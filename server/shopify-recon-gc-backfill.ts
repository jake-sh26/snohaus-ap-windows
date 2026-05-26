/**
 * PR #123 — Gift card identity historical backfill.
 *
 * Walks recon_orders + recon_line_items for any gift-card sale (POS or
 * online, digital or physical) that does NOT already have a corresponding
 * row in recon_gift_card_issuance, and writes one. The backfill marks
 * every row it inserts with `backfilled_at = now()` so the redemption flow
 * knows to suppress cross-entity JE generation for these cards (the
 * historical per-store liability was never tracked accurately, so a
 * retroactive JE would just shift a phantom number around).
 *
 * Idempotency: the underlying assignGcIssuance / recordPosGcIssuance helpers
 * use ON CONFLICT(order_id, line_item_id) DO NOTHING, so re-running this
 * over the same period is a no-op for rows already present.
 *
 * The chronological order matters for the cascade — customer_affinity and
 * email_affinity both read from recon_allocations, which is populated by
 * the regular allocator runs. Backfill assumes the allocator has already
 * run for the period (so prior_count queries can find allocated entities
 * for past orders).
 */

import { sqlite } from "./storage";
import {
  assignGcIssuance,
  recordPosGcIssuance,
  type GcAssignmentMethod,
} from "./shopify-recon-gc-issuance";
import { recordIntegrationWarn } from "./error-log";

function srWarn(scope: string, msg: string) {
  recordIntegrationWarn("shopify-recon", scope, msg);
}

// ----- Location → entity map (POS sales) ----------------------------------
// Mirrors the allocator's buildLocationToEntityMap. We re-derive it here
// instead of exporting from the allocator so the backfill stays a leaf
// module with no upstream dependency on the hot-path allocator.

type LocationEntityHit = { entity_id: number; kind: string };

function buildLocationToEntityMap(): Map<string, LocationEntityHit> {
  const map = new Map<string, LocationEntityHit>();
  const rows = sqlite
    .prepare(
      `SELECT shopify_location_id, entity_id, kind
       FROM recon_entity_pos_locations
       WHERE active = 1 AND shopify_location_id IS NOT NULL`
    )
    .all() as Array<{ shopify_location_id: string; entity_id: number; kind: string }>;
  for (const r of rows) {
    map.set(r.shopify_location_id, { entity_id: r.entity_id, kind: r.kind });
  }
  return map;
}

// ----- Candidate query ----------------------------------------------------
// Pulls every gift-card line item in the date range that does NOT already
// have an issuance row. We LEFT JOIN to recon_gift_card_issuance so the
// "missing" check happens in SQL — no in-memory diff.

type CandidateRow = {
  order_id: string;
  line_item_id: string;
  face_value: number;
  is_gift_card: number;
  requires_shipping: number;
  source_name: string | null;
  location_id: string | null;
  customer_id: string | null;
  customer_email: string | null;
  billing_zip: string | null;
  shipping_zip: string | null;
  order_created_at: string;
};

function listCandidates(sinceIso: string, untilIso: string): CandidateRow[] {
  return sqlite
    .prepare(
      `SELECT
         li.order_id      AS order_id,
         li.id            AS line_item_id,
         COALESCE(li.line_subtotal,
                  (li.price * li.quantity) - COALESCE(li.total_discount, 0)) AS face_value,
         li.is_gift_card  AS is_gift_card,
         li.requires_shipping AS requires_shipping,
         o.source_name    AS source_name,
         o.location_id    AS location_id,
         o.customer_id    AS customer_id,
         o.customer_email AS customer_email,
         o.billing_zip    AS billing_zip,
         o.shipping_zip   AS shipping_zip,
         o.created_at     AS order_created_at
       FROM recon_line_items li
       JOIN recon_orders o ON o.id = li.order_id
       LEFT JOIN recon_gift_card_issuance gi
         ON gi.order_id = li.order_id AND gi.line_item_id = li.id
       WHERE li.is_gift_card = 1
         AND o.created_at >= ?
         AND o.created_at < ?
         AND gi.order_id IS NULL
       ORDER BY o.created_at ASC`
    )
    .all(sinceIso, untilIso) as CandidateRow[];
}

// ----- Public API ---------------------------------------------------------

export type BackfillResult = {
  candidates_scanned: number;
  identity_rows_written: number;
  by_method: Record<GcAssignmentMethod, number>;
  pos_unmapped: number;        // POS line whose location_id didn't map to an entity
  failed_assignments: number;  // cascade returned assigned_entity_id=0 (no SD configured)
  errors: number;
  range: { since: string; until: string };
};

