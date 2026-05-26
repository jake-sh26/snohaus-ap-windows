/**
 * Recon Staging Harness — isolated SQLite DB connection.
 *
 * WHY: Pure read-only Shopify→staging tie-out harness. Never touches the main
 * app DB. Lives in `data-staging.db` next to `data.db`. ATTACHed under the
 * alias `staging` so every query reads/writes `staging.<table>`.
 *
 * The harness has its own connection (not the main app's `sqlite` handle).
 * That keeps schema drift, busy locks, and PRAGMA differences from leaking.
 *
 * Reset = delete `data-staging.db` on disk and call `openStagingDb()` again.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { getDbPath } from "../db-path";

let cached: Database.Database | null = null;

/**
 * Return a connection with `data-staging.db` ATTACHed as `staging`.
 *
 * Idempotent — first call creates/opens both files and runs the schema
 * bootstrap. Subsequent calls return the cached handle.
 *
 * Connection layout:
 *   - The main file passed to better-sqlite3 is an in-memory shim
 *     (we don't want the harness to ever hold a writable handle on data.db).
 *   - `staging` schema = data-staging.db, our only writable target.
 */
export function openStagingDb(): Database.Database {
  if (cached) return cached;

  const mainDbPath = getDbPath();
  const stagingPath = path.resolve(path.dirname(mainDbPath), "data-staging.db");

  // Open an :memory: handle. We never read or write its main schema —
  // we only use it as the host for ATTACH. This ensures the harness can
  // NEVER accidentally write to the real data.db.
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");
  db.pragma("synchronous = NORMAL");

  // ATTACH the real staging DB file as `staging`.
  db.prepare(`ATTACH DATABASE ? AS staging`).run(stagingPath);

  // Apply the same durability PRAGMAs to the staging file.
  // (PRAGMA targeting an ATTACHed db requires schema-qualified syntax.)
  db.pragma("staging.journal_mode = WAL");
  db.pragma("staging.synchronous = NORMAL");
  db.pragma("staging.busy_timeout = 5000");

  bootstrapStagingSchema(db);

  console.log(`[recon-staging] staging DB attached at ${stagingPath}`);
  cached = db;
  return db;
}

/**
 * Detach and close the staging DB. Primarily for tests / manual reset.
 */
export function closeStagingDb(): void {
  if (!cached) return;
  try { cached.exec("DETACH DATABASE staging"); } catch { /* ignore */ }
  try { cached.close(); } catch { /* ignore */ }
  cached = null;
}

/**
 * Create all `staging.*` tables if missing. Idempotent.
 *
 * Schema is intentionally hand-written CREATE TABLE rather than going through
 * Drizzle ORM — Drizzle's SQLite dialect doesn't model ATTACHed schemas, so
 * we keep parity between this file and `shared/staging-schema.ts` (the
 * Drizzle definitions, exposed only for typed reads).
 */
