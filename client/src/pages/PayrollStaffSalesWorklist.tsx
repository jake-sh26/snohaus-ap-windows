import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  ClipboardList, ChevronLeft, AlertTriangle, Eye, EyeOff, Check, X, Loader2,
} from "lucide-react";

// ============================================================================
// Payroll > Staff Sales > Reconciliation Worklist (PR E_Staff)
//
// Lists per-(order, group_key) discrepancies between ShopifyQL's
// recon_shopify_staff_sales table and our per-line attribution view
// v_staff_attributed_sales. Backed by GET /order-worklist (PR D4-D6).
//
// Classifications:
//   - unexplained          (red)    - real issues, action items
//   - shopify_refund_strip (yellow) - Shopify's reported refund bug; informational
//   - pre_ingest_refund    (purple) - original sale predates staff-attribution
//                                     launch (June 22, 2026); ignore
//   - match                (green)  - hidden by default
//
// Earliest selectable date is floored at 2026-06-22 (staff-attribution
// ingest start). Refunds for sales before that date can't be tied to a
// staffer and would only ever surface as pre_ingest_refund.
//
// Each row can be acknowledged (POST /worklist/acknowledge); acknowledged
// rows hide from the default view but are still queryable.
// ============================================================================

// Floor date: staff attribution ingest launched 2026-06-22. Earlier dates
// would just surface pre_ingest_refund rows that we know cannot be
// recovered.
const FLOOR_DATE = "2026-06-22";

// ----- Date helpers ---------------------------------------------------------

function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function lastNDays(n: number): { since: string; until: string } {
  const until = new Date();
  const since = new Date();
  since.setDate(until.getDate() - (n - 1));
  let sinceISO = fmtISO(since);
  // Clamp to floor.
  if (sinceISO < FLOOR_DATE) sinceISO = FLOOR_DATE;
  return { since: sinceISO, until: fmtISO(until) };
}

function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtMoneyClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return Number(n) < 0 ? "text-red-600 dark:text-red-400" : "";
}

// ----- API row shape (matches server/routes.ts) -----------------------------

type WorklistRow = {
  order_name: string;
  group_key: string;
  employee_id: number | null;
  assisting_staff_id: string | null;
  staff_name: string | null;
  ql_net: number | null;
  ql_sale: number | null;
  ql_refund: number | null;
  att_sale: number;
  att_refund: number;
  att_net: number | null;
  classification: "unexplained" | "shopify_refund_strip" | "pre_ingest_refund" | "match" | string;
  delta: number;
  acknowledged: boolean;
  acknowledged_at: string | null;
  acknowledged_by_email: string | null;
  acknowledgment_note: string | null;
};

type WorklistSummary = {
  unexplained: { row_count: number; order_count: number; total_abs_delta: number };
  pre_ingest_refund: { row_count: number; order_count: number; total_abs_delta: number };
  shopify_refund_strip: { row_count: number; order_count: number; total_abs_delta: number };
  match: { row_count: number; order_count: number };
  acknowledged: { row_count: number };
};

type WorklistResponse = {
  ok: boolean;
  since: string;
  until: string;
  summary: WorklistSummary;
  rows: WorklistRow[];
};

// ----- Classification badge -------------------------------------------------

function ClassificationBadge({ c }: { c: WorklistRow["classification"] }) {
  switch (c) {
    case "unexplained":
      return (
        <Badge variant="destructive" data-testid={`badge-${c}`}>
          Unexplained
        </Badge>
      );
    case "shopify_refund_strip":
      return (
        <Badge
          className="bg-yellow-100 text-yellow-900 hover:bg-yellow-100 border-yellow-300 dark:bg-yellow-900/40 dark:text-yellow-100"
          data-testid={`badge-${c}`}
        >
          Shopify refund bug
        </Badge>
      );
    case "pre_ingest_refund":
      return (
        <Badge
          className="bg-purple-100 text-purple-900 hover:bg-purple-100 border-purple-300 dark:bg-purple-900/40 dark:text-purple-100"
          data-testid={`badge-${c}`}
        >
          Pre-ingest refund
        </Badge>
      );
    case "match":
      return (
        <Badge
          className="bg-green-100 text-green-900 hover:bg-green-100 border-green-300 dark:bg-green-900/40 dark:text-green-100"
          data-testid={`badge-${c}`}
        >
          Match
        </Badge>
      );
    default:
      return <Badge variant="secondary">{c}</Badge>;
  }
}

