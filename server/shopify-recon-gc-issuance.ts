/**
 * PR #R4d (extended by PR #123) — gift card issuance allocator.
 *
 * When a line item is identified as a gift-card SALE (not a redemption), we
 * decide which entity gets credit for the sale via this cascade:
 *
 *   0. pos (PR #123): if the order is a POS sale at a mapped store, the
 *      issuance assigns to that store's entity directly. POS GC sales never
 *      run the cascade — the location IS the answer. We still write the
 *      identity row so a later cross-store redemption can find the issuer.
 *      Callers use recordPosGcIssuance() for this path, NOT assignGcIssuance().
 *
 *   1. customer_affinity: count prior orders for this customer_id grouped by
 *      their already-allocated entity (recon_orders ⋈ recon_allocations).
 *      Highest count wins. Tiebreaker (PR #123): on a tie, pick the entity
 *      attached to the customer's MOST RECENT prior order. Threshold ≥1
 *      prior order.
 *
 *   2. email_affinity (PR #123): when customer_id is null (guest checkout),
 *      look up other orders for this trimmed/lowercased email across all
 *      time. Same group/count/tiebreaker logic as customer_affinity.
 *
 *   3. zip_radius: parse customer billing ZIP (fall back to shipping ZIP).
 *      Compute haversine distance to each store ZIP. Closest store wins.
 *      No distance cap — the redemption ledger corrects intercompany later.
 *
 *   4. fallback_sd: Greenvale catches everything else.
 *
 * Idempotency: once an issuance row exists for (order_id, line_item_id), we
 * do NOT reassign it on subsequent allocation runs. GC entity assignments
 * are committed once — flipping them retroactively would move revenue
 * between books, which is exactly what reconciliation is meant to prevent.
 *
 * PR #123 — backfilled_at flag: the historical backfill route sets
 * backfilled_at=now() on every row it writes. The redemption flow inspects
 * this column when generating cross-entity JEs: if the issuance row is
 * marked backfilled, the redemption is recorded but the 3-leg inter-company
 * JE is suppressed (per-store liability was never tracked correctly
 * historically, so shifting phantom numbers around just creates noise).
 *
 * This module is separate from shopify-recon-allocator.ts because:
 *   (a) the cascade has its own state (the issuance ledger) that has to be
 *       read AND written, vs. the allocator which only writes,
 *   (b) the ZIP-coord and store-coord constants are issuance-specific and
 *       don't belong in the main allocator's hot path.
 */

import { sqlite, listPayrollEntities } from "./storage";
import zipCoordsRaw from "./data/zip-coords.json" with { type: "json" };

// ----- types -----

export type GcAssignmentMethod =
  | "pos"               // PR #123 — POS-sold physical card; assigned to selling location's entity
  | "customer_affinity"
  | "email_affinity"    // PR #123 — guest-checkout fallback by trimmed/lowercased email
  | "zip_radius"
  | "fallback_sd";

export type GcIssuanceResult = {
  assigned_entity_id: number;
  assignment_method: GcAssignmentMethod;
  assignment_distance_mi: number | null;
  reason: string;
};

/** PR #123 — cutover date. Cross-entity GC redemption JEs are only generated
 *  for redemptions on/after this date AND only when the underlying GC issuance
 *  row was NOT written by the historical backfill (i.e. backfilled_at IS NULL).
 *  See the redemption flow in shopify-recon-gc-redemption.ts. */
export const GC_JE_CUTOVER_ISO = "2026-06-01T00:00:00Z";

// ----- ZIP coord lookup -----

// JSON file has a `_metadata` key followed by `"ZIP": {lat, lng}` entries.
// Filter the metadata key out so callers can iterate freely.
type ZipEntry = { lat: number; lng: number };
const ZIP_COORDS: Record<string, ZipEntry> = (() => {
  const out: Record<string, ZipEntry> = {};
  for (const [k, v] of Object.entries(zipCoordsRaw as Record<string, any>)) {
    if (k === "_metadata") continue;
    if (v && typeof v.lat === "number" && typeof v.lng === "number") {
      out[k] = { lat: v.lat, lng: v.lng };
    }
  }
  return out;
})();

