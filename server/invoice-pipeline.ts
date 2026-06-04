/**
 * Shared invoice pipeline: takes a PDF buffer + lightweight metadata (filename, source label,
 * and optional email-style fields) and runs the same end-to-end ingestion that the Gmail
 * poller uses: LLM parse → smart vendor match → Claude vendor fallback → dedup check →
 * insert → auto QBO duplicate check.
 *
 * Used by:
 *   - POST /api/invoices/upload (manual PDF upload from Inbox / Settings)
 *   - server/acumatica.ts (per-invoice download from the WSR portal)
 */

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { parseInvoiceWithLLM, isLlmParserEnabled, getLastLlmFailure, clearLastLlmFailure, type LLMParsedInvoice } from "./llm-parser";
import { smartMatchVendor, resolveShipToStore, learnVendorAlias, checkSkipSender, recordSkipLog, replaceInvoiceLineItems, recordSkippedUpload } from "./storage";
import { matchVendorWithLlm, isVendorMatcherLlmEnabled } from "./vendor-matcher-llm";
import { getQboStatus, searchBills, searchPayments } from "./qbo";
import { findDuplicateInvoice } from "./dup-detector";
import { parsePaymentTermsFallback } from "./payment-terms-parser";

import { getDbPath } from "./db-path";
const DB_PATH = getDbPath(); // PR #R4j: NSSM-safe path

function getDb() {
  return new Database(DB_PATH);
}

/**
 * Coerce whatever the LLM returned for `due_date` into a YYYY-MM-DD string.
 * The LLM is asked to emit YYYY-MM-DD, but real-world invoices use M/D/YYYY,
 * MM-DD-YY, etc., and historical seed data has both. We also accept Net-N
 * style strings ("Net 30") by computing from invoice_date.
 *
 * Returns null if we can't produce a real date — the field stays empty rather
 * than being filled with garbage that QBO would reject.
 */
export function normalizeDueDate(
  raw: string | null | undefined,
  invoiceDate: string | null | undefined,
): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Already YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS — take the date portion.
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // "Net 30", "NET 15", "due in 45 days" — compute from invoice_date.
  const netMatch = s.match(/(?:net|due\s+in)\s*(\d{1,3})/i);
  if (netMatch && invoiceDate) {
    const days = parseInt(netMatch[1], 10);
    const base = new Date(invoiceDate);
    if (!isNaN(base.getTime()) && days > 0 && days < 400) {
      base.setUTCDate(base.getUTCDate() + days);
      return base.toISOString().slice(0, 10);
    }
  }

  // "Due on receipt", "upon receipt", "COD" — use invoice_date as the due date.
  if (/(due\s+on\s+receipt|upon\s+receipt|on\s+receipt|^cod$|payable\s+on\s+receipt)/i.test(s)) {
    if (invoiceDate) return String(invoiceDate).slice(0, 10);
  }

  // M/D/YYYY, MM/DD/YYYY, M-D-YY, etc.
  const slashMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/);
  if (slashMatch) {
    const mm = slashMatch[1].padStart(2, "0");
    const dd = slashMatch[2].padStart(2, "0");
    let yy = slashMatch[3];
    if (yy.length === 2) yy = (parseInt(yy, 10) >= 70 ? "19" : "20") + yy;
    return `${yy}-${mm}-${dd}`;
  }

  // Last-ditch: try Date.parse for things like "April 30, 2026".
  const t = Date.parse(s);
  if (!isNaN(t)) {
    return new Date(t).toISOString().slice(0, 10);
  }

  return null;
}

export type PipelineInput = {
  pdfBuffer: Buffer;
  /** Original filename (e.g. "B Robinson Invoice.pdf"). */
  originalFilename: string;
  /** Free-text label of where this came from — used for source_file marker. e.g. "manual-upload", "acumatica:WSR". */
  source: string;
  /** Optional email-style metadata to populate the invoice row (so the UI can show provenance). */
  emailFrom?: string | null;
  emailSubject?: string | null;
  emailDate?: string | null;
  emailBody?: string | null;
  /**
   * Classification of the source artifact. 'image_ocr' tells the UI this came
   * from a phone snapshot (JPG/PNG/HEIC) rather than a real PDF, so the user
   * should sanity-check the invoice number before approving.
   */
  sourceType?: "pdf" | "image_ocr" | "gmail" | "acumatica" | null;
};

