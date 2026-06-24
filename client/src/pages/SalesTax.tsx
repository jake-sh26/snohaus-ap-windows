/**
 * Sales Tax — workspace (PR #167).
 *
 * Final page of the Sales Tax trilogy (#165 backend, #166 nav, #167 content).
 * Mode-switches between Simple monthly and Quarterly ST-810 based on the
 * backend's `filing_mode`. Renders the per-store breakdown, the quarterly
 * ST-810 schedule, the filing checklist (Open/Filed/Amended + mark-filed
 * modal), and CSV/PDF/XLSX export buttons.
 *
 * All money arrives as integer cents from the backend and is formatted once via
 * formatCents. Export + mark-filed actions are gated by finance.sales_tax.export.
 */
import type React from "react";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { useEntities } from "@/hooks/useEntities";
import {
  getSalesTaxMonth, getSalesTaxQuarter, upsertSalesTaxFiling, downloadSalesTaxExport,
  listSalesTaxNotes, createSalesTaxNote,
  listFilingAttachments, uploadFilingAttachment,
  downloadFilingAttachment, deleteFilingAttachment,
  type SalesTaxMonth, type SalesTaxQuarter, type SalesTaxStoreRow,
  type SalesTaxFiling, type SalesTaxFilingAttachment,
  type FilingStatus, type ExportFormat,
  type SalesTaxNote,
} from "@/api/sales-tax";

