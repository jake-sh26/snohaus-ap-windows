/**
 * Sales Tax — form-aware export builders (PR #167, reworked PR #168).
 *
 * Pure builder functions for the three sales-tax export formats. They take
 * already-computed sales-tax data plus the per-entity (and, for ST-810,
 * per-jurisdiction) filing rows the route assembles from the single-source-of-
 * truth aggregator, and return a string (CSV) or Buffer (XLSX/PDF). No DB access
 * here — the route layer does the compute + entity_settings/DTF enrichment and
 * passes everything in.
 *
 * Form differentiation (PR #168): NY files ST-809 for the 8 non-quarter-end
 * months (long method, per-entity only) and ST-810 for the 4 quarter-end months
 * (per-entity + per-jurisdiction with DTF codes + fractional rates). `formType`
 * on the payload drives which layout each builder emits.
 *
 * Money: every figure arrives as integer cents and is formatted to 2 decimals
 * exactly once, at render time (centsToFixed). No intermediate float math.
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { formatRateAsFraction } from "@shared/format-rate";

// ---- Shapes mirrored from the routes.ts compute (kept in sync by hand) ----

export interface ExportStoreRow {
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
  marketplace_sales_cents: number;
  marketplace_tax_cents: number;
}

export interface ExportTotals {
  gross_sales_cents: number;
  taxable_sales_cents: number;
  tax_collected_cents: number;
  net_tax_cents: number;
  marketplace_sales_cents: number;
  marketplace_tax_cents: number;
}

export interface ExportInvariant {
  ok: boolean;
  per_entity_sum_cents: number;
  view_total_cents: number;
  delta_cents: number;
}

export interface ExportMonth {
  month: string;
  filing_mode: "month" | "quarter";
  quarter_key: string | null;
  stores: ExportStoreRow[];
  totals: ExportTotals;
  invariant: ExportInvariant;
}

/** One taxable line for the XLSX Line Detail sheet. */
export interface ExportLineDetail {
  order_name: string;
  order_date_eastern: string;
  store_name: string;
  county: string;
  rate_bps: number;
  taxable_amount_cents: number;
  tax_amount_cents: number;
  refund_flag: boolean;
}

/**
 * Per-entity filing row (the ST-809/ST-810 entity summary). Money is integer
 * cents. `tin` is null when unset → renderers show a blank underline. Spans the
 * whole period (quarter-rolled-up for ST-810).
 */
export interface ExportEntityRow {
  entity_id: number;
  legal_name: string;
  tin: string | null;
  county: string;
  dtf_code: string;
  gross_sales_cents: number;
  marketplace_sales_cents: number;
  taxable_sales_cents: number;
  tax_due_cents: number;
  /** R6b: marketplace tax Shopify already remitted (not your liability). */
  marketplace_tax_cents: number;
}

/**
 * Per-jurisdiction filing row (ST-810 only). One per (entity, jurisdiction).
 * `rate` is the decimal rate; `rate_display` the NY fraction ("8 5/8%").
 */
export interface ExportJurisdictionRow {
  entity_id: number;
  entity_legal_name: string;
  jurisdiction_name: string;
  dtf_code: string | null;
  rate: number;
  rate_display: string;
  taxable_sales_cents: number;
  tax_due_cents: number;
  /** R6b: marketplace-facilitated taxable/tax for this jurisdiction (info-only). */
  marketplace_taxable_cents: number;
  marketplace_tax_cents: number;
}

/**
 * R6b — NY locality rollup row (ST-810 only). One row per (entity, NY locality).
 *
 * NY DTF files ST-810 by COMBINED locality rate (Nassau 8 5/8%, Suffolk 8 3/4%,
 * NYC 8 7/8%) — not by component (state + county + MCTD broken out). This row
 * combines the components into a single locality total so the operator can fill
 * out the form one line per locality, matching DTF's mental model.
 *
 * Derivation: for each entity, take the COUNTY-type jurisdiction row's
 * taxable_sales as the locality's taxable base (one row per county in the
 * per-jurisdiction breakdown). Combined tax = taxable × DTF combined rate.
 * Component sum (state + county + MCTD) is also surfaced as `tax_components_cents`
 * so the operator can audit-tie the derived combined tax against the actual
 * components from the source-of-truth aggregator.
 */
