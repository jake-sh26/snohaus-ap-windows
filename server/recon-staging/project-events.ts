/**
 * Recon Staging Harness — projection from normalized staging tables into
 * staging.shopify_finance_events (the economic ledger).
 *
 * One row per economic event, dated by the event's OWN date (NOT the order
 * date). Reruns are safe — event_key is deterministic and upserted.
 *
 * Sign convention:
 *   - sale_line, shipping_sale, tax_sale, gift_card_sale: POSITIVE
 *   - discount_line, order_discount, return_line, shipping_refund, tax_refund,
 *     refund_adjustment (return fees on the refund payable side): NEGATIVE
 *   - order_edit_adjustment: signed (matches the delta)
 *
 * The rollup queries below depend on this convention.
 */

import Database from "better-sqlite3";
import { openStagingDb } from "./staging-db";

const RUN_ID_FILTER = `harness_run_id IS NOT NULL`;

export type ProjectOpts = {
  month: string;             // YYYY-MM (shop-local)
  includeCancelled?: boolean; // default false — adds `is_cancelled_order=1` rows; rollup excludes by default
};

export type ProjectResult = {
  events_projected: number;
  by_type: Record<string, number>;
};

export function projectEvents(opts: ProjectOpts): ProjectResult {
  const db = openStagingDb();
  const month = opts.month;
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Bad month '${month}'`);

  // Wipe prior projection for this month, ALL run ids. (Idempotent rerun.)
  db.prepare(`
    DELETE FROM staging.shopify_finance_events
    WHERE shop_local_month = ?
  `).run(month);

  db.exec("BEGIN");
  try {
    projectSales(db, month);
    projectShipping(db, month);
    projectTaxes(db, month);
    projectRefunds(db, month);
    projectEdits(db, month);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  const rows = db.prepare(`
    SELECT event_type, COUNT(*) AS n
    FROM staging.shopify_finance_events
    WHERE shop_local_month = ?
    GROUP BY event_type
  `).all(month) as Array<{ event_type: string; n: number }>;

  const by_type: Record<string, number> = {};
  let total = 0;
  for (const r of rows) { by_type[r.event_type] = r.n; total += r.n; }
  return { events_projected: total, by_type };
}

/**
 * Sale lines: one event per order_line whose ORDER's shop_local_month = month.
 * For each line we emit:
 *   - sale_line       = originalTotal (gross)            POSITIVE
 *   - discount_line   = -totalLineDiscount (if > 0)      NEGATIVE
 * Gift-card lines get event_type = gift_card_sale instead of sale_line.
 *
 * Order-level (non-line) discount allocations are not double-counted —
 * Shopify already allocates them to lineItem.totalDiscountSet on the
 * discounted line. If we ever see orders with order-level discounts that
 * don't get allocated to lines, we can add an `order_discount` branch
 * reading discountApplications.
 */
function projectSales(db: Database.Database, month: string): void {
  // Sale lines
  db.prepare(`
    INSERT OR REPLACE INTO staging.shopify_finance_events (
      event_key, event_type, order_id, order_name, ref_id,
      event_date_utc, shop_local_date, shop_local_month,
      amount, tax_amount, quantity, is_gift_card, is_cancelled_order,
      notes, raw_source, ingested_at_utc, harness_run_id
    )
    SELECT
      'sale:' || l.line_id,
      CASE WHEN l.is_gift_card = 1 THEN 'gift_card_sale' ELSE 'sale_line' END,
      l.order_id, l.order_name, l.line_id,
      COALESCE(o.processed_at_utc, o.created_at_utc),
      l.shop_local_date, l.shop_local_month,
      l.original_total,
      0,
      l.quantity,
      l.is_gift_card,
      CASE WHEN o.cancelled_at_utc IS NOT NULL THEN 1 ELSE 0 END,
      NULL,
      'shopify_order_lines:' || l.line_id,
      datetime('now'),
      l.harness_run_id
    FROM staging.shopify_order_lines l
    JOIN staging.shopify_orders o ON o.order_id = l.order_id
    WHERE l.shop_local_month = ?
  `).run(month);

  // Line-level discounts (one event per line that has a discount)
  db.prepare(`
    INSERT OR REPLACE INTO staging.shopify_finance_events (
      event_key, event_type, order_id, order_name, ref_id,
      event_date_utc, shop_local_date, shop_local_month,
      amount, tax_amount, quantity, is_gift_card, is_cancelled_order,
      notes, raw_source, ingested_at_utc, harness_run_id
    )
    SELECT
      'disc:' || l.line_id,
      'discount_line',
      l.order_id, l.order_name, l.line_id,
      COALESCE(o.processed_at_utc, o.created_at_utc),
      l.shop_local_date, l.shop_local_month,
      -l.total_line_discount,
      0,
      l.quantity,
      l.is_gift_card,
      CASE WHEN o.cancelled_at_utc IS NOT NULL THEN 1 ELSE 0 END,
      NULL,
      'shopify_order_lines:' || l.line_id,
      datetime('now'),
      l.harness_run_id
    FROM staging.shopify_order_lines l
    JOIN staging.shopify_orders o ON o.order_id = l.order_id
    WHERE l.shop_local_month = ?
      AND l.total_line_discount > 0
  `).run(month);
}

function projectShipping(db: Database.Database, month: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO staging.shopify_finance_events (
      event_key, event_type, order_id, order_name, ref_id,
      event_date_utc, shop_local_date, shop_local_month,
      amount, tax_amount, quantity, is_gift_card, is_cancelled_order,
      notes, raw_source, ingested_at_utc, harness_run_id
    )
    SELECT
      'ship:' || s.shipping_id,
      'shipping_sale',
      s.order_id, s.order_name, s.shipping_id,
      COALESCE(o.processed_at_utc, o.created_at_utc),
      s.shop_local_date, s.shop_local_month,
      s.discounted_price,
      0,
      NULL,
      0,
      CASE WHEN o.cancelled_at_utc IS NOT NULL THEN 1 ELSE 0 END,
      NULL,
      'shopify_order_shipping:' || s.shipping_id,
      datetime('now'),
      s.harness_run_id
    FROM staging.shopify_order_shipping s
    JOIN staging.shopify_orders o ON o.order_id = s.order_id
    WHERE s.shop_local_month = ?
  `).run(month);
}

