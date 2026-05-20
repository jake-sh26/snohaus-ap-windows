import {
  invoices,
  invoiceLineItems,
  vendorRules,
  vendorAliases,
  sessions,
  magicCodes,
  auditLog,
  INITIAL_ENTITIES,
  PERMISSION_CATALOG,
  SYSTEM_ROLES,
  type Invoice,
  type InvoiceLineItem,
  type VendorRule,
  type VendorAlias,
  type Session,
  // Reconciler (PR #R1)
  type ReconSettings,
  type ReconEntityPosLocation,
  type ReconAllocationMethod,
  type ReconGcAllocationPolicy,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and, desc, gte, lte, like, or } from "drizzle-orm";
import seedData from "./data/seed_data.json" with { type: "json" };
import qboVendorsData from "./data/qbo_vendors.json" with { type: "json" };

export const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite);

// Bootstrap tables (since we don't run drizzle-kit push at runtime).
function bootstrapSchema() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      source_file TEXT,
      email_id TEXT,
      email_date TEXT,
      email_from TEXT,
      email_subject TEXT,
      pdf_url TEXT,
      vendor_qbo_id TEXT,
      vendor_qbo_name TEXT,
      vendor_match_status TEXT,
      vendor_raw_name TEXT,
      invoice_number TEXT,
      invoice_date TEXT,
      due_date TEXT,
      total REAL,
      freight REAL,
      is_credit INTEGER DEFAULT 0,
      ship_to_store TEXT,
      parse_confidence TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending_review',
      routing_mode TEXT NOT NULL DEFAULT 'single_store',
      routing_data TEXT,
      duplicate_check_status TEXT DEFAULT 'unchecked',
      duplicate_check_at TEXT,
      qbo_bill_id TEXT,
      approved_by TEXT,
      approved_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      sku TEXT,
      description TEXT,
      qty REAL,
      unit_price REAL,
      amount REAL,
      store_assignment TEXT,
      is_freight INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vendor_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_qbo_id TEXT,
      vendor_name TEXT,
      rule_type TEXT,
      default_store TEXT,
      split_data TEXT,
      note TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS vendor_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias TEXT,
      alias_lower TEXT,
      vendor_qbo_id TEXT,
      vendor_name TEXT,
      note TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS magic_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT,
      action TEXT,
      before TEXT,
      after TEXT,
      user_email TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS invoice_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      user_email TEXT,
      text TEXT NOT NULL,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_notes_invoice ON invoice_notes(invoice_id);
    CREATE TABLE IF NOT EXISTS qbo_vendors_cache (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      company_name TEXT,
      active INTEGER DEFAULT 1,
      last_seen_at TEXT,
      inactive_at TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_qbo_vendors_cache_name_lower ON qbo_vendors_cache(LOWER(display_name));

    -- ===== Skipped Uploads (Round 7) =====
    -- Files the LLM classified as non-invoices (sales orders, statements,
    -- autopay utilities, $0 warranty replacements, etc). Previously we just
    -- deleted the PDF. Now we keep it so Jake can review/restore mistakes.
    CREATE TABLE IF NOT EXISTS skipped_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pdf_url TEXT,                       -- relative filename in private_assets/
      original_filename TEXT,
      source TEXT,                        -- 'manual-upload' | 'gmail' | 'acumatica'
      email_id TEXT,
      email_from TEXT,
      email_subject TEXT,
      email_date TEXT,
      llm_document_type TEXT,             -- e.g. 'sales_order', 'statement', 'autopay'
      llm_skip_reason TEXT,               -- e.g. 'Autopay vendor — not posted to AP queue'
      llm_notes TEXT,
      llm_vendor_raw_name TEXT,           -- whatever the LLM did parse (best effort)
      llm_total REAL,
      llm_invoice_number TEXT,
      restored_invoice_id TEXT,           -- set if user restored it; never deleted in that case
      restored_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skipped_uploads_created ON skipped_uploads(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skipped_uploads_active ON skipped_uploads(restored_invoice_id) WHERE restored_invoice_id IS NULL;

    -- ===== Skip Senders (Round 6) =====
    -- Subscription/recurring invoices that should be silently skipped at intake.
    -- Added by user via drawer "Skip this sender going forward" or Settings UI.
    CREATE TABLE IF NOT EXISTS skip_senders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type TEXT NOT NULL CHECK(match_type IN ('email','domain')),
      match_value TEXT NOT NULL,            -- billing@adobe.com OR adobe.com (lowercase)
      vendor_name TEXT,                     -- display only
      added_at TEXT NOT NULL,
      added_by TEXT,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      last_skipped_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skip_senders_unique ON skip_senders(match_type, LOWER(match_value));

    CREATE TABLE IF NOT EXISTS skip_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skipped_at TEXT NOT NULL,
      source TEXT NOT NULL,                 -- gmail, acumatica, manual-upload
      sender_email TEXT,
      subject TEXT,
      matched_rule_id INTEGER REFERENCES skip_senders(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skip_log_skipped_at ON skip_log(skipped_at DESC);
  `);

  // ===== New tables for combined patch (additive migrations) =====

  // app_users table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      enabled INTEGER NOT NULL DEFAULT 1,
      password_salt TEXT,
      password_hash TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
  `);

  // google_oauth table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS google_oauth (
      purpose TEXT PRIMARY KEY,
      encrypted_tokens TEXT NOT NULL,
      granted_email TEXT,
      granted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // backup_runs table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS backup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      file_path TEXT,
      file_size_bytes INTEGER,
      drive_file_id TEXT,
      error TEXT
    );
  `);

  // config table (key/value store for misc config like drive folder ID)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // additive column: invoices.archived_at
  try {
    sqlite.exec(`ALTER TABLE invoices ADD COLUMN archived_at TEXT`);
  } catch {
    // column already exists — ignore
  }

  // additive column: invoices.pdf_path (may already exist or not)
  try {
    sqlite.exec(`ALTER TABLE invoices ADD COLUMN pdf_path TEXT`);
  } catch {
    // already exists
  }

  // additive column: invoices.source_type — marks the ingest source so the UI
  // can show a yellow OCR-warning banner for image-sourced invoices.
  // Values: null (legacy), 'pdf', 'image_ocr', 'gmail', 'acumatica'.
  try {
    sqlite.exec(`ALTER TABLE invoices ADD COLUMN source_type TEXT`);
  } catch {
    // already exists
  }

  // additive column: invoices.fuzzy_dup_hint — JSON describing a low-confidence
  // fuzzy duplicate match (60–89%). Surfaced in the drawer so Jake can review.
  try {
    sqlite.exec(`ALTER TABLE invoices ADD COLUMN fuzzy_dup_hint TEXT`);
  } catch {
    // already exists
  }

  // v8.4.5: discount-terms columns. Detected at parse-time, applied only if the
  // user explicitly toggles "take discount" in the drawer before posting to QBO.
  //   discount_terms_pct   — e.g. 2.0 for "2% 10 Net 30"
  //   discount_days        — days from invoice_date until the discount window closes
  //   discount_due_date    — YYYY-MM-DD when the discount expires (invoice + discount_days)
  //   discount_kind        — 'early_pay' | 'net_with_discount' | null
  //   discount_warning     — non-null when parser is unsure; surfaces a chip
  //   discount_applied     — 0/1; user chose to take the discount. For
  //                          net_with_discount kind this defaults to 1 (auto),
  //                          for early_pay kind it defaults to 0 (must opt in).
  const discountCols: Array<[string, string]> = [
    ["discount_terms_pct", "REAL"],
    ["discount_days", "INTEGER"],
    ["discount_due_date", "TEXT"],
    ["discount_kind", "TEXT"],
    ["discount_warning", "TEXT"],
    ["discount_applied", "INTEGER DEFAULT 0"],
  ];
  for (const [name, type] of discountCols) {
    try {
      sqlite.exec(`ALTER TABLE invoices ADD COLUMN ${name} ${type}`);
    } catch {
      // already exists
    }
  }

  // ============================================================================
  // PAYROLL MODULE TABLES (PR #6)
  // ----------------------------------------------------------------------------
  // All idempotent (CREATE TABLE IF NOT EXISTS). Drizzle definitions live in
  // shared/schema.ts — keep these two in sync.
  // ============================================================================

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location TEXT NOT NULL,
      legal_name TEXT NOT NULL,
      cadence TEXT NOT NULL,
      adp_company_code TEXT,
      commissions_enabled INTEGER NOT NULL DEFAULT 0,
      pms_enabled INTEGER NOT NULL DEFAULT 0,
      tips_enabled INTEGER NOT NULL DEFAULT 0,
      easyrent_enabled INTEGER NOT NULL DEFAULT 0,
      spif_enabled INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_entities_location ON payroll_entities(location);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      full_name TEXT NOT NULL,
      email TEXT,
      shopify_staff_member_id TEXT,
      easyrent_clerk_guid TEXT,
      ltm_clerk_id TEXT,
      adp_employee_id TEXT,
      commission_rate_pct REAL,
      active INTEGER NOT NULL DEFAULT 1,
      hired_at TEXT,
      terminated_at TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_employees_entity ON payroll_employees(entity_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_employees_shopify ON payroll_employees(shopify_staff_member_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_employees_easyrent ON payroll_employees(easyrent_clerk_guid);
    CREATE INDEX IF NOT EXISTS idx_payroll_employees_ltm ON payroll_employees(ltm_clerk_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_pay_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      kind TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      exported_at TEXT,
      exported_by TEXT,
      notes TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_pay_periods_entity ON payroll_pay_periods(entity_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_pay_periods_unique
      ON payroll_pay_periods(entity_id, kind, period_start);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_pos_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      shopify_location_id TEXT NOT NULL,
      label TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_pos_locations_shopify
      ON payroll_pos_locations(shopify_location_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_ltm_merchants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      merchant_id TEXT NOT NULL,
      client_guid TEXT,
      label TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_ltm_merchants_merchant
      ON payroll_ltm_merchants(merchant_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_entity_processing_fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      fee_kind TEXT NOT NULL DEFAULT 'tip_cc_fee',
      fee_pct REAL NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      note TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_entity_processing_fees_entity
      ON payroll_entity_processing_fees(entity_id, fee_kind, effective_from);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_shopify_staff_weekly_totals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      pay_period_id INTEGER NOT NULL REFERENCES payroll_pay_periods(id),
      employee_id INTEGER REFERENCES payroll_employees(id),
      shopify_staff_member_id TEXT NOT NULL,
      raw_staff_name TEXT,
      net_sales REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'shopify_ql',
      ingested_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_shopify_staff_period
      ON payroll_shopify_staff_weekly_totals(pay_period_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_shopify_staff_unique
      ON payroll_shopify_staff_weekly_totals(pay_period_id, shopify_staff_member_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_easyrent_staff_weekly_totals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      pay_period_id INTEGER NOT NULL REFERENCES payroll_pay_periods(id),
      employee_id INTEGER REFERENCES payroll_employees(id),
      easyrent_clerk_guid TEXT NOT NULL,
      raw_clerk_name TEXT,
      net_sales REAL NOT NULL DEFAULT 0,
      ingested_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_easyrent_staff_period
      ON payroll_easyrent_staff_weekly_totals(pay_period_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_easyrent_staff_unique
      ON payroll_easyrent_staff_weekly_totals(pay_period_id, easyrent_clerk_guid);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_easyrent_pms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      pay_period_id INTEGER NOT NULL REFERENCES payroll_pay_periods(id),
      employee_id INTEGER REFERENCES payroll_employees(id),
      easyrent_clerk_guid TEXT,
      transaction_date TEXT,
      easyrent_transaction_id TEXT,
      pm_code TEXT,
      pm_label TEXT,
      amount REAL NOT NULL DEFAULT 0,
      ingested_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_easyrent_pms_period
      ON payroll_easyrent_pms(pay_period_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_easyrent_pms_txn
      ON payroll_easyrent_pms(easyrent_transaction_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_ltm_tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      pay_period_id INTEGER NOT NULL REFERENCES payroll_pay_periods(id),
      employee_id INTEGER REFERENCES payroll_employees(id),
      ltm_clerk_id TEXT,
      raw_clerk_name TEXT,
      transaction_date TEXT,
      shift4_invoice TEXT,
      gross_tip REAL NOT NULL DEFAULT 0,
      fee_pct REAL NOT NULL DEFAULT 0,
      fee_amount REAL NOT NULL DEFAULT 0,
      net_tip REAL NOT NULL DEFAULT 0,
      ingested_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_ltm_tips_period
      ON payroll_ltm_tips(pay_period_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_ltm_tips_shift4_invoice
      ON payroll_ltm_tips(shift4_invoice)
      WHERE shift4_invoice IS NOT NULL;
  `);

  // NOTE: payroll_spif_rules is created BEFORE payroll_shopify_line_items_spif
  // because the latter has a FK referencing it.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_spif_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      match_kind TEXT NOT NULL,
      match_value TEXT NOT NULL,
      label TEXT,
      amount_per_unit REAL NOT NULL,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_spif_rules_entity
      ON payroll_spif_rules(entity_id, active);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_shopify_line_items_spif (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      pay_period_id INTEGER NOT NULL REFERENCES payroll_pay_periods(id),
      employee_id INTEGER REFERENCES payroll_employees(id),
      shopify_staff_member_id TEXT,
      shopify_order_id TEXT,
      shopify_line_item_id TEXT,
      order_date TEXT,
      sku TEXT,
      product_title TEXT,
      quantity REAL NOT NULL DEFAULT 0,
      unit_price REAL,
      matched_spif_rule_id INTEGER REFERENCES payroll_spif_rules(id) ON DELETE SET NULL,
      ingested_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_shopify_spif_period
      ON payroll_shopify_line_items_spif(pay_period_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_shopify_spif_unique
      ON payroll_shopify_line_items_spif(shopify_line_item_id)
      WHERE shopify_line_item_id IS NOT NULL;
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_commission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      kind TEXT NOT NULL DEFAULT 'flat_pct',
      default_rate_pct REAL,
      config_json TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_commission_rules_entity
      ON payroll_commission_rules(entity_id, active);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      pay_period_id INTEGER NOT NULL REFERENCES payroll_pay_periods(id),
      employee_id INTEGER NOT NULL REFERENCES payroll_employees(id),
      kind TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      description TEXT,
      computation_json TEXT,
      source_table TEXT,
      source_row_id INTEGER,
      exported_at TEXT,
      exported_run_id TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_lines_period ON payroll_lines(pay_period_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_lines_emp_period
      ON payroll_lines(employee_id, pay_period_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_lines_kind ON payroll_lines(kind);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      pay_period_id INTEGER NOT NULL REFERENCES payroll_pay_periods(id),
      employee_id INTEGER NOT NULL REFERENCES payroll_employees(id),
      target_payroll_line_id INTEGER REFERENCES payroll_lines(id) ON DELETE SET NULL,
      adjustment_amount REAL NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_overrides_period
      ON payroll_overrides(pay_period_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS payroll_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      entity_id INTEGER,
      pay_period_id INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      rows_ingested INTEGER DEFAULT 0,
      error_message TEXT,
      triggered_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_sync_log_kind_started
      ON payroll_sync_log(kind, started_at DESC);
  `);

  // ----- Unmatched attributions VIEW -----
  // Surfaces every ingest row where employee_id IS NULL. The UI in PR #10
  // shows this list so the user can map the raw clerk name/ID to an employee.
  sqlite.exec(`
    CREATE VIEW IF NOT EXISTS payroll_unmatched_attributions AS
      SELECT
        'shopify_staff_totals' AS source_kind,
        id AS source_row_id,
        entity_id,
        pay_period_id,
        shopify_staff_member_id AS external_id,
        raw_staff_name AS raw_name,
        net_sales AS amount,
        ingested_at
      FROM payroll_shopify_staff_weekly_totals
      WHERE employee_id IS NULL
      UNION ALL
      SELECT
        'easyrent_staff_totals',
        id,
        entity_id,
        pay_period_id,
        easyrent_clerk_guid,
        raw_clerk_name,
        net_sales,
        ingested_at
      FROM payroll_easyrent_staff_weekly_totals
      WHERE employee_id IS NULL
      UNION ALL
      SELECT
        'easyrent_pms',
        id,
        entity_id,
        pay_period_id,
        easyrent_clerk_guid,
        NULL,
        amount,
        ingested_at
      FROM payroll_easyrent_pms
      WHERE employee_id IS NULL
      UNION ALL
      SELECT
        'ltm_tips',
        id,
        entity_id,
        pay_period_id,
        ltm_clerk_id,
        raw_clerk_name,
        net_tip,
        ingested_at
      FROM payroll_ltm_tips
      WHERE employee_id IS NULL
      UNION ALL
      SELECT
        'shopify_line_items_spif',
        id,
        entity_id,
        pay_period_id,
        shopify_staff_member_id,
        product_title,
        COALESCE(quantity * unit_price, 0),
        ingested_at
      FROM payroll_shopify_line_items_spif
      WHERE employee_id IS NULL;
  `);

  // ============================================================================
  // SHOPIFY RECONCILER TABLES (PR #R1)
  // ----------------------------------------------------------------------------
  // Phase 1 — READ ONLY ingest + allocation + monthly rollup. Test alongside
  // Excel before any QBO writes. Phase 2 (PR #R6+) adds per-entity QBO posting.
  //
  // Naming: every table is prefixed `recon_` so it can never collide with the
  // existing `payroll_` family even if Shopify concepts overlap (e.g. a single
  // Shopify order is referenced from both modules independently).
  //
  // Foreign-key story: most tables reference `payroll_entities(id)` because the
  // 3 legal entities (Greenvale / Huntington / Hempstead) are the same in both
  // modules. We deliberately do NOT introduce a second "entity" table.
  // ============================================================================

  // Single-row settings table for reconciler-wide policy. Use a fixed PK so we
  // can always upsert via INSERT OR REPLACE WHERE id=1.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      -- 'zip_then_pro_rata' is the v1 default: buyer zip -> nearest entity,
      -- fall back to the frozen prior-year pro-rata snapshot.
      default_digital_gc_allocation_policy TEXT NOT NULL DEFAULT 'zip_then_pro_rata',
      -- Year the frozen pro-rata snapshot was computed from. Null until first
      -- prior-year freeze runs. UI shows this so the user knows when to refresh.
      prior_year_pro_rata_year INTEGER,
      -- ISO timestamp of when the snapshot was frozen.
      prior_year_pro_rata_frozen_at TEXT,
      -- Shopify shop domain (e.g. 'snohaus.myshopify.com'). Cached for display.
      shopify_shop_domain TEXT,
      -- Initial sync depth boundary. Defaults to 2025-01-01 per locked design.
      initial_sync_from TEXT NOT NULL DEFAULT '2025-01-01',
      -- Bank account that receives Shopify payouts (for Plaid matching).
      -- Stored as Plaid account_id; null until user picks one in settings UI.
      payout_bank_plaid_account_id TEXT,
      updated_at TEXT,
      updated_by TEXT
    );
  `);

  // Maps Shopify physical/POS locations to our legal entities. One row per
  // Shopify location_id. Seeded with the 3 known stores; the user will edit
  // location_id once it is read from Shopify.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_entity_pos_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id) ON DELETE CASCADE,
      -- Shopify Admin API location id, e.g. '68042948819'. Nullable until the
      -- user maps it after first sync.
      shopify_location_id TEXT,
      shopify_location_name TEXT,
      -- 'pos' for in-store POS, 'fulfillment' for online order fulfillment.
      -- Defaults to 'pos' because today every store is both — but we keep the
      -- column so we can split later without a migration.
      kind TEXT NOT NULL DEFAULT 'pos',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recon_entity_pos_locations_shopify
      ON recon_entity_pos_locations(shopify_location_id)
      WHERE shopify_location_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_recon_entity_pos_locations_entity
      ON recon_entity_pos_locations(entity_id);
  `);

  // Zip-code lookup used to route digital gift cards to the nearest store.
  // Populated lazily: when an unknown zip appears we resolve nearest entity
  // and cache the result here. Seeded for NY's most common zips on first boot
  // in a follow-up PR; for now this just stores manual entries from the UI.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_zip_to_entity_lookup (
      zip TEXT PRIMARY KEY,
      -- The entity this zip routes to. Null = explicitly "no nearest store"
      -- (e.g. out-of-state) -> allocator falls back to pro-rata.
      entity_id INTEGER REFERENCES payroll_entities(id),
      -- Miles to nearest store, for transparency in the UI. Optional.
      distance_miles REAL,
      -- 'auto' (geocoded) | 'manual' (override entered by user)
      source TEXT NOT NULL DEFAULT 'auto',
      updated_at TEXT,
      updated_by TEXT
    );
  `);

  // Frozen prior-year pro-rata snapshot used as the FALLBACK for digital GC
  // online sales whose buyer zip has no nearest store (e.g. out-of-state).
  // One row per (year, entity) — sums to 1.0 across entities for a given year.
  // Computed once per year from prior-year online GC REDEMPTIONS and never
  // changes after that (frozen).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_prior_year_pro_rata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Calendar year these ratios apply to (i.e. the year being allocated).
      -- Computed from redemptions in (year - 1).
      applies_to_year INTEGER NOT NULL,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      -- Share of prior-year redemptions for this entity. 0..1, sums to 1.0.
      share REAL NOT NULL,
      -- Raw dollar amount from the source year, for audit/UI display.
      source_redemptions_total REAL NOT NULL,
      frozen_at TEXT NOT NULL,
      frozen_by TEXT,
      UNIQUE(applies_to_year, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_recon_prior_year_pro_rata_year
      ON recon_prior_year_pro_rata(applies_to_year);
  `);

  // ----- Shopify orders -----
  // We mirror the fields we need for allocation + tax breakdown. Anything we
  // don't need is left in `raw_json` for later forensics without a re-pull.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_orders (
      -- Shopify order GID/id (we store the numeric id as text to avoid bigint).
      id TEXT PRIMARY KEY,
      order_number TEXT,
      name TEXT,
      -- ISO timestamp of order creation in Shopify (UTC). Used for monthly
      -- rollup bucketing after converting to ET in the UI.
      created_at TEXT NOT NULL,
      processed_at TEXT,
      updated_at TEXT,
      cancelled_at TEXT,
      closed_at TEXT,
      financial_status TEXT,    -- paid|partially_refunded|refunded|...
      fulfillment_status TEXT,  -- fulfilled|partial|null
      -- Sales channel: 'pos' | 'online_store' | 'shop' | 'facebook' | ...
      -- 'shop' is the marketplace-facilitator exception — tax is remitted by
      -- Shopify, NOT by us. Allocator + tax UI MUST honor this.
      source_name TEXT,
      -- Shopify location_id for the order. For POS = store of sale. For
      -- online = fulfillment location. Joined to recon_entity_pos_locations.
      location_id TEXT,
      currency TEXT,
      -- Money fields (denormalized for fast monthly rollup).
      subtotal REAL,
      total_tax REAL,
      total_discounts REAL,
      total_shipping REAL,
      total_tips REAL,
      total_price REAL,
      total_refunded REAL DEFAULT 0,
      -- Customer fields used for digital-GC allocation (buyer's zip).
      customer_id TEXT,
      customer_email TEXT,
      billing_zip TEXT,
      shipping_zip TEXT,
      -- True if any line item is a gift card. Cached for fast filtering.
      has_gift_card INTEGER NOT NULL DEFAULT 0,
      -- 'channel_liable' rollup across line items. If TRUE, taxes for this
      -- order are remitted by Shopify (Shop channel marketplace facilitator).
      tax_channel_liable INTEGER NOT NULL DEFAULT 0,
      -- Raw GraphQL/REST payload for forensics. Stored as JSON text.
      raw_json TEXT,
      ingested_at TEXT NOT NULL,
      -- Bumped whenever an update webhook re-syncs the row. Cheap idempotency.
      ingest_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_recon_orders_created_at
      ON recon_orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_recon_orders_processed_at
      ON recon_orders(processed_at);
    CREATE INDEX IF NOT EXISTS idx_recon_orders_location
      ON recon_orders(location_id);
    CREATE INDEX IF NOT EXISTS idx_recon_orders_source
      ON recon_orders(source_name);
    CREATE INDEX IF NOT EXISTS idx_recon_orders_financial_status
      ON recon_orders(financial_status);
    CREATE INDEX IF NOT EXISTS idx_recon_orders_has_gift_card
      ON recon_orders(has_gift_card) WHERE has_gift_card = 1;
  `);

  // ----- Shopify line items -----
  // One row per line item per order. Tax detail is kept inline (tax_lines_json)
  // because per-line tax breakdown matters for NY county-level filings. The
  // CRITICAL field is `tax_channel_liable`: when TRUE the tax on this line is
  // remitted by Shopify (Shop channel) and must be EXCLUDED from our owed-tax
  // calculation.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_line_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES recon_orders(id) ON DELETE CASCADE,
      product_id TEXT,
      variant_id TEXT,
      sku TEXT,
      title TEXT,
      variant_title TEXT,
      quantity REAL NOT NULL DEFAULT 0,
      price REAL,
      total_discount REAL DEFAULT 0,
      -- Pre-tax line subtotal = price * quantity - total_discount.
      line_subtotal REAL,
      -- Sum of taxes on this line (regardless of channel_liable).
      line_tax_total REAL DEFAULT 0,
      -- TRUE if at least one tax_line on this item has channel_liable=true.
      -- Mirrored from order-level for fast filtering of Shop-channel sales.
      tax_channel_liable INTEGER NOT NULL DEFAULT 0,
      -- Full per-jurisdiction tax breakdown for NY county filings:
      --   [{ title, rate, price, channel_liable, jurisdiction }, ...]
      tax_lines_json TEXT,
      -- True if this line item IS a gift-card sale (not a redemption).
      is_gift_card INTEGER NOT NULL DEFAULT 0,
      -- True if this line is a physical product requiring fulfillment.
      requires_shipping INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_line_items_order
      ON recon_line_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_line_items_sku
      ON recon_line_items(sku);
    CREATE INDEX IF NOT EXISTS idx_recon_line_items_is_gift_card
      ON recon_line_items(is_gift_card) WHERE is_gift_card = 1;
    CREATE INDEX IF NOT EXISTS idx_recon_line_items_channel_liable
      ON recon_line_items(tax_channel_liable);
  `);

  // ----- Shopify payouts -----
  // A payout = one deposit from Shopify Payments to the bank account. The
  // Plaid matcher in PR #R5 will join recon_payouts.amount + deposit date to
  // bank transactions on the deposit account.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_payouts (
      id TEXT PRIMARY KEY,
      -- 'date' in Shopify payouts API = settlement/deposit date.
      payout_date TEXT NOT NULL,
      currency TEXT,
      amount REAL NOT NULL,
      status TEXT,             -- scheduled|in_transit|paid|failed|cancelled
      summary_json TEXT,       -- charges/refunds/adjustments/fees totals
      -- Plaid match — set by the matcher in PR #R5. Null until matched.
      plaid_transaction_id TEXT,
      matched_at TEXT,
      matched_by TEXT,         -- 'auto' | user email
      raw_json TEXT,
      ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_payouts_date
      ON recon_payouts(payout_date);
    CREATE INDEX IF NOT EXISTS idx_recon_payouts_status
      ON recon_payouts(status);
    CREATE INDEX IF NOT EXISTS idx_recon_payouts_plaid_match
      ON recon_payouts(plaid_transaction_id)
      WHERE plaid_transaction_id IS NOT NULL;
  `);

  // ----- Balance transactions -----
  // One row per line on a payout (charge, refund, fee, adjustment). Used to
  // explain a payout to a per-order level and to attribute Shopify fees back
  // to entities in Phase 2.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_balance_transactions (
      id TEXT PRIMARY KEY,
      payout_id TEXT REFERENCES recon_payouts(id) ON DELETE SET NULL,
      -- charge|refund|adjustment|fee|payout|...
      type TEXT NOT NULL,
      -- ISO timestamp the transaction was created in Shopify.
      processed_at TEXT,
      -- Net amount that hit the payout. Positive = inflow, negative = refund/fee.
      amount REAL NOT NULL,
      fee REAL DEFAULT 0,
      net REAL,
      currency TEXT,
      -- Source order, if applicable. Joined to recon_orders for attribution.
      source_order_id TEXT,
      -- Original transaction id this row refunds/adjusts, if applicable.
      source_transaction_id TEXT,
      raw_json TEXT,
      ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_balance_txn_payout
      ON recon_balance_transactions(payout_id);
    CREATE INDEX IF NOT EXISTS idx_recon_balance_txn_order
      ON recon_balance_transactions(source_order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_balance_txn_type
      ON recon_balance_transactions(type);
  `);

  // ----- Allocations -----
  // Derived: the allocator computes one row per order per receiving entity.
  // For most orders that's a single row (100% to the store of sale). Digital
  // gift cards can split across multiple entities; in that case multiple rows
  // share the same order_id with shares summing to 1.0.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES recon_orders(id) ON DELETE CASCADE,
      -- Specific line item, when the allocation differs per line (e.g. a cart
      -- with both a physical product AND a digital gift card). Null = order-level.
      line_item_id TEXT REFERENCES recon_line_items(id) ON DELETE CASCADE,
      entity_id INTEGER NOT NULL REFERENCES payroll_entities(id),
      -- Share of the order/line attributed to this entity. 0..1.
      share REAL NOT NULL,
      -- Dollar amount this entity gets (pre-tax). Denormalized for fast rollup.
      gross_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      -- 'pos' | 'online_fulfillment' | 'gc_zip' | 'gc_pro_rata' | 'manual'
      method TEXT NOT NULL,
      -- For audit: 'zip:11743' | 'location_id:680...' | 'override_by:user@x' etc.
      reason TEXT,
      -- Manual override audit trail. Null when allocator-set.
      overridden_by TEXT,
      overridden_at TEXT,
      -- The auto-computed method/entity BEFORE the override (so we can
      -- diff in the UI and revert).
      auto_method TEXT,
      auto_entity_id INTEGER REFERENCES payroll_entities(id),
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recon_allocations_order
      ON recon_allocations(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_allocations_entity
      ON recon_allocations(entity_id);
    CREATE INDEX IF NOT EXISTS idx_recon_allocations_method
      ON recon_allocations(method);
    CREATE INDEX IF NOT EXISTS idx_recon_allocations_overridden
      ON recon_allocations(overridden_at) WHERE overridden_at IS NOT NULL;
  `);

  // ----- Gift cards issued -----
  // The Shopify GC ledger: one row per card created. Used to compute prior-year
  // pro-rata when the card was DIGITAL and is later redeemed. We also store
  // the issuing order so we can audit "who originally paid for this card."
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_gift_cards (
      id TEXT PRIMARY KEY,
      -- Last 4 of the GC code, for matching at redemption time.
      last_characters TEXT,
      initial_value REAL NOT NULL,
      balance REAL,
      currency TEXT,
      -- 'digital' = emailed, no shipping. 'physical' = card SKU shipped.
      kind TEXT NOT NULL DEFAULT 'digital',
      -- Order that purchased this card, if applicable.
      issuing_order_id TEXT REFERENCES recon_orders(id) ON DELETE SET NULL,
      issuing_line_item_id TEXT REFERENCES recon_line_items(id) ON DELETE SET NULL,
      -- For digital GCs purchased online: buyer's zip captured at purchase.
      -- Used by the allocator to route to nearest store.
      buyer_zip TEXT,
      -- Entity assigned at purchase time (the seller of the card). Used by
      -- Phase 2 deferred-revenue JE.
      issuing_entity_id INTEGER REFERENCES payroll_entities(id),
      issued_at TEXT,
      disabled_at TEXT,
      expires_at TEXT,
      raw_json TEXT,
      ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_gift_cards_issuing_order
      ON recon_gift_cards(issuing_order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_gift_cards_issued_at
      ON recon_gift_cards(issued_at);
    CREATE INDEX IF NOT EXISTS idx_recon_gift_cards_kind
      ON recon_gift_cards(kind);
  `);

  // ----- Gift card redemptions -----
  // Each time a GC is used to pay (full or partial) for an order, we record
  // one row here. Powers (a) the prior-year pro-rata calculation, and (b) the
  // intercompany due-to/from JEs in Phase 2 when the issuer != redeemer entity.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_gift_card_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gift_card_id TEXT REFERENCES recon_gift_cards(id) ON DELETE SET NULL,
      -- Order where the card was applied as payment.
      order_id TEXT NOT NULL REFERENCES recon_orders(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      -- Entity that REDEEMED the card (where the order shipped/sold).
      redeeming_entity_id INTEGER REFERENCES payroll_entities(id),
      -- Snapshotted at redemption time so later edits to recon_gift_cards
      -- don't break the historical intercompany trail.
      issuing_entity_id INTEGER REFERENCES payroll_entities(id),
      redeemed_at TEXT NOT NULL,
      raw_json TEXT,
      ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recon_gc_redemptions_order
      ON recon_gift_card_redemptions(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_gc_redemptions_gc
      ON recon_gift_card_redemptions(gift_card_id);
    CREATE INDEX IF NOT EXISTS idx_recon_gc_redemptions_redeemed_at
      ON recon_gift_card_redemptions(redeemed_at);
    CREATE INDEX IF NOT EXISTS idx_recon_gc_redemptions_redeeming_entity
      ON recon_gift_card_redemptions(redeeming_entity_id);
  `);

  // ----- Reconciler sync log -----
  // Mirrors payroll_sync_log shape so the existing /api/sync-log UI can show
  // both modules in one timeline. `cursor` stores the per-stream incremental
  // watermark (e.g. 'updated_at_min=2026-04-15T00:00:00Z').
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 'orders' | 'payouts' | 'balance_transactions' | 'gift_cards' | 'allocator' | 'pro_rata_freeze'
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,      -- running|success|failure
      rows_ingested INTEGER DEFAULT 0,
      cursor TEXT,               -- watermark for resume
      error_message TEXT,
      triggered_by TEXT          -- 'cron' | 'manual:<email>'
    );
    CREATE INDEX IF NOT EXISTS idx_recon_sync_log_kind_started
      ON recon_sync_log(kind, started_at DESC);
  `);

  // ============================================================================
  // RBAC TABLES (PR #6)
  // ============================================================================

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      module TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      UNIQUE(role_id, permission_id)
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      entity_id_scope INTEGER REFERENCES payroll_entities(id) ON DELETE CASCADE,
      created_at TEXT,
      UNIQUE(user_id, role_id, entity_id_scope)
    );
    CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
  `);

  // Run user seed migration after schema is ready
  seedAppUsersFromEnv();

  // Seed payroll + RBAC baseline data (entities, permissions, system roles).
  // Idempotent — safe to run on every boot.
  seedPayrollBaseline();
  seedRbacBaseline();
  // Reconciler baseline (PR #R1): one settings row + entity_pos_locations
  // shells seeded from the 3 payroll_entities. Idempotent.
  seedReconcilerBaseline();
}

