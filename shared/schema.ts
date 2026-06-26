import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// --- Invoices ---
export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  source_file: text("source_file"),
  email_id: text("email_id"),
  email_date: text("email_date"),
  email_from: text("email_from"),
  email_subject: text("email_subject"),
  pdf_url: text("pdf_url"),
  vendor_qbo_id: text("vendor_qbo_id"),
  vendor_qbo_name: text("vendor_qbo_name"),
  vendor_match_status: text("vendor_match_status"), // matched|aliased|unmatched
  vendor_raw_name: text("vendor_raw_name"),
  invoice_number: text("invoice_number"),
  invoice_date: text("invoice_date"),
  due_date: text("due_date"),
  total: real("total"),
  freight: real("freight"),
  is_credit: integer("is_credit").default(0),
  ship_to_store: text("ship_to_store"),
  parse_confidence: text("parse_confidence"),
  notes: text("notes"),
  status: text("status").notNull().default("pending_review"),
  routing_mode: text("routing_mode").notNull().default("single_store"),
  routing_data: text("routing_data"), // JSON
  duplicate_check_status: text("duplicate_check_status").default("unchecked"),
  duplicate_check_at: text("duplicate_check_at"),
  qbo_bill_id: text("qbo_bill_id"),
  approved_by: text("approved_by"),
  approved_at: text("approved_at"),
  created_at: text("created_at"),
  updated_at: text("updated_at"),
  // v8: ingest source classification — 'pdf' | 'image_ocr' | 'gmail' | 'acumatica'.
  // Drives the OCR-warning banner in the drawer for image_ocr.
  source_type: text("source_type"),
  // v8: JSON-stringified low-confidence fuzzy duplicate hint (60–89%) so the
  // user can review without blocking ingest.
  fuzzy_dup_hint: text("fuzzy_dup_hint"),
  // v8.4.5: discount-terms columns. See server/storage.ts migration for details.
  discount_terms_pct: real("discount_terms_pct"),
  discount_days: integer("discount_days"),
  discount_due_date: text("discount_due_date"),
  discount_kind: text("discount_kind"), // 'early_pay' | 'net_with_discount' | null
  discount_warning: text("discount_warning"),
  discount_applied: integer("discount_applied").default(0),
  // PR #R4k — verbatim terms phrase as printed on the invoice ("Net 30",
  // "Pre-Pay", "2% 10 Net 30"). Used by the discount/due-date fallback regexes
  // and surfaced in the AP drawer so users can sanity-check the parse.
  payment_terms: text("payment_terms"),
});

export const invoiceLineItems = sqliteTable("invoice_line_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoice_id: text("invoice_id").notNull(),
  sku: text("sku"),
  description: text("description"),
  qty: real("qty"),
  unit_price: real("unit_price"),
  amount: real("amount"),
  store_assignment: text("store_assignment"),
  is_freight: integer("is_freight").default(0),
});

export const vendorRules = sqliteTable("vendor_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vendor_qbo_id: text("vendor_qbo_id"),
  vendor_name: text("vendor_name"),
  rule_type: text("rule_type"), // 100_percent | percent_split | line_review | review
  default_store: text("default_store"),
  split_data: text("split_data"), // JSON
  note: text("note"),
  created_at: text("created_at"),
  updated_at: text("updated_at"),
});

export const vendorAliases = sqliteTable("vendor_aliases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  alias: text("alias"),
  alias_lower: text("alias_lower"),
  vendor_qbo_id: text("vendor_qbo_id"),
  vendor_name: text("vendor_name"),
  note: text("note"),
  created_at: text("created_at"),
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  email: text("email").notNull(),
  expires_at: text("expires_at").notNull(),
  created_at: text("created_at"),
});

export const magicCodes = sqliteTable("magic_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  code: text("code").notNull(),
  expires_at: text("expires_at").notNull(),
  used: integer("used").default(0),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoice_id: text("invoice_id"),
  action: text("action"),
  before: text("before"),
  after: text("after"),
  user_email: text("user_email"),
  created_at: text("created_at"),
});

// Insert schemas
export const insertInvoiceSchema = createInsertSchema(invoices);
export const insertLineItemSchema = createInsertSchema(invoiceLineItems);
export const insertVendorRuleSchema = createInsertSchema(vendorRules).omit({ id: true, created_at: true, updated_at: true });
export const insertVendorAliasSchema = createInsertSchema(vendorAliases).omit({ id: true, created_at: true });

// Types
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type VendorRule = typeof vendorRules.$inferSelect;
export type VendorAlias = typeof vendorAliases.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;

export type StoreKey = "greenvale" | "hempstead" | "huntington";

export const STORES: { key: StoreKey; label: string; qbo_account_id: string; qbo_account_name: string }[] = [
  { key: "greenvale", label: "Sno-Haus Greenvale", qbo_account_id: "38", qbo_account_name: "Inventory Asset" },
  { key: "hempstead", label: "Sno-Haus Hempstead", qbo_account_id: "1150040012", qbo_account_name: "Inventory for Hempstead" },
  { key: "huntington", label: "Sno-Haus Huntington", qbo_account_id: "1150040011", qbo_account_name: "Inventory for Huntington" },
];

// ALLOWED_EMAILS: read from env (comma-separated) or fall back to hardcoded defaults.
// In .env: ALLOWED_EMAILS=jake@snohaus.com,jake@sundowngreenvale.com,admin@snohaus.com,johnny@snohaus.com
function getAllowedEmails(): string[] {
  const env = process.env.ALLOWED_EMAILS;
  if (env) {
    return env.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  }
  return [
    "jake@snohaus.com",
    "jake@sundowngreenvale.com",
    "admin@snohaus.com",
    "johnny@snohaus.com",
  ];
}

export const ALLOWED_EMAILS = getAllowedEmails();

