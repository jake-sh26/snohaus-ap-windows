/**
 * PR #96 — Shopify Agreements Ledger (schema only)
 * ================================================
 *
 * PURPOSE
 * -------
 * Mirror Shopify's `Order.agreements -> sales` ledger directly into our
 * database so we can project recon_revenue_events 1:1 from the same
 * source that powers Shopify's own finance reports.
 *
 * Path A (synthesize edit-deltas from our hand-rolled detector rules) was
 * abandoned because it kept drifting from Shopify in edge cases (returns,
 * partial refunds with tax recalc, mixed edits). The PR #96 probe (#99)
 * proved that Shopify exposes the exact ledger we need:
 *
 *   - SalesAgreement.happenedAt is the date Shopify books a sale to (so an
 *     OrderEditAgreement on Nov 4 books to Nov, not the May order date)
 *   - SalesAgreement.reason ∈ { ORDER, ORDER_EDIT, REFUND, RETURN, ... }
 *   - Each Sale carries totalAmount, totalDiscountAmount*, totalTaxAmount,
 *     plus per-subtype back-references (lineItem / shippingLine / fee /
 *     additionalFee / duty) and a tax_breakdown array.
 *
 * Path B (this PR + #97 + #98 + #99) replaces the synthesize-deltas logic
 * with direct ingestion of agreements/sales, then projects events 1:1.
 *
 *
 * DATA MODEL
 * ----------
 * Two tables, both keyed on the Shopify Sale/Agreement GIDs so re-ingest
 * is idempotent.
 *
 *   recon_shopify_agreements
 *     id                Shopify SalesAgreement GID (PRIMARY KEY)
 *     order_id          FK to recon_orders(id) ON DELETE CASCADE
 *     happened_at       ISO timestamp; date Shopify books the sales to
 *     happened_month    GENERATED column: YYYY-MM in store-local (ET)
 *     reason            ORDER | ORDER_EDIT | REFUND | RETURN | ...
 *     agreement_type    OrderAgreement | OrderEditAgreement |
 *                       RefundAgreement | ReturnAgreement | ...
 *     app_handle        Shopify app that created the agreement
 *                       (pos, shopify_web, point_of_sale, ...)
 *     refund_id         Shopify Refund GID when agreement_type=RefundAgreement
 *     return_id         Shopify Return GID when agreement_type=ReturnAgreement
 *     raw_json          full agreement node payload for forensics
 *     ingested_at       ISO timestamp of upsert
 *     ingest_version    bumped on every re-ingest
 *
 *   recon_shopify_sales
 *     id                Shopify Sale GID (PRIMARY KEY)
 *     agreement_id      FK to recon_shopify_agreements(id) ON DELETE CASCADE
 *     order_id          FK to recon_orders(id) ON DELETE CASCADE (denorm)
 *     happened_at       denorm copy of agreement.happenedAt — this is the
 *                       `recognized_at` for the event projector in PR #98
 *     happened_month    GENERATED column matching agreements table
 *     sale_type         Shopify __typename: ProductSale | GiftCardSale |
 *                       TipSale | ShippingLineSale | FeeSale |
 *                       AdditionalFeeSale | DutySale | AdjustmentSale |
 *                       UnknownSale
 *     action_type       Shopify SaleActionType: ORDER | UPDATE | RETURN |
 *                       REFUND | ...
 *     line_type         Shopify SaleLineType: PRODUCT | TIP | GIFT_CARD |
 *                       SHIPPING | DUTY | FEE | ADJUSTMENT | UNKNOWN
 *     quantity          signed quantity (negative on UPDATE reversals)
 *     total_amount      signed money amount (negative on reversals/refunds)
 *     total_discount_after_taxes   total discount applied (positive number)
 *     total_discount_before_taxes  pre-tax discount applied (positive)
 *     total_tax         signed tax amount
 *     ref_id            subtype-specific back-reference id
 *                         ProductSale, GiftCardSale, TipSale → lineItem.id
 *                         ShippingLineSale                   → shippingLine.id
 *                         FeeSale                            → fee.id
 *                         AdditionalFeeSale                  → additionalFee.id
 *                         DutySale                           → duty.id
 *                         AdjustmentSale, UnknownSale        → NULL
 *     ref_name          human-readable name from the back-ref
 *     ref_sku           SKU for product/gift-card sales
 *     tax_breakdown_json   JSON array: [{title, rate, amount, price}]
 *     raw_json          full sale node payload for forensics
 *     ingested_at       ISO timestamp of upsert
 *     ingest_version    bumped on every re-ingest
 *
 *
 * PROJECTION (PR #98, NOT THIS PR)
 * --------------------------------
 * In PR #98 the events projector will read recon_shopify_sales directly:
 *
 *   FOR each sale row:
 *     event_id   = deterministic hash of sale.id
 *     event_date = sale.happened_at                ← critical: uses Shopify's
 *                                                    booking date, not order date
 *     event_type = mapEventType(sale.action_type, sale.line_type, sale.sale_type)
 *     order_id   = sale.order_id
 *     gross/discount/tax/returns derived from sale columns
 *
 * The current projector (synthesize-deltas) stays behind a feature flag
 * during the A/B phase until events-vs-Shopify is clean across all 17
 * months. Then the synthesize-deltas detectors retire.
 *
 *
 * READ-ONLY GUARANTEE
 * -------------------
 * Phase 1 reconciler is read-only. Nothing in this PR (schema only) or
 * the subsequent ingest PR (#97) writes back to Shopify. We only READ
 * `Order.agreements -> sales` and project them into our local DB for
 * accounting.
 *
 *
 * IDEMPOTENCE
 * -----------
 * Both tables use the Shopify GID as PRIMARY KEY. Re-ingesting the same
 * agreements yields the same rows — re-runs are safe. `ingest_version`
 * bumps so we can detect re-ingests in audit queries.
 *
 *
 * WARNINGS
 * --------
 * Re-uses the existing `recon_event_warnings` table from
 * shopify-recon-revenue-events.ts. Malformed sale nodes (missing
 * happenedAt, unrecognized sale_type, etc.) log a warning and skip.
 * The schema migration itself never throws.
 */

