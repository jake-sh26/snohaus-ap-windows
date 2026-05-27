/**
 * PR #R4 — Shopify reconciler allocation engine.
 *
 * Decides which entity owns each dollar of every Shopify order, then writes
 * one row per (order, line_item, entity) into recon_allocations. Idempotent:
 * re-running the same month replaces only that month's allocations.
 *
 * Allocation methods (stored in `method` column):
 *   - "pos_location"          POS order → entity via entity_pos_locations.shopify_location_id
 *   - "fulfillment_location"  Online physical → entity by fulfillment location_id
 *   - "warehouse_rollup"      Location maps to a warehouse → rolls up to SD
 *   - "zip_lookup"            Digital GC → zip_to_entity_lookup
 *   - "prior_year_pro_rata"   Digital GC fallback → recon_prior_year_pro_rata
 *   - "manual_override"       User overrode via UI
 *   - "needs_review"          Couldn't allocate confidently
 *
 * Notes on the JE-pattern this feeds (PR #R5):
 *   - One allocation row per (order, line_item, entity). Multi-entity orders
 *     (e.g. a gift-card redemption where the GC was issued by Hempstead but
 *     redeemed at Greenvale) produce multiple rows that share an order_id.
 *   - We DO NOT decide here whether tax/shipping rolls up to SD or stays at
 *     the entity. The reconciler aggregator (PR #R5) will use the per-line
 *     gross_amount + tax_amount + the entity's COA mapping to emit JEs.
 *   - Warehouses (Amityville/Syosset) never sell direct-to-consumer, so any
 *     online order that lands there is rolled up to SD with method
 *     "warehouse_rollup" (still confident — they're SD's warehouses).
 */

import { sqlite, listPayrollEntities } from "./storage";
import { assignGcIssuance, recordPosGcIssuance } from "./shopify-recon-gc-issuance";
import { processOrderForGCRedemption } from "./shopify-recon-gc-redemption";

// ----- types -----

export type AllocationMethod =
  | "pos_location"
  | "fulfillment_location"
  | "warehouse_rollup"
  | "zip_lookup"
  | "prior_year_pro_rata"
  | "manual_override"
  | "needs_review";

export type AllocationRow = {
  order_id: string;
  line_item_id: string | null;
  entity_id: number;
  share: number;
  gross_amount: number;
  tax_amount: number;
  method: AllocationMethod;
  reason: string | null;
  auto_method: AllocationMethod;
  auto_entity_id: number | null;
};

export type AllocationRunSummary = {
  month: string; // YYYY-MM
  orders_processed: number;
  line_items_processed: number;
  allocations_written: number;
  by_method: Record<AllocationMethod, number>;
  needs_review_orders: number;
  failed_orders: number;
  // PR #R4e — redemption / JE counters from the post-allocation pass.
  // Populated after the main transaction commits; zero on cancelled-only
  // months or when no orders carried gift_card transactions.
  gc_redemptions_recorded: number;
  gc_je_legs_emitted: number;
  warnings: string[];
  ran_at: string;
  // PR #136 — per-phase timing. Used to find the real bottleneck after two
  // perf PRs (#134 indexes, #135 GC-shortcircuit) missed. All values in ms.
  // total_ms is the wall-clock end-to-end runAllocationEngine duration.
  // The phase fields sum to ~total_ms (small overhead for orchestration).
  // Inside txn_total_ms we also track per-statement aggregates so we can
  // see if it's the SELECTs (linesStmt/overridesStmt/fulfillments/FOs),
  // the in-memory allocateLineItem, the row INSERTs, or the GC-issuance
  // side-writes (assignGcIssuance/recordPosGcIssuance) that eats the time.
  timing_ms: {
    total_ms: number;
    fetch_orders_ms: number;
    delete_existing_ms: number;
    txn_total_ms: number;
    lines_query_ms: number;
    overrides_query_ms: number;
    fulfillments_query_ms: number;
    fulfillment_orders_query_ms: number;
    allocate_line_ms: number;
    insert_alloc_ms: number;
    gc_redemption_pass_ms: number;
  };
};

type OrderRow = {
  id: string;
  created_at: string;
  source_name: string | null;
  location_id: string | null;
  customer_id: string | null;
  customer_email: string | null;  // PR #123 — enables email_affinity fallback for guest checkouts
  shipping_zip: string | null;
  billing_zip: string | null;
  has_gift_card: number;
  cancelled_at: string | null;
  subtotal: number | null;
  total_tax: number | null;
  total_shipping: number | null;
  total_discounts: number | null;
  total_price: number | null;
};

type LineItemRow = {
  id: string;
  order_id: string;
  sku: string | null;
  title: string | null;
  quantity: number;
  price: number | null;
  total_discount: number | null;
  line_subtotal: number | null;
  line_tax_total: number | null;
  is_gift_card: number;
  requires_shipping: number;
};

// ----- helpers -----

function buildLocationToEntityMap(): Map<string, { entity_id: number; kind: string }> {
  const rows = sqlite
    .prepare(
      `SELECT shopify_location_id, entity_id, kind, active
       FROM recon_entity_pos_locations
       WHERE active = 1 AND shopify_location_id IS NOT NULL`
    )
    .all() as Array<{ shopify_location_id: string; entity_id: number; kind: string }>;
  const m = new Map<string, { entity_id: number; kind: string }>();
  for (const r of rows) m.set(r.shopify_location_id, { entity_id: r.entity_id, kind: r.kind });
  return m;
}

function getSdEntityId(): number | null {
  // SD = Greenvale. Identified by location keyword.
  const entities = listPayrollEntities();
  const sd = entities.find(e => (e.location || "").toLowerCase().includes("greenvale"));
  return sd?.id ?? null;
}

// PR #R4d — `lookupZip` (recon_zip_to_entity_lookup) and `getProRataShares`
// (recon_prior_year_pro_rata) used to back the digital-GC cascade. They were
// superseded by shopify-recon-gc-issuance.ts (customer_affinity → zip_radius
// → fallback_sd). The underlying tables are intentionally left in place —
// they still feed the readiness check and can be re-attached in PR #R5 if
// the issuance cascade ever needs a hybrid mode.