// ============================================================================
// PAYROLL MODULE SCHEMA
// ----------------------------------------------------------------------------
// All payroll tables are prefixed `payroll_*` to keep them visually separated
// from the AP module. They share the same SQLite database and live alongside
// the AP tables.
//
// Cadence model (locked):
//   - Commissions are computed WEEKLY (Mon – Sun) from Shopify + Easyrent.
//   - Tips, PMs, and SPIFs are computed MONTHLY and paid in the FIRST
//     weekly payroll of the following month.
//   - Only Greenvale (SD Ski and Patio Inc) produces commission/PM/SPIF lines
//     today. All three entities ingest Easyrent data; only Greenvale ingests
//     LTM tips today, but the `payroll_ltm_merchants` table is extensible.
// ============================================================================

// --- Entities (3 legal entities, one per store) ---
export const payrollEntities = sqliteTable("payroll_entities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Internal location key (e.g. "Greenvale") — stable identifier that may
  // differ from the user-facing display name (see display_name).
  // PR #194: legacy field. New code should prefer `short_name` (same data,
  // clearer purpose). Kept for one release cycle so in-flight readers don't
  // break; will be dropped in a follow-up cleanup PR.
  location: text("location").notNull(),
  // PR #194: Tight UI label (e.g. "Greenvale"). Used in Finance Monthly
  // Summary, Per Store Sales, breadcrumbs, sidebars, dropdowns, table
  // headers — anywhere a short brand label is desired. Backfilled from
  // `location` on first boot.
  short_name: text("short_name"),
  // Legal entity name used on tax docs / ADP exports (e.g. "SD Ski and Patio Inc").
  // Source of truth for ST-810 / ST-100 PDFs and any filing export.
  legal_name: text("legal_name").notNull(),
  // User-facing display label (e.g. "Sno-Haus Greenvale"). Independent from
  // `location` so the brand can change without renaming internal keys.
  // PR #192: added as part of entity source-of-truth consolidation.
  display_name: text("display_name"),
  // PR #194: NY-state registered DBA (Doing Business As) — e.g.
  // "Sno-Haus Greenvale". A LEGAL FACT, not a branding choice. Used on
  // receipts, customer-facing docs, and any legal context that requires the
  // registered trade name. Distinct from `display_name`, which is an
  // internal Ops Hub branding choice that happens to match today.
  dba: text("dba"),
  // URL/lookup slug matching the AP-side StoreKey type ("greenvale" / etc).
  // Bridges the AP module's string keys to the payroll module's integer ids.
  slug: text("slug"),
  // 'weekly' | 'biweekly' — payroll-run cadence in ADP.
  cadence: text("cadence").notNull(),
  // ADP Run company code for this entity (used to label export CSVs).
  adp_company_code: text("adp_company_code"),
  // NY/IRS Tax Identification Number (e.g. "86-3624190"). PR #192: moved
  // here from the separate entity_settings table so all entity metadata
  // lives in one row.
  tin: text("tin"),
  // Filing-jurisdiction facts (used by ST-810/ST-809 PDF + jurisdiction
  // enrichment). PR #192 lifted them out of the hardcoded ENTITY_FILING_INFO
  // const so the user can edit them; PR #198 (ST5) made this the only
  // source — the constant is gone and entity-settings.ts reads from here.
  county: text("county"),
  rate_bps: integer("rate_bps"),
  dtf_code: text("dtf_code"),
  // QBO inventory account IDs used by AP-side invoice posting. PR #192:
  // pulled from the hardcoded STORES[] const in shared/schema.ts so an
  // accountant can re-point them without a code change.
  qbo_inventory_account_id: text("qbo_inventory_account_id"),
  qbo_inventory_account_name: text("qbo_inventory_account_name"),
  // Module-level feature flags. Greenvale = all on. Huntington/Hempstead =
  // easyrent only today (commissions/pms/tips off for now).
  commissions_enabled: integer("commissions_enabled").notNull().default(0),
  pms_enabled: integer("pms_enabled").notNull().default(0),
  tips_enabled: integer("tips_enabled").notNull().default(0),
  easyrent_enabled: integer("easyrent_enabled").notNull().default(0),
  spif_enabled: integer("spif_enabled").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at"),
  updated_at: text("updated_at"),
});

// --- Employees (entity-scoped roster) ---
export const payrollEmployees = sqliteTable("payroll_employees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  full_name: text("full_name").notNull(),
  email: text("email"),
  // PR #207: contact phone. Light client-side normalization, no DB shape
  // constraint — international numbers / extensions round-trip cleanly.
  phone: text("phone"),
  // External IDs used for sales/tip attribution.
  shopify_staff_member_id: text("shopify_staff_member_id"),
  easyrent_clerk_guid: text("easyrent_clerk_guid"),
  ltm_clerk_id: text("ltm_clerk_id"),
  // ADP Run employee ID (used for CSV export row identity).
  adp_employee_id: text("adp_employee_id"),
  // Per-employee flat commission rate (e.g. 0.04 for 4%). Overrides the
  // entity default commission_rules when non-null.
  commission_rate_pct: real("commission_rate_pct"),
  active: integer("active").notNull().default(1),
  hired_at: text("hired_at"),
  terminated_at: text("terminated_at"),
  notes: text("notes"),
  // PR #208 — extended employee profile (all nullable).
  date_of_birth: text("date_of_birth"),
  address_line1: text("address_line1"),
  address_line2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postal_code: text("postal_code"),
  emergency_contact_name: text("emergency_contact_name"),
  emergency_contact_phone: text("emergency_contact_phone"),
  emergency_contact_relationship: text("emergency_contact_relationship"),
  tshirt_size: text("tshirt_size"),
  // PR #209 — pay rate + annual time-off allotments. Admin-only (gated by payroll.edit_commissions).
  hourly_rate: real("hourly_rate"),
  vacation_hours_annual: real("vacation_hours_annual"),
  sick_hours_annual: real("sick_hours_annual"),
  // PR #209 — "current" season bonus convenience fields. The authoritative
  // history lives in payroll_employee_season_bonuses; these are kept in sync
  // by the server so the table list page can render the latest bonus cheaply.
  current_season_label: text("current_season_label"),
  current_season_bonus: real("current_season_bonus"),
  created_at: text("created_at"),
  updated_at: text("updated_at"),
});

