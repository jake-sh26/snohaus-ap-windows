/**
 * PR #R4e — Gift card redemption tracking + cross-entity JE generation.
 *
 * Read-only (Phase 1): generates records into recon_gift_card_redemptions
 * and recon_inter_company_journal_entries. NO QBO posting, NO bank ops.
 * The JE ledger is what will eventually post once Jake validates the math.
 *
 * Worked examples (matches Jake's correction — issuer owes redeemer):
 *
 *   Example 1 — same-entity:
 *     SD issues a $100 GC. Customer comes back, SD redeems $80.
 *     recon_gift_card_redemptions: 1 row, is_cross_entity=0, amount=80
 *     recon_inter_company_journal_entries: 1 row
 *       entity=SD, role=gift_cards_outstanding, side=DR, amount=80
 *     (Revenue/COGS/sales_tax CR side is already booked by the regular
 *     allocation flow — we do NOT duplicate it here.)
 *
 *   Example 2 — cross-entity:
 *     SD issues a $200 GC. Customer redeems $150 at Hempstead.
 *     SD originally collected the $200 cash; Hempstead now delivered $150
 *     of goods funded by that cash → SD owes Hempstead $150.
 *     recon_gift_card_redemptions: 1 row, is_cross_entity=1, amount=150
 *     recon_inter_company_journal_entries: 3 rows
 *       entity=SD,        role=gift_cards_outstanding, side=DR, amount=150
 *       entity=SD,        role=due_to_sh_hempstead,    side=CR, amount=150
 *       entity=Hempstead, role=due_from_sd,            side=DR, amount=150
 *
 * Idempotency: redemptions UNIQUE on (gc_id, order_id, transaction_id);
 * JE legs UNIQUE on (source_kind, source_id, entity_id, account_role, side).
 * Re-running a rebuild over the same period writes zero new rows.
 */

import {
  sqlite,
  listPayrollEntities,
  upsertGiftCardRedemption,
  upsertInterCompanyJE,
  getRedemptionsByOrder,
  type GcRedemptionRow,
} from "./storage";
import { recordIntegrationWarn } from "./error-log";
import { getGcIssuanceByGcId, GC_JE_CUTOVER_ISO } from "./shopify-recon-gc-issuance";

function srWarn(scope: string, msg: string) {
  recordIntegrationWarn("shopify-recon", scope, msg);
}

// ----- Entity slug resolution ---------------------------------------------
// Lookup table built on demand from payroll_entities. We use the same
// keyword match as the rest of the reconciler (`shape()` in storage.ts) so
// "SH Huntington" / "SH Hempstead" / "SD Ski (Greenvale)" all collapse to
// stable slugs that map onto the CoA role enum.

export type EntitySlug = "sd" | "sh_hempstead" | "sh_huntington";

function entitySlugFor(entityLocation: string | null | undefined): EntitySlug | null {
  if (!entityLocation) return null;
  const l = entityLocation.toLowerCase();
  if (l.includes("greenvale")) return "sd";
  if (l.includes("hempstead")) return "sh_hempstead";
  if (l.includes("huntington")) return "sh_huntington";
  return null;
}

type EntityIndexEntry = { id: number; slug: EntitySlug };

function buildEntityIndex(): Map<number, EntityIndexEntry> {
  const out = new Map<number, EntityIndexEntry>();
  for (const e of listPayrollEntities()) {
    const slug = entitySlugFor(e.location);
    if (slug) out.set(e.id, { id: e.id, slug });
  }
  return out;
}

/**
 * Returns the CoA logical-role name for an inter-company leg.
 *   intercoRoleFor("sd", "sh_hempstead", "to")   -> "due_to_sh_hempstead"
 *   intercoRoleFor("sh_hempstead", "sd", "from") -> "due_from_sd"
 *
 * All combinations needed by the redemption JE flow exist in the
 * RECON_COA_LOGICAL_ROLES enum (we added the reverse-direction roles in
 * this PR alongside this module). The function does NOT validate that the
 * counterparty makes sense — callers are responsible for only generating
 * legs between entities the chart of accounts supports.
 */
