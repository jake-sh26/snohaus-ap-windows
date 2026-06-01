/**
 * PR #102 — Events projector V2 (Path B: agreements-ledger source)
 * ================================================================
 *
 * PURPOSE
 * -------
 * Project recon_revenue_events from `recon_shopify_sales` (the Shopify
 * agreements ledger mirror built in PR #96/#97), instead of synthesizing
 * deltas from recon_line_items / recon_refunds / recon_refund_line_items.
 *
 * Path B premise: Shopify's own SalesAgreement -> Sale ledger is the
 * source of truth for every economic event (sale, edit, refund, return),
 * with `happenedAt` already encoding the correct booking date. By
 * mirroring that ledger 1:1 we eliminate the entire stack of detector
 * rules (#5 / #6 / #7 / #8 / #9 / #10 / #11 / #12 / #13) the legacy
 * projector needs to reconcile to Shopify.
 *
 *
 * FEATURE FLAG
 * ------------
 * USE_AGREEMENTS_PROJECTOR (env var)
 *   - unset / "false" / "0" → legacy projector remains primary
 *   - "true" / "1"          → V2 projector is primary
 *
 * The legacy projector module is NOT deleted in this PR. The compare
 * endpoint runs both side-by-side so we can validate before flipping
 * the flag in production.
 *
 *
 * OUTPUT TABLE
 * ------------
 * recon_revenue_events_v2 — same column shape as recon_revenue_events
 * but populated by this projector. Kept in a separate table so:
 *   1. The two projectors never collide on event_id
 *   2. The compare endpoint can read both side-by-side
 *   3. Rolling back is one env-var flip — no data rebuild
 *
 * After validation in production and a soak period, a follow-up cleanup
 * PR will drop recon_revenue_events_v2 and promote it to be the only
 * recon_revenue_events table.
 *
 *
 * MAPPING — recon_shopify_sales → recon_revenue_events_v2
 * --------------------------------------------------------
 * Each row in recon_shopify_sales is ONE economic event. The projector
 * walks every row and emits exactly one events row per sale.
 *
 *   event_date  = sale.happened_at  (Shopify booking date)
 *   event_month = derived (ET) — matches legacy convention
 *   order_id    = sale.order_id
 *   line_item_id = ref_id when line_type IN (PRODUCT, GIFT_CARD, TIP), else NULL
 *   refund_id   = agreement.refund_id when reason='REFUND', else NULL
 *
 * event_type is derived from sale.action_type × sale.line_type (PR #110):
 *
 *   action_type=ORDER,  line_type=PRODUCT     → sale
 *   action_type=ORDER,  line_type=FEE         → return_fee (retained fee
 *                                                rolled into Sales Revenue
 *                                                for journal entries)
 *   action_type=ORDER,  line_type=GIFT_CARD   → sale (GC sold, liability)
 *   action_type=ORDER,  line_type=SHIPPING    → sale (shipping income)
 *   action_type=ORDER,  line_type=ADJUSTMENT  → sale (positive adjustment)
 *   action_type=RETURN, line_type=PRODUCT     → refund
 *   action_type=RETURN, line_type=FEE         → refund (item-level fee return)
 *   action_type=RETURN, line_type=GIFT_CARD   → refund (GC refund)
 *   action_type=RETURN, line_type=SHIPPING    → refund (shipping refund)
 *   action_type=RETURN, line_type=ADJUSTMENT  → refund (negative adjustment)
 *   action_type=UPDATE, quantity > 0           → sale (edit added line)
 *   action_type=UPDATE, quantity < 0           → edit_adjustment (reversal)
 *
 * Why action_type instead of reason (the PR #110 breakthrough):
 *   ShopifyQL Finance Summary's Gross Sales aggregates by Sale.actionType
 *   (= ORDER vs RETURN), not by the parent SalesAgreement.reason. Empirically,
 *   17 rows in April 2025 with agreement.reason=RETURN but sale.action_type=ORDER
 *   contribute $27,270.36 to ShopifyQL gross sales because the Sale itself is
 *   marked ORDER. Filtering by reason missed those entirely. Filtering by
 *   action_type matches ShopifyQL exactly.
 *
 * is_gift_card = (sale_type='GiftCardSale') ? 1 : 0
 *   Cleaner than reading recon_line_items.is_gift_card — Shopify tells us
 *   directly via the sale subtype.
 *
 *
 * DOLLAR COLUMN MAPPING
 * ---------------------
 * The agreements ledger gives us SIGNED values directly. A refund row
 * already has negative total_amount, a reversal already has negative
 * quantity. This eliminates legacy's Rule #10 sign-convention dance.
 *
 * VERIFIED EMPIRICALLY (2026-05-26, PR #108): Shopify's totalAmount on a
 * Sale is **tax-inclusive** (= line subtotal + tax, post-discount).
 *
 * ShopifyQL Finance Summary convention (PR #109 — v2 NOW STORES IN THIS
 * CONVENTION for direct ShopifyQL parity, replacing legacy positive-stored):
 *   gross_sales      ≥ 0   product subtotal at original price (pre-discount, pre-tax)
 *   discounts        ≤ 0   discount amount stored NEGATIVE
 *   returns          ≤ 0   refund amount stored NEGATIVE (tax-exclusive)
 *   shipping_charges ≥ 0   tax-exclusive shipping income
 *   taxes            ≥ 0   collected, or ≤ 0 if net refunded
 *   net_sales = gross_sales + discounts + returns       (all signed)
 *   total_sales = net_sales + shipping_charges + taxes  (= customer paid)
 *
 * Tax-exclusive inversion of totalAmount:
 *   product/edit:  gross = total_amount + total_discount_before_taxes - total_tax
 *   refund:        returns = (total_amount - total_tax)   // signed-negative
 *   discounts:     discount = -total_discount_before_taxes // signed-negative
 *
 * Per-order verification on April 2025 data (PR #108 probes):
 *   #21765:  tax sum    = $614.97   = exact gross overage under old rule
 *   #21707:  tax        = $4,102.98 = exact overage
 *   #21758:  tax        ≈ $794.98 vs $781.86 overage (~$13 cents/rounding)
 *
 * For action_type=ORDER, line_type=PRODUCT (gross sale):
 *   gross    = total_amount + total_discount_before_taxes - total_tax
 *   discount = -total_discount_before_taxes   // NEGATIVE per ShopifyQL
 *   tax      = total_tax
 *   returns  = 0
 *
 * For action_type=RETURN, line_type=PRODUCT (refund):
 *   returns = (total_amount - total_tax)      // NEGATIVE per ShopifyQL
 *             // tax-component of refund stays in the tax column
 *   tax     = total_tax      // already negative from Shopify
 *   gross   = 0
 *   discount = 0
 *
 * For action_type=ORDER, line_type=FEE (retained return-fee):
 *   return_fees = total_amount - total_tax    // POSITIVE
 *   tax         = total_tax
 *   gross/discount/returns = 0
 *   NOTE: For journal entries this column rolls into Sales Revenue
 *         (return fee = revenue retained by the merchant). It is kept
 *         in a separate column for ShopifyQL Finance Summary parity.
 *
 * For line_type=GIFT_CARD (any action_type):
 *   net_sales_gift_cards = total_amount - tax (signed — negative on return)
 *   gross/discount/tax/returns = 0 (excluded from main net-sales math)
 *   NOTE: Gift card sales credit "Gift Card Liability" on the balance
 *         sheet — they are NOT revenue. Stays separate from JE revenue.
 *
 * For line_type=SHIPPING:
 *   currently not booked in V2 events (legacy ledger handles shipping).
 *   PR #110 leaves this for a future PR.
 *
 *
 * SHIPPING + SHIPPING_TAX
 * -----------------------
 * Shipping IS in the agreements ledger as sale_type='ShippingLineSale'.
 * Shipping tax is embedded in the sale's total_tax. This is a major
 * cleanup vs legacy, which had to pull shipping_tax from order raw_json
 * because the source tables didn't expose it line-by-line.
 *
 *
 * RULE #9 / RULE #12 / RULE #8
 * ----------------------------
 * NOT NEEDED. These rules existed in legacy because:
 *   #8  — same-order exchanges weren't in our source tables
 *   #9  — retained fees were inferred from current_* deltas
 *   #12 — refund discrepancies needed signed-sum disambiguation
 *
 * The agreements ledger encodes all three explicitly:
 *   - Exchanges emit a ReturnAgreement + a paired OrderEditAgreement
 *   - Retained fees are FeeSale / AdditionalFeeSale rows
 *   - Refund discrepancies are AdjustmentSale rows under RefundAgreement
 *
 * So the V2 projector is a flat row-by-row mapper. No rule branches.
 *
 *
 * IDEMPOTENCE
 * -----------
 * Like the legacy projector, V2 is "wipe + rebuild" per scope:
 *   projectRevenueEventsV2({ scope: "all" })            → wipe all, rebuild
 *   projectRevenueEventsV2({ scope: "order", orderId })  → wipe one order, rebuild
 *
 * event_id is deterministic (derived from sale_id) so re-running yields
 * the same rows.
 *
 *
 * READ-ONLY GUARANTEE
 * -------------------
 * Phase 1 reconciler is read-only. This module reads recon_shopify_sales
 * (already populated by PR #97) and writes recon_revenue_events_v2. No
 * Shopify writes.
 */