// --- Employee season bonus history (PR #209) ---
// Ski-season fiscal year: each "season" is labeled like "2025-26" and runs
// roughly Apr 1 of year N to Mar 31 of year N+1. On April 1 each year, the
// current bonus snapshots into a row here and the current_season_* fields on
// payroll_employees clear, ready for the new season — see seasonBonusRollover
// in server/season-bonuses.ts.
export const payrollEmployeeSeasonBonuses = sqliteTable("payroll_employee_season_bonuses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  employee_id: integer("employee_id").notNull(),
  // e.g. "2024-25", "2025-26". Globally unique per employee — no two rows for the same season.
  season_label: text("season_label").notNull(),
  bonus_amount: real("bonus_amount").notNull(),
  // 'closed' = snapshotted by the April-1 rollover (read-only historical).
  // 'current' is not stored here — the live season lives on payroll_employees.current_season_*.
  notes: text("notes"),
  closed_at: text("closed_at").notNull(),
  created_at: text("created_at"),
});

// --- Pay periods (per-entity rolling window of payroll runs) ---
export const payrollPayPeriods = sqliteTable("payroll_pay_periods", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  // 'weekly' | 'monthly' — drives which line types this period contains.
  kind: text("kind").notNull(),
  period_start: text("period_start").notNull(), // YYYY-MM-DD inclusive
  period_end: text("period_end").notNull(),     // YYYY-MM-DD inclusive
  // 'open' → still ingesting / editable.
  // 'locked' → ready to export, no more edits.
  // 'exported' → ADP CSV downloaded; immutable.
  status: text("status").notNull().default("open"),
  exported_at: text("exported_at"),
  exported_by: text("exported_by"),
  notes: text("notes"),
  created_at: text("created_at"),
  updated_at: text("updated_at"),
});

// --- POS locations (Shopify location_id → entity mapping) ---
export const payrollPosLocations = sqliteTable("payroll_pos_locations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  shopify_location_id: text("shopify_location_id").notNull(),
  label: text("label"), // human-readable for the UI
  active: integer("active").notNull().default(1),
});

// --- LTM merchants (Shift4 merchant_id → entity mapping) ---
// Greenvale-only today, but extensible: future stores can register their own
// Shift4 Client GUID + merchant_id here and start ingesting tips automatically.
export const payrollLtmMerchants = sqliteTable("payroll_ltm_merchants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  merchant_id: text("merchant_id").notNull(),
  client_guid: text("client_guid"), // Shift4 Client GUID (per-app credential)
  label: text("label"),
  active: integer("active").notNull().default(1),
});

// --- Entity processing fees (versioned tip-fee config) ---
// Tips paid on credit cards have the CC processing fee deducted before they
// hit ADP. Today: flat 3.8% for Greenvale. Versioned via effective_from/to
// so we can change the rate without losing historical audit trail.
export const payrollEntityProcessingFees = sqliteTable("payroll_entity_processing_fees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  // 'tip_cc_fee' is the only kind today; left flexible for future fee types.
  fee_kind: text("fee_kind").notNull().default("tip_cc_fee"),
  fee_pct: real("fee_pct").notNull(), // e.g. 0.038 for 3.8%
  effective_from: text("effective_from").notNull(), // YYYY-MM-DD inclusive
  effective_to: text("effective_to"),               // YYYY-MM-DD inclusive, null = current
  note: text("note"),
  created_at: text("created_at"),
});

// --- Shopify staff sales (PR #202) ---
// Replaces the dropped payroll_shopify_staff_weekly_totals. Driven by
// ShopifyQL's `sales` dataset, one row per
// (period, assisting_staff_id, order_name, entity_id). See
// server/shopify-staff-sales.ts + the storage.ts table comment for the
// full schema doc. Money columns are SIGNED (negative for pure-returns
// periods).
export const reconShopifyStaffSales = sqliteTable("recon_shopify_staff_sales", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  period_start: text("period_start").notNull(),
  period_end: text("period_end").notNull(),
  assisting_staff_id: text("assisting_staff_id").notNull(),
  staff_name: text("staff_name"),
  employee_id: integer("employee_id"),     // null = unmatched
  entity_id: integer("entity_id"),         // null = unallocated
  order_name: text("order_name"),
  order_id: text("order_id"),
  pos_location_name: text("pos_location_name"),
  share: real("share").notNull().default(1.0),
  quantity: real("quantity"),
  gross_sales: real("gross_sales"),
  discounts: real("discounts"),
  returns: real("returns"),
  net_sales: real("net_sales").notNull().default(0),
  taxes: real("taxes"),
  total_sales: real("total_sales"),
  allocation_method: text("allocation_method").notNull().default("unallocated"),
  raw_json: text("raw_json"),
  ingested_at: text("ingested_at").notNull(),
});

// --- Easyrent weekly staff totals (per-employee rental sales) ---
export const payrollEasyrentStaffWeeklyTotals = sqliteTable("payroll_easyrent_staff_weekly_totals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  pay_period_id: integer("pay_period_id").notNull(),
  employee_id: integer("employee_id"),
  easyrent_clerk_guid: text("easyrent_clerk_guid").notNull(),
  raw_clerk_name: text("raw_clerk_name"),
  net_sales: real("net_sales").notNull().default(0),
  ingested_at: text("ingested_at"),
});

