/**
 * PR #94 — Revenue events ledger (data layer only).
 *
 * BACKGROUND
 * ----------
 * Shopify's "net sales by product" CSV backup is a TRANSACTION-LEVEL LEDGER.
 * Every economic event — a sale, a post-order edit, a refund, a retained fee —
 * is one row with its own date. Rolling up the rows by date reproduces the
 * Finance Summary exactly. By construction it reconciles to itself.
 *
 * Our local computeLocalFinanceSummary() has historically been a stack of
 * SQL aggregations over four source tables (recon_line_items, recon_refunds,
 * recon_refund_line_items, recon_orders) with mixed bucketing rules:
 *
 *   Rule #5  — recognized_at fallback
 *   Rule #6  — gift-card exclusion
 *   Rule #7a — line-discount aggregation
 *   Rule #7b — per-line tax
 *   Rule #7c — discount_allocations fallback
 *   Rule #8  — unverified-return tax delta
 *   Rule #9  — retained-fee detection
 *   Rule #10 — refund-tax sign convention
 *   Rule #11 — gift-card refund exclusion
 *   Rule #11b— gift-card refund symmetry
 *   Rule #12 — refund discrepancy as return
 *   Rule #13 — order-edit attribution (Bug 3)
 *
 * Every rule exists because the source schema can't natively express
 * "this discount happened on a different date than the sale." The events
 * ledger built here makes those rules unnecessary: each economic effect
 * gets its own row with its own bucket date, and the finance diff becomes
 * a single GROUP BY.
 *
 * PR SEQUENCE (DO NOT skip ahead)
 *   PR #94  — schema + projection + debug endpoints (behavior unchanged)
 *   PR #95  — parallel-validation endpoint comparing old vs new path
 *   PR #95c — projector fixes (THIS PR): shipping_tax, adjustment_tax, Rule #8
 *   PR #96  — edit_adjustment events from detectOrderEdit
 *   PR #97  — switch computeLocalFinanceSummary to events-ledger path
 *   PR #98  — delete legacy rules code
 *
 * PR #95c additions (validated against June 2025 diff-compare $77.64 gap):
 *   1. sale_shipping_tax events — one per order with non-zero shipping tax.
 *      Closes the missing shipping_tax piece on the sale side (Rule #7b
 *      shipping-line tax_lines) that legacy adds via order raw_json.
 *      June 2025: +$108.26.
 *   2. refund_adjustment_tax events — one per adjustment-kind refund line
 *      with non-zero total_tax. Stored negative (Rule #10 sign convention).
 *      Closes the missing adjustment-row tax subtraction that legacy does
 *      via the returns_tax CASE WHEN. June 2025: −$30.62 of refund tax.
 *      Shipping-refund adjustments use ABS(total_tax) to mirror legacy.
 *   3. unverified_return events — for orders matching Rule #8 (subtotal >
 *      current_subtotal, no refund row). Stores the subtotal delta as a
 *      return and the tax delta with legacy's sign convention. Validated
 *      against March 2026 #37901 ($24.99 leash → $27.14 GC).
 *
 * DATA MODEL
 * ----------
 * One table: recon_revenue_events.
 *
 *   event_id          synthetic PRIMARY KEY (deterministic from source so
 *                     reprojection is idempotent)
 *   event_type        sale | edit_adjustment | refund | return_fee
 *   event_date        ISO timestamp when the economic event occurred:
 *                       sale            → line.recognized_at
 *                       edit_adjustment → edit.edited_at_iso
 *                       refund          → refund.processed_at
 *                       return_fee      → refund.processed_at
 *   event_month       GENERATED column: substr(datetime(event_date,
 *                     '-5 hours'), 1, 7) → 'YYYY-MM' store-local
 *   order_id          FK to recon_orders.id (CASCADE)
 *   line_item_id      FK to recon_line_items.id when applicable, else NULL
 *   refund_id         FK to recon_refunds.id when applicable, else NULL
 *   refund_line_item_id  FK to recon_refund_line_items.id when applicable
 *
 *   Signed-dollar columns (positive = revenue, negative = reduction):
 *     gross             merchandise price × quantity (sales only; 0 for non-gross events)
 *     discount          discount applied (positive number reduces net sales downstream)
 *     tax               tax collected on this row (signed; refunds carry negative)
 *     returns           pre-tax refund subtotal (positive number reduces net sales downstream)
 *     return_fees       retained-fee amount (Shopify "Return fees" line)
 *     net_sales_gift_cards  gift-card net sales contribution (separate Shopify line)
 *
 *   is_gift_card      mirrored from line for fast GC filtering
 *
 * The monthly finance summary will be (PR #97):
 *
 *   SELECT
 *     SUM(gross) - SUM(discount) - SUM(returns) AS net_sales,
 *     SUM(discount)                              AS discounts,
 *     SUM(returns)                               AS returns,
 *     SUM(tax)                                   AS taxes,
 *     SUM(return_fees)                           AS return_fees,
 *     SUM(net_sales_gift_cards)                  AS net_sales_gift_cards,
 *     SUM(gross)                                 AS gross_sales,
 *   FROM recon_revenue_events
 *   WHERE event_month = ?
 *
 * (Plus shipping from recon_orders.total_shipping — still order-level
 * because Shopify doesn't have a per-line shipping concept.)
 *
 * PROJECTION
 * ----------
 * projectRevenueEvents() reads recon_line_items + recon_refunds +
 * recon_refund_line_items + recon_orders and emits one row per economic
 * event. It is fully deterministic: same source data → same events.
 * Re-running it wipes + re-inserts. No external API calls, no GraphQL.
 *
 * Edit-adjustment events are NOT emitted in PR #94 — they require the
 * detector data which arrives in PR #96. PR #94 establishes the table
 * and proves that sale + refund + return_fee events alone reproduce the
 * 12 already-validated months ($0 diff). Edit adjustments will close
 * the remaining 4 months (May/Jun/Oct/Nov 2025) in PR #96.
 *
 * WARNINGS
 * --------
 * recon_event_warnings carries soft-fail records — malformed rows, parse
 * errors, orphans. The projector never throws; it logs and skips. After
 * each backfill the operator reviews the warnings table.
 */

