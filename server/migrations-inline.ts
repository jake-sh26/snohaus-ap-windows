/**
 * Inline SQL migrations.
 *
 * Why inline instead of reading .sql files from disk?
 * -----------------------------------------------------
 * The AP prod deploy flow builds `dist/index.cjs` on one machine and copies
 * (a subset of) `dist/` to the Windows service host. The prior file-based
 * runner (PR #237) added a `dist/migrations/` sibling directory that the
 * existing copy pipeline was never taught about, so on the target host the
 * runner correctly resolved `<install>\dist\migrations` and correctly found
 * ZERO files — silently doing nothing. The RBAC seeder then re-added an
 * Owner row on top of the existing 278, taking it to 279.
 *
 * Fix: ship the SQL as string constants in a TypeScript module that esbuild
 * bundles into `index.cjs`. No filesystem read at runtime. No new folder to
 * copy. Impossible to accidentally omit from a deploy — if the app boots,
 * the migrations are present.
 *
 * Convention for new migrations:
 *  - Append to `INLINE_MIGRATIONS` in filename order (YYYY-MM-DD_<slug>).
 *  - The `name` field is used as the primary key in `schema_migrations` and
 *    MUST NEVER change once shipped, or the runner will re-execute it.
 *  - Include your own BEGIN/COMMIT inside the `sql` string (runner does not
 *    wrap statements in a transaction).
 */

export interface InlineMigration {
  /** Stable identifier stored as `schema_migrations.filename`. Do not rename. */
  name: string;
  /** Raw SQL to execute. Must contain its own BEGIN/COMMIT if transactional. */
  sql: string;
}

/**
 * 2026-07-01_dedupe_user_roles
 *
 * Collapses duplicate (user_id, role_id, entity_id_scope) rows in `user_roles`
 * to a single canonical row (min id kept). Then adds a NULL-safe unique index
 * to prevent recurrence — SQLite treats NULLs as distinct in composite UNIQUE
 * constraints, so we use `COALESCE(entity_id_scope, -1)` to normalize the
 * "global scope" case.
 *
 * Fixes: Jake (user_id=1) accumulated 278 identical Owner assignments due to
 * a defect in the assignment upsert that shipped in PR #233's SQL (which
 * itself never ran in prod because there was no migration runner).
 */
const DEDUPE_USER_ROLES = `
BEGIN TRANSACTION;

CREATE TEMPORARY TABLE _user_roles_dedup AS
  SELECT MIN(id) AS keep_id, user_id, role_id, entity_id_scope
  FROM user_roles
  GROUP BY user_id, role_id, entity_id_scope;

DELETE FROM user_roles
  WHERE id NOT IN (SELECT keep_id FROM _user_roles_dedup);

DROP TABLE _user_roles_dedup;

COMMIT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_user_roles_no_dupes
  ON user_roles (user_id, role_id, COALESCE(entity_id_scope, -1));
`;

/**
 * 2026-07-01_remove_payroll_edit_rules
 *
 * Removes the orphan `payroll.edit_rules` permission from the catalog plus
 * any assignments referencing it. The permission was dropped from
 * PERMISSION_CATALOG in PR #236, but the boot seeder only upserts — it
 * never prunes — so existing DBs retained the stale row.
 *
 * role_permissions has ON DELETE CASCADE from permissions(id), but we
 * clear it explicitly first in case the DB has `PRAGMA foreign_keys=OFF`.
 */
const REMOVE_PAYROLL_EDIT_RULES = `
BEGIN TRANSACTION;

DELETE FROM role_permissions
  WHERE permission_id IN (SELECT id FROM permissions WHERE key = 'payroll.edit_rules');

DELETE FROM permissions
  WHERE key = 'payroll.edit_rules';

COMMIT;
`;

/**
 * Ordered list of migrations. Filename order determines execution order and
 * MUST be stable across releases.
 */
export const INLINE_MIGRATIONS: InlineMigration[] = [
  { name: "2026-07-01_dedupe_user_roles", sql: DEDUPE_USER_ROLES },
  { name: "2026-07-01_remove_payroll_edit_rules", sql: REMOVE_PAYROLL_EDIT_RULES },
];
