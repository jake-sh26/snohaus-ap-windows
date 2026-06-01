/**
 * Sales Tax — per-entity settings (PR #168).
 *
 * Persists the filing-entity TINs the user enters in Finance Options. The 3
 * filing entities (SD Ski and Patio Inc / SH Huntington / SH Hempstead) map to
 * payroll_entities ids 1/2/3, but we key this table by a TEXT entity_id so the
 * settings surface is decoupled from the integer FK (and a future non-payroll
 * entity could be added without a schema change).
 *
 * Entity 1's TIN (86-3624190) is known and seeded on first boot. Entities 2 + 3
 * are unknown today and entered via the UI; until set, exports fall back to a
 * blank placeholder and the UI shows a "TIN not set" badge.
 *
 * No FK to payroll_entities — kept loose so a renamed/edited entity never
 * orphans a TIN row, mirroring the sales_tax_filings.filed_by_user_id approach.
 */
import { sqlite } from "./storage";

/** Entity 1 (SD Ski and Patio Inc) TIN — known; seeded on first boot. */
export const ENTITY_1_TIN = "86-3624190";

/**
 * Canonical filing-entity legal names + jurisdiction facts, keyed by
 * payroll_entities.id. The ST-809/ST-810 forms file under the legal name, not
 * the Shopify store/location label, so this is the authoritative display source
 * for exports + the entity cards. county + dtf_code/rate drive the ST-810
 * jurisdiction enrichment fallback.
 */
export interface EntityFilingInfo {
  entity_id: number;
  legal_name: string;
  county: string;
  rate_bps: number;
  dtf_code: string;
}

export const ENTITY_FILING_INFO: EntityFilingInfo[] = [
  { entity_id: 1, legal_name: "SD Ski and Patio Inc", county: "Nassau", rate_bps: 8625, dtf_code: "NA 2811" },
  { entity_id: 2, legal_name: "SH Huntington", county: "Suffolk", rate_bps: 8750, dtf_code: "SU 4711" },
  { entity_id: 3, legal_name: "SH Hempstead", county: "Nassau", rate_bps: 8625, dtf_code: "NA 2811" },
];

/** Legal name for an entity id, or a generic fallback. */
export function legalNameFor(entityId: number): string {
  return ENTITY_FILING_INFO.find((e) => e.entity_id === entityId)?.legal_name ?? `Entity ${entityId}`;
}

/** Filing info for an entity id. */
export function filingInfoFor(entityId: number): EntityFilingInfo | undefined {
  return ENTITY_FILING_INFO.find((e) => e.entity_id === entityId);
}

/** NY/IRS TIN display format: 2 digits, dash, 7 digits (e.g. 86-3624190). */
export const TIN_PATTERN = /^\d{2}-\d{7}$/;

export interface EntitySettingRow {
  entity_id: string;
  tin: string | null;
  updated_at: string;
}

/**
 * Idempotent schema-ensure. Called once at startup from bootstrapSchema().
 * Seeds Entity 1's known TIN only if no row exists for it yet (never clobbers a
 * user edit). Entities 2 + 3 are left absent until the user saves them.
 */
export function ensureEntitySettingsSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS entity_settings (
      entity_id TEXT PRIMARY KEY,
      tin TEXT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  sqlite
    .prepare(`
      INSERT INTO entity_settings (entity_id, tin, updated_at)
      VALUES ('1', ?, datetime('now'))
      ON CONFLICT(entity_id) DO NOTHING
    `)
    .run(ENTITY_1_TIN);
}

/** All entity-setting rows, keyed by entity_id for easy lookup. */
export function getEntitySettings(): Map<string, EntitySettingRow> {
  const rows = sqlite
    .prepare(`SELECT entity_id, tin, updated_at FROM entity_settings`)
    .all() as EntitySettingRow[];
  const map = new Map<string, EntitySettingRow>();
  for (const r of rows) map.set(String(r.entity_id), r);
  return map;
}

/** TIN for an entity (accepts number or string id). null if unset. */
export function getTin(entityId: number | string): string | null {
  const row = sqlite
    .prepare(`SELECT tin FROM entity_settings WHERE entity_id = ?`)
    .get(String(entityId)) as { tin: string | null } | undefined;
  return row?.tin ?? null;
}

/**
 * Upsert a TIN for an entity. Empty string clears it (stored as NULL). Throws
 * on a non-empty value that doesn't match TIN_PATTERN so the route can 400.
 */
export function upsertTin(entityId: number | string, tin: string): EntitySettingRow {
  const trimmed = (tin ?? "").trim();
  if (trimmed !== "" && !TIN_PATTERN.test(trimmed)) {
    throw new Error(`TIN must be formatted XX-XXXXXXX (got "${trimmed}")`);
  }
  sqlite
    .prepare(`
      INSERT INTO entity_settings (entity_id, tin, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(entity_id) DO UPDATE SET
        tin = excluded.tin,
        updated_at = datetime('now')
    `)
    .run(String(entityId), trimmed === "" ? null : trimmed);
  return sqlite
    .prepare(`SELECT entity_id, tin, updated_at FROM entity_settings WHERE entity_id = ?`)
    .get(String(entityId)) as EntitySettingRow;
}
