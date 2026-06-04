/**
 * Gmail IMAP polling for invoice ingestion.
 *
 * Required env vars:
 *   GMAIL_USER                  – Gmail address (e.g. admin@snohaus.com)
 *   GMAIL_APP_PASSWORD          – Google App Password (16 chars, no spaces)
 *   GMAIL_LABEL                 – IMAP label to search (default: "Unreceived Invoices")
 *   GMAIL_POLL_INTERVAL_MINUTES – how often to poll (default: 15)
 *
 * Behavior:
 *   - Connects to imap.gmail.com:993 with SSL
 *   - Searches for messages in the specified label
 *   - Skips already-ingested message IDs (tracked in `ingested_emails` SQLite table)
 *   - Saves PDF attachments to private_assets/
 *   - Parses invoice data using pdf-parse (pure JS)
 *   - Creates a new pending invoice record
 *   - Marks message as processed
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { parseInvoiceWithLLM, isLlmParserEnabled, getLastLlmFailure, clearLastLlmFailure, type LLMParsedInvoice } from "./llm-parser";
import { smartMatchVendor, resolveShipToStore, learnVendorAlias, replaceInvoiceLineItems } from "./storage";
import { matchVendorWithLlm, isVendorMatcherLlmEnabled } from "./vendor-matcher-llm";
import { getQboStatus, searchBills, searchPayments } from "./qbo";

// Types from imapflow / mailparser are loaded dynamically so they don't crash
// if not installed (graceful degradation when env vars are missing).

import { getDbPath } from "./db-path";
const DB_PATH = getDbPath(); // PR #R4j: NSSM-safe path
let _db: ReturnType<typeof Database> | null = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS ingested_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE NOT NULL,
        gmail_uid TEXT,
        subject TEXT,
        from_address TEXT,
        date TEXT,
        pdf_count INTEGER DEFAULT 0,
        invoice_ids TEXT,
        ingested_at TEXT NOT NULL,
        skipped_count INTEGER DEFAULT 0,
        skip_reasons TEXT
      );
    `);
    // Backfill columns if upgrading from older schema
    try { _db.exec("ALTER TABLE ingested_emails ADD COLUMN skipped_count INTEGER DEFAULT 0"); } catch {}
    try { _db.exec("ALTER TABLE ingested_emails ADD COLUMN skip_reasons TEXT"); } catch {}
    // Enrichment columns on invoices for LLM output
    try { _db.exec("ALTER TABLE invoices ADD COLUMN document_type TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN store_hint TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN llm_notes TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN already_paid INTEGER DEFAULT 0"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN line_items_json TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN bill_kind TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN parse_failure_reason TEXT"); } catch {}
    // PR #R4k — payment_terms was extracted by the LLM and used in-memory for
    // discount/due-date regex fallbacks, but never persisted. That made reparse
    // the only way to re-derive due_date and prevented the UI from showing the
    // verbatim terms phrase. Now stored on every ingest + reparse.
    try { _db.exec("ALTER TABLE invoices ADD COLUMN payment_terms TEXT"); } catch {}
  }
  return _db;
}

// ---- Config ----
function getConfig() {
  return {
    user: process.env.GMAIL_USER || "",
    password: process.env.GMAIL_APP_PASSWORD || "",
    label: process.env.GMAIL_LABEL || "Unreceived Invoices",
    pollIntervalMinutes: parseInt(process.env.GMAIL_POLL_INTERVAL_MINUTES || "15", 10),
    // New: scan mode — "inbox" (LLM-gated, recommended), "label" (legacy), "both" (default)
    scanMode: (process.env.GMAIL_SCAN_MODE || "both") as "inbox" | "label" | "both",
    // How many days back to look on first scan / for unscanned messages
    lookbackDays: parseInt(process.env.GMAIL_LOOKBACK_DAYS || "30", 10),
  };
}

// ---- Stage 1 pre-filter (free, local) ----
// Per Jake's rule: send to LLM only if email has a PDF attachment AND mentions
// "invoice" (or close variant) in subject or body. Everything else is skipped
// before any LLM cost is incurred.
// v8.3: expanded to cover credit memos / vendor credits, which the previous list missed
// (Elevate Outdoor credit memo from 4/30 was silently dropped by Stage 1).
const INVOICE_KEYWORDS = [
  "invoice", "inv #", "inv#", "inv-",
  "bill", "statement", "past due", "past-due",
  "amount due", "balance due", "please remit", "please pay",
  // v8.3: credit-memo / vendor-credit terms
  "credit memo", "credit note", "vendor credit", "credit invoice",
  "cm #", "cm#", "cm-",
];

// v8.3: pull QBO vendor names + email domains so a PDF from a known vendor
// auto-passes Stage 1 even if the keyword list misses (e.g. "Order confirmation"
// from a real vendor that turns out to include an attached invoice).
let _vendorAllowlistCache: { domains: Set<string>; names: Set<string>; loadedAt: number } | null = null;
function getVendorAllowlist(): { domains: Set<string>; names: Set<string> } {
  // Refresh every 10 minutes
  if (_vendorAllowlistCache && Date.now() - _vendorAllowlistCache.loadedAt < 10 * 60 * 1000) {
    return _vendorAllowlistCache;
  }
  const db = getDb();
  const domains = new Set<string>();
  const names = new Set<string>();
  try {
    const rows = db.prepare(
      "SELECT display_name, company_name FROM qbo_vendors_cache WHERE active = 1"
    ).all() as { display_name: string | null; company_name: string | null }[];
    for (const r of rows) {
      const n1 = (r.display_name || "").toLowerCase().trim();
      const n2 = (r.company_name || "").toLowerCase().trim();
      if (n1) names.add(n1);
      if (n2) names.add(n2);
    }
  } catch {}
  // Also include vendor_aliases which capture common sender forms like "sales@vendor.com"
  try {
    const aliasRows = db.prepare("SELECT alias_lower FROM vendor_aliases").all() as { alias_lower: string }[];
    for (const r of aliasRows) {
      const a = (r.alias_lower || "").trim();
      if (!a) continue;
      // If alias looks like an email or domain, pull domain part
      const m = a.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
      if (m) domains.add(m[1].toLowerCase());
      else names.add(a);
    }
  } catch {}
  _vendorAllowlistCache = { domains, names, loadedAt: Date.now() };
  return _vendorAllowlistCache;
}
export function invalidateVendorAllowlistCache() {
  _vendorAllowlistCache = null;
}

function extractFromDomain(fromText: string): string | null {
  const m = (fromText || "").match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : null;
}
function extractFromName(fromText: string): string {
  // "Acme Co <billing@acme.com>" -> "acme co"
  const m = (fromText || "").match(/^\s*"?([^<"]+?)"?\s*</);
  return ((m ? m[1] : (fromText || "")).toLowerCase() || "").trim();
}

// v8.4: regex patterns for invoice/credit-memo numbers that often appear without
// a separator (e.g. "INV24250439", "CM2024014295", "BILL-12345"). The earlier
// substring list missed these because we only had "inv #", "inv-", etc.
const INVOICE_NUMBER_PATTERNS: RegExp[] = [
  /\binv[\s\-#]*\d{3,}/i,        // INV12345, INV-12345, INV #12345, INV 12345
  /\bcm[\s\-#]*\d{4,}/i,         // CM2024014295
  /\bbill[\s\-#]*\d{3,}/i,       // BILL12345
  /\bcredit\s*memo/i,            // "credit memo" anywhere
  /\bcredit\s*note/i,
  /\bvendor\s*credit/i,
  /\bcredit\s*invoice/i,
  /\binvoice\s*[#:]?\s*\d{3,}/i, // "Invoice #12345", "Invoice 12345", "Invoice: 12345"
];

function shouldSendToLlm(opts: { subject: string; from: string; hasPdfAttachment: boolean; bodySnippet: string }): { ok: boolean; reason: string; matchedKeyword?: string; matchedVendor?: string } {
  // Hard requirement #1: must have a PDF attachment
  if (!opts.hasPdfAttachment) return { ok: false, reason: "no PDF attachment" };

  // Strip Fwd:/FW:/RE: prefixes (possibly stacked) so forwarded invoices still match.
  let subj = (opts.subject || "").toLowerCase();
  subj = subj.replace(/^\s*((fwd|fw|re)\s*:\s*)+/i, "");
  // v8.4: scan a larger body slice (8KB) so deeply-nested forwarded invoices still match.
  // Forwarded chains often push the original content past the 4KB cutoff.
  const body = (opts.bodySnippet || "").toLowerCase().slice(0, 8000);

  // Pass A1: keyword substring match
  const matched = INVOICE_KEYWORDS.find((k) => subj.includes(k) || body.includes(k));
  if (matched) return { ok: true, reason: "keyword", matchedKeyword: matched };

  // v8.4 Pass A2: regex match for invoice/credit-memo numbers without separators
  for (const pat of INVOICE_NUMBER_PATTERNS) {
    if (pat.test(subj)) return { ok: true, reason: "keyword-regex", matchedKeyword: pat.source + " (subject)" };
    if (pat.test(body)) return { ok: true, reason: "keyword-regex", matchedKeyword: pat.source + " (body)" };
  }

  // Pass B: vendor allowlist on the From header (works for direct emails)
  const allow = getVendorAllowlist();
  const fromDomain = extractFromDomain(opts.from);
  const fromName = extractFromName(opts.from);
  if (fromDomain && allow.domains.has(fromDomain)) {
    return { ok: true, reason: "vendor-domain", matchedVendor: fromDomain };
  }
  if (fromName) {
    const trimmed = fromName.replace(/\b(inc|llc|corp|co|company|ltd|the)\b\.?/g, "").replace(/\s+/g, " ").trim();
    for (const candidate of [fromName, trimmed]) {
      if (allow.names.has(candidate)) {
        return { ok: true, reason: "vendor-name", matchedVendor: candidate };
      }
      for (const v of allow.names) {
        if (v.length >= 4 && (candidate.includes(v) || v.includes(candidate))) {
          return { ok: true, reason: "vendor-name-loose", matchedVendor: v };
        }
      }
    }
  }

  // v8.4 Pass C: forwarded-email handling. When an email is forwarded to Jake's inbox,
  // the visible From rewrites to "<forwarder> via snohaus.com" — so the original sender
  // is lost from the From header. But the body usually contains the original sender info
  // and any invoice keywords. We search the body for QBO vendor names AND for original-sender
  // patterns (common forwarding syntaxes from Gmail / Outlook / Apple Mail).
  // Common patterns we expect to find in forwarded body content:
  //   "From: <Name> <email@vendor.com>"
  //   "---------- Forwarded message ----------"
  //   "On <date>, <Name> <email> wrote:"
  //   bare vendor name appearing in the forwarded section
  for (const v of allow.names) {
    // require >=4 chars to avoid false positives like "co" or "inc"
    if (v.length >= 4 && body.includes(v)) {
      return { ok: true, reason: "vendor-name-in-body", matchedVendor: v };
    }
  }
  for (const d of allow.domains) {
    if (d.length >= 6 && body.includes(d)) {
      return { ok: true, reason: "vendor-domain-in-body", matchedVendor: d };
    }
  }

  return { ok: false, reason: "no keyword + no vendor match anywhere" };
}

// ---- Status tracking ----
let lastPollAt: string | null = null;          // last SUCCESSFUL poll completion
let lastPollAttemptAt: string | null = null;   // last poll attempt (success OR failure)
let lastError: string | null = null;
let lastErrorAt: string | null = null;         // v8.3: timestamp of lastError so UI can hide stale errors
let lastSuccessAt: string | null = null;       // last time IMAP login succeeded
let ingestedCount = 0;
let pollRunning = false;

// v8.3: persist lastSuccessAt / lastPollAt to app_config so service restarts
// don't show "Never" — these are factual statements about history, not in-memory state.
function persistStatus() {
  try {
    const db = getDb();
    const stamp = new Date().toISOString();
    if (lastSuccessAt) {
      db.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES ('gmail.last_success_at', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(lastSuccessAt, stamp);
    }
    if (lastPollAt) {
      db.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES ('gmail.last_poll_at', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(lastPollAt, stamp);
    }
  } catch (e) {
    // Non-fatal; persistence is best-effort
  }
}
function loadPersistedStatus() {
  try {
    const db = getDb();
    const r1 = db.prepare("SELECT value FROM app_config WHERE key = 'gmail.last_success_at'").get() as { value: string } | undefined;
    const r2 = db.prepare("SELECT value FROM app_config WHERE key = 'gmail.last_poll_at'").get() as { value: string } | undefined;
    if (r1?.value) lastSuccessAt = r1.value;
    if (r2?.value) lastPollAt = r2.value;
  } catch {}
}
let _statusLoaded = false;
function ensureStatusLoaded() {
  if (_statusLoaded) return;
  _statusLoaded = true;
  loadPersistedStatus();
}

// Rolling buffer of recent Gmail errors for the Settings page "Error log" panel.
// Each entry includes ISO timestamp + scope (poll | test | message | attachment | mailbox)
// + the actual message. Newest first. Capped at 50 entries.
type GmailErrorEntry = { at: string; scope: string; message: string };
const errorLog: GmailErrorEntry[] = [];
function recordError(scope: string, message: string) {
  if (!message) return;
  const at = new Date().toISOString();
  errorLog.unshift({ at, scope, message: String(message).slice(0, 1000) });
  if (errorLog.length > 50) errorLog.length = 50;
  // v8.3: track timestamp of last error so the Watcher UI can hide it once it's stale
  // (older than the most recent successful connection).
  if (scope === "poll" || scope === "connect") {
    lastErrorAt = at;
  }
}
export function clearGmailErrorLog() {
  errorLog.length = 0;
}

function updateCount() {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as c FROM ingested_emails").get() as { c: number };
  ingestedCount = row.c;
}

export function getGmailStatus() {
  const cfg = getConfig();
  ensureStatusLoaded();
  updateCount();
  const credsPresent = !!(cfg.user && cfg.password);
  // "connected" now means: creds present AND last connection attempt succeeded.
  const connected = credsPresent && (lastSuccessAt !== null || lastError === null);

  // v8.3: hide stale errors when the most recent success is newer than the most recent error.
  // Without this, a transient connection blip from an hour ago keeps showing a red banner
  // even though every poll since has succeeded.
  let displayError: string | null = lastError;
  let displayErrorLog = errorLog.slice(0, 20);
  if (lastSuccessAt && lastErrorAt && new Date(lastSuccessAt) > new Date(lastErrorAt)) {
    displayError = null;
    displayErrorLog = errorLog.filter((e) => new Date(e.at) >= new Date(lastSuccessAt!)).slice(0, 20);
  }

  return {
    connected,
    configured: credsPresent,
    user: cfg.user || null,
    label: cfg.label,
    last_poll_at: lastPollAt,
    last_poll_attempt_at: lastPollAttemptAt,
    last_success_at: lastSuccessAt,
    last_error_at: lastErrorAt, // v8.3
    ingested_count: ingestedCount,
    poll_interval_minutes: cfg.pollIntervalMinutes,
    error: displayError,
    error_log: displayErrorLog, // recent errors, newest first, stale errors filtered
    error_log_full: errorLog.slice(0, 20), // v8.3: unfiltered, for diagnostic UI
  };
}

/**
 * Lightweight credential test — connects to Gmail IMAP, lists folders, then
 * disconnects. Used by the "Test connection" button on the Settings page so
 * Jake can validate his app password without running a full poll.
 */
