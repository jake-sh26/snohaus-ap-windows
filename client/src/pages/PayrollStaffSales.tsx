import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  TrendingUp, ChevronRight, ChevronDown, AlertCircle, RefreshCw, Loader2,
  Search,
} from "lucide-react";

// ============================================================================
// Payroll > Staff Sales (PR #203)
//
// Running tally of Shopify staff sales over an arbitrary date window. Top
// level is one row per employee (with per-entity breakdown subarrays); click
// an employee to expand the entity breakdown; click an entity to drill into
// the per-order rows from recon_shopify_staff_sales.
//
// The underlying table is refreshed automatically every 6 hours by the
// shopify-recon orders sync cron (see server/index.ts) — but a manual "Sync
// now" button is also available so the user can force a refresh after a
// known change in Shopify.
//
// Money columns are signed. A pure-returns period legitimately shows
// negative net_sales / total_sales (e.g. Bob Ballin's -$564.80 the week of
// 6/15-6/21 in our test data).
// ============================================================================

// ----------------------------------------------------------------------------
// Date helpers — default window is the current Mon–Sun (Greenvale's commission
// pay period cadence). Computed in local time so a Sunday-evening view shows
// the week the user is currently in, not the next one.
// ----------------------------------------------------------------------------

function fmtISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function currentWeekMonToSun(): { since: string; until: string } {
  const now = new Date();
  // JS getDay(): 0=Sun, 1=Mon, ... 6=Sat. Treat Monday as start.
  const dow = now.getDay();
  const offsetFromMon = dow === 0 ? 6 : dow - 1;
  const mon = new Date(now);
  mon.setDate(now.getDate() - offsetFromMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { since: fmtISO(mon), until: fmtISO(sun) };
}

function lastNDays(n: number): { since: string; until: string } {
  const until = new Date();
  const since = new Date();
  since.setDate(until.getDate() - (n - 1));
  return { since: fmtISO(since), until: fmtISO(until) };
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

// ----------------------------------------------------------------------------
// API row shapes — match server/routes.ts /by-employee + /orders
// ----------------------------------------------------------------------------

type ByEntityRow = {
  employee_id: number | null;
  entity_id: number | null;
  entity_label: string;
  entity_location: string | null;
  gross_sales: number | null;
  returns_amt: number | null;
  net_sales: number | null;
  total_sales: number | null;
  order_count: number;
};

type EmployeeRow = {
  employee_id: number | null;
  full_name: string;
  shopify_staff_name: string | null;
  shopify_staff_ids: string | null;
  gross_sales: number | null;
  discounts: number | null;
  returns_amt: number | null;
  net_sales: number | null;
  taxes: number | null;
  total_sales: number | null;
  qty: number | null;
  order_count: number;
  by_entity: ByEntityRow[];
};

type Totals = {
  gross_sales: number | null;
  discounts: number | null;
  returns_amt: number | null;
  net_sales: number | null;
  taxes: number | null;
  total_sales: number | null;
  order_count: number;
  row_count: number;
};

type ByEmployeeResponse = {
  ok: boolean;
  since: string;
  until: string;
  totals: Totals;
  employees: EmployeeRow[];
};

type OrderRow = {
  id: number;
  period_start: string;
  period_end: string;
  order_name: string | null;
  order_id: string | null;
  assisting_staff_id: string;
  staff_name: string | null;
  gross_sales: number | null;
  discounts: number | null;
  returns_amt: number | null;
  net_sales: number | null;
  taxes: number | null;
  total_sales: number | null;
  qty_per_order: number | null;
  allocation_method: string;
  entity_share: number | null;
  entity_label: string | null;
  order_processed_at: string | null;
  order_source: string | null;
};

// ----------------------------------------------------------------------------
// Page
// ----------------------------------------------------------------------------

export default function PayrollStaffSales() {
  const { hasPermission } = useAuth();
  // PR #204 fix: use the canonical payroll.run_sync key from PERMISSION_CATALOG
  // (server/routes.ts and shared/schema.ts). `payroll.edit` was a typo that
  // hid the Sync button entirely on prod.
  const canIngest = hasPermission("payroll.run_sync");
  const { toast } = useToast();
  const qc = useQueryClient();

  // Default window: current Mon–Sun. Stored as ISO YYYY-MM-DD strings so the
  // input[type=date] controls bind cleanly.
  const defaultWindow = useMemo(currentWeekMonToSun, []);
  const [since, setSince] = useState<string>(defaultWindow.since);
  const [until, setUntil] = useState<string>(defaultWindow.until);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drillKey, setDrillKey] = useState<string | null>(null);

  const empKey = (e: EmployeeRow) =>
    e.employee_id === null ? "_null" : String(e.employee_id);
  const entKey = (employeeId: number | null, entityId: number | null) =>
    `${employeeId === null ? "_null" : employeeId}|${entityId === null ? -1 : entityId}`;

  function toggleEmployee(e: EmployeeRow) {
    const k = empKey(e);
    const next = new Set(expanded);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setExpanded(next);
  }

  // ------- Queries -------
  const summaryQ = useQuery<ByEmployeeResponse>({
    queryKey: ["/api/recon/shopify/staff-sales/by-employee", since, until],
    queryFn: async () => {
      const url = `/api/recon/shopify/staff-sales/by-employee?since=${since}&until=${until}`;
      const res = await apiRequest("GET", url);
      return (await res.json()) as ByEmployeeResponse;
    },
  });

  const drillQ = useQuery<{ ok: boolean; count: number; rows: OrderRow[] }>({
    queryKey: ["/api/recon/shopify/staff-sales/orders", since, until, drillKey],
    enabled: drillKey !== null,
    queryFn: async () => {
      const [emp, ent] = (drillKey || "").split("|");
      const params = new URLSearchParams({ since, until });
      if (emp) params.set("employee_id", emp);
      if (ent) params.set("entity_id", ent);
      const res = await apiRequest(
        "GET",
        `/api/recon/shopify/staff-sales/orders?${params.toString()}`,
      );
      return await res.json();
    },
  });

  // ------- Mutations -------
  const ingestMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/recon/shopify/staff-sales/ingest", {
        since,
        until,
      });
      return await res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Sync complete",
        description: `${data.emitted_rows ?? 0} rows upserted (${data.shopifyql_rows ?? 0} from Shopify, ${data.unresolved_staff ?? 0} unresolved staff).`,
      });
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/staff-sales"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/staff-sales/by-employee"] });
      qc.invalidateQueries({ queryKey: ["/api/recon/shopify/staff-sales/orders"] });
    },
    onError: (e: any) => {
      toast({
        title: "Sync failed",
        description: String(e?.message || e),
        variant: "destructive",
      });
    },
  });

  // ------- Filter -------
  const employees = summaryQ.data?.employees || [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => {
      const hay = [
        e.full_name,
        e.shopify_staff_name || "",
        e.shopify_staff_ids || "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [employees, search]);

  const totals = summaryQ.data?.totals;

  // ------- Quick range presets -------
  function applyRange(label: "thisWeek" | "last7" | "last30" | "last90") {
    setExpanded(new Set());
    setDrillKey(null);
    if (label === "thisWeek") {
      const w = currentWeekMonToSun();
      setSince(w.since);
      setUntil(w.until);
    } else if (label === "last7") {
      const w = lastNDays(7);
      setSince(w.since);
      setUntil(w.until);
    } else if (label === "last30") {
      const w = lastNDays(30);
      setSince(w.since);
      setUntil(w.until);
    } else if (label === "last90") {
      const w = lastNDays(90);
      setSince(w.since);
      setUntil(w.until);
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <TrendingUp className="size-6 text-muted-foreground" />
            Staff Sales
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Running tally of Shopify sales by assisting staff member, sliced by
            entity. Auto-refreshes every 6 hours; click <em>Sync now</em> to force
            a refresh of the visible window.
          </p>
        </div>
        {canIngest && (
          <Button
            onClick={() => ingestMut.mutate()}
            disabled={ingestMut.isPending}
            data-testid="button-sync-staff-sales"
          >
            {ingestMut.isPending ? (
              <Loader2 className="size-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="size-4 mr-2" />
            )}
            Sync now
          </Button>
        )}
      </div>

      {/* Controls */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">Since</Label>
            <Input
              type="date"
              value={since}
              onChange={(e) => {
                setExpanded(new Set());
                setDrillKey(null);
                setSince(e.target.value);
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
              onChange={(e) => {
                setExpanded(new Set());
                setDrillKey(null);
                setUntil(e.target.value);
              }}
              className="w-40"
              data-testid="input-until"
            />
          </div>
          <div>
            <Label className="text-xs">Preset</Label>
            <Select
              value=""
              onValueChange={(v) =>
                applyRange(v as "thisWeek" | "last7" | "last30" | "last90")
              }
            >
              <SelectTrigger className="w-40" data-testid="select-preset">
                <SelectValue placeholder="Quick range…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="thisWeek">This week (Mon–Sun)</SelectItem>
                <SelectItem value="last7">Last 7 days</SelectItem>
                <SelectItem value="last30">Last 30 days</SelectItem>
                <SelectItem value="last90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-[220px]">
            <Label className="text-xs">Search employee / staff ID</Label>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name or Shopify staff ID…"
                className="pl-8"
                data-testid="input-search"
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Totals row */}
      {summaryQ.isLoading ? (
        <Card className="p-6 text-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin inline mr-2" /> Loading…
        </Card>
      ) : summaryQ.isError ? (
        <Card className="p-4 border-destructive">
          <div className="flex items-center gap-2 text-destructive text-sm">
            <AlertCircle className="size-4" />
            Failed to load: {String((summaryQ.error as any)?.message || "unknown error")}
          </div>
        </Card>
      ) : (
        <>
          {totals && (
            <Card className="p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4 text-sm">
                <Stat label="Gross sales" value={fmtMoney(totals.gross_sales)} />
                <Stat label="Discounts" value={fmtMoney(totals.discounts)} />
                <Stat
                  label="Returns"
                  value={fmtMoney(totals.returns_amt)}
                  className={fmtMoneyClass(totals.returns_amt)}
                />
                <Stat
                  label="Net sales"
                  value={fmtMoney(totals.net_sales)}
                  className={fmtMoneyClass(totals.net_sales)}
                />
                <Stat label="Taxes" value={fmtMoney(totals.taxes)} />
                <Stat
                  label="Total sales"
                  value={fmtMoney(totals.total_sales)}
                  className={fmtMoneyClass(totals.total_sales)}
                />
                <Stat
                  label="Orders"
                  value={String(totals.order_count ?? 0)}
                />
              </div>
            </Card>
          )}

          {/* Employee table */}
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 w-8" />
                  <th className="text-left px-3 py-2">Employee</th>
                  <th className="text-right px-3 py-2">Gross</th>
                  <th className="text-right px-3 py-2">Returns</th>
                  <th className="text-right px-3 py-2">Net sales</th>
                  <th className="text-right px-3 py-2">Total sales</th>
                  <th className="text-right px-3 py-2">Orders</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      No staff sales in this window.
                    </td>
                  </tr>
                )}
                {filtered.map((emp) => {
                  const k = empKey(emp);
                  const isOpen = expanded.has(k);
                  const unmatched = emp.employee_id === null;
                  return (
                    <EmployeeRowView
                      key={k}
                      emp={emp}
                      isOpen={isOpen}
                      unmatched={unmatched}
                      onToggle={() => toggleEmployee(emp)}
                      drillKey={drillKey}
                      setDrillKey={setDrillKey}
                      drillQ={drillQ}
                      entKey={entKey}
                    />
                  );
                })}
              </tbody>
            </table>
          </Card>

          <div className="text-xs text-muted-foreground">
            Window: {summaryQ.data?.since} → {summaryQ.data?.until} ·{" "}
            {totals?.row_count ?? 0} underlying rows · negative values are
            returns/exchanges (shown in red).
          </div>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Components
// ----------------------------------------------------------------------------

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`text-base font-semibold tabular-nums ${className || ""}`}>
        {value}
      </div>
    </div>
  );
}

function EmployeeRowView({
  emp,
  isOpen,
  unmatched,
  onToggle,
  drillKey,
  setDrillKey,
  drillQ,
  entKey,
}: {
  emp: EmployeeRow;
  isOpen: boolean;
  unmatched: boolean;
  onToggle: () => void;
  drillKey: string | null;
  setDrillKey: (k: string | null) => void;
  drillQ: ReturnType<typeof useQuery<{ ok: boolean; count: number; rows: OrderRow[] }>>;
  entKey: (employeeId: number | null, entityId: number | null) => string;
}) {
  return (
    <>
      <tr
        className="border-t hover:bg-muted/30 cursor-pointer"
        onClick={onToggle}
        data-testid={`row-employee-${emp.employee_id ?? "null"}`}
      >
        <td className="px-3 py-2 align-top">
          {isOpen ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </td>
        <td className="px-3 py-2">
          <div className="font-medium flex items-center gap-2">
            {emp.full_name}
            {unmatched && (
              <Badge variant="destructive" className="gap-1 text-[10px]">
                <AlertCircle className="size-3" />
                unmatched
              </Badge>
            )}
          </div>
          {emp.shopify_staff_ids && (
            <div className="text-[11px] text-muted-foreground mt-0.5">
              Shopify staff ID: {emp.shopify_staff_ids}
            </div>
          )}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(emp.gross_sales)}</td>
        <td className={`px-3 py-2 text-right tabular-nums ${fmtMoneyClass(emp.returns_amt)}`}>
          {fmtMoney(emp.returns_amt)}
        </td>
        <td className={`px-3 py-2 text-right tabular-nums ${fmtMoneyClass(emp.net_sales)}`}>
          {fmtMoney(emp.net_sales)}
        </td>
        <td className={`px-3 py-2 text-right tabular-nums font-medium ${fmtMoneyClass(emp.total_sales)}`}>
          {fmtMoney(emp.total_sales)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{emp.order_count}</td>
      </tr>
      {isOpen && (
        <tr className="bg-muted/20">
          <td colSpan={7} className="p-0">
            <div className="px-6 py-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Entity breakdown
              </div>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1 w-8" />
                    <th className="text-left px-2 py-1">Entity</th>
                    <th className="text-right px-2 py-1">Gross</th>
                    <th className="text-right px-2 py-1">Returns</th>
                    <th className="text-right px-2 py-1">Net sales</th>
                    <th className="text-right px-2 py-1">Total sales</th>
                    <th className="text-right px-2 py-1">Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {emp.by_entity.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-2 py-2 text-muted-foreground">
                        No entity rows.
                      </td>
                    </tr>
                  )}
                  {emp.by_entity.map((ent) => {
                    const dk = entKey(emp.employee_id, ent.entity_id);
                    const isDrill = drillKey === dk;
                    return (
                      <EntityRowView
                        key={dk}
                        ent={ent}
                        isDrill={isDrill}
                        onToggleDrill={() => setDrillKey(isDrill ? null : dk)}
                        drillRows={isDrill ? drillQ.data?.rows ?? [] : []}
                        drillLoading={isDrill && drillQ.isLoading}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function EntityRowView({
  ent,
  isDrill,
  onToggleDrill,
  drillRows,
  drillLoading,
}: {
  ent: ByEntityRow;
  isDrill: boolean;
  onToggleDrill: () => void;
  drillRows: OrderRow[];
  drillLoading: boolean;
}) {
  const unalloc = ent.entity_id === null;
  return (
    <>
      <tr
        className="border-t border-muted-foreground/10 hover:bg-muted/30 cursor-pointer"
        onClick={onToggleDrill}
        data-testid={`row-entity-${ent.employee_id ?? "null"}-${ent.entity_id ?? "null"}`}
      >
        <td className="px-2 py-1 align-top">
          {isDrill ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </td>
        <td className="px-2 py-1">
          <span className="font-medium">{ent.entity_label}</span>
          {unalloc && (
            <Badge variant="outline" className="ml-2 text-[10px]">
              unallocated
            </Badge>
          )}
        </td>
        <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(ent.gross_sales)}</td>
        <td className={`px-2 py-1 text-right tabular-nums ${fmtMoneyClass(ent.returns_amt)}`}>
          {fmtMoney(ent.returns_amt)}
        </td>
        <td className={`px-2 py-1 text-right tabular-nums ${fmtMoneyClass(ent.net_sales)}`}>
          {fmtMoney(ent.net_sales)}
        </td>
        <td className={`px-2 py-1 text-right tabular-nums ${fmtMoneyClass(ent.total_sales)}`}>
          {fmtMoney(ent.total_sales)}
        </td>
        <td className="px-2 py-1 text-right tabular-nums">{ent.order_count}</td>
      </tr>
      {isDrill && (
        <tr className="bg-background">
          <td colSpan={7} className="p-0">
            <div className="px-4 py-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Orders ({drillRows.length})
              </div>
              {drillLoading ? (
                <div className="text-xs text-muted-foreground p-3">
                  <Loader2 className="size-3 animate-spin inline mr-1" />
                  Loading orders…
                </div>
              ) : drillRows.length === 0 ? (
                <div className="text-xs text-muted-foreground p-3">
                  No orders match this employee × entity combination.
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left px-2 py-1">Order</th>
                      <th className="text-left px-2 py-1">Method</th>
                      <th className="text-right px-2 py-1">Share</th>
                      <th className="text-right px-2 py-1">Gross</th>
                      <th className="text-right px-2 py-1">Returns</th>
                      <th className="text-right px-2 py-1">Net</th>
                      <th className="text-right px-2 py-1">Total</th>
                      <th className="text-right px-2 py-1">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillRows.map((r) => (
                      <tr key={r.id} className="border-t border-muted-foreground/10">
                        <td className="px-2 py-1 font-mono">{r.order_name || "—"}</td>
                        <td className="px-2 py-1">
                          <Badge variant="outline" className="text-[10px]">
                            {r.allocation_method}
                          </Badge>
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {r.entity_share === null || r.entity_share === undefined
                            ? "—"
                            : (Number(r.entity_share) * 100).toFixed(1) + "%"}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(r.gross_sales)}</td>
                        <td className={`px-2 py-1 text-right tabular-nums ${fmtMoneyClass(r.returns_amt)}`}>
                          {fmtMoney(r.returns_amt)}
                        </td>
                        <td className={`px-2 py-1 text-right tabular-nums ${fmtMoneyClass(r.net_sales)}`}>
                          {fmtMoney(r.net_sales)}
                        </td>
                        <td className={`px-2 py-1 text-right tabular-nums ${fmtMoneyClass(r.total_sales)}`}>
                          {fmtMoney(r.total_sales)}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {r.qty_per_order ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