// PR #R4b — fulfillment lookup. Returns ALL successful fulfillments for an
// order, with the line item ids each fulfillment shipped. Used by allocator
// to route online-physical sales to the right entity (the order's top-level
// location_id is null for online sales).
type FulfillmentRow = {
  id: string;
  location_id: string | null;
  status: string | null;
  line_item_ids: string[];
};

// PR #134 — cache prepared statements so we don't recompile SQL per order.
// Lazy init lets the schema run() bootstrap before the first prepare().
let _fulfillmentsStmt: ReturnType<typeof sqlite.prepare> | null = null;
let _fulfillmentOrdersStmt: ReturnType<typeof sqlite.prepare> | null = null;
// PR #137 — PR #136 instrumentation revealed listSuccessfulFulfillments was
// 99.4% of allocator runtime (2511ms / 2525ms total in Aug 2025 with only 36
// orders = ~70ms per call). Two changes:
//
//   1. Drop the SQL ORDER BY (created_at IS NULL), created_at ASC, id ASC.
//      That expression-based sort can't be satisfied from the index, so even
//      with idx_recon_fulfillments_order sqlite was building a temp sort tree
//      per call. Findings are 0-2 rows in 99% of cases, so we sort in JS
//      after parsing instead. Chronological semantics preserved — same key
//      (created_at nulls last, then created_at ASC, id ASC tiebreak).
//
//   2. Inline-filter status='success' rather than relying on the index. The
//      existing idx_recon_fulfillments_order covers order_id only — sqlite
//      still has to read each matched row to check status. Pulling status
//      into the SELECT and filtering in JS is equivalent and lets sqlite use
//      the pure index lookup with no extra predicate work.
function listSuccessfulFulfillments(orderId: string): FulfillmentRow[] {
  if (!_fulfillmentsStmt) {
    _fulfillmentsStmt = sqlite.prepare(
      `SELECT id, location_id, status, created_at, line_item_ids_json
       FROM recon_order_fulfillments
       WHERE order_id = ?`
    );
  }
  const rows = _fulfillmentsStmt
    .all(orderId) as Array<{
      id: string;
      location_id: string | null;
      status: string | null;
      created_at: string | null;
      line_item_ids_json: string | null;
    }>;
  // Filter to status='success' AND sort chronologically in JS. Findings are
  // small (0-3 rows in 99% of cases) so this is fast.
  const successful = rows.filter(r => r.status === "success");
  successful.sort((a, b) => {
    const aNull = a.created_at == null;
    const bNull = b.created_at == null;
    if (aNull !== bNull) return aNull ? 1 : -1;        // nulls LAST
    if (a.created_at !== b.created_at) {
      return (a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1; // ASC
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;     // tiebreak id ASC
  });
  return successful.map(r => ({
    id: r.id,
    location_id: r.location_id,
    status: r.status,
    line_item_ids: (() => {
      if (!r.line_item_ids_json) return [];
      try {
        const parsed = JSON.parse(r.line_item_ids_json);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch { return []; }
    })(),
  }));
}

// Returns the *successful* fulfillment that shipped a given line item, if
// exactly one exists. If a line item appears on multiple fulfillments (rare
// — e.g. partial cancellation + reship), prefer the most recent. Returns
// null if none.
function findFulfillmentForLine(
  fulfillments: FulfillmentRow[],
  lineItemId: string,
): FulfillmentRow | null {
  const matches = fulfillments.filter(f => f.line_item_ids.includes(lineItemId));
  if (matches.length === 0) return null;
  // Last in chronological order (we sorted ASC) wins — represents the most
  // recent successful ship of this line.
  return matches[matches.length - 1];
}

// PR #R4d — fulfillment_order lookup. Distinct from fulfillments[]: a FO is
// the routed *intent* (created at order time), whereas fulfillments[] only
// appears once the merchant ships. For Locally orders and unshipped online
// orders, the FO's assigned_location_id is the only routing signal we have.
type FulfillmentOrderRow = {
  id: string;
  assigned_location_id: string | null;
  status: string | null;
  line_item_ids: string[];
};

function listFulfillmentOrders(orderId: string): FulfillmentOrderRow[] {
  // We accept open|in_progress|scheduled FOs as routing signals. Cancelled
  // / incomplete / closed-without-ship leave the assigned_location_id behind
  // but it no longer represents intent, so we skip them.
  if (!_fulfillmentOrdersStmt) {
    _fulfillmentOrdersStmt = sqlite.prepare(
      `SELECT id, assigned_location_id, status, line_item_ids_json
       FROM recon_fulfillment_orders
       WHERE order_id = ?
         AND status IN ('open', 'in_progress', 'scheduled', 'closed')
       ORDER BY (status = 'closed'), id ASC`
    );
  }
  const rows = _fulfillmentOrdersStmt
    .all(orderId) as Array<{
      id: string;
      assigned_location_id: string | null;
      status: string | null;
      line_item_ids_json: string | null;
    }>;
  return rows.map(r => ({
    id: r.id,
    assigned_location_id: r.assigned_location_id,
    status: r.status,
    line_item_ids: (() => {
      if (!r.line_item_ids_json) return [];
      try {
        const parsed = JSON.parse(r.line_item_ids_json);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch { return []; }
    })(),
  }));
}

// Find the fulfillment_order assigned to ship a given line item. The FO graph
// guarantees each line belongs to exactly one open FO at a time, so the first
// match wins. If we ever see split FOs the ORDER BY in listFulfillmentOrders
// puts open/in_progress before closed.
function findFulfillmentOrderForLine(
  fulfillmentOrders: FulfillmentOrderRow[],
  lineItemId: string,
): FulfillmentOrderRow | null {
  for (const fo of fulfillmentOrders) {
    if (fo.line_item_ids.includes(lineItemId)) return fo;
  }
  return null;
}

// Allocate a single line item. Returns one or more AllocationRow slices.
function allocateLineItem(
  order: OrderRow,
  line: LineItemRow,
  ctx: {
    locationMap: Map<string, { entity_id: number; kind: string }>;
    sdEntityId: number | null;
    fulfillments: FulfillmentRow[];
    fulfillmentOrders: FulfillmentOrderRow[];
  },
): AllocationRow[] {
  const gross =
    line.line_subtotal != null
      ? line.line_subtotal
      : (line.price ?? 0) * (line.quantity ?? 0) - (line.total_discount ?? 0);
  const tax = line.line_tax_total ?? 0;

  // PR #R4d — pos_location requires BOTH source_name === 'pos' AND a mapped
  // POS location. Pre-#R4d we treated any non-null order.location_id as POS
  // if the location mapped to a POS entity. That broke for Locally orders,
  // which inject their own pseudo-location id (e.g. 123711225857) onto the
  // order but are NOT actually POS sales. Without the source filter the
  // allocator would either map the fake id to needs_review (best case) or
  // pick the wrong entity (worst case). Now Locally orders fall through
  // into the fulfillment_orders / fulfillments cascade below, which uses
  // the *real* routed store.
  if ((order.source_name || "").toLowerCase() === "pos" && order.location_id) {
    const hit = ctx.locationMap.get(order.location_id);
    if (hit) {
      const method: AllocationMethod = hit.kind === "warehouse" ? "warehouse_rollup" : "pos_location";
      // PR #123 — POS gift card identity. If this line is a gift card, also
      // persist a recon_gift_card_issuance row so cross-store redemptions of
      // this card later can find the issuer entity. The allocator row itself
      // is unchanged — the issuance row is a parallel ledger.
      if (line.is_gift_card === 1) {
        recordPosGcIssuance({
          order_id: order.id,
          line_item_id: line.id,
          face_value: gross,
          assigned_entity_id: hit.entity_id,
          customer_id: order.customer_id,
          billing_zip: order.billing_zip,
          shipping_zip: order.shipping_zip,
          order_created_at: order.created_at,
        });
      }
      return [{
        order_id: order.id,
        line_item_id: line.id,
        entity_id: hit.entity_id,
        share: 1,
        gross_amount: gross,
        tax_amount: tax,
        method,
        reason: `POS @ location ${order.location_id} → ${hit.kind}`,
        auto_method: method,
        auto_entity_id: hit.entity_id,
      }];
    }
    return [{
      order_id: order.id,
      line_item_id: line.id,
      entity_id: ctx.sdEntityId ?? 0,
      share: 1,
      gross_amount: gross,
      tax_amount: tax,
      method: "needs_review",
      reason: `POS @ unmapped location ${order.location_id}`,
      auto_method: "needs_review",
      auto_entity_id: null,
    }];
  }

  // PR #R4d — Digital gift cards: replace the old zip_lookup/pro_rata cascade
  // with the issuance cascade (customer_affinity → zip_radius → fallback_sd).
  // The issuance ledger persists the assignment so it can't flip on re-runs;
  // the allocator just mirrors the chosen entity into recon_allocations so
  // the same per-entity rollups continue to work downstream.
  if (line.is_gift_card === 1 && line.requires_shipping === 0) {
    const issuance = assignGcIssuance({
      order_id: order.id,
      line_item_id: line.id,
      face_value: gross,
      customer_id: order.customer_id,
      customer_email: order.customer_email, // PR #123 — enables email_affinity fallback
      billing_zip: order.billing_zip,
      shipping_zip: order.shipping_zip,
      order_created_at: order.created_at,
    });
    // Translate the issuance method into an AllocationMethod. Keep the
    // existing "zip_lookup" / "prior_year_pro_rata" enum surface alive for
    // back-compat — newer methods reuse them with the issuance method
    // captured in `reason` for debuggability.
    let method: AllocationMethod;
    if (issuance.assignment_method === "customer_affinity") {
      // Customer affinity behaves like a fulfillment_location pick (we know
      // exactly which entity, with high confidence). No existing enum is a
      // perfect fit — reuse zip_lookup since it's the legacy GC-routed bucket.
      method = "zip_lookup";
    } else if (issuance.assignment_method === "zip_radius") {
      method = "zip_lookup";
    } else {
      // fallback_sd reuses the prior_year_pro_rata bucket so existing
      // dashboards distinguish "explicitly routed" from "catch-all."
      method = "prior_year_pro_rata";
    }
    if (issuance.assigned_entity_id === 0) {
      // Cascade couldn't resolve an entity (no SD configured) — flag.
      return [{
        order_id: order.id,
        line_item_id: line.id,
        entity_id: ctx.sdEntityId ?? 0,
        share: 1,
        gross_amount: gross,
        tax_amount: tax,
        method: "needs_review",
        reason: `GC issuance failed: ${issuance.reason}`,
        auto_method: "needs_review",
        auto_entity_id: null,
      }];
    }
    return [{
      order_id: order.id,
      line_item_id: line.id,
      entity_id: issuance.assigned_entity_id,
      share: 1,
      gross_amount: gross,
      tax_amount: tax,
      method,
      reason: issuance.reason,
      auto_method: method,
      auto_entity_id: issuance.assigned_entity_id,
    }];
  }

  // ------------------------------------------------------------------
  // Online physical order. PR #R4d priority cascade:
  //   (a) Order-level location_id is non-null AND maps to a POS entity.
  //       Tight constraint: a non-POS order with a non-null location_id is
  //       usually a third-party app artefact (e.g. Locally) and the field
  //       should NOT win here. Only "real" POS-kind locations bypass the
  //       fulfillment cascade.
  //   (b) Line item is on a successful fulfillment — use that fulfillment's
  //       ship-from location_id. Most reliable signal once the order ships.
  //   (c) [PR #R4d] Line item is on an open/in_progress fulfillment_order —
  //       use its assigned_location_id. This is the routing intent at order
  //       time; it exists BEFORE the first ship event and is the only signal
  //       we have for unshipped online orders and for Locally orders.
  //   (d) Nothing matches → needs_review.
  // ------------------------------------------------------------------

  // (a) Direct order-level location_id, only if it maps to a POS entity.
  if (order.location_id) {
    const hit = ctx.locationMap.get(order.location_id);
    if (hit && hit.kind === "pos") {
      // POS-mapped location on a non-POS order is unusual but legitimate
      // (e.g. Shop Pay express checkout from inside a store). Treat as
      // fulfillment_location since source_name !== 'pos'.
      return [{
        order_id: order.id,
        line_item_id: line.id,
        entity_id: hit.entity_id,
        share: 1,
        gross_amount: gross,
        tax_amount: tax,
        method: "fulfillment_location",
        reason: `Online @ order location ${order.location_id} → pos entity (direct route)`,
        auto_method: "fulfillment_location",
        auto_entity_id: hit.entity_id,
      }];
    }
    // If the location_id is set but kind != 'pos' (warehouse, fulfillment,
    // inactive, unmapped — e.g. Locally's 123711225857), DON'T trust it.
    // Fall through to fulfillment[] / fulfillment_orders[] below.
  }

  // (b) Look up the fulfillment that shipped this line.
  const fulfillment = findFulfillmentForLine(ctx.fulfillments, line.id);
  if (fulfillment && fulfillment.location_id) {
    const hit = ctx.locationMap.get(fulfillment.location_id);
    if (hit) {
      const method: AllocationMethod = hit.kind === "warehouse" ? "warehouse_rollup" : "fulfillment_location";
      return [{
        order_id: order.id,
        line_item_id: line.id,
        entity_id: hit.entity_id,
        share: 1,
        gross_amount: gross,
        tax_amount: tax,
        method,
        reason: `Online → fulfillment ${fulfillment.id} @ location ${fulfillment.location_id} (${hit.kind})`,
        auto_method: method,
        auto_entity_id: hit.entity_id,
      }];
    }
    // Shipped from an unmapped location — flag for review.
    return [{
      order_id: order.id,
      line_item_id: line.id,
      entity_id: ctx.sdEntityId ?? 0,
      share: 1,
      gross_amount: gross,
      tax_amount: tax,
      method: "needs_review",
      reason: `Online → fulfillment @ unmapped location ${fulfillment.location_id}`,
      auto_method: "needs_review",
      auto_entity_id: null,
    }];
  }

  // (c) PR #R4d — Fulfillment_order routing. The FO is created at order
  // placement, before any ship event, with assigned_location_id pointing at
  // the routed store. This is what catches Locally orders and unshipped
  // online orders that would otherwise fall to needs_review.
  const fo = findFulfillmentOrderForLine(ctx.fulfillmentOrders, line.id);
  if (fo && fo.assigned_location_id) {
    const hit = ctx.locationMap.get(fo.assigned_location_id);
    if (hit) {
      const method: AllocationMethod = hit.kind === "warehouse" ? "warehouse_rollup" : "fulfillment_location";
      return [{
        order_id: order.id,
        line_item_id: line.id,
        entity_id: hit.entity_id,
        share: 1,
        gross_amount: gross,
        tax_amount: tax,
        method,
        reason: `Online → fulfillment_order ${fo.id} @ assigned_location_id ${fo.assigned_location_id} (${hit.kind}) [status=${fo.status ?? "?"}] via fulfillment_order assigned_location_id`,
        auto_method: method,
        auto_entity_id: hit.entity_id,
      }];
    }
    // FO points at an unmapped location — flag.
    return [{
      order_id: order.id,
      line_item_id: line.id,
      entity_id: ctx.sdEntityId ?? 0,
      share: 1,
      gross_amount: gross,
      tax_amount: tax,
      method: "needs_review",
      reason: `Online → fulfillment_order @ unmapped assigned_location_id ${fo.assigned_location_id}`,
      auto_method: "needs_review",
      auto_entity_id: null,
    }];
  }

  // (d) No order-level POS location, no successful fulfillment, no FO with
  // an assigned location. Per spec: leave as needs_review until something
  // fires. Examples: pending online order with no FO yet (rare), or a draft
  // order that was never routed.
  const reason =
    ctx.fulfillments.length === 0 && ctx.fulfillmentOrders.length === 0
      ? `Online order not yet routed (no fulfillment + no fulfillment_order) — review after order processed`
      : ctx.fulfillments.length === 0
        ? `Online order has fulfillment_orders, but none route line ${line.id}`
        : `Online order has fulfillments, but none ship line ${line.id} yet`;
  return [{
    order_id: order.id,
    line_item_id: line.id,
    entity_id: ctx.sdEntityId ?? 0,
    share: 1,
    gross_amount: gross,
    tax_amount: tax,
    method: "needs_review",
    reason,
    auto_method: "needs_review",
    auto_entity_id: null,
  }];
}

// ----- public API -----

/**
 * Run the allocation engine for one month (YYYY-MM). Idempotent: deletes
 * previous *auto* allocations for the month and rewrites. Manual overrides
 * (method='manual_override') are preserved.
 */
export function runAllocationEngine(month: string): AllocationRunSummary {
  // PR #136 — instrumentation. All Date.now() checkpoints accumulate into
  // these locals and get folded into summary.timing_ms at the end.
  const t_start = Date.now();
  let t_fetch_orders = 0;
  let t_delete_existing = 0;
  let t_txn_total = 0;
  let t_lines_query = 0;
  let t_overrides_query = 0;
  let t_fulfillments_query = 0;
  let t_fulfillment_orders_query = 0;
  let t_allocate_line = 0;
  let t_insert_alloc = 0;
  let t_gc_redemption_pass = 0;

  const summary: AllocationRunSummary = {
    month,
    orders_processed: 0,
    line_items_processed: 0,
    allocations_written: 0,
    by_method: {
      pos_location: 0,
      fulfillment_location: 0,
      warehouse_rollup: 0,
      zip_lookup: 0,
      prior_year_pro_rata: 0,
      manual_override: 0,
      needs_review: 0,
    },
    needs_review_orders: 0,
    failed_orders: 0,
    gc_redemptions_recorded: 0,
    gc_je_legs_emitted: 0,
    warnings: [],
    ran_at: new Date().toISOString(),
    timing_ms: {
      total_ms: 0,
      fetch_orders_ms: 0,
      delete_existing_ms: 0,
      txn_total_ms: 0,
      lines_query_ms: 0,
      overrides_query_ms: 0,
      fulfillments_query_ms: 0,
      fulfillment_orders_query_ms: 0,
      allocate_line_ms: 0,
      insert_alloc_ms: 0,
      gc_redemption_pass_ms: 0,
    },
  };

  const monthStart = `${month}-01T00:00:00Z`;
  const [y, m] = month.split("-").map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01-01T00:00:00Z` : `${y}-${String(m + 1).padStart(2, "0")}-01T00:00:00Z`;

  const t0_fetch = Date.now();
  const orders = sqlite
    .prepare(
      `SELECT id, created_at, source_name, location_id, customer_id, customer_email,
              shipping_zip, billing_zip, has_gift_card, cancelled_at, subtotal,
              total_tax, total_shipping, total_discounts, total_price
       FROM recon_orders
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`
    )
    .all(monthStart, nextMonth) as OrderRow[];
  t_fetch_orders = Date.now() - t0_fetch;

  if (orders.length === 0) {
    summary.warnings.push(`No orders found for ${month}`);
    summary.timing_ms.total_ms = Date.now() - t_start;
    summary.timing_ms.fetch_orders_ms = t_fetch_orders;
    return summary;
  }

  const ctx = {
    locationMap: buildLocationToEntityMap(),
    sdEntityId: getSdEntityId(),
  };
  if (!ctx.sdEntityId) {
    summary.warnings.push("SD/Greenvale entity not found — needs_review fallbacks will use entity_id=0");
  }

  const now = new Date().toISOString();
  const txn = sqlite.transaction(() => {
    // Preserve manual overrides — delete only auto allocations for these orders.
    const orderIds = orders.map(o => o.id);
    if (orderIds.length > 0) {
      const t0_del = Date.now();
      const placeholders = orderIds.map(() => "?").join(",");
      sqlite
        .prepare(
          `DELETE FROM recon_allocations
           WHERE order_id IN (${placeholders})
             AND method != 'manual_override'`
        )
        .run(...orderIds);
      t_delete_existing = Date.now() - t0_del;
    }

    const insertStmt = sqlite.prepare(`
      INSERT INTO recon_allocations
        (order_id, line_item_id, entity_id, share, gross_amount, tax_amount,
         method, reason, auto_method, auto_entity_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // PR #134 — hoist per-order lookups out of the loop. better-sqlite3
    // .prepare() compiles the SQL each call, which adds up over thousands
    // of orders. Reusing the prepared handle is ~3–10× cheaper per call.
    const linesStmt = sqlite.prepare(
      `SELECT id, order_id, sku, title, quantity, price, total_discount,
              line_subtotal, line_tax_total, is_gift_card, requires_shipping
       FROM recon_line_items WHERE order_id = ?`
    );
    const overridesStmt = sqlite.prepare(
      `SELECT line_item_id FROM recon_allocations
       WHERE order_id = ? AND method = 'manual_override'`
    );

    for (const o of orders) {
      summary.orders_processed++;
      if (o.cancelled_at) {
        // Cancelled orders still get a row so we can see them in the UI, but
        // share=0 so they don't roll into revenue.
        continue;
      }
      const t0_lines = Date.now();
      const lines = linesStmt.all(o.id) as LineItemRow[];
      t_lines_query += Date.now() - t0_lines;

      // Check if any allocation for this order was overridden manually.
      const t0_ovr = Date.now();
      const overrides = overridesStmt.all(o.id) as Array<{ line_item_id: string | null }>;
      t_overrides_query += Date.now() - t0_ovr;
      const overriddenLineIds = new Set(overrides.map(r => r.line_item_id));

      // PR #R4b — pre-load successful fulfillments for this order so the
      // online-physical branch can route each line by its actual ship-from
      // location instead of the (often null) order-level location_id.
      const t0_ff = Date.now();
      const fulfillments = listSuccessfulFulfillments(o.id);
      t_fulfillments_query += Date.now() - t0_ff;
      // PR #R4d — pre-load fulfillment_orders too, for unshipped + Locally
      // orders that have no fulfillments yet but DO have FO routing intent.
      const t0_fo = Date.now();
      const fulfillmentOrders = listFulfillmentOrders(o.id);
      t_fulfillment_orders_query += Date.now() - t0_fo;
      const lineCtx = { ...ctx, fulfillments, fulfillmentOrders };

      let orderHasReview = false;
      for (const line of lines) {
        summary.line_items_processed++;
        if (overriddenLineIds.has(line.id)) continue; // keep manual override
        const t0_alloc = Date.now();
        const slices = allocateLineItem(o, line, lineCtx);
        t_allocate_line += Date.now() - t0_alloc;
        for (const a of slices) {
          const t0_ins = Date.now();
          insertStmt.run(
            a.order_id,
            a.line_item_id,
            a.entity_id,
            a.share,
            a.gross_amount,
            a.tax_amount,
            a.method,
            a.reason,
            a.auto_method,
            a.auto_entity_id,
            now,
          );
          t_insert_alloc += Date.now() - t0_ins;
          summary.by_method[a.method]++;
          summary.allocations_written++;
          if (a.method === "needs_review") orderHasReview = true;
        }
      }
      if (orderHasReview) summary.needs_review_orders++;
    }
  });

  const t0_txn = Date.now();
  try {
    txn();
  } catch (e: any) {
    summary.failed_orders = summary.orders_processed - summary.needs_review_orders;
    summary.warnings.push(`Transaction failed: ${e?.message ?? String(e)}`);
  }
  t_txn_total = Date.now() - t0_txn;

  // PR #R4e — Post-allocation: record GC redemptions + generate inter-company
  // JE legs. Runs AFTER the allocation transaction commits so the redemption
  // module can read the canonical redeemer entity from recon_allocations.
  // Each call is independently idempotent (UNIQUE constraints on both
  // tables), so partial reruns and re-trigger from the rebuild route both
  // converge to the same state.
  //
  // PR #135 perf — the previous implementation did a per-order SELECT raw_json
  // + JSON.parse for ALL orders, even though >99% have no GC redemption. For
  // Nov 2025 (1825 orders), that's 1825 extra round-trips and 1825 JSON parses
  // of ~50KB payloads. The fix:
  //   (1) Restrict the pull to orders whose raw_json actually contains the
  //       substring '"gateway":"gift_card"'. Sqlite INSTR on a TEXT column is
  //       a sequential scan of recon_orders for this month's order_ids — still
  //       O(orders) but the per-row cost is a fast substring check vs full
  //       JSON.parse + transaction array walk. For 1825 Nov orders we expect
  //       ≥10 GC redemptions → ≤1% pass rate, so we skip ~99% of JSON.parse
  //       calls.
  //   (2) Hoist the SELECT into a single batched query (IN clause) so we make
  //       one round-trip instead of 1825.
  //
  // Correctness is preserved: the substring test is a strict superset of
  // what processOrderForGCRedemption actually processes (it walks
  // transactions[] looking for gateway === 'gift_card'). Anything that would
  // have produced a redemption row still does; anything filtered out would
  // have returned skipped_reason='no_gc_transactions' anyway.
  const t0_gc = Date.now();
  const liveOrderIds = orders.filter(o => !o.cancelled_at).map(o => o.id);
  if (liveOrderIds.length > 0) {
    const placeholders = liveOrderIds.map(() => "?").join(",");
    const candidates = sqlite
      .prepare(
        `SELECT id, raw_json FROM recon_orders
         WHERE id IN (${placeholders})
           AND raw_json IS NOT NULL
           AND INSTR(raw_json, '"gateway":"gift_card"') > 0`
      )
      .all(...liveOrderIds) as Array<{ id: string; raw_json: string }>;
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c.raw_json);
        const r = processOrderForGCRedemption(c.id, parsed);
        summary.gc_redemptions_recorded += r.redemptions_recorded;
        summary.gc_je_legs_emitted += r.je_legs_emitted;
      } catch (e: any) {
        summary.warnings.push(`GC redemption ${c.id}: ${e?.message ?? String(e)}`);
      }
    }
  }
  t_gc_redemption_pass = Date.now() - t0_gc;

  summary.timing_ms = {
    total_ms: Date.now() - t_start,
    fetch_orders_ms: t_fetch_orders,
    delete_existing_ms: t_delete_existing,
    txn_total_ms: t_txn_total,
    lines_query_ms: t_lines_query,
    overrides_query_ms: t_overrides_query,
    fulfillments_query_ms: t_fulfillments_query,
    fulfillment_orders_query_ms: t_fulfillment_orders_query,
    allocate_line_ms: t_allocate_line,
    insert_alloc_ms: t_insert_alloc,
    gc_redemption_pass_ms: t_gc_redemption_pass,
  };
  return summary;
}

