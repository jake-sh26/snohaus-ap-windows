/**
 * PR #86a — Shopify order-edit ledger (data layer only).
 *
 * BACKGROUND (Bug 3).
 * Shopify's Admin Order Edit moves money between months without producing
 * a new sale or refund row. Example sentinel cases (validated to the penny
 * against Shopify's net-sales-by-order CSV export):
 *
 *   #21840  created 2025-05  edited 2025-06  subtotal_delta_est = +$588.01
 *   #22338  created 2025-10  edited 2025-11  subtotal_delta_est = -$219.99
 *
 * Shopify's net-sales report attributes the delta to the EDIT month
 * (subtract original from created_month, add the new amount to edit_month).
 * Our local computeLocalFinanceSummary() today buckets the *current* order
 * totals entirely on `recognized_at` (≈ created_at), which is why
 * created_month over-reports and edit_month under-reports.
 *
 * This file is the DATA LAYER ONLY. It:
 *   1. Defines the recon_order_edits ledger schema.
 *   2. Provides a per-order detector that asks Shopify's Admin GraphQL
 *      whether an order has a 'verb:edited' event and, if so, computes
 *      Path B (subtotal_delta_est).
 *   3. Provides an upsert helper.
 *
 * THIS FILE DOES NOT TOUCH THE RECONCILER MATH. Populating the table has
 * zero impact on computeLocalFinanceSummary() output. The reconciler
 * attribution change ships in PR #86b after we visually verify the rows
 * here match the 9 true edits already enumerated via PR #88.
 *
 * Path B formula (validated exhaustively in PRs #85b / #85d):
 *
 *   implied_tax_rate     = current_tax / current_subtotal
 *   original_subtotal    = (originalTotalPrice − currentShipping) / (1 + implied_tax_rate)
 *   subtotal_delta_est   = current_subtotal − original_subtotal
 *
 * `subtotal_delta_est` is the signed net-sales attribution amount:
 *   - Positive → edit ADDED merchandise. created_month over-reports.
 *   - Negative → edit REMOVED merchandise. created_month under-reports
 *                (because Shopify's CSV shows the original positive entry
 *                in created_month and the lower new entry in edit_month).
 *
 * Edge cases this module deliberately does NOT handle yet:
 *   - Edits that change shipping (assumes shipping unchanged).
 *   - Mixed tax rates within an order (assumes single rate).
 *   - Edits that span more than two months (one created → one edit
 *     month). We have not observed any in the historical scan and will
 *     model multi-edit chains only if a real case appears.
 */

import { sqlite } from "./storage";
import { shopifyGraphqlCall, type ShopifyReconConfig } from "./shopify-recon";