export function intercoRoleFor(
  source: EntitySlug,
  counterparty: EntitySlug,
  direction: "to" | "from",
): string {
  return `due_${direction}_${counterparty}`;
}

// ----- Allocation lookup --------------------------------------------------
// The redeemer entity for a given order is whichever entity holds the
// biggest allocation slice on that order. For single-entity orders that's
// trivially the only allocation row; for multi-entity orders (rare — only
// digital GC sales currently split, and those don't generate redemptions)
// we take the largest gross_amount as the redeemer's "primary" entity.

function lookupRedeemerEntity(orderId: string): number | null {
  const row = sqlite
    .prepare(
      `SELECT entity_id, SUM(gross_amount) AS total
       FROM recon_allocations
       WHERE order_id = ?
         AND method != 'needs_review'
       GROUP BY entity_id
       ORDER BY total DESC
       LIMIT 1`
    )
    .get(orderId) as { entity_id: number; total: number } | undefined;
  return row?.entity_id ?? null;
}

// PR #123 — lookupIssuerEntity was inlined into processOrderForGCRedemption
// alongside the new backfilled_at / cutover suppression logic. Use
// getGcIssuanceByGcId from shopify-recon-gc-issuance.ts to fetch the full
// issuance metadata (issuer entity + backfilled_at + assignment_method).

// ----- Transaction extraction --------------------------------------------
// Shopify reports a GC redemption as one row in order.transactions[] with
// gateway='gift_card'. The gift_card id is on receipt.gift_card_id (newer
// API) or sometimes on the top-level receipt — we check both. amount is a
// stringified decimal that we coerce to number.

type GcTxn = {
  transaction_id: string | null;
  gc_id: string;
  amount: number;
};

function extractGcTransactions(orderData: any): GcTxn[] {
  const txns = Array.isArray(orderData?.transactions) ? orderData.transactions : [];
  const out: GcTxn[] = [];
  for (const t of txns) {
    if (t?.gateway !== "gift_card") continue;
    // Only count successful captures/sales — pending / failure / void don't
    // settle a card. Shopify uses status='success' for the redemption row.
    if (t?.status && t.status !== "success") continue;
    // Refund transactions for a GC have kind='refund' and would reverse the
    // redemption; out of scope for R4e (they'd subtract from amount in the
    // ledger, but our current allocator skips refund flow entirely).
    if (t?.kind === "refund") continue;
    const gcId =
      t?.receipt?.gift_card_id != null
        ? String(t.receipt.gift_card_id)
        : t?.gift_card_id != null
          ? String(t.gift_card_id)
          : null;
    if (!gcId) continue;
    const amt = typeof t.amount === "number" ? t.amount : parseFloat(String(t.amount));
    if (!Number.isFinite(amt) || amt <= 0) continue;
    out.push({
      transaction_id: t?.id != null ? String(t.id) : null,
      gc_id: gcId,
      amount: amt,
    });
  }
  return out;
}

// ----- JE generation ------------------------------------------------------

/**
 * Emit the JE legs for one redemption row. Idempotent at the leg level via
 * the unique key on (source_kind, source_id, entity_id, account_role, side).
 *
 * Returns the number of legs UPSERTED (i.e. how many INSERT-OR-IGNOREs we
 * issued). The actual write count may be lower on re-runs.
 */
