/**
 * Sales Tax — export builders (PR #167).
 *
 * Pure builder functions for the three sales-tax export formats. They take
 * already-computed sales-tax data (the same SalesTaxMonth shape the
 * /sales-tax/:month endpoint returns) plus optional line detail, and return a
 * string (CSV) or Buffer (XLSX/PDF). No DB access here — the route layer does
 * the compute and passes the data in, so this module stays importable + the
 * canonical compute (computeSalesTaxForMonth, a closure in routes.ts) is reused
 * rather than duplicated.
 *
 * Money: every figure arrives as integer cents and is formatted to 2 decimals
 * exactly once, at render time (centsToFixed). No intermediate float math, no
 * rounding drift. Refund tax is already ABS-wrapped + subtracted upstream.
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

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
}

export interface ExportTotals {
  gross_sales_cents: number;
  taxable_sales_cents: number;
  tax_collected_cents: number;
  net_tax_cents: number;
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
 * The unit of work for an export: a single period that is either one month
 * (simple mode) or a quarter (three months rolled up). `months` always lists
 * the constituent month payloads; `periodKey`/`isQuarter` drive titles +
 * filenames. `lineDetail` spans the whole period.
 */
export interface ExportPayload {
  periodKey: string;
  isQuarter: boolean;
  months: ExportMonth[];
  /** Quarter-level totals + invariant (only meaningful when isQuarter). */
  totals: ExportTotals;
  invariant: ExportInvariant;
  lineDetail: ExportLineDetail[];
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

// ---- CSV -----------------------------------------------------------------

const CSV_HEADER = [
  "period_key", "month", "store_id", "store_name", "entity_id", "county",
  "state", "rate_pct", "gross_sales", "taxable_sales", "exempt_sales",
  "tax_collected", "refund_tax_in_period", "net_tax",
];

function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) return `"${field.replace(/"/g, '""')}"`;
  return field;
}

/** Per-store monthly summary CSV. One row per store per month in the period. */
export function buildSalesTaxCsv(payload: ExportPayload): string {
  const lines: string[] = [CSV_HEADER.join(",")];
  for (const mm of payload.months) {
    for (const s of mm.stores) {
      const row = [
        payload.periodKey,
        mm.month,
        s.store_id,
        s.name,
        String(s.entity_id),
        s.county,
        s.state,
        bpsToPct(s.rate_bps),
        centsToFixed(s.gross_sales_cents),
        centsToFixed(s.taxable_sales_cents),
        centsToFixed(s.exempt_sales_cents),
        centsToFixed(s.tax_collected_cents),
        centsToFixed(s.refund_tax_in_period_cents),
        centsToFixed(s.net_tax_cents),
      ];
      lines.push(row.map((f) => csvEscape(String(f))).join(","));
    }
  }
  // Trailing CRLF — Excel-friendly.
  return lines.join("\r\n") + "\r\n";
}

// ---- XLSX ----------------------------------------------------------------

const MONEY_FMT = '$#,##0.00';