// ----- Schema -----
// One row per edited order. Keyed by order_id so re-running the detector is
// idempotent: a later edit on the same order overwrites the row. event_id /
// edited_at carry the *latest* edit event so we can show the operator when
// the edit happened in dashboards.
let schemaEnsured = false;
export function ensureOrderEditsSchema(): void {
  if (schemaEnsured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_order_edits (
      -- Shopify order id (numeric, stored as text — same as recon_orders.id).
      order_id TEXT PRIMARY KEY REFERENCES recon_orders(id) ON DELETE CASCADE,
      -- Order #name for human cross-reference. Cached on insert; not authoritative.
      order_name TEXT,
      -- Shopify order createdAt (UTC ISO). Mirrored from recon_orders so the
      -- reconciler can join in a single read without bouncing back to the
      -- orders table during month bucketing.
      created_at_iso TEXT NOT NULL,
      -- Latest 'verb:edited' event id + timestamp. NULL only if the row was
      -- populated by a tool that didn't fetch events (currently always set).
      latest_event_id TEXT,
      edited_at_iso TEXT,
      -- Shopify GraphQL totals at detection time.
      original_total_price REAL,
      current_total_price REAL,
      current_subtotal REAL,
      current_tax REAL,
      current_shipping REAL,
      current_discounts REAL,
      -- Derived Path B values. subtotal_delta_est is the column the
      -- reconciler will read in PR #86b.
      implied_tax_rate REAL,
      original_subtotal_est REAL,
      subtotal_delta_est REAL,
      gross_delta REAL,
      -- Operational fields.
      detector_source TEXT NOT NULL,     -- 'populate-edits-endpoint' | future: 'sync-loop'
      detected_at TEXT NOT NULL          -- when *this row* was last upserted
    );
    CREATE INDEX IF NOT EXISTS idx_recon_order_edits_created_at
      ON recon_order_edits(created_at_iso);
    CREATE INDEX IF NOT EXISTS idx_recon_order_edits_edited_at
      ON recon_order_edits(edited_at_iso);
  `);
  schemaEnsured = true;
}

// Module-load idempotent schema bootstrap. Mirrors the pattern in
// shopify-finance-diff.ts (called lazily so unit tests can stub sqlite).
function ensure(): void {
  if (!schemaEnsured) ensureOrderEditsSchema();
}

// ----- Detector -----
// Asks Shopify GraphQL for a single order's totals + edit events. Returns
// null when the order has no edit (originalTotalPriceSet ==
// currentTotalPriceSet AND no verb=edited event) so callers can skip the
// upsert. Returns a row-shaped object when an edit IS detected.
//
// We treat "edited" as: original_total_price != current_total_price
// REGARDLESS of whether the events array contains a verb=edited node.
// In practice every true edit in the 1566-candidate scan had both, but
// the price-delta check is the authoritative one — Shopify occasionally
// trims old events from the events feed for very old orders.
//
// IMPORTANT: this is the same query used by PR #86's
// graphql-totals-batch endpoint — reusing keeps Path B math identical to
// the formula already validated against Shopify CSV.

export type OrderEditDetection = {
  order_id: string;
  order_name: string | null;
  created_at_iso: string;
  latest_event_id: string | null;
  edited_at_iso: string | null;
  original_total_price: number | null;
  current_total_price: number | null;
  current_subtotal: number | null;
  current_tax: number | null;
  current_shipping: number | null;
  current_discounts: number | null;
  implied_tax_rate: number | null;
  original_subtotal_est: number | null;
  subtotal_delta_est: number | null;
  gross_delta: number | null;
};

const DETECT_QUERY = `
  query OrderTotalsForEditDetect($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      originalTotalPriceSet     { shopMoney { amount currencyCode } }
      currentTotalPriceSet      { shopMoney { amount currencyCode } }
      currentSubtotalPriceSet   { shopMoney { amount currencyCode } }
      currentTotalDiscountsSet  { shopMoney { amount currencyCode } }
      currentTotalTaxSet        { shopMoney { amount currencyCode } }
      currentShippingPriceSet   { shopMoney { amount currencyCode } }
      events(first: 10, query: "verb:edited OR action:order_edited", sortKey: CREATED_AT, reverse: true) {
        edges { node { id createdAt message } }
      }
    }
  }
`;

const round2 = (n: number | null | undefined): number | null =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
const round5 = (n: number | null | undefined): number | null =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 100000) / 100000;
const moneyNum = (mb: any): number | null =>
  mb?.shopMoney?.amount != null ? Number(mb.shopMoney.amount) : null;

export async function detectOrderEdit(
  cfg: ShopifyReconConfig,
  orderId: string,
): Promise<OrderEditDetection | null> {
  const orderGid = `gid://shopify/Order/${orderId}`;
  const r = await shopifyGraphqlCall(cfg, DETECT_QUERY, { id: orderGid });
  if (r.errors) {
    throw new Error(`graphql errors: ${JSON.stringify(r.errors)}`);
  }
  const o: any = (r.data as any)?.order;
  if (!o) return null;

  const original_total_price = moneyNum(o.originalTotalPriceSet);
  const current_total_price = moneyNum(o.currentTotalPriceSet);
  const current_subtotal = moneyNum(o.currentSubtotalPriceSet);
  const current_discounts = moneyNum(o.currentTotalDiscountsSet);
  const current_tax = moneyNum(o.currentTotalTaxSet);
  const current_shipping = moneyNum(o.currentShippingPriceSet);

  // Authoritative edit check: total price differs from original. Falls back
  // to event-presence check only if totals are nullable (legacy orders).
  const totalsDiffer =
    original_total_price != null &&
    current_total_price != null &&
    round2(original_total_price) !== round2(current_total_price);

  const editEdges = (o.events?.edges || []) as any[];
  const hasEditEvent = editEdges.length > 0;

  if (!totalsDiffer && !hasEditEvent) return null;

  // Path B
  let implied_tax_rate: number | null = null;
  let original_subtotal_est: number | null = null;
  let subtotal_delta_est: number | null = null;
  if (
    current_subtotal != null && current_subtotal > 0 &&
    current_tax != null && original_total_price != null
  ) {
    implied_tax_rate = current_tax / current_subtotal;
    const pre_tax_pre_shipping = original_total_price - (current_shipping || 0);
    original_subtotal_est = pre_tax_pre_shipping / (1 + implied_tax_rate);
    subtotal_delta_est = current_subtotal - original_subtotal_est;
  }

  const gross_delta =
    current_total_price != null && original_total_price != null
      ? current_total_price - original_total_price
      : null;

  const latestEdit = editEdges[0]?.node;

  return {
    order_id: String(orderId),
    order_name: o.name ?? null,
    created_at_iso: o.createdAt,
    latest_event_id: latestEdit?.id ?? null,
    edited_at_iso: latestEdit?.createdAt ?? null,
    original_total_price: round2(original_total_price),
    current_total_price: round2(current_total_price),
    current_subtotal: round2(current_subtotal),
    current_tax: round2(current_tax),
    current_shipping: round2(current_shipping),
    current_discounts: round2(current_discounts),
    implied_tax_rate: round5(implied_tax_rate),
    original_subtotal_est: round2(original_subtotal_est),
    subtotal_delta_est: round2(subtotal_delta_est),
    gross_delta: round2(gross_delta),
  };
}

