/**
 * /api/recon/staging/*  routes — recon staging harness.
 *
 * All routes use the existing snohaus_token bearer auth + payroll.view perm.
 * All staging writes go ONLY to data-staging.db (attached as `staging`).
 *
 * Routes:
 *   POST /api/recon/staging/ingest/:month        — pull Shopify orders/refunds/edits for month
 *   POST /api/recon/staging/project/:month       — re-project events from staged rows
 *   GET  /api/recon/staging/rollup/:month        — monthly Finance Summary rollup
 *   GET  /api/recon/staging/orders/:month        — per-order dump for inspection
 *   GET  /api/recon/staging/events/:month        — raw events for the month
 *   GET  /api/recon/staging/runs                 — recent harness runs
 *   POST /api/recon/staging/reset                — drop all staging rows (handy for clean rerun)
 */

import type { Express, Request, Response, NextFunction } from "express";
import { requirePermission } from "../rbac";
import { openStagingDb } from "./staging-db";
import { ingestMonth } from "./ingest";
import { projectEvents } from "./project-events";
import { rollupMonth, rollupByDay } from "./rollup";

export function registerReconStagingRoutes(
  app: Express,
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void,
): void {
  // POST /api/recon/staging/ingest/:month
  app.post(
    "/api/recon/staging/ingest/:month",
    authMiddleware,
    requirePermission("payroll.view"),
    async (req: Request, res: Response) => {
      const month = String(req.params.month || "").trim();
      const includeCancelled = req.body?.includeCancelled === true;
      try {
        const out = await ingestMonth({ month, includeCancelled });
        res.json(out);
      } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    },
  );

  // POST /api/recon/staging/project/:month
  app.post(
    "/api/recon/staging/project/:month",
    authMiddleware,
    requirePermission("payroll.view"),
    (req: Request, res: Response) => {
      const month = String(req.params.month || "").trim();
      const includeCancelled = req.body?.includeCancelled === true;
      try {
        const out = projectEvents({ month, includeCancelled });
        res.json({ ok: true, month, ...out });
      } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    },
  );

  // GET /api/recon/staging/rollup/:month
  app.get(
    "/api/recon/staging/rollup/:month",
    authMiddleware,
    requirePermission("payroll.view"),
    (req: Request, res: Response) => {
      const month = String(req.params.month || "").trim();
      const includeCancelled = req.query.includeCancelled === "1" || req.query.includeCancelled === "true";
      try {
        const summary = rollupMonth({ month, includeCancelled });
        const byDay = rollupByDay({ month, includeCancelled });
        res.json({ ok: true, summary, by_day: byDay });
      } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    },
  );

  // GET /api/recon/staging/orders/:month
  app.get(
    "/api/recon/staging/orders/:month",
    authMiddleware,
    requirePermission("payroll.view"),
    (req: Request, res: Response) => {
      const month = String(req.params.month || "").trim();
      const limit = Math.min(2000, Number(req.query.limit || 2000));
      try {
        const db = openStagingDb();
        const rows = db.prepare(`
          SELECT
            o.order_name, o.order_id,
            o.created_at_utc, o.processed_at_utc, o.updated_at_utc, o.cancelled_at_utc,
            o.financial_status, o.fulfillment_status,
            o.channel_handle, o.channel_name,
            o.pos_location_id, o.pos_location_name,
            o.shop_local_date, o.shop_local_month,
            o.original_subtotal, o.original_total_price, o.original_total_tax,
            o.original_total_discounts, o.original_total_shipping,
            o.current_subtotal, o.current_total_price, o.current_total_tax,
            o.current_total_discounts, o.total_refunded,
            o.has_been_edited, o.edit_count,
            (SELECT ROUND(SUM(l.original_total),2)
               FROM staging.shopify_order_lines l WHERE l.order_id = o.order_id) AS lines_gross,
            (SELECT ROUND(SUM(l.total_line_discount),2)
               FROM staging.shopify_order_lines l WHERE l.order_id = o.order_id) AS lines_discount,
            (SELECT ROUND(SUM(r.total_refunded),2)
               FROM staging.shopify_refunds r WHERE r.order_id = o.order_id) AS refunds_total,
            (SELECT GROUP_CONCAT(DISTINCT f.value)
               FROM staging.shopify_orders xo, json_each(json_extract(xo.raw_json, '$.fulfillments')) f
               WHERE xo.order_id = o.order_id) AS fulfillment_locations_raw
          FROM staging.shopify_orders o
          WHERE o.shop_local_month = ?
          ORDER BY o.processed_at_utc ASC
          LIMIT ?
        `).all(month, limit) as any[];
        res.json({ ok: true, month, count: rows.length, orders: rows });
      } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    },
  );

  // GET /api/recon/staging/events/:month
  app.get(
    "/api/recon/staging/events/:month",
    authMiddleware,
    requirePermission("payroll.view"),
    (req: Request, res: Response) => {
      const month = String(req.params.month || "").trim();
      const limit = Math.min(5000, Number(req.query.limit || 5000));
      try {
        const db = openStagingDb();
        const rows = db.prepare(`
          SELECT event_key, event_type, order_name, ref_id,
                 shop_local_date, shop_local_month,
                 amount, tax_amount, quantity, is_gift_card, is_cancelled_order,
                 notes
          FROM staging.shopify_finance_events
          WHERE shop_local_month = ?
          ORDER BY shop_local_date ASC, event_type ASC
          LIMIT ?
        `).all(month, limit) as any[];
        res.json({ ok: true, month, count: rows.length, events: rows });
      } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    },
  );

  // GET /api/recon/staging/runs
  app.get(
    "/api/recon/staging/runs",
    authMiddleware,
    requirePermission("payroll.view"),
    (_req: Request, res: Response) => {
      try {
        const db = openStagingDb();
        const rows = db.prepare(`
          SELECT * FROM staging.harness_runs
          ORDER BY started_at_utc DESC LIMIT 50
        `).all();
        res.json({ ok: true, runs: rows });
      } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    },
  );

  // POST /api/recon/staging/reset
  app.post(
    "/api/recon/staging/reset",
    authMiddleware,
    requirePermission("payroll.view"),
    (req: Request, res: Response) => {
      const month = req.body?.month ? String(req.body.month) : null;
      try {
        const db = openStagingDb();
        if (month) {
          if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Bad month '${month}'`);
          db.exec("BEGIN");
          db.prepare(`DELETE FROM staging.shopify_finance_events WHERE shop_local_month = ?`).run(month);
          db.prepare(`DELETE FROM staging.shopify_refund_lines WHERE shop_local_month = ?`).run(month);
          db.prepare(`DELETE FROM staging.shopify_refunds WHERE shop_local_month = ?`).run(month);
          db.prepare(`DELETE FROM staging.shopify_order_edits WHERE shop_local_month = ?`).run(month);
          db.prepare(`DELETE FROM staging.shopify_order_tax_lines WHERE shop_local_month = ?`).run(month);
          db.prepare(`DELETE FROM staging.shopify_order_shipping WHERE shop_local_month = ?`).run(month);
          db.prepare(`DELETE FROM staging.shopify_order_lines WHERE shop_local_month = ?`).run(month);
          db.prepare(`DELETE FROM staging.shopify_orders WHERE shop_local_month = ?`).run(month);
          db.exec("COMMIT");
          res.json({ ok: true, reset: "month", month });
        } else {
          db.exec("BEGIN");
          db.prepare(`DELETE FROM staging.shopify_finance_events`).run();
          db.prepare(`DELETE FROM staging.shopify_refund_lines`).run();
          db.prepare(`DELETE FROM staging.shopify_refunds`).run();
          db.prepare(`DELETE FROM staging.shopify_order_edits`).run();
          db.prepare(`DELETE FROM staging.shopify_order_tax_lines`).run();
          db.prepare(`DELETE FROM staging.shopify_order_shipping`).run();
          db.prepare(`DELETE FROM staging.shopify_order_lines`).run();
          db.prepare(`DELETE FROM staging.shopify_orders`).run();
          db.prepare(`DELETE FROM staging.harness_runs`).run();
          db.exec("COMMIT");
          res.json({ ok: true, reset: "all" });
        }
      } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
      }
    },
  );
}
