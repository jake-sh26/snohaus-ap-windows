/**
 * People \u2014 the canonical "human" entity that ties together everything Ops Hub
 * knows about a person across systems (PR #199).
 *
 * Why this exists
 * ---------------
 * Today, Ops Hub has TWO parallel "person" tables:
 *
 *   - `users`     \u2014 login accounts (email, password, role, permissions)
 *   - `employees` \u2014 payroll records (ADP code, cadence, store, hourly rate)
 *
 * They have no foreign key between them. A user named "Mike Smith" with login
 * mike@snohaus.com and an employee row "Mike Smith / ADP-42 / Greenvale" are
 * two completely unrelated rows. That's the root of three audit bugs:
 *
 *   - EM1 \u2014 deactivating someone requires touching both tables; nothing warns
 *           you the other still has an active record.
 *   - EM4 \u2014 commission attribution matches Shopify orders to employees by
 *           name string. Typos and married-name changes silently drop revenue.
 *   - EM5 \u2014 the Employees page can't show "this person also has a login".
 *
 * The fix is a thin canonical `people` table that owns nothing but the
 * internal ID + timestamps. Every external system's identifier for the same
 * person (ADP code, Shopify staff GID, Shift4 employee number, QBO vendor ID,
 * GCal attendee email, etc.) goes in a sibling `person_external_ids` table
 * keyed by `(person_id, system)`. Then `employees` and `users` each get a
 * nullable `person_id` FK (added in PR #200) so they can both point at the
 * same human without merging their concerns.
 *
 * Scope of THIS module (PR #199)
 * ------------------------------
 * - Schema: `people` + `person_external_ids` tables.
 * - Helpers: createPerson, getPerson, listPeople, attach/detach/list external IDs,
 *   findPersonByExternalId (the commission matcher's future hot path).
 * - No consumer migrations yet. No employees.person_id column yet. No users
 *   touched. Pure additive foundation \u2014 PR #200 wires consumers.
 *
 * Identifier system enum (extensible)
 * -----------------------------------
 * `person_external_ids.system` is a free-text column with a recommended set
 * of values \u2014 not enforced by CHECK because new third-party systems are
 * added by code without a schema migration. Recommended canonical values:
 *
 *   - 'adp'              ADP company code + worker id (your payroll provider)
 *   - 'shopify_staff'    Shopify Staff GID, used by commission attribution
 *   - 'shift4_employee'  Shift4 (Lighthouse) employee number on credit-card
 *                        tips
 *   - 'qbo_vendor'       QBO vendor ID when an employee is paid as a vendor
 *                        for reimbursements
 *   - 'qbo_customer'     QBO customer ID for the employee-discount account
 *   - 'gcal_attendee'    Google Calendar attendee email
 *   - 'github'           GitHub login (for the dev team)
 *   - 'manual'           A label you pinned on for your own reference; the
 *                        `label` column is the source of truth in that case
 *
 * Adding a new system later is a one-line change in code that calls
 * attachExternalId() \u2014 no DB migration.
 */
import { sqlite } from "./storage";

// ---- Types ----------------------------------------------------------------

