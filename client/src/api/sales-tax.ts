/**
 * Sales Tax — client API helper (PR #166).
 *
 * Typed wrappers for the 5 sales-tax endpoints shipped by the PR #165 backend.
 * Not consumed yet — the Sales Tax UI (PR #167) wires these into React Query.
 * Lives here now so #167 can import a stable, typed surface.
 *
 * All wrappers go through the shared `apiRequest` helper (Bearer-token auth,
 * 401 handling). Do NOT add a separate fetch path. All money fields are integer
 * cents to match the backend's integer-cents-end-to-end contract.
 */
import { apiRequest } from "@/lib/queryClient";

export type FilingStatus = "open" | "filed" | "amended";
export type PeriodType = "month" | "quarter";

/** A single sales-tax filing row (mirrors server SalesTaxFilingRow). */
export interface SalesTaxFiling {
  period_key: string;
  period_type: PeriodType;
  status: FilingStatus;
  filed_at: string | null;
  confirmation_number: string | null;
  filed_by_user_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Per-store sales-tax figures for a month (all money in integer cents). */
export interface SalesTaxStoreRow {
  store_id: string;
  name: string;
  entity_id: number;
  county: string;
  state: string;
  rate_bps: number;
  closed: boolean;
  unexpected_activity: boolean;
  gross_sales_cents: number;
  taxable_sales_cents: number;
  exempt_sales_cents: number;
  tax_collected_cents: number;
  refund_tax_in_period_cents: number;
  net_tax_cents: number;
}

export interface SalesTaxTotals {
  gross_sales_cents: number;
  taxable_sales_cents: number;
  tax_collected_cents: number;
  net_tax_cents: number;
}

export interface SalesTaxInvariant {
  ok: boolean;
  per_entity_sum_cents: number;
  view_total_cents: number;
  delta_cents: number;
}

/** Composite monthly payload from GET /sales-tax/:month. */
export interface SalesTaxMonth {
  month: string;
  filing_mode: PeriodType;
  quarter_key: string | null;
  stores: SalesTaxStoreRow[];
  totals: SalesTaxTotals;
  invariant: SalesTaxInvariant;
  filing: SalesTaxFiling;
}

/** ST-810 quarter rollup from GET /sales-tax/quarter/:quarterKey. */
export interface SalesTaxQuarter {
  quarter_key: string;
  months: string[];
  per_month: SalesTaxMonth[];
  quarter_totals: SalesTaxTotals;
  quarter_invariant: SalesTaxInvariant;
  filing: SalesTaxFiling;
}

export interface UpsertFilingInput {
  status?: FilingStatus;
  filed_at?: string | null;
  confirmation_number?: string | null;
  notes?: string | null;
}

export type ExportFormat = "csv" | "pdf" | "xlsx";

const BASE = "/api/recon/finance/sales-tax";

/** 1. Composite monthly payload. `month` is YYYY-MM. */
export async function getSalesTaxMonth(month: string): Promise<SalesTaxMonth> {
  const res = await apiRequest("GET", `${BASE}/${encodeURIComponent(month)}`);
  return res.json();
}

/** 2. ST-810 quarter rollup. `quarterKey` is YYYY-QN (e.g. "2026-Q2"). */
export async function getSalesTaxQuarter(quarterKey: string): Promise<SalesTaxQuarter> {
  const res = await apiRequest("GET", `${BASE}/quarter/${encodeURIComponent(quarterKey)}`);
  return res.json();
}

/** 3. Upsert filing state for a period. `periodKey` is YYYY-MM or YYYY-QN. */
export async function upsertSalesTaxFiling(
  periodKey: string,
  input: UpsertFilingInput,
): Promise<SalesTaxFiling> {
  const res = await apiRequest("POST", `${BASE}/filings/${encodeURIComponent(periodKey)}`, input);
  return res.json();
}

/** 4. List filing rows whose period_key falls in [from, to] (both optional). */
export async function listSalesTaxFilings(
  from?: string,
  to?: string,
): Promise<{ filings: SalesTaxFiling[] }> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  const res = await apiRequest("GET", `${BASE}/filings${qs ? `?${qs}` : ""}`);
  return res.json();
}

/**
 * 5. Export URL for a period in the given format. Returns the relative path —
 * callers (PR #167) decide whether to fetch via apiRequest (Bearer header) or
 * open as a download. The backend currently returns 501 until #167.
 */
export function salesTaxExportPath(periodKey: string, format: ExportFormat): string {
  return `${BASE}/export/${encodeURIComponent(periodKey)}/${format}`;
}
