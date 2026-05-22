/**
 * PR #R4h — Deterministic regex fallback for payment-terms parsing.
 *
 * Pure JS, no LLM call. Runs AFTER the LLM in invoice-pipeline.ts; only
 * fills fields the LLM left null. Lets us recover from the (surprisingly
 * common) case where the same PDF + same prompt sometimes populates the
 * discount fields and sometimes doesn't.
 *
 * Triggering case in production: EC Woods invoice QS 7193, terms text on
 * the PDF was "2% 10 - Net 30". LLM populated payment_terms verbatim but
 * left discount_terms_pct / discount_days / discount_kind null. Reparse
 * sometimes fixed it, sometimes didn't. This module makes it deterministic.
 *
 * ----------------------------------------------------------------------------
 * Pattern matrix (all case-insensitive, whitespace-tolerant):
 *
 *   Input                       → discount_kind        pct  days  net
 *   "2% 10 Net 30"              → early_pay              2    10   30
 *   "2% 10 - Net 30"            → early_pay              2    10   30
 *   "2% 10/Net 30"              → early_pay              2    10   30
 *   "2/10 Net 30"               → early_pay              2    10   30
 *   "2/10 N30"                  → early_pay              2    10   30
 *   "2/10, n/30"                → early_pay              2    10   30
 *   "1% 15 Net 45"              → early_pay              1    15   45
 *   "Net 90 10%"                → net_with_discount     10    90   90  (single window)
 *   "Net 60 5%"                 → net_with_discount      5    60   60
 *   "Net 30"                    → null                   -     -   30
 *   "NET 15"                    → null                   -     -   15
 *   "N/30"                      → null                   -     -   30
 *   "Net30"                     → null                   -     -   30
 *   "Due on Receipt"            → null                   -     -    0
 *   "DOR"                       → null                   -     -    0
 *   "Due upon receipt"          → null                   -     -    0
 *   "COD"                       → null (cod=true)        -     -    0
 *   "Cash on Delivery"          → null (cod=true)        -     -    0
 *   "Prepaid" / "Pre-paid"      → null                   -     -    0
 *
 * Returns all-null shape if nothing matches — caller keeps whatever the LLM
 * gave us.
 * ----------------------------------------------------------------------------
 */

export type ParsedTerms = {
  discount_terms_pct: number | null;
  discount_days: number | null;
  discount_due_date: string | null; // YYYY-MM-DD
  discount_kind: "early_pay" | "net_with_discount" | null;
  net_days: number | null;
  due_date: string | null;          // YYYY-MM-DD
  cod: boolean;                     // optional flag (true only for "COD" / "Cash on Delivery")
};

const ALL_NULL: ParsedTerms = {
  discount_terms_pct: null,
  discount_days: null,
  discount_due_date: null,
  discount_kind: null,
  net_days: null,
  due_date: null,
  cod: false,
};