export interface PersonRow {
  id: number;
  /** Short human label for admin surfaces. Optional; defaults to "Person #id". */
  display_name: string | null;
  /** Free-text status: 'active' | 'archived'. Defaults to 'active'. */
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PersonExternalIdRow {
  person_id: number;
  /** Canonical system key, e.g. 'adp', 'shopify_staff'. Free-text by design. */
  system: string;
  /** The id as that system knows it. Stored as text for system-agnostic keys. */
  external_id: string;
  /** Optional human note (e.g. "Lehi store ADP code", "married-name alias"). */
  label: string | null;
  created_at: string;
  updated_at: string;
}

/** Canonical system keys, recommended set. New ones can be added without a DB change. */
export const PERSON_SYSTEMS = {
  ADP: "adp",
  SHOPIFY_STAFF: "shopify_staff",
  SHIFT4_EMPLOYEE: "shift4_employee",
  QBO_VENDOR: "qbo_vendor",
  QBO_CUSTOMER: "qbo_customer",
  GCAL_ATTENDEE: "gcal_attendee",
  GITHUB: "github",
  MANUAL: "manual",
} as const;

// ---- Schema ---------------------------------------------------------------

/**
 * Idempotent schema-ensure. Called once at startup from bootstrapSchema().
 * Both tables are pure additive \u2014 they touch no existing tables, and no
 * existing module reads from them yet. Safe to deploy without a feature flag.
 *
 * `person_external_ids.system` is intentionally TEXT (not a CHECK enum) so
 * adding a new 3rd-party system later is a code change only, not a migration.
 * Uniqueness is enforced two ways:
 *
 *   - PRIMARY KEY (person_id, system) \u2014 a person has at most one id in
 *     each system. (You'd never expect "Mike" to have two ADP codes.)
 *   - UNIQUE (system, external_id) \u2014 a given external id maps to exactly one
 *     person. (Two employees can't share the same Shopify Staff GID.)
 *
 * The second constraint is what makes the commission matcher's lookup
 * (`external_id \u2192 person_id`) safe to treat as a single-row result.
 */
export function ensurePeopleSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS person_external_ids (
      person_id INTEGER NOT NULL,
      system TEXT NOT NULL,
      external_id TEXT NOT NULL,
      label TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (person_id, system),
      UNIQUE (system, external_id),
      FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
    );

    -- Lookup index for the commission-matcher hot path:
    -- "given a Shopify staff GID, find the person_id."
    CREATE INDEX IF NOT EXISTS idx_person_external_ids_system_external
      ON person_external_ids (system, external_id);