// --- Easyrent PMs (price modifier line attributions, monthly) ---
export const payrollEasyrentPms = sqliteTable("payroll_easyrent_pms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  pay_period_id: integer("pay_period_id").notNull(),
  employee_id: integer("employee_id"),
  easyrent_clerk_guid: text("easyrent_clerk_guid"),
  transaction_date: text("transaction_date"),
  easyrent_transaction_id: text("easyrent_transaction_id"),
  pm_code: text("pm_code"),
  pm_label: text("pm_label"),
  amount: real("amount").notNull().default(0),
  ingested_at: text("ingested_at"),
});

// --- LTM tips (Shift4 tip transactions, monthly) ---
// Stores gross/fee_pct/fee_amount/net for full audit trail. ADP receives `net`.
export const payrollLtmTips = sqliteTable("payroll_ltm_tips", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  pay_period_id: integer("pay_period_id").notNull(),
  employee_id: integer("employee_id"),
  ltm_clerk_id: text("ltm_clerk_id"),
  raw_clerk_name: text("raw_clerk_name"),
  transaction_date: text("transaction_date"),
  shift4_invoice: text("shift4_invoice"), // Shift4 invoice/transaction identifier
  gross_tip: real("gross_tip").notNull().default(0),
  fee_pct: real("fee_pct").notNull().default(0),     // snapshotted at ingest from entity_processing_fees
  fee_amount: real("fee_amount").notNull().default(0),
  net_tip: real("net_tip").notNull().default(0),
  ingested_at: text("ingested_at"),
});

// --- Shopify line items eligible for SPIFs (monthly) ---
// Populated from the Shopify Orders API. The SPIF engine in PR #15 filters
// these against `payroll_spif_rules` to produce payroll_lines of kind 'spif'.
export const payrollShopifyLineItemsSpif = sqliteTable("payroll_shopify_line_items_spif", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  pay_period_id: integer("pay_period_id").notNull(),
  employee_id: integer("employee_id"),
  shopify_staff_member_id: text("shopify_staff_member_id"),
  shopify_order_id: text("shopify_order_id"),
  shopify_line_item_id: text("shopify_line_item_id"),
  order_date: text("order_date"),
  sku: text("sku"),
  product_title: text("product_title"),
  quantity: real("quantity").notNull().default(0),
  unit_price: real("unit_price"),
  // Matched SPIF rule (denormalized so refunds-after-rule-change behave
  // predictably). Null = no SPIF match.
  matched_spif_rule_id: integer("matched_spif_rule_id"),
  ingested_at: text("ingested_at"),
});

// --- SPIF rules (per-SKU bonus config) ---
export const payrollSpifRules = sqliteTable("payroll_spif_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  // Match by SKU exact, SKU prefix, or product title contains.
  match_kind: text("match_kind").notNull(), // 'sku_exact' | 'sku_prefix' | 'title_contains'
  match_value: text("match_value").notNull(),
  label: text("label"), // e.g. "BootDoc fitting"
  amount_per_unit: real("amount_per_unit").notNull(), // e.g. 3.00 for $3/each
  effective_from: text("effective_from").notNull(),
  effective_to: text("effective_to"),
  active: integer("active").notNull().default(1),
  created_at: text("created_at"),
});

// --- Commission rules (per-entity commission config) ---
// Today: flat % of net POS sales. Schema supports future tiered/threshold
// configs via `kind` + `config_json` so we don't need a migration to add.
export const payrollCommissionRules = sqliteTable("payroll_commission_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  kind: text("kind").notNull().default("flat_pct"), // 'flat_pct' | 'tiered' | future
  default_rate_pct: real("default_rate_pct"),       // used when kind='flat_pct'
  config_json: text("config_json"),                  // tier definitions etc.
  effective_from: text("effective_from").notNull(),
  effective_to: text("effective_to"),
  active: integer("active").notNull().default(1),
  created_at: text("created_at"),
});

// --- Payroll lines (final earnings rows; what gets exported to ADP) ---
export const payrollLines = sqliteTable("payroll_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  pay_period_id: integer("pay_period_id").notNull(),
  employee_id: integer("employee_id").notNull(),
  // 'commission' | 'pm' | 'tip' | 'spif' | 'override'
  kind: text("kind").notNull(),
  amount: real("amount").notNull().default(0),
  // Free-text description shown on the ADP CSV memo column.
  description: text("description"),
  // JSON breakdown for traceability (e.g. {"net_sales": 12500, "rate": 0.04}).
  computation_json: text("computation_json"),
  source_table: text("source_table"), // e.g. 'recon_shopify_staff_sales'
  source_row_id: integer("source_row_id"),
  // ADP export tracking.
  exported_at: text("exported_at"),
  exported_run_id: text("exported_run_id"),
  created_at: text("created_at"),
});

// --- Payroll overrides (manual corrections / one-off adjustments) ---
export const payrollOverrides = sqliteTable("payroll_overrides", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  pay_period_id: integer("pay_period_id").notNull(),
  employee_id: integer("employee_id").notNull(),
  // Either: adjust an existing payroll_line (link via target_payroll_line_id)
  // OR: add a new manual line (target_payroll_line_id null, amount stands alone).
  target_payroll_line_id: integer("target_payroll_line_id"),
  adjustment_amount: real("adjustment_amount").notNull(),
  reason: text("reason").notNull(),
  created_by: text("created_by").notNull(), // user email
  created_at: text("created_at").notNull(),
});

// --- Sync log (external integration run history) ---
export const payrollSyncLog = sqliteTable("payroll_sync_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // 'shopify_staff_totals' | 'easyrent_staff_totals' | 'easyrent_pms'
  //   | 'ltm_tips' | 'shopify_line_items_spif'
  kind: text("kind").notNull(),
  entity_id: integer("entity_id"),
  pay_period_id: integer("pay_period_id"),
  started_at: text("started_at").notNull(),
  finished_at: text("finished_at"),
  status: text("status").notNull(), // 'success' | 'partial' | 'error'
  rows_ingested: integer("rows_ingested").default(0),
  error_message: text("error_message"),
  triggered_by: text("triggered_by"), // 'cron' | user email
});

