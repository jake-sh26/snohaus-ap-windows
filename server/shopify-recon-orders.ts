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
  upsertReconOrder, replaceReconLineItems, replaceReconFulfillments,
  replaceReconFulfillmentOrders,
  replaceReconRefundsForOrder, setReconOrderRefundVariance,
  getReconOrdersWatermark, getReconSettings,
  type ReconOrderUpsert, type ReconLineItemUpsert, type ReconFulfillmentUpsert,
  type ReconFulfillmentOrderUpsert,
  type ReconRefundUpsert, type ReconRefundLineItemUpsert,
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
  fulfillments: ReconFulfillmentUpsert[];
  fulfillment_orders: ReconFulfillmentOrderUpsert[];
  refunds: ReconRefundUpsert[];
  refund_lines: ReconRefundLineItemUpsert[];
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

  // ---- Exchange detection (PR #R4l-a-fix4) ----
  // When a customer exchanges a returned item for a different item, Shopify
  // ADDS the new item as a line on the ORIGINAL order — not a new order. That
  // new line carries the ORIGINAL order's created_at on every field except the
  // fulfillment that delivered it. If we don't detect this, exchanges that
  // cross a month boundary recognize revenue in the wrong month.
  //
  // Detection signal: a fulfillment whose line_items include a line_item_id
  // that does NOT match any original line item we've seen at order-creation
  // time. But because Shopify already mutated line_items[] by the time we see
  // the order, we instead reason backward:
  //   * If a refund has restock_type ∈ {return, cancel} on at least one item,
  //     AND a fulfillment exists whose created_at is meaningfully after the
  //     refund's processed_at, those fulfilled line items are the exchange
  //     replacements.
  // We build a map { line_item_id -> { recognized_at, refund_id } } here, then
  // attach it to each line below.
  const exchangeLineMap = new Map<string, { recognized_at: string; refund_id: string }>();
  {
    const rawRefundsForExchangeScan = Array.isArray(o.refunds) ? o.refunds : [];
    const rawFulfillmentsForExchangeScan = Array.isArray(o.fulfillments) ? o.fulfillments : [];
    // Sort refunds with any restocking event by processed_at ascending so we
    // pair each exchange-fulfillment with the earliest refund it could have
    // resulted from. (Worst-case order has multiple refund+exchange cycles.)
    const restockingRefunds = rawRefundsForExchangeScan
      .filter((r: any) => {
        const rli = Array.isArray(r.refund_line_items) ? r.refund_line_items : [];
        return rli.some((li: any) => li?.restock_type === "return" || li?.restock_type === "cancel");
      })
      .sort((a: any, b: any) => String(a.processed_at ?? a.created_at ?? "").localeCompare(String(b.processed_at ?? b.created_at ?? "")));
    if (restockingRefunds.length > 0 && rawFulfillmentsForExchangeScan.length > 0) {
      const orderCreatedAt = String(o.created_at ?? "");
      for (const f of rawFulfillmentsForExchangeScan) {
        const fCreatedAt = String(f.created_at ?? "");
        // Tolerance: 60 seconds. A fulfillment created within a minute of the
        // order itself is the original-order fulfillment, not an exchange.
        if (!fCreatedAt || !orderCreatedAt) continue;
        const orderMs = Date.parse(orderCreatedAt);
        const fMs = Date.parse(fCreatedAt);
        if (!Number.isFinite(orderMs) || !Number.isFinite(fMs)) continue;
        if (fMs - orderMs < 60_000) continue;
        // This fulfillment is later than order creation — candidate for exchange.
        // Pair it with the latest restocking refund processed BEFORE the
        // fulfillment was created (the exchange flow: customer returns, staff
        // immediately fulfills replacement item).
        const pairedRefund = restockingRefunds
          .filter((r: any) => {
            const rWhen = Date.parse(String(r.processed_at ?? r.created_at ?? ""));
            return Number.isFinite(rWhen) && rWhen <= fMs;
          })
          .pop(); // latest qualifying
        if (!pairedRefund) continue;
        const refundId = String(pairedRefund.id);
        const fLineItems = Array.isArray(f.line_items) ? f.line_items : [];
        for (const fli of fLineItems) {
          const liId = fli?.id != null ? String(fli.id) : null;
          if (!liId) continue;
          // First write wins — if a line item somehow appears in multiple
          // exchange fulfillments, the earliest exchange owns it.
          if (!exchangeLineMap.has(liId)) {
            exchangeLineMap.set(liId, { recognized_at: fCreatedAt, refund_id: refundId });
          }
        }
      }
    }
  }

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
    // PR #R4l-a-fix4 — exchange-aware recognition date. Default to order time;
    // override to the exchange-fulfillment time when this line was added later.
    const liId = String(li.id);
    const exchangeInfo = exchangeLineMap.get(liId);
    const recognized_at = exchangeInfo?.recognized_at ?? o.created_at ?? null;
    const added_via_exchange_refund_id = exchangeInfo?.refund_id ?? null;
    return {
      id: liId,
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
      recognized_at,
      added_via_exchange_refund_id,
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

  // ---- Refunds (PR #R4l-a, math fixed in #R4l-a-fix) ----------------------
  // Shopify ships the full refunds[] array on every /orders.json payload, so
  // we extract it inline here — no separate API call needed for backfill.
  //
  // Sign convention for order_adjustments[]:
  //   * Shopify's `amount` is the SIGNED delta to merchant cash.
  //   * Shipping refunds appear as NEGATIVE amount (e.g. -15.00) meaning cash
  //     left the merchant on top of the line refunds.
  //   * Restocking fees the merchant retains also appear as NEGATIVE on the
  //     refund_discrepancy adjustment line — but Shopify also writes a
  //     corresponding `refund_discrepancy` adjustment that, when positive,
  //     means merchant KEPT cash instead of refunding it.
  //
  // Per-refund cash-out invariant we enforce:
  //   customer_cash_out = items_subtotal + items_tax
  //                       + |adjustments where amount<0|   (shipping refunds)
  //                       - |adjustments where amount>0|   (merchant retained)
  //
  // i.e. negative adjustment amounts represent additional cash going OUT to
  // the customer (shipping refund), positive amounts represent cash retained
  // BY the merchant (restocking fee, discrepancy). The order-level invariant
  // total_price - current_total_price = Σ customer_cash_out holds across
  // every refund pattern Shopify ships.
  const rawRefunds = Array.isArray(o.refunds) ? o.refunds : [];
  const refunds: ReconRefundUpsert[] = [];
  const refund_lines: ReconRefundLineItemUpsert[] = [];
  let aggregateRefundedSubtotal = 0;
  let aggregateRefundedTax = 0;
  let aggregateRefundedTotal = 0;
  for (const r of rawRefunds) {
    const refundId = String(r.id);
    const orderId = String(o.id);
    let rSubtotal = 0;
    let rTax = 0;
    let restocked = 0;

    // refund_line_items[] — the per-line refund detail.
    const rli = Array.isArray(r.refund_line_items) ? r.refund_line_items : [];
    for (const li of rli) {
      const liSubtotal = numOr0(li.subtotal);
      const liTax = numOr0(li.total_tax);
      rSubtotal += liSubtotal;
      rTax += liTax;
      const restock = (li.restock_type ?? "") as string;
      // 'return' and 'cancel' actually put inventory back. 'no_restock' and
      // 'legacy_restock' do not (legacy_restock was a 2017-era bug that
      // Shopify keeps reporting for backfill consistency).
      if (restock === "return" || restock === "cancel") restocked = 1;
      refund_lines.push({
        id: String(li.id),
        refund_id: refundId,
        order_id: orderId,
        kind: "item",
        line_item_id: li.line_item_id != null ? String(li.line_item_id) : null,
        quantity: numOr0(li.quantity),
        subtotal: liSubtotal,
        total_tax: liTax,
        restock_type: restock || null,
        adjustment_kind: null,
        raw_json: JSON.stringify(li),
      });
    }

    // order_adjustments[] — shipping refunds + restocking-fee adjustments.
    // Signed amounts. Negative = more cash out to customer; positive = cash
    // retained by merchant (restocking fee, discrepancy).
    const adjs = Array.isArray(r.order_adjustments) ? r.order_adjustments : [];
    let adjAmountSigned = 0;   // signed sum, for storage/audit
    let adjTaxSigned = 0;
    let extraCashOut = 0;      // |negative adjustment amounts| → adds to refund
    let merchantRetained = 0;  // |positive adjustment amounts| → subtracts from refund
    let extraTaxOut = 0;
    let taxRetained = 0;
    for (const a of adjs) {
      const amt = numOr0(a.amount);
      const tax = numOr0(a.tax_amount);
      adjAmountSigned += amt;
      adjTaxSigned += tax;
      if (amt < 0) extraCashOut += -amt;
      else merchantRetained += amt;
      if (tax < 0) extraTaxOut += -tax;
      else taxRetained += tax;
      refund_lines.push({
        // Adjustments use Shopify's adjustment id, prefixed to avoid PK
        // collision with refund_line_items (both id namespaces overlap).
        id: `adj-${String(a.id)}`,
        refund_id: refundId,
        order_id: orderId,
        kind: "adjustment",
        line_item_id: null,
        quantity: 0,
        // Store the SIGNED amount as-is so the raw_json round-trips cleanly
        // and audits can see the original direction. The rollup uses the
        // canonical formula below, not these raw values.
        subtotal: amt,
        total_tax: tax,
        restock_type: null,
        adjustment_kind: a.kind ?? null,
        raw_json: JSON.stringify(a),
      });
    }

    // Canonical customer cash refunded for this refund.
    // Always ≥ 0 (we floor at 0 in case Shopify ever sends an inverted
    // adjustment that exceeds the item refund — we'd rather log a 0 refund
    // and trip the variance flag than store negative cash).
    const rTotal = Math.max(
      0,
      rSubtotal + rTax + extraCashOut + extraTaxOut - merchantRetained - taxRetained,
    );
    refunds.push({
      id: refundId,
      order_id: orderId,
      created_at: r.created_at ?? null,
      processed_at: r.processed_at ?? null,
      note: r.note ?? null,
      subtotal: rSubtotal,
      total_tax: rTax,
      total_refunded: rTotal,
      adjustment_amount: adjAmountSigned,
      adjustment_tax: adjTaxSigned,
      restocked,
      raw_json: JSON.stringify(r),
    });
    aggregateRefundedSubtotal += rSubtotal;
    aggregateRefundedTax += rTax;
    aggregateRefundedTotal += rTotal;
  }

  // ---- transactions_refunded (PR #R4l-a-fix2, restored in fix6) ----
  // Read the top-level order.transactions[] array. In normal /orders.json
  // payloads this is absent and transactionsRefunded stays null — which is
  // exactly what the variance check needs to fall through to its
  // (total_price - current_total_price) path. The fix3 change to read nested
  // refunds[].transactions[] was the regression that took variance from 9 to
  // 260+: nested gateway-cash includes GC refund txns that are NOT in our
  // line-value sum, so the two never agreed.
  const rawTransactions = Array.isArray(o.transactions) ? o.transactions : [];
  let transactionsRefunded: number | null = null;
  if (rawTransactions.length > 0) {
    transactionsRefunded = 0;
    for (const tx of rawTransactions) {
      if (tx?.kind === "refund" && tx?.status === "success") {
        transactionsRefunded += numOr0(tx.amount);
      }
    }
  }

  // ---- current_* fields — the post-refund snapshot Shopify computes.
  // Defensive fallback: if Shopify omits them (older payloads), derive from
  // total_price minus aggregate refunded. Modern payloads (2023-10+) always
  // include current_total_price.
  const totalPrice = num(o.total_price);
  const subtotalPrice = num(o.subtotal_price);
  const totalTax = num(o.total_tax);
  const currentTotalPrice =
    num(o.current_total_price) ??
    (totalPrice !== null ? Math.max(0, totalPrice - aggregateRefundedTotal) : null);
  const currentSubtotalPrice =
    num(o.current_subtotal_price) ??
    (subtotalPrice !== null ? Math.max(0, subtotalPrice - aggregateRefundedSubtotal) : null);
  const currentTotalTax =
    num(o.current_total_tax) ??
    (totalTax !== null ? Math.max(0, totalTax - aggregateRefundedTax) : null);

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
    subtotal: subtotalPrice,
    total_tax: totalTax,
    total_discounts: num(o.total_discounts),
    total_shipping: totalShipping,
    total_tips: totalTips,
    total_price: totalPrice,
    // PR #R4l-a — was hardcoded 0, now sums refunds[].
    total_refunded: aggregateRefundedTotal,
    current_subtotal_price: currentSubtotalPrice,
    current_total_price: currentTotalPrice,
    current_total_tax: currentTotalTax,
    customer_id: o.customer?.id != null ? String(o.customer.id) : null,
    customer_email: o.email ?? o.customer?.email ?? null,
    billing_zip: billingZip,
    shipping_zip: shippingZip,
    has_gift_card: orderHasGiftCard,
    tax_channel_liable: orderChannelLiable,
    // PR #R4l-a-fix2 — cash-truth refund total from transactions[].
    transactions_refunded: transactionsRefunded,
    raw_json: JSON.stringify(o),
  };

  // ---- Fulfillments (PR #R4b) ----
  // The order-level location_id is the POS register on POS sales and null on
  // online sales. For online sales, each fulfillment carries the actual
  // ship-from location — that's what allocator uses to route to an entity.
  const rawFulfillments = Array.isArray(o.fulfillments) ? o.fulfillments : [];
  const fulfillments: ReconFulfillmentUpsert[] = rawFulfillments.map((f: any) => {
    const lineItemIds = Array.isArray(f.line_items)
      ? f.line_items.map((li: any) => (li?.id != null ? String(li.id) : null)).filter(Boolean)
      : [];
    return {
      id: String(f.id),
      order_id: String(o.id),
      location_id: f.location_id != null ? String(f.location_id) : null,
      status: f.status ?? null,
      shipment_status: f.shipment_status ?? null,
      created_at: f.created_at ?? null,
      updated_at: f.updated_at ?? null,
      tracking_company: f.tracking_company ?? null,
      tracking_number: f.tracking_number ?? null,
      line_item_ids_json: JSON.stringify(lineItemIds),
      raw_json: JSON.stringify(f),
    };
  });

  // ---- Fulfillment orders (PR #R4d) ----
  // The FO graph is more reliable than fulfillments[] for two cases:
  //   1. Online orders that haven't shipped yet still get an FO at order time,
  //      with assigned_location_id set to the routed store. Pre-#R4d these
  //      fell to needs_review until the merchant shipped.
  //   2. Locally orders, which arrive with a non-null order-level location_id
  //      that points at Locally's pseudo-location (e.g. 123711225857), have
  //      a FO assigned to the *actual* fulfilling store. Without this we mis-
  //      routed every Locally order to needs_review or to Locally's fake loc.
  //
  // fulfillment_orders is NOT part of the default /orders.json response —
  // see fetchFulfillmentOrdersForOrder() below for how we hydrate it during
  // sync. If the field happens to be present on the payload (webhook hot path
  // or `fields=...,fulfillment_orders` query) we transform it here too.
  const rawFulfillmentOrders = Array.isArray(o.fulfillment_orders) ? o.fulfillment_orders : [];
  const fulfillment_orders: ReconFulfillmentOrderUpsert[] = rawFulfillmentOrders.map((fo: any) => {
    const lineItemIds = Array.isArray(fo.line_items)
      ? fo.line_items.map((li: any) => (li?.line_item_id != null ? String(li.line_item_id) : null)).filter(Boolean)
      : [];
    return {
      id: String(fo.id),
      order_id: String(o.id),
      assigned_location_id: fo.assigned_location_id != null ? String(fo.assigned_location_id) : null,
      status: fo.status ?? null,
      request_status: fo.request_status ?? null,
      supported_actions_json: fo.supported_actions ? JSON.stringify(fo.supported_actions) : null,
      line_item_ids_json: JSON.stringify(lineItemIds),
      raw_json: JSON.stringify(fo),
    };
  });

  return { order, lines, fulfillments, fulfillment_orders, refunds, refund_lines };
}