export async function testGmailConnection(): Promise<{ ok: boolean; error?: string; user?: string; mailboxes?: string[] }> {
  const cfg = getConfig();
  if (!cfg.user || !cfg.password) {
    return { ok: false, error: "GMAIL_USER and GMAIL_APP_PASSWORD must be set in .env" };
  }
  try {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: cfg.user, pass: cfg.password },
      logger: false,
      socketTimeout: 60_000,
      greetingTimeout: 30_000,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    } as any);
    await client.connect();
    const list = await client.list();
    const mailboxes = list.map((m: any) => m.path).slice(0, 20);
    await client.logout();
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    persistStatus();
    return { ok: true, user: cfg.user, mailboxes };
  } catch (err: any) {
    const raw = String(err?.message || err || "unknown");
    let friendly = raw;
    if (/Invalid credentials|AUTHENTICATIONFAILED|LOGIN failed|authentication failed/i.test(raw)) {
      friendly =
        `Gmail rejected the App Password. The most common causes: ` +
        `(1) the App Password was revoked or never created, ` +
        `(2) 2-Step Verification is off on the Google account, or ` +
        `(3) IMAP is disabled in Gmail settings. ` +
        `Generate a new App Password at https://myaccount.google.com/apppasswords ` +
        `and update GMAIL_APP_PASSWORD in your .env file, then restart the server.`;
    } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(raw)) {
      friendly = `Cannot reach imap.gmail.com — check your internet connection or firewall. (${raw})`;
    }
    lastError = friendly;
    recordError("test", friendly);
    return { ok: false, error: friendly };
  }
}