// ----- Acknowledge dialog ---------------------------------------------------

function AckDialog({
  open, onOpenChange, row, onConfirm, pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  row: WorklistRow | null;
  onConfirm: (note: string) => void;
  pending: boolean;
}) {
  const [note, setNote] = useState("");
  if (!row) return null;
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setNote(""); }}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-acknowledge">
        <DialogHeader>
          <DialogTitle>Acknowledge worklist row</DialogTitle>
          <DialogDescription>
            Hides this row from the default worklist. Does not change any
            commission or reconciliation calculations. You can un-acknowledge
            later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <span className="text-muted-foreground">Order:</span>{" "}
            <span className="font-mono">{row.order_name}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Group:</span>{" "}
            <span className="font-mono">{row.group_key}</span>
            {row.staff_name && (
              <span className="ml-2 text-muted-foreground">({row.staff_name})</span>
            )}
          </div>
          <div>
            <span className="text-muted-foreground">Classification:</span>{" "}
            <ClassificationBadge c={row.classification} />
          </div>
          <div>
            <Label className="text-xs" htmlFor="ack-note">Note (optional)</Label>
            <Textarea
              id="ack-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. cashier did not tag staff at ring-up; accepted as POS workflow loss"
              rows={3}
              data-testid="textarea-ack-note"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(note)}
            disabled={pending}
            data-testid="button-confirm-ack"
          >
            {pending ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Check className="size-4 mr-2" />}
            Acknowledge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----- Main page ------------------------------------------------------------

