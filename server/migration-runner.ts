/**
 * PR #237 (P4_Perms) — SQL migration runner.
 *
 * Runs `.sql` files in `server/migrations/` exactly once per file, tracking
 * executed migrations in a `schema_migrations` table.
 *
 * Why this exists:
 *   PRs #233 and #236 shipped `server/migrations/*.sql` files but the repo
 *   never had code that loads/executes them. Both files (`2026-07-01_dedupe_user_roles.sql`
 *   and `2026-07-01_remove_payroll_edit_rules.sql`) sat unrun on the running
 *   server, leaving:
 *     - 278 duplicate Owner rows for user_id=1 in `user_roles` (256 pre-dedup
 *       + growth since — no unique index to prevent re-adds)
 *     - The orphaned `payroll.edit_rules` permission row + any role_permissions
 *       assignments still present in the DB (even though the catalog entry
 *       was removed from `shared/schema.ts`).
 *
 * Design:
 *   - Ordering: filenames sorted lexicographically. The convention going
 *     forward is `YYYY-MM-DD_<slug>.sql` (matches the two existing files).
 *   - Tracking: `schema_migrations(filename PRIMARY KEY, sha256, applied_at)`.
 *     `sha256` is recorded but NOT enforced on re-run — filename identity is
 *     the guard. Rewriting a merged migration is treated as a bug; do a new
 *     file instead. The hash is stored so `/api/admin/migrations` can flag
 *     drift between what's on disk and what was applied.
 *   - Transactionality: the runner does NOT wrap the file — many migrations
 *     (including both existing ones) already contain their own
 *     `BEGIN TRANSACTION; ... COMMIT;`. `sqlite.exec()` handles multi-statement
 *     SQL and the file's own BEGIN/COMMIT is honored. Files that don't have
 *     explicit BEGIN/COMMIT get statement-level auto-commit, which is fine
 *     for single-statement DDL.
 *   - Filesystem resolution: mirrors `db-path.ts` — resolves relative to
 *     `__dirname`. In dev (`tsx server/index.ts`) that lands at
 *     `<repo>/server/migrations`. In prod (`node dist/index.cjs`) that lands
 *     at `<install>/dist/migrations`, which the build script (see
 *     `script/build.ts` changes in this PR) populates by copying
 *     `server/migrations/` → `dist/migrations/` at build time.
 *   - Error policy: if a migration throws, the runner logs and re-throws.
 *     Boot should NOT continue — schema drift between what code expects and
 *     what's in the DB is exactly the class of bug that would corrupt data
 *     silently otherwise.
 *
 * This module has NO drizzle-orm dependency and takes the raw better-sqlite3
 * handle as a parameter, so it can be imported from `storage.ts` without a
 * circular dependency on the `db` export.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type Database from "better-sqlite3";

export type MigrationRecord = {
  filename: string;
  sha256: string;
  applied_at: string;
};

export type MigrationRunResult = {
  applied: string[];
  skipped: string[];
  drift: Array<{ filename: string; recorded_sha256: string; on_disk_sha256: string }>;
};

/**
 * Resolve the migrations directory. Tries a few candidate locations to
 * survive dev (tsx from repo root), prod (bundled cjs in dist/), and NSSM
 * (cwd unreliable).
 */
export function resolveMigrationsDir(): string {
  const candidates = [
    // Bundled prod: <install>/dist/index.cjs → <install>/dist/migrations/
    path.resolve(__dirname, "migrations"),
    // Dev tsx: <repo>/server/*.ts → <repo>/server/migrations/
    // (same as above — __dirname resolves to server/ in dev — so this branch
    // is a defensive duplicate that only differs from the first if __dirname
    // ever changes shape.)
    // Fallback: cwd-relative for any NSSM launch mode we haven't anticipated.
    path.resolve(process.cwd(), "server", "migrations"),
    path.resolve(process.cwd(), "dist", "migrations"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch {
      /* keep trying */
    }
  }
  // Return the primary candidate anyway — the runner will handle
  // "directory missing → nothing to do" gracefully.
  return candidates[0];
}

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Ensure the schema_migrations tracker table exists.
 * Idempotent — safe to call on every boot.
 */
function ensureTrackerTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * List all `.sql` files in the migrations directory, sorted lexicographically.
 * Files starting with `_` or `.` are skipped (convention for staging /
 * "not yet ready" migrations).
 */
function listMigrationFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !f.startsWith("_") && !f.startsWith("."))
    .sort();
}

