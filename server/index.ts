import "dotenv/config";

// v8: tee console output to <cwd>/logs/app.log so the in-app log viewer in
// Settings → Logs can show recent service activity. Idempotent; safe to call
// before the rest of the startup chain logs anything.
import { initAppLogger } from "./app-logger";
initAppLogger();

// Global safety nets — prevent any background error (Playwright, fetch, etc.)
// from crashing the Express server. Always log, never exit.
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.stack || reason?.message || String(reason);
  console.error("[unhandledRejection]", msg);
});
process.on("uncaughtException", (err: any) => {
  console.error("[uncaughtException]", err?.stack || err?.message || err);
});

import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { startGmailPolling } from "./gmail";
// R4q: Gmail API parallel-run service. Gated by GMAIL_API_ENABLED env flag.
import { startGmailApiService } from "./gmail-api";
import { syncQboVendorsFromApi, getQboStatus } from "./qbo";
import { backfillVendorAliasesFromPostedInvoices, backfillLineItemsFromJson } from "./storage";
import { runAcumaticaPullNow, scheduleAcumaticaDailyPull } from "./acumatica";
import { scheduleSeasonBonusRollover } from "./season-bonus-rollover";
import { startBackupScheduler, runLocalBackupWithTracking } from "./backups";
import { startArchiveScheduler } from "./pdf-archive";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Auto-generate SESSION_SECRET if not set (write to .env for persistence)
if (!process.env.SESSION_SECRET) {
  const generated = crypto.randomBytes(32).toString("hex");
  process.env.SESSION_SECRET = generated;
  // Try to append to .env so it persists across restarts
  const envPath = path.resolve(process.cwd(), ".env");
  try {
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
    if (!existing.includes("SESSION_SECRET=")) {
      fs.appendFileSync(envPath, `\nSESSION_SECRET=${generated}\n`);
      console.log("[init] Generated SESSION_SECRET and wrote to .env");
    }
  } catch {
    // Can't write .env — just use in-memory secret
  }
}

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// v8.2: Endpoints whose responses we never want to dump into the log line.
// /api/admin/logs returns the log file itself — logging it back into the log
// creates a runaway feedback loop (each fetch doubles the file size).
// /api/backups/status is huge and uninteresting in line form.
const LOG_BODY_SUPPRESS = new Set([
  "/api/admin/logs",
  "/api/backups/status",
  "/api/error-log",
  "/api/skip-log",
  "/api/audit",
]);
const MAX_LOG_BODY_CHARS = 500;

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse && !LOG_BODY_SUPPRESS.has(path)) {
        const body = JSON.stringify(capturedJsonResponse);
        logLine += " :: " + (body.length > MAX_LOG_BODY_CHARS ? body.slice(0, MAX_LOG_BODY_CHARS) + "…[truncated]" : body);
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  // PR #209 — daily season-bonus rollover. Snapshots prior-season bonuses to
  // history on/after April 1 and clears the current_season_bonus field for the
  // new season. Idempotent so a daily check is safe.
  scheduleSeasonBonusRollover();

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: process.platform !== "win32", // reusePort not supported on Windows
    },
    () => {
      log(`serving on port ${port}`);
      // Start Gmail polling if configured (IMAP path — original)
      startGmailPolling();
      // R4q: Start Gmail API path in parallel (no-op if GMAIL_API_ENABLED!=true)
      startGmailApiService();
      // Background QBO vendor sync — once at startup (if connected) and every 24h.
      const runVendorSync = async () => {
        try {
          if (!getQboStatus().connected) return;
          const r = await syncQboVendorsFromApi();
          log(`QBO vendor sync: ${r.total} total, ${r.new} new, ${r.updated} updated, ${r.deactivated} deactivated`);
        } catch (e: any) {
          console.error(`[QBO vendor sync] failed: ${e.message}`);
        }
      };
      // Stagger startup sync 5s after listen so the rest of bootstrap finishes first.
      setTimeout(runVendorSync, 5000);
      setInterval(runVendorSync, 24 * 60 * 60 * 1000);

      // One-time alias backfill from posted invoices (idempotent — only adds new mappings).
      setTimeout(() => {
        try {
          const r = backfillVendorAliasesFromPostedInvoices();
          if (r.added > 0) log(`Vendor alias backfill: added ${r.added}, skipped ${r.skipped}`);
        } catch (e: any) {
          console.error(`[alias-backfill] failed: ${e.message}`);
        }
      }, 7000);

      // One-time line-item backfill from line_items_json (idempotent — only fills
      // invoices with empty invoice_line_items rows).
      setTimeout(() => {
        try {
          const r = backfillLineItemsFromJson();
          if (r.invoices > 0) log(`Line item backfill: populated ${r.lines} lines across ${r.invoices} invoices`);
        } catch (e: any) {
          console.error(`[line-item-backfill] failed: ${e.message}`);
        }
      }, 8000);

      // Schedule daily Acumatica pull at 2:00 AM ET (no-op if not configured).
      scheduleAcumaticaDailyPull();

      // Shopify reconciler (PR #R2):
      //  - On boot: ensure webhook subscriptions point at current public URL.
      //  - Periodic: orders polling safety net (catches anything that missed
      //    a webhook — webhook drops happen, especially during ngrok restarts).
      const runShopifyBootstrap = async () => {
        try {
          const { getShopifyReconConfig } = await import("./shopify-recon");
          if (!getShopifyReconConfig()) return; // unconfigured — silent no-op
          const { ensureShopifyWebhooks } = await import("./shopify-recon-webhooks");
          const results = await ensureShopifyWebhooks();
          const summary = results.map(r => `${r.topic}=${r.state}`).join(", ");
          log(`Shopify webhooks: ${summary}`);
        } catch (e: any) {
          console.error(`[shopify-recon] webhook bootstrap failed: ${e?.message ?? e}`);
        }
      };
      const runShopifyOrdersSync = async () => {
        try {
          const { getShopifyReconConfig } = await import("./shopify-recon");
          if (!getShopifyReconConfig()) return;
          const { syncOrdersIncremental } = await import("./shopify-recon-orders");
          const r = await syncOrdersIncremental("cron");
          if (r.error) {
            console.error(`[shopify-recon] orders sync error: ${r.error}`);
          } else {
            log(`Shopify orders sync: ${r.ordersIngested} rows (${r.inserted} new, ${r.updated} updated) across ${r.pages} pages`);
          }
        } catch (e: any) {
          console.error(`[shopify-recon] orders sync failed: ${e?.message ?? e}`);
        }

        // PR #129 — keep per-line pos_location_id attribution fresh.
        //
        // The orders sync (webhook + 6h polling) lands new sale rows with
        // pos_location_id = NULL. We backfill that column from ShopifyQL
        // immediately afterward so /api/recon/finance/by-store-pos and the
        // By-Store UI stay current.
        //
        // Window: rolling 14 days. ShopifyQL analytics has up to ~1h lag
        // landing attribution, so 14d is generous — it also catches any late
        // edits that reclassify a sale to a different register.
        //
        // Wrapped in its own try/catch: a ShopifyQL hiccup must NOT fail the
        // orders sync (orders are source of truth; pos_location_id is
        // downstream enrichment).
        try {
          const { getShopifyReconConfig } = await import("./shopify-recon");
          if (!getShopifyReconConfig()) return;
          const { ingestPosLocationsFromQL } = await import(
            "./shopify-recon-pos-locations"
          );
          const now = new Date();
          const endExclusive = new Date(now);
          endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
          const start = new Date(now);
          start.setUTCDate(start.getUTCDate() - 14);
          const fmt = (d: Date) => d.toISOString().slice(0, 10);
          const r = await ingestPosLocationsFromQL(fmt(start), fmt(endExclusive));
          log(
            `Shopify pos-locations sync: ${r.sales_updated} updated, ${r.sales_unchanged} unchanged, ${r.ql_rows_fetched} QL rows across ${r.windows_ran} windows (${r.duration_ms}ms)` +
              (r.warnings && r.warnings.length
                ? ` — ${r.warnings.length} warning(s)`
                : ""),
          );
          if (r.warnings && r.warnings.length) {
            for (const w of r.warnings) {
              console.warn(`[shopify-recon] pos-locations warning: ${w}`);
            }
          }
        } catch (e: any) {
          console.error(
            `[shopify-recon] pos-locations sync failed: ${e?.message ?? e}`,
          );
        }

        // PR #203 — keep recon_shopify_staff_sales fresh.
        //
        // ShopifyQL drives the "sales by assisting staff member" report we use
        // for commissions. Same lag/edit characteristics as pos-locations, so
        // we use the same rolling window (35 days — generous enough to cover a
        // bi-weekly pay period plus late edits / returns). Re-ingest is
        // idempotent via the composite ON CONFLICT key, so re-running every
        // 6h costs nothing on rows that haven't changed.
        //
        // Own try/catch: a ShopifyQL hiccup must NOT fail the orders sync.
        try {
          const { getShopifyReconConfig } = await import("./shopify-recon");
          if (!getShopifyReconConfig()) return;
          const { ingestStaffSales } = await import(
            "./shopify-staff-sales-ingest"
          );
          const now = new Date();
          const start = new Date(now);
          start.setUTCDate(start.getUTCDate() - 35);
          const fmt = (d: Date) => d.toISOString().slice(0, 10);
          const r = await ingestStaffSales(fmt(start), fmt(now));
          log(
            `Shopify staff-sales sync: ${r.emitted_rows ?? 0} rows upserted (${r.shopifyql_rows ?? 0} QL rows, ${r.unique_staff ?? 0} staff, ${r.unique_orders ?? 0} orders); ${r.unresolved_staff ?? 0} unresolved staff, ${r.orders_not_yet_in_db ?? 0} unallocated orders`,
          );
        } catch (e: any) {
          console.error(
            `[shopify-recon] staff-sales sync failed: ${e?.message ?? e}`,
          );
        }
      };
      // PR #R3 — payouts polling. No webhooks for payouts (Shopify doesn't offer
      // a payout webhook for app-level installs), so this poller is the only
      // path. Less frequent than orders since payouts settle ~daily.
      const runShopifyPayoutsSync = async () => {
        try {
          const { getShopifyReconConfig } = await import("./shopify-recon");
          if (!getShopifyReconConfig()) return;
          const { syncPayoutsIncremental } = await import("./shopify-recon-payouts");
          const r = await syncPayoutsIncremental("cron");
          if (r.error) {
            console.error(`[shopify-recon] payouts sync error: ${r.error}`);
          } else {
            log(`Shopify payouts sync: ${r.payoutsIngested} payouts (${r.inserted} new, ${r.updated} updated), ${r.balanceTransactionsIngested} balance txns, ${r.chargebacksDetected} chargebacks across ${r.pages} pages`);
          }
        } catch (e: any) {
          console.error(`[shopify-recon] payouts sync failed: ${e?.message ?? e}`);
        }
      };
      // Stagger — boot tasks already happen at +5/+7/+8s, run shopify at +9s
      // so it doesn't compete with QBO/alias/line-item backfills.
      setTimeout(runShopifyBootstrap, 9000);
      setTimeout(runShopifyOrdersSync, 12000);
      // Run payouts first time at +18s, then every 12h (payouts settle ~daily).
      setTimeout(runShopifyPayoutsSync, 18000);
      setInterval(runShopifyPayoutsSync, 12 * 60 * 60 * 1000);
      // Polling safety net every 6 hours (webhooks are the primary path for orders).
      setInterval(runShopifyOrdersSync, 6 * 60 * 60 * 1000);

      // PR #157 — agreements-ledger safety-net cron.
      //
      // recon_orders / recon_line_items stay current via webhooks + the 6h
      // orders sync above, but recon_shopify_sales (read by the reconcile /
      // by-store UI tabs) is ONLY populated by ingestAgreementsForOrder, which
      // today is triggered exclusively by manual hits to
      // POST /api/recon/finance/debug/agreements-ledger/backfill. So new orders
      // land but the UI looks frozen until someone kicks the backfill by hand.
      //
      // This hourly cron calls the SAME function that route uses
      // (startAgreementsBackfill, scope=missing) so the missing sale rows get
      // filled in automatically. The proper fix — wiring ingestAgreementsForOrder
      // into the webhook + orders-sync hot path — is deferred to a follow-up PR.
      //
      // Gated by AGREEMENTS_SAFETY_NET_CRON_ENABLED (default on; set to 'false'
      // to kill it without a redeploy). Non-overlapping via an in-memory flag,
      // and does NOT run on boot — first execution is the next top-of-hour tick.
      let agreementsSafetyNetRunning = false;
      const runAgreementsSafetyNet = async () => {
        if (process.env.AGREEMENTS_SAFETY_NET_CRON_ENABLED === "false") return;
        if (agreementsSafetyNetRunning) {
          console.warn("[agreements-ledger-safety-net] previous run still in progress — skipping this tick");
          return;
        }
        agreementsSafetyNetRunning = true;
        const startedAt = Date.now();
        console.log("[agreements-ledger-safety-net] start (scope=missing)");
        try {
          const { getShopifyReconConfig } = await import("./shopify-recon");
          const cfg = getShopifyReconConfig();
          if (!cfg) {
            console.log("[agreements-ledger-safety-net] Shopify reconciler not configured — skipping");
            return;
          }
          const { startAgreementsBackfill } = await import("./shopify-recon-agreements");
          const progress = startAgreementsBackfill(cfg, { kind: "missing" });
          console.log(`[agreements-ledger-safety-net] backfill job started: job_id=${progress.job_id} total_orders=${progress.total_orders}`);
        } catch (e: any) {
          console.error(`[agreements-ledger-safety-net] failed: ${e?.message ?? e}`);
        } finally {
          agreementsSafetyNetRunning = false;
          console.log(`[agreements-ledger-safety-net] end (${Date.now() - startedAt}ms)`);
        }
      };
      // Every hour at the top of the hour. No immediate boot run (intentional —
      // deploys shouldn't surprise the user; the manual backfill endpoint is
      // still available for an on-demand kick). Align the first tick to the next
      // :00 so subsequent hourly ticks land on the clock hour instead of drifting
      // off boot time.
      {
        const now = new Date();
        const msToTopOfHour =
          (60 - now.getMinutes()) * 60 * 1000 -
          now.getSeconds() * 1000 -
          now.getMilliseconds();
        setTimeout(() => {
          runAgreementsSafetyNet();
          setInterval(runAgreementsSafetyNet, 60 * 60 * 1000);
        }, msToTopOfHour);
      }

      // Start backup scheduler (hourly local, daily Drive, weekly full)
      setTimeout(() => {
        try {
          startBackupScheduler();
          startArchiveScheduler();
          // Run first local backup after 10s delay
          setTimeout(() => {
            runLocalBackupWithTracking().catch(e => console.error('[backups] Initial backup error:', e.message));
          }, 10000);
        } catch (e: any) {
          console.error('[backups] Failed to start scheduler:', e.message);
        }
      }, 5000);
    },
  );
})();