export function generateRedemptionJEs(redemption: GcRedemptionRow): number {
  const entities = buildEntityIndex();
  const redeemer = entities.get(redemption.redeemer_entity_id);
  const issuer =
    redemption.issuer_entity_id != null
      ? entities.get(redemption.issuer_entity_id) ?? null
      : null;

  // If we don't know the redeemer's slug we can't pick a CoA role — bail
  // without writing JEs. The redemption row itself was still recorded so
  // we have audit history.
  if (!redeemer) {
    srWarn(
      "gc-redemption-je",
      `Redemption #${redemption.id}: redeemer entity ${redemption.redeemer_entity_id} has no slug; skipping JE generation`,
    );
    return 0;
  }

  // Same-entity (or unknown issuer): one leg only. We still mark the
  // gift_cards_outstanding liability as settled even when the issuer is
  // unknown — at minimum the redeemer's books should show the redemption.
  if (!issuer || issuer.id === redeemer.id) {
    const liabilityHolder = issuer ?? redeemer;
    upsertInterCompanyJE({
      source_kind: "gc_redemption",
      source_id: redemption.id,
      entity_id: liabilityHolder.id,
      // No real counterparty on a same-entity leg; reuse the entity itself
      // as a self-reference so the column stays NOT NULL.
      counterparty_entity_id: liabilityHolder.id,
      account_role: "gift_cards_outstanding",
      side: "DR",
      amount: redemption.amount,
      order_id: redemption.order_id,
      gc_id: redemption.gc_id,
    });
    return 1;
  }

  // Cross-entity: 3 legs.
  // Issuer's books — settle the liability and book the payable to redeemer.
  upsertInterCompanyJE({
    source_kind: "gc_redemption",
    source_id: redemption.id,
    entity_id: issuer.id,
    counterparty_entity_id: redeemer.id,
    account_role: "gift_cards_outstanding",
    side: "DR",
    amount: redemption.amount,
    order_id: redemption.order_id,
    gc_id: redemption.gc_id,
  });
  upsertInterCompanyJE({
    source_kind: "gc_redemption",
    source_id: redemption.id,
    entity_id: issuer.id,
    counterparty_entity_id: redeemer.id,
    account_role: intercoRoleFor(issuer.slug, redeemer.slug, "to"),
    side: "CR",
    amount: redemption.amount,
    order_id: redemption.order_id,
    gc_id: redemption.gc_id,
  });
  // Redeemer's books — receivable from issuer.
  upsertInterCompanyJE({
    source_kind: "gc_redemption",
    source_id: redemption.id,
    entity_id: redeemer.id,
    counterparty_entity_id: issuer.id,
    account_role: intercoRoleFor(redeemer.slug, issuer.slug, "from"),
    side: "DR",
    amount: redemption.amount,
    order_id: redemption.order_id,
    gc_id: redemption.gc_id,
  });
  return 3;
}

// ----- Order processor ----------------------------------------------------

export type ProcessOrderResult = {
  order_id: string;
  redemptions_recorded: number;
  je_legs_emitted: number;
  skipped_reason?: "no_allocation" | "no_gc_transactions";
};

/**
 * Walk an order's transactions, record any GC redemptions, and generate
 * the inter-company JE legs. Safe to re-run — both writes use INSERT OR
 * IGNORE under unique keys.
 *
 * If the order has no allocation yet (allocator hasn't run for this
 * month, or it's pending/failed), we return early without recording the
 * redemption — we don't know the redeemer entity yet and would have to
 * guess. The caller (rebuild route / allocator hook) re-runs once
 * allocation lands.
 */
