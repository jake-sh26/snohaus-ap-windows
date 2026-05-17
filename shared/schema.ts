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
  { key: "greenvale", label: "Sundown Greenvale", qbo_account_id: "38", qbo_account_name: "Inventory Asset" },
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
