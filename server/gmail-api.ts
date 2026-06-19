/**
 * Gmail API (HTTPS REST) — replacement for IMAP polling.
 *
 * R4q: Migrates the Gmail ingest pipeline off `imapflow` + App Password onto
 * the Gmail REST API + OAuth2 via the existing `Sno-Haus AP Server` Google
 * OAuth client (shared with Drive). Uses Pub/Sub push notifications via
 * users.watch() so new mail is delivered to /api/gmail/push within seconds
 * instead of polled every 15 minutes.
 *
 * Token storage reuses the `google_oauth` table (purpose=`gmail_service`),
 * encrypted with the same AES-256-GCM helpers as drive_service.
 *
 * Public surface mirrors gmail.ts so routes can swap with minimal change:
 *   - getGmailApiStatus()
 *   - testGmailApiConnection()
 *   - pollNowApi()              (manual or scheduled fallback)
 *   - processHistoryPush(...)   (called by /api/gmail/push webhook)
 *   - startGmailWatch()         (renews users.watch() — call on boot + every 6 days)
 *   - stopGmailWatch()
 */
import { google, gmail_v1, Auth } from "googleapis";
import {
  GoogleTokens,
  isGoogleConfigured,
  getOAuth2Client,
} from "./google-oauth";
import {
  getGoogleOAuthRow,
  upsertGoogleOAuthRow,
  deleteGoogleOAuthRow,
  smartMatchVendor,
  resolveShipToStore,
  learnVendorAlias,
  replaceInvoiceLineItems,
} from "./storage";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { getDbPath } from "./db-path";
import {
  parseInvoiceWithLLM,
  isLlmParserEnabled,
  getLastLlmFailure,
  clearLastLlmFailure,
  computeDueDateFromTerms,
  type LLMParsedInvoice,
} from "./llm-parser";
import { normalizeDueDate } from "./invoice-pipeline";
import { matchVendorWithLlm, isVendorMatcherLlmEnabled } from "./vendor-matcher-llm";
import { getQboStatus, searchBills, searchVendorCredits, searchPayments } from "./qbo";

// ===== Constants =====

// Gmail scopes we request — mirrors what was added in the OAuth consent screen.
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify", // read + label (we'll label processed messages)
];

const PURPOSE = "gmail_service";
const PUBSUB_TOPIC = `projects/${process.env.GCP_PROJECT_ID || "sno-haus-ap"}/topics/${process.env.GMAIL_PUBSUB_TOPIC || "gmail-notification"}`;

// ===== Encryption (reuse google-oauth.ts patterns) =====
// We need our own copy here because google-oauth.ts didn't export them.
// TODO: refactor google-oauth.ts to export encrypt/decrypt helpers so we don't duplicate.

function getDerivedKey(): Buffer {
  const secret = process.env.SESSION_SECRET || "default-dev-secret-change-in-production";
  return crypto.scryptSync(secret, "oauth-salt", 32);
}

function encryptTokens(tokens: GoogleTokens): string {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptTokens(encrypted: string): GoogleTokens | null {
  try {
    const key = getDerivedKey();
    const parts = encrypted.split(":");
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const ciphertext = Buffer.from(parts[2], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as GoogleTokens;
  } catch {
    return null;
  }
}

// ===== Token storage =====

export function getGmailTokens(): GoogleTokens | null {
  const row = getGoogleOAuthRow(PURPOSE);
  if (!row) return null;
  return decryptTokens(row.encrypted_tokens);
}

export function setGmailTokens(tokens: GoogleTokens, grantedEmail?: string): void {
  const now = new Date().toISOString();
  upsertGoogleOAuthRow({
    purpose: PURPOSE,
    encrypted_tokens: encryptTokens(tokens),
    granted_email: grantedEmail || null,
    granted_at: now,
    updated_at: now,
  });
}

export function clearGmailTokens(): void {
  deleteGoogleOAuthRow(PURPOSE);
}

export function getGmailApiConnectedStatus(): {
  connected: boolean;
  granted_email?: string;
  granted_at?: string;
} {
  const row = getGoogleOAuthRow(PURPOSE);
  if (!row) return { connected: false };
  const tokens = decryptTokens(row.encrypted_tokens);
  if (!tokens) return { connected: false };
  return {
    connected: true,
    granted_email: row.granted_email || undefined,
    granted_at: row.granted_at || undefined,
  };
}

// ===== OAuth URL helpers =====

export function getGmailAuthUrl(redirectUri: string, state: string): string {
  const oauth2 = getOAuth2Client(redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: GMAIL_SCOPES,
    state,
    prompt: "consent", // force consent so we always receive a refresh_token
  });
}

// ===== Authenticated Gmail client =====

export async function getValidGmailClient(): Promise<gmail_v1.Gmail | null> {
  if (!isGoogleConfigured()) return null;
  const tokens = getGmailTokens();
  if (!tokens) return null;

  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI_PROD ||
    process.env.GOOGLE_REDIRECT_URI_LOCAL ||
    "http://localhost:5000/api/auth/gmail/callback";
  // Always use the gmail-specific path
  const gmailRedirectUri = redirectUri
    .replace("/auth/google/callback", "/auth/gmail/callback")
    .replace("/auth/drive/callback", "/auth/gmail/callback");

  const oauth2 = getOAuth2Client(gmailRedirectUri);
  oauth2.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });

  // Refresh if expiring within 5 min
  if (tokens.expiry_date && tokens.expiry_date - Date.now() < 5 * 60 * 1000) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      const newTokens: GoogleTokens = {
        access_token: credentials.access_token || tokens.access_token,
        refresh_token: credentials.refresh_token || tokens.refresh_token,
        expiry_date: credentials.expiry_date || Date.now() + 3600 * 1000,
      };
      setGmailTokens(newTokens);
      oauth2.setCredentials(newTokens);
    } catch (e: any) {
      console.error("[gmail-api] token refresh failed:", e.message);
    }
  }

  return google.gmail({ version: "v1", auth: oauth2 });
}

