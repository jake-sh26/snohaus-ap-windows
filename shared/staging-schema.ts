/**
 * Drizzle ORM definitions for the staging.* tables.
 *
 * NOTE: These are typed-read mirrors of the CREATE TABLE statements in
 * server/recon-staging/staging-db.ts. Drizzle's SQLite dialect does not
 * natively model ATTACHed schemas — these definitions are intentionally
 * declared with bare table names. The harness only ever uses these for
 * type inference + parameterized read queries via raw SQL strings that
 * include the `staging.` prefix manually.
 *
 * If you need to refactor the schema, edit BOTH this file AND
 * server/recon-staging/staging-db.ts. They must stay in lock-step.
 */

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const stagingShopifyOrders = sqliteTable("shopify_orders", {
  orderId: text("order_id").primaryKey(),
  orderName: text("order_name").notNull(),
  legacyResourceId: text("legacy_resource_id"),
  createdAtUtc: text("created_at_utc").notNull(),
  processedAtUtc: text("processed_at_utc"),
  updatedAtUtc: text("updated_at_utc"),
  cancelledAtUtc: text("cancelled_at_utc"),
  closedAtUtc: text("closed_at_utc"),
  shopLocalDate: text("shop_local_date").notNull(),
  shopLocalMonth: text("shop_local_month").notNull(),
  financialStatus: text("financial_status"),
  fulfillmentStatus: text("fulfillment_status"),
  cancelReason: text("cancel_reason"),
  channelHandle: text("channel_handle"),
  channelName: text("channel_name"),
  posLocationId: text("pos_location_id"),
  posLocationName: text("pos_location_name"),
  currency: text("currency").notNull(),
  originalSubtotal: real("original_subtotal"),
  originalTotalPrice: real("original_total_price"),
  originalTotalTax: real("original_total_tax"),
  originalTotalDiscounts: real("original_total_discounts"),
  originalTotalShipping: real("original_total_shipping"),
  currentSubtotal: real("current_subtotal"),
  currentTotalPrice: real("current_total_price"),
  currentTotalTax: real("current_total_tax"),
  currentTotalDiscounts: real("current_total_discounts"),
  totalRefunded: real("total_refunded"),
  totalOutstanding: real("total_outstanding"),
  hasBeenEdited: integer("has_been_edited").notNull().default(0),
  editCount: integer("edit_count").notNull().default(0),
  rawJson: text("raw_json").notNull(),
  ingestedAtUtc: text("ingested_at_utc").notNull(),
  harnessRunId: text("harness_run_id").notNull(),
});

export const stagingShopifyOrderLines = sqliteTable("shopify_order_lines", {
  lineId: text("line_id").primaryKey(),
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  shopLocalDate: text("shop_local_date").notNull(),
  shopLocalMonth: text("shop_local_month").notNull(),
  lineIndex: integer("line_index").notNull(),
  sku: text("sku"),
  title: text("title"),
  variantId: text("variant_id"),
  productId: text("product_id"),
  productType: text("product_type"),
  vendor: text("vendor"),
  quantity: integer("quantity").notNull(),
  originalUnitPrice: real("original_unit_price").notNull(),
  originalTotal: real("original_total").notNull(),
  discountedUnitPrice: real("discounted_unit_price").notNull(),
  discountedTotal: real("discounted_total").notNull(),
  totalLineDiscount: real("total_line_discount").notNull().default(0),
  isGiftCard: integer("is_gift_card").notNull().default(0),
  requiresShipping: integer("requires_shipping").notNull().default(1),
  currentQuantity: integer("current_quantity"),
  refundableQuantity: integer("refundable_quantity"),
  rawJson: text("raw_json").notNull(),
  ingestedAtUtc: text("ingested_at_utc").notNull(),
  harnessRunId: text("harness_run_id").notNull(),
});

export const stagingShopifyOrderShipping = sqliteTable("shopify_order_shipping", {
  shippingId: text("shipping_id").primaryKey(),
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  shopLocalDate: text("shop_local_date").notNull(),
  shopLocalMonth: text("shop_local_month").notNull(),
  title: text("title"),
  code: text("code"),
  originalPrice: real("original_price").notNull().default(0),
  discountedPrice: real("discounted_price").notNull().default(0),
  rawJson: text("raw_json").notNull(),
  ingestedAtUtc: text("ingested_at_utc").notNull(),
  harnessRunId: text("harness_run_id").notNull(),
});

