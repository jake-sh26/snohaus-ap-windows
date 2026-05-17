/**
 * PDF Archive Engine — Feature 3
 *
 * - Weekly on Sunday at 04:00, bundles invoices older than 12 months into monthly zips
 * - Uploads to Drive folder "SnoHaus AP PDF Archive"
 * - After successful upload, marks invoice.archived_at and clears pdf_url
 * - Tracks archive status
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createReadStream } from "node:fs";

import { sqlite, getConfig, setConfig } from "./storage";
import { getValidDriveClient, getOrCreateDriveFolder } from "./google-oauth";
import { drive_v3 } from "googleapis";

const PRIVATE_ASSETS_DIR = path.resolve("private_assets");
const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
const DRIVE_PDF_ARCHIVE_FOLDER = "SnoHaus AP PDF Archive";
const DRIVE_PDF_FOLDER_KEY = "drive_pdf_archive_folder_id";

// ===== Archive status for UI =====

export function getArchiveStatus(): {
  archived_months: number;
  archived_invoice_count: number;
  last_run_at: string | null;
  last_error: string | null;
} {
  try {
    const archived_invoice_count = (
      sqlite.prepare(`SELECT COUNT(*) as c FROM invoices WHERE archived_at IS NOT NULL`).get() as { c: number }
    ).c;
    // Count distinct months of archived invoices
    const months = sqlite.prepare(
      `SELECT COUNT(DISTINCT substr(created_at, 1, 7)) as m FROM invoices WHERE archived_at IS NOT NULL`
    ).get() as { m: number };
    const lastRun = getConfig("pdf_archive_last_run");
    const lastError = getConfig("pdf_archive_last_error");
    return {
      archived_months: months.m,
      archived_invoice_count,
      last_run_at: lastRun,
      last_error: lastError,
    };
  } catch {
    return { archived_months: 0, archived_invoice_count: 0, last_run_at: null, last_error: null };
  }
}

// ===== Run archive =====

export async function runPdfArchive(): Promise<{ archived: number; skipped: number; error?: string }> {
  const drive = await getValidDriveClient();
  if (!drive) {
    const msg = "Drive not connected — skipping PDF archive";
    setConfig("pdf_archive_last_error", msg);
    console.log(`[pdf-archive] ${msg}`);
    return { archived: 0, skipped: 0, error: msg };
  }

  const cutoff = new Date(Date.now() - TWELVE_MONTHS_MS).toISOString();
  let totalArchived = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  try {
    // Find all invoices older than 12 months with a PDF that haven't been archived yet
    const invoicesToArchive = sqlite.prepare(`
      SELECT id, pdf_url, source_file, created_at
      FROM invoices
      WHERE created_at < ?
        AND archived_at IS NULL
        AND (pdf_url IS NOT NULL OR source_file IS NOT NULL)
      ORDER BY created_at ASC
    `).all(cutoff) as Array<{
      id: string;
      pdf_url: string | null;
      source_file: string | null;
      created_at: string;
    }>;

    if (invoicesToArchive.length === 0) {
      console.log("[pdf-archive] No invoices to archive");
      setConfig("pdf_archive_last_run", new Date().toISOString());
      setConfig("pdf_archive_last_error", "");
      return { archived: 0, skipped: 0 };
    }

    // Group by YYYY-MM
    const byMonth = new Map<string, typeof invoicesToArchive>();
    for (const inv of invoicesToArchive) {
      const month = (inv.created_at || "").substring(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month)!.push(inv);
    }

    // Get/create Drive archive folder
    const folderId = await getOrCreateArchiveFolder(drive);

    for (const [month, invoices] of byMonth.entries()) {
      try {
        const { archived, skipped } = await archiveMonth(drive, folderId, month, invoices);
        totalArchived += archived;
        totalSkipped += skipped;
      } catch (e: any) {
        console.error(`[pdf-archive] Error archiving month ${month}:`, e.message);
        errors.push(`${month}: ${e.message}`);
      }
    }

    setConfig("pdf_archive_last_run", new Date().toISOString());
    setConfig("pdf_archive_last_error", errors.length > 0 ? errors.join("; ") : "");
    console.log(`[pdf-archive] Done: archived ${totalArchived} invoices, skipped ${totalSkipped}`);
    return { archived: totalArchived, skipped: totalSkipped, error: errors.length > 0 ? errors.join("; ") : undefined };
  } catch (e: any) {
    const msg = e.message;
    setConfig("pdf_archive_last_error", msg);
    console.error("[pdf-archive] Fatal error:", msg);
    return { archived: totalArchived, skipped: totalSkipped, error: msg };
  }
}

async function getOrCreateArchiveFolder(drive: drive_v3.Drive): Promise<string> {
  const cached = getConfig(DRIVE_PDF_FOLDER_KEY);
  if (cached) return cached;
  const folderId = await getOrCreateDriveFolder(drive, DRIVE_PDF_ARCHIVE_FOLDER);
  setConfig(DRIVE_PDF_FOLDER_KEY, folderId);
  return folderId;
}

async function archiveMonth(
  drive: drive_v3.Drive,
  folderId: string,
  month: string,  // "YYYY-MM"
  invoices: Array<{ id: string; pdf_url: string | null; source_file: string | null; created_at: string }>
): Promise<{ archived: number; skipped: number }> {
  const zipName = `snohaus-ap-pdfs-${month}.zip`;
  const tmpZipPath = path.join(os.tmpdir(), `archive-${month}-${Date.now()}.zip`);

  // Collect PDF files that actually exist
  const entries: { path: string; name: string; invoiceId: string }[] = [];
  for (const inv of invoices) {
    const pdfFile = inv.source_file || inv.pdf_url;
    if (!pdfFile) continue;

    // Resolve path
    let fullPath: string;
    if (path.isAbsolute(pdfFile)) {
      fullPath = pdfFile;
    } else {
      fullPath = path.join(PRIVATE_ASSETS_DIR, pdfFile);
    }

    if (fs.existsSync(fullPath)) {
      entries.push({ path: fullPath, name: path.basename(fullPath), invoiceId: inv.id });
    }
  }

  if (entries.length === 0) {
    // No actual PDFs to archive — just mark them as archived anyway
    const now = new Date().toISOString();
    for (const inv of invoices) {
      sqlite.prepare(`UPDATE invoices SET archived_at = ? WHERE id = ?`).run(now, inv.id);
    }
    return { archived: invoices.length, skipped: 0 };
  }

  // Build the zip
  await buildSimpleZip(tmpZipPath, entries.map(e => ({ path: e.path, name: e.name })));

  try {
    // Upload to Drive
    const stat = fs.statSync(tmpZipPath);
    await drive.files.create({
      requestBody: {
        name: zipName,
        parents: [folderId],
      },
      media: {
        mimeType: "application/zip",
        body: createReadStream(tmpZipPath),
      },
      fields: "id",
    });

    // Mark invoices as archived + clear pdf_url
    const now = new Date().toISOString();
    const archiveMarker = `archived://${month}/${zipName}`;
    for (const entry of entries) {
      sqlite.prepare(`
        UPDATE invoices
        SET archived_at = ?,
            pdf_url = ?,
            source_file = ?
        WHERE id = ?
      `).run(now, archiveMarker, archiveMarker, entry.invoiceId);

      // Delete the local PDF file
      try { fs.unlinkSync(entry.path); } catch {}
    }

    // Mark invoices with no PDF file as archived too
    for (const inv of invoices) {
      if (!entries.find(e => e.invoiceId === inv.id)) {
        sqlite.prepare(`UPDATE invoices SET archived_at = ? WHERE id = ?`).run(now, inv.id);
      }
    }

    console.log(`[pdf-archive] Archived ${month}: ${entries.length} PDFs → ${zipName}`);
    return { archived: entries.length, skipped: invoices.length - entries.length };
  } finally {
    try { fs.unlinkSync(tmpZipPath); } catch {}
  }
}

// ===== Simple ZIP builder (copied from backups.ts approach) =====

async function buildSimpleZip(outputPath: string, entries: { path: string; name: string }[]): Promise<void> {
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
  fs.writeFileSync(outputPath, Buffer.concat([...parts, centralDirBytes, eocd]));
}

// ZIP helpers (same as backups.ts)
function crc32(buf: Buffer): number {
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
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(20, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt16LE(0, 12);
  buf.writeUInt32LE(crc, 14);
  buf.writeUInt32LE(size, 18);
  buf.writeUInt32LE(size, 22);
  buf.writeUInt16LE(name.length, 26);
  buf.writeUInt16LE(0, 28);
  name.copy(buf, 30);
  return buf;
}

function makeCentralHeader(name: Buffer, size: number, crc: number, offset: number): Buffer {
  const buf = Buffer.alloc(46 + name.length);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt16LE(20, 4);
  buf.writeUInt16LE(20, 6);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt16LE(0, 12);
  buf.writeUInt16LE(0, 14);
  buf.writeUInt32LE(crc, 16);
  buf.writeUInt32LE(size, 20);
  buf.writeUInt32LE(size, 24);
  buf.writeUInt16LE(name.length, 28);
  buf.writeUInt16LE(0, 30);
  buf.writeUInt16LE(0, 32);
  buf.writeUInt16LE(0, 34);
  buf.writeUInt16LE(0, 36);
  buf.writeUInt32LE(0, 38);
  buf.writeUInt32LE(offset, 42);
  name.copy(buf, 46);
  return buf;
}

function makeEndOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(count, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(cdSize, 12);
  buf.writeUInt32LE(cdOffset, 16);
  buf.writeUInt16LE(0, 20);
  return buf;
}

// ===== Scheduler =====

export function startArchiveScheduler(): void {
  // Weekly on Sunday at 04:00
  scheduleWeeklyOnSunday(4, 0, () => {
    runPdfArchive().catch(e => console.error("[pdf-archive] Scheduler error:", e.message));
  });
  console.log("[pdf-archive] Archive scheduler started (weekly on Sunday at 04:00)");
}

function scheduleWeeklyOnSunday(hour: number, minute: number, fn: () => void): void {
  function scheduleNext() {
    const now = new Date();
    const next = new Date(now);
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