/**
 * Per-order refund variance check (PR #R4l-a — reverted to fix2 logic in fix5).
 *
 * fix4 replaced this with a 4-pattern classifier (math_mismatch, manual_edit,
 * refund_discrepancy_only, instant_void). The instant_void heuristic flagged
 * any same-day register return as an anomaly — which is normal retail — and
 * blew the variance list back up to 83. Reverting to the fix2 algorithm gets
 * us back to the known-good 9 exceptions we hadn't yet resolved.
 *
 * fix2 algorithm:
 *   expected =
 *     transactions_refunded != null  → transactions_refunded  (cash truth)
 *     else if no refund rows         → 0                       (no activity)
 *     else                           → total_price − current_total_price  (legacy fallback)
 *   actual   = Σ recon_refunds.total_refunded
 *   variance = expected − actual; flag when |variance| > $0.01.
 *
 * The legitimate divergence between line-value-refunded (P&L) and gateway-cash-refunded
 * still exists — we just don't try to reconcile it per-order. R5 payout reconciliation
 * is where cash-truth lives.
 *
 * Schema notes:
 *   * recon_orders.refund_variance_kind column is preserved from fix4 (in case we
 *     want to attach a tag later) but always set to null here.
 *   * recon_line_items.recognized_at and added_via_exchange_refund_id are written
 *     by transformShopifyOrder regardless — R5 will use them.
 */