// NOTE: `payroll_unmatched_attributions` is created as a VIEW (not a table) in
// server/storage.ts bootstrap. It unions rows from the *_staff_weekly_totals,
// *_pms, *_tips, and *_line_items_spif tables where employee_id IS NULL.
// The view is intentionally read-only; surfacing unmatched attributions is a
// reporting concern, not a write target.

// ============================================================================
// RBAC SCHEMA
// ----------------------------------------------------------------------------
// Layered on top of the existing `app_users` table. The pre-existing
// `app_users.role` (admin/user) column stays for back-compat — PR #7
// middleware will read both, treating 'admin' as having the system Owner role.
//
// Three-dimensional access model:
//   1. Module access      (which features can the user see at all)
//   2. Entity scope       (which entities can the user see/edit data for)
//   3. Action scope       (read vs export vs edit vs admin)
//
// Permissions are dot-namespaced strings like `payroll.export_adp`.
// ============================================================================

export const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  // System roles ('Owner', 'Manager', 'ADP Exporter') cannot be deleted/renamed
  // via the UI. Custom user-created roles have is_system=0.
  is_system: integer("is_system").notNull().default(0),
  created_at: text("created_at"),
});

export const permissions = sqliteTable("permissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Dot-namespaced key, e.g. 'payroll.view', 'payroll.export_adp'.
  key: text("key").notNull().unique(),
  // 'ap' | 'payroll' | 'users' | 'system' — used to group in the admin UI.
  module: text("module").notNull(),
  label: text("label").notNull(),
  description: text("description"),
});

export const rolePermissions = sqliteTable("role_permissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  role_id: integer("role_id").notNull(),
  permission_id: integer("permission_id").notNull(),
});

export const userRoles = sqliteTable("user_roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: integer("user_id").notNull(),
  role_id: integer("role_id").notNull(),
  // null = role applies to ALL entities. Specific entity_id = scoped.
  // e.g. a Manager role granted with entity_id=1 means "Manager of Greenvale".
  entity_id_scope: integer("entity_id_scope"),
  created_at: text("created_at"),
});

// ============================================================================
// SHOPIFY RECONCILER (PR #R1) — Drizzle definitions
// ----------------------------------------------------------------------------
// Column lists mirror the CREATE TABLE statements in server/storage.ts. If you
// add a column there, add it here too. See PR #R1 description for the data
// model rationale.
// ============================================================================

export const reconSettings = sqliteTable("recon_settings", {
  id: integer("id").primaryKey(),
  default_digital_gc_allocation_policy: text("default_digital_gc_allocation_policy")
    .notNull()
    .default("zip_then_pro_rata"),
  prior_year_pro_rata_year: integer("prior_year_pro_rata_year"),
  prior_year_pro_rata_frozen_at: text("prior_year_pro_rata_frozen_at"),
  shopify_shop_domain: text("shopify_shop_domain"),
  initial_sync_from: text("initial_sync_from").notNull().default("2025-01-01"),
  payout_bank_plaid_account_id: text("payout_bank_plaid_account_id"),
  updated_at: text("updated_at"),
  updated_by: text("updated_by"),
});

export const reconEntityPosLocations = sqliteTable("recon_entity_pos_locations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  shopify_location_id: text("shopify_location_id"),
  shopify_location_name: text("shopify_location_name"),
  kind: text("kind").notNull().default("pos"),
  active: integer("active").notNull().default(1),
  created_at: text("created_at"),
  updated_at: text("updated_at"),
});

// PR #R4a-prep — chart-of-accounts mapping per entity.
// One row per (entity, logical_role). The logical_role is the role the
// reconciler needs to book to (e.g. 'sales_income', 'cc_fees') and
// qbo_account_name is the entity's actual QBO account that role maps to.
// qbo_account_id stays NULL until the 3-QBO connector is wired in Phase 2.
export const reconCoaMapping = sqliteTable("recon_coa_mapping", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  logical_role: text("logical_role").notNull(),
  qbo_account_name: text("qbo_account_name"),
  qbo_account_id: text("qbo_account_id"),
  notes: text("notes"),
  active: integer("active").notNull().default(1),
  created_at: text("created_at"),
  updated_at: text("updated_at"),
});

// Per-entity QBO chart of accounts (imported from CSV export until the
// 3-QBO connector is wired). Used to populate the dropdown options in the
// COA Mapping UI card.
export const reconEntityCoa = sqliteTable("recon_entity_coa", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entity_id: integer("entity_id").notNull(),
  account_number: text("account_number"),
  account_name: text("account_name").notNull(),
  account_type: text("account_type"),
  detail_type: text("detail_type"),
  active: integer("active").notNull().default(1),
  imported_at: text("imported_at").notNull(),
});

export const reconZipToEntityLookup = sqliteTable("recon_zip_to_entity_lookup", {
  zip: text("zip").primaryKey(),
  entity_id: integer("entity_id"),
  distance_miles: real("distance_miles"),
  source: text("source").notNull().default("auto"),
  updated_at: text("updated_at"),
  updated_by: text("updated_by"),
});

export const reconPriorYearProRata = sqliteTable("recon_prior_year_pro_rata", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  applies_to_year: integer("applies_to_year").notNull(),
  entity_id: integer("entity_id").notNull(),
  share: real("share").notNull(),
  source_redemptions_total: real("source_redemptions_total").notNull(),
  frozen_at: text("frozen_at").notNull(),
  frozen_by: text("frozen_by"),
});

