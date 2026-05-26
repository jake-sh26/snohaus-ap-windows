/**
 * Recon Staging Harness — Shopify → staging ingest.
 *
 * Public entry point: `ingestMonth(month, opts)` — pulls all Shopify orders
 * whose processed_at falls in `month` (shop-local), plus refunds processed
 * in that month even if the parent order is older. Writes normalized rows
 * to staging.* tables, idempotent via upserts on primary keys.
 *
 * Design constraints (per harness spec):
 *   - REUSE shopifyGraphqlCall + getShopifyReconConfig from server/shopify-recon.ts
 *   - NEVER import old finance bucketing logic.
 *   - Refunds keyed by their OWN processed_at, not the parent order's date.
 *   - Order edits dated by edit.createdAt.
 *   - Raw JSON preserved on every staging row.
 *   - Reruns of the same month are safe (PK-based upsert).
 */

import Database from "better-sqlite3";
import crypto from "node:crypto";
import { getShopifyReconConfig, shopifyGraphqlCall } from "../shopify-recon";
import { openStagingDb } from "./staging-db";
import {
  setShopTimezone,
  getShopTimezone,
  shopLocalDate,
  shopLocalMonth,
  monthFilterRange,
} from "./tz";
import {
  SHOP_INFO_QUERY,
  ORDERS_BY_PROCESSED_AT_QUERY,
  ORDER_LINEITEMS_PAGED_QUERY,
} from "./graphql";

