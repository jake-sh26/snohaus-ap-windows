/**
 * Phase 1 reconciler test console.
 *
 * Single-page test UI for PR #R2 — runs all the smoke-test calls (status, ping,
 * sync, sample orders, webhooks) behind buttons so the user can validate the
 * Shopify reconciler without touching PowerShell or curl.
 *
 * Read-only: nothing here mutates business data. The only "writes" are calls
 * to register/reset webhook subscriptions on the Shopify side and the manual
 * sync trigger (which is also automated on boot + every 6h).
 */
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { apiRequest } from "@/lib/queryClient";
import { CheckCircle2, XCircle, RefreshCw, Plug, Cable, ListChecks, AlertTriangle, Trash2, KeyRound, ShieldCheck, ExternalLink, BarChart3, Store, CalendarRange, Banknote, ShieldAlert, MapPin, Building2, Save, Check, BookOpen, Upload, Calculator, Layers } from "lucide-react";

// ----- typed responses (loose — backend already validates) -----
type TokenStatus = { hasToken: boolean; expiresAt: string | null; expiresInSec: number | null };
type Status = {
  configured: boolean;
  shopDomain: string | null;
  apiVersion: string | null;
  publicBaseUrl: string | null;
  authMode: "client_credentials" | "static_token" | "none";
  tokenStatus: TokenStatus;
  missing: string[];
};
type TokenRefreshResult = { ok: boolean; tokenPrefix?: string; tokenLength?: number; tokenStatus?: TokenStatus; authMode?: string; error?: string };
type Ping = { ok: boolean; shopName: string | null; myshopifyDomain: string | null; primaryLocationId: string | null; error?: string };
type Watermark = { orders_watermark: string | null };
type SyncResult = { pages: number; ordersIngested: number; inserted: number; updated: number; watermark: string | null; syncLogId: number; error?: string };
type ShopifyLocation = { id: string; name: string; active: boolean; legacy: boolean };
type OrderSample = {
  id: string; name: string | null; created_at: string; source_name: string | null;
  location_id: string | null; total_price: number | null; total_tax: number | null;
  financial_status: string | null; has_gift_card: number; tax_channel_liable: number;
  ingest_version: number; ingested_at: string;
};
type SyncLogRow = {
  id: number; kind: string; status: string; triggered_by: string | null;
  started_at: string; finished_at: string | null; rows_ingested: number | null;
  cursor: string | null; error_message: string | null;
};
type ErrorLogRow = { ts: string; scope: string; message: string; severity: string };
type WebhookRegResult = {
  topics: string[];
  results: Array<{ topic: string; state: string; address: string; webhookId: string | null; error?: string }>;
};
type InstalledStatus = {
  installed: boolean;
  shopDomain: string | null;
  scopes: string[] | null;
  installedAt: string | null;
  lastUsedAt: string | null;
};
type InstallUrl = { url: string };
type OrdersSummary = {
  total_orders: number;
  total_line_items: number;
  earliest_order_at: string | null;
  latest_order_at: string | null;
  gross_total: number;
  gross_tax: number;
  gross_discounts: number;
  gross_refunded: number;
  by_month: Array<{ month: string; orders: number; total: number; tax: number; discounts: number }>;
  by_channel: Array<{ source_name: string | null; orders: number; total: number }>;
  by_location: Array<{ location_id: string | null; orders: number; total: number }>;
  by_financial_status: Array<{ financial_status: string | null; orders: number }>;
  gift_card_orders: number;
  channel_liable_orders: number;
};
// PR #R3 — Shopify Payments payouts + balance_transactions
type PayoutsWatermark = { payouts_watermark: string | null };
type PayoutsSyncResult = {
  pages: number;
  payoutsIngested: number;
  inserted: number;
  updated: number;
  balanceTransactionsIngested: number;
  chargebacksDetected: number;
  watermark: string | null;
  syncLogId: number;
  error?: string;
};
type PayoutSample = {
  id: string;
  payout_date: string;
  amount: number;
  status: string | null;
  currency: string | null;
  txn_count: number;
  chargeback_count: number;
  ingested_at: string;
};
type PayoutsSummary = {
  total_payouts: number;
  total_balance_transactions: number;
  earliest_payout_at: string | null;
  latest_payout_at: string | null;
  gross_payout_amount: number;
  total_fees: number;
  total_chargebacks: number;
  chargeback_count: number;
  unmatched_payouts: number;
  by_month: Array<{ month: string; payouts: number; amount: number; chargebacks: number }>;
  by_status: Array<{ status: string | null; payouts: number; amount: number }>;
  by_txn_type: Array<{ type: string; count: number; amount: number; fees: number }>;
};

// PR #R3b — Suggested entity ↔ Shopify location mapping
type MappingEntity = { id: number; location: string; legal_name: string };
type MappingKind = "pos" | "fulfillment" | "warehouse" | "inactive";
type MappingSuggestion = {
  shopify_location_id: string;
  shopify_location_name: string;
  active: boolean;
  legacy: boolean;
  order_count_365d: number;
  total_sales_365d: number;
  suggested_entity_id: number | null;
  suggested_entity_location: string | null;
  suggested_kind: MappingKind;
  current_mapping_id: number | null;
  current_entity_id: number | null;
  current_entity_location: string | null;
  current_kind: string | null;
};
type MappingSuggestedResponse = { entities: MappingEntity[]; suggestions: MappingSuggestion[] };
type MappingBulkSaveResult = {
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ shopify_location_id: string; message: string }>;
};

// PR #R4a-prep — per-entity COA import + mapping
type CoaImportStatusRow = {
  entity_id: number;
  location: string;
  legal_name: string;
  account_count: number;
  active_count: number;
  last_imported_at: string | null;
};
type CoaAccountRow = {
  account_number: string | null;
  account_name: string;
  account_type: string | null;
  detail_type: string | null;
};
type CoaRoleMeta = {
  label: string;
  section: string;
  description: string;
  applies_to: "all" | "sd_only" | "hemp_hunt_only";
};
type CoaMatrixEntity = {
  id: number;
  location: string;
  legal_name: string;
  coa_imported: boolean;
  account_count: number;
  accounts: CoaAccountRow[];
};
type CoaMatrixCell = {
  entity_id: number;
  entity_location: string;
  logical_role: string;
  suggested_account_name: string | null;
  suggested_match_quality: "exact" | "strong" | "weak" | "none";
  current_account_name: string | null;
  current_account_id: string | null;
  notes: string | null;
  not_applicable: boolean;
};
type CoaMatrix = {
  entities: CoaMatrixEntity[];
  cells: CoaMatrixCell[];
  role_metadata: Record<string, CoaRoleMeta>;
  ready_for_phase_2: boolean;
  missing_count: number;
};
type CoaImportResult = { ok: boolean; entity_id: number; inserted: number; updated: number; deactivated: number; error?: string };
type CoaBulkSaveResult = { ok: boolean; inserted: number; updated: number; cleared: number; errors: Array<{ entity_id: number; logical_role: string; message: string }>; error?: string };

// ---- PR #R4: allocation engine types ----
type AllocationMethod =
  | "pos_location"
  | "fulfillment_location"
  | "warehouse_rollup"
  | "zip_lookup"
  | "prior_year_pro_rata"
  | "manual_override"
  | "needs_review";
