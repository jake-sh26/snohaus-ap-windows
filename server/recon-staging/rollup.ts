/**
 * Monthly rollup of staging.shopify_finance_events.
 *
 * Returns the seven Shopify Finance Summary lines plus net_sales_gift_cards
 * split out, AND a per-day breakdown for sanity-checking.
 *
 * Rollup contract — matches Shopify Finance Summary:
 *   gross_sales      = SUM(sale_line + gift_card_sale + order_edit_adjustment.positive)
 *   discounts        = -SUM(discount_line + order_discount)        // always positive in output
 *   returns          = -SUM(return_line + refund_adjustment)       // always positive in output
 *   net_sales        = gross_sales - discounts - returns
 *   shipping         = SUM(shipping_sale + shipping_refund)
 *   taxes            = SUM(tax_sale + tax_refund)
 *   total_sales      = net_sales + shipping + taxes
 *   net_sales_gift_cards = SUM(amount) where is_gift_card=1, event in (sale_line,gift_card_sale,return_line,discount_line,order_edit_adjustment)
 *
 * Cancelled-order filter:
 *   By default rows with is_cancelled_order=1 are EXCLUDED from rollup
 *   numbers (matches Shopify Finance Summary, which treats fully voided
 *   orders as not-sold). The endpoint exposes an `includeCancelled` flag
 *   so you can see all data.
 */

import { openStagingDb } from "./staging-db";

export type RollupOpts = {
  month: string;
  includeCancelled?: boolean;
};

export type Rollup = {
  month: string;
  include_cancelled: boolean;
  gross_sales: number;
  discounts: number;
  returns: number;
  net_sales: number;
  shipping: number;
  taxes: number;
  total_sales: number;
  net_sales_gift_cards: number;
  event_counts: Record<string, number>;
  totals_by_type: Record<string, number>;
  cancelled_excluded: {
    orders: number;
    sale_line_amount: number;
  };
};

