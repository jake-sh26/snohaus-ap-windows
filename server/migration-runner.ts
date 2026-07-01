/**
 * Migration runner (inline-SQL edition).
 *
 * Executes each entry in `INLINE_MIGRATIONS` (from ./migrations-inline)
 * exactly once per database, tracking applied migrations in a
 * `schema_migrations` table keyed by migration name.
 *
 * Design notes
 * ------------
 * - Why inline SQL and not `.sql` files? See `migrations-inline.ts`. TL;DR:
 *   PR #237 tried file-based and the prod copy pipeline dropped the folder
 *   silently. Inlining makes bundling and boot-time execution atomic — if
 *   `index.cjs` reached the target host, the SQL is guaranteed present.
 *
 * - Tracking: `schema_migrations(filename PRIMARY KEY, sha256, applied_at)`.
 *   The `filename` column keeps the historical name for schema compatibility
 *   with the (now-removed) file-based runner; new entries store the
 *   InlineMigration.name here. sha256 is over the raw SQL string so drift
 *   detection still works (if we ever hand-edit an already-applied SQL
 *   constant, the endpoint flags it).
 *
 * - Transactionality: the runner does NOT wrap each migration. Each SQL
 *   string is expected to declare its own BEGIN/COMMIT if it needs to be
 *   transactional. Multi-statement `.exec()` handles either case.
 *
 * - Failure mode: the first failing migration throws, aborting server
 *   startup. Half-applied schema is a worse outcome than a crash loop that
 *   forces a human to look at the log.
 */

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { INLINE_MIGRATIONS, type InlineMigration } from "./migrations-inline";

interface MigrationRecord {
  filename: string;
  sha256: string;
  applied_at: string;
}

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
  drift: Array<{ filename: string; recorded_sha256: string; on_disk_sha256: string }>;
}

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Ensure the schema_migrations tracker table exists.
 * Idempotent — safe to call on every boot. Column names preserved for
 * back-compat with the file-based runner that previously wrote here.
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
 * Run every pending migration from `migrations` against `db`. Records each
 * successful run in `schema_migrations`. Returns a summary for observability
 * (used by the diagnostic endpoint).
 *
 * `migrations` defaults to INLINE_MIGRATIONS; the parameter exists so tests
 * can inject a custom list.
 */
export function runMigrations(
  db: Database.Database,
  migrations: InlineMigration[] = INLINE_MIGRATIONS,
): MigrationRunResult {
  ensureTrackerTable(db);

  const applied: string[] = [];
  const skipped: string[] = [];
  const drift: MigrationRunResult["drift"] = [];

  const getExisting = db.prepare(
    "SELECT filename, sha256, applied_at FROM schema_migrations WHERE filename = ?",
  );
  const recordApplied = db.prepare(
    "INSERT INTO schema_migrations (filename, sha256, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of migrations) {
    const { name, sql } = migration;
    const currentSha = sha256Hex(sql);

    const existing = getExisting.get(name) as MigrationRecord | undefined;
    if (existing) {
      skipped.push(name);
      if (existing.sha256 !== currentSha) {
        drift.push({
          filename: name,
          recorded_sha256: existing.sha256,
          on_disk_sha256: currentSha,
        });
        console.warn(
          `[migrations] DRIFT: ${name} in code (sha256=${currentSha.slice(0, 12)}) differs from applied record (sha256=${existing.sha256.slice(0, 12)}). Applied version is authoritative — do not edit shipped migrations.`,
        );
      }
      continue;
    }

    console.log(`[migrations] Applying ${name}...`);
    const startedAt = Date.now();
    try {
      db.exec(sql);
    } catch (e: any) {
      console.error(`[migrations] FAILED applying ${name}:`, e?.message ?? e);
      throw new Error(
        `Migration ${name} failed: ${e?.message ?? String(e)}. Server startup aborted to prevent schema drift.`,
      );
    }
    recordApplied.run(name, currentSha, new Date().toISOString());
    const elapsed = Date.now() - startedAt;
    applied.push(name);
    console.log(`[migrations] Applied ${name} in ${elapsed}ms`);
  }

  if (applied.length === 0 && skipped.length === 0) {
    console.log(`[migrations] No migrations to run (INLINE_MIGRATIONS is empty)`);
  } else {
    console.log(
      `[migrations] Done. Applied ${applied.length}, skipped ${skipped.length}${drift.length ? `, drift ${drift.length}` : ""}.`,
    );
  }

  return { applied, skipped, drift };
}

/**
 * Return the current tracker state + inline migration list, for the admin
 * diagnostic endpoint. `orphans` catches migrations recorded in the DB but
 * no longer present in code (e.g., someone renamed one — DO NOT do this).
 */
export function getMigrationStatus(
  db: Database.Database,
  migrations: InlineMigration[] = INLINE_MIGRATIONS,
): {
  source: "inline";
  files: Array<{
    filename: string;
    on_disk_sha256: string;
    applied: boolean;
    applied_at: string | null;
    recorded_sha256: string | null;
    drift: boolean;
  }>;
  orphans: MigrationRecord[];
} {
  ensureTrackerTable(db);

  const recorded = db
    .prepare("SELECT filename, sha256, applied_at FROM schema_migrations ORDER BY filename")
    .all() as MigrationRecord[];
  const recordedByName = new Map(recorded.map((r) => [r.filename, r]));

  const combined = migrations.map((m) => {
    const currentSha = sha256Hex(m.sql);
    const rec = recordedByName.get(m.name);
    return {
      filename: m.name,
      on_disk_sha256: currentSha,
      applied: !!rec,
      applied_at: rec?.applied_at ?? null,
      recorded_sha256: rec?.sha256 ?? null,
      drift: !!rec && rec.sha256 !== currentSha,
    };
  });

  const inlineSet = new Set(migrations.map((m) => m.name));
  const orphans = recorded.filter((r) => !inlineSet.has(r.filename));

  return { source: "inline", files: combined, orphans };
}
