-- ============================================================
-- monthly rollup query — Shopify Finance Summary parity
--
-- Run this query directly (don't need the view) against the
-- ATTACHed staging DB:
--
--   $ sqlite3 :memory:
--   sqlite> ATTACH DATABASE 'data-staging.db' AS staging;
--   sqlite> .read 002_monthly_rollup_view.sql
--   sqlite> SELECT * FROM v_staging_finance_summary WHERE shop_local_month='2025-04';
--
-- Sign convention in staging.shopify_finance_events:
--   sale_line, gift_card_sale, shipping_sale, tax_sale  : POSITIVE
--   discount_line, order_discount                       : NEGATIVE
--   return_line, refund_adjustment, shipping_refund     : NEGATIVE
--   tax_refund (in tax_amount column)                   : NEGATIVE
--   order_edit_adjustment                               : SIGNED
--
-- Default: excludes is_cancelled_order = 1 rows (matches Shopify
-- Finance Summary). To see cancelled-order numbers run the
-- query directly with `WHERE 1=1` instead of `is_cancelled_order=0`.
-- ============================================================
DROP VIEW IF EXISTS v_staging_finance_summary;

CREATE VIEW v_staging_finance_summary AS
WITH base AS (
  SELECT shop_local_month,
         event_type,
         amount,
         tax_amount,
         is_gift_card,
         is_cancelled_order
  FROM staging.shopify_finance_events
  WHERE is_cancelled_order = 0
)
SELECT
  shop_local_month,
  ROUND(SUM(CASE
    WHEN event_type IN ('sale_line','gift_card_sale') THEN amount
    WHEN event_type = 'order_edit_adjustment' AND amount > 0 THEN amount
    ELSE 0 END), 2) AS gross_sales,
  ROUND(SUM(CASE
    WHEN event_type IN ('discount_line','order_discount') THEN -amount
    ELSE 0 END), 2) AS discounts,
  ROUND(SUM(CASE
    WHEN event_type IN ('return_line','refund_adjustment') THEN -amount
    ELSE 0 END), 2) AS returns,
  ROUND(
    SUM(CASE WHEN event_type IN ('sale_line','gift_card_sale') THEN amount
             WHEN event_type = 'order_edit_adjustment' AND amount > 0 THEN amount
             ELSE 0 END)
    - SUM(CASE WHEN event_type IN ('discount_line','order_discount') THEN -amount ELSE 0 END)
    - SUM(CASE WHEN event_type IN ('return_line','refund_adjustment') THEN -amount ELSE 0 END)
    + SUM(CASE WHEN event_type = 'order_edit_adjustment' AND amount < 0 THEN amount ELSE 0 END),
    2) AS net_sales,
  ROUND(SUM(CASE
    WHEN event_type IN ('shipping_sale','shipping_refund') THEN amount
    ELSE 0 END), 2) AS shipping,
  ROUND(SUM(CASE
    WHEN event_type IN ('tax_sale','tax_refund') THEN tax_amount
    ELSE 0 END), 2) AS taxes,
  ROUND(SUM(CASE WHEN is_gift_card = 1
                   AND event_type IN ('sale_line','gift_card_sale','return_line','discount_line','order_edit_adjustment')
                  THEN amount ELSE 0 END), 2) AS net_sales_gift_cards
FROM base
GROUP BY shop_local_month
ORDER BY shop_local_month;