export type PipelineResult = {
  status: "ingested" | "skipped_non_invoice" | "duplicate_internal" | "duplicate_qbo" | "error";
  invoice_id: string | null;
  vendor_qbo_name: string | null;
  vendor_match_status: string | null;
  reason: string | null;
};

export async function processInvoicePdf(input: PipelineInput): Promise<PipelineResult> {
  // ===== Skip Senders gate (Round 6) =====
  // Before doing any work (no LLM call, no file write), check if the sender
  // is on the user's skip list. Subscriptions / autopay services route here.
  if (input.emailFrom) {
    const rule = checkSkipSender(input.emailFrom);
    if (rule) {
      recordSkipLog({
        source: input.source,
        sender_email: input.emailFrom,
        subject: input.emailSubject || null,
        matched_rule_id: rule.id,
      });
      return {
        status: "skipped_non_invoice",
        invoice_id: null,
        vendor_qbo_name: null,
        vendor_match_status: null,
        reason: `Skipped by user rule (${rule.match_type}: ${rule.match_value})`,
      };
    }
  }

  const assetsDir = path.resolve(process.cwd(), "private_assets");
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  const prefix = crypto.randomBytes(5).toString("hex");
  const safeName = (input.originalFilename || "invoice.pdf").replace(/[^a-zA-Z0-9._\-]/g, "_");
  const filename = `${prefix}_${safeName}`;
  const filePath = path.join(assetsDir, filename);
  fs.writeFileSync(filePath, input.pdfBuffer);

  // ---- LLM parse ----
  let llmResult: LLMParsedInvoice | null = null;
  let llmFailureReason: string | null = null;
  if (isLlmParserEnabled()) {
    clearLastLlmFailure();
    try {
      llmResult = await parseInvoiceWithLLM(input.pdfBuffer, {
        subject: input.emailSubject || null,
        from: input.emailFrom || null,
        body: input.emailBody || null,
      });
    } catch (e: any) {
      llmFailureReason = `threw: ${e.message}`;
    }
    if (!llmResult && !llmFailureReason) {
      llmFailureReason = getLastLlmFailure() || "unknown LLM failure";
    }
    // Soft-failure detection: LLM returned an object but every critical field
    // is null/empty AND there are no line items. This catches the case where
    // truncation or a parser hiccup yields a syntactically valid but
    // information-empty response. Surfaces a parse-failure banner so Jake
    // knows to hit Reparse.
    if (llmResult && !llmFailureReason) {
      const hasVendor = !!(llmResult.vendor_raw_name && String(llmResult.vendor_raw_name).trim());
      const hasNumber = !!(llmResult.invoice_number && String(llmResult.invoice_number).trim());
      const hasTotal = llmResult.total != null && !Number.isNaN(Number(llmResult.total));
      const hasDate = !!(llmResult.invoice_date && String(llmResult.invoice_date).trim());
      const hasLines = Array.isArray((llmResult as any).line_items) && (llmResult as any).line_items.length > 0;
      const filledCount = [hasVendor, hasNumber, hasTotal, hasDate].filter(Boolean).length;
      // Treat as failure when zero or one critical field came back AND no line
      // items either. One field alone (e.g. vendor only) is essentially
      // useless for reconciliation. We require both conditions to be careful
      // not to flag legitimately sparse credits/adjustments.
      if (filledCount <= 1 && !hasLines) {
        llmFailureReason = `parsed but mostly empty (filled ${filledCount}/4 critical fields, no line items) — likely truncation or scan quality`;
      }
    }
  }

  // FORCE_REAL_INVOICE=1 (set by /api/skipped/:id/restore) overrides the LLM's
  // is_real_invoice=false verdict so the same PDF lands as a normal invoice.
  if (llmResult && !llmResult.is_real_invoice && process.env.FORCE_REAL_INVOICE === "1") {
    (llmResult as any).is_real_invoice = true;
  }

  // Skip non-invoices flagged by the LLM. We KEEP the PDF on disk and
  // record a row in skipped_uploads so the user can review/restore mistakes
  // (the LLM occasionally misclassifies real invoices as statements/autopay).
  if (llmResult && !llmResult.is_real_invoice) {
    try {
      recordSkippedUpload({
        pdf_url: filename,
        original_filename: input.originalFilename || null,
        source: input.source,
        email_id: null,
        email_from: input.emailFrom || null,
        email_subject: input.emailSubject || null,
        email_date: input.emailDate || null,
        llm_document_type: llmResult.document_type || null,
        llm_skip_reason: llmResult.skip_reason || null,
        llm_notes: llmResult.notes || null,
        llm_vendor_raw_name: llmResult.vendor_raw_name || null,
        llm_total: typeof llmResult.total === "number" ? llmResult.total : null,
        llm_invoice_number: llmResult.invoice_number || null,
      });
    } catch (e: any) {
      console.warn(`[pipeline] failed to record skipped upload: ${e.message}`);
    }
    return {
      status: "skipped_non_invoice",
      invoice_id: null,
      vendor_qbo_name: null,
      vendor_match_status: null,
      reason: `${llmResult.document_type}${llmResult.skip_reason ? ` — ${llmResult.skip_reason}` : ""}`,
    };
  }

  // PR #R4h — Deterministic terms-parsing fallback. The LLM is inconsistent
  // about populating the discount_terms_pct/days/due_date/kind fields when it
  // sees a "2% 10 Net 30" style string in the terms text — same PDF + same
  // prompt sometimes produces structured fields, sometimes only the verbatim
  // string. Regex-parse the verbatim text and fill any gaps the LLM left,
  // preserving anything the LLM did populate correctly.
  // Triggering case: EC Woods invoice QS 7193, terms "2% 10 - Net 30".
  if (llmResult?.payment_terms) {
    const fallback = parsePaymentTermsFallback(llmResult.payment_terms, llmResult.invoice_date);
    if (fallback) {
      const filled: string[] = [];
      if (llmResult.discount_terms_pct == null && fallback.discount_terms_pct != null) {
        llmResult.discount_terms_pct = fallback.discount_terms_pct;
        filled.push("discount_terms_pct");
      }
      if (llmResult.discount_days == null && fallback.discount_days != null) {
        llmResult.discount_days = fallback.discount_days;
        filled.push("discount_days");
      }
      if (!llmResult.discount_due_date && fallback.discount_due_date) {
        llmResult.discount_due_date = fallback.discount_due_date;
        filled.push("discount_due_date");
      }
      if (!llmResult.discount_kind && fallback.discount_kind) {
        llmResult.discount_kind = fallback.discount_kind;
        filled.push("discount_kind");
      }
      // due_date: only fill if the LLM left it null AND the fallback produced
      // one. The verbatim "Net 30" with no LLM due_date is exactly the gap
      // this catches.
      if (!llmResult.due_date && fallback.due_date) {
        llmResult.due_date = fallback.due_date;
        filled.push("due_date");
      }
      if (filled.length > 0) {
        // invoiceId isn't assigned yet at this point in the pipeline (id is
        // derived from filename later); the invoice_number / vendor are the
        // most useful identifiers at this stage.
        const tag = llmResult.invoice_number ?? llmResult.vendor_raw_name ?? "?";
        console.log(
          `[terms-fallback] ${tag}: filled ${filled.join(",")} from "${llmResult.payment_terms}"`,
        );
      }
    }
  }

  // Build parsed_data
  const parsed_data = llmResult ? {
    vendor_raw_name: llmResult.vendor_raw_name,
    invoice_number: llmResult.invoice_number,
    invoice_date: llmResult.invoice_date,
    // v8.1: due_date — separate from invoice_date (document date). Drives the
    // Inbox "Due" column and is sent to QBO as Bill.DueDate at posting time.
    due_date: normalizeDueDate(llmResult.due_date, llmResult.invoice_date),
    total: llmResult.total,
    low_confidence: llmResult.parse_confidence === "low",
    freight: llmResult.freight ?? 0,
    is_credit: llmResult.is_credit,
    // PR #R4k — verbatim terms phrase ("Net 30", "Pre-Pay", "2% 10 Net 30"). Was
    // previously consumed in-memory by the fallback regexes and discarded.
    payment_terms: llmResult.payment_terms ?? null,
  } : {
    vendor_raw_name: null,
    invoice_number: null,
    invoice_date: null,
    due_date: null,
    total: null,
    low_confidence: true,
    freight: 0,
    is_credit: false,
    payment_terms: null,
  };

  // ---- Vendor matching: local first, then Claude fallback ----
  let vendorMatch = smartMatchVendor(parsed_data.vendor_raw_name);
  let vendorMatchStatus: string = vendorMatch?.vendor_match_status || "unmatched";
  let vendorQboId: string | null = vendorMatch?.vendor_qbo_id || null;
  let vendorQboName: string | null = vendorMatch?.vendor_qbo_name || null;

  if (!vendorMatch && parsed_data.vendor_raw_name && isVendorMatcherLlmEnabled()) {
    try {
      const llmMatch = await matchVendorWithLlm(parsed_data.vendor_raw_name);
      if (llmMatch?.vendor_qbo_id && llmMatch.confidence === "high") {
        vendorQboId = llmMatch.vendor_qbo_id;
        vendorQboName = llmMatch.vendor_qbo_name;
        vendorMatchStatus = "aliased";
        learnVendorAlias(parsed_data.vendor_raw_name, llmMatch.vendor_qbo_id, llmMatch.vendor_qbo_name || "", "learned-from-llm-high-confidence");
      }
    } catch {}
  }

  const shipToStore = resolveShipToStore(llmResult?.store_hint || null, vendorQboId);

  const invoiceId = `${prefix}_${safeName.replace(/\.pdf$/i, "")}`;
  const now = new Date().toISOString();
  const db = getDb();

  // ---- Internal dedup ----
  // First: exact match on (vendor + invoice_number + total) — fastest path,
  // matches Gmail poller behavior. Second: fuzzy match (Levenshtein on
  // normalized invoice numbers + total/date proximity) to catch OCR typos.
  if (parsed_data.invoice_number && parsed_data.total != null) {
    try {
      const rawTrim = (parsed_data.vendor_raw_name || "").trim();
      const dupRawLike = rawTrim ? `%${rawTrim.slice(0, 30)}%` : null;
      const existing = db.prepare(
        `SELECT id FROM invoices
         WHERE invoice_number = ? AND total = ?
           AND (
             (? IS NOT NULL AND vendor_qbo_id = ?)
             OR (? IS NOT NULL AND vendor_raw_name LIKE ?)
             OR (vendor_qbo_id IS NULL AND (vendor_raw_name IS NULL OR TRIM(vendor_raw_name) = '' OR ? IS NULL))
           )
         LIMIT 1`
      ).get(
        parsed_data.invoice_number,
        parsed_data.total,
        vendorQboId, vendorQboId,
        dupRawLike, dupRawLike,
        dupRawLike,
      ) as { id: string } | undefined;
      if (existing) {
        try { fs.unlinkSync(filePath); } catch {}
        db.close();
        return {
          status: "duplicate_internal",
          invoice_id: existing.id,
          vendor_qbo_name: vendorQboName,
          vendor_match_status: vendorMatchStatus,
          reason: `Already exists as ${existing.id}`,
        };
      }
    } catch {}
  }

  // Fuzzy match — only block ingest at confidence ≥ 90 (essentially the same
  // invoice number with 1–2 OCR substitutions). Lower-confidence hits get
  // flagged via duplicate_check_status so the user sees them in the drawer.
  let fuzzyHit: ReturnType<typeof findDuplicateInvoice> = null;
  if (parsed_data.invoice_number) {
    try {
      fuzzyHit = findDuplicateInvoice(db, {
        vendorQboId,
        vendorRawName: parsed_data.vendor_raw_name,
        invoiceNumber: parsed_data.invoice_number,
        total: parsed_data.total,
        invoiceDate: parsed_data.invoice_date,
      });
      if (fuzzyHit && fuzzyHit.confidence >= 90) {
        try { fs.unlinkSync(filePath); } catch {}
        db.close();
        return {
          status: "duplicate_internal",
          invoice_id: fuzzyHit.id,
          vendor_qbo_name: vendorQboName,
          vendor_match_status: vendorMatchStatus,
          reason: `Likely duplicate of ${fuzzyHit.id} (${fuzzyHit.confidence}%): ${fuzzyHit.reason}`,
        };
      }
    } catch (e) {
      console.warn(`[pipeline] fuzzy dup check failed:`, (e as Error).message);
    }
  }

  // ---- Insert ----
  // Persist a low-confidence fuzzy hint as JSON so the drawer can surface it.
  const fuzzyHintJson =
    fuzzyHit && fuzzyHit.confidence < 90
      ? JSON.stringify({
          matched_invoice_id: fuzzyHit.id,
          matched_invoice_number: fuzzyHit.invoice_number,
          confidence: fuzzyHit.confidence,
          reason: fuzzyHit.reason,
        })
      : null;

  // v8.4.5: discount fields. For net_with_discount kind the discount is
  // automatic per spec — flip discount_applied=1 at ingest. For early_pay the
  // user chooses in the drawer, so we leave applied=0.
  const discountAppliedInitial = llmResult?.discount_kind === "net_with_discount" ? 1 : 0;

  db.prepare(`
    INSERT OR IGNORE INTO invoices (
      id, source_file, email_id, email_date, email_from, email_subject,
      pdf_url, vendor_raw_name, vendor_match_status, vendor_qbo_id, vendor_qbo_name,
      invoice_number, invoice_date, due_date, total, freight, is_credit,
      ship_to_store, parse_confidence, status, routing_mode, routing_data, duplicate_check_status,
      created_at, updated_at,
      document_type, store_hint, llm_notes, already_paid, line_items_json, bill_kind,
      parse_failure_reason, source_type, fuzzy_dup_hint,
      discount_terms_pct, discount_days, discount_due_date, discount_kind, discount_warning, discount_applied,
      payment_terms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    invoiceId,
    `${prefix}_${safeName.replace(/\.pdf$/i, "")}.txt`,
    `source:${input.source}`,
    input.emailDate || null,
    input.emailFrom || null,
    input.emailSubject || null,
    filename,
    parsed_data.vendor_raw_name,
    vendorMatchStatus,
    vendorQboId,
    vendorQboName,
    parsed_data.invoice_number,
    parsed_data.invoice_date,
    parsed_data.due_date,
    parsed_data.total,
    parsed_data.freight,
    parsed_data.is_credit ? 1 : 0,
    shipToStore,
    llmResult?.parse_confidence || (parsed_data.low_confidence ? "low" : "medium"),
    "pending_review",
    "single_store",
    shipToStore ? JSON.stringify({ store: shipToStore }) : null,
    "unchecked",
    now, now,
    llmResult?.document_type || null,
    llmResult?.store_hint || null,
    llmResult?.notes || null,
    llmResult?.already_paid ? 1 : 0,
    llmResult ? JSON.stringify(llmResult.line_items) : null,
    llmResult?.bill_kind || null,
    llmFailureReason,
    input.sourceType || null,
    fuzzyHintJson,
    llmResult?.discount_terms_pct ?? null,
    llmResult?.discount_days ?? null,
    llmResult?.discount_due_date ?? null,
    llmResult?.discount_kind ?? null,
    llmResult?.discount_warning ?? null,
    discountAppliedInitial,
    parsed_data.payment_terms
  );

  // ---- Persist parsed line items into invoice_line_items so the Routing
  // "Line items" tab is enabled in the drawer.
  // PR #R4k — previously a silent console.warn. Royal Teak INV-01482 had 6
  // line items in line_items_json but 0 rows in invoice_line_items, with no
  // log evidence. Now we error-log AND surface to the UI via
  // parse_failure_reason so the orange banner shows up.
  try {
    if (Array.isArray(llmResult?.line_items) && llmResult!.line_items.length > 0) {
      replaceInvoiceLineItems(invoiceId, llmResult!.line_items as any);
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[pipeline] line-item persist FAILED for ${invoiceId}: ${msg}`);
    try {
      db.prepare(
        `UPDATE invoices SET parse_failure_reason = COALESCE(parse_failure_reason || ' | ', '') || ? WHERE id = ?`
      ).run(`line-item persist failed: ${msg}`, invoiceId);
    } catch (inner) {
      console.error(`[pipeline] failed to record line-item persist failure: ${(inner as Error).message}`);
    }
  }

  // ---- Audit log: every LLM parse attempt (success or failure) ----
  try {
    if (isLlmParserEnabled()) {
      const parseAfter = llmResult
        ? JSON.stringify({
            ok: true,
            vendor_raw_name: llmResult.vendor_raw_name,
            invoice_number: llmResult.invoice_number,
            total: llmResult.total,
            parse_confidence: llmResult.parse_confidence,
            document_type: llmResult.document_type,
            line_item_count: Array.isArray(llmResult.line_items) ? llmResult.line_items.length : 0,
          })
        : JSON.stringify({ ok: false, reason: llmFailureReason || "unknown" });
      db.prepare(`INSERT INTO audit_log (invoice_id, action, before, after, user_email, created_at) VALUES (?,?,?,?,?,?)`)
        .run(invoiceId, "llm_parse", null, parseAfter, "system@parser", now);
    }
  } catch (e) {
    // PR #R4k — was previously a silent `catch {}`. Royal Teak INV-01482 had 0
    // llm_parse audit rows despite a successful parse — we want this to be
    // visible in the logs so we can find the schema constraint that's tripping.
    console.error(`[pipeline] audit_log llm_parse write failed for ${invoiceId}: ${(e as Error).message}`);
  }

  // Audit log entry recording the source
  try {
    db.prepare(`INSERT INTO audit_log (invoice_id, action, before, after, user_email, created_at) VALUES (?,?,?,?,?,?)`)
      .run(invoiceId, `ingest_${input.source.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`,
        null,
        JSON.stringify({ source: input.source, originalFilename: input.originalFilename }),
        "system@ingest",
        now);
  } catch (e) {
    console.error(`[pipeline] audit_log ingest write failed for ${invoiceId}: ${(e as Error).message}`);
  }

  // ---- Auto QBO duplicate check ----
  let finalStatus: PipelineResult["status"] = "ingested";
  if (parsed_data.invoice_number) {
    try {
      const qboState = getQboStatus();
      if (qboState.connected) {
        const bills = await searchBills([parsed_data.invoice_number]);
        const payments = await searchPayments([parsed_data.invoice_number]);
        if (bills.length > 0 || payments.length > 0) {
          const firstBill = bills[0];
          const billId = firstBill?.Id || null;
          const billTotal = Number(firstBill?.TotalAmt || 0);
          const billBalance = Number(firstBill?.Balance ?? billTotal);
          let paymentLabel = "";
          if (firstBill) {
            if (billBalance <= 0.005) paymentLabel = " — PAID";
            else if (billBalance < billTotal) paymentLabel = ` — partially paid ($${billBalance.toFixed(2)} open)`;
            else paymentLabel = " — unpaid";
          }
          const paymentId = payments[0]?.Id || null;
          const note = [
            bills.length > 0 ? `Auto-skipped at ingest: Bill #${billId} already in QBO${paymentLabel}` : null,
            payments.length > 0 ? `BillPayment #${paymentId} found` : null,
          ].filter(Boolean).join("; ");
          db.prepare(`UPDATE invoices SET status = ?, duplicate_check_status = ?, duplicate_check_at = ?, qbo_bill_id = ?, notes = ?, updated_at = ? WHERE id = ?`)
            .run("posted_qbo", "duplicate_found", new Date().toISOString(), billId, note, new Date().toISOString(), invoiceId);
          db.prepare(`INSERT INTO audit_log (invoice_id, action, before, after, user_email, created_at) VALUES (?,?,?,?,?,?)`)
            .run(invoiceId, "auto_skip_existing_qbo_bill",
              JSON.stringify({ status: "pending_review" }),
              JSON.stringify({ status: "posted_qbo", qbo_bill_id: billId, note }),
              "system@ingest",
              new Date().toISOString());
          finalStatus = "duplicate_qbo";
        } else {
          db.prepare(`UPDATE invoices SET duplicate_check_status = ?, duplicate_check_at = ?, updated_at = ? WHERE id = ?`)
            .run("clean", new Date().toISOString(), new Date().toISOString(), invoiceId);
        }
      }
    } catch {}
  }

  db.close();

  return {
    status: finalStatus,
    invoice_id: invoiceId,
    vendor_qbo_name: vendorQboName,
    vendor_match_status: vendorMatchStatus,
    reason: null,
  };
}
