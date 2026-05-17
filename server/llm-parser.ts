/**
 * LLM-based invoice parser using Claude Haiku.
 *
 * Replaces regex-based heuristics with multimodal reasoning:
 *   - Reads the PDF natively (vision)
 *   - Considers email subject + body for context
 *   - Returns structured invoice data + classification
 *   - Knows the difference between bills, sales orders, statements, $0 warranties, CC purchases
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY                 – Claude API key
 *   LLM_PARSER_MODEL                  – default "claude-haiku-4-5"
 *   LLM_PARSER_DISABLED               – set to "1" to bypass and use regex fallback
 *
 * Cost: ~$0.01–0.02 per invoice with Haiku.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5";

export interface LLMParsedInvoice {
  // Classification
  is_real_invoice: boolean;
  document_type:
    | "invoice"
    | "sales_order"
    | "statement"
    | "warranty_replacement"
    | "credit_card_purchase"
    | "credit_memo"
    | "receipt"
    | "shipment_notification"
    | "autopay"
    | "other";
  skip_reason: string | null;

  // Core fields
  vendor_raw_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null; // YYYY-MM-DD
  due_date: string | null;     // YYYY-MM-DD
  total: number | null;
  subtotal: number | null;
  freight: number | null;
  tax: number | null;
  is_credit: boolean;
  payment_method: string | null; // e.g. "VISA", "ACH" (payment instrument only)
  payment_terms: string | null;  // verbatim terms text, e.g. "Net 30", "Due on Receipt", "2% 10 Net 30"
  // v8.4.5: discount-terms support. Always reflects what was detected on the
  // invoice; whether to actually apply it is a user decision (discount_applied
  // flag on the invoices row, toggled from the drawer UI before posting to QBO).
  discount_terms_pct: number | null;     // e.g. 2 for "2% 10 Net 30", 10 for "Net 90 10%"
  discount_days: number | null;          // window from invoice_date to discount_due_date
  discount_due_date: string | null;      // YYYY-MM-DD when the discount window closes
  discount_warning: string | null;       // non-null when match is ambiguous — surfaces a UI chip
  discount_kind: "early_pay" | "net_with_discount" | null;
  // "early_pay"          → e.g. "2% 10 Net 30" — user CHOOSES discount vs. full Net
  // "net_with_discount"  → e.g. "Net 90 10%" — discount is automatic, due_date = net days
  already_paid: boolean;

  // Line items (helpful for inventory routing)
  line_items: Array<{
    sku: string | null;
    description: string;
    quantity: number | null;
    unit_price: number | null;
    amount: number;
    suggested_category: "inventory" | "freight" | "tax" | "discount" | "expense" | "other";
    suggested_account_id: string | null; // QBO Account.Id for expense lines
    suggested_account_name: string | null; // human-readable account name
  }>;

  // Routing hints (from system rules)
  store_hint: "Greenvale" | "Hempstead" | "Huntington" | "unknown";
  vendor_alias_applied: string | null; // e.g. "N-Brands → Nikkie"
  bill_kind: "inventory" | "expense" | "mixed" | "unknown"; // top-level routing decision

  // Confidence
  parse_confidence: "high" | "medium" | "low";
  notes: string | null;
}

const SYSTEM_PROMPT = `You are an accounts-payable invoice parser for Sno-Haus, a ski/outdoor retailer with three stores (Greenvale, Hempstead, Huntington).

Your job: read an email + PDF attachment and decide if it is a REAL invoice/bill that needs to be posted to QuickBooks. Sno-Haus has BOTH inventory bills (skis, boots, parts) AND expense bills (rent, utilities, payroll fees, legal, R&M). Both kinds are real bills and both must post to QuickBooks — but they route to different accounts.

DOCUMENT CLASSIFICATION (set is_real_invoice):
- Sales Order / Order Confirmation / Statement of Account / Shipment Notification / Login Link → is_real_invoice=false
- $0.00 total with 100% discount → warranty_replacement, is_real_invoice=false
- AUTOPAY VENDORS (skip, don't queue): ADP, Waste Management, internet providers, telephone/phone providers → is_real_invoice=false, document_type="autopay", skip_reason="Autopay vendor — not posted to AP queue". These vendors are paid automatically and don't need manual review.
- Real invoice/bill (inventory OR expense, not autopay) → is_real_invoice=true
- Credit memo or negative amount → is_credit=true, document_type="credit_memo", is_real_invoice=true
- Already paid via credit card (VISA/AMEX/etc on the invoice) → already_paid=true, document_type="credit_card_purchase", is_real_invoice=true

AUTOPAY VENDOR LIST (always skip these — set is_real_invoice=false):
- ADP / run.payroll.invoice@adp.com / payroll service fees
- Waste Management / waste.com / garbage / recycling carriers
- ALL UTILITIES (autopay) — these include but are not limited to:
  - Electric: PSEG, Con Edison, ConEd, National Grid Electric, any electric utility
  - Gas: National Grid Gas, gas utility, propane delivery on auto-renewal
  - Water / Sewer: any municipal water authority, sewer authority
  - Internet: Optimum, Spectrum, Verizon Fios, Altice, Comcast, Xfinity, ISP bills
  - Telephone: Verizon, AT&T, T-Mobile, RingCentral, mobile phone bills, landline bills
  - Cable / TV providers

IF a bill comes from any utility provider (electric, gas, water, internet, phone, cable, sewer) → set is_real_invoice=false, document_type="autopay", skip_reason="Autopay vendor — not posted to AP queue". Do not route to any expense account.

BILL_KIND (top-level routing decision):
- "inventory" — product-for-resale invoices from brand vendors (Elevate/K2/Volkl/Thule/Bogner/Nikkie/Royal Teak/Treasure Garden/Revo/etc). May include freight/tax lines.
- "expense" — operating expenses: rent, utilities, payroll service, legal, accounting, R&M, software, freight carriers (FedEx/UPS standalone), etc.
- "mixed" — a single bill with both inventory AND expense lines (rare, but possible)
- "unknown" — can't tell

PER-LINE-ITEM ROUTING:
For each line item, set suggested_category AND (where applicable) suggested_account_id + suggested_account_name from this list:

  EXPENSE ACCOUNTS (use exact Id strings):
  - Rent & Lease (general) → Id "17"
  - Amityville Warehouse Rent → Id "1150040010"
  - Woodbury Warehouse Rent → Id "151"   ← KrownPoint / ARJI Woodbury LLC / 100 Crossways Park Dr W storage rent goes here
  - Storage Costs → Id "137"
  - Repairs & Maintenance → Id "18"
  - Legal & Professional Services → Id "12"
  - Accountant Fees → Id "140"
  - Payroll Wage Expenses → Id "89" (only for direct wage entries, NOT ADP fees — ADP is autopay)
  - Software & Subscriptions → Id "33"
  - (Utilities, electric, gas, internet, phone, cable, water, ADP, Waste Mgmt are AUTOPAY — do not route, skip the bill)
  - Insurance → Id "10"
  - Bank Charges & Fees → Id "8"
  - Credit Card Processing Fees → Id "62"
  - Shipping, Freight & Delivery → Id "66"   ← only for STANDALONE freight bills (FedEx Freight, UPS billing). Freight LINES on inventory invoices stay with the inventory bill.
  - Office Supplies → Id "15"
  - Store Supplies → Id "67"
  - Workshop Supplies → Id "130"
  - Advertising & Marketing → Id "6"
  - Computer Expense → Id "121"

  INVENTORY ACCOUNTS (only for inventory line items, by store):
  - Greenvale Inventory → Id "38"
  - Hempstead Inventory → Id "1150040012"
  - Huntington Inventory → Id "1150040011"

ROUTING DECISION TABLE for common vendors:
- KrownPoint / ARJI Woodbury LLC → bill_kind="expense", route ALL lines to Woodbury Warehouse Rent (Id 151)
- ADP → AUTOPAY (skip)
- Waste Management / garbage / recycling → AUTOPAY (skip)
- ALL utilities — PSEG, ConEd, National Grid, water, sewer, internet, phone, cable → AUTOPAY (skip)
- FedEx Freight standalone bill → bill_kind="expense", Shipping Freight & Delivery (Id 66)
- Inventory brand vendors (Elevate, Thule for product, K2, Volkl, etc) → bill_kind="inventory". Inventory items get inventory account by store_hint. Freight lines get suggested_category="freight". Tax gets suggested_category="tax".
- Law firms / CPAs / consultants → bill_kind="expense", Legal & Professional Services (Id 12) or Accountant Fees (Id 140)
- Repairs/contractors/maintenance → bill_kind="expense", Repairs & Maintenance (Id 18)

VENDOR ALIASES:
- "N-Brands" → Nikkie. Set vendor_alias_applied="N-Brands → Nikkie".

STORE ROUTING (for store_hint AND inventory account selection):
- Greenvale = 47 Northern Blvd, Greenvale NY. Inventory account 38.
- Huntington = 2 West Jericho Tpke, Huntington Station NY. Inventory account 1150040011.
- Hempstead = anything else NY tied to Sno-Haus / SD Ski and Patio. Inventory account 1150040012.
- KrownPoint storage at 100 Crossways Park Dr W Woodbury → store_hint="Greenvale" (it's the Greenvale store's storage), but the bill_kind is expense (rent), not inventory.

ADDITIONAL RULES:
- Ignore Shopify-inventory-account entirely.
- Internal forwards from snohaus.com employees are typically order confirmations or sales orders, examine carefully.
- Sometimes a bill needs line-item splits (e.g. one Bogner invoice covers Greenvale + Hempstead). Keep each line as its own item with the right suggested_account_id.

DUE_DATE EXTRACTION (critical — drives AP aging):
- invoice_date = the document/issue date printed on the invoice ("Invoice Date", "Date", header date).
- due_date = the date payment is owed by. NEVER copy invoice_date into due_date.
- payment_terms = the verbatim terms string as printed ("Net 30", "Net 15", "Net 45", "Net 60", "Net 90", "2% 10 Net 30", "Due on Receipt", "COD", "Prepaid", etc). Look in a "Terms" column/row, near the totals block, or on the customer-info band.
- ALWAYS populate payment_terms when any terms text is visible on the invoice, even if you also extract an explicit due_date.
- Look for explicit due-date labels: "Due Date", "Payment Due", "Pay By", "Net Due Date", "Due".
- If only payment terms are listed (no explicit due date), COMPUTE due_date deterministically:
    "Net N" / "Net-N" / "NETN" / "N days" / "Due in N days"  → due_date = invoice_date + N days
    "Due on Receipt" / "Upon Receipt" / "COD" / "Prepaid"     → due_date = invoice_date
    "2% 10 Net 30" (early-pay discount)                       → due_date = invoice_date + 30 days (use the Net portion)
- Examples:
    Terms="Net 30", invoice_date=2026-05-12 → due_date=2026-06-11
    Terms="Net 60", invoice_date=2026-05-01 → due_date=2026-06-30
    Terms="Due on Receipt", invoice_date=2026-05-12 → due_date=2026-05-12
- If both an explicit due date AND terms appear, prefer the explicit due date (but still emit payment_terms).
- If no due date and no terms are present at all, return due_date=null and payment_terms=null — do NOT guess.
- Always emit due_date as YYYY-MM-DD.

Return ONLY valid JSON matching the schema. No prose. No markdown.`;

const SCHEMA_HINT = `{
  "is_real_invoice": boolean,
  "document_type": "invoice" | "sales_order" | "statement" | "warranty_replacement" | "credit_card_purchase" | "credit_memo" | "receipt" | "shipment_notification" | "autopay" | "other",
  "skip_reason": string or null,
  "vendor_raw_name": string or null,
  "invoice_number": string or null,
  "invoice_date": "YYYY-MM-DD" or null,
  "due_date": "YYYY-MM-DD" or null,
  "payment_terms": string or null,
  "total": number or null,
  "subtotal": number or null,
  "freight": number or null,
  "tax": number or null,
  "is_credit": boolean,
  "payment_method": string or null,
  "already_paid": boolean,
  "bill_kind": "inventory"|"expense"|"mixed"|"unknown",
  "line_items": [{"sku": string or null, "description": string, "quantity": number or null, "unit_price": number or null, "amount": number, "suggested_category": "inventory"|"freight"|"tax"|"discount"|"expense"|"other", "suggested_account_id": string or null, "suggested_account_name": string or null}],
  "store_hint": "Greenvale"|"Hempstead"|"Huntington"|"unknown",
  "vendor_alias_applied": string or null,
  "parse_confidence": "high"|"medium"|"low",
  "notes": string or null
}`;

export function isLlmParserEnabled(): boolean {
  if (process.env.LLM_PARSER_DISABLED === "1") return false;
  return !!process.env.ANTHROPIC_API_KEY;
}

// ---- Module-level throttle + last-error reporter ----
// Tier 1 Anthropic: 50 RPM, 50K input tokens/min, 10K output tokens/min.
// Default gap of 1500ms between calls (~40 RPM) leaves headroom; concurrency
// env LLM_PARSER_CONCURRENCY allows up to N parallel requests (default 1).
const MIN_GAP_MS = Number(process.env.LLM_PARSER_MIN_GAP_MS || 1500);
const LLM_CONCURRENCY = Math.max(1, Number(process.env.LLM_PARSER_CONCURRENCY || 1));
let lastCallAt = 0;
// Concurrency-aware queue: limit in-flight calls to LLM_CONCURRENCY, and enforce
// MIN_GAP_MS between successive starts (regardless of in-flight count).
const slots: Promise<void>[] = Array.from({ length: LLM_CONCURRENCY }, () => Promise.resolve());

// Last failure reason for the most recent call (read by gmail.ts to log into skip_reasons)
let _lastLlmFailure: string | null = null;
export function getLastLlmFailure(): string | null { return _lastLlmFailure; }
export function clearLastLlmFailure(): void { _lastLlmFailure = null; }

async function throttle(): Promise<void> {
  // Pick the slot that frees up first.
  let pickIdx = 0;
  let pickPromise = slots[0];
  for (let i = 1; i < slots.length; i++) {
    // simple round-robin-ish: take whichever was set up first
    if (slots[i] !== pickPromise) {
      pickIdx = i;
      pickPromise = slots[i];
      break;
    }
  }
  let release: () => void = () => {};
  const next = new Promise<void>((res) => { release = res; });
  slots[pickIdx] = next;
  await pickPromise;
  // Inter-call gap: enforce MIN_GAP_MS between successive *starts*.
  const now = Date.now();
  const wait = Math.max(0, lastCallAt + MIN_GAP_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
  // Release the slot when the caller's HTTP work has had a chance to start.
  // We release immediately here; the slot serializes *start times* not full lifetimes,
  // because Anthropic rate-limits by RPM not by concurrent connections at this tier.
  setTimeout(() => release(), 0);
}

/**
 * Parse an invoice using Claude Haiku.
 * Returns null if disabled, missing API key, or parsing fails (caller should fall back).
 */
