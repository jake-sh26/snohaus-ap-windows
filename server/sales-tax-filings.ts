/**
 * Sales Tax — filings state (PR #165).
 *
 * Tracks the open/filed/amended status of each NY sales-tax period so the
 * Sales Tax UI (PR #167) can render a filing checklist and let an authorized
 * user mark a period filed (with confirmation number + notes).
 *
 * period_key is either a month ("2026-05") or an ST-810 quarter ("2026-Q2").
 * Both share this table; period_type disambiguates.
 */
import { sqlite } from "./storage";

export type FilingStatus = "open" | "filed" | "amended";
export type PeriodType = "month" | "quarter";

export interface SalesTaxFilingRow {
  period_key: string;
  period_type: PeriodType;
  status: FilingStatus;
  filed_at: string | null;
  confirmation_number: string | null;
  filed_by_user_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Idempotent schema-ensure. Called once at startup from bootstrapSchema().
 * filed_by_user_id is a plain INTEGER (no FK) — app_users is the user table
 * but we keep this loose so a deleted user never orphans a historical filing.
 */
export function ensureSalesTaxFilingsSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sales_tax_filings (
      period_key TEXT PRIMARY KEY,
      period_type TEXT NOT NULL CHECK (period_type IN ('month','quarter')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filed','amended')),
      filed_at TEXT NULL,
      confirmation_number TEXT NULL,
      filed_by_user_id INTEGER NULL,
      notes TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sales_tax_filings_status
      ON sales_tax_filings(status);
  `);
}

/** Fetch a single filing row by period key. null if none exists yet. */
export function getFiling(periodKey: string): SalesTaxFilingRow | null {
  const row = sqlite
    .prepare(`SELECT * FROM sales_tax_filings WHERE period_key = ?`)
    .get(periodKey) as SalesTaxFilingRow | undefined;
  return row ?? null;
}

/**
 * The "open" placeholder returned by the read endpoints when no row exists.
 * Keeps the API shape stable whether or not a period has been touched.
 */
export function openFilingPlaceholder(periodKey: string): SalesTaxFilingRow {
  return {
    period_key: periodKey,
    period_type: periodKey.includes("-Q") ? "quarter" : "month",
    status: "open",
    filed_at: null,
    confirmation_number: null,
    filed_by_user_id: null,
    notes: null,
    created_at: "",
    updated_at: "",
  };
}

export interface UpsertFilingInput {
  status?: FilingStatus;
  filed_at?: string | null;
  confirmation_number?: string | null;
  notes?: string | null;
  filed_by_user_id?: number | null;
}

/**
 * Upsert a filing row. period_type is derived from the key shape. On conflict
 * we update the provided columns and always bump updated_at. Returns the row.
 */
export function upsertFiling(
  periodKey: string,
  input: UpsertFilingInput,
): SalesTaxFilingRow {
  const periodType: PeriodType = periodKey.includes("-Q") ? "quarter" : "month";
  const status: FilingStatus = input.status ?? "open";
  sqlite
    .prepare(`
      INSERT INTO sales_tax_filings (
        period_key, period_type, status, filed_at, confirmation_number,
        filed_by_user_id, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(period_key) DO UPDATE SET
        status = excluded.status,
        filed_at = excluded.filed_at,
        confirmation_number = excluded.confirmation_number,
        filed_by_user_id = excluded.filed_by_user_id,
        notes = excluded.notes,
        updated_at = datetime('now')
    `)
    .run(
      periodKey,
      periodType,
      status,
      input.filed_at ?? null,
      input.confirmation_number ?? null,
      input.filed_by_user_id ?? null,
      input.notes ?? null,
    );
  return getFiling(periodKey)!;
}

/**
 * List filing rows whose period_key falls in [from, to] (inclusive), by string
 * compare on the key. Both bounds optional. Month and quarter keys sort
 * sensibly enough for the checklist (UI groups by type anyway).
 */
export function listFilings(from?: string, to?: string): SalesTaxFilingRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (from) { clauses.push(`period_key >= ?`); params.push(from); }
  if (to) { clauses.push(`period_key <= ?`); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return sqlite
    .prepare(`SELECT * FROM sales_tax_filings ${where} ORDER BY period_key ASC`)
    .all(...params) as SalesTaxFilingRow[];
}