    -- Reverse index for the "show all 3rd-party ids for this person" UI.
    CREATE INDEX IF NOT EXISTS idx_person_external_ids_person
      ON person_external_ids (person_id);
  `);
}

// ---- People helpers -------------------------------------------------------

/**
 * Create a person row. `display_name` is optional \u2014 the row is just an
 * internal ID, the display name is a convenience for admin surfaces. PR #200
 * will backfill one person per existing employee with their legal_name here.
 */
export function createPerson(input: { display_name?: string | null } = {}): PersonRow {
  const display = input.display_name?.trim() || null;
  const row = sqlite
    .prepare(
      `INSERT INTO people (display_name, status, created_at, updated_at)
       VALUES (?, 'active', datetime('now'), datetime('now'))
       RETURNING *`,
    )
    .get(display) as PersonRow;
  return row;
}

export function getPerson(personId: number): PersonRow | undefined {
  return sqlite
    .prepare(`SELECT * FROM people WHERE id = ?`)
    .get(personId) as PersonRow | undefined;
}

export function listPeople(opts?: { status?: "active" | "archived" | "all" }): PersonRow[] {
  const status = opts?.status ?? "active";
  if (status === "all") {
    return sqlite.prepare(`SELECT * FROM people ORDER BY id ASC`).all() as PersonRow[];
  }
  return sqlite
    .prepare(`SELECT * FROM people WHERE status = ? ORDER BY id ASC`)
    .all(status) as PersonRow[];
}

/**
 * Update the display name on a person row. Pass null to clear it.
 * The `status` is intentionally NOT mutable via this helper \u2014 use
 * archivePerson() / unarchivePerson() so the intent is explicit.
 */
export function updatePersonDisplayName(personId: number, display_name: string | null): PersonRow | undefined {
  const trimmed = display_name?.trim() || null;
  const row = sqlite
    .prepare(
      `UPDATE people
          SET display_name = ?, updated_at = datetime('now')
        WHERE id = ?
        RETURNING *`,
    )
    .get(trimmed, personId) as PersonRow | undefined;
  return row;
}

/** Soft-archive. Existing employees / users that reference this person are NOT touched. */
export function archivePerson(personId: number): PersonRow | undefined {
  return sqlite
    .prepare(
      `UPDATE people SET status = 'archived', updated_at = datetime('now')
        WHERE id = ? RETURNING *`,
    )
    .get(personId) as PersonRow | undefined;
}

export function unarchivePerson(personId: number): PersonRow | undefined {
  return sqlite
    .prepare(
      `UPDATE people SET status = 'active', updated_at = datetime('now')
        WHERE id = ? RETURNING *`,
    )
    .get(personId) as PersonRow | undefined;
}

// ---- External IDs ---------------------------------------------------------

/**
 * Attach (or update) an external id for a person. The combined uniqueness
 * constraint means:
 *
 *   - Re-calling with the same (person_id, system) updates external_id +
 *     label in-place. This is the common "I had it wrong, here's the right
 *     ADP code" path.
 *   - Calling with a (system, external_id) that already belongs to a different
 *     person throws \u2014 the caller must detach it from the old person first.
 *     This is on purpose: silently re-pointing an external id is exactly the
 *     kind of attribution bug we're solving.
 */
export function attachExternalId(input: {
  person_id: number;
  system: string;
  external_id: string;
  label?: string | null;
}): PersonExternalIdRow {
  const { person_id, system, external_id, label = null } = input;
  if (!external_id || external_id.trim() === "") {
    throw new Error(`attachExternalId: external_id required`);
  }
  const labelTrim = label?.trim() || null;
  // Existing owner check \u2014 reject conflicts loudly so the caller deals with it.
  const existingOwner = sqlite
    .prepare(`SELECT person_id FROM person_external_ids WHERE system = ? AND external_id = ?`)
    .get(system, external_id) as { person_id: number } | undefined;
  if (existingOwner && existingOwner.person_id !== person_id) {
    throw new Error(
      `attachExternalId: ${system}/${external_id} already belongs to person ${existingOwner.person_id}`,
    );
  }
  const row = sqlite
    .prepare(
      `INSERT INTO person_external_ids (person_id, system, external_id, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(person_id, system) DO UPDATE SET
         external_id = excluded.external_id,
         label = excluded.label,
         updated_at = datetime('now')
       RETURNING *`,
    )
    .get(person_id, system, external_id.trim(), labelTrim) as PersonExternalIdRow;
  return row;
}

/** Remove the (person_id, system) row. No-op if it doesn't exist. */
export function detachExternalId(person_id: number, system: string): void {
  sqlite
    .prepare(`DELETE FROM person_external_ids WHERE person_id = ? AND system = ?`)
    .run(person_id, system);
}

/** All external ids registered for one person, ordered by system. */
export function listExternalIdsForPerson(person_id: number): PersonExternalIdRow[] {
  return sqlite
    .prepare(`SELECT * FROM person_external_ids WHERE person_id = ? ORDER BY system ASC`)
    .all(person_id) as PersonExternalIdRow[];
}

/**
 * COMMISSION-MATCHER HOT PATH (PR #201 will use this).
 *
 * Given a (system, external_id) pair \u2014 e.g. ('shopify_staff', 'gid://shopify/StaffMember/123')
 * \u2014 return the person_id that owns it, or undefined if none. The
 * `UNIQUE (system, external_id)` constraint guarantees a single row.
 */
export function findPersonByExternalId(system: string, external_id: string): number | undefined {
  const row = sqlite
    .prepare(`SELECT person_id FROM person_external_ids WHERE system = ? AND external_id = ?`)
    .get(system, external_id) as { person_id: number } | undefined;
  return row?.person_id;
}

/**
 * Bulk lookup variant: given many (system, external_id) pairs, return a Map
 * keyed by `${system}|${external_id}` -> person_id. Used by the commission
 * matcher when reconciling a batch of Shopify orders.
 */
export function findPeopleByExternalIds(
  pairs: Array<{ system: string; external_id: string }>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (pairs.length === 0) return out;
  // SQLite's parameter limit is ~32k; chunk to be safe.
  const CHUNK = 500;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const slice = pairs.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "(?, ?)").join(", ");
    const params: any[] = [];
    for (const p of slice) {
      params.push(p.system, p.external_id);
    }
    const rows = sqlite
      .prepare(
        `SELECT system, external_id, person_id
           FROM person_external_ids
          WHERE (system, external_id) IN (VALUES ${placeholders})`,
      )
      .all(...params) as Array<{ system: string; external_id: string; person_id: number }>;
    for (const r of rows) out.set(`${r.system}|${r.external_id}`, r.person_id);
  }
  return out;
}