export async function parseInvoiceWithLLM(
  pdfBuffer: Buffer,
  emailContext: { subject?: string | null; from?: string | null; body?: string | null }
): Promise<LLMParsedInvoice | null> {
  if (!isLlmParserEnabled()) return null;

  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const model = process.env.LLM_PARSER_MODEL || DEFAULT_MODEL;

  const userText = `Email subject: ${emailContext.subject || "(none)"}
Email from: ${emailContext.from || "(none)"}
Email body (truncated): ${(emailContext.body || "").slice(0, 1500)}

The PDF attachment is provided. Classify and extract per the schema below. Return ONLY JSON, no prose.

Schema:
${SCHEMA_HINT}`;

  const body = {
    model,
    // Bumped from 2048 → 8192 (Round 7, 4/28/2026). Fox River Mills 3-page invoice with
    // 30+ line items was getting truncated mid-JSON, JSON.parse threw, we silently fell
    // back to all-null fields. Haiku 4.5 supports up to 8192 output tokens with no extra
    // cost beyond what's actually emitted, so this is free headroom for big invoices.
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBuffer.toString("base64"),
            },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  };

  // Serialize + throttle to stay under free-tier rate limits.
  await throttle();

  let response: Response;
  let attempts = 0;
  const MAX_ATTEMPTS = 3;

  while (true) {
    attempts++;
    try {
      response = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      _lastLlmFailure = `network error: ${err.message}`;
      console.error("[LLM Parser] Network error:", err.message);
      return null;
    }

    // Auto-retry on 429 (rate limit) and 529 (overloaded). Honor Retry-After header.
    if ((response.status === 429 || response.status === 529) && attempts < MAX_ATTEMPTS) {
      // Log Anthropic-specific reset headers so we can tune throttling.
      const retryAfterHeader = response.headers.get("retry-after");
      const inputReset = response.headers.get("anthropic-ratelimit-input-tokens-reset");
      const outputReset = response.headers.get("anthropic-ratelimit-output-tokens-reset");
      const requestsReset = response.headers.get("anthropic-ratelimit-requests-reset");
      const inputRemaining = response.headers.get("anthropic-ratelimit-input-tokens-remaining");
      const requestsRemaining = response.headers.get("anthropic-ratelimit-requests-remaining");
      console.error(
        `[LLM Parser] HTTP ${response.status} rate-limit headers: ` +
        `retry-after=${retryAfterHeader || "-"} ` +
        `input-reset=${inputReset || "-"} input-remaining=${inputRemaining || "-"} ` +
        `output-reset=${outputReset || "-"} ` +
        `requests-reset=${requestsReset || "-"} requests-remaining=${requestsRemaining || "-"}`
      );
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const waitMs = (Number.isFinite(retryAfterSec) ? retryAfterSec : 30) * 1000;
      console.error(`[LLM Parser] HTTP ${response.status} — backing off ${waitMs}ms before retry ${attempts + 1}/${MAX_ATTEMPTS}`);
      await new Promise((r) => setTimeout(r, waitMs));
      lastCallAt = Date.now();
      continue;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      _lastLlmFailure = `HTTP ${response.status}: ${errText.slice(0, 200)}`;
      console.error(`[LLM Parser] HTTP ${response.status}: ${errText.slice(0, 500)}`);
      return null;
    }

    break;
  }

  let json: any;
  try {
    json = await response.json();
  } catch (err: any) {
    console.error("[LLM Parser] JSON decode error:", err.message);
    return null;
  }

  // Surface truncation explicitly. stop_reason="max_tokens" means Claude was still
  // generating when we cut her off. Without this guard the response is unparseable
  // JSON and we silently fall back to all-null fields.
  const stopReason = json.stop_reason || null;
  if (stopReason === "max_tokens") {
    _lastLlmFailure = `output truncated at max_tokens (${body.max_tokens}); raise the limit or simplify schema`;
    console.error(
      `[LLM Parser] Response truncated at max_tokens=${body.max_tokens}. ` +
      `Output was ${(json.usage?.output_tokens ?? "?")} tokens. ` +
      `Bump max_tokens or shorten schema.`
    );
    return null;
  }

  const textBlock = (json.content || []).find((c: any) => c.type === "text");
  if (!textBlock || typeof textBlock.text !== "string") {
    _lastLlmFailure = "no text block in Claude response";
    console.error("[LLM Parser] No text block in response");
    return null;
  }

  // Strip code fences if model added them
  let raw = textBlock.text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    _lastLlmFailure = `output not valid JSON (stop_reason=${stopReason || "unknown"})`;
    console.error(
      `[LLM Parser] Output not valid JSON (stop_reason=${stopReason}, output_tokens=${json.usage?.output_tokens ?? "?"}):`,
      raw.slice(0, 300)
    );
    return null;
  }

  // Coerce/validate minimum shape
  const result: LLMParsedInvoice = {
    is_real_invoice: !!parsed.is_real_invoice,
    document_type: parsed.document_type || "other",
    skip_reason: parsed.skip_reason || null,
    vendor_raw_name: parsed.vendor_raw_name || null,
    invoice_number: parsed.invoice_number || null,
    invoice_date: parsed.invoice_date || null,
    due_date: parsed.due_date || null,
    payment_terms: typeof parsed.payment_terms === "string" && parsed.payment_terms.trim() ? parsed.payment_terms.trim() : null,
    total: typeof parsed.total === "number" ? parsed.total : null,
    subtotal: typeof parsed.subtotal === "number" ? parsed.subtotal : null,
    freight: typeof parsed.freight === "number" ? parsed.freight : null,
    tax: typeof parsed.tax === "number" ? parsed.tax : null,
    is_credit: !!parsed.is_credit,
    payment_method: parsed.payment_method || null,
    already_paid: !!parsed.already_paid,
    bill_kind: parsed.bill_kind || "unknown",
    line_items: Array.isArray(parsed.line_items)
      ? parsed.line_items.map((li: any) => ({
          sku: li.sku || null,
          description: li.description || "",
          quantity: typeof li.quantity === "number" ? li.quantity : null,
          unit_price: typeof li.unit_price === "number" ? li.unit_price : null,
          amount: typeof li.amount === "number" ? li.amount : 0,
          suggested_category: li.suggested_category || "other",
          suggested_account_id: li.suggested_account_id || null,
          suggested_account_name: li.suggested_account_name || null,
        }))
      : [],
    store_hint: parsed.store_hint || "unknown",
    vendor_alias_applied: parsed.vendor_alias_applied || null,
    parse_confidence: parsed.parse_confidence || "medium",
    notes: parsed.notes || null,
  };

  // Deterministic post-parse fallback: derive due_date from payment_terms when
  // the LLM forgot. Drives AP aging — we'd rather compute Net 30 ourselves than
  // leave it blank.
  if (!result.due_date && result.invoice_date) {
    const computed = computeDueDateFromTerms(
      result.invoice_date,
      result.payment_terms || result.payment_method || ""
    );
    if (computed) {
      result.due_date = computed;
      result.notes = (result.notes ? result.notes + " " : "") +
        `[auto] due_date computed from terms "${result.payment_terms || result.payment_method}"`;
    }
  }

  // v8.4.5 — Option A: when the LLM doesn't surface payment_terms (it often
  // narrates the math into `notes` instead), scan the raw PDF text directly.
  // We extract once with pdf-parse, then run both due_date AND discount detection
  // against the full text. Cheap, deterministic, and doesn't trust the LLM.
  let rawPdfText: string | null = null;
  if (!result.due_date && result.invoice_date) {
    rawPdfText = await safeExtractPdfText(pdfBuffer);
    if (rawPdfText) {
      const fromRaw = computeDueDateFromTerms(result.invoice_date, rawPdfText);
      if (fromRaw) {
        result.due_date = fromRaw;
        const snippet = findTermsSnippet(rawPdfText) || "raw PDF text";
        result.notes = (result.notes ? result.notes + " " : "") +
          `[auto] due_date computed from PDF text ("${snippet}")`;
      }
    }
  }

  // Discount-terms detection. Try the LLM-emitted payment_terms first, then fall
  // back to the raw PDF text. Always emit on result so the UI can surface a chip
  // (with warning if ambiguous, per user spec).
  const discountSource = result.payment_terms
    || (rawPdfText ?? (rawPdfText = await safeExtractPdfText(pdfBuffer)))
    || "";
  const detected = detectDiscountTerms(discountSource, result.invoice_date);
  result.discount_terms_pct = detected.pct;
  result.discount_days = detected.days;
  result.discount_due_date = detected.dueDate;
  result.discount_kind = detected.kind;
  result.discount_warning = detected.warning;
  // If kind = net_with_discount the LLM may not have set a due_date or may have
  // set the net portion; either way, due_date IS the net days (already handled).

  return result;
}

