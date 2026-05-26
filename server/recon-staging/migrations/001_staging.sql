-- ============================================================
-- recon staging harness — raw SQL migration
--
-- This is the same DDL applied by server/recon-staging/staging-db.ts
-- at module load time. Provided as a standalone .sql file so you
-- can inspect it / apply it manually to a sqlite3 CLI session if
-- you want to debug without running the Node app.
--
-- Usage from sqlite3 CLI:
--   $ sqlite3 data-staging.db
--   sqlite> .read server/recon-staging/migrations/001_staging.sql
--
-- Or from the running app via ATTACH:
--   ATTACH DATABASE 'data-staging.db' AS staging;
--   .read 001_staging.sql       -- with `staging.` prefixes already in place
--
-- All tables live in the `staging` schema (the ATTACHed db alias).
-- ============================================================

-- ============================================================
-- staging.shopify_orders
-- ============================================================
CREATE TABLE IF NOT EXISTS staging.shopify_orders (
  order_id              TEXT PRIMARY KEY,
  order_name            TEXT NOT NULL,
  legacy_resource_id    TEXT,
  created_at_utc        TEXT NOT NULL,
  processed_at_utc      TEXT,
  updated_at_utc        TEXT,
  cancelled_at_utc      TEXT,
  closed_at_utc         TEXT,
  shop_local_date       TEXT NOT NULL,
  shop_local_month      TEXT NOT NULL,
  financial_status      TEXT,
  fulfillment_status    TEXT,
  cancel_reason         TEXT,
  channel_handle        TEXT,
  channel_name          TEXT,
  pos_location_id       TEXT,
  pos_location_name     TEXT,
  currency              TEXT NOT NULL,
  original_subtotal     REAL,
  original_total_price  REAL,
  original_total_tax    REAL,
  original_total_discounts REAL,
  original_total_shipping REAL,
  current_subtotal      REAL,
  current_total_price   REAL,
  current_total_tax     REAL,
  current_total_discounts REAL,
  total_refunded        REAL,
  total_outstanding     REAL,
  has_been_edited       INTEGER NOT NULL DEFAULT 0,
  edit_count            INTEGER NOT NULL DEFAULT 0,
  raw_json              TEXT NOT NULL,
  ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
  harness_run_id        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stg_orders_month ON staging.shopify_orders (shop_local_month);
CREATE INDEX IF NOT EXISTS idx_stg_orders_name  ON staging.shopify_orders (order_name);
CREATE INDEX IF NOT EXISTS idx_stg_orders_run   ON staging.shopify_orders (harness_run_id);

-- ============================================================
-- staging.shopify_order_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS staging.shopify_order_lines (
  line_id               TEXT PRIMARY KEY,
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
  original_total        REAL NOT NULL,
  discounted_unit_price REAL NOT NULL,
  discounted_total      REAL NOT NULL,
  total_line_discount   REAL NOT NULL DEFAULT 0,
  is_gift_card          INTEGER NOT NULL DEFAULT 0,
  requires_shipping     INTEGER NOT NULL DEFAULT 1,
  current_quantity      INTEGER,
  refundable_quantity   INTEGER,
  raw_json              TEXT NOT NULL,
  ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
  harness_run_id        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stg_lines_order    ON staging.shopify_order_lines (order_id);
CREATE INDEX IF NOT EXISTS idx_stg_lines_month    ON staging.shopify_order_lines (shop_local_month);
CREATE INDEX IF NOT EXISTS idx_stg_lines_giftcard ON staging.shopify_order_lines (is_gift_card);

-- ============================================================
-- staging.shopify_order_shipping
-- ============================================================
CREATE TABLE IF NOT EXISTS staging.shopify_order_shipping (
  shipping_id           TEXT PRIMARY KEY,
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
  harness_run_id        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stg_shipping_order ON staging.shopify_order_shipping (order_id);
CREATE INDEX IF NOT EXISTS idx_stg_shipping_month ON staging.shopify_order_shipping (shop_local_month);

-- ============================================================
-- staging.shopify_order_tax_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS staging.shopify_order_tax_lines (
  tax_id                TEXT PRIMARY KEY,
  order_id              TEXT NOT NULL,
  order_name            TEXT NOT NULL,
  shop_local_date       TEXT NOT NULL,
  shop_local_month      TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  parent_id             TEXT,
  title                 TEXT,
  rate                  REAL,
  price                 REAL NOT NULL DEFAULT 0,
  raw_json              TEXT NOT NULL,
  ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
  harness_run_id        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stg_tax_order ON staging.shopify_order_tax_lines (order_id);
CREATE INDEX IF NOT EXISTS idx_stg_tax_month ON staging.shopify_order_tax_lines (shop_local_month);

-- ============================================================
-- staging.shopify_refunds
-- ============================================================
CREATE TABLE IF NOT EXISTS staging.shopify_refunds (
  refund_id             TEXT PRIMARY KEY,
  order_id              TEXT NOT NULL,
  order_name            TEXT NOT NULL,
  created_at_utc        TEXT NOT NULL,
  processed_at_utc      TEXT NOT NULL,
  shop_local_date       TEXT NOT NULL,
  shop_local_month      TEXT NOT NULL,
  note                  TEXT,
  total_refunded        REAL NOT NULL DEFAULT 0,
  total_refunded_set    REAL NOT NULL DEFAULT 0,
  raw_json              TEXT NOT NULL,
  ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
  harness_run_id        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stg_refunds_order ON staging.shopify_refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_stg_refunds_month ON staging.shopify_refunds (shop_local_month);

-- ============================================================
-- staging.shopify_refund_lines
-- ============================================================
CREATE TABLE IF NOT EXISTS staging.shopify_refund_lines (
  refund_line_id        TEXT PRIMARY KEY,
  refund_id             TEXT NOT NULL,
  order_id              TEXT NOT NULL,
  order_name            TEXT NOT NULL,
  shop_local_date       TEXT NOT NULL,
  shop_local_month      TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  line_item_id          TEXT,
  quantity              INTEGER,
  subtotal              REAL NOT NULL DEFAULT 0,
  total_tax             REAL NOT NULL DEFAULT 0,
  adjustment_kind       TEXT,
  restock_type          TEXT,
  is_gift_card          INTEGER NOT NULL DEFAULT 0,
  raw_json              TEXT NOT NULL,
  ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
  harness_run_id        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stg_refund_lines_refund ON staging.shopify_refund_lines (refund_id);
CREATE INDEX IF NOT EXISTS idx_stg_refund_lines_month  ON staging.shopify_refund_lines (shop_local_month);
CREATE INDEX IF NOT EXISTS idx_stg_refund_lines_kind   ON staging.shopify_refund_lines (kind);

-- ============================================================
-- staging.shopify_order_edits
-- ============================================================
CREATE TABLE IF NOT EXISTS staging.shopify_order_edits (
  edit_id               TEXT PRIMARY KEY,
  order_id              TEXT NOT NULL,
  order_name            TEXT NOT NULL,
  event_id              TEXT,
  created_at_utc        TEXT NOT NULL,
  shop_local_date       TEXT NOT NULL,
  shop_local_month      TEXT NOT NULL,
  message               TEXT,
  attribute_to_app      TEXT,
  attribute_to_user     TEXT,
  delta_subtotal        REAL NOT NULL DEFAULT 0,
  delta_tax             REAL NOT NULL DEFAULT 0,
  delta_total           REAL NOT NULL DEFAULT 0,
  raw_json              TEXT NOT NULL,
  ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
  harness_run_id        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stg_edits_order ON staging.shopify_order_edits (order_id);
CREATE INDEX IF NOT EXISTS idx_stg_edits_month ON staging.shopify_order_edits (shop_local_month);

-- ============================================================
-- staging.shopify_finance_events
-- ============================================================
CREATE TABLE IF NOT EXISTS staging.shopify_finance_events (
  event_key             TEXT PRIMARY KEY,
  event_type            TEXT NOT NULL,
  order_id              TEXT NOT NULL,
  order_name            TEXT NOT NULL,
  ref_id                TEXT,
  event_date_utc        TEXT NOT NULL,
  shop_local_date       TEXT NOT NULL,
  shop_local_month      TEXT NOT NULL,
  amount                REAL NOT NULL DEFAULT 0,
  tax_amount            REAL NOT NULL DEFAULT 0,
  quantity              INTEGER,
  is_gift_card          INTEGER NOT NULL DEFAULT 0,
  is_cancelled_order    INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT,
  raw_source            TEXT,
  ingested_at_utc       TEXT NOT NULL DEFAULT (datetime('now')),
  harness_run_id        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stg_events_month  ON staging.shopify_finance_events (shop_local_month);
CREATE INDEX IF NOT EXISTS idx_stg_events_type   ON staging.shopify_finance_events (event_type);
CREATE INDEX IF NOT EXISTS idx_stg_events_order  ON staging.shopify_finance_events (order_id);
CREATE INDEX IF NOT EXISTS idx_stg_events_gc     ON staging.shopify_finance_events (is_gift_card);
CREATE INDEX IF NOT EXISTS idx_stg_events_cancel ON staging.shopify_finance_events (is_cancelled_order);

-- ============================================================
-- staging.harness_runs
-- ============================================================
CREATE TABLE IF NOT EXISTS staging.harness_runs (
  harness_run_id        TEXT PRIMARY KEY,
  month                 TEXT NOT NULL,
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