import { sqlite } from "./storage";

let schemaEnsured = false;

/**
 * Idempotent schema migration for the Shopify agreements/sales ledger.
 * Safe to call repeatedly — uses CREATE TABLE IF NOT EXISTS + CREATE INDEX
 * IF NOT EXISTS. No data is inserted here; ingest lands in PR #97.
 */
export function ensureShopifyAgreementsSchema(): void {
  if (schemaEnsured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_shopify_agreements (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES recon_orders(id) ON DELETE CASCADE,
      happened_at TEXT NOT NULL,
      -- Store-local (ET) YYYY-MM bucket. Matches recon_revenue_events
      -- convention so the two ledgers join cleanly on event_month.
      happened_month TEXT GENERATED ALWAYS AS
        (substr(datetime(happened_at, '-5 hours'), 1, 7)) VIRTUAL,
      reason TEXT NOT NULL,
      agreement_type TEXT NOT NULL,
      app_handle TEXT,
      refund_id TEXT,
      return_id TEXT,
      raw_json TEXT,
      ingested_at TEXT NOT NULL,
      ingest_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_agreements_order
      ON recon_shopify_agreements(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_agreements_month
      ON recon_shopify_agreements(happened_month);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_agreements_reason
      ON recon_shopify_agreements(reason);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_agreements_happened_at
      ON recon_shopify_agreements(happened_at);

    CREATE TABLE IF NOT EXISTS recon_shopify_sales (
      id TEXT PRIMARY KEY,
      agreement_id TEXT NOT NULL REFERENCES recon_shopify_agreements(id) ON DELETE CASCADE,
      order_id TEXT NOT NULL REFERENCES recon_orders(id) ON DELETE CASCADE,
      -- Denormalized from agreement so the events projector can read this
      -- table alone without a join. This is the value that will become
      -- event_date / recognized_at in the new projector (PR #98).
      happened_at TEXT NOT NULL,
      happened_month TEXT GENERATED ALWAYS AS
        (substr(datetime(happened_at, '-5 hours'), 1, 7)) VIRTUAL,
      sale_type TEXT NOT NULL,
      action_type TEXT,
      line_type TEXT,
      quantity INTEGER,
      total_amount REAL,
      total_discount_after_taxes REAL,
      total_discount_before_taxes REAL,
      total_tax REAL,
      ref_id TEXT,
      ref_name TEXT,
      ref_sku TEXT,
      tax_breakdown_json TEXT,
      raw_json TEXT,
      ingested_at TEXT NOT NULL,
      ingest_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_agreement
      ON recon_shopify_sales(agreement_id);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_order
      ON recon_shopify_sales(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_month
      ON recon_shopify_sales(happened_month);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_type
      ON recon_shopify_sales(sale_type);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_action
      ON recon_shopify_sales(action_type);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_happened_at
      ON recon_shopify_sales(happened_at);
  `);
  schemaEnsured = true;
}

/**
 * Lightweight introspection used by debug endpoints and PR #97 ingest
 * progress tracking. Returns 0/0 in a fresh DB.
 */
export function getShopifyAgreementsCounts(): {
  agreements: number;
  sales: number;
} {
  ensureShopifyAgreementsSchema();
  const a = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recon_shopify_agreements`)
    .get() as any;
  const s = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recon_shopify_sales`)
    .get() as any;
  return { agreements: a?.n ?? 0, sales: s?.n ?? 0 };
}
