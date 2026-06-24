/**
 * Sales Tax — per-entity settings.
 *
 * PR #168 — original TIN-only settings table; entity facts (legal_name,
 * county, rate_bps, dtf_code) lived in a hardcoded ENTITY_FILING_INFO array.
 *
 * PR #198 (ST5) — entity facts now come from `payroll_entities` (the SoT
 * established by PR #194). The ENTITY_FILING_INFO constant is gone; callers
 * use `loadFilingEntities()` to read directly from the DB. The `entity_settings`
 * table still holds TINs only, keyed by TEXT entity_id (decoupled from the
 * integer FK so a renamed/edited entity never orphans a TIN row, mirroring
 * sales_tax_filings.filed_by_user_id).
 *
 * Entity 1's TIN (86-3624190) is known and seeded on first boot. Entities 2 + 3
 * are unknown today and entered via the UI; until set, exports fall back to a
 * blank placeholder and the UI shows a "TIN not set" badge.
 */
import { sqlite } from "./storage";

/** Entity 1 (SD Ski and Patio Inc) TIN — known; seeded on first boot. */
export const ENTITY_1_TIN = "86-3624190";

/**
 * Canonical filing-entity legal-name + jurisdiction facts. Source of truth
 * is `payroll_entities` (PR #194); this interface is just the projection the
 * Sales Tax module reads.
 *
 * NOTE: PR #198 — `county`, `rate_bps`, and `dtf_code` are nullable. A
 * brand-new entity created via the Add Entity dialog can leave them unset;
 * see `isFilingComplete()` and `loadFilingEntities()` for how exports
 * handle that.
 */
export interface EntityFilingInfo {
  entity_id: number;
  legal_name: string;
  /** PR #194 — branded label (e.g. "Sno-Haus Greenvale"). Optional in DB. */
  display_name: string | null;
  /** PR #198 — null when a new entity hasn't been configured for ST-810 yet. */
  county: string | null;
  /** PR #198 — null when a new entity hasn't been configured for ST-810 yet. */
  rate_bps: number | null;
  /** PR #198 — null when a new entity hasn't been configured for ST-810 yet. */
  dtf_code: string | null;
  /** PR #198 — active flag from payroll_entities. */
  active: number;
}

/** Row shape returned by `SELECT … FROM payroll_entities`. Local subset. */
interface PayrollEntityFilingRow {
  id: number;
  legal_name: string;
  display_name: string | null;
  county: string | null;
  rate_bps: number | null;
  dtf_code: string | null;
  active: number;
}

/**
 * Read filing-entity rows directly from `payroll_entities`. Ordered by
 * (active DESC, id ASC) so the 3 seeded entities (1=Greenvale, 2=Huntington,
 * 3=Hempstead) keep their historical order on every export, and any
 * newly-added or deactivated entities sort predictably after them.
 *
 * Callers should usually use `loadFilingEntities(opts)` instead, which
 * implements the active-filter + period-sales policy. This raw helper is
 * exposed for the entity-settings PUT validation path that needs to check
 * "does this entity_id exist at all", regardless of active state.
 */
export function listAllFilingEntities(): EntityFilingInfo[] {
  const rows = sqlite
    .prepare<[], PayrollEntityFilingRow>(
      `SELECT id, legal_name, display_name, county, rate_bps, dtf_code, active
         FROM payroll_entities
        ORDER BY active DESC, id ASC`,
    )
    .all() as PayrollEntityFilingRow[];
  return rows.map((r) => ({
    entity_id: r.id,
    legal_name: r.legal_name,
    display_name: r.display_name,
    county: r.county,
    rate_bps: r.rate_bps,
    dtf_code: r.dtf_code,
    active: r.active,
  }));
}

/**
 * "Smart middle" inclusion rule for sales-tax filing rows (PR #198 ST5).
 *
 * - Active entities are always included.
 * - Inactive entities are included only when `entitiesWithSalesInPeriod`
 *   contains their id — i.e. they had attributed sales rows in the
 *   requested period. This lets you deactivate a store today without
 *   breaking back-period filings for months when it was still operating.
 *
 * Callers that don't have a period (e.g. the entity-settings admin GET)
 * pass `undefined`, which collapses the rule to "active-only".
 */
export function loadFilingEntities(opts?: {
  /** Set of payroll_entity ids that had attributed sales in the period. */
  entitiesWithSalesInPeriod?: Set<number>;
}): EntityFilingInfo[] {
  const all = listAllFilingEntities();
  const periodIds = opts?.entitiesWithSalesInPeriod;
  return all.filter((e) => {
    if (e.active === 1) return true;
    if (periodIds && periodIds.has(e.entity_id)) return true;
    return false;
  });
}

/**
 * True when an entity has every field ST-810 jurisdiction enrichment needs
 * (legal_name is NOT NULL in the schema; we check the three optional fields).
 * Used to "silently skip" not-fully-configured stores from jurisdiction
 * exports per the PR #198 decision, while surfacing the exclusion in the
 * response payload so the UI can show a banner.
 */
export function isFilingComplete(e: EntityFilingInfo): boolean {
  return (
    e.county !== null && e.county.trim() !== "" &&
    e.rate_bps !== null &&
    e.dtf_code !== null && e.dtf_code.trim() !== ""
  );
}

/** Legal name for an entity id, or a generic fallback. */
export function legalNameFor(entityId: number): string {
  const row = sqlite
    .prepare<[number], { legal_name: string }>(
      `SELECT legal_name FROM payroll_entities WHERE id = ?`,
    )
    .get(entityId) as { legal_name: string } | undefined;
  return row?.legal_name ?? `Entity ${entityId}`;
}

/** Filing info for an entity id, or undefined when the id doesn't exist. */
export function filingInfoFor(entityId: number): EntityFilingInfo | undefined {
  const row = sqlite
    .prepare<[number], PayrollEntityFilingRow>(
      `SELECT id, legal_name, display_name, county, rate_bps, dtf_code, active
         FROM payroll_entities WHERE id = ?`,
    )
    .get(entityId) as PayrollEntityFilingRow | undefined;
  if (!row) return undefined;
  return {
    entity_id: row.id,
    legal_name: row.legal_name,
    display_name: row.display_name,
    county: row.county,
    rate_bps: row.rate_bps,
    dtf_code: row.dtf_code,
    active: row.active,
  };
}

/** True iff a payroll_entities row exists with this id (active or not). */
export function filingEntityExists(entityId: number | string): boolean {
  const row = sqlite
    .prepare<[number], { c: number }>(
      `SELECT 1 AS c FROM payroll_entities WHERE id = ? LIMIT 1`,
    )
    .get(Number(entityId)) as { c: number } | undefined;
  return !!row;
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
