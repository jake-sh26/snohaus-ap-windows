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
  // Idempotent column add for return_fees (Shopify's Finance Summary added
  // "Return fees" as a separate line between Shipping and Taxes — e.g. Apr
  // 2025 +$10, Mar 2026 +$10). Older deployments don't have the column; this
  // backfills it on first import after the upgrade.
  try {
    sqlite.exec(`ALTER TABLE recon_shopify_finance_snapshots ADD COLUMN return_fees REAL`);
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    if (!/duplicate column name|already exists/i.test(msg)) throw e;
  }
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
  return_fees: number;
  taxes: number;
  total_sales: number;
  net_sales_gift_cards: number;
  // Diagnostics — counts so the operator can sanity-check coverage:
  order_count: number;
  refund_count: number;
  // Debug components (only present when computeLocalFinanceSummary is called
  // with { includeComponents: true } via the debug endpoint).
  _components?: {
    per_line_tax: number;
    shipping_tax: number;
    returns_tax: number;
    unverified_return_tax: number;
    retained_fees: number;
    total_shipping_orders: number;
    shipping_refunded: number;
    returns_subtotal: number;
    unverified_return_subtotal: number;
    discrepancy_returns: number;
    gc_refund_subtotal: number;
  };
};

// `bucketBy` controls how lines are time-bucketed for the SALE side
// (gross, line_tax). Returns are ALWAYS bucketed on refund.processed_at
// (matches Shopify exactly).
//
// Per Shopify Help docs (Total Sales Reports), verbatim:
//   "Sales display in your sales reports as a positive value for the day
//    that they were made, and reversals display as a negative value for
//    the day that they were processed."
//
// Options:
//   - 'line_recognized_at' (current default): bucket each line on
//     COALESCE(li.recognized_at, o.processed_at, o.created_at). GAAP-correct
//     deferred revenue recognition (line recognized when fulfilled). Reused
//     by Phase 2 for QBO JE posting. DOES NOT MATCH Shopify Finance Summary.
//   - 'order_processed_at': bucket on COALESCE(o.processed_at, o.created_at).
//     Matches "the day money moved."
//   - 'order_created_at': bucket on o.created_at exactly. Matches Shopify
//     Help docs verbatim — "the day the order was placed."
//
// `discountBucketBy` and `unverifiedBucketBy` control the OTHER sale-side
// buckets independently so we can test which knob actually closes Oct/Nov.
// Defaults preserve current behavior exactly.
export function computeLocalFinanceSummary(
  monthKey: string,
  opts?: {
    includeComponents?: boolean;
    bucketBy?: 'line_recognized_at' | 'order_processed_at' | 'order_created_at';
    discountBucketBy?: 'order_processed_at' | 'order_created_at';
    shippingBucketBy?: 'order_processed_at' | 'order_created_at';
    unverifiedBucketBy?: 'order_processed_at' | 'order_created_at';
  },
): FinanceSummaryLocal {
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

  // 1. Gross sales + GC tracking + order count.
  // Bucket expression depends on opts.bucketBy. Default = line.recognized_at
  // (deferred fulfillment recognition). 'order_processed_at' matches Shopify
  // Finance Summary's behavior.
  const bucketBy = opts?.bucketBy ?? 'line_recognized_at';
  const discountBucketBy = opts?.discountBucketBy ?? 'order_processed_at';
  const shippingBucketBy = opts?.shippingBucketBy ?? 'order_processed_at';
  const unverifiedBucketBy = opts?.unverifiedBucketBy ?? 'order_processed_at';
  const grossBucketExpr =
    bucketBy === 'order_created_at'
      ? `o.created_at`
      : bucketBy === 'order_processed_at'
      ? `COALESCE(o.processed_at, o.created_at)`
      : `COALESCE(li.recognized_at, o.processed_at, o.created_at)`;
  const orderDateExprFor = (mode: 'order_processed_at' | 'order_created_at') =>
    mode === 'order_created_at' ? `o.created_at` : `COALESCE(o.processed_at, o.created_at)`;
  const shippingBucketExpr = orderDateExprFor(shippingBucketBy);
  const unverifiedBucketExpr = orderDateExprFor(unverifiedBucketBy);
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
        ${grossBucketExpr},
        '-5 hours'), 1, 7) = ?
    `)
    .get(monthKey) as {
      gross: number;
      line_discounts_nongc: number;
      gc_net_sales: number;
      order_count: number;
    };

  // 2. Per-line tax from tax_lines_json (Rule #7b). Use the same bucketBy
  //    as gross so tax stays consistent with the lines it's collected on.
  //    Exclude gift-card lines (they're non-taxable anyway, but defensive).
  const lineTaxRows = sqlite
    .prepare(`
      SELECT li.tax_lines_json
      FROM recon_line_items li
      JOIN recon_orders o ON o.id = li.order_id
      WHERE substr(datetime(
        ${grossBucketExpr},
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
      WHERE substr(datetime(${shippingBucketExpr}, '-5 hours'), 1, 7) = ?
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
        -- Rule #11 — exclude gift card refunds from returns_subtotal/tax.
        -- Gift card SALES are recognized as a liability, not revenue
        -- (Rule #6 already excludes is_gift_card=1 from gross_sales and
        -- reports them separately as net_sales_gift_cards). For symmetry,
        -- refunds of gift card line items must ALSO be excluded from
        -- Returns — otherwise we'd reduce returns by an amount that was
        -- never in revenue in the first place.
        -- Validated on Dec 2025 / order #25819: a $81.56 gift card refund
        -- (line_item.gift_card=true, restock_type='no_restock', tax=0) was
        -- our entire Dec returns over-count vs Shopify Finance Summary.
        -- LEFT JOIN because adjustment rows don't have a line_item_id;
        -- COALESCE(li.is_gift_card, 0) = 0 keeps adjustments included.
        COALESCE(SUM(CASE WHEN rli.kind = 'item'
                            AND COALESCE(li.is_gift_card, 0) = 0
                          THEN rli.subtotal ELSE 0 END), 0)                                    AS returns_subtotal,
        -- Rule #10 — sign convention for refund line item tax:
        --   item rows store positive total_tax (positive on the wire from Shopify).
        --   shipping_refund adjustment rows store SIGNED tax_amount, where a
        --     negative value (e.g. -0.90) means "this much tax is being refunded
        --     back to the customer" — which should INCREASE returns_tax (so it
        --     gets subtracted from our reported tax).
        -- Stored signed, the raw SUM lets the negative cancel/flip the
        -- subtraction. So we take ABS() of shipping_refund tax to make it
        -- contribute its full magnitude to returns_tax.
        -- Other adjustment kinds (restocking_fee, refund_discrepancy) typically
        -- have tax_amount=0; we leave their handling unchanged.
        -- Bug found Jan 2026: #25524 had shipping_refund.tax_amount=-0.90
        -- stored as total_tax=-0.90. Sum-as-stored made the -taxes -=- returns_tax
        -- formula effectively ADD 0.90 back instead of subtract it (+1.80 overage).
        -- Same pattern in Dec: #26507 tax_amount=-1.32 → +2.64 overage.
        -- Rule #11: also exclude gift card item tax (always $0 in practice).
        COALESCE(SUM(
          CASE WHEN rli.kind = 'item' AND COALESCE(li.is_gift_card, 0) = 0
                    THEN rli.total_tax
               WHEN rli.kind = 'adjustment' AND rli.adjustment_kind = 'shipping_refund'
                    THEN ABS(rli.total_tax)
               WHEN rli.kind = 'adjustment' THEN rli.total_tax
               ELSE 0 END
        ), 0)                                                                                  AS returns_tax,
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
      LEFT JOIN recon_line_items li ON li.id = rli.line_item_id
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
      WHERE substr(datetime(${unverifiedBucketExpr}, '-5 hours'), 1, 7) = ?
        AND NOT EXISTS (SELECT 1 FROM recon_refunds r WHERE r.order_id = o.id)
    `)
    .get(monthKey) as {
      unverified_return_subtotal: number;
      unverified_return_tax: number;
    };

  // 5. Rule #9 — return shipping fees retained.
  //    When a customer returns merchandise via mail, Sno-Haus deducts a $10
  //    return shipping fee from the cash refund (e.g. #35232: returned $230
  //    merchandise, customer received $220 cash, $10 retained as fee revenue).
  //
  //    Shopify encodes this with TWO patterns simultaneously:
  //      (a) a pair of offsetting `refund_discrepancy` order_adjustments on
  //          the refund (e.g. +$220 / -$220) — these net to $0 in the refunds
  //          table, so they don't show up in our 'returns' aggregate, AND
  //      (b) a positive `current_total_price` on the order equal to the fee.
  //
  //    Shopify's Finance Summary books the retained fee in `total_sales`
  //    on the refund's processed_at month (not the original order's month).
  //    To match, we sum `current_total_price` for orders whose refunds this
  //    month contain a `refund_discrepancy` adjustment.
  //
  //    Detection rationale: refund_discrepancy is Shopify's specific marker
  //    for "this refund's cash amount didn't match the merchandise value";
  //    we cross-check current_total_price > 0 so we only book actual retained
  //    revenue (zero on full returns where the discrepancy was a Shopify-side
  //    payout rounding artifact, like #37402 and #35100).
  //
  //    Important caveat: refund_discrepancy is also used by Shopify for tiny
  //    payment-processor rounding artifacts unrelated to return fees (e.g.
  //    a ±$1.08 pair on order #35518 in Feb 2026). In those cases the order's
  //    `current_total_price` reflects an unrelated unrefunded balance (e.g.
  //    customer kept some items) and should NOT be booked as retained revenue.
  //
  //    Discriminator (Rule #9e — Jan 2026 #33393 / March 2026 #35232):
  //    The unrefunded balance is a FEE (not retained merchandise) iff:
  //      current_subtotal_price = 0 AND current_total_tax = 0
  //      AND current_total_price > 0
  //    This means "no merch and no tax is outstanding" but money is still
  //    owed/kept — i.e. a return-shipping fee. Validated against:
  //
  //      • #35232 (real fee, fires ✓):
  //          subtotal=230, current_subtotal_price=0,
  //          total_tax=0,  current_total_tax=0,
  //          current_total_price=$10 → pure fee. Fires ✓
  //      • #33393 (false positive, excluded):
  //          current_subtotal_price=$39.99 (customer kept merch),
  //          current_total_tax=$3.45,
  //          current_total_price=$43.44 → unrefunded merchandise.
  //          Doesn't fire ✓
  //      • #35518 (rounding artifact, excluded):
  //          current_subtotal_price>0 → doesn't fire ✓
  //
  //    Note: the previous rd MAX-vs-ctp / SUM-vs-ctp discriminators both
  //    failed because the rd adjustments are always paired-and-reversed
  //    in Shopify's wire format (they zero out the discrepancy bookkeeping).
  //    The actual signal of a retained fee lives in current_*, not rd_*.
  const retainedFees = sqlite
    .prepare(`
      SELECT COALESCE(SUM(o.current_total_price), 0) AS retained_total
      FROM recon_orders o
      WHERE o.current_total_price IS NOT NULL
        AND o.current_total_price > 0
        AND COALESCE(o.current_subtotal_price, 0) = 0
        AND COALESCE(o.current_total_tax, 0) = 0
        AND EXISTS (
          SELECT 1
          FROM recon_refunds r
          WHERE r.order_id = o.id
            AND EXISTS (
              SELECT 1 FROM recon_refund_line_items rli
               WHERE rli.refund_id = r.id
                 AND rli.kind = 'adjustment'
                 AND rli.adjustment_kind = 'refund_discrepancy'
            )
            AND substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
        )
    `)
    .get(monthKey) as { retained_total: number };

  // 6. Rule #11b — gift-card liability symmetry on net_sales_gift_cards.
  //
  //    Rule #6 builds net_sales_gift_cards from the SALE side only
  //    (Σ li.price × li.quantity − line discounts WHERE is_gift_card=1).
  //    Shopify ALSO nets gift-card REFUNDS out of net_sales_gift_cards in
  //    its Finance Summary — same way it nets merchandise refunds out of
  //    Returns. Without this rule, any month with a refund of a
  //    previously-sold gift card has our net_sales_gift_cards over-stated
  //    by the refund amount.
  //
  //    Bucketing: on refund.processed_at (mirrors Returns bucketing), not
  //    on the original sale's recognized_at.
  //
  //    Detection: refund_line_item.kind='item' AND li.is_gift_card=1 (the
  //    same join+filter Rule #11 uses to EXCLUDE these from main Returns).
  //    Rule #11 keeps them out of Returns; Rule #11b nets them out of GC.
  //
  //    Validated against Feb 2025 (#20790: $32.59 GC refund, Feb 20):
  //      pre-fix gc_diff = +$32.59 (ours over)
  //      post-fix gc_diff = $0.00
  //    Also predicts Jan 25 +$50, Mar 25 +$488.80, May 25 +$195.54 close.
  const gcRefundRow = sqlite
    .prepare(`
      SELECT COALESCE(SUM(rli.subtotal), 0) AS gc_refund_subtotal
      FROM recon_refunds r
      JOIN recon_refund_line_items rli ON rli.refund_id = r.id
      JOIN recon_line_items li ON li.id = rli.line_item_id
      WHERE rli.kind = 'item'
        AND li.is_gift_card = 1
        AND substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
    `)
    .get(monthKey) as { gc_refund_subtotal: number };

  // 7. Rule #12 — pure refund_discrepancy as Return.
  //
  //    The remaining unmodeled refund pattern is the "price error" /
  //    discount-match cash refund: customer keeps the merchandise, but we
  //    issue a cash refund anyway because we overcharged. Shopify encodes
  //    this as a refund with:
  //      • refund_line_items: ONE adjustment line, kind='refund_discrepancy'
  //      • refund.adjustment_amount = -X  (negative = money leaving us)
  //      • refund.total_refunded = X      (the cash that moved)
  //      • refund.subtotal = 0, total_tax = 0  (no item rows)
  //    Shopify books this in Returns (reduces Net sales by X).
  //
  //    Discriminator — Rule #12 fires only on orders where Rule #9 retained-
  //    fees does NOT fire. The two patterns are mutually exclusive in
  //    practice:
  //      • Rule #9 (retained fee) fires iff current_subtotal_price=0 AND
  //        current_total_tax=0 AND current_total_price>0 — i.e. customer
  //        returned all merch and we kept the $10 return-shipping fee.
  //      • Rule #12 (price error) fires when customer KEEPS merch — i.e.
  //        current_subtotal_price > 0 — and gets a cash discrepancy back.
  //    So we filter Rule #12 to orders NOT matching Rule #9's discriminator.
  //
  //    Using refund.adjustment_amount (the per-refund net) instead of
  //    SUM(rli.subtotal WHERE adjustment_kind='refund_discrepancy') means
  //    Shopify's own per-refund pairing nets WITHIN the refund row. The
  //    #21526 case has refund A with rli=[-24.99, +244.99, -244.99] all
  //    inside one refund — adjustment_amount nets those to -24.99
  //    automatically. We don't need to re-derive pair detection here.
  //
  //    Why not just use adjustment_amount unconditionally? Because Rule #9
  //    orders ALSO have a non-zero adjustment_amount per refund (#21526
  //    refund A: -24.99, refund B: +9.99 = ±$15 net). Booking either as
  //    a Return would double-count on top of the item lines that ARE
  //    captured by Rule #11's returns_subtotal.
  //
  //    Validated against:
  //      • Jan 25 #19670 (Oakley discount match, $129.92, kept merch)
  //          → Rule #9 doesn't fire (current_sub=$333.99) → +$129.92 Return
  //      • Feb 25 #20368 (Price error, $5.43, kept merch)
  //          → Rule #9 doesn't fire (current_sub=$89.95) → +$5.43 Return
  //      • Jun 25 #21876 ($500, kept merch)
  //          → Rule #9 doesn't fire (current_sub=$3185) → +$500 Return
  //      • Apr 25 #21526 (real return + retained fee)
  //          → Rule #9 FIRES (current_sub=0, current_total=$10)
  //          → Rule #12 skipped, no double-count
  //
  //    We use ABS(adjustment_amount) because the sign convention is
  //    "negative = money leaving us" (which is exactly a Return). Storing
  //    Returns as positive magnitudes matches our other Returns sources.
  const discrepancyReturnsRow = sqlite
    .prepare(`
      SELECT COALESCE(SUM(ABS(r.adjustment_amount)), 0) AS discrepancy_returns
      FROM recon_refunds r
      JOIN recon_orders o ON o.id = r.order_id
      WHERE r.adjustment_amount IS NOT NULL
        AND ABS(r.adjustment_amount) > 0.005
        AND substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
        AND EXISTS (
          SELECT 1 FROM recon_refund_line_items rli
           WHERE rli.refund_id = r.id
             AND rli.kind = 'adjustment'
             AND rli.adjustment_kind = 'refund_discrepancy'
        )
        -- Rule #9 retained-fee discriminator (inverted): fires only when
        -- the order is NOT a retained-fee scenario. A retained-fee order
        -- has current_subtotal_price=0 AND current_total_tax=0 AND
        -- current_total_price>0. We exclude those orders so Rule #9 stays
        -- the source of truth for retained fees.
        AND NOT (
              o.current_total_price IS NOT NULL
          AND o.current_total_price > 0
          AND COALESCE(o.current_subtotal_price, 0) = 0
          AND COALESCE(o.current_total_tax, 0) = 0
        )
    `)
    .get(monthKey) as { discrepancy_returns: number };

  // Plug into Shopify's formulas. Returns are stored positive and subtracted
  // in Net sales. Discounts use the non-GC line aggregate (Rule #7a).
  const gross_sales = grossRow.gross;
  const discounts = grossRow.line_discounts_nongc;
  const returns =
    refundTotals.returns_subtotal
    + unverifiedReturns.unverified_return_subtotal
    + discrepancyReturnsRow.discrepancy_returns;  // Rule #12
  const net_sales = gross_sales - discounts - returns;
  const shipping = orderTotals.total_shipping - refundTotals.shipping_refunded;
  // Taxes (Rule #7b): per-line tax + shipping-line tax − refund tax this month.
  // Rule #8 — also subtract the tax delta from unverified returns. The delta
  // can be negative (Shopify writes -$2.15 in current_total_tax), so the
  // subtraction effectively re-adds the customer's reversed tax to refunds.
  const taxes = perLineTax + shippingTax - refundTotals.returns_tax - unverifiedReturns.unverified_return_tax;
  // Rule #9 surfaced as its own line (matches Shopify Finance Summary's
  // "Return fees" row — Apr 2025 +$10, Mar 2026 +$10). Total_sales math is
  // unchanged: net + shipping + taxes + return_fees (Shopify adds it to
  // total_sales but not to net/shipping/taxes individually).
  const return_fees = retainedFees.retained_total;
  const total_sales = net_sales + shipping + taxes + return_fees;
  // Rule #11b — net GC refunds out of net_sales_gift_cards. Bucketed on
  // refund.processed_at, mirroring main Returns bucketing.
  const net_sales_gift_cards = grossRow.gc_net_sales - gcRefundRow.gc_refund_subtotal;

  const result: FinanceSummaryLocal = {
    month: monthKey,
    gross_sales: round2(gross_sales),
    discounts: round2(discounts),
    returns: round2(returns),
    net_sales: round2(net_sales),
    shipping: round2(shipping),
    return_fees: round2(return_fees),
    taxes: round2(taxes),
    total_sales: round2(total_sales),
    net_sales_gift_cards: round2(net_sales_gift_cards),
    order_count: grossRow.order_count,
    refund_count: refundTotals.refund_count,
  };
  if (opts?.includeComponents) {
    result._components = {
      per_line_tax: round2(perLineTax),
      shipping_tax: round2(shippingTax),
      returns_tax: round2(refundTotals.returns_tax),
      unverified_return_tax: round2(unverifiedReturns.unverified_return_tax),
      retained_fees: round2(retainedFees.retained_total),
      total_shipping_orders: round2(orderTotals.total_shipping),
      shipping_refunded: round2(refundTotals.shipping_refunded),
      returns_subtotal: round2(refundTotals.returns_subtotal),
      unverified_return_subtotal: round2(unverifiedReturns.unverified_return_subtotal),
      discrepancy_returns: round2(discrepancyReturnsRow.discrepancy_returns),
      gc_refund_subtotal: round2(gcRefundRow.gc_refund_subtotal),
    };
  }
  return result;
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
  return_fees?: number | null;
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
         shipping, return_fees, taxes, total_sales, net_sales_gift_cards,
         source_label, raw_input, captured_at, captured_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(month, snapshot_kind) DO UPDATE SET
        gross_sales = excluded.gross_sales,
        discounts   = excluded.discounts,
        returns     = excluded.returns,
        net_sales   = excluded.net_sales,
        shipping    = excluded.shipping,
        return_fees = excluded.return_fees,
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
      p.return_fees ?? null,
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

// Order matches Shopify Admin's Finance Summary line order (Apr 2025 onward).
// `return_fees` lives between Shipping and Taxes — same as the Shopify UI.
const DIFF_FIELDS = [
  "gross_sales",
  "discounts",
  "returns",
  "net_sales",
  "shipping",
  "return_fees",
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
