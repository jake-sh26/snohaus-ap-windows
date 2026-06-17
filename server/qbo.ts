/**
 * QuickBooks Online OAuth 2.0 integration
 *
 * Required env vars:
 *   QBO_CLIENT_ID       – from developer.intuit.com app
 *   QBO_CLIENT_SECRET   – from developer.intuit.com app
 *   QBO_ENVIRONMENT     – "sandbox" | "production"  (default: "sandbox")
 *   QBO_REDIRECT_URI    – e.g. http://localhost:5000/api/qbo/callback
 *
 * Token storage: SQLite table `qbo_tokens` (single-row).
 */

import Database from "better-sqlite3";
import path from "node:path";
import {
  recordIntegrationError,
  recordIntegrationWarn,
  getIntegrationErrorLog,
  clearIntegrationErrorLog,
} from "./error-log";

// Convenience wrappers — always tag entries with integration="qbo"
function qboError(scope: string, msg: string) { recordIntegrationError("qbo", scope, msg, "error"); }
function qboWarn(scope: string, msg: string) { recordIntegrationWarn("qbo", scope, msg); }
export function getQboErrorLog(limit = 20) { return getIntegrationErrorLog("qbo", limit); }
export function clearQboErrorLog() { clearIntegrationErrorLog("qbo"); }

// Re-use the same SQLite database file as storage.ts
import { getDbPath } from "./db-path";
const DB_PATH = getDbPath(); // PR #R4j: NSSM-safe path
let _db: ReturnType<typeof Database> | null = null;
function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS qbo_tokens (
        id INTEGER PRIMARY KEY,
        realm_id TEXT,
        access_token TEXT,
        refresh_token TEXT,
        access_expires_at INTEGER,
        refresh_expires_at INTEGER,
        updated_at TEXT
      );
    `);
  }
  return _db;
}

// ---- Config ----
function getConfig() {
  return {
    clientId: process.env.QBO_CLIENT_ID || "",
    clientSecret: process.env.QBO_CLIENT_SECRET || "",
    environment: (process.env.QBO_ENVIRONMENT || "sandbox") as "sandbox" | "production",
    redirectUri: process.env.QBO_REDIRECT_URI || "http://localhost:5000/api/qbo/callback",
  };
}

const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPES = ["com.intuit.quickbooks.accounting"];

function apiBase(realmId: string, environment: string) {
  if (environment === "production") {
    return `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
  }
  return `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}`;
}

// ---- Token persistence ----
interface TokenRow {
  id: number;
  realm_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
  updated_at: string;
}

function readTokens(): TokenRow | undefined {
  return getDb().prepare("SELECT * FROM qbo_tokens WHERE id = 1").get() as TokenRow | undefined;
}

function saveTokens(row: Omit<TokenRow, "id">) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM qbo_tokens WHERE id = 1").get();
  if (existing) {
    db.prepare(`
      UPDATE qbo_tokens SET realm_id=?, access_token=?, refresh_token=?,
        access_expires_at=?, refresh_expires_at=?, updated_at=? WHERE id=1
    `).run(row.realm_id, row.access_token, row.refresh_token, row.access_expires_at, row.refresh_expires_at, row.updated_at);
  } else {
    db.prepare(`
      INSERT INTO qbo_tokens (id, realm_id, access_token, refresh_token, access_expires_at, refresh_expires_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
    `).run(row.realm_id, row.access_token, row.refresh_token, row.access_expires_at, row.refresh_expires_at, row.updated_at);
  }
}

function clearTokens() {
  getDb().prepare("DELETE FROM qbo_tokens WHERE id = 1").run();
}

// ---- Public API ----

export function getQboStatus() {
  const cfg = getConfig();
  if (!cfg.clientId) {
    return { connected: false, realmId: null, environment: cfg.environment, expiresIn: null, configured: false };
  }
  const tokens = readTokens();
  if (!tokens) {
    return { connected: false, realmId: null, environment: cfg.environment, expiresIn: null, configured: true };
  }
  const now = Date.now();
  const accessValid = tokens.access_expires_at > now;
  const refreshValid = tokens.refresh_expires_at > now;
  if (!refreshValid) {
    // Refresh token expired — effectively disconnected
    return { connected: false, realmId: tokens.realm_id, environment: cfg.environment, expiresIn: null, configured: true, error: "Refresh token expired — please reconnect" };
  }
  const expiresIn = accessValid ? Math.round((tokens.access_expires_at - now) / 1000) : 0;
  return { connected: true, realmId: tokens.realm_id, environment: cfg.environment, expiresIn, configured: true };
}

