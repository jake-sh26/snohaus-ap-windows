/**
 * server/shopify-staff-sales.ts
 *
 * PR #202 — ShopifyQL staff-sales fetcher.
 *
 * Pulls the per-staff-per-order net_sales breakdown via the ShopifyQL
 * `sales` dataset. This is the same data source that powers the
 * "POS total sales by staff member" report in the Shopify admin, but
 * grouped one level finer by `order_name` so we can join the result back
 * to our local `recon_orders` + `recon_allocations` tables for entity
 * attribution (POS rows are entity-attributed via location; online rows
 * fall back to the share-weighted finance allocator).
 *
 * Key facts (locked from the dimension probing screenshots, 2026-06-24):
 *   - The dimension is `assisting_staff_id` (bare numeric — same value
 *     as REST `order.user_id`, NOT a gid:// string).
 *   - Online sales WITH manually-tagged staff attribution appear here as
 *     pos_location_name = "None". They are intentional commission rows.
 *   - Online sales without staff attribution simply don't appear (no
 *     assisting_staff_id) — they are not commissionable under the
 *     current policy and we don't need to ingest them via this path.
 *   - `net_sales` is Shopify's authoritative number — already net of
 *     returns AND already exchange-aware (cross-month claw-backs land
 *     in the period they were processed in).
 *
 * Scopes required: `read_reports` (already in REQUIRED_SCOPES from
 * PR #R5b).
 */

import { runShopifyql, type ShopifyqlRow } from "./shopify-shopifyql";
import { recordIntegrationError, recordIntegrationWarn } from "./error-log";

function logErr(scope: string, msg: string) {
  recordIntegrationError("shopify-staff-sales", scope, msg, "error");
}
function logWarn(scope: string, msg: string) {
  recordIntegrationWarn("shopify-staff-sales", scope, msg);
}

export type StaffSalesRow = {
  /** Bare numeric — matches PERSON_SYSTEMS.SHOPIFY_STAFF external_id. */
  assisting_staff_id: string;
  /** Human-readable name for audit + the unmatched-row UI. */
  staff_name: string | null;
  /** "Sno-Haus Greenvale" / "Sno-Haus Huntington" / "None" (online). */
  pos_location_name: string | null;
  /** Shopify order name (e.g. "#38173") — joins to recon_orders.name. */
  order_name: string | null;
  // Money fields — all in shop currency, signed per Shopify's convention:
  //   gross_sales:  POSITIVE (line subtotal)
  //   discounts:    NEGATIVE
  //   returns:      NEGATIVE
  //   net_sales:    SIGNED (negative when returns > gross — a pay period
  //                 of pure returns will produce a negative number, e.g.
  //                 Bob Ballin -$519.95 in the 6/15-6/21 example)
  //   taxes:        POSITIVE
  //   total_sales:  SIGNED
  quantity_ordered_per_order: number | null;
  gross_sales: number | null;
  discounts: number | null;
  returns: number | null;
  net_sales: number | null;
  taxes: number | null;
  total_sales: number | null;
  /** The full raw ShopifyQL row, for audit / debugging. */
  raw: ShopifyqlRow;
};

export type StaffSalesPull = {
  since: string; // YYYY-MM-DD inclusive
  until: string; // YYYY-MM-DD inclusive
  query: string;
  rows: StaffSalesRow[];
  parseErrors: Array<{ message: string; code?: string }>;
};

/**
 * Build the ShopifyQL query string for a given date range. Exposed for
 * tests and the diagnostic UI so a human can paste it into the Shopify
 * admin ShopifyQL playground and verify the numbers.
 *
 * Bucketing note: ShopifyQL's `sales` dataset is bucketed by the
 * transaction date when the money moved — matches the same convention
 * the Shopify "Total sales by staff member" admin report uses. Returns
 * processed in this date range land here, even when the original order
 * was earlier (which is exactly what we want for commission claw-backs).
 */