export function processOrderForGCRedemption(
  orderId: string,
  orderData: any,
): ProcessOrderResult {
  const gcTxns = extractGcTransactions(orderData);
  if (gcTxns.length === 0) {
    return { order_id: orderId, redemptions_recorded: 0, je_legs_emitted: 0, skipped_reason: "no_gc_transactions" };
  }

  const redeemerEntityId = lookupRedeemerEntity(orderId);
  if (redeemerEntityId == null) {
    // Allocation hasn't run for this order yet — defer. The rebuild route
    // will catch it on the next pass; the allocator hook calls us after
    // allocation finalizes so the normal path is covered.
    return { order_id: orderId, redemptions_recorded: 0, je_legs_emitted: 0, skipped_reason: "no_allocation" };
  }

  const redeemedAt =
    orderData?.processed_at ?? orderData?.created_at ?? new Date().toISOString();

  let recorded = 0;
  let legs = 0;
  for (const txn of gcTxns) {
    // PR #123 — fetch full issuance metadata so we can suppress JE generation
    // for backfilled cards and for redemptions before the cutover.
    const issuance = getGcIssuanceByGcId(txn.gc_id);
    const issuerEntityId = issuance?.assigned_entity_id ?? null;
    if (issuerEntityId == null) {
      srWarn(
        "gc-redemption",
        `Order ${orderId} redeems gc ${txn.gc_id} but no issuance row found; recording with issuer=null`,
      );
    }
    const isCrossEntity: 0 | 1 =
      issuerEntityId != null && issuerEntityId !== redeemerEntityId ? 1 : 0;
    const redemption = upsertGiftCardRedemption({
      gc_id: txn.gc_id,
      order_id: orderId,
      transaction_id: txn.transaction_id,
      amount: txn.amount,
      issuer_entity_id: issuerEntityId,
      redeemer_entity_id: redeemerEntityId,
      is_cross_entity: isCrossEntity,
      redeemed_at: redeemedAt,
    });
    recorded++;

    // PR #123 — cross-entity JE suppression rules:
    //   (1) The redemption is BEFORE the cutover (GC_JE_CUTOVER_ISO), OR
    //   (2) The underlying issuance row was written by the historical
    //       backfill (backfilled_at IS NOT NULL).
    // In both cases the redemption itself is still recorded for audit, but
    // the 3-leg inter-company JE is skipped. We log a single info-level
    // warning per suppression so the suppression chain is traceable.
    const preCutover = redeemedAt < GC_JE_CUTOVER_ISO;
    const backfilledIssuance = issuance?.backfilled_at != null;
    if (isCrossEntity && (preCutover || backfilledIssuance)) {
      const why = preCutover ? "pre-cutover redemption" : "backfilled issuance";
      srWarn(
        "gc-redemption-je",
        `Redemption #${redemption.id}: cross-entity JE suppressed (${why}); gc=${txn.gc_id} order=${orderId} amount=${txn.amount}`,
      );
      continue;
    }

    legs += generateRedemptionJEs(redemption);
  }

  return { order_id: orderId, redemptions_recorded: recorded, je_legs_emitted: legs };
}

/**
 * Rebuild redemptions over a date range. Pulls every order in [since, until)
 * from recon_orders (where we have a stored raw_json) and re-processes it.
 * Idempotent — runs over the same period back-to-back are no-ops.
 */
export function rebuildRedemptionsForRange(
  sinceIso: string,
  untilIso: string,
): {
  orders_scanned: number;
  redemptions_recorded: number;
  je_legs_emitted: number;
  orders_deferred: number;
  errors: number;
} {
  const orders = sqlite
    .prepare(
      `SELECT id, raw_json FROM recon_orders
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`
    )
    .all(sinceIso, untilIso) as Array<{ id: string; raw_json: string | null }>;

  let scanned = 0;
  let recorded = 0;
  let legs = 0;
  let deferred = 0;
  let errors = 0;
  for (const o of orders) {
    scanned++;
    if (!o.raw_json) continue;
    try {
      const parsed = JSON.parse(o.raw_json);
      const r = processOrderForGCRedemption(o.id, parsed);
      recorded += r.redemptions_recorded;
      legs += r.je_legs_emitted;
      if (r.skipped_reason === "no_allocation") deferred++;
    } catch (e: any) {
      errors++;
      srWarn(
        "gc-redemption-rebuild",
        `Order ${o.id}: ${e?.message ?? e}`,
      );
    }
  }
  return {
    orders_scanned: scanned,
    redemptions_recorded: recorded,
    je_legs_emitted: legs,
    orders_deferred: deferred,
    errors,
  };
}

// Convenience re-export so callers from the routes layer only need to import
// from this module to render the redemption ledger card.
export { getRedemptionsByOrder };
