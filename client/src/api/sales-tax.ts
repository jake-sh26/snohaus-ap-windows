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
  /** PR #191: 0 = legacy aggregate row; 1, 2, 3 = per-entity rows. */
  entity_id: number;
  period_type: PeriodType;
  status: FilingStatus;
  filed_at: string | null;
  confirmation_number: string | null;
  filed_by_user_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Metadata for an attached PDF on a per-entity filing. */
export interface SalesTaxFilingAttachment {
  id: number;
  period_key: string;
  entity_id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string | null;
  uploaded_by_email: string | null;
  uploaded_at: string;
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
  // PR #168: marketplace-facilitator carve-out (Shopify already remits these).
  marketplace_sales_cents: number;
  marketplace_tax_cents: number;
}

export interface SalesTaxTotals {
  gross_sales_cents: number;
  taxable_sales_cents: number;
  tax_collected_cents: number;
  net_tax_cents: number;
  marketplace_sales_cents: number;
  marketplace_tax_cents: number;
}

/** PR #168: a taxable sale attributed to a warehouse location (non-blocking). */
export interface WarehouseAnomaly {
  location_id: string;
  name: string;
  taxable_cents: number;
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
  form_type: "ST-809" | "ST-810";
  stores: SalesTaxStoreRow[];
  totals: SalesTaxTotals;
  warehouse_anomalies: WarehouseAnomaly[];
  invariant: SalesTaxInvariant;
  /** Legacy aggregate filing row (entity_id = 0). Kept for backward compat. */
  filing: SalesTaxFiling;
  /** PR #191: per-entity filing rows, ordered by entity_id (1, 2, 3). */
  filings_by_entity: SalesTaxFiling[];
}

// ----- PR #168: ST-809 / ST-810 form payloads + entity settings -----

export interface St809Entity {
  entity_id: number;
  legal_name: string;
  tin: string | null;
  county: string;
  dtf_code: string;
  gross_sales: string;
  marketplace_sales: string;
  taxable_sales: string;
  non_taxable_sales: string;
  tax_due: string;
}

export interface St809Payload {
  period: string;
  formType: "ST-809";
  method: "long";
  entities: St809Entity[];
}

export interface St810Jurisdiction {
  jurisdiction_name: string;
  jurisdiction_type: string;
  rate: string;
  taxable_sales: string;
  tax_due: string;
  marketplace_taxable: string;
  marketplace_tax: string;
  dtf_code: string | null;
  rate_display: string;
}

export interface St810Entity {
  entity_id: number;
  entity_name: string;
  legal_name: string;
  tin: string | null;
  jurisdictions: St810Jurisdiction[];
  totals: { taxable_sales: string; tax_due: string };
}

export interface St810Payload {
  month?: string;
  quarter?: string;
  months_included?: string[];
  formType: "ST-810";
  entities: St810Entity[];
  unmapped_jurisdictions: string[];
}

export interface EntitySetting {
  entity_id: number;
  legal_name: string;
  /** PR #198 (ST5) — NULL for newly-created entities until ops fills it in. */
  county: string | null;
  /** PR #198 (ST5) — NULL for newly-created entities until ops fills it in. */
  dtf_code: string | null;
  tin: string | null;
}

export interface RecomputeResult {
  months_processed: number;
  entities_written: number;
  summary: Array<{ period: string; entity_id: number; tax_due: string; marketplace_sales: string }>;
}

/** ST-810 quarter rollup from GET /sales-tax/quarter/:quarterKey. */
export interface SalesTaxQuarter {
  quarter_key: string;
  months: string[];
  per_month: SalesTaxMonth[];
  quarter_totals: SalesTaxTotals;
  quarter_invariant: SalesTaxInvariant;
  /** Legacy aggregate quarter filing row (entity_id = 0). */
  filing: SalesTaxFiling;
  /** PR #191: per-entity quarter filing rows. */
  filings_by_entity: SalesTaxFiling[];
}