// ---- PDF parsing helper ----
async function extractTextFromPdf(pdfBuffer: Buffer): Promise<string> {
  try {
    // pdf-parse is a pure-JS PDF text extractor
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(pdfBuffer);
    return data.text || "";
  } catch {
    return "";
  }
}

/** Simple heuristic extraction from raw PDF text — used as fallback if LLM parsing is disabled or fails */
function parseInvoiceText(text: string, filename: string): {
  vendor_raw_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total: number | null;
  low_confidence: boolean;
} {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);

  let invoice_number: string | null = null;
  let invoice_date: string | null = null;
  let total: number | null = null;
  let vendor_raw_name: string | null = null;

  // Invoice number patterns
  const invNumMatch = text.match(/invoice\s*#?\s*:?\s*([A-Z0-9\-]{4,20})/i)
    || text.match(/inv\s*#?\s*:?\s*([A-Z0-9\-]{4,20})/i)
    || text.match(/(?:^|\s)(INV-\d+)/im);
  if (invNumMatch) invoice_number = invNumMatch[1].trim();

  // Date patterns
  const dateMatch = text.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/)
    || text.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i);
  if (dateMatch) {
    const raw = dateMatch[1];
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
      invoice_date = parsed.toISOString().slice(0, 10);
    }
  }

  // Total patterns: look for dollar amounts near "total" keywords
  const totalMatch = text.match(/(?:invoice total|total due|total amount|amount due|balance due)\s*[:$]?\s*([\d,]+\.\d{2})/i)
    || text.match(/\bTotal\b[^\n]*?([\d,]+\.\d{2})/i);
  if (totalMatch) {
    total = parseFloat(totalMatch[1].replace(/,/g, ""));
  }

  // Vendor: often the first line or near "from:"
  const fromMatch = text.match(/(?:from|vendor|bill from|billed by)\s*:?\s*([^\n]{3,50})/i);
  if (fromMatch) {
    vendor_raw_name = fromMatch[1].trim();
  } else if (lines.length > 0) {
    vendor_raw_name = lines[0].length < 60 ? lines[0] : null;
  }

  const low_confidence = !invoice_number || !total;
  return { vendor_raw_name, invoice_number, invoice_date, total, low_confidence };
}