export function getAuthUrl(state: string): string {
  const cfg = getConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    scope: SCOPES.join(" "),
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    access_type: "offline",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCode(code: string, realmId: string, _state?: string): Promise<void> {
  const cfg = getConfig();
  const credentials = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    qboError("auth", `Token exchange failed (${res.status}): ${text.slice(0, 500)}`);
    throw new Error(`QBO token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as any;
  const now = Date.now();
  saveTokens({
    realm_id: realmId,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    access_expires_at: now + (data.expires_in || 3600) * 1000,
    refresh_expires_at: now + (data.x_refresh_token_expires_in || 8726400) * 1000,
    updated_at: new Date().toISOString(),
  });
  console.log(`[QBO] Connected to realm ${realmId} (${cfg.environment})`);
}

export async function refreshTokens(): Promise<void> {
  const cfg = getConfig();
  const tokens = readTokens();
  if (!tokens) throw new Error("No QBO tokens to refresh");

  const credentials = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    qboError("auth", `Token refresh failed (${res.status}): ${text.slice(0, 500)}`);
    throw new Error(`QBO token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as any;
  const now = Date.now();
  saveTokens({
    realm_id: tokens.realm_id,
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    access_expires_at: now + (data.expires_in || 3600) * 1000,
    refresh_expires_at: now + (data.x_refresh_token_expires_in || 8726400) * 1000,
    updated_at: new Date().toISOString(),
  });
  console.log("[QBO] Tokens refreshed");
}

export function disconnectQbo(): void {
  clearTokens();
  console.log("[QBO] Disconnected");
}

/** Auto-refresh tokens if near expiry, then make authenticated QBO API request */
export async function qboFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const cfg = getConfig();
  let tokens = readTokens();
  if (!tokens) throw new Error("QBO not connected");

  // Refresh if access token expires within 5 minutes
  if (tokens.access_expires_at - Date.now() < 5 * 60 * 1000) {
    await refreshTokens();
    tokens = readTokens()!;
  }

  const base = apiBase(tokens.realm_id, cfg.environment);
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${tokens.access_token}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });

  if (res.status === 401) {
    // Try one refresh and retry
    await refreshTokens();
    tokens = readTokens()!;
    const retry = await fetch(url, {
      ...opts,
      headers: {
        "Authorization": `Bearer ${tokens.access_token}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    if (!retry.ok) {
      const text = await retry.text();
      const tid = retry.headers.get("intuit_tid") || "";
      console.error(`[QBO] API error ${retry.status} (intuit_tid=${tid}) ${url}: ${text}`);
      qboError("api", `${retry.status} ${url} [tid=${tid}]: ${text.slice(0, 500)}`);
      throw new Error(`QBO API error (${retry.status}) [tid=${tid}]: ${text}`);
    }
    return retry.json();
  }

  if (!res.ok) {
    const text = await res.text();
    const tid = res.headers.get("intuit_tid") || "";
    console.error(`[QBO] API error ${res.status} (intuit_tid=${tid}) ${url}: ${text}`);
    qboError("api", `${res.status} ${url} [tid=${tid}]: ${text.slice(0, 500)}`);
    throw new Error(`QBO API error (${res.status}) [tid=${tid}]: ${text}`);
  }
  return res.json();
}

/** Search QBO Bills by DocNumber (invoice number). Chunks large lists. */
export async function searchBills(docNumbers: string[]): Promise<any[]> {
  if (!docNumbers.length) return [];
  // QBO supports IN queries; chunk into groups of 20
  const chunks: string[][] = [];
  for (let i = 0; i < docNumbers.length; i += 20) {
    chunks.push(docNumbers.slice(i, i + 20));
  }
  const results: any[] = [];
  for (const chunk of chunks) {
    const nums = chunk.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ");
    const query = `select Id, DocNumber, TxnDate, TotalAmt, Balance, VendorRef from Bill where DocNumber in (${nums})`;
    const data = await qboFetch(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
    const rows = data?.QueryResponse?.Bill || [];
    results.push(...rows);
  }
  return results;
}

/**
 * Search QBO Vendor Credits by DocNumber. PR #R4m — the existing
 * `searchBills` only queries the Bill entity, but vendor credits (e.g. RMA
 * credits, return-merchandise refunds) post to QBO under the VendorCredit
 * entity at /vendorcredit, not /bill. Without this, the duplicate check on a
 * credit memo invoice never flagged the existing QBO record. Same DocNumber-IN
 * shape as searchBills so callers can union the results.
 */
export async function searchVendorCredits(docNumbers: string[]): Promise<any[]> {
  if (!docNumbers.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < docNumbers.length; i += 20) {
    chunks.push(docNumbers.slice(i, i + 20));
  }
  const results: any[] = [];
  for (const chunk of chunks) {
    const nums = chunk.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ");
    const query = `select Id, DocNumber, TxnDate, TotalAmt, Balance, VendorRef from VendorCredit where DocNumber in (${nums})`;
    try {
      const data = await qboFetch(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
      const rows = data?.QueryResponse?.VendorCredit || [];
      results.push(...rows);
    } catch (err: any) {
      console.warn(`[QBO] VendorCredit query failed (non-fatal): ${err.message}`);
      qboWarn("vendorcredit", `VendorCredit query failed (non-fatal): ${err.message}`);
    }
  }
  return results;
}

/**
 * Search QBO Payments by PaymentRefNum (a.k.a. "Reference no." / check number on a bill payment).
 * NOTE: QBO Payment entities apply to AR (customer) Payments, not bill payments. AP bill payments
 * live as BillPayment entities. We try BillPayment first — falls back to empty if not searchable.
 */
export async function searchPayments(docNumbers: string[]): Promise<any[]> {
  if (!docNumbers.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < docNumbers.length; i += 20) {
    chunks.push(docNumbers.slice(i, i + 20));
  }
  const results: any[] = [];
  for (const chunk of chunks) {
    const nums = chunk.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ");
    // BillPayment is the AP equivalent. Use DocNumber field.
    const query = `select Id, TxnDate, TotalAmt, VendorRef, DocNumber from BillPayment where DocNumber in (${nums})`;
    try {
      const data = await qboFetch(`/query?query=${encodeURIComponent(query)}&minorversion=65`);
      const rows = data?.QueryResponse?.BillPayment || [];
      // Normalize so caller can read EntityRef like before
      for (const r of rows) {
        results.push({ ...r, EntityRef: r.VendorRef });
      }
    } catch (err: any) {
      console.warn(`[QBO] BillPayment query failed (non-fatal): ${err.message}`);
      qboWarn("billpayment", `BillPayment query failed (non-fatal): ${err.message}`);
    }
  }
  return results;
}

/** Search QBO vendors */
export async function searchVendor(query: string, limit = 20): Promise<any[]> {
  const q = `select Id, DisplayName, CompanyName from Vendor where Active = true and DisplayName like '%${query.replace(/'/g, "''")}%' MAXRESULTS ${limit}`;
  const data = await qboFetch(`/query?query=${encodeURIComponent(q)}&minorversion=65`);
  return data?.QueryResponse?.Vendor || [];
}

/**
 * Create a Bill in QBO.
 * payload should already be a valid QBO Bill object (VendorRef, TxnDate, DocNumber, Line[]).
 */
export async function createBill(payload: any): Promise<any> {
  return qboFetch("/bill?minorversion=65", {
    method: "POST",
    body: JSON.stringify({ ...payload, sparse: false }),
  });
}

/**
 * Create a Vendor Credit in QBO.
 * Same line structure as a Bill (AccountBasedExpenseLineDetail), positive amounts —
 * QBO treats this entity type as a reduction of vendor balance automatically.
 * Endpoint: /vendorcredit (NOT /bill).
 */
export async function createVendorCredit(payload: any): Promise<any> {
  return qboFetch("/vendorcredit?minorversion=65", {
    method: "POST",
    body: JSON.stringify({ ...payload, sparse: false }),
  });
}

/**
 * Pull ALL vendors from QBO (paged, 1000 per page) and upsert into qbo_vendors_cache.
 * - Adds new vendors, updates DisplayName/CompanyName/Active/last_seen_at on existing.
 * - Vendors that disappear from QBO get inactive_at stamped (kept for history per user pref).
 * Returns counts.
 */
export async function syncQboVendorsFromApi(): Promise<{ total: number; new: number; updated: number; deactivated: number }> {
  const status = getQboStatus();
  if (!status.connected) throw new Error("QBO not connected");
  const db = getDb();
  // Ensure cache table exists (also created in storage.ts bootstrap, but be defensive).
  db.exec(`
    CREATE TABLE IF NOT EXISTS qbo_vendors_cache (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      company_name TEXT,
      active INTEGER DEFAULT 1,
      last_seen_at TEXT,
      inactive_at TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_qbo_vendors_cache_name_lower ON qbo_vendors_cache(LOWER(display_name));
  `);

  const now = new Date().toISOString();
  const seen = new Set<string>();
  let pageStart = 1;
  const pageSize = 1000;
  let added = 0;
  let updated = 0;

  // Fetch ALL vendors (active + inactive) so we mirror QBO state.
  // QBO query language: STARTPOSITION starts at 1.
  while (true) {
    const q = `select Id, DisplayName, CompanyName, Active from Vendor STARTPOSITION ${pageStart} MAXRESULTS ${pageSize}`;
    const data = await qboFetch(`/query?query=${encodeURIComponent(q)}&minorversion=65`);
    const rows: any[] = data?.QueryResponse?.Vendor || [];
    if (rows.length === 0) break;
    const upsert = db.prepare(`
      INSERT INTO qbo_vendors_cache (id, display_name, company_name, active, last_seen_at, inactive_at, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        company_name = excluded.company_name,
        active = excluded.active,
        last_seen_at = excluded.last_seen_at,
        inactive_at = NULL
    `);
    const txn = db.transaction((items: any[]) => {
      for (const v of items) {
        if (!v.Id || !v.DisplayName) continue;
        seen.add(String(v.Id));
        const before = db.prepare("SELECT id FROM qbo_vendors_cache WHERE id = ?").get(String(v.Id));
        upsert.run(
          String(v.Id),
          String(v.DisplayName),
          v.CompanyName ? String(v.CompanyName) : null,
          v.Active === false ? 0 : 1,
          now,
          now,
        );
        if (before) updated++; else added++;
      }
    });
    txn(rows);
    if (rows.length < pageSize) break;
    pageStart += pageSize;
    // Safety cap.
    if (pageStart > 100000) break;
  }

  // Mark vendors not seen this run as inactive (but keep the row).
  const allCached = db.prepare("SELECT id FROM qbo_vendors_cache").all() as { id: string }[];
  let deactivated = 0;
  const stampInactive = db.prepare("UPDATE qbo_vendors_cache SET active = 0, inactive_at = ? WHERE id = ? AND (inactive_at IS NULL OR inactive_at = '')");
  for (const r of allCached) {
    if (!seen.has(r.id)) { stampInactive.run(now, r.id); deactivated++; }
  }

  console.log(`[QBO vendor sync] total=${seen.size} new=${added} updated=${updated} deactivated=${deactivated}`);

  // Also persist a snapshot of the live vendor list to private_assets/qbo_vendors_live.json.
  // This becomes the cold-start fallback so a fresh install / wiped data.db never reverts to
  // the stale 200-vendor JSON baked into the bundle.
  try {
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    const liveRows = db.prepare(
      "SELECT id, display_name, company_name, active FROM qbo_vendors_cache ORDER BY display_name COLLATE NOCASE"
    ).all() as { id: string; display_name: string; company_name: string | null; active: number }[];
    const snapshot = {
      saved_at: new Date().toISOString(),
      result: {
        QueryResponse: {
          Vendor: liveRows.map((r) => ({
            Id: r.id,
            DisplayName: r.display_name,
            CompanyName: r.company_name || undefined,
            Active: r.active === 1,
          })),
        },
      },
    };
    const dir = pathMod.resolve(process.cwd(), "private_assets");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const outPath = pathMod.join(dir, "qbo_vendors_live.json");
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`[qbo] Live vendor snapshot saved: ${liveRows.length} vendors -> ${outPath}`);
  } catch (e: any) {
    console.warn("[qbo] Could not save live vendor snapshot:", e?.message || e);
    qboWarn("vendor-sync", `Could not save live vendor snapshot: ${e?.message || e}`);
  }

  return { total: seen.size, new: added, updated, deactivated };
}

/** Returns ms since last successful vendor sync, or null if never. */
export function lastVendorSyncAge(): { last_synced_at: string | null; count: number } {
  const db = getDb();
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS qbo_vendors_cache (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, company_name TEXT,
      active INTEGER DEFAULT 1, last_seen_at TEXT, inactive_at TEXT, created_at TEXT
    )`);
  } catch {}
  const last = db.prepare("SELECT MAX(last_seen_at) as t, COUNT(*) as c FROM qbo_vendors_cache").get() as { t: string | null; c: number };
  return { last_synced_at: last?.t || null, count: last?.c || 0 };
}