export function recomputeRefundVariance(orderId: string): {
  flag: 0 | 1;
  amount: number;
  kind: string | null;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sqlite } = require("./storage");
  const ord = sqlite
    .prepare(
      `SELECT total_price, current_total_price, transactions_refunded, financial_status
       FROM recon_orders WHERE id = ?`
    )
    .get(orderId) as {
      total_price: number | null;
      current_total_price: number | null;
      transactions_refunded: number | null;
      financial_status: string | null;
    } | undefined;
  if (!ord) return { flag: 0, amount: 0, kind: null };

  // Actual: canonical sign-corrected sum from recon_refunds.
  const actual = (sqlite
    .prepare(
      `SELECT COALESCE(SUM(total_refunded), 0) AS total
       FROM recon_refunds
       WHERE order_id = ?`
    )
    .get(orderId) as { total: number }).total;

  // Expected: byte-exact fix2 logic.
  //   transactions_refunded != null → cash truth from top-level transactions[].
  //   otherwise                    → (total_price − current_total_price).
  // Top-level transactions[] is absent in standard /orders.json payloads, so
  // the second path is the live one for nearly every order. This is what
  // produced the known-good 9 exceptions.
  const expected =
    ord.transactions_refunded != null
      ? ord.transactions_refunded
      : (ord.total_price ?? 0) - (ord.current_total_price ?? ord.total_price ?? 0);

  const variance = expected - actual;
  const flag: 0 | 1 = Math.abs(variance) > 0.01 ? 1 : 0;

  // refund_variance_kind preserved as a column but unused by this algorithm.
  // Future PRs may classify the remaining variances; until then leave null.
  setReconOrderRefundVariance(orderId, flag, variance, null);
  return { flag, amount: variance, kind: null };
}