export function buildStaffSalesQuery(since: string, until: string): string {
  // Defensive: validate format. We don't want to interpolate junk into
  // the query string and let Shopify error on it.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error(`since must be YYYY-MM-DD (got "${since}")`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    throw new Error(`until must be YYYY-MM-DD (got "${until}")`);
  }

  // Keep this query exactly aligned with the verified-working version in
  // the admin's POS-total-sales-by-staff-member report — the only change
  // is adding `order_name` to GROUP BY so each row is per-staff-per-order
  // instead of aggregated. WITH TOTALS lets the caller sanity-check the
  // sum without re-aggregating.
  //
  // LIMIT 5000 is a guardrail — at ~200 orders/wk × ~5 commissionable
  // staff = ~1000 rows/wk worst case; 5000 gives us a comfortable buffer
  // for monthly pulls or stores with higher volume. ShopifyQL caps at
  // 10000.
  return [
    "FROM sales",
    "SHOW quantity_ordered_per_order, gross_sales, discounts, returns,",
    "     net_sales, taxes, total_sales",
    "GROUP BY assisting_staff_member_name, assisting_staff_id,",
    "         pos_location_name, order_name",
    "  WITH TOTALS",
    `SINCE ${since} UNTIL ${until}`,
    "ORDER BY total_sales DESC",
    "LIMIT 5000",
  ].join("\n");
}

/**
 * Run the ShopifyQL query for the given window and return cleaned rows.
 * Throws on transport / auth errors (caller should surface to user with
 * the re-install hint). Returns a structured result on success.
 *
 * Rows where `assisting_staff_id` is null (no staff attribution at all)
 * AND `assisting_staff_member_name` is null are silently dropped — these
 * are the `WITH TOTALS` summary row plus any all-online-unattributed
 * aggregate that ShopifyQL emits. We don't store summary rows; if a
 * caller needs the total it should sum the returned rows.
 */
export async function fetchStaffSales(
  since: string,
  until: string,
): Promise<StaffSalesPull> {
  const query = buildStaffSalesQuery(since, until);
  const result = await runShopifyql(query);

  // Surface parse errors as a structured field — don't throw, since we
  // still want to return whatever rows we got (sometimes ShopifyQL
  // returns warnings alongside valid data).
  if (result.parseErrors.length > 0) {
    logWarn(
      "parse",
      `staff-sales pull ${since}..${until} had ${result.parseErrors.length} parse error(s): ${result.parseErrors.map((e) => e.message).join("; ")}`,
    );
  }

  const rows: StaffSalesRow[] = [];
  for (const raw of result.rows) {
    const idRaw = raw["assisting_staff_id"];
    const nameRaw = raw["assisting_staff_member_name"];
    // Skip the WITH TOTALS summary row (everything null on the dim side).
    if (idRaw === null && nameRaw === null) continue;
    // Drop rows that somehow have name but no id — we can't resolve them
    // back to an employee deterministically, but we also don't want to
    // silently lose them. Log + skip.
    if (idRaw === null) {
      logWarn(
        "row",
        `staff-sales row with name "${String(nameRaw)}" but no assisting_staff_id — skipped`,
      );
      continue;
    }
    const idStr = String(idRaw).trim();
    if (idStr.length === 0) continue;

    rows.push({
      assisting_staff_id: idStr,
      staff_name: nameRaw === null ? null : String(nameRaw),
      pos_location_name:
        raw["pos_location_name"] === null
          ? null
          : String(raw["pos_location_name"]),
      order_name:
        raw["order_name"] === null ? null : String(raw["order_name"]),
      quantity_ordered_per_order: toNum(raw["quantity_ordered_per_order"]),
      gross_sales: toNum(raw["gross_sales"]),
      discounts: toNum(raw["discounts"]),
      returns: toNum(raw["returns"]),
      net_sales: toNum(raw["net_sales"]),
      taxes: toNum(raw["taxes"]),
      total_sales: toNum(raw["total_sales"]),
      raw,
    });
  }

  if (rows.length >= 5000) {
    logErr(
      "limit",
      `staff-sales pull ${since}..${until} returned 5000 rows — at LIMIT cap. Narrow the date range or raise the limit.`,
    );
  }

  return { since, until, query, rows, parseErrors: result.parseErrors };
}

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