export function backfillGcIdentityForRange(
  sinceIso: string,
  untilIso: string,
): BackfillResult {
  const candidates = listCandidates(sinceIso, untilIso);
  const locationMap = buildLocationToEntityMap();
  const result: BackfillResult = {
    candidates_scanned: candidates.length,
    identity_rows_written: 0,
    by_method: {
      pos: 0,
      customer_affinity: 0,
      email_affinity: 0,
      zip_radius: 0,
      fallback_sd: 0,
    },
    pos_unmapped: 0,
    failed_assignments: 0,
    errors: 0,
    range: { since: sinceIso, until: untilIso },
  };

  for (const c of candidates) {
    try {
      const isPos = (c.source_name || "").toLowerCase() === "pos" && c.location_id;
      let methodWritten: GcAssignmentMethod;

      if (isPos) {
        // POS branch — assign to the selling location's entity.
        const hit = locationMap.get(c.location_id!);
        if (!hit) {
          // POS sale at an unmapped location — fall through to cascade so
          // the row still gets an identity, but flag the count so we can
          // investigate. We use assignGcIssuance because the location is
          // unknown — the cascade will pick best-effort.
          result.pos_unmapped++;
          const issuance = assignGcIssuance({
            order_id: c.order_id,
            line_item_id: c.line_item_id,
            face_value: c.face_value,
            customer_id: c.customer_id,
            customer_email: c.customer_email,
            billing_zip: c.billing_zip,
            shipping_zip: c.shipping_zip,
            order_created_at: c.order_created_at,
            backfilled: true,
          });
          methodWritten = issuance.assignment_method;
          if (issuance.assigned_entity_id === 0) result.failed_assignments++;
        } else {
          recordPosGcIssuance({
            order_id: c.order_id,
            line_item_id: c.line_item_id,
            face_value: c.face_value,
            assigned_entity_id: hit.entity_id,
            customer_id: c.customer_id,
            billing_zip: c.billing_zip,
            shipping_zip: c.shipping_zip,
            order_created_at: c.order_created_at,
            backfilled: true,
          });
          methodWritten = "pos";
        }
      } else {
        // Online / non-POS branch — run the full cascade.
        const issuance = assignGcIssuance({
          order_id: c.order_id,
          line_item_id: c.line_item_id,
          face_value: c.face_value,
          customer_id: c.customer_id,
          customer_email: c.customer_email,
          billing_zip: c.billing_zip,
          shipping_zip: c.shipping_zip,
          order_created_at: c.order_created_at,
          backfilled: true,
        });
        methodWritten = issuance.assignment_method;
        if (issuance.assigned_entity_id === 0) result.failed_assignments++;
      }

      result.identity_rows_written++;
      result.by_method[methodWritten] = (result.by_method[methodWritten] ?? 0) + 1;
    } catch (e: any) {
      result.errors++;
      srWarn(
        "gc-identity-backfill",
        `order=${c.order_id} line=${c.line_item_id}: ${e?.message ?? e}`,
      );
    }
  }

  return result;
}

// ----- Diagnostic ---------------------------------------------------------

export type GcIdentityDistribution = {
  total_issuance_rows: number;
  total_face_value: number;
  by_method: Array<{ method: string; count: number; face_value: number }>;
  by_entity: Array<{ entity_id: number; entity_location: string | null; count: number; face_value: number }>;
  by_backfill_status: Array<{ backfilled: 0 | 1; count: number; face_value: number }>;
  // The redemption flow's expected behavior on each card if redeemed cross-store
  // on/after the cutover: 'would_emit_je' (live identity) vs. 'suppressed_backfilled'.
  je_eligibility: { would_emit_je: number; suppressed_backfilled: number };
};

export function getGcIdentityDistribution(): GcIdentityDistribution {
  const total = sqlite
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(face_value), 0) AS total_face_value
       FROM recon_gift_card_issuance`
    )
    .get() as { count: number; total_face_value: number };
  const by_method = sqlite
    .prepare(
      `SELECT assignment_method AS method, COUNT(*) AS count,
              COALESCE(SUM(face_value), 0) AS face_value
       FROM recon_gift_card_issuance
       GROUP BY assignment_method
       ORDER BY face_value DESC`
    )
    .all() as Array<{ method: string; count: number; face_value: number }>;
  const by_entity = sqlite
    .prepare(
      `SELECT i.assigned_entity_id AS entity_id,
              e.location           AS entity_location,
              COUNT(*)             AS count,
              COALESCE(SUM(i.face_value), 0) AS face_value
       FROM recon_gift_card_issuance i
       LEFT JOIN payroll_entities e ON e.id = i.assigned_entity_id
       GROUP BY i.assigned_entity_id, e.location
       ORDER BY face_value DESC`
    )
    .all() as Array<{ entity_id: number; entity_location: string | null; count: number; face_value: number }>;
  const by_backfill_status = sqlite
    .prepare(
      `SELECT
         CASE WHEN backfilled_at IS NULL THEN 0 ELSE 1 END AS backfilled,
         COUNT(*) AS count,
         COALESCE(SUM(face_value), 0) AS face_value
       FROM recon_gift_card_issuance
       GROUP BY backfilled
       ORDER BY backfilled ASC`
    )
    .all() as Array<{ backfilled: 0 | 1; count: number; face_value: number }>;
  const wouldEmit = by_backfill_status.find(r => r.backfilled === 0)?.count ?? 0;
  const suppressed = by_backfill_status.find(r => r.backfilled === 1)?.count ?? 0;
  return {
    total_issuance_rows: Number(total.count ?? 0),
    total_face_value: Number(total.total_face_value ?? 0),
    by_method,
    by_entity,
    by_backfill_status,
    je_eligibility: { would_emit_je: wouldEmit, suppressed_backfilled: suppressed },
  };
}