import { sqlite } from "./storage";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

let schemaEnsured = false;

export function ensureRevenueEventsV2Schema(): void {
  if (schemaEnsured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_revenue_events_v2 (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK (event_type IN
        ('sale', 'edit_adjustment', 'refund', 'return_fee')),
      event_date TEXT NOT NULL,
      event_month TEXT GENERATED ALWAYS AS
        (substr(datetime(event_date, '-5 hours'), 1, 7)) VIRTUAL,
      order_id TEXT NOT NULL REFERENCES recon_orders(id) ON DELETE CASCADE,
      line_item_id TEXT,
      refund_id TEXT,
      refund_line_item_id TEXT,
      sale_id TEXT,
      agreement_id TEXT,
      is_gift_card INTEGER NOT NULL DEFAULT 0,
      gross REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      returns REAL NOT NULL DEFAULT 0,
      return_fees REAL NOT NULL DEFAULT 0,
      net_sales_gift_cards REAL NOT NULL DEFAULT 0,
      detector_source TEXT NOT NULL,
      detected_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_revenue_events_v2_month
      ON recon_revenue_events_v2(event_month);
    CREATE INDEX IF NOT EXISTS idx_recon_revenue_events_v2_order
      ON recon_revenue_events_v2(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_revenue_events_v2_type
      ON recon_revenue_events_v2(event_type);
    CREATE INDEX IF NOT EXISTS idx_recon_revenue_events_v2_date
      ON recon_revenue_events_v2(event_date);
    CREATE INDEX IF NOT EXISTS idx_recon_revenue_events_v2_sale
      ON recon_revenue_events_v2(sale_id);
  `);
  schemaEnsured = true;
}

function ensure(): void {
  if (!schemaEnsured) ensureRevenueEventsV2Schema();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round2 = (n: number | null | undefined): number =>
  n == null || !Number.isFinite(n) ? 0 : Math.round(n * 100) / 100;

function logWarning(
  reason: string,
  ctx: {
    order_id?: string | null;
    sale_id?: string | null;
    agreement_id?: string | null;
    event_type?: string | null;
    detail?: any;
  },
): void {
  // Re-use the existing warnings table from the legacy projector module.
  sqlite.prepare(`
    INSERT INTO recon_event_warnings
      (order_id, refund_id, line_item_id, event_type, reason, detail_json, logged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    ctx.order_id ?? null,
    null,
    null,
    ctx.event_type ?? null,
    reason,
    ctx.detail != null
      ? JSON.stringify({ sale_id: ctx.sale_id, agreement_id: ctx.agreement_id, ...ctx.detail })
      : JSON.stringify({ sale_id: ctx.sale_id, agreement_id: ctx.agreement_id }),
    new Date().toISOString(),
  );
}

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/**
 * PR #104 status:
 *
 *   The V2 projector is DIAGNOSTIC-ONLY. The legacy projector
 *   (recon_revenue_events) remains the source of truth for the books.
 *
 *   Why: PR #102 ground-truth validation (PR #103 endpoint) found that
 *   the V2 pipeline as of 8c15bb2 has known unresolved issues:
 *     - Ingest layer drops orders that have ReturnAgreement edges
 *       (~1,778 of 19,175 / ~9% missing entirely; 6 of 77 April 2025
 *       orders missing $33,316 of gross)
 *     - Projector layer inflates gross by ~$14,700 in April 2025
 *       (V2 gross $87,488 vs Shopify subtotal $97,693, but V2 > ingest
 *       total_amount $72,781 — i.e. projector double-counts something)
 *     - return_fees comes out $0 across all months (real value ~$10+)
 *     - returns comes out near $0 (legacy correctly books $26,947 in
 *       April 2025)
 *
 *   The V2 tables (recon_shopify_agreements, recon_shopify_sales,
 *   recon_revenue_events_v2) remain populated and are useful as a
 *   shadow ledger for ad-hoc per-order investigation via:
 *     - GET /api/recon/finance/debug/shopify-ground-truth/:month
 *     - GET /api/recon/finance/debug/diagnose-order/:name (PR #104)
 *     - GET /api/recon/finance/debug/projector-compare/order/:name
 *
 *   Do NOT set USE_AGREEMENTS_PROJECTOR=true in production until the
 *   issues above are resolved. The boot-time check below will log a
 *   loud warning if the flag is enabled.
 */
export function isV2ProjectorActive(): boolean {
  const v = (process.env.USE_AGREEMENTS_PROJECTOR || "").toLowerCase();
  const active = v === "true" || v === "1" || v === "yes";
  if (active && !warnedAboutV2Active) {
    warnedAboutV2Active = true;
    // eslint-disable-next-line no-console
    console.warn(
      "\n[V2-PROJECTOR-WARN] USE_AGREEMENTS_PROJECTOR is enabled. " +
      "V2 is diagnostic-only as of PR #104 and is known to drop ~9% of " +
      "orders and inflate gross by ~15%. Unset this flag unless you know " +
      "exactly what you're doing.\n"
    );
  }
  return active;
}
let warnedAboutV2Active = false;

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export type ProjectionV2Summary = {
  events_inserted: number;
  by_type: Record<"sale" | "edit_adjustment" | "refund" | "return_fee", number>;
  by_reason: Record<string, number>;
  warnings_logged: number;
  duration_ms: number;
  scope: "all" | "order";
  order_id?: string | null;
};

type SaleRow = {
  sale_id: string;
  agreement_id: string;
  order_id: string;
  happened_at: string;
  sale_type: string;
  action_type: string | null;
  line_type: string | null;
  quantity: number | null;
  total_amount: number | null;
  total_discount_after_taxes: number | null;
  total_discount_before_taxes: number | null;
  total_tax: number | null;
  ref_id: string | null;
  // From the parent agreement:
  reason: string;
  agreement_type: string;
  refund_id: string | null;
  return_id: string | null;
};

/**
 * Project revenue events V2 from the Shopify agreements ledger.
 *
 * Modes:
 *   { scope: "all" }            — wipe + rebuild the entire V2 ledger
 *   { scope: "order", orderId } — rebuild events for a single order (idempotent)
 *
 * Re-running with the same scope produces the same rows (event_id is
 * deterministic from sale_id).
 */
export function projectRevenueEventsV2(
  opts: { scope: "all" } | { scope: "order"; orderId: string },
): ProjectionV2Summary {
  ensure();
  const startedAt = Date.now();
  const detector_source = "projectRevenueEventsV2-pr102";
  const detected_at = new Date().toISOString();

  const summary: ProjectionV2Summary = {
    events_inserted: 0,
    by_type: { sale: 0, edit_adjustment: 0, refund: 0, return_fee: 0 },
    by_reason: {},
    warnings_logged: 0,
    duration_ms: 0,
    scope: opts.scope,
    order_id: opts.scope === "order" ? opts.orderId : undefined,
  };

  const warningsBefore = (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recon_event_warnings`)
    .get() as { n: number }).n;

  const txn = sqlite.transaction(() => {
    if (opts.scope === "all") {
      sqlite.exec(`DELETE FROM recon_revenue_events_v2`);
    } else {
      sqlite.prepare(`DELETE FROM recon_revenue_events_v2 WHERE order_id = ?`)
        .run(opts.orderId);
    }

    const insertStmt = sqlite.prepare(`
      INSERT INTO recon_revenue_events_v2 (
        event_id, event_type, event_date,
        order_id, line_item_id, refund_id, refund_line_item_id,
        sale_id, agreement_id,
        is_gift_card,
        gross, discount, tax, returns, return_fees, net_sales_gift_cards,
        detector_source, detected_at
      ) VALUES (
        @event_id, @event_type, @event_date,
        @order_id, @line_item_id, @refund_id, @refund_line_item_id,
        @sale_id, @agreement_id,
        @is_gift_card,
        @gross, @discount, @tax, @returns, @return_fees, @net_sales_gift_cards,
        @detector_source, @detected_at
      )
    `);

    // Join sale rows with their agreement for reason + refund_id + return_id.
    const saleRows = sqlite
      .prepare(`
        SELECT
          s.id AS sale_id,
          s.agreement_id,
          s.order_id,
          s.happened_at,
          s.sale_type,
          s.action_type,
          s.line_type,
          s.quantity,
          s.total_amount,
          s.total_discount_after_taxes,
          s.total_discount_before_taxes,
          s.total_tax,
          s.ref_id,
          a.reason,
          a.agreement_type,
          a.refund_id,
          a.return_id
        FROM recon_shopify_sales s
        JOIN recon_shopify_agreements a ON a.id = s.agreement_id
        ${opts.scope === "order" ? "WHERE s.order_id = ?" : ""}
        ORDER BY s.happened_at ASC, s.id ASC
      `)
      .all(...(opts.scope === "order" ? [opts.orderId] : [])) as SaleRow[];

    for (const s of saleRows) {
      summary.by_reason[s.reason] = (summary.by_reason[s.reason] || 0) + 1;

      if (!s.happened_at) {
        logWarning("sale has no happened_at", {
          order_id: s.order_id,
          sale_id: s.sale_id,
          agreement_id: s.agreement_id,
        });
        continue;
      }

      const totalAmount = Number(s.total_amount ?? 0);
      const discount = Number(s.total_discount_before_taxes ?? 0);
      const tax = Number(s.total_tax ?? 0);
      const qty = Number(s.quantity ?? 0);
      const isGc = s.sale_type === "GiftCardSale" ? 1 : 0;

      // PR #110: Determine event_type from action_type + line_type.
      // This matches ShopifyQL Finance Summary's aggregation logic exactly.
      let eventType: "sale" | "edit_adjustment" | "refund" | "return_fee";
      const actionType = (s.action_type || "").toUpperCase();
      const lineType = (s.line_type || "").toUpperCase();

      if (actionType === "ORDER") {
        if (lineType === "FEE") {
          // Retained return fee booked as ORDER+FEE — appears in revenue.
          eventType = "return_fee";
        } else {
          eventType = "sale";
        }
      } else if (actionType === "RETURN") {
        eventType = "refund";
      } else if (actionType === "UPDATE") {
        // OrderEdit reversal/addition. Negative qty = reversed line.
        eventType = qty < 0 ? "edit_adjustment" : "sale";
      } else {
        // Unknown action_type — bucket as sale and warn so we surface new
        // Shopify Sale.actionType values in the warnings table.
        logWarning("unknown sale action_type", {
          order_id: s.order_id,
          sale_id: s.sale_id,
          agreement_id: s.agreement_id,
          detail: {
            action_type: s.action_type,
            line_type: s.line_type,
            reason: s.reason,
            agreement_type: s.agreement_type,
          },
        });
        eventType = "sale";
      }

      // Dollar column derivation.
      let gross = 0;
      let discountCol = 0;
      let taxCol = 0;
      let returnsCol = 0;
      let returnFeesCol = 0;
      let netSalesGcCol = 0;
      let lineItemId: string | null = null;

      if (
        s.line_type === "PRODUCT" ||
        s.line_type === "GIFT_CARD" ||
        s.line_type === "TIP"
      ) {
        lineItemId = s.ref_id;
      }

      // PR #110 sign convention (matches ShopifyQL Finance Summary):
      //   gross    ≥ 0    discounts ≤ 0    returns ≤ 0    tax signed
      //   net_sales = gross + discounts + returns
      // Routing by line_type so we honor ShopifyQL's per-line classification.
      if (isGc === 1 || lineType === "GIFT_CARD") {
        // Gift cards are a separate liability bucket — never in gross/net.
        // Sign tracks action_type (ORDER => positive, RETURN => negative).
        netSalesGcCol = totalAmount - tax;
      } else if (lineType === "SHIPPING") {
        // Shipping not currently booked in V2 events (legacy handles it).
        // Leave all columns at 0; this is intentional for PR #110.
      } else if (eventType === "sale") {
        // ORDER + (PRODUCT|ADJUSTMENT|...). gross is positive; discount
        // is stored negative.
        gross = totalAmount + discount - tax;
        discountCol = -discount;
        taxCol = tax;
      } else if (eventType === "edit_adjustment") {
        // UPDATE with negative qty — reversed line. totalAmount already
        // negative; gross goes negative, discount/tax follow source sign.
        gross = totalAmount + discount - tax;
        discountCol = -discount;
        taxCol = tax;
      } else if (eventType === "refund") {
        // RETURN + (PRODUCT|FEE|ADJUSTMENT|...). totalAmount is negative
        // on returns. Tax-exclusive returns = (totalAmount - tax).
        returnsCol = totalAmount - tax;
        taxCol = tax;
      } else if (eventType === "return_fee") {
        // ORDER + FEE — retained return fee. Positive contribution; kept
        // in a separate column for ShopifyQL parity but rolled into Sales
        // Revenue in QBO journal entries.
        returnFeesCol = totalAmount - tax;
        taxCol = tax;
      }

      insertStmt.run({
        event_id: `v2:${s.sale_id}`,
        event_type: eventType,
        event_date: s.happened_at,
        order_id: s.order_id,
        line_item_id: lineItemId,
        refund_id: s.refund_id ?? null,
        refund_line_item_id: null,
        sale_id: s.sale_id,
        agreement_id: s.agreement_id,
        is_gift_card: isGc,
        gross: round2(gross),
        discount: round2(discountCol),
        tax: round2(taxCol),
        returns: round2(returnsCol),
        return_fees: round2(returnFeesCol),
        net_sales_gift_cards: round2(netSalesGcCol),
        detector_source,
        detected_at,
      });

      summary.by_type[eventType] += 1;
      summary.events_inserted += 1;
    }
  });

  txn();

  const warningsAfter = (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recon_event_warnings`)
    .get() as { n: number }).n;
  summary.warnings_logged = warningsAfter - warningsBefore;
  summary.duration_ms = Date.now() - startedAt;
  return summary;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export type EventsV2MonthlyRow = {
  event_month: string;
  gross_sales: number;
  discounts: number;
  returns: number;
  taxes: number;
  return_fees: number;
  net_sales_gift_cards: number;
  net_sales: number;
  event_count: number;
};

/**
 * Aggregate V2 events for a given month (YYYY-MM, store-local ET).
 * Mirrors aggregateRevenueEventsByMonth from the legacy projector module
 * so the two outputs can be diffed cell-by-cell.
 */
export function aggregateRevenueEventsV2ByMonth(monthKey: string): EventsV2MonthlyRow {
  ensure();
  const row = sqlite.prepare(`
    SELECT
      COALESCE(SUM(gross), 0)                AS gross_sales,
      COALESCE(SUM(discount), 0)             AS discounts,
      COALESCE(SUM(returns), 0)              AS returns,
      COALESCE(SUM(tax), 0)                  AS taxes,
      COALESCE(SUM(return_fees), 0)          AS return_fees,
      COALESCE(SUM(net_sales_gift_cards), 0) AS net_sales_gift_cards,
      COUNT(*)                               AS event_count
    FROM recon_revenue_events_v2
    WHERE event_month = ?
  `).get(monthKey) as Omit<EventsV2MonthlyRow, "event_month" | "net_sales">;

  // PR #109: discounts and returns are stored negative (ShopifyQL convention),
  // so net_sales = gross + disc + ret (all signed).
  const net_sales = row.gross_sales + row.discounts + row.returns;
  return {
    event_month: monthKey,
    ...row,
    gross_sales: round2(row.gross_sales),
    discounts: round2(row.discounts),
    returns: round2(row.returns),
    taxes: round2(row.taxes),
    return_fees: round2(row.return_fees),
    net_sales_gift_cards: round2(row.net_sales_gift_cards),
    net_sales: round2(net_sales),
  };
}

export type RevenueEventV2Row = {
  event_id: string;
  event_type: string;
  event_date: string;
  event_month: string;
  order_id: string;
  line_item_id: string | null;
  refund_id: string | null;
  refund_line_item_id: string | null;
  sale_id: string | null;
  agreement_id: string | null;
  is_gift_card: number;
  gross: number;
  discount: number;
  tax: number;
  returns: number;
  return_fees: number;
  net_sales_gift_cards: number;
};

export function listEventsV2ForOrder(orderId: string): RevenueEventV2Row[] {
  ensure();
  return sqlite.prepare(`
    SELECT event_id, event_type, event_date, event_month,
           order_id, line_item_id, refund_id, refund_line_item_id,
           sale_id, agreement_id,
           is_gift_card, gross, discount, tax, returns, return_fees,
           net_sales_gift_cards
    FROM recon_revenue_events_v2
    WHERE order_id = ?
    ORDER BY event_date ASC, event_type ASC, event_id ASC
  `).all(orderId) as RevenueEventV2Row[];
}