// ===== Watch (Pub/Sub push registration) =====
//
// users.watch() asks Gmail to publish a message to our Pub/Sub topic every time
// the user's mailbox changes. The watch expires after 7 days and MUST be renewed.
// We persist the lastHistoryId returned so the push handler can ask Gmail
// "what happened since X" instead of re-scanning the whole mailbox.

let _watchTimer: ReturnType<typeof setInterval> | null = null;

export async function startGmailWatch(): Promise<{
  historyId: string;
  expiration: string;
}> {
  const gmail = await getValidGmailClient();
  if (!gmail) throw new Error("Gmail not connected");

  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: PUBSUB_TOPIC,
      labelIds: ["INBOX"], // only INBOX changes — drastically cuts noise from labels, drafts, sent, etc.
      labelFilterBehavior: "INCLUDE",
    },
  });

  const historyId = res.data.historyId || "";
  const expiration = res.data.expiration || "";
  console.log(`[gmail-api] watch registered. historyId=${historyId} expires=${new Date(Number(expiration)).toISOString()}`);

  // Persist for the push handler to use as the starting point.
  setLastHistoryId(historyId);
  setWatchExpiration(expiration);

  return { historyId, expiration };
}

export async function stopGmailWatch(): Promise<void> {
  const gmail = await getValidGmailClient();
  if (!gmail) return;
  try {
    await gmail.users.stop({ userId: "me" });
    console.log("[gmail-api] watch stopped");
  } catch (e: any) {
    console.error("[gmail-api] watch stop failed:", e.message);
  }
  if (_watchTimer) {
    clearInterval(_watchTimer);
    _watchTimer = null;
  }
}

// Renew watch every 6 days (Gmail expires watches after 7 days).
export function startWatchRenewalTimer() {
  // Initial register on boot — but only if already connected.
  if (getGmailTokens()) {
    startGmailWatch().catch((e) => console.error("[gmail-api] initial watch failed:", e.message));
  }
  _watchTimer = setInterval(() => {
    if (getGmailTokens()) {
      startGmailWatch().catch((e) => console.error("[gmail-api] watch renewal failed:", e.message));
    }
  }, 6 * 24 * 60 * 60 * 1000);
}

// ===== History tracking (for incremental push processing) =====
//
// Stored as a row in `google_oauth` with purpose=`gmail_watch_state`. We
// piggyback on the existing table to avoid a schema migration.

const WATCH_STATE_PURPOSE = "gmail_watch_state";

interface WatchState {
  lastHistoryId?: string;
  watchExpiration?: string;
}

function getWatchState(): WatchState {
  const row = getGoogleOAuthRow(WATCH_STATE_PURPOSE);
  if (!row) return {};
  try {
    // encrypted_tokens column repurposed to hold JSON state (unencrypted — no secret here).
    return JSON.parse(row.encrypted_tokens) as WatchState;
  } catch {
    return {};
  }
}

function saveWatchState(state: WatchState): void {
  const now = new Date().toISOString();
  upsertGoogleOAuthRow({
    purpose: WATCH_STATE_PURPOSE,
    encrypted_tokens: JSON.stringify(state),
    granted_email: null,
    granted_at: now,
    updated_at: now,
  });
}

function setLastHistoryId(historyId: string) {
  const s = getWatchState();
  s.lastHistoryId = historyId;
  saveWatchState(s);
}

function setWatchExpiration(expiration: string) {
  const s = getWatchState();
  s.watchExpiration = expiration;
  saveWatchState(s);
}

export function getLastHistoryId(): string | undefined {
  return getWatchState().lastHistoryId;
}

// ===== Status / test =====

export function getGmailApiStatus() {
  const conn = getGmailApiConnectedStatus();
  const state = getWatchState();
  return {
    connected: conn.connected,
    configured: isGoogleConfigured(),
    granted_email: conn.granted_email,
    granted_at: conn.granted_at,
    last_history_id: state.lastHistoryId || null,
    watch_expiration: state.watchExpiration
      ? new Date(Number(state.watchExpiration)).toISOString()
      : null,
    pubsub_topic: PUBSUB_TOPIC,
  };
}