/** Multi-sheet workbook: Summary, Line Detail, Reconciliation. */
export async function buildSalesTaxXlsx(payload: ExportPayload): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sno-Haus AP";
  wb.created = new Date();

  // ----- Sheet 1: Summary (same columns as CSV) -----
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Period", key: "period_key", width: 12 },
    { header: "Month", key: "month", width: 10 },
    { header: "Store ID", key: "store_id", width: 16 },
    { header: "Store", key: "store_name", width: 14 },
    { header: "Entity", key: "entity_id", width: 8 },
    { header: "County", key: "county", width: 12 },
    { header: "State", key: "state", width: 7 },
    { header: "Rate", key: "rate_pct", width: 9 },
    { header: "Gross Sales", key: "gross_sales", width: 14 },
    { header: "Taxable Sales", key: "taxable_sales", width: 14 },
    { header: "Exempt Sales", key: "exempt_sales", width: 14 },
    { header: "Tax Collected", key: "tax_collected", width: 14 },
    { header: "Refund Tax", key: "refund_tax_in_period", width: 14 },
    { header: "Net Tax", key: "net_tax", width: 14 },
  ];
  const moneyCols = ["gross_sales", "taxable_sales", "exempt_sales", "tax_collected", "refund_tax_in_period", "net_tax"];
  for (const mm of payload.months) {
    for (const s of mm.stores) {
      summary.addRow({
        period_key: payload.periodKey,
        month: mm.month,
        store_id: s.store_id,
        store_name: s.name,
        entity_id: s.entity_id,
        county: s.county,
        state: s.state,
        rate_pct: bpsToPct(s.rate_bps),
        gross_sales: s.gross_sales_cents / 100,
        taxable_sales: s.taxable_sales_cents / 100,
        exempt_sales: s.exempt_sales_cents / 100,
        tax_collected: s.tax_collected_cents / 100,
        refund_tax_in_period: s.refund_tax_in_period_cents / 100,
        net_tax: s.net_tax_cents / 100,
      });
    }
  }
  // Totals row.
  const t = payload.totals;
  summary.addRow({
    period_key: "TOTAL",
    gross_sales: t.gross_sales_cents / 100,
    taxable_sales: t.taxable_sales_cents / 100,
    tax_collected: t.tax_collected_cents / 100,
    net_tax: t.net_tax_cents / 100,
  });
  summary.getRow(1).font = { bold: true };
  summary.lastRow!.font = { bold: true };
  for (const key of moneyCols) {
    const col = summary.getColumn(key);
    col.numFmt = MONEY_FMT;
    col.alignment = { horizontal: "right" };
  }

  // ----- Sheet 2: Line Detail -----
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

  // ----- Sheet 3: Reconciliation -----
  const recon = wb.addWorksheet("Reconciliation");
  recon.columns = [
    { header: "Check", key: "check", width: 40 },
    { header: "Per-Entity Sum", key: "a", width: 18 },
    { header: "View Total", key: "b", width: 18 },
    { header: "Delta (cents)", key: "delta", width: 14 },
    { header: "Status", key: "status", width: 10 },
  ];
  recon.getRow(1).font = { bold: true };
  // Section 1: per-store sum vs engine view total (per month + quarter total).
  recon.addRow({ check: "Section 1 — per-store net-tax sum vs view total" }).font = { bold: true };
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
  // Section 2: per-jurisdiction (county) tax sum vs total tax.
  recon.addRow({});
  recon.addRow({ check: "Section 2 — per-jurisdiction tax sum vs total tax" }).font = { bold: true };
  const countyTax = new Map<string, number>();
  let totalTax = 0;
  for (const mm of payload.months) {
    for (const s of mm.stores) {
      countyTax.set(s.county, (countyTax.get(s.county) || 0) + s.net_tax_cents);
      totalTax += s.net_tax_cents;
    }
  }
  let countySum = 0;
  Array.from(countyTax.entries()).forEach(([county, cents]) => {
    countySum += cents;
    recon.addRow({ check: `  ${county}`, a: cents / 100 });
  });
  recon.addRow({
    check: "  Σ counties vs total net tax",
    a: countySum / 100,
    b: totalTax / 100,
    delta: countySum - totalTax,
    status: countySum - totalTax === 0 ? "OK" : "VIOLATION",
  });
  for (const key of ["a", "b"]) {
    const col = recon.getColumn(key);
    col.numFmt = MONEY_FMT;
    col.alignment = { horizontal: "right" };
  }

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

// ---- PDF -----------------------------------------------------------------

/** ST-810 filing-ready PDF. Resolves with the full document Buffer. */
export function buildSalesTaxPdf(payload: ExportPayload): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const title = payload.isQuarter
      ? `Sno-Haus Sales Tax — ${payload.periodKey.replace("-", " ")} (NY ST-810)`
      : `Sno-Haus Sales Tax — ${monthLabel(payload.months[0].month)}`;
    doc.font("Helvetica-Bold").fontSize(16).text(title);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9).fillColor("#444")
      .text(`Filing period: ${payload.periodKey} · Generated: ${payload.generatedAtET}`);
    doc.fillColor("#000").moveDown(1);

    if (payload.isQuarter) {
      drawQuarterlySchedule(doc, payload);
    } else {
      drawSimpleSummary(doc, payload.months[0]);
    }

    // Invariant footer.
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(9);
    if (payload.invariant.ok) {
      doc.fillColor("#15803d").text("Invariant holds to the penny — per-store sum equals view total.");
    } else {
      doc.fillColor("#b91c1c").text(
        `Invariant VIOLATION — per-store sum ${centsToDisplay(payload.invariant.per_entity_sum_cents)} `
        + `vs view total ${centsToDisplay(payload.invariant.view_total_cents)} `
        + `(delta ${centsToDisplay(payload.invariant.delta_cents)}). Do not file until resolved.`,
      );
    }
    doc.fillColor("#000");

    // Signature block.
    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(10).text("Filing record");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10);
    const sigLines = ["Prepared by", "Date", "Confirmation #", "Filed at"];
    for (const label of sigLines) {
      doc.text(`${label}: ______________________________`);
      doc.moveDown(0.4);
    }

    doc.end();
  });
}

// Monospaced money cell to keep columns aligned.
function moneyCell(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w: number) {
  doc.font("Courier").fontSize(8).text(text, x, y, { width: w, align: "right" });
}
function textCell(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w: number, bold = false) {
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).text(text, x, y, { width: w, align: "left" });
}