export const reconOrders = sqliteTable("recon_orders", {
  id: text("id").primaryKey(),
  order_number: text("order_number"),
  name: text("name"),
  created_at: text("created_at").notNull(),
  processed_at: text("processed_at"),
  updated_at: text("updated_at"),
  cancelled_at: text("cancelled_at"),
  closed_at: text("closed_at"),
  financial_status: text("financial_status"),
  fulfillment_status: text("fulfillment_status"),
  source_name: text("source_name"),
  location_id: text("location_id"),
  currency: text("currency"),
  subtotal: real("subtotal"),
  total_tax: real("total_tax"),
  total_discounts: real("total_discounts"),
  total_shipping: real("total_shipping"),
  total_tips: real("total_tips"),
  total_price: real("total_price"),
  total_refunded: real("total_refunded").default(0),
  customer_id: text("customer_id"),
  customer_email: text("customer_email"),
  billing_zip: text("billing_zip"),
  shipping_zip: text("shipping_zip"),
  has_gift_card: integer("has_gift_card").notNull().default(0),
  tax_channel_liable: integer("tax_channel_liable").notNull().default(0),
  raw_json: text("raw_json"),
  ingested_at: text("ingested_at").notNull(),
  ingest_version: integer("ingest_version").notNull().default(1),
});

export const reconLineItems = sqliteTable("recon_line_items", {
  id: text("id").primaryKey(),
  order_id: text("order_id").notNull(),
  product_id: text("product_id"),
  variant_id: text("variant_id"),
  sku: text("sku"),
  title: text("title"),
  variant_title: text("variant_title"),
  quantity: real("quantity").notNull().default(0),
  price: real("price"),
  total_discount: real("total_discount").default(0),
  line_subtotal: real("line_subtotal"),
  line_tax_total: real("line_tax_total").default(0),
  tax_channel_liable: integer("tax_channel_liable").notNull().default(0),
  tax_lines_json: text("tax_lines_json"),
  is_gift_card: integer("is_gift_card").notNull().default(0),
  requires_shipping: integer("requires_shipping").notNull().default(0),
  raw_json: text("raw_json"),
  ingested_at: text("ingested_at").notNull(),
});

// PR #216 — per-line POS staff attribution extracted from
// recon_orders.raw_json.line_items[].attributed_staffs[]. One row per
// (line_item, assisting_staff). unit_quantity is how many units of that line
// were attributed to the staff member (Shopify POS supports same-line
// splits when a line has qty > 1). Lines with no attributed_staffs entries
// get NO rows here — the view layer treats the missing units as the
// "unmatched" bucket (no order.user_id fallback by design — forces POS
// hygiene). assisting_staff_id stores the numeric portion of
// gid://shopify/StaffMember/<id> so it matches recon_shopify_staff_sales
// and payroll_employees.shopify_staff_id without further parsing.
export const reconOrderAssistingStaff = sqliteTable(
  "recon_order_assisting_staff",
  {
    order_id: text("order_id").notNull(),
    order_name: text("order_name").notNull(),
    line_item_id: text("line_item_id").notNull(),
    assisting_staff_id: text("assisting_staff_id").notNull(),
    unit_quantity: integer("unit_quantity").notNull(),
    source: text("source").notNull().default("shopify_rest_attributed_staffs"),
    ingested_at: text("ingested_at").notNull(),
  },
);

export const reconPayouts = sqliteTable("recon_payouts", {
  id: text("id").primaryKey(),
  payout_date: text("payout_date").notNull(),
  currency: text("currency"),
  amount: real("amount").notNull(),
  status: text("status"),
  summary_json: text("summary_json"),
  plaid_transaction_id: text("plaid_transaction_id"),
  matched_at: text("matched_at"),
  matched_by: text("matched_by"),
  raw_json: text("raw_json"),
  ingested_at: text("ingested_at").notNull(),
});

export const reconBalanceTransactions = sqliteTable("recon_balance_transactions", {
  id: text("id").primaryKey(),
  payout_id: text("payout_id"),
  type: text("type").notNull(),
  processed_at: text("processed_at"),
  amount: real("amount").notNull(),
  fee: real("fee").default(0),
  net: real("net"),
  currency: text("currency"),
  source_order_id: text("source_order_id"),
  source_transaction_id: text("source_transaction_id"),
  // PR #R3: explicit chargeback flag. TRUE when Shopify's balance_transaction
  // is a customer dispute outflow (`type=adjustment` with chargeback-related
  // adjustment_reason, or any `type` matching dispute_*). Critical for the
  // catch-all decomposition — chargebacks are one of the silent sources of
  // the "Other Discounts/Refunds Given" plug in the old process.
  chargeback: integer("chargeback").notNull().default(0),
  adjustment_reason: text("adjustment_reason"),
  raw_json: text("raw_json"),
  ingested_at: text("ingested_at").notNull(),
});

export const reconAllocations = sqliteTable("recon_allocations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  order_id: text("order_id").notNull(),
  line_item_id: text("line_item_id"),
  entity_id: integer("entity_id").notNull(),
  share: real("share").notNull(),
  gross_amount: real("gross_amount").notNull().default(0),
  tax_amount: real("tax_amount").notNull().default(0),
  method: text("method").notNull(),
  reason: text("reason"),
  overridden_by: text("overridden_by"),
  overridden_at: text("overridden_at"),
  auto_method: text("auto_method"),
  auto_entity_id: integer("auto_entity_id"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at"),
});

export const reconGiftCards = sqliteTable("recon_gift_cards", {
  id: text("id").primaryKey(),
  last_characters: text("last_characters"),
  initial_value: real("initial_value").notNull(),
  balance: real("balance"),
  currency: text("currency"),
  kind: text("kind").notNull().default("digital"),
  issuing_order_id: text("issuing_order_id"),
  issuing_line_item_id: text("issuing_line_item_id"),
  buyer_zip: text("buyer_zip"),
  issuing_entity_id: integer("issuing_entity_id"),
  issued_at: text("issued_at"),
  disabled_at: text("disabled_at"),
  expires_at: text("expires_at"),
  raw_json: text("raw_json"),
  ingested_at: text("ingested_at").notNull(),
});

