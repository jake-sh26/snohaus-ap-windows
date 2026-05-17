/**
 * Fuzzy duplicate detection for invoices.
 *
 * Why this exists:
 *   The exact-match dedup (vendor + invoice_number + total) misses cases where
 *   OCR re-typed a digit (e.g. "1NV-1024" vs "INV-1O24"), or the same vendor
 *   sends the same bill twice with whitespace / dash differences in the invoice
 *   number. This module catches those by normalizing both sides and comparing
 *   with bounded Levenshtein distance, plus total+date proximity as evidence.
 *
 * Used by:
 *   - server/invoice-pipeline.ts  (called during ingest, before insert)
 *   - server/routes.ts            (POST /api/invoices/:id/recheck-duplicates)
 */
import type Database from "better-sqlite3";

export type DuplicateMatch = {
  id: string;
  invoice_number: string | null;
  total: number | null;
  invoice_date: string | null;
  vendor_qbo_id: string | null;
  vendor_qbo_name: string | null;
  vendor_raw_name: string | null;
  /** 100 = exact normalized match, 80–99 = fuzzy (Levenshtein), 60–79 = number close + total/date evidence. */
  confidence: number;
  reason: string;
};

/** OCR-friendly normalization for comparison only — never written back. */
export function normalizeInvoiceNumber(raw: string | null | undefined): string {
  if (!raw) return "";
  // strip non-alphanumeric, uppercase
  let s = String(raw).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  // common OCR substitutions to a canonical form (collapse confusable pairs to digits)
  s = s
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8");
  return s;
}

/** Bounded Levenshtein — returns Infinity if distance > maxDistance. */
export function levenshtein(a: string, b: string, maxDistance = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return Infinity;
  if (!a.length) return b.length <= maxDistance ? b.length : Infinity;
  if (!b.length) return a.length <= maxDistance ? a.length : Infinity;

  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDistance) return Infinity;
    [prev, curr] = [curr, prev];
  }
  const result = prev[n];
  return result <= maxDistance ? result : Infinity;
}

function daysBetween(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return Infinity;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (isNaN(ta) || isNaN(tb)) return Infinity;
  return Math.abs(ta - tb) / 86_400_000;
}

type CandidateRow = {
  id: string;
  invoice_number: string | null;
  total: number | null;
  invoice_date: string | null;
  vendor_qbo_id: string | null;
  vendor_qbo_name: string | null;
  vendor_raw_name: string | null;
};

export type FindDuplicateOptions = {
  /** Skip this invoice id when scanning (so editing/re-checking doesn't match itself). */
  excludeId?: string | null;
  /** Levenshtein distance budget on normalized numbers. Default 2. */
  maxDistance?: number;
  /** Total tolerance in dollars. Default $0.01 (cent rounding). */
  totalTolerance?: number;
  /** Date proximity in days. Default 3. */
  dateProximityDays?: number;
};

/**
 * Find a likely-duplicate invoice for the given inputs.
 *
 * Strategy:
 *   1. Pull candidate rows for the same vendor (qbo id OR raw-name LIKE) where
 *      invoice_number is non-empty. (small set — fine to scan in JS.)
 *   2. Normalize both sides; if normalized strings are equal → confidence 100.
 *   3. Else if Levenshtein ≤ maxDistance → confidence 80–99 (closer = higher).
 *   4. Else if total within tolerance AND date within proximityDays → 60–79
 *      (treats the invoice as the same bill resubmitted with a typo'd number).
 *
 * Returns the *highest-confidence* match, or null. Caller decides what to do
 * (block ingest, surface a UI warning, etc.).
 */
export function findDuplicateInvoice(
  db: Database.Database,
  args: {
    vendorQboId: string | null;
    vendorRawName: string | null;
    invoiceNumber: string | null;
    total: number | null;
    invoiceDate: string | null;
  },
  opts: FindDuplicateOptions = {},
): DuplicateMatch | null {
  const maxDistance = opts.maxDistance ?? 2;
  const totalTolerance = opts.totalTolerance ?? 0.01;
  const dateProximityDays = opts.dateProximityDays ?? 3;
  const targetNorm = normalizeInvoiceNumber(args.invoiceNumber);

  // Need either a vendor key or an invoice number to do anything useful.
  if (!targetNorm && args.total == null) return null;
  if (!args.vendorQboId && !args.vendorRawName) return null;

  const rawTrim = (args.vendorRawName || "").trim();
  const dupRawLike = rawTrim ? `%${rawTrim.slice(0, 30)}%` : null;

  // Pull candidate set scoped to this vendor.
  const rows = db.prepare(
    `SELECT id, invoice_number, total, invoice_date,
            vendor_qbo_id, vendor_qbo_name, vendor_raw_name
       FROM invoices
      WHERE invoice_number IS NOT NULL AND TRIM(invoice_number) <> ''
        AND (
          (? IS NOT NULL AND vendor_qbo_id = ?)
          OR (? IS NOT NULL AND vendor_raw_name LIKE ?)
        )
        AND (? IS NULL OR id <> ?)
      LIMIT 500`,
  ).all(
    args.vendorQboId, args.vendorQboId,
    dupRawLike, dupRawLike,
    opts.excludeId || null, opts.excludeId || null,
  ) as CandidateRow[];

  let best: DuplicateMatch | null = null;

  for (const row of rows) {
    const candNorm = normalizeInvoiceNumber(row.invoice_number);
    const totalClose =
      args.total != null && row.total != null &&
      Math.abs(Number(row.total) - Number(args.total)) <= totalTolerance;
    const dateClose = daysBetween(args.invoiceDate, row.invoice_date) <= dateProximityDays;

    let confidence = 0;
    let reason = "";

    if (targetNorm && candNorm) {
      if (targetNorm === candNorm) {
        confidence = 100;
        reason = "Normalized invoice numbers match exactly";
      } else {
        const dist = levenshtein(targetNorm, candNorm, maxDistance);
        if (dist !== Infinity) {
          // 80 baseline, +5 per saved edit, capped at 99
          confidence = Math.min(99, 80 + (maxDistance - dist) * 5);
          reason = `Invoice numbers off by ${dist} character${dist === 1 ? "" : "s"} after normalization (${row.invoice_number} ≈ ${args.invoiceNumber})`;
        }
      }
    }

    // If number isn't close enough but total + date both line up, that's still
    // strong evidence the same bill was resubmitted with a different number.
    if (confidence === 0 && totalClose && dateClose && targetNorm && candNorm) {
      confidence = 65;
      reason = `Same vendor, total within $${totalTolerance.toFixed(2)}, dated within ${dateProximityDays} days (#${row.invoice_number})`;
    }

    if (confidence > 0) {
      // Boost when total also matches — strongest signal.
      if (totalClose) confidence = Math.min(100, confidence + 5);
      if (dateClose) confidence = Math.min(100, confidence + 2);

      if (!best || confidence > best.confidence) {
        best = {
          id: row.id,
          invoice_number: row.invoice_number,
          total: row.total,
          invoice_date: row.invoice_date,
          vendor_qbo_id: row.vendor_qbo_id,
          vendor_qbo_name: row.vendor_qbo_name,
          vendor_raw_name: row.vendor_raw_name,
          confidence,
          reason,
        };
      }
    }
  }

  return best;
}