export interface UpsertFilingInput {
  /** PR #191: defaults to 0 (legacy aggregate) when omitted. */
  entity_id?: number;
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

/** PR #168 — ST-809 long-method monthly payload. `period` is YYYY-MM (non-quarter-end). */
export async function getSt809(period: string): Promise<St809Payload> {
  const res = await apiRequest("GET", `/api/recon/tax/st809/${encodeURIComponent(period)}`);
  return res.json();
}

/** PR #168 — ST-810 enriched payload. `period` is YYYY-MM or YYYY-QN. */
export async function getSt810(period: string): Promise<St810Payload> {
  const res = await apiRequest("GET", `/api/recon/tax/st810/${encodeURIComponent(period)}`);
  return res.json();
}

/** PR #168 — all 3 filing entities with legal name + current TIN. */
export async function getEntitySettings(): Promise<{ entities: EntitySetting[] }> {
  const res = await apiRequest("GET", `/api/recon/tax/entity-settings`);
  return res.json();
}

/** PR #168 — set/clear an entity's TIN. Empty string clears. */
export async function upsertEntityTin(
  entityId: number,
  tin: string,
): Promise<{ entity_id: number; tin: string | null; updated_at: string }> {
  const res = await apiRequest("PUT", `/api/recon/tax/entity-settings/${entityId}`, { tin });
  return res.json();
}

/** PR #168 — admin: rebuild the filing-totals cache from the aggregator. */
export async function recomputeAllFilings(): Promise<RecomputeResult> {
  const res = await apiRequest("POST", `/api/recon/tax/recompute-all`);
  return res.json();
}

/**
 * 5. Export URL for a period in the given format. Returns the relative path —
 * callers decide whether to fetch via apiRequest (Bearer header) or open as a
 * download.
 */
export function salesTaxExportPath(periodKey: string, format: ExportFormat): string {
  return `${BASE}/export/${encodeURIComponent(periodKey)}/${format}`;
}

const EXT: Record<ExportFormat, string> = { csv: "csv", pdf: "pdf", xlsx: "xlsx" };

/**
 * Download an export for a period as a file. Fetches through apiRequest so the
 * Bearer token is attached (export endpoints are permission-gated), reads the
 * body as a blob, and triggers a browser download. Prefers the server's
 * Content-Disposition filename, falling back to the documented convention.
 */
export async function downloadSalesTaxExport(
  periodKey: string,
  format: ExportFormat,
): Promise<void> {
  const res = await apiRequest("GET", salesTaxExportPath(periodKey, format));
  const blob = await res.blob();

  const cd = res.headers.get("Content-Disposition") || "";
  const match = /filename="?([^"]+)"?/.exec(cd);
  const filename = match?.[1] ?? `sales-tax_${periodKey}_all-entities.${EXT[format]}`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Period notes (append-only audit trail keyed by period_key).
// ---------------------------------------------------------------------------
export interface SalesTaxNote {
  id: number;
  period_key: string;
  user_email: string | null;
  text: string;
  created_at: string;
}

export async function listSalesTaxNotes(periodKey: string): Promise<SalesTaxNote[]> {
  const res = await apiRequest("GET", `${BASE}/notes/${encodeURIComponent(periodKey)}`);
  const data = await res.json();
  return (data?.notes ?? []) as SalesTaxNote[];
}

export async function createSalesTaxNote(periodKey: string, text: string): Promise<SalesTaxNote> {
  const res = await apiRequest(
    "POST",
    `${BASE}/notes/${encodeURIComponent(periodKey)}`,
    { text },
  );
  return (await res.json()) as SalesTaxNote;
}

// ---------------------------------------------------------------------------
// PR #191 — Per-entity filing attachments (PDF copies of filed returns).
// ---------------------------------------------------------------------------

/**
 * List attachments for a (period_key, entity_id) filing. Returns [] if none.
 */
export async function listFilingAttachments(
  periodKey: string,
  entityId: number,
): Promise<SalesTaxFilingAttachment[]> {
  const res = await apiRequest(
    "GET",
    `${BASE}/filings/${encodeURIComponent(periodKey)}/${entityId}/attachments`,
  );
  const data = await res.json();
  return (data?.attachments ?? []) as SalesTaxFilingAttachment[];
}

/**
 * Upload a PDF attachment for a (period_key, entity_id) filing. Backend
 * validates magic bytes (%PDF-) and enforces a 25MB cap.
 *
 * Uses a direct fetch (not apiRequest) because apiRequest always forces
 * Content-Type: application/json when a body is present, which would break
 * the multipart boundary the browser sets automatically for FormData.
 */
export async function uploadFilingAttachment(
  periodKey: string,
  entityId: number,
  file: File,
): Promise<SalesTaxFilingAttachment> {
  const fd = new FormData();
  fd.append("file", file);

  const token = (() => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem("snohaus_token") : null;
    } catch {
      return null;
    }
  })();

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // NOTE: do NOT set Content-Type — the browser must add the multipart boundary.

  const res = await fetch(
    `${BASE}/filings/${encodeURIComponent(periodKey)}/${entityId}/attachments`,
    { method: "POST", headers, body: fd },
  );
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
  const data = await res.json();
  return data?.attachment as SalesTaxFilingAttachment;
}

/**
 * Download an attachment by id, attaching the Bearer token (endpoint is
 * permission-gated). Mirrors downloadSalesTaxExport.
 */
export async function downloadFilingAttachment(
  id: number,
  fallbackFilename: string,
): Promise<void> {
  const res = await apiRequest("GET", `${BASE}/filings/attachment/${id}`);
  const blob = await res.blob();

  const cd = res.headers.get("Content-Disposition") || "";
  const match = /filename="?([^"]+)"?/.exec(cd);
  const filename = match?.[1] ?? fallbackFilename;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Delete an attachment by id. */
export async function deleteFilingAttachment(id: number): Promise<void> {
  await apiRequest("DELETE", `${BASE}/filings/attachment/${id}`);
}