/**
 * Return needs-review allocations + their context, for the UI override card.
 */
export type NeedsReviewRow = {
  order_id: string;
  order_name: string | null;
  order_created_at: string;
  source_name: string | null;
  location_id: string | null;
  line_item_id: string | null;
  sku: string | null;
  title: string | null;
  gross_amount: number;
  tax_amount: number;
  reason: string | null;
  current_entity_id: number;
};

export function listNeedsReview(month?: string): NeedsReviewRow[] {
  const filter = month ? `AND o.created_at >= ? AND o.created_at < ?` : "";
  const params: any[] = [];
  if (month) {
    const [y, m] = month.split("-").map(Number);
    params.push(`${month}-01T00:00:00Z`);
    params.push(m === 12 ? `${y + 1}-01-01T00:00:00Z` : `${y}-${String(m + 1).padStart(2, "0")}-01T00:00:00Z`);
  }
  return sqlite
    .prepare(
      `SELECT
         a.order_id, o.name AS order_name, o.created_at AS order_created_at,
         o.source_name, o.location_id, a.line_item_id,
         li.sku, li.title,
         a.gross_amount, a.tax_amount, a.reason, a.entity_id AS current_entity_id
       FROM recon_allocations a
       JOIN recon_orders o ON o.id = a.order_id
       LEFT JOIN recon_line_items li ON li.id = a.line_item_id
       WHERE a.method = 'needs_review' ${filter}
       ORDER BY o.created_at DESC, a.id ASC`
    )
    .all(...params) as NeedsReviewRow[];
}

