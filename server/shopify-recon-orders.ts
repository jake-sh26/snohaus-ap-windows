/**
 * Shopify orders → recon_orders + recon_line_items ingest (PR #R2).
 *
 * Two entry points:
 *   - syncOrdersIncremental():   polling job, walks updated_at_min watermark
 *   - upsertOrderFromShopify():  webhook hot-path, single payload
 *
 * BOTH funnel through `transformAndUpsert()` so the transform logic is
 * identical and the row in storage looks the same regardless of source.
 *
 * Key invariants (DO NOT regress without updating PR #R5 rollup math):
 *   1. `tax_channel_liable` at the LINE level mirrors any tax_line on that
 *      line with `channel_liable = true`. Order-level is TRUE if ANY line is.
 *      This is the marketplace-facilitator (Shop channel) exception — tax is
 *      remitted by Shopify, NOT us, and must be EXCLUDED from owed-tax math.
 *   2. `has_gift_card` at the ORDER level is TRUE if any line item's product
 *      has `is_gift_card = true` in the line item payload. Gift-card sales
 *      get special allocation in PR #R4.
 *   3. We never compute monetary totals — we store Shopify's authoritative
 *      values (subtotal_price, total_tax, etc.) verbatim as REAL. The raw
 *      JSON payload is also stored for forensic audit.
 */

import {
  startReconSync, finishReconSync,
  upsertReconOrder, replaceReconLineItems,
  getReconOrdersWatermark, getReconSettings,
  type ReconOrderUpsert, type ReconLineItemUpsert,
} from "./storage";
import {
  getShopifyReconConfig, shopifyRestCall, parseNextPageUrl,
} from "./shopify-recon";
import { recordIntegrationError, recordIntegrationWarn } from "./error-log";

function srError(scope: string, msg: string) { recordIntegrationError("shopify-recon", scope, msg, "error"); }
function srWarn(scope: string, msg: string) { recordIntegrationWarn("shopify-recon", scope, msg); }

const PAGE_LIMIT = 250; // Shopify max for orders.json

