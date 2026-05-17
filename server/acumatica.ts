/**
 * Acumatica vendor portal puller (Winter Sports Retailers).
 *
 * Proven flow (validated 4/28/2026 against tenant wintersportsretailers.scsuser.com):
 *   1. Login to /MembersPortal/Frames/Login.aspx (visible inputs only — skip hidden CompanyID)
 *   2. Click sidebar Documents → My Documents (lives in OUTER page)
 *   3. Drill into iframe[name="main"] (Acumatica wraps all screens here)
 *   4. Click "OPEN DOCUMENT" tab inside iframe
 *   5. Collect <a> tags whose text matches /^(INV|CRT|REC|ARWO)\d+$/
 *   6. For each ref NOT in acumatica_seen_docs:
 *        a. Listen for any response with content-type: application/pdf
 *        b. Click the reference link → iframe loads ScreenID=AR641000 → fires GET PX.ReportViewer.axd
 *        c. Capture PDF buffer from the response
 *        d. Run pipeline.processInvoicePdf
 *        e. INSERT into acumatica_seen_docs
 *        f. Navigate iframe back to My Documents (ScreenID=SP402000)
 *   7. Log summary to acumatica_pulls
 *
 * Env vars (optional — module no-ops when missing):
 *   ACUMATICA_URL, ACUMATICA_USER, ACUMATICA_PASS
 */

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  recordIntegrationError,
  recordIntegrationWarn,
  getIntegrationErrorLog,
  clearIntegrationErrorLog,
} from "./error-log";

function acuError(scope: string, msg: string) { recordIntegrationError("acumatica", scope, msg, "error"); }
function acuWarn(scope: string, msg: string) { recordIntegrationWarn("acumatica", scope, msg); }
export function getAcumaticaErrorLog(limit = 20) { return getIntegrationErrorLog("acumatica", limit); }
export function clearAcumaticaErrorLog() { clearIntegrationErrorLog("acumatica"); }
import { processInvoicePdf } from "./invoice-pipeline";

const DB_PATH = path.resolve(process.cwd(), "data.db");

let lastRunAt: string | null = null;
let lastRunSummary: AcumaticaRunResult | null = null;
let lastRunError: string | null = null;
let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
let runInProgress = false;

export type AcumaticaRunResult = {
  ok: boolean;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  documents_seen: number;
  documents_new: number;
  documents_ingested: number;
  documents_skipped: number;
  documents_duplicate: number;
  errors: string[];
  /** Set only when run was invoked with debug=true. Paths are absolute. */
  debug?: {
    enabled: true;
    screenshot_path: string | null;
    iframe_html_path: string | null;
    log_path: string | null;
    summary: string;
  };
};

function getDb() {
  return new Database(DB_PATH);
}

function ensureSchema() {
  const db = getDb();
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS acumatica_pulls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT,
        ended_at TEXT,
        ok INTEGER,
        documents_seen INTEGER,
        documents_new INTEGER,
        documents_ingested INTEGER,
        documents_skipped INTEGER,
        documents_duplicate INTEGER,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS acumatica_seen_docs (
        doc_ref TEXT PRIMARY KEY,
        first_seen_at TEXT,
        invoice_id TEXT
      );
    `);
  } finally {
    db.close();
  }
}

export function isAcumaticaConfigured(): boolean {
  return !!(process.env.ACUMATICA_URL && process.env.ACUMATICA_USER && process.env.ACUMATICA_PASS);
}

let runStartedAt: string | null = null;
let runProgressNote: string | null = null;

export function setAcumaticaProgress(note: string) {
  runProgressNote = note;
}

export function getAcumaticaStatus() {
  ensureSchema();
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM acumatica_pulls ORDER BY id DESC LIMIT 5`).all();
  db.close();
  return {
    configured: isAcumaticaConfigured(),
    run_in_progress: runInProgress,
    run_started_at: runStartedAt,
    run_progress_note: runProgressNote,
    last_run_at: lastRunAt,
    last_run: lastRunSummary,
    last_error: lastRunError,
    recent_runs: rows,
  };
}

