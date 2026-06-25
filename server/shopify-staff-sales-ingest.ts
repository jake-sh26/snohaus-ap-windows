/**
 * server/shopify-staff-sales-ingest.ts
 *
 * PR #202 \u2014 Ingest pipeline that joins the ShopifyQL staff-sales pull to
 * our local `recon_orders` + `recon_allocations` tables and upserts one
 * row per (period \u00d7 staff \u00d7 order \u00d7 entity) into
 * `recon_shopify_staff_sales`.
 *
 *   ShopifyQL row \u2014 one per (assisting_staff_id, order_name).
 *   net_sales is the canonical Shopify number (already net of returns,
 *   exchange-aware).
 *
 *   For each row, we:
 *     1. Resolve assisting_staff_id \u2192 payroll_employees via the matcher.
 *        Miss = NULL employee_id, row still stored and surfaced in the
 *        payroll_unmatched_attributions view.
 *     2. Look up recon_orders by name = order_name. If absent, store
 *        with NULL entity_id / NULL order_id / share=1.0 /
 *        allocation_method='unallocated'. Re-ingest will resolve.
 *     3. If recon_orders is present, fetch recon_allocations rows for
 *        that order. POS orders typically have one allocation row
 *        (method='pos', share=1.0); online orders may have multiple
 *        per-line or per-entity rows.
 *     4. Aggregate allocations per entity (sum shares per entity), then
 *        emit one ingest row per entity, with dollar columns multiplied
 *        by the entity's total share.
 *        \u2192 share sums across entities for one order ALWAYS equal 1.0
 *          (per the allocator's invariant), so the dollar columns sum
 *          back to the original ShopifyQL net_sales.
 *     5. UPSERT keyed on (period_start, period_end, assisting_staff_id,
 *        order_name, entity_id) so re-runs are idempotent.
 *
 * This module is intentionally simple \u2014 no UI, no scheduling, no
 * commission calc. The next PR (#203) adds the running-tally UI.
 */

import { sqlite } from "./storage";
import { fetchStaffSales, type StaffSalesRow } from "./shopify-staff-sales";
import {
  resolveEmployeesByShopifyStaffBatch,
  type ResolvedEmployee,
} from "./commission-matcher";
import { recordIntegrationError, recordIntegrationWarn } from "./error-log";

function logErr(scope: string, msg: string) {
  recordIntegrationError("shopify-staff-sales-ingest", scope, msg, "error");
}
function logWarn(scope: string, msg: string) {
  recordIntegrationWarn("shopify-staff-sales-ingest", scope, msg);
}

export type IngestSummary = {
  since: string;
  until: string;
  shopifyql_rows: number;
  emitted_rows: number;
  resolved_employees: number;
  unresolved_staff: number;
  orders_not_yet_in_db: number;
  unique_staff: number;
  unique_orders: number;
  query: string;
};

type AllocationRow = {
  entity_id: number;
  share: number;
  method: string | null;
};

/**
 * Run the full ingest for a date range. Idempotent: re-running over the
 * same window upserts rows in place. Returns a summary the caller can
 * surface in the UI or the response of the ingest route.
 */
