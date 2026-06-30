import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/lib/auth";
import { apiRequest, getAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  LogOut, Mail, Shield, CheckCircle2, XCircle, RefreshCw,
  ExternalLink, AlertTriangle, Loader2, Clock, BookOpenCheck, Globe,
  Ban, Trash2, Plus, ChevronDown, Copy, FileText,
  Users, Database, Archive, Download, Play, Link2, Link2Off,
  UserPlus, UserX, KeyRound, ToggleLeft, ToggleRight,
  Lock, Save, X, Briefcase, UserCheck, AlertCircle,
} from "lucide-react";
import { SkipSenderDialog } from "@/components/SkipSenderDialog";

function ConnectedBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <Badge variant="outline" className="text-emerald-600 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30">
        <CheckCircle2 className="size-3 mr-1" /> Connected
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-slate-500 border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900">
      <XCircle className="size-3 mr-1" /> Not connected
    </Badge>
  );
}

function QboSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const statusQ = useQuery<any>({
    queryKey: ["/api/qbo/status"],
    refetchInterval: 30_000,
  });

  const disconnectMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/qbo/disconnect").then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "QuickBooks disconnected" });
      qc.invalidateQueries({ queryKey: ["/api/qbo/status"] });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const s = statusQ.data;

  function handleConnect() {
    // Pass session token via query string — a top-level navigation can't send Authorization headers
    const token = getAuthToken();
    window.location.href = `/api/qbo/connect?t=${encodeURIComponent(token || "")}`;
  }

  if (statusQ.isLoading) {
    return <div className="py-8 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>;
  }

  if (!s?.configured) {
    return (
      <div className="rounded-lg border border-amber-300/50 bg-amber-50 dark:bg-amber-950/20 p-4 text-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium text-amber-800 dark:text-amber-300">QBO credentials not configured</div>
            <p className="text-amber-700 dark:text-amber-400 mt-1">
              Add <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">QBO_CLIENT_ID</code> and{" "}
              <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">QBO_CLIENT_SECRET</code> to your <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">.env</code> file, then restart the server.
            </p>
            <p className="mt-2 text-amber-700 dark:text-amber-400">
              Create a QBO app at{" "}
              <a href="https://developer.intuit.com" target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-1 hover:text-amber-900">
                developer.intuit.com <ExternalLink className="size-3" />
              </a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Connection status</div>
          <div className="text-xs text-muted-foreground">
            Environment: <span className="font-mono">{s?.environment || "sandbox"}</span>
          </div>
        </div>
        <ConnectedBadge connected={!!s?.connected} />
      </div>

      {s?.connected && (
        <div className="rounded-lg bg-muted/30 border border-border p-3 text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Realm ID</span>
            <span className="font-mono">{s.realmId}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Access token expires</span>
            <span className="font-mono">
              {s.expiresIn > 0 ? `${Math.round(s.expiresIn / 60)} min` : "Expired"}
            </span>
          </div>
        </div>
      )}

      {s?.error && (
        <div className="rounded-lg border border-red-300/50 bg-red-50 dark:bg-red-950/20 p-3 text-xs text-red-700 dark:text-red-400">
          <AlertTriangle className="size-3.5 inline mr-1" />{s.error}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {!s?.connected ? (
          <Button onClick={handleConnect} data-testid="button-qbo-connect">
            Connect QuickBooks
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => disconnectMut.mutate()}
            disabled={disconnectMut.isPending}
            data-testid="button-qbo-disconnect"
          >
            {disconnectMut.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <XCircle className="size-3.5 mr-1.5" />}
            Disconnect
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["/api/qbo/status"] })} data-testid="button-qbo-refresh">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {s?.connected && <VendorSyncRow />}

      <div className="border-t border-border pt-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">How to set up:</p>
        <ol className="list-decimal ml-4 space-y-1">
          <li>Go to <a href="https://developer.intuit.com" target="_blank" rel="noreferrer" className="underline hover:text-foreground">developer.intuit.com</a> and sign in</li>
          <li>Create an app → select "QuickBooks Online Accounting" scope</li>
          <li>Copy Client ID and Client Secret into <code className="bg-muted px-1 rounded">.env</code></li>
          <li>Set the Redirect URI in the Intuit app to match exactly the value of <code className="bg-muted px-1 rounded">QBO_REDIRECT_URI</code> in your <code className="bg-muted px-1 rounded">.env</code> (use your ngrok HTTPS URL for production, e.g. <code className="bg-muted px-1 rounded">https://your-domain.ngrok-free.dev/api/qbo/callback</code>)</li>
          <li>Restart the server, then click "Connect QuickBooks" above to complete OAuth</li>
        </ol>
        <p className="pt-2">
          Need help? Contact <a href="mailto:jake@snohaus.com" className="underline hover:text-foreground">jake@snohaus.com</a>
        </p>
      </div>

      <IntegrationErrorLogPanel
        entries={(s as any)?.error_log || []}
        clearEndpoint="/api/qbo/clear-error-log"
        statusQueryKey="/api/qbo/status"
        emptyHint="No errors logged. QBO API errors, OAuth failures, vendor sync issues, and webhook errors will appear here automatically."
      />
    </div>
  );
}

function VendorSyncRow() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery<{ last_synced_at: string | null; count: number }>({
    queryKey: ["/api/qbo/vendors/status"],
    refetchInterval: 60_000,
  });
  const sync = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/qbo/vendors/sync", {});
      return res.json();
    },
    onSuccess: (r: any) => {
      toast({ title: "Vendor sync complete", description: `${r.total} total — ${r.new} new, ${r.updated} updated, ${r.deactivated} deactivated` });
      qc.invalidateQueries({ queryKey: ["/api/qbo/vendors/status"] });
      qc.invalidateQueries({ queryKey: ["/api/qbo/vendors"] });
    },
    onError: (err: any) => {
      toast({ title: "Vendor sync failed", description: err.message, variant: "destructive" });
    },
  });
  const last = status.data?.last_synced_at;
  const lastLabel = last
    ? new Date(last).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "never";
  return (
    <div className="rounded-lg bg-muted/30 border border-border p-3 text-xs space-y-2" data-testid="qbo-vendor-sync">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-foreground">Vendor list cache</div>
          <div className="text-muted-foreground mt-0.5">{status.data?.count ?? 0} vendors cached · last sync: {lastLabel}</div>
        </div>
        <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending} data-testid="button-vendor-sync">
          {sync.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="size-3.5 mr-1.5" />}
          Sync from QBO
        </Button>
      </div>
      <p className="text-muted-foreground">Vendors auto-sync every 24h on server start. Click to fetch new vendors right now (e.g. Royal Teak).</p>
    </div>
  );
}

function GmailSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const statusQ = useQuery<any>({
    queryKey: ["/api/gmail/status"],
    refetchInterval: 60_000,
  });

  const pollMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/gmail/poll-now").then((r) => r.json()),
    onSuccess: (data) => {
      // v8.4: with auto-retry, the server suppresses transient errors when retry succeeded.
      // Show "recovered" wording when retried=true and no remaining errors.
      const retried = data.retried;
      const errCount = data.errors?.length || 0;
      const desc = errCount > 0
        ? `${data.new_invoices} new invoice(s) ingested. ${errCount} error(s).`
        : retried
          ? `${data.new_invoices} new invoice(s) ingested (recovered from a transient connection blip).`
          : `${data.new_invoices} new invoice(s) ingested.`;
      toast({ title: "Poll complete", description: desc });
      qc.invalidateQueries({ queryKey: ["/api/gmail/status"] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
    },
    onError: (e: any) => toast({ title: "Poll failed", description: e.message, variant: "destructive" }),
  });

  // v8.4: Reingest mutation — lets user resurface previously-skipped emails
  // by subject / from / body keyword without dropping into the browser console.
  const [reingestOpen, setReingestOpen] = useState(false);
  const [reingestSubject, setReingestSubject] = useState("");
  const [reingestFrom, setReingestFrom] = useState("");
  const [reingestDays, setReingestDays] = useState("7");
  const reingestMut = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/gmail/reingest", body).then((r) => r.json()),
    onSuccess: (data: any) => {
      const cleared = data.cleared_count ?? 0;
      const newInv = data.new_invoices ?? 0;
      toast({
        title: "Reingest complete",
        description: `Cleared ${cleared} previously-skipped email(s). ${newInv} new invoice(s) created.`,
      });
      setReingestOpen(false);
      setReingestSubject("");
      setReingestFrom("");
      qc.invalidateQueries({ queryKey: ["/api/gmail/status"] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
    },
    onError: (e: any) => toast({ title: "Reingest failed", description: e.message, variant: "destructive" }),
  });

  const testMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/gmail/test-connection").then((r) => r.json()),
    onSuccess: (data: any) => {
      if (data.ok) {
        toast({
          title: "Gmail connection successful",
          description: `Logged in as ${data.user}. Found ${data.mailboxes?.length || 0} mailboxes.`,
        });
      } else {
        toast({
          title: "Gmail connection failed",
          description: data.error || "Unknown error",
          variant: "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: ["/api/gmail/status"] });
    },
    onError: (e: any) => toast({ title: "Test failed", description: e.message, variant: "destructive" }),
  });

  const s = statusQ.data;

  if (statusQ.isLoading) {
    return <div className="py-8 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>;
  }

  if (!s?.configured) {
    return (
      <div className="rounded-lg border border-amber-300/50 bg-amber-50 dark:bg-amber-950/20 p-4 text-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium text-amber-800 dark:text-amber-300">Gmail credentials not configured</div>
            <p className="text-amber-700 dark:text-amber-400 mt-1">
              Add <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">GMAIL_USER</code> and{" "}
              <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">GMAIL_APP_PASSWORD</code> to your{" "}
              <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">.env</code> file, then restart the server.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Connection status</div>
          <div className="text-xs text-muted-foreground font-mono">{s?.user}</div>
        </div>
        <ConnectedBadge connected={!!s?.connected} />
      </div>

      <div className="rounded-lg bg-muted/30 border border-border p-3 text-xs space-y-1.5">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Label</span>
          <span className="font-mono">{s?.label}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Poll interval</span>
          <span>{s?.poll_interval_minutes} minutes</span>
        </div>
        {/* v8.4: "Last successful" now uses the most recent of last_poll_at (full successful poll)
            or last_success_at (successful IMAP login). The latter is more lenient — a poll
            that connected and listed mailboxes counts as success even if the fetch step had
            a transient blip. "Never" should only show when both are null. */}
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last successful poll</span>
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {(() => {
              const candidates = [s?.last_poll_at, s?.last_success_at].filter(Boolean) as string[];
              if (candidates.length === 0) return "Never";
              const latest = candidates.sort().reverse()[0];
              return new Date(latest).toLocaleString();
            })()}
          </span>
        </div>
        {/* Only show "Last attempt failed" if the last attempt is newer than the latest success */}
        {(() => {
          const success = [s?.last_poll_at, s?.last_success_at].filter(Boolean) as string[];
          const latestSuccess = success.length > 0 ? success.sort().reverse()[0] : null;
          const attempt = s?.last_poll_attempt_at;
          if (!attempt) return null;
          if (latestSuccess && new Date(attempt) <= new Date(latestSuccess)) return null;
          return (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last attempt</span>
              <span className="flex items-center gap-1">
                <Clock className="size-3" />
                {new Date(attempt).toLocaleString()}
                <span className="text-red-600 dark:text-red-400 ml-1">(failed)</span>
              </span>
            </div>
          );
        })()}
        <div className="flex justify-between">
          <span className="text-muted-foreground">Emails ingested</span>
          <span className="font-mono">{s?.ingested_count ?? 0}</span>
        </div>
      </div>

      {s?.error && (
        <div className="rounded-lg border border-red-300/50 bg-red-50 dark:bg-red-950/20 p-3 text-xs text-red-700 dark:text-red-400">
          <AlertTriangle className="size-3.5 inline mr-1" />{s.error}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          onClick={() => pollMut.mutate()}
          disabled={pollMut.isPending}
          data-testid="button-gmail-poll-now"
        >
          {pollMut.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="size-3.5 mr-1.5" />}
          Poll now
        </Button>
        <Button
          variant="outline"
          onClick={() => testMut.mutate()}
          disabled={testMut.isPending}
          data-testid="button-gmail-test-connection"
          title="Try connecting to Gmail IMAP without running a full poll"
        >
          {testMut.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="size-3.5 mr-1.5" />}
          Test connection
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => qc.invalidateQueries({ queryKey: ["/api/gmail/status"] })}
          data-testid="button-gmail-refresh"
          title="Refresh status display (does not run a poll)"
        >
          <RefreshCw className="size-3.5" />
        </Button>
        {/* v8.4: Reingest button */}
        <Button
          variant="outline"
          onClick={() => setReingestOpen(!reingestOpen)}
          data-testid="button-gmail-reingest-toggle"
          title="Resurface a previously-skipped email by subject or sender keyword"
        >
          <RefreshCw className="size-3.5 mr-1.5" />
          Reingest email
        </Button>
      </div>

      {/* v8.4: Reingest panel — inline form */}
      {reingestOpen && (
        <div className="rounded-lg border border-border p-3 space-y-3 bg-muted/30">
          <div className="text-xs text-muted-foreground">
            Find a missed invoice / credit memo by typing part of its subject or sender. The system will
            clear the matching skipped-email rows and re-run the poll so the new Stage 1 logic picks them up.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
            <div>
              <label className="block text-muted-foreground mb-1">Subject contains</label>
              <input
                type="text"
                value={reingestSubject}
                onChange={(e) => setReingestSubject(e.target.value)}
                placeholder="e.g. CM2024014295"
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                data-testid="input-reingest-subject"
              />
            </div>
            <div>
              <label className="block text-muted-foreground mb-1">From contains</label>
              <input
                type="text"
                value={reingestFrom}
                onChange={(e) => setReingestFrom(e.target.value)}
                placeholder="e.g. elevate-oc.com"
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                data-testid="input-reingest-from"
              />
            </div>
            <div>
              <label className="block text-muted-foreground mb-1">Days back</label>
              <input
                type="number"
                min="1"
                max="60"
                value={reingestDays}
                onChange={(e) => setReingestDays(e.target.value)}
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                data-testid="input-reingest-days"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                if (!reingestSubject.trim() && !reingestFrom.trim()) {
                  toast({ title: "Please enter a subject or sender keyword", variant: "destructive" });
                  return;
                }
                reingestMut.mutate({
                  subjectContains: reingestSubject.trim() || undefined,
                  fromContains: reingestFrom.trim() || undefined,
                  sinceDays: parseInt(reingestDays, 10) || 7,
                });
              }}
              disabled={reingestMut.isPending}
              data-testid="button-reingest-run"
            >
              {reingestMut.isPending ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" /> Reingesting (60-90s)…</> : "Run reingest"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReingestOpen(false)} disabled={reingestMut.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="border-t border-border pt-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">How to set up:</p>
        <ol className="list-decimal ml-4 space-y-1">
          <li>Enable 2-Step Verification on your Google account</li>
          <li>Go to Google Account → Security → App Passwords</li>
          <li>Create an app password (select "Mail" + "Other")</li>
          <li>Copy the 16-character password into <code className="bg-muted px-1 rounded">GMAIL_APP_PASSWORD</code> in <code className="bg-muted px-1 rounded">.env</code></li>
          <li>Create a Gmail label called "Unreceived Invoices" (or customize with <code className="bg-muted px-1 rounded">GMAIL_LABEL</code>)</li>
          <li>Restart the server — polling will begin automatically</li>
        </ol>
      </div>

      <IntegrationErrorLogPanel
        entries={s?.error_log || []}
        clearEndpoint="/api/gmail/clear-error-log"
        statusQueryKey="/api/gmail/status"
        emptyHint="No errors logged. Errors from polls and connection tests will appear here automatically so you can copy them when reporting issues."
      />
    </div>
  );
}

// ---- Reusable error log panel (Gmail / QBO / Acumatica) ----
type IntegrationLogEntry = { at: string; scope: string; message: string; level?: string };
function IntegrationErrorLogPanel({
  entries,
  clearEndpoint,
  statusQueryKey,
  emptyHint,
}: {
  entries: IntegrationLogEntry[];
  clearEndpoint: string;
  statusQueryKey: string;
  emptyHint: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const clearMut = useMutation({
    mutationFn: () => apiRequest("POST", clearEndpoint),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [statusQueryKey] });
      toast({ title: "Error log cleared" });
    },
  });

  const formatForCopy = () => {
    if (!entries.length) return "(no errors logged)";
    return entries
      .map((e) => {
        const lvl = e.level && e.level !== "error" ? `[${e.level}] ` : "";
        return `[${new Date(e.at).toLocaleString()}] [${e.scope}] ${lvl}${e.message}`;
      })
      .join("\n");
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(formatForCopy());
      toast({ title: "Error log copied to clipboard" });
    } catch {
      toast({ title: "Copy failed", description: "Select and copy manually below.", variant: "destructive" });
    }
  };

  const visibleEntries = expanded ? entries : entries.slice(0, 5);
  const hasMore = entries.length > 5;

  return (
    <div className="border-t border-border pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <FileText className="size-3.5 text-muted-foreground" />
          <p className="text-xs font-medium text-foreground">
            Error log {entries.length > 0 && <span className="text-muted-foreground font-normal">({entries.length} recent)</span>}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={copyAll}
            disabled={!entries.length}
          >
            <Copy className="size-3 mr-1" />
            Copy all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => clearMut.mutate()}
            disabled={!entries.length || clearMut.isPending}
          >
            <Trash2 className="size-3 mr-1" />
            Clear
          </Button>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground italic px-1">{emptyHint}</p>
      ) : (
        <div className="rounded-md border border-border bg-muted/20 divide-y divide-border max-h-[260px] overflow-y-auto">
          {visibleEntries.map((e, i) => (
            <div key={i} className="p-2 text-xs space-y-0.5">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="size-3" />
                <span className="font-mono">{new Date(e.at).toLocaleString()}</span>
                <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">{e.scope}</Badge>
                {e.level === "warn" && (
                  <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-amber-300 text-amber-700 dark:text-amber-400">warn</Badge>
                )}
              </div>
              <div className="text-foreground/90 break-words font-mono text-[11px] leading-snug">{e.message}</div>
            </div>
          ))}
          {hasMore && (
            <button
              type="button"
              className="w-full py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? `Show fewer…` : `Show ${entries.length - 5} older…`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const { email, logout, role } = useAuth();
  const isAdmin = role === "admin";

  // PR #238 — Settings reorg.
  //
  // Previously the page was a flat stack of ~9 Cards. With RBAC, integrations,
  // backups, archive, and service logs all living here it grew long enough
  // that locating any one section meant scrolling past the others. This
  // refactor groups them into 3 tabs that mirror how the operator thinks
  // about the page:
  //
  //   1. Users & Permissions — who can sign in + what they can do
  //   2. Integrations        — external services + allowlist
  //   3. Backups & Service   — backups, PDF archive, live service logs
  //
  // The Sign-in/Sign-out card stays above the tab strip so logout is always
  // one click from /settings regardless of which tab is active.
  //
  // Skip Senders moved out entirely — it governs AP email intake, so it now
  // lives as the 4th tab on /accounts-payable/settings (next to Vendor Rules,
  // Aliases, Vendor Groups). See client/src/pages/accounts-payable/SkipSenders.tsx.
  //
  // Tabs Users & Permissions and Backups & Service are admin-only. Non-admin
  // operators landing on /settings see only the Sign-in card + Integrations
  // tab (TabsList itself is hidden for them so the page doesn't show empty
  // restricted tabs).

  return (
    <div className="px-8 pt-6 pb-12 max-w-[900px] mx-auto">
      <h1 className="text-xl font-semibold tracking-tight mb-1">Settings</h1>
      <p className="text-sm text-muted-foreground mb-6">Account, integrations, and configuration.</p>

      {/* Account card — always visible above the tab strip so the user can
          sign out from /settings no matter which tab is selected. */}
      <Card className="border-card-border p-5 mb-6">
        <div className="flex items-center gap-3 mb-1">
          <Mail className="size-4 text-muted-foreground" />
          <div className="text-sm font-medium">Signed in</div>
        </div>
        <div className="text-base font-mono mb-3" data-testid="text-settings-email">{email}</div>
        <Button variant="outline" size="sm" onClick={logout} data-testid="button-settings-logout">
          <LogOut className="size-4 mr-1" /> Sign out
        </Button>
      </Card>

      <Tabs defaultValue={isAdmin ? "users" : "integrations"}>
        {/* Hide TabsList for non-admins (only Integrations would be there).
            For admins, show all 3 with equal-width grid. */}
        {isAdmin && (
          <TabsList className="grid grid-cols-3 w-full mb-6">
            <TabsTrigger value="users" data-testid="tab-settings-users">
              <Users className="size-3.5 mr-1.5" />
              Users &amp; Permissions
            </TabsTrigger>
            <TabsTrigger value="integrations" data-testid="tab-settings-integrations">
              <BookOpenCheck className="size-3.5 mr-1.5" />
              Integrations
            </TabsTrigger>
            <TabsTrigger value="backups" data-testid="tab-settings-backups">
              <Database className="size-3.5 mr-1.5" />
              Backups &amp; Service
            </TabsTrigger>
          </TabsList>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Tab 1: Users & Permissions — admin-only                            */}
        {/* ------------------------------------------------------------------ */}
        {isAdmin && (
          <TabsContent value="users" className="space-y-4 mt-0">
            <Card className="border-card-border p-5">
              <div className="flex items-center gap-3 mb-2">
                <Users className="size-4 text-muted-foreground" />
                <div className="text-sm font-medium">Users</div>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Manage who can access Sno-Haus Ops Hub. Admin-only.
              </p>
              <UsersSection />
            </Card>

            <Card className="border-card-border p-5">
              <div className="flex items-center gap-3 mb-2">
                <Shield className="size-4 text-muted-foreground" />
                <div className="text-sm font-medium">Access Control</div>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Define roles (groups of permissions) and assign them to users
                per entity. Owner gets everything by default. Use ADP Exporter
                for staff who should be able to export payroll CSVs without
                seeing underlying invoice data.
              </p>
              <AccessControlSection />
            </Card>
          </TabsContent>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Tab 2: Integrations                                                */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="integrations" className="space-y-4 mt-0">
          <Card className="border-card-border p-5">
            <div className="flex items-center gap-3 mb-4">
              <BookOpenCheck className="size-4 text-muted-foreground" />
              <div className="text-sm font-medium">Integrations</div>
            </div>
            <Tabs defaultValue="qbo">
              <TabsList className="grid grid-cols-3 w-full mb-4">
                <TabsTrigger value="qbo" data-testid="tab-qbo">QuickBooks Online</TabsTrigger>
                <TabsTrigger value="gmail" data-testid="tab-gmail">Gmail Invoice Intake</TabsTrigger>
                <TabsTrigger value="acumatica" data-testid="tab-acumatica">Acumatica</TabsTrigger>
              </TabsList>
              <TabsContent value="qbo">
                <QboSection />
              </TabsContent>
              <TabsContent value="gmail">
                <GmailSection />
              </TabsContent>
              <TabsContent value="acumatica">
                <AcumaticaSection />
              </TabsContent>
            </Tabs>
          </Card>

          <Card className="border-card-border p-5">
            <div className="flex items-center gap-3 mb-2">
              <Shield className="size-4 text-muted-foreground" />
              <div className="text-sm font-medium">Allowlisted emails</div>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Only these accounts can sign in. Edit <code className="bg-muted px-1 rounded">ALLOWED_EMAILS</code> in <code className="bg-muted px-1 rounded">.env</code> to change.
            </p>
            <AllowedEmailsList />
          </Card>
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Tab 3: Backups & Service — admin-only                              */}
        {/* ------------------------------------------------------------------ */}
        {isAdmin && (
          <TabsContent value="backups" className="space-y-4 mt-0">
            <Card className="border-card-border p-5">
              <div className="flex items-center gap-3 mb-2">
                <Database className="size-4 text-muted-foreground" />
                <div className="text-sm font-medium">Backups</div>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Hourly local snapshots + daily/weekly Google Drive backups. Admin-only.
              </p>
              <BackupsSection />
            </Card>

            <Card className="border-card-border p-5">
              <div className="flex items-center gap-3 mb-2">
                <Archive className="size-4 text-muted-foreground" />
                <div className="text-sm font-medium">PDF Archive</div>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Invoices older than 12 months are bundled into monthly zip archives and uploaded to Drive.
              </p>
              <ArchiveSection />
            </Card>

            <Card className="border-card-border p-5">
              <div className="flex items-center gap-3 mb-2">
                <FileText className="size-4 text-muted-foreground" />
                <div className="text-sm font-medium">Service logs</div>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Live tail of the SnoHausAP service log. Useful for debugging Gmail polls, OCR conversions, QBO posts, and uploads without RDPing into the Windows box.
              </p>
              <LogsSection />
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// v8: live tail of <cwd>/logs/app.log via GET /api/admin/logs.
// Polls every 5s by default; user can pause auto-refresh and adjust line count.
function LogsSection() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [maxLines, setMaxLines] = useState(200);
  const q = useQuery<{
    path: string;
    size: number;
    lines: string[];
    line_count: number;
    fetched_at: string;
  }>({
    queryKey: ["/api/admin/logs", maxLines],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/logs?lines=${maxLines}`);
      return res.json();
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });

  const sizeKb = q.data ? (q.data.size / 1024).toFixed(1) : "—";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button
          size="sm"
          variant="outline"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          data-testid="button-logs-refresh"
        >
          <RefreshCw className={`size-3 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
        <Button
          size="sm"
          variant={autoRefresh ? "default" : "outline"}
          onClick={() => setAutoRefresh((v) => !v)}
          data-testid="button-logs-autorefresh"
        >
          {autoRefresh ? "Auto-refresh: on" : "Auto-refresh: off"}
        </Button>
        <Select value={String(maxLines)} onValueChange={(v) => setMaxLines(parseInt(v, 10))}>
          <SelectTrigger className="h-8 w-[140px] text-xs" data-testid="select-logs-lines">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="100">Last 100 lines</SelectItem>
            <SelectItem value="200">Last 200 lines</SelectItem>
            <SelectItem value="500">Last 500 lines</SelectItem>
            <SelectItem value="1000">Last 1000 lines</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (!q.data?.lines) return;
            navigator.clipboard?.writeText(q.data.lines.join("\n"));
          }}
          data-testid="button-logs-copy"
        >
          <Copy className="size-3 mr-1" /> Copy
        </Button>
        <span className="text-muted-foreground ml-auto">
          {q.data ? `${q.data.line_count} lines · ${sizeKb} KB` : q.isLoading ? "Loading…" : "—"}
        </span>
      </div>
      {q.data?.path && (
        <div className="text-[11px] text-muted-foreground font-mono break-all">{q.data.path}</div>
      )}
      <pre
        className="text-[11px] bg-muted/40 border border-border rounded-md p-3 overflow-auto max-h-[480px] font-mono leading-relaxed whitespace-pre"
        data-testid="text-logs"
      >
        {q.isError
          ? `Failed to load logs: ${(q.error as any)?.message || "unknown error"}`
          : q.data?.lines?.length
            ? q.data.lines.join("\n")
            : q.isLoading
              ? "Loading…"
              : "(log file is empty — service may have just started)"}
      </pre>
    </div>
  );
}

export function SkipSendersList() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const q = useQuery<Array<{
    id: number;
    match_type: "email" | "domain";
    match_value: string;
    vendor_name: string | null;
    added_at: string;
    added_by: string | null;
    skipped_count: number;
    last_skipped_at: string | null;
  }>>({
    queryKey: ["/api/skip-senders"],
  });

  const removeMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/skip-senders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skip-senders"] });
      toast({ title: "Skip rule removed" });
    },
    onError: (e: any) => toast({ title: "Could not remove rule", description: e?.message, variant: "destructive" }),
  });

  const rows = q.data || [];

  return (
    <div>
      <div className="flex items-center justify-end mb-2">
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)} data-testid="button-skip-senders-add">
          <Plus className="size-3.5 mr-1" /> Add sender
        </Button>
      </div>
      {q.isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground italic py-3 px-2 rounded-md border border-dashed border-border">
          No senders on the skip list.
        </div>
      ) : (
        <div className="rounded-md border border-border overflow-hidden" data-testid="table-skip-senders">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Match</th>
                <th className="px-3 py-2 font-medium">Vendor</th>
                <th className="px-3 py-2 font-medium text-right">Skipped</th>
                <th className="px-3 py-2 font-medium">Last skipped</th>
                <th className="px-3 py-2 font-medium">Added</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border" data-testid={`row-skip-sender-${r.id}`}>
                  <td className="px-3 py-2 font-mono break-all">
                    {r.match_type === "domain" ? `@${r.match_value}` : r.match_value}
                    <Badge variant="outline" className="ml-2 text-[10px]">{r.match_type}</Badge>
                  </td>
                  <td className="px-3 py-2">{r.vendor_name || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.skipped_count}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.last_skipped_at ? new Date(r.last_skipped_at).toLocaleString() : "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{new Date(r.added_at).toLocaleDateString()}{r.added_by ? ` · ${r.added_by}` : ""}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeMut.mutate(r.id)}
                      disabled={removeMut.isPending}
                      data-testid={`button-remove-skip-sender-${r.id}`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <SkipSenderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        mode="manual"
      />
    </div>
  );
}

function AcumaticaSection() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const statusQ = useQuery<any>({
    queryKey: ["/api/acumatica/status"],
    // Poll every 2s while a pull is running, every 30s otherwise.
    refetchInterval: (q: any) => {
      const data = q.state?.data;
      return data?.run_in_progress ? 2_000 : 30_000;
    },
  });
  const runMut = useMutation({
    mutationFn: (opts: { debug?: boolean } = {}) =>
      apiRequest("POST", `/api/acumatica/run-now${opts.debug ? "?debug=1" : ""}`).then((r) => r.json()),
    onSuccess: (data: any) => {
      const ok = data?.ok;
      // Debug runs short-circuit before the per-row click loop and return file paths.
      if (data?.debug?.enabled) {
        toast({
          title: "Acumatica debug capture complete",
          description: data.debug.summary +
            ` Files: ${[data.debug.screenshot_path, data.debug.iframe_html_path, data.debug.log_path].filter(Boolean).join(", ")}`,
        });
      } else {
        toast({
          title: ok ? "Acumatica pull complete" : "Acumatica pull finished with errors",
          description: `${data?.documents_seen || 0} seen · ${data?.documents_new || 0} new · ${data?.documents_ingested || 0} ingested`,
          variant: ok ? "default" : "destructive",
        });
      }
      qc.invalidateQueries({ queryKey: ["/api/acumatica/status"] });
    },
    onError: (e: any) => toast({ title: "Pull failed", description: e.message, variant: "destructive" }),
  });
  const s = statusQ.data as any;
  const isRunning = !!(s?.run_in_progress) || runMut.isPending;
  if (statusQ.isLoading) {
    return <div className="py-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>;
  }
  if (!s?.configured) {
    return (
      <div className="rounded-lg border border-amber-300/50 bg-amber-50 dark:bg-amber-950/20 p-4 text-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium text-amber-800 dark:text-amber-300">Acumatica not configured</div>
            <p className="text-amber-700 dark:text-amber-400 mt-1">
              Add the following to <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">.env</code> and restart the server:
            </p>
            <pre className="mt-2 text-xs bg-amber-100 dark:bg-amber-900/40 p-2 rounded">
ACUMATICA_URL=https://wintersportsretailers.scsuser.com/MembersPortal/Frames/Login.aspx?ReturnUrl=%2fMembersPortal&CompanyID=WSR
ACUMATICA_USER=jake@sundowngreenvale.com
ACUMATICA_PASS=...</pre>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">
              You also need Chromium installed once: <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">npx playwright install chromium</code>
            </p>
          </div>
        </div>
      </div>
    );
  }
  const lr = s.last_run;
  const recent = (s.recent_runs as any[]) || [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="size-4 text-muted-foreground" />
        <div className="text-sm font-medium">Winter Sports Retailers (vendor portal)</div>
        <ConnectedBadge connected={!!s.configured} />
      </div>
      <div className="text-xs text-muted-foreground">
        Daily pull at 2:00 AM ET. Logs into the portal and downloads new invoices from Documents → My Documents → Open Documents.
      </div>
      {lr && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-1">
          <div><span className="text-muted-foreground">Last run:</span> {new Date(lr.ended_at).toLocaleString()}</div>
          <div><span className="text-muted-foreground">Result:</span> {lr.documents_seen} seen · {lr.documents_new} new · {lr.documents_ingested} ingested · {lr.documents_duplicate} duplicate · {lr.documents_skipped} skipped</div>
          {lr.errors?.length > 0 && (
            <div className="text-amber-600 dark:text-amber-400">Errors: {lr.errors.join("; ")}</div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={() => runMut.mutate({})} disabled={isRunning} data-testid="button-acumatica-run-now">
          {isRunning ? <><Loader2 className="size-4 mr-1 animate-spin" /> Running…</> : <><RefreshCw className="size-4 mr-1" /> Run pull now</>}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => runMut.mutate({ debug: true })}
          disabled={isRunning}
          data-testid="button-acumatica-debug-pull"
          title="Login + navigate, dump screenshot/HTML/log to ./debug/, skip per-row clicks. Use when row clicks are timing out."
        >
          Debug pull (no clicks)
        </Button>
        {isRunning && s?.run_progress_note && (
          <span className="ml-1 text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin" /> {s.run_progress_note}
          </span>
        )}
      </div>
      {recent.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Recent runs ({recent.length})</summary>
          <div className="mt-2 space-y-1">
            {recent.map((r: any) => (
              <div key={r.id} className="font-mono text-[11px]">
                {new Date(r.ended_at).toLocaleString()} · {r.ok ? "✓" : "✗"} · {r.documents_new} new
              </div>
            ))}
          </div>
        </details>
      )}

      <IntegrationErrorLogPanel
        entries={(s as any)?.error_log || []}
        clearEndpoint="/api/acumatica/clear-error-log"
        statusQueryKey="/api/acumatica/status"
        emptyHint="No errors logged. Login failures, timeouts, and per-document errors will appear here automatically."
      />
    </div>
  );
}

function AllowedEmailsList() {
  const q = useQuery<{ email: string }>({
    queryKey: ["/api/me"],
  });
  // We don't expose ALLOWED_EMAILS from the API; show a note instead
  return (
    <div className="text-xs text-muted-foreground space-y-1.5">
      <p>Currently signed in as: <span className="font-mono text-foreground">{q.data?.email}</span></p>
      <p className="mt-2">To see or change the full list, open <code className="bg-muted px-1 rounded">.env</code> and look for <code className="bg-muted px-1 rounded">ALLOWED_EMAILS</code>.</p>
    </div>
  );
}

// Vendor Groups moved to client/src/pages/accounts-payable/VendorGroups.tsx
// (AP Settings hub). The 3 helper functions that used to live here
// (VendorGroupsCard, VendorGroupRow, VendorGroupMemberRow) and the
// VendorGroup interface now live in that file.


// ============================================================
// USERS SECTION
// ============================================================
function UsersSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { email: myEmail, hasPermission } = useAuth();
  const canManageLinks = hasPermission("users.manage_links");
  const [addOpen, setAddOpen] = useState(false);
  const [pwdDialog, setPwdDialog] = useState<{ id: number; email: string } | null>(null);
  const [linkDialog, setLinkDialog] = useState<{
    userId: number;
    userEmail: string;
    currentEmployeeId: number | null;
    currentEmployeeName: string | null;
  } | null>(null);

  const usersQ = useQuery<any[]>({ queryKey: ["/api/users"] });
  const users = usersQ.data || [];

  // Link state — joined view of which employee each user is currently tied
  // to via person_id. Only fetched if the caller can see/manage links.
  const linksQ = useQuery<any[]>({
    queryKey: ["/api/people-links/users"],
    enabled: canManageLinks,
  });
  const linkByUserId = new Map<number, any>();
  for (const row of linksQ.data || []) linkByUserId.set(row.user_id, row);

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/users/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/users"] }); toast({ title: "User deleted" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiRequest("PATCH", `/api/users/${id}`, { enabled: enabled ? 1 : 0 }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/users"] }),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const roleMut = useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) =>
      apiRequest("PATCH", `/api/users/${id}`, { role }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/users"] }),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)} data-testid="button-add-user">
          <UserPlus className="size-3.5 mr-1" /> Add user
        </Button>
      </div>
      {usersQ.isLoading && <div className="text-sm text-muted-foreground py-4 text-center"><Loader2 className="size-4 animate-spin inline mr-2" />Loading users…</div>}
      {!usersQ.isLoading && users.length === 0 && (
        <div className="text-sm text-muted-foreground py-4 text-center">No users found.</div>
      )}
      <div className="space-y-2">
        {users.map((u: any) => (
          <div key={u.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 bg-card">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm truncate">{u.email}</span>
                {u.name && <span className="text-xs text-muted-foreground">({u.name})</span>}
                {!u.password_salt && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">SSO only</Badge>
                )}
                {!u.enabled && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-slate-500">Disabled</Badge>
                )}
              </div>
              {u.last_login_at && (
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Last login: {new Date(u.last_login_at).toLocaleString()}
                </div>
              )}
              {canManageLinks && linksQ.data && (() => {
                const link = linkByUserId.get(u.id);
                if (link?.linked_employee_id) {
                  return (
                    <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                      <Briefcase className="size-3 text-emerald-500" />
                      <span>Linked to employee:</span>
                      <span className="font-medium text-foreground" data-testid={`text-linked-employee-${u.id}`}>
                        {link.linked_employee_name || `#${link.linked_employee_id}`}
                      </span>
                    </div>
                  );
                }
                return (
                  <div className="text-[11px] text-amber-600 dark:text-amber-500 mt-0.5 flex items-center gap-1" data-testid={`text-no-link-${u.id}`}>
                    <AlertCircle className="size-3" />
                    <span>No linked employee — standalone person</span>
                  </div>
                );
              })()}
            </div>
            <Select
              value={u.role}
              onValueChange={(val) => roleMut.mutate({ id: u.id, role: val })}
              disabled={u.email === myEmail}
            >
              <SelectTrigger className="h-7 w-[90px] text-xs" data-testid={`select-role-${u.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              title={u.enabled ? "Disable user" : "Enable user"}
              onClick={() => toggleMut.mutate({ id: u.id, enabled: !u.enabled })}
              disabled={u.email === myEmail}
              data-testid={`button-toggle-user-${u.id}`}
            >
              {u.enabled ? <ToggleRight className="size-4 text-emerald-500" /> : <ToggleLeft className="size-4 text-slate-400" />}
            </Button>
            {canManageLinks && (() => {
              const link = linkByUserId.get(u.id);
              return (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  title={link?.linked_employee_id ? "Change linked employee" : "Link to employee"}
                  onClick={() =>
                    setLinkDialog({
                      userId: u.id,
                      userEmail: u.email,
                      currentEmployeeId: link?.linked_employee_id ?? null,
                      currentEmployeeName: link?.linked_employee_name ?? null,
                    })
                  }
                  data-testid={`button-link-employee-${u.id}`}
                >
                  <Briefcase className="size-3.5" />
                </Button>
              );
            })()}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              title="Set password"
              onClick={() => setPwdDialog({ id: u.id, email: u.email })}
              data-testid={`button-set-pwd-${u.id}`}
            >
              <KeyRound className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-destructive hover:text-destructive"
              title="Delete user"
              onClick={() => deleteMut.mutate(u.id)}
              disabled={u.email === myEmail}
              data-testid={`button-delete-user-${u.id}`}
            >
              <UserX className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {addOpen && <AddUserDialog onClose={() => setAddOpen(false)} onSaved={() => { qc.invalidateQueries({ queryKey: ["/api/users"] }); setAddOpen(false); }} />}
      {pwdDialog && <SetPasswordDialog userId={pwdDialog.id} userEmail={pwdDialog.email} onClose={() => setPwdDialog(null)} />}
      {linkDialog && (
        <UserLinkEmployeeDialog
          userId={linkDialog.userId}
          userEmail={linkDialog.userEmail}
          currentEmployeeId={linkDialog.currentEmployeeId}
          currentEmployeeName={linkDialog.currentEmployeeName}
          onClose={() => setLinkDialog(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["/api/people-links/users"] });
            qc.invalidateQueries({ queryKey: ["/api/people-links/employees"] });
            setLinkDialog(null);
          }}
        />
      )}
    </div>
  );
}

function AddUserDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    try {
      await apiRequest("POST", "/api/users", { email: email.trim(), name: name.trim() || null, role, password: password || undefined });
      toast({ title: "User created" });
      onSaved();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>Create a new user account. Password is optional — leave blank for SSO-only.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label htmlFor="new-user-email">Email *</Label>
            <Input id="new-user-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com" className="mt-1" required />
          </div>
          <div>
            <Label htmlFor="new-user-name">Name</Label>
            <Input id="new-user-name" value={name} onChange={e => setName(e.target.value)} placeholder="Full name (optional)" className="mt-1" />
          </div>
          <div>
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "admin" | "user")}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="new-user-pwd">Password</Label>
            <Input id="new-user-pwd" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Leave blank for SSO-only" className="mt-1" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : null}Create user</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SetPasswordDialog({ userId, userEmail, onClose }: { userId: number; userEmail: string; onClose: () => void }) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setLoading(true);
    try {
      await apiRequest("POST", `/api/users/${userId}/password`, { password });
      toast({ title: "Password updated" });
      onClose();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set password</DialogTitle>
          <DialogDescription>Set a new password for {userEmail}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label htmlFor="set-pwd">New password</Label>
            <Input id="set-pwd" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="New password" className="mt-1" required minLength={6} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : null}Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// USER ↔ EMPLOYEE LINK DIALOG (PR #201)
// ============================================================
// Lets an admin override the auto-backfill's email-based match. Pick a target
// employee from a searchable list, or hit Unlink to spin off a fresh person.
// Block-on-conflict: server returns 409 if the target employee is already
// linked to another user, with a message telling the operator who to unlink
// first.
function UserLinkEmployeeDialog({
  userId,
  userEmail,
  currentEmployeeId,
  currentEmployeeName,
  onClose,
  onSaved,
}: {
  userId: number;
  userEmail: string;
  currentEmployeeId: number | null;
  currentEmployeeName: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Employee list from the link endpoint includes the current linked-user
  // info, which we use to mark already-claimed employees in the dropdown.
  const employeesQ = useQuery<any[]>({ queryKey: ["/api/people-links/employees"] });
  const all = employeesQ.data || [];
  const filtered = search.trim()
    ? all.filter((e: any) =>
        (e.employee_name || "").toLowerCase().includes(search.toLowerCase()) ||
        (e.employee_email || "").toLowerCase().includes(search.toLowerCase()),
      )
    : all;

  async function pick(employeeId: number) {
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", `/api/people-links/users/${userId}/link`, { employee_id: employeeId });
      const body = await res.json().catch(() => ({}));
      if (body?.archived_person_id) {
        toast({
          title: "Linked",
          description: `Old standalone person (id ${body.archived_person_id}) archived because nothing else referenced it.`,
        });
      } else {
        toast({ title: "Linked" });
      }
      onSaved();
    } catch (e: any) {
      const msg = e?.message || String(e);
      toast({
        title: msg.includes("already linked") ? "Already linked" : "Error",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function unlink() {
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", `/api/people-links/users/${userId}/unlink`, {});
      const body = await res.json().catch(() => ({}));
      if (body?.archived_person_id) {
        toast({
          title: "Unlinked",
          description: `Old shared person (id ${body.archived_person_id}) archived because nothing else referenced it.`,
        });
      } else {
        toast({ title: "Unlinked" });
      }
      onSaved();
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || String(e), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link employee</DialogTitle>
          <DialogDescription>
            User <span className="font-mono">{userEmail}</span> is currently{" "}
            {currentEmployeeId
              ? <>linked to <span className="font-medium text-foreground">{currentEmployeeName || `#${currentEmployeeId}`}</span>.</>
              : <>not linked to any employee.</>}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Search employees by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            data-testid="input-link-employee-search"
          />
          <div className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
            {employeesQ.isLoading && (
              <div className="text-sm text-muted-foreground py-4 text-center">
                <Loader2 className="size-4 animate-spin inline mr-2" />Loading employees…
              </div>
            )}
            {!employeesQ.isLoading && filtered.length === 0 && (
              <div className="text-sm text-muted-foreground py-4 text-center">No employees match.</div>
            )}
            {filtered.map((e: any) => {
              const isCurrent = e.employee_id === currentEmployeeId;
              const claimedByOther = e.linked_user_id && e.linked_user_id !== userId;
              return (
                <button
                  key={e.employee_id}
                  type="button"
                  disabled={submitting || isCurrent}
                  onClick={() => pick(e.employee_id)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                    isCurrent ? "bg-muted/40" : "hover:bg-muted/60"
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                  data-testid={`link-employee-row-${e.employee_id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{e.employee_name || `Employee #${e.employee_id}`}</div>
                    {e.employee_email && (
                      <div className="text-xs text-muted-foreground truncate">{e.employee_email}</div>
                    )}
                  </div>
                  {isCurrent && (
                    <Badge variant="outline" className="text-[10px]">Current</Badge>
                  )}
                  {!isCurrent && claimedByOther && (
                    <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">
                      Linked to {e.linked_user_email}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Picking an employee already linked to another user will be blocked.
            Unlink that user first.
          </p>
        </div>
        <div className="flex justify-between gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={unlink}
            disabled={submitting || !currentEmployeeId}
            data-testid="button-unlink-employee"
          >
            <Link2Off className="size-3.5 mr-1.5" />
            Unlink (keep standalone)
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// BACKUPS SECTION
// ============================================================
function BackupsSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const statusQ = useQuery<any>({ queryKey: ["/api/backups/status"], refetchInterval: 30_000 });
  const listQ = useQuery<any>({ queryKey: ["/api/backups/list"] });
  const driveStatusQ = useQuery<any>({ queryKey: ["/api/auth/drive/status"], refetchInterval: 60_000 });

  const runMut = useMutation({
    mutationFn: (kind: string) => apiRequest("POST", "/api/backups/run", { kind }).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Backup triggered" });
      qc.invalidateQueries({ queryKey: ["/api/backups/status"] });
      qc.invalidateQueries({ queryKey: ["/api/backups/list"] });
    },
    onError: (e: any) => toast({ title: "Backup failed", description: e.message, variant: "destructive" }),
  });

  const disconnectDriveMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/drive/disconnect").then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Google Drive disconnected" });
      qc.invalidateQueries({ queryKey: ["/api/auth/drive/status"] });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const driveConnected = driveStatusQ.data?.connected;
  const driveEmail = driveStatusQ.data?.granted_email;

  function handleConnectDrive() {
    const token = getAuthToken();
    window.location.href = `/api/auth/drive/connect?t=${encodeURIComponent(token || "")}`;
  }

  function handleDownload(filename: string) {
    const token = getAuthToken();
    const a = document.createElement("a");
    a.href = `/api/backups/download/${encodeURIComponent(filename)}?t=${encodeURIComponent(token || "")}`;
    a.download = filename;
    a.click();
  }

  const s = statusQ.data || {};
  const kinds = [
    { key: "local_hourly", label: "Local hourly", icon: <Database className="size-3.5 text-muted-foreground" /> },
    { key: "drive_daily_db", label: "Drive daily (DB)", icon: <Globe className="size-3.5 text-muted-foreground" /> },
    { key: "drive_weekly_full", label: "Drive weekly (full)", icon: <Globe className="size-3.5 text-muted-foreground" /> },
  ];

  return (
    <div className="space-y-5">
      {/* Drive connection */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="space-y-0.5">
            <div className="text-sm font-medium">Google Drive connection</div>
            <div className="text-xs text-muted-foreground">
              {driveConnected
                ? <>Connected as <span className="font-mono">{driveEmail}</span></>
                : "Not connected — connect to enable Drive backups"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ConnectedBadge connected={!!driveConnected} />
            {driveConnected ? (
              <Button size="sm" variant="outline" onClick={() => disconnectDriveMut.mutate()} disabled={disconnectDriveMut.isPending}>
                <Link2Off className="size-3.5 mr-1" /> Disconnect
              </Button>
            ) : (
              <Button size="sm" onClick={handleConnectDrive}>
                <Link2 className="size-3.5 mr-1" /> Connect Drive
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Backup status per kind */}
      <div className="space-y-3">
        {kinds.map(({ key, label, icon }) => {
          const kindData = s[key]; // { last_run, last_success, consecutive_failures }
          const run = kindData?.last_run;
          return (
            <div key={key} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  {icon}
                  <span className="text-sm font-medium">{label}</span>
                  {run && (
                    <Badge
                      variant="outline"
                      className={run.status === "success"
                        ? "text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-700"
                        : "text-red-600 border-red-300 bg-red-50 dark:bg-red-950/30 dark:text-red-400 dark:border-red-700"}
                    >
                      {run.status === "success" ? <CheckCircle2 className="size-3 mr-1" /> : <XCircle className="size-3 mr-1" />}
                      {run.status}
                    </Badge>
                  )}
                  {!run && <span className="text-xs text-muted-foreground">No runs yet</span>}
                  {(kindData?.consecutive_failures ?? 0) >= 2 && (
                    <Badge variant="outline" className="text-red-600 border-red-300">
                      <AlertTriangle className="size-3 mr-1" /> {kindData.consecutive_failures} failures
                    </Badge>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => runMut.mutate(key)}
                  disabled={runMut.isPending}
                  data-testid={`button-backup-${key}`}
                >
                  {runMut.isPending ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Play className="size-3.5 mr-1" />}
                  Run now
                </Button>
              </div>
              {run && (
                <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                  {run.finished_at && <div>Last run: {new Date(run.finished_at).toLocaleString()}</div>}
                  {kindData?.last_success && kindData.last_success.id !== run.id && (
                    <div>Last success: {new Date(kindData.last_success.finished_at).toLocaleString()}</div>
                  )}
                  {run.file_size_bytes && <div>Size: {(run.file_size_bytes / 1024 / 1024).toFixed(2)} MB</div>}
                  {run.error && <div className="text-red-500">Error: {run.error}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Local backup files list */}
      {listQ.data?.local?.length > 0 && (
        <div>
          <div className="text-sm font-medium mb-2">Local backups</div>
          <div className="text-[11px] text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-1.5">
            <AlertTriangle className="size-3.5" />
            Restore = download only. To restore: stop the server, replace data.db, restart.
          </div>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {listQ.data.local.map((f: any) => (
              <div key={f.filename} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5 text-xs">
                <span className="font-mono truncate">{f.filename}</span>
                <span className="text-muted-foreground shrink-0">{f.sizeBytes ? `${(f.sizeBytes / 1024 / 1024).toFixed(2)} MB` : ""}</span>
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => handleDownload(f.filename)} data-testid={`button-download-backup-${f.filename}`}>
                  <Download className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// ARCHIVE SECTION
// ============================================================
function ArchiveSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const archiveMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/archive/run").then(r => r.json()),
    onSuccess: (data: any) => {
      toast({ title: "Archive complete", description: `Archived ${data.archived ?? 0} invoices` });
    },
    onError: (e: any) => toast({ title: "Archive failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4">
        <div className="text-sm font-medium mb-1">12-month PDF archive</div>
        <div className="text-xs text-muted-foreground mb-3">
          Bundles PDFs from invoices older than 12 months into monthly zip files and uploads them to Google Drive (folder: &ldquo;SnoHaus AP PDF Archive&rdquo;). Local PDFs are removed after successful upload.
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => archiveMut.mutate()}
            disabled={archiveMut.isPending}
            data-testid="button-archive-run"
          >
            {archiveMut.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Archive className="size-3.5 mr-1.5" />}
            Archive now
          </Button>
        </div>
      </div>
      <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-800 dark:text-amber-300">
        <AlertTriangle className="size-3.5 inline mr-1.5" />
        Archive requires Google Drive to be connected (see Backups section above). The next scheduled run is every Sunday at 04:00.
      </div>
    </div>
  );
}

// ============================================================================
// Access Control (PR #7)
// ----------------------------------------------------------------------------
// Two tabs:
//   1. Roles      — list of roles + permission picker (grouped by module).
//                   System roles (Owner, Manager, ADP Exporter, Read Only)
//                   can't be renamed/deleted but their permissions are editable.
//   2. Assignments — per-user role assignment. Pick one role for a user, then
//                    check which entities it applies to (Option B from session).
//                    "All entities" = entity_id_scope: null.
// ============================================================================

type RbacRole = {
  id: number;
  name: string;
  description: string | null;
  is_system: number;
  permissions: string[];
};

type RbacPermission = {
  id: number;
  key: string;
  module: string;
  description: string | null;
};

type RbacEntity = {
  id: number;
  // payroll_entities uses `location` (e.g. "Greenvale") and `legal_name`
  // (e.g. "SD Ski and Patio Inc"); there is no `code` / `location_label`.
  location: string;
  legal_name: string;
};

type UserRoleAssignment = {
  user_id: number;
  user_email: string;
  user_name: string | null;
  role_id: number;
  role_name: string;
  entity_id_scope: number | null;
};

function AccessControlSection() {
  const [tab, setTab] = useState<"roles" | "assignments">("roles");

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
      <TabsList className="grid grid-cols-2 w-full mb-4">
        <TabsTrigger value="roles" data-testid="tab-rbac-roles">Roles &amp; Permissions</TabsTrigger>
        <TabsTrigger value="assignments" data-testid="tab-rbac-assignments">User Assignments</TabsTrigger>
      </TabsList>
      <TabsContent value="roles">
        <RbacRolesTab />
      </TabsContent>
      <TabsContent value="assignments">
        <RbacAssignmentsTab />
      </TabsContent>
    </Tabs>
  );
}

function RbacRolesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingDescription, setEditingDescription] = useState("");
  const [editingPerms, setEditingPerms] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);

  const rolesQ = useQuery<RbacRole[]>({ queryKey: ["/api/settings/roles"] });
  const permsQ = useQuery<{ permissions: RbacPermission[]; grouped: Record<string, RbacPermission[]> }>(
    { queryKey: ["/api/settings/permissions"] },
  );

  const roles = rolesQ.data || [];
  const grouped = permsQ.data?.grouped || {};
  const selectedRole = roles.find((r) => r.id === selectedRoleId) || null;

  // When user clicks a different role, load its fields into the local editor state.
  function selectRole(r: RbacRole) {
    setSelectedRoleId(r.id);
    setEditingName(r.name);
    setEditingDescription(r.description || "");
    setEditingPerms(new Set(r.permissions));
  }

  // Auto-select the first role on initial load so the editor isn't empty.
  // Effect (not inline) so we don't setState during render.
  useEffect(() => {
    if (roles.length > 0 && selectedRoleId === null) {
      const first = roles[0];
      setSelectedRoleId(first.id);
      setEditingName(first.name);
      setEditingDescription(first.description || "");
      setEditingPerms(new Set(first.permissions));
    }
  }, [roles, selectedRoleId]);

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!selectedRole) throw new Error("No role selected");
      const body: any = { permissions: Array.from(editingPerms) };
      // System roles can't have name/description changed.
      if (!selectedRole.is_system) {
        body.name = editingName.trim();
        body.description = editingDescription.trim() || null;
      }
      const res = await apiRequest("PATCH", `/api/settings/roles/${selectedRole.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Role saved" });
      qc.invalidateQueries({ queryKey: ["/api/settings/roles"] });
      qc.invalidateQueries({ queryKey: ["/api/me"] }); // permissions may have changed for current user
    },
    onError: (e: any) => toast({ title: "Error saving role", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/settings/roles/${id}`),
    onSuccess: () => {
      toast({ title: "Role deleted" });
      setSelectedRoleId(null);
      qc.invalidateQueries({ queryKey: ["/api/settings/roles"] });
      qc.invalidateQueries({ queryKey: ["/api/settings/user-roles"] });
    },
    onError: (e: any) => toast({ title: "Cannot delete", description: e.message, variant: "destructive" }),
  });

  function togglePerm(key: string) {
    setEditingPerms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  if (rolesQ.isLoading || permsQ.isLoading) {
    return (
      <div className="text-sm text-muted-foreground py-6 text-center">
        <Loader2 className="size-4 animate-spin inline mr-2" />Loading…
      </div>
    );
  }

  const moduleLabels: Record<string, string> = {
    ap: "Accounts Payable",
    payroll: "Payroll",
    users: "Users & Access",
    system: "System",
  };

  // Detect unsaved changes so we can enable/disable the Save button.
  const hasChanges = selectedRole && (
    (!selectedRole.is_system && editingName !== selectedRole.name) ||
    (!selectedRole.is_system && (editingDescription || "") !== (selectedRole.description || "")) ||
    editingPerms.size !== selectedRole.permissions.length ||
    Array.from(editingPerms).some((k) => !selectedRole.permissions.includes(k))
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
      {/* Left: role list */}
      <div className="space-y-1">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Roles</div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() => setCreateOpen(true)}
            data-testid="button-rbac-add-role"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        {roles.map((r) => (
          <button
            key={r.id}
            onClick={() => selectRole(r)}
            className={cnLocal(
              "w-full text-left px-2.5 py-1.5 rounded-md text-sm transition-colors",
              selectedRoleId === r.id ? "bg-accent text-accent-foreground" : "hover:bg-muted",
            )}
            data-testid={`button-rbac-role-${r.id}`}
          >
            <div className="flex items-center gap-1.5">
              <span className="flex-1 truncate">{r.name}</span>
              {r.is_system === 1 && (
                <Lock className="size-3 text-muted-foreground" />
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {r.permissions.length} permission{r.permissions.length === 1 ? "" : "s"}
            </div>
          </button>
        ))}
        {roles.length === 0 && (
          <div className="text-xs text-muted-foreground py-3 text-center">No roles</div>
        )}
      </div>

      {/* Right: role editor */}
      <div className="min-w-0">
        {selectedRole ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">Role name</Label>
              <Input
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                disabled={selectedRole.is_system === 1}
                data-testid="input-rbac-role-name"
              />
              {selectedRole.is_system === 1 && (
                <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Lock className="size-3" /> System role name cannot be changed; permissions are editable.
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Description</Label>
              <Textarea
                value={editingDescription}
                onChange={(e) => setEditingDescription(e.target.value)}
                rows={2}
                disabled={selectedRole.is_system === 1}
                placeholder="What does this role do?"
                data-testid="input-rbac-role-description"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Permissions</Label>
              <div className="space-y-3">
                {Object.entries(grouped).map(([module, perms]) => (
                  <div key={module} className="rounded-md border border-border p-3">
                    <div className="text-xs font-medium mb-2">{moduleLabels[module] || module}</div>
                    <div className="space-y-1.5">
                      {perms.map((p) => (
                        <label
                          key={p.key}
                          className="flex items-start gap-2 cursor-pointer"
                          data-testid={`perm-row-${p.key}`}
                        >
                          <Checkbox
                            checked={editingPerms.has(p.key)}
                            onCheckedChange={() => togglePerm(p.key)}
                            className="mt-0.5"
                            data-testid={`checkbox-perm-${p.key}`}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-mono">{p.key}</div>
                            {p.description && (
                              <div className="text-[11px] text-muted-foreground">{p.description}</div>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <Button
                size="sm"
                onClick={() => saveMut.mutate()}
                disabled={!hasChanges || saveMut.isPending}
                data-testid="button-rbac-save-role"
              >
                {saveMut.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Save className="size-3.5 mr-1.5" />}
                Save
              </Button>
              {hasChanges && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => selectRole(selectedRole)}
                  data-testid="button-rbac-discard"
                >
                  <X className="size-3.5 mr-1.5" /> Discard
                </Button>
              )}
              {selectedRole.is_system === 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-destructive hover:text-destructive"
                  onClick={() => {
                    if (confirm(`Delete role "${selectedRole.name}"? This will remove it from all users.`)) {
                      deleteMut.mutate(selectedRole.id);
                    }
                  }}
                  disabled={deleteMut.isPending}
                  data-testid="button-rbac-delete-role"
                >
                  <Trash2 className="size-3.5 mr-1.5" /> Delete role
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground py-6 text-center">Select a role to edit</div>
        )}
      </div>

      {createOpen && (
        <CreateRoleDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            qc.invalidateQueries({ queryKey: ["/api/settings/roles"] }).then(() => {
              setSelectedRoleId(id);
            });
          }}
        />
      )}
    </div>
  );
}

function CreateRoleDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const createMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/settings/roles", { name: name.trim(), description: description.trim() || null, permissions: [] });
      return res.json();
    },
    onSuccess: (r: RbacRole) => {
      toast({ title: "Role created" });
      onCreated(r.id);
    },
    onError: (e: any) => toast({ title: "Cannot create role", description: e.message, variant: "destructive" }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New role</DialogTitle>
          <DialogDescription>Create a custom role, then pick its permissions on the next screen.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Store Manager" data-testid="input-new-role-name" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Description (optional)</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} data-testid="input-new-role-description" />
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              size="sm"
              disabled={!name.trim() || createMut.isPending}
              onClick={() => createMut.mutate()}
              data-testid="button-create-role-submit"
            >
              {createMut.isPending && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RbacAssignmentsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user_id: meId } = useAuth();

  const usersQ = useQuery<any[]>({ queryKey: ["/api/users"] });
  const rolesQ = useQuery<RbacRole[]>({ queryKey: ["/api/settings/roles"] });
  const entitiesQ = useQuery<RbacEntity[]>({ queryKey: ["/api/settings/entities"] });
  const userRolesQ = useQuery<UserRoleAssignment[]>({ queryKey: ["/api/settings/user-roles"] });

  if (usersQ.isLoading || rolesQ.isLoading || entitiesQ.isLoading || userRolesQ.isLoading) {
    return (
      <div className="text-sm text-muted-foreground py-6 text-center">
        <Loader2 className="size-4 animate-spin inline mr-2" />Loading…
      </div>
    );
  }

  const users = usersQ.data || [];
  const roles = rolesQ.data || [];
  const entities = entitiesQ.data || [];
  const allAssignments = userRolesQ.data || [];

  // Group assignments by user_id.
  const byUser = new Map<number, UserRoleAssignment[]>();
  for (const a of allAssignments) {
    if (!byUser.has(a.user_id)) byUser.set(a.user_id, []);
    byUser.get(a.user_id)!.push(a);
  }

  return (
    <div className="space-y-3">
      {users.length === 0 && (
        <div className="text-sm text-muted-foreground py-4 text-center">No users to assign roles to.</div>
      )}
      {users.map((u: any) => (
        <UserRoleAssignmentRow
          key={u.id}
          user={u}
          roles={roles}
          entities={entities}
          existing={byUser.get(u.id) || []}
          isMe={u.id === meId}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["/api/settings/user-roles"] });
            qc.invalidateQueries({ queryKey: ["/api/me"] });
            toast({ title: "Assignments saved" });
          }}
        />
      ))}
    </div>
  );
}

function UserRoleAssignmentRow({
  user, roles, entities, existing, isMe, onSaved,
}: {
  user: any;
  roles: RbacRole[];
  entities: RbacEntity[];
  existing: UserRoleAssignment[];
  isMe: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  // Local state: which role and which entity scopes apply.
  // Option B: ONE role per user; check which entities it applies to.
  // entity_id_scope: null means "all entities" (the "All" checkbox).
  const initialRoleId = existing[0]?.role_id ?? null;
  const initialEntityIds: Array<number | null> = existing
    .filter((a) => a.role_id === initialRoleId)
    .map((a) => a.entity_id_scope);
  const initialAllEntities = initialEntityIds.includes(null);

  const [roleId, setRoleId] = useState<number | null>(initialRoleId);
  const [allEntities, setAllEntities] = useState<boolean>(initialAllEntities);
  const [entityIds, setEntityIds] = useState<Set<number>>(
    new Set(initialEntityIds.filter((id): id is number => id !== null)),
  );
  const [open, setOpen] = useState(false);

  function toggleEntity(id: number) {
    setEntityIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Build the assignments payload that the API expects.
  function buildAssignments() {
    if (roleId === null) return [];
    if (allEntities) return [{ role_id: roleId, entity_id_scope: null }];
    return Array.from(entityIds).map((eid) => ({ role_id: roleId, entity_id_scope: eid }));
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/settings/users/${user.id}/roles`, { assignments: buildAssignments() });
      return res.json();
    },
    onSuccess: () => {
      setOpen(false);
      onSaved();
    },
    onError: (e: any) => toast({ title: "Cannot save", description: e.message, variant: "destructive" }),
  });

  // Pretty summary line for the row (closed state).
  const summary = (() => {
    if (existing.length === 0) return "No role";
    const roleName = existing[0].role_name;
    const scopes = existing.filter((a) => a.role_id === existing[0].role_id);
    if (scopes.some((s) => s.entity_id_scope === null)) return `${roleName} — all entities`;
    const labels = scopes.map((s) => {
      const e = entities.find((x) => x.id === s.entity_id_scope);
      return e?.location || `#${s.entity_id_scope}`;
    });
    return `${roleName} — ${labels.join(", ")}`;
  })();

  // Disable save if nothing selected (and existing isn't already empty).
  const noSelection = roleId === null || (!allEntities && entityIds.size === 0);
  const canSave = !noSelection || existing.length > 0; // allow clearing if currently has roles

  return (
    <div className="rounded-md border border-border bg-card" data-testid={`row-user-assign-${user.id}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm truncate">{user.email}</span>
            {user.name && <span className="text-xs text-muted-foreground">({user.name})</span>}
            {isMe && <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">You</Badge>}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{summary}</div>
        </div>
        <ChevronDown className={cnLocal("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-border space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Role</Label>
            <Select
              value={roleId === null ? "" : String(roleId)}
              onValueChange={(v) => setRoleId(v === "" ? null : Number(v))}
            >
              <SelectTrigger className="h-8 text-xs" data-testid={`select-role-assign-${user.id}`}>
                <SelectValue placeholder="— No role —" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {roleId !== null && (
            <div className="space-y-1.5">
              <Label className="text-xs">Applies to</Label>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={allEntities}
                    onCheckedChange={(v) => setAllEntities(!!v)}
                    data-testid={`checkbox-all-entities-${user.id}`}
                  />
                  <span className="text-sm font-medium">All entities</span>
                  <span className="text-[11px] text-muted-foreground">(includes future ones)</span>
                </label>
                {!allEntities && entities.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 cursor-pointer ml-5">
                    <Checkbox
                      checked={entityIds.has(e.id)}
                      onCheckedChange={() => toggleEntity(e.id)}
                      data-testid={`checkbox-entity-${user.id}-${e.id}`}
                    />
                    <span className="text-sm">
                      {e.location}
                      <span className="text-[11px] text-muted-foreground ml-1.5">{e.legal_name}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => saveMut.mutate()}
              disabled={!canSave || saveMut.isPending}
              data-testid={`button-save-assign-${user.id}`}
            >
              {saveMut.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Save className="size-3.5 mr-1.5" />}
              Save
            </Button>
            {existing.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRoleId(null);
                  setAllEntities(false);
                  setEntityIds(new Set());
                }}
                data-testid={`button-clear-assign-${user.id}`}
              >
                <X className="size-3.5 mr-1.5" /> Clear
              </Button>
            )}
            {isMe && (
              <div className="ml-auto text-[11px] text-muted-foreground flex items-center gap-1">
                <AlertTriangle className="size-3" />
                You can’t remove your own Owner+all-entities access.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Small classnames helper to avoid pulling in cn from utils at the file top.
function cnLocal(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