export const reconGiftCardRedemptions = sqliteTable("recon_gift_card_redemptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  gift_card_id: text("gift_card_id"),
  order_id: text("order_id").notNull(),
  amount: real("amount").notNull(),
  redeeming_entity_id: integer("redeeming_entity_id"),
  issuing_entity_id: integer("issuing_entity_id"),
  redeemed_at: text("redeemed_at").notNull(),
  raw_json: text("raw_json"),
  ingested_at: text("ingested_at").notNull(),
});

export const reconSyncLog = sqliteTable("recon_sync_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  started_at: text("started_at").notNull(),
  finished_at: text("finished_at"),
  status: text("status").notNull(),
  rows_ingested: integer("rows_ingested").default(0),
  cursor: text("cursor"),
  error_message: text("error_message"),
  triggered_by: text("triggered_by"),
});

// Closed enums kept in code so the UI, allocator, and tests share one source.
export const RECON_ALLOCATION_METHODS = [
  "pos",                 // POS sale -> store of sale
  "online_fulfillment",  // Online order -> fulfillment location
  "gc_zip",              // Digital GC -> buyer's zip -> nearest entity
  "gc_pro_rata",         // Digital GC fallback -> prior-year frozen pro-rata
  "manual",              // User override
] as const;
export type ReconAllocationMethod = (typeof RECON_ALLOCATION_METHODS)[number];

export const RECON_SOURCE_NAMES = [
  "pos",
  "online_store",
  "shop",        // Shop channel — Shopify is marketplace facilitator (tax remitted by Shopify)
  "web",
  "facebook",
  "google",
  "draft_order",
  "other",
] as const;

export const RECON_SYNC_KINDS = [
  "orders",
  "payouts",
  "balance_transactions",
  "gift_cards",
  "allocator",
  "pro_rata_freeze",
] as const;
export type ReconSyncKind = (typeof RECON_SYNC_KINDS)[number];

export const RECON_GC_ALLOCATION_POLICIES = [
  "zip_then_pro_rata", // v1 default
  "pro_rata_only",     // future: skip zip lookup
  "manual_only",       // future: require user to allocate every digital GC
] as const;
export type ReconGcAllocationPolicy = (typeof RECON_GC_ALLOCATION_POLICIES)[number];

export type ReconSettings = typeof reconSettings.$inferSelect;
export type ReconEntityPosLocation = typeof reconEntityPosLocations.$inferSelect;
export type ReconCoaMapping = typeof reconCoaMapping.$inferSelect;
export type ReconEntityCoa = typeof reconEntityCoa.$inferSelect;
export type ReconZipToEntityLookup = typeof reconZipToEntityLookup.$inferSelect;
export type ReconPriorYearProRata = typeof reconPriorYearProRata.$inferSelect;
export type ReconOrder = typeof reconOrders.$inferSelect;
export type ReconLineItem = typeof reconLineItems.$inferSelect;
export type ReconOrderAssistingStaff =
  typeof reconOrderAssistingStaff.$inferSelect;
export type ReconPayout = typeof reconPayouts.$inferSelect;
export type ReconBalanceTransaction = typeof reconBalanceTransactions.$inferSelect;
export type ReconAllocation = typeof reconAllocations.$inferSelect;
export type ReconGiftCard = typeof reconGiftCards.$inferSelect;
export type ReconGiftCardRedemption = typeof reconGiftCardRedemptions.$inferSelect;
export type ReconSyncLogEntry = typeof reconSyncLog.$inferSelect;

// Types for payroll + RBAC
export type PayrollEntity = typeof payrollEntities.$inferSelect;
export type PayrollEmployee = typeof payrollEmployees.$inferSelect;
export type PayrollPayPeriod = typeof payrollPayPeriods.$inferSelect;
export type PayrollPosLocation = typeof payrollPosLocations.$inferSelect;
export type PayrollLtmMerchant = typeof payrollLtmMerchants.$inferSelect;
export type PayrollEntityProcessingFee = typeof payrollEntityProcessingFees.$inferSelect;
export type ReconShopifyStaffSales = typeof reconShopifyStaffSales.$inferSelect;
export type PayrollEasyrentStaffWeeklyTotal = typeof payrollEasyrentStaffWeeklyTotals.$inferSelect;
export type PayrollEasyrentPm = typeof payrollEasyrentPms.$inferSelect;
export type PayrollLtmTip = typeof payrollLtmTips.$inferSelect;
export type PayrollShopifyLineItemSpif = typeof payrollShopifyLineItemsSpif.$inferSelect;
export type PayrollSpifRule = typeof payrollSpifRules.$inferSelect;
export type PayrollCommissionRule = typeof payrollCommissionRules.$inferSelect;
export type PayrollLine = typeof payrollLines.$inferSelect;
export type PayrollOverride = typeof payrollOverrides.$inferSelect;
export type PayrollSyncLogEntry = typeof payrollSyncLog.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type UserRole = typeof userRoles.$inferSelect;