// ----- Upsert -----
// Idempotent by order_id. Re-running the detector after a second edit on
// the same order overwrites the row with the newer Path B numbers. We do
// NOT keep an edit history (single-row-per-order) because the reconciler
// only needs the *current* delta between original and current totals.
export function upsertOrderEdit(
  row: OrderEditDetection,
  detectorSource: string,
): void {
  ensure();
  sqlite.prepare(`
    INSERT INTO recon_order_edits (
      order_id, order_name, created_at_iso,
      latest_event_id, edited_at_iso,
      original_total_price, current_total_price, current_subtotal,
      current_tax, current_shipping, current_discounts,
      implied_tax_rate, original_subtotal_est,
      subtotal_delta_est, gross_delta,
      detector_source, detected_at
    ) VALUES (
      @order_id, @order_name, @created_at_iso,
      @latest_event_id, @edited_at_iso,
      @original_total_price, @current_total_price, @current_subtotal,
      @current_tax, @current_shipping, @current_discounts,
      @implied_tax_rate, @original_subtotal_est,
      @subtotal_delta_est, @gross_delta,
      @detector_source, @detected_at
    )
    ON CONFLICT(order_id) DO UPDATE SET
      order_name            = excluded.order_name,
      created_at_iso        = excluded.created_at_iso,
      latest_event_id       = excluded.latest_event_id,
      edited_at_iso         = excluded.edited_at_iso,
      original_total_price  = excluded.original_total_price,
      current_total_price   = excluded.current_total_price,
      current_subtotal      = excluded.current_subtotal,
      current_tax           = excluded.current_tax,
      current_shipping      = excluded.current_shipping,
      current_discounts     = excluded.current_discounts,
      implied_tax_rate      = excluded.implied_tax_rate,
      original_subtotal_est = excluded.original_subtotal_est,
      subtotal_delta_est    = excluded.subtotal_delta_est,
      gross_delta           = excluded.gross_delta,
      detector_source       = excluded.detector_source,
      detected_at           = excluded.detected_at
  `).run({
    ...row,
    detector_source: detectorSource,
    detected_at: new Date().toISOString(),
  });
}

// ----- Helpers used by PR #86b (NOT WIRED YET) -----
// Exported so PR #86b's reconciler integration can read deltas without
// duplicating the SQL. Returns rows whose created_at month OR edited_at
// month falls inside [monthStartIso, monthEndIso].
//
// Returned in a single query so the caller can decide which side
// (created-month or edited-month) applies. The reconciler will:
//   - For rows where ToMonth(created_at_iso) == queryMonth: subtract subtotal_delta_est.
//   - For rows where ToMonth(edited_at_iso)  == queryMonth: add subtotal_delta_est.
// (Same-month edits cancel out — net zero — which is the desired behavior
// because the order's current totals already feed the rollup correctly.)
export type OrderEditLedgerRow = {
  order_id: string;
  order_name: string | null;
  created_at_iso: string;
  edited_at_iso: string | null;
  subtotal_delta_est: number | null;
  gross_delta: number | null;
};

export function listOrderEditsForMonthRange(
  monthStartIso: string,
  monthEndIso: string,
): OrderEditLedgerRow[] {
  ensure();
  return sqlite.prepare(`
    SELECT order_id, order_name, created_at_iso, edited_at_iso,
           subtotal_delta_est, gross_delta
    FROM recon_order_edits
    WHERE (created_at_iso >= ? AND created_at_iso < ?)
       OR (edited_at_iso  >= ? AND edited_at_iso  < ?)
  `).all(monthStartIso, monthEndIso, monthStartIso, monthEndIso) as OrderEditLedgerRow[];
}

// Diagnostics — used by the populate-edits endpoint to report what's in
// the table after a manual run. Sorted newest-edit first.
export function listAllOrderEdits(): OrderEditLedgerRow[] {
  ensure();
  return sqlite.prepare(`
    SELECT order_id, order_name, created_at_iso, edited_at_iso,
           subtotal_delta_est, gross_delta
    FROM recon_order_edits
    ORDER BY COALESCE(edited_at_iso, created_at_iso) DESC
  `).all() as OrderEditLedgerRow[];
}