/**
 * Apply a manual override to a single allocation slice. Sets method to
 * 'manual_override' so the engine won't overwrite it on subsequent runs.
 */
export function applyAllocationOverride(args: {
  order_id: string;
  line_item_id: string | null;
  entity_id: number;
  user: string;
}): { ok: boolean; updated: number } {
  const now = new Date().toISOString();
  const r = sqlite
    .prepare(
      `UPDATE recon_allocations
       SET entity_id = ?, method = 'manual_override',
           overridden_by = ?, overridden_at = ?, updated_at = ?
       WHERE order_id = ? AND (line_item_id IS ? OR line_item_id = ?)`
    )
    .run(args.entity_id, args.user, now, now, args.order_id, args.line_item_id, args.line_item_id);
  return { ok: true, updated: r.changes };
}

/**
 * Per-entity per-month allocation rollup (used by the summary card).
 *
 * PR #R4k — Gift-card carve-out. Shopify's Net sales / Gross sales reports
 * exclude gift card issuance — the face value of a sold GC is recorded as a
 * LIABILITY, not revenue, until the customer redeems it. To make our rollup
 * tie out to Shopify (and to QBO once we wire JE posting in Phase 2), we now
 * split the per-entity total into two columns:
 *
 *   gross_total            — merchandise revenue only, matches Shopify Net
 *                            sales (after discounts, before refunds).
 *   gc_issuance_total      — face value of digital gift cards issued in the
 *                            month, allocated to the issuer entity by the
 *                            R4d issuance cascade (customer_affinity →
 *                            zip_radius → fallback_sd). Mirrors Shopify's
 *                            "Net sales from gift cards" finance report.
 *
 * "Total Shopify activity" — if you want a single number that ties to
 * Shopify's gross-sales-minus-discounts — is `gross_total + gc_issuance_total`.
 *
 * GC detection rule MUST mirror the allocator's branch at allocateLineItem():
 * a digital gift card has line_items.is_gift_card = 1 AND requires_shipping = 0.
 * Physical gift cards (requires_shipping = 1) ship like regular merchandise
 * and ARE counted as gross revenue, which also matches Shopify's treatment
 * (Shopify distinguishes by product type, and physical GC products typically
 * carry actual SKU/inventory).
 */
