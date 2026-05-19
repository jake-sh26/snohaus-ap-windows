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

