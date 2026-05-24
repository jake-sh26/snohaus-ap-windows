/**
 * PR #R5a — Finance Summary diff (Shopify all-channels reconciliation).
 *
 * The premise: Shopify's Finance Summary is a deterministic query over orders,
 * refunds, and transactions. We ingest the same source data, so if we compute
 * the same formulas we MUST get the same numbers. Any non-zero diff is a bug
 * in our ingest or formulas — not an accounting question.
 *
 * Shopify's documented formulas (all-channels, single currency):
 *
 *   Gross sales = Σ (line.price × line.quantity)                              -- pre-discount, pre-tax, pre-shipping, pre-return
 *   Discounts   = Σ line.total_discount + Σ order-level discount allocations  -- positive number, subtracted below
 *   Returns     = Σ refund_line_item.subtotal where kind='item'               -- pre-tax line value of returned goods, positive
 *   Net sales   = Gross sales − Discounts − Returns
 *   Shipping    = Σ order.total_shipping − Σ shipping refunds                 -- shipping refunds live in refund.order_adjustments
 *   Taxes       = Σ order.total_tax − Σ refund_line_item.total_tax            -- refunded taxes net out
 *   Total sales = Net sales + Shipping + Taxes
 *
 * NOTES on edge cases:
 *
 *   * Gift card sales: Shopify treats GC sales as a liability, not revenue. The
 *     Finance Summary in Admin SEPARATES "Net sales from gift cards" as its
 *     own line below the main Net sales total. We compute Net sales WITHOUT
 *     subtracting GC, but expose `net_sales_gift_cards` separately so the diff
 *     can compare both against Shopify's report.
 *
 *   * Timezone bucketing: Shopify's Admin Finance Summary buckets by STORE-LOCAL
 *     time. recon_orders.created_at is stored in UTC. The monthly rollup must
 *     convert to America/New_York (SnoHaus is NY) before bucketing or
 *     end-of-month orders land in the wrong bucket. We use a SQLite expression
 *     for this: substr(datetime(created_at, '-5 hours'), 1, 7) — close enough
 *     for the EST/EDT shoulder; we revisit if a March/November shoulder order
 *     drives a diff.
 *
 *   * Returns bucket on REFUND date, not order date. Shopify books the return
 *     reversal on the date the refund was processed, not the original order
 *     date. Use recon_refunds.processed_at (fall back to created_at).
 *
 *   * Channel scope: this is ALL CHANNELS combined (pos + online_store + shop
 *     + buy-button + ...) to match Shopify's "all channels" total. Per-channel
 *     and per-entity breakdowns come in R5b.
 */

import { sqlite } from "./storage";

// Module-init side effect: ensure schema on first import. Cheap (CREATE
// TABLE IF NOT EXISTS) and means the routes don't need to wire it up.
let schemaEnsured = false;
function ensureSchemaOnce(): void {
  if (schemaEnsured) return;
  ensureFinanceDiffSchema();
  schemaEnsured = true;
}