function drawSimpleSummary(doc: PDFKit.PDFDocument, mm: ExportMonth) {
  doc.font("Helvetica-Bold").fontSize(11).text("Per-store summary");
  doc.moveDown(0.4);
  // Columns: Store | County | Rate | Taxable | Tax Collected | Net Tax
  const left = doc.page.margins.left;
  const cols = [
    { label: "Store", x: left, w: 90, money: false },
    { label: "County", x: left + 92, w: 70, money: false },
    { label: "Rate", x: left + 164, w: 45, money: false },
    { label: "Taxable", x: left + 211, w: 90, money: true },
    { label: "Tax Collected", x: left + 303, w: 95, money: true },
    { label: "Net Tax", x: left + 400, w: 95, money: true },
  ];
  let y = doc.y;
  for (const c of cols) {
    if (c.money) moneyCellHeader(doc, c.label, c.x, y, c.w);
    else textCell(doc, c.label, c.x, y, c.w, true);
  }
  y += 16;
  for (const s of mm.stores) {
    const closedTag = s.closed && s.gross_sales_cents === 0 ? " (closed)" : "";
    textCell(doc, s.name + closedTag, cols[0].x, y, cols[0].w);
    textCell(doc, s.county, cols[1].x, y, cols[1].w);
    textCell(doc, bpsToPct(s.rate_bps), cols[2].x, y, cols[2].w);
    moneyCell(doc, centsToDisplay(s.taxable_sales_cents), cols[3].x, y, cols[3].w);
    moneyCell(doc, centsToDisplay(s.tax_collected_cents), cols[4].x, y, cols[4].w);
    moneyCell(doc, centsToDisplay(s.net_tax_cents), cols[5].x, y, cols[5].w);
    y += 14;
  }
  // Totals row.
  textCell(doc, "TOTAL", cols[0].x, y, cols[0].w, true);
  moneyCell(doc, centsToDisplay(mm.totals.taxable_sales_cents), cols[3].x, y, cols[3].w);
  moneyCell(doc, centsToDisplay(mm.totals.tax_collected_cents), cols[4].x, y, cols[4].w);
  moneyCell(doc, centsToDisplay(mm.totals.net_tax_cents), cols[5].x, y, cols[5].w);
  doc.y = y + 18;
}

function drawQuarterlySchedule(doc: PDFKit.PDFDocument, payload: ExportPayload) {
  doc.font("Helvetica-Bold").fontSize(11).text("Quarterly ST-810 schedule");
  doc.moveDown(0.4);
  const left = doc.page.margins.left;
  const cols = [
    { label: "Month", x: left, w: 55, money: false },
    { label: "Store", x: left + 57, w: 80, money: false },
    { label: "Jurisdiction", x: left + 139, w: 70, money: false },
    { label: "Rate", x: left + 211, w: 42, money: false },
    { label: "Taxable", x: left + 255, w: 105, money: true },
    { label: "Tax Collected", x: left + 362, w: 105, money: true },
  ];
  let y = doc.y;
  for (const c of cols) {
    if (c.money) moneyCellHeader(doc, c.label, c.x, y, c.w);
    else textCell(doc, c.label, c.x, y, c.w, true);
  }
  y += 16;
  // Rows sorted by month then store (months already in order; stores in mapping order).
  const countySubtotal = new Map<string, { taxable: number; tax: number }>();
  for (const mm of payload.months) {
    for (const s of mm.stores) {
      if (y > doc.page.height - doc.page.margins.bottom - 60) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      textCell(doc, monthLabel(mm.month).split(" ")[0].slice(0, 3), cols[0].x, y, cols[0].w);
      textCell(doc, s.name, cols[1].x, y, cols[1].w);
      textCell(doc, s.county, cols[2].x, y, cols[2].w);
      textCell(doc, bpsToPct(s.rate_bps), cols[3].x, y, cols[3].w);
      moneyCell(doc, centsToDisplay(s.taxable_sales_cents), cols[4].x, y, cols[4].w);
      moneyCell(doc, centsToDisplay(s.tax_collected_cents), cols[5].x, y, cols[5].w);
      const cs = countySubtotal.get(s.county) || { taxable: 0, tax: 0 };
      cs.taxable += s.taxable_sales_cents;
      cs.tax += s.net_tax_cents;
      countySubtotal.set(s.county, cs);
      y += 13;
    }
  }
  // Per-county subtotals (NY ST-810 wants the jurisdictional breakdown).
  y += 6;
  textCell(doc, "Per-county subtotals", cols[0].x, y, 200, true);
  y += 15;
  Array.from(countySubtotal.entries()).forEach(([county, cs]) => {
    textCell(doc, county, cols[2].x, y, cols[2].w, true);
    moneyCell(doc, centsToDisplay(cs.taxable), cols[4].x, y, cols[4].w);
    moneyCell(doc, centsToDisplay(cs.tax), cols[5].x, y, cols[5].w);
    y += 13;
  });
  // Grand total.
  y += 4;
  textCell(doc, "GRAND TOTAL", cols[0].x, y, 200, true);
  moneyCell(doc, centsToDisplay(payload.totals.taxable_sales_cents), cols[4].x, y, cols[4].w);
  moneyCell(doc, centsToDisplay(payload.totals.tax_collected_cents), cols[5].x, y, cols[5].w);
  doc.y = y + 18;
}

function moneyCellHeader(doc: PDFKit.PDFDocument, text: string, x: number, y: number, w: number) {
  doc.font("Helvetica-Bold").fontSize(8).text(text, x, y, { width: w, align: "right" });
}