export interface ExportLocalityRow {
  entity_id: number;
  entity_legal_name: string;
  locality_name: string;          // e.g. "Nassau", "Suffolk", "New York City"
  dtf_code: string;               // e.g. "NA 2811"
  combined_rate: number;          // decimal, e.g. 0.08625
  rate_display: string;           // NY fraction, e.g. "8 5/8%"
  taxable_sales_cents: number;    // taxable base for this locality
  /** Combined tax = taxable × combined_rate (the value to file on ST-810). */
  tax_due_cents: number;
  /** Audit-only: sum of state + county + MCTD components from the aggregator. */
  tax_components_cents: number;
  /** tax_due − tax_components; non-zero means component-vs-rate drift. */
  audit_delta_cents: number;
  /** R6b: marketplace-facilitated taxable/tax under this locality (info-only). */
  marketplace_taxable_cents: number;
  marketplace_tax_cents: number;
}

/**
 * R6b — Marketplace Provider Sales row (info-only, not filed by merchant).
 *
 * Out-of-state and NY-marketplace lines where Shopify (or another facilitator)
 * collected and remitted the tax directly. Shown for audit / reconciliation
 * against the Shopify Tax Liability report. NOT included in ST-810 totals.
 */
export interface ExportMarketplaceProviderRow {
  entity_id: number;
  entity_legal_name: string;
  jurisdiction_name: string;
  jurisdiction_type: string;
  rate: number;
  rate_display: string;
  marketplace_taxable_cents: number;
  marketplace_tax_cents: number;
}

/**
 * The unit of work for an export: a single period that is either one month
 * (ST-809) or a quarter (ST-810, three months rolled up). `months` always lists
 * the constituent month payloads; `periodKey`/`formType` drive titles +
 * filenames. `entities`/`jurisdictions` carry the form-faithful filing rows.
 */
export interface ExportPayload {
  periodKey: string;
  isQuarter: boolean;
  formType: "ST-809" | "ST-810";
  months: ExportMonth[];
  totals: ExportTotals;
  invariant: ExportInvariant;
  lineDetail: ExportLineDetail[];
  /** Per-entity filing rows (always present; all 3 entities). */
  entities: ExportEntityRow[];
  /** Per-jurisdiction rows (ST-810 only; empty for ST-809). Audit/component-level. */
  jurisdictions: ExportJurisdictionRow[];
  /** R6b: NY locality rollup rows (ST-810 only). The primary filing view. */
  localities: ExportLocalityRow[];
  /** R6b: marketplace-remitted sales (info-only, not filed). */
  marketplaceProviders: ExportMarketplaceProviderRow[];
  /** Any jurisdiction name lacking a DTF code (ST-810 warning). */
  unmappedJurisdictions: string[];
  /**
   * PR #198 (ST5) — entities skipped from this export because they're missing
   * jurisdiction config (county / rate_bps / dtf_code) required by ST-810.
   * Always [] for ST-809. The Sales Tax UI surfaces this as a banner so the
   * operator can fix the entity before re-running the export.
   */
  excludedEntities?: Array<{ entity_id: number; legal_name: string; missing: string[] }>;
  generatedAtET: string;
}

// ---- Formatting helpers --------------------------------------------------

/** Integer cents -> "12345.67" (no thousands separators; CSV/raw friendly). */
export function centsToFixed(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${dollars}.${rem}`;
}

/** Integer cents -> "$12,345.67" for display in PDF/XLSX. */
export function centsToDisplay(cents: number): string {
  const fixed = centsToFixed(Math.abs(cents));
  const [intPart, decPart] = fixed.split(".");
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${withSep}.${decPart}`;
}