// ===== app_users helpers =====

export type AppUser = {
  id: number;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
  enabled: number;
  password_salt: string | null;
  password_hash: string | null;
  created_at: string;
  last_login_at: string | null;
};

export function listAppUsers(): AppUser[] {
  return sqlite.prepare(`SELECT * FROM app_users ORDER BY created_at ASC`).all() as AppUser[];
}

export function getAppUserByEmail(email: string): AppUser | null {
  return (sqlite.prepare(`SELECT * FROM app_users WHERE LOWER(email) = ? LIMIT 1`).get(email.toLowerCase()) as AppUser) || null;
}

export function getAppUserById(id: number): AppUser | null {
  return (sqlite.prepare(`SELECT * FROM app_users WHERE id = ? LIMIT 1`).get(id) as AppUser) || null;
}

export function createAppUser(p: {
  email: string;
  name?: string | null;
  role?: 'admin' | 'user';
  enabled?: number;
  password_salt?: string | null;
  password_hash?: string | null;
}): AppUser {
  const now = new Date().toISOString();
  const row = sqlite.prepare(`
    INSERT INTO app_users (email, name, role, enabled, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(
    p.email.trim().toLowerCase(),
    p.name || null,
    p.role || 'user',
    p.enabled ?? 1,
    p.password_salt || null,
    p.password_hash || null,
    now,
  ) as AppUser;
  return row;
}

export function updateAppUser(id: number, p: {
  name?: string | null;
  role?: 'admin' | 'user';
  enabled?: number;
  last_login_at?: string | null;
}): AppUser | null {
  const fields: string[] = [];
  const vals: any[] = [];
  if (p.name !== undefined) { fields.push('name = ?'); vals.push(p.name); }
  if (p.role !== undefined) { fields.push('role = ?'); vals.push(p.role); }
  if (p.enabled !== undefined) { fields.push('enabled = ?'); vals.push(p.enabled); }
  if (p.last_login_at !== undefined) { fields.push('last_login_at = ?'); vals.push(p.last_login_at); }
  if (fields.length === 0) return getAppUserById(id);
  vals.push(id);
  sqlite.prepare(`UPDATE app_users SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getAppUserById(id);
}

export function setAppUserPassword(id: number, salt: string, hash: string): void {
  sqlite.prepare(`UPDATE app_users SET password_salt = ?, password_hash = ? WHERE id = ?`).run(salt, hash, id);
}

export function deleteAppUser(id: number): boolean {
  const r = sqlite.prepare(`DELETE FROM app_users WHERE id = ?`).run(id);
  return r.changes > 0;
}

// ===== app_config helpers =====

export function getConfig(key: string): string | null {
  const row = sqlite.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setConfig(key: string, value: string): void {
  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

// ===== backup_runs helpers =====

export type BackupRun = {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  file_path: string | null;
  file_size_bytes: number | null;
  drive_file_id: string | null;
  error: string | null;
};

export function insertBackupRun(p: Omit<BackupRun, 'id'>): BackupRun {
  const row = sqlite.prepare(`
    INSERT INTO backup_runs (kind, started_at, finished_at, status, file_path, file_size_bytes, drive_file_id, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(p.kind, p.started_at, p.finished_at, p.status, p.file_path, p.file_size_bytes, p.drive_file_id, p.error) as BackupRun;
  return row;
}

export function getLastBackupRun(kind: string): BackupRun | null {
  return (sqlite.prepare(`SELECT * FROM backup_runs WHERE kind = ? ORDER BY started_at DESC LIMIT 1`).get(kind) as BackupRun) || null;
}

export function getLastSuccessfulBackupRun(kind: string): BackupRun | null {
  return (sqlite.prepare(`SELECT * FROM backup_runs WHERE kind = ? AND status = 'success' ORDER BY started_at DESC LIMIT 1`).get(kind) as BackupRun) || null;
}

export function listBackupRuns(kind?: string, limit = 20): BackupRun[] {
  if (kind) {
    return sqlite.prepare(`SELECT * FROM backup_runs WHERE kind = ? ORDER BY started_at DESC LIMIT ?`).all(kind, limit) as BackupRun[];
  }
  return sqlite.prepare(`SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as BackupRun[];
}

export function countConsecutiveFailures(kind: string): number {
  // Count failures from the most recent run backwards until we hit a success or run out of records
  const rows = sqlite.prepare(`SELECT status FROM backup_runs WHERE kind = ? ORDER BY started_at DESC LIMIT 10`).all(kind) as { status: string }[];
  let count = 0;
  for (const r of rows) {
    if (r.status === 'failed') count++;
    else break;
  }
  return count;
}

// ===== google_oauth helpers =====

export type GoogleOAuthRow = {
  purpose: string;
  encrypted_tokens: string;
  granted_email: string | null;
  granted_at: string;
  updated_at: string;
};

export function getGoogleOAuthRow(purpose: string): GoogleOAuthRow | null {
  return (sqlite.prepare(`SELECT * FROM google_oauth WHERE purpose = ?`).get(purpose) as GoogleOAuthRow) || null;
}

export function upsertGoogleOAuthRow(p: GoogleOAuthRow): void {
  sqlite.prepare(`
    INSERT INTO google_oauth (purpose, encrypted_tokens, granted_email, granted_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(purpose) DO UPDATE SET
      encrypted_tokens = excluded.encrypted_tokens,
      granted_email = excluded.granted_email,
      updated_at = excluded.updated_at
  `).run(p.purpose, p.encrypted_tokens, p.granted_email, p.granted_at, p.updated_at);
}

export function deleteGoogleOAuthRow(purpose: string): void {
  sqlite.prepare(`DELETE FROM google_oauth WHERE purpose = ?`).run(purpose);
}

/**
 * Seed app_users from environment variables on first boot (when table is empty).
 * This ensures backwards-compatibility with env-based auth.
 */
function seedAppUsersFromEnv(): void {
  try {
    const count = (sqlite.prepare(`SELECT COUNT(*) as c FROM app_users`).get() as { c: number }).c;
    if (count > 0) return; // already seeded

    const now = new Date().toISOString();
    const usersToSeed: Array<{ email: string; name?: string; role: 'admin' | 'user'; password_hash?: string }> = [];

    // Read LOGIN_USERS (JSON array format or comma-sep)
    const loginUsers = process.env.LOGIN_USERS;
    if (loginUsers) {
      try {
        const arr = JSON.parse(loginUsers) as Array<{ email: string; password_hash?: string; role?: string }>;
        for (const u of arr) {
          if (u.email) usersToSeed.push({ email: u.email, role: 'admin', password_hash: u.password_hash });
        }
      } catch {
        // comma-separated emails
        for (const email of loginUsers.split(',').map(e => e.trim()).filter(Boolean)) {
          usersToSeed.push({ email, role: 'admin' });
        }
      }
    }

    // Read LOGIN_EMAIL / LOGIN_PASSWORD_HASH
    const loginEmail = process.env.LOGIN_EMAIL;
    const loginPasswordHash = process.env.LOGIN_PASSWORD_HASH;
    if (loginEmail) {
      const existing = usersToSeed.find(u => u.email.toLowerCase() === loginEmail.toLowerCase());
      if (!existing) {
        usersToSeed.push({ email: loginEmail, role: 'admin', password_hash: loginPasswordHash });
      } else if (loginPasswordHash && !existing.password_hash) {
        existing.password_hash = loginPasswordHash;
      }
    }

    // Ensure jake and johnny are always present
    if (!usersToSeed.find(u => u.email.toLowerCase() === 'jake@snohaus.com')) {
      usersToSeed.push({ email: 'jake@snohaus.com', name: 'Jake', role: 'admin' });
    } else {
      const jake = usersToSeed.find(u => u.email.toLowerCase() === 'jake@snohaus.com')!;
      jake.name = jake.name || 'Jake';
      jake.role = 'admin';
    }
    if (!usersToSeed.find(u => u.email.toLowerCase() === 'johnny@snohaus.com')) {
      usersToSeed.push({ email: 'johnny@snohaus.com', name: 'Johnny', role: 'user' });
    }

    // Insert all
    for (const u of usersToSeed) {
      try {
        sqlite.prepare(`
          INSERT OR IGNORE INTO app_users (email, name, role, enabled, password_hash, created_at)
          VALUES (?, ?, ?, 1, ?, ?)
        `).run(u.email.toLowerCase(), u.name || null, u.role, u.password_hash || null, now);
      } catch {
        // ignore duplicate errors
      }
    }
    console.log(`[storage] Seeded ${usersToSeed.length} users into app_users from env`);
  } catch (e: any) {
    console.error('[storage] seedAppUsersFromEnv failed:', e.message);
  }
}

// ============================================================================
// PAYROLL + RBAC BASELINE SEEDS (PR #6)
// ----------------------------------------------------------------------------
// Both functions are idempotent. They run on every boot via bootstrapSchema()
// and are safe to re-run — they only insert rows that don't already exist.
// ============================================================================

function seedPayrollBaseline(): void {
  try {
    const now = new Date().toISOString();

    // Seed the 3 entities if the table is empty. We deliberately don't try to
    // "upsert" by location once the table is populated — the user may rename
    // entities and we don't want to clobber their edits.
    const entityCount = (sqlite.prepare(`SELECT COUNT(*) AS c FROM payroll_entities`).get() as { c: number }).c;
    if (entityCount === 0) {
      const insert = sqlite.prepare(`
        INSERT INTO payroll_entities
          (location, legal_name, cadence, commissions_enabled, pms_enabled,
           tips_enabled, easyrent_enabled, spif_enabled, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const e of INITIAL_ENTITIES) {
        insert.run(
          e.location,
          e.legal_name,
          e.cadence,
          e.commissions_enabled,
          e.pms_enabled,
          e.tips_enabled,
          e.easyrent_enabled,
          e.spif_enabled,
          now,
          now,
        );
      }
      console.log(`[storage] Seeded ${INITIAL_ENTITIES.length} entities into payroll_entities`);
    }

    // Seed the 3.8% tip CC fee for Greenvale if no row exists.
    const greenvale = sqlite.prepare(
      `SELECT id FROM payroll_entities WHERE location = 'Greenvale' LIMIT 1`
    ).get() as { id: number } | undefined;
    if (greenvale) {
      const feeExists = sqlite.prepare(
        `SELECT 1 FROM payroll_entity_processing_fees WHERE entity_id = ? AND fee_kind = 'tip_cc_fee' LIMIT 1`
      ).get(greenvale.id);
      if (!feeExists) {
        sqlite.prepare(`
          INSERT INTO payroll_entity_processing_fees
            (entity_id, fee_kind, fee_pct, effective_from, note, created_at)
          VALUES (?, 'tip_cc_fee', 0.038, ?, 'Initial seed — 3.8% Shift4 CC processing fee deducted from tips before ADP import.', ?)
        `).run(greenvale.id, '2020-01-01', now);
        console.log(`[storage] Seeded Greenvale tip CC fee (3.8%)`);
      }
    }
  } catch (e: any) {
    console.error('[storage] seedPayrollBaseline failed:', e.message);
  }
}

// ============================================================================
// RECONCILER BASELINE SEED (PR #R1)
// ----------------------------------------------------------------------------
// Inserts the singleton recon_settings row and one shell recon_entity_pos_
// locations row per active payroll entity so the UI in PR #R2 can immediately
// render the mapping table (the user will fill in shopify_location_id after
// the first Shopify sync). Fully idempotent.
// ============================================================================

function seedReconcilerBaseline(): void {
  try {
    const now = new Date().toISOString();

    // 1) Singleton settings row.
    const settingsExists = sqlite.prepare(
      `SELECT 1 FROM recon_settings WHERE id = 1 LIMIT 1`
    ).get();
    if (!settingsExists) {
      sqlite.prepare(`
        INSERT INTO recon_settings
          (id, default_digital_gc_allocation_policy, initial_sync_from, updated_at, updated_by)
        VALUES (1, 'zip_then_pro_rata', '2025-01-01', ?, 'seed')
      `).run(now);
      console.log(`[storage] Seeded recon_settings (singleton row)`);
    }

    // 2) One pos-location shell per active payroll entity, if missing.
    // We don't yet know the Shopify location_id; the user maps it in PR #R2.
    const entities = sqlite.prepare(
      `SELECT id, location FROM payroll_entities WHERE active = 1 ORDER BY id`
    ).all() as Array<{ id: number; location: string }>;
    const insertLoc = sqlite.prepare(`
      INSERT INTO recon_entity_pos_locations
        (entity_id, shopify_location_id, shopify_location_name, kind, active, created_at, updated_at)
      VALUES (?, NULL, ?, 'pos', 1, ?, ?)
    `);
    let seededLocs = 0;
    for (const e of entities) {
      const exists = sqlite.prepare(
        `SELECT 1 FROM recon_entity_pos_locations WHERE entity_id = ? LIMIT 1`
      ).get(e.id);
      if (!exists) {
        insertLoc.run(e.id, `${e.location} (unmapped)`, now, now);
        seededLocs++;
      }
    }
    if (seededLocs > 0) {
      console.log(`[storage] Seeded ${seededLocs} recon_entity_pos_locations shells`);
    }
  } catch (e: any) {
    console.error('[storage] seedReconcilerBaseline failed:', e.message);
  }
}

function seedRbacBaseline(): void {
  try {
    const now = new Date().toISOString();

    // ----- Seed permission catalog -----
    // Always run — lets us add new permissions in future PRs by simply
    // appending to PERMISSION_CATALOG and they'll be inserted on next boot.
    const upsertPerm = sqlite.prepare(`
      INSERT INTO permissions (key, module, label, description)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        module = excluded.module,
        label = excluded.label,
        description = excluded.description
    `);
    for (const p of PERMISSION_CATALOG) {
      upsertPerm.run(p.key, p.module, p.label, p.description);
    }

    // ----- Seed system roles -----
    // Only insert if the role doesn't exist by name. If the Owner has edited
    // a system role's permissions in the UI, we DON'T overwrite their changes
    // on the next boot. New permissions added in future PRs need to be
    // assigned to roles via the Settings UI (or a follow-up migration).
    const getRoleByName = sqlite.prepare(`SELECT id FROM roles WHERE name = ? LIMIT 1`);
    const insertRole = sqlite.prepare(`
      INSERT INTO roles (name, description, is_system, created_at) VALUES (?, ?, 1, ?)
    `);
    const getAllPermIds = sqlite.prepare(`SELECT id, key FROM permissions`);
    const getPermIdByKey = sqlite.prepare(`SELECT id FROM permissions WHERE key = ? LIMIT 1`);
    const insertRolePerm = sqlite.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)
    `);

    for (const r of SYSTEM_ROLES) {
      let row = getRoleByName.get(r.name) as { id: number } | undefined;
      if (!row) {
        const info = insertRole.run(r.name, r.description, now);
        row = { id: Number(info.lastInsertRowid) };

        // Assign permissions only on initial creation.
        if (r.permissions === "ALL") {
          const allPerms = getAllPermIds.all() as Array<{ id: number; key: string }>;
          for (const p of allPerms) {
            insertRolePerm.run(row.id, p.id);
          }
        } else {
          for (const key of r.permissions) {
            const p = getPermIdByKey.get(key) as { id: number } | undefined;
            if (p) insertRolePerm.run(row.id, p.id);
          }
        }
        console.log(`[storage] Seeded system role "${r.name}" with ${
          r.permissions === "ALL" ? "all" : r.permissions.length
        } permissions`);
      }
    }

    // ----- Auto-assign Owner role to legacy admin users -----
    // Anyone in app_users with role='admin' should also have the Owner role
    // in the new RBAC system, with no entity scope (= all entities).
    const ownerRole = getRoleByName.get("Owner") as { id: number } | undefined;
    if (ownerRole) {
      const admins = sqlite.prepare(
        `SELECT id FROM app_users WHERE role = 'admin' AND enabled = 1`
      ).all() as Array<{ id: number }>;
      const insertUserRole = sqlite.prepare(`
        INSERT OR IGNORE INTO user_roles (user_id, role_id, entity_id_scope, created_at)
        VALUES (?, ?, NULL, ?)
      `);
      for (const a of admins) {
        insertUserRole.run(a.id, ownerRole.id, now);
      }
    }
  } catch (e: any) {
    console.error('[storage] seedRbacBaseline failed:', e.message);
  }
}


// ===== Skip Senders helpers (Round 6) =====

export type SkipSenderRow = {
  id: number;
  match_type: "email" | "domain";
  match_value: string;
  vendor_name: string | null;
  added_at: string;
  added_by: string | null;
  skipped_count: number;
  last_skipped_at: string | null;
};

export function listSkipSenders(): SkipSenderRow[] {
  return sqlite.prepare(`SELECT * FROM skip_senders ORDER BY added_at DESC`).all() as SkipSenderRow[];
}

/**
 * Extract a bare email address from a free-form RFC-5322-ish "From" string.
 * Handles:
 *   - "Display Name" <user@host.com>
 *   - Display Name <user@host.com>
 *   - user@host.com
 *   - whitespace, surrounding quotes, leading/trailing junk
 * Returns lowercase email or empty string if none found.
 */
export function extractBareEmail(input: string | null | undefined): string {
  if (!input) return "";
  const s = String(input).trim();
  if (!s) return "";
  // Prefer the address inside <...> if present.
  const angle = s.match(/<\s*([^<>\s"]+@[^<>\s"]+)\s*>/);
  if (angle && angle[1]) return angle[1].trim().toLowerCase();
  // Otherwise pick the first email-like token in the string.
  const bare = s.match(/[^\s<>"',;()]+@[^\s<>"',;()]+\.[^\s<>"',;()]+/);
  if (bare && bare[0]) return bare[0].trim().toLowerCase();
  return "";
}

export function addSkipSender(p: {
  match_type: "email" | "domain";
  match_value: string;
  vendor_name?: string | null;
  added_by?: string | null;
}): { ok: boolean; id?: number; error?: string } {
  let value = (p.match_value || "").trim().toLowerCase();
  if (!value) return { ok: false, error: "Empty match value" };
  if (p.match_type === "email") {
    // Defensively pull the bare email out if a display-name wrapper slipped through.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      const extracted = extractBareEmail(value);
      if (extracted) value = extracted;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      return { ok: false, error: "Invalid email format" };
    }
  }
  if (p.match_type === "domain") {
    // Allow callers to pass a full email and strip the local part.
    if (value.includes("@")) value = value.slice(value.indexOf("@") + 1);
    if (!/^[^@\s]+\.[^@\s]+$/.test(value)) {
      return { ok: false, error: "Invalid domain format (e.g. adobe.com)" };
    }
  }
  try {
    const r = sqlite.prepare(
      `INSERT INTO skip_senders (match_type, match_value, vendor_name, added_at, added_by) VALUES (?,?,?,?,?)`
    ).run(p.match_type, value, p.vendor_name || null, new Date().toISOString(), p.added_by || null);
    return { ok: true, id: Number(r.lastInsertRowid) };
  } catch (e: any) {
    if (/UNIQUE/i.test(e.message)) return { ok: false, error: "Already in skip list" };
    return { ok: false, error: e.message };
  }
}

export function removeSkipSender(id: number): boolean {
  const r = sqlite.prepare(`DELETE FROM skip_senders WHERE id = ?`).run(id);
  return r.changes > 0;
}

/**
 * Returns the matching skip rule if the given sender should be skipped, else null.
 * Matches by exact email first, then by domain. Case-insensitive.
 */
export function checkSkipSender(senderEmail: string | null | undefined): SkipSenderRow | null {
  if (!senderEmail) return null;
  const email = senderEmail.toLowerCase().trim();
  if (!email) return null;
  const exact = sqlite.prepare(
    `SELECT * FROM skip_senders WHERE match_type='email' AND LOWER(match_value) = ? LIMIT 1`
  ).get(email) as SkipSenderRow | undefined;
  if (exact) return exact;
  const at = email.indexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1);
  const dom = sqlite.prepare(
    `SELECT * FROM skip_senders WHERE match_type='domain' AND LOWER(match_value) = ? LIMIT 1`
  ).get(domain) as SkipSenderRow | undefined;
  return dom || null;
}

/**
 * Atomic "skip sender + reject invoice" used by the drawer's Skip & reject button.
 *
 * All four writes happen in a single transaction:
 *   1. INSERT skip rule (no-op if it already exists)
 *   2. UPDATE invoice status -> 'rejected'
 *   3. INSERT audit log row
 *   4. INSERT invoice note row
 *
 * Returns { ok, error?, matchValue, matchType, alreadyExisted } — never throws
 * for known validation cases. Bubbles unknown DB errors up so the route can 500
 * with a useful message.
 */
export function skipSenderAndRejectInvoice(p: {
  invoiceId: string;
  matchType: "email" | "domain";
  rawSender: string;        // original email_from for the note text
  matchValue: string;       // already-normalized bare email or domain
  vendorName: string | null;
  userEmail: string | null;
}): { ok: boolean; error?: string; alreadyExisted?: boolean } {
  // Validate match value first using the same rules as addSkipSender so we
  // fail fast outside the transaction.
  let value = (p.matchValue || "").trim().toLowerCase();
  if (!value) return { ok: false, error: "Empty match value" };
  if (p.matchType === "email") {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      const extracted = extractBareEmail(value);
      if (extracted) value = extracted;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      return { ok: false, error: "Invalid email format" };
    }
  } else {
    if (value.includes("@")) value = value.slice(value.indexOf("@") + 1);
    if (!/^[^@\s]+\.[^@\s]+$/.test(value)) {
      return { ok: false, error: "Invalid domain format (e.g. adobe.com)" };
    }
  }

  const inv = sqlite.prepare(`SELECT id, status FROM invoices WHERE id = ?`).get(p.invoiceId) as
    | { id: string; status: string }
    | undefined;
  if (!inv) return { ok: false, error: "Invoice not found" };

  const beforeStatus = inv.status;
  const now = new Date().toISOString();
  let alreadyExisted = false;

  const tx = sqlite.transaction(() => {
    // 1. Skip rule (ignore unique-constraint failures so this is idempotent).
    try {
      sqlite.prepare(
        `INSERT INTO skip_senders (match_type, match_value, vendor_name, added_at, added_by) VALUES (?,?,?,?,?)`
      ).run(p.matchType, value, p.vendorName || null, now, p.userEmail || null);
    } catch (e: any) {
      if (/UNIQUE/i.test(e.message)) {
        alreadyExisted = true;
      } else {
        throw e;
      }
    }

    // 2. Reject the invoice.
    sqlite.prepare(
      `UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?`
    ).run("rejected", now, p.invoiceId);

    // 3. Audit log (positional args matching audit_log schema).
    sqlite.prepare(
      `INSERT INTO audit_log (invoice_id, action, before, after, user_email, created_at) VALUES (?,?,?,?,?,?)`
    ).run(
      p.invoiceId,
      "skip_sender",
      JSON.stringify({ status: beforeStatus }),
      JSON.stringify({
        status: "rejected",
        skip_match_type: p.matchType,
        skip_match_value: value,
        skip_rule_already_existed: alreadyExisted,
      }),
      p.userEmail || "",
      now,
    );

    // 4. Invoice note.
    sqlite.prepare(
      `INSERT INTO invoice_notes (invoice_id, user_email, text, created_at) VALUES (?,?,?,?)`
    ).run(
      p.invoiceId,
      p.userEmail || null,
      `Skipped subscription \u2014 first occurrence. Sender: ${p.rawSender}. Match: ${p.matchType} (${value})`,
      now,
    );
  });

  try {
    tx();
  } catch (e: any) {
    return { ok: false, error: e?.message || "DB transaction failed" };
  }
  return { ok: true, alreadyExisted };
}

// ===== Skipped Uploads (Round 7) =====
export type SkippedUploadRow = {
  id: number;
  pdf_url: string | null;
  original_filename: string | null;
  source: string | null;
  email_id: string | null;
  email_from: string | null;
  email_subject: string | null;
  email_date: string | null;
  llm_document_type: string | null;
  llm_skip_reason: string | null;
  llm_notes: string | null;
  llm_vendor_raw_name: string | null;
  llm_total: number | null;
  llm_invoice_number: string | null;
  restored_invoice_id: string | null;
  restored_at: string | null;
  created_at: string;
};

export function recordSkippedUpload(p: {
  pdf_url: string | null;
  original_filename: string | null;
  source: string | null;
  email_id: string | null;
  email_from: string | null;
  email_subject: string | null;
  email_date: string | null;
  llm_document_type: string | null;
  llm_skip_reason: string | null;
  llm_notes: string | null;
  llm_vendor_raw_name: string | null;
  llm_total: number | null;
  llm_invoice_number: string | null;
}): SkippedUploadRow {
  const now = new Date().toISOString();
  const row = sqlite.prepare(`
    INSERT INTO skipped_uploads (
      pdf_url, original_filename, source, email_id, email_from, email_subject, email_date,
      llm_document_type, llm_skip_reason, llm_notes, llm_vendor_raw_name, llm_total, llm_invoice_number,
      created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *
  `).get(
    p.pdf_url, p.original_filename, p.source, p.email_id, p.email_from, p.email_subject, p.email_date,
    p.llm_document_type, p.llm_skip_reason, p.llm_notes, p.llm_vendor_raw_name, p.llm_total, p.llm_invoice_number,
    now
  ) as SkippedUploadRow;
  return row;
}

export function listSkippedUploads(opts: { includeRestored?: boolean } = {}): SkippedUploadRow[] {
  const where = opts.includeRestored ? "" : "WHERE restored_invoice_id IS NULL";
  return sqlite.prepare(
    `SELECT * FROM skipped_uploads ${where} ORDER BY created_at DESC`
  ).all() as SkippedUploadRow[];
}

export function getSkippedUpload(id: number): SkippedUploadRow | undefined {
  return sqlite.prepare(`SELECT * FROM skipped_uploads WHERE id = ?`).get(id) as SkippedUploadRow | undefined;
}

export function markSkippedUploadRestored(id: number, invoiceId: string): void {
  sqlite.prepare(
    `UPDATE skipped_uploads SET restored_invoice_id = ?, restored_at = ? WHERE id = ?`
  ).run(invoiceId, new Date().toISOString(), id);
}

export function deleteSkippedUpload(id: number): SkippedUploadRow | undefined {
  const row = getSkippedUpload(id);
  if (!row) return undefined;
  sqlite.prepare(`DELETE FROM skipped_uploads WHERE id = ?`).run(id);
  return row;
}

export function countActiveSkippedUploads(): number {
  const r = sqlite.prepare(
    `SELECT COUNT(*) as c FROM skipped_uploads WHERE restored_invoice_id IS NULL`
  ).get() as { c: number };
  return r.c;
}

export function recordSkipLog(p: {
  source: string;
  sender_email: string | null;
  subject: string | null;
  matched_rule_id: number | null;
}): void {
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO skip_log (skipped_at, source, sender_email, subject, matched_rule_id) VALUES (?,?,?,?,?)`
  ).run(now, p.source, p.sender_email, p.subject, p.matched_rule_id);
  if (p.matched_rule_id) {
    sqlite.prepare(
      `UPDATE skip_senders SET skipped_count = skipped_count + 1, last_skipped_at = ? WHERE id = ?`
    ).run(now, p.matched_rule_id);
  }
}

bootstrapSchema();

// One-time cleanup: collapse existing duplicate invoices created BEFORE the dedup fix.
// Strategy: group by (invoice_number, total) where both are non-null. Keep the OLDEST id
// (lowest created_at, falling back to id). Delete the rest. Only runs if dups are detected
// and only acts on rows that are still in pending_review (won't touch posted/approved).
function cleanupDuplicateInvoices() {
  try {
    const groups = sqlite.prepare(`
      SELECT invoice_number, total, COUNT(*) as c
      FROM invoices
      WHERE invoice_number IS NOT NULL AND total IS NOT NULL AND status = 'pending_review'
      GROUP BY invoice_number, total
      HAVING c > 1
    `).all() as { invoice_number: string; total: number; c: number }[];
    if (!groups.length) return;
    let removed = 0;
    const findDups = sqlite.prepare(`
      SELECT id FROM invoices
      WHERE invoice_number = ? AND total = ? AND status = 'pending_review'
      ORDER BY COALESCE(created_at, '') ASC, id ASC
    `);
    const delLineItems = sqlite.prepare(`DELETE FROM invoice_line_items WHERE invoice_id = ?`);
    const delInvoice = sqlite.prepare(`DELETE FROM invoices WHERE id = ?`);
    const txn = sqlite.transaction((invoice_number: string, total: number) => {
      const rows = findDups.all(invoice_number, total) as { id: string }[];
      // Keep the first (oldest); remove the rest.
      for (let i = 1; i < rows.length; i++) {
        delLineItems.run(rows[i].id);
        delInvoice.run(rows[i].id);
        removed++;
      }
    });
    for (const g of groups) txn(g.invoice_number, g.total);
    if (removed > 0) console.log(`[dedup-cleanup] Removed ${removed} duplicate pending_review invoice(s) across ${groups.length} group(s).`);
  } catch (err: any) {
    console.error(`[dedup-cleanup] failed (non-fatal): ${err.message}`);
  }
}
cleanupDuplicateInvoices();

// Build a map of source_file -> pdf url path
// PDFs are served via authenticated, signed-URL route. Frontend calls
// POST /api/invoices/:id/pdf-url to get a short-lived ?t= token, then loads
// /api/invoices/:id/pdf?t=... in the iframe. Files live in private_assets/.
// pdf_url stored in DB is the bare filename (used to resolve disk path).
// Mutable map — can be extended at runtime for Gmail-ingested invoices
export const PDF_FILES_MAP: Record<string, string> = {
  "2f730d0ff5_Invoice_70125204.txt": "2f730d0ff5_Invoice_70125204.PDF",
  "3cfa043ce9_NYS229_Inv_8514109_60097.txt": "3cfa043ce9_NYS229_Inv_8514109_60097.pdf",
  "4a68bce824_INV773046.txt": "4a68bce824_INV773046.pdf",
  "67a5baa741_INV773611.txt": "67a5baa741_INV773611.pdf",
  "7ddc36ec3e_INV773048.txt": "7ddc36ec3e_INV773048.pdf",
  "a1d78c88d4_NYS229_Inv_8515011_40516.txt": "a1d78c88d4_NYS229_Inv_8515011_40516.pdf",
  "a5424e2279_INV773047.txt": "a5424e2279_INV773047.pdf",
  "adf8fc0afa_Thule_Inc_INVOICE__126048140_-_703459_1.txt": "adf8fc0afa_Thule_Inc_INVOICE__126048140_-_703459_1.pdf",
  "b062c961b5_INV773594.txt": "b062c961b5_INV773594.pdf",
  "d8e861fa72_Invoice_INV-01070_for_Sno-Haus.txt": "d8e861fa72_Invoice_INV-01070_for_Sno-Haus.pdf",
  "d9891a3e38_F3082196.txt": "d9891a3e38_F3082196.PDF",
  "e943e02995_INV773612.txt": "e943e02995_INV773612.pdf",
};
const pdfFilesMap = PDF_FILES_MAP;

function seedIfEmpty() {
  const count = (sqlite.prepare("SELECT COUNT(*) as c FROM invoices").get() as { c: number }).c;
  if (count > 0) return;

  const now = new Date().toISOString();
  const insertInvoice = sqlite.prepare(`
    INSERT INTO invoices (
      id, source_file, pdf_url, vendor_qbo_id, vendor_qbo_name, vendor_match_status,
      vendor_raw_name, invoice_number, invoice_date, due_date, total, freight, is_credit,
      ship_to_store, parse_confidence, notes, status, routing_mode, routing_data,
      duplicate_check_status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertLine = sqlite.prepare(`
    INSERT INTO invoice_line_items (invoice_id, sku, description, qty, unit_price, amount, is_freight)
    VALUES (?,?,?,?,?,?,?)
  `);

  for (const inv of (seedData as any).invoices) {
    const id = inv.source_file.replace(/\.txt$/, "");
    const vendor = inv.vendor || {};
    const matchStatus = vendor.alias_from ? "aliased" : (vendor.qbo_id ? "matched" : "unmatched");
    const rawName = vendor.alias_from || vendor.qbo_name || null;
    const routingData = JSON.stringify({ store: inv.ship_to_store });
    insertInvoice.run(
      id,
      inv.source_file,
      pdfFilesMap[inv.source_file] || null,
      vendor.qbo_id || null,
      vendor.qbo_name || null,
      matchStatus,
      rawName,
      inv.invoice_number,
      inv.invoice_date,
      inv.due_date,
      inv.total,
      inv.freight || 0,
      inv.is_credit ? 1 : 0,
      inv.ship_to_store,
      inv.parse_confidence,
      inv.notes || null,
      "pending_review",
      "single_store",
      routingData,
      "unchecked",
      now,
      now,
    );

    if (inv.line_items && inv.line_items.length > 0) {
      for (const li of inv.line_items) {
        insertLine.run(id, li.sku || null, li.description || null, li.qty || null, li.unit_price || null, li.amount || null, 0);
      }
    }
  }

  const insertRule = sqlite.prepare(`
    INSERT INTO vendor_rules (vendor_qbo_id, vendor_name, rule_type, default_store, split_data, note, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const r of (seedData as any).rules) {
    insertRule.run(r.vendor_qbo_id, r.vendor_name, r.rule_type, r.store || null, null, r.note || null, now, now);
  }

  const insertAlias = sqlite.prepare(`
    INSERT INTO vendor_aliases (alias, alias_lower, vendor_qbo_id, vendor_name, note, created_at)
    VALUES (?,?,?,?,?,?)
  `);
  for (const a of (seedData as any).aliases) {
    insertAlias.run(a.alias, a.alias_lower, a.vendor_qbo_id, a.vendor_name, a.note || null, now);
  }

  console.log("[seed] Inserted", (seedData as any).invoices.length, "invoices,",
    (seedData as any).rules.length, "rules,",
    (seedData as any).aliases.length, "aliases");
}

seedIfEmpty();

// ---- QBO Vendors ----
// Source of truth is the SQLite `qbo_vendors_cache` table, kept fresh by
// syncQboVendorsFromApi() (server/qbo.ts). When the cache is empty (e.g. fresh DB,
// or QBO was never connected), we fall back to the static qbo_vendors.json snapshot
// so the UI still works. Once a real sync runs, the JSON is no longer consulted.
type QboVendor = { Id: string; DisplayName: string; CompanyName?: string; Active?: boolean };

// Cold-start fallback resolution order:
//   1. private_assets/qbo_vendors_live.json (written after each successful QBO sync)
//   2. The bundled server/data/qbo_vendors.json snapshot (200 vendors, baked at build)
// Once the qbo_vendors_cache table has rows, neither is consulted.
function loadFallbackVendors(): { source: string; vendors: QboVendor[] } {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const pathMod = require("node:path") as typeof import("node:path");
    const livePath = pathMod.resolve(process.cwd(), "private_assets", "qbo_vendors_live.json");
    if (fs.existsSync(livePath)) {
      const raw = JSON.parse(fs.readFileSync(livePath, "utf8"));
      const list: QboVendor[] = (raw?.result?.QueryResponse?.Vendor || []).map((v: any) => ({
        Id: v.Id,
        DisplayName: v.DisplayName,
        CompanyName: v.CompanyName,
        Active: v.Active,
      }));
      if (list.length > 0) return { source: `live snapshot (${raw.saved_at || "unknown date"})`, vendors: list };
    }
  } catch (e: any) {
    console.warn("[qbo] Could not read live vendor snapshot:", e?.message || e);
  }
  const bundled: QboVendor[] = ((qboVendorsData as any)?.result?.QueryResponse?.Vendor || []).map((v: any) => ({
    Id: v.Id,
    DisplayName: v.DisplayName,
    CompanyName: v.CompanyName,
    Active: v.Active,
  }));
  return { source: "bundled JSON", vendors: bundled };
}

const { source: _fallbackSource, vendors: fallbackVendors } = loadFallbackVendors();
console.log(`[qbo] Static fallback list: ${fallbackVendors.length} vendors from ${_fallbackSource} (active until first API sync)`);

function readVendorsFromCache(): QboVendor[] {
  try {
    const rows = sqlite.prepare(
      "SELECT id, display_name, company_name, active FROM qbo_vendors_cache ORDER BY display_name COLLATE NOCASE ASC"
    ).all() as { id: string; display_name: string; company_name: string | null; active: number }[];
    return rows.map((r) => ({
      Id: r.id,
      DisplayName: r.display_name,
      CompanyName: r.company_name || undefined,
      Active: r.active === 1,
    }));
  } catch {
    return [];
  }
}

function effectiveVendors(): QboVendor[] {
  const cached = readVendorsFromCache();
  return cached.length > 0 ? cached : fallbackVendors;
}

export function searchQboVendors(q: string, limit = 50): QboVendor[] {
  const list = effectiveVendors();
  if (!q) return list.slice(0, limit);
  const lower = q.toLowerCase();
  return list.filter((v) => v.DisplayName?.toLowerCase().includes(lower)).slice(0, limit);
}

export function getAllQboVendors(): QboVendor[] {
  return effectiveVendors();
}

/** Normalize a vendor string for fuzzy matching. Strips punctuation, suffixes, whitespace. */
function normalizeVendor(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\.,'’"]/g, "")
    .replace(/\b(inc|llc|llp|ltd|corp|corporation|co|company|the|and|&|usa|us|inc\.)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Smart-match a parsed vendor name against:
 *  1. vendor_aliases table (exact alias_lower hit) — returns "aliased"
 *  2. QBO vendor list — normalized exact match — returns "matched"
 *  3. QBO vendor list — substring/contains match either direction — returns "matched" if unique
 * Returns null if no confident match.
 */
export function smartMatchVendor(rawName: string | null | undefined): {
  vendor_qbo_id: string;
  vendor_qbo_name: string;
  vendor_match_status: "matched" | "aliased";
} | null {
  if (!rawName) return null;
  const trimmed = rawName.trim();
  if (!trimmed) return null;

  // 1. Alias table — exact hit on alias_lower (full raw name)
  const lower = trimmed.toLowerCase();
  const aliasHit = sqlite
    .prepare(`SELECT vendor_qbo_id, vendor_name FROM vendor_aliases WHERE alias_lower = ? LIMIT 1`)
    .get(lower) as { vendor_qbo_id: string; vendor_name: string } | undefined;
  if (aliasHit) {
    return {
      vendor_qbo_id: aliasHit.vendor_qbo_id,
      vendor_qbo_name: aliasHit.vendor_name,
      vendor_match_status: "aliased",
    };
  }

  // Build candidate name segments by splitting on slash, ampersand, " and ", comma, pipe, dash.
  // E.g. "B Robinson LLC / Revo" → ["B Robinson LLC / Revo", "B Robinson LLC", "Revo"]
  const segments = splitVendorSegments(trimmed);

  const qboVendors = effectiveVendors();

  // 1b. Try alias table for each segment
  for (const seg of segments) {
    const segLower = seg.toLowerCase();
    if (segLower === lower) continue; // already tried
    const segHit = sqlite
      .prepare(`SELECT vendor_qbo_id, vendor_name FROM vendor_aliases WHERE alias_lower = ? LIMIT 1`)
      .get(segLower) as { vendor_qbo_id: string; vendor_name: string } | undefined;
    if (segHit) {
      return {
        vendor_qbo_id: segHit.vendor_qbo_id,
        vendor_qbo_name: segHit.vendor_name,
        vendor_match_status: "aliased",
      };
    }
  }

  // 2-4. For each segment, try normalized exact / contains / first-two-word match
  for (const seg of segments) {
    const normRaw = normalizeVendor(seg);
    if (!normRaw) continue;

    // 2. Normalized exact match
    const exactMatches = qboVendors.filter((v) => normalizeVendor(v.DisplayName || "") === normRaw);
    if (exactMatches.length === 1) {
      return {
        vendor_qbo_id: exactMatches[0].Id,
        vendor_qbo_name: exactMatches[0].DisplayName,
        vendor_match_status: "matched",
      };
    }

    // 3. Substring contains (either direction) — unique only
    const containsMatches = qboVendors.filter((v) => {
      const nv = normalizeVendor(v.DisplayName || "");
      if (!nv) return false;
      return nv.includes(normRaw) || normRaw.includes(nv);
    });
    if (containsMatches.length === 1) {
      return {
        vendor_qbo_id: containsMatches[0].Id,
        vendor_qbo_name: containsMatches[0].DisplayName,
        vendor_match_status: "matched",
      };
    }

    // 4. First-two-word match — unique only
    const firstTwoWords = normRaw.split(" ").slice(0, 2).join(" ");
    if (firstTwoWords && firstTwoWords.length > 4) {
      const fwMatches = qboVendors.filter((v) => {
        const nv = normalizeVendor(v.DisplayName || "");
        return nv.startsWith(firstTwoWords);
      });
      if (fwMatches.length === 1) {
        return {
          vendor_qbo_id: fwMatches[0].Id,
          vendor_qbo_name: fwMatches[0].DisplayName,
          vendor_match_status: "matched",
        };
      }
    }
  }

  return null;
}

/**
 * Split a raw vendor name into candidate segments to try independently.
 * Useful for inputs like "B Robinson LLC / Revo" or "Smith & Jones".
 */
function splitVendorSegments(raw: string): string[] {
  const out = new Set<string>();
  out.add(raw.trim());
  const splitters = ["/", "|", ",", " - ", " – ", " — ", " & ", " and ", " dba ", " DBA ", " d/b/a "];
  let parts: string[] = [raw];
  for (const sep of splitters) {
    const next: string[] = [];
    for (const p of parts) {
      if (p.toLowerCase().includes(sep.toLowerCase())) {
        const lower = p.toLowerCase();
        const sepLower = sep.toLowerCase();
        let cursor = 0;
        const segs: string[] = [];
        while (true) {
          const idx = lower.indexOf(sepLower, cursor);
          if (idx === -1) { segs.push(p.slice(cursor)); break; }
          segs.push(p.slice(cursor, idx));
          cursor = idx + sep.length;
        }
        next.push(...segs);
      } else {
        next.push(p);
      }
    }
    parts = next;
  }
  for (const p of parts) {
    const t = p.trim();
    if (t.length >= 2) out.add(t);
  }
  return Array.from(out);
}

/**
 * Returns ranked vendor suggestions when smartMatchVendor returns null (or to enrich the dropdown).
 * Score = sum of token overlap × (segment-length boost). Returns top N candidates.
 */
export function rankVendorSuggestions(
  rawName: string | null | undefined,
  limit = 5,
): { vendor_qbo_id: string; vendor_qbo_name: string; score: number }[] {
  if (!rawName) return [];
  const trimmed = rawName.trim();
  if (!trimmed) return [];
  const qboVendors = effectiveVendors();
  const segments = splitVendorSegments(trimmed);
  const tokenSet = new Set<string>();
  for (const seg of segments) {
    const norm = normalizeVendor(seg);
    for (const t of norm.split(" ")) {
      if (t.length >= 3) tokenSet.add(t);
    }
  }
  if (tokenSet.size === 0) return [];
  const scored = qboVendors.map((v) => {
    const nv = normalizeVendor(v.DisplayName || "");
    const cn = normalizeVendor(v.CompanyName || "");
    let score = 0;
    for (const tok of tokenSet) {
      if (nv === tok) score += 10;
      else if (nv.split(" ").includes(tok)) score += 5 + Math.min(tok.length, 8);
      else if (nv.includes(tok)) score += 2 + Math.min(tok.length, 6);
      if (cn && cn.includes(tok)) score += 1;
    }
    return { vendor_qbo_id: v.Id, vendor_qbo_name: v.DisplayName, score };
  });
  return scored
    .filter((s) => s.score >= 5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Reject obviously-bad alias keys before they hit the alias table.
 * Catches the literal strings "null"/"none"/"unknown" that show up when
 * the LLM parser failed and silently set vendor_raw_name=null, then the user
 * picked a vendor in the drawer (which used to save the literal string "null"
 * as the alias key).
 */
export function isBogusAliasKey(rawName: string | null | undefined): boolean {
  const t = (rawName ?? "").trim().toLowerCase();
  if (!t) return true;
  if (t.length < 3) return true;
  if (["null", "none", "unknown", "n/a", "na", "undefined"].includes(t)) return true;
  return false;
}

/** Save a learned alias when the user picks a vendor for an unmatched raw name. */
export function learnVendorAlias(
  rawName: string,
  vendorQboId: string,
  vendorName: string,
  note: string = "learned-from-user-pick",
): void {
  const trimmed = (rawName || "").trim();
  if (!trimmed) return;
  if (isBogusAliasKey(trimmed)) {
    console.warn(`[Alias] Refusing to save bogus alias key: ${JSON.stringify(trimmed)}`);
    return;
  }
  const lower = trimmed.toLowerCase();
  const existing = sqlite.prepare(`SELECT id FROM vendor_aliases WHERE alias_lower = ? LIMIT 1`).get(lower) as { id: number } | undefined;
  if (existing) {
    sqlite.prepare(`UPDATE vendor_aliases SET vendor_qbo_id = ?, vendor_name = ?, note = ? WHERE id = ?`)
      .run(vendorQboId, vendorName, note, existing.id);
  } else {
    sqlite.prepare(`INSERT INTO vendor_aliases (alias, alias_lower, vendor_qbo_id, vendor_name, note, created_at) VALUES (?,?,?,?,?,?)`)
      .run(trimmed, lower, vendorQboId, vendorName, note, new Date().toISOString());
  }
}

/** One-time backfill of vendor_aliases from already-posted invoices that have a vendor_qbo_id. */
export function backfillVendorAliasesFromPostedInvoices(): { added: number; skipped: number } {
  const rows = sqlite.prepare(
    `SELECT DISTINCT vendor_raw_name, vendor_qbo_id, vendor_qbo_name
     FROM invoices
     WHERE vendor_raw_name IS NOT NULL AND TRIM(vendor_raw_name) != ''
       AND vendor_qbo_id IS NOT NULL
       AND status IN ('posted_qbo', 'approved_local')`
  ).all() as { vendor_raw_name: string; vendor_qbo_id: string; vendor_qbo_name: string }[];
  let added = 0;
  let skipped = 0;
  for (const r of rows) {
    const lower = r.vendor_raw_name.trim().toLowerCase();
    if (!lower) { skipped++; continue; }
    const existing = sqlite.prepare(`SELECT id FROM vendor_aliases WHERE alias_lower = ? LIMIT 1`).get(lower) as { id: number } | undefined;
    if (existing) { skipped++; continue; }
    sqlite.prepare(`INSERT INTO vendor_aliases (alias, alias_lower, vendor_qbo_id, vendor_name, note, created_at) VALUES (?,?,?,?,?,?)`)
      .run(r.vendor_raw_name.trim(), lower, r.vendor_qbo_id, r.vendor_qbo_name || "", "backfill-from-posted", new Date().toISOString());
    added++;
  }
  return { added, skipped };
}

/**
 * Map LLM's store_hint ("Greenvale"/"Hempstead"/"Huntington"/"unknown") to a StoreKey.
 * If the vendor has a default_store rule, that wins over store_hint="unknown".
 */
export function resolveShipToStore(
  storeHint: string | null | undefined,
  vendorQboId: string | null | undefined,
): "greenvale" | "hempstead" | "huntington" | null {
  const lower = (storeHint || "").toLowerCase().trim();
  if (lower === "greenvale") return "greenvale";
  if (lower === "hempstead") return "hempstead";
  if (lower === "huntington") return "huntington";

  // Fall back to vendor's default_store rule
  if (vendorQboId) {
    const rule = sqlite
      .prepare(`SELECT default_store FROM vendor_rules WHERE vendor_qbo_id = ? AND default_store IS NOT NULL LIMIT 1`)
      .get(vendorQboId) as { default_store: string } | undefined;
    if (rule?.default_store) {
      const ds = rule.default_store.toLowerCase();
      if (ds === "greenvale" || ds === "hempstead" || ds === "huntington") return ds;
    }
  }
  return null;
}

// ---- Session helpers ----
import crypto from "node:crypto";

export function createSession(email: string): string {
  const token = `tok_${crypto.randomBytes(32).toString('hex')}`;
  // 1-day session lifetime per user request — must re-login daily.
  const expires = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();
  sqlite.prepare(`INSERT INTO sessions (token, email, expires_at, created_at) VALUES (?, ?, ?, ?)`)
    .run(token, email, expires, new Date().toISOString());
  return token;
}

export function getSession(token: string): Session | undefined {
  const s = sqlite.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token) as Session | undefined;
  if (!s) return undefined;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    sqlite.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return undefined;
  }
  return s;
}

export function deleteSession(token: string) {
  sqlite.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

// ---- Magic codes ----
export function createMagicCode(email: string): string {
  const code = String(crypto.randomInt(100000, 1000000));
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  sqlite.prepare(`INSERT INTO magic_codes (email, code, expires_at, used) VALUES (?, ?, ?, 0)`)
    .run(email, code, expires);
  return code;
}

export function verifyMagicCode(email: string, code: string): boolean {
  const row = sqlite.prepare(
    `SELECT * FROM magic_codes WHERE email = ? AND code = ? AND used = 0 ORDER BY id DESC LIMIT 1`,
  ).get(email, code) as { id: number; expires_at: string } | undefined;
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  sqlite.prepare(`UPDATE magic_codes SET used = 1 WHERE id = ?`).run(row.id);
  return true;
}

// ---- Invoice helpers ----
export function listInvoices(filters: {
  status?: string;
  vendor_qbo_id?: string;
  ship_to_store?: string;
  confidence?: string;
  // Round 7: doc-type filter on Inbox + All Invoices.
  // "invoices" => is_credit = 0 (or NULL); "credits" => is_credit = 1
  doc_type?: "invoices" | "credits";
} = {}): Invoice[] {
  const conds: string[] = [];
  const args: any[] = [];
  if (filters.status) { conds.push("status = ?"); args.push(filters.status); }
  if (filters.vendor_qbo_id) { conds.push("vendor_qbo_id = ?"); args.push(filters.vendor_qbo_id); }
  if (filters.ship_to_store) { conds.push("ship_to_store = ?"); args.push(filters.ship_to_store); }
  if (filters.confidence) { conds.push("parse_confidence = ?"); args.push(filters.confidence); }
  if (filters.doc_type === "invoices") { conds.push("(is_credit IS NULL OR is_credit = 0)"); }
  else if (filters.doc_type === "credits") { conds.push("is_credit = 1"); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  return sqlite.prepare(`SELECT * FROM invoices ${where} ORDER BY created_at DESC`).all(...args) as Invoice[];
}

export function getInvoice(id: string): Invoice | undefined {
  return sqlite.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id) as Invoice | undefined;
}

export function getLineItems(invoiceId: string): InvoiceLineItem[] {
  return sqlite.prepare(`SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY id`).all(invoiceId) as InvoiceLineItem[];
}

export function getAuditLog(invoiceId: string) {
  return sqlite.prepare(`SELECT * FROM audit_log WHERE invoice_id = ? ORDER BY id DESC`).all(invoiceId);
}

export function appendAuditLog(invoiceId: string, action: string, before: any, after: any, userEmail: string) {
  sqlite.prepare(`INSERT INTO audit_log (invoice_id, action, before, after, user_email, created_at) VALUES (?,?,?,?,?,?)`)
    .run(invoiceId, action, JSON.stringify(before ?? null), JSON.stringify(after ?? null), userEmail, new Date().toISOString());
}

export function updateInvoice(id: string, patch: Partial<Invoice>): Invoice | undefined {
  const before = getInvoice(id);
  if (!before) return undefined;
  const fields = Object.keys(patch).filter((k) => k !== "id");
  if (fields.length === 0) return before;
  const setSql = fields.map((k) => `${k} = ?`).join(", ");
  const args = fields.map((k) => (patch as any)[k]);
  sqlite.prepare(`UPDATE invoices SET ${setSql}, updated_at = ? WHERE id = ?`).run(...args, new Date().toISOString(), id);
  return getInvoice(id);
}

export function setLineItemStore(lineId: number, store: string | null) {
  sqlite.prepare(`UPDATE invoice_line_items SET store_assignment = ? WHERE id = ?`).run(store, lineId);
}

/**
 * Replace all line items for an invoice with the given list. Preserves prior
 * store_assignment values when description+amount match (so re-parsing doesn't
 * lose user routing decisions).
 */
export function replaceInvoiceLineItems(
  invoiceId: string,
  items: Array<{ sku?: string | null; description?: string | null; quantity?: number | null; qty?: number | null; unit_price?: number | null; amount?: number | null; suggested_category?: string | null; is_freight?: number | boolean }>
): void {
  // Snapshot existing assignments by description+amount key.
  const prior = sqlite.prepare(
    `SELECT description, amount, store_assignment FROM invoice_line_items WHERE invoice_id = ?`
  ).all(invoiceId) as Array<{ description: string | null; amount: number | null; store_assignment: string | null }>;
  const priorMap = new Map<string, string>();
  for (const p of prior) {
    if (p.store_assignment) {
      const key = `${(p.description || "").trim().toLowerCase()}|${Number(p.amount || 0).toFixed(2)}`;
      priorMap.set(key, p.store_assignment);
    }
  }

  const tx = sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM invoice_line_items WHERE invoice_id = ?`).run(invoiceId);
    const ins = sqlite.prepare(`
      INSERT INTO invoice_line_items (invoice_id, sku, description, qty, unit_price, amount, store_assignment, is_freight)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const li of items || []) {
      const description = (li.description || "").toString();
      const amount = li.amount == null ? null : Number(li.amount);
      const isFreight = li.is_freight ? 1 : (String(li.suggested_category || "").toLowerCase() === "freight" ? 1 : 0);
      const key = `${description.trim().toLowerCase()}|${Number(amount || 0).toFixed(2)}`;
      const carriedStore = priorMap.get(key) || null;
      ins.run(
        invoiceId,
        li.sku ?? null,
        description,
        li.qty != null ? li.qty : (li.quantity != null ? li.quantity : null),
        li.unit_price ?? null,
        amount,
        carriedStore,
        isFreight
      );
    }
  });
  tx();
}

/**
 * One-time backfill: invoices that have line_items_json but no rows in
 * invoice_line_items get their lines populated. Safe to call on every server
 * boot — only runs for invoices missing rows.
 */
export function backfillLineItemsFromJson(): { invoices: number; lines: number } {
  const rows = sqlite.prepare(
    `SELECT id, line_items_json FROM invoices WHERE line_items_json IS NOT NULL AND line_items_json != '' AND line_items_json != 'null'`
  ).all() as Array<{ id: string; line_items_json: string | null }>;
  let invoices = 0;
  let lines = 0;
  for (const r of rows) {
    const has = sqlite.prepare(`SELECT 1 FROM invoice_line_items WHERE invoice_id = ? LIMIT 1`).get(r.id);
    if (has) continue;
    let parsed: any = null;
    try { parsed = JSON.parse(r.line_items_json || "[]"); } catch { continue; }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    replaceInvoiceLineItems(r.id, parsed);
    invoices += 1;
    lines += parsed.length;
  }
  return { invoices, lines };
}

export function listRules(): VendorRule[] {
  return sqlite.prepare(`SELECT * FROM vendor_rules ORDER BY vendor_name`).all() as VendorRule[];
}
export function createRule(data: Partial<VendorRule>): VendorRule {
  const now = new Date().toISOString();
  const r = sqlite.prepare(`
    INSERT INTO vendor_rules (vendor_qbo_id, vendor_name, rule_type, default_store, split_data, note, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?) RETURNING *
  `).get(
    data.vendor_qbo_id ?? null,
    data.vendor_name ?? null,
    data.rule_type ?? null,
    data.default_store ?? null,
    data.split_data ?? null,
    data.note ?? null,
    now, now,
  ) as VendorRule;
  return r;
}
export function updateRule(id: number, data: Partial<VendorRule>): VendorRule | undefined {
  const fields = Object.keys(data).filter((k) => k !== "id" && k !== "created_at");
  if (fields.length === 0) return sqlite.prepare(`SELECT * FROM vendor_rules WHERE id = ?`).get(id) as VendorRule;
  const setSql = fields.map((k) => `${k} = ?`).join(", ");
  const args = fields.map((k) => (data as any)[k]);
  sqlite.prepare(`UPDATE vendor_rules SET ${setSql}, updated_at = ? WHERE id = ?`).run(...args, new Date().toISOString(), id);
  return sqlite.prepare(`SELECT * FROM vendor_rules WHERE id = ?`).get(id) as VendorRule | undefined;
}
export function deleteRule(id: number) {
  sqlite.prepare(`DELETE FROM vendor_rules WHERE id = ?`).run(id);
}

export function listAliases(): VendorAlias[] {
  return sqlite.prepare(`SELECT * FROM vendor_aliases ORDER BY alias`).all() as VendorAlias[];
}
export function createAlias(data: Partial<VendorAlias>): VendorAlias {
  if (isBogusAliasKey(data.alias)) {
    throw new Error(`Refusing to create alias for bogus key: ${JSON.stringify(data.alias ?? null)}. Alias must be at least 3 characters and not be a placeholder like "null" or "unknown".`);
  }
  const now = new Date().toISOString();
  return sqlite.prepare(`
    INSERT INTO vendor_aliases (alias, alias_lower, vendor_qbo_id, vendor_name, note, created_at)
    VALUES (?,?,?,?,?,?) RETURNING *
  `).get(
    (data.alias || "").trim(),
    (data.alias || "").trim().toLowerCase(),
    data.vendor_qbo_id ?? null,
    data.vendor_name ?? null,
    data.note ?? null,
    now,
  ) as VendorAlias;
}
export function deleteAlias(id: number) {
  sqlite.prepare(`DELETE FROM vendor_aliases WHERE id = ?`).run(id);
}
export function deleteAliasByLowerName(name: string): number {
  if (!name) return 0;
  const info = sqlite.prepare(`DELETE FROM vendor_aliases WHERE alias_lower = ?`).run(name.toLowerCase());
  return info.changes ?? 0;
}

// ---- Invoice notes (append-only log) ----
export interface InvoiceNote {
  id: number;
  invoice_id: string;
  user_email: string | null;
  text: string;
  created_at: string;
}

export function listInvoiceNotes(invoiceId: string): InvoiceNote[] {
  return sqlite.prepare(`SELECT * FROM invoice_notes WHERE invoice_id = ? ORDER BY id ASC`).all(invoiceId) as InvoiceNote[];
}

export function createInvoiceNote(invoiceId: string, userEmail: string | null, text: string): InvoiceNote {
  return sqlite.prepare(
    `INSERT INTO invoice_notes (invoice_id, user_email, text, created_at) VALUES (?, ?, ?, ?) RETURNING *`
  ).get(invoiceId, userEmail, text, new Date().toISOString()) as InvoiceNote;
}


// ============================================================================
// RBAC HELPERS (PR #7)
// ----------------------------------------------------------------------------
// CRUD helpers for roles, permissions, role_permissions, user_roles.
// All idempotent for upserts where possible. System roles get extra guarding
// at the API layer.
// ============================================================================

export type RoleRow = {
  id: number;
  name: string;
  description: string | null;
  is_system: number;
  created_at: string | null;
};

export type PermissionRow = {
  id: number;
  key: string;
  module: string;
  label: string;
  description: string | null;
};

export type UserRoleRow = {
  id: number;
  user_id: number;
  role_id: number;
  entity_id_scope: number | null;
  created_at: string | null;
};

export type PayrollEntityRow = {
  id: number;
  location: string;
  legal_name: string;
  cadence: string;
  adp_company_code: string | null;
  commissions_enabled: number;
  pms_enabled: number;
  tips_enabled: number;
  easyrent_enabled: number;
  spif_enabled: number;
  active: number;
  created_at: string | null;
  updated_at: string | null;
};

// ----- Read helpers -----

export function listRoles(): RoleRow[] {
  return sqlite.prepare(`SELECT * FROM roles ORDER BY is_system DESC, name ASC`).all() as RoleRow[];
}

export function getRoleById(id: number): RoleRow | null {
  return (sqlite.prepare(`SELECT * FROM roles WHERE id = ? LIMIT 1`).get(id) as RoleRow) || null;
}

export function getRoleByName(name: string): RoleRow | null {
  return (sqlite.prepare(`SELECT * FROM roles WHERE name = ? LIMIT 1`).get(name) as RoleRow) || null;
}

export function listPermissions(): PermissionRow[] {
  return sqlite.prepare(`SELECT * FROM permissions ORDER BY module ASC, key ASC`).all() as PermissionRow[];
}

export function listPermissionsForRole(roleId: number): PermissionRow[] {
  return sqlite.prepare(`
    SELECT p.* FROM permissions p
    JOIN role_permissions rp ON rp.permission_id = p.id
    WHERE rp.role_id = ?
    ORDER BY p.module, p.key
  `).all(roleId) as PermissionRow[];
}

export function listUserRolesForUser(userId: number): Array<UserRoleRow & { role_name: string; role_is_system: number }> {
  return sqlite.prepare(`
    SELECT ur.*, r.name AS role_name, r.is_system AS role_is_system
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ?
    ORDER BY r.name ASC
  `).all(userId) as any[];
}

export function listAllUserRoles(): Array<UserRoleRow & { user_email: string; role_name: string; entity_location: string | null }> {
  return sqlite.prepare(`
    SELECT
      ur.*,
      u.email AS user_email,
      r.name AS role_name,
      e.location AS entity_location
    FROM user_roles ur
    JOIN app_users u ON u.id = ur.user_id
    JOIN roles r ON r.id = ur.role_id
    LEFT JOIN payroll_entities e ON e.id = ur.entity_id_scope
    ORDER BY u.email, r.name
  `).all() as any[];
}

export function listPayrollEntities(): PayrollEntityRow[] {
  return sqlite.prepare(
    `SELECT * FROM payroll_entities WHERE active = 1 ORDER BY location ASC`
  ).all() as PayrollEntityRow[];
}

// ----- Write helpers -----

export function createRole(name: string, description: string | null): RoleRow {
  const now = new Date().toISOString();
  const info = sqlite.prepare(
    `INSERT INTO roles (name, description, is_system, created_at) VALUES (?, ?, 0, ?)`
  ).run(name, description, now);
  return getRoleById(Number(info.lastInsertRowid))!;
}

export function updateRole(id: number, patch: { name?: string; description?: string | null }): RoleRow | null {
  const role = getRoleById(id);
  if (!role) return null;
  const next = {
    name: patch.name ?? role.name,
    description: patch.description !== undefined ? patch.description : role.description,
  };
  sqlite.prepare(`UPDATE roles SET name = ?, description = ? WHERE id = ?`)
    .run(next.name, next.description, id);
  return getRoleById(id);
}

export function deleteRole(id: number): boolean {
  const role = getRoleById(id);
  if (!role) return false;
  if (role.is_system) return false; // guarded at API layer too
  sqlite.prepare(`DELETE FROM roles WHERE id = ?`).run(id);
  return true;
}

/**
 * Replace a role's permission set with the given list of permission keys.
 * Atomic — wraps INSERT+DELETE in a transaction so a failure leaves the role's
 * old permissions intact.
 */
export function setRolePermissions(roleId: number, permissionKeys: string[]): void {
  const txn = sqlite.transaction((keys: string[]) => {
    sqlite.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).run(roleId);
    const ins = sqlite.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT ?, id FROM permissions WHERE key = ?
    `);
    for (const k of keys) ins.run(roleId, k);
  });
  txn(permissionKeys);
}

/**
 * Replace a user's role assignments with the given list. Each entry is
 * (role_id, entity_id_scope | null). Atomic.
 */
export function setUserRoles(
  userId: number,
  assignments: Array<{ role_id: number; entity_id_scope: number | null }>
): void {
  const now = new Date().toISOString();
  const txn = sqlite.transaction((items: typeof assignments) => {
    sqlite.prepare(`DELETE FROM user_roles WHERE user_id = ?`).run(userId);
    const ins = sqlite.prepare(`
      INSERT OR IGNORE INTO user_roles (user_id, role_id, entity_id_scope, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const a of items) ins.run(userId, a.role_id, a.entity_id_scope, now);
  });
  txn(assignments);
}

// ============================================================================
// PR #9 — Entities & processing-fee helpers
// ----------------------------------------------------------------------------
// listPayrollEntities() (defined above) returns ACTIVE entities only. The admin
// UI needs to see inactive ones too — use listAllPayrollEntities() for that.
// ============================================================================

export function listAllPayrollEntities(): PayrollEntityRow[] {
  return sqlite
    .prepare(`SELECT * FROM payroll_entities ORDER BY active DESC, location ASC`)
    .all() as PayrollEntityRow[];
}

export function getPayrollEntityById(id: number): PayrollEntityRow | null {
  return (
    (sqlite
      .prepare(`SELECT * FROM payroll_entities WHERE id = ? LIMIT 1`)
      .get(id) as PayrollEntityRow) || null
  );
}

/**
 * Partial update of a payroll entity. Only whitelisted fields are accepted to
 * avoid surprise overwrites of bookkeeping columns (id, created_at, etc).
 * Returns the fresh row.
 */
export function updatePayrollEntity(
  id: number,
  patch: Partial<{
    location: string;
    legal_name: string;
    cadence: string;
    adp_company_code: string | null;
    commissions_enabled: number;
    pms_enabled: number;
    tips_enabled: number;
    easyrent_enabled: number;
    spif_enabled: number;
    active: number;
  }>,
): PayrollEntityRow | null {
  const allowed: Array<keyof typeof patch> = [
    "location", "legal_name", "cadence", "adp_company_code",
    "commissions_enabled", "pms_enabled", "tips_enabled",
    "easyrent_enabled", "spif_enabled", "active",
  ];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(patch[k] as any);
    }
  }
  if (sets.length === 0) return getPayrollEntityById(id);
  sets.push(`updated_at = ?`);
  vals.push(new Date().toISOString());
  vals.push(id);
  sqlite.prepare(`UPDATE payroll_entities SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getPayrollEntityById(id);
}

// ----- Processing fees (CC fee on tips, etc.) -----

export type ProcessingFeeRow = {
  id: number;
  entity_id: number;
  fee_kind: string;
  fee_pct: number;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at: string | null;
};

/**
 * List all processing-fee history rows for an entity (newest effective_from
 * first). The UI shows the most recent as "current" but keeps history
 * visible so the owner can see when the rate changed.
 */
export function listProcessingFees(entityId: number): ProcessingFeeRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM payroll_entity_processing_fees
       WHERE entity_id = ?
       ORDER BY effective_from DESC, id DESC`,
    )
    .all(entityId) as ProcessingFeeRow[];
}

/**
 * Resolve the fee % in effect for a given date (defaults to today).
 * Returns null when no fee row applies (e.g. Huntington/Hempstead don't take
 * tips, so they have no fee history).
 */
export function getEffectiveProcessingFee(
  entityId: number,
  feeKind: string,
  onDate?: string,
): ProcessingFeeRow | null {
  const d = onDate || new Date().toISOString().slice(0, 10);
  return (
    (sqlite
      .prepare(
        `SELECT * FROM payroll_entity_processing_fees
         WHERE entity_id = ? AND fee_kind = ?
           AND effective_from <= ?
           AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC
         LIMIT 1`,
      )
      .get(entityId, feeKind, d, d) as ProcessingFeeRow) || null
  );
}

/**
 * Add a new fee row, automatically closing out the previous row of the same
 * kind by setting its effective_to to one day before the new effective_from.
 * This keeps history intact (an old payroll run can still resolve the rate
 * that was in effect at the time).
 */
export function addProcessingFee(
  entityId: number,
  feeKind: string,
  feePct: number,
  effectiveFrom: string,
  note: string | null,
): ProcessingFeeRow {
  const now = new Date().toISOString();
  const txn = sqlite.transaction(() => {
    // Close out the current open fee row, if any.
    const dayBefore = new Date(effectiveFrom + "T00:00:00Z");
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const closeDate = dayBefore.toISOString().slice(0, 10);
    sqlite
      .prepare(
        `UPDATE payroll_entity_processing_fees
         SET effective_to = ?
         WHERE entity_id = ? AND fee_kind = ? AND effective_to IS NULL
           AND effective_from < ?`,
      )
      .run(closeDate, entityId, feeKind, effectiveFrom);
    sqlite
      .prepare(
        `INSERT INTO payroll_entity_processing_fees
           (entity_id, fee_kind, fee_pct, effective_from, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entityId, feeKind, feePct, effectiveFrom, note, now);
  });
  txn();
  return (sqlite
    .prepare(
      `SELECT * FROM payroll_entity_processing_fees
       WHERE entity_id = ? AND fee_kind = ?
       ORDER BY effective_from DESC, id DESC LIMIT 1`,
    )
    .get(entityId, feeKind) as ProcessingFeeRow);
}

// ============================================================================
// PR #10 — Employee helpers
// ============================================================================

export type EmployeeRow = {
  id: number;
  entity_id: number;
  full_name: string;
  email: string | null;
  shopify_staff_member_id: string | null;
  easyrent_clerk_guid: string | null;
  ltm_clerk_id: string | null;
  adp_employee_id: string | null;
  commission_rate_pct: number | null;
  active: number;
  hired_at: string | null;
  terminated_at: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export function listEmployees(opts?: { entityId?: number; includeInactive?: boolean }): EmployeeRow[] {
  const wheres: string[] = [];
  const args: any[] = [];
  if (opts?.entityId !== undefined) {
    wheres.push(`entity_id = ?`);
    args.push(opts.entityId);
  }
  if (!opts?.includeInactive) {
    wheres.push(`active = 1`);
  }
  const sql = `
    SELECT * FROM payroll_employees
    ${wheres.length ? "WHERE " + wheres.join(" AND ") : ""}
    ORDER BY active DESC, full_name ASC
  `;
  return sqlite.prepare(sql).all(...args) as EmployeeRow[];
}

export function getEmployeeById(id: number): EmployeeRow | null {
  return (
    (sqlite
      .prepare(`SELECT * FROM payroll_employees WHERE id = ? LIMIT 1`)
      .get(id) as EmployeeRow) || null
  );
}

export function createEmployee(emp: {
  entity_id: number;
  full_name: string;
  email?: string | null;
  shopify_staff_member_id?: string | null;
  easyrent_clerk_guid?: string | null;
  ltm_clerk_id?: string | null;
  adp_employee_id?: string | null;
  commission_rate_pct?: number | null;
  active?: number;
  hired_at?: string | null;
  notes?: string | null;
}): EmployeeRow {
  const now = new Date().toISOString();
  const info = sqlite
    .prepare(
      `INSERT INTO payroll_employees
         (entity_id, full_name, email, shopify_staff_member_id, easyrent_clerk_guid,
          ltm_clerk_id, adp_employee_id, commission_rate_pct, active,
          hired_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      emp.entity_id,
      emp.full_name,
      emp.email ?? null,
      emp.shopify_staff_member_id ?? null,
      emp.easyrent_clerk_guid ?? null,
      emp.ltm_clerk_id ?? null,
      emp.adp_employee_id ?? null,
      emp.commission_rate_pct ?? null,
      emp.active ?? 1,
      emp.hired_at ?? null,
      emp.notes ?? null,
      now,
      now,
    );
  return getEmployeeById(Number(info.lastInsertRowid))!;
}

export function updateEmployee(
  id: number,
  patch: Partial<Omit<EmployeeRow, "id" | "created_at" | "updated_at">>,
): EmployeeRow | null {
  const allowed: Array<keyof typeof patch> = [
    "entity_id", "full_name", "email",
    "shopify_staff_member_id", "easyrent_clerk_guid", "ltm_clerk_id",
    "adp_employee_id", "commission_rate_pct", "active",
    "hired_at", "terminated_at", "notes",
  ];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(patch[k] as any);
    }
  }
  if (sets.length === 0) return getEmployeeById(id);
  sets.push(`updated_at = ?`);
  vals.push(new Date().toISOString());
  vals.push(id);
  sqlite
    .prepare(`UPDATE payroll_employees SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
  return getEmployeeById(id);
}

/**
 * Soft-delete by setting active=0 and terminated_at=today. Hard-delete is
 * intentionally NOT exposed because employees are referenced from payroll
 * history (commissions, tips, etc.) and removing them would orphan that data.
 */
export function deactivateEmployee(id: number): EmployeeRow | null {
  const today = new Date().toISOString().slice(0, 10);
  return updateEmployee(id, { active: 0, terminated_at: today });
}

// ============================================================================
// RECONCILER STORAGE HELPERS (PR #R1)
// ----------------------------------------------------------------------------
// Minimal read/write helpers used by the API stubs in PR #R1 and the
// ingest/allocator code in PR #R2-R4. Kept tight on purpose — anything more
// elaborate (joins, rollups, etc.) will arrive with the consumer PR that
// actually needs it.
// ============================================================================

// ----- recon_settings -----

export function getReconSettings(): ReconSettings | null {
  return (sqlite
    .prepare(`SELECT * FROM recon_settings WHERE id = 1 LIMIT 1`)
    .get() as ReconSettings) || null;
}

export function updateReconSettings(
  patch: Partial<{
    default_digital_gc_allocation_policy: ReconGcAllocationPolicy;
    shopify_shop_domain: string | null;
    initial_sync_from: string;
    payout_bank_plaid_account_id: string | null;
  }>,
  updatedBy: string
): ReconSettings | null {
  // Ensure the singleton row exists (paranoia — seed should have created it).
  if (!getReconSettings()) {
    sqlite.prepare(`
      INSERT INTO recon_settings
        (id, default_digital_gc_allocation_policy, initial_sync_from, updated_at, updated_by)
      VALUES (1, 'zip_then_pro_rata', '2025-01-01', ?, ?)
    `).run(new Date().toISOString(), updatedBy);
  }
  const allowed: Array<keyof typeof patch> = [
    "default_digital_gc_allocation_policy",
    "shopify_shop_domain",
    "initial_sync_from",
    "payout_bank_plaid_account_id",
  ];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(patch[k] as any);
    }
  }
  if (sets.length === 0) return getReconSettings();
  sets.push(`updated_at = ?`);
  vals.push(new Date().toISOString());
  sets.push(`updated_by = ?`);
  vals.push(updatedBy);
  sqlite
    .prepare(`UPDATE recon_settings SET ${sets.join(", ")} WHERE id = 1`)
    .run(...vals);
  return getReconSettings();
}

// ----- recon_entity_pos_locations -----

export function listReconEntityPosLocations(): Array<
  ReconEntityPosLocation & { entity_location: string | null }
> {
  return sqlite
    .prepare(`
      SELECT l.*, e.location AS entity_location
      FROM recon_entity_pos_locations l
      LEFT JOIN payroll_entities e ON e.id = l.entity_id
      ORDER BY l.entity_id ASC, l.id ASC
    `)
    .all() as any;
}

export function setReconShopifyLocationMapping(
  id: number,
  shopify_location_id: string | null,
  shopify_location_name: string | null
): ReconEntityPosLocation | null {
  const now = new Date().toISOString();
  sqlite
    .prepare(`
      UPDATE recon_entity_pos_locations
      SET shopify_location_id = ?, shopify_location_name = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(shopify_location_id, shopify_location_name, now, id);
  return (sqlite
    .prepare(`SELECT * FROM recon_entity_pos_locations WHERE id = ? LIMIT 1`)
    .get(id) as ReconEntityPosLocation) || null;
}

// ----- recon_sync_log -----

export type ReconSyncLogRow = {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "failure";
  rows_ingested: number | null;
  cursor: string | null;
  error_message: string | null;
  triggered_by: string | null;
};

export function listReconSyncLog(limit = 50): ReconSyncLogRow[] {
  return sqlite
    .prepare(
      `SELECT * FROM recon_sync_log ORDER BY started_at DESC LIMIT ?`
    )
    .all(limit) as ReconSyncLogRow[];
}

export function startReconSync(
  kind: string,
  triggeredBy: string,
  cursor: string | null = null
): number {
  const res = sqlite
    .prepare(`
      INSERT INTO recon_sync_log (kind, started_at, status, cursor, triggered_by, rows_ingested)
      VALUES (?, ?, 'running', ?, ?, 0)
    `)
    .run(kind, new Date().toISOString(), cursor, triggeredBy);
  return Number(res.lastInsertRowid);
}

export function finishReconSync(
  id: number,
  patch: {
    status: "success" | "failure";
    rows_ingested?: number;
    cursor?: string | null;
    error_message?: string | null;
  }
): void {
  sqlite
    .prepare(`
      UPDATE recon_sync_log
      SET finished_at = ?, status = ?, rows_ingested = ?, cursor = COALESCE(?, cursor), error_message = ?
      WHERE id = ?
    `)
    .run(
      new Date().toISOString(),
      patch.status,
      patch.rows_ingested ?? 0,
      patch.cursor ?? null,
      patch.error_message ?? null,
      id,
    );
}

// ----- recon_orders / line_items / payouts -----
// Read-only stat helpers used by the API stubs (PR #R1) and the rollup UI
// (PR #R5). Heavy joins live in later PRs.

export type ReconCounts = {
  orders: number;
  line_items: number;
  payouts: number;
  balance_transactions: number;
  gift_cards: number;
  gift_card_redemptions: number;
  allocations: number;
  oldest_order_at: string | null;
  newest_order_at: string | null;
  oldest_payout_at: string | null;
  newest_payout_at: string | null;
};

export function getReconCounts(): ReconCounts {
  const c = (sql: string) =>
    (sqlite.prepare(sql).get() as { c: number }).c;
  const minMax = (sql: string) =>
    (sqlite.prepare(sql).get() as { min: string | null; max: string | null });
  const o = minMax(
    `SELECT MIN(created_at) AS min, MAX(created_at) AS max FROM recon_orders`
  );
  const p = minMax(
    `SELECT MIN(payout_date) AS min, MAX(payout_date) AS max FROM recon_payouts`
  );
  return {
    orders: c(`SELECT COUNT(*) AS c FROM recon_orders`),
    line_items: c(`SELECT COUNT(*) AS c FROM recon_line_items`),
    payouts: c(`SELECT COUNT(*) AS c FROM recon_payouts`),
    balance_transactions: c(`SELECT COUNT(*) AS c FROM recon_balance_transactions`),
    gift_cards: c(`SELECT COUNT(*) AS c FROM recon_gift_cards`),
    gift_card_redemptions: c(`SELECT COUNT(*) AS c FROM recon_gift_card_redemptions`),
    allocations: c(`SELECT COUNT(*) AS c FROM recon_allocations`),
    oldest_order_at: o.min,
    newest_order_at: o.max,
    oldest_payout_at: p.min,
    newest_payout_at: p.max,
  };
}

// ----- zip lookup + prior-year pro-rata (read helpers for now) -----

export function getZipMapping(zip: string): {
  zip: string;
  entity_id: number | null;
  distance_miles: number | null;
  source: string;
} | null {
  return (sqlite
    .prepare(`SELECT zip, entity_id, distance_miles, source FROM recon_zip_to_entity_lookup WHERE zip = ? LIMIT 1`)
    .get(zip) as any) || null;
}

export function upsertZipMapping(
  zip: string,
  entityId: number | null,
  distanceMiles: number | null,
  source: "auto" | "manual",
  updatedBy: string
): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(`
      INSERT INTO recon_zip_to_entity_lookup
        (zip, entity_id, distance_miles, source, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(zip) DO UPDATE SET
        entity_id = excluded.entity_id,
        distance_miles = excluded.distance_miles,
        source = excluded.source,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `)
    .run(zip, entityId, distanceMiles, source, now, updatedBy);
}

export function listPriorYearProRata(year: number): Array<{
  entity_id: number;
  entity_location: string | null;
  share: number;
  source_redemptions_total: number;
  frozen_at: string;
  frozen_by: string | null;
}> {
  return sqlite
    .prepare(`
      SELECT p.entity_id, e.location AS entity_location,
             p.share, p.source_redemptions_total, p.frozen_at, p.frozen_by
      FROM recon_prior_year_pro_rata p
      LEFT JOIN payroll_entities e ON e.id = p.entity_id
      WHERE p.applies_to_year = ?
      ORDER BY p.entity_id ASC
    `)
    .all(year) as any;
}

// Lightweight allocator hint used by the rollup UI in PR #R5: returns the
// allocation method enum string for a given Shopify location_id, or null if
// the location isn't mapped yet.
export function resolveEntityIdForLocation(
  shopifyLocationId: string | null
): number | null {
  if (!shopifyLocationId) return null;
  const row = sqlite
    .prepare(`
      SELECT entity_id FROM recon_entity_pos_locations
      WHERE shopify_location_id = ? AND active = 1
      LIMIT 1
    `)
    .get(shopifyLocationId) as { entity_id: number } | undefined;
  return row?.entity_id ?? null;
}

// (allocation method type is imported from @shared/schema by callers directly)

// ============================================================================
// RECON: Shopify orders + line items (PR #R2)
// ----------------------------------------------------------------------------
// Upserts are idempotent: webhook AND polling can both write the same row
// without dupes. `ingest_version` bumps on every overwrite so we can tell
// fresh vs stale at a glance during testing.
// ============================================================================

export type ReconOrderUpsert = {
  id: string;
  order_number: string | null;
  name: string | null;
  created_at: string;
  processed_at: string | null;
  updated_at: string | null;
  cancelled_at: string | null;
  closed_at: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  source_name: string | null;
  location_id: string | null;
  currency: string | null;
  subtotal: number | null;
  total_tax: number | null;
  total_discounts: number | null;
  total_shipping: number | null;
  total_tips: number | null;
  total_price: number | null;
  total_refunded: number | null;
  customer_id: string | null;
  customer_email: string | null;
  billing_zip: string | null;
  shipping_zip: string | null;
  has_gift_card: number;
  tax_channel_liable: number;
  raw_json: string;
};

export type ReconLineItemUpsert = {
  id: string;
  order_id: string;
  product_id: string | null;
  variant_id: string | null;
  sku: string | null;
  title: string | null;
  variant_title: string | null;
  quantity: number;
  price: number | null;
  total_discount: number;
  line_subtotal: number | null;
  line_tax_total: number;
  tax_channel_liable: number;
  tax_lines_json: string | null;
  is_gift_card: number;
  requires_shipping: number;
  raw_json: string;
};

/**
 * Idempotent upsert of one order. If the row exists, ingest_version is
 * incremented and all mutable columns are replaced. Designed to be safe
 * for repeated calls from both the webhook handler and the polling job.
 *
 * Returns "inserted" | "updated" so the caller (sync log) can report
 * accurate counters.
 */
export function upsertReconOrder(row: ReconOrderUpsert): "inserted" | "updated" {
  const existing = sqlite
    .prepare(`SELECT ingest_version FROM recon_orders WHERE id = ?`)
    .get(row.id) as { ingest_version: number } | undefined;

  const now = new Date().toISOString();

  if (!existing) {
    sqlite
      .prepare(`
        INSERT INTO recon_orders (
          id, order_number, name, created_at, processed_at, updated_at,
          cancelled_at, closed_at, financial_status, fulfillment_status,
          source_name, location_id, currency, subtotal, total_tax,
          total_discounts, total_shipping, total_tips, total_price,
          total_refunded, customer_id, customer_email, billing_zip,
          shipping_zip, has_gift_card, tax_channel_liable, raw_json,
          ingested_at, ingest_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `)
      .run(
        row.id, row.order_number, row.name, row.created_at, row.processed_at, row.updated_at,
        row.cancelled_at, row.closed_at, row.financial_status, row.fulfillment_status,
        row.source_name, row.location_id, row.currency, row.subtotal, row.total_tax,
        row.total_discounts, row.total_shipping, row.total_tips, row.total_price,
        row.total_refunded ?? 0, row.customer_id, row.customer_email, row.billing_zip,
        row.shipping_zip, row.has_gift_card, row.tax_channel_liable, row.raw_json,
        now,
      );
    return "inserted";
  }

  sqlite
    .prepare(`
      UPDATE recon_orders SET
        order_number = ?, name = ?, created_at = ?, processed_at = ?, updated_at = ?,
        cancelled_at = ?, closed_at = ?, financial_status = ?, fulfillment_status = ?,
        source_name = ?, location_id = ?, currency = ?, subtotal = ?, total_tax = ?,
        total_discounts = ?, total_shipping = ?, total_tips = ?, total_price = ?,
        total_refunded = ?, customer_id = ?, customer_email = ?, billing_zip = ?,
        shipping_zip = ?, has_gift_card = ?, tax_channel_liable = ?, raw_json = ?,
        ingested_at = ?, ingest_version = ingest_version + 1
      WHERE id = ?
    `)
    .run(
      row.order_number, row.name, row.created_at, row.processed_at, row.updated_at,
      row.cancelled_at, row.closed_at, row.financial_status, row.fulfillment_status,
      row.source_name, row.location_id, row.currency, row.subtotal, row.total_tax,
      row.total_discounts, row.total_shipping, row.total_tips, row.total_price,
      row.total_refunded ?? 0, row.customer_id, row.customer_email, row.billing_zip,
      row.shipping_zip, row.has_gift_card, row.tax_channel_liable, row.raw_json,
      now, row.id,
    );
  return "updated";
}

/**
 * Replace ALL line items for a given order in a single transaction. We
 * delete-then-insert instead of upserting because Shopify can reshape the
 * line item array on edits (combined items, refunds split lines, etc.) and
 * orphaned rows would corrupt downstream allocation math. Safe because the
 * order_id FK has ON DELETE CASCADE and we always re-write the full set.
 */
export function replaceReconLineItems(
  orderId: string,
  lines: ReconLineItemUpsert[],
): number {
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM recon_line_items WHERE order_id = ?`).run(orderId);
    const ins = sqlite.prepare(`
      INSERT INTO recon_line_items (
        id, order_id, product_id, variant_id, sku, title, variant_title,
        quantity, price, total_discount, line_subtotal, line_tax_total,
        tax_channel_liable, tax_lines_json, is_gift_card, requires_shipping,
        raw_json, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const li of lines) {
      ins.run(
        li.id, li.order_id, li.product_id, li.variant_id, li.sku, li.title, li.variant_title,
        li.quantity, li.price, li.total_discount, li.line_subtotal, li.line_tax_total,
        li.tax_channel_liable, li.tax_lines_json, li.is_gift_card, li.requires_shipping,
        li.raw_json, now,
      );
    }
  });
  tx();
  return lines.length;
}

/**
 * Returns the most recent `updated_at` watermark we've successfully ingested
 * via the `orders` sync log. Used to bound the polling job's `updated_at_min`
 * query parameter. Null on first run -> caller uses `initial_sync_from`.
 */
export function getReconOrdersWatermark(): string | null {
  const row = sqlite
    .prepare(`
      SELECT cursor FROM recon_sync_log
      WHERE kind = 'orders' AND status = 'success' AND cursor IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `)
    .get() as { cursor: string } | undefined;
  return row?.cursor ?? null;
}

/**
 * Returns the most recent ingested orders (id, name, created_at, totals)
 * so the testing UI / API can render a sample. Capped to keep payloads cheap.
 */
export function listReconOrdersSample(limit = 50): Array<{
  id: string;
  name: string | null;
  created_at: string;
  source_name: string | null;
  location_id: string | null;
  total_price: number | null;
  total_tax: number | null;
  financial_status: string | null;
  has_gift_card: number;
  tax_channel_liable: number;
  ingest_version: number;
  ingested_at: string;
}> {
  return sqlite
    .prepare(`
      SELECT id, name, created_at, source_name, location_id, total_price,
             total_tax, financial_status, has_gift_card, tax_channel_liable,
             ingest_version, ingested_at
      FROM recon_orders
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(Math.min(500, Math.max(1, limit))) as any;
}

/**
 * Single order detail including its line items — used by the test UI to
 * sanity-check the tax_channel_liable rollup against per-line tax_lines_json.
 */
export function getReconOrderWithLines(orderId: string): {
  order: any;
  lines: any[];
} | null {
  const order = sqlite
    .prepare(`SELECT * FROM recon_orders WHERE id = ?`)
    .get(orderId);
  if (!order) return null;
  const lines = sqlite
    .prepare(`SELECT * FROM recon_line_items WHERE order_id = ? ORDER BY id ASC`)
    .all(orderId);
  return { order, lines };
}