export function rollupMonth(opts: RollupOpts): Rollup {
  const db = openStagingDb();
  const month = opts.month;
  const includeCancelled = !!opts.includeCancelled;
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Bad month '${month}'`);

  const cancelClause = includeCancelled ? "1=1" : "is_cancelled_order = 0";

  const totalsByType = db.prepare(`
    SELECT event_type,
           ROUND(SUM(amount), 2) AS amount,
           ROUND(SUM(tax_amount), 2) AS tax_amount,
           COUNT(*) AS n
    FROM staging.shopify_finance_events
    WHERE shop_local_month = ? AND ${cancelClause}
    GROUP BY event_type
  `).all(month) as Array<{ event_type: string; amount: number; tax_amount: number; n: number }>;

  const totals_by_type: Record<string, number> = {};
  const event_counts: Record<string, number> = {};
  for (const r of totalsByType) {
    totals_by_type[r.event_type] = r.amount;
    event_counts[r.event_type] = r.n;
  }
  const get = (k: string) => totals_by_type[k] || 0;
  const getTax = (k: string) =>
    (totalsByType.find((r) => r.event_type === k)?.tax_amount) || 0;

  // Sales side
  const sale_line = get("sale_line");
  const gift_card_sale = get("gift_card_sale");
  const edit_adj_amount = get("order_edit_adjustment");

  // Discounts (events store as negative; flip sign for display)
  const discount_line = -get("discount_line");
  const order_discount = -get("order_discount");

  // Returns (events negative; flip)
  const return_line = -get("return_line");
  const refund_adjustment = -get("refund_adjustment");

  // Shipping
  const shipping_sale = get("shipping_sale");
  const shipping_refund = get("shipping_refund"); // already negative
  const shipping = shipping_sale + shipping_refund;

  // Taxes (use tax_amount column, not amount)
  const taxes = getTax("tax_sale") + getTax("tax_refund");

  const gross_sales = sale_line + gift_card_sale + Math.max(0, edit_adj_amount);
  const discounts = discount_line + order_discount;
  const returns = return_line + refund_adjustment;
  const net_sales = gross_sales - discounts - returns + Math.min(0, edit_adj_amount);
  const total_sales = net_sales + shipping + taxes;

  // Gift card net amount
  const gcRow = db.prepare(`
    SELECT ROUND(SUM(amount), 2) AS amt
    FROM staging.shopify_finance_events
    WHERE shop_local_month = ?
      AND is_gift_card = 1
      AND ${cancelClause}
      AND event_type IN ('sale_line','gift_card_sale','return_line','discount_line','order_edit_adjustment')
  `).get(month) as { amt: number | null };
  const net_sales_gift_cards = Number(gcRow?.amt ?? 0);

  // Cancelled excluded — show visibility
  const cancRow = db.prepare(`
    SELECT COUNT(DISTINCT order_id) AS n_orders,
           ROUND(SUM(CASE WHEN event_type='sale_line' THEN amount ELSE 0 END),2) AS sale_line_amount
    FROM staging.shopify_finance_events
    WHERE shop_local_month = ? AND is_cancelled_order = 1
  `).get(month) as { n_orders: number; sale_line_amount: number };

  return {
    month, include_cancelled: includeCancelled,
    gross_sales: round2(gross_sales),
    discounts: round2(discounts),
    returns: round2(returns),
    net_sales: round2(net_sales),
    shipping: round2(shipping),
    taxes: round2(taxes),
    total_sales: round2(total_sales),
    net_sales_gift_cards: round2(net_sales_gift_cards),
    event_counts,
    totals_by_type,
    cancelled_excluded: {
      orders: cancRow?.n_orders || 0,
      sale_line_amount: cancRow?.sale_line_amount || 0,
    },
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Per-day rollup — useful to spot bucketing weirdness.
 */
export function rollupByDay(opts: RollupOpts): Array<{
  shop_local_date: string;
  gross_sales: number; discounts: number; returns: number;
  net_sales: number; shipping: number; taxes: number; total_sales: number;
}> {
  const db = openStagingDb();
  const includeCancelled = !!opts.includeCancelled;
  const cancelClause = includeCancelled ? "1=1" : "is_cancelled_order = 0";

  const rows = db.prepare(`
    SELECT shop_local_date,
           ROUND(SUM(CASE WHEN event_type IN ('sale_line','gift_card_sale') THEN amount
                          WHEN event_type='order_edit_adjustment' AND amount > 0 THEN amount
                          ELSE 0 END), 2) AS gross_sales,
           ROUND(SUM(CASE WHEN event_type IN ('discount_line','order_discount') THEN -amount ELSE 0 END), 2) AS discounts,
           ROUND(SUM(CASE WHEN event_type IN ('return_line','refund_adjustment') THEN -amount ELSE 0 END), 2) AS returns,
           ROUND(SUM(CASE WHEN event_type IN ('shipping_sale','shipping_refund') THEN amount ELSE 0 END), 2) AS shipping,
           ROUND(SUM(tax_amount), 2) AS taxes
    FROM staging.shopify_finance_events
    WHERE shop_local_month = ? AND ${cancelClause}
    GROUP BY shop_local_date
    ORDER BY shop_local_date
  `).all(opts.month) as any[];

  return rows.map((r) => ({
    shop_local_date: r.shop_local_date,
    gross_sales: r.gross_sales || 0,
    discounts: r.discounts || 0,
    returns: r.returns || 0,
    net_sales: round2((r.gross_sales || 0) - (r.discounts || 0) - (r.returns || 0)),
    shipping: r.shipping || 0,
    taxes: r.taxes || 0,
    total_sales: round2(
      (r.gross_sales || 0) - (r.discounts || 0) - (r.returns || 0) +
      (r.shipping || 0) + (r.taxes || 0),
    ),
  }));
}