/**
 * Run every pending migration in `dir` against `db`. Records each successful
 * run in `schema_migrations`. Returns a summary of what happened for
 * observability (used by the diagnostic endpoint).
 *
 * Throws on the first failure (rest of migrations are NOT attempted) so a
 * partial schema doesn't come up half-migrated.
 */
export function runMigrations(db: Database.Database, dir?: string): MigrationRunResult {
  const migrationsDir = dir ?? resolveMigrationsDir();
  ensureTrackerTable(db);

  const files = listMigrationFiles(migrationsDir);
  const applied: string[] = [];
  const skipped: string[] = [];
  const drift: MigrationRunResult["drift"] = [];

  const getExisting = db.prepare(
    "SELECT filename, sha256, applied_at FROM schema_migrations WHERE filename = ?",
  );
  const recordApplied = db.prepare(
    "INSERT INTO schema_migrations (filename, sha256, applied_at) VALUES (?, ?, ?)",
  );

  for (const filename of files) {
    const full = path.join(migrationsDir, filename);
    const contents = fs.readFileSync(full);
    const onDiskSha = sha256Hex(contents);

    const existing = getExisting.get(filename) as MigrationRecord | undefined;
    if (existing) {
      skipped.push(filename);
      if (existing.sha256 !== onDiskSha) {
        drift.push({
          filename,
          recorded_sha256: existing.sha256,
          on_disk_sha256: onDiskSha,
        });
        console.warn(
          `[migrations] DRIFT: ${filename} on disk (sha256=${onDiskSha.slice(0, 12)}) differs from applied record (sha256=${existing.sha256.slice(0, 12)}). Applied version is authoritative.`,
        );
      }
      continue;
    }

    // Run the file. Files typically contain their own BEGIN/COMMIT — we do
    // not wrap them. Multi-statement `.exec()` handles the case where they
    // don't (each statement auto-commits).
    console.log(`[migrations] Applying ${filename}...`);
    const startedAt = Date.now();
    try {
      db.exec(contents.toString("utf-8"));
    } catch (e: any) {
      console.error(`[migrations] FAILED applying ${filename}:`, e?.message ?? e);
      throw new Error(
        `Migration ${filename} failed: ${e?.message ?? String(e)}. Server startup aborted to prevent schema drift.`,
      );
    }
    recordApplied.run(filename, onDiskSha, new Date().toISOString());
    const elapsed = Date.now() - startedAt;
    applied.push(filename);
    console.log(`[migrations] Applied ${filename} in ${elapsed}ms`);
  }

  if (applied.length === 0 && skipped.length === 0) {
    console.log(`[migrations] No migration files found in ${migrationsDir}`);
  } else {
    console.log(
      `[migrations] Done. Applied ${applied.length}, skipped ${skipped.length}${drift.length ? `, drift ${drift.length}` : ""}.`,
    );
  }

  return { applied, skipped, drift };
}

/**
 * Return the current tracker state + on-disk file list, for the admin
 * diagnostic endpoint.
 */
export function getMigrationStatus(db: Database.Database, dir?: string): {
  dir: string;
  files: Array<{
    filename: string;
    on_disk_sha256: string;
    applied: boolean;
    applied_at: string | null;
    recorded_sha256: string | null;
    drift: boolean;
  }>;
  orphans: MigrationRecord[]; // recorded in DB but missing from disk
} {
  const migrationsDir = dir ?? resolveMigrationsDir();
  ensureTrackerTable(db);

  const files = listMigrationFiles(migrationsDir);
  const recorded = db
    .prepare("SELECT filename, sha256, applied_at FROM schema_migrations ORDER BY filename")
    .all() as MigrationRecord[];
  const recordedByName = new Map(recorded.map((r) => [r.filename, r]));

  const combined = files.map((filename) => {
    const full = path.join(migrationsDir, filename);
    const onDiskSha = sha256Hex(fs.readFileSync(full));
    const rec = recordedByName.get(filename);
    return {
      filename,
      on_disk_sha256: onDiskSha,
      applied: !!rec,
      applied_at: rec?.applied_at ?? null,
      recorded_sha256: rec?.sha256 ?? null,
      drift: !!rec && rec.sha256 !== onDiskSha,
    };
  });

  const onDiskSet = new Set(files);
  const orphans = recorded.filter((r) => !onDiskSet.has(r.filename));

  return { dir: migrationsDir, files: combined, orphans };
}