export const stagingShopifyOrderTaxLines = sqliteTable("shopify_order_tax_lines", {
  taxId: text("tax_id").primaryKey(),
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  shopLocalDate: text("shop_local_date").notNull(),
  shopLocalMonth: text("shop_local_month").notNull(),
  scope: text("scope").notNull(),
  parentId: text("parent_id"),
  title: text("title"),
  rate: real("rate"),
  price: real("price").notNull().default(0),
  rawJson: text("raw_json").notNull(),
  ingestedAtUtc: text("ingested_at_utc").notNull(),
  harnessRunId: text("harness_run_id").notNull(),
});

export const stagingShopifyRefunds = sqliteTable("shopify_refunds", {
  refundId: text("refund_id").primaryKey(),
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  createdAtUtc: text("created_at_utc").notNull(),
  processedAtUtc: text("processed_at_utc").notNull(),
  shopLocalDate: text("shop_local_date").notNull(),
  shopLocalMonth: text("shop_local_month").notNull(),
  note: text("note"),
  totalRefunded: real("total_refunded").notNull().default(0),
  totalRefundedSet: real("total_refunded_set").notNull().default(0),
  rawJson: text("raw_json").notNull(),
  ingestedAtUtc: text("ingested_at_utc").notNull(),
  harnessRunId: text("harness_run_id").notNull(),
});

export const stagingShopifyRefundLines = sqliteTable("shopify_refund_lines", {
  refundLineId: text("refund_line_id").primaryKey(),
  refundId: text("refund_id").notNull(),
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  shopLocalDate: text("shop_local_date").notNull(),
  shopLocalMonth: text("shop_local_month").notNull(),
  kind: text("kind").notNull(),
  lineItemId: text("line_item_id"),
  quantity: integer("quantity"),
  subtotal: real("subtotal").notNull().default(0),
  totalTax: real("total_tax").notNull().default(0),
  adjustmentKind: text("adjustment_kind"),
  restockType: text("restock_type"),
  isGiftCard: integer("is_gift_card").notNull().default(0),
  rawJson: text("raw_json").notNull(),
  ingestedAtUtc: text("ingested_at_utc").notNull(),
  harnessRunId: text("harness_run_id").notNull(),
});

export const stagingShopifyOrderEdits = sqliteTable("shopify_order_edits", {
  editId: text("edit_id").primaryKey(),
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  eventId: text("event_id"),
  createdAtUtc: text("created_at_utc").notNull(),
  shopLocalDate: text("shop_local_date").notNull(),
  shopLocalMonth: text("shop_local_month").notNull(),
  message: text("message"),
  attributeToApp: text("attribute_to_app"),
  attributeToUser: text("attribute_to_user"),
  deltaSubtotal: real("delta_subtotal").notNull().default(0),
  deltaTax: real("delta_tax").notNull().default(0),
  deltaTotal: real("delta_total").notNull().default(0),
  rawJson: text("raw_json").notNull(),
  ingestedAtUtc: text("ingested_at_utc").notNull(),
  harnessRunId: text("harness_run_id").notNull(),
});

export const stagingShopifyFinanceEvents = sqliteTable("shopify_finance_events", {
  eventKey: text("event_key").primaryKey(),
  eventType: text("event_type").notNull(),
  orderId: text("order_id").notNull(),
  orderName: text("order_name").notNull(),
  refId: text("ref_id"),
  eventDateUtc: text("event_date_utc").notNull(),
  shopLocalDate: text("shop_local_date").notNull(),
  shopLocalMonth: text("shop_local_month").notNull(),
  amount: real("amount").notNull().default(0),
  taxAmount: real("tax_amount").notNull().default(0),
  quantity: integer("quantity"),
  isGiftCard: integer("is_gift_card").notNull().default(0),
  isCancelledOrder: integer("is_cancelled_order").notNull().default(0),
  notes: text("notes"),
  rawSource: text("raw_source"),
  ingestedAtUtc: text("ingested_at_utc").notNull(),
  harnessRunId: text("harness_run_id").notNull(),
});

export const stagingHarnessRuns = sqliteTable("harness_runs", {
  harnessRunId: text("harness_run_id").primaryKey(),
  month: text("month").notNull(),
  shopTz: text("shop_tz").notNull(),
  startedAtUtc: text("started_at_utc").notNull(),
  finishedAtUtc: text("finished_at_utc"),
  ok: integer("ok").notNull().default(0),
  ordersPulled: integer("orders_pulled").notNull().default(0),
  refundsPulled: integer("refunds_pulled").notNull().default(0),
  linesPulled: integer("lines_pulled").notNull().default(0),
  editsPulled: integer("edits_pulled").notNull().default(0),
  eventsProjected: integer("events_projected").notNull().default(0),
  errorText: text("error_text"),
  paramsJson: text("params_json").notNull(),
});