/**
 * Taxes — both sale-side and refund-side.
 * Sale-side: every order_tax_line row of scope IN ('line','shipping') for the month.
 * Refund-side: every refund_lines row's total_tax (signed negative).
 */
function projectTaxes(db: Database.Database, month: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO staging.shopify_finance_events (
      event_key, event_type, order_id, order_name, ref_id,
      event_date_utc, shop_local_date, shop_local_month,
      amount, tax_amount, quantity, is_gift_card, is_cancelled_order,
      notes, raw_source, ingested_at_utc, harness_run_id
    )
    SELECT
      'tax_sale:' || t.tax_id,
      'tax_sale',
      t.order_id, t.order_name, t.tax_id,
      COALESCE(o.processed_at_utc, o.created_at_utc),
      t.shop_local_date, t.shop_local_month,
      0,
      t.price,
      NULL,
      0,
      CASE WHEN o.cancelled_at_utc IS NOT NULL THEN 1 ELSE 0 END,
      t.title,
      'shopify_order_tax_lines:' || t.tax_id,
      datetime('now'),
      t.harness_run_id
    FROM staging.shopify_order_tax_lines t
    JOIN staging.shopify_orders o ON o.order_id = t.order_id
    WHERE t.shop_local_month = ?
  `).run(month);

  // Tax refund — dated by REFUND date, not order date
  db.prepare(`
    INSERT OR REPLACE INTO staging.shopify_finance_events (
      event_key, event_type, order_id, order_name, ref_id,
      event_date_utc, shop_local_date, shop_local_month,
      amount, tax_amount, quantity, is_gift_card, is_cancelled_order,
      notes, raw_source, ingested_at_utc, harness_run_id
    )
    SELECT
      'tax_refund:' || rl.refund_line_id,
      'tax_refund',
      rl.order_id, rl.order_name, rl.refund_line_id,
      r.processed_at_utc,
      rl.shop_local_date, rl.shop_local_month,
      0,
      -rl.total_tax,
      NULL,
      rl.is_gift_card,
      CASE WHEN o.cancelled_at_utc IS NOT NULL THEN 1 ELSE 0 END,
      NULL,
      'shopify_refund_lines:' || rl.refund_line_id,
      datetime('now'),
      rl.harness_run_id
    FROM staging.shopify_refund_lines rl
    JOIN staging.shopify_refunds r ON r.refund_id = rl.refund_id
    JOIN staging.shopify_orders o ON o.order_id = rl.order_id
    WHERE rl.shop_local_month = ?
      AND rl.total_tax != 0
  `).run(month);
}

/**
 * Refunds:
 *   - kind='line_item'         → return_line (signed negative)
 *   - kind='shipping_refund'   → shipping_refund (signed negative)
 *   - kind='order_adjustment'  → refund_adjustment (sign = sign of amount)
 *
 * Critical: dated by the REFUND's processed_at, NOT the order's processed_at.
 * So a refund processed in May against an April order ends up in the May
 * bucket — matching Shopify's Finance Summary behaviour.
 */
function projectRefunds(db: Database.Database, month: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO staging.shopify_finance_events (
      event_key, event_type, order_id, order_name, ref_id,
      event_date_utc, shop_local_date, shop_local_month,
      amount, tax_amount, quantity, is_gift_card, is_cancelled_order,
      notes, raw_source, ingested_at_utc, harness_run_id
    )
    SELECT
      'ret:' || rl.refund_line_id,
      CASE
        WHEN rl.kind = 'line_item' THEN 'return_line'
        WHEN rl.kind = 'shipping_refund' THEN 'shipping_refund'
        ELSE 'refund_adjustment'
      END,
      rl.order_id, rl.order_name, rl.refund_line_id,
      r.processed_at_utc,
      rl.shop_local_date, rl.shop_local_month,
      CASE
        WHEN rl.kind = 'line_item' THEN -rl.subtotal
        WHEN rl.kind = 'shipping_refund' THEN -rl.subtotal
        ELSE -rl.subtotal -- adjustments are stored as positive fee amounts; flip
      END,
      0,
      rl.quantity,
      rl.is_gift_card,
      CASE WHEN o.cancelled_at_utc IS NOT NULL THEN 1 ELSE 0 END,
      rl.adjustment_kind,
      'shopify_refund_lines:' || rl.refund_line_id,
      datetime('now'),
      rl.harness_run_id
    FROM staging.shopify_refund_lines rl
    JOIN staging.shopify_refunds r ON r.refund_id = rl.refund_id
    JOIN staging.shopify_orders o ON o.order_id = rl.order_id
    WHERE rl.shop_local_month = ?
  `).run(month);
}