// Initial permission catalog — seeded into `permissions` on first boot.
// Adding a new permission? Append it here AND in the migration in storage.ts.
export const PERMISSION_CATALOG: Array<{
  key: string;
  module: "ap" | "payroll" | "users" | "system" | "finance";
  label: string;
  description: string;
}> = [
  // ----- Accounts Payable -----
  { key: "ap.view", module: "ap", label: "View AP", description: "See the AP inbox, invoices, and history." },
  { key: "ap.approve", module: "ap", label: "Approve invoices", description: "Approve invoices and post to QuickBooks." },
  { key: "ap.edit_rules", module: "ap", label: "Edit vendor rules", description: "Create or change vendor routing rules and aliases." },
  { key: "ap.skip_senders", module: "ap", label: "Manage skip senders", description: "Add/remove email senders that AP should ignore." },

  // ----- Payroll -----
  { key: "payroll.view", module: "payroll", label: "View payroll", description: "See payroll lines, periods, and reports." },
  { key: "payroll.edit_overrides", module: "payroll", label: "Edit overrides", description: "Create manual adjustments to payroll lines." },
  { key: "payroll.lock_period", module: "payroll", label: "Lock pay periods", description: "Move a pay period from open to locked." },
  { key: "payroll.export_adp", module: "payroll", label: "Export ADP CSV", description: "Download the per-entity ADP Run import file. Does not require payroll.view." },
  { key: "payroll.edit_employees", module: "payroll", label: "Manage employees", description: "Add, edit, or deactivate employees within scoped entities." },
  { key: "payroll.edit_commissions", module: "payroll", label: "Edit per-employee commission rate", description: "Set or change the per-employee commission_rate_pct override. View is open to anyone with payroll.view; this gates writes only." },
  { key: "payroll.edit_rules", module: "payroll", label: "Edit commission/SPIF rules", description: "Change commission rates, SPIF rules, and processing fees." },
  { key: "payroll.run_sync", module: "payroll", label: "Trigger sync", description: "Manually trigger Shopify / Easyrent / Shift4 ingestion runs." },

  // ----- Finance (PR #165) -----
  // finance.view replaces payroll.view on /api/recon/finance/* routes (with a
  // graceful payroll.view fallback during cutover). The two sales_tax keys gate
  // the Sales Tax module: .view for reading data, .export for downloads AND for
  // marking a period filed.
  { key: "finance.view", module: "finance", label: "View Finance", description: "See the Finance section: reconciler finance reports, by-store totals, and sales tax." },
  { key: "finance.sales_tax.view", module: "finance", label: "View Sales Tax", description: "See sales-tax summaries, jurisdiction breakdowns, and filing status." },
  { key: "finance.sales_tax.export", module: "finance", label: "Export / file Sales Tax", description: "Download sales-tax exports (CSV/PDF/XLSX) and mark a period as filed." },
  { key: "finance.entity_settings.edit", module: "finance", label: "Edit Entity Settings", description: "Manage entity-level filing settings such as the TIN used on ST-809/ST-810 forms." },

  // ----- Users / RBAC -----
  { key: "users.view", module: "users", label: "View users", description: "See the users list and their assigned roles." },
  { key: "users.manage", module: "users", label: "Manage users & roles", description: "Create/edit/disable users and assign roles. Owner-equivalent." },
  { key: "users.manage_links", module: "users", label: "Manage employee ↔ user links", description: "Change which person an employee or user is linked to. Used to fix mismatches the auto-backfill couldn't catch (different emails, ambiguous matches, no-email employees)." },

  // ----- System -----
  { key: "system.view_audit", module: "system", label: "View audit log", description: "Read the system audit log." },
  { key: "system.view_sync_log", module: "system", label: "View sync log", description: "Read the integration sync log." },
  { key: "system.manage_config", module: "system", label: "Manage system config", description: "Edit Google/QBO/Shift4/etc. integration credentials and global settings." },
];

// System role definitions — seeded into `roles` + `role_permissions` on first
// boot. These are baseline starting points; the Owner can edit non-system
// roles freely via the Settings UI (coming in PR #8).
export const SYSTEM_ROLES: Array<{
  name: string;
  description: string;
  permissions: string[] | "ALL";
}> = [
  {
    name: "Owner",
    description: "Full access to everything across all entities. Cannot be deleted.",
    permissions: "ALL",
  },
  {
    name: "Manager",
    description: "Day-to-day management of AP and payroll within their scoped entity. Cannot manage users or system config.",
    permissions: [
      "ap.view",
      "ap.approve",
      "ap.edit_rules",
      "payroll.view",
      "payroll.edit_overrides",
      "payroll.lock_period",
      "payroll.edit_employees",
      "payroll.run_sync",
      "users.manage_links",
      "system.view_sync_log",
    ],
  },
  {
    name: "ADP Exporter",
    description: "Limited role for whoever runs payroll in ADP — can download the export CSV but not see payroll detail.",
    permissions: ["payroll.export_adp"],
  },
  {
    name: "Read Only",
    description: "View AP and payroll data without making changes. Useful for accountants and reviewers.",
    permissions: ["ap.view", "payroll.view", "system.view_audit", "system.view_sync_log"],
  },
];

// Initial entity seed — the 3 stores. Matches the StoreKey values up top so
// AP-side store routing and payroll-side entity records stay in sync.
export const INITIAL_ENTITIES: Array<{
  location: string;
  short_name: string;
  legal_name: string;
  display_name: string;
  dba: string;
  cadence: "weekly" | "biweekly";
  commissions_enabled: 0 | 1;
  pms_enabled: 0 | 1;
  tips_enabled: 0 | 1;
  easyrent_enabled: 0 | 1;
  spif_enabled: 0 | 1;
}> = [
  {
    location: "Greenvale",
    short_name: "Greenvale",
    legal_name: "SD Ski and Patio Inc",
    display_name: "Sno-Haus Greenvale",
    dba: "Sno-Haus Greenvale",
    cadence: "weekly",
    commissions_enabled: 1,
    pms_enabled: 1,
    tips_enabled: 1,
    easyrent_enabled: 1,
    spif_enabled: 1,
  },
  {
    location: "Huntington",
    short_name: "Huntington",
    legal_name: "SH Huntington Inc",
    display_name: "Sno-Haus Huntington",
    dba: "Sno-Haus Huntington",
    cadence: "biweekly",
    commissions_enabled: 0,
    pms_enabled: 0,
    tips_enabled: 0,
    easyrent_enabled: 1,
    spif_enabled: 0,
  },
  {
    location: "Hempstead",
    short_name: "Hempstead",
    legal_name: "SH Hempstead Inc",
    display_name: "Sno-Haus Hempstead",
    dba: "Sno-Haus Hempstead",
    cadence: "biweekly",
    commissions_enabled: 0,
    pms_enabled: 0,
    tips_enabled: 0,
    easyrent_enabled: 1,
    spif_enabled: 0,
  },
];

