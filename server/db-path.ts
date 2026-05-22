/**
 * PR #R4j — Centralized resolver for the SQLite data file path.
 *
 * Why this exists:
 *   storage.ts, qbo.ts, gmail.ts, acumatica.ts, invoice-pipeline.ts and
 *   vendor-groups.ts all need to open the SAME data.db file. Until this PR
 *   each module computed it independently — five of them used
 *   `path.resolve(process.cwd(), "data.db")` and one used the bare relative
 *   path `"data.db"`.
 *
 *   That worked fine when the process was launched from a shell sitting in
 *   `C:\snohaus-ap-windows`. It broke when NSSM (Windows service wrapper)
 *   launched the same binary under LocalSystem: depending on the NSSM
 *   version and the AppDirectory setting, `process.cwd()` can land in
 *   `C:\Windows\system32`. In that case:
 *
 *     - `new Database("data.db")` either silently creates an empty
 *       `C:\Windows\system32\data.db` (write OK) or throws SQLITE_CANTOPEN
 *       (typical, because LocalSystem can write there but the bootstrap
 *       schema then has no parent tables) before app-logger's
 *       uncaughtException hook has fully wired through every import path.
 *
 *     - The service exits in <1500 ms with no stack trace in either
 *       server.log (NSSM stderr — too early) or logs/app.log (app-logger —
 *       crashed mid-import before the file handle was open).
 *
 *   The R4e gift-card schema and the R4i schema-drift migration both run
 *   CREATE TABLE / ALTER TABLE statements at module load. Before R4e the
 *   wrong-cwd open would silently land on an empty stray DB and the service
 *   would limp along with no business data; with R4e/R4i's writes the
 *   cascade fails outright and NSSM kills the process. That's why the
 *   regression "appeared with R4e" — the bug is older but R4e is what made
 *   it fatal.
 *
 * Resolution policy (highest precedence first):
 *   1. SNOHAUS_DB_PATH env var — explicit override for tests / migration.
 *   2. <executable dir>/../data.db — for production cjs builds this lands
 *      at `C:\snohaus-ap-windows\data.db` regardless of cwd (the bundled
 *      `dist/index.cjs` lives in `dist/`, so `..` walks up to the install
 *      root).
 *   3. <process.cwd()>/data.db — fallback for `tsx server/index.ts` dev
 *      runs where the script is loaded from server/, not dist/.
 *
 * The file is NOT created here — callers still do `new Database(getDbPath())`
 * which creates the file on first open. We only resolve the path.
 */

import path from "node:path";
import fs from "node:fs";

let cached: string | null = null;

export function getDbPath(): string {
  if (cached) return cached;

  const envOverride = process.env.SNOHAUS_DB_PATH;
  if (envOverride && envOverride.trim().length > 0) {
    cached = path.resolve(envOverride);
    return cached;
  }

  // __dirname in the bundled cjs build = `<install>/dist`. Walk up one level
  // to land on the install root next to package.json, ngrok.exe, etc.
  //
  // In dev (tsx) __dirname = `<repo>/server`, so `..` walks up to the repo
  // root which is the same place data.db lives in checked-out repos.
  const beside = path.resolve(__dirname, "..", "data.db");

  // If `beside` resolves to a writable location, use it. Otherwise fall
  // back to cwd-relative (preserves legacy behaviour for any setup we
  // haven't anticipated).
  try {
    const dir = path.dirname(beside);
    fs.accessSync(dir, fs.constants.W_OK);
    cached = beside;
    return cached;
  } catch {
    cached = path.resolve(process.cwd(), "data.db");
    return cached;
  }
}

/**
 * Reset the cached value. Test-only — production code should call getDbPath()
 * which memoizes the first resolution.
 */
export function _resetDbPathCache(): void {
  cached = null;
}

/**
 * The install root — same logic as the DB path resolution but without the
 * `data.db` filename. Useful for resolving `private_assets/`, `logs/`,
 * `ngrok.exe` and similar siblings of the data file when callers need to be
 * cwd-independent. Not currently used in this PR; provided for follow-ups.
 */
export function getInstallRoot(): string {
  const dbPath = getDbPath();
  return path.dirname(dbPath);
}