/**
 * Order edits: emit one event_type=order_edit_adjustment per edit row.
 * Amount = delta_subtotal (subtotal delta only; tax delta carried in tax_amount).
 * Dated by the edit's own createdAt → cross-month edits land in the edit month.
 */
function projectEdits(db: Database.Database, month: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO staging.shopify_finance_events (
      event_key, event_type, order_id, order_name, ref_id,
      event_date_utc, shop_local_date, shop_local_month,
      amount, tax_amount, quantity, is_gift_card, is_cancelled_order,
      notes, raw_source, ingested_at_utc, harness_run_id
    )
    SELECT
      'edit:' || e.edit_id,
      'order_edit_adjustment',
      e.order_id, e.order_name, e.edit_id,
      e.created_at_utc,
      e.shop_local_date, e.shop_local_month,
      e.delta_subtotal,
      e.delta_tax,
      NULL,
      0,
      CASE WHEN o.cancelled_at_utc IS NOT NULL THEN 1 ELSE 0 END,
      e.message,
      'shopify_order_edits:' || e.edit_id,
      datetime('now'),
      e.harness_run_id
    FROM staging.shopify_order_edits e
    JOIN staging.shopify_orders o ON o.order_id = e.order_id
    WHERE e.shop_local_month = ?
      AND (e.delta_subtotal != 0 OR e.delta_tax != 0)
  `).run(month);
}