export default function PayrollStaffSalesWorklist() {
  const { hasPermission } = useAuth();
  const canAck = hasPermission("payroll.edit_overrides");
  const { toast } = useToast();
  const qc = useQueryClient();

  // Default window: last 7 days (floored at FLOOR_DATE on the since side).
  const defaultWindow = useMemo(() => lastNDays(7), []);
  const [since, setSince] = useState<string>(defaultWindow.since);
  const [until, setUntil] = useState<string>(defaultWindow.until);

  // Visibility toggles. Defaults reflect what Jake actually wants to see
  // day-to-day: unexplained + shopify_refund_strip rows that are still
  // unacknowledged. Pre-ingest refunds and matches are noise by default.
  const [showPreIngest, setShowPreIngest] = useState(false);
  const [showMatches, setShowMatches] = useState(false);
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  // Acknowledgment dialog state.
  const [ackTarget, setAckTarget] = useState<WorklistRow | null>(null);
  const [ackOpen, setAckOpen] = useState(false);

  // ------- Query -------
  const includeMatches = showMatches ? "1" : "0";
  const includeAcknowledged = showAcknowledged ? "1" : "0";

  const worklistQ = useQuery<WorklistResponse>({
    queryKey: [
      "/api/recon/shopify/staff-sales/order-worklist",
      since, until, includeMatches, includeAcknowledged,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        since, until,
        include_matches: includeMatches,
        include_acknowledged: includeAcknowledged,
      });
      const res = await apiRequest(
        "GET",
        `/api/recon/shopify/staff-sales/order-worklist?${params.toString()}`,
      );
      return (await res.json()) as WorklistResponse;
    },
  });

  // ------- Mutations -------
  const ackMut = useMutation({
    mutationFn: async (input: { order_name: string; group_key: string; note: string }) => {
      const res = await apiRequest(
        "POST",
        "/api/recon/shopify/staff-sales/worklist/acknowledge",
        input,
      );
      return await res.json();
    },
    onSuccess: () => {
      toast({ title: "Row acknowledged" });
      qc.invalidateQueries({
        queryKey: ["/api/recon/shopify/staff-sales/order-worklist"],
      });
      setAckOpen(false);
      setAckTarget(null);
    },
    onError: (e: any) => {
      toast({
        title: "Acknowledge failed",
        description: String(e?.message || e),
        variant: "destructive",
      });
    },
  });

  const unackMut = useMutation({
    mutationFn: async (input: { order_name: string; group_key: string }) => {
      const params = new URLSearchParams(input);
      const res = await apiRequest(
        "DELETE",
        `/api/recon/shopify/staff-sales/worklist/acknowledge?${params.toString()}`,
      );
      return await res.json();
    },
    onSuccess: () => {
      toast({ title: "Acknowledgment removed" });
      qc.invalidateQueries({
        queryKey: ["/api/recon/shopify/staff-sales/order-worklist"],
      });
    },
    onError: (e: any) => {
      toast({
        title: "Unacknowledge failed",
        description: String(e?.message || e),
        variant: "destructive",
      });
    },
  });

  // ------- Filter rows by classification toggles -------
  const rows = worklistQ.data?.rows ?? [];
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (r.classification === "pre_ingest_refund" && !showPreIngest) return false;
      if (r.classification === "match" && !showMatches) return false;
      return true;
    });
  }, [rows, showPreIngest, showMatches]);

  const summary = worklistQ.data?.summary;

  // ------- Range presets -------
  function applyRange(days: number) {
    const w = lastNDays(days);
    setSince(w.since);
    setUntil(w.until);
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm mb-1">
            <Link
              href="/payroll/staff-sales"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="link-back-staff-sales"
            >
              <ChevronLeft className="size-3" />
              Back to Staff Sales
            </Link>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ClipboardList className="size-6 text-muted-foreground" />
            Reconciliation Worklist
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Per-(order, employee) discrepancies between Shopify's reported
            sales and our per-line staff attribution view. Acknowledge a row
            to hide it from this list while preserving the audit record.
          </p>
        </div>
      </div>

      {/* Controls */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">Since</Label>
            <Input
              type="date"
              value={since}
              min={FLOOR_DATE}
              onChange={(e) => {
                const v = e.target.value;
                setSince(v < FLOOR_DATE ? FLOOR_DATE : v);
              }}
              className="w-40"
              data-testid="input-since"
            />
          </div>
          <div>
            <Label className="text-xs">Until</Label>
            <Input
              type="date"
              value={until}
              min={FLOOR_DATE}
              onChange={(e) => setUntil(e.target.value)}
              className="w-40"
              data-testid="input-until"
            />
          </div>
          <div className="flex items-end gap-1">
            <Button variant="outline" size="sm" onClick={() => applyRange(7)} data-testid="button-range-7">7d</Button>
            <Button variant="outline" size="sm" onClick={() => applyRange(30)} data-testid="button-range-30">30d</Button>
            <Button variant="outline" size="sm" onClick={() => applyRange(90)} data-testid="button-range-90">90d</Button>
          </div>
          <div className="flex-1" />
          <div className="text-xs text-muted-foreground">
            Earliest selectable date: {FLOOR_DATE}
            <br />
            (staff attribution ingest start)
          </div>
        </div>

        {/* Visibility toggles */}
        <div className="flex flex-wrap items-center gap-4 mt-4 pt-4 border-t">
          <div className="text-xs text-muted-foreground">Show:</div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={showPreIngest}
              onCheckedChange={(v) => setShowPreIngest(Boolean(v))}
              data-testid="checkbox-show-pre-ingest"
            />
            Pre-ingest refunds
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={showMatches}
              onCheckedChange={(v) => setShowMatches(Boolean(v))}
              data-testid="checkbox-show-matches"
            />
            Matches
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={showAcknowledged}
              onCheckedChange={(v) => setShowAcknowledged(Boolean(v))}
              data-testid="checkbox-show-acknowledged"
            />
            Acknowledged
          </label>
        </div>
      </Card>

      {/* Summary chips */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard
            label="Unexplained"
            count={summary.unexplained.row_count}
            sub={`${summary.unexplained.order_count} order${summary.unexplained.order_count === 1 ? "" : "s"}, ${fmtMoney(summary.unexplained.total_abs_delta)}`}
            tone="red"
          />
          <SummaryCard
            label="Shopify refund bug"
            count={summary.shopify_refund_strip.row_count}
            sub={`${summary.shopify_refund_strip.order_count} order${summary.shopify_refund_strip.order_count === 1 ? "" : "s"}, ${fmtMoney(summary.shopify_refund_strip.total_abs_delta)}`}
            tone="yellow"
          />
          <SummaryCard
            label="Pre-ingest refund"
            count={summary.pre_ingest_refund.row_count}
            sub={`${summary.pre_ingest_refund.order_count} order${summary.pre_ingest_refund.order_count === 1 ? "" : "s"}, ${fmtMoney(summary.pre_ingest_refund.total_abs_delta)}`}
            tone="purple"
          />
          <SummaryCard
            label="Acknowledged"
            count={summary.acknowledged.row_count}
            sub="Hidden by default"
            tone="muted"
          />
        </div>
      )}

      {/* Table */}
      {worklistQ.isLoading && (
        <Card className="p-6 text-center text-muted-foreground">
          <Loader2 className="size-4 inline animate-spin mr-2" />
          Loading worklist...
        </Card>
      )}
      {worklistQ.isError && (
        <Card className="p-4 border-destructive">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-4" />
            <span>Failed to load worklist: {String((worklistQ.error as any)?.message ?? worklistQ.error)}</span>
          </div>
        </Card>
      )}
      {!worklistQ.isLoading && !worklistQ.isError && (
        <Card className="overflow-hidden">
          {filteredRows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              No worklist rows for the current filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[130px]">Classification</TableHead>
                  <TableHead className="w-[100px]">Order</TableHead>
                  <TableHead>Employee / Staff</TableHead>
                  <TableHead className="text-right">QL net</TableHead>
                  <TableHead className="text-right">Attributed net</TableHead>
                  <TableHead className="text-right">Delta</TableHead>
                  <TableHead className="w-[140px]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((r) => (
                  <TableRow
                    key={`${r.order_name}|${r.group_key}`}
                    className={r.acknowledged ? "opacity-60" : ""}
                    data-testid={`row-${r.order_name}-${r.group_key}`}
                  >
                    <TableCell>
                      <ClassificationBadge c={r.classification} />
                      {r.acknowledged && (
                        <Badge variant="outline" className="ml-1 text-xs" data-testid="badge-acknowledged">
                          Ack
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.order_name}</TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {r.staff_name ?? <span className="text-muted-foreground italic">unmatched</span>}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">{r.group_key}</div>
                      {r.acknowledged && r.acknowledgment_note && (
                        <div className="text-xs text-muted-foreground mt-1 italic">
                          “{r.acknowledgment_note}”
                          {r.acknowledged_by_email && (
                            <span className="ml-1 not-italic">— {r.acknowledged_by_email}</span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className={`text-right font-mono text-xs ${fmtMoneyClass(r.ql_net)}`}>
                      {fmtMoney(r.ql_net)}
                    </TableCell>
                    <TableCell className={`text-right font-mono text-xs ${fmtMoneyClass(r.att_net)}`}>
                      {fmtMoney(r.att_net)}
                    </TableCell>
                    <TableCell className={`text-right font-mono text-xs font-medium ${fmtMoneyClass(r.delta)}`}>
                      {fmtMoney(r.delta)}
                    </TableCell>
                    <TableCell>
                      {r.acknowledged ? (
                        canAck && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => unackMut.mutate({
                              order_name: r.order_name,
                              group_key: r.group_key,
                            })}
                            disabled={unackMut.isPending}
                            data-testid={`button-unack-${r.order_name}-${r.group_key}`}
                          >
                            <X className="size-3 mr-1" />
                            Unack
                          </Button>
                        )
                      ) : canAck ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => { setAckTarget(r); setAckOpen(true); }}
                          data-testid={`button-ack-${r.order_name}-${r.group_key}`}
                        >
                          <Check className="size-3 mr-1" />
                          Acknowledge
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      )}

      {/* Footer hint */}
      <div className="text-xs text-muted-foreground flex items-center gap-2">
        {showAcknowledged ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
        Showing {filteredRows.length} row{filteredRows.length === 1 ? "" : "s"} for {since} to {until}.
      </div>

      <AckDialog
        open={ackOpen}
        onOpenChange={setAckOpen}
        row={ackTarget}
        onConfirm={(note) => {
          if (!ackTarget) return;
          ackMut.mutate({
            order_name: ackTarget.order_name,
            group_key: ackTarget.group_key,
            note,
          });
        }}
        pending={ackMut.isPending}
      />
    </div>
  );
}

// ----- Summary card sub-component -------------------------------------------

function SummaryCard({
  label, count, sub, tone,
}: {
  label: string;
  count: number;
  sub: string;
  tone: "red" | "yellow" | "purple" | "muted";
}) {
  const toneClass =
    tone === "red"    ? "border-red-200 dark:border-red-900/50"
  : tone === "yellow" ? "border-yellow-200 dark:border-yellow-900/50"
  : tone === "purple" ? "border-purple-200 dark:border-purple-900/50"
  :                     "";
  return (
    <Card className={`p-3 ${toneClass}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1">{count}</div>
      <div className="text-xs text-muted-foreground mt-1">{sub}</div>
    </Card>
  );
}