export async function ingestStaffSales(
  since: string,
  until: string,
): Promise<IngestSummary> {
  const pull = await fetchStaffSales(since, until);

  // Batch-resolve all staff ids up front so the per-row loop is just a
  // map lookup (no DB round-trips).
  const resolved = resolveEmployeesByShopifyStaffBatch(
    pull.rows.map((r) => r.assisting_staff_id),
  );

  // Pre-load the orders we need by name. ShopifyQL returns order_name
  // with the leading "#" (e.g. "#38173") \u2014 our local recon_orders.name
  // matches this format (confirmed from the schema doc string).
  const orderNames = Array.from(
    new Set(
      pull.rows
        .map((r) => r.order_name)
        .filter((n): n is string => typeof n === "string" && n.length > 0),
    ),
  );

  const ordersByName = lookupOrdersByName(orderNames);
  const allocationsByOrderId = lookupAllocationsByOrderIds(
    Array.from(new Set(Array.from(ordersByName.values()).map((o) => o.id))),
  );

  // Counters for the summary.
  let emitted = 0;
  let resolvedCount = 0;
  let unresolvedCount = 0;
  let ordersMissing = 0;
  const uniqueStaff = new Set<string>();
  const uniqueOrders = new Set<string>();

  const ingestedAt = new Date().toISOString();

  // One UPSERT per emitted row \u2014 transaction-wrap so a partial failure
  // doesn't leave a half-written period.
  const upsert = sqlite.prepare(`
    INSERT INTO recon_shopify_staff_sales (
      period_start, period_end,
      assisting_staff_id, staff_name,
      employee_id, entity_id,
      order_name, order_id, pos_location_name,
      share,
      quantity, gross_sales, discounts, returns,
      net_sales, taxes, total_sales,
      allocation_method, raw_json, ingested_at
    ) VALUES (
      @period_start, @period_end,
      @assisting_staff_id, @staff_name,
      @employee_id, @entity_id,
      @order_name, @order_id, @pos_location_name,
      @share,
      @quantity, @gross_sales, @discounts, @returns,
      @net_sales, @taxes, @total_sales,
      @allocation_method, @raw_json, @ingested_at
    )
    ON CONFLICT (period_start, period_end, assisting_staff_id,
                 COALESCE(order_name, ''), COALESCE(entity_id, -1))
    DO UPDATE SET
      staff_name        = excluded.staff_name,
      employee_id       = excluded.employee_id,
      order_id          = excluded.order_id,
      pos_location_name = excluded.pos_location_name,
      share             = excluded.share,
      quantity          = excluded.quantity,
      gross_sales       = excluded.gross_sales,
      discounts         = excluded.discounts,
      returns           = excluded.returns,
      net_sales         = excluded.net_sales,
      taxes             = excluded.taxes,
      total_sales       = excluded.total_sales,
      allocation_method = excluded.allocation_method,
      raw_json          = excluded.raw_json,
      ingested_at       = excluded.ingested_at
  `);

  const tx = sqlite.transaction((rows: StaffSalesRow[]) => {
    for (const row of rows) {
      uniqueStaff.add(row.assisting_staff_id);
      if (row.order_name) uniqueOrders.add(row.order_name);

      const emp = resolved.get(row.assisting_staff_id) ?? null;
      if (emp) resolvedCount++;
      else unresolvedCount++;

      const order =
        row.order_name === null ? null : (ordersByName.get(row.order_name) ?? null);
      if (row.order_name !== null && order === null) ordersMissing++;

      // Compute per-entity emissions. If we have no order at all (not
      // yet in recon_orders), emit one row with NULL entity / share=1.
      // If we have an order but no allocations, emit one unallocated
      // row (allocator hasn't run yet for this order).
      const emissions = computeEmissions(order, allocationsByOrderId);

      for (const e of emissions) {
        const params = {
          period_start: pull.since,
          period_end: pull.until,
          assisting_staff_id: row.assisting_staff_id,
          staff_name: row.staff_name,
          employee_id: emp?.employee_id ?? null,
          entity_id: e.entity_id,
          order_name: row.order_name,
          order_id: order?.id ?? null,
          pos_location_name: row.pos_location_name,
          share: e.share,
          quantity: scale(row.quantity_ordered_per_order, e.share),
          gross_sales: scale(row.gross_sales, e.share),
          discounts: scale(row.discounts, e.share),
          returns: scale(row.returns, e.share),
          net_sales: scale(row.net_sales, e.share) ?? 0,
          taxes: scale(row.taxes, e.share),
          total_sales: scale(row.total_sales, e.share),
          allocation_method: e.method,
          raw_json: JSON.stringify(row.raw),
          ingested_at: ingestedAt,
        };
        upsert.run(params);
        emitted++;
      }
    }
  });

  try {
    tx(pull.rows);
  } catch (e: any) {
    logErr("upsert", `transaction failed for ${since}..${until}: ${e?.message ?? e}`);
    throw e;
  }

  return {
    since: pull.since,
    until: pull.until,
    shopifyql_rows: pull.rows.length,
    emitted_rows: emitted,
    resolved_employees: resolvedCount,
    unresolved_staff: unresolvedCount,
    orders_not_yet_in_db: ordersMissing,
    unique_staff: uniqueStaff.size,
    unique_orders: uniqueOrders.size,
    query: pull.query,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OrderLite = { id: string; name: string; location_id: string | null };

function lookupOrdersByName(names: string[]): Map<string, OrderLite> {
  const out = new Map<string, OrderLite>();
  if (names.length === 0) return out;

  // SQLite parameter ceiling is 999 by default; chunk to be safe.
  const CHUNK = 500;
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = sqlite
      .prepare(
        `SELECT id, name, location_id FROM recon_orders WHERE name IN (${placeholders})`,
      )
      .all(...chunk) as OrderLite[];
    for (const r of rows) out.set(r.name, r);
  }
  return out;
}

function lookupAllocationsByOrderIds(
  orderIds: string[],
): Map<string, AllocationRow[]> {
  const out = new Map<string, AllocationRow[]>();
  if (orderIds.length === 0) return out;

  const CHUNK = 500;
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const chunk = orderIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    // We aggregate share per (order_id, entity_id) here so per-line
    // allocations roll up to one row per entity for this order \u2014
    // matches the share-weighting semantics documented in the table.
    const rows = sqlite
      .prepare(
        `SELECT order_id,
                entity_id,
                SUM(share)   AS share,
                MIN(method)  AS method
           FROM recon_allocations
          WHERE order_id IN (${placeholders})
          GROUP BY order_id, entity_id`,
      )
      .all(...chunk) as Array<{
      order_id: string;
      entity_id: number;
      share: number;
      method: string | null;
    }>;
    for (const r of rows) {
      const list = out.get(r.order_id) ?? [];
      list.push({ entity_id: r.entity_id, share: r.share, method: r.method });
      out.set(r.order_id, list);
    }
  }
  return out;
}