export type AllocationRollupRow = {
  entity_id: number;
  entity_location: string | null;
  orders: number;
  line_items: number;
  // Merchandise gross only (excludes digital GC issuance) — ties to
  // Shopify Net sales + |Returns|.
  gross_total: number;
  // PR #R4k — digital GC issuance face value, allocated to the issuer
  // entity. Ties to Shopify "Net sales from gift cards" report.
  gc_issuance_total: number;
  tax_total: number;
};

export function getAllocationRollup(month: string): AllocationRollupRow[] {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01T00:00:00Z`;
  const end = m === 12 ? `${y + 1}-01-01T00:00:00Z` : `${y}-${String(m + 1).padStart(2, "0")}-01T00:00:00Z`;
  // Join recon_line_items so we can branch on is_gift_card + requires_shipping.
  // LEFT JOIN with COALESCE preserves any historical allocation rows whose
  // line_item_id is null (cross-entity GC redemption legs, manual overrides
  // without a specific line) — those are treated as merchandise (gc=0,
  // ships=1) so they fall into gross_total, matching pre-R4k behaviour.
  return sqlite
    .prepare(
      `SELECT
         a.entity_id,
         e.location AS entity_location,
         COUNT(DISTINCT a.order_id) AS orders,
         COUNT(a.line_item_id) AS line_items,
         SUM(CASE
               WHEN COALESCE(li.is_gift_card, 0) = 1
                    AND COALESCE(li.requires_shipping, 1) = 0
               THEN 0
               ELSE a.gross_amount
             END) AS gross_total,
         SUM(CASE
               WHEN COALESCE(li.is_gift_card, 0) = 1
                    AND COALESCE(li.requires_shipping, 1) = 0
               THEN a.gross_amount
               ELSE 0
             END) AS gc_issuance_total,
         SUM(a.tax_amount) AS tax_total
       FROM recon_allocations a
       JOIN recon_orders o ON o.id = a.order_id
       LEFT JOIN recon_line_items li ON li.id = a.line_item_id
       LEFT JOIN payroll_entities e ON e.id = a.entity_id
       WHERE o.created_at >= ? AND o.created_at < ?
       GROUP BY a.entity_id, e.location
       ORDER BY a.entity_id ASC`
    )
    .all(start, end) as AllocationRollupRow[];
}

/**
 * PR #R4k-diag — Compute the UTC instants that bound a calendar month
 * in store time (America/New_York). DST-safe: walks an Intl.DateTimeFormat
 * to find the actual UTC offset for the first instant of the target month
 * and the first instant of the following month.
 *
 * Returns ISO-8601 UTC strings suitable for use as SQL `created_at` bounds.
 */
export function getStoreTimeMonthBoundsUtc(month: string, tz = "America/New_York"): {
  start_utc: string;
  end_utc: string;
} {
  const [y, m] = month.split("-").map(Number);
  // Find the UTC instant whose store-time representation is YYYY-MM-01 00:00:00.
  // We bracket-search: start with the naive UTC midnight, then ask Intl what
  // that maps to in store time, and shift by the resulting offset.
  const findUtcMidnight = (yy: number, mm: number): Date => {
    // Start at the naive instant (treat YYYY-MM-01 00:00 as if it were UTC).
    const naive = new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0));
    // Format that instant in store time; the difference tells us the offset.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(naive).map((p) => [p.type, p.value])
    );
    // What instant did we *want*? Local midnight of yy-mm-01. What do we have?
    const haveLocal = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) === 24 ? 0 : Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    // Shift the naive instant by the offset between what-we-want and what-we-have.
    return new Date(naive.getTime() + (naive.getTime() - haveLocal));
  };
  const startDate = findUtcMidnight(y, m);
  const endDate = m === 12 ? findUtcMidnight(y + 1, 1) : findUtcMidnight(y, m + 1);
  return {
    start_utc: startDate.toISOString(),
    end_utc: endDate.toISOString(),
  };
}

/**
 * PR #R4k-diag — Same shape as getAllocationRollup() but bounds the month
 * in store time (America/New_York) instead of UTC, so the result is directly
 * comparable to Shopify Finance reports.
 *
 * Read-only diagnostic — does NOT replace the canonical UTC rollup yet.
 */
export function getAllocationRollupStoreTime(
  month: string,
  tz = "America/New_York"
): AllocationRollupRow[] {
  const { start_utc, end_utc } = getStoreTimeMonthBoundsUtc(month, tz);
  return sqlite
    .prepare(
      `SELECT
         a.entity_id,
         e.location AS entity_location,
         COUNT(DISTINCT a.order_id) AS orders,
         COUNT(a.line_item_id) AS line_items,
         SUM(CASE
               WHEN COALESCE(li.is_gift_card, 0) = 1
                    AND COALESCE(li.requires_shipping, 1) = 0
               THEN 0
               ELSE a.gross_amount
             END) AS gross_total,
         SUM(CASE
               WHEN COALESCE(li.is_gift_card, 0) = 1
                    AND COALESCE(li.requires_shipping, 1) = 0
               THEN a.gross_amount
               ELSE 0
             END) AS gc_issuance_total,
         SUM(a.tax_amount) AS tax_total
       FROM recon_allocations a
       JOIN recon_orders o ON o.id = a.order_id
       LEFT JOIN recon_line_items li ON li.id = a.line_item_id
       LEFT JOIN payroll_entities e ON e.id = a.entity_id
       WHERE o.created_at >= ? AND o.created_at < ?
       GROUP BY a.entity_id, e.location
       ORDER BY a.entity_id ASC`
    )
    .all(start_utc, end_utc) as AllocationRollupRow[];
}

/**
 * PR #R4k-diag — Diagnose the timezone discrepancy for a given month:
 * count and sum the orders that fall inside the UTC bucket but outside the
 * store-time bucket (and vice versa). These are the edge-of-month orders
 * that drive variance between reconciler totals and Shopify Finance.
 */
export function getMonthBoundaryDiag(
  month: string,
  tz = "America/New_York"
): {
  month: string;
  tz: string;
  utc_bounds: { start: string; end: string };
  store_bounds_as_utc: { start: string; end: string };
  // Orders in UTC bucket but NOT in store-time bucket (added to UTC by mistake)
  in_utc_not_store: { order_count: number; gross_sum: number; tax_sum: number; samples: any[] };
  // Orders in store-time bucket but NOT in UTC bucket (missing from UTC)
  in_store_not_utc: { order_count: number; gross_sum: number; tax_sum: number; samples: any[] };
} {
  const [y, m] = month.split("-").map(Number);
  const utc_start = `${month}-01T00:00:00Z`;
  const utc_end =
    m === 12
      ? `${y + 1}-01-01T00:00:00Z`
      : `${y}-${String(m + 1).padStart(2, "0")}-01T00:00:00Z`;
  const { start_utc, end_utc } = getStoreTimeMonthBoundsUtc(month, tz);

  const edgeQuery = (whereClause: string, args: any[]) => {
    const rows = sqlite
      .prepare(
        `SELECT a.order_id, o.created_at, o.name AS order_name,
                SUM(a.gross_amount) AS gross, SUM(a.tax_amount) AS tax
           FROM recon_allocations a
           JOIN recon_orders o ON o.id = a.order_id
           WHERE ${whereClause}
           GROUP BY a.order_id, o.created_at, o.name
           ORDER BY o.created_at ASC`
      )
      .all(...args) as Array<{
      order_id: string;
      created_at: string;
      order_name: string | null;
      gross: number;
      tax: number;
    }>;
    const order_count = rows.length;
    const gross_sum = rows.reduce((s, r) => s + (r.gross ?? 0), 0);
    const tax_sum = rows.reduce((s, r) => s + (r.tax ?? 0), 0);
    return { order_count, gross_sum, tax_sum, samples: rows.slice(0, 25) };
  };

  // In UTC bucket but NOT in store bucket:
  //   created_at >= utc_start AND < utc_end
  //   AND (created_at < start_utc OR created_at >= end_utc)
  const inUtcNotStore = edgeQuery(
    `o.created_at >= ? AND o.created_at < ?
     AND (o.created_at < ? OR o.created_at >= ?)`,
    [utc_start, utc_end, start_utc, end_utc]
  );

  // In store bucket but NOT in UTC bucket:
  //   created_at >= start_utc AND < end_utc
  //   AND (created_at < utc_start OR created_at >= utc_end)
  const inStoreNotUtc = edgeQuery(
    `o.created_at >= ? AND o.created_at < ?
     AND (o.created_at < ? OR o.created_at >= ?)`,
    [start_utc, end_utc, utc_start, utc_end]
  );

  return {
    month,
    tz,
    utc_bounds: { start: utc_start, end: utc_end },
    store_bounds_as_utc: { start: start_utc, end: end_utc },
    in_utc_not_store: inUtcNotStore,
    in_store_not_utc: inStoreNotUtc,
  };
}

/**
 * Are we ready to run the engine? Mapping config readiness + COA readiness.
 */
export function getAllocationReadiness(): {
  has_pos_mappings: boolean;
  pos_mapping_count: number;
  unmapped_active_locations: number;
  has_sd_entity: boolean;
  has_zip_lookups: boolean;
  zip_lookup_count: number;
  has_pro_rata: boolean;
  pro_rata_year: number | null;
} {
  const mappingRow = sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM recon_entity_pos_locations
       WHERE active = 1 AND shopify_location_id IS NOT NULL`
    )
    .get() as { c: number };
  const unmappedRow = sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM recon_entity_pos_locations
       WHERE active = 1 AND shopify_location_id IS NULL`
    )
    .get() as { c: number };
  const zipRow = sqlite
    .prepare(`SELECT COUNT(*) AS c FROM recon_zip_to_entity_lookup`)
    .get() as { c: number };
  const proRataRow = sqlite
    .prepare(
      `SELECT applies_to_year FROM recon_prior_year_pro_rata
       ORDER BY applies_to_year DESC LIMIT 1`
    )
    .get() as { applies_to_year: number } | undefined;
  return {
    has_pos_mappings: mappingRow.c > 0,
    pos_mapping_count: mappingRow.c,
    unmapped_active_locations: unmappedRow.c,
    has_sd_entity: !!getSdEntityId(),
    has_zip_lookups: zipRow.c > 0,
    zip_lookup_count: zipRow.c,
    has_pro_rata: !!proRataRow,
    pro_rata_year: proRataRow?.applies_to_year ?? null,
  };
}