export async function testGmailApiConnection(): Promise<{
  ok: boolean;
  error?: string;
  user?: string;
  messages_total?: number;
}> {
  try {
    const gmail = await getValidGmailClient();
    if (!gmail) return { ok: false, error: "Gmail not connected" };
    const profile = await gmail.users.getProfile({ userId: "me" });
    return {
      ok: true,
      user: profile.data.emailAddress || undefined,
      messages_total: profile.data.messagesTotal || undefined,
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ===== DB helper =====

const DB_PATH = getDbPath();
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
    try { _db.exec("ALTER TABLE ingested_emails ADD COLUMN skipped_count INTEGER DEFAULT 0"); } catch {}
    try { _db.exec("ALTER TABLE ingested_emails ADD COLUMN skip_reasons TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN document_type TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN store_hint TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN llm_notes TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN already_paid INTEGER DEFAULT 0"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN line_items_json TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN bill_kind TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN parse_failure_reason TEXT"); } catch {}
    try { _db.exec("ALTER TABLE invoices ADD COLUMN payment_terms TEXT"); } catch {}
  }
  return _db;
}

// ===== Config =====

function getConfig() {
  return {
    label: process.env.GMAIL_LABEL || "Unreceived Invoices",
    // R4q: API path defaults to 7-day lookback for the manual poll fallback
    // (push notifications cover real-time, so the poll is only used to backfill
    // a missed window). 30-day was an IMAP-era number to absorb intermittent
    // connection failures we no longer have.
    lookbackDays: parseInt(process.env.GMAIL_LOOKBACK_DAYS || "7", 10),
    // Manual fallback poll interval — push is primary, this is a safety net only.
    pollIntervalMinutes: parseInt(process.env.GMAIL_POLL_INTERVAL_MINUTES || "60", 10),
  };
}

// ===== Stage 1 pre-filter (inlined from gmail.ts so this module is self-contained) =====
// PR #R4p: nameSlugs catches vendors whose PrimaryEmailAddr isn't set in QBO
// but whose domain contains the vendor name (e.g. orders@kingsleybate.com).

const INVOICE_KEYWORDS = [
  "invoice", "inv #", "inv#", "inv-",
  "bill", "statement", "past due", "past-due",
  "amount due", "balance due", "please remit", "please pay",
  "credit memo", "credit note", "vendor credit", "credit invoice",
  "cm #", "cm#", "cm-",
];

const INVOICE_NUMBER_PATTERNS: RegExp[] = [
  /\binv[\s\-#]*\d{3,}/i,
  /\bcm[\s\-#]*\d{4,}/i,
  /\bbill[\s\-#]*\d{3,}/i,
  /\bcredit\s*memo/i,
  /\bcredit\s*note/i,
  /\bvendor\s*credit/i,
  /\bcredit\s*invoice/i,
  /\binvoice\s*[#:]?\s*\d{3,}/i,
];

let _vendorAllowlistCache: { domains: Set<string>; names: Set<string>; nameSlugs: Set<string>; loadedAt: number } | null = null;
function getVendorAllowlist(): { domains: Set<string>; names: Set<string>; nameSlugs: Set<string> } {
  if (_vendorAllowlistCache && Date.now() - _vendorAllowlistCache.loadedAt < 10 * 60 * 1000) {
    return _vendorAllowlistCache;
  }
  const db = getDb();
  const domains = new Set<string>();
  const names = new Set<string>();
  const nameSlugs = new Set<string>();
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  try {
    let rows: { display_name: string | null; company_name: string | null; primary_email: string | null }[] = [];
    try {
      rows = db.prepare(
        "SELECT display_name, company_name, primary_email FROM qbo_vendors_cache WHERE active = 1"
      ).all() as any[];
    } catch {
      rows = (db.prepare(
        "SELECT display_name, company_name FROM qbo_vendors_cache WHERE active = 1"
      ).all() as any[]).map((r: any) => ({ ...r, primary_email: null }));
    }
    for (const r of rows) {
      const n1 = (r.display_name || "").toLowerCase().trim();
      const n2 = (r.company_name || "").toLowerCase().trim();
      if (n1) { names.add(n1); const s = slugify(n1); if (s.length >= 5) nameSlugs.add(s); }
      if (n2) { names.add(n2); const s = slugify(n2); if (s.length >= 5) nameSlugs.add(s); }
      const email = (r.primary_email || "").trim();
      const m = email.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
      if (m) domains.add(m[1].toLowerCase());
    }
  } catch {}
  try {
    const aliasRows = db.prepare("SELECT alias_lower FROM vendor_aliases").all() as { alias_lower: string }[];
    for (const r of aliasRows) {
      const a = (r.alias_lower || "").trim();
      if (!a) continue;
      const m = a.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
      if (m) domains.add(m[1].toLowerCase());
      else names.add(a);
    }
  } catch {}
  _vendorAllowlistCache = { domains, names, nameSlugs, loadedAt: Date.now() };
  return _vendorAllowlistCache;
}

// R4q parallel-run: shares the *concept* with gmail.ts but each module caches
// its own allowlist. The QBO sync endpoint must invalidate both.
export function invalidateGmailApiVendorAllowlistCache() {
  _vendorAllowlistCache = null;
}

function extractFromDomain(fromText: string): string | null {
  const m = (fromText || "").match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : null;
}
function extractFromName(fromText: string): string {
  const m = (fromText || "").match(/^\s*"?([^<"]+?)"?\s*</);
  return ((m ? m[1] : (fromText || "")).toLowerCase() || "").trim();
}

function shouldSendToLlm(opts: { subject: string; from: string; hasPdfAttachment: boolean; bodySnippet: string }): { ok: boolean; reason: string; matchedKeyword?: string; matchedVendor?: string } {
  if (!opts.hasPdfAttachment) return { ok: false, reason: "no PDF attachment" };
  let subj = (opts.subject || "").toLowerCase();
  subj = subj.replace(/^\s*((fwd|fw|re)\s*:\s*)+/i, "");
  const body = (opts.bodySnippet || "").toLowerCase().slice(0, 8000);

  const matched = INVOICE_KEYWORDS.find((k) => subj.includes(k) || body.includes(k));
  if (matched) return { ok: true, reason: "keyword", matchedKeyword: matched };

  for (const pat of INVOICE_NUMBER_PATTERNS) {
    if (pat.test(subj)) return { ok: true, reason: "keyword-regex", matchedKeyword: pat.source + " (subject)" };
    if (pat.test(body)) return { ok: true, reason: "keyword-regex", matchedKeyword: pat.source + " (body)" };
  }

  const allow = getVendorAllowlist();
  const fromDomain = extractFromDomain(opts.from);
  const fromName = extractFromName(opts.from);
  if (fromDomain && allow.domains.has(fromDomain)) {
    return { ok: true, reason: "vendor-domain", matchedVendor: fromDomain };
  }
  if (fromDomain) {
    const domainCore = fromDomain.replace(/\.[a-z]{2,}$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const slugs = Array.from(allow.nameSlugs);
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      if (domainCore.includes(slug) || slug.includes(domainCore)) {
        return { ok: true, reason: "vendor-name-in-domain", matchedVendor: slug };
      }
    }
  }
  if (fromName) {
    const trimmed = fromName.replace(/\b(inc|llc|corp|co|company|ltd|the)\b\.?/g, "").replace(/\s+/g, " ").trim();
    for (const candidate of [fromName, trimmed]) {
      if (allow.names.has(candidate)) {
        return { ok: true, reason: "vendor-name", matchedVendor: candidate };
      }
      for (const v of Array.from(allow.names)) {
        if (v.length >= 4 && (candidate.includes(v) || v.includes(candidate))) {
          return { ok: true, reason: "vendor-name-loose", matchedVendor: v };
        }
      }
    }
  }

  for (const v of Array.from(allow.names)) {
    if (v.length >= 4 && body.includes(v)) {
      return { ok: true, reason: "vendor-name-in-body", matchedVendor: v };
    }
  }
  for (const d of Array.from(allow.domains)) {
    if (d.length >= 6 && body.includes(d)) {
      return { ok: true, reason: "vendor-domain-in-body", matchedVendor: d };
    }
  }

  return { ok: false, reason: "no keyword + no vendor match anywhere" };
}

// ===== Status tracking =====

let lastPollAt: string | null = null;
let lastPollAttemptAt: string | null = null;
let lastError: string | null = null;
let lastErrorAt: string | null = null;
let lastSuccessAt: string | null = null;
let lastPushAt: string | null = null;        // R4q: last Pub/Sub push received
let ingestedCount = 0;
let pollRunning = false;

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
    if (lastPushAt) {
      db.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES ('gmail.last_push_at', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(lastPushAt, stamp);
    }
  } catch {}
}
function loadPersistedStatus() {
  try {
    const db = getDb();
    const r1 = db.prepare("SELECT value FROM app_config WHERE key = 'gmail.last_success_at'").get() as { value: string } | undefined;
    const r2 = db.prepare("SELECT value FROM app_config WHERE key = 'gmail.last_poll_at'").get() as { value: string } | undefined;
    const r3 = db.prepare("SELECT value FROM app_config WHERE key = 'gmail.last_push_at'").get() as { value: string } | undefined;
    if (r1?.value) lastSuccessAt = r1.value;
    if (r2?.value) lastPollAt = r2.value;
    if (r3?.value) lastPushAt = r3.value;
  } catch {}
}
let _statusLoaded = false;
function ensureStatusLoaded() {
  if (_statusLoaded) return;
  _statusLoaded = true;
  loadPersistedStatus();
}

type GmailErrorEntry = { at: string; scope: string; message: string };
const errorLog: GmailErrorEntry[] = [];
function recordError(scope: string, message: string) {
  if (!message) return;
  const at = new Date().toISOString();
  errorLog.unshift({ at, scope, message: String(message).slice(0, 1000) });
  if (errorLog.length > 50) errorLog.length = 50;
  if (scope === "poll" || scope === "connect" || scope === "push") {
    lastErrorAt = at;
  }
}
export function clearGmailApiErrorLog() {
  errorLog.length = 0;
}

function updateCount() {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as c FROM ingested_emails").get() as { c: number };
  ingestedCount = row.c;
}

// R4q parallel-run: this function lives alongside gmail.ts getGmailStatus().
// Routes.ts will expose this at /api/gmail-api/status while keeping the
// existing /api/gmail/status pointing at the IMAP path. Once API is proven
// reliable in R4r, the IMAP version goes away and this gets renamed.
// (Renamed below to avoid name collision when both modules are imported.)
function getGmailStatusInternal() {
  ensureStatusLoaded();
  updateCount();
  const conn = getGmailApiConnectedStatus();
  const state = getWatchState();
  const cfg = getConfig();
  const credsPresent = conn.connected;
  const connected = credsPresent && (lastSuccessAt !== null || lastError === null);

  let displayError: string | null = lastError;
  let displayErrorLog = errorLog.slice(0, 20);
  if (lastSuccessAt && lastErrorAt && new Date(lastSuccessAt) > new Date(lastErrorAt)) {
    displayError = null;
    displayErrorLog = errorLog.filter((e) => new Date(e.at) >= new Date(lastSuccessAt!)).slice(0, 20);
  }

  return {
    connected,
    configured: isGoogleConfigured(),
    // R4q: user/label become read-only descriptors; the API path uses OAuth + INBOX
    user: conn.granted_email || null,
    label: "INBOX",
    last_poll_at: lastPollAt,
    last_poll_attempt_at: lastPollAttemptAt,
    last_success_at: lastSuccessAt,
    last_error_at: lastErrorAt,
    last_push_at: lastPushAt,             // R4q: new
    ingested_count: ingestedCount,
    poll_interval_minutes: cfg.pollIntervalMinutes,
    error: displayError,
    error_log: displayErrorLog,
    error_log_full: errorLog.slice(0, 20),
    // R4q: API-specific surface
    transport: "gmail-api",
    watch_expiration: state.watchExpiration
      ? new Date(Number(state.watchExpiration)).toISOString()
      : null,
    last_history_id: state.lastHistoryId || null,
    granted_email: conn.granted_email,
    granted_at: conn.granted_at,
  };
}

// Detailed status for the parallel-run UI / debug. Same shape as the IMAP
// getGmailStatus() so the Settings panel can render either with one component.
export const getGmailIngestStatus = getGmailStatusInternal;

// ===== Helpers: parse Gmail message → invoice-like envelope =====

function decodeBase64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface ParsedGmailMessage {
  messageId: string;          // RFC 822 Message-ID header (preferred for dedup)
  gmailId: string;            // Gmail's API-internal id
  subject: string;
  from: string;
  dateIso: string | null;
  textBody: string;
  htmlBody: string;
  pdfAttachments: { filename: string; content: Buffer }[];
}

async function fetchAndParseMessage(
  gmail: gmail_v1.Gmail,
  gmailId: string
): Promise<ParsedGmailMessage> {
  const res = await gmail.users.messages.get({
    userId: "me",
    id: gmailId,
    format: "full",
  });
  const msg = res.data;
  const headers = msg.payload?.headers || [];
  const getHeader = (name: string): string => {
    const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
    return h?.value || "";
  };
  const messageId = getHeader("Message-ID") || `gmail-${gmailId}`;
  const subject = getHeader("Subject");
  const from = getHeader("From");
  const dateHeader = getHeader("Date");
  const dateIso = dateHeader ? new Date(dateHeader).toISOString() : null;

  let textBody = "";
  let htmlBody = "";
  const pdfAttachments: { filename: string; content: Buffer }[] = [];

  // Recursive walk over MIME parts
  const walk = async (part: gmail_v1.Schema$MessagePart) => {
    const mime = part.mimeType || "";
    const filename = part.filename || "";
    const isPdf =
      mime === "application/pdf" ||
      filename.toLowerCase().endsWith(".pdf");

    if (isPdf && part.body) {
      let content: Buffer | null = null;
      if (part.body.data) {
        content = decodeBase64Url(part.body.data);
      } else if (part.body.attachmentId) {
        const att = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: gmailId,
          id: part.body.attachmentId,
        });
        if (att.data.data) content = decodeBase64Url(att.data.data);
      }
      if (content) {
        pdfAttachments.push({
          filename: filename || `attachment-${pdfAttachments.length}.pdf`,
          content,
        });
      }
      return;
    }

    if (mime === "text/plain" && part.body?.data) {
      textBody += decodeBase64Url(part.body.data).toString("utf8");
    } else if (mime === "text/html" && part.body?.data) {
      htmlBody += decodeBase64Url(part.body.data).toString("utf8");
    }

    for (const child of part.parts || []) {
      await walk(child);
    }
  };

  if (msg.payload) await walk(msg.payload);

  return { messageId, gmailId, subject, from, dateIso, textBody, htmlBody, pdfAttachments };
}

// ===== Shared processing pipeline (mirrors gmail.ts lines 619-1003) =====

/**
 * Process a single Gmail message: Stage 1 pre-filter → LLM parse → vendor match
 * → dedup → INSERT invoice → QBO duplicate check.
 *
 * Returns the number of new invoice records created (0 if filtered out / dedup
 * collision / non-invoice). Errors are pushed to `errors[]` and recorded in the
 * rolling error log so the Settings UI can surface them.
 */
async function processOneGmailMessage(
  parsed: ParsedGmailMessage,
  errors: string[]
): Promise<number> {
  const db = getDb();
  const assetsDir = path.resolve(process.cwd(), "private_assets");
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  let newInvoices = 0;

  // Skip already ingested
  const existing = db.prepare("SELECT id FROM ingested_emails WHERE message_id = ?").get(parsed.messageId);
  if (existing) return 0;

  // Stage 1 pre-filter
  const stage1 = shouldSendToLlm({
    subject: parsed.subject,
    from: parsed.from,
    hasPdfAttachment: parsed.pdfAttachments.length > 0,
    bodySnippet: parsed.textBody || parsed.htmlBody,
  });

  if (!stage1.ok) {
    if (parsed.pdfAttachments.length > 0) {
      const fromShort = parsed.from.slice(0, 80);
      const subjShort = parsed.subject.slice(0, 120);
      console.log(`[gmail-stage1] SKIP pdf=${parsed.pdfAttachments.length} from="${fromShort}" subject="${subjShort}" reason="${stage1.reason}"`);
    }
    db.prepare(`INSERT OR IGNORE INTO ingested_emails (message_id, gmail_uid, subject, from_address, date, pdf_count, invoice_ids, ingested_at, skipped_count, skip_reasons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.messageId, parsed.gmailId,
      parsed.subject || null,
      parsed.from || null,
      parsed.dateIso,
      parsed.pdfAttachments.length,
      null,
      new Date().toISOString(),
      parsed.pdfAttachments.length || 1,
      JSON.stringify([`stage1: ${stage1.reason}`])
    );
    return 0;
  } else if (stage1.reason !== "keyword") {
    console.log(
      `[gmail-stage1] PASS via ${stage1.reason}="${stage1.matchedVendor}" ` +
      `from="${parsed.from.slice(0, 80)}" subject="${parsed.subject.slice(0, 120)}"`
    );
  }

  if (parsed.pdfAttachments.length === 0) {
    // Passed Stage 1 but no PDF — log as deferred (text-only invoice).
    db.prepare(`INSERT OR IGNORE INTO ingested_emails (message_id, gmail_uid, subject, from_address, date, pdf_count, invoice_ids, ingested_at, skipped_count, skip_reasons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parsed.messageId, parsed.gmailId,
      parsed.subject || null,
      parsed.from || null,
      parsed.dateIso,
      0, null, new Date().toISOString(),
      1,
      JSON.stringify(["text-only invoice, no PDF — deferred (future: LLM-parse from email body)"])
    );
    return 0;
  }

  const invoiceIds: string[] = [];
  const skipReasonsForEmail: string[] = [];
  let skippedCount = 0;

  for (const attachment of parsed.pdfAttachments) {
    try {
      const prefix = crypto.randomBytes(5).toString("hex");
      const safeName = (attachment.filename || "invoice.pdf").replace(/[^a-zA-Z0-9._\-]/g, "_");
      const filename = `${prefix}_${safeName}`;
      const filePath = path.join(assetsDir, filename);

      fs.writeFileSync(filePath, attachment.content);

      // ---- LLM-first parsing ----
      let llmResult: LLMParsedInvoice | null = null;
      let llmFailureReason: string | null = null;
      if (isLlmParserEnabled()) {
        clearLastLlmFailure();
        try {
          llmResult = await parseInvoiceWithLLM(attachment.content, {
            subject: parsed.subject || null,
            from: parsed.from || null,
            body: parsed.textBody || parsed.htmlBody || null,
          });
        } catch (llmErr: any) {
          llmFailureReason = `threw: ${llmErr.message}`;
          console.error("[gmail-api] LLM parser threw:", llmErr.message);
        }
        if (!llmResult && !llmFailureReason) {
          llmFailureReason = getLastLlmFailure() || "unknown LLM failure (returned null)";
        }
        if (!llmResult) {
          const fname = attachment.filename || "(unnamed)";
          skipReasonsForEmail.push(`LLM-fallback-to-regex: ${fname} — ${llmFailureReason}`);
          console.error(`[gmail-api] LLM failed for ${fname}: ${llmFailureReason} — falling back to regex`);
        }
      }

      // SKIP non-invoices flagged by the LLM
      if (llmResult && !llmResult.is_real_invoice) {
        const reason = `${attachment.filename || "(unnamed)"}: ${llmResult.document_type}${llmResult.skip_reason ? ` — ${llmResult.skip_reason}` : ""}`;
        skipReasonsForEmail.push(reason);
        skippedCount++;
        try { fs.unlinkSync(filePath); } catch {}
        console.log(`[gmail-api] Skipping non-invoice: ${reason}`);
        continue;
      }

      // PR #R4m due-date computation (normalize → fallback to terms)
      let parsed_data: {
        vendor_raw_name: string | null;
        invoice_number: string | null;
        invoice_date: string | null;
        due_date: string | null;
        total: number | null;
        low_confidence: boolean;
        freight: number;
        is_credit: boolean;
        payment_terms: string | null;
      };
      if (llmResult) {
        const normalizedDue = normalizeDueDate(llmResult.due_date, llmResult.invoice_date);
        const fallbackDue = !normalizedDue && llmResult.invoice_date
          ? computeDueDateFromTerms(
              llmResult.invoice_date,
              llmResult.payment_terms || llmResult.payment_method || null,
            )
          : null;
        parsed_data = {
          vendor_raw_name: llmResult.vendor_raw_name,
          invoice_number: llmResult.invoice_number,
          invoice_date: llmResult.invoice_date,
          due_date: normalizedDue || fallbackDue,
          total: llmResult.total,
          low_confidence: llmResult.parse_confidence === "low",
          freight: llmResult.freight ?? 0,
          is_credit: llmResult.is_credit,
          payment_terms: llmResult.payment_terms ?? null,
        };
      } else {
        // No regex fallback in the API path — if the LLM failed, persist with nulls
        // and let Jake reparse from the UI. R4q deliberately drops the pdf-parse
        // regex fallback because it was wrong >50% of the time and produced bad
        // ledger entries; the LLM is reliable enough now that a UI reparse is the
        // right path for the occasional failure.
        parsed_data = {
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
      }

      const invoiceId = `${prefix}_${safeName.replace(/\.pdf$/i, "")}`;
      const now = new Date().toISOString();

      // Vendor matching
      let vendorMatch = smartMatchVendor(parsed_data.vendor_raw_name);
      let vendorMatchStatus = vendorMatch?.vendor_match_status || "unmatched";
      let vendorQboId = vendorMatch?.vendor_qbo_id || null;
      let vendorQboName = vendorMatch?.vendor_qbo_name || null;

      if (!vendorMatch && parsed_data.vendor_raw_name && isVendorMatcherLlmEnabled()) {
        try {
          const llmMatch = await matchVendorWithLlm(parsed_data.vendor_raw_name);
          if (llmMatch?.vendor_qbo_id && llmMatch.confidence === "high") {
            vendorQboId = llmMatch.vendor_qbo_id;
            vendorQboName = llmMatch.vendor_qbo_name;
            vendorMatchStatus = "aliased";
            learnVendorAlias(parsed_data.vendor_raw_name, llmMatch.vendor_qbo_id, llmMatch.vendor_qbo_name || "", "learned-from-llm-high-confidence");
            console.log(`[gmail-api] Claude vendor match (high): "${parsed_data.vendor_raw_name}" → ${vendorQboName} (saved alias)`);
          }
        } catch (llmErr: any) {
          console.warn(`[gmail-api] Claude vendor match failed (non-fatal): ${llmErr.message}`);
        }
      }

      const shipToStore = resolveShipToStore(llmResult?.store_hint || null, vendorQboId);

      // Dedup (same logic as gmail.ts)
      try {
        if (parsed_data.invoice_number && parsed_data.total != null) {
          const rawTrim = (parsed_data.vendor_raw_name || "").trim();
          const dupRawLike = rawTrim ? `%${rawTrim.slice(0, 30)}%` : null;
          const dup = db.prepare(
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
          if (dup) {
            console.log(`[gmail-api] dedup: skipping duplicate of ${dup.id} (invoice_number=${parsed_data.invoice_number}, total=${parsed_data.total})`);
            try { fs.unlinkSync(filePath); } catch {}
            continue;
          }
        }
      } catch (dedupErr: any) {
        console.error(`[gmail-api] dedup check failed (continuing): ${dedupErr.message}`);
      }

      db.prepare(`
        INSERT OR IGNORE INTO invoices (
          id, source_file, email_id, email_date, email_from, email_subject,
          pdf_url, vendor_raw_name, vendor_match_status, vendor_qbo_id, vendor_qbo_name,
          invoice_number, invoice_date, due_date, total, freight, is_credit,
          ship_to_store, parse_confidence, status, routing_mode, routing_data, duplicate_check_status,
          created_at, updated_at,
          document_type, store_hint, llm_notes, already_paid, line_items_json, bill_kind,
          payment_terms
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        invoiceId,
        `${prefix}_${safeName.replace(/\.pdf$/i, "")}.txt`,
        parsed.messageId,
        (parsed.dateIso ? parsed.dateIso.slice(0, 10) : null),
        parsed.from || null,
        parsed.subject || null,
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
        parsed_data.payment_terms
      );

      try {
        if (Array.isArray(llmResult?.line_items) && llmResult.line_items.length > 0) {
          replaceInvoiceLineItems(invoiceId, llmResult.line_items as any);
        }
      } catch (e) {
        console.error(`[gmail-api] line-item persist failed for ${invoiceId}:`, (e as Error).message);
      }

      console.log(`[gmail-api] Ingested ${invoiceId}: vendor="${parsed_data.vendor_raw_name}" → ${vendorMatchStatus}${vendorQboName ? ` (${vendorQboName})` : ""}, store=${shipToStore || "unknown"}`);

      // Auto QBO duplicate check at ingest (R4m semantics)
      if (parsed_data.invoice_number) {
        try {
          const qboState = getQboStatus();
          if (qboState.connected) {
            const [bills, vendorCredits, payments] = await Promise.all([
              searchBills([parsed_data.invoice_number]),
              searchVendorCredits([parsed_data.invoice_number]),
              searchPayments([parsed_data.invoice_number]),
            ]);
            if (bills.length > 0 || vendorCredits.length > 0 || payments.length > 0) {
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
              const firstCredit = vendorCredits[0];
              const creditId = firstCredit?.Id || null;
              const creditTotal = Number(firstCredit?.TotalAmt || 0);
              const creditLabel = firstCredit ? ` — $${creditTotal.toFixed(2)}` : "";
              const paymentId = payments[0]?.Id || null;
              const note = [
                bills.length > 0 ? `Auto-skipped at ingest: Bill #${billId} already in QBO${paymentLabel}` : null,
                vendorCredits.length > 0 ? `Auto-skipped at ingest: VendorCredit #${creditId} already in QBO${creditLabel}` : null,
                payments.length > 0 ? `BillPayment #${paymentId} found` : null,
              ].filter(Boolean).join("; ");
              const linkedQboId = billId || creditId;
              db.prepare(`UPDATE invoices SET status = ?, duplicate_check_status = ?, duplicate_check_at = ?, qbo_bill_id = ?, notes = ?, updated_at = ? WHERE id = ?`)
                .run("posted_qbo", "duplicate_found", new Date().toISOString(), linkedQboId, note, new Date().toISOString(), invoiceId);
              db.prepare(`INSERT INTO audit_log (invoice_id, action, before, after, user_email, created_at) VALUES (?,?,?,?,?,?)`)
                .run(invoiceId, "auto_skip_existing_qbo_bill",
                  JSON.stringify({ status: "pending_review" }),
                  JSON.stringify({ status: "posted_qbo", qbo_bill_id: linkedQboId, note }),
                  "system@ingest",
                  new Date().toISOString());
              console.log(`[gmail-api] Auto-skipped ${invoiceId} — already in QBO as ${billId ? `Bill #${billId}${paymentLabel}` : `VendorCredit #${creditId}${creditLabel}`}`);
            } else {
              db.prepare(`UPDATE invoices SET duplicate_check_status = ?, duplicate_check_at = ?, updated_at = ? WHERE id = ?`)
                .run("clean", new Date().toISOString(), new Date().toISOString(), invoiceId);
            }
          }
        } catch (qboErr: any) {
          console.warn(`[gmail-api] QBO duplicate check at ingest failed (non-fatal): ${qboErr.message}`);
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

  db.prepare(`INSERT OR IGNORE INTO ingested_emails (message_id, gmail_uid, subject, from_address, date, pdf_count, invoice_ids, ingested_at, skipped_count, skip_reasons)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    parsed.messageId, parsed.gmailId,
    parsed.subject || null,
    parsed.from || null,
    parsed.dateIso,
    parsed.pdfAttachments.length,
    JSON.stringify(invoiceIds),
    new Date().toISOString(),
    skippedCount,
    skipReasonsForEmail.length ? JSON.stringify(skipReasonsForEmail) : null
  );

  return newInvoices;
}

// ===== Public: poll fallback (lists recent INBOX messages) =====

/**
 * Manual / scheduled poll fallback. Push notifications are the primary path,
 * but a periodic poll fills any gap from a missed push (server restart, expired
 * watch, Pub/Sub backlog drop).
 *
 * Uses Gmail's `q=newer_than:Nd in:inbox` search instead of IMAP SINCE.
 */
export async function pollNowApi(): Promise<{ new_invoices: number; errors: string[] }> {
  if (pollRunning) {
    return { new_invoices: 0, errors: ["Poll already in progress"] };
  }

  pollRunning = true;
  lastError = null;
  lastPollAttemptAt = new Date().toISOString();
  let newInvoices = 0;
  const errors: string[] = [];

  try {
    const gmail = await getValidGmailClient();
    if (!gmail) {
      const msg = "Gmail not connected — visit Settings → Gmail to authorize.";
      lastError = msg;
      recordError("poll", msg);
      return { new_invoices: 0, errors: [msg] };
    }

    const cfg = getConfig();
    const q = `in:inbox newer_than:${cfg.lookbackDays}d has:attachment filename:pdf`;

    // List matching message ids (paginate)
    const ids: string[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const list: any = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 100,
        pageToken,
      });
      for (const m of (list.data.messages || [])) {
        if (m.id) ids.push(m.id);
      }
      pageToken = list.data.nextPageToken || undefined;
    } while (pageToken && ids.length < 500); // safety cap

    lastSuccessAt = new Date().toISOString();
    persistStatus();

    for (const id of ids) {
      try {
        const parsed = await fetchAndParseMessage(gmail, id);
        newInvoices += await processOneGmailMessage(parsed, errors);
      } catch (msgErr: any) {
        const mMsg = `Message ${id} error: ${msgErr?.message || String(msgErr)}`;
        errors.push(mMsg);
        recordError("message", mMsg);
        console.error("[gmail-api]", mMsg, "\n", msgErr?.stack || "(no stack)");
      }
    }

    lastPollAt = new Date().toISOString();
    persistStatus();
    console.log(`[gmail-api] Poll complete. New invoices: ${newInvoices} (scanned ${ids.length} messages)`);
  } catch (err: any) {
    lastError = err?.message || String(err);
    errors.push(lastError!);
    recordError("poll", lastError!);
    console.error("[gmail-api] poll ERROR", lastError, "\n", err?.stack || "(no stack)");
  } finally {
    pollRunning = false;
  }

  return { new_invoices: newInvoices, errors };
}



// ===== Public: Pub/Sub push handler =====
//
// Pub/Sub POSTs a JSON envelope to /api/gmail/push that looks like:
//   { message: { data: <base64({"emailAddress":"...","historyId":"123"})>, messageId: "...", publishTime: "..." }, subscription: "..." }
// The route handler decodes and forwards the historyId to this function.

export async function processHistoryPush(historyId: string): Promise<{ new_invoices: number; errors: string[] }> {
  lastPushAt = new Date().toISOString();
  const errors: string[] = [];
  let newInvoices = 0;

  try {
    const gmail = await getValidGmailClient();
    if (!gmail) {
      const msg = "Gmail not connected — push ignored.";
      recordError("push", msg);
      return { new_invoices: 0, errors: [msg] };
    }

    const startHistoryId = getLastHistoryId();
    if (!startHistoryId) {
      // No baseline yet — start watch + treat this push as "ack and wait for next".
      // The watch call will store a fresh historyId.
      console.warn("[gmail-api] push received without baseline historyId — registering watch");
      await startGmailWatch();
      return { new_invoices: 0, errors: [] };
    }

    // Walk history pages and collect added INBOX message ids.
    const addedIds = new Set<string>();
    let pageToken: string | undefined = undefined;
    do {
      try {
        const h: any = await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
          labelId: "INBOX",
          maxResults: 100,
          pageToken,
        });
        for (const rec of h.data.history || []) {
          for (const ma of rec.messagesAdded || []) {
            if (ma.message?.id) addedIds.add(ma.message.id);
          }
        }
        pageToken = h.data.nextPageToken || undefined;
      } catch (e: any) {
        // 404 = historyId too old (>7 days). Re-register watch to reset baseline.
        if (e.code === 404 || /not found|invalid/i.test(e.message)) {
          console.warn("[gmail-api] history baseline expired — re-registering watch");
          await startGmailWatch();
          return { new_invoices: 0, errors: ["history expired, watch re-registered"] };
        }
        throw e;
      }
    } while (pageToken);

    // Advance baseline to the historyId Pub/Sub gave us (next push picks up from here).
    setLastHistoryId(historyId);
    lastSuccessAt = new Date().toISOString();
    persistStatus();

    if (addedIds.size === 0) {
      console.log("[gmail-api] push: no new INBOX messages in history delta");
      return { new_invoices: 0, errors: [] };
    }

    console.log(`[gmail-api] push: processing ${addedIds.size} new message(s)`);
    for (const id of Array.from(addedIds)) {
      try {
        const parsed = await fetchAndParseMessage(gmail, id);
        newInvoices += await processOneGmailMessage(parsed, errors);
      } catch (msgErr: any) {
        const mMsg = `Push message ${id} error: ${msgErr?.message || String(msgErr)}`;
        errors.push(mMsg);
        recordError("message", mMsg);
      }
    }
  } catch (err: any) {
    const eMsg = err?.message || String(err);
    errors.push(eMsg);
    recordError("push", eMsg);
    console.error("[gmail-api] push ERROR", eMsg, "\n", err?.stack || "(no stack)");
  }

  return { new_invoices: newInvoices, errors };
}

// ===== Boot wiring =====

/**
 * Call once on server boot. Gated by GMAIL_API_ENABLED env flag so the
 * parallel-run path can be toggled off without code changes. Registers the
 * Gmail watch if connected, then sets a 6-day timer to renew it (Gmail
 * watches expire after 7 days). Also runs a backfill poll on boot to catch
 * anything missed while the server was down or the watch was expired.
 */
export function startGmailApiService() {
  const flag = (process.env.GMAIL_API_ENABLED || "").toLowerCase();
  if (flag !== "true" && flag !== "1" && flag !== "yes") {
    console.log("[gmail-api] GMAIL_API_ENABLED is not set — Gmail API parallel-run path disabled (IMAP-only mode)");
    return;
  }
  ensureStatusLoaded();
  if (!isGoogleConfigured()) {
    console.log("[gmail-api] GOOGLE_CLIENT_ID/SECRET not set — Gmail API service disabled");
    return;
  }
  if (!getGmailTokens()) {
    console.log("[gmail-api] No tokens yet — connect Gmail in Settings to enable ingest");
    return;
  }

  // Backfill poll on boot
  pollNowApi().catch((e) => console.error("[gmail-api] boot poll failed:", e.message));

  // Register watch + renewal timer
  startWatchRenewalTimer();

  // Safety-net periodic poll (rare; mostly to catch a missed push during a Pub/Sub outage)
  const cfg = getConfig();
  setInterval(() => {
    pollNowApi().catch((e) => console.error("[gmail-api] periodic poll failed:", e.message));
  }, Math.max(15, cfg.pollIntervalMinutes) * 60 * 1000);

  console.log(`[gmail-api] Service started (parallel-run mode — IMAP still active). Push topic: ${PUBSUB_TOPIC}`);
}

export function isGmailApiEnabled(): boolean {
  const flag = (process.env.GMAIL_API_ENABLED || "").toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

// ===== Reingest (UI: "Reingest from inbox") =====
//
// Deletes ingested_emails rows for messages from a given sender or subject filter,
// then re-runs pollNow so they re-evaluate against the current Stage 1 / LLM rules.
// Mirrors gmail.ts reingestEmails() so the existing routes endpoint keeps working.

export async function reingestEmailsApi(opts: {
  from?: string;
  subject?: string;
  since?: string; // ISO date
  dryRun?: boolean;
}): Promise<{ cleared: number; matched_messages: { message_id: string; subject: string | null; from_address: string | null; date: string | null }[]; }> {
  const db = getDb();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.from) {
    where.push("from_address LIKE ?");
    params.push(`%${opts.from}%`);
  }
  if (opts.subject) {
    where.push("subject LIKE ?");
    params.push(`%${opts.subject}%`);
  }
  if (opts.since) {
    where.push("date >= ?");
    params.push(opts.since);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const matched = db.prepare(
    `SELECT message_id, subject, from_address, date FROM ingested_emails ${whereSql} ORDER BY date DESC LIMIT 500`
  ).all(...params) as { message_id: string; subject: string | null; from_address: string | null; date: string | null }[];

  if (opts.dryRun) {
    return { cleared: 0, matched_messages: matched };
  }

  const cleared = db.prepare(`DELETE FROM ingested_emails ${whereSql}`).run(...params).changes;
  console.log(`[gmail-api] reingest cleared ${cleared} rows; next poll will re-evaluate`);
  return { cleared, matched_messages: matched };
}
