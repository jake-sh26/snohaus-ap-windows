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
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  getSalesTaxMonth, upsertSalesTaxFiling, downloadSalesTaxExport,
  type SalesTaxMonth, type SalesTaxStoreRow, type FilingStatus, type ExportFormat,
} from "@/api/sales-tax";

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

/** Months a quarter covers, derived from the selected month's calendar quarter. */
function quarterCoverageLabel(data: SalesTaxMonth): string {
  // NY ST-810 quarters: Q1 Dec-Feb, Q2 Mar-May, Q3 Jun-Aug, Q4 Sep-Nov.
  const m = Number(data.month.split("-")[1]);
  const endMonthByQuarterEnd: Record<number, number[]> = {
    2: [12, 1, 2], 5: [3, 4, 5], 8: [6, 7, 8], 11: [9, 10, 11],
  };
  const set = endMonthByQuarterEnd[m] ?? [m];
  const yr = data.month.split("-")[0];
  return `${set.map((mm) => MONTH_NAMES[mm - 1]).join(" / ")} ${yr}`;
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
          <InvariantBanner data={data} />
          <PerStoreTable data={data} />
          {isQuarter && <QuarterlySchedule data={data} />}
          <FilingChecklist
            data={data}
            periodKey={periodKey}
            canExport={canExport}
            currentUser={{ user_id, name, email }}
            onChanged={() => qc.invalidateQueries({ queryKey: ["/api/recon/finance/sales-tax", month] })}
            toast={toast}
          />
          {canExport && (
            <ExportButtons periodKey={periodKey} toast={toast} />
          )}
        </>
      )}
    </div>
  );
}

function InvariantBanner({ data }: { data: SalesTaxMonth }) {
  const inv = data.invariant;
  if (inv.ok) {
    return (
      <div
        className="rounded-md border border-green-500/40 bg-green-500/10 px-4 py-2.5 text-sm text-green-800 dark:text-green-300"
        data-testid="banner-invariant-ok"
      >
        ✓ Invariant holds — per-store sum equals view total to the penny ({formatCents(inv.view_total_cents)}).
      </div>
    );
  }
  return (
    <div
      className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-800 dark:text-red-300"
      data-testid="banner-invariant-violation"
    >
      ⚠ Invariant violation — per-store sum {formatCents(inv.per_entity_sum_cents)} differs from view total{" "}
      {formatCents(inv.view_total_cents)} by {formatCents(inv.delta_cents)}. Do not file until resolved.
    </div>
  );
}

function storeNameCell(s: SalesTaxStoreRow) {
  if (s.closed && s.unexpected_activity) {
    return (
      <span className="flex items-center gap-1.5">
        {s.name}
        <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 text-[10px]">
          Unexpected activity at closed store
        </Badge>
      </span>
    );
  }
  if (s.closed && s.gross_sales_cents === 0) {
    return (
      <span>
        {s.name} <span className="italic text-muted-foreground">Closed post-Apr 2026</span>
      </span>
    );
  }
  return <span>{s.name}</span>;
}