/**
 * Public entry — invoked from /api/acumatica/run-now and from the cron timer.
 *
 * `opts.debug = true` runs through login + navigation + OPEN DOCUMENT click,
 * dumps a screenshot, the main iframe HTML, and a structured DOM-probe log to
 * C:\snohaus-ap-windows\debug, then returns WITHOUT clicking any per-row link.
 * Use it once when row-clicks are timing out so we can see what changed.
 */
export async function runAcumaticaPullNow(opts: { debug?: boolean } = {}): Promise<AcumaticaRunResult> {
  const debug = !!opts.debug;
  if (runInProgress) {
    return {
      ok: false,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 0,
      documents_seen: 0,
      documents_new: 0,
      documents_ingested: 0,
      documents_skipped: 0,
      documents_duplicate: 0,
      errors: ["A pull is already in progress"],
    };
  }
  runInProgress = true;
  ensureSchema();
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  runStartedAt = startedAtIso;
  runProgressNote = "Starting…";
  const errors: string[] = [];
  let documents_seen = 0;
  let documents_new = 0;
  let documents_ingested = 0;
  let documents_skipped = 0;
  let documents_duplicate = 0;

  try {
    if (!isAcumaticaConfigured()) {
      throw new Error("Acumatica not configured. Set ACUMATICA_URL, ACUMATICA_USER, ACUMATICA_PASS in .env");
    }

    runProgressNote = "Launching browser…";
    let chromium: any;
    try {
      ({ chromium } = await import("playwright"));
    } catch (e: any) {
      throw new Error(`Playwright not available: ${e.message}. Run: npx playwright install chromium`);
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1400, height: 900 },
    });
    const page = await context.newPage();

    // Set up a global PDF response capture. Acumatica fires
    // GET /MembersPortal/.../frames/PX.ReportViewer.axd?...&OpType=PdfReport when
    // the invoice detail (ScreenID=AR641000) screen renders. We grab the buffer
    // here so we don't have to interact with the in-browser PDF viewer toolbar.
    // Buffer ALL pdf responses the moment they arrive. We grab the body immediately
    // (before any navigation can evict the resource from Chrome's network store).
    // This is critical because Acumatica's invoice screen runs the PDF fetch inside
    // an iframe that gets replaced between documents — by the time we'd lazily call
    // resp.body(), Chrome has already freed the resource and the call throws
    // "No resource with given identifier found" (Network.getResponseBody protocol error).
    type PdfHit = { buf: Buffer; filename: string | null; url: string };
    const pdfQueue: PdfHit[] = [];
    const pdfWaiters: Array<(hit: PdfHit) => void> = [];

    async function tryBufferPdfResponse(resp: any) {
      try {
        const ct = (resp.headers()["content-type"] || "").toString();
        if (!/application\/pdf/i.test(ct)) return;
        const cd = (resp.headers()["content-disposition"] || "").toString();
        const m = cd.match(/filename\*?\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i);
        let filename: string | null = null;
        if (m) {
          try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; }
        }
        const url = resp.url();
        let buf: Buffer | null = null;
        // Primary: read the response body NOW while it's still in the protocol buffer.
        try {
          buf = await resp.body();
        } catch (err: any) {
          // Fallback: response body was evicted (iframe detached, navigation, etc.).
          // Refetch the same URL through the authenticated context — cookies are reused.
          try {
            const r2 = await context.request.get(url);
            const ab = await r2.body();
            buf = Buffer.from(ab);
          } catch (refetchErr: any) {
            console.warn(
              `[acumatica] could not capture PDF body for ${url.slice(0, 120)}… ` +
              `(primary: ${err?.message || err}; refetch: ${refetchErr?.message || refetchErr})`
            );
            return;
          }
        }
        if (!buf || buf.length < 100) return; // not a real PDF
        const hit: PdfHit = { buf, filename, url };
        const w = pdfWaiters.shift();
        if (w) w(hit);
        else pdfQueue.push(hit);
      } catch {
        // never let a stray response handler crash the pull
      }
    }

    // Listen on every page in the context (covers popups + iframes via the parent page).
    context.on("page", (p: any) => {
      p.on("response", tryBufferPdfResponse);
    });
    page.on("response", tryBufferPdfResponse);

    // Track in-flight waiter rejecters so we can fail-fast on click errors
    // instead of waiting for the 120s timeout.
    const pendingRejecters = new Set<(e: Error) => void>();
    function clearPdfQueue(reason?: string) {
      // Called between docs so a leftover response from a prior iteration
      // can't be mis-attributed to the next one.
      pdfQueue.length = 0;
      pdfWaiters.length = 0;
      if (reason) {
        for (const rej of pendingRejecters) {
          try { rej(new Error(reason)); } catch {}
        }
      }
      pendingRejecters.clear();
    }

    function waitForNextPdf(timeoutMs = 120000): Promise<{ buf: Buffer; filename: string | null }> {
      // If a PDF already arrived (e.g. between when we kicked the click and now), return it.
      const queued = pdfQueue.shift();
      if (queued) return Promise.resolve({ buf: queued.buf, filename: queued.filename });
      let settled = false;
      let waiter: ((hit: PdfHit) => void) | null = null;
      let rejecter: ((e: Error) => void) | null = null;
      const p = new Promise<{ buf: Buffer; filename: string | null }>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (waiter) {
            const i = pdfWaiters.indexOf(waiter);
            if (i >= 0) pdfWaiters.splice(i, 1);
          }
          if (rejecter) pendingRejecters.delete(rejecter);
          reject(new Error(`Timed out waiting for PDF after ${timeoutMs}ms`));
        }, timeoutMs);
        waiter = (hit: PdfHit) => {
          if (settled) {
            pdfQueue.unshift(hit);
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (rejecter) pendingRejecters.delete(rejecter);
          resolve({ buf: hit.buf, filename: hit.filename });
        };
        rejecter = (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (waiter) {
            const i = pdfWaiters.indexOf(waiter);
            if (i >= 0) pdfWaiters.splice(i, 1);
          }
          reject(e);
        };
        pdfWaiters.push(waiter);
        pendingRejecters.add(rejecter);
      });
      p.catch(() => {});
      return p;
    }

    try {
      // ===== 1. Login =====
      await page.goto(process.env.ACUMATICA_URL!, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);

      // Acumatica's login page has a hidden CompanyID input that matches name="User*".
      // Filter to visible inputs only.
      const inputs = await page.$$eval("input", (els: any[]) =>
        els.map((el) => ({
          id: el.getAttribute("id"),
          name: el.getAttribute("name"),
          type: el.getAttribute("type"),
          placeholder: el.getAttribute("placeholder"),
          visible: el.offsetParent !== null,
        }))
      );
      const visible = inputs.filter((i: any) => i.visible);
      const userField =
        visible.find((i: any) => /user|email|login/i.test(i.name || i.id || i.placeholder || "")) ||
        visible.find((i: any) => i.type === "text" || i.type === "email");
      const passField =
        visible.find((i: any) => /pass/i.test(i.name || i.id || i.placeholder || "")) ||
        visible.find((i: any) => i.type === "password");
      if (!userField || !passField) {
        throw new Error("Could not auto-detect login fields");
      }

      await page.locator(`input[id="${userField.id}"]`).fill(process.env.ACUMATICA_USER!, { timeout: 15000 });
      await page.locator(`input[id="${passField.id}"]`).fill(process.env.ACUMATICA_PASS!, { timeout: 15000 });
      await page.locator(`input[id="${passField.id}"]`).press("Enter");
      await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // ===== 2. Sidebar nav (in OUTER page) =====
      await page.locator("text=Documents").first().click({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.locator("text=My Documents").first().click({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3500);

      // ===== 3. Drill into the main iframe =====
      const getMainFrame = async (expectTitleContains: string | null = null, attempts = 40) => {
        for (let i = 0; i < attempts; i++) {
          const frames = page.frames();
          const main = frames.find((f: any) => {
            try {
              return f.name() === "main";
            } catch {
              return false;
            }
          });
          if (main) {
            try {
              await main.waitForLoadState("domcontentloaded", { timeout: 1500 }).catch(() => {});
              const info = await main
                .evaluate(() => ({
                  title: document.title,
                  ready: document.body && document.body.children.length > 0,
                }))
                .catch(() => null);
              if (info && info.ready) {
                if (!expectTitleContains || info.title.toLowerCase().includes(expectTitleContains.toLowerCase())) {
                  return main;
                }
              }
            } catch {}
          }
          await page.waitForTimeout(500);
        }
        return null;
      };

      let mainFrame: any = await getMainFrame("My Documents");
      if (!mainFrame) throw new Error("My Documents frame did not load");

      // ===== 4. Click "OPEN DOCUMENT" tab =====
      const tabSelectors = [
        'text="OPEN DOCUMENT"',
        "text=Open Document",
        'a:has-text("OPEN DOCUMENT")',
        'span:has-text("OPEN DOCUMENT")',
      ];
      let tabClicked = false;
      for (const sel of tabSelectors) {
        try {
          const c = await mainFrame.locator(sel).first().count();
          if (c > 0) {
            await mainFrame.locator(sel).first().click({ timeout: 5000 });
            tabClicked = true;
            break;
          }
        } catch {}
      }
      if (!tabClicked) errors.push("Could not click OPEN DOCUMENT tab — using default view");
      await page.waitForTimeout(2500);

      // ===== 5. Collect reference numbers =====
      const refTexts: string[] = await mainFrame
        .$$eval("a", (els: any[]) =>
          els
            .map((e) => (e.innerText || "").trim())
            .filter((t: string) => /^(INV|CRT|REC|ARWO)\d+$/.test(t))
        )
        .catch(() => []);
      // De-dup while preserving order (some grids render same ref twice for icon + label)
      const seenInPage = new Set<string>();
      const docRefs = refTexts.filter((r: string) => {
        if (seenInPage.has(r)) return false;
        seenInPage.add(r);
        return true;
      });
      documents_seen = docRefs.length;
      runProgressNote = `Found ${documents_seen} open documents`;
      console.log(`[acumatica] OPEN DOCUMENT tab shows ${documents_seen} references: ${docRefs.join(", ")}`);

      // ===== DEBUG MODE: dump diagnostics and bail before per-row clicks =====
      if (debug) {
        const debugDir = path.resolve(process.cwd(), "debug");
        try { fs.mkdirSync(debugDir, { recursive: true }); } catch {}
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const screenshotPath = path.join(debugDir, `acumatica-mydocs-${stamp}.png`);
        const htmlPath = path.join(debugDir, `acumatica-mydocs-${stamp}.html`);
        const logPath = path.join(debugDir, `acumatica-debug-${stamp}.log`);
        const lines: string[] = [];
        const log = (s: string) => { lines.push(s); console.log(`[acumatica-debug] ${s}`); };

        log(`Run started ${startedAtIso}`);
        log(`Tab click attempt result: ${tabClicked ? "CLICKED" : "FAILED — used default view"}`);
        log(`Page URL: ${page.url()}`);

        // 1. Screenshot
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          log(`Screenshot saved: ${screenshotPath}`);
        } catch (e: any) {
          log(`Screenshot FAILED: ${e?.message || e}`);
        }

        // 2. Iframe HTML
        try {
          const html = await mainFrame.content();
          // Trim head + scripts to keep file readable; limit to 200KB.
          const trimmed = html
            .replace(/<script[\s\S]*?<\/script>/gi, "<script>…<\/script>")
            .slice(0, 200_000);
          fs.writeFileSync(htmlPath, trimmed, "utf-8");
          log(`Iframe HTML saved: ${htmlPath} (${trimmed.length} bytes after trim)`);
        } catch (e: any) {
          log(`Iframe HTML dump FAILED: ${e?.message || e}`);
        }

        // 3. Probe every element matching ref pattern — not just <a>.
        try {
          const probes = await mainFrame.evaluate(() => {
            const RE = /^(INV|CRT|REC|ARWO)\d+$/;
            const out: any[] = [];
            const all = document.querySelectorAll("*");
            for (let i = 0; i < all.length && out.length < 60; i++) {
              const el = all[i] as HTMLElement;
              const txt = (el.innerText || el.textContent || "").trim();
              if (!RE.test(txt)) continue;
              // Skip elements whose ref text is just inherited from a child we already captured.
              if (el.children.length > 0) {
                let allFromChild = false;
                for (const c of Array.from(el.children)) {
                  const ct = ((c as HTMLElement).innerText || c.textContent || "").trim();
                  if (ct === txt) { allFromChild = true; break; }
                }
                if (allFromChild) continue;
              }
              const rect = el.getBoundingClientRect();
              out.push({
                ref: txt,
                tag: el.tagName.toLowerCase(),
                classes: el.className && typeof el.className === "string" ? el.className : "",
                id: el.id || "",
                href: (el as HTMLAnchorElement).href || "",
                role: el.getAttribute("role") || "",
                onclick_attr: !!el.getAttribute("onclick"),
                parent_tag: el.parentElement?.tagName.toLowerCase() || "",
                parent_classes: el.parentElement && typeof el.parentElement.className === "string" ? el.parentElement.className : "",
                grandparent_tag: el.parentElement?.parentElement?.tagName.toLowerCase() || "",
                visible: rect.width > 0 && rect.height > 0,
                rect_x: Math.round(rect.x),
                rect_y: Math.round(rect.y),
                rect_w: Math.round(rect.width),
                rect_h: Math.round(rect.height),
                pointer_events: getComputedStyle(el).pointerEvents,
              });
            }
            return out;
          });
          log(`Found ${probes.length} ref-text-bearing elements:`);
          for (const p of probes) {
            log(`  ${p.ref}  <${p.tag}${p.classes ? " ." + p.classes.split(/\s+/).slice(0, 3).join(".") : ""}>` +
                `  parent=<${p.parent_tag}> grandparent=<${p.grandparent_tag}>` +
                `  visible=${p.visible} pointer-events=${p.pointer_events}` +
                `  rect=${p.rect_w}x${p.rect_h}@(${p.rect_x},${p.rect_y})` +
                `  href=${p.href ? "yes" : "no"} onclick=${p.onclick_attr}`);
          }
        } catch (e: any) {
          log(`Ref-element probe FAILED: ${e?.message || e}`);
        }

        // 4. List every tab/header label so we can fix the OPEN DOCUMENT selector.
        try {
          const labels = await mainFrame.evaluate(() => {
            const out: any[] = [];
            const sel = "a, [role=tab], [role=button], button, .tab, [class*='Tab'], [class*='tab']";
            const els = document.querySelectorAll(sel);
            for (let i = 0; i < els.length && out.length < 80; i++) {
              const el = els[i] as HTMLElement;
              const t = (el.innerText || el.textContent || "").trim();
              if (!t || t.length > 60) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 20 || r.height < 10) continue;
              out.push({
                text: t,
                tag: el.tagName.toLowerCase(),
                classes: el.className && typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 3).join(".") : "",
                role: el.getAttribute("role") || "",
              });
            }
            return out;
          });
          log(`---`);
          log(`Tabs / buttons / nav labels visible in main frame (${labels.length}):`);
          for (const l of labels) {
            log(`  "${l.text}"  <${l.tag}${l.classes ? "." + l.classes : ""}> role=${l.role || "—"}`);
          }
        } catch (e: any) {
          log(`Tab-label probe FAILED: ${e?.message || e}`);
        }

        try { fs.writeFileSync(logPath, lines.join("\n"), "utf-8"); } catch {}

        documents_seen = docRefs.length;
        const summary = `Debug capture complete. ${documents_seen} ref-bearing texts found in default view; ` +
          `OPEN DOCUMENT tab click ${tabClicked ? "succeeded" : "FAILED"}. ` +
          `Inspect the saved files to see what to match.`;
        await context.close();
        await browser.close();
        const endedAt = new Date();
        const dbgResult: AcumaticaRunResult = {
          ok: true,
          started_at: startedAtIso,
          ended_at: endedAt.toISOString(),
          duration_ms: endedAt.getTime() - startedAt.getTime(),
          documents_seen,
          documents_new: 0,
          documents_ingested: 0,
          documents_skipped: 0,
          documents_duplicate: 0,
          errors,
          debug: {
            enabled: true,
            screenshot_path: screenshotPath,
            iframe_html_path: htmlPath,
            log_path: logPath,
            summary,
          },
        };
        lastRunAt = endedAt.toISOString();
        lastRunSummary = dbgResult;
        lastRunError = null;
        runInProgress = false;
        runStartedAt = null;
        runProgressNote = null;
        return dbgResult;
      }

      // ===== 6. Process each new ref =====
      const db = getDb();
      const seenStmt = db.prepare(`SELECT doc_ref FROM acumatica_seen_docs WHERE doc_ref = ?`);
      const insertSeenStmt = db.prepare(
        `INSERT OR IGNORE INTO acumatica_seen_docs (doc_ref, first_seen_at, invoice_id) VALUES (?,?,?)`
      );

      for (const ref of docRefs) {
        if (seenStmt.get(ref)) continue;
        documents_new++;
        runProgressNote = `Processing ${ref} (${documents_new} of ${docRefs.length})`;

        // Drop any leftover queued PDFs / pending waiters so a stale capture
        // from the prior iteration can't be mis-attributed to this doc.
        clearPdfQueue();

        try {
          // Re-grab frame each iteration — iframe URL changes when we navigate.
          let f: any = page.frames().find((fr: any) => {
            try {
              return fr.name() === "main";
            } catch {
              return false;
            }
          });
          if (!f) throw new Error("main iframe gone");

          // Set up PDF capture promise BEFORE clicking
          const pdfPromise = waitForNextPdf(120000);

          // Click the reference link inside iframe.
          // CRITICAL: use force:true — Acumatica's RowNavigator <table> overlays the
          // active row and intercepts pointer events, so a normal click times out.
          // Confirmed via interactive REPL debug session 4/28/2026 against CRT016715.
          // 30s timeout because slow doc render can take ~10-15s before any DOM update.
          // If click itself fails, force-reject the pdfPromise so it doesn't dangle.
          const link = f.locator("a").filter({ hasText: new RegExp(`^${ref}$`) }).first();
          try {
            await link.click({ force: true, timeout: 30000 });
          } catch (clickErr: any) {
            // Fail-fast the pdfPromise so we don't wait the full 120s.
            clearPdfQueue(`Click failed before PDF arrived: ${clickErr.message}`);
            throw clickErr;
          }

          // Wait for the PDF response
          const { buf, filename } = await pdfPromise;
          console.log(`[acumatica] ${ref}: captured PDF (${buf.length} bytes, filename=${filename || "?"})`);

          // Run pipeline
          const r = await processInvoicePdf({
            pdfBuffer: buf,
            originalFilename: filename || `${ref}.pdf`,
            source: "acumatica:WSR",
            emailFrom: "wintersportsretailers@portal",
            emailSubject: `Acumatica doc ${ref}`,
            emailDate: new Date().toISOString(),
          });
          if (r.status === "ingested") documents_ingested++;
          else if (r.status === "duplicate_internal" || r.status === "duplicate_qbo") documents_duplicate++;
          else if (r.status === "skipped_non_invoice") documents_skipped++;

          insertSeenStmt.run(ref, new Date().toISOString(), r.invoice_id);

          // Navigate back to My Documents (ScreenID=SP402000) for next iteration.
          // The sidebar is in the outer page.
          await page.locator("text=Documents").first().click({ timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1000);
          await page.locator("text=My Documents").first().click({ timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2500);

          // Re-acquire frame and click OPEN DOCUMENT tab again
          mainFrame = await getMainFrame("My Documents");
          if (mainFrame) {
            for (const sel of tabSelectors) {
              try {
                const c = await mainFrame.locator(sel).first().count();
                if (c > 0) {
                  await mainFrame.locator(sel).first().click({ timeout: 5000 });
                  break;
                }
              } catch {}
            }
            await page.waitForTimeout(1500);
          }
        } catch (rowErr: any) {
          errors.push(`${ref}: ${rowErr.message}`);
          // Try to recover: navigate back to My Documents
          try {
            await page.locator("text=Documents").first().click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(800);
            await page.locator("text=My Documents").first().click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2000);
            mainFrame = await getMainFrame("My Documents");
            if (mainFrame) {
              for (const sel of tabSelectors) {
                const c = await mainFrame.locator(sel).first().count().catch(() => 0);
                if (c > 0) {
                  await mainFrame.locator(sel).first().click({ timeout: 5000 }).catch(() => {});
                  break;
                }
              }
            }
          } catch {}
        }
      }
      db.close();
    } finally {
      await context.close();
      await browser.close();
    }
  } catch (e: any) {
    errors.push(e.message);
  }

  const endedAt = new Date();
  const result: AcumaticaRunResult = {
    ok: errors.length === 0,
    started_at: startedAtIso,
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    documents_seen,
    documents_new,
    documents_ingested,
    documents_skipped,
    documents_duplicate,
    errors,
  };
  lastRunAt = endedAt.toISOString();
  lastRunSummary = result;
  lastRunError = errors.length > 0 ? errors.join("; ") : null;
  // Surface every error from this run (top-level + per-document) into the rolling log.
  for (const errMsg of errors) acuError("pull", errMsg);

  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO acumatica_pulls (started_at, ended_at, ok, documents_seen, documents_new, documents_ingested, documents_skipped, documents_duplicate, error) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      startedAtIso,
      endedAt.toISOString(),
      result.ok ? 1 : 0,
      documents_seen,
      documents_new,
      documents_ingested,
      documents_skipped,
      documents_duplicate,
      lastRunError
    );
    db.close();
  } catch {}

  runInProgress = false;
  runStartedAt = null;
  runProgressNote = null;
  return result;
}

