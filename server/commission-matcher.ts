/**
 * server/commission-matcher.ts
 *
 * PR #202 — Commission matcher resolver.
 *
 * Maps a Shopify "assisting staff" identifier (as returned by ShopifyQL's
 * `assisting_staff_id` dimension, or by REST `order.user_id`) to a
 * `payroll_employees` row, going through the `person_external_ids` link
 * table that PR #199 / #200 established.
 *
 * The function accepts either the bare numeric form (e.g. "82318328050",
 * which is what ShopifyQL `assisting_staff_id` and REST `order.user_id`
 * actually return) OR the GraphQL GID form (e.g.
 * "gid://shopify/StaffMember/82318328050"). It normalizes to bare numeric
 * for lookup since that is the canonical form we store in
 * person_external_ids (PERSON_SYSTEMS.SHOPIFY_STAFF).
 *
 * Lookup order:
 *   1. person_external_ids(system='SHOPIFY_STAFF', external_id=<numeric>)
 *        -> payroll_employees.person_id  (the "modern" path)
 *   2. payroll_employees.shopify_staff_member_id = <numeric>
 *        (legacy fallback — pre-PR #200 employees not yet linked to a
 *         person row may still have the raw column populated)
 *
 * Returns null on miss. Caller is responsible for flagging the row in
 * payroll_unmatched_attributions for manual UI mapping.
 */

import { sqlite } from "./storage";
import { PERSON_SYSTEMS } from "./people";

export type ResolvedEmployee = {
  employee_id: number;
  person_id: number | null;
  full_name: string | null;
  entity_id: number | null;
  commission_rate_pct: number | null;
  /** Which lookup path matched: "person_external_ids" or "direct_column". */
  match_source: "person_external_ids" | "direct_column";
};

/**
 * Normalize a Shopify staff identifier to the canonical bare numeric form
 * used in storage. Accepts:
 *   - "82318328050"                                  -> "82318328050"
 *   - "gid://shopify/StaffMember/82318328050"        -> "82318328050"
 *   - 82318328050  (number — BigInts not needed; we treat as string)
 *
 * Returns null for null/empty/non-numeric inputs.
 */
export function normalizeShopifyStaffId(
  raw: string | number | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s.length === 0) return null;

  // GID form: gid://shopify/StaffMember/<digits>
  const gidMatch = s.match(/^gid:\/\/shopify\/StaffMember\/(\d+)$/i);
  if (gidMatch) return gidMatch[1];

  // Bare numeric form: only digits
  if (/^\d+$/.test(s)) return s;

  // Anything else (names, malformed GIDs, etc.) is not a staff id.
  return null;
}

/**
 * Resolve a Shopify staff identifier to a payroll_employees row.
 * Returns null if no matching employee is found.
 */
export function resolveEmployeeByShopifyStaff(
  raw: string | number | null | undefined,
): ResolvedEmployee | null {
  const normalized = normalizeShopifyStaffId(raw);
  if (normalized === null) return null;

  // Path 1: via person_external_ids (the modern, post-PR-#199 path).
  // We restrict to non-archived persons since archived = orphan/replaced.
  const viaPerson = sqlite.prepare(`
    SELECT
      e.id            AS employee_id,
      e.person_id     AS person_id,
      e.full_name     AS full_name,
      e.entity_id     AS entity_id,
      e.commission_rate_pct AS commission_rate_pct
    FROM person_external_ids pxi
    JOIN people p   ON p.id = pxi.person_id
    JOIN payroll_employees e ON e.person_id = pxi.person_id
    WHERE pxi.system = ?
      AND pxi.external_id = ?
      AND p.status = 'active'
    LIMIT 1
  `).get(PERSON_SYSTEMS.SHOPIFY_STAFF, normalized) as
    | {
        employee_id: number;
        person_id: number | null;
        full_name: string | null;
        entity_id: number | null;
        commission_rate_pct: number | null;
      }
    | undefined;

  if (viaPerson) {
    return { ...viaPerson, match_source: "person_external_ids" };
  }

  // Path 2: direct column fallback. Pre-PR-#200 backfill may have left
  // some employees with `shopify_staff_member_id` populated but no
  // person_external_ids row — typically employees added manually after
  // the backfill ran. We allow either bare-numeric OR gid:// form here
  // since the raw column has no normalization guarantee.
  const gidForm = `gid://shopify/StaffMember/${normalized}`;
  const viaDirect = sqlite.prepare(`
    SELECT
      id              AS employee_id,
      person_id       AS person_id,
      full_name       AS full_name,
      entity_id       AS entity_id,
      commission_rate_pct AS commission_rate_pct
    FROM payroll_employees
    WHERE shopify_staff_member_id IN (?, ?)
    LIMIT 1
  `).get(normalized, gidForm) as
    | {
        employee_id: number;
        person_id: number | null;
        full_name: string | null;
        entity_id: number | null;
        commission_rate_pct: number | null;
      }
    | undefined;

  if (viaDirect) {
    return { ...viaDirect, match_source: "direct_column" };
  }

  return null;
}

/**
 * Batched variant for ingest hot paths. Given a list of raw staff ids,
 * returns a Map keyed by the NORMALIZED id. Entries are missing when no
 * employee matched. Avoids N round-trips on big ingest batches.
 */
export function resolveEmployeesByShopifyStaffBatch(
  rawIds: Array<string | number | null | undefined>,
): Map<string, ResolvedEmployee> {
  const out = new Map<string, ResolvedEmployee>();
  // De-dupe normalized ids so we don't waste work on repeats.
  const norm = new Set<string>();
  for (const r of rawIds) {
    const n = normalizeShopifyStaffId(r);
    if (n !== null) norm.add(n);
  }
  norm.forEach((n) => {
    const resolved = resolveEmployeeByShopifyStaff(n);
    if (resolved !== null) out.set(n, resolved);
  });
  return out;
}
