/**
 * Shopify Payments payouts + balance_transactions → recon_payouts +
 * recon_balance_transactions (PR #R3).
 *
 * Two-step pull, both incremental & idempotent:
 *   1. List payouts since the last watermark (date-keyed).
 *   2. For each payout, list its balance_transactions and replace the set.
 *
 * Key invariants:
 *   - We store Shopify's authoritative amounts verbatim (REAL). No math here.
 *   - `chargeback` is derived ONLY from Shopify-side signals. Currently:
 *       * type starts with "dispute"   (dispute_won, dispute_lost, dispute_*)
 *       * type === "adjustment" AND adjustment_reason includes "chargeback" / "dispute"
 *     If Shopify adds new signals we extend the helper, not the schema.
 *   - We do NOT touch payouts.plaid_transaction_id / matched_at — that's set
 *     by the Plaid matcher in PR #R5 and must survive re-ingests.
 *   - Pagination uses Link header rel="next" (same as orders sync).
 */

import {
  startReconSync, finishReconSync,
  upsertReconPayout, replaceReconBalanceTransactions,
  getReconPayoutsWatermark, getReconSettings,
  type ReconPayoutUpsert, type ReconBalanceTxnUpsert,
} from "./storage";
import {
  getShopifyReconConfig, shopifyRestCall, parseNextPageUrl,
} from "./shopify-recon";
import { recordIntegrationError, recordIntegrationWarn } from "./error-log";

function srError(scope: string, msg: string) { recordIntegrationError("shopify-recon", scope, msg, "error"); }
function srWarn(scope: string, msg: string) { recordIntegrationWarn("shopify-recon", scope, msg); }

const PAYOUT_PAGE_LIMIT = 250;       // Shopify max for shopify_payments/payouts
const TXN_PAGE_LIMIT = 250;          // Shopify max for balance_transactions

// ----------------------------------------------------------------------------
// Transform: raw Shopify payout / balance_transaction → upsert row
// ----------------------------------------------------------------------------

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function transformShopifyPayout(p: any): ReconPayoutUpsert {
  if (!p || !p.id) throw new Error("payout missing id");
  return {
    id: String(p.id),
    payout_date: String(p.date || p.created_at || ""),
    currency: p.currency ?? null,
    amount: num(p.amount) ?? 0,
    status: p.status ?? null,
    // summary_json: the per-bucket totals Shopify computes for the payout
    // (charges_gross, refunds_fee_amount, adjustments_gross, etc.). Stored
    // verbatim — PR #R5 catch-all math reads from balance_transactions, NOT
    // this summary, but having it here makes spot-checking trivial.
    summary_json: p.summary ? JSON.stringify(p.summary) : null,
    raw_json: JSON.stringify(p),
  };
}

/**
 * Detect chargeback signals from a balance_transaction row.
 * Returns [chargebackFlag, adjustmentReason].
 */
function detectChargeback(bt: any): { chargeback: number; adjustment_reason: string | null } {
  const type = String(bt?.type || "").toLowerCase();
  const reason = bt?.adjustment_reason ? String(bt.adjustment_reason) : null;

  // Direct dispute_* types are unambiguous.
  if (type.startsWith("dispute")) {
    return { chargeback: 1, adjustment_reason: reason };
  }

  // `adjustment` rows carry the chargeback signal via adjustment_reason.
  if (type === "adjustment" && reason) {
    const r = reason.toLowerCase();
    if (r.includes("chargeback") || r.includes("dispute") || r.includes("inquiry")) {
      return { chargeback: 1, adjustment_reason: reason };
    }
  }

  return { chargeback: 0, adjustment_reason: reason };
}

export function transformBalanceTransaction(bt: any, payoutId: string | null): ReconBalanceTxnUpsert {
  if (!bt || !bt.id) throw new Error("balance_transaction missing id");
  const { chargeback, adjustment_reason } = detectChargeback(bt);

  // source_order_id: Shopify exposes this via `source_order_transaction_id`
  // on charge/refund rows and via `source_order_id` on some types. The
  // shape varies — we prefer source_order_id when present, else fall back
  // to source_id only when type is in a known order-linked set.
  const sourceOrderId =
    bt.source_order_id != null ? String(bt.source_order_id)
    : (bt.source_type === "Order" && bt.source_id != null) ? String(bt.source_id)
    : null;

  return {
    id: String(bt.id),
    payout_id: payoutId,
    type: String(bt.type || "unknown"),
    processed_at: bt.processed_at ?? bt.created_at ?? null,
    amount: num(bt.amount) ?? 0,
    fee: num(bt.fee) ?? 0,
    net: num(bt.net),
    currency: bt.currency ?? null,
    source_order_id: sourceOrderId,
    source_transaction_id: bt.source_id != null ? String(bt.source_id) : null,
    chargeback,
    adjustment_reason,
    raw_json: JSON.stringify(bt),
  };
}

// ----------------------------------------------------------------------------
// Sync entry points
// ----------------------------------------------------------------------------

/**
 * Pull all balance_transactions for a single payout id, paginating Link headers.
 * Returns the transformed array — caller writes them in one transaction.
 */