/**
 * Schedule a daily pull at 2:00 AM America/New_York.
 */
export function scheduleAcumaticaDailyPull() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  const fireOnce = async () => {
    try {
      if (isAcumaticaConfigured()) {
        console.log("[acumatica] daily 2:00 AM ET pull starting");
        await runAcumaticaPullNow();
      }
    } catch (e: any) {
      console.error(`[acumatica] daily run failed: ${e.message}`);
      acuError("daily-pull", `Daily run failed: ${e.message}`);
    } finally {
      scheduleAcumaticaDailyPull();
    }
  };
  const next = nextRunAtEt(2, 0);
  const delay = next.getTime() - Date.now();
  scheduledTimer = setTimeout(fireOnce, delay);
  console.log(
    `[acumatica] next pull scheduled for ${next.toLocaleString("en-US", {
      timeZone: "America/New_York",
    })} ET (in ${Math.round(delay / 60000)} min)`
  );
}

function nextRunAtEt(hour: number, minute: number): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const curH = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  const curM = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
  const minutesUntil = ((hour - curH + 24) * 60 + (minute - curM)) % (24 * 60);
  const delayMin = minutesUntil === 0 ? 24 * 60 : minutesUntil;
  return new Date(now.getTime() + delayMin * 60 * 1000);
}