/** Extract text from PDF buffer; never throws. Returns null on failure. */
async function safeExtractPdfText(pdfBuffer: Buffer): Promise<string | null> {
  try {
    // Lazy require to avoid loading pdf-parse on every cold start.
    const pdfParse = require("pdf-parse");
    const out = await pdfParse(pdfBuffer);
    const text = (out?.text || "").replace(/\s+/g, " ").trim();
    return text || null;
  } catch (err: any) {
    console.error("[LLM Parser] pdf-parse failed:", err?.message || err);
    return null;
  }
}

/** Best-effort snippet of the terms region of the PDF text, for audit notes. */
function findTermsSnippet(text: string): string | null {
  const m = text.match(/(.{0,30}(?:net[\s\-]?\d{1,3}|due\s*(?:on|upon)?\s*receipt|\d{1,2}\s*%\s*\d{1,3}\s*net\s*\d{1,3}).{0,30})/i);
  return m ? m[1].trim().slice(0, 80) : null;
}

/**
 * Detect early-pay or net-with-discount terms in a free-form string.
 * Returns the discount percentage, the discount-window days, the computed
 * discount_due_date, and a "kind" indicator.
 *
 * Recognized formats:
 *   "2% 10 Net 30"      → early_pay, pct=2,  days=10, kind="early_pay"
 *   "2/10 Net 30"       → early_pay, pct=2,  days=10
 *   "2% 10 Days Net 30" → early_pay
 *   "Net 90 10%"        → net_with_discount, pct=10, days=90
 *   "Net 45 3% Discount"→ net_with_discount, pct=3,  days=45
 *
 * The warning is non-null when the regex hit something but the structure is
 * fuzzy enough that the user should eyeball the source PDF before trusting it.
 */