type AllocReadiness = {
  has_pos_mappings: boolean;
  pos_mapping_count: number;
  unmapped_active_locations: number;
  has_sd_entity: boolean;
  has_zip_lookups: boolean;
  zip_lookup_count: number;
  has_pro_rata: boolean;
  pro_rata_year: number | null;
};
type AllocRunSummary = {
  ok: boolean;
  month: string;
  orders_processed: number;
  line_items_processed: number;
  allocations_written: number;
  by_method: Record<AllocationMethod, number>;
  needs_review_orders: number;
  failed_orders: number;
  warnings: string[];
  ran_at: string;
  error?: string;
};
type AllocNeedsReviewRow = {
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
type AllocRollupRow = {
  entity_id: number;
  entity_location: string | null;
  orders: number;
  line_items: number;
  gross_total: number;
  tax_total: number;
};

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function num(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}
function monthLabel(yyyyMm: string): string {
  // "2026-05" → "May 2026"
  const [y, m] = yyyyMm.split("-").map(Number);
  if (!y || !m) return yyyyMm;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

// ----- helpers -----
async function jsonGet<T>(path: string): Promise<T> { const r = await apiRequest("GET", path); return r.json() as Promise<T>; }
async function jsonPost<T>(path: string, body?: any): Promise<T> { const r = await apiRequest("POST", path, body); return r.json() as Promise<T>; }
async function jsonDelete<T>(path: string): Promise<T> { const r = await apiRequest("DELETE", path); return r.json() as Promise<T>; }

function moneyOrDash(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toFixed(2)}`;
}
function shortTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// =============================================================================
export default function ReconcilerTest() {
  const qc = useQueryClient();
  const [lastAction, setLastAction] = useState<string | null>(null);

  // --- status (always show, refresh every 10s for boot drift visibility) ---
  const statusQ = useQuery<Status>({
    queryKey: ["/api/recon/shopify/status"],
    refetchInterval: 10_000,
  });

  // --- watermark ---
  const watermarkQ = useQuery<Watermark>({ queryKey: ["/api/recon/shopify/watermark"] });

  // --- locations (cached — only refetched on demand) ---
  const locationsQ = useQuery<ShopifyLocation[]>({
    queryKey: ["/api/recon/shopify/locations"],
    enabled: !!statusQ.data?.configured,
  });

  // --- recent orders sample ---
  const ordersQ = useQuery<OrderSample[]>({
    queryKey: ["/api/recon/orders"],
    enabled: !!statusQ.data?.configured,
  });

  // --- sync log (most recent 20) ---
  const syncLogQ = useQuery<SyncLogRow[]>({
    queryKey: ["/api/recon/sync-log"],
  });

  // --- error log ---
  const errorLogQ = useQuery<ErrorLogRow[]>({
    queryKey: ["/api/recon/shopify/error-log"],
    enabled: !!statusQ.data?.configured,
  });

  // --- mutations ---
  const pingMut = useMutation<Ping>({
    mutationFn: () => jsonPost("/api/recon/shopify/ping"),
    onSuccess: () => setLastAction("Ping complete"),
  });
  const syncMut = useMutation<SyncResult>({
    mutationFn: () => jsonPost("/api/recon/shopify/sync/orders"),
    onSuccess: (r) => {
      setLastAction(r.error ? `Sync error: ${r.error}` : `Sync done: ${r.ordersIngested} rows (${r.inserted} new, ${r.updated} updated)`);
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/watermark"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/orders"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/sync-log"] });
    },
  });
  // PR #R4b/R4c — Fulfillment backfill. For orders ingested before R4b shipped,
  // re-pulls each order's fulfillments[] only and rewrites recon_order_fulfillments.
  // Order/line item rows are NOT touched. R4c uses the list endpoint so a month
  // is ~3-4 API calls instead of 700+, and we poll progress while it runs.
  type FulfillmentBackfillResult = {
    orders_scanned: number;
    orders_updated: number;
    fulfillments_written: number;
    errors: number;
    pages: number;
    syncLogId: number;
    error?: string;
  };
  type BackfillProgress = {
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
  const [backfillSince, setBackfillSince] = useState<string>("");
  const [backfillUntil, setBackfillUntil] = useState<string>("");
  // PR #R4d — pull initial_sync_from from reconciler settings so the
  // "Backfill all history" button knows where the configured history floor is.
  // PR #R4g — was a raw fetch() with `credentials: "include"`; the API uses
  // Bearer auth (cookies not honoured by requirePermission), so a session
  // refresh would silently 401 these. Route through apiRequest so the
  // Authorization header is read fresh from localStorage every poll.
  const settingsQ = useQuery<{ initial_sync_from?: string | null }>({
    queryKey: ["/api/recon/settings"],
    queryFn: () => jsonGet("/api/recon/settings"),
  });
  // PR #R4f — always-on backfill progress poller. Decoupled from the
  // mutation's isPending so a freshly-loaded client (after a refresh, or
  // simply someone else's session) sees the running job's state within
  // ~1.5s. The server returns the currently-running backfill (or the most
  // recent finished one) when called without a syncLogId.
  // PR #R4g — same fix as above; uses apiRequest so a relogin's fresh token
  // is picked up on the very next poll instead of 401ing forever.
  const backfillProgressQ = useQuery<{ progress: BackfillProgress | null; recent?: BackfillProgress[] }>({
    queryKey: ["/api/recon/shopify/sync/fulfillments-backfill/progress"],
    queryFn: async () => {
      try {
        const r = await apiRequest("GET", "/api/recon/shopify/sync/fulfillments-backfill/progress");
        return r.json();
      } catch {
        // Don't break the poller on a single transient failure — return the
        // safe empty shape so the Diagnostics block can show "no progress."
        return { progress: null, recent: [] };
      }
    },
    refetchInterval: 1500,
    // Always refetch in the background even when the tab is hidden, so a
    // user returning to the tab sees fresh state immediately.
    refetchIntervalInBackground: true,
  });
  const backfillProgress = backfillProgressQ.data?.progress ?? null;
  const backfillIsRunning = backfillProgress?.state === "running";
  // Surface the final tally exactly once when the run flips out of running.
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    if (wasRunning && !backfillIsRunning && backfillProgress) {
      if (backfillProgress.state === "failure") {
        setLastAction(
          `Backfill ended: ${backfillProgress.message ?? backfillProgress.error ?? "failure"} — ` +
          `${backfillProgress.orders_scanned} scanned, ${backfillProgress.orders_updated} updated, ${backfillProgress.fulfillments_written} fulfillments`,
        );
      } else {
        setLastAction(
          `Backfill done: ${backfillProgress.orders_scanned} scanned, ${backfillProgress.orders_updated} updated, ${backfillProgress.fulfillments_written} fulfillment rows, ${backfillProgress.errors} errors (${backfillProgress.pages} page(s))`,
        );
      }
      qc.invalidateQueries({ queryKey: ["/api/recon/sync-log"] });
    }
    prevRunningRef.current = backfillIsRunning;
  }, [backfillIsRunning, backfillProgress, qc]);

  const fulfillmentBackfillMut = useMutation<FulfillmentBackfillResult, Error, { since: string; until?: string }>({
    mutationFn: (args) => jsonPost<FulfillmentBackfillResult>("/api/recon/shopify/sync/fulfillments-backfill", args),
    onSuccess: (r) => {
      // The always-on poller surfaces progress + final tally; we don't need
      // to duplicate the success line. We still record an error if the run
      // itself reported one in its response body (vs. the 409 path which
      // throws and lands in onError below).
      if (r.error) setLastAction(`Fulfillment backfill error: ${r.error}`);
      qc.invalidateQueries({ queryKey: ["/api/recon/sync-log"] });
    },
    onError: (e: any) => {
      const msg: string = e?.message ?? String(e);
      // apiRequest throws as `${status}: ${body}` — pick the 409 we send
      // when a run is already in flight and surface it in plain English.
      if (msg.startsWith("409:")) {
        setLastAction("A backfill is already running — wait or stop it first");
      } else {
        setLastAction(`Fulfillment backfill failed: ${msg}`);
      }
    },
  });

  // PR #R4f — stop the currently-running backfill (server cancels ALL when
  // no syncLogId is provided in the body). The actual halt is cooperative —
  // the loop checks the flag between pages/orders — so it may take a few
  // seconds to take effect, which we tell the user.
  const cancelBackfillMut = useMutation<{ cancelled: number[] }, Error>({
    mutationFn: () => jsonPost("/api/recon/shopify/sync/fulfillments-backfill/cancel", {}),
    onSuccess: (r) => {
      if (r.cancelled && r.cancelled.length > 0) {
        setLastAction(
          `Backfill stop requested (id ${r.cancelled.join(", ")}). It may take a few seconds to halt.`,
        );
      } else {
        setLastAction("No running backfill to stop");
      }
    },
    onError: (e: any) => setLastAction(`Stop request failed: ${e?.message ?? e}`),
  });
  const registerMut = useMutation<WebhookRegResult>({
    mutationFn: () => jsonPost("/api/recon/shopify/webhooks/register"),
    onSuccess: (r) => setLastAction(`Webhooks: ${r.results.map(x => `${x.topic}=${x.state}`).join(", ")}`),
  });
  const resetWebhooksMut = useMutation<{ deleted: number }>({
    mutationFn: () => jsonDelete("/api/recon/shopify/webhooks"),
    onSuccess: (r) => setLastAction(`Deleted ${r.deleted} webhook(s)`),
  });
  const refreshTokenMut = useMutation<TokenRefreshResult>({
    mutationFn: () => jsonPost("/api/recon/shopify/token/refresh"),
    onSuccess: (r) => {
      setLastAction(r.ok ? `Token minted: ${r.tokenPrefix}… (${r.tokenLength} chars)` : `Token mint failed: ${r.error}`);
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/status"] });
    },
  });
  const clearErrorsMut = useMutation<{ ok: boolean }>({
    mutationFn: () => jsonDelete("/api/recon/shopify/error-log"),
    onSuccess: () => {
      setLastAction("Error log cleared");
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/error-log"] });
    },
  });

  // --- OAuth install status (PR #R2e) ---
  const installedQ = useQuery<InstalledStatus>({
    queryKey: ["/api/auth/shopify/installed-status"],
    refetchInterval: 10_000,
  });
  const installMut = useMutation<InstallUrl>({
    mutationFn: () => jsonGet<InstallUrl>("/api/auth/shopify/install-url"),
    onSuccess: (r) => {
      if (r?.url) {
        setLastAction("Opening Shopify install page in a new tab…");
        window.open(r.url, "_blank", "noopener,noreferrer");
      } else {
        setLastAction("Could not build install URL");
      }
    },
    onError: (e: any) => setLastAction(`Install URL error: ${e?.message ?? "unknown"}`),
  });
  const deleteTokenMut = useMutation<{ ok: boolean; deleted: boolean }>({
    mutationFn: () => jsonDelete("/api/auth/shopify/token"),
    onSuccess: (r) => {
      setLastAction(r.deleted ? "Stored Shopify token removed" : "No stored token to remove");
      qc.invalidateQueries({ queryKey: ["/api/auth/shopify/installed-status"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/status"] });
    },
  });

  // --- Orders summary (PR #R2f) ---
  const summaryQ = useQuery<OrdersSummary>({
    queryKey: ["/api/recon/shopify/orders-summary"],
    refetchInterval: 30_000,
  });

  // --- Payouts (PR #R3) ---
  const payoutsWatermarkQ = useQuery<PayoutsWatermark>({
    queryKey: ["/api/recon/shopify/payouts-watermark"],
  });
  const payoutsSampleQ = useQuery<PayoutSample[]>({
    queryKey: ["/api/recon/payouts"],
    enabled: !!statusQ.data?.configured,
  });
  const payoutsSummaryQ = useQuery<PayoutsSummary>({
    queryKey: ["/api/recon/shopify/payouts-summary"],
    refetchInterval: 30_000,
  });
  const payoutsSyncMut = useMutation<PayoutsSyncResult>({
    mutationFn: () => jsonPost("/api/recon/shopify/sync/payouts"),
    onSuccess: (r) => {
      setLastAction(
        r.error
          ? `Payouts sync error: ${r.error}`
          : `Payouts sync done: ${r.payoutsIngested} payouts (${r.inserted} new, ${r.updated} updated), ${r.balanceTransactionsIngested} balance txns, ${r.chargebacksDetected} chargebacks`,
      );
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/payouts-watermark"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/payouts"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/payouts-summary"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/sync-log"] });
    },
  });

  // --- PR #R3b: Suggested entity ↔ location mapping ---
  // Lazy: only fetched when the user clicks "Load suggestions". Editable
  // table state lives in `mappingDraft` so we can preview before saving.
  const [mappingDraft, setMappingDraft] = useState<MappingSuggestion[] | null>(null);
  const [mappingEntities, setMappingEntities] = useState<MappingEntity[]>([]);
  const mappingSuggestedMut = useMutation<MappingSuggestedResponse>({
    mutationFn: () => jsonGet("/api/recon/entity-mapping/suggested"),
    onSuccess: (r) => {
      // Pre-fill any unmapped rows with suggested values; preserve current
      // saved mappings so the user can see what's already there.
      setMappingDraft(r.suggestions);
      setMappingEntities(r.entities);
      setLastAction(`Loaded ${r.suggestions.length} Shopify locations`);
    },
    onError: (e: any) => setLastAction(`Failed to load mapping: ${e?.message ?? e}`),
  });
  const mappingSaveMut = useMutation<MappingBulkSaveResult, Error, MappingSuggestion[]>({
    mutationFn: (rows) =>
      jsonPost<MappingBulkSaveResult>("/api/recon/entity-mapping/bulk-save", {
        rows: rows.map(r => ({
          shopify_location_id: r.shopify_location_id,
          shopify_location_name: r.shopify_location_name,
          entity_id: r.suggested_entity_id,
          kind: r.suggested_kind,
        })),
      }),
    onSuccess: (r) => {
      const errMsg = r.errors.length > 0 ? `, ${r.errors.length} errors` : "";
      setLastAction(`Mapping saved: ${r.inserted} inserted, ${r.updated} updated, ${r.skipped} skipped${errMsg}`);
      qc.invalidateQueries({ queryKey: ["/api/recon/pos-locations"] });
      mappingSuggestedMut.mutate();
    },
    onError: (e: any) => setLastAction(`Save failed: ${e?.message ?? e}`),
  });

  function updateDraftRow(idx: number, patch: Partial<MappingSuggestion>) {
    setMappingDraft(prev => {
      if (!prev) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  // --- PR #R4a-prep: COA mapping ---
  // Two queries: per-entity import freshness (always shown) + the full mapping
  // matrix (only built once at least one entity has been imported).
  const coaStatusQ = useQuery<CoaImportStatusRow[]>({
    queryKey: ["/api/recon/coa/import-status"],
  });
  const coaMatrixQ = useQuery<CoaMatrix>({
    queryKey: ["/api/recon/coa/mapping-matrix"],
    enabled: !!coaStatusQ.data && coaStatusQ.data.some(r => r.account_count > 0),
  });
  // Local draft of cell selections so the user can edit before saving.
  const [coaDraft, setCoaDraft] = useState<Record<string, string | null>>({});
  const [coaSavedFlash, setCoaSavedFlash] = useState(false);
  // Inline status for the upload row (visible right next to the button so the
  // user doesn't have to look at the bottom status line).
  const [coaUploadStatus, setCoaUploadStatus] = useState<Record<number, { kind: "ok" | "err" | "working"; msg: string }>>({});
  // Track which cells have been edited locally (so we know what to save).
  const cellKey = (entityId: number, role: string) => `${entityId}::${role}`;
  const getCellValue = (entityId: number, role: string): string | null => {
    const k = cellKey(entityId, role);
    if (k in coaDraft) return coaDraft[k];
    const cell = coaMatrixQ.data?.cells.find(c => c.entity_id === entityId && c.logical_role === role);
    return cell?.current_account_name ?? cell?.suggested_account_name ?? null;
  };
  const coaImportMut = useMutation<CoaImportResult, Error, { entityId: number; rows: CoaAccountRow[] }>({
    mutationFn: ({ entityId, rows }) => jsonPost<CoaImportResult>(`/api/recon/coa/import/${entityId}`, { rows }),
    onSuccess: (r, vars) => {
      const msg = r.error
        ? `Import error: ${r.error}`
        : `Imported ${r.inserted} new, ${r.updated} updated, ${r.deactivated} deactivated`;
      setLastAction(`COA: ${msg}`);
      setCoaUploadStatus(prev => ({ ...prev, [vars.entityId]: { kind: r.error ? "err" : "ok", msg } }));
      qc.invalidateQueries({ queryKey: ["/api/recon/coa/import-status"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/coa/mapping-matrix"] });
    },
    onError: (e: any, vars) => {
      const msg = `Upload failed: ${e?.message ?? e}`;
      setLastAction(`COA: ${msg}`);
      setCoaUploadStatus(prev => ({ ...prev, [vars.entityId]: { kind: "err", msg } }));
    },
  });
  const coaSaveMut = useMutation<CoaBulkSaveResult, Error, Array<{ entity_id: number; logical_role: string; qbo_account_name: string | null }>>({
    mutationFn: (rows) => jsonPost<CoaBulkSaveResult>("/api/recon/coa/mapping/bulk-save", { rows }),
    onSuccess: (r) => {
      const errMsg = r.errors.length > 0 ? `, ${r.errors.length} errors` : "";
      setLastAction(`COA mapping saved: ${r.inserted} inserted, ${r.updated} updated, ${r.cleared} cleared${errMsg}`);
      setCoaDraft({});
      setCoaSavedFlash(true);
      setTimeout(() => setCoaSavedFlash(false), 2_500);
      qc.invalidateQueries({ queryKey: ["/api/recon/coa/mapping-matrix"] });
    },
    onError: (e: any) => setLastAction(`COA save failed: ${e?.message ?? e}`),
  });

  // ---- PR #R4: allocation engine state + hooks ----
  // Default the run/rollup month to the most recent fully-closed month so
  // blind validation against Feb 2026 / Jan 2026 / Nov 2025 is one click.
  const defaultAllocMonth = (() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();
  const [allocMonth, setAllocMonth] = useState<string>(defaultAllocMonth);
  const [allocLastSummary, setAllocLastSummary] = useState<AllocRunSummary | null>(null);
  const [overrideDraft, setOverrideDraft] = useState<Record<string, number | "">>({});

  const allocReadinessQ = useQuery<AllocReadiness>({
    queryKey: ["/api/recon/allocations/readiness"],
  });
  const allocNeedsReviewQ = useQuery<{ rows: AllocNeedsReviewRow[] }>({
    queryKey: ["/api/recon/allocations/needs-review", allocMonth],
    queryFn: () => jsonGet(`/api/recon/allocations/needs-review?month=${encodeURIComponent(allocMonth)}`),
  });
  const allocRollupQ = useQuery<{ rows: AllocRollupRow[] }>({
    queryKey: ["/api/recon/allocations/rollup", allocMonth],
    queryFn: () => jsonGet(`/api/recon/allocations/rollup?month=${encodeURIComponent(allocMonth)}`),
  });

  const allocRunMut = useMutation<AllocRunSummary, Error, string>({
    mutationFn: (month) => jsonPost<AllocRunSummary>("/api/recon/allocations/run", { month }),
    onSuccess: (r) => {
      setAllocLastSummary(r);
      const errMsg = r.error ? ` (error: ${r.error})` : "";
      setLastAction(
        `Allocation: ${r.orders_processed} orders, ${r.allocations_written} rows, ` +
        `${r.needs_review_orders} need review, ${r.failed_orders} failed${errMsg}`
      );
      qc.invalidateQueries({ queryKey: ["/api/recon/allocations/needs-review"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/allocations/rollup"] });
    },
    onError: (e: any) => setLastAction(`Allocation run failed: ${e?.message ?? e}`),
  });

  const overrideMut = useMutation<
    { ok: boolean; updated: number },
    Error,
    { order_id: string; line_item_id: string | null; entity_id: number }
  >({
    mutationFn: (args) => jsonPost("/api/recon/allocations/override", args),
    onSuccess: (r, vars) => {
      setLastAction(`Override saved: order ${vars.order_id} → entity ${vars.entity_id} (${r.updated} rows)`);
      qc.invalidateQueries({ queryKey: ["/api/recon/allocations/needs-review"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/allocations/rollup"] });
    },
    onError: (e: any) => setLastAction(`Override failed: ${e?.message ?? e}`),
  });

  // Parses a QBO COA CSV (Account Type, Detail Type, Name, Number variants).
  // Returns rows ready for /api/recon/coa/import/:entityId.
  function parseCoaCsv(text: string): CoaAccountRow[] {
    // Minimal CSV parser — handles quoted fields with embedded commas/newlines.
    const out: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else { field += c; }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); out.push(row); row = []; field = ""; }
        else if (c === "\r") { /* skip */ }
        else { field += c; }
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); out.push(row); }

    // Find the header row. QBO exports often have 1-3 preamble rows.
    // Header column variants we accept (case-insensitive, trimmed):
    //   name   : "account", "name", "account name", "full name"
    //   number : "number", "acct #", "acct#", "account number", "account #"
    //   type   : "type", "account type"
    //   detail : "detail type", "detail_type"
    const nameAliases = ["account name", "account", "name", "full name"];
    const numberAliases = ["account number", "number", "acct #", "acct#", "account #", "#"];
    const typeAliases = ["account type", "type"];
    const detailAliases = ["detail type", "detail_type"];
    let headerIdx = -1;
    for (let i = 0; i < out.length && i < 10; i++) {
      const r = out[i].map(s => s.toLowerCase().trim());
      if (r.some(s => nameAliases.includes(s)) && r.some(s => typeAliases.includes(s))) {
        headerIdx = i; break;
      }
    }
    if (headerIdx === -1) return [];
    const header = out[headerIdx].map(s => s.toLowerCase().trim());
    const findCol = (aliases: string[]) => header.findIndex(h => aliases.includes(h));
    const colName = findCol(nameAliases);
    const colNumber = findCol(numberAliases);
    const colType = findCol(typeAliases);
    const colDetail = findCol(detailAliases);

    const rows: CoaAccountRow[] = [];
    for (let i = headerIdx + 1; i < out.length; i++) {
      const r = out[i];
      const name = (colName >= 0 ? r[colName] : "")?.trim();
      if (!name) continue;
      rows.push({
        account_name: name,
        account_number: colNumber >= 0 ? (r[colNumber]?.trim() || null) : null,
        account_type: colType >= 0 ? (r[colType]?.trim() || null) : null,
        detail_type: colDetail >= 0 ? (r[colDetail]?.trim() || null) : null,
      });
    }
    return rows;
  }

  function handleCoaCsvUpload(entityId: number, file: File) {
    setCoaUploadStatus(prev => ({ ...prev, [entityId]: { kind: "working", msg: `Reading ${file.name}…` } }));
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const rows = parseCoaCsv(text);
      if (rows.length === 0) {
        const msg = `No account rows detected in ${file.name}. Expected QBO export with columns: Account name, Account type (Account number + Detail type optional).`;
        setLastAction(`COA: ${msg}`);
        setCoaUploadStatus(prev => ({ ...prev, [entityId]: { kind: "err", msg } }));
        return;
      }
      setCoaUploadStatus(prev => ({ ...prev, [entityId]: { kind: "working", msg: `Parsed ${rows.length} rows, uploading…` } }));
      coaImportMut.mutate({ entityId, rows });
    };
    reader.onerror = () => {
      const msg = `Could not read ${file.name}`;
      setLastAction(`COA: ${msg}`);
      setCoaUploadStatus(prev => ({ ...prev, [entityId]: { kind: "err", msg } }));
    };
    reader.readAsText(file);
  }

  function saveCoaMapping() {
    if (!coaMatrixQ.data) return;
    // Build the full payload from current draft + existing cells so the server
    // sees one authoritative state per (entity, role).
    const rows = coaMatrixQ.data.cells
      .filter(c => !c.not_applicable)
      .map(c => ({
        entity_id: c.entity_id,
        logical_role: c.logical_role,
        qbo_account_name: getCellValue(c.entity_id, c.logical_role),
      }));
    coaSaveMut.mutate(rows);
  }

  const coaDirty = Object.keys(coaDraft).length > 0;

  const cfg = statusQ.data;
  const configured = !!cfg?.configured;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reconciler — Phase 1 Test Console</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Read-only validation for the multi-entity Shopify reconciler. No QBO posting, no allocation — that lands in Phase 2.
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5">Read-only</Badge>
      </div>

      {/* ===== 1. Connection status ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Plug className="size-4" /> Connection</CardTitle>
          <CardDescription>Is the Shopify reconciler wired up correctly?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {statusQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Checking…</div>
          ) : !cfg ? (
            <div className="text-sm text-red-600">Status check failed</div>
          ) : (
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div className="font-medium">Configured</div>
              <div>
                {configured ? <span className="inline-flex items-center gap-1.5 text-green-700"><CheckCircle2 className="size-4" /> Yes</span>
                           : <span className="inline-flex items-center gap-1.5 text-red-700"><XCircle className="size-4" /> No</span>}
              </div>
              <div className="font-medium">Shop domain</div>
              <div className="font-mono text-xs">{cfg.shopDomain ?? "—"}</div>
              <div className="font-medium">API version</div>
              <div className="font-mono text-xs">{cfg.apiVersion ?? "—"}</div>
              <div className="font-medium">Public base URL</div>
              <div className="font-mono text-xs break-all">{cfg.publicBaseUrl ?? "—"}</div>
              <div className="font-medium">Auth mode</div>
              <div className="font-mono text-xs">
                {cfg.authMode === "client_credentials" ? "client_credentials (auto-mint)"
                  : cfg.authMode === "static_token" ? "static_token (override)"
                  : "—"}
              </div>
              <div className="font-medium">Access token</div>
              <div className="font-mono text-xs">
                {cfg.tokenStatus?.hasToken
                  ? <span className="text-green-700">cached — expires in {Math.floor((cfg.tokenStatus.expiresInSec ?? 0) / 60)} min</span>
                  : cfg.authMode === "static_token" ? <span className="text-muted-foreground">using static token from .env</span>
                  : <span className="text-amber-700">not minted yet</span>}
              </div>
              {cfg.missing.length > 0 && (
                <>
                  <div className="font-medium text-red-700">Missing env</div>
                  <div className="font-mono text-xs text-red-700">{cfg.missing.join(", ")}</div>
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => pingMut.mutate()} disabled={!configured || pingMut.isPending}>
              {pingMut.isPending ? <RefreshCw className="size-4 mr-1.5 animate-spin" /> : <Plug className="size-4 mr-1.5" />}
              Ping Shopify
            </Button>
            <Button size="sm" variant="outline" onClick={() => refreshTokenMut.mutate()} disabled={!configured || cfg?.authMode !== "client_credentials" || refreshTokenMut.isPending}>
              {refreshTokenMut.isPending ? <RefreshCw className="size-4 mr-1.5 animate-spin" /> : <KeyRound className="size-4 mr-1.5" />}
              Mint fresh token
            </Button>
            <Button size="sm" variant="outline" onClick={() => statusQ.refetch()}>
              <RefreshCw className="size-4 mr-1.5" /> Refresh status
            </Button>
          </div>

          {refreshTokenMut.data && (
            <div className={`text-sm rounded-md border p-3 ${refreshTokenMut.data.ok ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
              {refreshTokenMut.data.ok ? (
                <>
                  <div className="font-medium text-green-800">Token minted</div>
                  <div className="text-xs text-green-700 mt-1 font-mono">{refreshTokenMut.data.tokenPrefix}… ({refreshTokenMut.data.tokenLength} chars)</div>
                  {refreshTokenMut.data.tokenStatus?.expiresInSec != null && (
                    <div className="text-xs text-green-700">Expires in {Math.floor(refreshTokenMut.data.tokenStatus.expiresInSec / 60)} min</div>
                  )}
                </>
              ) : (
                <>
                  <div className="font-medium text-red-800">Token mint failed</div>
                  <div className="text-xs text-red-700 mt-1">{refreshTokenMut.data.error ?? "Unknown error"}</div>
                </>
              )}
            </div>
          )}

          {pingMut.data && (
            <div className={`text-sm rounded-md border p-3 ${pingMut.data.ok ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
              {pingMut.data.ok ? (
                <>
                  <div className="font-medium text-green-800">Connection OK</div>
                  <div className="text-xs text-green-700 mt-1">Shop: {pingMut.data.shopName ?? "—"}</div>
                  <div className="text-xs text-green-700">Primary location: {pingMut.data.primaryLocationId ?? "—"}</div>
                </>
              ) : (
                <>
                  <div className="font-medium text-red-800">Connection failed</div>
                  <div className="text-xs text-red-700 mt-1">{pingMut.data.error ?? "Unknown error"}</div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 1b. App install (OAuth) — PR #R2e ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" /> App install (Admin API token)</CardTitle>
          <CardDescription>
            Installs the custom Shopify app on your store and stores the Admin API token. Required before Ping or sync will work.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {installedQ.isLoading && <div className="text-sm text-muted-foreground">Checking install status…</div>}
          {installedQ.data && (
            <div className="flex items-center gap-2 text-sm">
              {installedQ.data.installed ? (
                <>
                  <CheckCircle2 className="size-4 text-green-600" />
                  <span className="font-medium text-green-800">Installed</span>
                  <span className="text-muted-foreground">on {installedQ.data.shopDomain ?? "—"}</span>
                </>
              ) : (
                <>
                  <XCircle className="size-4 text-red-600" />
                  <span className="font-medium text-red-800">Not installed</span>
                  <span className="text-muted-foreground">— click below to install</span>
                </>
              )}
            </div>
          )}

          {installedQ.data?.installed && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-muted-foreground">
              <div>Installed: <span className="font-mono">{shortTime(installedQ.data.installedAt)}</span></div>
              <div>Last used: <span className="font-mono">{shortTime(installedQ.data.lastUsedAt)}</span></div>
              {installedQ.data.scopes && installedQ.data.scopes.length > 0 && (
                <div className="md:col-span-2">
                  Scopes: <span className="font-mono">{installedQ.data.scopes.join(", ")}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => installMut.mutate()}
              disabled={!configured || installMut.isPending}
            >
              {installMut.isPending ? <RefreshCw className="size-4 mr-1.5 animate-spin" /> : <ExternalLink className="size-4 mr-1.5" />}
              {installedQ.data?.installed ? "Reinstall via OAuth" : "Install via OAuth"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => installedQ.refetch()}
            >
              <RefreshCw className="size-4 mr-1.5" /> Refresh
            </Button>
            {installedQ.data?.installed && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (confirm("Remove the stored Shopify token? You'll need to reinstall to use Admin API calls again.")) {
                    deleteTokenMut.mutate();
                  }
                }}
                disabled={deleteTokenMut.isPending}
                className="text-red-700 hover:text-red-800"
              >
                <Trash2 className="size-4 mr-1.5" /> Remove stored token
              </Button>
            )}
          </div>

          {!configured && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
              Set <span className="font-mono">SHOPIFY_SHOP_DOMAIN</span>, <span className="font-mono">SHOPIFY_CLIENT_ID</span>,
              <span className="font-mono"> SHOPIFY_API_SECRET</span>, and <span className="font-mono">SHOPIFY_PUBLIC_BASE_URL</span> in .env before installing.
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 2. Orders sync ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><RefreshCw className="size-4" /> Orders sync</CardTitle>
          <CardDescription>Runs automatically every 6 hours. Click to force an incremental pull now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="font-medium">Current watermark</div>
            <div className="font-mono text-xs">{watermarkQ.data?.orders_watermark ?? "(none — first run)"}</div>
            <div className="font-medium">Orders in DB</div>
            <div className="font-mono text-xs">{ordersQ.data ? `${ordersQ.data.length} (most recent shown below)` : "—"}</div>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" onClick={() => syncMut.mutate()} disabled={!configured || syncMut.isPending}>
              {syncMut.isPending ? <RefreshCw className="size-4 mr-1.5 animate-spin" /> : <RefreshCw className="size-4 mr-1.5" />}
              Sync now
            </Button>
          </div>
          {syncMut.data && (
            <div className={`text-sm rounded-md border p-3 ${syncMut.data.error ? "border-red-200 bg-red-50" : "border-green-200 bg-green-50"}`}>
              {syncMut.data.error ? (
                <div className="text-red-800"><AlertTriangle className="size-4 inline mr-1" />{syncMut.data.error}</div>
              ) : (
                <div className="text-green-800">
                  Synced <b>{syncMut.data.ordersIngested}</b> orders across <b>{syncMut.data.pages}</b> page(s) — {syncMut.data.inserted} new, {syncMut.data.updated} updated.
                </div>
              )}
            </div>
          )}

          {/* ===== PR #R4b: Fulfillment backfill ===== */}
          <Separator className="my-2" />
          <div className="space-y-2">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <RefreshCw className="size-4" /> Fulfillment backfill (PR #R4b)
            </div>
            <div className="text-xs text-muted-foreground">
              Re-pulls fulfillments only for orders already in the database in this date range.
              Use this for past months (e.g. Feb/Jan 2026, Nov 2025) so online-store orders
              get their ship-from location set correctly. Safe to re-run — order/line item
              rows are not touched.
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Since</label>
                <input
                  type="date"
                  value={backfillSince}
                  onChange={(e) => setBackfillSince(e.target.value)}
                  className="border rounded px-2 py-1.5 text-sm font-mono bg-background text-foreground [color-scheme:light_dark]"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Until (optional)</label>
                <input
                  type="date"
                  value={backfillUntil}
                  onChange={(e) => setBackfillUntil(e.target.value)}
                  className="border rounded px-2 py-1.5 text-sm font-mono bg-background text-foreground [color-scheme:light_dark]"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!configured || !backfillSince || fulfillmentBackfillMut.isPending || backfillIsRunning}
                onClick={() => {
                  fulfillmentBackfillMut.mutate({
                    since: backfillSince,
                    until: backfillUntil || undefined,
                  });
                }}
              >
                <RefreshCw className={`size-4 mr-1.5 ${(fulfillmentBackfillMut.isPending || backfillIsRunning) ? "animate-spin" : ""}`} />
                {(fulfillmentBackfillMut.isPending || backfillIsRunning) ? "Backfilling…" : "Backfill fulfillments"}
              </Button>
              {/* PR #R4d — single-button shortcut for the full history sweep. */}
              <Button
                size="sm"
                variant="outline"
                disabled={!configured || fulfillmentBackfillMut.isPending || backfillIsRunning}
                onClick={() => {
                  const floor = settingsQ.data?.initial_sync_from || "2025-01-01";
                  const ok = window.confirm(
                    `Backfill fulfillments + fulfillment_orders for ALL orders since ${floor}? This may take several minutes for a full history sweep.`,
                  );
                  if (!ok) return;
                  fulfillmentBackfillMut.mutate({ since: floor });
                }}
              >
                <RefreshCw className={`size-4 mr-1.5 ${(fulfillmentBackfillMut.isPending || backfillIsRunning) ? "animate-spin" : ""}`} />
                Backfill all history
              </Button>
              {/* PR #R4f — cooperative cancel. Disabled unless a run is
                  actually in flight (server state, not client mutation). */}
              <Button
                size="sm"
                variant="destructive"
                disabled={!backfillIsRunning || cancelBackfillMut.isPending}
                onClick={() => {
                  const ok = window.confirm(
                    "Stop the running backfill? Progress will be lost.",
                  );
                  if (!ok) return;
                  cancelBackfillMut.mutate();
                }}
              >
                Stop backfill
              </Button>
            </div>
            {/* PR #R4f — show the progress card whenever a run is actually
                in flight on the server, regardless of whether THIS client
                started it. Resumes correctly after a page refresh. */}
            {backfillIsRunning && backfillProgress && (
              <div className="text-xs rounded-md border border-blue-200 bg-blue-50 p-2.5 text-blue-900">
                <div className="flex items-center gap-2">
                  <RefreshCw className="size-3.5 animate-spin" />
                  <span className="font-medium">{backfillProgress.message ?? "Working…"}</span>
                </div>
                <div className="mt-1 font-mono">
                  page {backfillProgress.pages}
                  {backfillProgress.total_pages_estimate ? ` / ~${backfillProgress.total_pages_estimate}` : ""}
                  {" — "}
                  {backfillProgress.orders_scanned} scanned,
                  {" "}{backfillProgress.orders_updated} updated,
                  {" "}{backfillProgress.fulfillments_written} fulfillments
                  {backfillProgress.errors > 0 ? `, ${backfillProgress.errors} errors` : ""}
                </div>
                <div className="mt-1 text-[10px] text-blue-700/80">
                  syncLogId {backfillProgress.syncLogId} · started {shortTime(backfillProgress.startedAt)}
                </div>
              </div>
            )}
            {/* PR #R4g — Defensive observability. The Diagnostics disclosure
                is always rendered (collapsed by default) so if the progress
                card ever fails to appear despite a running backfill on the
                server, the operator can expand this and see exactly what
                the client knows about the poll. Surfaces query lifecycle
                state, last-good timestamp, and the raw response body. */}
            <details className="text-xs rounded-md border border-muted-foreground/20 bg-muted/30 px-2.5 py-1.5">
              <summary className="cursor-pointer select-none font-medium text-muted-foreground">
                Diagnostics
                <span className="ml-2 font-mono text-[10px] text-muted-foreground/70">
                  status={backfillProgressQ.status}
                  {backfillProgressQ.isFetching ? " · fetching" : ""}
                  {backfillProgressQ.isError ? " · ERROR" : ""}
                </span>
              </summary>
              <div className="mt-2 space-y-1.5 font-mono text-[11px] text-foreground/80">
                <div>
                  <span className="text-muted-foreground">Query status:</span>{" "}
                  {backfillProgressQ.status}
                  {backfillProgressQ.isFetching ? " (refetching)" : ""}
                </div>
                <div>
                  <span className="text-muted-foreground">Last successful response:</span>{" "}
                  {backfillProgressQ.dataUpdatedAt
                    ? new Date(backfillProgressQ.dataUpdatedAt).toLocaleTimeString()
                    : "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Last error:</span>{" "}
                  {backfillProgressQ.error
                    ? String((backfillProgressQ.error as Error).message ?? backfillProgressQ.error)
                    : "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Stored auth token present:</span>{" "}
                  {typeof localStorage !== "undefined" && localStorage.getItem("snohaus_token") ? "yes" : "no"}
                </div>
                <div className="mt-1.5">
                  <div className="text-muted-foreground mb-0.5">data.progress:</div>
                  <pre className="whitespace-pre-wrap break-all text-[10px] bg-background/60 rounded px-1.5 py-1 border">
                    {backfillProgressQ.data?.progress
                      ? JSON.stringify(backfillProgressQ.data.progress, null, 2)
                      : "null"}
                  </pre>
                </div>
                <div>
                  <div className="text-muted-foreground mb-0.5">data.recent (last 3):</div>
                  <pre className="whitespace-pre-wrap break-all text-[10px] bg-background/60 rounded px-1.5 py-1 border">
                    {backfillProgressQ.data?.recent && backfillProgressQ.data.recent.length > 0
                      ? JSON.stringify(backfillProgressQ.data.recent.slice(0, 3), null, 2)
                      : "[]"}
                  </pre>
                </div>
              </div>
            </details>
            {fulfillmentBackfillMut.data && (
              <div
                className={`text-sm rounded-md border p-3 ${
                  fulfillmentBackfillMut.data.error
                    ? "border-red-200 bg-red-50"
                    : "border-green-200 bg-green-50"
                }`}
              >
                {fulfillmentBackfillMut.data.error ? (
                  <div className="text-red-800">
                    <AlertTriangle className="size-4 inline mr-1" />
                    {fulfillmentBackfillMut.data.error}
                  </div>
                ) : (
                  <div className="text-green-800">
                    Scanned <b>{fulfillmentBackfillMut.data.orders_scanned}</b> orders, updated{" "}
                    <b>{fulfillmentBackfillMut.data.orders_updated}</b>, wrote{" "}
                    <b>{fulfillmentBackfillMut.data.fulfillments_written}</b> fulfillment row(s)
                    {fulfillmentBackfillMut.data.errors > 0 ? `, ${fulfillmentBackfillMut.data.errors} error(s)` : ""}.
                    {" "}Re-run allocation for the same month after this completes.
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ===== 2b. Orders summary — PR #R2f ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BarChart3 className="size-4" /> Orders summary</CardTitle>
          <CardDescription>
            What's in the database after the backfill. Sanity-check totals, date range, and per-month volume before moving to allocation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {summaryQ.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {summaryQ.data && (
            <>
              {/* Top-line metrics */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground">Total orders</div>
                  <div className="text-2xl font-semibold">{num(summaryQ.data.total_orders)}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{num(summaryQ.data.total_line_items)} line items</div>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground">Gross sales</div>
                  <div className="text-2xl font-semibold">{money(summaryQ.data.gross_total)}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Tax: {money(summaryQ.data.gross_tax)}</div>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground">Discounts</div>
                  <div className="text-2xl font-semibold">{money(summaryQ.data.gross_discounts)}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Refunded: {money(summaryQ.data.gross_refunded)}</div>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground flex items-center gap-1"><CalendarRange className="size-3" /> Date range</div>
                  <div className="text-sm font-semibold mt-1">{shortDate(summaryQ.data.earliest_order_at)}</div>
                  <div className="text-xs text-muted-foreground">to {shortDate(summaryQ.data.latest_order_at)}</div>
                </div>
              </div>

              {/* Flags */}
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">Gift card orders: {num(summaryQ.data.gift_card_orders)}</Badge>
                <Badge variant="outline">Shop-channel (tax remitted by Shopify): {num(summaryQ.data.channel_liable_orders)}</Badge>
              </div>

              {/* Per-month */}
              <div>
                <div className="text-sm font-medium mb-1.5 flex items-center gap-1.5"><CalendarRange className="size-4" /> By month</div>
                <div className="border rounded-md overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-medium">Month</th>
                        <th className="text-right px-3 py-1.5 font-medium">Orders</th>
                        <th className="text-right px-3 py-1.5 font-medium">Gross</th>
                        <th className="text-right px-3 py-1.5 font-medium">Tax</th>
                        <th className="text-right px-3 py-1.5 font-medium">Discounts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryQ.data.by_month.map((r) => (
                        <tr key={r.month} className="border-t">
                          <td className="px-3 py-1.5">{monthLabel(r.month)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{num(r.orders)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{money(r.total)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{money(r.tax)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{money(r.discounts)}</td>
                        </tr>
                      ))}
                      {summaryQ.data.by_month.length === 0 && (
                        <tr><td colSpan={5} className="px-3 py-3 text-center text-muted-foreground">No orders yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Per-channel + per-location side-by-side */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-sm font-medium mb-1.5 flex items-center gap-1.5"><Store className="size-4" /> By channel</div>
                  {/* PR #R4d — five-bucket roll-up over the raw source_name rows.
                      Surfaces Locally / draft / shop-pay / other so we can spot
                      Locally volume at a glance without scrolling the raw table. */}
                  {(() => {
                    const buckets: Record<string, { orders: number; total: number }> = {
                      pos: { orders: 0, total: 0 },
                      web: { orders: 0, total: 0 },
                      shopify_draft_order: { orders: 0, total: 0 },
                      locally: { orders: 0, total: 0 },
                      other: { orders: 0, total: 0 },
                    };
                    for (const r of summaryQ.data.by_channel) {
                      const sn = (r.source_name || "").toLowerCase();
                      let key = "other";
                      if (sn === "pos") key = "pos";
                      else if (sn === "web" || sn === "shopify_payments" || sn === "shop") key = "web";
                      else if (sn === "shopify_draft_order" || sn.includes("draft")) key = "shopify_draft_order";
                      else if (sn.includes("locally")) key = "locally";
                      buckets[key].orders += r.orders;
                      buckets[key].total += r.total;
                    }
                    const order: Array<keyof typeof buckets> = ["pos", "web", "shopify_draft_order", "locally", "other"];
                    return (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {order.map((k) => (
                          <Badge key={k} variant="outline" className="text-xs font-mono">
                            {k}: {num(buckets[k].orders)} · {money(buckets[k].total)}
                          </Badge>
                        ))}
                      </div>
                    );
                  })()}
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium">Source</th>
                          <th className="text-right px-3 py-1.5 font-medium">Orders</th>
                          <th className="text-right px-3 py-1.5 font-medium">Gross</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summaryQ.data.by_channel.map((r, i) => (
                          <tr key={`${r.source_name ?? "null"}-${i}`} className="border-t">
                            <td className="px-3 py-1.5 font-mono text-xs">{r.source_name ?? "(unknown)"}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{num(r.orders)}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{money(r.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-1.5 flex items-center gap-1.5"><Store className="size-4" /> By location</div>
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium">Location ID</th>
                          <th className="text-right px-3 py-1.5 font-medium">Orders</th>
                          <th className="text-right px-3 py-1.5 font-medium">Gross</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summaryQ.data.by_location.map((r, i) => (
                          <tr key={`${r.location_id ?? "null"}-${i}`} className="border-t">
                            <td className="px-3 py-1.5 font-mono text-xs">{r.location_id ?? "(unassigned)"}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{num(r.orders)}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{money(r.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Financial status */}
              <div>
                <div className="text-sm font-medium mb-1.5">By financial status</div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {summaryQ.data.by_financial_status.map((r, i) => (
                    <Badge key={`${r.financial_status ?? "null"}-${i}`} variant="secondary">
                      {r.financial_status ?? "(unknown)"}: {num(r.orders)}
                    </Badge>
                  ))}
                </div>
              </div>

              <Button size="sm" variant="outline" onClick={() => summaryQ.refetch()}>
                <RefreshCw className="size-4 mr-1.5" /> Refresh summary
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* ===== 2c. Payouts sync — PR #R3 ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Banknote className="size-4" /> Payouts sync</CardTitle>
          <CardDescription>
            Pulls Shopify Payments deposits + balance transactions (charges, refunds, fees, chargebacks).
            Runs every 12 hours automatically. Click to force a pull now.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="font-medium">Current watermark</div>
            <div className="font-mono text-xs">{payoutsWatermarkQ.data?.payouts_watermark ?? "(none — first run)"}</div>
            <div className="font-medium">Payouts in DB</div>
            <div className="font-mono text-xs">
              {payoutsSampleQ.data ? `${payoutsSampleQ.data.length} (most recent shown below)` : "—"}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              size="sm"
              onClick={() => payoutsSyncMut.mutate()}
              disabled={!configured || payoutsSyncMut.isPending}
            >
              {payoutsSyncMut.isPending
                ? <RefreshCw className="size-4 mr-1.5 animate-spin" />
                : <RefreshCw className="size-4 mr-1.5" />}
              Sync now
            </Button>
          </div>
          {payoutsSyncMut.data && (
            <div className={`text-sm rounded-md border p-3 ${payoutsSyncMut.data.error ? "border-red-200 bg-red-50" : "border-green-200 bg-green-50"}`}>
              {payoutsSyncMut.data.error ? (
                <div className="text-red-800"><AlertTriangle className="size-4 inline mr-1" />{payoutsSyncMut.data.error}</div>
              ) : (
                <div className="text-green-800">
                  Synced <b>{payoutsSyncMut.data.payoutsIngested}</b> payouts across <b>{payoutsSyncMut.data.pages}</b> page(s) —
                  {" "}{payoutsSyncMut.data.inserted} new, {payoutsSyncMut.data.updated} updated.
                  {" "}<b>{payoutsSyncMut.data.balanceTransactionsIngested}</b> balance transactions,
                  {" "}<b className={payoutsSyncMut.data.chargebacksDetected > 0 ? "text-amber-700" : undefined}>
                    {payoutsSyncMut.data.chargebacksDetected}
                  </b> chargeback(s).
                </div>
              )}
            </div>
          )}

          {/* Recent payouts sample */}
          {payoutsSampleQ.data && payoutsSampleQ.data.length > 0 && (
            <div className="pt-2">
              <div className="text-sm font-medium mb-1.5">Recent payouts (most recent first)</div>
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="text-left px-3 py-1.5 font-medium">Payout ID</th>
                      <th className="text-left px-3 py-1.5 font-medium">Date</th>
                      <th className="text-right px-3 py-1.5 font-medium">Amount</th>
                      <th className="text-left px-3 py-1.5 font-medium">Status</th>
                      <th className="text-right px-3 py-1.5 font-medium">Txns</th>
                      <th className="text-right px-3 py-1.5 font-medium">Chargebacks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payoutsSampleQ.data.slice(0, 25).map((p) => (
                      <tr key={p.id} className="border-t">
                        <td className="px-3 py-1.5 font-mono text-xs">{p.id}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{p.payout_date}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{money(p.amount)}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{p.status ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{num(p.txn_count)}</td>
                        <td className={`px-3 py-1.5 text-right font-mono ${p.chargeback_count > 0 ? "text-amber-700 font-semibold" : ""}`}>
                          {p.chargeback_count > 0
                            ? <span className="inline-flex items-center gap-1"><ShieldAlert className="size-3.5" />{num(p.chargeback_count)}</span>
                            : num(p.chargeback_count)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 2d. Payouts summary — PR #R3 ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BarChart3 className="size-4" /> Payouts summary</CardTitle>
          <CardDescription>
            Aggregated view of Shopify Payments. Use this to validate the totals against your bank deposits before PR #R5 builds the Plaid matcher.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {payoutsSummaryQ.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {payoutsSummaryQ.data && (
            <>
              {/* Top-line metrics */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground">Total payouts</div>
                  <div className="text-2xl font-semibold">{num(payoutsSummaryQ.data.total_payouts)}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{num(payoutsSummaryQ.data.total_balance_transactions)} balance txns</div>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground">Gross paid out</div>
                  <div className="text-2xl font-semibold">{money(payoutsSummaryQ.data.gross_payout_amount)}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Fees: {money(payoutsSummaryQ.data.total_fees)}</div>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground flex items-center gap-1"><ShieldAlert className="size-3" /> Chargebacks</div>
                  <div className={`text-2xl font-semibold ${payoutsSummaryQ.data.chargeback_count > 0 ? "text-amber-700" : ""}`}>
                    {num(payoutsSummaryQ.data.chargeback_count)}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{money(payoutsSummaryQ.data.total_chargebacks)} disputed</div>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground flex items-center gap-1"><CalendarRange className="size-3" /> Date range</div>
                  <div className="text-sm font-semibold mt-1">{shortDate(payoutsSummaryQ.data.earliest_payout_at)}</div>
                  <div className="text-xs text-muted-foreground">to {shortDate(payoutsSummaryQ.data.latest_payout_at)}</div>
                </div>
              </div>

              {/* Flags */}
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">Unmatched to bank: {num(payoutsSummaryQ.data.unmatched_payouts)}</Badge>
              </div>

              {/* Per-month */}
              <div>
                <div className="text-sm font-medium mb-1.5 flex items-center gap-1.5"><CalendarRange className="size-4" /> By month</div>
                <div className="border rounded-md overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-medium">Month</th>
                        <th className="text-right px-3 py-1.5 font-medium">Payouts</th>
                        <th className="text-right px-3 py-1.5 font-medium">Amount</th>
                        <th className="text-right px-3 py-1.5 font-medium">Chargebacks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payoutsSummaryQ.data.by_month.map((r) => (
                        <tr key={r.month} className="border-t">
                          <td className="px-3 py-1.5">{monthLabel(r.month)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{num(r.payouts)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{money(r.amount)}</td>
                          <td className={`px-3 py-1.5 text-right font-mono ${r.chargebacks > 0 ? "text-amber-700" : ""}`}>
                            {num(r.chargebacks)}
                          </td>
                        </tr>
                      ))}
                      {payoutsSummaryQ.data.by_month.length === 0 && (
                        <tr><td colSpan={4} className="px-3 py-3 text-center text-muted-foreground">No payouts yet</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* By status + by txn type */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-sm font-medium mb-1.5">By status</div>
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium">Status</th>
                          <th className="text-right px-3 py-1.5 font-medium">Payouts</th>
                          <th className="text-right px-3 py-1.5 font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payoutsSummaryQ.data.by_status.map((r, i) => (
                          <tr key={`${r.status ?? "null"}-${i}`} className="border-t">
                            <td className="px-3 py-1.5 font-mono text-xs">{r.status ?? "(unknown)"}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{num(r.payouts)}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{money(r.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-1.5">By transaction type</div>
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-xs text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-1.5 font-medium">Type</th>
                          <th className="text-right px-3 py-1.5 font-medium">Count</th>
                          <th className="text-right px-3 py-1.5 font-medium">Amount</th>
                          <th className="text-right px-3 py-1.5 font-medium">Fees</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payoutsSummaryQ.data.by_txn_type.map((r, i) => (
                          <tr key={`${r.type}-${i}`} className="border-t">
                            <td className="px-3 py-1.5 font-mono text-xs">{r.type}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{num(r.count)}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{money(r.amount)}</td>
                            <td className="px-3 py-1.5 text-right font-mono">{money(r.fees)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <Button size="sm" variant="outline" onClick={() => payoutsSummaryQ.refetch()}>
                <RefreshCw className="size-4 mr-1.5" /> Refresh summary
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* ===== 3. Webhooks ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Cable className="size-4" /> Webhooks</CardTitle>
          <CardDescription>Real-time order events. Auto-registered on boot. Use Reset after rotating the ngrok URL.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-muted-foreground">
            Subscribed topics: <span className="font-mono">orders/create</span>, <span className="font-mono">orders/updated</span>, <span className="font-mono">orders/cancelled</span>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => registerMut.mutate()} disabled={!configured || registerMut.isPending}>
              {registerMut.isPending ? <RefreshCw className="size-4 mr-1.5 animate-spin" /> : <Cable className="size-4 mr-1.5" />}
              Re-register
            </Button>
            <Button size="sm" variant="outline" onClick={() => {
              if (confirm("Delete all webhook subscriptions pointed at our public URL?")) resetWebhooksMut.mutate();
            }} disabled={!configured || resetWebhooksMut.isPending}>
              <Trash2 className="size-4 mr-1.5" /> Reset
            </Button>
          </div>
          {registerMut.data && (
            <div className="text-sm rounded-md border p-3 bg-muted/50">
              {registerMut.data.results.map(r => (
                <div key={r.topic} className="font-mono text-xs flex justify-between gap-3 py-0.5">
                  <span>{r.topic}</span>
                  <span className={r.state === "error" ? "text-red-700" : r.state === "created" ? "text-green-700" : r.state === "updated" ? "text-amber-700" : "text-muted-foreground"}>
                    {r.state}{r.error ? `: ${r.error}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 4. Shopify locations ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ListChecks className="size-4" /> Shopify locations</CardTitle>
          <CardDescription>Verify which Shopify locations exist — these get mapped to legal entities in Phase 2.</CardDescription>
        </CardHeader>
        <CardContent>
          {locationsQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : !locationsQ.data || locationsQ.data.length === 0 ? (
            <div className="text-sm text-muted-foreground">No locations found.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-1.5 font-medium">ID</th>
                  <th className="py-1.5 font-medium">Name</th>
                  <th className="py-1.5 font-medium">Active</th>
                </tr>
              </thead>
              <tbody>
                {locationsQ.data.map(l => (
                  <tr key={l.id} className="border-b last:border-0">
                    <td className="py-1.5 font-mono text-xs">{l.id}</td>
                    <td className="py-1.5">{l.name}{l.legacy && <span className="ml-2 text-xs text-muted-foreground">(legacy)</span>}</td>
                    <td className="py-1.5">{l.active ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* ===== 5. Recent orders sample ===== */}
      <Card>
        <CardHeader>
          <CardTitle>Recent ingested orders (sample)</CardTitle>
          <CardDescription>Spot-check these against the Shopify admin to confirm transform is correct.</CardDescription>
        </CardHeader>
        <CardContent>
          {ordersQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : !ordersQ.data || ordersQ.data.length === 0 ? (
            <div className="text-sm text-muted-foreground">No orders ingested yet — run Sync now above.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-1.5 font-medium">Order</th>
                    <th className="py-1.5 font-medium">Created</th>
                    <th className="py-1.5 font-medium">Source</th>
                    <th className="py-1.5 font-medium">Location</th>
                    <th className="py-1.5 font-medium text-right">Total</th>
                    <th className="py-1.5 font-medium text-right">Tax</th>
                    <th className="py-1.5 font-medium">Status</th>
                    <th className="py-1.5 font-medium">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {ordersQ.data.map(o => (
                    <tr key={o.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-1.5 font-mono text-xs">{o.name ?? o.id}</td>
                      <td className="py-1.5 text-xs">{shortTime(o.created_at)}</td>
                      <td className="py-1.5 text-xs">{o.source_name ?? "—"}</td>
                      <td className="py-1.5 font-mono text-xs">{o.location_id ?? "—"}</td>
                      <td className="py-1.5 text-right">{moneyOrDash(o.total_price)}</td>
                      <td className="py-1.5 text-right">{moneyOrDash(o.total_tax)}</td>
                      <td className="py-1.5 text-xs">{o.financial_status ?? "—"}</td>
                      <td className="py-1.5">
                        <div className="flex gap-1">
                          {o.has_gift_card === 1 && <Badge variant="outline" className="text-xs">GC</Badge>}
                          {o.tax_channel_liable === 1 && <Badge variant="outline" className="text-xs">Shop tax</Badge>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 6. Sync log ===== */}
      <Card>
        <CardHeader>
          <CardTitle>Sync log</CardTitle>
          <CardDescription>Every sync run and webhook event is recorded here.</CardDescription>
        </CardHeader>
        <CardContent>
          {syncLogQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : !syncLogQ.data || syncLogQ.data.length === 0 ? (
            <div className="text-sm text-muted-foreground">No sync log entries yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-1.5 font-medium">Started</th>
                    <th className="py-1.5 font-medium">Kind</th>
                    <th className="py-1.5 font-medium">Trigger</th>
                    <th className="py-1.5 font-medium">Status</th>
                    <th className="py-1.5 font-medium text-right">Rows</th>
                    <th className="py-1.5 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {syncLogQ.data.map(r => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-1.5 text-xs">{shortTime(r.started_at)}</td>
                      <td className="py-1.5 font-mono text-xs">{r.kind}</td>
                      <td className="py-1.5 text-xs">{r.triggered_by ?? "—"}</td>
                      <td className="py-1.5 text-xs">
                        <span className={r.status === "success" ? "text-green-700" : r.status === "failure" ? "text-red-700" : "text-muted-foreground"}>
                          {r.status}
                        </span>
                      </td>
                      <td className="py-1.5 text-right text-xs">{r.rows_ingested ?? "—"}</td>
                      <td className="py-1.5 font-mono text-xs text-muted-foreground truncate max-w-md" title={r.error_message ?? r.cursor ?? ""}>
                        {r.error_message ?? r.cursor ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 6.5. Suggested entity ↔ Shopify location mapping (PR #R3b) ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><MapPin className="size-4" /> Suggested entity ↔ location mapping</CardTitle>
          <CardDescription>
            One row per Shopify location with a suggested legal entity + kind based on name match.
            Edit any row before saving. Re-runnable as new stores are added.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => mappingSuggestedMut.mutate()}
              disabled={mappingSuggestedMut.isPending || !configured}
            >
              <RefreshCw className={`size-4 mr-1.5 ${mappingSuggestedMut.isPending ? "animate-spin" : ""}`} />
              {mappingDraft ? "Reload suggestions" : "Load suggestions"}
            </Button>
            {mappingDraft && mappingDraft.length > 0 && (() => {
              const allSynced = mappingDraft.every(r => r.current_entity_id != null && r.current_entity_id === r.suggested_entity_id && (r.current_kind ?? "pos") === r.suggested_kind);
              const pendingCount = mappingDraft.filter(r => r.current_entity_id == null || r.current_entity_id !== r.suggested_entity_id || (r.current_kind ?? "pos") !== r.suggested_kind).length;
              return (
                <Button
                  size="sm"
                  variant={allSynced ? "outline" : "default"}
                  onClick={() => mappingDraft && mappingSaveMut.mutate(mappingDraft)}
                  disabled={mappingSaveMut.isPending || allSynced}
                >
                  {allSynced ? (
                    <><Check className="size-4 mr-1.5 text-emerald-700" /> All saved</>
                  ) : (
                    <><Save className="size-4 mr-1.5" /> Confirm & save ({pendingCount} pending)</>
                  )}
                </Button>
              );
            })()}
            {!configured && (
              <span className="text-xs text-muted-foreground">Connect Shopify first.</span>
            )}
          </div>

          {mappingSaveMut.isSuccess && mappingDraft && mappingDraft.length > 0 && mappingDraft.every(r => r.current_entity_id != null && r.current_entity_id === r.suggested_entity_id && (r.current_kind ?? "pos") === r.suggested_kind) && (
            <div className="flex items-center gap-2 text-emerald-700 text-sm bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded-md px-3 py-2">
              <CheckCircle2 className="size-4" />
              All {mappingDraft.length} locations saved. Last save: {mappingSaveMut.data ? `${mappingSaveMut.data.inserted} inserted, ${mappingSaveMut.data.updated} updated, ${mappingSaveMut.data.skipped} skipped` : ""}
            </div>
          )}

          {mappingDraft && mappingDraft.length > 0 && (
            <div className="border rounded-md overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="px-2 py-2 font-medium">Shopify location</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium text-right">Orders 365d</th>
                    <th className="px-2 py-2 font-medium text-right">Sales 365d</th>
                    <th className="px-2 py-2 font-medium">Entity</th>
                    <th className="px-2 py-2 font-medium">Kind</th>
                    <th className="px-2 py-2 font-medium">Current</th>
                  </tr>
                </thead>
                <tbody>
                  {mappingDraft.map((row, idx) => {
                    const changed =
                      row.current_entity_id !== row.suggested_entity_id ||
                      (row.current_kind ?? "pos") !== row.suggested_kind;
                    return (
                      <tr key={row.shopify_location_id} className="border-t">
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <Building2 className="size-3 text-muted-foreground" />
                            <span className="font-medium">{row.shopify_location_name}</span>
                          </div>
                          <div className="text-muted-foreground font-mono text-[10px]">id: {row.shopify_location_id}</div>
                        </td>
                        <td className="px-2 py-1.5">
                          {row.active ? (
                            <Badge variant="outline" className="text-[10px]">active</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px]">inactive</Badge>
                          )}
                          {row.legacy && <Badge variant="secondary" className="text-[10px] ml-1">legacy</Badge>}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{num(row.order_count_365d)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{money(row.total_sales_365d)}</td>
                        <td className="px-2 py-1.5">
                          <select
                            className="w-full text-xs border rounded px-1 py-1 bg-background"
                            value={row.suggested_entity_id ?? ""}
                            onChange={e => updateDraftRow(idx, {
                              suggested_entity_id: e.target.value === "" ? null : Number(e.target.value),
                              suggested_entity_location: mappingEntities.find(ent => ent.id === Number(e.target.value))?.location ?? null,
                            })}
                          >
                            <option value="">— unassigned —</option>
                            {mappingEntities.map(ent => (
                              <option key={ent.id} value={ent.id}>{ent.location} ({ent.legal_name})</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            className="w-full text-xs border rounded px-1 py-1 bg-background"
                            value={row.suggested_kind}
                            onChange={e => updateDraftRow(idx, { suggested_kind: e.target.value as MappingKind })}
                          >
                            <option value="pos">POS (in-store)</option>
                            <option value="fulfillment">Online fulfillment</option>
                            <option value="warehouse">Warehouse (no sales)</option>
                            <option value="inactive">Inactive / ignore</option>
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          {row.current_entity_id == null ? (
                            <span className="inline-flex items-center gap-1 text-amber-700 text-[11px]">
                              <AlertTriangle className="size-3" /> not saved yet
                            </span>
                          ) : changed ? (
                            <span className="inline-flex items-center gap-1 text-blue-700 text-[11px]">
                              {row.current_entity_location} / {row.current_kind} → will update
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px]">
                              <Check className="size-3" /> saved
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {mappingDraft && mappingDraft.length === 0 && (
            <div className="text-sm text-muted-foreground">Shopify returned no locations. Check the connection.</div>
          )}

          {mappingSaveMut.data && mappingSaveMut.data.errors.length > 0 && (
            <div className="text-xs space-y-1">
              <div className="font-medium text-amber-700">Save errors:</div>
              {mappingSaveMut.data.errors.map((e, i) => (
                <div key={i} className="font-mono text-amber-700">• {e.shopify_location_id}: {e.message}</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 7. COA mapping (PR #R4a-prep) ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BookOpen className="size-4" /> Chart of Accounts mapping</CardTitle>
          <CardDescription>
            For each entity, upload its QuickBooks CoA CSV, then confirm which account fulfills each role the reconciler needs (sales income, COGS, Shopify PIT, etc.). This is the foundation Phase 2's journal entries will use.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Import status table */}
          <div className="rounded-md border">
            <div className="grid grid-cols-12 px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/40">
              <div className="col-span-4">Entity</div>
              <div className="col-span-3">Imported accounts</div>
              <div className="col-span-3">Last imported</div>
              <div className="col-span-2 text-right">Action</div>
            </div>
            {coaStatusQ.isLoading && (
              <div className="px-3 py-3 text-sm text-muted-foreground">Loading…</div>
            )}
            {coaStatusQ.data?.map(row => (
              <div key={row.entity_id} className="grid grid-cols-12 px-3 py-2 text-sm border-t items-center">
                <div className="col-span-4">
                  <div className="font-medium flex items-center gap-1.5"><Building2 className="size-3.5 text-muted-foreground" /> {row.location}</div>
                  <div className="text-xs text-muted-foreground">{row.legal_name}</div>
                </div>
                <div className="col-span-3">
                  {row.account_count === 0 ? (
                    <span className="text-muted-foreground italic">Not yet imported</span>
                  ) : (
                    <span>{row.active_count} active / {row.account_count} total</span>
                  )}
                </div>
                <div className="col-span-3 text-xs text-muted-foreground">
                  {row.last_imported_at ? shortTime(row.last_imported_at) : "—"}
                </div>
                <div className="col-span-2 text-right">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer px-2 py-1 rounded-md border text-xs hover:bg-muted/40">
                    <Upload className="size-3.5" />
                    {row.account_count === 0 ? "Upload CSV" : "Replace CSV"}
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={e => {
                        const f = e.target.files?.[0];
                        if (f) handleCoaCsvUpload(row.entity_id, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                {coaUploadStatus[row.entity_id] && (
                  <div className={
                    "col-span-12 mt-1 text-xs " +
                    (coaUploadStatus[row.entity_id].kind === "ok" ? "text-green-700" :
                     coaUploadStatus[row.entity_id].kind === "err" ? "text-amber-700" : "text-muted-foreground")
                  }>
                    {coaUploadStatus[row.entity_id].kind === "ok" && <Check className="inline size-3 mr-1" />}
                    {coaUploadStatus[row.entity_id].kind === "err" && <AlertTriangle className="inline size-3 mr-1" />}
                    {coaUploadStatus[row.entity_id].msg}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Mapping matrix (only once at least one entity has imported) */}
          {coaMatrixQ.data && coaMatrixQ.data.entities.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Role → account mapping</div>
                  <div className="text-xs text-muted-foreground">
                    {coaMatrixQ.data.ready_for_phase_2
                      ? "All required cells filled. Ready for Phase 2."
                      : `${coaMatrixQ.data.missing_count} required cell${coaMatrixQ.data.missing_count === 1 ? "" : "s"} still missing.`}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => saveCoaMapping()}
                  disabled={coaSaveMut.isPending}
                  variant={coaSavedFlash && !coaDirty ? "secondary" : "default"}
                >
                  {coaSavedFlash && !coaDirty ? (
                    <><Check className="size-4 mr-1.5 text-green-600" /> Saved</>
                  ) : (
                    <><Save className="size-4 mr-1.5" /> Confirm &amp; save all</>
                  )}
                </Button>
              </div>

              {/* Group cells by section (Income / COGS / Expense / Asset / Liability / Inter-company) */}
              {["Income", "COGS", "Expense", "Asset", "Liability", "Inter-company"].map(section => {
                const rolesInSection = Object.entries(coaMatrixQ.data!.role_metadata)
                  .filter(([, meta]) => meta.section === section)
                  .map(([role]) => role);
                if (rolesInSection.length === 0) return null;
                return (
                  <div key={section} className="rounded-md border overflow-hidden">
                    <div className="px-3 py-2 bg-muted/60 text-xs font-semibold uppercase tracking-wide">
                      {section}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs text-muted-foreground border-b">
                            <th className="text-left px-3 py-2 w-[280px]">Role</th>
                            {coaMatrixQ.data!.entities.map(e => (
                              <th key={e.id} className="text-left px-3 py-2 min-w-[220px]">{e.location}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rolesInSection.map(role => {
                            const meta = coaMatrixQ.data!.role_metadata[role];
                            return (
                              <tr key={role} className="border-b last:border-b-0">
                                <td className="px-3 py-2 align-top">
                                  <div className="font-medium">{meta.label}</div>
                                  <div className="text-xs text-muted-foreground mt-0.5">{meta.description}</div>
                                </td>
                                {coaMatrixQ.data!.entities.map(e => {
                                  const cell = coaMatrixQ.data!.cells.find(c => c.entity_id === e.id && c.logical_role === role);
                                  if (!cell) return <td key={e.id} className="px-3 py-2 align-top text-xs text-muted-foreground italic">—</td>;
                                  if (cell.not_applicable) {
                                    return <td key={e.id} className="px-3 py-2 align-top text-xs text-muted-foreground italic">N/A</td>;
                                  }
                                  const value = getCellValue(e.id, role);
                                  const isEdited = cellKey(e.id, role) in coaDraft;
                                  const quality = cell.suggested_match_quality;
                                  const showQualityBadge = !cell.current_account_name && cell.suggested_account_name && !isEdited;
                                  return (
                                    <td key={e.id} className="px-3 py-2 align-top">
                                      <select
                                        className={
                                          "w-full text-xs border rounded-md px-2 py-1.5 bg-background " +
                                          (isEdited ? "border-blue-400 ring-1 ring-blue-100" : "")
                                        }
                                        value={value ?? ""}
                                        onChange={ev => {
                                          const v = ev.target.value || null;
                                          setCoaDraft(prev => ({ ...prev, [cellKey(e.id, role)]: v }));
                                        }}
                                      >
                                        <option value="">— not mapped —</option>
                                        {e.accounts.map(a => (
                                          <option key={a.account_name} value={a.account_name}>
                                            {a.account_number ? `${a.account_number} · ` : ""}{a.account_name}
                                          </option>
                                        ))}
                                      </select>
                                      {showQualityBadge && (
                                        <div className="mt-1">
                                          <Badge variant="outline" className={
                                            "text-[10px] py-0 px-1.5 " +
                                            (quality === "exact" ? "border-green-300 text-green-700" :
                                             quality === "strong" ? "border-blue-300 text-blue-700" :
                                             quality === "weak" ? "border-amber-300 text-amber-700" : "")
                                          }>
                                            {quality === "exact" ? "Exact match" : quality === "strong" ? "Likely match" : quality === "weak" ? "Possible match" : "No match"} — review
                                          </Badge>
                                        </div>
                                      )}
                                      {isEdited && (
                                        <div className="mt-1 text-[10px] text-blue-700">Unsaved change</div>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}

              {coaSaveMut.data && coaSaveMut.data.errors.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs space-y-1">
                  <div className="font-medium text-amber-700">Save errors:</div>
                  {coaSaveMut.data.errors.map((e, i) => (
                    <div key={i} className="font-mono text-amber-700">• entity {e.entity_id} / {e.logical_role}: {e.message}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ===== 8. Allocation engine (PR #R4) ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Calculator className="size-4" /> Allocation engine</CardTitle>
          <CardDescription>
            For each order, decide which legal entity owns the sale. Read-only — nothing is
            posted to QBO yet. Run a month, then review the per-entity rollup and any orders
            that need a manual call.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* --- Readiness banner --- */}
          {allocReadinessQ.data && (() => {
            const r = allocReadinessQ.data;
            const blockers: string[] = [];
            const warnings: string[] = [];
            if (!r.has_sd_entity) blockers.push("No SD Ski/Patio entity configured");
            if (!r.has_pos_mappings) blockers.push("No POS ↔ entity mappings saved (configure in card #5)");
            if (r.unmapped_active_locations > 0) warnings.push(`${r.unmapped_active_locations} active POS location(s) still unmapped`);
            if (!r.has_zip_lookups) warnings.push("No ZIP ↔ entity lookups configured (digital gift cards will be flagged)");
            if (!r.has_pro_rata) warnings.push("No prior-year pro-rata configured (used as last-resort fallback)");
            const ok = blockers.length === 0;
            return (
              <div className={`rounded border p-3 text-sm ${ok ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"}`}>
                <div className="flex items-center gap-2 font-medium">
                  {ok ? <CheckCircle2 className="size-4 text-green-700" /> : <XCircle className="size-4 text-red-700" />}
                  {ok ? "Ready to run" : "Not ready — fix blockers below"}
                </div>
                {blockers.length > 0 && (
                  <ul className="mt-2 ml-5 list-disc text-red-700">
                    {blockers.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                )}
                {warnings.length > 0 && (
                  <ul className="mt-2 ml-5 list-disc text-amber-800">
                    {warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
                <div className="mt-2 text-xs text-muted-foreground">
                  POS mappings: {r.pos_mapping_count} · ZIP lookups: {r.zip_lookup_count} ·
                  Pro-rata year: {r.pro_rata_year ?? "—"}
                </div>
              </div>
            );
          })()}

          {/* --- Run controls --- */}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Month</label>
              <input
                type="month"
                value={allocMonth}
                onChange={(e) => setAllocMonth(e.target.value)}
                className="border rounded px-2 py-1.5 text-sm font-mono bg-background text-foreground [color-scheme:light_dark]"
              />
            </div>
            <Button
              onClick={() => allocRunMut.mutate(allocMonth)}
              disabled={allocRunMut.isPending || !allocReadinessQ.data?.has_pos_mappings || !allocReadinessQ.data?.has_sd_entity}
            >
              <RefreshCw className={`size-4 mr-1.5 ${allocRunMut.isPending ? "animate-spin" : ""}`} />
              {allocRunMut.isPending ? "Running…" : `Run allocation for ${monthLabel(allocMonth)}`}
            </Button>
            {allocLastSummary && (
              <Badge variant={allocLastSummary.failed_orders > 0 ? "destructive" : "secondary"} className="text-xs">
                Last run: {allocLastSummary.orders_processed} orders → {allocLastSummary.allocations_written} rows
              </Badge>
            )}
          </div>

          {/* --- Run summary --- */}
          {allocLastSummary && (
            <div className="rounded border bg-muted/30 p-3 text-sm space-y-2">
              <div className="font-medium flex items-center gap-2">
                <Layers className="size-4" /> Run summary — {monthLabel(allocLastSummary.month)}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div><span className="text-muted-foreground">Orders processed:</span> <span className="font-mono">{num(allocLastSummary.orders_processed)}</span></div>
                <div><span className="text-muted-foreground">Line items:</span> <span className="font-mono">{num(allocLastSummary.line_items_processed)}</span></div>
                <div><span className="text-muted-foreground">Allocation rows:</span> <span className="font-mono">{num(allocLastSummary.allocations_written)}</span></div>
                <div><span className="text-muted-foreground">Needs review:</span> <span className={`font-mono ${allocLastSummary.needs_review_orders > 0 ? "text-amber-700" : ""}`}>{num(allocLastSummary.needs_review_orders)}</span></div>
                <div><span className="text-muted-foreground">Failed:</span> <span className={`font-mono ${allocLastSummary.failed_orders > 0 ? "text-red-700" : ""}`}>{num(allocLastSummary.failed_orders)}</span></div>
                <div><span className="text-muted-foreground">Ran at:</span> <span className="font-mono">{shortTime(allocLastSummary.ran_at)}</span></div>
              </div>
              <div className="text-xs">
                <div className="text-muted-foreground mb-1">By method:</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(allocLastSummary.by_method).map(([m, n]) => (
                    n > 0 ? <Badge key={m} variant="outline" className="font-mono">{m}: {num(n)}</Badge> : null
                  ))}
                </div>
              </div>
              {allocLastSummary.warnings && allocLastSummary.warnings.length > 0 && (
                <div className="text-xs text-amber-800">
                  <div className="font-medium">Warnings:</div>
                  <ul className="ml-5 list-disc">
                    {allocLastSummary.warnings.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}
                    {allocLastSummary.warnings.length > 8 && <li>… and {allocLastSummary.warnings.length - 8} more</li>}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* --- Per-entity rollup --- */}
          <div>
            <div className="text-sm font-medium mb-2">Per-entity rollup — {monthLabel(allocMonth)}</div>
            {allocRollupQ.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : !allocRollupQ.data || allocRollupQ.data.rows.length === 0 ? (
              <div className="text-sm text-muted-foreground italic">No allocations yet for this month. Click “Run allocation” above.</div>
            ) : (
              <div className="overflow-x-auto border rounded">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs">
                    <tr>
                      <th className="text-left px-2 py-1.5">Entity</th>
                      <th className="text-right px-2 py-1.5">Orders</th>
                      <th className="text-right px-2 py-1.5">Line items</th>
                      <th className="text-right px-2 py-1.5">Gross</th>
                      <th className="text-right px-2 py-1.5">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocRollupQ.data.rows.map((row) => (
                      <tr key={row.entity_id} className="border-t">
                        <td className="px-2 py-1.5">{row.entity_location ?? `Entity #${row.entity_id}`}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{num(row.orders)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{num(row.line_items)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{money(row.gross_total)}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{money(row.tax_total)}</td>
                      </tr>
                    ))}
                    {(() => {
                      const t = allocRollupQ.data.rows.reduce(
                        (acc, r) => ({
                          orders: acc.orders + r.orders,
                          line_items: acc.line_items + r.line_items,
                          gross: acc.gross + (r.gross_total ?? 0),
                          tax: acc.tax + (r.tax_total ?? 0),
                        }),
                        { orders: 0, line_items: 0, gross: 0, tax: 0 }
                      );
                      return (
                        <tr className="border-t bg-muted/30 font-medium">
                          <td className="px-2 py-1.5">Total</td>
                          <td className="px-2 py-1.5 text-right font-mono">{num(t.orders)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{num(t.line_items)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{money(t.gross)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{money(t.tax)}</td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* --- Needs review --- */}
          <div>
            <div className="text-sm font-medium mb-2 flex items-center gap-2">
              <ShieldAlert className="size-4 text-amber-700" />
              Needs review {allocNeedsReviewQ.data && allocNeedsReviewQ.data.rows.length > 0 && (
                <Badge variant="secondary" className="text-xs">{allocNeedsReviewQ.data.rows.length}</Badge>
              )}
            </div>
            {allocNeedsReviewQ.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : !allocNeedsReviewQ.data || allocNeedsReviewQ.data.rows.length === 0 ? (
              <div className="text-sm text-muted-foreground italic">No orders need manual review for this month.</div>
            ) : (
              <div className="overflow-x-auto border rounded">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs">
                    <tr>
                      <th className="text-left px-2 py-1.5">Order</th>
                      <th className="text-left px-2 py-1.5">Date</th>
                      <th className="text-left px-2 py-1.5">Source</th>
                      <th className="text-left px-2 py-1.5">Item</th>
                      <th className="text-right px-2 py-1.5">Gross</th>
                      <th className="text-left px-2 py-1.5">Reason</th>
                      <th className="text-left px-2 py-1.5">Override → entity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocNeedsReviewQ.data.rows.slice(0, 50).map((r, i) => {
                      const k = `${r.order_id}::${r.line_item_id ?? "_"}`;
                      const draft = overrideDraft[k] ?? "";
                      const entities = coaMatrixQ.data?.entities ?? [];
                      return (
                        <tr key={i} className="border-t align-top">
                          <td className="px-2 py-1.5 font-mono text-xs">{r.order_name ?? r.order_id}</td>
                          <td className="px-2 py-1.5 text-xs">{shortDate(r.order_created_at)}</td>
                          <td className="px-2 py-1.5 text-xs">{r.source_name ?? "—"}</td>
                          <td className="px-2 py-1.5 text-xs">
                            {r.title ?? r.sku ?? "—"}
                            {r.line_item_id && <div className="text-muted-foreground font-mono">li {r.line_item_id}</div>}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-xs">{money(r.gross_amount)}</td>
                          <td className="px-2 py-1.5 text-xs text-amber-800">{r.reason ?? "—"}</td>
                          <td className="px-2 py-1.5 text-xs">
                            <div className="flex items-center gap-1.5">
                              <select
                                value={draft}
                                onChange={(e) => setOverrideDraft(prev => ({
                                  ...prev,
                                  [k]: e.target.value === "" ? "" : Number(e.target.value),
                                }))}
                                className="border rounded px-1.5 py-1 text-xs bg-background text-foreground"
                              >
                                <option value="">— select —</option>
                                {entities.map(e => (
                                  <option key={e.id} value={e.id}>{e.location}</option>
                                ))}
                              </select>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={draft === "" || overrideMut.isPending}
                                onClick={() => {
                                  if (draft === "") return;
                                  overrideMut.mutate({
                                    order_id: r.order_id,
                                    line_item_id: r.line_item_id,
                                    entity_id: Number(draft),
                                  });
                                  setOverrideDraft(prev => ({ ...prev, [k]: "" }));
                                }}
                              >
                                <Save className="size-3 mr-1" /> Save
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {allocNeedsReviewQ.data.rows.length > 50 && (
                  <div className="text-xs text-muted-foreground p-2 border-t">
                    Showing first 50 of {allocNeedsReviewQ.data.rows.length} rows.
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ===== 8b. Gift card activity (PR #R4e) ===== */}
      <GiftCardActivityCard month={allocMonth} />

      {/* ===== 9. Error log ===== */}
      {(() => {
        if (!errorLogQ.data || errorLogQ.data.length === 0) return null;
        // PR #R4f — suppress 429 backoff lines from the Integration Errors
        // panel. The shopifyRestCall helper logs every "429 from <url> sleeping
        // <ms>ms" event so the operator can see throttling pressure, but it's
        // not an *error* — it's the rate limiter doing its job. Hide them by
        // default and just show a count, so a real error doesn't get lost in
        // hundreds of backoff lines during a long backfill.
        const isRateLimitNoise = (msg: string) =>
          /^429 from .* sleeping/i.test(msg);
        const filtered = errorLogQ.data.filter((e) => !isRateLimitNoise(e.message));
        const suppressed = errorLogQ.data.length - filtered.length;
        if (filtered.length === 0 && suppressed === 0) return null;
        return (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-700"><AlertTriangle className="size-4" /> Integration errors</CardTitle>
              <CardDescription>Transient API failures or HMAC mismatches. Safe to clear once reviewed.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                {filtered.map((e, i) => (
                  <div key={i} className="text-xs font-mono border-l-2 border-amber-300 pl-2">
                    <span className="text-muted-foreground">{shortTime(e.ts)}</span>{" "}
                    <span className="text-amber-700">[{e.scope}]</span>{" "}
                    <span>{e.message}</span>
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="text-xs text-muted-foreground italic">No real errors right now.</div>
                )}
              </div>
              {suppressed > 0 && (
                <div className="text-[10px] text-muted-foreground">
                  {suppressed} 429 backoff line{suppressed === 1 ? "" : "s"} suppressed (normal rate-limit pressure).
                </div>
              )}
              <Button size="sm" variant="outline" onClick={() => clearErrorsMut.mutate()}>
                <Trash2 className="size-4 mr-1.5" /> Clear error log
              </Button>
            </CardContent>
          </Card>
        );
      })()}

      {/* Tiny status line at the bottom */}
      {lastAction && (
        <>
          <Separator />
          <div className="text-xs text-muted-foreground">Last action: {lastAction}</div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// PR #R4e — Gift card activity (issuance + redemption + inter-company JE
// preview). Self-contained component, sources its own data from the new
// /api/recon/gc-redemptions and /api/recon/intercompany-jes endpoints. Driven
// by the allocation month picker (parent passes the same month string).
// =============================================================================

type GcRedemptionRow = {
  id: number;
  gc_id: string;
  order_id: string;
  transaction_id: string | null;
  amount: number;
  issuer_entity_id: number | null;
  redeemer_entity_id: number;
  is_cross_entity: number;
  redeemed_at: string;
};
type GcRedemptionSummary = {
  count: number;
  total_amount: number;
  cross_entity_count: number;
  cross_entity_amount: number;
  by_pair: Array<{
    issuer_entity_id: number | null;
    redeemer_entity_id: number;
    count: number;
    amount: number;
  }>;
};
type GcIssuanceSummary = {
  count: number;
  total_face_value: number;
  by_entity: Array<{ entity_id: number; count: number; face_value: number }>;
  by_method: Array<{ method: string; count: number; face_value: number }>;
};
type InterCoJeRow = {
  id: number;
  source_kind: string;
  source_id: number;
  entity_id: number;
  counterparty_entity_id: number;
  account_role: string;
  side: "DR" | "CR";
  amount: number;
  order_id: string | null;
  gc_id: string | null;
  created_at: string;
};
type EntityRow = { id: number; location: string; legal_name: string };

function GiftCardActivityCard({ month }: { month: string }) {
  // Month → [sinceIso, untilIso). The server's parseRangeOrNull expects
  // YYYY-MM-DD, so we convert month-start to month-end-exclusive here.
  const { since, until } = (() => {
    const [y, m] = month.split("-").map(Number);
    const sinceDate = `${month}-01`;
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const untilDate = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
    return { since: sinceDate, until: untilDate };
  })();

  const qc = useQueryClient();
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);

  const entitiesQ = useQuery<EntityRow[]>({ queryKey: ["/api/payroll/entities"] });
  const entityLabel = (id: number | null): string => {
    if (id == null) return "(unknown)";
    const e = entitiesQ.data?.find((x) => x.id === id);
    return e?.location ?? `entity ${id}`;
  };

  const redemptionsQ = useQuery<{ rows: GcRedemptionRow[]; summary: GcRedemptionSummary; issuance: GcIssuanceSummary }>({
    queryKey: ["/api/recon/gc-redemptions", since, until],
    queryFn: () =>
      jsonGet(`/api/recon/gc-redemptions?since=${since}&until=${until}`),
  });

  const jesQ = useQuery<{ rows: InterCoJeRow[] }>({
    queryKey: ["/api/recon/intercompany-jes", since, until],
    queryFn: () => jsonGet(`/api/recon/intercompany-jes?since=${since}&until=${until}`),
  });

  const rebuildMut = useMutation<{ orders_scanned: number; redemptions_recorded: number; je_legs_emitted: number; orders_deferred: number; errors: number }, Error>({
    mutationFn: () => jsonPost("/api/recon/gc-redemptions/rebuild", { since, until }),
    onSuccess: (r) => {
      setResyncMsg(
        `Scanned ${r.orders_scanned} orders → ${r.redemptions_recorded} redemptions, ${r.je_legs_emitted} JE legs` +
        (r.orders_deferred > 0 ? `, ${r.orders_deferred} deferred (no allocation)` : "") +
        (r.errors > 0 ? `, ${r.errors} errors` : ""),
      );
      qc.invalidateQueries({ queryKey: ["/api/recon/gc-redemptions", since, until] });
      qc.invalidateQueries({ queryKey: ["/api/recon/intercompany-jes", since, until] });
    },
    onError: (e) => setResyncMsg(`Rebuild failed: ${e.message}`),
  });

  const issuance = redemptionsQ.data?.issuance;
  const redemptionSummary = redemptionsQ.data?.summary;

  // Group JE legs by entity for the preview disclosure.
  const jesByEntity = (() => {
    const map = new Map<number, InterCoJeRow[]>();
    for (const j of jesQ.data?.rows ?? []) {
      const arr = map.get(j.entity_id) ?? [];
      arr.push(j);
      map.set(j.entity_id, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  })();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Banknote className="size-4" /> Gift card activity — {monthLabel(month)}
        </CardTitle>
        <CardDescription>
          Issuance ledger + redemption ledger + inter-company JE preview for the
          selected month. Read-only — these records will eventually feed the
          QBO journal-entry posting in Phase 2.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Issuance + Redemption cards stacked */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Issuance */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="text-sm font-semibold flex items-center gap-1.5">
              <Banknote className="size-4" /> Issuance
            </div>
            {issuance ? (
              <>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <div className="text-muted-foreground">Cards issued</div>
                  <div className="font-mono text-right">{issuance.count}</div>
                  <div className="text-muted-foreground">Total face value</div>
                  <div className="font-mono text-right">{money(issuance.total_face_value)}</div>
                </div>
                {issuance.by_entity.length > 0 && (
                  <div className="text-xs">
                    <div className="font-medium mb-0.5">By entity</div>
                    <div className="space-y-0.5">
                      {issuance.by_entity.map((r) => (
                        <div key={r.entity_id} className="flex justify-between font-mono">
                          <span>{entityLabel(r.entity_id)}</span>
                          <span>{r.count} · {money(r.face_value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {issuance.by_method.length > 0 && (
                  <div className="text-xs">
                    <div className="font-medium mb-0.5">By method</div>
                    <div className="space-y-0.5">
                      {issuance.by_method.map((r) => (
                        <div key={r.method} className="flex justify-between font-mono">
                          <span>{r.method}</span>
                          <span>{r.count} · {money(r.face_value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-muted-foreground italic">Loading…</div>
            )}
          </div>

          {/* Redemption */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="text-sm font-semibold flex items-center gap-1.5">
              <Banknote className="size-4" /> Redemption
            </div>
            {redemptionSummary ? (
              <>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <div className="text-muted-foreground">Redemptions</div>
                  <div className="font-mono text-right">{redemptionSummary.count}</div>
                  <div className="text-muted-foreground">Total redeemed</div>
                  <div className="font-mono text-right">{money(redemptionSummary.total_amount)}</div>
                  <div className="text-muted-foreground">Cross-entity</div>
                  <div className="font-mono text-right">{redemptionSummary.cross_entity_count}</div>
                  <div className="text-muted-foreground">Cross-entity $</div>
                  <div className="font-mono text-right">{money(redemptionSummary.cross_entity_amount)}</div>
                </div>
                {redemptionSummary.by_pair.length > 0 && (
                  <div className="text-xs">
                    <div className="font-medium mb-0.5">Issuer → Redeemer</div>
                    <div className="space-y-0.5">
                      {redemptionSummary.by_pair.map((p, i) => (
                        <div key={i} className="flex justify-between font-mono">
                          <span>
                            {entityLabel(p.issuer_entity_id)} → {entityLabel(p.redeemer_entity_id)}
                          </span>
                          <span>{p.count} · {money(p.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-muted-foreground italic">Loading…</div>
            )}
          </div>
        </div>

        {/* Resync button + status */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => rebuildMut.mutate()}
            disabled={rebuildMut.isPending}
            data-testid="button-gc-redemption-rebuild"
          >
            <RefreshCw className={`size-4 mr-1.5 ${rebuildMut.isPending ? "animate-spin" : ""}`} />
            {rebuildMut.isPending ? "Resyncing…" : "Resync GC redemptions"}
          </Button>
          {resyncMsg && <span className="text-xs text-muted-foreground">{resyncMsg}</span>}
        </div>

        {/* Inter-company JE preview */}
        <details className="rounded-md border px-3 py-2 bg-muted/30">
          <summary className="cursor-pointer select-none text-sm font-medium">
            Inter-company JE preview
            <span className="ml-2 text-[10px] font-mono text-muted-foreground">
              {jesQ.data?.rows.length ?? 0} legs across {jesByEntity.length} entit{jesByEntity.length === 1 ? "y" : "ies"}
            </span>
          </summary>
          <div className="mt-2 space-y-3">
            {jesByEntity.length === 0 && (
              <div className="text-xs text-muted-foreground italic">No JE legs for this period yet.</div>
            )}
            {jesByEntity.map(([entityId, legs]) => (
              <div key={entityId} className="rounded-md border bg-background">
                <div className="px-2 py-1.5 text-xs font-semibold bg-muted/50 border-b">
                  {entityLabel(entityId)} · {legs.length} leg{legs.length === 1 ? "" : "s"}
                </div>
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium">Order</th>
                      <th className="text-left px-2 py-1 font-medium">GC</th>
                      <th className="text-left px-2 py-1 font-medium">Account role</th>
                      <th className="text-center px-2 py-1 font-medium">Side</th>
                      <th className="text-right px-2 py-1 font-medium">Amount</th>
                      <th className="text-left px-2 py-1 font-medium">Counterparty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {legs.map((j) => (
                      <tr key={j.id} className="border-t">
                        <td className="px-2 py-1 font-mono">{j.order_id ?? "—"}</td>
                        <td className="px-2 py-1 font-mono">{j.gc_id ?? "—"}</td>
                        <td className="px-2 py-1 font-mono">{j.account_role}</td>
                        <td className="px-2 py-1 text-center font-mono">{j.side}</td>
                        <td className="px-2 py-1 text-right font-mono">{money(j.amount)}</td>
                        <td className="px-2 py-1 font-mono">{entityLabel(j.counterparty_entity_id)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