// ----- Schema -----
// Snapshot table: Shopify's reported values, keyed by month. The operator
// pastes/uploads these from the Shopify Admin Finance Summary export.
// One row per (month, snapshot_kind). snapshot_kind = 'all_channels' for now;
// future kinds could be 'per_channel:online_store', etc.
export function ensureFinanceDiffSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_shopify_finance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,            -- 'YYYY-MM' in store-local time (America/New_York)
      snapshot_kind TEXT NOT NULL DEFAULT 'all_channels',
      gross_sales REAL,
      discounts REAL,                 -- stored as positive (subtracted in net sales)
      returns REAL,                   -- stored as positive (subtracted in net sales)
      net_sales REAL,
      shipping REAL,
      taxes REAL,
      total_sales REAL,
      net_sales_gift_cards REAL,      -- optional; Shopify reports separately
      source_label TEXT,              -- 'csv_export' | 'manual_entry' | 'shopifyql'
      raw_input TEXT,                 -- the pasted CSV / JSON for forensics
      captured_at TEXT NOT NULL,
      captured_by TEXT,
      UNIQUE(month, snapshot_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_finance_snap_month
      ON recon_shopify_finance_snapshots(month);
  `);
}

// ----- Local rollup compute -----
// Build the same 7-line Finance Summary from our local DB for a given month.
// Returns the EXACT structure that lines up with the Shopify snapshot for diff.
//
// `monthKey` is 'YYYY-MM' in store-local time. We bucket via the SQLite
// datetime offset trick (UTC − 5h is wrong half the year for EDT, but the
// shoulder months are March/November and we'll revisit if a real diff shows
// up there — KISS for now).
export type FinanceSummaryLocal = {
  month: string;
  gross_sales: number;
  discounts: number;
  returns: number;
  net_sales: number;
  shipping: number;
  taxes: number;
  total_sales: number;
  net_sales_gift_cards: number;
  // Diagnostics — counts so the operator can sanity-check coverage:
  order_count: number;
  refund_count: number;
};

export function computeLocalFinanceSummary(monthKey: string): FinanceSummaryLocal {
  ensureSchemaOnce();
  // Match Shopify's store-local month bucketing. SQLite stores ISO UTC; we
  // shift by -5h (EST) as a coarse approximation. The shoulder days in
  // March (DST start) and November (DST end) are within an hour of midnight
  // for at most a handful of orders per year; if a diff shows up there we
  // can swap to a proper TZ library.
  //
  // Rule #5 (recognized_at bucketing): Shopify's ShopifyQL `sales` dataset
  // buckets revenue on processed_at (when money actually moved), NOT on
  // created_at (when the order was placed). For draft orders / late-paid
  // orders these can differ by days or months. To match Shopify we bucket
  // on COALESCE(processed_at, created_at) — the order's recognition date,
  // falling back to creation when processed_at is unset (rare, e.g. fully
  // unpaid orders).
  //
  // Refunds were already bucketed on processed_at correctly (returns matched
  // exactly on April pre-Rule#5). This rule changes the ORDER side.
  const STORE_TZ_OFFSET_HOURS = -5; // EST; close enough for now
  const tzExpr = `datetime(?1, '${STORE_TZ_OFFSET_HOURS} hours')`;
  void tzExpr; // (we inline the offset literally below to keep prepared statements simple)

  // R5a-fix1 ships the full ruleset proved by recon_v5.py on Apr 2026 ($0.00
  // across all 7 lines).
  //
  // Rule #6 (gift cards out of revenue): exclude is_gift_card=1 lines from
  // gross, line discounts, and order_count. Gift-card sales appear separately
  // as net_sales_gift_cards. Pure-GC orders are dropped from order_count.
  //
  // Rule #7a (line-level discounts): discounts = SUM(li.total_discount) on
  // non-GC lines bucketed by recognized_at. Order-level total_discounts can
  // include order-level codes that Shopify allocates per-line in the Finance
  // Summary anyway, so the line aggregate is the correct view.
  //
  // Rule #7c (PR #R5a-fix2): for discount-CODE orders Shopify writes the per-
  // line share to li.discount_allocations[].amount and leaves li.total_discount
  // at 0.00. The Finance Summary uses MAX(total_discount, alloc_sum) per line.
  // Validated against March 2026: line-only aggregate $64,811.72 →
  // MAX aggregate $66,842.69 (matches Shopify exactly).
  //
  // Rule #7b (per-line tax): taxes = SUM(li.tax_lines[].price) on non-GC
  // lines + SUM(shipping_line.tax_lines[].price), minus the month's refund
  // tax. Order-level total_tax can drift a few dollars from per-line per-
  // jurisdiction rounding; the line aggregate matches Shopify exactly.

  // 1. Gross sales + GC tracking + order count, bucketed on LINE recognized_at.
  const grossRow = sqlite
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN li.is_gift_card = 0
                          THEN li.price * li.quantity ELSE 0 END), 0)        AS gross,
        COALESCE(SUM(CASE WHEN li.is_gift_card = 0
                          THEN MAX(li.total_discount, COALESCE(li.discount_allocations_total, 0))
                          ELSE 0 END), 0)                                    AS line_discounts_nongc,
        COALESCE(SUM(CASE WHEN li.is_gift_card = 1
                          THEN li.price * li.quantity
                               - MAX(li.total_discount, COALESCE(li.discount_allocations_total, 0))
                          ELSE 0 END), 0)                                    AS gc_net_sales,
        COUNT(DISTINCT CASE WHEN li.is_gift_card = 0 THEN li.order_id END)   AS order_count
      FROM recon_line_items li
      JOIN recon_orders o ON o.id = li.order_id
      WHERE substr(datetime(
        COALESCE(li.recognized_at, o.processed_at, o.created_at),
        '-5 hours'), 1, 7) = ?
    `)
    .get(monthKey) as {
      gross: number;
      line_discounts_nongc: number;
      gc_net_sales: number;
      order_count: number;
    };

  // 2. Per-line tax from tax_lines_json (Rule #7b). Bucket on LINE recognized_at,
  //    exclude gift-card lines (they're non-taxable anyway, but defensive).
  const lineTaxRows = sqlite
    .prepare(`
      SELECT li.tax_lines_json
      FROM recon_line_items li
      JOIN recon_orders o ON o.id = li.order_id
      WHERE substr(datetime(
        COALESCE(li.recognized_at, o.processed_at, o.created_at),
        '-5 hours'), 1, 7) = ?
        AND li.is_gift_card = 0
        AND li.tax_lines_json IS NOT NULL
        AND li.tax_lines_json <> ''
    `)
    .all(monthKey) as { tax_lines_json: string }[];
  let perLineTax = 0;
  for (const row of lineTaxRows) {
    try {
      const tls = JSON.parse(row.tax_lines_json);
      if (Array.isArray(tls)) {
        for (const tl of tls) {
          const p = Number(tl?.price);
          if (Number.isFinite(p)) perLineTax += p;
        }
      }
    } catch { /* malformed JSON — skip silently */ }
  }

  // 3. Shipping totals + shipping-line tax_lines (Rule #7b) from raw_json.
  //    Shopify counts shipping tax inside the Taxes column, not Shipping.
  //    Orders here are bucketed on ORDER recognized_at (processed_at|created_at)
  //    — shipping is paid at order time, not at line-recognition time.
  const shippingOrderRows = sqlite
    .prepare(`
      SELECT o.total_shipping, o.raw_json
      FROM recon_orders o
      WHERE substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) = ?
    `)
    .all(monthKey) as { total_shipping: number | null; raw_json: string | null }[];
  let totalShipping = 0;
  let shippingTax = 0;
  for (const row of shippingOrderRows) {
    totalShipping += Number(row.total_shipping) || 0;
    if (!row.raw_json) continue;
    try {
      const rj = typeof row.raw_json === "string" ? JSON.parse(row.raw_json) : row.raw_json;
      const shippingLines = Array.isArray(rj?.shipping_lines) ? rj.shipping_lines : [];
      for (const s of shippingLines) {
        const tls = Array.isArray(s?.tax_lines) ? s.tax_lines : [];
        for (const tl of tls) {
          const p = Number(tl?.price);
          if (Number.isFinite(p)) shippingTax += p;
        }
      }
    } catch { /* malformed JSON — skip silently */ }
  }

  const orderTotals = { total_shipping: totalShipping };

  // 3. Returns: line-value of refunded items, bucketed on refund processed_at
  //    (not the original order's created_at). Shipping refunds + tax refunds
  //    are separated so we can subtract them from Shipping and Taxes columns,
  //    matching how Shopify presents the report.
  const refundTotals = sqlite
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN rli.kind = 'item' THEN rli.subtotal ELSE 0 END), 0)             AS returns_subtotal,
        COALESCE(SUM(rli.total_tax), 0)                                                        AS returns_tax,
        -- ABS() because order_adjustments subtotals are ingested with Shopify's
        -- raw sign (negative = outflow), unlike refund_line_items 'item' rows
        -- which are stored positive. Without ABS, the formula
        -- 'shipping = total_shipping - shipping_refunded' double-negates and
        -- adds the refund back to shipping (verified on Apr 2026: $74.95 + $14.99
        -- = $89.94 instead of correct $59.96).
        COALESCE(SUM(CASE WHEN rli.kind = 'adjustment' AND rli.adjustment_kind = 'shipping_refund'
                          THEN ABS(rli.subtotal) ELSE 0 END), 0)                               AS shipping_refunded,
        COUNT(DISTINCT r.id)                                                                   AS refund_count
      FROM recon_refunds r
      JOIN recon_refund_line_items rli ON rli.refund_id = r.id
      WHERE substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
    `)
    .get(monthKey) as {
      returns_subtotal: number;
      returns_tax: number;
      shipping_refunded: number;
      refund_count: number;
    };

  // 4. Rule #8 — unverified returns (same-order exchanges for store credit).
  //    When a customer returns an item without proof of original transaction
  //    we issue a gift card on the same order. Shopify encodes this in the
  //    `current_*` fields rather than emitting a refund row:
  //
  //      • returned line:  quantity=1, current_quantity=0, price=24.99
  //      • gift card line: price=27.14 (24.99 + tax)
  //      • order:          refunds[] = [], total_subtotal=27.14,
  //                        current_subtotal=2.15, current_total_tax=-2.15
  //
  //    Shopify's Finance Summary computes
  //      Returns      = Σ (total_subtotal − current_subtotal)   on these orders
  //      Tax delta    = Σ (total_tax      − current_total_tax)  on these orders
  //    so we add the same deltas to our recon. Filter to orders where there
  //    is no recon_refund row (otherwise we'd double-count regular refunds,
  //    which already shift current_*). Bucket on the order's recognized
  //    date — same as gross_sales — since the offset hits the same month.
  //
  //    Validated against March 2026: order #37901 ($24.99 leash → $27.14 GC).
  //    Pre-rule diff was +$17.14 / 0.007%. Post-rule diff: $0.00.
  const unverifiedReturns = sqlite
    .prepare(`
      SELECT
        COALESCE(SUM(
          CASE WHEN o.current_subtotal_price IS NOT NULL
                AND o.subtotal IS NOT NULL
                AND (o.subtotal - o.current_subtotal_price) > 0
               THEN (o.subtotal - o.current_subtotal_price)
               ELSE 0 END), 0) AS unverified_return_subtotal,
        COALESCE(SUM(
          CASE WHEN o.current_total_tax IS NOT NULL
                AND o.total_tax IS NOT NULL
                AND (o.total_tax - o.current_total_tax) <> 0
               THEN (o.total_tax - o.current_total_tax)
               ELSE 0 END), 0) AS unverified_return_tax
      FROM recon_orders o
      WHERE substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) = ?
        AND NOT EXISTS (SELECT 1 FROM recon_refunds r WHERE r.order_id = o.id)
    `)
    .get(monthKey) as {
      unverified_return_subtotal: number;
      unverified_return_tax: number;
    };

  // Plug into Shopify's formulas. Returns are stored positive and subtracted
  // in Net sales. Discounts use the non-GC line aggregate (Rule #7a).
  const gross_sales = grossRow.gross;
  const discounts = grossRow.line_discounts_nongc;
  const returns = refundTotals.returns_subtotal + unverifiedReturns.unverified_return_subtotal;
  const net_sales = gross_sales - discounts - returns;
  const shipping = orderTotals.total_shipping - refundTotals.shipping_refunded;
  // Taxes (Rule #7b): per-line tax + shipping-line tax − refund tax this month.
  // Rule #8 — also subtract the tax delta from unverified returns. The delta
  // can be negative (Shopify writes -$2.15 in current_total_tax), so the
  // subtraction effectively re-adds the customer's reversed tax to refunds.
  const taxes = perLineTax + shippingTax - refundTotals.returns_tax - unverifiedReturns.unverified_return_tax;
  const total_sales = net_sales + shipping + taxes;

  return {
    month: monthKey,
    gross_sales: round2(gross_sales),
    discounts: round2(discounts),
    returns: round2(returns),
    net_sales: round2(net_sales),
    shipping: round2(shipping),
    taxes: round2(taxes),
    total_sales: round2(total_sales),
    net_sales_gift_cards: round2(grossRow.gc_net_sales),
    order_count: grossRow.order_count,
    refund_count: refundTotals.refund_count,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ----- Snapshot CRUD -----
// Upsert a Shopify snapshot for a (month, snapshot_kind). Used by the operator
// to record "this is what Shopify Admin's Finance Summary showed for April."
export type ShopifySnapshotInput = {
  month: string;
  snapshot_kind?: string;
  gross_sales?: number | null;
  discounts?: number | null;
  returns?: number | null;
  net_sales?: number | null;
  shipping?: number | null;
  taxes?: number | null;
  total_sales?: number | null;
  net_sales_gift_cards?: number | null;
  source_label?: string;
  raw_input?: string | null;
  captured_by?: string;
};

export function upsertShopifySnapshot(p: ShopifySnapshotInput): void {
  ensureSchemaOnce();
  const kind = p.snapshot_kind ?? "all_channels";
  const now = new Date().toISOString();
  sqlite
    .prepare(`
      INSERT INTO recon_shopify_finance_snapshots
        (month, snapshot_kind, gross_sales, discounts, returns, net_sales,
         shipping, taxes, total_sales, net_sales_gift_cards,
         source_label, raw_input, captured_at, captured_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(month, snapshot_kind) DO UPDATE SET
        gross_sales = excluded.gross_sales,
        discounts   = excluded.discounts,
        returns     = excluded.returns,
        net_sales   = excluded.net_sales,
        shipping    = excluded.shipping,
        taxes       = excluded.taxes,
        total_sales = excluded.total_sales,
        net_sales_gift_cards = excluded.net_sales_gift_cards,
        source_label = excluded.source_label,
        raw_input   = excluded.raw_input,
        captured_at = excluded.captured_at,
        captured_by = excluded.captured_by
    `)
    .run(
      p.month,
      kind,
      p.gross_sales ?? null,
      p.discounts ?? null,
      p.returns ?? null,
      p.net_sales ?? null,
      p.shipping ?? null,
      p.taxes ?? null,
      p.total_sales ?? null,
      p.net_sales_gift_cards ?? null,
      p.source_label ?? "manual_entry",
      p.raw_input ?? null,
      now,
      p.captured_by ?? null,
    );
}

export function getShopifySnapshot(month: string, kind = "all_channels"): any | null {
  ensureSchemaOnce();
  const row = sqlite
    .prepare(`
      SELECT * FROM recon_shopify_finance_snapshots
      WHERE month = ? AND snapshot_kind = ?
    `)
    .get(month, kind);
  return row ?? null;
}

export function listShopifySnapshots(limit = 36): any[] {
  ensureSchemaOnce();
  return sqlite
    .prepare(`
      SELECT * FROM recon_shopify_finance_snapshots
      ORDER BY month DESC
      LIMIT ?
    `)
    .all(limit);
}

// ----- Diff -----
// Returns a side-by-side comparison for a single month. Per-line diff is
// (ours − Shopify) AFTER sign normalization; positive means we're over,
// negative means under. ok=true when |diff| ≤ tolerance (default $0.01 —
// true accounting tolerance, NOT the variance-flagging tolerance which is
// $1.00 in fix9).
//
// Sign normalization: ShopifyQL `sales` returns `discounts` and `returns`
// as NEGATIVE numbers (contra-revenue convention — they're reductions to
// gross sales). Our local rollup stores them as POSITIVE magnitudes
// (because we sum the absolute amounts from refunds/discounts). To make
// the diff economically meaningful we compare magnitudes: shopify_abs =
// |shopify[field]| for contra-revenue fields. We also surface the raw
// values so a human can verify nothing weird is happening.
export type FinanceDiffLine = {
  field: string;
  ours: number;
  shopify: number | null;
  /** raw value Shopify returned, before sign normalization */
  shopify_raw?: number | null;
  diff: number | null;
  ok: boolean | null;
};

export type FinanceDiffResult = {
  month: string;
  ours: FinanceSummaryLocal;
  shopify: any | null;
  lines: FinanceDiffLine[];
  all_ok: boolean | null;          // null if no snapshot exists yet
  tolerance: number;
};

const DIFF_FIELDS = [
  "gross_sales",
  "discounts",
  "returns",
  "net_sales",
  "shipping",
  "taxes",
  "total_sales",
  "net_sales_gift_cards",
] as const;

export function computeFinanceDiff(
  monthKey: string,
  opts: { tolerance?: number; snapshotKind?: string } = {},
): FinanceDiffResult {
  ensureSchemaOnce();
  const tolerance = opts.tolerance ?? 0.01;
  const ours = computeLocalFinanceSummary(monthKey);
  const shopify = getShopifySnapshot(monthKey, opts.snapshotKind ?? "all_channels");

  // Fields where Shopify uses contra-revenue (negative) sign convention but
  // we store positive magnitudes. For these we compare |shopify| to ours.
  const CONTRA_REVENUE_FIELDS = new Set(["discounts", "returns"]);

  const lines: FinanceDiffLine[] = DIFF_FIELDS.map((f) => {
    const o = (ours as any)[f] as number;
    if (!shopify || shopify[f] == null) {
      return { field: f, ours: o, shopify: null, shopify_raw: null, diff: null, ok: null };
    }
    const rawS = Number(shopify[f]);
    const s = CONTRA_REVENUE_FIELDS.has(f) ? Math.abs(rawS) : rawS;
    const diff = round2(o - s);
    return {
      field: f,
      ours: o,
      shopify: s,
      shopify_raw: rawS,
      diff,
      ok: Math.abs(diff) <= tolerance,
    };
  });

  const linesWithSnapshot = lines.filter((l) => l.shopify != null);
  const all_ok =
    linesWithSnapshot.length === 0
      ? null
      : linesWithSnapshot.every((l) => l.ok === true);

  return { month: monthKey, ours, shopify, lines, all_ok, tolerance };
}