/**
 * Fetch fulfillment_orders for a given order id via the dedicated endpoint.
 * The list /orders.json endpoint does not include this collection even with
 * `fields=...,fulfillment_orders` — confirmed empirically against the 2024-10
 * REST admin API. So during sync we make one extra call per order.
 *
 * For high-volume backfills this WOULD be a problem, but: (a) we only call
 * this on orders we actually want to (re)route, and (b) the regular sync
 * loop already throttles via shopifyRestCall's leaky-bucket helper.
 */
export async function fetchFulfillmentOrdersForOrder(
  cfg: ReturnType<typeof getShopifyReconConfig>,
  orderId: string,
): Promise<any[]> {
  if (!cfg) return [];
  const res = await shopifyRestCall(cfg, `/orders/${orderId}/fulfillment_orders.json`);
  return Array.isArray(res.json?.fulfillment_orders) ? res.json.fulfillment_orders : [];
}

/**
 * Upsert a single order + its line items + its fulfillments + its
 * fulfillment_orders. Used by both webhook handlers and the polling loop.
 * Idempotent — safe to call multiple times for the same order.
 *
 * If the order payload doesn't include `fulfillment_orders` (the common case
 * from the list endpoint), pass `rawFulfillmentOrders` separately — the
 * caller is responsible for fetching them via fetchFulfillmentOrdersForOrder().
 */