function PerStoreTable({ data }: { data: SalesTaxMonth }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Per-store breakdown — {monthLong(data.month)}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Store</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>County</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead className="text-right">Gross Sales</TableHead>
              <TableHead className="text-right">Taxable Sales</TableHead>
              <TableHead className="text-right">Exempt Sales</TableHead>
              <TableHead className="text-right">Tax Collected</TableHead>
              <TableHead className="text-right">Refund Tax</TableHead>
              <TableHead className="text-right">Net Tax</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.stores.map((s) => (
              <TableRow key={s.store_id} data-testid={`row-store-${s.entity_id}`}>
                <TableCell className="font-medium">{storeNameCell(s)}</TableCell>
                <TableCell>{s.entity_id}</TableCell>
                <TableCell>{s.county}</TableCell>
                <TableCell>{bpsToPct(s.rate_bps)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(s.gross_sales_cents)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(s.taxable_sales_cents)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(s.exempt_sales_cents)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(s.tax_collected_cents)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(s.refund_tax_in_period_cents)}</TableCell>
                <TableCell className="text-right tabular-nums font-medium">{formatCents(s.net_tax_cents)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="font-semibold border-t-2">
              <TableCell>Total</TableCell>
              <TableCell colSpan={3} />
              <TableCell className="text-right tabular-nums">{formatCents(data.totals.gross_sales_cents)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCents(data.totals.taxable_sales_cents)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCents(data.totals.gross_sales_cents - data.totals.taxable_sales_cents)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCents(data.totals.tax_collected_cents)}</TableCell>
              <TableCell className="text-right tabular-nums" />
              <TableCell className="text-right tabular-nums">{formatCents(data.totals.net_tax_cents)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function QuarterlySchedule({ data }: { data: SalesTaxMonth }) {
  // Single-month payload only carries one month's stores; the full 3-month
  // schedule is rendered from the quarter export / endpoint. Here we present
  // the selected month's jurisdictional rows in the ST-810 grouping (month →
  // store) so the operator sees the filing-portal structure; the downloadable
  // PDF/XLSX exports carry the full 3-month rollup.
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Quarterly ST-810 schedule — jurisdictional breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          NY filing-portal grouping (month · store · jurisdiction). The full three-month
          rollup is included in the PDF and XLSX exports below.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead>Store</TableHead>
              <TableHead>Jurisdiction</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead className="text-right">Taxable Sales</TableHead>
              <TableHead className="text-right">Tax Collected</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.stores.map((s) => (
              <TableRow key={`q-${s.store_id}`}>
                <TableCell>{MONTH_NAMES[Number(data.month.split("-")[1]) - 1]}</TableCell>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell>{s.county}</TableCell>
                <TableCell>{bpsToPct(s.rate_bps)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(s.taxable_sales_cents)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(s.tax_collected_cents)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="font-semibold border-t-2">
              <TableCell colSpan={4}>Total ({monthLong(data.month)})</TableCell>
              <TableCell className="text-right tabular-nums">{formatCents(data.totals.taxable_sales_cents)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCents(data.totals.tax_collected_cents)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
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
  const filing = data.filing;
  const status = filing.status;
  const badge = STATUS_BADGE[status];

  const [open, setOpen] = useState(false);
  const [amendMode, setAmendMode] = useState(false);
  const [filedAt, setFiledAt] = useState<string>("");
  const [confirmation, setConfirmation] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const mut = useMutation({
    mutationFn: (input: { status: FilingStatus; filed_at: string | null; confirmation_number: string; notes: string }) =>
      upsertSalesTaxFiling(periodKey, input),
    onSuccess: () => {
      setOpen(false);
      toast({ title: "Filing updated", description: `${periodKey} marked ${amendMode ? "amended" : "filed"}.` });
      onChanged();
    },
    onError: (e: any) => toast({ title: "Update failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  function openModal(amend: boolean) {
    setAmendMode(amend);
    // Default filed_at to now (local, formatted for datetime-local input).
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    setFiledAt(
      filing.filed_at
        ? filing.filed_at.slice(0, 16)
        : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`,
    );
    setConfirmation(filing.confirmation_number ?? "");
    setNotes(filing.notes ?? "");
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

  const filedByLabel = (() => {
    if (filing.filed_by_user_id == null) return "—";
    if (filing.filed_by_user_id === currentUser.user_id) return currentUser.name || currentUser.email || `User ${filing.filed_by_user_id}`;
    return `User ${filing.filed_by_user_id}`;
  })();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Filing checklist
          <Badge className={badge.cls} data-testid="badge-filing-status">{badge.label}</Badge>
          <span className="text-xs font-normal text-muted-foreground">period {periodKey}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {status === "open" ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">This period has not been filed.</span>
            <Button
              size="sm"
              disabled={!canExport}
              onClick={() => openModal(false)}
              data-testid="button-mark-filed"
              title={canExport ? undefined : "Requires finance.sales_tax.export"}
            >
              Mark as Filed
            </Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 max-w-xl">
              <div className="font-medium">Filed at</div>
              <div className="tabular-nums">{filing.filed_at ?? "—"}</div>
              <div className="font-medium">Confirmation #</div>
              <div className="font-mono text-xs">{filing.confirmation_number || "—"}</div>
              <div className="font-medium">Filed by</div>
              <div>{filedByLabel}</div>
              <div className="font-medium">Notes</div>
              <div className="whitespace-pre-wrap">{filing.notes || "—"}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!canExport}
              onClick={() => openModal(true)}
              data-testid="button-amend-filing"
              title={canExport ? undefined : "Requires finance.sales_tax.export"}
            >
              Amend
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{amendMode ? "Amend filing" : "Mark as Filed"} — {periodKey}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="filed-at">Filed at</Label>
              <Input
                id="filed-at" type="datetime-local" value={filedAt}
                onChange={(e) => setFiledAt(e.target.value)} data-testid="input-filed-at"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirmation">Confirmation number</Label>
              <Input
                id="confirmation" value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                placeholder="NY portal confirmation #" data-testid="input-confirmation"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes" value={notes} rows={3}
                onChange={(e) => setNotes(e.target.value)} data-testid="input-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={mut.isPending} data-testid="button-submit-filing">
              {mut.isPending ? "Saving…" : amendMode ? "Save amendment" : "Confirm filed"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
