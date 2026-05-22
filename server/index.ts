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
import { syncQboVendorsFromApi, getQboStatus } from "./qbo";
import { backfillVendorAliasesFromPostedInvoices, backfillLineItemsFromJson } from "./storage";
import { runAcumaticaPullNow, scheduleAcumaticaDailyPull } from "./acumatica";
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
      // Start Gmail polling if configured
      startGmailPolling();
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