// Same date arithmetic the rest of the pipeline uses (normalizeDueDate in
// invoice-pipeline.ts). UTC throughout so a server in any timezone produces
// the same answer.
function addDays(yyyyMmDd: string, days: number): string | null {
  const base = new Date(yyyyMmDd);
  if (isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Parse the verbatim payment-terms string into structured fields. Caller
 * passes invoice_date (YYYY-MM-DD) so the function can compute the absolute
 * discount_due_date / due_date.
 *
 * Returns null if nothing matched. Returns all-null fields inside the
 * object if the call was made with empty input.
 */
export function parsePaymentTermsFallback(
  termsText: string | null | undefined,
  invoiceDate: string | null | undefined,
): ParsedTerms | null {
  if (!termsText || typeof termsText !== "string") return null;
  const s = termsText.trim();
  if (!s) return null;
  // Collapse whitespace and lowercase a working copy. We keep the original
  // for any error logging the caller might do; matching is on the normalized.
  const t = s.replace(/\s+/g, " ").toLowerCase();
  const out: ParsedTerms = { ...ALL_NULL };

  // ---- early_pay: "2% 10 Net 30" / "2/10 Net 30" / "2/10 N30" / variants ----
  // Two captures: the discount expression ("2% 10" or "2/10") followed by a
  // net term ("Net 30" / "N30" / "N/30"). Punctuation between is anything
  // non-alphanumeric: space, slash, dash, comma.
  //   group 1 = pct, group 2 = discount_days, group 3 = net_days
  const earlyPay = t.match(
    /(?:^|\s|,)\s*(\d{1,2})\s*[%/]\s*(\d{1,3})\s*[^\w]+\s*(?:net|n)\s*\/?\s*(\d{1,3})\b/i,
  );
  if (earlyPay) {
    const pct = parseInt(earlyPay[1], 10);
    const dDays = parseInt(earlyPay[2], 10);
    const nDays = parseInt(earlyPay[3], 10);
    if (Number.isFinite(pct) && Number.isFinite(dDays) && Number.isFinite(nDays) &&
        pct > 0 && pct < 100 && dDays > 0 && dDays < 365 && nDays > 0 && nDays < 400) {
      out.discount_kind = "early_pay";
      out.discount_terms_pct = pct;
      out.discount_days = dDays;
      out.net_days = nDays;
      if (invoiceDate) {
        out.discount_due_date = addDays(invoiceDate, dDays);
        out.due_date = addDays(invoiceDate, nDays);
      }
      return out;
    }
  }

  // ---- net_with_discount: "Net 90 10%" / "Net 60 5%" ----
  // Discount is automatic per spec; single window so due_date == discount_due_date.
  const netDisc = t.match(/(?:net|n)\s*\/?\s*(\d{1,3})\s*[^\w]*\s*(\d{1,2})\s*%/i);
  if (netDisc) {
    const nDays = parseInt(netDisc[1], 10);
    const pct = parseInt(netDisc[2], 10);
    if (Number.isFinite(pct) && Number.isFinite(nDays) &&
        pct > 0 && pct < 100 && nDays > 0 && nDays < 400) {
      out.discount_kind = "net_with_discount";
      out.discount_terms_pct = pct;
      out.discount_days = nDays;
      out.net_days = nDays;
      if (invoiceDate) {
        const d = addDays(invoiceDate, nDays);
        out.discount_due_date = d;
        out.due_date = d;
      }
      return out;
    }
  }

  // ---- COD / Cash on Delivery ----
  if (/(?:^|\W)(cod|c\.o\.d\.|cash\s+on\s+delivery)(?:$|\W)/i.test(t)) {
    out.net_days = 0;
    out.cod = true;
    if (invoiceDate) out.due_date = invoiceDate;
    return out;
  }

  // ---- Prepaid ----
  if (/(?:^|\W)(prepaid|pre[\s-]?paid)(?:$|\W)/i.test(t)) {
    out.net_days = 0;
    if (invoiceDate) out.due_date = invoiceDate;
    return out;
  }

  // ---- Due on Receipt / DOR / Due upon Receipt / Payable on Receipt ----
  if (/(?:due\s+on\s+receipt|due\s+upon\s+receipt|payable\s+on\s+receipt|\bdor\b|\bupon\s+receipt\b)/i.test(t)) {
    out.net_days = 0;
    if (invoiceDate) out.due_date = invoiceDate;
    return out;
  }

  // ---- Plain Net term: "Net 30" / "N/30" / "Net30" ----
  const netOnly = t.match(/(?:net|n)\s*\/?\s*(\d{1,3})\b/i);
  if (netOnly) {
    const nDays = parseInt(netOnly[1], 10);
    if (Number.isFinite(nDays) && nDays > 0 && nDays < 400) {
      out.net_days = nDays;
      if (invoiceDate) out.due_date = addDays(invoiceDate, nDays);
      return out;
    }
  }

  return null;
}
