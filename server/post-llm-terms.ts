/**
 * Shared post-LLM payment-terms + discount transform.
 *
 * Runs the deterministic regex fallback (parsePaymentTermsFallback) against the
 * LLM-emitted payment_terms string and fills in any discount_* / due_date
 * fields the LLM left null. Used by every ingest path AND by the reparse
 * endpoint so the behaviour is identical regardless of how an invoice enters
 * the system. Before this lived in three places (invoice-pipeline.ts, the
 * /api/invoices/:id/reparse handler, and was missing entirely from the Gmail
 * pollers), which is why hitting Reparse sometimes "fixed" fields the first
 * ingest left blank.
 *
 * Operates on the LLM result object in-place: only writes a field when the
 * fallback parser produced a value AND the result currently has null/empty
 * for that field. Never overwrites a real value.
 *
 * Returns the list of field names that were filled (for log lines).
 */

import { parsePaymentTermsFallback } from "./payment-terms-parser";

export interface PostLlmTermsTarget {
  payment_terms?: string | null;
  invoice_date?: string | null;
  due_date?: string | null;
  discount_terms_pct?: number | null;
  discount_days?: number | null;
  discount_due_date?: string | null;
  discount_kind?: "early_pay" | "net_with_discount" | null;
  // discount_warning is intentionally not touched here — detectDiscountTerms
  // in llm-parser.ts owns that field, and we don't want a deterministic-regex
  // pass clobbering a "verify on invoice" warning that came from the more
  // permissive llm-parser regex.
}

/**
 * Fill discount_* and due_date fields on `target` using parsePaymentTermsFallback.
 * @param target Mutated in-place. Typically the LLMParsedInvoice result.
 * @param effectiveInvoiceDate Invoice date to use when computing due dates.
 *        Pass the caller's most-up-to-date invoice_date (post any patches).
 * @returns Array of field names that were filled. Empty when nothing changed.
 */
export function applyPostLlmTermsFallback(
  target: PostLlmTermsTarget,
  effectiveInvoiceDate: string | null | undefined,
): string[] {
  const filled: string[] = [];
  if (!target.payment_terms) return filled;

  const fallback = parsePaymentTermsFallback(target.payment_terms, effectiveInvoiceDate ?? null);
  if (!fallback) return filled;

  if (target.discount_terms_pct == null && fallback.discount_terms_pct != null) {
    target.discount_terms_pct = fallback.discount_terms_pct;
    filled.push("discount_terms_pct");
  }
  if (target.discount_days == null && fallback.discount_days != null) {
    target.discount_days = fallback.discount_days;
    filled.push("discount_days");
  }
  if (!target.discount_due_date && fallback.discount_due_date) {
    target.discount_due_date = fallback.discount_due_date;
    filled.push("discount_due_date");
  }
  if (!target.discount_kind && fallback.discount_kind) {
    target.discount_kind = fallback.discount_kind;
    filled.push("discount_kind");
  }
  // due_date: only fill if the LLM left it null AND the fallback produced one.
  // The verbatim "Net 30" with no LLM due_date is exactly the gap this catches.
  if (!target.due_date && fallback.due_date) {
    target.due_date = fallback.due_date;
    filled.push("due_date");
  }
  return filled;
}