/** Rate units (8.625% = 8625) -> "8.625%". */
export function bpsToPct(bps: number): string {
  return `${(bps / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/** Decimal rate (0.08625) -> NY fraction ("8 5/8%"). */
export function rateFraction(rate: number): string {
  return formatRateAsFraction(rate);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-05" -> "May 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

/** Human-readable list of the months a quarter covers, e.g. "Mar / Apr / May 2026". */
export function quarterCoverageLabel(months: ExportMonth[]): string {
  if (months.length === 0) return "";
  const shortNames = months.map((mm) => MONTH_NAMES[Number(mm.month.split("-")[1]) - 1].slice(0, 3));
  const year = months[months.length - 1].month.split("-")[0];
  return `${shortNames.join(" / ")} ${year}`;
}

/** Slug a legal name for filenames: "SD Ski and Patio Inc" -> "SD-Ski-and-Patio-Inc". */
export function slugLegalName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const TIN_BLANK = "___________";

// ---- CSV -----------------------------------------------------------------

function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

function csvRow(fields: (string | number)[]): string {
  return fields.map((f) => csvEscape(String(f))).join(",");
}

/**
 * Form-aware CSV. ST-809 = one row per entity. ST-810 = entity summary rows
 * then clearly-labeled jurisdiction-detail rows. CSV keeps the raw DECIMAL rate.
 */
export function buildSalesTaxCsv(payload: ExportPayload): string {
  const lines: string[] = [];
  lines.push(csvRow([`form_type`, payload.formType]));
  lines.push(csvRow([`period`, payload.periodKey]));
  lines.push("");

  // ===== Entity summary section =====
  // R6b: marketplace_tax column added — the tax Shopify already remitted on
  // marketplace-facilitated lines. Excluded from tax_due (merchant liability).
  lines.push(csvRow([
    "section", "entity_id", "legal_name", "tin", "county", "dtf_code",
    "gross_sales", "marketplace_sales", "marketplace_tax", "taxable_sales", "tax_due",
  ]));
  for (const e of payload.entities) {
    lines.push(csvRow([
      "ENTITY",
      e.entity_id,
      e.legal_name,
      e.tin ?? "",
      e.county,
      e.dtf_code,
      centsToFixed(e.gross_sales_cents),
      centsToFixed(e.marketplace_sales_cents),
      centsToFixed(e.marketplace_tax_cents),
      centsToFixed(e.taxable_sales_cents),
      centsToFixed(e.tax_due_cents),
    ]));
  }

  // ===== R6b: NY Locality Rollup (PRIMARY filing view, ST-810 only) =====
  // One row per (entity, locality). Combined rate (state + county + MCTD merged).
  // tax_due here is the value to enter on each ST-810 jurisdiction line.
  if (payload.formType === "ST-810" && payload.localities.length > 0) {
    lines.push("");
    lines.push(csvRow([
      "section", "entity_id", "entity_legal_name", "locality", "dtf_code",
      "combined_rate", "rate_display", "taxable_sales", "tax_due",
      "tax_components_sum", "audit_delta",
      "marketplace_taxable", "marketplace_tax",
    ]));
    for (const l of payload.localities) {
      lines.push(csvRow([
        "LOCALITY",
        l.entity_id,
        l.entity_legal_name,
        l.locality_name,
        l.dtf_code,
        l.combined_rate.toFixed(5),
        l.rate_display,
        centsToFixed(l.taxable_sales_cents),
        centsToFixed(l.tax_due_cents),
        centsToFixed(l.tax_components_cents),
        centsToFixed(l.audit_delta_cents),
        centsToFixed(l.marketplace_taxable_cents),
        centsToFixed(l.marketplace_tax_cents),
      ]));
    }
  }

  // ===== Jurisdiction component detail (ST-810; audit trail) =====
  // Original per-component breakdown. State + county + MCTD broken out. R6b adds
  // marketplace_taxable + marketplace_tax for parity with the locality view.
  if (payload.formType === "ST-810" && payload.jurisdictions.length > 0) {
    lines.push("");
    lines.push(csvRow([
      "section", "entity_id", "entity_legal_name", "jurisdiction", "dtf_code",
      "rate_decimal", "taxable_sales", "tax_due",
      "marketplace_taxable", "marketplace_tax",
    ]));
    for (const j of payload.jurisdictions) {
      lines.push(csvRow([
        "JURISDICTION",
        j.entity_id,
        j.entity_legal_name,
        j.jurisdiction_name,
        j.dtf_code ?? "",
        j.rate.toFixed(5),
        centsToFixed(j.taxable_sales_cents),
        centsToFixed(j.tax_due_cents),
        centsToFixed(j.marketplace_taxable_cents),
        centsToFixed(j.marketplace_tax_cents),
      ]));
    }
  }

  // ===== R6b: Marketplace Provider Sales (info-only, not filed) =====
  // Out-of-state lines where Shopify (or another facilitator) collected and
  // remitted the tax. Audit trail for reconciling against Shopify's report.
  if (payload.formType === "ST-810" && payload.marketplaceProviders.length > 0) {
    lines.push("");
    lines.push(csvRow([
      "section", "entity_id", "entity_legal_name", "jurisdiction", "jurisdiction_type",
      "rate_decimal", "rate_display", "marketplace_taxable", "marketplace_tax",
    ]));
    for (const m of payload.marketplaceProviders) {
      lines.push(csvRow([
        "MARKETPLACE_PROVIDER",
        m.entity_id,
        m.entity_legal_name,
        m.jurisdiction_name,
        m.jurisdiction_type,
        m.rate.toFixed(5),
        m.rate_display,
        centsToFixed(m.marketplace_taxable_cents),
        centsToFixed(m.marketplace_tax_cents),
      ]));
    }
  }

  if (payload.unmappedJurisdictions.length > 0) {
    lines.push("");
    lines.push(csvRow(["unmapped_jurisdictions", payload.unmappedJurisdictions.join("; ")]));
  }

  return lines.join("\r\n") + "\r\n";
}

// ---- XLSX ----------------------------------------------------------------

const MONEY_FMT = '$#,##0.00';

/**
 * Form-aware workbook. ST-809 = Entity Summary + Reconciliation. ST-810 =
 * Entity Summary + Jurisdiction Detail + Line Detail + Reconciliation.
 */
export async function buildSalesTaxXlsx(payload: ExportPayload): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sno-Haus AP";
  wb.created = new Date();

  // ----- Sheet: Filing Summary (entity totals) -----
  // R6b: tab renamed from "Entity Summary" → "Filing Summary" + marketplace_tax col.
  const summary = wb.addWorksheet("Filing Summary");
  summary.columns = [
    { header: "Entity", key: "entity_id", width: 8 },
    { header: "Legal Name", key: "legal_name", width: 24 },
    { header: "TIN", key: "tin", width: 14 },
    { header: "County", key: "county", width: 12 },
    { header: "DTF Code", key: "dtf_code", width: 12 },
    { header: "Gross Sales", key: "gross_sales", width: 14 },
    { header: "Marketplace Sales", key: "marketplace_sales", width: 16 },
    { header: "Marketplace Tax", key: "marketplace_tax", width: 14 },
    { header: "Taxable Sales", key: "taxable_sales", width: 14 },
    { header: "Tax Due", key: "tax_due", width: 14 },
  ];
  const entityMoneyCols = ["gross_sales", "marketplace_sales", "marketplace_tax", "taxable_sales", "tax_due"];
  for (const e of payload.entities) {
    summary.addRow({
      entity_id: e.entity_id,
      legal_name: e.legal_name,
      tin: e.tin ?? "TIN not set",
      county: e.county,
      dtf_code: e.dtf_code,
      gross_sales: e.gross_sales_cents / 100,
      marketplace_sales: e.marketplace_sales_cents / 100,
      marketplace_tax: e.marketplace_tax_cents / 100,
      taxable_sales: e.taxable_sales_cents / 100,
      tax_due: e.tax_due_cents / 100,
    });
  }
  const et = payload.totals;
  summary.addRow({
    entity_id: "TOTAL",
    gross_sales: et.gross_sales_cents / 100,
    marketplace_sales: et.marketplace_sales_cents / 100,
    marketplace_tax: et.marketplace_tax_cents / 100,
    taxable_sales: et.taxable_sales_cents / 100,
    tax_due: et.net_tax_cents / 100,
  });
  summary.getRow(1).font = { bold: true };
  summary.lastRow!.font = { bold: true };
  for (const key of entityMoneyCols) {
    const col = summary.getColumn(key);
    col.numFmt = MONEY_FMT;
    col.alignment = { horizontal: "right" };
  }

  // ----- R6b: Sheet: NY Locality Rollup (ST-810 only) -----
  // PRIMARY filing view. One row per (entity, locality) with combined NY rate.
  // The Tax Due column is what to enter on each ST-810 jurisdiction line.
  if (payload.formType === "ST-810") {
    const loc = wb.addWorksheet("NY Locality Rollup");
    loc.columns = [
      { header: "Entity", key: "entity_id", width: 8 },
      { header: "Legal Name", key: "legal_name", width: 24 },
      { header: "Locality", key: "locality_name", width: 18 },
      { header: "DTF Code", key: "dtf_code", width: 10 },
      { header: "Rate", key: "rate_display", width: 9 },
      { header: "Taxable Sales", key: "taxable_sales", width: 14 },
      { header: "Tax Due", key: "tax_due", width: 14 },
      { header: "Components Sum", key: "components", width: 16 },
      { header: "Audit Delta", key: "audit_delta", width: 12 },
      { header: "Marketplace Taxable", key: "mkt_taxable", width: 18 },
      { header: "Marketplace Tax", key: "mkt_tax", width: 16 },
    ];
    for (const l of payload.localities) {
      loc.addRow({
        entity_id: l.entity_id,
        legal_name: l.entity_legal_name,
        locality_name: l.locality_name,
        dtf_code: l.dtf_code,
        rate_display: l.rate_display,
        taxable_sales: l.taxable_sales_cents / 100,
        tax_due: l.tax_due_cents / 100,
        components: l.tax_components_cents / 100,
        audit_delta: l.audit_delta_cents / 100,
        mkt_taxable: l.marketplace_taxable_cents / 100,
        mkt_tax: l.marketplace_tax_cents / 100,
      });
    }
    loc.getRow(1).font = { bold: true };
    for (const key of ["taxable_sales", "tax_due", "components", "audit_delta", "mkt_taxable", "mkt_tax"]) {
      const col = loc.getColumn(key);
      col.numFmt = MONEY_FMT;
      col.alignment = { horizontal: "right" };
    }

    // ----- R6b: Sheet: Marketplace Providers (info-only) -----
    // Out-of-state marketplace-facilitator sales. NOT filed by merchant.
    if (payload.marketplaceProviders.length > 0) {
      const mp = wb.addWorksheet("Marketplace Providers");
      mp.columns = [
        { header: "Entity", key: "entity_id", width: 8 },
        { header: "Legal Name", key: "legal_name", width: 24 },
        { header: "Jurisdiction", key: "jurisdiction", width: 28 },
        { header: "Type", key: "type", width: 10 },
        { header: "Rate", key: "rate_display", width: 9 },
        { header: "Marketplace Taxable", key: "mkt_taxable", width: 18 },
        { header: "Marketplace Tax", key: "mkt_tax", width: 16 },
      ];
      for (const m of payload.marketplaceProviders) {
        mp.addRow({
          entity_id: m.entity_id,
          legal_name: m.entity_legal_name,
          jurisdiction: m.jurisdiction_name,
          type: m.jurisdiction_type,
          rate_display: m.rate_display,
          mkt_taxable: m.marketplace_taxable_cents / 100,
          mkt_tax: m.marketplace_tax_cents / 100,
        });
      }
      mp.getRow(1).font = { bold: true };
      for (const key of ["mkt_taxable", "mkt_tax"]) {
        const col = mp.getColumn(key);
        col.numFmt = MONEY_FMT;
        col.alignment = { horizontal: "right" };
      }
    }

    // ----- Sheet: Jurisdiction Components (audit detail) -----
    // R6b: renamed from "Jurisdiction Detail" → "Jurisdiction Components" so it's
    // clear this is the audit-level component breakdown. Filing view = locality tab.
    const jur = wb.addWorksheet("Jurisdiction Components");
    jur.columns = [
      { header: "Entity", key: "entity_id", width: 8 },
      { header: "Legal Name", key: "legal_name", width: 24 },
      { header: "Jurisdiction", key: "jurisdiction", width: 22 },
      { header: "DTF Code", key: "dtf_code", width: 12 },
      { header: "Rate", key: "rate_display", width: 10 },
      { header: "Taxable Sales", key: "taxable_sales", width: 14 },
      { header: "Tax Due", key: "tax_due", width: 14 },
      { header: "Marketplace Taxable", key: "mkt_taxable", width: 18 },
      { header: "Marketplace Tax", key: "mkt_tax", width: 16 },
    ];
    for (const j of payload.jurisdictions) {
      jur.addRow({
        entity_id: j.entity_id,
        legal_name: j.entity_legal_name,
        jurisdiction: j.jurisdiction_name,
        dtf_code: j.dtf_code ?? "(unmapped)",
        rate_display: j.rate_display,
        taxable_sales: j.taxable_sales_cents / 100,
        tax_due: j.tax_due_cents / 100,
        mkt_taxable: j.marketplace_taxable_cents / 100,
        mkt_tax: j.marketplace_tax_cents / 100,
      });
    }
    jur.getRow(1).font = { bold: true };
    for (const key of ["taxable_sales", "tax_due", "mkt_taxable", "mkt_tax"]) {
      const col = jur.getColumn(key);
      col.numFmt = MONEY_FMT;
      col.alignment = { horizontal: "right" };
    }

    // ----- Sheet: Line Detail (ST-810 only) -----
    const detail = wb.addWorksheet("Line Detail");
    detail.columns = [
      { header: "Order", key: "order_name", width: 14 },
      { header: "Date (ET)", key: "order_date_eastern", width: 22 },
      { header: "Store", key: "store_name", width: 14 },
      { header: "County", key: "county", width: 12 },
      { header: "Rate", key: "rate_pct", width: 9 },
      { header: "Taxable Amount", key: "taxable_amount", width: 16 },
      { header: "Tax Amount", key: "tax_amount", width: 14 },
      { header: "Refund?", key: "refund_flag", width: 9 },
    ];
    for (const ld of payload.lineDetail) {
      detail.addRow({
        order_name: ld.order_name,
        order_date_eastern: ld.order_date_eastern,
        store_name: ld.store_name,
        county: ld.county,
        rate_pct: bpsToPct(ld.rate_bps),
        taxable_amount: ld.taxable_amount_cents / 100,
        tax_amount: ld.tax_amount_cents / 100,
        refund_flag: ld.refund_flag ? "REFUND" : "",
      });
    }
    detail.getRow(1).font = { bold: true };
    for (const key of ["taxable_amount", "tax_amount"]) {
      const col = detail.getColumn(key);
      col.numFmt = MONEY_FMT;
      col.alignment = { horizontal: "right" };
    }
  }

  // ----- Sheet: Reconciliation -----
  const recon = wb.addWorksheet("Reconciliation");
  recon.columns = [
    { header: "Check", key: "check", width: 44 },
    { header: "Per-Entity Sum", key: "a", width: 18 },
    { header: "View Total", key: "b", width: 18 },
    { header: "Delta (cents)", key: "delta", width: 14 },
    { header: "Status", key: "status", width: 10 },
  ];
  recon.getRow(1).font = { bold: true };
  recon.addRow({ check: "Per-entity tax-due sum vs aggregator view total" }).font = { bold: true };
  for (const mm of payload.months) {
    recon.addRow({
      check: `  ${mm.month}`,
      a: mm.invariant.per_entity_sum_cents / 100,
      b: mm.invariant.view_total_cents / 100,
      delta: mm.invariant.delta_cents,
      status: mm.invariant.ok ? "OK" : "VIOLATION",
    });
  }
  if (payload.isQuarter) {
    recon.addRow({
      check: `  ${payload.periodKey} (quarter)`,
      a: payload.invariant.per_entity_sum_cents / 100,
      b: payload.invariant.view_total_cents / 100,
      delta: payload.invariant.delta_cents,
      status: payload.invariant.ok ? "OK" : "VIOLATION",
    });
  }
  for (const key of ["a", "b"]) {
    const col = recon.getColumn(key);
    col.numFmt = MONEY_FMT;
    col.alignment = { horizontal: "right" };
  }

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

// ---- PDF -----------------------------------------------------------------

/**
 * Form-faithful PDF. ST-809: one page per entity (gross / taxable / tax-due,
 * TIN, long method). ST-810: one page per entity + a Jurisdiction Summary table
 * with DTF codes + fractional rates. Resolves with the full document Buffer.
 */
export function buildSalesTaxPdf(payload: ExportPayload): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const periodLabel = payload.isQuarter
      ? payload.periodKey.replace("-", " ")
      : monthLabel(payload.months[0].month);

    payload.entities.forEach((e, idx) => {
      if (idx > 0) doc.addPage();
      drawEntityPage(doc, payload, e, periodLabel);
    });

    // Trailing reconciliation note.
    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(13).text(`${payload.formType} — Filing reconciliation`);
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(9).fillColor("#444")
      .text(`Period: ${payload.periodKey} · Generated: ${payload.generatedAtET}`);
    doc.fillColor("#000").moveDown(1);
    if (payload.invariant.ok) {
      doc.fillColor("#15803d").fontSize(10)
        .text("Invariant holds to the penny — Σ per-entity tax due equals the aggregator total (marketplace-carved).");
    } else {
      doc.fillColor("#b91c1c").fontSize(10).text(
        `Invariant VIOLATION — per-entity sum ${centsToDisplay(payload.invariant.per_entity_sum_cents)} `
        + `vs view total ${centsToDisplay(payload.invariant.view_total_cents)} `
        + `(delta ${centsToDisplay(payload.invariant.delta_cents)}). Do not file until resolved.`,
      );
    }
    doc.fillColor("#000");
    if (payload.unmappedJurisdictions.length > 0) {
      doc.moveDown(0.8);
      doc.fillColor("#b45309").fontSize(9).text(
        `Warning — jurisdictions with no DTF code (verify manually): ${payload.unmappedJurisdictions.join(", ")}`,
      );
      doc.fillColor("#000");
    }

    doc.end();
  });
}

function drawEntityPage(
  doc: PDFKit.PDFDocument,
  payload: ExportPayload,
  e: ExportEntityRow,
  periodLabel: string,
) {
  doc.font("Helvetica-Bold").fontSize(15)
    .text(`${payload.formType} — ${payload.formType === "ST-809" ? "Long Method" : "Quarter-End"}`);
  doc.moveDown(0.2);
  doc.font("Helvetica-Bold").fontSize(13).text(e.legal_name);
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(9).fillColor("#444")
    .text(`Period: ${periodLabel} · County: ${e.county} (DTF ${e.dtf_code})`);
  doc.text(`TIN: ${e.tin ?? TIN_BLANK}`);
  doc.fillColor("#000").moveDown(1);

  // Entity summary block.
  doc.font("Helvetica-Bold").fontSize(11).text("Entity summary");
  doc.moveDown(0.4);
  const rows: [string, string][] = [
    ["Gross sales", centsToDisplay(e.gross_sales_cents)],
    ["Marketplace sales (Shopify-remitted)", centsToDisplay(e.marketplace_sales_cents)],
    ["Marketplace tax (Shopify already remitted)", centsToDisplay(e.marketplace_tax_cents)],
    ["Taxable sales", centsToDisplay(e.taxable_sales_cents)],
    ["Tax due (you owe)", centsToDisplay(e.tax_due_cents)],
  ];
  const left = doc.page.margins.left;
  let y = doc.y;
  for (const [label, val] of rows) {
    doc.font("Helvetica").fontSize(10).text(label, left, y, { width: 320, align: "left" });
    doc.font("Courier").fontSize(10).text(val, left + 330, y, { width: 130, align: "right" });
    y += 18;
  }
  doc.y = y + 6;

  // ST-810: R6b — NY Locality Rollup (filing view, primary). Components table
  // is on subsequent pages as audit detail.
  if (payload.formType === "ST-810") {
    const lrows = payload.localities.filter((l) => l.entity_id === e.entity_id);
    if (lrows.length > 0) {
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(11).text("NY Locality rollup (file this on ST-810)");
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(8).fillColor("#444")
        .text("Combined NY rate per locality (state + county + MCTD merged). Enter Tax Due on the matching ST-810 line.");
      doc.fillColor("#000").moveDown(0.4);
      const lcols = [
        { label: "Locality", x: left, w: 120, money: false },
        { label: "DTF Code", x: left + 124, w: 60, money: false },
        { label: "Rate", x: left + 186, w: 50, money: false },
        { label: "Taxable", x: left + 238, w: 100, money: true },
        { label: "Tax Due", x: left + 340, w: 110, money: true },
      ];
      let ly = doc.y;
      for (const c of lcols) {
        doc.font("Helvetica-Bold").fontSize(8)
          .text(c.label, c.x, ly, { width: c.w, align: c.money ? "right" : "left" });
      }
      ly += 14;
      for (const l of lrows) {
        if (ly > doc.page.height - doc.page.margins.bottom - 40) {
          doc.addPage();
          ly = doc.page.margins.top;
        }
        doc.font("Helvetica").fontSize(8).text(l.locality_name, lcols[0].x, ly, { width: lcols[0].w });
        doc.font("Helvetica").fontSize(8).text(l.dtf_code, lcols[1].x, ly, { width: lcols[1].w });
        doc.font("Helvetica").fontSize(8).text(l.rate_display, lcols[2].x, ly, { width: lcols[2].w });
        doc.font("Courier").fontSize(8).text(centsToDisplay(l.taxable_sales_cents), lcols[3].x, ly, { width: lcols[3].w, align: "right" });
        doc.font("Courier").fontSize(9).text(centsToDisplay(l.tax_due_cents), lcols[4].x, ly, { width: lcols[4].w, align: "right" });
        ly += 13;
      }
      doc.y = ly + 10;
    }

    // Audit-detail component breakdown.
    const jrows = payload.jurisdictions.filter((j) => j.entity_id === e.entity_id);
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(10).text("Component detail (audit only)");
    doc.moveDown(0.2);
    doc.font("Helvetica").fontSize(8).fillColor("#444")
      .text("State + County + MCTD broken out. For audit; not used for filing.");
    doc.fillColor("#000").moveDown(0.4);
    const cols = [
      { label: "Jurisdiction", x: left, w: 120, money: false },
      { label: "DTF Code", x: left + 124, w: 70, money: false },
      { label: "Rate", x: left + 196, w: 60, money: false },
      { label: "Taxable", x: left + 258, w: 100, money: true },
      { label: "Tax Due", x: left + 360, w: 100, money: true },
    ];
    let yy = doc.y;
    for (const c of cols) {
      doc.font("Helvetica-Bold").fontSize(8)
        .text(c.label, c.x, yy, { width: c.w, align: c.money ? "right" : "left" });
    }
    yy += 14;
    for (const j of jrows) {
      if (yy > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage();
        yy = doc.page.margins.top;
      }
      doc.font("Helvetica").fontSize(8).text(j.jurisdiction_name, cols[0].x, yy, { width: cols[0].w });
      doc.font("Helvetica").fontSize(8).text(j.dtf_code ?? "(unmapped)", cols[1].x, yy, { width: cols[1].w });
      doc.font("Helvetica").fontSize(8).text(j.rate_display, cols[2].x, yy, { width: cols[2].w });
      doc.font("Courier").fontSize(8).text(centsToDisplay(j.taxable_sales_cents), cols[3].x, yy, { width: cols[3].w, align: "right" });
      doc.font("Courier").fontSize(8).text(centsToDisplay(j.tax_due_cents), cols[4].x, yy, { width: cols[4].w, align: "right" });
      yy += 13;
    }
    doc.y = yy + 10;
  }

  // Signature block.
  doc.moveDown(1.5);
  doc.font("Helvetica-Bold").fontSize(10).text("Filing record");
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(10);
  for (const label of ["Prepared by", "Date", "Confirmation #", "Filed at"]) {
    doc.text(`${label}: ______________________________`);
    doc.moveDown(0.4);
  }
}