type Emission = {
  entity_id: number | null;
  share: number;
  method: string;
};

/**
 * Decide how to fan a ShopifyQL row into one or more ingest rows based on
 * what we know locally about the order's allocation.
 *
 *   - order missing in recon_orders                \u2192 one row, NULL entity, share=1, 'unallocated'
 *   - order present but no allocations             \u2192 one row, NULL entity, share=1, 'unallocated'
 *   - order present with allocations               \u2192 one row per entity, share-weighted
 *
 * Allocation shares are normalized: if the allocator's total share isn't
 * exactly 1.0 (rare \u2014 floating point drift or partial allocations on
 * mixed carts), we scale to 1.0 so the ShopifyQL net_sales total
 * reconciles. Log a warning if drift exceeds 1% \u2014 that signals an
 * allocator bug worth investigating, not silent re-normalization.
 */
function computeEmissions(
  order: OrderLite | null,
  allocationsByOrderId: Map<string, AllocationRow[]>,
): Emission[] {
  if (order === null) {
    return [{ entity_id: null, share: 1, method: "unallocated" }];
  }
  const allocs = allocationsByOrderId.get(order.id) ?? [];
  if (allocs.length === 0) {
    return [{ entity_id: null, share: 1, method: "unallocated" }];
  }

  const totalShare = allocs.reduce((s, a) => s + (a.share || 0), 0);
  if (totalShare <= 0) {
    logWarn(
      "alloc",
      `order ${order.name} (${order.id}) has allocations but totalShare=${totalShare} \u2014 emitting unallocated`,
    );
    return [{ entity_id: null, share: 1, method: "unallocated" }];
  }
  if (Math.abs(totalShare - 1) > 0.01) {
    logWarn(
      "alloc",
      `order ${order.name} (${order.id}) allocations sum to ${totalShare.toFixed(4)} (expected 1.0) \u2014 renormalizing`,
    );
  }

  // POS allocations have method='pos'; online sales use various methods
  // ('online_fulfillment', 'gc_zip', 'gc_pro_rata', 'manual'). We
  // collapse to a single label for the ingest row.
  return allocs.map((a) => ({
    entity_id: a.entity_id,
    share: (a.share || 0) / totalShare,
    method: a.method === "pos" ? "pos" : "online_share",
  }));
}

function scale(v: number | null, share: number): number | null {
  if (v === null) return null;
  if (!Number.isFinite(v)) return null;
  return v * share;
}
