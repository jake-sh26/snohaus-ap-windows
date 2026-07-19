/**
 * Sales Tax — filings state (PR #165, extended PR #191 for per-entity filings).
 *
 * Tracks the open/filed/amended status of each NY sales-tax period so the
 * Sales Tax UI can render a filing checklist and let an authorized user mark
 * a period filed (with confirmation number + notes).
 *
 * period_key is either a month ("2026-05") or an ST-810 quarter ("2026-Q2").
 * period_type disambiguates.
 *
 * R7 (PR #191): each NY entity files separately, so the table now keys on
 * (period_key, entity_id). `entity_id = 0` is the legacy aggregate row
 * (pre-R7); new UI flows always write per-entity rows with entity_id in
 * {1, 2, 3}. The aggregate row is still readable so historical filings
 * never disappear from the UI.
 */
import { sqlite } from "./storage";

export type FilingStatus = "open" | "filed" | "amended";
export type PeriodType = "month" | "quarter";

export interface SalesTaxFilingRow {
  period_key: string;
  entity_id: number;
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
 *
 * Migration strategy (safe for existing data):
 *   1. Create the table fresh if it doesn't exist, with composite PK
 *      (period_key, entity_id) and entity_id default 0.
 *   2. If the table already exists from an older deploy without entity_id,
 *      ALTER TABLE ... ADD COLUMN entity_id INTEGER NOT NULL DEFAULT 0. The
 *      old PRIMARY KEY (period_key alone) stays in place; the new column
 *      defaults to 0 so existing rows continue to read as "legacy aggregate".
 *      We don't try to rebuild the PK — SQLite's PK constraint on the old
 *      rows is satisfied (entity_id defaults to 0, unique with period_key).
 *   3. New per-entity writes use entity_id in {1, 2, 3}. SQLite enforces
 *      uniqueness on the existing PK (period_key), so for fresh tables we
 *      use the composite PK; for migrated tables we add a UNIQUE INDEX on
 *      (period_key, entity_id) which gives us the same guarantee.
 */
export function ensureSalesTaxFilingsSchema(): void {
  const tableInfo = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sales_tax_filings'`)
    .get() as { name: string } | undefined;

  if (!tableInfo) {
    sqlite.exec(`
      CREATE TABLE sales_tax_filings (
        period_key TEXT NOT NULL,
        entity_id INTEGER NOT NULL DEFAULT 0,
        period_type TEXT NOT NULL CHECK (period_type IN ('month','quarter')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filed','amended')),
        filed_at TEXT NULL,
        confirmation_number TEXT NULL,
        filed_by_user_id INTEGER NULL,
        notes TEXT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (period_key, entity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sales_tax_filings_status
        ON sales_tax_filings(status);
    `);
  } else {
    // Pre-existing table. Two eras coexist here:
    //   * PR #165 shape: PRIMARY KEY (period_key)                 -- BROKEN for per-entity
    //   * PR #191 shape: PK (period_key) + UNIQUE(period_key,eid) -- ALSO BROKEN, still keyed on period_key alone
    //
    // The PR #191 migration added a UNIQUE INDEX on (period_key, entity_id)
    // but never rebuilt the primary key, so INSERTs from the per-entity UI
    // fail with "UNIQUE constraint failed: sales_tax_filings.period_key" as
    // soon as a second entity is filed for the same period (see July 19 2026
    // Huntington-after-Greenvale bug).
    //
    // SQLite can't drop a PRIMARY KEY in place, so we rebuild the table
    // exactly once, inside a transaction, only when the old PK shape is
    // detected. This is idempotent: after the rebuild the detection returns
    // false and this block short-circuits to the additive path.
    const cols = sqlite
      .prepare(`PRAGMA table_info(sales_tax_filings)`)
      .all() as Array<{ name: string; pk: number }>;
    const hasEntityId = cols.some((c) => c.name === "entity_id");

    // Detect the broken PK shape: entity_id is NOT part of the primary key
    // (i.e. exactly one column has pk > 0, and it's not entity_id).
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    const pkNeedsRebuild =
      pkCols.length === 1 && pkCols[0] !== "entity_id" && pkCols[0] === "period_key";

    if (pkNeedsRebuild) {
      console.log(
        "[sales-tax-filings] rebuilding table to composite PK (period_key, entity_id)",
      );
      // Wrap the rebuild in a transaction so we never end up with a half-
      // migrated schema on crash. If entity_id doesn't exist yet, add it as
      // part of the SELECT (default 0 = legacy aggregate row).
      const tx = sqlite.transaction(() => {
        // Turn foreign_keys off during the rename dance (SQLite recommendation
        // for this pattern). No FKs touch this table today, but be safe.
        const fkPragma = sqlite.pragma("foreign_keys", { simple: true }) as number;
        try {
          sqlite.exec("PRAGMA foreign_keys = OFF");
          sqlite.exec(`
            CREATE TABLE sales_tax_filings__new (
              period_key TEXT NOT NULL,
              entity_id INTEGER NOT NULL DEFAULT 0,
              period_type TEXT NOT NULL CHECK (period_type IN ('month','quarter')),
              status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filed','amended')),
              filed_at TEXT NULL,
              confirmation_number TEXT NULL,
              filed_by_user_id INTEGER NULL,
              notes TEXT NULL,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (period_key, entity_id)
            );
          `);
          const selectEntityCol = hasEntityId ? "entity_id" : "0 AS entity_id";
          sqlite.exec(`
            INSERT INTO sales_tax_filings__new
              (period_key, entity_id, period_type, status, filed_at,
               confirmation_number, filed_by_user_id, notes, created_at, updated_at)
            SELECT
              period_key, ${selectEntityCol}, period_type, status, filed_at,
              confirmation_number, filed_by_user_id, notes, created_at, updated_at
            FROM sales_tax_filings;
          `);
          sqlite.exec("DROP TABLE sales_tax_filings;");
          sqlite.exec("ALTER TABLE sales_tax_filings__new RENAME TO sales_tax_filings;");
        } finally {
          if (fkPragma === 1) sqlite.exec("PRAGMA foreign_keys = ON");
        }
      });
      tx();
      console.log("[sales-tax-filings] rebuild complete");
    } else if (!hasEntityId) {
      // Older-than-PR#191 table with no entity_id column at all AND the PK
      // check above didn't fire (shouldn't be reachable in prod, but keep
      // the safety net for local dev DBs).
      try {
        sqlite.exec(
          `ALTER TABLE sales_tax_filings ADD COLUMN entity_id INTEGER NOT NULL DEFAULT 0`,
        );
      } catch (e: any) {
        console.error("[sales-tax-filings] add entity_id column failed:", e?.message);
      }
    }

    // Always ensure the composite unique index + status index exist. The
    // unique index is redundant once the composite PK is in place, but it's
    // cheap and it makes the intent obvious in schema dumps.
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_tax_filings_period_entity
        ON sales_tax_filings(period_key, entity_id);
      CREATE INDEX IF NOT EXISTS idx_sales_tax_filings_status
        ON sales_tax_filings(status);
    `);
  }

  // Attachments table — stores the filed-confirmation PDF blob for each
  // (period_key, entity_id). Multiple attachments per filing are allowed; the
  // UI surfaces them as a list. We keep the blob in SQLite for simplicity;
  // PDFs are tiny (<1 MB typical) so this stays well within SQLite limits.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sales_tax_filing_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_key TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT,
      blob BLOB NOT NULL,
      uploaded_by_email TEXT,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sales_tax_filing_attachments_period_entity
      ON sales_tax_filing_attachments(period_key, entity_id);
  `);
}

/** Fetch a single filing row by (period_key, entity_id). null if none yet. */
export function getFiling(periodKey: string, entityId: number = 0): SalesTaxFilingRow | null {
  const row = sqlite
    .prepare(
      `SELECT * FROM sales_tax_filings WHERE period_key = ? AND entity_id = ?`,
    )
    .get(periodKey, entityId) as SalesTaxFilingRow | undefined;
  return row ?? null;
}

/**
 * List ALL filing rows for a period (one per entity_id). Convenient for the
 * per-entity checklist UI which renders 3 cards.
 */
export function getFilingsByPeriod(periodKey: string): SalesTaxFilingRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM sales_tax_filings WHERE period_key = ? ORDER BY entity_id ASC`,
    )
    .all(periodKey) as SalesTaxFilingRow[];
}

/**
 * The "open" placeholder returned by the read endpoints when no row exists.
 * Keeps the API shape stable whether or not a period has been touched.
 */
export function openFilingPlaceholder(periodKey: string, entityId: number = 0): SalesTaxFilingRow {
  return {
    period_key: periodKey,
    entity_id: entityId,
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
  entity_id?: number;
  status?: FilingStatus;
  filed_at?: string | null;
  confirmation_number?: string | null;
  notes?: string | null;
  filed_by_user_id?: number | null;
}

/**
 * Upsert a filing row. period_type is derived from the key shape. On conflict
 * (period_key, entity_id) we update the provided columns and bump updated_at.
 */
export function upsertFiling(
  periodKey: string,
  input: UpsertFilingInput,
): SalesTaxFilingRow {
  const entityId = input.entity_id ?? 0;
  const periodType: PeriodType = periodKey.includes("-Q") ? "quarter" : "month";
  const status: FilingStatus = input.status ?? "open";
  sqlite
    .prepare(`
      INSERT INTO sales_tax_filings (
        period_key, entity_id, period_type, status, filed_at, confirmation_number,
        filed_by_user_id, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(period_key, entity_id) DO UPDATE SET
        status = excluded.status,
        filed_at = excluded.filed_at,
        confirmation_number = excluded.confirmation_number,
        filed_by_user_id = excluded.filed_by_user_id,
        notes = excluded.notes,
        updated_at = datetime('now')
    `)
    .run(
      periodKey,
      entityId,
      periodType,
      status,
      input.filed_at ?? null,
      input.confirmation_number ?? null,
      input.filed_by_user_id ?? null,
      input.notes ?? null,
    );
  return getFiling(periodKey, entityId)!;
}

/**
 * List filing rows whose period_key falls in [from, to] (inclusive), by string
 * compare on the key. Both bounds optional.
 */
export function listFilings(from?: string, to?: string): SalesTaxFilingRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (from) { clauses.push(`period_key >= ?`); params.push(from); }
  if (to) { clauses.push(`period_key <= ?`); params.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return sqlite
    .prepare(
      `SELECT * FROM sales_tax_filings ${where} ORDER BY period_key ASC, entity_id ASC`,
    )
    .all(...params) as SalesTaxFilingRow[];
}

// ----------------------------------------------------------------------------
// Attachments (PDF copies of the filed confirmation)
// ----------------------------------------------------------------------------

export interface SalesTaxFilingAttachmentMeta {
  id: number;
  period_key: string;
  entity_id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string | null;
  uploaded_by_email: string | null;
  uploaded_at: string;
}

export interface SalesTaxFilingAttachmentBlob extends SalesTaxFilingAttachmentMeta {
  blob: Buffer;
}

/** List attachments for a single (period_key, entity_id) without blob bytes. */
export function listFilingAttachments(
  periodKey: string,
  entityId: number,
): SalesTaxFilingAttachmentMeta[] {
  return sqlite
    .prepare(`
      SELECT id, period_key, entity_id, filename, content_type, size_bytes,
             sha256, uploaded_by_email, uploaded_at
      FROM sales_tax_filing_attachments
      WHERE period_key = ? AND entity_id = ?
      ORDER BY uploaded_at ASC, id ASC
    `)
    .all(periodKey, entityId) as SalesTaxFilingAttachmentMeta[];
}

/** Get one attachment with blob bytes for download. */
export function getFilingAttachment(id: number): SalesTaxFilingAttachmentBlob | null {
  const row = sqlite
    .prepare(`SELECT * FROM sales_tax_filing_attachments WHERE id = ?`)
    .get(id) as SalesTaxFilingAttachmentBlob | undefined;
  if (!row) return null;
  // better-sqlite3 returns BLOB as Buffer already.
  return row;
}

export function createFilingAttachment(input: {
  periodKey: string;
  entityId: number;
  filename: string;
  contentType: string;
  blob: Buffer;
  sha256?: string | null;
  uploadedByEmail?: string | null;
}): SalesTaxFilingAttachmentMeta {
  const stmt = sqlite.prepare(`
    INSERT INTO sales_tax_filing_attachments
      (period_key, entity_id, filename, content_type, size_bytes, sha256, blob, uploaded_by_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id, period_key, entity_id, filename, content_type, size_bytes,
              sha256, uploaded_by_email, uploaded_at
  `);
  return stmt.get(
    input.periodKey,
    input.entityId,
    input.filename,
    input.contentType,
    input.blob.length,
    input.sha256 ?? null,
    input.blob,
    input.uploadedByEmail ?? null,
  ) as SalesTaxFilingAttachmentMeta;
}

export function deleteFilingAttachment(id: number): boolean {
  const r = sqlite.prepare(`DELETE FROM sales_tax_filing_attachments WHERE id = ?`).run(id);
  return r.changes > 0;
}