export function detectDiscountTerms(
  source: string | null | undefined,
  invoiceDateISO: string | null,
): {
  pct: number | null;
  days: number | null;
  dueDate: string | null;
  kind: "early_pay" | "net_with_discount" | null;
  warning: string | null;
} {
  const blank = { pct: null, days: null, dueDate: null, kind: null, warning: null } as const;
  if (!source) return { ...blank };
  const t = String(source).toLowerCase();

  // Early-pay style: "2% 10 Net 30" / "2/10 Net 30" / "2% 10 days Net 30"
  // Allow up to ~20 chars between the % and the Net keyword to handle dashes,
  // "days", "-", etc. Sno-Haus EC Woods shows "2% 10 - Net 30".
  const earlyPay = t.match(
    /(\d{1,2})\s*[%\/]\s*(\d{1,3})(?:\s*days?)?[^a-z0-9]{0,20}net[\s\-]*?(\d{1,3})/i
  );
  if (earlyPay) {
    const pct = parseInt(earlyPay[1], 10);
    const discountDays = parseInt(earlyPay[2], 10);
    const netDays = parseInt(earlyPay[3], 10);
    const dueDate = invoiceDateISO ? addDays(invoiceDateISO, discountDays) : null;
    // Sanity: discount window must be < net window
    const warn =
      discountDays >= netDays
        ? `Discount window (${discountDays}d) is not earlier than net window (${netDays}d) — verify terms on the invoice.`
        : pct > 15
        ? `Detected ${pct}% discount — unusually high, double-check the printed terms.`
        : null;
    return { pct, days: discountDays, dueDate, kind: "early_pay", warning: warn };
  }

  // Net-with-discount style: "Net 90 10%" / "Net 45 3% discount"
  const netDisc = t.match(
    /net[\s\-]*?(\d{1,3})[^a-z0-9]{0,10}(\d{1,2})\s*%/i
  );
  if (netDisc) {
    const days = parseInt(netDisc[1], 10);
    const pct = parseInt(netDisc[2], 10);
    // For net_with_discount, the "due date" is just the net date — same as due_date.
    const dueDate = invoiceDateISO ? addDays(invoiceDateISO, days) : null;
    const warn =
      pct > 25
        ? `Detected ${pct}% discount on Net ${days} — unusually high, verify on invoice.`
        : null;
    return { pct, days, dueDate, kind: "net_with_discount", warning: warn };
  }

  return { ...blank };
}