async function fetchBalanceTransactionsForPayout(cfg: ReturnType<typeof getShopifyReconConfig> extends infer C ? Exclude<C, null> : never, payoutId: string): Promise<ReconBalanceTxnUpsert[]> {
  const out: ReconBalanceTxnUpsert[] = [];
  let nextUrl: string | null = null;
  let pages = 0;
  do {
    pages++;
    const res = nextUrl
      ? await shopifyRestCall(cfg, nextUrl)
      : await shopifyRestCall(cfg, "/shopify_payments/balance/transactions.json", {
          query: {
            payout_id: payoutId,
            limit: TXN_PAGE_LIMIT,
          },
        });
    const txns = (res.json?.transactions || []) as any[];
    for (const bt of txns) {
      try {
        out.push(transformBalanceTransaction(bt, payoutId));
      } catch (e: any) {
        srWarn("balance-txn-transform", `payout ${payoutId} txn ${bt?.id} failed: ${e?.message ?? e}`);
      }
    }
    nextUrl = parseNextPageUrl(res.linkHeader);
    if (pages > 50) {
      // 50 pages = 12.5k transactions per payout — should never happen
      srWarn("balance-txn-pages", `stopping payout ${payoutId} at ${pages} pages`);
      break;
    }
  } while (nextUrl);
  return out;
}

export async function syncPayoutsIncremental(
  triggeredBy: string,
): Promise<{
  pages: number;
  payoutsIngested: number;
  inserted: number;
  updated: number;
  balanceTransactionsIngested: number;
  chargebacksDetected: number;
  watermark: string | null;
  syncLogId: number;
  error?: string;
}> {
  const cfg = getShopifyReconConfig();
  if (!cfg) {
    return {
      pages: 0, payoutsIngested: 0, inserted: 0, updated: 0,
      balanceTransactionsIngested: 0, chargebacksDetected: 0,
      watermark: null, syncLogId: -1,
      error: "Shopify reconciler not configured",
    };
  }

  const settings = getReconSettings();
  // Payouts cursor is a date (YYYY-MM-DD), not an ISO timestamp — Shopify's
  // `date_min` filter accepts both but date-only avoids edge cases at midnight UTC.
  const initialSyncFrom = (settings?.initial_sync_from || "2025-01-01");
  const lastWatermark = getReconPayoutsWatermark();
  const dateMin = lastWatermark || initialSyncFrom;

  const syncLogId = startReconSync("payouts", triggeredBy, dateMin);

  let pages = 0;
  let inserted = 0;
  let updated = 0;
  let balanceTransactionsIngested = 0;
  let chargebacksDetected = 0;
  let maxDate: string | null = null;

  let nextUrl: string | null = null;
  try {
    do {
      pages++;
      const res = nextUrl
        ? await shopifyRestCall(cfg, nextUrl)
        : await shopifyRestCall(cfg, "/shopify_payments/payouts.json", {
            query: {
              limit: PAYOUT_PAGE_LIMIT,
              date_min: dateMin,
              // Ascending so watermark advances monotonically.
              // (Shopify accepts `order` for some endpoints; payouts respects since_id
              //  and date_min — we sort ascending in app code via maxDate tracking.)
            },
          });

      const payouts = (res.json?.payouts || []) as any[];
      for (const p of payouts) {
        try {
          const upsertRow = transformShopifyPayout(p);
          const outcome = upsertReconPayout(upsertRow);
          if (outcome === "inserted") inserted++; else updated++;

          // Pull balance_transactions for this payout. We always re-pull and
          // replace because Shopify can adjust per-payout txn shapes after the
          // fact (e.g. a refund issued days later attaches to an earlier payout).
          const txns = await fetchBalanceTransactionsForPayout(cfg, upsertRow.id);
          replaceReconBalanceTransactions(upsertRow.id, txns);
          balanceTransactionsIngested += txns.length;
          for (const t of txns) if (t.chargeback === 1) chargebacksDetected++;

          if (upsertRow.payout_date && (!maxDate || upsertRow.payout_date > maxDate)) {
            maxDate = upsertRow.payout_date;
          }
        } catch (e: any) {
          srWarn("payouts-ingest", `payout ${p?.id} ingest failed: ${e?.message ?? e}`);
        }
      }

      nextUrl = parseNextPageUrl(res.linkHeader);

      // Safety: stop runaway pulls (>50 pages = 12.5k payouts in one go ≈ 30+ years).
      if (pages > 50) {
        srWarn("payouts-ingest", `stopping incremental pull at ${pages} pages — resume next run`);
        break;
      }
    } while (nextUrl);

    finishReconSync(syncLogId, {
      status: "success",
      rows_ingested: inserted + updated,
      // Bump watermark forward by one day so the next pull starts strictly after
      // the last seen payout date (date_min is inclusive at day granularity).
      cursor: maxDate ? bumpDate(maxDate) : dateMin,
    });

    return {
      pages,
      payoutsIngested: inserted + updated,
      inserted,
      updated,
      balanceTransactionsIngested,
      chargebacksDetected,
      watermark: maxDate ? bumpDate(maxDate) : dateMin,
      syncLogId,
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    srError("payouts-ingest", `incremental sync failed: ${msg}`);
    finishReconSync(syncLogId, {
      status: "failure",
      rows_ingested: inserted + updated,
      error_message: msg,
    });
    return {
      pages,
      payoutsIngested: inserted + updated,
      inserted,
      updated,
      balanceTransactionsIngested,
      chargebacksDetected,
      watermark: null,
      syncLogId,
      error: msg,
    };
  }
}

/**
 * Add 1 day to a YYYY-MM-DD date string. Used to advance the watermark past
 * the last-seen payout day so date_min on the next run is strictly greater.
 */
function bumpDate(date: string): string {
  // Accept either YYYY-MM-DD or full ISO; coerce to date-only.
  const day = date.length >= 10 ? date.slice(0, 10) : date;
  const t = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(t)) return day;
  const next = new Date(t + 86400000);
  return next.toISOString().slice(0, 10);
}
