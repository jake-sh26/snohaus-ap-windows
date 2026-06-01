/**
 * Sales Tax — store / jurisdiction mapping (single source of truth).
 *
 * Hardcoded NY jurisdiction data for the three Sno-Haus retail POS stores.
 * Imported by the sales-tax backend (PR #165) and the Sales Tax UI / nav
 * restructure (PR #166 / #167) so the jurisdiction facts live in exactly
 * one place.
 *
 * `store_id` is the Shopify POS `pos_location_id` (matches
 * SNOHAUS_POS_LOCATIONS in shopify-recon-pos-locations.ts and the
 * recon_entity_pos_locations.shopify_location_id rows). `entity_id` is the
 * payroll_entities.id used throughout the reconciler attribution engine.
 *
 * Rates are stored in basis points (integer) to keep all downstream math in
 * integers — 8.625% = 8625 bps, 8.75% = 8750 bps.
 */

export interface StoreTaxMapping {
  /** Shopify POS location id (recon_shopify_sales.pos_location_id). */
  store_id: string;
  name: string;
  county: string;
  state: string;
  /** Combined state+local rate in basis points (8.625% = 8625). */
  rate_bps: number;
  /** payroll_entities.id used by the attribution engine. */
  entity_id: number;
  /**
   * Last NY-month (YYYY-MM) the store had normal activity. null = open/active.
   * Hempstead closed after April 2026 — kept visible (surfaced as $0 / closed),
   * never filtered out, and any post-close activity should be flagged.
   */
  closed_after_month: string | null;
}

export const STORE_TAX_MAPPING: StoreTaxMapping[] = [
  {
    store_id: "63208882365",
    name: "Greenvale",
    county: "Nassau",
    state: "NY",
    rate_bps: 8625,
    entity_id: 1,
    closed_after_month: null,
  },
  {
    store_id: "82273140978",
    name: "Huntington",
    county: "Suffolk",
    state: "NY",
    rate_bps: 8750,
    entity_id: 2,
    closed_after_month: null,
  },
  {
    store_id: "82273206514",
    name: "Hempstead",
    county: "Nassau",
    state: "NY",
    rate_bps: 8625,
    entity_id: 3,
    closed_after_month: "2026-04",
  },
];

/** Lookup helpers (entity_id and store_id are both 1:1 unique). */
export function mappingByEntityId(entityId: number): StoreTaxMapping | undefined {
  return STORE_TAX_MAPPING.find((m) => m.entity_id === entityId);
}

export function mappingByStoreId(storeId: string): StoreTaxMapping | undefined {
  return STORE_TAX_MAPPING.find((m) => m.store_id === storeId);
}

/**
 * Is the given store closed as of (i.e. strictly after) the given NY month?
 * "2026-05" > "2026-04" → closed. Month strings are zero-padded YYYY-MM so a
 * plain string compare is a correct chronological compare.
 */
export function isStoreClosedForMonth(m: StoreTaxMapping, month: string): boolean {
  if (!m.closed_after_month) return false;
  return month > m.closed_after_month;
}