function addDays(invoiceDateISO: string, n: number): string | null {
  const m = invoiceDateISO.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const base = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(base.getTime())) return null;
  const out = new Date(base.getTime() + n * 86400000);
  return `${out.getUTCFullYear()}-${String(out.getUTCMonth() + 1).padStart(2, "0")}-${String(out.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Derive a YYYY-MM-DD due date from an invoice date + free-form terms string.
 * Handles: "Net 30", "Net-30", "NET30", "Net 30 Days", "30 days", "Due in 30 days",
 *          "2% 10 Net 30" (uses Net portion), "Due on Receipt", "Upon Receipt",
 *          "COD", "Prepaid", "Cash on Delivery".
 * Returns null if no recognizable term is found.
 */
export function computeDueDateFromTerms(
  invoiceDateISO: string,
  termsRaw: string | null | undefined
): string | null {
  if (!invoiceDateISO || !termsRaw) return null;
  const m = invoiceDateISO.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const base = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(base.getTime())) return null;

  const t = String(termsRaw).toLowerCase().trim();
  if (!t) return null;

  // Due-on-receipt / COD / Prepaid → same day
  if (
    /\b(due\s*(on|upon)?\s*receipt|upon\s*receipt|on\s*receipt|cod\b|c\.o\.d\.|cash\s*on\s*delivery|prepaid|paid\s*in\s*advance|due\s*now)\b/.test(t)
  ) {
    return invoiceDateISO.slice(0, 10);
  }

  // Try to find a Net N (preferring the "Net" portion of "2% 10 Net 30")
  let days: number | null = null;
  const netMatch = t.match(/net[\s\-]*?(\d{1,3})/);
  if (netMatch) days = parseInt(netMatch[1], 10);

  // "Due in N days" / "N days" / "N day"
  if (days === null) {
    const dueIn = t.match(/(?:due\s*in\s*)?(\d{1,3})\s*day/);
    if (dueIn) days = parseInt(dueIn[1], 10);
  }

  if (days === null || !Number.isFinite(days) || days < 0 || days > 365) return null;

  const due = new Date(base.getTime() + days * 86400000);
  const yyyy = due.getUTCFullYear();
  const mm = String(due.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(due.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