// PR #194 — Entity names are pulled from the DB via `useEntities()`.
// Summary cards use `display_name` (UI brand label). The filing checklist
// (anything that ends up on an ST-810 export or in a filing toast) uses
// `legal_name`, which is the NY DTF corporate name. The two are not
// interchangeable: e.g. Greenvale's brand is "Sno-Haus Greenvale" but its
// DTF filing is "SD Ski and Patio Inc". A previous hardcoded
// `ENTITY_LEGAL_NAMES` const lived here and had silently drifted from the
// DB (missing "Inc" on entities 2 + 3) — it was removed in PR #194.
//
// Server-side, `server/entity-settings.ts` still has its own
// `ENTITY_FILING_INFO` constant that drives the actual ST-810 PDF/CSV math.
// Migrating that to the DB is tracked separately — it has 8+ callsites in
// routes.ts and needs its own PR.

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Integer cents -> "$12,345.67". */
function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const dec = String(abs % 100).padStart(2, "0");
  const withSep = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${withSep}.${dec}`;
}

function bpsToPct(bps: number): string {
  return `${(bps / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

function monthLong(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

/**
 * PR #191 — NY tax-year quarter-end months. Returns true when the YYYY-MM
 * key falls on Feb (Q4 end), May (Q1), Aug (Q2), or Nov (Q3). We trigger the
 * cumulative quarter section in the monthly view on these months.
 */
function isQuarterEndMonth(monthKey: string): boolean {
  const mm = monthKey.slice(5);
  return mm === "02" || mm === "05" || mm === "08" || mm === "11";
}

/** Previous calendar month as YYYY-MM (today June 1 2026 -> "2026-05"). */
function previousMonthKey(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** A 24-month rolling window ending at the current month, descending. */
function monthOptions(): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < 24; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

/** Months a quarter covers, derived from the selected month's NY tax quarter. */
function quarterCoverageLabel(data: SalesTaxMonth): string {
  // R6a: NY ST-810 quarters per Pub 718-Q (tax year is March-February):
  //   Q1 Mar/Apr/May (end May), Q2 Jun/Jul/Aug (end Aug),
  //   Q3 Sep/Oct/Nov (end Nov), Q4 Dec/Jan/Feb (end Feb, spans year).
  // Previously labeled the wrong months for every quarter.
  const [yStr, mStr] = data.month.split("-");
  const yr = Number(yStr);
  const m = Number(mStr);
  // Map the selected quarter-end month -> [months, label-year-list].
  if (m === 5)  return `${MONTH_NAMES[2]} / ${MONTH_NAMES[3]} / ${MONTH_NAMES[4]} ${yr}`;        // Mar/Apr/May
  if (m === 8)  return `${MONTH_NAMES[5]} / ${MONTH_NAMES[6]} / ${MONTH_NAMES[7]} ${yr}`;        // Jun/Jul/Aug
  if (m === 11) return `${MONTH_NAMES[8]} / ${MONTH_NAMES[9]} / ${MONTH_NAMES[10]} ${yr}`;       // Sep/Oct/Nov
  if (m === 2)  return `${MONTH_NAMES[11]} ${yr - 1} / ${MONTH_NAMES[0]} / ${MONTH_NAMES[1]} ${yr}`; // Dec prev-yr + Jan/Feb
  // Non-quarter-end month (shouldn't render this label, but be safe).
  return `${MONTH_NAMES[m - 1]} ${yr}`;
}

const STATUS_BADGE: Record<FilingStatus, { label: string; cls: string }> = {
  open: { label: "Open", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30" },
  filed: { label: "Filed", cls: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30" },
  amended: { label: "Amended", cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30" },
};

export default function SalesTax() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { hasPermission, user_id, name, email } = useAuth();
  const canExport = hasPermission("finance.sales_tax.export");

  const [month, setMonth] = useState<string>(previousMonthKey);
  const months = useMemo(monthOptions, []);

  const dataQ = useQuery<SalesTaxMonth>({
    queryKey: ["/api/recon/finance/sales-tax", month],
    queryFn: () => getSalesTaxMonth(month),
  });
  const data = dataQ.data;

  const isQuarter = data?.filing_mode === "quarter";
  // Filing period: the quarter key in ST-810 mode, otherwise the month.
  const periodKey = isQuarter && data?.quarter_key ? data.quarter_key : month;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales Tax</h1>
        <p className="text-sm text-muted-foreground mt-1">
          ST-810 reporting, filing checklist, and exports.
        </p>
      </div>

      {/* Header row: month picker + mode badge */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-44" data-testid="select-sales-tax-month">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {months.map((m) => (
              <SelectItem key={m} value={m}>{monthLong(m)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data && (
          isQuarter ? (
            <Badge
              className="bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40 gap-1.5"
              data-testid="badge-mode"
            >
              Quarterly ST-810 — covers {quarterCoverageLabel(data)}
            </Badge>
          ) : (
            <Badge variant="outline" data-testid="badge-mode">Simple monthly</Badge>
          )
        )}
      </div>

      {dataQ.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {dataQ.error && (
        <div className="text-sm text-red-600" data-testid="text-sales-tax-error">
          Failed to load: {String((dataQ.error as any)?.message ?? dataQ.error)}
        </div>
      )}

      {data && (
        <>
          <FormModeBanner data={data} />
          <InvariantBanner data={data} />
          <WarehouseAnomalies data={data} />
          <EntityCards data={data} />
          <FilingChecklist
            data={data}
            periodKey={periodKey}
            canExport={canExport}
            currentUser={{ user_id, name, email }}
            onChanged={() => qc.invalidateQueries({ queryKey: ["/api/recon/finance/sales-tax", month] })}
            toast={toast}
          />
          {/* PR #191 — on quarter-end months (Feb/May/Aug/Nov in NY tax-year
              calendar), show the cumulative quarter rollup so the filer can
              cross-check the ST-810 totals. */}
          {!isQuarter && data.quarter_key && isQuarterEndMonth(data.month) && (
            <QuarterlyCumulativeSection quarterKey={data.quarter_key} />
          )}
          {canExport && (
            <ExportButtons periodKey={periodKey} toast={toast} />
          )}
          <NotesSection periodKey={periodKey} isQuarter={isQuarter} toast={toast} />
        </>
      )}
    </div>
  );
}

/**
 * Append-only notes for a sales-tax period. Notes are keyed by periodKey, so
 * the monthly view shows that month's notes and the quarterly view shows the
 * quarter's notes (they're stored independently). Use cases: manual cash
 * refunds, check returns, or anything else not captured by Shopify that the
 * filer should remember when reviewing this period later.
 *
 * The log is append-only — we never edit or delete past entries so the audit
 * trail survives. Each row stamps the author email and ET-local timestamp.
 */
function NotesSection({
  periodKey,
  isQuarter,
  toast,
}: {
  periodKey: string;
  isQuarter: boolean;
  toast: ToastFn;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const notesQ = useQuery<SalesTaxNote[]>({
    queryKey: ["/api/recon/finance/sales-tax/notes", periodKey],
    queryFn: () => listSalesTaxNotes(periodKey),
  });

  const addMut = useMutation({
    mutationFn: (text: string) => createSalesTaxNote(periodKey, text),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["/api/recon/finance/sales-tax/notes", periodKey] });
    },
    onError: (e: any) => {
      toast({ title: "Could not save note", description: String(e?.message ?? e), variant: "destructive" });
    },
  });

  const periodLabel = isQuarter
    ? periodKey.replace("-", " ")
    : monthLong(periodKey);

  const handleSubmit = () => {
    const text = draft.trim();
    if (!text) return;
    addMut.mutate(text);
  };

  const notes = notesQ.data ?? [];

  return (
    <Card data-testid="card-sales-tax-notes">
      <CardHeader>
        <CardTitle className="text-base">Notes for {periodLabel}</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Append-only log. Use for context the Shopify report can’t capture (manual
          cash refund, check return, amended filing rationale, etc.). Multiple
          people can add notes; nothing is ever edited or deleted.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {notesQ.isLoading && (
          <div className="text-sm text-muted-foreground">Loading notes…</div>
        )}
        {notesQ.error && (
          <div className="text-sm text-red-600" data-testid="text-notes-error">
            Failed to load notes: {String((notesQ.error as any)?.message ?? notesQ.error)}
          </div>
        )}

        {!notesQ.isLoading && notes.length === 0 && (
          <div className="text-sm text-muted-foreground italic" data-testid="text-notes-empty">
            No notes yet for this period.
          </div>
        )}

        {notes.length > 0 && (
          <ul className="space-y-3" data-testid="list-sales-tax-notes">
            {notes.map((n) => (
              <li
                key={n.id}
                className="rounded-md border border-border bg-muted/30 px-3 py-2"
                data-testid={`note-${n.id}`}
              >
                <div className="text-xs text-muted-foreground flex flex-wrap gap-x-2">
                  <span className="font-medium text-foreground">
                    {n.user_email ?? "unknown user"}
                  </span>
                  <span>·</span>
                  <span>{formatNoteTimestamp(n.created_at)}</span>
                </div>
                <div className="text-sm mt-1 whitespace-pre-wrap break-words">
                  {n.text}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 pt-2 border-t border-border">
          <Label htmlFor="sales-tax-note-input" className="text-sm">Add a note</Label>
          <Textarea
            id="sales-tax-note-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. Manual cash refund $250 issued at Hempstead 2026-02-14; Shopify won’t reflect this."
            rows={3}
            maxLength={4000}
            disabled={addMut.isPending}
            data-testid="input-sales-tax-note"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {draft.length}/4000
            </span>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!draft.trim() || addMut.isPending}
              data-testid="button-add-sales-tax-note"
            >
              {addMut.isPending ? "Saving…" : "Add note"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Format an ISO timestamp as a readable ET-local date+time. */
function formatNoteTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " ET";
  } catch {
    return iso;
  }
}

function InvariantBanner({ data }: { data: SalesTaxMonth }) {
  const inv = data.invariant;
  if (inv.ok) {
    return (
      <div
        className="rounded-md border border-green-500/40 bg-green-500/10 px-4 py-2.5 text-sm text-green-800 dark:text-green-300"
        data-testid="banner-invariant-ok"
      >
        ✓ Invariant holds — per-entity tax due equals the aggregator total to the penny ({formatCents(inv.view_total_cents)}).
      </div>
    );
  }
  return (
    <div
      className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-800 dark:text-red-300"
      data-testid="banner-invariant-violation"
    >
      ⚠ Invariant violation — per-entity sum {formatCents(inv.per_entity_sum_cents)} differs from view total{" "}
      {formatCents(inv.view_total_cents)} by {formatCents(inv.delta_cents)}. Do not file until resolved.
    </div>
  );
}

/** Form-mode banner: ST-809 (long method) vs ST-810 (quarter-end). */
function FormModeBanner({ data }: { data: SalesTaxMonth }) {
  const isSt810 = data.form_type === "ST-810";
  return (
    <div
      className={
        "rounded-md border px-4 py-2.5 text-sm " +
        (isSt810
          ? "border-blue-500/40 bg-blue-500/10 text-blue-800 dark:text-blue-300"
          : "border-slate-500/30 bg-slate-500/10 text-slate-800 dark:text-slate-300")
      }
      data-testid="banner-form-mode"
    >
      {isSt810
        ? `Filing form: ST-810 — Quarter-End (per-entity + per-jurisdiction). Covers ${quarterCoverageLabel(data)}.`
        : "Filing form: ST-809 — Long Method (per-entity, monthly)."}
    </div>
  );
}

/** Non-blocking warnings for taxable sales attributed to a warehouse location. */
function WarehouseAnomalies({ data }: { data: SalesTaxMonth }) {
  const anomalies = data.warehouse_anomalies ?? [];
  if (anomalies.length === 0) return null;
  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-300"
      data-testid="banner-warehouse-anomaly"
    >
      ⚠ Warehouse fulfillment anomaly — taxable sales attributed to a non-selling location:
      <ul className="mt-1 list-disc list-inside">
        {anomalies.map((a) => (
          <li key={a.location_id} className="tabular-nums">
            {a.name} ({a.location_id}): {formatCents(a.taxable_cents)} taxable
          </li>
        ))}
      </ul>
      <span className="text-xs">Attribution is unchanged — verify these orders rang up at the correct POS.</span>
    </div>
  );
}

/** Three per-entity filing cards with a collapsible per-store breakdown. */
function EntityCards({ data }: { data: SalesTaxMonth }) {
  // Group stores by entity_id (one store per entity today, but keep it general).
  const byEntity = new Map<number, SalesTaxStoreRow[]>();
  for (const s of data.stores) {
    const arr = byEntity.get(s.entity_id) ?? [];
    arr.push(s);
    byEntity.set(s.entity_id, arr);
  }
  const entityIds = [1, 2, 3];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {entityIds.map((eid) => {
        const stores = byEntity.get(eid) ?? [];
        const sum = (pick: (s: SalesTaxStoreRow) => number) => stores.reduce((a, s) => a + pick(s), 0);
        return (
          <EntityCard
            key={eid}
            entityId={eid}
            stores={stores}
            gross={sum((s) => s.gross_sales_cents)}
            marketplace={sum((s) => s.marketplace_sales_cents)}
            taxable={sum((s) => s.taxable_sales_cents)}
            taxDue={sum((s) => s.net_tax_cents)}
          />
        );
      })}
    </div>
  );
}

function EntityCard({
  entityId, stores, gross, marketplace, taxable, taxDue,
}: {
  entityId: number;
  stores: SalesTaxStoreRow[];
  gross: number;
  marketplace: number;
  taxable: number;
  taxDue: number;
}) {
  const [open, setOpen] = useState(false);
  // PR #194 — Summary card uses the brand label (display_name). Falls back
  // to short_name → location → "Entity {id}" via the EntityView helpers.
  const { byId } = useEntities();
  const ent = byId(entityId);
  const label = ent?.displayName ?? `Entity ${entityId}`;
  return (
    <Card data-testid={`card-entity-${entityId}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{label}</CardTitle>
        <span className="text-xs text-muted-foreground">Entity {entityId}</span>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Gross</span><span className="tabular-nums">{formatCents(gross)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Marketplace</span><span className="tabular-nums">{formatCents(marketplace)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Taxable</span><span className="tabular-nums">{formatCents(taxable)}</span></div>
        <div className="flex justify-between font-medium border-t pt-1.5 mt-1.5"><span>Tax due</span><span className="tabular-nums" data-testid={`text-entity-${entityId}-tax-due`}>{formatCents(taxDue)}</span></div>
        {stores.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              onClick={() => setOpen((v) => !v)}
              data-testid={`button-entity-${entityId}-breakdown`}
            >
              {open ? "Hide" : "Show"} per-store breakdown
            </button>
            {open && (
              <div className="mt-2 space-y-2">
                {stores.map((s) => (
                  <div key={s.store_id} className="rounded border px-2 py-1.5 text-xs">
                    <div className="font-medium">{s.name} · {s.county} · {bpsToPct(s.rate_bps)}</div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Gross</span><span className="tabular-nums">{formatCents(s.gross_sales_cents)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Taxable</span><span className="tabular-nums">{formatCents(s.taxable_sales_cents)}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Tax due</span><span className="tabular-nums">{formatCents(s.net_tax_cents)}</span></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type ToastFn = ReturnType<typeof useToast>["toast"];

function FilingChecklist({
  data, periodKey, canExport, currentUser, onChanged, toast,
}: {
  data: SalesTaxMonth;
  periodKey: string;
  canExport: boolean;
  currentUser: { user_id: number | null; name: string | null; email: string | null };
  onChanged: () => void;
  toast: ToastFn;
}) {
  // PR #191 â each entity (1=Greenvale, 2=Huntington, 3=Hempstead) files
  // its own ST-810/ST-809 return. Render 3 cards. The legacy aggregate row
  // (entity_id 0) is intentionally NOT shown; it remains in the backend only
  // for backward compatibility with old per-period exports.
  const filings = data.filings_by_entity ?? [];
  const filingFor = (eid: number): SalesTaxFiling | undefined =>
    filings.find((f) => f.entity_id === eid);

  // Tax-due per entity for display in the card header (sums net_tax_cents
  // across the entity’s stores in this period).
  const taxDueByEntity = new Map<number, number>();
  for (const s of data.stores) {
    taxDueByEntity.set(
      s.entity_id,
      (taxDueByEntity.get(s.entity_id) ?? 0) + s.net_tax_cents,
    );
  }

  const entityIds = [1, 2, 3];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Filing checklist
          <span className="text-xs font-normal text-muted-foreground">period {periodKey}</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Each entity files its own return. Mark each card filed individually and
          attach the official confirmation PDF for the audit trail.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-3">
          {entityIds.map((eid) => (
            <EntityFilingCard
              key={eid}
              entityId={eid}
              periodKey={periodKey}
              filing={filingFor(eid)}
              taxDueCents={taxDueByEntity.get(eid) ?? 0}
              canExport={canExport}
              currentUser={currentUser}
              onChanged={onChanged}
              toast={toast}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One filing card for one entity. Owns its own modal + attachments query.
 *
 * Per-entity attachments are scoped to (period_key, entity_id) on the server.
 * Uploading a PDF here records who uploaded it and stores the blob in SQLite
 * so it follows the database backup/restore cycle (no separate file store).
 */
function EntityFilingCard({
  entityId, periodKey, filing, taxDueCents,
  canExport, currentUser, onChanged, toast,
}: {
  entityId: number;
  periodKey: string;
  filing: SalesTaxFiling | undefined;
  taxDueCents: number;
  canExport: boolean;
  currentUser: { user_id: number | null; name: string | null; email: string | null };
  onChanged: () => void;
  toast: ToastFn;
}) {
  const qc = useQueryClient();
  // PR #194 — Filing checklist row. Toasts, dialog titles, and the card
  // header all reference what the user is *filing* with NY DTF, so we use
  // the DB-backed `legal_name` here, not the brand label. Falls back to
  // display_name → "Entity {id}" if the row hasn't loaded yet.
  const { byId } = useEntities();
  const ent = byId(entityId);
  const legal = ent?.legal_name ?? ent?.displayName ?? `Entity ${entityId}`;
  const status: FilingStatus = filing?.status ?? "open";
  const badge = STATUS_BADGE[status];

  const [open, setOpen] = useState(false);
  const [amendMode, setAmendMode] = useState(false);
  const [filedAt, setFiledAt] = useState<string>("");
  const [confirmation, setConfirmation] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const mut = useMutation({
    mutationFn: (input: {
      status: FilingStatus;
      filed_at: string | null;
      confirmation_number: string;
      notes: string;
    }) =>
      upsertSalesTaxFiling(periodKey, {
        entity_id: entityId,
        ...input,
      }),
    onSuccess: () => {
      setOpen(false);
      toast({
        title: "Filing updated",
        description: `${legal} — ${periodKey} marked ${amendMode ? "amended" : "filed"}.`,
      });
      onChanged();
    },
    onError: (e: any) =>
      toast({ title: "Update failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  function openModal(amend: boolean) {
    setAmendMode(amend);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    setFiledAt(
      filing?.filed_at
        ? filing.filed_at.slice(0, 16)
        : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`,
    );
    setConfirmation(filing?.confirmation_number ?? "");
    setNotes(filing?.notes ?? "");
    setOpen(true);
  }

  function submit() {
    mut.mutate({
      status: amendMode ? "amended" : "filed",
      filed_at: filedAt ? filedAt.replace("T", " ") + ":00" : null,
      confirmation_number: confirmation.trim(),
      notes: notes.trim(),
    });
  }

  // -- Attachments --------------------------------------------------------
  const attachmentsKey = ["/api/recon/finance/sales-tax/filings", periodKey, entityId, "attachments"];
  const attachmentsQ = useQuery<SalesTaxFilingAttachment[]>({
    queryKey: attachmentsKey,
    queryFn: () => listFilingAttachments(periodKey, entityId),
  });

  const uploadMut = useMutation({
    mutationFn: (file: File) => uploadFilingAttachment(periodKey, entityId, file),
    onSuccess: () => {
      toast({ title: "Attachment uploaded", description: `${legal} — ${periodKey}` });
      qc.invalidateQueries({ queryKey: attachmentsKey });
    },
    onError: (e: any) =>
      toast({ title: "Upload failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => deleteFilingAttachment(id),
    onSuccess: () => {
      toast({ title: "Attachment removed" });
      qc.invalidateQueries({ queryKey: attachmentsKey });
    },
    onError: (e: any) =>
      toast({ title: "Delete failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  function handlePickFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0];
    ev.target.value = ""; // allow re-uploading the same filename later
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      toast({ title: "PDF only", description: "Only .pdf files are accepted.", variant: "destructive" });
      return;
    }
    if (f.size > 25 * 1024 * 1024) {
      toast({ title: "Too large", description: "Max 25 MB per attachment.", variant: "destructive" });
      return;
    }
    uploadMut.mutate(f);
  }

  async function handleDownload(att: SalesTaxFilingAttachment) {
    try {
      await downloadFilingAttachment(att.id, att.filename);
    } catch (e: any) {
      toast({ title: "Download failed", description: String(e?.message ?? e), variant: "destructive" });
    }
  }

  const filedByLabel = (() => {
    if (!filing || filing.filed_by_user_id == null) return "—";
    if (filing.filed_by_user_id === currentUser.user_id)
      return currentUser.name || currentUser.email || `User ${filing.filed_by_user_id}`;
    return `User ${filing.filed_by_user_id}`;
  })();

  const attachments = attachmentsQ.data ?? [];

  return (
    <Card data-testid={`card-filing-${entityId}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{legal}</CardTitle>
          <Badge className={badge.cls} data-testid={`badge-filing-${entityId}-status`}>
            {badge.label}
          </Badge>
        </div>
        <div className="flex justify-between text-xs text-muted-foreground mt-1">
          <span>Entity {entityId}</span>
          <span className="tabular-nums" data-testid={`text-filing-${entityId}-tax-due`}>
            Tax due {formatCents(taxDueCents)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status === "open" ? (
          <div className="text-muted-foreground text-xs">Not yet filed.</div>
        ) : (
          <div className="space-y-1 text-xs">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Filed at</span>
              <span className="tabular-nums">{filing?.filed_at ?? "—"}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Confirmation #</span>
              <span className="font-mono">{filing?.confirmation_number || "—"}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Filed by</span>
              <span className="truncate" title={filedByLabel}>{filedByLabel}</span>
            </div>
            {filing?.notes ? (
              <div className="text-muted-foreground whitespace-pre-wrap break-words pt-1">
                {filing.notes}
              </div>
            ) : null}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          {status === "open" ? (
            <Button
              size="sm"
              disabled={!canExport}
              onClick={() => openModal(false)}
              data-testid={`button-mark-filed-${entityId}`}
              title={canExport ? undefined : "Requires finance.sales_tax.export"}
            >
              Mark as Filed
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!canExport}
              onClick={() => openModal(true)}
              data-testid={`button-amend-filing-${entityId}`}
              title={canExport ? undefined : "Requires finance.sales_tax.export"}
            >
              Amend
            </Button>
          )}
        </div>

        {/* Attachments */}
        <div className="border-t pt-2 space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">
            Filing PDFs ({attachments.length})
          </div>
          {attachmentsQ.isLoading && (
            <div className="text-xs text-muted-foreground">Loading…</div>
          )}
          {attachments.length === 0 && !attachmentsQ.isLoading && (
            <div className="text-xs text-muted-foreground italic">No PDFs attached.</div>
          )}
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs"
              data-testid={`row-attachment-${att.id}`}
            >
              <button
                type="button"
                onClick={() => handleDownload(att)}
                className="text-left truncate text-blue-600 dark:text-blue-400 hover:underline flex-1"
                title={att.filename}
                data-testid={`button-download-attachment-${att.id}`}
              >
                {att.filename}
              </button>
              <span className="text-muted-foreground tabular-nums shrink-0">
                {formatBytes(att.size_bytes)}
              </span>
              {canExport && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete ${att.filename}?`)) {
                      deleteMut.mutate(att.id);
                    }
                  }}
                  className="text-red-600 hover:underline shrink-0"
                  data-testid={`button-delete-attachment-${att.id}`}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
          {canExport && (
            <label className="inline-flex items-center gap-2 text-xs cursor-pointer mt-1">
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={handlePickFile}
                disabled={uploadMut.isPending}
                className="hidden"
                data-testid={`input-upload-${entityId}`}
              />
              <span className="rounded border border-dashed border-border px-2 py-1 hover:bg-muted">
                {uploadMut.isPending ? "Uploading…" : "+ Attach PDF"}
              </span>
            </label>
          )}
        </div>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {amendMode ? "Amend filing" : "Mark as Filed"} — {legal} — {periodKey}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`filed-at-${entityId}`}>Filed at</Label>
              <Input
                id={`filed-at-${entityId}`} type="datetime-local" value={filedAt}
                onChange={(e) => setFiledAt(e.target.value)}
                data-testid={`input-filed-at-${entityId}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`confirmation-${entityId}`}>Confirmation number</Label>
              <Input
                id={`confirmation-${entityId}`} value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                placeholder="NY portal confirmation #"
                data-testid={`input-confirmation-${entityId}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`notes-${entityId}`}>Notes</Label>
              <Textarea
                id={`notes-${entityId}`} value={notes} rows={3}
                onChange={(e) => setNotes(e.target.value)}
                data-testid={`input-notes-${entityId}`}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              onClick={submit}
              disabled={mut.isPending}
              data-testid={`button-submit-filing-${entityId}`}
            >
              {mut.isPending ? "Saving…" : amendMode ? "Save amendment" : "Confirm filed"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Pretty-print a byte count: 12345 -> "12.1 KB". */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Quarter-end months also show a cumulative quarter rollup so the filer can
 * verify the ST-810 quarter totals before submitting. Renders only when the
 * selected month is the NY-tax-year quarter end (Feb, May, Aug, Nov).
 *
 * Each entity card here is collapsible (closed by default) so the page stays
 * compact for the common case where the filer is just reviewing the month.
 */
function QuarterlyCumulativeSection({
  quarterKey,
}: {
  quarterKey: string;
}) {
  const quarterQ = useQuery<SalesTaxQuarter>({
    queryKey: ["/api/recon/finance/sales-tax/quarter", quarterKey],
    queryFn: () => getSalesTaxQuarter(quarterKey),
  });

  const data = quarterQ.data;

  // Cumulative per-entity totals across the 3 months in the quarter.
  // We sum store-level cents (filtered by entity_id) across per_month entries.
  const cumulative = (() => {
    const out = new Map<number, { gross: number; taxable: number; tax: number; marketplace: number }>();
    if (!data) return out;
    for (const month of data.per_month) {
      for (const s of month.stores) {
        const cur = out.get(s.entity_id) ?? { gross: 0, taxable: 0, tax: 0, marketplace: 0 };
        cur.gross += s.gross_sales_cents;
        cur.taxable += s.taxable_sales_cents;
        cur.tax += s.net_tax_cents;
        cur.marketplace += s.marketplace_sales_cents;
        out.set(s.entity_id, cur);
      }
    }
    return out;
  })();

  const entityIds = [1, 2, 3];

  return (
    <Card data-testid="card-quarter-cumulative">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Quarterly cumulative — {quarterKey}
          <Badge variant="outline" className="font-normal text-xs">Quarter end</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Running totals for the 3 months in this quarter. Use these to verify
          your ST-810 quarter return matches the per-month numbers above.
        </p>
      </CardHeader>
      <CardContent>
        {quarterQ.isLoading && (
          <div className="text-sm text-muted-foreground">Loading quarter rollup…</div>
        )}
        {quarterQ.error && (
          <div className="text-sm text-red-600">
            Failed to load quarter: {String((quarterQ.error as any)?.message ?? quarterQ.error)}
          </div>
        )}
        {data && (
          <div className="grid gap-4 md:grid-cols-3">
            {entityIds.map((eid) => (
              <QuarterEntityCard
                key={eid}
                entityId={eid}
                gross={cumulative.get(eid)?.gross ?? 0}
                marketplace={cumulative.get(eid)?.marketplace ?? 0}
                taxable={cumulative.get(eid)?.taxable ?? 0}
                taxDue={cumulative.get(eid)?.tax ?? 0}
                perMonth={data.per_month}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuarterEntityCard({
  entityId, gross, marketplace, taxable, taxDue, perMonth,
}: {
  entityId: number;
  gross: number;
  marketplace: number;
  taxable: number;
  taxDue: number;
  perMonth: SalesTaxMonth[];
}) {
  const [open, setOpen] = useState(false);
  // PR #194 — Quarter cumulative summary card uses the brand label.
  const { byId } = useEntities();
  const ent = byId(entityId);
  const label = ent?.displayName ?? `Entity ${entityId}`;

  // Per-month breakdown for this entity.
  const rows = perMonth.map((m) => {
    let g = 0, t = 0, x = 0;
    for (const s of m.stores) {
      if (s.entity_id !== entityId) continue;
      g += s.gross_sales_cents;
      t += s.taxable_sales_cents;
      x += s.net_tax_cents;
    }
    return { month: m.month, gross: g, taxable: t, taxDue: x };
  });

  return (
    <Card data-testid={`card-quarter-entity-${entityId}`} className="border-blue-500/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{label}</CardTitle>
        <span className="text-xs text-muted-foreground">Quarter cumulative</span>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Gross</span>
          <span className="tabular-nums">{formatCents(gross)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Marketplace</span>
          <span className="tabular-nums">{formatCents(marketplace)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Taxable</span>
          <span className="tabular-nums">{formatCents(taxable)}</span>
        </div>
        <div className="flex justify-between font-medium border-t pt-1.5 mt-1.5">
          <span>Tax due (quarter)</span>
          <span
            className="tabular-nums"
            data-testid={`text-quarter-entity-${entityId}-tax-due`}
          >
            {formatCents(taxDue)}
          </span>
        </div>
        <div className="pt-2">
          <button
            type="button"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            onClick={() => setOpen((v) => !v)}
            data-testid={`button-quarter-entity-${entityId}-breakdown`}
          >
            {open ? "Hide" : "Show"} per-month breakdown
          </button>
          {open && (
            <div className="mt-2 space-y-1.5">
              {rows.map((r) => (
                <div key={r.month} className="rounded border px-2 py-1.5 text-xs">
                  <div className="font-medium">{monthLong(r.month)}</div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gross</span>
                    <span className="tabular-nums">{formatCents(r.gross)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Taxable</span>
                    <span className="tabular-nums">{formatCents(r.taxable)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tax due</span>
                    <span className="tabular-nums">{formatCents(r.taxDue)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ExportButtons({ periodKey, toast }: { periodKey: string; toast: ToastFn }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  async function run(format: ExportFormat) {
    setBusy(format);
    try {
      await downloadSalesTaxExport(periodKey, format);
    } catch (e: any) {
      toast({ title: "Export failed", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Exports</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => run("csv")} data-testid="button-export-csv">
          {busy === "csv" ? "Preparing…" : "Download CSV"}
        </Button>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => run("pdf")} data-testid="button-export-pdf">
          {busy === "pdf" ? "Preparing…" : "Download PDF"}
        </Button>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => run("xlsx")} data-testid="button-export-xlsx">
          {busy === "xlsx" ? "Preparing…" : "Download XLSX"}
        </Button>
      </CardContent>
    </Card>
  );
}
