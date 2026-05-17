/**
 * Backup engine — Feature 2
 *
 * - Local hourly snapshots of data.db (VACUUM INTO + gzip)
 * - Daily Google Drive DB push
 * - Weekly full backup (DB + PDFs)
 * - Retention management
 * - backup_runs tracking
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";

import { sqlite, insertBackupRun, getLastSuccessfulBackupRun, countConsecutiveFailures, getLastBackupRun, listBackupRuns, getConfig, setConfig } from "./storage";
import { getValidDriveClient, getOrCreateDriveFolder } from "./google-oauth";
import { drive_v3 } from "googleapis";

// ===== Constants =====

export const BACKUP_DIR = path.resolve("private_assets/backups/local");
const PRIVATE_ASSETS_DIR = path.resolve("private_assets");
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DRIVE_BACKUPS_FOLDER = "SnoHaus AP Backups";
const DRIVE_FOLDER_ID_KEY = "drive_backups_folder_id";

// ===== Directory setup =====

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

// ===== Filename helpers =====

function makeDateStr(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function makeDateOnlyStr(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ===== Local hourly backup =====

export async function runLocalBackup(): Promise<{ filePath: string; sizeBytes: number }> {
  ensureBackupDir();
  const now = new Date();
  const dateStr = makeDateStr(now);
  const finalName = `snohaus-ap-${dateStr}.db.gz`;
  const finalPath = path.join(BACKUP_DIR, finalName);

  // VACUUM INTO a temp file to avoid locking issues
  const tmpPath = path.join(os.tmpdir(), `backup-${Date.now()}.db`);
  try {
    sqlite.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);

    // Gzip the temp file to the final path
    await pipeline(
      createReadStream(tmpPath),
      zlib.createGzip(),
      createWriteStream(finalPath)
    );

    const stat = fs.statSync(finalPath);
    return { filePath: finalPath, sizeBytes: stat.size };
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

export async function runLocalBackupWithTracking(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const { filePath, sizeBytes } = await runLocalBackup();
    insertBackupRun({
      kind: "local_hourly",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "success",
      file_path: filePath,
      file_size_bytes: sizeBytes,
      drive_file_id: null,
      error: null,
    });
    // Prune old local backups (keep 7 days)
    pruneLocalBackups(7);
    console.log(`[backups] Local backup complete: ${path.basename(filePath)} (${(sizeBytes / 1024).toFixed(1)} KB)`);
  } catch (e: any) {
    console.error("[backups] Local backup failed:", e.message);
    insertBackupRun({
      kind: "local_hourly",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "failed",
      file_path: null,
      file_size_bytes: null,
      drive_file_id: null,
      error: e.message,
    });
    checkAndAlertOnFailures("local_hourly");
  }
}

// ===== Retention / pruning =====

function pruneLocalBackups(keepDays: number) {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(BACKUP_DIR)) {
    if (!file.endsWith(".db.gz")) continue;
    const fullPath = path.join(BACKUP_DIR, file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtime.getTime() < cutoff) {
        fs.unlinkSync(fullPath);
        console.log(`[backups] Pruned old local backup: ${file}`);
      }
    } catch {}
  }
}

// ===== Drive folder management =====

async function getDriveFolderId(drive: drive_v3.Drive): Promise<string> {
  // Check cache
  const cached = getConfig(DRIVE_FOLDER_ID_KEY);
  if (cached) return cached;

  const folderId = await getOrCreateDriveFolder(drive, DRIVE_BACKUPS_FOLDER);
  setConfig(DRIVE_FOLDER_ID_KEY, folderId);
  return folderId;
}

async function pruneOldDriveFiles(
  drive: drive_v3.Drive,
  folderId: string,
  namePrefix: string,
  keepDays: number
): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    const res = await drive.files.list({
      q: `'${folderId}' in parents and name contains '${namePrefix}' and trashed=false and createdTime < '${cutoff}'`,
      fields: "files(id, name, createdTime)",
      spaces: "drive",
    });
    for (const f of res.data.files || []) {
      if (f.id) {
        await drive.files.delete({ fileId: f.id });
        console.log(`[backups] Pruned old Drive file: ${f.name}`);
      }
    }
  } catch (e: any) {
    console.error("[backups] Drive prune failed:", e.message);
  }
}

// ===== Daily Drive DB push =====

export async function runDriveDailyBackup(): Promise<void> {
  const startedAt = new Date().toISOString();
  const drive = await getValidDriveClient();
  if (!drive) {
    console.log("[backups] Drive daily backup skipped: Drive not connected");
    return;
  }

  try {
    // Find the most recent local backup
    ensureBackupDir();
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith(".db.gz"))
      .sort()
      .reverse();

    let sourceFile: string;
    if (files.length > 0) {
      sourceFile = path.join(BACKUP_DIR, files[0]);
    } else {
      // Run a fresh local backup
      const { filePath } = await runLocalBackup();
      sourceFile = filePath;
    }

    const folderId = await getDriveFolderId(drive);
    const dateStr = makeDateOnlyStr();
    const driveName = `snohaus-ap-db-${dateStr}.db.gz`;

    const uploadRes = await drive.files.create({
      requestBody: {
        name: driveName,
        parents: [folderId],
      },
      media: {
        mimeType: "application/gzip",
        body: createReadStream(sourceFile),
      },
      fields: "id",
    });

    const driveFileId = uploadRes.data.id || null;
    const stat = fs.statSync(sourceFile);

    insertBackupRun({
      kind: "drive_daily_db",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "success",
      file_path: sourceFile,
      file_size_bytes: stat.size,
      drive_file_id: driveFileId,
      error: null,
    });

    // Prune old Drive backups
    await pruneOldDriveFiles(drive, folderId, "snohaus-ap-db-", 30);
    console.log(`[backups] Drive daily backup complete: ${driveName} (file ID: ${driveFileId})`);
  } catch (e: any) {
    console.error("[backups] Drive daily backup failed:", e.message);
    insertBackupRun({
      kind: "drive_daily_db",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "failed",
      file_path: null,
      file_size_bytes: null,
      drive_file_id: null,
      error: e.message,
    });
    checkAndAlertOnFailures("drive_daily_db");
  }
}

// ===== Weekly full backup =====

export async function runDriveWeeklyFullBackup(): Promise<void> {
  const startedAt = new Date().toISOString();
  const drive = await getValidDriveClient();
  if (!drive) {
    console.log("[backups] Drive weekly backup skipped: Drive not connected");
    return;
  }

  const tmpZipPath = path.join(os.tmpdir(), `snohaus-full-backup-${Date.now()}.zip`);
  try {
    // Build a zip containing the latest DB backup + all PDFs
    await buildFullBackupZip(tmpZipPath);

    const folderId = await getDriveFolderId(drive);
    const dateStr = makeDateOnlyStr();
    const driveName = `snohaus-ap-full-${dateStr}.zip`;

    const stat = fs.statSync(tmpZipPath);
    const uploadRes = await drive.files.create({
      requestBody: {
        name: driveName,
        parents: [folderId],
      },
      media: {
        mimeType: "application/zip",
        body: createReadStream(tmpZipPath),
      },
      fields: "id",
    });

    const driveFileId = uploadRes.data.id || null;
    insertBackupRun({
      kind: "drive_weekly_full",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "success",
      file_path: tmpZipPath,
      file_size_bytes: stat.size,
      drive_file_id: driveFileId,
      error: null,
    });

    await pruneOldDriveFiles(drive, folderId, "snohaus-ap-full-", 30);
    console.log(`[backups] Drive weekly full backup complete: ${driveName}`);
  } catch (e: any) {
    console.error("[backups] Drive weekly backup failed:", e.message);
    insertBackupRun({
      kind: "drive_weekly_full",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      status: "failed",
      file_path: null,
      file_size_bytes: null,
      drive_file_id: null,
      error: e.message,
    });
    checkAndAlertOnFailures("drive_weekly_full");
  } finally {
    try { fs.unlinkSync(tmpZipPath); } catch {}
  }
}

async function buildFullBackupZip(outputPath: string): Promise<void> {
  // Use archiver-style manual zip building with yauzl — but we don't have yauzl.
  // Use a simple approach: shell-less zip via node:stream with a JSZip-like implementation.
  // Since we don't have JSZip, use the built-in approach: write a .zip with raw stored entries.
  // For simplicity, use a gzip tarball approach via Node streams.
  // Actually: let's use archiver if available, or fall back to a simple approach.

  // Simplest reliable approach: create an uncompressed zip using raw zip format
  const { ZipWriter } = await importZipWriter();

  // Get latest DB backup file
  const dbFile = getLatestLocalBackupFile();
  const dbEntry = dbFile ? { path: dbFile, name: `db/${path.basename(dbFile)}` } : null;

  // Get all PDFs from private_assets (excluding backups dir)
  const pdfEntries: { path: string; name: string }[] = [];
  if (fs.existsSync(PRIVATE_ASSETS_DIR)) {
    for (const file of fs.readdirSync(PRIVATE_ASSETS_DIR)) {
      const fullPath = path.join(PRIVATE_ASSETS_DIR, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && /\.(pdf|PDF)$/.test(file)) {
        pdfEntries.push({ path: fullPath, name: `pdfs/${file}` });
      }
    }
  }

  await ZipWriter.write(outputPath, [
    ...(dbEntry ? [dbEntry] : []),
    ...pdfEntries,
  ]);
}

// Simple zip writer using Node.js built-in streams
const importZipWriter = async () => ({
  ZipWriter: {
    async write(outputPath: string, entries: { path: string; name: string }[]): Promise<void> {
      // Use a minimal ZIP implementation
      const parts: Buffer[] = [];
      const centralDir: Buffer[] = [];
      let offset = 0;

      for (const entry of entries) {
        if (!fs.existsSync(entry.path)) continue;
        const data = fs.readFileSync(entry.path);
        const nameBytes = Buffer.from(entry.name, "utf8");
        const crc = crc32(data);
        const localHeader = makeLocalHeader(nameBytes, data.length, crc);
        parts.push(localHeader);
        parts.push(data);
        centralDir.push(makeCentralHeader(nameBytes, data.length, crc, offset));
        offset += localHeader.length + data.length;
      }

      const centralDirBytes = Buffer.concat(centralDir);
      const eocd = makeEndOfCentralDirectory(centralDir.length, centralDirBytes.length, offset);
      const zip = Buffer.concat([...parts, centralDirBytes, eocd]);
      fs.writeFileSync(outputPath, zip);
    }
  }
});

// Minimal ZIP implementation
function crc32(buf: Buffer): number {
  // CRC-32 table
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeLocalHeader(name: Buffer, size: number, crc: number): Buffer {
  const buf = Buffer.alloc(30 + name.length);
  buf.writeUInt32LE(0x04034b50, 0);  // local file header signature
  buf.writeUInt16LE(20, 4);          // version needed
  buf.writeUInt16LE(0, 6);           // general purpose flags
  buf.writeUInt16LE(0, 8);           // compression: stored
  buf.writeUInt16LE(0, 10);          // last mod time
  buf.writeUInt16LE(0, 12);          // last mod date
  buf.writeUInt32LE(crc, 14);        // crc-32
  buf.writeUInt32LE(size, 18);       // compressed size
  buf.writeUInt32LE(size, 22);       // uncompressed size
  buf.writeUInt16LE(name.length, 26); // file name length
  buf.writeUInt16LE(0, 28);          // extra field length
  name.copy(buf, 30);
  return buf;
}

function makeCentralHeader(name: Buffer, size: number, crc: number, offset: number): Buffer {
  const buf = Buffer.alloc(46 + name.length);
  buf.writeUInt32LE(0x02014b50, 0);  // central dir signature
  buf.writeUInt16LE(20, 4);          // version made by
  buf.writeUInt16LE(20, 6);          // version needed
  buf.writeUInt16LE(0, 8);           // flags
  buf.writeUInt16LE(0, 10);          // compression: stored
  buf.writeUInt16LE(0, 12);          // last mod time
  buf.writeUInt16LE(0, 14);          // last mod date
  buf.writeUInt32LE(crc, 16);        // crc-32
  buf.writeUInt32LE(size, 20);       // compressed size
  buf.writeUInt32LE(size, 24);       // uncompressed size
  buf.writeUInt16LE(name.length, 28); // filename length
  buf.writeUInt16LE(0, 30);          // extra field length
  buf.writeUInt16LE(0, 32);          // comment length
  buf.writeUInt16LE(0, 34);          // disk start
  buf.writeUInt16LE(0, 36);          // internal attrs
  buf.writeUInt32LE(0, 38);          // external attrs
  buf.writeUInt32LE(offset, 42);     // relative offset
  name.copy(buf, 46);
  return buf;
}

function makeEndOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);  // EOCD signature
  buf.writeUInt16LE(0, 4);           // disk number
  buf.writeUInt16LE(0, 6);           // disk with CD start
  buf.writeUInt16LE(count, 8);       // entries on this disk
  buf.writeUInt16LE(count, 10);      // total entries
  buf.writeUInt32LE(cdSize, 12);     // central dir size
  buf.writeUInt32LE(cdOffset, 16);   // central dir offset
  buf.writeUInt16LE(0, 20);          // comment length
  return buf;
}

// ===== List local backups =====

export function listLocalBackups(): { filename: string; sizeBytes: number; createdAt: string }[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith(".db.gz"))
    .sort()
    .reverse()
    .map(f => {
      const fullPath = path.join(BACKUP_DIR, f);
      let sizeBytes = 0;
      let createdAt = "";
      try {
        const stat = fs.statSync(fullPath);
        sizeBytes = stat.size;
        createdAt = stat.mtime.toISOString();
      } catch {}
      return { filename: f, sizeBytes, createdAt };
    });
}

export function getLatestLocalBackupFile(): string | null {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith(".db.gz"))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(BACKUP_DIR, files[0]) : null;
}

// ===== Failure alerting =====

function checkAndAlertOnFailures(kind: string) {
  try {
    const count = countConsecutiveFailures(kind);
    if (count >= 2) {
      console.error(
        `[backups] ALERT: ${kind} has failed ${count} consecutive times. ` +
        `Check Settings → Backups for details. To fix: verify Google Drive connection, ` +
        `check disk space, and ensure data.db is accessible.`
      );
    }
  } catch {}
}

// ===== Scheduler =====

export function startBackupScheduler(): void {
  // Local hourly backup
  setInterval(() => {
    runLocalBackupWithTracking().catch(e => console.error("[backups] Scheduler error:", e.message));
  }, 60 * 60 * 1000);

  // Drive daily at 02:00 local time
  scheduleDailyAt(2, 0, () => {
    runDriveDailyBackup().catch(e => console.error("[backups] Drive daily error:", e.message));
  });

  // Drive weekly on Sunday at 03:00 local time
  scheduleWeeklyOnSunday(3, 0, () => {
    runDriveWeeklyFullBackup().catch(e => console.error("[backups] Drive weekly error:", e.message));
  });

  console.log("[backups] Backup scheduler started (hourly local, daily drive at 02:00, weekly full on Sun at 03:00)");
}

function scheduleDailyAt(hour: number, minute: number, fn: () => void): void {
  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    setTimeout(() => {
      fn();
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}

function scheduleWeeklyOnSunday(hour: number, minute: number, fn: () => void): void {
  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
    // Move to next Sunday
    const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
    next.setDate(next.getDate() + daysUntilSunday);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 7);
    const delay = next.getTime() - now.getTime();
    setTimeout(() => {
      fn();
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}

// ===== Status API =====

export function getBackupStatus() {
  const kinds = ["local_hourly", "drive_daily_db", "drive_weekly_full"] as const;
  const result: Record<string, any> = {};
  for (const kind of kinds) {
    const last = getLastBackupRun(kind);
    const lastSuccess = getLastSuccessfulBackupRun(kind);
    result[kind] = {
      last_run: last,
      last_success: lastSuccess,
      consecutive_failures: countConsecutiveFailures(kind),
    };
  }
  return result;
}