const num = (v: any): number => {
  if (v == null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
};
const money = (set: any): number => num(set?.shopMoney?.amount);

type IngestOpts = {
  month: string;           // 'YYYY-MM'
  includeCancelled?: boolean; // staging always pulls them; this is just a label
};

type IngestResult = {
  ok: boolean;
  harness_run_id: string;
  month: string;
  shop_tz: string;
  counts: {
    orders: number;
    lines: number;
    shipping: number;
    tax_lines: number;
    refunds: number;
    refund_lines: number;
    edits: number;
  };
  error?: string;
};

export async function ingestMonth(opts: IngestOpts): Promise<IngestResult> {
  const month = opts.month;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Bad month '${month}' (want YYYY-MM)`);
  }

  const cfg = getShopifyReconConfig();
  if (!cfg) throw new Error("Shopify recon not configured");

  // Resolve shop TZ first so all bucketing uses shop-local time.
  const shopInfo = await shopifyGraphqlCall<any>(cfg, SHOP_INFO_QUERY);
  if (shopInfo.errors) {
    throw new Error(`shop info errors: ${JSON.stringify(shopInfo.errors).slice(0, 400)}`);
  }
  const tz = shopInfo.data?.shop?.ianaTimezone || "America/New_York";
  setShopTimezone(tz);

  const stagingDb = openStagingDb();
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  stagingDb.prepare(`
    INSERT INTO staging.harness_runs
      (harness_run_id, month, shop_tz, started_at_utc, ok, params_json)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(runId, month, tz, startedAt, JSON.stringify(opts));

  const counts = {
    orders: 0, lines: 0, shipping: 0, tax_lines: 0,
    refunds: 0, refund_lines: 0, edits: 0,
  };

  try {
    // --------- PASS 1: orders processed in this month ----------
    const { q: monthQ } = monthFilterRange(month);
    await pullOrders(cfg, stagingDb, runId, monthQ, counts);

    // --------- PASS 2: orders WHOSE REFUNDS were processed this month ----------
    // (Pulling by `updated_at` for the month picks up older orders that received
    //  a refund this month. We re-upsert their headers + refunds.)
    const updatedQ = monthFilterRange(month).q.replace(/processed_at:/g, "updated_at:");
    await pullOrders(cfg, stagingDb, runId, updatedQ, counts);

    stagingDb.prepare(`
      UPDATE staging.harness_runs SET
        finished_at_utc = ?, ok = 1,
        orders_pulled = ?, lines_pulled = ?, refunds_pulled = ?, edits_pulled = ?
      WHERE harness_run_id = ?
    `).run(
      new Date().toISOString(),
      counts.orders, counts.lines, counts.refunds, counts.edits,
      runId,
    );

    return {
      ok: true, harness_run_id: runId, month, shop_tz: tz, counts,
    };
  } catch (e: any) {
    const errText = String(e?.message || e);
    stagingDb.prepare(`
      UPDATE staging.harness_runs SET
        finished_at_utc = ?, ok = 0, error_text = ?
      WHERE harness_run_id = ?
    `).run(new Date().toISOString(), errText, runId);
    return {
      ok: false, harness_run_id: runId, month, shop_tz: tz, counts,
      error: errText,
    };
  }
}

async function pullOrders(
  cfg: any,
  db: Database.Database,
  runId: string,
  q: string,
  counts: IngestResult["counts"],
): Promise<void> {
  let cursor: string | null = null;
  let pageNum = 0;

  while (true) {
    pageNum++;
    const resp: { status: number; data: any; errors: any[] | null } =
      await shopifyGraphqlCall<any>(cfg, ORDERS_BY_PROCESSED_AT_QUERY, {
        cursor, q,
      });
    if (resp.errors) {
      throw new Error(`orders page ${pageNum} errors: ${JSON.stringify(resp.errors).slice(0, 400)}`);
    }
    const conn: any = resp.data?.orders;
    if (!conn) break;

    const nodes = conn.nodes || [];
    for (const order of nodes) {
      await writeOneOrder(cfg, db, runId, order, counts);
    }

    console.log(`[recon-staging] q='${q.slice(0, 60)}' page ${pageNum}: ${nodes.length} orders (total so far ${counts.orders})`);

    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
}

async function writeOneOrder(
  cfg: any,
  db: Database.Database,
  runId: string,
  order: any,
  counts: IngestResult["counts"],
): Promise<void> {
  const orderId = order.id;
  const orderName = order.name; // includes leading '#'

  const processedAt = order.processedAt || order.createdAt;
  const shopDate = shopLocalDate(processedAt);
  const shopMonth = shopLocalMonth(processedAt);

  const channelHandle = order.channelInformation?.channelDefinition?.handle ?? null;
  const channelName = order.channelInformation?.channelDefinition?.channelName ?? null;
  const posLocId = order.physicalLocation?.id ?? null;
  const posLocName = order.physicalLocation?.name ?? null;

  const editEvents = (order.events?.nodes || []).filter((e: any) =>
    e?.message && /edited|added|removed|discount/i.test(e.message),
  );

  db.prepare(`
    INSERT INTO staging.shopify_orders (
      order_id, order_name, legacy_resource_id,
      created_at_utc, processed_at_utc, updated_at_utc, cancelled_at_utc, closed_at_utc,
      shop_local_date, shop_local_month,
      financial_status, fulfillment_status, cancel_reason,
      channel_handle, channel_name, pos_location_id, pos_location_name,
      currency,
      original_subtotal, original_total_price, original_total_tax,
      original_total_discounts, original_total_shipping,
      current_subtotal, current_total_price, current_total_tax,
      current_total_discounts, total_refunded, total_outstanding,
      has_been_edited, edit_count,
      raw_json, ingested_at_utc, harness_run_id
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, datetime('now'), ?
    )
    ON CONFLICT(order_id) DO UPDATE SET
      order_name = excluded.order_name,
      legacy_resource_id = excluded.legacy_resource_id,
      created_at_utc = excluded.created_at_utc,
      processed_at_utc = excluded.processed_at_utc,
      updated_at_utc = excluded.updated_at_utc,
      cancelled_at_utc = excluded.cancelled_at_utc,
      closed_at_utc = excluded.closed_at_utc,
      shop_local_date = excluded.shop_local_date,
      shop_local_month = excluded.shop_local_month,
      financial_status = excluded.financial_status,
      fulfillment_status = excluded.fulfillment_status,
      cancel_reason = excluded.cancel_reason,
      channel_handle = excluded.channel_handle,
      channel_name = excluded.channel_name,
      pos_location_id = excluded.pos_location_id,
      pos_location_name = excluded.pos_location_name,
      currency = excluded.currency,
      original_subtotal = excluded.original_subtotal,
      original_total_price = excluded.original_total_price,
      original_total_tax = excluded.original_total_tax,
      original_total_discounts = excluded.original_total_discounts,
      original_total_shipping = excluded.original_total_shipping,
      current_subtotal = excluded.current_subtotal,
      current_total_price = excluded.current_total_price,
      current_total_tax = excluded.current_total_tax,
      current_total_discounts = excluded.current_total_discounts,
      total_refunded = excluded.total_refunded,
      total_outstanding = excluded.total_outstanding,
      has_been_edited = excluded.has_been_edited,
      edit_count = excluded.edit_count,
      raw_json = excluded.raw_json,
      ingested_at_utc = datetime('now'),
      harness_run_id = excluded.harness_run_id
  `).run(
    orderId, orderName, order.legacyResourceId || null,
    order.createdAt, order.processedAt || null, order.updatedAt || null,
    order.cancelledAt || null, order.closedAt || null,
    shopDate, shopMonth,
    order.displayFinancialStatus || null,
    order.displayFulfillmentStatus || null,
    order.cancelReason || null,
    channelHandle, channelName, posLocId, posLocName,
    order.currencyCode || "USD",
    money(order.subtotalPriceSet), money(order.originalTotalPriceSet), money(order.totalTaxSet),
    money(order.totalDiscountsSet), money(order.totalShippingPriceSet),
    money(order.currentSubtotalPriceSet), money(order.currentTotalPriceSet),
    money(order.currentTotalTaxSet), money(order.currentTotalDiscountsSet),
    money(order.totalRefundedSet), money(order.totalOutstandingSet),
    editEvents.length > 0 ? 1 : 0, editEvents.length,
    JSON.stringify(order), runId,
  );
  counts.orders++;

  // Lines
  const liConn = order.lineItems;
  let lineNodes: any[] = liConn?.nodes || [];
  if (liConn?.pageInfo?.hasNextPage) {
    let cursor: string | null = liConn.pageInfo.endCursor;
    while (cursor) {
      const r = await shopifyGraphqlCall<any>(cfg, ORDER_LINEITEMS_PAGED_QUERY, {
        orderId, cursor,
      });
      if (r.errors) throw new Error(`lineItems page errors: ${JSON.stringify(r.errors).slice(0, 400)}`);
      const more = r.data?.order?.lineItems;
      if (!more) break;
      lineNodes = lineNodes.concat(more.nodes || []);
      if (!more.pageInfo?.hasNextPage) break;
      cursor = more.pageInfo.endCursor;
    }
  }
  writeLines(db, runId, order, lineNodes, shopDate, shopMonth, counts);

  // Shipping
  writeShipping(db, runId, order, shopDate, shopMonth, counts);

  // Tax lines (aggregated from per-line and per-shipping nests)
  writeTaxLines(db, runId, order, lineNodes, shopDate, shopMonth, counts);

  // Refunds — dated by their OWN processed_at
  writeRefunds(db, runId, order, lineNodes, counts);

  // Order edits — dated by edit.createdAt
  writeEdits(db, runId, order, editEvents, counts);
}

function writeLines(
  db: Database.Database, runId: string, order: any, lineNodes: any[],
  shopDate: string, shopMonth: string, counts: IngestResult["counts"],
): void {
  const stmt = db.prepare(`
    INSERT INTO staging.shopify_order_lines (
      line_id, order_id, order_name, shop_local_date, shop_local_month, line_index,
      sku, title, variant_id, product_id, product_type, vendor,
      quantity, original_unit_price, original_total,
      discounted_unit_price, discounted_total, total_line_discount,
      is_gift_card, requires_shipping,
      current_quantity, refundable_quantity,
      raw_json, ingested_at_utc, harness_run_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, datetime('now'), ?
    )
    ON CONFLICT(line_id) DO UPDATE SET
      order_id = excluded.order_id,
      order_name = excluded.order_name,
      shop_local_date = excluded.shop_local_date,
      shop_local_month = excluded.shop_local_month,
      line_index = excluded.line_index,
      sku = excluded.sku,
      title = excluded.title,
      variant_id = excluded.variant_id,
      product_id = excluded.product_id,
      product_type = excluded.product_type,
      vendor = excluded.vendor,
      quantity = excluded.quantity,
      original_unit_price = excluded.original_unit_price,
      original_total = excluded.original_total,
      discounted_unit_price = excluded.discounted_unit_price,
      discounted_total = excluded.discounted_total,
      total_line_discount = excluded.total_line_discount,
      is_gift_card = excluded.is_gift_card,
      requires_shipping = excluded.requires_shipping,
      current_quantity = excluded.current_quantity,
      refundable_quantity = excluded.refundable_quantity,
      raw_json = excluded.raw_json,
      ingested_at_utc = datetime('now'),
      harness_run_id = excluded.harness_run_id
  `);

  lineNodes.forEach((li: any, idx: number) => {
    const productType = li.product?.productType || "";
    const isGc = /gift\s*card/i.test(productType) || li.title?.toLowerCase().includes("gift card") ? 1 : 0;
    stmt.run(
      li.id, order.id, order.name, shopDate, shopMonth, idx,
      li.sku || li.variant?.sku || null,
      li.title || null,
      li.variant?.id || null,
      li.product?.id || null,
      productType || null,
      li.product?.vendor || null,
      Number(li.quantity || 0),
      money(li.originalUnitPriceSet),
      money(li.originalTotalSet),
      money(li.discountedUnitPriceSet),
      money(li.discountedTotalSet),
      money(li.totalDiscountSet),
      isGc,
      li.requiresShipping === false ? 0 : 1,
      li.currentQuantity != null ? Number(li.currentQuantity) : null,
      li.refundableQuantity != null ? Number(li.refundableQuantity) : null,
      JSON.stringify(li), runId,
    );
    counts.lines++;
  });
}

function writeShipping(
  db: Database.Database, runId: string, order: any,
  shopDate: string, shopMonth: string, counts: IngestResult["counts"],
): void {
  const stmt = db.prepare(`
    INSERT INTO staging.shopify_order_shipping (
      shipping_id, order_id, order_name, shop_local_date, shop_local_month,
      title, code, original_price, discounted_price,
      raw_json, ingested_at_utc, harness_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(shipping_id) DO UPDATE SET
      title = excluded.title, code = excluded.code,
      original_price = excluded.original_price,
      discounted_price = excluded.discounted_price,
      raw_json = excluded.raw_json,
      ingested_at_utc = datetime('now'),
      harness_run_id = excluded.harness_run_id
  `);
  const nodes = order.shippingLines?.nodes || [];
  nodes.forEach((s: any, idx: number) => {
    const sid = s.id || `${order.id}:ship:${idx}`;
    stmt.run(
      sid, order.id, order.name, shopDate, shopMonth,
      s.title || null, s.code || null,
      money(s.originalPriceSet),
      money(s.discountedPriceSet),
      JSON.stringify(s), runId,
    );
    counts.shipping++;
  });
}

function writeTaxLines(
  db: Database.Database, runId: string, order: any, lineNodes: any[],
  shopDate: string, shopMonth: string, counts: IngestResult["counts"],
): void {
  const stmt = db.prepare(`
    INSERT INTO staging.shopify_order_tax_lines (
      tax_id, order_id, order_name, shop_local_date, shop_local_month,
      scope, parent_id, title, rate, price,
      raw_json, ingested_at_utc, harness_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(tax_id) DO UPDATE SET
      title = excluded.title, rate = excluded.rate, price = excluded.price,
      raw_json = excluded.raw_json,
      ingested_at_utc = datetime('now'),
      harness_run_id = excluded.harness_run_id
  `);

  // per-line tax
  lineNodes.forEach((li: any) => {
    (li.taxLines || []).forEach((t: any, ti: number) => {
      const tid = `${li.id}:tax:${ti}`;
      stmt.run(
        tid, order.id, order.name, shopDate, shopMonth,
        "line", li.id, t.title || null, num(t.rate), money(t.priceSet),
        JSON.stringify(t), runId,
      );
      counts.tax_lines++;
    });
  });

  // shipping tax
  (order.shippingLines?.nodes || []).forEach((s: any, si: number) => {
    const sid = s.id || `${order.id}:ship:${si}`;
    (s.taxLines || []).forEach((t: any, ti: number) => {
      const tid = `${sid}:tax:${ti}`;
      stmt.run(
        tid, order.id, order.name, shopDate, shopMonth,
        "shipping", sid, t.title || null, num(t.rate), money(t.priceSet),
        JSON.stringify(t), runId,
      );
      counts.tax_lines++;
    });
  });
}

function writeRefunds(
  db: Database.Database, runId: string, order: any, lineNodes: any[],
  counts: IngestResult["counts"],
): void {
  const lineMap = new Map<string, any>();
  for (const l of lineNodes) lineMap.set(l.id, l);

  const refundStmt = db.prepare(`
    INSERT INTO staging.shopify_refunds (
      refund_id, order_id, order_name,
      created_at_utc, processed_at_utc, shop_local_date, shop_local_month,
      note, total_refunded, total_refunded_set,
      raw_json, ingested_at_utc, harness_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(refund_id) DO UPDATE SET
      note = excluded.note, total_refunded = excluded.total_refunded,
      total_refunded_set = excluded.total_refunded_set,
      shop_local_date = excluded.shop_local_date,
      shop_local_month = excluded.shop_local_month,
      processed_at_utc = excluded.processed_at_utc,
      raw_json = excluded.raw_json,
      ingested_at_utc = datetime('now'),
      harness_run_id = excluded.harness_run_id
  `);
  const refundLineStmt = db.prepare(`
    INSERT INTO staging.shopify_refund_lines (
      refund_line_id, refund_id, order_id, order_name,
      shop_local_date, shop_local_month, kind, line_item_id, quantity,
      subtotal, total_tax, adjustment_kind, restock_type, is_gift_card,
      raw_json, ingested_at_utc, harness_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(refund_line_id) DO UPDATE SET
      subtotal = excluded.subtotal, total_tax = excluded.total_tax,
      adjustment_kind = excluded.adjustment_kind,
      restock_type = excluded.restock_type,
      is_gift_card = excluded.is_gift_card,
      shop_local_date = excluded.shop_local_date,
      shop_local_month = excluded.shop_local_month,
      raw_json = excluded.raw_json,
      ingested_at_utc = datetime('now'),
      harness_run_id = excluded.harness_run_id
  `);

  const refunds = order.refunds || [];
  for (const refund of refunds) {
    const procAt = refund.processedAt || refund.createdAt;
    const rDate = shopLocalDate(procAt);
    const rMonth = shopLocalMonth(procAt);

    // Sum transactions for total_refunded
    let txAmt = 0;
    for (const tx of (refund.transactions?.nodes || [])) {
      if (tx.kind === "REFUND" && tx.status === "SUCCESS") txAmt += money(tx.amountSet);
    }

    refundStmt.run(
      refund.id, order.id, order.name,
      refund.createdAt, procAt, rDate, rMonth,
      refund.note || null,
      txAmt,
      money(refund.totalRefundedSet),
      JSON.stringify(refund), runId,
    );
    counts.refunds++;

    // Refund line items
    (refund.refundLineItems?.nodes || []).forEach((rli: any, idx: number) => {
      const li = rli.lineItem ? lineMap.get(rli.lineItem.id) : null;
      const isGc = li
        ? (/gift\s*card/i.test(li.product?.productType || "") || li.title?.toLowerCase().includes("gift card") ? 1 : 0)
        : (/gift\s*card/i.test(rli.lineItem?.product?.productType || "") ? 1 : 0);
      const rlid = `${refund.id}:rli:${rli.lineItem?.id || idx}`;
      refundLineStmt.run(
        rlid, refund.id, order.id, order.name, rDate, rMonth,
        "line_item", rli.lineItem?.id || null,
        Number(rli.quantity || 0),
        money(rli.subtotalSet), money(rli.totalTaxSet),
        null, rli.restockType || null, isGc,
        JSON.stringify(rli), runId,
      );
      counts.refund_lines++;
    });

    // Order adjustments (return fees / shipping refund / discrepancy)
    (refund.orderAdjustments?.nodes || []).forEach((oa: any, idx: number) => {
      const rlid = oa.id || `${refund.id}:adj:${idx}`;
      const amt = money(oa.amountSet);
      const taxAmt = money(oa.taxAmountSet);
      const kind = (oa.kind || "").toString().toLowerCase();
      let normKind = "order_adjustment";
      if (kind.includes("shipping")) normKind = "shipping_refund";
      else if (kind.includes("refund_discrepancy") || kind.includes("discrepancy")) normKind = "order_adjustment";
      refundLineStmt.run(
        rlid, refund.id, order.id, order.name, rDate, rMonth,
        normKind, null, null,
        amt, taxAmt,
        oa.kind || null, null, 0,
        JSON.stringify(oa), runId,
      );
      counts.refund_lines++;
    });
  }
}

function writeEdits(
  db: Database.Database, runId: string, order: any, editEvents: any[],
  counts: IngestResult["counts"],
): void {
  if (!editEvents.length) return;
  const stmt = db.prepare(`
    INSERT INTO staging.shopify_order_edits (
      edit_id, order_id, order_name, event_id, created_at_utc,
      shop_local_date, shop_local_month, message, attribute_to_app, attribute_to_user,
      delta_subtotal, delta_tax, delta_total,
      raw_json, ingested_at_utc, harness_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(edit_id) DO UPDATE SET
      message = excluded.message,
      delta_subtotal = excluded.delta_subtotal,
      delta_tax = excluded.delta_tax,
      delta_total = excluded.delta_total,
      raw_json = excluded.raw_json,
      ingested_at_utc = datetime('now'),
      harness_run_id = excluded.harness_run_id
  `);
  // Aggregate delta = current - original (single best-effort number per order).
  // We attribute the FULL delta to the LATEST edit event and zero to others —
  // Shopify doesn't expose per-edit deltas via GraphQL. This is documented in
  // the README at the bottom of this file.
  const delta_sub = money(order.currentSubtotalPriceSet) - money(order.subtotalPriceSet);
  const delta_tax = money(order.currentTotalTaxSet) - money(order.totalTaxSet);
  const delta_tot = money(order.currentTotalPriceSet) - money(order.originalTotalPriceSet);
  const lastIdx = editEvents.length - 1;

  editEvents.forEach((ev: any, idx: number) => {
    const editId = `${order.id}:edit:${ev.id || idx}`;
    const eDate = shopLocalDate(ev.createdAt);
    const eMonth = shopLocalMonth(ev.createdAt);
    const isLast = idx === lastIdx;
    stmt.run(
      editId, order.id, order.name, ev.id || null, ev.createdAt,
      eDate, eMonth,
      ev.message || null,
      ev.attributeToApp || null,
      ev.attributeToUser || null,
      isLast ? delta_sub : 0,
      isLast ? delta_tax : 0,
      isLast ? delta_tot : 0,
      JSON.stringify(ev), runId,
    );
    counts.edits++;
  });
}

/**
 * NOTE on order-edit deltas:
 *   Shopify GraphQL exposes the order.events stream (created/edited/refunded)
 *   but does NOT expose per-event monetary deltas. To get the true per-edit
 *   delta you'd need the Bulk Order Edits API or to snapshot order state
 *   before/after each edit via webhooks.
 *
 *   This harness attributes the entire current-vs-original delta to the LATEST
 *   edit event. That's good enough for cross-month bucketing in the common
 *   case (one edit per order in a single month) and shows up clearly in the
 *   diff when wrong, so we can chase precision later if Shopify Finance
 *   Summary differs.
 */