export function upsertOrderFromShopify(
  rawOrder: any,
  rawFulfillmentOrders?: any[] | null,
): {
  orderId: string;
  outcome: "inserted" | "updated";
  lineCount: number;
  fulfillmentCount: number;
  fulfillmentOrderCount: number;
} {
  // If the caller supplied FOs separately, splice them into the raw order so
  // the transform sees them uniformly. (Webhooks: never separate. Sync: usually
  // separate.)
  if (Array.isArray(rawFulfillmentOrders) && rawFulfillmentOrders.length > 0) {
    rawOrder = { ...rawOrder, fulfillment_orders: rawFulfillmentOrders };
  }
  const { order, lines, fulfillments, fulfillment_orders, refunds, refund_lines } =
    transformShopifyOrder(rawOrder);
  const outcome = upsertReconOrder(order);
  const lineCount = replaceReconLineItems(order.id, lines);
  const fulfillmentCount = replaceReconFulfillments(order.id, fulfillments);
  const fulfillmentOrderCount = replaceReconFulfillmentOrders(order.id, fulfillment_orders);
  // PR #R4l-a — write refunds + per-order variance check. Refunds wipe first
  // (delete-then-insert in one tx) so re-ingesting an order can never leave
  // orphaned refund rows pointing at deleted refunds.
  replaceReconRefundsForOrder(order.id, refunds, refund_lines);
  recomputeRefundVariance(order.id);
  return { orderId: order.id, outcome, lineCount, fulfillmentCount, fulfillmentOrderCount };
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
          // PR #R4d — hydrate fulfillment_orders via the dedicated endpoint.
          // The list /orders.json response doesn't include them. We swallow
          // errors here (best-effort) — the order itself still ingests so the
          // sync watermark advances; the FO backfill route can fill gaps later.
          let foPayload: any[] | null = null;
          try {
            foPayload = await fetchFulfillmentOrdersForOrder(cfg, String(o.id));
          } catch (e: any) {
            srWarn("orders-ingest", `order ${o?.id} FO fetch failed: ${e?.message ?? e}`);
          }
          const { outcome } = upsertOrderFromShopify(o, foPayload);
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

/**
 * PR #R4c — in-memory progress tracker for the backfill so the UI can poll
 * status while it runs. Keyed by syncLogId. Cleaned up automatically after
 * the job finishes (we leave the final entry for ~5 min so a slow client
 * poll still gets the final tally).
 */
export type FulfillmentBackfillProgress = {
  syncLogId: number;
  state: "running" | "success" | "failure";
  pages: number;
  total_pages_estimate: number | null;
  orders_scanned: number;
  orders_updated: number;
  fulfillments_written: number;
  errors: number;
  startedAt: string;
  finishedAt: string | null;
  error?: string;
  message?: string;
};
const backfillProgress = new Map<number, FulfillmentBackfillProgress>();
export function getBackfillProgress(syncLogId: number): FulfillmentBackfillProgress | null {
  return backfillProgress.get(syncLogId) ?? null;
}
export function listRecentBackfillProgress(): FulfillmentBackfillProgress[] {
  return Array.from(backfillProgress.values()).sort((a, b) => b.syncLogId - a.syncLogId).slice(0, 10);
}
function setBackfillProgress(syncLogId: number, patch: Partial<FulfillmentBackfillProgress>) {
  const prev = backfillProgress.get(syncLogId);
  const merged: FulfillmentBackfillProgress = {
    syncLogId,
    state: "running",
    pages: 0,
    total_pages_estimate: null,
    orders_scanned: 0,
    orders_updated: 0,
    fulfillments_written: 0,
    errors: 0,
    startedAt: prev?.startedAt ?? new Date().toISOString(),
    finishedAt: null,
    ...prev,
    ...patch,
  };
  backfillProgress.set(syncLogId, merged);
  // Evict entries older than 30 minutes to keep the map bounded.
  const cutoff = Date.now() - 30 * 60_000;
  const stale: number[] = [];
  backfillProgress.forEach((v, k) => {
    if (v.finishedAt && Date.parse(v.finishedAt) < cutoff) stale.push(k);
  });
  for (const k of stale) backfillProgress.delete(k);
}

/**
 * PR #R4f — Cancellation. The backfill is a long-running async loop that
 * holds no DB lock, so we can stop it cleanly between pages/orders by
 * checking an in-memory flag. The set is bounded (cleaned up on exit), so
 * leaving stale entries on a server crash is harmless.
 *
 * The flag is set by the cancel route and read at the top of every backfill
 * loop iteration. We don't try to abort an in-flight HTTP call — that's
 * cooperative cancellation at the boundary of "between Shopify calls."
 */
const cancelledSyncLogIds = new Set<number>();

export function requestCancelBackfill(syncLogId: number): boolean {
  // Only meaningful if the run is actually still in our in-memory map and
  // currently marked running — otherwise we'd be setting a flag for a
  // syncLogId that will never check it.
  const p = backfillProgress.get(syncLogId);
  if (!p || p.state !== "running") return false;
  cancelledSyncLogIds.add(syncLogId);
  return true;
}

function isCancelled(syncLogId: number): boolean {
  return cancelledSyncLogIds.has(syncLogId);
}

/**
 * Returns the syncLogIds of every backfill currently in state="running".
 * Used by (a) the cancel-all route, and (b) the POST handler's concurrency
 * guard to reject a second click while a run is already underway.
 */
export function listRunningBackfillIds(): number[] {
  const out: number[] = [];
  backfillProgress.forEach((v, k) => {
    if (v.state === "running") out.push(k);
  });
  return out;
}

/**
 * Returns the currently-running backfill (if any). Used by the progress
 * endpoint so the UI can resume polling after a page refresh without knowing
 * the syncLogId of the run it didn't initiate.
 */
export function getActiveBackfillProgress(): FulfillmentBackfillProgress | null {
  let best: FulfillmentBackfillProgress | null = null;
  backfillProgress.forEach((v) => {
    if (v.state !== "running") return;
    if (!best || v.syncLogId > best.syncLogId) best = v;
  });
  return best;
}

/**
 * PR #R4b/R4c — backfill fulfillments for orders already in the DB.
 *
 * Existing orders ingested before R4b have no rows in recon_order_fulfillments
 * because the transform didn't extract them. This rewrites the fulfillment
 * table only — order/line item rows are NOT touched.
 *
 * R4c rewrite: instead of one /orders/{id}.json request per order (rate-limit
 * heavy: 700+ requests for a month, frequent 429s), we paginate the list
 * endpoint /orders.json?fields=id,fulfillments&created_at_min/max=...&limit=250.
 * Same data, ~3-4 requests per month, no rate limiting issues.
 *
 * We then intersect the returned IDs with what's actually in our local
 * recon_orders table — only orders we know about get fulfillment rows
 * written. If Shopify has orders we haven't synced yet, they're skipped
 * (the regular orders sync will pick them up + their fulfillments).
 */
export async function backfillFulfillments(
  triggeredBy: string,
  opts: { sinceIso: string; untilIso?: string },
): Promise<{
  orders_scanned: number;
  orders_updated: number;
  fulfillments_written: number;
  errors: number;
  pages: number;
  syncLogId: number;
  error?: string;
}> {
  const cfg = getShopifyReconConfig();
  if (!cfg) {
    return {
      orders_scanned: 0, orders_updated: 0, fulfillments_written: 0, errors: 0, pages: 0,
      syncLogId: -1, error: "Shopify reconciler not configured",
    };
  }
  const syncLogId = startReconSync("fulfillments-backfill", triggeredBy, opts.sinceIso);
  setBackfillProgress(syncLogId, { state: "running", message: "Loading local order index…" });

  let pages = 0;
  let scanned = 0;
  let updated = 0;
  let totalFulfillments = 0;
  let errors = 0;

  try {
    // Build a Set of order IDs we have locally in this date range. The list
    // endpoint may return orders we haven't synced yet; we skip those.
    const { sqlite } = await import("./storage");
    const localOrders = sqlite
      .prepare(
        opts.untilIso
          ? `SELECT id FROM recon_orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC`
          : `SELECT id FROM recon_orders WHERE created_at >= ? ORDER BY created_at ASC`
      )
      .all(...(opts.untilIso ? [opts.sinceIso, opts.untilIso] : [opts.sinceIso])) as Array<{ id: string }>;
    const localIds = new Set(localOrders.map((r) => String(r.id)));
    setBackfillProgress(syncLogId, {
      total_pages_estimate: Math.max(1, Math.ceil(localOrders.length / PAGE_LIMIT)),
      message: `Backfilling ${localOrders.length} orders…`,
    });

    let nextUrl: string | null = null;
    let wasCancelled = false;
    do {
      // PR #R4f — between-page cancel check.
      if (isCancelled(syncLogId)) { wasCancelled = true; break; }
      pages++;
      const res = nextUrl
        ? await shopifyRestCall(cfg, nextUrl)
        : await shopifyRestCall(cfg, "/orders.json", {
            query: {
              status: "any",
              limit: PAGE_LIMIT,
              created_at_min: opts.sinceIso,
              ...(opts.untilIso ? { created_at_max: opts.untilIso } : {}),
              fields: "id,fulfillments",
              order: "created_at asc",
            },
          });
      const orders = (res.json?.orders || []) as any[];
      for (const order of orders) {
        // PR #R4f — between-order cancel check (per-order FO fetch is the
        // slowest part of the loop, so checking before each one keeps the
        // halt latency under a second in typical conditions).
        if (isCancelled(syncLogId)) { wasCancelled = true; break; }
        const oid = order?.id != null ? String(order.id) : null;
        if (!oid) continue;
        scanned++;
        // Skip orders we don't have locally yet — regular sync will pick them up.
        if (!localIds.has(oid)) continue;
        try {
          const rawFulfillments = Array.isArray(order.fulfillments) ? order.fulfillments : [];
          const fulfillments: ReconFulfillmentUpsert[] = rawFulfillments.map((f: any) => {
            const lineItemIds = Array.isArray(f.line_items)
              ? f.line_items.map((li: any) => (li?.id != null ? String(li.id) : null)).filter(Boolean)
              : [];
            return {
              id: String(f.id),
              order_id: oid,
              location_id: f.location_id != null ? String(f.location_id) : null,
              status: f.status ?? null,
              shipment_status: f.shipment_status ?? null,
              created_at: f.created_at ?? null,
              updated_at: f.updated_at ?? null,
              tracking_company: f.tracking_company ?? null,
              tracking_number: f.tracking_number ?? null,
              line_item_ids_json: JSON.stringify(lineItemIds),
              raw_json: JSON.stringify(f),
            };
          });
          const written = replaceReconFulfillments(oid, fulfillments);
          totalFulfillments += written;
          if (written > 0) updated++;

          // PR #R4d — also hydrate fulfillment_orders for this order so the
          // allocator can route Locally / unshipped online orders correctly.
          // One extra REST call per order; cheap relative to the per-order
          // pulls #R4c eliminated for shipments themselves.
          try {
            const foPayload = await fetchFulfillmentOrdersForOrder(cfg, oid);
            const fos: ReconFulfillmentOrderUpsert[] = (foPayload || []).map((fo: any) => {
              const lineItemIds = Array.isArray(fo.line_items)
                ? fo.line_items.map((li: any) => (li?.line_item_id != null ? String(li.line_item_id) : null)).filter(Boolean)
                : [];
              return {
                id: String(fo.id),
                order_id: oid,
                assigned_location_id: fo.assigned_location_id != null ? String(fo.assigned_location_id) : null,
                status: fo.status ?? null,
                request_status: fo.request_status ?? null,
                supported_actions_json: fo.supported_actions ? JSON.stringify(fo.supported_actions) : null,
                line_item_ids_json: JSON.stringify(lineItemIds),
                raw_json: JSON.stringify(fo),
              };
            });
            replaceReconFulfillmentOrders(oid, fos);
          } catch (e: any) {
            srWarn("fulfillments-backfill", `order ${oid} FO fetch failed: ${e?.message ?? e}`);
            // Not counted as a fatal error — FO hydration is best-effort.
          }
        } catch (e: any) {
          errors++;
          srWarn("fulfillments-backfill", `order ${oid}: ${e?.message ?? e}`);
        }
      }
      nextUrl = parseNextPageUrl(res.linkHeader);
      setBackfillProgress(syncLogId, {
        pages, orders_scanned: scanned, orders_updated: updated,
        fulfillments_written: totalFulfillments, errors,
      });
      // PR #R4d — cap raised 50 → 200 to enable "Backfill all history" runs.
      // Each page is 250 orders, so 200 pages = 50k orders; at our volume
      // that's well over a year of history. A full reset still terminates.
      if (pages > 200) {
        srWarn("fulfillments-backfill", `stopping at ${pages} pages — narrow the date range or split the run`);
        break;
      }
    } while (nextUrl && !wasCancelled);

    if (wasCancelled) {
      // PR #R4f — user-requested halt. Mark failure with a plain-English
      // reason so the UI surfaces it instead of treating partial counts as
      // a successful (smaller) run. Clean up the flag so the next run on
      // this syncLogId — impossible, but defensive — wouldn't inherit it.
      cancelledSyncLogIds.delete(syncLogId);
      finishReconSync(syncLogId, {
        status: "failure",
        rows_ingested: totalFulfillments,
        error_message: "Cancelled by user",
      });
      setBackfillProgress(syncLogId, {
        state: "failure",
        pages, orders_scanned: scanned, orders_updated: updated,
        fulfillments_written: totalFulfillments, errors,
        finishedAt: new Date().toISOString(),
        error: "Cancelled by user",
        message: "Cancelled by user",
      });
      return {
        orders_scanned: scanned, orders_updated: updated,
        fulfillments_written: totalFulfillments, errors, pages, syncLogId,
        error: "Cancelled by user",
      };
    }

    finishReconSync(syncLogId, {
      status: errors > scanned / 2 ? "failure" : "success",
      rows_ingested: totalFulfillments,
      cursor: opts.untilIso ?? opts.sinceIso,
    });
    setBackfillProgress(syncLogId, {
      state: errors > scanned / 2 ? "failure" : "success",
      pages, orders_scanned: scanned, orders_updated: updated,
      fulfillments_written: totalFulfillments, errors,
      finishedAt: new Date().toISOString(),
      message: "Done",
    });
    return { orders_scanned: scanned, orders_updated: updated, fulfillments_written: totalFulfillments, errors, pages, syncLogId };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    srError("fulfillments-backfill", `backfill failed: ${msg}`);
    setBackfillProgress(syncLogId, {
      state: "failure", error: msg, finishedAt: new Date().toISOString(),
      pages, orders_scanned: scanned, orders_updated: updated,
      fulfillments_written: totalFulfillments, errors,
    });
    finishReconSync(syncLogId, {
      status: "failure", rows_ingested: totalFulfillments, error_message: msg,
    });
    return { orders_scanned: scanned, orders_updated: updated, fulfillments_written: totalFulfillments, errors, pages, syncLogId, error: msg };
  } finally {
    // PR #R4f — always drop the cancel flag on exit, even on the happy path
    // or thrown error path. Keeps the set from leaking entries for runs that
    // weren't actually cancelled.
    cancelledSyncLogIds.delete(syncLogId);
  }
}

// ============================================================================
// PR #R4l-a — Refunds backfill from raw_json.
// ----------------------------------------------------------------------------
// We already store the full Shopify order payload in recon_orders.raw_json, so
// backfilling refunds for every historical order is a pure local operation —
// NO Shopify API calls needed. This re-parses raw_json for every order in the
// given date range, runs transformShopifyOrder against it, and writes the
// refunds[] / refund_line_items[] tables (plus updates current_* columns and
// total_refunded on the order row, plus the variance flag).
//
// Why a local backfill vs. re-pulling from Shopify:
//   1. Free — no rate-limit pressure, no 429 risk.
//   2. Deterministic — we backfill exactly what was ingested at the time, no
//      drift if Shopify edits a historical refund (which they can).
//   3. Fast — 50ms per order vs. ~300ms for an API round-trip; the entire
//      year's history backfills in ~30 seconds vs. several hours.
//
// If a row's raw_json is empty/null (shouldn't happen, but guards against it)
// the order is skipped and counted as a soft error.
// ============================================================================

export type RefundsBackfillResult = {
  orders_scanned: number;
  orders_updated: number;
  refunds_written: number;
  refund_lines_written: number;
  variance_flags_set: number;
  errors: number;
  error?: string;
  syncLogId: number;
};

export async function backfillRefundsFromRawJson(
  triggeredBy: string,
  opts: { sinceIso: string; untilIso?: string },
): Promise<RefundsBackfillResult> {
  const syncLogId = startReconSync("refunds-backfill", triggeredBy, opts.sinceIso);
  let scanned = 0;
  let updated = 0;
  let refundsWritten = 0;
  let linesWritten = 0;
  let varianceFlags = 0;
  let errors = 0;

  try {
    const { sqlite } = await import("./storage");
    const rows = sqlite
      .prepare(
        opts.untilIso
          ? `SELECT id, raw_json FROM recon_orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC`
          : `SELECT id, raw_json FROM recon_orders WHERE created_at >= ? ORDER BY created_at ASC`
      )
      .all(...(opts.untilIso ? [opts.sinceIso, opts.untilIso] : [opts.sinceIso])) as Array<{ id: string; raw_json: string | null }>;

    for (const row of rows) {
      scanned++;
      if (!row.raw_json) {
        errors++;
        srWarn("refunds-backfill", `order ${row.id}: raw_json is null, skipping`);
        continue;
      }
      try {
        const o = JSON.parse(row.raw_json);
        const { order, refunds, refund_lines } = transformShopifyOrder(o);
        // Re-upsert the order so current_* / total_refunded columns get populated
        // on pre-R4l rows that have NULL/0 for them.
        upsertReconOrder(order);
        replaceReconRefundsForOrder(order.id, refunds, refund_lines);
        const vr = recomputeRefundVariance(order.id);
        refundsWritten += refunds.length;
        linesWritten += refund_lines.length;
        if (refunds.length > 0) updated++;
        if (vr.flag === 1) varianceFlags++;
      } catch (e: any) {
        errors++;
        srWarn("refunds-backfill", `order ${row.id}: ${e?.message ?? e}`);
      }
    }

    finishReconSync(syncLogId, {
      status: errors > scanned / 2 ? "failure" : "success",
      rows_ingested: refundsWritten,
      cursor: opts.untilIso ?? opts.sinceIso,
    });
    return {
      orders_scanned: scanned,
      orders_updated: updated,
      refunds_written: refundsWritten,
      refund_lines_written: linesWritten,
      variance_flags_set: varianceFlags,
      errors,
      syncLogId,
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    srError("refunds-backfill", `backfill failed: ${msg}`);
    finishReconSync(syncLogId, {
      status: "failure",
      rows_ingested: refundsWritten,
      error_message: msg,
    });
    return {
      orders_scanned: scanned,
      orders_updated: updated,
      refunds_written: refundsWritten,
      refund_lines_written: linesWritten,
      variance_flags_set: varianceFlags,
      errors,
      syncLogId,
      error: msg,
    };
  }
}

// ============================================================================
// PR #R4l-a-fix — Re-pull stale refund data from Shopify.
// ----------------------------------------------------------------------------
// Some orders in the variance list have current_total_price < total_price
// (Shopify says cash was refunded) but our refunds[] array is empty. Root
// cause: webhook missed the refund event, or the order was ingested before
// the refund existed and was never re-synced because Shopify didn't bump
// updated_at when the refund posted (yes, Shopify has this bug).
//
// Fix: query for variance-flagged orders with NO refund rows, re-fetch each
// from Shopify's /orders/{id}.json (the FULL payload, which always includes
// the current refunds[] array), and re-ingest. This is the ONLY path in the
// reconciler that makes Shopify API calls during variance recovery, so we
// cap it at 100 orders per run to stay well under the leaky-bucket budget.
// ============================================================================

export type StaleRefundsRepullResult = {
  candidates_found: number;
  re_pulled: number;
  refunds_added: number;
  variances_cleared: number;
  errors: number;
  error?: string;
  syncLogId: number;
};

export async function repullStaleRefunds(
  triggeredBy: string,
  opts: { limit?: number } = {},
): Promise<StaleRefundsRepullResult> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const syncLogId = startReconSync("refunds-repull", triggeredBy, new Date().toISOString());
  let candidates = 0;
  let rePulled = 0;
  let refundsAdded = 0;
  let variancesCleared = 0;
  let errors = 0;

  try {
    const cfg = getShopifyReconConfig();
    if (!cfg) throw new Error("Shopify reconciler not configured");
    const { sqlite } = await import("./storage");

    // Candidates: orders flagged as variance exceptions OR with no refund rows
    // despite a current_total_price < total_price gap, OR with financial_status
    // in ('refunded','partially_refunded') and no refund rows. We union all
    // three cases so we catch every stale-refund pattern in one pass.
    const rows = sqlite
      .prepare(`
        SELECT o.id
        FROM recon_orders o
        LEFT JOIN (
          SELECT order_id, COUNT(*) AS n FROM recon_refunds GROUP BY order_id
        ) rc ON rc.order_id = o.id
        WHERE (
          o.refund_variance_flag = 1
          OR (o.financial_status IN ('refunded','partially_refunded') AND COALESCE(rc.n, 0) = 0)
          OR ((COALESCE(o.current_total_price, o.total_price) < o.total_price - 0.01) AND COALESCE(rc.n, 0) = 0)
        )
        ORDER BY o.created_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<{ id: string }>;

    candidates = rows.length;

    for (const row of rows) {
      try {
        // Per-order Shopify fetch — returns the canonical payload including
        // refunds[] + order_adjustments[]. ~300ms per call; leaky-bucket
        // in shopifyRestCall keeps us under the rate limit.
        const res = await shopifyRestCall(cfg, `/orders/${row.id}.json`);
        const o = res.json?.order;
        if (!o) {
          errors++;
          srWarn("refunds-repull", `order ${row.id}: Shopify returned no order body`);
          continue;
        }
        // Hydrate FOs too while we're here — fresh data is fresh data.
        let foPayload: any[] | null = null;
        try {
          foPayload = await fetchFulfillmentOrdersForOrder(cfg, String(o.id));
        } catch (e: any) {
          srWarn("refunds-repull", `order ${o?.id} FO fetch failed: ${e?.message ?? e}`);
        }
        const beforeRefunds = (sqlite
          .prepare(`SELECT COUNT(*) AS n FROM recon_refunds WHERE order_id = ?`)
          .get(row.id) as { n: number }).n;
        const beforeVariance = (sqlite
          .prepare(`SELECT refund_variance_flag AS f FROM recon_orders WHERE id = ?`)
          .get(row.id) as { f: number | null })?.f ?? 0;
        upsertOrderFromShopify(o, foPayload);
        const afterRefunds = (sqlite
          .prepare(`SELECT COUNT(*) AS n FROM recon_refunds WHERE order_id = ?`)
          .get(row.id) as { n: number }).n;
        const afterVariance = (sqlite
          .prepare(`SELECT refund_variance_flag AS f FROM recon_orders WHERE id = ?`)
          .get(row.id) as { f: number | null })?.f ?? 0;
        rePulled++;
        refundsAdded += Math.max(0, afterRefunds - beforeRefunds);
        if (beforeVariance === 1 && afterVariance === 0) variancesCleared++;
      } catch (e: any) {
        errors++;
        srWarn("refunds-repull", `order ${row.id}: ${e?.message ?? e}`);
      }
    }

    finishReconSync(syncLogId, {
      status: errors > candidates / 2 ? "failure" : "success",
      rows_ingested: rePulled,
      cursor: new Date().toISOString(),
    });
    return {
      candidates_found: candidates,
      re_pulled: rePulled,
      refunds_added: refundsAdded,
      variances_cleared: variancesCleared,
      errors,
      syncLogId,
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    srError("refunds-repull", `re-pull failed: ${msg}`);
    finishReconSync(syncLogId, {
      status: "failure",
      rows_ingested: rePulled,
      error_message: msg,
    });
    return {
      candidates_found: candidates,
      re_pulled: rePulled,
      refunds_added: refundsAdded,
      variances_cleared: variancesCleared,
      errors,
      syncLogId,
      error: msg,
    };
  }
}
