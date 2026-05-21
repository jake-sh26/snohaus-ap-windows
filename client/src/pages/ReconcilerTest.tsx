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
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { apiRequest } from "@/lib/queryClient";
import { CheckCircle2, XCircle, RefreshCw, Plug, Cable, ListChecks, AlertTriangle, Trash2 } from "lucide-react";

// ----- typed responses (loose — backend already validates) -----
type Status = {
  configured: boolean;
  shopDomain: string | null;
  apiVersion: string | null;
  publicBaseUrl: string | null;
  missing: string[];
};
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
  const registerMut = useMutation<WebhookRegResult>({
    mutationFn: () => jsonPost("/api/recon/shopify/webhooks/register"),
    onSuccess: (r) => setLastAction(`Webhooks: ${r.results.map(x => `${x.topic}=${x.state}`).join(", ")}`),
  });
  const resetWebhooksMut = useMutation<{ deleted: number }>({
    mutationFn: () => jsonDelete("/api/recon/shopify/webhooks"),
    onSuccess: (r) => setLastAction(`Deleted ${r.deleted} webhook(s)`),
  });
  const clearErrorsMut = useMutation<{ ok: boolean }>({
    mutationFn: () => jsonDelete("/api/recon/shopify/error-log"),
    onSuccess: () => {
      setLastAction("Error log cleared");
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/error-log"] });
    },
  });

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
            <Button size="sm" variant="outline" onClick={() => statusQ.refetch()}>
              <RefreshCw className="size-4 mr-1.5" /> Refresh status
            </Button>
          </div>

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

      {/* ===== 7. Error log ===== */}
      {errorLogQ.data && errorLogQ.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-700"><AlertTriangle className="size-4" /> Integration errors</CardTitle>
            <CardDescription>Transient API failures or HMAC mismatches. Safe to clear once reviewed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              {errorLogQ.data.map((e, i) => (
                <div key={i} className="text-xs font-mono border-l-2 border-amber-300 pl-2">
                  <span className="text-muted-foreground">{shortTime(e.ts)}</span>{" "}
                  <span className="text-amber-700">[{e.scope}]</span>{" "}
                  <span>{e.message}</span>
                </div>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={() => clearErrorsMut.mutate()}>
              <Trash2 className="size-4 mr-1.5" /> Clear error log
            </Button>
          </CardContent>
        </Card>
      )}

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