function lookupZipCoords(zip: string | null): ZipEntry | null {
  if (!zip) return null;
  const z5 = zip.trim().slice(0, 5);
  if (z5.length < 5) return null;
  return ZIP_COORDS[z5] ?? null;
}

// Haversine distance between two lat/lng pairs in miles.
function haversineMi(a: ZipEntry, b: ZipEntry): number {
  const R = 3958.8; // Earth radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ----- store ZIP → entity resolution -----
// We learn the entity per store from payroll_entities.location keyword match.
// The store ZIPs themselves are documented in zip-coords.json metadata.

type StoreEntity = { entity_id: number; zip: string; coords: ZipEntry; label: string };

function loadStoreEntities(): StoreEntity[] {
  const entities = listPayrollEntities();
  const stores: StoreEntity[] = [];

  // Greenvale (SD): 11548
  const sd = entities.find(e => (e.location || "").toLowerCase().includes("greenvale"));
  if (sd) {
    const c = ZIP_COORDS["11548"];
    if (c) stores.push({ entity_id: sd.id, zip: "11548", coords: c, label: "Greenvale" });
  }
  // SH Huntington: 11746
  const hunt = entities.find(e => (e.location || "").toLowerCase().includes("huntington"));
  if (hunt) {
    const c = ZIP_COORDS["11746"];
    if (c) stores.push({ entity_id: hunt.id, zip: "11746", coords: c, label: "Huntington" });
  }
  // SH Hempstead: 11550
  const hemp = entities.find(e => (e.location || "").toLowerCase().includes("hempstead"));
  if (hemp) {
    const c = ZIP_COORDS["11550"];
    if (c) stores.push({ entity_id: hemp.id, zip: "11550", coords: c, label: "Hempstead" });
  }

  return stores;
}

function getSdEntityId(): number | null {
  const entities = listPayrollEntities();
  const sd = entities.find(e => (e.location || "").toLowerCase().includes("greenvale"));
  return sd?.id ?? null;
}

// ----- cascade -----

/**
 * Look up whether this (order_id, line_item_id) already has a committed
 * issuance assignment. If so the caller should preserve it (idempotency).
 */
export function getExistingGcIssuance(
  orderId: string,
  lineItemId: string,
): { assigned_entity_id: number; assignment_method: GcAssignmentMethod } | null {
  const row = sqlite
    .prepare(
      `SELECT assigned_entity_id, assignment_method
       FROM recon_gift_card_issuance
       WHERE order_id = ? AND line_item_id = ?`
    )
    .get(orderId, lineItemId) as
      | { assigned_entity_id: number; assignment_method: GcAssignmentMethod }
      | undefined;
  return row ?? null;
}

/**
 * Step 1: customer_affinity. Count prior orders for this customer grouped by
 * the entity that won their previous allocation. Highest count wins; on a
 * tie (PR #123) pick whichever entity is attached to the customer's most
 * recent prior order — fewer coin flips, more deterministic books.
 *
 * "Prior" = orders created before this one. We compare on created_at to
 * avoid self-counting when the engine re-runs over the same month.
 */
function tryCustomerAffinity(
  customerId: string | null,
  orderCreatedAt: string,
): { entity_id: number; prior_count: number; tiebroken: boolean } | null {
  if (!customerId) return null;
  return tryAffinityForFilter(
    `o.customer_id = ?`,
    [customerId],
    orderCreatedAt,
  );
}

/**
 * Step 2: email_affinity (PR #123). Guest-checkout fallback for when the
 * online GC purchase has no customer_id (Shopify only attaches customer_id
 * if the buyer logs in; pure guest checkouts have null). We match by
 * trimmed/lowercased customer_email across recon_orders and run the same
 * count + tiebreaker logic as customer_affinity.
 */
function tryEmailAffinity(
  customerEmail: string | null,
  orderCreatedAt: string,
): { entity_id: number; prior_count: number; tiebroken: boolean } | null {
  if (!customerEmail) return null;
  const norm = customerEmail.trim().toLowerCase();
  if (!norm) return null;
  return tryAffinityForFilter(
    `LOWER(TRIM(o.customer_email)) = ?`,
    [norm],
    orderCreatedAt,
  );
}

/**
 * Shared affinity backbone for customer_id and email_affinity. Runs the
 * GROUP BY entity_id with prior_count; on tie, runs a second query to find
 * the entity attached to the most-recent prior order matching the same
 * filter. Returns null when no prior orders match.
 */
function tryAffinityForFilter(
  whereClause: string,
  bindParams: any[],
  orderCreatedAt: string,
): { entity_id: number; prior_count: number; tiebroken: boolean } | null {
  const rows = sqlite
    .prepare(
      `SELECT a.entity_id, COUNT(DISTINCT a.order_id) AS prior_count
       FROM recon_allocations a
       JOIN recon_orders o ON o.id = a.order_id
       WHERE ${whereClause}
         AND o.created_at < ?
         AND a.method IN ('pos_location', 'fulfillment_location', 'manual_override')
       GROUP BY a.entity_id
       ORDER BY prior_count DESC, a.entity_id ASC`
    )
    .all(...bindParams, orderCreatedAt) as Array<{ entity_id: number; prior_count: number }>;
  if (rows.length === 0) return null;
  if (rows[0].prior_count < 1) return null;
  // No tie — clear winner.
  if (rows.length === 1 || rows[0].prior_count !== rows[1].prior_count) {
    return { entity_id: rows[0].entity_id, prior_count: rows[0].prior_count, tiebroken: false };
  }
  // Tie — pick the entity attached to the most-recent prior order. We
  // restrict the tiebreaker pool to the entities that tied at the top so a
  // recent order from an unrelated entity (somehow scoring 0 prior_count)
  // can't influence the pick.
  const topCount = rows[0].prior_count;
  const tiedEntityIds = rows
    .filter(r => r.prior_count === topCount)
    .map(r => r.entity_id);
  const placeholders = tiedEntityIds.map(() => "?").join(",");
  const mostRecent = sqlite
    .prepare(
      `SELECT a.entity_id
       FROM recon_allocations a
       JOIN recon_orders o ON o.id = a.order_id
       WHERE ${whereClause}
         AND o.created_at < ?
         AND a.method IN ('pos_location', 'fulfillment_location', 'manual_override')
         AND a.entity_id IN (${placeholders})
       ORDER BY o.created_at DESC
       LIMIT 1`
    )
    .get(...bindParams, orderCreatedAt, ...tiedEntityIds) as { entity_id: number } | undefined;
  if (!mostRecent) {
    // Should never happen — the GROUP BY just returned these rows. Fail
    // safe: pick the lowest entity_id for determinism.
    return { entity_id: tiedEntityIds[0], prior_count: topCount, tiebroken: true };
  }
  return { entity_id: mostRecent.entity_id, prior_count: topCount, tiebroken: true };
}

/**
 * Step 2: zip_radius. Find the closest store by haversine. Returns null if
 * the customer's ZIP isn't in our coord table (caller falls to step 3).
 */
function tryZipRadius(
  billingZip: string | null,
  shippingZip: string | null,
): { entity_id: number; distance_mi: number; zip: string; store_label: string } | null {
  const zip = billingZip || shippingZip;
  const customerCoords = lookupZipCoords(zip);
  if (!customerCoords || !zip) return null;
  const stores = loadStoreEntities();
  if (stores.length === 0) return null;

  let best: { entity_id: number; distance_mi: number; zip: string; store_label: string } | null = null;
  for (const s of stores) {
    const d = haversineMi(customerCoords, s.coords);
    if (!best || d < best.distance_mi) {
      best = { entity_id: s.entity_id, distance_mi: d, zip: zip.trim().slice(0, 5), store_label: s.label };
    }
  }
  return best;
}

/**
 * Run the full cascade for one GC issuance. Reads existing issuance row first
 * — if found, returns it unchanged (idempotent). Otherwise picks an entity
 * and writes the row.
 */
export function assignGcIssuance(args: {
  order_id: string;
  line_item_id: string;
  face_value: number;
  customer_id: string | null;
  customer_email?: string | null;  // PR #123 — guest-checkout fallback
  billing_zip: string | null;
  shipping_zip: string | null;
  order_created_at: string;
  gc_id?: string | null;
  backfilled?: boolean;  // PR #123 — mark rows written by the historical backfill route
}): GcIssuanceResult {
  // Idempotency check — never flip a committed assignment.
  const existing = getExistingGcIssuance(args.order_id, args.line_item_id);
  if (existing) {
    return {
      assigned_entity_id: existing.assigned_entity_id,
      assignment_method: existing.assignment_method,
      assignment_distance_mi: null,
      reason: `GC issuance preserved (${existing.assignment_method}) — already committed`,
    };
  }

  let result: GcIssuanceResult | null = null;

  // 1) customer_affinity
  const aff = tryCustomerAffinity(args.customer_id, args.order_created_at);
  if (aff) {
    const tiebrokenNote = aff.tiebroken ? "; tiebreaker=most_recent_order" : "";
    result = {
      assigned_entity_id: aff.entity_id,
      assignment_method: "customer_affinity",
      assignment_distance_mi: null,
      reason: `GC → entity ${aff.entity_id} via customer affinity (${aff.prior_count} prior orders${tiebrokenNote})`,
    };
  }

  // 2) email_affinity (PR #123) — guest-checkout fallback when customer_id
  //    is null. Skipped automatically when customer_email is empty.
  if (!result) {
    const em = tryEmailAffinity(args.customer_email ?? null, args.order_created_at);
    if (em) {
      const tiebrokenNote = em.tiebroken ? "; tiebreaker=most_recent_order" : "";
      result = {
        assigned_entity_id: em.entity_id,
        assignment_method: "email_affinity",
        assignment_distance_mi: null,
        reason: `GC → entity ${em.entity_id} via email affinity (${em.prior_count} prior orders${tiebrokenNote})`,
      };
    }
  }

  // 3) zip_radius
  if (!result) {
    const rad = tryZipRadius(args.billing_zip, args.shipping_zip);
    if (rad) {
      result = {
        assigned_entity_id: rad.entity_id,
        assignment_method: "zip_radius",
        assignment_distance_mi: Number(rad.distance_mi.toFixed(2)),
        reason: `GC → ${rad.store_label} via ZIP radius (zip=${rad.zip}, ${rad.distance_mi.toFixed(1)}mi)`,
      };
    }
  }

  // 4) fallback_sd
  if (!result) {
    const sd = getSdEntityId();
    if (sd) {
      result = {
        assigned_entity_id: sd,
        assignment_method: "fallback_sd",
        assignment_distance_mi: null,
        reason: `GC → SD/Greenvale (no customer affinity, no ZIP match)`,
      };
    } else {
      // No SD entity configured — return entity_id=0 with method=fallback_sd
      // so the row at least gets written and the UI can surface the warning.
      result = {
        assigned_entity_id: 0,
        assignment_method: "fallback_sd",
        assignment_distance_mi: null,
        reason: `GC fallback failed — no Greenvale entity found`,
      };
    }
  }

  // Persist the issuance row.
  const now = new Date().toISOString();
  const customerZip = args.billing_zip || args.shipping_zip || null;
  const backfilledAt = args.backfilled ? now : null;
  sqlite
    .prepare(
      `INSERT INTO recon_gift_card_issuance
         (gc_id, order_id, line_item_id, face_value, assigned_entity_id,
          assignment_method, assignment_distance_mi, customer_id, customer_zip,
          remaining, issued_at, created_at, backfilled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id, line_item_id) DO NOTHING`
    )
    .run(
      args.gc_id ?? null,
      args.order_id,
      args.line_item_id,
      args.face_value,
      result.assigned_entity_id,
      result.assignment_method,
      result.assignment_distance_mi,
      args.customer_id,
      customerZip,
      args.face_value, // remaining initialised to face_value
      args.order_created_at,
      now,
      backfilledAt,
    );

  return result;
}

/**
 * PR #123 — POS gift-card issuance. Called by the allocator's POS branch
 * when it sees `line.is_gift_card === 1` on a `source_name === 'pos'` order.
 *
 * Unlike assignGcIssuance() this does NOT run the cascade — the POS
 * location IS the answer. We just need to persist the identity row so a
 * later cross-store redemption of this card can find the issuer entity
 * and generate the proper 3-leg inter-company JE.
 *
 * Idempotent via ON CONFLICT(order_id, line_item_id) DO NOTHING — re-runs
 * over the same order never flip the assignment.
 */
export function recordPosGcIssuance(args: {
  order_id: string;
  line_item_id: string;
  face_value: number;
  assigned_entity_id: number;
  customer_id: string | null;
  billing_zip: string | null;
  shipping_zip: string | null;
  order_created_at: string;
  gc_id?: string | null;
  backfilled?: boolean;
}): GcIssuanceResult {
  const existing = getExistingGcIssuance(args.order_id, args.line_item_id);
  if (existing) {
    return {
      assigned_entity_id: existing.assigned_entity_id,
      assignment_method: existing.assignment_method,
      assignment_distance_mi: null,
      reason: `POS GC issuance preserved (${existing.assignment_method}) — already committed`,
    };
  }
  const now = new Date().toISOString();
  const customerZip = args.billing_zip || args.shipping_zip || null;
  const backfilledAt = args.backfilled ? now : null;
  sqlite
    .prepare(
      `INSERT INTO recon_gift_card_issuance
         (gc_id, order_id, line_item_id, face_value, assigned_entity_id,
          assignment_method, assignment_distance_mi, customer_id, customer_zip,
          remaining, issued_at, created_at, backfilled_at)
       VALUES (?, ?, ?, ?, ?, 'pos', NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id, line_item_id) DO NOTHING`
    )
    .run(
      args.gc_id ?? null,
      args.order_id,
      args.line_item_id,
      args.face_value,
      args.assigned_entity_id,
      args.customer_id,
      customerZip,
      args.face_value,
      args.order_created_at,
      now,
      backfilledAt,
    );
  return {
    assigned_entity_id: args.assigned_entity_id,
    assignment_method: "pos",
    assignment_distance_mi: null,
    reason: `POS GC → entity ${args.assigned_entity_id} via selling location`,
  };
}

/**
 * PR #123 — lookup helper for the redemption flow. Returns issuance metadata
 * needed to decide whether a cross-entity JE should be generated.
 */
export function getGcIssuanceByGcId(gcId: string): {
  assigned_entity_id: number;
  assignment_method: GcAssignmentMethod;
  backfilled_at: string | null;
  issued_at: string;
} | null {
  const row = sqlite
    .prepare(
      `SELECT assigned_entity_id, assignment_method, backfilled_at, issued_at
       FROM recon_gift_card_issuance
       WHERE gc_id = ?
       ORDER BY issued_at DESC
       LIMIT 1`
    )
    .get(gcId) as
      | { assigned_entity_id: number; assignment_method: GcAssignmentMethod; backfilled_at: string | null; issued_at: string }
      | undefined;
  return row ?? null;
}

/**
 * Read-only ledger view for the UI / sanity-checks.
 */
export type GcIssuanceLedgerRow = {
  order_id: string;
  order_name: string | null;
  line_item_id: string | null;
  face_value: number;
  assigned_entity_id: number;
  entity_location: string | null;
  assignment_method: GcAssignmentMethod;
  assignment_distance_mi: number | null;
  customer_id: string | null;
  customer_zip: string | null;
  remaining: number;
  issued_at: string;
};

export function listGcIssuanceLedger(limit = 200): GcIssuanceLedgerRow[] {
  return sqlite
    .prepare(
      `SELECT
         i.order_id, o.name AS order_name, i.line_item_id, i.face_value,
         i.assigned_entity_id, e.location AS entity_location,
         i.assignment_method, i.assignment_distance_mi,
         i.customer_id, i.customer_zip, i.remaining, i.issued_at
       FROM recon_gift_card_issuance i
       LEFT JOIN recon_orders o ON o.id = i.order_id
       LEFT JOIN payroll_entities e ON e.id = i.assigned_entity_id
       ORDER BY i.issued_at DESC
       LIMIT ?`
    )
    .all(Math.min(1000, Math.max(1, limit))) as GcIssuanceLedgerRow[];
}