import { sqlite } from "./storage";

// ----- Schema -----

let schemaEnsured = false;

export function ensureRevenueEventsSchema(): void {
  if (schemaEnsured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_revenue_events (
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
    CREATE INDEX IF NOT EXISTS idx_recon_revenue_events_month
      ON recon_revenue_events(event_month);
    CREATE INDEX IF NOT EXISTS idx_recon_revenue_events_order
      ON recon_revenue_events(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_revenue_events_type
      ON recon_revenue_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_recon_revenue_events_date
      ON recon_revenue_events(event_date);

    CREATE TABLE IF NOT EXISTS recon_event_warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      refund_id TEXT,
      line_item_id TEXT,
      event_type TEXT,
      reason TEXT NOT NULL,
      detail_json TEXT,
      logged_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_event_warnings_order
      ON recon_event_warnings(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_event_warnings_logged_at
      ON recon_event_warnings(logged_at);
  `);
  schemaEnsured = true;
}

function ensure(): void {
  if (!schemaEnsured) ensureRevenueEventsSchema();
}

// ----- Helpers -----

const round2 = (n: number | null | undefined): number =>
  n == null || !Number.isFinite(n) ? 0 : Math.round(n * 100) / 100;

function logWarning(
  reason: string,
  ctx: {
    order_id?: string | null;
    refund_id?: string | null;
    line_item_id?: string | null;
    event_type?: string | null;
    detail?: any;
  },
): void {
  sqlite.prepare(`
    INSERT INTO recon_event_warnings
      (order_id, refund_id, line_item_id, event_type, reason, detail_json, logged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    ctx.order_id ?? null,
    ctx.refund_id ?? null,
    ctx.line_item_id ?? null,
    ctx.event_type ?? null,
    reason,
    ctx.detail != null ? JSON.stringify(ctx.detail) : null,
    new Date().toISOString(),
  );
}

// Sum tax_lines[].price from a JSON-encoded tax_lines array. Returns 0 on
// any parse failure (and logs a warning).
function sumTaxLinesJson(
  json: string | null | undefined,
  ctx: { order_id: string; line_item_id?: string | null; refund_id?: string | null },
): number {
  if (!json) return 0;
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return 0;
    let s = 0;
    for (const tl of arr) {
      const p = Number(tl?.price);
      if (Number.isFinite(p)) s += p;
    }
    return s;
  } catch {
    logWarning("tax_lines_json parse failed", {
      ...ctx,
      event_type: "sale",
      detail: { snippet: String(json).slice(0, 200) },
    });
    return 0;
  }
}

// ----- Projection -----

export type ProjectionSummary = {
  events_inserted: number;
  by_type: Record<"sale" | "edit_adjustment" | "refund" | "return_fee", number>;
  warnings_logged: number;
  duration_ms: number;
  scope: "all" | "order";
  order_id?: string | null;
};

type LineRow = {
  id: string;
  order_id: string;
  recognized_at: string | null;
  is_gift_card: number;
  price: number | null;
  quantity: number | null;
  total_discount: number | null;
  discount_allocations_total: number | null;
  tax_lines_json: string | null;
};

type RefundRow = {
  id: string;
  order_id: string;
  processed_at: string | null;
  created_at: string | null;
  adjustment_amount: number;
  adjustment_tax: number;
};

type RefundLineRow = {
  id: string;
  refund_id: string;
  order_id: string;
  kind: string;
  line_item_id: string | null;
  subtotal: number;
  total_tax: number;
  adjustment_kind: string | null;
};

type OrderRow = {
  id: string;
  current_total_price: number | null;
  current_subtotal_price: number | null;
  current_total_tax: number | null;
};

/**
 * Project revenue events from source tables.
 *
 * Modes:
 *   { scope: "all" }           — wipe + rebuild the entire ledger
 *   { scope: "order", orderId } — rebuild events for a single order (idempotent)
 *
 * Re-running with the same scope produces the same rows (event_id is
 * deterministic from source ids).
 */
export function projectRevenueEvents(
  opts: { scope: "all" } | { scope: "order"; orderId: string },
): ProjectionSummary {
  ensure();
  const startedAt = Date.now();
  const detector_source = "projectRevenueEvents-pr95c";
  const detected_at = new Date().toISOString();

  const summary: ProjectionSummary = {
    events_inserted: 0,
    by_type: { sale: 0, edit_adjustment: 0, refund: 0, return_fee: 0 },
    warnings_logged: 0,
    duration_ms: 0,
    scope: opts.scope,
    order_id: opts.scope === "order" ? opts.orderId : undefined,
  };

  // Count warnings before/after to populate the summary cheaply.
  const warningsBefore = (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recon_event_warnings`)
    .get() as { n: number }).n;

  const txn = sqlite.transaction(() => {
    // 1. Wipe the target scope.
    if (opts.scope === "all") {
      sqlite.exec(`DELETE FROM recon_revenue_events`);
    } else {
      sqlite.prepare(`DELETE FROM recon_revenue_events WHERE order_id = ?`)
        .run(opts.orderId);
    }

    const insertStmt = sqlite.prepare(`
      INSERT INTO recon_revenue_events (
        event_id, event_type, event_date,
        order_id, line_item_id, refund_id, refund_line_item_id,
        is_gift_card,
        gross, discount, tax, returns, return_fees, net_sales_gift_cards,
        detector_source, detected_at
      ) VALUES (
        @event_id, @event_type, @event_date,
        @order_id, @line_item_id, @refund_id, @refund_line_item_id,
        @is_gift_card,
        @gross, @discount, @tax, @returns, @return_fees, @net_sales_gift_cards,
        @detector_source, @detected_at
      )
    `);

    const orderFilter = opts.scope === "order"
      ? `WHERE order_id = ?`
      : ``;
    const orderFilterParams = opts.scope === "order" ? [opts.orderId] : [];

    // 2. SALE events: one per recon_line_items row.
    //    Non-gift-card lines contribute to gross/discount/tax.
    //    Gift-card lines contribute to net_sales_gift_cards (separate Shopify
    //    metric); their gross is excluded from the main net-sales formula
    //    just like Rule #6 used to enforce.
    //
    //    Bucket date: COALESCE(li.recognized_at, o.processed_at, o.created_at).
    //    Same fallback chain as the current `line_recognized_at` bucketBy.
    const lineRows = sqlite
      .prepare(`
        SELECT
          li.id, li.order_id, li.is_gift_card,
          li.price, li.quantity, li.total_discount,
          li.discount_allocations_total, li.tax_lines_json,
          COALESCE(li.recognized_at, o.processed_at, o.created_at) AS recognized_at
        FROM recon_line_items li
        JOIN recon_orders o ON o.id = li.order_id
        ${opts.scope === "order" ? "WHERE li.order_id = ?" : ""}
      `)
      .all(...orderFilterParams) as LineRow[];

    for (const li of lineRows) {
      if (!li.recognized_at) {
        logWarning("line has no recognized_at/processed_at/created_at", {
          order_id: li.order_id,
          line_item_id: li.id,
          event_type: "sale",
        });
        continue;
      }
      const price = Number(li.price ?? 0);
      const qty = Number(li.quantity ?? 0);
      const gross = price * qty;
      // Rule #7c: MAX(total_discount, discount_allocations_total). For
      // discount-CODE orders, Shopify zeroes total_discount and writes the
      // per-line share into discount_allocations[]. The line aggregate
      // already validated against Shopify Finance Summary in PR #R5a-fix2.
      const discount = Math.max(
        Number(li.total_discount ?? 0),
        Number(li.discount_allocations_total ?? 0),
      );
      const tax = sumTaxLinesJson(li.tax_lines_json, {
        order_id: li.order_id,
        line_item_id: li.id,
      });
      const isGc = Number(li.is_gift_card) === 1 ? 1 : 0;
      const netSalesGc = isGc === 1 ? gross - discount : 0;

      insertStmt.run({
        event_id: `sale:${li.id}`,
        event_type: "sale",
        event_date: li.recognized_at,
        order_id: li.order_id,
        line_item_id: li.id,
        refund_id: null,
        refund_line_item_id: null,
        is_gift_card: isGc,
        // Non-GC: contribute to gross/discount/tax. GC: contribute only
        // to net_sales_gift_cards (Rule #6 exclusion baked into projection).
        gross: round2(isGc === 1 ? 0 : gross),
        discount: round2(isGc === 1 ? 0 : discount),
        tax: round2(isGc === 1 ? 0 : tax),
        returns: 0,
        return_fees: 0,
        net_sales_gift_cards: round2(netSalesGc),
        detector_source,
        detected_at,
      });
      summary.by_type.sale += 1;
      summary.events_inserted += 1;
    }

    // 2b. SALE_SHIPPING_TAX events (PR #95c, addition #1).
    //     One per order with non-zero shipping_lines[].tax_lines[].price sum.
    //     Legacy adds this via order raw_json → shippingTax → taxes (Rule
    //     #7b shipping piece). Bucket on the order's recognized date —
    //     shipping is paid at order time, not at line-recognition time —
    //     mirroring legacy's shippingBucketBy = 'order_processed_at'.
    //     Emitted as event_type='sale' (not a refund or fee) so SUM(tax)
    //     over sale events still equals "tax collected on sale-side".
    const shippingOrderRows = sqlite
      .prepare(`
        SELECT o.id, o.raw_json,
               COALESCE(o.processed_at, o.created_at) AS event_date
        FROM recon_orders o
        ${opts.scope === "order" ? "WHERE o.id = ?" : ""}
      `)
      .all(...orderFilterParams) as Array<{
        id: string;
        raw_json: string | null;
        event_date: string | null;
      }>;

    for (const row of shippingOrderRows) {
      if (!row.event_date) continue;
      if (!row.raw_json) continue;
      let shipTax = 0;
      try {
        const rj = typeof row.raw_json === "string"
          ? JSON.parse(row.raw_json)
          : row.raw_json;
        const shippingLines = Array.isArray(rj?.shipping_lines)
          ? rj.shipping_lines
          : [];
        for (const s of shippingLines) {
          const tls = Array.isArray(s?.tax_lines) ? s.tax_lines : [];
          for (const tl of tls) {
            const p = Number(tl?.price);
            if (Number.isFinite(p)) shipTax += p;
          }
        }
      } catch {
        logWarning("order raw_json parse failed for shipping tax", {
          order_id: row.id,
          event_type: "sale",
          detail: { snippet: String(row.raw_json).slice(0, 200) },
        });
        continue;
      }
      if (Math.abs(shipTax) < 0.005) continue;
      insertStmt.run({
        event_id: `sale_shipping_tax:${row.id}`,
        event_type: "sale",
        event_date: row.event_date,
        order_id: row.id,
        line_item_id: null,
        refund_id: null,
        refund_line_item_id: null,
        is_gift_card: 0,
        gross: 0,
        discount: 0,
        tax: round2(shipTax),
        returns: 0,
        return_fees: 0,
        net_sales_gift_cards: 0,
        detector_source,
        detected_at,
      });
      summary.by_type.sale += 1;
      summary.events_inserted += 1;
    }

    // 3. REFUND events: one per recon_refund_line_items row of kind='item'.
    //    Bucket date: refund.processed_at.
    //    Rule #11 carry-forward: refund lines that point at a gift-card line
    //    contribute to net_sales_gift_cards (negative), NOT to the main
    //    returns/tax. This matches Shopify's net_sales_gift_cards definition
    //    (sales − GC refunds).
    const refundLineRows = sqlite
      .prepare(`
        SELECT
          rli.id, rli.refund_id, rli.order_id, rli.kind, rli.line_item_id,
          rli.subtotal, rli.total_tax, rli.adjustment_kind,
          r.processed_at, r.created_at, li.is_gift_card AS line_is_gift_card
        FROM recon_refund_line_items rli
        JOIN recon_refunds r ON r.id = rli.refund_id
        LEFT JOIN recon_line_items li ON li.id = rli.line_item_id
        ${opts.scope === "order" ? "WHERE rli.order_id = ?" : ""}
      `)
      .all(...orderFilterParams) as Array<RefundLineRow & {
        processed_at: string | null;
        created_at: string | null;
        line_is_gift_card: number | null;
      }>;

    for (const rli of refundLineRows) {
      const eventDate = rli.processed_at || rli.created_at;
      if (!eventDate) {
        logWarning("refund line has no processed_at/created_at", {
          order_id: rli.order_id,
          refund_id: rli.refund_id,
          line_item_id: rli.line_item_id,
          event_type: "refund",
        });
        continue;
      }
      if (rli.kind === "item") {
        const isGc = Number(rli.line_is_gift_card) === 1 ? 1 : 0;
        const subtotal = Number(rli.subtotal ?? 0);
        const refundTax = Number(rli.total_tax ?? 0);
        // Rule #11: gift-card refunds nets out net_sales_gift_cards, not
        // returns. Store as negative GC sales contribution; do not double-
        // count as a return.
        insertStmt.run({
          event_id: `refund:${rli.id}`,
          event_type: "refund",
          event_date: eventDate,
          order_id: rli.order_id,
          line_item_id: rli.line_item_id,
          refund_id: rli.refund_id,
          refund_line_item_id: rli.id,
          is_gift_card: isGc,
          gross: 0,
          discount: 0,
          // Rule #10 sign convention: refund tax is a reversal of collected
          // tax. We store it negative so the monthly SUM(tax) over events
          // gives "tax collected this month net of refunds." Gift-card
          // refunds carry no tax in practice, but defensive zero anyway.
          tax: round2(isGc === 1 ? 0 : -refundTax),
          returns: round2(isGc === 1 ? 0 : subtotal),
          return_fees: 0,
          net_sales_gift_cards: round2(isGc === 1 ? -subtotal : 0),
          detector_source,
          detected_at,
        });
        summary.by_type.refund += 1;
        summary.events_inserted += 1;
        continue;
      }
      if (rli.kind === "adjustment") {
        // Rule #9 carry-forward: positive adjustment_amount on an
        // adjustment row = retained fee (Shopify's "Return fees" line).
        // Negative = refund discrepancy treated as additional return.
        // Shipping refunds are handled via order shipping math, not here.
        const amount = Number(rli.subtotal ?? 0);  // adjustment subtotal
        const adjKind = (rli.adjustment_kind || "").toLowerCase();

        // PR #95c addition #2: emit a tax-only refund event for ANY
        // adjustment row carrying non-zero total_tax (independent of the
        // subtotal branch below). Legacy's returns_tax SUM includes:
        //   shipping_refund        → ABS(total_tax)
        //   other adjustment kinds → total_tax (signed)
        // We mirror both with a single negative refund-tax row so the
        // events SUM(tax) matches legacy's `taxes − returns_tax` math.
        // Rule #10 sign convention: refund tax stored negative.
        const adjTaxRaw = Number(rli.total_tax ?? 0);
        if (Number.isFinite(adjTaxRaw) && Math.abs(adjTaxRaw) > 0.005) {
          const taxMagnitude = adjKind === "shipping_refund"
            ? Math.abs(adjTaxRaw)
            : adjTaxRaw;
          insertStmt.run({
            event_id: `refund_adjustment_tax:${rli.id}`,
            event_type: "refund",
            event_date: eventDate,
            order_id: rli.order_id,
            line_item_id: null,
            refund_id: rli.refund_id,
            refund_line_item_id: rli.id,
            is_gift_card: 0,
            gross: 0,
            discount: 0,
            tax: round2(-taxMagnitude),
            returns: 0,
            return_fees: 0,
            net_sales_gift_cards: 0,
            detector_source,
            detected_at,
          });
          summary.by_type.refund += 1;
          summary.events_inserted += 1;
        }

        if (adjKind === "shipping_refund") {
          // Skip subtotal: shipping refunds reduce shipping in PR #97's
          // shipping query, not the events ledger. Tax already handled
          // above via the adjustment-tax event.
          continue;
        }
        if (amount > 0.005) {
          // Retained fee — appears on Shopify Finance Summary "Return fees"
          insertStmt.run({
            event_id: `return_fee:${rli.id}`,
            event_type: "return_fee",
            event_date: eventDate,
            order_id: rli.order_id,
            line_item_id: null,
            refund_id: rli.refund_id,
            refund_line_item_id: rli.id,
            is_gift_card: 0,
            gross: 0,
            discount: 0,
            tax: 0,
            returns: 0,
            return_fees: round2(amount),
            net_sales_gift_cards: 0,
            detector_source,
            detected_at,
          });
          summary.by_type.return_fee += 1;
          summary.events_inserted += 1;
        } else if (amount < -0.005) {
          // Discrepancy adjustment — Shopify books this as additional
          // Returns (Rule #12). Stored positive on the returns column.
          insertStmt.run({
            event_id: `refund_discrepancy:${rli.id}`,
            event_type: "refund",
            event_date: eventDate,
            order_id: rli.order_id,
            line_item_id: null,
            refund_id: rli.refund_id,
            refund_line_item_id: rli.id,
            is_gift_card: 0,
            gross: 0,
            discount: 0,
            tax: 0,
            returns: round2(Math.abs(amount)),
            return_fees: 0,
            net_sales_gift_cards: 0,
            detector_source,
            detected_at,
          });
          summary.by_type.refund += 1;
          summary.events_inserted += 1;
        }
        // amount ≈ 0 → no event (e.g. zero-adjustment refunds)
      }
      // Other refund line kinds — currently none expected; would warn if seen.
    }

    // 4. UNVERIFIED_RETURN events (PR #95c, addition #3 — Rule #8).
    //    Same-order exchanges for store credit don't emit a refund row;
    //    Shopify encodes them via current_subtotal_price / current_total_tax
    //    deltas on the order itself. Legacy adds:
    //      Returns      += (o.subtotal − o.current_subtotal_price)
    //      Taxes delta  -= (o.total_tax − o.current_total_tax)
    //    on orders where the delta is non-zero AND no refund row exists.
    //    See shopify-finance-diff.ts Rule #8 block. Validated against
    //    Mar 2026 #37901 ($24.99 leash → $27.14 GC, pre-rule diff was
    //    +$17.14 / 0.007%, post-rule $0.00).
    //
    //    Bucket date: order recognized date (processed_at|created_at) —
    //    same as legacy's unverifiedBucketExpr default.
    const unverifiedRows = sqlite
      .prepare(`
        SELECT
          o.id, o.subtotal, o.current_subtotal_price,
          o.total_tax, o.current_total_tax,
          COALESCE(o.processed_at, o.created_at) AS event_date
        FROM recon_orders o
        WHERE NOT EXISTS (SELECT 1 FROM recon_refunds r WHERE r.order_id = o.id)
          AND o.current_subtotal_price IS NOT NULL
          AND o.subtotal IS NOT NULL
          AND (o.subtotal - o.current_subtotal_price) > 0
          ${opts.scope === "order" ? "AND o.id = ?" : ""}
      `)
      .all(...orderFilterParams) as Array<{
        id: string;
        subtotal: number | null;
        current_subtotal_price: number | null;
        total_tax: number | null;
        current_total_tax: number | null;
        event_date: string | null;
      }>;

    for (const row of unverifiedRows) {
      if (!row.event_date) continue;
      const subtotalDelta = Number(row.subtotal ?? 0) - Number(row.current_subtotal_price ?? 0);
      if (!(subtotalDelta > 0.005)) continue;
      // Tax delta uses legacy's exact predicate: include only when both
      // sides present and non-equal. Stored negative (Rule #10) so the
      // monthly SUM(tax) over events matches legacy's `taxes -= delta`.
      let taxDelta = 0;
      if (
        row.total_tax != null && row.current_total_tax != null &&
        Number(row.total_tax) !== Number(row.current_total_tax)
      ) {
        taxDelta = Number(row.total_tax) - Number(row.current_total_tax);
      }
      insertStmt.run({
        event_id: `unverified_return:${row.id}`,
        event_type: "refund",
        event_date: row.event_date,
        order_id: row.id,
        line_item_id: null,
        refund_id: null,
        refund_line_item_id: null,
        is_gift_card: 0,
        gross: 0,
        discount: 0,
        tax: round2(-taxDelta),
        returns: round2(subtotalDelta),
        return_fees: 0,
        net_sales_gift_cards: 0,
        detector_source,
        detected_at,
      });
      summary.by_type.refund += 1;
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

// ----- Read helpers (for PR #95 parallel validation) -----

export type EventsMonthlyRow = {
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
 * Aggregate events for a given month (YYYY-MM, store-local).
 *
 * This is the *future* shape of computeLocalFinanceSummary's core math.
 * PR #94 exposes it via a debug endpoint for inspection. PR #95 wires it
 * into a parallel-validation comparison. PR #97 promotes it to the
 * primary implementation.
 *
 * Net sales = gross − discounts − returns, matching Shopify's formula.
 * Shipping + shipping_tax are NOT in this query — they remain order-level
 * and are added by the caller in PR #97.
 */
export function aggregateRevenueEventsByMonth(monthKey: string): EventsMonthlyRow {
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
    FROM recon_revenue_events
    WHERE event_month = ?
  `).get(monthKey) as Omit<EventsMonthlyRow, "event_month" | "net_sales">;

  const net_sales = row.gross_sales - row.discounts - row.returns;
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

/**
 * List events for an order — used by PR #95's debug endpoint to inspect
 * exactly which rows the projector emitted for a given order.
 */
export type RevenueEventRow = {
  event_id: string;
  event_type: string;
  event_date: string;
  event_month: string;
  order_id: string;
  line_item_id: string | null;
  refund_id: string | null;
  refund_line_item_id: string | null;
  is_gift_card: number;
  gross: number;
  discount: number;
  tax: number;
  returns: number;
  return_fees: number;
  net_sales_gift_cards: number;
};

export function listEventsForOrder(orderId: string): RevenueEventRow[] {
  ensure();
  return sqlite.prepare(`
    SELECT event_id, event_type, event_date, event_month,
           order_id, line_item_id, refund_id, refund_line_item_id,
           is_gift_card, gross, discount, tax, returns, return_fees,
           net_sales_gift_cards
    FROM recon_revenue_events
    WHERE order_id = ?
    ORDER BY event_date ASC, event_type ASC, event_id ASC
  `).all(orderId) as RevenueEventRow[];
}

export type EventWarningRow = {
  id: number;
  order_id: string | null;
  refund_id: string | null;
  line_item_id: string | null;
  event_type: string | null;
  reason: string;
  detail_json: string | null;
  logged_at: string;
};

export function listRecentEventWarnings(limit = 100): EventWarningRow[] {
  ensure();
  return sqlite.prepare(`
    SELECT id, order_id, refund_id, line_item_id, event_type,
           reason, detail_json, logged_at
    FROM recon_event_warnings
    ORDER BY logged_at DESC
    LIMIT ?
  `).all(limit) as EventWarningRow[];
}