// ---- Core polling logic ----
export async function pollNow(): Promise<{ new_invoices: number; errors: string[] }> {
  const cfg = getConfig();
  if (!cfg.user || !cfg.password) {
    return { new_invoices: 0, errors: ["Gmail credentials not configured (GMAIL_USER / GMAIL_APP_PASSWORD)"] };
  }
  if (pollRunning) {
    return { new_invoices: 0, errors: ["Poll already in progress"] };
  }

  pollRunning = true;
  lastError = null;
  lastPollAttemptAt = new Date().toISOString();
  let newInvoices = 0;
  const errors: string[] = [];

  try {
    // Dynamic import so the module loads fine even if imapflow isn't installed yet
    let ImapFlow: any;
    let simpleParser: any;
    try {
      ImapFlow = (await import("imapflow")).ImapFlow;
      simpleParser = (await import("mailparser")).simpleParser;
    } catch (e: any) {
      const msg = "imapflow or mailparser not installed. Run: npm install imapflow mailparser";
      lastError = msg;
      recordError("poll", msg);
      return { new_invoices: 0, errors: [msg] };
    }

    // v8.4: hardened IMAP options to reduce "Connection not available" frequency.
    // - socketTimeout: 60s (default is much shorter; Gmail can be slow during high-volume scan)
    // - greetingTimeout: 30s (initial server greeting)
    // - tls.rejectUnauthorized: true (default)
    // - emitLogs: false (don't pump library logs into our service log)
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user: cfg.user,
        pass: cfg.password,
      },
      logger: false,
      socketTimeout: 60_000,
      greetingTimeout: 30_000,
      tls: {
        rejectUnauthorized: true,
        // v8.4: pin to TLS 1.2+ — some intermediate proxies have been flaky on TLS 1.3 with imapflow
        minVersion: "TLSv1.2",
      },
    } as any);

    try {
      await client.connect();
      lastSuccessAt = new Date().toISOString();
      persistStatus();
    } catch (connErr: any) {
      const raw = String(connErr?.message || connErr || "unknown");
      let friendly = raw;
      if (/Invalid credentials|AUTHENTICATIONFAILED|LOGIN failed|authentication failed/i.test(raw)) {
        friendly =
          `Gmail rejected the App Password. Generate a new one at ` +
          `https://myaccount.google.com/apppasswords and update GMAIL_APP_PASSWORD in .env, then restart the server.`;
      } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(raw)) {
        friendly = `Cannot reach imap.gmail.com — check internet/firewall. (${raw})`;
      }
      throw new Error(friendly);
    }

    // Determine which mailboxes to scan based on scanMode
    const mailboxesToScan: string[] = [];
    if (cfg.scanMode === "inbox" || cfg.scanMode === "both") {
      mailboxesToScan.push("INBOX");
    }
    if (cfg.scanMode === "label" || cfg.scanMode === "both") {
      // Only add the label if it exists
      try {
        const lst = await client.list();
        if (lst.some((m: any) => m.path === cfg.label || m.name === cfg.label)) {
          mailboxesToScan.push(cfg.label);
        } else if (cfg.scanMode === "label") {
          const lblMsg = `Label "${cfg.label}" not found, falling back to INBOX`;
          errors.push(lblMsg);
          recordError("mailbox", lblMsg);
          if (!mailboxesToScan.includes("INBOX")) mailboxesToScan.push("INBOX");
        }
      } catch {}
    }

    const db = getDb();
    const assetsDir = path.resolve(process.cwd(), "private_assets");
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    // Compute lookback cutoff (only fetch messages newer than this)
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - cfg.lookbackDays);

    let stage1Skipped = 0;

    // Iterate each mailbox
    for (const mailboxName of mailboxesToScan) {
      try {
        await client.mailboxOpen(mailboxName);
      } catch (e: any) {
        const mbMsg = `Could not open mailbox "${mailboxName}": ${e.message}`;
        errors.push(mbMsg);
        recordError("mailbox", mbMsg);
        continue;
      }

      // Use IMAP SINCE to limit by date — huge speedup vs fetching whole inbox
      let uids: number[] = [];
      try {
        uids = (await client.search({ since: sinceDate })) || [];
      } catch {
        // Fallback: fetch all if SINCE not supported
        uids = [];
      }

      const fetchRange = uids.length > 0 ? uids : "1:*";

    for await (const msg of client.fetch(fetchRange as any, {
      uid: true,
      envelope: true,
      source: true,
    })) {
      try {
        const messageId = msg.envelope?.messageId || `uid-${msg.uid}`;

        // Skip already ingested
        const existing = db.prepare("SELECT id FROM ingested_emails WHERE message_id = ?").get(messageId);
        if (existing) continue;

        const parsed = await simpleParser(msg.source);
        const attachments = (parsed.attachments || []).filter(
          (a: any) => a.contentType === "application/pdf" || a.filename?.toLowerCase().endsWith(".pdf")
        );

        // Stage 1 pre-filter: should we even bother sending this to the LLM?
        const stage1 = shouldSendToLlm({
          subject: parsed.subject || "",
          from: parsed.from?.text || "",
          hasPdfAttachment: attachments.length > 0,
          bodySnippet: (parsed.text || parsed.html || "").toString(),
        });

        if (!stage1.ok) {
          // v8.3: log every Stage 1 skip with sender + subject + reason so misses are auditable
          if (attachments.length > 0) {
            const fromShort = (parsed.from?.text || "").slice(0, 80);
            const subjShort = (parsed.subject || "").slice(0, 120);
            console.log(`[gmail-stage1] SKIP pdf=${attachments.length} from="${fromShort}" subject="${subjShort}" reason="${stage1.reason}"`);
          }
          // Mark as ingested-and-skipped so we don't re-evaluate
          db.prepare(`INSERT OR IGNORE INTO ingested_emails (message_id, gmail_uid, subject, from_address, date, pdf_count, invoice_ids, ingested_at, skipped_count, skip_reasons)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            messageId, String(msg.uid),
            parsed.subject || null,
            (parsed.from?.text || null),
            (parsed.date?.toISOString() || null),
            attachments.length,
            null,
            new Date().toISOString(),
            attachments.length || 1,
            JSON.stringify([`stage1: ${stage1.reason}`])
          );
          stage1Skipped++;
          continue;
        } else if (stage1.reason !== "keyword") {
          // v8.3: log when vendor allowlist saved an email keyword would have missed
          console.log(
            `[gmail-stage1] PASS via ${stage1.reason}="${stage1.matchedVendor}" ` +
            `from="${(parsed.from?.text || "").slice(0, 80)}" subject="${(parsed.subject || "").slice(0, 120)}"`
          );
        }

        if (attachments.length === 0) {
          // No PDF but passed Stage 1 (e.g. text-only invoice like ADP).
          // Future: send body+subject to LLM for text-only parsing. For now, log and skip.
          db.prepare(`INSERT OR IGNORE INTO ingested_emails (message_id, gmail_uid, subject, from_address, date, pdf_count, invoice_ids, ingested_at, skipped_count, skip_reasons)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            messageId, String(msg.uid),
            parsed.subject || null,
            (parsed.from?.text || null),
            (parsed.date?.toISOString() || null),
            0, null, new Date().toISOString(),
            1,
            JSON.stringify(["text-only invoice, no PDF — deferred (future: LLM-parse from email body)"])
          );
          continue;
        }

        const invoiceIds: string[] = [];

        const skipReasonsForEmail: string[] = [];
        let skippedCount = 0;

        for (const attachment of attachments) {
          try {
            const prefix = crypto.randomBytes(5).toString("hex");
            const safeName = (attachment.filename || "invoice.pdf").replace(/[^a-zA-Z0-9._\-]/g, "_");
            const filename = `${prefix}_${safeName}`;
            const filePath = path.join(assetsDir, filename);

            // Save PDF
            fs.writeFileSync(filePath, attachment.content);

            // ---- LLM-first parsing ----
            let llmResult: LLMParsedInvoice | null = null;
            let llmFailureReason: string | null = null;
            if (isLlmParserEnabled()) {
              clearLastLlmFailure();
              try {
                llmResult = await parseInvoiceWithLLM(attachment.content, {
                  subject: parsed.subject || null,
                  from: parsed.from?.text || null,
                  body: parsed.text || parsed.html || null,
                });
              } catch (llmErr: any) {
                llmFailureReason = `threw: ${llmErr.message}`;
                console.error("[Gmail] LLM parser threw:", llmErr.message);
              }
              if (!llmResult && !llmFailureReason) {
                // parseInvoiceWithLLM returns null on HTTP/JSON/parse errors. Pull last reason.
                llmFailureReason = getLastLlmFailure() || "unknown LLM failure (returned null)";
              }
              if (!llmResult) {
                const fname = attachment.filename || "(unnamed)";
                skipReasonsForEmail.push(`LLM-fallback-to-regex: ${fname} — ${llmFailureReason}`);
                console.error(`[Gmail] LLM failed for ${fname}: ${llmFailureReason} — falling back to regex`);
              }
            }

            // SKIP non-invoices flagged by the LLM (warranty replacements, sales orders, statements, etc.)
            if (llmResult && !llmResult.is_real_invoice) {
              const reason = `${attachment.filename || "(unnamed)"}: ${llmResult.document_type}${llmResult.skip_reason ? ` — ${llmResult.skip_reason}` : ""}`;
              skipReasonsForEmail.push(reason);
              skippedCount++;
              // Delete the saved PDF since we don't need it
              try { fs.unlinkSync(filePath); } catch {}
              console.log(`[Gmail] Skipping non-invoice: ${reason}`);
              continue;
            }

            // Build parsed_data from LLM if available, otherwise fall back to regex
            let parsed_data: {
              vendor_raw_name: string | null;
              invoice_number: string | null;
              invoice_date: string | null;
              total: number | null;
              low_confidence: boolean;
              freight: number;
              is_credit: boolean;
              payment_terms: string | null;
            };
            if (llmResult) {
              parsed_data = {
                vendor_raw_name: llmResult.vendor_raw_name,
                invoice_number: llmResult.invoice_number,
                invoice_date: llmResult.invoice_date,
                total: llmResult.total,
                low_confidence: llmResult.parse_confidence === "low",
                freight: llmResult.freight ?? 0,
                is_credit: llmResult.is_credit,
                payment_terms: llmResult.payment_terms ?? null,
              };
            } else {
              const text = await extractTextFromPdf(attachment.content);
              const regex = parseInvoiceText(text, filename);
              parsed_data = { ...regex, freight: 0, is_credit: false, payment_terms: null };
            }

            // Create invoice record
            const invoiceId = `${prefix}_${safeName.replace(/\.pdf$/i, "")}`;
            const now = new Date().toISOString();

            // Smart-match vendor against alias table + QBO vendors
            let vendorMatch = smartMatchVendor(parsed_data.vendor_raw_name);
            let vendorMatchStatus = vendorMatch?.vendor_match_status || "unmatched";
            let vendorQboId = vendorMatch?.vendor_qbo_id || null;
            let vendorQboName = vendorMatch?.vendor_qbo_name || null;

            // Claude fallback when local matching fails. High-confidence picks auto-match
            // (and we save an alias so it sticks). Med/low picks are recorded as suggestions
            // (vendor stays unmatched) so Jake reviews before posting.
            if (!vendorMatch && parsed_data.vendor_raw_name && isVendorMatcherLlmEnabled()) {
              try {
                const llmMatch = await matchVendorWithLlm(parsed_data.vendor_raw_name);
                if (llmMatch?.vendor_qbo_id && llmMatch.confidence === "high") {
                  vendorQboId = llmMatch.vendor_qbo_id;
                  vendorQboName = llmMatch.vendor_qbo_name;
                  vendorMatchStatus = "aliased";
                  // Persist as alias so future invoices skip the LLM call
                  learnVendorAlias(parsed_data.vendor_raw_name, llmMatch.vendor_qbo_id, llmMatch.vendor_qbo_name || "", "learned-from-llm-high-confidence");
                  console.log(`[Gmail] Claude vendor match (high): "${parsed_data.vendor_raw_name}" → ${vendorQboName} (saved alias)`);
                }
              } catch (llmErr: any) {
                console.warn(`[Gmail] Claude vendor match failed (non-fatal): ${llmErr.message}`);
              }
            }

            // Resolve ship-to store from LLM hint (and fallback to vendor rule). null means leave blank —
            // do NOT default to greenvale silently; the UI surfaces this for user input.
            const shipToStore = resolveShipToStore(llmResult?.store_hint || null, vendorQboId);

            // dedup: skip if an invoice with same invoice_number + total already exists.
            // Strategy:
            //   1. If both new and existing have a vendor_qbo_id, require a vendor match.
            //   2. If both have raw names, require a fuzzy raw-name overlap.
            //   3. If either side has NO vendor info, fall back to invoice_number + total only
            //      (treat null as wildcard) — covers the case where the same PDF arrives 3x
            //      and parser/match comes up empty on each pass.
            // Skips dedup entirely when invoice_number or total is null (too risky to collapse).
            try {
              if (parsed_data.invoice_number && parsed_data.total != null) {
                const rawTrim = (parsed_data.vendor_raw_name || "").trim();
                const dupRawLike = rawTrim ? `%${rawTrim.slice(0, 30)}%` : null;
                // Match if (a) any candidate vendor identifier overlaps OR (b) neither side has
                // identifiable vendor info — then invoice_number + total is enough.
                const existing = db.prepare(
                  `SELECT id, vendor_qbo_id, vendor_raw_name FROM invoices
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
                  console.log(`[Gmail] dedup: skipping duplicate of ${existing.id} (invoice_number=${parsed_data.invoice_number}, total=${parsed_data.total})`);
                  try { fs.unlinkSync(filename); } catch {}
                  continue;
                }
              }
            } catch (dedupErr: any) {
              console.error(`[Gmail] dedup check failed (continuing): ${dedupErr.message}`);
            }

            db.prepare(`
              INSERT OR IGNORE INTO invoices (
                id, source_file, email_id, email_date, email_from, email_subject,
                pdf_url, vendor_raw_name, vendor_match_status, vendor_qbo_id, vendor_qbo_name,
                invoice_number, invoice_date, total, freight, is_credit,
                ship_to_store, parse_confidence, status, routing_mode, routing_data, duplicate_check_status,
                created_at, updated_at,
                document_type, store_hint, llm_notes, already_paid, line_items_json, bill_kind,
                payment_terms
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(
              invoiceId,
              `${prefix}_${safeName.replace(/\.pdf$/i, "")}.txt`,
              messageId,
              (parsed.date?.toISOString().slice(0, 10) || null),
              (parsed.from?.text || null),
              (parsed.subject || null),
              filename,
              parsed_data.vendor_raw_name,
              vendorMatchStatus,
              vendorQboId,
              vendorQboName,
              parsed_data.invoice_number,
              parsed_data.invoice_date,
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
              parsed_data.payment_terms
            );

            // PR #R4k — mirror the pipeline's line-item persistence so the gmail
            // path doesn't depend on the 8-sec boot-time backfill in storage.ts.
            try {
              if (Array.isArray(llmResult?.line_items) && llmResult.line_items.length > 0) {
                replaceInvoiceLineItems(invoiceId, llmResult.line_items as any);
              }
            } catch (e) {
              console.error(`[Gmail] line-item persist failed for ${invoiceId}:`, (e as Error).message);
            }

            console.log(`[Gmail] Ingested ${invoiceId}: vendor="${parsed_data.vendor_raw_name}" → ${vendorMatchStatus}${vendorQboName ? ` (${vendorQboName})` : ""}, store=${shipToStore || "unknown"}`);

            // Auto QBO duplicate check at ingest. If QBO already has this bill, mark this
            // invoice as posted_qbo + duplicate_found and link the existing bill id, so it
            // bypasses the inbox entirely. Wrapped in try/catch so a QBO outage doesn't
            // block ingest — falls back to today's behavior (duplicate_check_status=unchecked).
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
                    console.log(`[Gmail] Auto-skipped ${invoiceId} — already posted to QBO as Bill #${billId}${paymentLabel}`);
                  } else {
                    // QBO clean — mark so user doesn't have to click Recheck in the drawer.
                    db.prepare(`UPDATE invoices SET duplicate_check_status = ?, duplicate_check_at = ?, updated_at = ? WHERE id = ?`)
                      .run("clean", new Date().toISOString(), new Date().toISOString(), invoiceId);
                  }
                }
              } catch (qboErr: any) {
                console.warn(`[Gmail] QBO duplicate check at ingest failed (non-fatal): ${qboErr.message}`);
              }
            }

            invoiceIds.push(invoiceId);
            newInvoices++;
          } catch (attachErr: any) {
            const aMsg = `Attachment error: ${attachErr.message}`;
            errors.push(aMsg);
            recordError("attachment", aMsg);
          }
        }

        // Mark email as ingested
        db.prepare(`INSERT OR IGNORE INTO ingested_emails (message_id, gmail_uid, subject, from_address, date, pdf_count, invoice_ids, ingested_at, skipped_count, skip_reasons)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          messageId, String(msg.uid),
          parsed.subject || null,
          (parsed.from?.text || null),
          (parsed.date?.toISOString() || null),
          attachments.length,
          JSON.stringify(invoiceIds),
          new Date().toISOString(),
          skippedCount,
          skipReasonsForEmail.length ? JSON.stringify(skipReasonsForEmail) : null
        );
      } catch (msgErr: any) {
        const mMsg = `Message processing error: ${msgErr?.message || String(msgErr)}`;
        errors.push(mMsg);
        recordError("message", mMsg);
        // v8.2: write the stack to the service log so we can see WHICH email
        // and WHICH step inside the pipeline blew up.
        console.error("[gmail-poll] message error", mMsg, "\n", msgErr?.stack || "(no stack)");
      }
    }
    } // end for mailbox

    await client.logout();
    if (stage1Skipped > 0) {
      console.log(`[Gmail] Stage 1 pre-filter skipped ${stage1Skipped} non-invoice emails (saved LLM credits).`);
    }
    lastPollAt = new Date().toISOString();
    persistStatus();
    console.log(`[Gmail] Poll complete. New invoices: ${newInvoices}`);
  } catch (err: any) {
    // v8.2: include stack so the in-app log viewer captures the full trace.
    lastError = err?.message || String(err);
    errors.push(lastError);
    recordError("poll", lastError);
    console.error("[gmail-poll] ERROR", lastError, "\n", err?.stack || "(no stack)");
  } finally {
    pollRunning = false;
  }

  return { new_invoices: newInvoices, errors };
}

// v8.3: transient-error pattern — the imapflow library drops the TLS connection
// frequently ("Connection not available", socket hang up, ETIMEDOUT, ECONNRESET).
// pollWithRetry wraps pollNow with a single 30s retry on these patterns so a
// flaky network blip doesn't skip the cycle entirely.
const TRANSIENT_PATTERNS = [
  /connection not available/i,
  /socket hang up/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /read ECONNABORTED/i,
];
function isTransient(errMsg: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(errMsg || ""));
}
export async function pollWithRetry(): Promise<{ new_invoices: number; errors: string[]; retried?: boolean }> {
  const first = await pollNow();
  if (first.errors.length > 0 && first.new_invoices === 0) {
    const transient = first.errors.some(isTransient);
    if (transient) {
      console.log(`[gmail-poll] transient error detected, retrying in 30s: ${first.errors[0]}`);
      await new Promise((r) => setTimeout(r, 30_000));
      const second = await pollNow();
      // v8.4: if the retry succeeded (no errors), don't surface the first-attempt's transient error
      // — the user already got the recovery they needed, and the toast "1 error(s)" was misleading.
      // Also clear the in-memory lastError so the UI dot turns green.
      if (second.errors.length === 0) {
        lastError = null;
        return { new_invoices: second.new_invoices, errors: [], retried: true };
      }
      return { ...second, retried: true };
    }
  }
  return first;
}

// ---- Auto-polling timer ----
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startGmailPolling() {
  const cfg = getConfig();
  if (!cfg.user || !cfg.password) {
    console.log("[Gmail] Polling disabled — GMAIL_USER / GMAIL_APP_PASSWORD not set");
    return;
  }

  const intervalMs = cfg.pollIntervalMinutes * 60 * 1000;
  console.log(`[Gmail] Starting poll timer: every ${cfg.pollIntervalMinutes} minutes`);

  // Initial poll after 30 seconds (give server time to start) — v8.3: with retry
  setTimeout(() => pollWithRetry().catch((e) => console.error("[Gmail] Poll error:", e)), 30_000);

  pollTimer = setInterval(() => {
    pollWithRetry().catch((e) => console.error("[Gmail] Poll error:", e));
  }, intervalMs);
}

/**
 * v8.3: Reingest a previously-skipped email by clearing its ingested_emails row
 * and triggering a fresh poll. Used to recover credit memos / vendor credits that
 * were dropped by the old Stage 1 keyword list.
 *
 * Selectors (any combination, AND-joined):
 *   - fromContains: substring match on from_address (case-insensitive)
 *   - subjectContains: substring match on subject (case-insensitive)
 *   - sinceDays: only consider emails received in the last N days (default 30)
 *
 * Returns the rows that were cleared so the caller can show what's about to be re-pulled.
 */
export async function reingestEmails(opts: {
  fromContains?: string;
  subjectContains?: string;
  sinceDays?: number;
}): Promise<{ cleared: { message_id: string; subject: string | null; from_address: string | null; date: string | null }[]; poll: { new_invoices: number; errors: string[] } }> {
  const db = getDb();
  const sinceDays = opts.sinceDays ?? 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - sinceDays);

  const conditions: string[] = ["(invoice_ids IS NULL OR skipped_count > 0)"];
  const params: any[] = [];
  if (opts.fromContains) {
    conditions.push("LOWER(from_address) LIKE ?");
    params.push(`%${opts.fromContains.toLowerCase()}%`);
  }
  if (opts.subjectContains) {
    conditions.push("LOWER(subject) LIKE ?");
    params.push(`%${opts.subjectContains.toLowerCase()}%`);
  }
  conditions.push("(date IS NULL OR date >= ?)");
  params.push(cutoff.toISOString());

  const sql = `SELECT message_id, subject, from_address, date FROM ingested_emails WHERE ${conditions.join(" AND ")} LIMIT 500`;
  const rows = db.prepare(sql).all(...params) as any[];

  if (rows.length > 0) {
    const ids = rows.map((r) => r.message_id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM ingested_emails WHERE message_id IN (${placeholders})`).run(...ids);
    console.log(`[gmail-reingest] cleared ${ids.length} ingested_emails rows; running poll`);
  } else {
    console.log(`[gmail-reingest] no matching rows found; running poll anyway`);
  }

  const poll = await pollWithRetry();
  return { cleared: rows, poll };
}

export function stopGmailPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