// ----------------------------------------------------------------------------
// Transform: raw Shopify order JSON -> ReconOrderUpsert + line items.
// Exported so tests / debug routes can preview transforms without writing.
// ----------------------------------------------------------------------------
export function transformShopifyOrder(o: any): {
  order: ReconOrderUpsert;
  lines: ReconLineItemUpsert[];
} {
  // ---- Defensive number coercion. Shopify sends money as strings ("123.45"). ----
  const num = (v: any): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  };
  const numOr0 = (v: any): number => num(v) ?? 0;

  // ---- Total tips: Shopify exposes either total_tip_received or total_tip ----
  const totalTips =
    num(o.total_tip_received) ??
    num(o.total_tip) ??
    null;

  // ---- Lines ----
  const rawLines = Array.isArray(o.line_items) ? o.line_items : [];
  const lines: ReconLineItemUpsert[] = rawLines.map((li: any) => {
    const taxLines = Array.isArray(li.tax_lines) ? li.tax_lines : [];
    // Channel_liable flag — TRUE if ANY tax_line on this line is channel-liable.
    const lineChannelLiable = taxLines.some((tl: any) => tl?.channel_liable === true) ? 1 : 0;
    // Sum line-level tax (regardless of channel_liable).
    const lineTaxTotal = taxLines.reduce((acc: number, tl: any) => acc + (num(tl?.price) ?? 0), 0);
    const qty = numOr0(li.quantity);
    const price = num(li.price);
    const totalDiscount = numOr0(li.total_discount);
    const lineSubtotal = price !== null ? (price * qty - totalDiscount) : null;
    // Normalised tax_lines for storage — preserve everything we'll need for NY
    // county-level filings (jurisdiction codes are inside `tax_lines[].jurisdiction*`).
    const taxLinesNormalized = taxLines.map((tl: any) => ({
      title: tl?.title ?? null,
      rate: num(tl?.rate),
      price: num(tl?.price),
      channel_liable: Boolean(tl?.channel_liable),
      // The exact field name for jurisdiction depends on API version. Capture all common keys.
      jurisdiction_id: tl?.jurisdiction_id ?? null,
      jurisdiction_name: tl?.jurisdiction_name ?? null,
      jurisdiction_type: tl?.jurisdiction_type ?? null,
    }));
    return {
      id: String(li.id),
      order_id: String(o.id),
      product_id: li.product_id != null ? String(li.product_id) : null,
      variant_id: li.variant_id != null ? String(li.variant_id) : null,
      sku: li.sku ?? null,
      title: li.title ?? null,
      variant_title: li.variant_title ?? null,
      quantity: qty,
      price,
      total_discount: totalDiscount,
      line_subtotal: lineSubtotal,
      line_tax_total: lineTaxTotal,
      tax_channel_liable: lineChannelLiable,
      tax_lines_json: JSON.stringify(taxLinesNormalized),
      // Heuristic: Shopify marks gift cards with `gift_card: true` on the line
      // item OR with a `properties` entry. Trust the explicit field first.
      is_gift_card: li.gift_card === true ? 1 : 0,
      requires_shipping: li.requires_shipping === true ? 1 : 0,
      raw_json: JSON.stringify(li),
    };
  });

  // ---- Order rollups (denormalized from lines) ----
  const orderChannelLiable = lines.some(l => l.tax_channel_liable === 1) ? 1 : 0;
  const orderHasGiftCard = lines.some(l => l.is_gift_card === 1) ? 1 : 0;

  // ---- Shipping totals — Shopify aggregates these in shipping_lines. ----
  const totalShipping = Array.isArray(o.shipping_lines)
    ? o.shipping_lines.reduce((acc: number, s: any) => acc + (num(s?.price) ?? 0), 0)
    : null;

  // ---- Customer + zip extraction for digital-GC allocator (PR #R4) ----
  const billingZip = o.billing_address?.zip ?? null;
  const shippingZip = o.shipping_address?.zip ?? null;

  // ---- location_id: present for POS orders; null for online before fulfillment.
  // We capture it as-is; allocator (PR #R4) will fall back to fulfillment.location_id
  // when this is missing.
  const locationId = o.location_id != null ? String(o.location_id) : null;

  const order: ReconOrderUpsert = {
    id: String(o.id),
    order_number: o.order_number != null ? String(o.order_number) : null,
    name: o.name ?? null,
    created_at: o.created_at,
    processed_at: o.processed_at ?? null,
    updated_at: o.updated_at ?? null,
    cancelled_at: o.cancelled_at ?? null,
    closed_at: o.closed_at ?? null,
    financial_status: o.financial_status ?? null,
    fulfillment_status: o.fulfillment_status ?? null,
    source_name: o.source_name ?? null,
    location_id: locationId,
    currency: o.currency ?? null,
    subtotal: num(o.subtotal_price),
    total_tax: num(o.total_tax),
    total_discounts: num(o.total_discounts),
    total_shipping: totalShipping,
    total_tips: totalTips,
    total_price: num(o.total_price),
    total_refunded: 0, // refunds tracked separately when we add the refunds endpoint
    customer_id: o.customer?.id != null ? String(o.customer.id) : null,
    customer_email: o.email ?? o.customer?.email ?? null,
    billing_zip: billingZip,
    shipping_zip: shippingZip,
    has_gift_card: orderHasGiftCard,
    tax_channel_liable: orderChannelLiable,
    raw_json: JSON.stringify(o),
  };
  return { order, lines };
}

/**
 * Upsert a single order + its line items. Used by both webhook handlers and
 * the polling loop. Idempotent — safe to call multiple times for the same order.
 */
export function upsertOrderFromShopify(rawOrder: any): {
  orderId: string;
  outcome: "inserted" | "updated";
  lineCount: number;
} {
  const { order, lines } = transformShopifyOrder(rawOrder);
  const outcome = upsertReconOrder(order);
  const lineCount = replaceReconLineItems(order.id, lines);
  return { orderId: order.id, outcome, lineCount };
}