function bootstrapStagingSchema(db: Database.Database): void {
  db.exec(`
    -- ============================================================
    -- staging.shopify_orders
    --   One row per Shopify order (regardless of status).
    --   Includes both ORIGINAL and CURRENT totals — Shopify mutates
    --   current_* after returns/edits/cancellations.
    --   Raw GraphQL payload kept in raw_json for audit.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staging.shopify_orders (
      order_id              TEXT PRIMARY KEY,    -- Shopify GID, e.g. gid://shopify/Order/123
      order_name            TEXT NOT NULL,       -- '#21707' with leading #
      legacy_resource_id    TEXT,                -- numeric REST ID, useful for cross-ref
      created_at_utc        TEXT NOT NULL,       -- order.createdAt (ISO UTC)
      processed_at_utc      TEXT,                -- order.processedAt (sale recognition)
      updated_at_utc        TEXT,
      cancelled_at_utc      TEXT,
      closed_at_utc         TEXT,
      shop_local_date       TEXT NOT NULL,       -- YYYY-MM-DD in shop.ianaTimezone, derived from processed_at_utc
      shop_local_month      TEXT NOT NULL,       -- YYYY-MM
      financial_status      TEXT,                -- 'paid','refunded','partially_refunded','voided', etc
      fulfillment_status    TEXT,
      cancel_reason         TEXT,
      channel_handle        TEXT,                -- 'online_store' | 'pos' | etc
      channel_name          TEXT,
      pos_location_id       TEXT,                -- order.physicalLocation.id (POS only)
      pos_location_name     TEXT,
      currency              TEXT NOT NULL,
      -- ORIGINAL totals (set at order creation; do not mutate after edits)
      original_subtotal     REAL,
      original_total_price  REAL,
      original_total_tax    REAL,
      original_total_discounts REAL,
      original_total_shipping REAL,
      -- CURRENT totals (Shopify recomputes after returns/edits)
      current_subtotal      REAL,
      current_total_price   REAL,
      current_total_tax     REAL,
      current_total_discounts REAL,
      total_refunded        REAL,
      total_outstanding     REAL,
      -- Edit/exchange flags
      has_been_edited       INTEGER NOT NULL DEFAULT 0,   -- 1 if order.events surfaced an edit
      edit_count            INTEGER NOT NULL DEFAULT 0,
      raw_json              TEXT NOT NULL,       -- full GraphQL node payload
      ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
      harness_run_id        TEXT NOT NULL        -- groups rows from one ingest run
    );
    CREATE INDEX IF NOT EXISTS idx_stg_orders_month
      ON staging.shopify_orders (shop_local_month);
    CREATE INDEX IF NOT EXISTS idx_stg_orders_name
      ON staging.shopify_orders (order_name);
    CREATE INDEX IF NOT EXISTS idx_stg_orders_run
      ON staging.shopify_orders (harness_run_id);

    -- ============================================================
    -- staging.shopify_order_lines
    --   One row per line item on each order.
    --   is_gift_card flagged from lineItem.giftCard or productType.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staging.shopify_order_lines (
      line_id               TEXT PRIMARY KEY,    -- gid://shopify/LineItem/...
      order_id              TEXT NOT NULL,
      order_name            TEXT NOT NULL,
      shop_local_date       TEXT NOT NULL,
      shop_local_month      TEXT NOT NULL,
      line_index            INTEGER NOT NULL,
      sku                   TEXT,
      title                 TEXT,
      variant_id            TEXT,
      product_id            TEXT,
      product_type          TEXT,
      vendor                TEXT,
      quantity              INTEGER NOT NULL,
      original_unit_price   REAL NOT NULL,
      original_total        REAL NOT NULL,       -- qty * original_unit_price (gross)
      discounted_unit_price REAL NOT NULL,
      discounted_total      REAL NOT NULL,       -- after line-level discounts, pre-tax
      total_line_discount   REAL NOT NULL DEFAULT 0,
      is_gift_card          INTEGER NOT NULL DEFAULT 0,
      requires_shipping     INTEGER NOT NULL DEFAULT 1,
      -- Quantity not yet returned (for refund math)
      current_quantity      INTEGER,
      refundable_quantity   INTEGER,
      raw_json              TEXT NOT NULL,
      ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
      harness_run_id        TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES staging.shopify_orders(order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_stg_lines_order
      ON staging.shopify_order_lines (order_id);
    CREATE INDEX IF NOT EXISTS idx_stg_lines_month
      ON staging.shopify_order_lines (shop_local_month);
    CREATE INDEX IF NOT EXISTS idx_stg_lines_giftcard
      ON staging.shopify_order_lines (is_gift_card);

    -- ============================================================
    -- staging.shopify_order_shipping
    --   Per-line shipping charges from order.shippingLines.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staging.shopify_order_shipping (
      shipping_id           TEXT PRIMARY KEY,    -- synthesized: order_id + idx
      order_id              TEXT NOT NULL,
      order_name            TEXT NOT NULL,
      shop_local_date       TEXT NOT NULL,
      shop_local_month      TEXT NOT NULL,
      title                 TEXT,
      code                  TEXT,
      original_price        REAL NOT NULL DEFAULT 0,
      discounted_price      REAL NOT NULL DEFAULT 0,
      raw_json              TEXT NOT NULL,
      ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
      harness_run_id        TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES staging.shopify_orders(order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_stg_shipping_order
      ON staging.shopify_order_shipping (order_id);
    CREATE INDEX IF NOT EXISTS idx_stg_shipping_month
      ON staging.shopify_order_shipping (shop_local_month);

    -- ============================================================
    -- staging.shopify_order_tax_lines
    --   Per-line tax rows from lineItem.taxLines and shippingLine.taxLines
    --   plus order-level. scope distinguishes the source.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staging.shopify_order_tax_lines (
      tax_id                TEXT PRIMARY KEY,    -- synthesized
      order_id              TEXT NOT NULL,
      order_name            TEXT NOT NULL,
      shop_local_date       TEXT NOT NULL,
      shop_local_month      TEXT NOT NULL,
      scope                 TEXT NOT NULL,       -- 'line' | 'shipping' | 'order'
      parent_id             TEXT,                -- line_id or shipping_id when applicable
      title                 TEXT,
      rate                  REAL,
      price                 REAL NOT NULL DEFAULT 0,
      raw_json              TEXT NOT NULL,
      ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
      harness_run_id        TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES staging.shopify_orders(order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_stg_tax_order
      ON staging.shopify_order_tax_lines (order_id);
    CREATE INDEX IF NOT EXISTS idx_stg_tax_month
      ON staging.shopify_order_tax_lines (shop_local_month);

    -- ============================================================
    -- staging.shopify_refunds
    --   One row per Shopify refund event. Dated by refund.processedAt
    --   in shop-local time → refunds in later months naturally bucket
    --   into the later month.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staging.shopify_refunds (
      refund_id             TEXT PRIMARY KEY,    -- gid://shopify/Refund/...
      order_id              TEXT NOT NULL,
      order_name            TEXT NOT NULL,
      created_at_utc        TEXT NOT NULL,
      processed_at_utc      TEXT NOT NULL,
      shop_local_date       TEXT NOT NULL,       -- refund's own date, NOT order date
      shop_local_month      TEXT NOT NULL,
      note                  TEXT,
      total_refunded        REAL NOT NULL DEFAULT 0,   -- transactions sum
      total_refunded_set    REAL NOT NULL DEFAULT 0,
      raw_json              TEXT NOT NULL,
      ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
      harness_run_id        TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES staging.shopify_orders(order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_stg_refunds_order
      ON staging.shopify_refunds (order_id);
    CREATE INDEX IF NOT EXISTS idx_stg_refunds_month
      ON staging.shopify_refunds (shop_local_month);

    -- ============================================================
    -- staging.shopify_refund_lines
    --   Per-line breakdown of each refund. Includes refunded line items
    --   AND refund order adjustments (return fees, shipping refunds).
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staging.shopify_refund_lines (
      refund_line_id        TEXT PRIMARY KEY,    -- gid or synthesized
      refund_id             TEXT NOT NULL,
      order_id              TEXT NOT NULL,
      order_name            TEXT NOT NULL,
      shop_local_date       TEXT NOT NULL,       -- inherited from parent refund
      shop_local_month      TEXT NOT NULL,
      kind                  TEXT NOT NULL,       -- 'line_item' | 'shipping_refund' | 'order_adjustment' | 'tax_refund'
      line_item_id          TEXT,                -- when kind='line_item'
      quantity              INTEGER,
      subtotal              REAL NOT NULL DEFAULT 0,
      total_tax             REAL NOT NULL DEFAULT 0,
      adjustment_kind       TEXT,                -- 'refund_discrepancy' | 'shipping_refund' | 'restock_fee'
      restock_type          TEXT,
      is_gift_card          INTEGER NOT NULL DEFAULT 0,
      raw_json              TEXT NOT NULL,
      ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
      harness_run_id        TEXT NOT NULL,
      FOREIGN KEY (refund_id) REFERENCES staging.shopify_refunds(refund_id)
    );
    CREATE INDEX IF NOT EXISTS idx_stg_refund_lines_refund
      ON staging.shopify_refund_lines (refund_id);
    CREATE INDEX IF NOT EXISTS idx_stg_refund_lines_month
      ON staging.shopify_refund_lines (shop_local_month);
    CREATE INDEX IF NOT EXISTS idx_stg_refund_lines_kind
      ON staging.shopify_refund_lines (kind);

    -- ============================================================
    -- staging.shopify_order_edits
    --   Order-edit events from order.events (filtered to edit/exchange).
    --   Dated by the EDIT timestamp, not the order timestamp.
    --   Each edit becomes one or more delta events downstream.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staging.shopify_order_edits (
      edit_id               TEXT PRIMARY KEY,    -- synthesized order_id+event_id
      order_id              TEXT NOT NULL,
      order_name            TEXT NOT NULL,
      event_id              TEXT,                -- order.events node id
      created_at_utc        TEXT NOT NULL,       -- when the edit happened
      shop_local_date       TEXT NOT NULL,
      shop_local_month      TEXT NOT NULL,
      message               TEXT,                -- human-readable: "Edited the order"
      attribute_to_app      TEXT,
      attribute_to_user     TEXT,
      delta_subtotal        REAL NOT NULL DEFAULT 0,   -- computed from current vs prev snapshot
      delta_tax             REAL NOT NULL DEFAULT 0,
      delta_total           REAL NOT NULL DEFAULT 0,
      raw_json              TEXT NOT NULL,
      ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
      harness_run_id        TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES staging.shopify_orders(order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_stg_edits_order
      ON staging.shopify_order_edits (order_id);
    CREATE INDEX IF NOT EXISTS idx_stg_edits_month
      ON staging.shopify_order_edits (shop_local_month);

    -- ============================================================
    -- staging.shopify_finance_events
    --   The economic ledger. One row per economic event, dated by the
    --   event's OWN transaction date.
    --
    --   event_type:
    --     sale_line              - line item sold (date = order.processedAt)
    --     discount_line          - line-level discount (date = order.processedAt)
    --     order_discount         - order-level discount (date = order.processedAt)
    --     return_line            - refund of a line item (date = refund.processedAt)
    --     shipping_sale          - shipping charged on the order (date = order.processedAt)
    --     shipping_refund        - shipping refunded (date = refund.processedAt)
    --     tax_sale               - tax charged on a sale (date = order.processedAt)
    --     tax_refund             - tax refunded (date = refund.processedAt)
    --     gift_card_sale         - line of type gift card (date = order.processedAt)
    --     order_edit_adjustment  - delta from an order edit (date = edit.createdAt)
    --     refund_adjustment      - return fee / restock fee on a refund (date = refund.processedAt)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staging.shopify_finance_events (
      event_key             TEXT PRIMARY KEY,    -- deterministic; prevents dup on rerun
      event_type            TEXT NOT NULL,
      order_id              TEXT NOT NULL,
      order_name            TEXT NOT NULL,
      ref_id                TEXT,                -- line_id | refund_id | refund_line_id | edit_id
      event_date_utc        TEXT NOT NULL,
      shop_local_date       TEXT NOT NULL,
      shop_local_month      TEXT NOT NULL,
      amount                REAL NOT NULL DEFAULT 0,   -- signed: sales positive, returns/discounts negative
      tax_amount            REAL NOT NULL DEFAULT 0,
      quantity              INTEGER,
      is_gift_card          INTEGER NOT NULL DEFAULT 0,
      is_cancelled_order    INTEGER NOT NULL DEFAULT 0,   -- visibility flag, not auto-filtered
      notes                 TEXT,
      raw_source            TEXT,                -- JSON: which staging row(s) produced this
      ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
      harness_run_id        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stg_events_month
      ON staging.shopify_finance_events (shop_local_month);
    CREATE INDEX IF NOT EXISTS idx_stg_events_type
      ON staging.shopify_finance_events (event_type);
    CREATE INDEX IF NOT EXISTS idx_stg_events_order
      ON staging.shopify_finance_events (order_id);
    CREATE INDEX IF NOT EXISTS idx_stg_events_gc
      ON staging.shopify_finance_events (is_gift_card);
    CREATE INDEX IF NOT EXISTS idx_stg_events_cancel
      ON staging.shopify_finance_events (is_cancelled_order);

    -- ============================================================
    -- staging.harness_runs
    --   Audit trail of each ingest invocation.
    -- ============================================================
    CREATE TABLE IF NOT EXISTS staging.harness_runs (
      harness_run_id        TEXT PRIMARY KEY,
      month                 TEXT NOT NULL,             -- YYYY-MM (shop-local)
      shop_tz               TEXT NOT NULL,
      started_at_utc        TEXT NOT NULL,
      finished_at_utc       TEXT,
      ok                    INTEGER NOT NULL DEFAULT 0,
      orders_pulled         INTEGER NOT NULL DEFAULT 0,
      refunds_pulled        INTEGER NOT NULL DEFAULT 0,
      lines_pulled          INTEGER NOT NULL DEFAULT 0,
      edits_pulled          INTEGER NOT NULL DEFAULT 0,
      events_projected      INTEGER NOT NULL DEFAULT 0,
      error_text            TEXT,
      params_json           TEXT NOT NULL
    );
  `);
}