/**
 * Incremental orders sync. Two modes:
 *   - first run: pulls everything from initial_sync_from (settings) onward
 *   - subsequent runs: uses updated_at_min = last successful watermark
 *
 * Watermark is the MAX updated_at of all orders seen on this run, persisted
 * via finishReconSync(..., cursor) on success. We use updated_at (not
 * created_at) so edits to old orders re-flow.
 *
 * Returns counters for logging — also writes them to recon_sync_log.
 */
export async function syncOrdersIncremental(
  triggeredBy: string,
): Promise<{
  pages: number;
  ordersIngested: number;
  inserted: number;
  updated: number;
  watermark: string | null;
  syncLogId: number;
  error?: string;
}> {
  const cfg = getShopifyReconConfig();
  if (!cfg) {
    return { pages: 0, ordersIngested: 0, inserted: 0, updated: 0, watermark: null, syncLogId: -1, error: "Shopify reconciler not configured" };
  }

  const settings = getReconSettings();
  const initialSyncFrom = (settings?.initial_sync_from || "2025-01-01") + "T00:00:00Z";
  const lastWatermark = getReconOrdersWatermark();
  const updatedAtMin = lastWatermark || initialSyncFrom;

  const syncLogId = startReconSync("orders", triggeredBy, updatedAtMin);

  let pages = 0;
  let inserted = 0;
  let updated = 0;
  let maxUpdatedAt: string | null = null;

  // First page: explicit query params. Subsequent pages: Link header URL.
  let nextUrl: string | null = null;
  try {
    do {
      pages++;
      const res = nextUrl
        ? await shopifyRestCall(cfg, nextUrl)
        : await shopifyRestCall(cfg, "/orders.json", {
            query: {
              status: "any",            // include cancelled, closed, open
              limit: PAGE_LIMIT,
              updated_at_min: updatedAtMin,
              order: "updated_at asc",  // stable for watermark advancement
            },
          });
      const orders = (res.json?.orders || []) as any[];
      for (const o of orders) {
        try {
          const { outcome } = upsertOrderFromShopify(o);
          if (outcome === "inserted") inserted++; else updated++;
          if (o.updated_at && (!maxUpdatedAt || o.updated_at > maxUpdatedAt)) {
            maxUpdatedAt = o.updated_at;
          }
        } catch (e: any) {
          srWarn("orders-ingest", `order ${o?.id} transform/upsert failed: ${e?.message ?? e}`);
        }
      }
      nextUrl = parseNextPageUrl(res.linkHeader);

      // Safety: stop runaway pulls (>200 pages = 50k orders in one go).
      if (pages > 200) {
        srWarn("orders-ingest", `stopping incremental pull at ${pages} pages — will resume from new watermark next run`);
        break;
      }
    } while (nextUrl);

    finishReconSync(syncLogId, {
      status: "success",
      rows_ingested: inserted + updated,
      // Bump watermark forward by 1ms so the next pull starts strictly after
      // the last row (prevents redundant re-ingest of the boundary row).
      cursor: maxUpdatedAt ? bumpIso(maxUpdatedAt) : updatedAtMin,
    });

    return {
      pages,
      ordersIngested: inserted + updated,
      inserted,
      updated,
      watermark: maxUpdatedAt ? bumpIso(maxUpdatedAt) : updatedAtMin,
      syncLogId,
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    srError("orders-ingest", `incremental sync failed: ${msg}`);
    finishReconSync(syncLogId, {
      status: "failure",
      rows_ingested: inserted + updated,
      error_message: msg,
    });
    return { pages, ordersIngested: inserted + updated, inserted, updated, watermark: null, syncLogId, error: msg };
  }
}

/**
 * Add 1 millisecond to an ISO timestamp. Used to advance the watermark past
 * the last seen row so the next pull is strictly greater-than instead of
 * equal-to (Shopify's updated_at_min is inclusive).
 */
function bumpIso(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + 1).toISOString();
}
