import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  smartMatchVendor,
  resolveShipToStore,
  createMagicCode,
  verifyMagicCode,
  createSession,
  getSession,
  deleteSession,
  listInvoices,
  getInvoice,
  getLineItems,
  getAuditLog,
  appendAuditLog,
  updateInvoice,
  setLineItemStore,
  replaceInvoiceLineItems,
  listRules,
  createRule,
  updateRule,
  deleteRule,
  listAliases,
  createAlias,
  deleteAlias,
  deleteAliasByLowerName,
  searchQboVendors,
  listInvoiceNotes,
  createInvoiceNote,
  PDF_FILES_MAP,
  rankVendorSuggestions,
  backfillVendorAliasesFromPostedInvoices,
  listSkipSenders,
  addSkipSender,
  extractBareEmail,
  skipSenderAndRejectInvoice,
  removeSkipSender,
  listSkippedUploads,
  getSkippedUpload,
  markSkippedUploadRestored,
  deleteSkippedUpload,
  countActiveSkippedUploads,
  // New for combined patch
  listAppUsers,
  getAppUserByEmail,
  getAppUserById,
  createAppUser,
  updateAppUser,
  setAppUserPassword,
  deleteAppUser,
  // RBAC (PR #7)
  listRoles,
  getRoleById,
  getRoleByName,
  createRole,
  updateRole,
  deleteRole,
  setRolePermissions,
  listPermissions,
  listPermissionsForRole,
  listAllUserRoles,
  listUserRolesForUser,
  setUserRoles,
  listPayrollEntities,
  // Payroll admin (PR #9 + #10)
  listAllPayrollEntities,
  getPayrollEntityById,
  updatePayrollEntity,
  listProcessingFees,
  getEffectiveProcessingFee,
  addProcessingFee,
  listEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deactivateEmployee,
  // Reconciler (PR #R1)
  getReconSettings,
  updateReconSettings,
  listReconEntityPosLocations,
  setReconShopifyLocationMapping,
  buildEntityMappingSuggestions,
  bulkSaveReconEntityPosLocations,
  getReconCounts,
  listReconSyncLog,
  getZipMapping,
  upsertZipMapping,
  listPriorYearProRata,
  // Reconciler (PR #R2)
  listReconOrdersSample,
  getReconOrderWithLines,
  getReconOrdersWatermark,
  getReconOrdersSummary,
  // Reconciler (PR #R5a-pre) — paginated date-range pulls
  listReconOrdersByDateRange,
  listReconOrdersWithRefundsInRange,
  // Reconciler (PR #R3)
  listReconPayoutsSample,
  getReconPayoutWithTransactions,
  getReconPayoutsWatermark,
  getReconPayoutsSummary,
  // Reconciler (PR #R4a-prep) — COA mapping
  importReconEntityCoa,
  listReconEntityCoa,
  getReconCoaImportStatus,
  buildReconCoaMappingMatrix,
  bulkSaveReconCoaMapping,
  RECON_COA_LOGICAL_ROLES,
  // Reconciler (PR #R4e) — GC redemption ledger + inter-company JE preview
  listRedemptionsForRange,
  getRedemptionSummary,
  listInterCompanyJEsForRange,
  getIssuanceSummary,
} from "./storage";
import {
  getShopifyReconConfig,
  getShopifyReconStatus,
  pingShopify,
  listShopifyLocations,
  getShopifyReconErrorLog,
  clearShopifyReconErrorLog,
  getShopifyAccessToken,
  clearShopifyTokenCache,
  shopifyRestCall,
  shopifyGraphqlCall,
} from "./shopify-recon";
import {
  syncOrdersIncremental,
  transformShopifyOrder,
  backfillFulfillments,
  backfillRefundsFromRawJson,
  repullStaleRefunds,
  repullSingleOrderByName,
  getBackfillProgress,
  listRecentBackfillProgress,
  getActiveBackfillProgress,
  listRunningBackfillIds,
  requestCancelBackfill,
} from "./shopify-recon-orders";
import {
  syncPayoutsIncremental,
} from "./shopify-recon-payouts";
import {
  handleShopifyWebhook,
  ensureShopifyWebhooks,
  deleteAllOurWebhooks,
  SHOPIFY_RECON_WEBHOOK_TOPICS,
} from "./shopify-recon-webhooks";
import {
  runAllocationEngine,
  listNeedsReview,
  applyAllocationOverride,
  getAllocationRollup,
  getAllocationRollupStoreTime,
  getMonthBoundaryDiag,
  getAllocationReadiness,
} from "./shopify-recon-allocator";
import {
  rebuildRedemptionsForRange,
} from "./shopify-recon-gc-redemption";
import {
  shopifyInstallHandler,
  shopifyCallbackHandler,
  shopifyInstallUrlHandler,
  shopifyInstalledStatusHandler,
  shopifyDeleteTokenHandler,
} from "./shopify-oauth";
import { getUserPermissions, requirePermission } from "./rbac";
import {
  isGoogleConfigured,
  getDriveAuthUrl,
  getSsoAuthUrl,
  exchangeCodeForTokens,
  exchangeSsoCode,
  setDriveTokens,
  clearDriveTokens,
  getDriveStatus,
  generateOAuthState,
  verifyOAuthState,
} from "./google-oauth";
import {
  runLocalBackupWithTracking,
  runDriveDailyBackup,
  runDriveWeeklyFullBackup,
  getBackupStatus,
  listLocalBackups,
  BACKUP_DIR,
} from "./backups";
import {
  getArchiveStatus,
  runPdfArchive,
} from "./pdf-archive";
import { matchVendorWithLlm, isVendorMatcherLlmEnabled } from "./vendor-matcher-llm";
import { processInvoicePdf, normalizeDueDate } from "./invoice-pipeline";
import { parsePaymentTermsFallback } from "./payment-terms-parser";
import { parseInvoiceWithLLM, isLlmParserEnabled, getLastLlmFailure, clearLastLlmFailure, computeDueDateFromTerms } from "./llm-parser";
import {
  listVendorGroups, getVendorGroup, createVendorGroup, updateVendorGroup, deleteVendorGroup,
  addGroupMember, updateGroupMember, deleteGroupMember,
  findGroupForVendor, suggestGroupMember, autoDetectGroup,
} from "./vendor-groups";
import { getAcumaticaStatus, runAcumaticaPullNow, getAcumaticaErrorLog, clearAcumaticaErrorLog } from "./acumatica";
import multer from "multer";
import { imageBufferToPdf, looksLikeImage, sniffImageKind } from "./image-to-pdf";

const uploadHandler = multer({
  storage: multer.memoryStorage(),
  // 50MB / 20 files — generous so a multi-page mailed invoice scan never trips the cap.
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  // No fileFilter — we accept anything here and validate by sniffing the actual
  // file bytes (%PDF- magic) inside the route handler. This makes us robust to:
  //   - browsers sending odd mimetypes (text/plain, octet-stream, empty)
  //   - filenames with uppercase .PDF or no extension at all
  //   - drag-and-drop variations across Chrome / Edge / Firefox
});
import { ALLOWED_EMAILS, STORES } from "@shared/schema";
import { getQboStatus, getAuthUrl, exchangeCode, disconnectQbo, searchBills, searchPayments, createBill, createVendorCredit, syncQboVendorsFromApi, lastVendorSyncAge, getQboErrorLog, clearQboErrorLog } from "./qbo";
import { getGmailStatus, pollNow, pollWithRetry, testGmailConnection, clearGmailErrorLog, reingestEmails } from "./gmail";

declare global {
  namespace Express {
    interface Request {
      email?: string;
      userId?: number;
      userRole?: 'admin' | 'user';
      userName?: string | null;
    }
  }
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const token = auth.slice(7);
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
  req.email = session.email;
  // Load role + id from app_users (falls back to 'admin' for existing users not yet in the table)
  try {
    const appUser = getAppUserByEmail(session.email);
    req.userId = appUser?.id;
    req.userRole = (appUser?.role as 'admin' | 'user') || 'admin';
    req.userName = appUser?.name || null;
  } catch {
    req.userRole = 'admin'; // safe fallback
  }
  next();
}

function adminMiddleware(req: Request, res: Response, next: NextFunction) {
  authMiddleware(req, res, () => {
    if (req.userRole !== 'admin') {
      return res.status(403).json({ message: "Admin access required" });
    }
    next();
  });
}

function buildQboBillPayload(invoice: any, lineItems: any[]): any {
  // Build a representative QBO Bill payload showing how lines distribute across inventory accounts.
  const storeAccount = (key: string) => STORES.find((s) => s.key === key) || STORES[0];

  let routing: any = {};
  try { routing = invoice.routing_data ? JSON.parse(invoice.routing_data) : {}; } catch {}

  const lines: any[] = [];

  if (invoice.routing_mode === "single_store") {
    const store = routing.store || invoice.ship_to_store || "greenvale";
    const acc = storeAccount(store);
    const subtotal = (invoice.total || 0) - (invoice.freight || 0);
    if (subtotal !== 0) {
      lines.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: Number(subtotal.toFixed(2)),
        Description: `Inventory — ${acc.label}`,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: acc.qbo_account_id, name: acc.qbo_account_name },
        },
      });
    }
    if (invoice.freight && invoice.freight !== 0) {
      lines.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: Number(invoice.freight.toFixed(2)),
        Description: `Freight (landed cost) — ${acc.label}`,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: acc.qbo_account_id, name: acc.qbo_account_name },
        },
      });
    }
  } else if (invoice.routing_mode === "percent_split") {
    const splits = routing.percentages || { greenvale: 100, hempstead: 0, huntington: 0 };
    const subtotal = (invoice.total || 0) - (invoice.freight || 0);
    for (const key of ["greenvale", "hempstead", "huntington"] as const) {
      const pct = splits[key] || 0;
      if (pct === 0) continue;
      const acc = storeAccount(key);
      const amt = Number(((subtotal * pct) / 100).toFixed(2));
      lines.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: amt,
        Description: `Inventory — ${acc.label} (${pct}%)`,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: acc.qbo_account_id, name: acc.qbo_account_name },
        },
      });
      if (invoice.freight && invoice.freight !== 0) {
        const fAmt = Number(((invoice.freight * pct) / 100).toFixed(2));
        lines.push({
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: fAmt,
          Description: `Freight (pro-rata ${pct}%) — ${acc.label}`,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: acc.qbo_account_id, name: acc.qbo_account_name },
          },
        });
      }
    }
  } else if (invoice.routing_mode === "line_item_split") {
    // Group line items by store_assignment
    const storeTotals: Record<string, number> = {};
    for (const li of lineItems) {
      const store = li.store_assignment || routing.default_store || invoice.ship_to_store || "greenvale";
      const amt = li.amount || 0;
      storeTotals[store] = (storeTotals[store] || 0) + amt;
    }
    for (const [key, amt] of Object.entries(storeTotals)) {
      const acc = storeAccount(key);
      lines.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: Number(amt.toFixed(2)),
        Description: `Inventory (line items) — ${acc.label}`,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: acc.qbo_account_id, name: acc.qbo_account_name },
        },
      });
    }
    // Pro-rata freight by line subtotals
    if (invoice.freight && invoice.freight !== 0) {
      const totalAssigned = Object.values(storeTotals).reduce((a: number, b: number) => a + b, 0) || 1;
      for (const [key, amt] of Object.entries(storeTotals)) {
        const acc = storeAccount(key);
        const fAmt = Number((((amt as number) / totalAssigned) * invoice.freight).toFixed(2));
        lines.push({
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: fAmt,
          Description: `Freight (pro-rata) — ${acc.label}`,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: acc.qbo_account_id, name: acc.qbo_account_name },
          },
        });
      }
    }
  }

  // v8.4.5: discount lines — when the user has elected to take the early-pay
  // discount, or the invoice carries a net_with_discount kind (automatic per
  // spec), append negative line(s) against the same inventory accounts used
  // above. Pro-rata split across stores. Discount applies to (total − freight).
  // Never reduces freight. Records 1 negative line per store with the same
  // AccountRef as the corresponding positive inventory line.
  if (invoice.discount_applied && invoice.discount_terms_pct && invoice.discount_kind) {
    const pct = Number(invoice.discount_terms_pct) || 0;
    const subtotal = (invoice.total || 0) - (invoice.freight || 0);
    const discountTotal = (subtotal * pct) / 100;
    if (discountTotal > 0) {
      const desc = `${pct}% terms discount`;
      if (invoice.routing_mode === "percent_split") {
        const splits = routing.percentages || { greenvale: 100, hempstead: 0, huntington: 0 };
        for (const key of ["greenvale", "hempstead", "huntington"] as const) {
          const sharePct = splits[key] || 0;
          if (sharePct === 0) continue;
          const acc = storeAccount(key);
          const amt = Number(((discountTotal * sharePct) / 100).toFixed(2));
          lines.push({
            DetailType: "AccountBasedExpenseLineDetail",
            Amount: -amt,
            Description: `${desc} — ${acc.label} (${sharePct}%)`,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: acc.qbo_account_id, name: acc.qbo_account_name },
            },
          });
        }
      } else if (invoice.routing_mode === "line_item_split") {
        // Same pro-rata weighting as the positive lines.
        const storeTotals: Record<string, number> = {};
        for (const li of lineItems) {
          const store = li.store_assignment || routing.default_store || invoice.ship_to_store || "greenvale";
          storeTotals[store] = (storeTotals[store] || 0) + (li.amount || 0);
        }
        const totalAssigned = Object.values(storeTotals).reduce((a: number, b: number) => a + b, 0) || 1;
        for (const [key, amt] of Object.entries(storeTotals)) {
          const acc = storeAccount(key);
          const share = Number((((amt as number) / totalAssigned) * discountTotal).toFixed(2));
          if (share === 0) continue;
          lines.push({
            DetailType: "AccountBasedExpenseLineDetail",
            Amount: -share,
            Description: `${desc} — ${acc.label}`,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: acc.qbo_account_id, name: acc.qbo_account_name },
            },
          });
        }
      } else {
        // single_store
        const store = routing.store || invoice.ship_to_store || "greenvale";
        const acc = storeAccount(store);
        lines.push({
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: -Number(discountTotal.toFixed(2)),
          Description: `${desc} — ${acc.label}`,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: acc.qbo_account_id, name: acc.qbo_account_name },
          },
        });
      }
    }
  }

  // v8.4.5: when discount is applied, the bill total drops by the discount
  // amount and (for early_pay) the due_date shifts to the discount window.
  const discountActive = !!(invoice.discount_applied && invoice.discount_terms_pct && invoice.discount_kind);
  const discountAmount = discountActive
    ? (((invoice.total || 0) - (invoice.freight || 0)) * Number(invoice.discount_terms_pct)) / 100
    : 0;
  const effectiveTotal = Number(((invoice.total || 0) - discountAmount).toFixed(2));
  const effectiveDueDate =
    discountActive && invoice.discount_kind === "early_pay" && invoice.discount_due_date
      ? invoice.discount_due_date
      : invoice.due_date;

  return {
    VendorRef: invoice.vendor_qbo_id
      ? { value: invoice.vendor_qbo_id, name: invoice.vendor_qbo_name }
      : null,
    TxnDate: invoice.invoice_date,
    DueDate: effectiveDueDate,
    DocNumber: invoice.invoice_number,
    TotalAmt: effectiveTotal,
    PrivateNote: invoice.notes || undefined,
    Line: lines,
  };
}

// Round 7 follow-up: shared helper that runs the QBO duplicate check against a
// single invoice. Returns the updated invoice plus whether a dup was found and
// the matching Bill/Payment metadata. Reused by:
//   POST /api/invoices/:id/recheck-duplicate (manual)
//   POST /api/invoices/:id/reparse           (auto, after fields change)
//   POST /api/invoices/:id/rematch-vendor    (auto, after vendor changes)
// Always idempotent — doesn't mutate status, only updates the dup flag + notes.
async function runDuplicateCheck(invoiceId: string, actorEmail: string): Promise<{
  invoice: any;
  found: boolean;
  bill: { id: string | null; total: number; balance: number; paid_label: string } | null;
  payment_id: string | null;
  note: string | null;
  reason?: string;
}> {
  const inv = getInvoice(invoiceId);
  if (!inv) return { invoice: null, found: false, bill: null, payment_id: null, note: null, reason: "not found" };
  try {
    const status = getQboStatus();
    if (!status.connected || !inv.invoice_number) {
      const updated = updateInvoice(inv.id, {
        duplicate_check_status: "clean",
        duplicate_check_at: new Date().toISOString(),
      });
      return { invoice: updated, found: false, bill: null, payment_id: null, note: null, reason: !status.connected ? "qbo not connected" : "no invoice number" };
    }
    const bills = await searchBills([inv.invoice_number]);
    const payments = await searchPayments([inv.invoice_number]);
    if (bills.length > 0 || payments.length > 0) {
      const firstBill = bills[0];
      const billId = firstBill?.Id || null;
      const total = Number(firstBill?.TotalAmt || 0);
      const balance = Number(firstBill?.Balance ?? total);
      let paidLabel = "";
      if (firstBill) {
        if (balance <= 0.005) paidLabel = " \u2014 PAID";
        else if (balance < total) paidLabel = ` \u2014 partially paid ($${balance.toFixed(2)} open)`;
        else paidLabel = " \u2014 unpaid";
      }
      const paymentId = payments[0]?.Id || null;
      const vendorMismatch =
        inv.vendor_qbo_id &&
        ((bills.length > 0 && !bills.some((b: any) => b.VendorRef?.value === inv.vendor_qbo_id)) ||
          (payments.length > 0 && !payments.some((p: any) => p.EntityRef?.value === inv.vendor_qbo_id)));
      const note = [
        bills.length > 0 ? `Bill #${billId} exists in QBO${paidLabel}` : null,
        payments.length > 0 ? `BillPayment #${paymentId} found` : null,
        vendorMismatch ? "(vendor ID differs \u2014 verify manually)" : null,
      ].filter(Boolean).join("; ");
      const updated = updateInvoice(inv.id, {
        duplicate_check_status: "duplicate_found",
        duplicate_check_at: new Date().toISOString(),
        notes: note,
      });
      try {
        appendAuditLog(inv.id, "duplicate_check", { status: inv.duplicate_check_status }, { status: "duplicate_found", note }, actorEmail);
      } catch {}
      return {
        invoice: updated,
        found: true,
        bill: { id: billId, total, balance, paid_label: paidLabel.trim() },
        payment_id: paymentId,
        note,
      };
    }
    const updated = updateInvoice(inv.id, {
      duplicate_check_status: "clean",
      duplicate_check_at: new Date().toISOString(),
    });
    try {
      appendAuditLog(inv.id, "duplicate_check", { status: inv.duplicate_check_status }, { status: "clean" }, actorEmail);
    } catch {}
    return { invoice: updated, found: false, bill: null, payment_id: null, note: null };
  } catch (err: any) {
    console.error("[runDuplicateCheck] error:", err.message);
    return { invoice: inv, found: false, bill: null, payment_id: null, note: null, reason: `error: ${err.message}` };
  }
}

// ---- Password auth helpers ----
// Supports multiple users via LOGIN_USERS env var (comma-separated email:salt:hash triples)
// Falls back to single user via LOGIN_PASSWORD_SALT + LOGIN_PASSWORD_HASH + LOGIN_EMAIL
// Last resort: the jake@snohaus.com / skiing18 credentials baked in.
function buildPasswordRecords(): Record<string, { salt: string; hash: string }> {
  const records: Record<string, { salt: string; hash: string }> = {};

  // Multi-user: LOGIN_USERS=email1:salt1:hash1,email2:salt2:hash2
  const loginUsers = process.env.LOGIN_USERS;
  if (loginUsers) {
    for (const entry of loginUsers.split(",")) {
      const parts = entry.trim().split(":");
      if (parts.length === 3) {
        const [email, salt, hash] = parts;
        records[email.toLowerCase()] = { salt, hash };
      }
    }
    if (Object.keys(records).length > 0) return records;
  }

  // Single user via individual env vars
  const singleEmail = process.env.LOGIN_EMAIL;
  const singleSalt = process.env.LOGIN_PASSWORD_SALT;
  const singleHash = process.env.LOGIN_PASSWORD_HASH;
  if (singleEmail && singleSalt && singleHash) {
    records[singleEmail.toLowerCase()] = { salt: singleSalt, hash: singleHash };
    return records;
  }

  // Hardcoded fallback: jake@snohaus.com / skiing18
  records["jake@snohaus.com"] = {
    salt: "5cdc5ff936fec8452272a753eacebebe",
    hash: "0e435278b5825d2524fd594a957a963251ad4f247b5e05cf9065763316e831be94fdf5d83578c4774d994d45fe263646ea36c584f5af05eaa4feca73353e4c40",
  };
  return records;
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // ---- Auth ----
  // Simple in-memory rate limit: 5 attempts per email per 15min
  const authAttempts = new Map<string, number[]>();
  function checkRateLimit(key: string, max = 5, windowMs = 15 * 60 * 1000): boolean {
    const now = Date.now();
    const arr = (authAttempts.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return false;
    arr.push(now);
    authAttempts.set(key, arr);
    return true;
  }

  const PASSWORD_RECORDS = buildPasswordRecords();

  function verifyPassword(email: string, password: string): boolean {
    const rec = PASSWORD_RECORDS[email.toLowerCase()];
    if (!rec) return false;
    const salt = Buffer.from(rec.salt, "hex");
    const expected = Buffer.from(rec.hash, "hex");
    const actual = crypto.scryptSync(password, salt, expected.length);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }

  // Also verify against app_users table (new) with its own password hash
  function verifyPasswordFromAppUsers(email: string, password: string): boolean {
    try {
      const user = getAppUserByEmail(email);
      if (!user || !user.enabled) return false;
      if (!user.password_hash) return false;
      // Support two formats:
      // 1. salt:hash (scrypt) — new format from password set via app
      // 2. raw hash — migrated from env (no salt in app_users)
      if (user.password_salt) {
        const salt = Buffer.from(user.password_salt, "hex");
        const expected = Buffer.from(user.password_hash, "hex");
        const actual = crypto.scryptSync(password, salt, expected.length);
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
      } else {
        // Hash only — compare directly (may be a raw hex scrypt hash from old env)
        // Try matching against env-based records for backwards compat
        return verifyPassword(email, password);
      }
    } catch {
      return false;
    }
  }

  app.post("/api/auth/login", (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }
    if (!checkRateLimit(`login:${email}`, 5, 15 * 60 * 1000)) {
      return res.status(429).json({ message: "Too many attempts. Try again in 15 minutes." });
    }
    // Check app_users first (new), then fall back to env-based auth (backwards compat)
    const appUser = getAppUserByEmail(email);
    let authed = false;
    if (appUser && appUser.enabled) {
      authed = verifyPasswordFromAppUsers(email, password);
    } else if (!appUser) {
      // User not in app_users yet — fall back to env-based
      authed = ALLOWED_EMAILS.includes(email) && verifyPassword(email, password);
    } else {
      // User in app_users but disabled
      return res.status(401).json({ message: "Account disabled" });
    }
    if (!authed) {
      // Generic message — don't reveal which field was wrong
      return res.status(401).json({ message: "Invalid email or password" });
    }
    // Update last_login_at
    if (appUser) {
      try { updateAppUser(appUser.id, { last_login_at: new Date().toISOString() }); } catch {}
    }
    const token = createSession(email);
    console.log(`[AUTH] Login success for ${email}`);
    res.json({ token, email });
  });

  app.post("/api/auth/logout", authMiddleware, (req, res) => {
    const auth = req.headers.authorization!;
    deleteSession(auth.slice(7));
    res.json({ ok: true });
  });

  app.get("/api/me", authMiddleware, (req, res) => {
    // Resolve full RBAC permissions for the frontend. Permissions are returned
    // as an array of {key, entity_id_scope} pairs; the client uses this to
    // show/hide UI affordances. Legacy admins automatically have the Owner
    // role (assigned in seedRbacBaseline()) so this works for everyone.
    let permissions: Array<{ key: string; entity_id_scope: number | null }> = [];
    let roles: Array<{ id: number; name: string; entity_id_scope: number | null }> = [];
    if (req.userId) {
      permissions = getUserPermissions(req.userId);
      roles = listUserRolesForUser(req.userId).map((r) => ({
        id: r.role_id, name: r.role_name, entity_id_scope: r.entity_id_scope,
      }));
    }
    res.json({
      email: req.email,
      role: req.userRole || 'admin',
      name: req.userName || null,
      user_id: req.userId,
      permissions,
      roles,
    });
  });

  // ============================================================================
  // SETTINGS — RBAC management (PR #7)
  // ----------------------------------------------------------------------------
  // Read endpoints: anyone with users.view (Owner only by default) can list.
  // Write endpoints: users.manage required (Owner only by default).
  // System roles cannot be deleted or renamed; their permissions can be edited
  // via the same endpoint (so the Owner can grant the Manager role additional
  // permissions as the app grows).
  // ============================================================================

  app.get("/api/settings/permissions", authMiddleware, requirePermission("users.view"), (_req, res) => {
    const all = listPermissions();
    // Group by module for nicer frontend rendering.
    const grouped: Record<string, typeof all> = {};
    for (const p of all) {
      if (!grouped[p.module]) grouped[p.module] = [];
      grouped[p.module].push(p);
    }
    res.json({ permissions: all, grouped });
  });

  app.get("/api/settings/entities", authMiddleware, requirePermission("users.view"), (_req, res) => {
    res.json(listPayrollEntities());
  });

  app.get("/api/settings/roles", authMiddleware, requirePermission("users.view"), (_req, res) => {
    const roles = listRoles();
    const withPerms = roles.map((r) => ({
      ...r,
      permissions: listPermissionsForRole(r.id).map((p) => p.key),
    }));
    res.json(withPerms);
  });

  app.post("/api/settings/roles", authMiddleware, requirePermission("users.manage"), (req, res) => {
    const { name, description, permissions } = req.body || {};
    if (!name || typeof name !== "string") return res.status(400).json({ message: "name is required" });
    if (getRoleByName(name)) return res.status(409).json({ message: "A role with that name already exists" });
    const role = createRole(name, description ?? null);
    if (Array.isArray(permissions) && permissions.length > 0) {
      setRolePermissions(role.id, permissions);
    }
    res.json({ ...role, permissions: listPermissionsForRole(role.id).map((p) => p.key) });
  });

  app.patch("/api/settings/roles/:id", authMiddleware, requirePermission("users.manage"), (req, res) => {
    const id = Number(req.params.id);
    const role = getRoleById(id);
    if (!role) return res.status(404).json({ message: "Role not found" });
    const { name, description, permissions } = req.body || {};
    // System roles: lock name + description, allow permission edits.
    if (role.is_system) {
      if (name !== undefined && name !== role.name) {
        return res.status(400).json({ message: "System role names cannot be changed." });
      }
    } else {
      if (name !== undefined || description !== undefined) {
        updateRole(id, { name, description });
      }
    }
    if (Array.isArray(permissions)) {
      setRolePermissions(id, permissions);
    }
    const updated = getRoleById(id)!;
    res.json({ ...updated, permissions: listPermissionsForRole(id).map((p) => p.key) });
  });

  app.delete("/api/settings/roles/:id", authMiddleware, requirePermission("users.manage"), (req, res) => {
    const id = Number(req.params.id);
    const role = getRoleById(id);
    if (!role) return res.status(404).json({ message: "Role not found" });
    if (role.is_system) return res.status(400).json({ message: "System roles cannot be deleted." });
    deleteRole(id);
    res.json({ ok: true });
  });

  // List all user→role assignments (for the per-user role-assignment UI).
  app.get("/api/settings/user-roles", authMiddleware, requirePermission("users.view"), (_req, res) => {
    res.json(listAllUserRoles());
  });

  // Replace a single user's role assignments. Body: { assignments: [{ role_id, entity_id_scope }] }
  // entity_id_scope: null = all entities.
  app.put("/api/settings/users/:userId/roles", authMiddleware, requirePermission("users.manage"), (req, res) => {
    const userId = Number(req.params.userId);
    const user = getAppUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    const { assignments } = req.body || {};
    if (!Array.isArray(assignments)) {
      return res.status(400).json({ message: "assignments must be an array" });
    }
    // Validate each assignment shape.
    for (const a of assignments) {
      if (!a || typeof a !== "object") return res.status(400).json({ message: "Invalid assignment" });
      if (!Number.isFinite(Number(a.role_id))) return res.status(400).json({ message: "role_id must be a number" });
      if (a.entity_id_scope !== null && !Number.isFinite(Number(a.entity_id_scope))) {
        return res.status(400).json({ message: "entity_id_scope must be a number or null" });
      }
      if (!getRoleById(Number(a.role_id))) return res.status(400).json({ message: `Unknown role_id ${a.role_id}` });
    }
    // Safety: don't let an Owner remove their OWN Owner-with-all-entities grant.
    // Otherwise they could lock themselves out and nobody could fix it.
    if (userId === req.userId) {
      const ownerRole = getRoleByName("Owner");
      if (ownerRole) {
        const stillOwnerEverywhere = assignments.some(
          (a: any) => Number(a.role_id) === ownerRole.id && a.entity_id_scope === null
        );
        const currentlyOwnerEverywhere = listUserRolesForUser(userId).some(
          (r) => r.role_id === ownerRole.id && r.entity_id_scope === null
        );
        if (currentlyOwnerEverywhere && !stillOwnerEverywhere) {
          return res.status(400).json({
            message: "You cannot remove your own Owner role across all entities. Ask another Owner to do it.",
          });
        }
      }
    }
    setUserRoles(userId, assignments.map((a: any) => ({
      role_id: Number(a.role_id),
      entity_id_scope: a.entity_id_scope === null ? null : Number(a.entity_id_scope),
    })));
    res.json({ ok: true, assignments: listUserRolesForUser(userId) });
  });

  // ============================================================================
  // PAYROLL ADMIN — Entities (PR #9)
  // ----------------------------------------------------------------------------
  // Read endpoints use payroll.view; write endpoints use payroll.edit_employees
  // (the same permission that gates the master employees list, since both are
  // "who is being paid where" configuration).
  // ============================================================================

  app.get("/api/payroll/entities", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    // Include inactive entities so the admin UI can show them; the UI greys
    // them out. For other consumers, use /api/settings/entities which is
    // active-only.
    const rows = listAllPayrollEntities();
    // Attach the currently-effective tip CC fee, if any, for convenience.
    const today = new Date().toISOString().slice(0, 10);
    const enriched = rows.map((e) => {
      const fee = getEffectiveProcessingFee(e.id, "tip_cc_fee", today);
      return {
        ...e,
        current_tip_cc_fee_pct: fee ? fee.fee_pct : null,
        current_tip_cc_fee_id: fee ? fee.id : null,
      };
    });
    res.json(enriched);
  });

  app.patch("/api/payroll/entities/:id", authMiddleware, requirePermission("payroll.edit_employees"), (req, res) => {
    const id = Number(req.params.id);
    const existing = getPayrollEntityById(id);
    if (!existing) return res.status(404).json({ message: "Entity not found" });
    const { location, legal_name, cadence, adp_company_code,
            commissions_enabled, pms_enabled, tips_enabled,
            easyrent_enabled, spif_enabled, active } = req.body || {};
    // Light validation: cadence must be weekly/biweekly when provided.
    if (cadence !== undefined && cadence !== "weekly" && cadence !== "biweekly") {
      return res.status(400).json({ message: "cadence must be 'weekly' or 'biweekly'" });
    }
    // Refuse to deactivate the only remaining active entity — the payroll
    // module would have nothing to run against.
    if (active === 0 && existing.active === 1) {
      const remaining = listAllPayrollEntities().filter((e) => e.id !== id && e.active === 1).length;
      if (remaining === 0) {
        return res.status(400).json({
          message: "Cannot deactivate the only active entity. Activate another first.",
        });
      }
    }
    const patch: any = {};
    if (location !== undefined) patch.location = String(location);
    if (legal_name !== undefined) patch.legal_name = String(legal_name);
    if (cadence !== undefined) patch.cadence = cadence;
    if (adp_company_code !== undefined) patch.adp_company_code = adp_company_code || null;
    if (commissions_enabled !== undefined) patch.commissions_enabled = commissions_enabled ? 1 : 0;
    if (pms_enabled !== undefined) patch.pms_enabled = pms_enabled ? 1 : 0;
    if (tips_enabled !== undefined) patch.tips_enabled = tips_enabled ? 1 : 0;
    if (easyrent_enabled !== undefined) patch.easyrent_enabled = easyrent_enabled ? 1 : 0;
    if (spif_enabled !== undefined) patch.spif_enabled = spif_enabled ? 1 : 0;
    if (active !== undefined) patch.active = active ? 1 : 0;
    const updated = updatePayrollEntity(id, patch);
    res.json(updated);
  });

  // Processing-fee history for one entity (e.g. the 3.8% Shift4 CC fee on tips).
  app.get("/api/payroll/entities/:id/fees", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const id = Number(req.params.id);
    if (!getPayrollEntityById(id)) return res.status(404).json({ message: "Entity not found" });
    res.json(listProcessingFees(id));
  });

  app.post("/api/payroll/entities/:id/fees", authMiddleware, requirePermission("payroll.edit_employees"), (req, res) => {
    const id = Number(req.params.id);
    if (!getPayrollEntityById(id)) return res.status(404).json({ message: "Entity not found" });
    const { fee_kind, fee_pct, effective_from, note } = req.body || {};
    const kind = (fee_kind || "tip_cc_fee").toString();
    const pct = Number(fee_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 1) {
      return res.status(400).json({
        message: "fee_pct must be a number between 0 and 1 (e.g. 0.038 for 3.8%)",
      });
    }
    const from = (effective_from || new Date().toISOString().slice(0, 10)).toString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ message: "effective_from must be YYYY-MM-DD" });
    }
    const row = addProcessingFee(id, kind, pct, from, note ?? null);
    res.json(row);
  });

  // ============================================================================
  // PAYROLL ADMIN — Employees (PR #10)
  // ============================================================================

  app.get("/api/payroll/employees", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const entityIdRaw = req.query.entity_id;
    const includeInactive = req.query.include_inactive === "1" || req.query.include_inactive === "true";
    const opts: { entityId?: number; includeInactive?: boolean } = { includeInactive };
    if (entityIdRaw !== undefined && entityIdRaw !== "" && entityIdRaw !== "all") {
      const n = Number(entityIdRaw);
      if (Number.isFinite(n)) opts.entityId = n;
    }
    res.json(listEmployees(opts));
  });

  app.post("/api/payroll/employees", authMiddleware, requirePermission("payroll.edit_employees"), (req, res) => {
    const { entity_id, full_name, email, shopify_staff_member_id,
            easyrent_clerk_guid, ltm_clerk_id, adp_employee_id,
            commission_rate_pct, active, hired_at, notes } = req.body || {};
    if (!Number.isFinite(Number(entity_id))) {
      return res.status(400).json({ message: "entity_id is required" });
    }
    if (!getPayrollEntityById(Number(entity_id))) {
      return res.status(400).json({ message: "Unknown entity_id" });
    }
    if (!full_name || typeof full_name !== "string" || !full_name.trim()) {
      return res.status(400).json({ message: "full_name is required" });
    }
    const row = createEmployee({
      entity_id: Number(entity_id),
      full_name: full_name.trim(),
      email: email ?? null,
      shopify_staff_member_id: shopify_staff_member_id ?? null,
      easyrent_clerk_guid: easyrent_clerk_guid ?? null,
      ltm_clerk_id: ltm_clerk_id ?? null,
      adp_employee_id: adp_employee_id ?? null,
      commission_rate_pct: commission_rate_pct === "" || commission_rate_pct === undefined || commission_rate_pct === null
        ? null
        : Number(commission_rate_pct),
      active: active === 0 ? 0 : 1,
      hired_at: hired_at ?? null,
      notes: notes ?? null,
    });
    res.json(row);
  });

  app.patch("/api/payroll/employees/:id", authMiddleware, requirePermission("payroll.edit_employees"), (req, res) => {
    const id = Number(req.params.id);
    const existing = getEmployeeById(id);
    if (!existing) return res.status(404).json({ message: "Employee not found" });
    const patch: any = {};
    const body = req.body || {};
    if (body.entity_id !== undefined) {
      const n = Number(body.entity_id);
      if (!Number.isFinite(n) || !getPayrollEntityById(n)) {
        return res.status(400).json({ message: "Unknown entity_id" });
      }
      patch.entity_id = n;
    }
    if (body.full_name !== undefined) {
      if (!String(body.full_name).trim()) return res.status(400).json({ message: "full_name cannot be empty" });
      patch.full_name = String(body.full_name).trim();
    }
    for (const k of ["email", "shopify_staff_member_id", "easyrent_clerk_guid",
                     "ltm_clerk_id", "adp_employee_id", "hired_at",
                     "terminated_at", "notes"]) {
      if (body[k] !== undefined) {
        const v = body[k];
        patch[k] = (v === "" || v === null) ? null : String(v);
      }
    }
    if (body.commission_rate_pct !== undefined) {
      const v = body.commission_rate_pct;
      patch.commission_rate_pct = (v === "" || v === null) ? null : Number(v);
    }
    if (body.active !== undefined) patch.active = body.active ? 1 : 0;
    const updated = updateEmployee(id, patch);
    res.json(updated);
  });

  // Soft-delete: marks the employee inactive instead of deleting. Hard-delete
  // is intentionally not exposed (would orphan payroll history).
  app.delete("/api/payroll/employees/:id", authMiddleware, requirePermission("payroll.edit_employees"), (req, res) => {
    const id = Number(req.params.id);
    if (!getEmployeeById(id)) return res.status(404).json({ message: "Employee not found" });
    const updated = deactivateEmployee(id);
    res.json(updated);
  });

  // ============================================================================
  // SHOPIFY RECONCILER (PR #R1)
  // ----------------------------------------------------------------------------
  // Minimal read-only API stubs that let PR #R2's Settings UI render the
  // entity ↔ Shopify location mapping table and the global policy controls.
  // No write path to orders/payouts/allocations yet — that arrives in PR #R2+.
  // ============================================================================

  app.get("/api/recon/settings", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json(getReconSettings());
  });

  app.patch("/api/recon/settings", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const updatedBy = req.user?.email || "unknown";
    const { default_digital_gc_allocation_policy, shopify_shop_domain, initial_sync_from, payout_bank_plaid_account_id } = req.body || {};
    if (default_digital_gc_allocation_policy !== undefined) {
      const allowed: string[] = ["zip_then_pro_rata", "pro_rata_only", "manual_only"];
      if (!allowed.includes(default_digital_gc_allocation_policy)) {
        return res.status(400).json({ message: `default_digital_gc_allocation_policy must be one of ${allowed.join(", ")}` });
      }
    }
    if (initial_sync_from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(initial_sync_from))) {
      return res.status(400).json({ message: "initial_sync_from must be YYYY-MM-DD" });
    }
    const updated = updateReconSettings(
      { default_digital_gc_allocation_policy, shopify_shop_domain, initial_sync_from, payout_bank_plaid_account_id },
      updatedBy,
    );
    res.json(updated);
  });

  app.get("/api/recon/pos-locations", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json(listReconEntityPosLocations());
  });

  app.patch("/api/recon/pos-locations/:id", authMiddleware, requirePermission("system.manage_config"), (req, res) => {
    const id = Number(req.params.id);
    const { shopify_location_id, shopify_location_name } = req.body || {};
    const updated = setReconShopifyLocationMapping(
      id,
      shopify_location_id != null ? String(shopify_location_id) : null,
      shopify_location_name != null ? String(shopify_location_name) : null,
    );
    if (!updated) return res.status(404).json({ message: "Mapping not found" });
    res.json(updated);
  });

  // --------------------------------------------------------------------------
  // PR #R3b — Suggested entity ↔ Shopify location mapping
  // --------------------------------------------------------------------------
  // GET returns a table where each row is one Shopify location with:
  //   - live name, active/legacy flags from Shopify
  //   - last-365d order count + sales total from recon_orders
  //   - suggested entity (fuzzy match on name)
  //   - suggested kind (pos / warehouse based on name keywords)
  //   - current saved mapping (if any) so the UI can pre-fill
  //
  // POST bulk-saves the user-confirmed table in one transaction. Idempotent —
  // re-runnable as new Shopify locations are added in the future.
  app.get("/api/recon/entity-mapping/suggested", authMiddleware, requirePermission("payroll.view"), async (_req, res) => {
    try {
      const locs = await listShopifyLocations();
      const suggestions = buildEntityMappingSuggestions(locs);
      const entities = listPayrollEntities().map(e => ({ id: e.id, location: e.location, legal_name: e.legal_name }));
      res.json({ entities, suggestions });
    } catch (e: any) {
      res.status(502).json({ message: e?.message ?? "Failed to build mapping suggestions" });
    }
  });

  app.post("/api/recon/entity-mapping/bulk-save", authMiddleware, requirePermission("system.manage_config"), (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ message: "rows[] required" });
    // Validate each row
    const cleaned: Array<{ shopify_location_id: string; shopify_location_name: string; entity_id: number; kind: "pos" | "fulfillment" | "warehouse" | "inactive" }> = [];
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const sid = r.shopify_location_id != null ? String(r.shopify_location_id) : null;
      const sname = r.shopify_location_name != null ? String(r.shopify_location_name) : "";
      const eid = Number(r.entity_id);
      const kind = String(r.kind || "pos");
      if (!sid || !Number.isFinite(eid) || eid <= 0) continue;
      if (!(["pos", "fulfillment", "warehouse", "inactive"] as const).includes(kind as any)) continue;
      cleaned.push({ shopify_location_id: sid, shopify_location_name: sname, entity_id: eid, kind: kind as any });
    }
    if (cleaned.length === 0) return res.status(400).json({ message: "No valid rows to save" });
    const result = bulkSaveReconEntityPosLocations(cleaned);
    res.json(result);
  });

  // Bird's-eye-view counters used by the Reconciler landing page so the user
  // can see at a glance how much data has been ingested. Cheap COUNT(*)s only.
  app.get("/api/recon/counts", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json(getReconCounts());
  });

  // Sync log — shared shape with /api/payroll-sync-log so a single UI tab can
  // show both ingest histories side by side.
  app.get("/api/recon/sync-log", authMiddleware, requirePermission("system.view_sync_log"), (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(listReconSyncLog(limit));
  });

  // Zip lookup admin (read + manual override). Auto-resolution lives in PR #R4.
  app.get("/api/recon/zip-lookup/:zip", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    res.json(getZipMapping(String(req.params.zip)) || null);
  });

  app.put("/api/recon/zip-lookup/:zip", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const zip = String(req.params.zip);
    if (!/^\d{5}$/.test(zip)) return res.status(400).json({ message: "zip must be a 5-digit US zip" });
    const { entity_id, distance_miles } = req.body || {};
    const entityId = entity_id == null ? null : Number(entity_id);
    const dist = distance_miles == null ? null : Number(distance_miles);
    upsertZipMapping(zip, entityId, dist, "manual", req.user?.email || "unknown");
    res.json(getZipMapping(zip));
  });

  // Prior-year frozen pro-rata snapshot — read-only in PR #R1. The freeze
  // computation arrives in PR #R4 (allocator) and is triggered manually from
  // the Settings UI once per year.
  app.get("/api/recon/prior-year-pro-rata/:year", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 3000) {
      return res.status(400).json({ message: "year must be a 4-digit integer" });
    }
    res.json(listPriorYearProRata(year));
  });

  // ==========================================================================
  // SHOPIFY RECONCILER (PR #R2) — orders sync + webhooks
  // --------------------------------------------------------------------------
  // Read-only data + manual sync trigger + webhook receiver. NO QBO posting,
  // NO allocation, NO bank match. All of that lands in PR #R3+.
  // ==========================================================================

  // Config + connectivity status. Safe to call without permission gating since
  // it returns no PII / no secrets — only env presence flags.
  app.get("/api/recon/shopify/status", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json(getShopifyReconStatus());
  });

  // Live ping — hits Shopify /shop.json. Useful for the "Test connection"
  // button in the Settings UI tile.
  app.post("/api/recon/shopify/ping", authMiddleware, requirePermission("system.manage_config"), async (_req, res) => {
    const r = await pingShopify();
    res.status(r.ok ? 200 : 502).json(r);
  });

  // Force-mint a fresh Admin API token via the client_credentials grant.
  // Clears the in-memory cache first so the user can verify credentials
  // without restarting the server. Returns a redacted preview + expiry only.
  app.post("/api/recon/shopify/token/refresh", authMiddleware, requirePermission("system.manage_config"), async (_req, res) => {
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ ok: false, error: "Shopify reconciler not configured" });
    try {
      clearShopifyTokenCache();
      const token = await getShopifyAccessToken(cfg, { forceRefresh: true });
      // Don't leak the full token to the client — only show prefix + length.
      const prefix = token.slice(0, 8);
      const status = getShopifyReconStatus();
      res.json({
        ok: true,
        tokenPrefix: prefix,
        tokenLength: token.length,
        tokenStatus: status.tokenStatus,
        authMode: status.authMode,
      });
    } catch (e: any) {
      res.status(502).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // List Shopify locations — populates the Settings dropdown next to each
  // entity ↔ POS mapping row (one-time setup when wiring 3 stores to 3 entities).
  app.get("/api/recon/shopify/locations", authMiddleware, requirePermission("payroll.view"), async (_req, res) => {
    try {
      const locs = await listShopifyLocations();
      res.json(locs);
    } catch (e: any) {
      res.status(502).json({ message: e?.message ?? "Failed to list locations" });
    }
  });

  // Manual orders sync trigger — used during testing to force a pull. Returns
  // counters synchronously. The daily cron in server/index.ts calls the same
  // function automatically.
  app.post("/api/recon/shopify/sync/orders", authMiddleware, requirePermission("system.manage_config"), async (req: any, res) => {
    const triggeredBy = `manual:${req.user?.email || "unknown"}`;
    const result = await syncOrdersIncremental(triggeredBy);
    res.status(result.error ? 502 : 200).json(result);
  });

  // PR #R4b — Fulfillment backfill. For orders ingested before R4b (which
  // didn't extract fulfillments[]), this re-pulls each order's fulfillments
  // array only and rewrites recon_order_fulfillments. Order/line item rows
  // are NOT touched, so it's safe to run repeatedly. Date range is required
  // so we don't hammer Shopify with the entire order history.
  app.post("/api/recon/shopify/sync/fulfillments-backfill", authMiddleware, requirePermission("system.manage_config"), async (req: any, res) => {
    const since = String(req.body?.since || "").trim();
    const until = req.body?.until ? String(req.body.until).trim() : undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(400).json({ message: "`since` is required as YYYY-MM-DD" });
    }
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return res.status(400).json({ message: "`until` must be YYYY-MM-DD when provided" });
    }
    // PR #R4f — reject if a backfill is already running. The original UX
    // (one user clicked "Backfill all history" five times during debugging)
    // had five concurrent runs fighting for the same Shopify rate-limit
    // bucket. Plain 409 + an existing syncLogId lets the client point at
    // the run-in-flight instead of starting another.
    const running = listRunningBackfillIds();
    if (running.length > 0) {
      return res.status(409).json({
        error: "Backfill already running",
        syncLogId: running[0],
        running,
      });
    }
    const triggeredBy = `manual:${req.user?.email || "unknown"}`;
    // Convert YYYY-MM-DD to ISO at midnight UTC. The DB query uses created_at
    // string compare, which is ISO-8601 lex-sortable, so this works.
    const sinceIso = `${since}T00:00:00Z`;
    const untilIso = until ? `${until}T00:00:00Z` : undefined;
    const result = await backfillFulfillments(triggeredBy, { sinceIso, untilIso });
    res.status(result.error ? 502 : 200).json(result);
  });

  // PR #R4c/R4f — progress poll for the fulfillment backfill.
  // - If syncLogId is provided, returns that specific run's progress (legacy).
  // - Otherwise: returns the currently-running run (state="running") if any,
  //   falling back to the most recent finished run. This lets a freshly
  //   loaded client resume the live spinner without knowing the id.
  app.get("/api/recon/shopify/sync/fulfillments-backfill/progress", authMiddleware, requirePermission("system.manage_config"), (req, res) => {
    const idStr = String(req.query.syncLogId || "").trim();
    if (idStr) {
      const id = parseInt(idStr, 10);
      const p = Number.isFinite(id) ? getBackfillProgress(id) : null;
      return res.json({ progress: p });
    }
    const active = getActiveBackfillProgress();
    const recent = listRecentBackfillProgress();
    res.json({ progress: active ?? recent[0] ?? null, recent });
  });

  // PR #R4f — cancel one or all running backfills.
  // Body: { syncLogId?: number }. If omitted, cancel every running entry.
  // Returns the syncLogIds whose cancel flags were actually set (skips
  // ids that aren't running anymore — idempotent).
  app.post("/api/recon/shopify/sync/fulfillments-backfill/cancel", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const requested = req.body?.syncLogId;
    const targets: number[] =
      typeof requested === "number" && Number.isFinite(requested)
        ? [requested]
        : listRunningBackfillIds();
    const cancelled: number[] = [];
    for (const id of targets) {
      if (requestCancelBackfill(id)) cancelled.push(id);
    }
    res.json({ cancelled });
  });

  // PR #R4l-a — Refunds backfill from raw_json. No Shopify API calls; just
  // re-parses the stored payload for every order in the range and writes
  // refunds + variance flags. Date range required so the user can run it
  // per-month without re-processing the entire history every time.
  app.post("/api/recon/refunds/backfill", authMiddleware, requirePermission("system.manage_config"), async (req: any, res) => {
    const since = String(req.body?.since || "").trim();
    const until = req.body?.until ? String(req.body.until).trim() : undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(400).json({ message: "`since` is required as YYYY-MM-DD" });
    }
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return res.status(400).json({ message: "`until` must be YYYY-MM-DD when provided" });
    }
    const triggeredBy = `manual:${req.user?.email || "unknown"}`;
    const sinceIso = `${since}T00:00:00Z`;
    const untilIso = until ? `${until}T00:00:00Z` : undefined;
    const result = await backfillRefundsFromRawJson(triggeredBy, { sinceIso, untilIso });
    res.status(result.error ? 502 : 200).json(result);
  });

  // PR #R4l-a-fix — Re-pull stale refund data from Shopify for variance
  // exceptions. Catches the Pattern-1 case where Shopify shows the order as
  // refunded but our local raw_json.refunds[] is empty (missed webhook, or
  // updated_at not bumped). Bounded by `limit` (default 100, max 500) to
  // avoid rate-limit surprises.
  app.post("/api/recon/refunds/repull-stale", authMiddleware, requirePermission("system.manage_config"), async (req: any, res) => {
    const limit = req.body?.limit != null ? Number(req.body.limit) : undefined;
    if (limit != null && (!Number.isFinite(limit) || limit < 1 || limit > 500)) {
      return res.status(400).json({ message: "`limit` must be an integer between 1 and 500" });
    }
    const triggeredBy = `manual:${req.user?.email || "unknown"}`;
    const result = await repullStaleRefunds(triggeredBy, { limit });
    res.status(result.error ? 502 : 200).json(result);
  });

  // PR #R5a-fix3 — Manual single-order re-pull. The stale-refund heuristic
  // only finds orders whose financial_status or current_total_price tipped us
  // off, but Shopify sometimes posts a refund without bumping either field
  // (or before our last incremental sync). This endpoint takes an order name
  // ("#37901") and unconditionally re-pulls that one order from Shopify,
  // re-ingesting refunds[] and fulfillment_orders[]. Use case: operator sees
  // a Shopify Finance Summary line item that doesn't appear in our diff and
  // wants to fix it without waiting for the next scheduled stale-refund run.
  app.post("/api/recon/orders/repull-by-name", authMiddleware, requirePermission("system.manage_config"), async (req: any, res) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ message: "`name` is required, e.g. '#37901'" });
    if (name.length > 32) return res.status(400).json({ message: "`name` looks malformed (too long)" });
    const result = await repullSingleOrderByName(name);
    res.status(result.error && !result.found ? 404 : 200).json(result);
  });

  // PR #R4l-a (rewritten in fix4, dispositions added in fix9) — list orders
  // with refund_variance_flag = 1 (open triage queue) plus, optionally,
  // already-resolved orders (disposition IS NOT NULL) so the UI can show a
  // "resolved" section. Each open row carries a server-suggested disposition
  // so the dropdown can pre-fill.
  app.get("/api/recon/refunds/variances", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const includeResolved = req.query.include_resolved === "1" || req.query.include_resolved === "true";
    const { sqlite } = require("./storage");
    const { suggestDisposition } = require("./shopify-recon-orders");
    const openRows = sqlite
      .prepare(`
        SELECT id, order_number, name, created_at,
               total_price, current_total_price, total_refunded,
               transactions_refunded, refund_variance_amount, refund_variance_kind,
               disposition, disposition_note, disposition_amount,
               disposition_set_at, disposition_set_by
        FROM recon_orders
        WHERE refund_variance_flag = 1
        ORDER BY ABS(refund_variance_amount) DESC
        LIMIT ?
      `)
      .all(limit) as any[];
    // Decorate each open row with the server's suggested disposition + rationale.
    const orders = openRows.map((o) => {
      const sug = suggestDisposition(o.id);
      return {
        ...o,
        suggested_disposition: sug?.disposition ?? null,
        suggested_confidence: sug?.confidence ?? null,
        suggested_rationale: sug?.rationale ?? null,
      };
    });
    const kindCounts = sqlite
      .prepare(`
        SELECT refund_variance_kind AS kind, COUNT(*) AS count
        FROM recon_orders
        WHERE refund_variance_flag = 1
        GROUP BY refund_variance_kind
      `)
      .all() as { kind: string | null; count: number }[];
    const totalCount = (sqlite
      .prepare(`SELECT COUNT(*) AS c FROM recon_orders WHERE refund_variance_flag = 1`)
      .get() as { c: number }).c;
    // Resolved = disposition tagged (irrespective of flag); used for audit trail.
    let resolved: any[] = [];
    let resolvedCount = 0;
    if (includeResolved) {
      resolved = sqlite
        .prepare(`
          SELECT id, order_number, name, created_at,
                 total_price, current_total_price, total_refunded,
                 refund_variance_amount,
                 disposition, disposition_note, disposition_amount,
                 disposition_set_at, disposition_set_by
          FROM recon_orders
          WHERE disposition IS NOT NULL
          ORDER BY disposition_set_at DESC
          LIMIT ?
        `)
        .all(limit) as any[];
      resolvedCount = (sqlite
        .prepare(`SELECT COUNT(*) AS c FROM recon_orders WHERE disposition IS NOT NULL`)
        .get() as { c: number }).c;
    }
    // Per-disposition counts — useful summary chips in the UI.
    const byDisposition = sqlite
      .prepare(`
        SELECT disposition, COUNT(*) AS count
        FROM recon_orders
        WHERE disposition IS NOT NULL
        GROUP BY disposition
      `)
      .all() as { disposition: string; count: number }[];
    res.json({
      orders,
      count: orders.length,
      total_count: totalCount,
      by_kind: kindCounts,
      by_disposition: byDisposition,
      resolved,
      resolved_count: resolvedCount,
    });
  });

  // PR #R4l-a-fix9 — set / clear a disposition on a variance-flagged order.
  // POST body: { disposition: 'partial_refund_post_sale' | 'unverified_return_to_gc'
  //                          | 'theft_post_sale_revenue_reversal' | 'other' | null,
  //              note?: string, amount?: number }
  // Setting disposition=null clears it and re-flags the order (re-runs variance).
  app.post("/api/recon/orders/:id/disposition", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const orderId = String(req.params.id);
    const { disposition, note, amount } = req.body ?? {};
    const VALID = [
      "partial_refund_post_sale",
      "unverified_return_to_gc",
      "theft_post_sale_revenue_reversal",
      "other",
    ];
    if (disposition !== null && disposition !== undefined && !VALID.includes(disposition)) {
      return res.status(400).json({ message: `Invalid disposition. Allowed: ${VALID.join(", ")} or null to clear.` });
    }
    const { sqlite, setReconOrderDisposition } = require("./storage");
    const exists = sqlite.prepare(`SELECT id FROM recon_orders WHERE id = ?`).get(orderId);
    if (!exists) return res.status(404).json({ message: "Order not found" });
    // Default disposition_amount to (total_price − current_total_price) when
    // setting a disposition without an explicit amount. Operators can override.
    let dispAmount: number | null = null;
    if (disposition !== null && disposition !== undefined) {
      if (typeof amount === "number" && Number.isFinite(amount)) {
        dispAmount = amount;
      } else {
        const row = sqlite
          .prepare(`SELECT total_price, current_total_price FROM recon_orders WHERE id = ?`)
          .get(orderId) as { total_price: number | null; current_total_price: number | null } | undefined;
        if (row) {
          dispAmount = (row.total_price ?? 0) - (row.current_total_price ?? row.total_price ?? 0);
        }
      }
    }
    setReconOrderDisposition(
      orderId,
      disposition ?? null,
      typeof note === "string" ? note : null,
      dispAmount,
      req.user?.email || "unknown",
    );
    // Re-run variance — clears the flag if disposition was set, restores if cleared.
    const { recomputeRefundVariance } = require("./shopify-recon-orders");
    const v = recomputeRefundVariance(orderId);
    res.json({ ok: true, order_id: orderId, disposition: disposition ?? null, variance: v });
  });

  // --------------------------------------------------------------------------
  // PR #R5a — Shopify Finance Summary diff (all-channels reconciliation)
  // --------------------------------------------------------------------------
  // Premise: Shopify's Finance Summary is a deterministic query over the same
  // orders + refunds we ingest. Same inputs + same formulas = same outputs.
  // Any non-zero diff is a bug to fix, not an accounting judgment.
  //
  // Workflow:
  //   1. Operator picks a month, GETs the local rollup ("ours")
  //   2. Operator exports/copies Shopify Admin → Analytics → Finance Summary
  //      for the same month, POSTs the values via /snapshot endpoint
  //   3. Operator GETs the /diff endpoint — side-by-side, all_ok true/false
  //   4. If all_ok is false, drill into specific orders and fix the ingest bug

  // Local rollup only — no snapshot required. Useful for spot-checking.
  app.get("/api/recon/finance/local/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { computeLocalFinanceSummary } = require("./shopify-finance-diff");
    res.json(computeLocalFinanceSummary(month));
  });

  // Diff (ours vs Shopify snapshot). Returns null per line if no snapshot.
  // Debug: per-order shipping breakdown for a month. Read-only. Used to find
  // where our shipping total drifts from Shopify's. Returns each order with
  // total_shipping, plus each refund-adjustment row that touches shipping,
  // and the grand totals — so an operator can spot duplicates or missing
  // shipping-refund rows immediately.
  app.get("/api/recon/finance/debug/shipping/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { sqlite } = require("./storage");
    const orders = sqlite.prepare(`
      SELECT id, order_number, name, created_at,
             total_shipping, total_discounts, total_tax, total_price
      FROM recon_orders o
      WHERE substr(datetime(o.created_at, '-5 hours'), 1, 7) = ?
        AND COALESCE(total_shipping, 0) <> 0
      ORDER BY created_at
    `).all(month);
    const refundAdjustments = sqlite.prepare(`
      SELECT r.id AS refund_id, r.order_id, r.processed_at, r.created_at AS refund_created_at,
             rli.id AS rli_id, rli.kind, rli.adjustment_kind, rli.restock_type,
             rli.subtotal, rli.total_tax,
             o.name AS order_name, o.order_number
      FROM recon_refunds r
      JOIN recon_refund_line_items rli ON rli.refund_id = r.id
      JOIN recon_orders o ON o.id = r.order_id
      WHERE substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
        AND (rli.kind = 'adjustment' OR rli.adjustment_kind IS NOT NULL OR LOWER(COALESCE(rli.restock_type, '')) LIKE '%ship%')
      ORDER BY r.processed_at
    `).all(month);
    const totals = sqlite.prepare(`
      SELECT
        (SELECT COALESCE(SUM(total_shipping), 0) FROM recon_orders
          WHERE substr(datetime(created_at, '-5 hours'), 1, 7) = ?) AS total_shipping_charged,
        (SELECT COALESCE(SUM(CASE WHEN rli.kind = 'adjustment' AND rli.adjustment_kind = 'shipping_refund'
                                  THEN rli.subtotal ELSE 0 END), 0)
           FROM recon_refunds r
           JOIN recon_refund_line_items rli ON rli.refund_id = r.id
          WHERE substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?) AS shipping_refunded_by_recon
    `).get(month, month);
    res.json({
      month,
      orders_with_shipping: orders,
      refund_adjustments_in_month: refundAdjustments,
      totals,
      note: "net_shipping (per recon) = total_shipping_charged - shipping_refunded_by_recon",
    });
  });

  app.get("/api/recon/finance/diff/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const tolerance = Number(req.query.tolerance);
    const { computeFinanceDiff } = require("./shopify-finance-diff");
    res.json(
      computeFinanceDiff(month, {
        tolerance: Number.isFinite(tolerance) ? tolerance : undefined,
      }),
    );
  });

  // PR #95 — Parallel-validation endpoint: legacy vs events vs Shopify in
  // one shot. Pure read; touches no production reconciler state. Lets
  // operators monitor the events-ledger path across the historical
  // backfill before PR #97 switches the production reconciler over.
  //
  //   GET /api/recon/finance/diff-compare/:month
  //   GET /api/recon/finance/diff-compare/:month?tolerance=0.01
  //
  // Response shape (FinanceDiffCompareResult):
  //   {
  //     month, tolerance,
  //     legacy:  { gross_sales, discounts, returns, net_sales, taxes, ... },
  //     events:  { gross_sales, discounts, returns, net_sales, taxes, return_fees, net_sales_gift_cards, event_count },
  //     shopify: <recon_shopify_finance_snapshots row>,
  //     lines: [{ field, legacy, events, shopify, shopify_raw,
  //               legacy_vs_events, events_vs_shopify, legacy_vs_shopify,
  //               ok_legacy_events, ok_events_shopify }, ...],
  //     summary: {
  //       legacy_vs_events_all_ok,
  //       events_vs_shopify_all_ok,
  //       legacy_vs_events_total_abs,
  //       events_vs_shopify_total_abs,
  //       events_count,
  //     }
  //   }
  app.get("/api/recon/finance/diff-compare/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const tolerance = Number(req.query.tolerance);
    try {
      const { computeFinanceDiffCompare } = require("./shopify-finance-diff");
      res.json(
        computeFinanceDiffCompare(month, {
          tolerance: Number.isFinite(tolerance) ? tolerance : undefined,
        }),
      );
    } catch (e: any) {
      res.status(502).json({ message: "diff-compare failed", error: String(e?.message || e) });
    }
  });

  // Debug: dump the internal components of computeLocalFinanceSummary so we
  // can see exactly which sub-total contributes to each line. Read-only.
  app.get("/api/recon/finance/debug/components/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { computeLocalFinanceSummary } = require("./shopify-finance-diff");
    res.json(computeLocalFinanceSummary(month, { includeComponents: true }));
  });

  // DRY RUN: returns what computeLocalFinanceSummary WOULD return if we shipped
  // Rule #6 (gift-card line exclusion + line-level recognized_at bucketing).
  // Pure read — no code path changed. Confirm $0.00 vs Shopify here BEFORE we
  // touch shopify-finance-diff.ts.
  app.get("/api/recon/finance/debug/dryrun-rule6/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { sqlite } = require("./storage");

    // 1. Gross sales / discounts / order count: bucket LINES on li.recognized_at
    //    (falling back to o.processed_at, then o.created_at), exclude gift cards.
    const grossRow = sqlite.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN li.is_gift_card = 0
                          THEN li.price * li.quantity ELSE 0 END), 0)        AS gross,
        COALESCE(SUM(CASE WHEN li.is_gift_card = 0
                          THEN li.total_discount ELSE 0 END), 0)             AS line_discounts_nongc,
        COALESCE(SUM(CASE WHEN li.is_gift_card = 1
                          THEN li.total_discount ELSE 0 END), 0)             AS line_discounts_gc,
        COALESCE(SUM(CASE WHEN li.is_gift_card = 1
                          THEN li.price * li.quantity - li.total_discount
                          ELSE 0 END), 0)                                    AS gc_net_sales,
        COUNT(DISTINCT CASE WHEN li.is_gift_card = 0 THEN li.order_id END)   AS order_count
      FROM recon_line_items li
      JOIN recon_orders o ON o.id = li.order_id
      WHERE substr(datetime(
        COALESCE(li.recognized_at, o.processed_at, o.created_at),
        '-5 hours'), 1, 7) = ?
    `).get(month);

    // 2. Order-level shipping/tax/discounts (still order-bucketed for now).
    const orderTotals = sqlite.prepare(`
      SELECT
        COALESCE(SUM(total_discounts), 0)                   AS total_discounts,
        COALESCE(SUM(total_shipping),  0)                   AS total_shipping,
        COALESCE(SUM(total_tax),       0)                   AS total_tax
      FROM recon_orders o
      WHERE substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) = ?
    `).get(month);

    // 3. Refunds: bucket on r.processed_at (unchanged from current behavior).
    const refundTotals = sqlite.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN rli.kind = 'item' THEN rli.subtotal ELSE 0 END), 0) AS returns_subtotal,
        COALESCE(SUM(rli.total_tax), 0)                                            AS returns_tax,
        COALESCE(SUM(CASE WHEN rli.kind = 'adjustment' AND rli.adjustment_kind = 'shipping_refund'
                          THEN ABS(rli.subtotal) ELSE 0 END), 0)                   AS shipping_refunded,
        COUNT(DISTINCT r.id)                                                       AS refund_count
      FROM recon_refunds r
      JOIN recon_refund_line_items rli ON rli.refund_id = r.id
      WHERE substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
    `).get(month);

    // Apply Rule #6: subtract GC line discounts from order discounts.
    const gross_sales = grossRow.gross;
    const discounts = orderTotals.total_discounts - grossRow.line_discounts_gc;
    const returns = refundTotals.returns_subtotal;
    const net_sales = gross_sales - discounts - returns;
    const shipping = orderTotals.total_shipping - refundTotals.shipping_refunded;
    const taxes = orderTotals.total_tax - refundTotals.returns_tax;
    const total_sales = net_sales + shipping + taxes;
    const r2 = (n: number) => Math.round(n * 100) / 100;

    res.json({
      month,
      proposed: {
        gross_sales: r2(gross_sales),
        discounts: r2(discounts),
        returns: r2(returns),
        net_sales: r2(net_sales),
        shipping: r2(shipping),
        taxes: r2(taxes),
        total_sales: r2(total_sales),
        net_sales_gift_cards: r2(grossRow.gc_net_sales),
        order_count: grossRow.order_count,
        refund_count: refundTotals.refund_count,
      },
      _diagnostics: {
        line_discounts_nongc: r2(grossRow.line_discounts_nongc),
        line_discounts_gc: r2(grossRow.line_discounts_gc),
        total_discounts_raw: r2(orderTotals.total_discounts),
        total_shipping_raw: r2(orderTotals.total_shipping),
        total_tax_raw: r2(orderTotals.total_tax),
        returns_tax: r2(refundTotals.returns_tax),
        shipping_refunded: r2(refundTotals.shipping_refunded),
      },
      note: "Dry run — returns what computeLocalFinanceSummary would return under Rule #6 (gift-card exclusion + li.recognized_at bucketing). Live diff endpoint still uses old logic.",
    });
  });

  // DRY RUN: order-date bucketing across ALL months. For each month with a
  // Shopify snapshot, run computeLocalFinanceSummary twice — once with the
  // current line.recognized_at bucketing, once with order.processed_at
  // bucketing — and show the diff against the Shopify snapshot for both.
  //
  // This lets us confirm in one call whether switching to order-date bucketing
  // closes Oct + Nov gaps WITHOUT regressing any of the 7 currently-clean
  // months. Pure read — no code path changed. If all months land within
  // tolerance, the next step is a tiny PR making 'order_processed_at' the
  // default in computeLocalFinanceSummary.
  app.get("/api/recon/finance/debug/dryrun-order-bucket", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const { sqlite } = require("./storage");
    const { computeLocalFinanceSummary } = require("./shopify-finance-diff");
    const tolerance = Number.isFinite(Number(req.query.tolerance))
      ? Number(req.query.tolerance)
      : 0.01;

    // Pull every month that has a snapshot to compare against.
    const snaps = sqlite
      .prepare(
        `SELECT month, snapshot_kind, gross_sales, discounts, returns, net_sales,
                shipping, taxes, total_sales, net_sales_gift_cards
           FROM recon_shopify_finance_snapshots
          WHERE snapshot_kind = 'all_channels'
          ORDER BY month`,
      )
      .all() as Array<{
        month: string;
        snapshot_kind: string;
        gross_sales: number | null;
        discounts: number | null;
        returns: number | null;
        net_sales: number | null;
        shipping: number | null;
        taxes: number | null;
        total_sales: number | null;
        net_sales_gift_cards: number | null;
      }>;

    // Shopify stores discounts/returns as negative; flip to positive for the
    // ours-side comparison (which is stored positive).
    const absDisc = (n: number | null) => (n == null ? null : Math.abs(n));
    const absRet = (n: number | null) => (n == null ? null : Math.abs(n));

    const FIELDS = [
      "gross_sales",
      "discounts",
      "returns",
      "net_sales",
      "shipping",
      "taxes",
      "total_sales",
    ] as const;

    // Test multiple bucketing variants in one shot.
    //   A: current default (line_recognized_at) — baseline
    //   B: order_processed_at for gross/line_tax (other knobs unchanged)
    //   C: order_created_at for gross/line_tax (matches Shopify Help docs verbatim)
    //   D: order_created_at for EVERYTHING on the sale side
    //      (gross/line_tax/shipping/unverified). Discounts inside grossRow follow gross.
    const VARIANTS: Record<string, Parameters<typeof computeLocalFinanceSummary>[1]> = {
      A_current: { bucketBy: "line_recognized_at" },
      B_proc_lines: { bucketBy: "order_processed_at" },
      C_created_lines: { bucketBy: "order_created_at" },
      D_created_all: {
        bucketBy: "order_created_at",
        shippingBucketBy: "order_created_at",
        unverifiedBucketBy: "order_created_at",
      },
    };
    const VARIANT_KEYS = Object.keys(VARIANTS);

    const results = snaps.map((snap: any) => {
      const month = snap.month;
      const shopify = {
        gross_sales: snap.gross_sales,
        discounts: absDisc(snap.discounts),
        returns: absRet(snap.returns),
        net_sales: snap.net_sales,
        shipping: snap.shipping,
        taxes: snap.taxes,
        total_sales: snap.total_sales,
      };
      const variantSummaries: Record<string, any> = {};
      for (const v of VARIANT_KEYS) {
        variantSummaries[v] = computeLocalFinanceSummary(month, VARIANTS[v]);
      }
      const fieldRows: any = {};
      for (const f of FIELDS) {
        const shop = (shopify as any)[f];
        const perVariant: Record<string, any> = {};
        for (const v of VARIANT_KEYS) {
          const val = (variantSummaries[v] as any)[f];
          perVariant[v] = {
            ours: val,
            diff: shop == null ? null : Math.round((val - shop) * 100) / 100,
          };
        }
        fieldRows[f] = { shopify: shop, ...perVariant };
      }
      const okFor = (v: string) =>
        FIELDS.every(f => {
          const d = fieldRows[f][v].diff;
          return d == null || Math.abs(d) <= tolerance;
        });
      const verdicts: Record<string, boolean> = {};
      for (const v of VARIANT_KEYS) verdicts[v] = okFor(v);

      // Per-field totals across variants for easy console.table scanning.
      const compact: any = { month };
      for (const f of FIELDS) {
        for (const v of VARIANT_KEYS) {
          compact[`${f}__${v}`] = fieldRows[f][v].diff;
        }
      }

      return {
        month,
        verdicts,
        fields: fieldRows,
        compact,
      };
    });

    const cleanCount: Record<string, number> = {};
    const cleanMonths: Record<string, string[]> = {};
    for (const v of VARIANT_KEYS) {
      cleanMonths[v] = results.filter((r: any) => r.verdicts[v]).map((r: any) => r.month);
      cleanCount[v] = cleanMonths[v].length;
    }

    // Helper: months that go from broken → clean / clean → broken vs baseline A.
    const transitions: Record<string, { fixed: string[]; regressed: string[] }> = {};
    for (const v of VARIANT_KEYS) {
      if (v === "A_current") continue;
      const fixed: string[] = [];
      const regressed: string[] = [];
      for (const r of results as any[]) {
        if (!r.verdicts.A_current && r.verdicts[v]) fixed.push(r.month);
        if (r.verdicts.A_current && !r.verdicts[v]) regressed.push(r.month);
      }
      transitions[v] = { fixed, regressed };
    }

    res.json({
      tolerance,
      months_examined: results.length,
      variants: VARIANT_KEYS,
      variants_legend: {
        A_current: "baseline — line.recognized_at (fulfillment) for sales",
        B_proc_lines: "order.processed_at for gross/line_tax (other buckets unchanged)",
        C_created_lines: "order.created_at for gross/line_tax (other buckets unchanged)",
        D_created_all: "order.created_at for gross/line_tax/shipping/unverified",
      },
      months_clean_count: cleanCount,
      months_clean: cleanMonths,
      transitions_vs_current: transitions,
      results,
      note:
        "Dry run only. Tests 4 bucketing variants against each month's Shopify snapshot. " +
        "Returns are ALWAYS bucketed on refund.processed_at (matches Shopify exactly — " +
        "per Shopify Help: 'reversals display on the day they were processed').",
    });
  });

  // Debug: distribution of exchange-line pairings by (fulfillment - order_created) gap.
  // Plus per-month breakdown of recognition-vs-creation drift. Helps answer:
  //   - is the Oct/Nov over-recognition unique, or systemic?
  //   - what gap threshold (7d, 14d, 30d, 90d) would have caught the bug?
  app.get("/api/recon/finance/debug/exchange-gap-audit", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    const { sqlite } = require("./storage");
    const tz = "'-5 hours'";

    // Per exchange-flagged line: how many days between order.created_at and line.recognized_at?
    const lines = sqlite.prepare(`
      SELECT
        o.name,
        substr(datetime(o.created_at,    ${tz}), 1, 7) AS month_order_created,
        substr(datetime(li.recognized_at, ${tz}), 1, 7) AS month_recognized,
        o.created_at AS order_created_at,
        li.recognized_at,
        li.title,
        li.price, li.quantity,
        (li.price * li.quantity) AS gross,
        MAX(li.total_discount, COALESCE(li.discount_allocations_total, 0)) AS effective_discount,
        CAST(round((julianday(li.recognized_at) - julianday(o.created_at)), 0) AS INT) AS gap_days
      FROM recon_line_items li
      JOIN recon_orders o ON o.id = li.order_id
      WHERE li.added_via_exchange_refund_id IS NOT NULL
        AND li.is_gift_card = 0
      ORDER BY gap_days DESC, gross DESC
    `).all() as any[];

    // Bucket by gap window.
    const buckets = {
      "0-7d":   { count: 0, gross: 0, disc: 0 },
      "8-14d":  { count: 0, gross: 0, disc: 0 },
      "15-30d": { count: 0, gross: 0, disc: 0 },
      "31-90d": { count: 0, gross: 0, disc: 0 },
      "91-180d":{ count: 0, gross: 0, disc: 0 },
      "180d+":  { count: 0, gross: 0, disc: 0 },
    };
    for (const l of lines) {
      const g = Number(l.gap_days) || 0;
      const gr = Number(l.gross) || 0;
      const ds = Number(l.effective_discount) || 0;
      let k: keyof typeof buckets;
      if (g <= 7) k = "0-7d";
      else if (g <= 14) k = "8-14d";
      else if (g <= 30) k = "15-30d";
      else if (g <= 90) k = "31-90d";
      else if (g <= 180) k = "91-180d";
      else k = "180d+";
      buckets[k].count += 1;
      buckets[k].gross += gr;
      buckets[k].disc += ds;
    }

    // Per-month: how much exchange gross is recognized into each month, separated
    // by short-gap (<=14d, likely legit) vs long-gap (>14d, likely bug)?
    const monthly: Record<string, { legit_gross: number; legit_disc: number; suspect_gross: number; suspect_disc: number; legit_count: number; suspect_count: number }> = {};
    for (const l of lines) {
      const m = l.month_recognized as string;
      if (!m) continue;
      monthly[m] = monthly[m] || { legit_gross: 0, legit_disc: 0, suspect_gross: 0, suspect_disc: 0, legit_count: 0, suspect_count: 0 };
      const g = Number(l.gap_days) || 0;
      const gr = Number(l.gross) || 0;
      const ds = Number(l.effective_discount) || 0;
      if (g <= 14) {
        monthly[m].legit_gross += gr;
        monthly[m].legit_disc += ds;
        monthly[m].legit_count += 1;
      } else {
        monthly[m].suspect_gross += gr;
        monthly[m].suspect_disc += ds;
        monthly[m].suspect_count += 1;
      }
    }

    res.json({
      total_exchange_lines: lines.length,
      gap_buckets: buckets,
      monthly_recognition: monthly,
      top_20_widest_gaps: lines.slice(0, 20),
      note: "gap_days = days between o.created_at and li.recognized_at. Real exchanges should land in 0-14d. Anything >30d is almost certainly a false-positive pairing (the bug).",
    });
  });

  // Debug: audit how many lines actually have a recognized_at ≠ their order's
  // created_at. If our recognized_at logic only overrides for exchange lines
  // (added_via_exchange_refund_id), the count of non-equal lines should equal
  // the count of exchange lines. If it's much larger, the override is firing
  // on more cases than intended.
  app.get("/api/recon/finance/debug/recognized-vs-created-audit", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    const { sqlite } = require("./storage");
    const tz = "'-5 hours'";
    const overall = sqlite.prepare(`
      SELECT
        COUNT(*)                                                                    AS total_lines,
        SUM(CASE WHEN li.recognized_at IS NULL                            THEN 1 ELSE 0 END) AS recognized_at_null,
        SUM(CASE WHEN li.added_via_exchange_refund_id IS NOT NULL         THEN 1 ELSE 0 END) AS exchange_lines,
        SUM(CASE WHEN li.recognized_at <> o.created_at                    THEN 1 ELSE 0 END) AS recognized_ne_created_raw,
        SUM(CASE WHEN li.recognized_at <> o.created_at
                  AND li.added_via_exchange_refund_id IS NULL              THEN 1 ELSE 0 END) AS recognized_ne_created_nonexchange,
        SUM(CASE WHEN substr(datetime(li.recognized_at, ${tz}), 1, 7) <>
                       substr(datetime(o.created_at,     ${tz}), 1, 7)
                  AND li.added_via_exchange_refund_id IS NULL              THEN 1 ELSE 0 END) AS recognized_month_ne_created_month_nonexchange,
        SUM(CASE WHEN substr(datetime(COALESCE(o.processed_at, o.created_at), ${tz}), 1, 7) <>
                       substr(datetime(o.created_at,                          ${tz}), 1, 7)
                                                                            THEN 1 ELSE 0 END) AS processed_month_ne_created_month
      FROM recon_line_items li
      JOIN recon_orders o ON o.id = li.order_id
    `).get() as Record<string, number>;

    // Sample 20 non-exchange lines where recognized_at month ≠ created_at month
    const sample = sqlite.prepare(`
      SELECT
        o.name,
        o.created_at, o.processed_at, o.cancelled_at,
        li.id AS line_id, li.title,
        li.recognized_at, li.added_via_exchange_refund_id,
        li.price, li.quantity, li.is_gift_card,
        substr(datetime(li.recognized_at, ${tz}), 1, 7) AS month_recognized,
        substr(datetime(o.created_at,     ${tz}), 1, 7) AS month_created,
        substr(datetime(o.processed_at,   ${tz}), 1, 7) AS month_processed
      FROM recon_line_items li
      JOIN recon_orders o ON o.id = li.order_id
      WHERE li.added_via_exchange_refund_id IS NULL
        AND substr(datetime(li.recognized_at, ${tz}), 1, 7) <>
            substr(datetime(o.created_at,     ${tz}), 1, 7)
      ORDER BY o.created_at DESC
      LIMIT 20
    `).all();

    res.json({ overall, sample });
  });

  // Debug: per-order date-mismatch report for a month.
  // For every order whose line.recognized_at month = :month, report:
  //   - created_at month, processed_at month, line.recognized_at month
  //   - whether they disagree (draft order / paid-later / exchange)
  //   - per-order gross + discount + tax + refund totals
  // Sort by absolute gross contribution descending so the biggest outliers
  // bubble to the top. Read-only.
  app.get("/api/recon/finance/debug/date-mismatches/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { sqlite } = require("./storage");
    const tz = "'-5 hours'";
    // Pull every order that has at least one line recognized in :month.
    const rows = sqlite.prepare(`
      WITH lines_in_month AS (
        SELECT
          li.order_id,
          SUM(CASE WHEN li.is_gift_card = 0 THEN li.price * li.quantity ELSE 0 END) AS gross_in_month,
          SUM(CASE WHEN li.is_gift_card = 0 THEN MAX(li.total_discount, COALESCE(li.discount_allocations_total, 0)) ELSE 0 END) AS disc_in_month,
          SUM(CASE WHEN li.is_gift_card = 0 THEN li.line_tax_total ELSE 0 END) AS tax_in_month,
          COUNT(*) AS lines_in_month_count,
          SUM(CASE WHEN li.added_via_exchange_refund_id IS NOT NULL THEN 1 ELSE 0 END) AS exchange_line_count
        FROM recon_line_items li
        WHERE substr(datetime(
          COALESCE(li.recognized_at, (SELECT o.processed_at FROM recon_orders o WHERE o.id = li.order_id), (SELECT o.created_at FROM recon_orders o WHERE o.id = li.order_id)),
          ${tz}), 1, 7) = ?
        GROUP BY li.order_id
      )
      SELECT
        o.id, o.order_number, o.name,
        o.created_at, o.processed_at, o.cancelled_at,
        substr(datetime(o.created_at,                              ${tz}), 1, 7) AS month_created,
        substr(datetime(COALESCE(o.processed_at, o.created_at),    ${tz}), 1, 7) AS month_processed,
        o.financial_status, o.fulfillment_status, o.source_name,
        o.total_price, o.total_discounts, o.total_tax, o.total_refunded,
        l.gross_in_month, l.disc_in_month, l.tax_in_month,
        l.lines_in_month_count, l.exchange_line_count,
        (SELECT COUNT(*) FROM recon_line_items li2 WHERE li2.order_id = o.id) AS total_lines_on_order
      FROM lines_in_month l
      JOIN recon_orders o ON o.id = l.order_id
      ORDER BY ABS(l.gross_in_month) DESC
    `).all(month);

    // Bucket rows by date-mismatch pattern.
    const buckets: Record<string, any[]> = {
      cross_month_created_vs_recognized: [], // order created in different month than recognized
      processed_vs_created_mismatch: [],     // processed_at month ≠ created_at month (draft/layaway)
      exchange_lines: [],                    // exchange replacement lines (added_via_exchange_refund_id)
      cancelled: [],
      same_month: [],                        // all dates agree on :month
    };
    const totals = {
      gross_in_month: 0, disc_in_month: 0, tax_in_month: 0,
      gross_by_bucket: {} as Record<string, number>,
      disc_by_bucket: {} as Record<string, number>,
    };
    for (const r of rows as any[]) {
      totals.gross_in_month += Number(r.gross_in_month) || 0;
      totals.disc_in_month += Number(r.disc_in_month) || 0;
      totals.tax_in_month += Number(r.tax_in_month) || 0;
      const sameCreated = r.month_created === month;
      const sameProcessed = r.month_processed === month;
      const hasExchange = (Number(r.exchange_line_count) || 0) > 0;
      const isCancelled = !!r.cancelled_at;
      let bucket: keyof typeof buckets;
      if (isCancelled) bucket = "cancelled";
      else if (hasExchange) bucket = "exchange_lines";
      else if (!sameCreated) bucket = "cross_month_created_vs_recognized";
      else if (!sameProcessed) bucket = "processed_vs_created_mismatch";
      else bucket = "same_month";
      buckets[bucket].push(r);
      totals.gross_by_bucket[bucket] = (totals.gross_by_bucket[bucket] || 0) + (Number(r.gross_in_month) || 0);
      totals.disc_by_bucket[bucket] = (totals.disc_by_bucket[bucket] || 0) + (Number(r.disc_in_month) || 0);
    }

    res.json({
      month,
      order_count: (rows as any[]).length,
      totals,
      bucket_counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
      bucket_top_10: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, (v as any[]).slice(0, 10)])),
      note:
        "Buckets are evaluated in priority order: cancelled → exchange_lines → cross_month_created_vs_recognized → processed_vs_created_mismatch → same_month. " +
        "`cross_month_created_vs_recognized` means the line was fulfilled (recognized) in :month but the order was placed in a different month — these are the exchange / late-fulfillment / deferred lines. " +
        "`processed_vs_created_mismatch` means the order was placed AND recognized in :month but payment was processed in a different month — draft / layaway / paid-later orders.",
    });
  });

  // Debug: list every order our recon bucketed into this month, so we can diff
  // against Shopify's ShopifyQL `FROM sales` order_name list and identify the
  // exact orders that disagree. Returns per-order gross/discounts/refund flags
  // so the operator can spot draft/cancelled/test orders that Shopify excludes.
  app.get("/api/recon/finance/debug/orders/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { sqlite } = require("./storage");
    const orders = sqlite.prepare(`
      SELECT
        o.id, o.order_number, o.name,
        o.created_at, o.processed_at, o.cancelled_at,
        substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) AS recognized_month,
        o.financial_status, o.fulfillment_status, o.source_name,
        o.total_price, o.subtotal, o.total_discounts, o.total_shipping, o.total_tax, o.total_refunded,
        o.current_subtotal_price, o.current_total_price, o.current_total_tax,
        o.has_gift_card,
        (SELECT COUNT(*) FROM recon_refunds r WHERE r.order_id = o.id) AS refund_count,
        (SELECT COALESCE(SUM(rli.subtotal), 0) FROM recon_refunds r
           JOIN recon_refund_line_items rli ON rli.refund_id = r.id
          WHERE r.order_id = o.id AND rli.kind = 'item') AS refund_item_subtotal_sum,
        (SELECT COALESCE(SUM(rli.total_tax), 0) FROM recon_refunds r
           JOIN recon_refund_line_items rli ON rli.refund_id = r.id
          WHERE r.order_id = o.id AND rli.kind = 'item') AS refund_item_tax_sum,
        (SELECT COALESCE(SUM(rli.subtotal), 0) FROM recon_refunds r
           JOIN recon_refund_line_items rli ON rli.refund_id = r.id
          WHERE r.order_id = o.id AND rli.kind = 'adjustment'
            AND rli.adjustment_kind = 'refund_discrepancy') AS refund_discrepancy_sum,
        (SELECT COALESCE(SUM(rli.subtotal), 0) FROM recon_refunds r
           JOIN recon_refund_line_items rli ON rli.refund_id = r.id
          WHERE r.order_id = o.id AND rli.kind = 'adjustment'
            AND rli.adjustment_kind = 'shipping_refund') AS shipping_refund_sum,
        (SELECT COALESCE(SUM(li.price * li.quantity), 0)
           FROM recon_line_items li WHERE li.order_id = o.id) AS line_gross,
        -- PR #R5a-fix2 — expose both discount columns and the MAX-of-the-two
        -- (the actual aggregator used by computeLocalFinanceSummary) so diagnostics
        -- can spot discount-code orders without re-parsing raw_json.
        (SELECT COALESCE(SUM(li.total_discount), 0)
           FROM recon_line_items li WHERE li.order_id = o.id AND li.is_gift_card = 0) AS line_total_discount,
        (SELECT COALESCE(SUM(COALESCE(li.discount_allocations_total, 0)), 0)
           FROM recon_line_items li WHERE li.order_id = o.id AND li.is_gift_card = 0) AS line_alloc_discount,
        (SELECT COALESCE(SUM(MAX(li.total_discount, COALESCE(li.discount_allocations_total, 0))), 0)
           FROM recon_line_items li WHERE li.order_id = o.id AND li.is_gift_card = 0) AS line_effective_discount,
        (SELECT COUNT(*) FROM recon_line_items li WHERE li.order_id = o.id) AS line_count,
        (SELECT COUNT(*) FROM recon_line_items li WHERE li.order_id = o.id AND li.is_gift_card = 1) AS gift_card_lines
      FROM recon_orders o
      WHERE substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) = ?
      ORDER BY o.processed_at, o.created_at
    `).all(month);
    res.json({
      month,
      order_count: orders.length,
      orders,
      note: "All orders whose recognized_month (COALESCE(processed_at, created_at) shifted -5h) matches this month. This is the same bucket used by computeLocalFinanceSummary.",
    });
  });

  // Debug endpoint for Rule #9 (retained return-shipping fees). Lists every
  // order that would be flagged by Rule #9 in :month, with the contributing
  // current_total_price and refund-side discrepancy details. Read-only.
  app.get("/api/recon/finance/debug/rule9/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { sqlite } = require("./storage");
    const rows = sqlite.prepare(`
      SELECT
        o.name,
        o.created_at,
        o.processed_at,
        o.financial_status,
        o.total_price,
        o.current_total_price,
        o.subtotal,
        o.current_subtotal_price,
        o.total_tax,
        o.current_total_tax,
        (SELECT COUNT(*) FROM recon_refunds r WHERE r.order_id = o.id) AS refund_count,
        (SELECT MIN(r.processed_at) FROM recon_refunds r
           JOIN recon_refund_line_items rli ON rli.refund_id = r.id
          WHERE r.order_id = o.id
            AND rli.kind = 'adjustment'
            AND rli.adjustment_kind = 'refund_discrepancy'
            AND substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
        ) AS rd_refund_processed_at,
        (SELECT GROUP_CONCAT(rli.subtotal, ',') FROM recon_refunds r
           JOIN recon_refund_line_items rli ON rli.refund_id = r.id
          WHERE r.order_id = o.id
            AND rli.kind = 'adjustment'
            AND rli.adjustment_kind = 'refund_discrepancy'
            AND substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
        ) AS rd_amounts,
        (SELECT COALESCE(SUM(rli.subtotal), 0) FROM recon_refunds r
           JOIN recon_refund_line_items rli ON rli.refund_id = r.id
          WHERE r.order_id = o.id
            AND rli.kind = 'adjustment'
            AND rli.adjustment_kind = 'refund_discrepancy'
            AND substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
        ) AS rd_net,
        (SELECT MAX(ABS(rli.subtotal)) FROM recon_refunds r
           JOIN recon_refund_line_items rli ON rli.refund_id = r.id
          WHERE r.order_id = o.id
            AND rli.kind = 'adjustment'
            AND rli.adjustment_kind = 'refund_discrepancy'
            AND substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
        ) AS rd_max_abs
      FROM recon_orders o
      WHERE o.current_total_price IS NOT NULL
        AND o.current_total_price > 0
        AND EXISTS (
          SELECT 1 FROM recon_refunds r
            JOIN recon_refund_line_items rli ON rli.refund_id = r.id
           WHERE r.order_id = o.id
             AND rli.kind = 'adjustment'
             AND rli.adjustment_kind = 'refund_discrepancy'
             AND substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
        )
      ORDER BY o.current_total_price DESC
    `).all(month, month, month, month, month);
    const total = rows.reduce((s: number, r: any) => s + Number(r.current_total_price || 0), 0);
    res.json({ month, count: rows.length, total_retained: Math.round(total * 100) / 100, orders: rows });
  });

  // Debug endpoint — lists every refund line item bucketed into a given month
  // using the SAME bucketing logic as the returns_subtotal aggregator in
  // shopify-finance-diff.ts (refund.processed_at, -5 hours offset).
  //
  // Purpose: hunt the Dec 2025 returns over-count of +$81.56. We need to see
  // every refund row that hits Dec on its own processed_at so we can compare
  // against Shopify's Finance Summary detail and identify which one(s) Shopify
  // excludes (or which the aggregator double-counts).
  app.get("/api/recon/finance/debug/refunds/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { sqlite } = require("./storage");
    const rows = sqlite.prepare(`
      SELECT
        r.id                                                                        AS refund_id,
        r.order_id                                                                  AS order_id,
        o.name                                                                      AS order_name,
        r.processed_at                                                              AS refund_processed_at,
        r.created_at                                                                AS refund_created_at,
        substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7)  AS bucket_month,
        o.created_at                                                                AS order_created_at,
        o.processed_at                                                              AS order_processed_at,
        o.financial_status                                                          AS financial_status,
        o.current_total_price                                                       AS current_total_price,
        o.current_subtotal_price                                                    AS current_subtotal_price,
        o.current_total_tax                                                         AS current_total_tax,
        COALESCE(SUM(CASE WHEN rli.kind = 'item' THEN rli.subtotal ELSE 0 END), 0)  AS item_subtotal,
        COALESCE(SUM(CASE WHEN rli.kind = 'item' THEN rli.total_tax ELSE 0 END), 0) AS item_tax,
        COALESCE(SUM(CASE WHEN rli.kind = 'adjustment'
                            AND rli.adjustment_kind = 'shipping_refund'
                          THEN ABS(rli.subtotal) ELSE 0 END), 0)                    AS shipping_refund_subtotal,
        COALESCE(SUM(CASE WHEN rli.kind = 'adjustment'
                            AND rli.adjustment_kind = 'shipping_refund'
                          THEN ABS(rli.total_tax) ELSE 0 END), 0)                   AS shipping_refund_tax,
        COALESCE(SUM(CASE WHEN rli.kind = 'adjustment'
                            AND rli.adjustment_kind = 'restocking_fee'
                          THEN rli.subtotal ELSE 0 END), 0)                         AS restocking_fee,
        COALESCE(SUM(CASE WHEN rli.kind = 'adjustment'
                            AND rli.adjustment_kind = 'refund_discrepancy'
                          THEN rli.subtotal ELSE 0 END), 0)                         AS refund_discrepancy,
        COUNT(rli.id)                                                               AS line_count,
        GROUP_CONCAT(rli.kind || ':' || COALESCE(rli.adjustment_kind, '') || '=' || rli.subtotal, ' | ') AS line_summary
      FROM recon_refunds r
      JOIN recon_refund_line_items rli ON rli.refund_id = r.id
      LEFT JOIN recon_orders o ON o.id = r.order_id
      WHERE substr(datetime(COALESCE(r.processed_at, r.created_at), '-5 hours'), 1, 7) = ?
      GROUP BY r.id
      ORDER BY item_subtotal DESC
    `).all(month) as any[];
    const totals = rows.reduce((acc: any, r: any) => {
      acc.item_subtotal += Number(r.item_subtotal || 0);
      acc.item_tax += Number(r.item_tax || 0);
      acc.shipping_refund_subtotal += Number(r.shipping_refund_subtotal || 0);
      acc.shipping_refund_tax += Number(r.shipping_refund_tax || 0);
      acc.restocking_fee += Number(r.restocking_fee || 0);
      acc.refund_discrepancy += Number(r.refund_discrepancy || 0);
      return acc;
    }, { item_subtotal: 0, item_tax: 0, shipping_refund_subtotal: 0, shipping_refund_tax: 0, restocking_fee: 0, refund_discrepancy: 0 });
    const round2 = (n: number) => Math.round(n * 100) / 100;
    res.json({
      month,
      refund_count: rows.length,
      totals: {
        item_subtotal: round2(totals.item_subtotal),
        item_tax: round2(totals.item_tax),
        shipping_refund_subtotal: round2(totals.shipping_refund_subtotal),
        shipping_refund_tax: round2(totals.shipping_refund_tax),
        restocking_fee: round2(totals.restocking_fee),
        refund_discrepancy: round2(totals.refund_discrepancy),
      },
      refunds: rows,
    });
  });

  // PR #81 — Bug 3 forensic endpoint.
  //
  // For a given month, produce a per-order pivot of where our recon books the
  // order's gross/discount/tax vs where Shopify (presumably) books it. Shopify
  // Finance Summary books an order's gross + discount + tax in the month of
  // o.created_at (origin month). Our recon books each LINE in the month of
  // li.recognized_at (which can differ from o.created_at when a line was added
  // via exchange/refund).
  //
  // For each order whose lines touch :month OR whose origin month is :month,
  // we return:
  //   - origin_month                       — month_of(o.created_at)
  //   - our_lines[month] = { gross, disc, tax, line_count }
  //   - shopify_attribution_month          — origin_month (the convention)
  //   - our_attribution_in_target          — our_lines[:month]
  //   - shopify_attribution_in_target      — origin_month==month ? order totals : 0
  //   - diff                               — ours - shopify, per field
  //
  // Orders are sorted by ABS(net diff) so the operator can see the biggest
  // mirror contributors first. No truncation — ALL orders affecting the diff.
  app.get("/api/recon/finance/debug/bug3-forensics/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { sqlite } = require("./storage");
    const tz = "'-5 hours'";

    // Per-order, per-line-month pivot. Sums gross/disc/tax by the month each
    // line was recognized in. Excludes gift cards and cancelled orders to
    // match Shopify's Finance Summary exclusions.
    const rows = sqlite.prepare(`
      WITH per_line AS (
        SELECT
          li.order_id,
          o.name AS order_name,
          o.order_number,
          substr(datetime(o.created_at, ${tz}), 1, 7) AS origin_month,
          substr(datetime(
            COALESCE(li.recognized_at, o.processed_at, o.created_at), ${tz}
          ), 1, 7) AS line_month,
          li.is_gift_card,
          li.added_via_exchange_refund_id IS NOT NULL AS is_exchange_line,
          (li.price * li.quantity) AS line_gross,
          MAX(li.total_discount, COALESCE(li.discount_allocations_total, 0)) AS line_disc,
          li.line_tax_total AS line_tax,
          o.total_price AS order_total_price,
          o.total_discounts AS order_total_discounts,
          o.total_tax AS order_total_tax,
          o.cancelled_at,
          o.financial_status
        FROM recon_line_items li
        JOIN recon_orders o ON o.id = li.order_id
        WHERE li.is_gift_card = 0
          AND o.cancelled_at IS NULL
      ),
      pivot AS (
        SELECT
          order_id, order_name, order_number, origin_month,
          order_total_price, order_total_discounts, order_total_tax,
          financial_status,
          SUM(CASE WHEN line_month = ?     THEN line_gross ELSE 0 END) AS gross_in_target,
          SUM(CASE WHEN line_month = ?     THEN line_disc  ELSE 0 END) AS disc_in_target,
          SUM(CASE WHEN line_month = ?     THEN line_tax   ELSE 0 END) AS tax_in_target,
          SUM(CASE WHEN line_month = ?     THEN 1 ELSE 0 END) AS lines_in_target,
          SUM(CASE WHEN line_month != ?    THEN line_gross ELSE 0 END) AS gross_other,
          SUM(CASE WHEN line_month != ?    THEN line_disc  ELSE 0 END) AS disc_other,
          SUM(CASE WHEN line_month != ?    THEN line_tax   ELSE 0 END) AS tax_other,
          SUM(CASE WHEN line_month != ?    THEN 1 ELSE 0 END) AS lines_other,
          SUM(CASE WHEN is_exchange_line=1 THEN 1 ELSE 0 END) AS exchange_line_count,
          MIN(line_month) AS first_line_month,
          MAX(line_month) AS last_line_month,
          GROUP_CONCAT(DISTINCT line_month) AS line_months
        FROM per_line
        GROUP BY order_id
      )
      SELECT * FROM pivot
       WHERE origin_month = ?
          OR lines_in_target > 0
    `).all(month, month, month, month, month, month, month, month, month) as any[];

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const enriched = rows.map((r: any) => {
      // Where Shopify presumably books this order (origin month convention)
      const shopifyAttributesToTarget = r.origin_month === month;
      const shopify_gross = shopifyAttributesToTarget ? Number(r.order_total_price) - Number(r.order_total_tax) + Number(r.order_total_discounts) : 0;
      const shopify_disc = shopifyAttributesToTarget ? Number(r.order_total_discounts) : 0;
      const shopify_tax = shopifyAttributesToTarget ? Number(r.order_total_tax) : 0;
      // Our attribution to target month
      const our_gross = Number(r.gross_in_target);
      const our_disc = Number(r.disc_in_target);
      const our_tax = Number(r.tax_in_target);

      return {
        order_name: r.order_name,
        origin_month: r.origin_month,
        line_months: r.line_months,
        exchange_line_count: Number(r.exchange_line_count),
        ours_in_target:   { gross: round2(our_gross), disc: round2(our_disc), tax: round2(our_tax), lines: Number(r.lines_in_target) },
        shopify_in_target:{ gross: round2(shopify_gross), disc: round2(shopify_disc), tax: round2(shopify_tax) },
        diff:             { gross: round2(our_gross - shopify_gross), disc: round2(our_disc - shopify_disc), tax: round2(our_tax - shopify_tax) },
        order_totals:     { gross: round2(Number(r.order_total_price) - Number(r.order_total_tax) + Number(r.order_total_discounts)), disc: round2(Number(r.order_total_discounts)), tax: round2(Number(r.order_total_tax)) },
      };
    }).filter((r: any) => {
      // Only return rows where there's an attribution difference. Same-month
      // orders with no exchange lines wash out and aren't interesting.
      return Math.abs(r.diff.gross) > 0.005 || Math.abs(r.diff.disc) > 0.005 || Math.abs(r.diff.tax) > 0.005;
    });

    enriched.sort((a: any, b: any) =>
      (Math.abs(b.diff.gross) + Math.abs(b.diff.disc) + Math.abs(b.diff.tax))
      - (Math.abs(a.diff.gross) + Math.abs(a.diff.disc) + Math.abs(a.diff.tax))
    );

    const sumDiff = enriched.reduce((acc: any, r: any) => {
      acc.gross += r.diff.gross;
      acc.disc += r.diff.disc;
      acc.tax += r.diff.tax;
      return acc;
    }, { gross: 0, disc: 0, tax: 0 });

    res.json({
      month,
      orders_with_attribution_mismatch: enriched.length,
      sum_of_diffs: { gross: round2(sumDiff.gross), disc: round2(sumDiff.disc), tax: round2(sumDiff.tax) },
      note: "diff.gross = our_gross_in_target - shopify_gross_in_target (Shopify books by o.created_at month). Sum_of_diffs SHOULD equal the gross/disc/tax diff in the finance reconciler for this month, ignoring refund/return effects.",
      orders: enriched,
    });
  });

  // PR #82 diagnostic — Look up a single recon_orders row + parsed raw_json
  // by Shopify order name (e.g. "22338" or "#22338"). Read-only. Used to
  // investigate Bug 3 (cross-boundary order edits). The raw_json carries the
  // full Shopify order payload including `transactions[]`, `order_adjustments[]`,
  // `current_*` vs `original_*` totals, and `updated_at` — which is where the
  // edit-month deltas live.
  app.get("/api/recon/finance/debug/orders/by-name/:name", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const { sqlite } = require("./storage");
    const raw = String(req.params.name || "").trim();
    if (!raw) return res.status(400).json({ message: "name required" });
    const withHash = raw.startsWith("#") ? raw : `#${raw}`;
    const noHash   = raw.startsWith("#") ? raw.slice(1) : raw;
    const row: any = sqlite.prepare(`
      SELECT
        o.id, o.order_number, o.name,
        o.created_at, o.processed_at, o.updated_at, o.cancelled_at, o.closed_at,
        substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) AS recognized_month,
        o.financial_status, o.fulfillment_status, o.source_name,
        o.total_price, o.subtotal, o.total_discounts, o.total_shipping, o.total_tax, o.total_refunded,
        o.has_gift_card,
        o.raw_json
      FROM recon_orders o
      WHERE o.name = ? OR o.name = ? OR o.order_number = ?
      LIMIT 1
    `).get(withHash, noHash, noHash);
    if (!row) return res.status(404).json({ message: `Order ${raw} not found in recon_orders` });
    let parsed: any = null;
    let parse_error: string | null = null;
    try {
      parsed = row.raw_json ? JSON.parse(row.raw_json) : null;
    } catch (e: any) {
      parse_error = String(e?.message || e);
    }
    delete row.raw_json;
    const refunds = sqlite.prepare(`
      SELECT * FROM recon_refunds WHERE order_id = ? ORDER BY processed_at, created_at
    `).all(row.id);
    const lineItems = sqlite.prepare(`
      SELECT * FROM recon_line_items WHERE order_id = ? ORDER BY id
    `).all(row.id);
    // Strip raw_json from nested rows to keep payload focused
    for (const li of lineItems) delete (li as any).raw_json;
    for (const rf of refunds) delete (rf as any).raw_json;
    res.json({
      order: row,
      refunds,
      line_items: lineItems,
      raw_json: parsed,
      parse_error,
      note: "PR #82 diagnostic. raw_json is the full Shopify payload as stored at last sync. Look at raw_json.updated_at, raw_json.order_adjustments[], raw_json.transactions[] (timestamps), and current_* vs original_* totals to find order-edit deltas.",
    });
  });

  // PR #82 diagnostic — Bug 3 blast radius. Lists every order where the
  // closed_at month (NY local) differs from the recognized month
  // (COALESCE(processed_at, created_at) -5h), with the dollars at stake.
  // Rationale: Shopify's Net Sales by Order CSV attributes discount/balance
  // to the close month for partially-paid orders that finalize later.
  // Our reconciler books everything in the created_at month, producing the
  // cross-boundary mirror seen in May/Jun and Oct/Nov. This endpoint quantifies
  // how many orders/dollars are affected across the entire history before we
  // decide on an attribution fix.
  //
  // Read-only. Returns: per-month buckets keyed by close_month, with the
  // sum of total_discounts moving (the most common delta), plus a flat list
  // of every cross-month order.
  app.get("/api/recon/finance/debug/cross-month-close", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const { sqlite } = require("./storage");
    const rows: any[] = sqlite.prepare(`
      SELECT
        o.id, o.name, o.order_number,
        o.created_at, o.processed_at, o.closed_at, o.updated_at,
        o.financial_status, o.fulfillment_status, o.source_name,
        o.total_price, o.subtotal, o.total_discounts, o.total_tax, o.total_shipping, o.total_refunded,
        substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) AS recognized_month,
        substr(datetime(o.closed_at, '-5 hours'), 1, 7) AS close_month
      FROM recon_orders o
      WHERE o.closed_at IS NOT NULL
        AND substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7)
            != substr(datetime(o.closed_at, '-5 hours'), 1, 7)
      ORDER BY o.closed_at
    `).all();

    // Bucket by (recognized_month -> close_month) pair so we can see the
    // mirror clearly: each pair will produce a +X in close_month, -X in
    // recognized_month if we shift attribution.
    const byPair = new Map<string, any>();
    let total_discount_at_stake = 0;
    let total_gross_at_stake = 0;
    for (const r of rows) {
      const key = `${r.recognized_month} -> ${r.close_month}`;
      const disc = Number(r.total_discounts || 0);
      const gross = Number(r.subtotal || 0);
      total_discount_at_stake += disc;
      total_gross_at_stake += gross;
      if (!byPair.has(key)) byPair.set(key, {
        recognized_month: r.recognized_month,
        close_month: r.close_month,
        order_count: 0,
        sum_total_discounts: 0,
        sum_subtotal: 0,
        sum_total_price: 0,
        sample_orders: [] as string[],
      });
      const b = byPair.get(key);
      b.order_count += 1;
      b.sum_total_discounts = +(b.sum_total_discounts + disc).toFixed(2);
      b.sum_subtotal = +(b.sum_subtotal + gross).toFixed(2);
      b.sum_total_price = +(b.sum_total_price + Number(r.total_price || 0)).toFixed(2);
      if (b.sample_orders.length < 5) b.sample_orders.push(r.name);
    }

    const pairs = Array.from(byPair.values()).sort((a: any, b: any) =>
      Math.abs(b.sum_total_discounts) - Math.abs(a.sum_total_discounts));

    res.json({
      total_cross_month_orders: rows.length,
      total_discount_at_stake: +total_discount_at_stake.toFixed(2),
      total_gross_at_stake: +total_gross_at_stake.toFixed(2),
      pairs,
      orders: rows,
      note: "All orders whose recognized_month (COALESCE(processed_at,created_at) -5h) differs from close_month (closed_at -5h). If we shift attribution to close_month, each pair represents -disc/+disc mirror between the two months. Compare against Bug-3 known months (2025-05/06, 2025-10/11) and any additional months not yet caught by the reconciler.",
    });
  });

  // PR #84 diagnostic — Bug 3. Proxies Shopify's REST GET /orders/:id/events.json
  // for a single order (looked up by name), returning the timeline events.
  //
  // This is the cleanest data source for post-sale order edits: Shopify's
  // /orders/:id snapshot only ever returns the current state of the order,
  // but /orders/:id/events.json returns the audit log including
  // "Order edited", item add/remove, discount applied, and refund events
  // — each with the timestamp at which it happened.
  //
  // Used to confirm the Bug 3 mechanism for #22338 (Nov 4 discount-added)
  // and #21840 (Jun 22 backend item add) before designing the attribution fix.
  //
  // Read-only. payroll.view permission. No DB writes.
  app.get("/api/recon/finance/debug/orders/by-name/:name/events", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    const { sqlite } = require("./storage");
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
    const raw = String(req.params.name || "").trim();
    if (!raw) return res.status(400).json({ message: "name required" });
    const withHash = raw.startsWith("#") ? raw : `#${raw}`;
    const noHash   = raw.startsWith("#") ? raw.slice(1) : raw;
    const row: any = sqlite.prepare(`
      SELECT id, name, order_number, created_at, processed_at, updated_at, closed_at
      FROM recon_orders
      WHERE name = ? OR name = ? OR order_number = ?
      LIMIT 1
    `).get(withHash, noHash, noHash);
    if (!row) return res.status(404).json({ message: `Order ${raw} not found in recon_orders` });
    try {
      const r = await shopifyRestCall(cfg, `/orders/${row.id}/events.json`, {
        query: { limit: 250 },
      });
      const body: any = r.json || {};
      const events: any[] = Array.isArray(body.events) ? body.events : [];
      // Surface the most relevant fields plus the raw event — we don't yet
      // know which subset of fields Shopify populates for order edits, so
      // returning the full event is the safest call.
      const summary = events.map((e: any) => ({
        id: e.id,
        created_at: e.created_at,
        verb: e.verb,
        subject_type: e.subject_type,
        subject_id: e.subject_id,
        message: e.message,
        author: e.author,
        description: e.description,
        arguments: e.arguments,
        path: e.path,
      }));
      res.json({
        order: row,
        event_count: events.length,
        events_summary: summary,
        events_raw: events,
        shopify_status: r.status,
        note: "Shopify /orders/:id/events.json output. Look for verb='order_edited' or 'discount_applied' or 'order_line_added' — the created_at on those events is when the edit actually happened, which is what Bug 3 needs to attribute deltas by.",
      });
    } catch (e: any) {
      res.status(502).json({ message: "Shopify events fetch failed", error: String(e?.message || e) });
    }
  });

  // PR #85 diagnostic — Bug 3 GraphQL pre-edit totals.
  //
  // The Shopify Admin GraphQL Order object exposes
  //   originalTotalPriceSet           = total price at order CREATION (pre-edit)
  //   currentTotalPriceSet            = total price NOW (post-edit)
  //   currentTotalDiscountsSet        = discount NOW
  //   currentSubtotalPriceSet         = subtotal NOW (post-returns/refunds)
  //   currentTotalTaxSet              = tax NOW
  //   originalTotalAdditionalFeesSet  = fees at creation
  //   originalTotalDutiesSet          = duties at creation
  // The pre-edit DISCOUNT is NOT directly exposed but is derivable from the
  // line items' original prices vs the order's originalTotalPrice.
  //
  // This endpoint runs a single GraphQL query for one order (by name) and
  // returns the structured Original-vs-Current totals plus the most recent
  // `verb=edited` event with its timestamp. If `originalTotalPriceSet` for
  // #22338 is the pre-edit price ($741.99 = $699.99 + $42 tax) and
  // `currentTotalPriceSet` is the post-edit price ($521.99), we know
  // GraphQL has what we need to model Bug 3 attribution.
  //
  // Read-only. payroll.view. No DB writes.
  app.get("/api/recon/finance/debug/orders/by-name/:name/graphql-totals", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    const { sqlite } = require("./storage");
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
    const raw = String(req.params.name || "").trim();
    if (!raw) return res.status(400).json({ message: "name required" });
    const withHash = raw.startsWith("#") ? raw : `#${raw}`;
    const noHash   = raw.startsWith("#") ? raw.slice(1) : raw;
    const row: any = sqlite.prepare(`
      SELECT id, name, order_number, created_at, processed_at, updated_at, closed_at,
             total_price, subtotal, total_discounts, total_tax, total_shipping
      FROM recon_orders
      WHERE name = ? OR name = ? OR order_number = ?
      LIMIT 1
    `).get(withHash, noHash, noHash);
    if (!row) return res.status(404).json({ message: `Order ${raw} not found` });

    const orderGid = `gid://shopify/Order/${row.id}`;
    const query = `
      query OrderTotals($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          updatedAt
          closedAt
          originalTotalPriceSet           { shopMoney { amount currencyCode } }
          originalTotalAdditionalFeesSet  { shopMoney { amount currencyCode } }
          originalTotalDutiesSet          { shopMoney { amount currencyCode } }
          currentTotalPriceSet            { shopMoney { amount currencyCode } }
          currentSubtotalPriceSet         { shopMoney { amount currencyCode } }
          currentTotalDiscountsSet        { shopMoney { amount currencyCode } }
          currentCartDiscountAmountSet    { shopMoney { amount currencyCode } }
          currentTotalTaxSet              { shopMoney { amount currencyCode } }
          currentShippingPriceSet         { shopMoney { amount currencyCode } }
          currentSubtotalLineItemsQuantity
          events(first: 50, query: "verb:edited OR action:order_edited", sortKey: CREATED_AT, reverse: true) {
            edges { node { id createdAt message } }
          }
        }
      }
    `;
    try {
      const r = await shopifyGraphqlCall(cfg, query, { id: orderGid });
      if (r.errors) {
        return res.status(502).json({ message: "GraphQL errors", errors: r.errors, data: r.data });
      }
      const o: any = (r.data as any)?.order;
      if (!o) return res.status(404).json({ message: "GraphQL order returned null" });

      const num = (mb: any) => mb?.shopMoney?.amount ? Number(mb.shopMoney.amount) : null;
      const original_total_price = num(o.originalTotalPriceSet);
      const original_total_additional_fees = num(o.originalTotalAdditionalFeesSet);
      const original_total_duties = num(o.originalTotalDutiesSet);
      const current_total_price = num(o.currentTotalPriceSet);
      const current_subtotal_price = num(o.currentSubtotalPriceSet);
      const current_total_discounts = num(o.currentTotalDiscountsSet);
      const current_cart_discount_amount = num(o.currentCartDiscountAmountSet);
      const current_total_tax = num(o.currentTotalTaxSet);
      const current_shipping_price = num(o.currentShippingPriceSet);

      const deltas = {
        gross_delta: (current_total_price ?? 0) - (original_total_price ?? 0),
        // We can't compute discount_delta directly without originalTotalDiscountsSet.
        // But: current_total_price = current_subtotal - current_discount + tax + shipping.
        // And: original_total_price = original_subtotal - original_discount + original_tax + original_shipping.
        // The Bug 3 hypothesis is that gross_delta + tax_delta + shipping_delta == -discount_delta.
        note: "originalTotalDiscountsSet is not exposed by GraphQL. To recover the pre-edit discount, the gross_delta should equal -(post-edit discount additions). For #22338 we expect originalTotalPriceSet=$741.99 (=$699.99+$42 tax, pre-discount) and currentTotalPriceSet=$521.99, giving gross_delta=-$220, which IS the discount applied at edit.",
      };

      const edits = (o.events?.edges || []).map((e: any) => ({
        id: e.node.id,
        created_at: e.node.createdAt,
        message: e.node.message,
      }));

      res.json({
        order_id: row.id,
        order_name: row.name,
        our_db: {
          total_price: row.total_price,
          subtotal: row.subtotal,
          total_discounts: row.total_discounts,
          total_tax: row.total_tax,
          total_shipping: row.total_shipping,
        },
        shopify_graphql: {
          original_total_price,
          original_total_additional_fees,
          original_total_duties,
          current_total_price,
          current_subtotal_price,
          current_total_discounts,
          current_cart_discount_amount,
          current_total_tax,
          current_shipping_price,
          current_subtotal_line_items_quantity: o.currentSubtotalLineItemsQuantity,
          created_at: o.createdAt,
          updated_at: o.updatedAt,
          closed_at: o.closedAt,
        },
        deltas,
        edit_events: edits,
        note: "PR #85 diagnostic. If shopify_graphql.original_total_price differs from shopify_graphql.current_total_price, the order was edited post-creation and the delta is what Shopify books in the edit month. Compare against edit_events[0].created_at for the edit-month timestamp.",
      });
    } catch (e: any) {
      res.status(502).json({ message: "shopifyGraphqlCall failed", error: String(e?.message || e) });
    }
  });

  // PR #96 probe (read-only) — pulls Shopify's per-line transaction
  // ledger via the Order.agreements -> sales GraphQL connection.
  // This is what powers Shopify's finance reports. Each SalesAgreement
  // has happenedAt + reason (ORDER, ORDER_EDIT, REFUND, RETURN, etc.);
  // each Sale within has actionType + lineType + totalAmount and
  // tax/discount breakdowns. We use this to validate that we can mirror
  // Shopify's ledger directly instead of synthesizing edit-deltas
  // ourselves.
  app.get("/api/recon/finance/debug/orders/by-name/:name/agreements", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    const { sqlite } = require("./storage");
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
    const raw = String(req.params.name || "").trim();
    if (!raw) return res.status(400).json({ message: "name required" });
    const withHash = raw.startsWith("#") ? raw : `#${raw}`;
    const noHash   = raw.startsWith("#") ? raw.slice(1) : raw;
    const row: any = sqlite.prepare(`
      SELECT id, name, order_number, created_at, processed_at, updated_at
      FROM recon_orders
      WHERE name = ? OR name = ? OR order_number = ?
      LIMIT 1
    `).get(withHash, noHash, noHash);
    if (!row) return res.status(404).json({ message: `Order ${raw} not found` });

    const orderGid = `gid://shopify/Order/${row.id}`;
    const query = `
      query OrderAgreements($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          processedAt
          updatedAt
          originalTotalPriceSet { shopMoney { amount } }
          currentTotalPriceSet  { shopMoney { amount } }
          agreements(first: 50) {
            edges {
              node {
                id
                happenedAt
                reason
                __typename
                ... on OrderAgreement      { app { handle } }
                ... on OrderEditAgreement  { app { handle } }
                ... on RefundAgreement     { app { handle } refund { id processedAt createdAt } }
                ... on ReturnAgreement     { app { handle } return { id name status } }
                sales(first: 50) {
                  edges {
                    node {
                      id
                      __typename
                      actionType
                      lineType
                      quantity
                      totalAmount         { shopMoney { amount currencyCode } }
                      totalDiscountAmountAfterTaxes { shopMoney { amount } }
                      totalDiscountAmountBeforeTaxes { shopMoney { amount } }
                      totalTaxAmount      { shopMoney { amount } }
                      taxes {
                        amount { shopMoney { amount } }
                        taxLine { title rate priceSet { shopMoney { amount } } }
                      }
                      ... on ProductSale {
                        lineItem { id name sku quantity originalUnitPriceSet { shopMoney { amount } } }
                      }
                      ... on GiftCardSale {
                        lineItem { id name sku }
                      }
                      ... on TipSale {
                        lineItem { id name }
                      }
                      ... on ShippingLineSale {
                        shippingLine { id title code originalPriceSet { shopMoney { amount } } }
                      }
                      ... on FeeSale {
                        fee { id }
                      }
                      ... on AdditionalFeeSale {
                        additionalFee { id name }
                      }
                      ... on DutySale {
                        duty { id }
                      }
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `;
    try {
      const r = await shopifyGraphqlCall(cfg, query, { id: orderGid });
      if (r.errors) {
        return res.status(502).json({ message: "GraphQL errors", errors: r.errors, data: r.data });
      }
      const o: any = (r.data as any)?.order;
      if (!o) return res.status(404).json({ message: "GraphQL order returned null" });
      const num = (mb: any) => mb?.shopMoney?.amount != null ? Number(mb.shopMoney.amount) : null;
      const agreements = (o.agreements?.edges || []).map((ae: any) => {
        const a = ae.node;
        const sales = (a.sales?.edges || []).map((se: any) => {
          const s = se.node;
          // Subtype-aware back-reference extraction.
          // AdjustmentSale + UnknownSale have no back-ref (ref_id stays null).
          let ref_id: string | null = null;
          let ref_name: string | null = null;
          let ref_sku:  string | null = null;
          switch (s.__typename) {
            case "ProductSale":
            case "GiftCardSale":
              ref_id   = s.lineItem?.id   || null;
              ref_name = s.lineItem?.name || null;
              ref_sku  = s.lineItem?.sku  || null;
              break;
            case "TipSale":
              ref_id   = s.lineItem?.id   || null;
              ref_name = s.lineItem?.name || null;
              break;
            case "ShippingLineSale":
              ref_id   = s.shippingLine?.id    || null;
              ref_name = s.shippingLine?.title || s.shippingLine?.code || null;
              break;
            case "FeeSale":
              ref_id = s.fee?.id || null;
              break;
            case "AdditionalFeeSale":
              ref_id   = s.additionalFee?.id   || null;
              ref_name = s.additionalFee?.name || null;
              break;
            case "DutySale":
              ref_id = s.duty?.id || null;
              break;
            // AdjustmentSale, UnknownSale: no back-ref
          }
          const tax_breakdown = (s.taxes || []).map((t: any) => ({
            amount: num(t.amount),
            title:  t.taxLine?.title || null,
            rate:   t.taxLine?.rate ?? null,
            price:  num(t.taxLine?.priceSet),
          }));
          return {
            id: s.id,
            type: s.__typename,
            action_type: s.actionType,
            line_type: s.lineType,
            quantity: s.quantity,
            total_amount: num(s.totalAmount),
            total_discount_after_taxes: num(s.totalDiscountAmountAfterTaxes),
            total_discount_before_taxes: num(s.totalDiscountAmountBeforeTaxes),
            total_tax: num(s.totalTaxAmount),
            ref_id,
            ref_name,
            ref_sku,
            tax_breakdown,
          };
        });
        return {
          id: a.id,
          type: a.__typename,
          happened_at: a.happenedAt,
          reason: a.reason,
          app_handle: a.app?.handle || null,
          refund_id: a.refund?.id || null,
          refund_processed_at: a.refund?.processedAt || null,
          return_id: a.return?.id || null,
          sales,
          sales_page_info: a.sales?.pageInfo || null,
        };
      });
      res.json({
        order_id: row.id,
        order_name: row.name,
        our_db: {
          created_at: row.created_at,
          processed_at: row.processed_at,
          updated_at: row.updated_at,
        },
        shopify_graphql: {
          original_total_price: num(o.originalTotalPriceSet),
          current_total_price:  num(o.currentTotalPriceSet),
          created_at: o.createdAt,
          processed_at: o.processedAt,
          updated_at: o.updatedAt,
        },
        agreements,
        agreements_page_info: o.agreements?.pageInfo || null,
        note: "PR #96 probe. Each agreement.happenedAt is the date Shopify books the contained sales to. Each sale carries line_item_id + amounts, so we can rebuild the events ledger one-to-one against Shopify's view.",
      });
    } catch (e: any) {
      res.status(502).json({ message: "shopifyGraphqlCall failed", error: String(e?.message || e) });
    }
  });

  // PR #96 schema-health (read-only). Materializes the new
  // recon_shopify_agreements + recon_shopify_sales tables on first hit
  // and returns current row counts.
  app.get("/api/recon/finance/debug/agreements-ledger/health", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    try {
      const {
        ensureShopifyAgreementsSchema,
        getShopifyAgreementsCounts,
      } = require("./shopify-recon-agreements");
      ensureShopifyAgreementsSchema();
      const counts = getShopifyAgreementsCounts();
      res.json({
        ok: true,
        build_id: "pr97",
        schema_ready: true,
        counts,
        note: "Agreements ledger ready. Ingest via /agreements-ledger/ingest (single order) or /agreements-ledger/backfill (batch).",
      });
    } catch (e: any) {
      res.status(500).json({ message: "agreements-ledger schema check failed", error: String(e?.message || e) });
    }
  });

  // PR #97 single-order ingest. Pulls Order.agreements -> sales from
  // Shopify GraphQL and upserts into recon_shopify_agreements +
  // recon_shopify_sales. Idempotent (re-runs bump ingest_version).
  // Read-only against Shopify.
  // Body: { name: string } e.g. "22338" or "#22338"
  app.post("/api/recon/finance/debug/agreements-ledger/ingest", authMiddleware, requirePermission("payroll.view"), async (req: any, res) => {
    const { sqlite } = require("./storage");
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
    const raw = String(req.body?.name || "").trim();
    if (!raw) return res.status(400).json({ message: "body.name required" });
    const withHash = raw.startsWith("#") ? raw : `#${raw}`;
    const noHash = raw.startsWith("#") ? raw.slice(1) : raw;
    const row: any = sqlite.prepare(`
      SELECT id, name FROM recon_orders
      WHERE name = ? OR name = ? OR order_number = ?
      LIMIT 1
    `).get(withHash, noHash, noHash);
    if (!row) return res.status(404).json({ message: `Order ${raw} not found` });

    try {
      const {
        ingestAgreementsForOrder,
        getOrderAgreementsCounts,
      } = require("./shopify-recon-agreements");
      const result = await ingestAgreementsForOrder(cfg, row.id);
      const counts_after = getOrderAgreementsCounts(row.id);
      res.json({
        ok: true,
        order_id: row.id,
        order_name: row.name,
        result,
        counts_after,
      });
    } catch (e: any) {
      res.status(502).json({ message: "ingestAgreementsForOrder failed", error: String(e?.message || e) });
    }
  });

  // PR #97 batch backfill. Kicks off a background loop and returns a
  // job id immediately. Poll progress via
  // GET /agreements-ledger/backfill/:job_id.
  // Body shapes:
  //   { scope: "all" }
  //   { scope: "edited" }                        // Bug 3 blast radius
  //   { scope: "month", month: "2025-11" }
  //   { scope: "names", names: ["22338", "21840"] }
  //   { scope: "orders", ids: ["123456789", ...] }
  app.post("/api/recon/finance/debug/agreements-ledger/backfill", authMiddleware, requirePermission("payroll.view"), (req: any, res) => {
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
    const body = req.body || {};
    const kind = String(body.scope || "").trim();
    let scope: any;
    if (kind === "all") {
      scope = { kind: "all" };
    } else if (kind === "edited") {
      scope = { kind: "edited" };
    } else if (kind === "month") {
      if (!body.month || !/^\d{4}-\d{2}$/.test(String(body.month))) {
        return res.status(400).json({ message: "body.month required as 'YYYY-MM'" });
      }
      scope = { kind: "month", month: String(body.month) };
    } else if (kind === "names") {
      if (!Array.isArray(body.names) || body.names.length === 0) {
        return res.status(400).json({ message: "body.names: string[] required" });
      }
      scope = { kind: "names", names: body.names.map((n: any) => String(n)) };
    } else if (kind === "orders") {
      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return res.status(400).json({ message: "body.ids: string[] required" });
      }
      scope = { kind: "orders", ids: body.ids.map((n: any) => String(n)) };
    } else {
      return res.status(400).json({ message: "body.scope must be one of: all | edited | month | names | orders" });
    }

    try {
      const { startAgreementsBackfill } = require("./shopify-recon-agreements");
      const progress = startAgreementsBackfill(cfg, scope);
      res.json({ ok: true, job_id: progress.job_id, total_orders: progress.total_orders, status: progress.status });
    } catch (e: any) {
      res.status(500).json({ message: "startAgreementsBackfill failed", error: String(e?.message || e) });
    }
  });

  // PR #97 backfill progress polling.
  app.get("/api/recon/finance/debug/agreements-ledger/backfill/:job_id", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    try {
      const { getBackfillProgress } = require("./shopify-recon-agreements");
      const p = getBackfillProgress(String(req.params.job_id));
      if (!p) return res.status(404).json({ message: "job not found (in-process registry only)" });
      // Trim errors[] in the response so big jobs stay readable.
      res.json({
        ...p,
        errors_count: p.errors.length,
        errors_sample: p.errors.slice(0, 10),
        errors: undefined,
      });
    } catch (e: any) {
      res.status(500).json({ message: "getBackfillProgress failed", error: String(e?.message || e) });
    }
  });

  // PR #97 read-back. Returns the agreements + sales we have stored
  // locally for one order, for comparison against the live-GraphQL
  // endpoint at /agreements (which fetches from Shopify in real time).
  app.get("/api/recon/finance/debug/orders/by-name/:name/agreements-ledger", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const { sqlite } = require("./storage");
    const raw = String(req.params.name || "").trim();
    if (!raw) return res.status(400).json({ message: "name required" });
    const withHash = raw.startsWith("#") ? raw : `#${raw}`;
    const noHash = raw.startsWith("#") ? raw.slice(1) : raw;
    const row: any = sqlite.prepare(`
      SELECT id, name FROM recon_orders
      WHERE name = ? OR name = ? OR order_number = ?
      LIMIT 1
    `).get(withHash, noHash, noHash);
    if (!row) return res.status(404).json({ message: `Order ${raw} not found` });

    const {
      ensureShopifyAgreementsSchema,
    } = require("./shopify-recon-agreements");
    ensureShopifyAgreementsSchema();

    const agreements: any[] = sqlite.prepare(`
      SELECT id, happened_at, happened_month, reason, agreement_type,
             app_handle, refund_id, return_id, ingested_at, ingest_version
      FROM recon_shopify_agreements
      WHERE order_id = ?
      ORDER BY happened_at ASC, id ASC
    `).all(row.id) as any[];
    const sales: any[] = sqlite.prepare(`
      SELECT id, agreement_id, happened_at, happened_month, sale_type,
             action_type, line_type, quantity, total_amount,
             total_discount_after_taxes, total_discount_before_taxes,
             total_tax, ref_id, ref_name, ref_sku, tax_breakdown_json,
             ingested_at, ingest_version
      FROM recon_shopify_sales
      WHERE order_id = ?
      ORDER BY happened_at ASC, id ASC
    `).all(row.id) as any[];

    // Attach sales to their parent agreement for readability.
    const byAgreement = new Map<string, any[]>();
    for (const s of sales) {
      const arr = byAgreement.get(s.agreement_id) || [];
      const taxBreakdown = (() => {
        try { return JSON.parse(s.tax_breakdown_json || "[]"); } catch { return []; }
      })();
      arr.push({ ...s, tax_breakdown: taxBreakdown, tax_breakdown_json: undefined });
      byAgreement.set(s.agreement_id, arr);
    }
    const enriched = agreements.map((a) => ({ ...a, sales: byAgreement.get(a.id) || [] }));

    res.json({
      order_id: row.id,
      order_name: row.name,
      agreements: enriched,
      counts: { agreements: agreements.length, sales: sales.length },
      note: "Local DB copy of agreements ledger. Compare with /agreements (live GraphQL) to validate ingest.",
    });
  });

  // ===================================================================
  // PR #102 — Events Projector V2 (Path B: agreements-ledger source)
  // ===================================================================
  // 4 endpoints behind the USE_AGREEMENTS_PROJECTOR feature flag. The V2
  // projector writes to recon_revenue_events_v2 (a separate table) so
  // legacy and V2 coexist for diff-compare validation.
  // -------------------------------------------------------------------

  // POST /api/recon/finance/debug/projector-v2/project
  // Body: { scope: 'all' } | { scope: 'order', orderId: string }
  // Synchronously runs the V2 projector. Wipes target scope, re-emits
  // from recon_shopify_sales. Returns counts + by_type + by_reason.
  app.post("/api/recon/finance/debug/projector-v2/project", authMiddleware, requirePermission("payroll.view"), (req: any, res) => {
    try {
      const {
        projectRevenueEventsV2,
        ensureRevenueEventsV2Schema,
      } = require("./shopify-recon-events-projector-v2");
      ensureRevenueEventsV2Schema();

      const body = req.body || {};
      const scope = String(body.scope || "all");
      if (scope === "all") {
        const summary = projectRevenueEventsV2({ scope: "all" });
        return res.json({ build_id: "pr102", ...summary });
      }
      if (scope === "order") {
        const orderId = String(body.orderId || body.order_id || "").trim();
        if (!orderId) {
          return res.status(400).json({ message: "orderId required when scope='order'" });
        }
        const summary = projectRevenueEventsV2({ scope: "order", orderId });
        return res.json({ build_id: "pr102", ...summary });
      }
      return res.status(400).json({ message: "scope must be 'all' or 'order'" });
    } catch (e: any) {
      res.status(500).json({ message: "projector-v2 failed", error: String(e?.message || e) });
    }
  });

  // GET /api/recon/finance/debug/projector-compare/:month
  // Diffs legacy recon_revenue_events vs V2 recon_revenue_events_v2 for
  // a single month (YYYY-MM, ET). Returns:
  //   - legacy totals (from aggregateRevenueEventsByMonth)
  //   - v2 totals (from aggregateRevenueEventsV2ByMonth)
  //   - delta = v2 - legacy for each column
  //   - per-order discrepancies where the two projectors disagree
  app.get("/api/recon/finance/debug/projector-compare/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    try {
      const month = String(req.params.month || "").trim();
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "month must be YYYY-MM" });
      }
      const {
        aggregateRevenueEventsByMonth,
      } = require("./shopify-recon-revenue-events");
      const {
        aggregateRevenueEventsV2ByMonth,
        ensureRevenueEventsV2Schema,
        isV2ProjectorActive,
      } = require("./shopify-recon-events-projector-v2");
      ensureRevenueEventsV2Schema();
      const { sqlite } = require("./storage");

      const legacy = aggregateRevenueEventsByMonth(month);
      const v2 = aggregateRevenueEventsV2ByMonth(month);

      const cols = ["gross_sales", "discounts", "returns", "taxes", "return_fees", "net_sales_gift_cards", "net_sales"];
      const delta: Record<string, number> = {};
      const round2 = (n: number) => Math.round(n * 100) / 100;
      for (const c of cols) {
        delta[c] = round2(Number((v2 as any)[c]) - Number((legacy as any)[c]));
      }

      // Per-order discrepancies — orders where legacy and v2 totals diverge
      // by more than $0.01 on net_sales. Limit to 200 worst offenders so
      // the response stays manageable.
      const orderDiffs: any[] = sqlite.prepare(`
        SELECT
          o.id AS order_id,
          o.name AS order_name,
          COALESCE(L.gross,0) - COALESCE(V.gross,0)   AS d_gross,
          COALESCE(L.disc,0)  - COALESCE(V.disc,0)    AS d_discount,
          COALESCE(L.ret,0)   - COALESCE(V.ret,0)     AS d_returns,
          COALESCE(L.tax,0)   - COALESCE(V.tax,0)     AS d_tax,
          COALESCE(L.rfee,0)  - COALESCE(V.rfee,0)    AS d_return_fees,
          COALESCE(L.gc,0)    - COALESCE(V.gc,0)      AS d_gc,
          (COALESCE(L.gross,0)-COALESCE(L.disc,0)-COALESCE(L.ret,0))
            - (COALESCE(V.gross,0)-COALESCE(V.disc,0)-COALESCE(V.ret,0)) AS d_net_sales
        FROM recon_orders o
        LEFT JOIN (
          SELECT order_id,
                 SUM(gross) AS gross, SUM(discount) AS disc,
                 SUM(returns) AS ret, SUM(tax) AS tax,
                 SUM(return_fees) AS rfee, SUM(net_sales_gift_cards) AS gc
          FROM recon_revenue_events
          WHERE event_month = ?
          GROUP BY order_id
        ) L ON L.order_id = o.id
        LEFT JOIN (
          SELECT order_id,
                 SUM(gross) AS gross, SUM(discount) AS disc,
                 SUM(returns) AS ret, SUM(tax) AS tax,
                 SUM(return_fees) AS rfee, SUM(net_sales_gift_cards) AS gc
          FROM recon_revenue_events_v2
          WHERE event_month = ?
          GROUP BY order_id
        ) V ON V.order_id = o.id
        WHERE (L.order_id IS NOT NULL OR V.order_id IS NOT NULL)
          AND ABS(
            (COALESCE(L.gross,0)-COALESCE(L.disc,0)-COALESCE(L.ret,0))
            - (COALESCE(V.gross,0)-COALESCE(V.disc,0)-COALESCE(V.ret,0))
          ) > 0.01
        ORDER BY ABS(
          (COALESCE(L.gross,0)-COALESCE(L.disc,0)-COALESCE(L.ret,0))
          - (COALESCE(V.gross,0)-COALESCE(V.disc,0)-COALESCE(V.ret,0))
        ) DESC
        LIMIT 200
      `).all(month, month) as any[];

      res.json({
        build_id: "pr102",
        month,
        active_projector: isV2ProjectorActive() ? "v2" : "legacy",
        flag_env: process.env.USE_AGREEMENTS_PROJECTOR || "(unset)",
        legacy,
        v2,
        delta,
        is_clean: cols.every((c) => Math.abs(delta[c]) < 0.01),
        order_diffs: orderDiffs.map((d) => ({
          ...d,
          d_gross: round2(d.d_gross),
          d_discount: round2(d.d_discount),
          d_returns: round2(d.d_returns),
          d_tax: round2(d.d_tax),
          d_return_fees: round2(d.d_return_fees),
          d_gc: round2(d.d_gc),
          d_net_sales: round2(d.d_net_sales),
        })),
        order_diff_count: orderDiffs.length,
      });
    } catch (e: any) {
      res.status(500).json({ message: "projector-compare failed", error: String(e?.message || e) });
    }
  });

  // GET /api/recon/finance/debug/projector-compare/order/:name
  // Side-by-side diff of legacy and V2 events for a single order. Useful
  // when projector-compare/:month surfaces a discrepant order and you
  // want to drill into which specific events differ.
  app.get("/api/recon/finance/debug/projector-compare/order/:name", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    try {
      const { sqlite } = require("./storage");
      const raw = String(req.params.name || "").trim();
      if (!raw) return res.status(400).json({ message: "name required" });
      const withHash = raw.startsWith("#") ? raw : `#${raw}`;
      const noHash = raw.startsWith("#") ? raw.slice(1) : raw;
      const row: any = sqlite.prepare(`
        SELECT id, name FROM recon_orders
        WHERE name = ? OR name = ? OR order_number = ?
        LIMIT 1
      `).get(withHash, noHash, noHash);
      if (!row) return res.status(404).json({ message: `Order ${raw} not found` });

      const {
        listEventsForOrder,
      } = require("./shopify-recon-revenue-events");
      const {
        listEventsV2ForOrder,
        ensureRevenueEventsV2Schema,
      } = require("./shopify-recon-events-projector-v2");
      ensureRevenueEventsV2Schema();

      const legacy = listEventsForOrder(row.id);
      const v2 = listEventsV2ForOrder(row.id);

      const sumCols = (rows: any[]) => {
        const t = { gross: 0, discount: 0, tax: 0, returns: 0, return_fees: 0, net_sales_gift_cards: 0 };
        for (const r of rows) {
          t.gross += Number(r.gross || 0);
          t.discount += Number(r.discount || 0);
          t.tax += Number(r.tax || 0);
          t.returns += Number(r.returns || 0);
          t.return_fees += Number(r.return_fees || 0);
          t.net_sales_gift_cards += Number(r.net_sales_gift_cards || 0);
        }
        return t;
      };

      res.json({
        build_id: "pr102",
        order_id: row.id,
        order_name: row.name,
        legacy: { events: legacy, totals: sumCols(legacy) },
        v2: { events: v2, totals: sumCols(v2) },
      });
    } catch (e: any) {
      res.status(500).json({ message: "projector-compare/order failed", error: String(e?.message || e) });
    }
  });

  // GET /api/recon/finance/debug/projector-v2/orders/by-name/:name
  // List V2 events for a single order. Mirrors the legacy /events endpoint
  // for direct inspection of the V2 projector output.
  app.get("/api/recon/finance/debug/projector-v2/orders/by-name/:name", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    try {
      const { sqlite } = require("./storage");
      const raw = String(req.params.name || "").trim();
      if (!raw) return res.status(400).json({ message: "name required" });
      const withHash = raw.startsWith("#") ? raw : `#${raw}`;
      const noHash = raw.startsWith("#") ? raw.slice(1) : raw;
      const row: any = sqlite.prepare(`
        SELECT id, name FROM recon_orders
        WHERE name = ? OR name = ? OR order_number = ?
        LIMIT 1
      `).get(withHash, noHash, noHash);
      if (!row) return res.status(404).json({ message: `Order ${raw} not found` });

      const {
        listEventsV2ForOrder,
        ensureRevenueEventsV2Schema,
      } = require("./shopify-recon-events-projector-v2");
      ensureRevenueEventsV2Schema();

      const events = listEventsV2ForOrder(row.id);
      res.json({
        build_id: "pr102",
        order_id: row.id,
        order_name: row.name,
        count: events.length,
        events,
      });
    } catch (e: any) {
      res.status(500).json({ message: "projector-v2/orders failed", error: String(e?.message || e) });
    }
  });

  // PR #85b diagnostic. Batch version of /graphql-totals.
  // POST body: { names: string[] } (with or without leading '#'; max 25)
  // For each order: runs the same GraphQL query, computes the
  // tax-rate-back-out estimate of original_subtotal and subtotal_delta
  // (the value Shopify's net-sales-by-order CSV books to the edit month).
  // Read-only. Used to validate the Path B attribution formula on 5-10
  // Bug 3 candidates from the 522-order blast radius before committing
  // it to the real fix in PR #86.
  app.post("/api/recon/finance/debug/orders/graphql-totals-batch", authMiddleware, requirePermission("payroll.view"), async (req: any, res) => {
    const { sqlite } = require("./storage");
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
    const inNames: any = req.body?.names;
    if (!Array.isArray(inNames) || inNames.length === 0) {
      return res.status(400).json({ message: "body.names: string[] required" });
    }
    if (inNames.length > 25) {
      return res.status(400).json({ message: "max 25 names per batch" });
    }

    const round2 = (n: number | null | undefined) =>
      n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;

    const query = `
      query OrderTotals($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          updatedAt
          closedAt
          originalTotalPriceSet           { shopMoney { amount currencyCode } }
          currentTotalPriceSet            { shopMoney { amount currencyCode } }
          currentSubtotalPriceSet         { shopMoney { amount currencyCode } }
          currentTotalDiscountsSet        { shopMoney { amount currencyCode } }
          currentTotalTaxSet              { shopMoney { amount currencyCode } }
          currentShippingPriceSet         { shopMoney { amount currencyCode } }
          events(first: 10, query: "verb:edited OR action:order_edited", sortKey: CREATED_AT, reverse: true) {
            edges { node { id createdAt message } }
          }
        }
      }
    `;

    const results: any[] = [];
    for (const raw0 of inNames) {
      const raw = String(raw0 || "").trim();
      if (!raw) { results.push({ input: raw0, error: "empty name" }); continue; }
      const withHash = raw.startsWith("#") ? raw : `#${raw}`;
      const noHash   = raw.startsWith("#") ? raw.slice(1) : raw;
      const row: any = sqlite.prepare(`
        SELECT id, name, order_number, created_at, updated_at, closed_at,
               total_price, subtotal, total_discounts, total_tax, total_shipping
        FROM recon_orders
        WHERE name = ? OR name = ? OR order_number = ?
        LIMIT 1
      `).get(withHash, noHash, noHash);
      if (!row) { results.push({ input: raw, error: "not found in recon_orders" }); continue; }

      const orderGid = `gid://shopify/Order/${row.id}`;
      try {
        const r = await shopifyGraphqlCall(cfg, query, { id: orderGid });
        if (r.errors) {
          results.push({ input: raw, order_id: row.id, error: "graphql errors", errors: r.errors });
          continue;
        }
        const o: any = (r.data as any)?.order;
        if (!o) { results.push({ input: raw, order_id: row.id, error: "graphql order null" }); continue; }

        const num = (mb: any) => mb?.shopMoney?.amount != null ? Number(mb.shopMoney.amount) : null;
        const original_total_price = num(o.originalTotalPriceSet);
        const current_total_price  = num(o.currentTotalPriceSet);
        const current_subtotal     = num(o.currentSubtotalPriceSet);
        const current_discounts    = num(o.currentTotalDiscountsSet);
        const current_tax          = num(o.currentTotalTaxSet);
        const current_shipping     = num(o.currentShippingPriceSet);

        // Path B: back out the original subtotal using current tax rate.
        //   implied_tax_rate = current_tax / current_subtotal
        //   original_subtotal_est = (original_total_price - current_shipping) / (1 + implied_tax_rate)
        // Notes:
        //   - We assume shipping was not changed during the edit (best effort).
        //   - We assume tax rate is stable per order (no mixed-rate items).
        //   - Validated against #22338 (-$220) and #21840 (+$588) to the penny.
        let implied_tax_rate: number | null = null;
        let original_subtotal_est: number | null = null;
        let subtotal_delta_est: number | null = null;
        if (
          current_subtotal != null && current_subtotal > 0 &&
          current_tax != null && original_total_price != null
        ) {
          implied_tax_rate = current_tax / current_subtotal;
          const pre_tax_pre_shipping = original_total_price - (current_shipping || 0);
          original_subtotal_est = pre_tax_pre_shipping / (1 + implied_tax_rate);
          subtotal_delta_est = current_subtotal - original_subtotal_est;
        }

        const gross_delta =
          current_total_price != null && original_total_price != null
            ? current_total_price - original_total_price
            : null;

        const editEdges = (o.events?.edges || []) as any[];
        const firstEdit = editEdges[editEdges.length - 1]?.node; // oldest first edit
        const lastEdit  = editEdges[0]?.node;                    // newest edit

        results.push({
          input: raw,
          order_id: row.id,
          order_name: row.name,
          created_at: o.createdAt,
          updated_at: o.updatedAt,
          closed_at: o.closedAt,
          first_edit_at: firstEdit?.createdAt || null,
          last_edit_at: lastEdit?.createdAt || null,
          edit_event_count: editEdges.length,
          shopify: {
            original_total_price: round2(original_total_price),
            current_total_price:  round2(current_total_price),
            current_subtotal:     round2(current_subtotal),
            current_discounts:    round2(current_discounts),
            current_tax:          round2(current_tax),
            current_shipping:     round2(current_shipping),
          },
          path_b: {
            implied_tax_rate: implied_tax_rate == null ? null : Math.round(implied_tax_rate * 100000) / 100000,
            original_subtotal_est: round2(original_subtotal_est),
            subtotal_delta_est: round2(subtotal_delta_est),
            gross_delta: round2(gross_delta),
          },
        });
      } catch (e: any) {
        results.push({ input: raw, order_id: row.id, error: String(e?.message || e) });
      }
    }

    res.json({
      count: results.length,
      results,
      note: "PR #85b: Path B = tax-rate-back-out formula. original_subtotal_est = (originalTotalPrice - currentShipping) / (1 + currentTax/currentSubtotal). subtotal_delta_est is the predicted edit-month attribution amount (should match Shopify net-sales-by-order CSV).",
    });
  });

  // PR #85c diagnostic. Full-history enumeration of orders that have at
  // least one Shopify Admin GraphQL 'edited' event AND whose
  // originalTotalPriceSet != currentTotalPriceSet. Returns Path B
  // subtotal_delta_est for every match so we can validate the formula
  // exhaustively before PR #86.
  //
  // POST body: {
  //   updated_at_min?: string   // ISO; default "2024-01-01T00:00:00Z"
  //   updated_at_max?: string   // ISO; default now
  //   page_size?: number        // default 50, max 100 (GraphQL bulk safety)
  //   cursor?: string           // GraphQL endCursor from previous page
  // }
  //
  // Returns:
  //   { page_count, has_next_page, end_cursor, results: [{name, deltas, ...}],
  //     scanned_count, edited_count }
  //
  // Read-only. payroll.view permission.
  app.post("/api/recon/finance/debug/orders/enumerate-edited", authMiddleware, requirePermission("payroll.view"), async (req: any, res) => {
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });

    const updatedMin = String(req.body?.updated_at_min || "2024-01-01T00:00:00Z");
    const updatedMax = String(req.body?.updated_at_max || new Date().toISOString());
    const pageSize = Math.min(Math.max(Number(req.body?.page_size) || 50, 1), 100);
    const cursor: string | null = req.body?.cursor || null;

    const round2 = (n: number | null | undefined) =>
      n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;

    // Page through Shopify orders by updatedAt.
    //
    // NOTE (PR #85d fix): we previously included an `events(query: "verb:edited")`
    // sub-selection here. That works fine when querying ONE order at a time
    // (PR #85/#85b), but inside the orders connection Shopify silently
    // returns 0 events for every order — appears to be a nested-connection
    // cost-limit truncation. As a result PR #85c (with that subselection)
    // scanned 10,000 orders and returned 0 edits even though #22338 and
    // #21840 demonstrably have verb=edited events.
    //
    // Fix: drop the events sub-selection. Detect candidates purely by
    // originalTotalPriceSet != currentTotalPriceSet. This catches order
    // edits AND refunds — we distinguish them client-side or in a follow-up
    // per-order call against PR #85b.
    const query = `
      query EditedOrdersPage($first: Int!, $after: String, $q: String!) {
        orders(first: $first, after: $after, query: $q, sortKey: UPDATED_AT) {
          pageInfo { hasNextPage endCursor }
          edges {
            cursor
            node {
              id
              name
              createdAt
              updatedAt
              closedAt
              originalTotalPriceSet  { shopMoney { amount } }
              currentTotalPriceSet   { shopMoney { amount } }
              currentSubtotalPriceSet{ shopMoney { amount } }
              currentTotalDiscountsSet{ shopMoney { amount } }
              currentTotalTaxSet     { shopMoney { amount } }
              currentShippingPriceSet{ shopMoney { amount } }
            }
          }
        }
      }
    `;

    // Shopify orders search query string: updated_at range
    const qStr = `updated_at:>='${updatedMin}' AND updated_at:<='${updatedMax}'`;

    try {
      const r = await shopifyGraphqlCall(cfg, query, {
        first: pageSize,
        after: cursor,
        q: qStr,
      });
      if (r.errors) {
        return res.status(502).json({ message: "GraphQL errors", errors: r.errors });
      }
      const conn: any = (r.data as any)?.orders;
      if (!conn) return res.status(502).json({ message: "GraphQL orders connection null" });

      const edges: any[] = conn.edges || [];
      const num = (mb: any) => mb?.shopMoney?.amount != null ? Number(mb.shopMoney.amount) : null;

      const results: any[] = [];
      let editedCount = 0;

      for (const e of edges) {
        const o = e.node;

        const original_total_price = num(o.originalTotalPriceSet);
        const current_total_price  = num(o.currentTotalPriceSet);
        const current_subtotal     = num(o.currentSubtotalPriceSet);
        const current_discounts    = num(o.currentTotalDiscountsSet);
        const current_tax          = num(o.currentTotalTaxSet);
        const current_shipping     = num(o.currentShippingPriceSet);

        if (original_total_price == null || current_total_price == null) continue;
        // Detection: any order where original_total_price != current_total_price.
        // This catches both true edits (Bug 3) and refunds. Refunds get
        // filtered out client-side by checking against the refund table,
        // or in a follow-up per-order PR #85b call to inspect events.
        if (Math.abs(original_total_price - current_total_price) < 0.01) continue;

        editedCount++;

        let implied_tax_rate: number | null = null;
        let original_subtotal_est: number | null = null;
        let subtotal_delta_est: number | null = null;
        if (current_subtotal != null && current_subtotal > 0 && current_tax != null) {
          implied_tax_rate = current_tax / current_subtotal;
          const pre_tax_pre_shipping = original_total_price - (current_shipping || 0);
          original_subtotal_est = pre_tax_pre_shipping / (1 + implied_tax_rate);
          subtotal_delta_est = current_subtotal - original_subtotal_est;
        }

        results.push({
          order_id: String(o.id).replace("gid://shopify/Order/", ""),
          name: o.name,
          created_at: o.createdAt,
          updated_at: o.updatedAt,
          closed_at: o.closedAt,
          // edit_at proxy: when there's no events subselection, we use
          // updatedAt (the most recent modification timestamp) as the
          // attribution timestamp. For most edits this is == the edit time.
          // For refunds it's the refund time. Client-side reconciliation
          // step should validate against the actual event verb via PR #85b
          // before booking.
          edit_at_proxy: o.updatedAt,
          shopify: {
            original_total_price: round2(original_total_price),
            current_total_price:  round2(current_total_price),
            current_subtotal:     round2(current_subtotal),
            current_discounts:    round2(current_discounts),
            current_tax:          round2(current_tax),
            current_shipping:     round2(current_shipping),
          },
          path_b: {
            implied_tax_rate: implied_tax_rate == null ? null : Math.round(implied_tax_rate * 100000) / 100000,
            original_subtotal_est: round2(original_subtotal_est),
            subtotal_delta_est:    round2(subtotal_delta_est),
            gross_delta:           round2(current_total_price - original_total_price),
          },
        });
      }

      res.json({
        scanned_count: edges.length,
        edited_count: editedCount,
        results,
        page_info: {
          has_next_page: conn.pageInfo?.hasNextPage || false,
          end_cursor: conn.pageInfo?.endCursor || null,
        },
        query_args: { updated_at_min: updatedMin, updated_at_max: updatedMax, page_size: pageSize, cursor },
        note: "PR #85d (fix): events sub-selection inside the orders connection silently returned 0 events due to a nested-connection cost limit. Detection now relies solely on originalTotalPriceSet != currentTotalPriceSet. Catches edits AND refunds; the caller should distinguish them via PR #85b (verb=edited check per order).",
      });
    } catch (e: any) {
      res.status(502).json({ message: "enumerate-edited failed", error: String(e?.message || e) });
    }
  });

  // PR #86a — populate recon_order_edits ledger.
  //
  // DATA-LAYER ONLY. This endpoint reads from Shopify and writes to the new
  // recon_order_edits table. It DOES NOT touch the reconciler math —
  // computeLocalFinanceSummary() ignores the table for now. The attribution
  // change ships in PR #86b after we visually verify the rows here match
  // the 9 true edits enumerated via PR #88 (only #21840 and #22338 should
  // affect cross-month buckets).
  //
  // Strategy: page through the Shopify Admin GraphQL orders connection by
  // updatedAt (same query as PR #88), filter to orders whose original total
  // != current total, then per matching order call detectOrderEdit() which
  // runs the single-order query that DOES include the events sub-selection
  // (works at single-order scope; only fails at the connection level — see
  // PR #88 commit note). For each detection we upsert into recon_order_edits.
  //
  // Body: {
  //   updated_at_min?: string   // ISO; default "2024-01-01T00:00:00Z"
  //   updated_at_max?: string   // ISO; default now
  //   page_size?: number        // default 50, max 100
  //   cursor?: string           // GraphQL endCursor from previous page
  //   dry_run?: boolean         // when true, returns detections but does
  //                             // NOT write to the table. Default false.
  // }
  //
  // Returns: { scanned_count, edited_count, written_count, results: [...],
  //            page_info: {has_next_page, end_cursor}, ledger_total }
  //
  // Read-only impact on the reconciler. payroll.view permission.
  app.post("/api/recon/finance/debug/orders/populate-edits", authMiddleware, requirePermission("payroll.view"), async (req: any, res) => {
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });

    const { sqlite } = require("./storage");
    const {
      detectOrderEdit,
      upsertOrderEdit,
      ensureOrderEditsSchema,
    } = require("./shopify-recon-order-edits");
    ensureOrderEditsSchema();

    const updatedMin = String(req.body?.updated_at_min || "2024-01-01T00:00:00Z");
    const updatedMax = String(req.body?.updated_at_max || new Date().toISOString());
    const pageSize = Math.min(Math.max(Number(req.body?.page_size) || 50, 1), 100);
    const cursor: string | null = req.body?.cursor || null;
    const dryRun: boolean = req.body?.dry_run === true;

    // First pass: enumerate candidates via the connection-level query.
    // Same query and detection rule as PR #88 — original_total_price !=
    // current_total_price. We intentionally do NOT filter by event verb
    // here because the nested events sub-selection is unreliable at the
    // connection level (PR #85d finding).
    const pageQuery = `
      query EditedOrdersPage($first: Int!, $after: String, $q: String!) {
        orders(first: $first, after: $after, query: $q, sortKey: UPDATED_AT) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              originalTotalPriceSet  { shopMoney { amount } }
              currentTotalPriceSet   { shopMoney { amount } }
            }
          }
        }
      }
    `;
    const qStr = `updated_at:>='${updatedMin}' AND updated_at:<='${updatedMax}'`;

    try {
      const r = await shopifyGraphqlCall(cfg, pageQuery, {
        first: pageSize,
        after: cursor,
        q: qStr,
      });
      if (r.errors) {
        return res.status(502).json({ message: "GraphQL errors", errors: r.errors });
      }
      const conn: any = (r.data as any)?.orders;
      if (!conn) return res.status(502).json({ message: "GraphQL orders connection null" });

      const edges: any[] = conn.edges || [];
      const numAmt = (mb: any) => mb?.shopMoney?.amount != null ? Number(mb.shopMoney.amount) : null;

      // Build the candidate list — orders whose total moved.
      const candidateOrderIds: string[] = [];
      for (const e of edges) {
        const o = e.node;
        const orig = numAmt(o.originalTotalPriceSet);
        const curr = numAmt(o.currentTotalPriceSet);
        if (orig == null || curr == null) continue;
        if (Math.abs(orig - curr) < 0.01) continue;
        candidateOrderIds.push(String(o.id).replace("gid://shopify/Order/", ""));
      }

      // Second pass: per-candidate single-order GraphQL via detectOrderEdit().
      // This is the query that DOES include events — it works because we
      // ask for one order at a time. The per-order call cost is cheap
      // (~1 cost unit each); doing it serially keeps us under any burst
      // limits even on a 100-candidate page.
      const results: any[] = [];
      let writtenCount = 0;
      for (const orderId of candidateOrderIds) {
        try {
          const detection = await detectOrderEdit(cfg, orderId);
          if (!detection) {
            results.push({ order_id: orderId, skipped: "no edit detected" });
            continue;
          }
          if (!dryRun) {
            upsertOrderEdit(detection, "populate-edits-endpoint");
            writtenCount++;
          }
          results.push(detection);
        } catch (err: any) {
          results.push({ order_id: orderId, error: String(err?.message || err) });
        }
      }

      const ledgerTotal: number = (sqlite
        .prepare(`SELECT COUNT(*) AS n FROM recon_order_edits`)
        .get() as any)?.n ?? 0;

      res.json({
        scanned_count: edges.length,
        candidate_count: candidateOrderIds.length,
        written_count: writtenCount,
        dry_run: dryRun,
        results,
        page_info: {
          has_next_page: conn.pageInfo?.hasNextPage || false,
          end_cursor: conn.pageInfo?.endCursor || null,
        },
        ledger_total: ledgerTotal,
        query_args: { updated_at_min: updatedMin, updated_at_max: updatedMax, page_size: pageSize, cursor, dry_run: dryRun },
        // PR #86a-fix2: build sentinel so we can confirm which code is live.
        // Bump whenever detector logic changes so dry-run output is unambiguous.
        build_id: "86a-fix2",
        note: "PR #86a: data layer only. Rows written to recon_order_edits do NOT affect the reconciler — computeLocalFinanceSummary() ignores the table until PR #86b. Run with dry_run=true first to preview detections.",
      });
    } catch (e: any) {
      res.status(502).json({ message: "populate-edits failed", error: String(e?.message || e) });
    }
  });

  // PR #86a-fix4 diagnostic. Side-by-side view of one order: local
  // recon_orders + line-item subtotal aggregate + refund aggregate,
  // vs Shopify Admin's current totals + refund state. Built for the
  // edited-to-zero investigation — lets us verify whether the local
  // line-item rollup reflects the post-edit state ($0), and whether
  // a refund row already books the negative attribution.
  //
  // pattern classifier values:
  //   refund_via_edit_fully_refunded — total_refunded == original, edit
  //     just cosmetic; recon_refunds already corrects local books.
  //   edited_to_zero_no_refund — no refund row; pure write-off; we
  //     need to book -local_net_subtotal in edit-month.
  //   edited_to_zero_partial_refund — needs manual review.
  //   other — not zeroed; normal edit.
  // Read-only.
  //
  // POST body: { order_id?: string, order_name?: string }   // one or other
  app.post("/api/recon/finance/debug/orders/local-vs-shopify", authMiddleware, requirePermission("payroll.view"), async (req: any, res) => {
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
    const { sqlite } = require("./storage");

    const orderId = String(req.body?.order_id || "").trim();
    const orderName = String(req.body?.order_name || "").trim();
    if (!orderId && !orderName) return res.status(400).json({ message: "body.order_id or body.order_name required" });

    // Resolve to recon_orders row.
    const row: any = orderId
      ? sqlite.prepare(`SELECT id, name, created_at, updated_at, total_price, subtotal, total_tax, total_discounts, total_shipping, ingest_version, ingested_at FROM recon_orders WHERE id = ?`).get(orderId)
      : sqlite.prepare(`SELECT id, name, created_at, updated_at, total_price, subtotal, total_tax, total_discounts, total_shipping, ingest_version, ingested_at FROM recon_orders WHERE name = ? OR name = ?`).get(orderName.startsWith("#") ? orderName : `#${orderName}`, orderName.startsWith("#") ? orderName.slice(1) : orderName);
    if (!row) return res.status(404).json({ message: "not found in recon_orders", looked_up: { orderId, orderName } });

    // Local line-item rollup.
    const lineAgg: any = sqlite.prepare(`
      SELECT
        COUNT(*) AS line_count,
        COALESCE(SUM(price * quantity), 0)               AS gross_pre_discount,
        COALESCE(SUM(MAX(total_discount, COALESCE(discount_allocations_total, 0))), 0) AS line_discounts,
        COALESCE(SUM(price * quantity)
               - SUM(MAX(total_discount, COALESCE(discount_allocations_total, 0))), 0) AS net_subtotal,
        SUM(CASE WHEN is_gift_card = 1 THEN 1 ELSE 0 END) AS gift_card_lines
      FROM recon_line_items
      WHERE order_id = ?
    `).get(row.id);

    // Local refund rollup (recon_refunds is denormalized by order_id).
    const refundAgg: any = sqlite.prepare(`
      SELECT
        COUNT(*)                              AS refund_count,
        COALESCE(SUM(subtotal), 0)            AS refund_subtotal_sum,
        COALESCE(SUM(total_tax), 0)           AS refund_tax_sum,
        COALESCE(SUM(total_refunded), 0)      AS refund_total_sum,
        COALESCE(SUM(adjustment_amount), 0)   AS refund_adjustment_sum,
        MAX(processed_at)                     AS last_processed_at
      FROM recon_refunds
      WHERE order_id = ?
    `).get(row.id);

    // Ask Shopify for the live totals + refund state.
    const probeQuery = `
      query OrderTotalsForDiag($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          updatedAt
          displayFinancialStatus
          originalTotalPriceSet     { shopMoney { amount } }
          currentTotalPriceSet      { shopMoney { amount } }
          currentSubtotalPriceSet   { shopMoney { amount } }
          currentTotalTaxSet        { shopMoney { amount } }
          currentShippingPriceSet   { shopMoney { amount } }
          totalRefundedSet          { shopMoney { amount } }
          refunds {
            id
            createdAt
            totalRefundedSet        { shopMoney { amount } }
          }
        }
      }
    `;
    let shopifyTotals: any = null;
    let shopifyRefunds: any = null;
    let shopifyError: string | null = null;
    try {
      const r = await shopifyGraphqlCall(cfg, probeQuery, { id: `gid://shopify/Order/${row.id}` });
      if (r.errors) shopifyError = JSON.stringify(r.errors);
      else {
        const o: any = (r.data as any)?.order;
        const num = (mb: any) => mb?.shopMoney?.amount != null ? Number(mb.shopMoney.amount) : null;
        shopifyTotals = {
          display_financial_status: o?.displayFinancialStatus ?? null,
          original_total_price:     num(o?.originalTotalPriceSet),
          current_total_price:      num(o?.currentTotalPriceSet),
          current_subtotal:         num(o?.currentSubtotalPriceSet),
          current_tax:              num(o?.currentTotalTaxSet),
          current_shipping:         num(o?.currentShippingPriceSet),
          total_refunded:           num(o?.totalRefundedSet),
        };
        const refunds = Array.isArray(o?.refunds) ? o.refunds : [];
        shopifyRefunds = {
          count: refunds.length,
          items: refunds.map((rf: any) => ({
            id: rf?.id,
            created_at: rf?.createdAt,
            total_refunded: num(rf?.totalRefundedSet),
          })),
        };
      }
    } catch (e: any) {
      shopifyError = String(e?.message || e);
    }

    // Pattern classifier — only meaningful when shopify_totals returned.
    let pattern: string | null = null;
    if (shopifyTotals) {
      const original = shopifyTotals.original_total_price ?? 0;
      const refunded = shopifyTotals.total_refunded ?? 0;
      const current  = shopifyTotals.current_total_price ?? 0;
      const eps = 0.01;
      if (current === 0 && Math.abs(refunded - original) < eps) {
        pattern = "refund_via_edit_fully_refunded";       // refund row already books -original
      } else if (current === 0 && refunded < eps) {
        pattern = "edited_to_zero_no_refund";              // pure write-off, no refund row
      } else if (current === 0 && refunded > eps && Math.abs(refunded - original) > eps) {
        pattern = "edited_to_zero_partial_refund";         // mixed — needs manual review
      } else {
        pattern = "other";
      }
    }

    res.json({
      build_id: "86a-fix4",
      recon_orders_row: row,
      local_line_aggregate: lineAgg,
      local_refund_aggregate: refundAgg,
      shopify_totals: shopifyTotals,
      shopify_refunds: shopifyRefunds,
      shopify_error: shopifyError,
      diagnosis: {
        local_reflects_post_edit:
          shopifyTotals?.current_subtotal != null &&
          Math.abs((lineAgg.net_subtotal || 0) - (shopifyTotals.current_subtotal || 0)) < 0.01,
        local_minus_shopify_subtotal:
          shopifyTotals?.current_subtotal != null
            ? Math.round(((lineAgg.net_subtotal || 0) - (shopifyTotals.current_subtotal || 0)) * 100) / 100
            : null,
        local_refund_total_matches_shopify:
          shopifyTotals?.total_refunded != null
            ? Math.abs((refundAgg.refund_total_sum || 0) - (shopifyTotals.total_refunded || 0)) < 0.01
            : null,
        pattern,
      },
    });
  });

  // PR #86a — read-only listing of recon_order_edits for operator inspection.
  // GET so it's easy to spot-check from the browser.
  app.get("/api/recon/finance/debug/orders/list-edits", authMiddleware, requirePermission("payroll.view"), async (_req: any, res) => {
    const { ensureOrderEditsSchema, listAllOrderEdits } = require("./shopify-recon-order-edits");
    ensureOrderEditsSchema();
    const rows = listAllOrderEdits();
    res.json({ count: rows.length, rows, build_id: "86a-fix2" });
  });

  // PR #86a-fix2 diagnostic. Calls the SAME query that detectOrderEdit() runs
  // for a single order, then returns the raw events.edges + the detector
  // decision. Lets us verify whether the events sub-selection is actually
  // returning edges in the deployed environment, vs the detector returning
  // null for some other reason. Read-only.
  //
  // POST body: { order_id: string }   // numeric Shopify order id
  app.post("/api/recon/finance/debug/orders/probe-edit-detector", authMiddleware, requirePermission("payroll.view"), async (req: any, res) => {
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
    const orderId = String(req.body?.order_id || "").trim();
    if (!orderId) return res.status(400).json({ message: "body.order_id required" });

    const probeQuery = `
      query ProbeOrderForDetect($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          originalTotalPriceSet     { shopMoney { amount } }
          currentTotalPriceSet      { shopMoney { amount } }
          events(first: 10, query: "verb:edited OR action:order_edited", sortKey: CREATED_AT, reverse: true) {
            edges { node { id createdAt message } }
          }
        }
      }
    `;
    try {
      const r = await shopifyGraphqlCall(cfg, probeQuery, { id: `gid://shopify/Order/${orderId}` });
      const o: any = (r.data as any)?.order;
      const editEdges: any[] = (o?.events?.edges || []) as any[];

      // Also call the actual detector so we can compare what it returns.
      const { detectOrderEdit } = require("./shopify-recon-order-edits");
      let detector_result: any = null;
      let detector_error: string | null = null;
      try {
        detector_result = await detectOrderEdit(cfg, orderId);
      } catch (err: any) {
        detector_error = String(err?.message || err);
      }

      res.json({
        build_id: "86a-fix2",
        order_id: orderId,
        raw_graphql: {
          errors: r.errors || null,
          order_name: o?.name || null,
          original_total_price: o?.originalTotalPriceSet?.shopMoney?.amount ?? null,
          current_total_price:  o?.currentTotalPriceSet?.shopMoney?.amount ?? null,
          events_edges_count: editEdges.length,
          events_edges: editEdges,
        },
        detector_result,
        detector_error,
      });
    } catch (e: any) {
      res.status(502).json({ message: "probe failed", error: String(e?.message || e), build_id: "86a-fix2" });
    }
  });

  // =====================================================================
  // PR #94 — Revenue events ledger (data layer only).
  //
  // These endpoints expose the new recon_revenue_events projection without
  // touching the production reconciler math. They exist so we can build,
  // backfill, and inspect the ledger in parallel with the legacy path,
  // then compare in PR #95 before switching over in PR #97.
  //
  //   POST /api/recon/finance/debug/events/backfill
  //     Body: { scope: "all" } | { scope: "order", order_id }
  //     Wipes (in scope) and re-projects events from recon_line_items +
  //     recon_refunds + recon_refund_line_items.
  //
  //   GET  /api/recon/finance/debug/events/monthly/:month
  //     Returns the new path's monthly aggregate for inspection.
  //
  //   GET  /api/recon/finance/debug/events/order/:order_id
  //     Returns every event row for one order. Useful for verifying that
  //     an edited order generated the right sale/refund/return_fee rows.
  //
  //   GET  /api/recon/finance/debug/events/warnings
  //     Returns recent rows from recon_event_warnings.
  //
  //   GET  /api/recon/finance/debug/events/health
  //     Quick counts: total events, by type, distinct months, latest detected_at.
  // =====================================================================
  app.post("/api/recon/finance/debug/events/backfill", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    try {
      const {
        projectRevenueEvents,
      } = require("./shopify-recon-revenue-events");
      const scope = req.body?.scope === "order" ? "order" : "all";
      if (scope === "order") {
        const orderId = String(req.body?.order_id || "").trim();
        if (!orderId) {
          return res.status(400).json({ message: "order_id required for scope=order" });
        }
        const summary = projectRevenueEvents({ scope, orderId });
        return res.json({ ok: true, build_id: "pr94", summary });
      }
      const summary = projectRevenueEvents({ scope: "all" });
      res.json({ ok: true, build_id: "pr94", summary });
    } catch (e: any) {
      res.status(502).json({ message: "projectRevenueEvents failed", error: String(e?.message || e) });
    }
  });

  app.get("/api/recon/finance/debug/events/monthly/:month", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    try {
      const {
        aggregateRevenueEventsByMonth,
      } = require("./shopify-recon-revenue-events");
      const monthKey = String(req.params.month || "").trim();
      if (!/^\d{4}-\d{2}$/.test(monthKey)) {
        return res.status(400).json({ message: "month must be YYYY-MM" });
      }
      const row = aggregateRevenueEventsByMonth(monthKey);
      res.json({ ok: true, build_id: "pr94", month: monthKey, row });
    } catch (e: any) {
      res.status(502).json({ message: "aggregateRevenueEventsByMonth failed", error: String(e?.message || e) });
    }
  });

  app.get("/api/recon/finance/debug/events/order/:order_id", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    try {
      const {
        listEventsForOrder,
      } = require("./shopify-recon-revenue-events");
      const orderId = String(req.params.order_id || "").trim();
      if (!orderId) {
        return res.status(400).json({ message: "order_id required" });
      }
      const events = listEventsForOrder(orderId);
      res.json({ ok: true, build_id: "pr94", order_id: orderId, count: events.length, events });
    } catch (e: any) {
      res.status(502).json({ message: "listEventsForOrder failed", error: String(e?.message || e) });
    }
  });

  app.get("/api/recon/finance/debug/events/warnings", authMiddleware, requirePermission("payroll.view"), (req: any, res) => {
    try {
      const {
        listRecentEventWarnings,
      } = require("./shopify-recon-revenue-events");
      const limit = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 1000);
      const rows = listRecentEventWarnings(limit);
      res.json({ ok: true, build_id: "pr94", count: rows.length, warnings: rows });
    } catch (e: any) {
      res.status(502).json({ message: "listRecentEventWarnings failed", error: String(e?.message || e) });
    }
  });

  app.get("/api/recon/finance/debug/events/health", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    try {
      const { sqlite } = require("./storage");
      const {
        ensureRevenueEventsSchema,
      } = require("./shopify-recon-revenue-events");
      ensureRevenueEventsSchema();
      const total = (sqlite.prepare(`SELECT COUNT(*) AS n FROM recon_revenue_events`).get() as any).n;
      const byType = sqlite.prepare(`
        SELECT event_type, COUNT(*) AS n
        FROM recon_revenue_events
        GROUP BY event_type
        ORDER BY event_type
      `).all();
      const months = sqlite.prepare(`
        SELECT event_month, COUNT(*) AS n
        FROM recon_revenue_events
        GROUP BY event_month
        ORDER BY event_month ASC
      `).all();
      const latest = (sqlite.prepare(`
        SELECT MAX(detected_at) AS d FROM recon_revenue_events
      `).get() as any).d;
      const warnings = (sqlite.prepare(`SELECT COUNT(*) AS n FROM recon_event_warnings`).get() as any).n;
      res.json({
        ok: true,
        build_id: "pr94",
        total_events: total,
        by_type: byType,
        by_month: months,
        latest_detected_at: latest,
        warnings_total: warnings,
      });
    } catch (e: any) {
      res.status(502).json({ message: "events health failed", error: String(e?.message || e) });
    }
  });

  // R5a-fix1 one-shot backfill. Re-transforms every recon_orders.raw_json
  // through the (now broadened) exchange detection logic in
  // shopify-recon-orders.ts and rewrites recon_line_items including
  // recognized_at. Idempotent. Run once after R5a-fix1 deploys.
  //
  // Body: { dryRun?: boolean, limit?: number }
  //   dryRun=true returns counts only, no writes.
  //   limit caps the order count for incremental backfills (default: all).
  app.post("/api/recon/backfill-recognized-at", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const { sqlite } = require("./storage");
    const { upsertOrderFromShopify } = require("./shopify-recon-orders");
    const dryRun = req.body?.dryRun === true;
    const limit = Number(req.body?.limit);
    const sql = `SELECT id, raw_json FROM recon_orders WHERE raw_json IS NOT NULL${Number.isFinite(limit) ? " LIMIT " + Math.floor(limit) : ""}`;
    const rows = sqlite.prepare(sql).all() as { id: string; raw_json: string | null }[];

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let recognizedAtChanged = 0;
    let discountAllocBackfilled = 0;
    const errors: { order_id: string; error: string }[] = [];

    for (const row of rows) {
      attempted++;
      if (!row.raw_json) continue;
      try {
        const raw = typeof row.raw_json === "string" ? JSON.parse(row.raw_json) : row.raw_json;
        // Count line-level recognized_at deltas BEFORE writing so we can report
        // how many lines actually moved (most won't change — only orders with
        // late fulfillments + refunds, i.e. exchanges).
        const beforeRows = sqlite
          .prepare(`SELECT id, recognized_at, COALESCE(discount_allocations_total, 0) AS dat FROM recon_line_items WHERE order_id = ?`)
          .all(row.id) as { id: string; recognized_at: string | null; dat: number }[];
        const beforeRA = new Map(beforeRows.map((r: { id: string; recognized_at: string | null; dat: number }) => [r.id, r.recognized_at]));
        const beforeDAT = new Map(beforeRows.map((r: { id: string; recognized_at: string | null; dat: number }) => [r.id, r.dat]));

        if (!dryRun) {
          upsertOrderFromShopify(raw);
        }

        const afterRows = sqlite
          .prepare(`SELECT id, recognized_at, COALESCE(discount_allocations_total, 0) AS dat FROM recon_line_items WHERE order_id = ?`)
          .all(row.id) as { id: string; recognized_at: string | null; dat: number }[];
        for (const a of afterRows as { id: string; recognized_at: string | null; dat: number }[]) {
          if (beforeRA.get(a.id) !== a.recognized_at) recognizedAtChanged++;
          // Count any line whose newly-written discount_allocations_total > 0
          // (was 0 before the backfill ran, because the column didn't exist yet).
          if ((beforeDAT.get(a.id) ?? 0) === 0 && (a.dat ?? 0) > 0) discountAllocBackfilled++;
        }
        succeeded++;
      } catch (e: any) {
        failed++;
        if (errors.length < 20) errors.push({ order_id: row.id, error: String(e?.message ?? e) });
      }
    }

    res.json({
      dryRun,
      attempted,
      succeeded,
      failed,
      recognized_at_lines_changed: recognizedAtChanged,
      discount_allocations_backfilled: discountAllocBackfilled,
      errors,
      note: dryRun
        ? "Dry run — no writes performed."
        : "Backfill complete. Re-run /api/recon/finance/diff/:month to see the recomputed totals.",
    });
  });

  // Save / overwrite a Shopify snapshot for a month. Operator pastes values
  // from the Admin Finance Summary export. All money fields optional — a
  // partial save (just net_sales, say) is allowed; missing fields show as null
  // in the diff (no comparison for that line).
  app.post("/api/recon/finance/snapshot", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const b = req.body ?? {};
    if (!b.month || !/^\d{4}-\d{2}$/.test(b.month)) {
      return res.status(400).json({ message: "month is required and must be YYYY-MM" });
    }
    const num = (v: any): number | null => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const { upsertShopifySnapshot } = require("./shopify-finance-diff");
    upsertShopifySnapshot({
      month: b.month,
      snapshot_kind: b.snapshot_kind ?? "all_channels",
      gross_sales: num(b.gross_sales),
      discounts: num(b.discounts),
      returns: num(b.returns),
      net_sales: num(b.net_sales),
      shipping: num(b.shipping),
      taxes: num(b.taxes),
      total_sales: num(b.total_sales),
      net_sales_gift_cards: num(b.net_sales_gift_cards),
      source_label: typeof b.source_label === "string" ? b.source_label : "manual_entry",
      raw_input: typeof b.raw_input === "string" ? b.raw_input : null,
      captured_by: req.user?.email || "unknown",
    });
    res.json({ ok: true, month: b.month });
  });

  // List recent snapshots — last 36 months for the UI's history dropdown.
  app.get("/api/recon/finance/snapshots", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    const { listShopifySnapshots } = require("./shopify-finance-diff");
    res.json({ snapshots: listShopifySnapshots(36) });
  });

  // ------------------------------------------------------------------------
  // PR #R5b — pull Shopify's own Finance Summary via ShopifyQL.
  // ------------------------------------------------------------------------
  // Live pull (no DB write). Returns the {gross_sales, discounts, returns,
  // net_sales, shipping, taxes, total_sales, orders} totals for the date
  // range, plus the raw query text and raw row for audit.
  //
  // Query params:
  //   start     YYYY-MM-DD (required)
  //   end       YYYY-MM-DD (required, inclusive)
  //   bucket_by processed_at | created_at  (default: processed_at)
  //
  // Requires `read_reports` / `read_analytics` scopes on the Shopify token.
  // If the token is missing those scopes, this returns 502 with a hint to
  // re-install the app.
  app.get("/api/recon/shopifyql/summary", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();
    const bucketBy = String(req.query.bucket_by || "processed_at").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ message: "start and end (YYYY-MM-DD) are required" });
    }
    if (bucketBy !== "processed_at" && bucketBy !== "created_at") {
      return res.status(400).json({ message: "bucket_by must be 'processed_at' or 'created_at'" });
    }
    try {
      const { pullFinanceSummary } = require("./shopify-shopifyql");
      const result = await pullFinanceSummary(start, end, bucketBy);
      res.json(result);
    } catch (e: any) {
      const msg = String(e?.message || e);
      const isAuth = /401|403|scope/i.test(msg);
      res.status(isAuth ? 502 : 500).json({
        message: msg,
        hint: isAuth
          ? "Re-install the Shopify app via /api/auth/shopify/install to grant the read_reports / read_analytics scopes."
          : undefined,
      });
    }
  });

  // Generic ShopifyQL passthrough — lets us test arbitrary queries (e.g. when
  // we're not sure which dataset/column names Shopify accepts) without
  // shipping a code change. Returns the raw `runShopifyql` result so the
  // caller sees parseErrors, columns, and rows.
  //
  //   POST /api/recon/shopifyql/run  body { query: "FROM sales SHOW total_sales SINCE -7d UNTIL today" }
  //
  // Read-only — only requires `payroll.view` and the read_reports scope on the
  // Shopify token. We intentionally do NOT log the raw query body in case it
  // contains PII filters.
  app.post("/api/recon/shopifyql/run", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    const query = String((req.body && req.body.query) || "").trim();
    if (!query) {
      return res.status(400).json({ message: "body.query is required (a ShopifyQL string)" });
    }
    if (query.length > 4000) {
      return res.status(400).json({ message: "query too long (max 4000 chars)" });
    }
    try {
      const { runShopifyql } = require("./shopify-shopifyql");
      const result = await runShopifyql(query);
      res.json(result);
    } catch (e: any) {
      const msg = String(e?.message || e);
      const isAuth = /401|403|scope/i.test(msg);
      res.status(isAuth ? 502 : 500).json({
        message: msg,
        hint: isAuth
          ? "Re-install the Shopify app via /api/auth/shopify/install to grant the read_reports / read_analytics scopes."
          : undefined,
      });
    }
  });

  // Snapshot a month's ShopifyQL totals into recon_shopify_snapshots so the
  // existing /api/recon/finance/diff/:month endpoint can compare our local
  // rollup against it. Body params:
  //   month     YYYY-MM (required) — used as both the bucket key and the
  //             date range (first..last day of month)
  //   bucket_by processed_at | created_at  (default: processed_at)
  //
  // Writes a snapshot with source_label = "shopifyql:<bucket_by>" so it
  // doesn't collide with manually-entered PDF snapshots.
  app.post("/api/recon/shopifyql/snapshot", authMiddleware, requirePermission("system.manage_config"), async (req: any, res) => {
    const body = req.body ?? {};
    const month = String(body.month || "").trim();
    const bucketBy = String(body.bucket_by || "processed_at").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "month is required and must be YYYY-MM" });
    }
    if (bucketBy !== "processed_at" && bucketBy !== "created_at") {
      return res.status(400).json({ message: "bucket_by must be 'processed_at' or 'created_at'" });
    }
    // Compute first/last day of month. Last day = day 0 of next month.
    const [y, m] = month.split("-").map((s) => Number(s));
    const start = `${month}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${month}-${String(lastDay).padStart(2, "0")}`;
    try {
      const { pullFinanceSummary } = require("./shopify-shopifyql");
      const result = await pullFinanceSummary(start, end, bucketBy);
      const { upsertShopifySnapshot } = require("./shopify-finance-diff");
      upsertShopifySnapshot({
        month,
        snapshot_kind: "all_channels",
        gross_sales: result.gross_sales,
        discounts: result.discounts,
        returns: result.returns,
        net_sales: result.net_sales,
        shipping: result.shipping,
        taxes: result.taxes,
        total_sales: result.total_sales,
        net_sales_gift_cards: null, // not in this query; PDF lists separately
        source_label: `shopifyql:${bucketBy}`,
        raw_input: JSON.stringify({ query: result.query, raw: result.raw, orders: result.orders }),
        captured_by: req.user?.email || "unknown",
      });
      res.json({ ok: true, month, bucket_by: bucketBy, totals: result });
    } catch (e: any) {
      const msg = String(e?.message || e);
      const isAuth = /401|403|scope/i.test(msg);
      res.status(isAuth ? 502 : 500).json({
        message: msg,
        hint: isAuth
          ? "Re-install the Shopify app via /api/auth/shopify/install to grant the read_reports / read_analytics scopes."
          : undefined,
      });
    }
  });

  // Current orders watermark (read-only) — shown in the Settings UI so the user
  // knows where the incremental pull will resume from on next run.
  app.get("/api/recon/shopify/watermark", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json({ orders_watermark: getReconOrdersWatermark() });
  });

  // Sample of recently ingested orders — used by the Phase 1 testing UI so the
  // user can spot-check transformations against Shopify Admin UI side-by-side.
  app.get("/api/recon/orders", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    res.json(listReconOrdersSample(limit));
  });

  // Aggregated summary of all ingested orders — powers the "Orders summary"
  // card in the Test Console. Totals, date range, per-month/channel/location
  // breakdowns. Read-only (PR #R2f).
  app.get("/api/recon/shopify/orders-summary", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json(getReconOrdersSummary());
  });

  // --------------------------------------------------------------------------
  // PR #R5a-pre — paginated, date-range order listing for paper-recon pulls.
  // --------------------------------------------------------------------------
  // Keyset-paginated. Pass `field=created_at|updated_at|processed_at`, ISO
  // `start`/`end`, optional `cursor` (echo back next_cursor), and `limit`
  // (default 200, max 1000). Read-only, same payroll.view permission as the
  // existing sample endpoint.
  //
  // IMPORTANT: this route MUST be registered BEFORE /api/recon/orders/:id so
  // Express doesn't match "range" as the :id parameter.
  app.get("/api/recon/orders/range", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();
    if (!start || !end) {
      return res.status(400).json({ message: "start and end (ISO timestamps) are required" });
    }
    if (start >= end) {
      return res.status(400).json({ message: "start must be < end" });
    }
    const fieldRaw = String(req.query.field || "created_at");
    const field = (fieldRaw === "updated_at" || fieldRaw === "processed_at")
      ? (fieldRaw as "updated_at" | "processed_at")
      : "created_at";
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const limit = Number(req.query.limit) || 200;
    const page = listReconOrdersByDateRange({ field, start, end, cursor, limit });
    res.json(page);
  });

  // Companion endpoint: list every order whose refund.processed_at falls in
  // [start, end). Cross-month refund parents are invisible to a created_at
  // window so this is the only way to pull them for paper-recon. Returns just
  // the order rows; callers loop /api/recon/orders/:id for full detail.
  app.get("/api/recon/refunds/orders-in-range", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const start = String(req.query.start || "").trim();
    const end = String(req.query.end || "").trim();
    if (!start || !end) {
      return res.status(400).json({ message: "start and end (ISO timestamps) are required" });
    }
    if (start >= end) {
      return res.status(400).json({ message: "start must be < end" });
    }
    const limit = Number(req.query.limit) || 1000;
    const result = listReconOrdersWithRefundsInRange({ start, end, limit });
    res.json(result);
  });

  // Single order detail (order + line items) for spot-checking tax_channel_liable.
  app.get("/api/recon/orders/:id", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const detail = getReconOrderWithLines(String(req.params.id));
    if (!detail) return res.status(404).json({ message: "Order not found" });
    res.json(detail);
  });

  // --------------------------------------------------------------------------
  // PR #R3 — Shopify Payments payouts + balance_transactions sync
  // --------------------------------------------------------------------------
  // Manual trigger — mirrors the orders sync route. Daily cron in server/index.ts
  // calls the same function. Returns counters synchronously.
  app.post("/api/recon/shopify/sync/payouts", authMiddleware, requirePermission("system.manage_config"), async (req: any, res) => {
    const triggeredBy = `manual:${req.user?.email || "unknown"}`;
    const result = await syncPayoutsIncremental(triggeredBy);
    res.status(result.error ? 502 : 200).json(result);
  });

  // Current payouts watermark (read-only).
  app.get("/api/recon/shopify/payouts-watermark", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json({ payouts_watermark: getReconPayoutsWatermark() });
  });

  // Sample of recent payouts — each row carries txn_count + chargeback_count
  // so the user can spot chargeback-bearing payouts at a glance.
  app.get("/api/recon/payouts", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    res.json(listReconPayoutsSample(limit));
  });

  // Aggregated summary of all ingested payouts — powers the "Payouts summary"
  // card in the Test Console.
  app.get("/api/recon/shopify/payouts-summary", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json(getReconPayoutsSummary());
  });

  // Single payout detail (payout + balance_transactions) for forensic drill-down.
  app.get("/api/recon/payouts/:id", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const detail = getReconPayoutWithTransactions(String(req.params.id));
    if (!detail) return res.status(404).json({ message: "Payout not found" });
    res.json(detail);
  });

  // Preview the transformation of a raw Shopify order payload WITHOUT writing
  // to the DB. Pure debugging aid for when a transformed row looks wrong —
  // POST the raw Shopify JSON, get back what we would have stored.
  app.post("/api/recon/shopify/transform-preview", authMiddleware, requirePermission("system.manage_config"), (req, res) => {
    try {
      const out = transformShopifyOrder(req.body);
      res.json(out);
    } catch (e: any) {
      res.status(400).json({ message: e?.message ?? "Transform failed" });
    }
  });

  // Webhook registration — reconciles desired topics (orders/create, /updated,
  // /cancelled) with what's currently subscribed at the configured public URL.
  // Idempotent — safe to call on every boot or from the UI.
  app.post("/api/recon/shopify/webhooks/register", authMiddleware, requirePermission("system.manage_config"), async (_req, res) => {
    try {
      const results = await ensureShopifyWebhooks();
      res.json({ topics: SHOPIFY_RECON_WEBHOOK_TOPICS, results });
    } catch (e: any) {
      res.status(502).json({ message: e?.message ?? "Webhook registration failed" });
    }
  });

  // Reset webhooks — deletes everything pointed at our public URL. Used after
  // ngrok domain rotation when stale entries pile up, or to fully unwind.
  app.delete("/api/recon/shopify/webhooks", authMiddleware, requirePermission("system.manage_config"), async (_req, res) => {
    try {
      const count = await deleteAllOurWebhooks();
      res.json({ deleted: count });
    } catch (e: any) {
      res.status(502).json({ message: e?.message ?? "Webhook delete failed" });
    }
  });

  // -------- Webhook receiver (PUBLIC — no auth, HMAC-verified) --------------
  // Mounted under /api/recon/* so it lives next to the other recon routes but
  // has NO authMiddleware/permission gate. HMAC verification inside the handler
  // is the auth boundary. MUST run with req.rawBody available — captured by the
  // global express.json({ verify }) hook in server/index.ts.
  app.post("/api/recon/webhooks/shopify", (req, res) => {
    void handleShopifyWebhook(req, res);
  });

  // Integration error log (most recent N entries) — surfaces transient API
  // failures, HMAC mismatches, etc. for the Settings UI debug panel.
  app.get("/api/recon/shopify/error-log", authMiddleware, requirePermission("system.view_sync_log"), (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    res.json(getShopifyReconErrorLog(limit));
  });
  app.delete("/api/recon/shopify/error-log", authMiddleware, requirePermission("system.manage_config"), (_req, res) => {
    clearShopifyReconErrorLog();
    res.json({ ok: true });
  });

  // ---- Reconciler COA Mapping (PR #R4a-prep) ----
  // Lets the user upload a per-entity QBO Chart of Accounts CSV and then
  // confirm a mapping of each "logical role" the engine emits (sales_income,
  // cogs, shopify_pit, etc.) to a specific QBO account name on that entity's
  // books. The matrix is the foundation for PR #R4 (allocation engine) and
  // later PRs that emit JEs.

  // List logical roles + metadata (read-only).
  app.get("/api/recon/coa/roles", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json({ roles: RECON_COA_LOGICAL_ROLES });
  });

  // Per-entity import status (last import timestamp + count + active count).
  app.get("/api/recon/coa/import-status", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json(getReconCoaImportStatus());
  });

  // List a single entity's imported accounts (used by the UI dropdowns).
  app.get("/api/recon/coa/entity/:entityId/accounts", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const entityId = Number(req.params.entityId);
    if (!Number.isFinite(entityId)) return res.status(400).json({ error: "invalid entity_id" });
    const includeInactive = String(req.query.include_inactive || "") === "1";
    res.json(listReconEntityCoa(entityId, includeInactive));
  });

  // Import a CSV for one entity. We accept a JSON body of pre-parsed rows so
  // the heavy CSV parsing stays in the browser (PapaParse) where it already
  // lives — the server just upserts.
  // Body: { rows: [{ account_number?, account_name, account_type?, detail_type? }] }
  app.post("/api/recon/coa/import/:entityId", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const entityId = Number(req.params.entityId);
    if (!Number.isFinite(entityId)) return res.status(400).json({ error: "invalid entity_id" });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: "rows array required" });
    try {
      const result = importReconEntityCoa(entityId, rows);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // Build the full mapping matrix (entities × logical roles × each entity's
  // accounts) including pre-fill suggestions and quality flags.
  app.get("/api/recon/coa/mapping-matrix", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    res.json(buildReconCoaMappingMatrix());
  });

  // Bulk-save user-confirmed mapping rows.
  // Body: { rows: [{ entity_id, logical_role, qbo_account_name, notes? }] }
  app.post("/api/recon/coa/mapping/bulk-save", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) return res.status(400).json({ error: "rows array required" });
    try {
      const result = bulkSaveReconCoaMapping(rows);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // ---- PR #R4 — Allocation engine (read-only Phase 1) ----
  // Allocates each order line_item + shipping + tax to a legal entity
  // (SD Ski/Patio, SH Hempstead, SH Huntington) using a layered set of
  // methods: pos_location → fulfillment_location → warehouse_rollup →
  // zip_lookup (digital gift cards) → prior_year_pro_rata → manual_override
  // → needs_review. This is purely a read-only computation; no QBO posting.
  app.get("/api/recon/allocations/readiness", authMiddleware, requirePermission("payroll.view"), (_req, res) => {
    try {
      res.json(getAllocationReadiness());
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.post("/api/recon/allocations/run", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const month = String(req.body?.month ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "month must be YYYY-MM" });
    }
    try {
      const summary = runAllocationEngine(month);
      res.json({ ok: true, ...summary });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/recon/allocations/needs-review", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month
      : undefined;
    try {
      res.json({ rows: listNeedsReview(month) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.post("/api/recon/allocations/override", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const order_id = String(req.body?.order_id ?? "").trim();
    const line_item_id = req.body?.line_item_id == null ? null : String(req.body.line_item_id).trim();
    const entity_id = Number(req.body?.entity_id);
    if (!order_id || !Number.isFinite(entity_id)) {
      return res.status(400).json({ error: "order_id and numeric entity_id required" });
    }
    const user = String(req.user?.email ?? req.user?.id ?? "system");
    try {
      const result = applyAllocationOverride({ order_id, line_item_id, entity_id, user });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/recon/allocations/rollup", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = typeof req.query.month === "string" ? req.query.month : "";
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "month must be YYYY-MM" });
    }
    try {
      res.json({ rows: getAllocationRollup(month) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // PR #R4k-diag — Same rollup, but bound the month in store time
  // (America/New_York) instead of UTC, so the result is directly comparable
  // to Shopify Finance summary reports.
  app.get("/api/recon/allocations/rollup-store-time", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = typeof req.query.month === "string" ? req.query.month : "";
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "month must be YYYY-MM" });
    }
    try {
      res.json({ rows: getAllocationRollupStoreTime(month) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // PR #R4k-diag — Surface the orders that fall on the timezone edge of the
  // month (in UTC bucket but not store-time bucket, and vice versa).
  app.get("/api/recon/allocations/month-boundary-diag", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const month = typeof req.query.month === "string" ? req.query.month : "";
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "month must be YYYY-MM" });
    }
    try {
      res.json(getMonthBoundaryDiag(month));
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // ---- PR #R4e — GC redemption + inter-company JE preview ----
  // Three endpoints; all behind system.manage_config like the other writer-
  // adjacent reconciler routes (the rebuild one actually writes records, the
  // two GETs are read-only but kept on the same permission for simplicity).
  // YYYY-MM-DD inputs convert to midnight UTC for the storage queries.
  function parseRangeOrNull(
    q: any,
  ): { sinceIso: string; untilIso: string } | { error: string } {
    const since = typeof q.since === "string" ? q.since : "";
    const until = typeof q.until === "string" ? q.until : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return { error: "since must be YYYY-MM-DD" };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return { error: "until must be YYYY-MM-DD" };
    }
    return { sinceIso: `${since}T00:00:00Z`, untilIso: `${until}T00:00:00Z` };
  }

  app.get("/api/recon/gc-redemptions", authMiddleware, requirePermission("system.manage_config"), (req, res) => {
    const parsed = parseRangeOrNull(req.query);
    if ("error" in parsed) return res.status(400).json(parsed);
    try {
      const rows = listRedemptionsForRange(parsed.sinceIso, parsed.untilIso);
      const summary = getRedemptionSummary(parsed.sinceIso, parsed.untilIso);
      const issuance = getIssuanceSummary(parsed.sinceIso, parsed.untilIso);
      res.json({ rows, summary, issuance });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.get("/api/recon/intercompany-jes", authMiddleware, requirePermission("system.manage_config"), (req, res) => {
    const parsed = parseRangeOrNull(req.query);
    if ("error" in parsed) return res.status(400).json(parsed);
    try {
      const rows = listInterCompanyJEsForRange(parsed.sinceIso, parsed.untilIso);
      res.json({ rows });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.post("/api/recon/gc-redemptions/rebuild", authMiddleware, requirePermission("system.manage_config"), (req, res) => {
    // Body OR query — easier to copy/paste from the existing fulfillment
    // backfill flow either way.
    const src = Object.keys(req.body || {}).length > 0 ? req.body : req.query;
    const parsed = parseRangeOrNull(src);
    if ("error" in parsed) return res.status(400).json(parsed);
    try {
      const result = rebuildRedemptionsForRange(parsed.sinceIso, parsed.untilIso);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // ---- Shopify OAuth (Authorization Code Grant) ----
  // PR #R2e — Captures Admin API access token via standard OAuth install flow.
  // Install + callback are PUBLIC (no authMiddleware) because Shopify itself
  // hits them with no user session. The callback verifies HMAC + state to
  // ensure the request really came from Shopify before storing the token.
  app.get("/api/auth/shopify/install", shopifyInstallHandler);
  app.get("/api/auth/shopify/callback", shopifyCallbackHandler);

  // These are app-internal helpers used by the Test Console UI, so they are
  // gated behind auth + the same permission used by other recon settings.
  app.get("/api/auth/shopify/install-url", authMiddleware, requirePermission("system.manage_config"), shopifyInstallUrlHandler);
  app.get("/api/auth/shopify/installed-status", authMiddleware, requirePermission("payroll.view"), shopifyInstalledStatusHandler);
  app.delete("/api/auth/shopify/token", authMiddleware, requirePermission("system.manage_config"), shopifyDeleteTokenHandler);

  // ---- Health ----
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "1.0.0", app: "snohaus-ap-windows" });
  });

  // ---- Invoices ----
  app.get("/api/invoices", authMiddleware, (req, res) => {
    const filters: any = {};
    if (req.query.status && req.query.status !== "all") filters.status = req.query.status;
    if (req.query.vendor_qbo_id) filters.vendor_qbo_id = req.query.vendor_qbo_id;
    if (req.query.ship_to_store) filters.ship_to_store = req.query.ship_to_store;
    if (req.query.confidence) filters.confidence = req.query.confidence;
    if (req.query.doc_type === "invoices" || req.query.doc_type === "credits") filters.doc_type = req.query.doc_type;
    const list = listInvoices(filters);
    const enriched = list.map((inv) => ({ ...inv, line_items: getLineItems(inv.id) }));
    res.json(enriched);
  });

  app.get("/api/invoices/:id", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const lineItems = getLineItems(inv.id);
    const audit = getAuditLog(inv.id);
    // Find applicable rule by vendor
    let rule = null;
    if (inv.vendor_qbo_id) {
      rule = listRules().find((r) => r.vendor_qbo_id === inv.vendor_qbo_id) || null;
    }
    res.json({ ...inv, line_items: lineItems, audit_log: audit, vendor_rule: rule });
  });

  // ---- Authenticated PDF access via signed short-lived token ----
  const PDF_TOKEN_TTL_MS = 5 * 60 * 1000;
  const PDF_SECRET = process.env.PDF_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
  function signPdfToken(invoiceId: string, sessionToken: string): { token: string; expires: number } {
    const expires = Date.now() + PDF_TOKEN_TTL_MS;
    const payload = `${invoiceId}.${expires}.${sessionToken.slice(-12)}`;
    const sig = crypto.createHmac('sha256', PDF_SECRET).update(payload).digest('hex').slice(0, 24);
    return { token: `${expires}.${sig}`, expires };
  }
  function verifyPdfToken(invoiceId: string, sessionToken: string, t: string): boolean {
    const [expStr, sig] = t.split('.');
    if (!expStr || !sig) return false;
    const exp = parseInt(expStr, 10);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    const payload = `${invoiceId}.${exp}.${sessionToken.slice(-12)}`;
    const expected = crypto.createHmac('sha256', PDF_SECRET).update(payload).digest('hex').slice(0, 24);
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  app.get("/api/invoices/:id/pdf-token", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const sessionToken = req.headers.authorization!.slice(7);
    const { token, expires } = signPdfToken(inv.id, sessionToken);
    res.json({ token, expires, url: `/api/invoices/${inv.id}/pdf?t=${token}&s=${encodeURIComponent(sessionToken)}` });
  });

  app.get("/api/invoices/:id/pdf", (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).send("Not found");
    const t = String(req.query.t || "");
    const sessionToken = String(req.query.s || "");
    const sess = sessionToken ? getSession(sessionToken) : null;
    if (!sess) return res.status(401).send("Unauthorized");
    if (!verifyPdfToken(inv.id, sessionToken, t)) return res.status(401).send("Bad or expired link");

    // Look up PDF filename: check source_file map first, then try pdf_url directly
    const filename = PDF_FILES_MAP[inv.source_file] || inv.pdf_url || null;
    if (!filename) return res.status(404).send("PDF not found");
    const baseDir = path.resolve(__dirname, "..", "private_assets");
    const fullPath = path.resolve(baseDir, filename);
    if (!fullPath.startsWith(baseDir + path.sep) && fullPath !== baseDir) {
      return res.status(400).send("Invalid path");
    }
    if (!fs.existsSync(fullPath)) return res.status(404).send("PDF missing on disk");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-cache");
    fs.createReadStream(fullPath).pipe(res);
  });

  app.patch("/api/invoices/:id", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const before = { ...inv };
    // v8: allow editing invoice_number / invoice_date / due_date so OCR fixes
    // don't require re-uploading the PDF.
    // PR #R4h: allow discount_applied so the drawer can clear it in the same
    // patch when the user manually overrides Due Date while a discount was
    // active. Server-side post path already accepts a sibling endpoint
    // (POST /discount-applied) — including the field here keeps both writes
    // atomic from the client's perspective.
    const allowed = ["routing_mode", "routing_data", "total", "freight", "notes", "invoice_number", "invoice_date", "due_date", "discount_applied"];
    const patch: any = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if (patch.routing_data && typeof patch.routing_data !== "string") patch.routing_data = JSON.stringify(patch.routing_data);
    // Trim invoice_number; treat empty string as null so dedup doesn't match "".
    if ("invoice_number" in patch) {
      const v = typeof patch.invoice_number === "string" ? patch.invoice_number.trim() : patch.invoice_number;
      patch.invoice_number = v === "" ? null : v;
    }
    const updated = updateInvoice(inv.id, patch);
    if (Array.isArray(req.body.line_items)) {
      for (const li of req.body.line_items) {
        if (li.id) setLineItemStore(li.id, li.store_assignment ?? null);
      }
    }
    appendAuditLog(inv.id, "edit", before, updated, req.email!);
    const final = getInvoice(inv.id);
    res.json({ ...final, line_items: getLineItems(inv.id) });
  });

  app.post("/api/invoices/:id/approve", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    if (inv.vendor_match_status === "unmatched") {
      return res.status(400).json({ message: "Vendor must be matched before approval" });
    }
    if (inv.duplicate_check_status === "duplicate_found") {
      return res.status(400).json({ message: "Resolve duplicate before approving" });
    }
    if ((!inv.total || inv.total === 0) && !inv.is_credit) {
      return res.status(400).json({ message: "Total cannot be zero" });
    }
    const updated = updateInvoice(inv.id, {
      status: "approved_local",
      approved_by: req.email,
      approved_at: new Date().toISOString(),
    });
    appendAuditLog(inv.id, "approve", inv, updated, req.email!);
    const lineItems = getLineItems(inv.id);
    const payload = buildQboBillPayload(updated, lineItems);
    res.json({ invoice: { ...updated, line_items: lineItems }, qbo_payload: payload });
  });

  app.post("/api/invoices/:id/mark-posted", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const updated = updateInvoice(inv.id, {
      status: "posted_qbo",
      qbo_bill_id: req.body?.qbo_bill_id || null,
    });
    appendAuditLog(inv.id, "mark_posted", inv, updated, req.email!);
    res.json(updated);
  });

  app.post("/api/invoices/:id/reject", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const updated = updateInvoice(inv.id, { status: "rejected", notes: req.body?.reason || inv.notes });
    appendAuditLog(inv.id, "reject", inv, updated, req.email!);
    res.json(updated);
  });

  app.post("/api/invoices/:id/restore", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    if (inv.status !== "rejected") {
      return res.status(400).json({ message: `Can only restore rejected invoices (current status: ${inv.status})` });
    }
    const updated = updateInvoice(inv.id, { status: "pending_review" });
    appendAuditLog(inv.id, "restore", inv, updated, req.email!);
    res.json(updated);
  });

  // Real QBO duplicate check — queries Bills and Payments from QBO if connected,
  // otherwise falls back to marking clean. Returns the same dup_check shape used
  // by reparse/rematch so the client can pop the auto-complete modal uniformly.
  app.post("/api/invoices/:id/recheck-duplicate", authMiddleware, async (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const dupCheck = await runDuplicateCheck(inv.id, req.email!);
    if (!dupCheck.invoice) return res.status(404).json({ message: "Not found" });
    res.json({ ...dupCheck.invoice, dup_check: dupCheck });
  });

  // v8: Internal fuzzy duplicate check — scans the local DB for invoices with
  // OCR-similar invoice numbers (Levenshtein ≤ 2 on normalized strings) for the
  // same vendor, plus total/date proximity. Used when Jake edits the invoice
  // number in the drawer to catch "this is actually invoice #1024 we already
  // ingested as #1O24" cases.
  app.post("/api/invoices/:id/recheck-duplicates", authMiddleware, async (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });

    // 1) Run the existing QBO check so the UI gets a unified result.
    const qboDup = await runDuplicateCheck(inv.id, req.email!);

    // 2) Internal fuzzy scan.
    let internalMatch: { id: string; invoice_number: string | null; total: number | null; invoice_date: string | null; vendor_qbo_name: string | null; confidence: number; reason: string } | null = null;
    try {
      const { findDuplicateInvoice } = await import("./dup-detector");
      const Database = (await import("better-sqlite3")).default;
      const path = await import("node:path");
      const db = new Database(path.resolve(process.cwd(), "data.db"));
      try {
        const hit = findDuplicateInvoice(db, {
          vendorQboId: inv.vendor_qbo_id,
          vendorRawName: inv.vendor_raw_name,
          invoiceNumber: inv.invoice_number,
          total: inv.total,
          invoiceDate: inv.invoice_date,
        }, { excludeId: inv.id });
        if (hit) {
          internalMatch = {
            id: hit.id,
            invoice_number: hit.invoice_number,
            total: hit.total,
            invoice_date: hit.invoice_date,
            vendor_qbo_name: hit.vendor_qbo_name,
            confidence: hit.confidence,
            reason: hit.reason,
          };
        }
      } finally {
        db.close();
      }
    } catch (err: any) {
      console.warn("[recheck-duplicates] fuzzy scan failed:", err.message);
    }

    // 3) Persist the fuzzy hint (or clear it) on the invoice itself.
    const fuzzyHintJson = internalMatch && internalMatch.confidence < 90
      ? JSON.stringify({
          matched_invoice_id: internalMatch.id,
          matched_invoice_number: internalMatch.invoice_number,
          confidence: internalMatch.confidence,
          reason: internalMatch.reason,
        })
      : null;
    updateInvoice(inv.id, { fuzzy_dup_hint: fuzzyHintJson });

    const final = getInvoice(inv.id);
    res.json({
      ...final,
      dup_check: qboDup,
      internal_fuzzy_match: internalMatch,
    });
  });

  app.post("/api/invoices/:id/assign-vendor", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const { vendor_qbo_id, vendor_name, save_as_alias } = req.body;
    if (!vendor_qbo_id || !vendor_name) return res.status(400).json({ message: "vendor_qbo_id and vendor_name required" });
    const before = { ...inv };
    // Per Jake: always learn the alias so future invoices with the same raw name auto-match.
    // save_as_alias defaults true; only false if explicitly passed false (kept for back-compat).
    const learn = save_as_alias !== false;
    const updated = updateInvoice(inv.id, {
      vendor_qbo_id,
      vendor_qbo_name: vendor_name,
      vendor_match_status: learn ? "aliased" : "matched",
    });
    let alias_saved = false;
    let alias_skip_reason: string | null = null;
    if (learn && inv.vendor_raw_name) {
      try {
        createAlias({
          alias: inv.vendor_raw_name,
          vendor_qbo_id,
          vendor_name,
          note: `Set by ${req.email} on ${new Date().toLocaleDateString()}`,
        } as any);
        alias_saved = true;
      } catch (e: any) {
        alias_skip_reason = e.message || "unknown";
        console.warn(`[assign-vendor] alias save skipped: ${alias_skip_reason}`);
      }
    } else if (learn && !inv.vendor_raw_name) {
      alias_skip_reason = "no vendor_raw_name on invoice (likely an LLM parse failure)";
    }
    appendAuditLog(inv.id, "assign_vendor", before, { ...updated, alias_saved, alias_skip_reason }, req.email!);
    res.json(updated);
  });

  // v8.4.5: toggle the early-pay discount on/off for an invoice that has
  // discount_kind = 'early_pay'. For 'net_with_discount' the discount is
  // automatic per spec and this endpoint refuses to flip it off. Audit-logged.
  app.post("/api/invoices/:id/discount-applied", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    if (!inv.discount_kind || !inv.discount_terms_pct) {
      return res.status(400).json({ message: "No discount detected on this invoice" });
    }
    const applied = !!req.body?.applied;
    if (inv.discount_kind === "net_with_discount" && !applied) {
      return res.status(400).json({
        message: "This discount is automatic per terms and cannot be removed",
      });
    }
    if (inv.status !== "pending_review" && inv.status !== "receiving" && inv.status !== "quarantined") {
      return res.status(400).json({ message: `Cannot toggle discount when status is ${inv.status}` });
    }
    const before = {
      discount_applied: inv.discount_applied,
    };
    const updated = updateInvoice(inv.id, { discount_applied: applied ? 1 : 0 } as any);
    try {
      appendAuditLog(inv.id, "discount_toggled", before, {
        discount_applied: applied ? 1 : 0,
        discount_kind: inv.discount_kind,
        discount_terms_pct: inv.discount_terms_pct,
        discount_due_date: inv.discount_due_date,
      } as any, req.email!);
    } catch {}
    res.json(updated);
  });

  // Re-run the LLM parser on an existing invoice's stored PDF.
  // Useful when an earlier parse hit max_tokens or a transient API error and
  // left the invoice with vendor_raw_name=null.
  app.post("/api/invoices/:id/reparse", authMiddleware, async (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    if (!isLlmParserEnabled()) return res.status(400).json({ message: "LLM parser is not enabled" });

    const filename = PDF_FILES_MAP[inv.source_file] || inv.pdf_url || null;
    if (!filename) return res.status(404).json({ message: "PDF not found for this invoice" });
    const baseDir = path.resolve(__dirname, "..", "private_assets");
    const fullPath = path.resolve(baseDir, filename);
    if (!fullPath.startsWith(baseDir + path.sep) && fullPath !== baseDir) {
      return res.status(400).json({ message: "Invalid PDF path" });
    }
    if (!fs.existsSync(fullPath)) return res.status(404).json({ message: "PDF missing on disk" });

    const before = { ...inv };
    const buf = fs.readFileSync(fullPath);
    clearLastLlmFailure();
    let llmResult: any = null;
    let failure: string | null = null;
    try {
      llmResult = await parseInvoiceWithLLM(buf, {
        subject: inv.email_subject || null,
        from: inv.email_from || null,
        body: null,
      });
    } catch (e: any) {
      failure = `threw: ${e.message}`;
    }
    if (!llmResult && !failure) failure = getLastLlmFailure() || "unknown LLM failure";

    if (!llmResult) {
      // Persist failure reason but keep current invoice fields
      updateInvoice(inv.id, { parse_failure_reason: failure } as any);
      try {
        appendAuditLog(inv.id, "llm_parse", null, { ok: false, reason: failure, manual_reparse: true } as any, req.email!);
      } catch {}
      return res.status(502).json({ message: failure, ok: false });
    }

    // Apply parsed fields. We preserve the user's existing vendor mapping unless
    // the invoice currently has no vendor and the LLM gives us a raw name.
    const patch: any = {
      parse_failure_reason: null,
      parse_confidence: llmResult.parse_confidence || "medium",
      document_type: llmResult.document_type || null,
      store_hint: llmResult.store_hint || null,
      llm_notes: llmResult.notes || null,
      already_paid: llmResult.already_paid ? 1 : 0,
      line_items_json: JSON.stringify(llmResult.line_items || []),
      bill_kind: llmResult.bill_kind || null,
      is_credit: llmResult.is_credit ? 1 : 0,
    };
    // Only fill in fields that were missing — never overwrite user-edited values.
    if (!inv.vendor_raw_name && llmResult.vendor_raw_name) patch.vendor_raw_name = llmResult.vendor_raw_name;
    if (!inv.invoice_number && llmResult.invoice_number) patch.invoice_number = llmResult.invoice_number;
    if (!inv.invoice_date && llmResult.invoice_date) patch.invoice_date = llmResult.invoice_date;
    if ((inv.total == null || inv.total === 0) && llmResult.total != null) patch.total = llmResult.total;
    if ((inv.freight == null || inv.freight === 0) && llmResult.freight != null) patch.freight = llmResult.freight;
    // v8.4.4: due_date fill-in on reparse — uses parser's deterministic Net-N
    // fallback. Run normalizeDueDate against the effective invoice_date so
    // "Net 30" style strings still resolve if the LLM put terms there.
    if (!inv.due_date) {
      const effectiveInvoiceDate = patch.invoice_date || inv.invoice_date || llmResult.invoice_date || null;
      const normalized = normalizeDueDate(llmResult.due_date, effectiveInvoiceDate);
      const fromTerms = !normalized && effectiveInvoiceDate
        ? computeDueDateFromTerms(effectiveInvoiceDate, llmResult.payment_terms || llmResult.payment_method || null)
        : null;
      const finalDue = normalized || fromTerms;
      if (finalDue) patch.due_date = finalDue;
    }

    // PR #R4h — same deterministic terms-parsing fallback as the initial
    // pipeline. If the LLM gave us a payment_terms string but left the
    // discount_* fields null, regex-parse it and fill the gaps so a reparse
    // doesn't keep producing the same "verbatim terms only" output.
    if (llmResult.payment_terms) {
      const effectiveInvoiceDate = patch.invoice_date || inv.invoice_date || llmResult.invoice_date || null;
      const fallback = parsePaymentTermsFallback(llmResult.payment_terms, effectiveInvoiceDate);
      if (fallback) {
        const filled: string[] = [];
        if (llmResult.discount_terms_pct == null && fallback.discount_terms_pct != null) {
          llmResult.discount_terms_pct = fallback.discount_terms_pct;
          filled.push("discount_terms_pct");
        }
        if (llmResult.discount_days == null && fallback.discount_days != null) {
          llmResult.discount_days = fallback.discount_days;
          filled.push("discount_days");
        }
        if (!llmResult.discount_due_date && fallback.discount_due_date) {
          llmResult.discount_due_date = fallback.discount_due_date;
          filled.push("discount_due_date");
        }
        if (!llmResult.discount_kind && fallback.discount_kind) {
          llmResult.discount_kind = fallback.discount_kind;
          filled.push("discount_kind");
        }
        if (filled.length > 0) {
          console.log(
            `[terms-fallback] reparse ${inv.id}: filled ${filled.join(",")} from "${llmResult.payment_terms}"`,
          );
        }
      }
    }

    // v8.4.5: discount fields. Only fill when the invoice has no discount_kind
    // yet — never overwrite a user toggle/applied state. For net_with_discount
    // the discount is automatic per spec, so flip applied=1 when first detected.
    if (!inv.discount_kind && llmResult.discount_kind) {
      patch.discount_terms_pct = llmResult.discount_terms_pct ?? null;
      patch.discount_days = llmResult.discount_days ?? null;
      patch.discount_due_date = llmResult.discount_due_date ?? null;
      patch.discount_kind = llmResult.discount_kind;
      patch.discount_warning = llmResult.discount_warning ?? null;
      if (llmResult.discount_kind === "net_with_discount") patch.discount_applied = 1;
    }

    // Round 7 follow-up: if the invoice has no QBO vendor yet, run vendor
    // matching using the freshly-parsed (or pre-existing) raw name. Smart
    // match first, then LLM fallback. Never overwrite a user-set vendor.
    if (!inv.vendor_qbo_id) {
      const candidateRawName = patch.vendor_raw_name || inv.vendor_raw_name || llmResult.vendor_raw_name || null;
      if (candidateRawName) {
        const local = smartMatchVendor(candidateRawName);
        if (local?.vendor_qbo_id) {
          patch.vendor_qbo_id = local.vendor_qbo_id;
          patch.vendor_qbo_name = local.vendor_qbo_name;
          patch.vendor_match_status = local.vendor_match_status;
        } else if (isVendorMatcherLlmEnabled()) {
          try {
            const llmMatch = await matchVendorWithLlm(candidateRawName);
            if (llmMatch?.vendor_qbo_id && llmMatch.confidence === "high") {
              patch.vendor_qbo_id = llmMatch.vendor_qbo_id;
              patch.vendor_qbo_name = llmMatch.vendor_qbo_name;
              patch.vendor_match_status = "aliased";
              try {
                learnVendorAlias(candidateRawName, llmMatch.vendor_qbo_id, llmMatch.vendor_qbo_name || "", "learned-from-llm-high-confidence");
              } catch {}
            }
          } catch {}
        }
      }
    }

    const updated = updateInvoice(inv.id, patch);

    // Round 7 follow-up: persist line items into invoice_line_items so the
    // drawer's "Line items" routing tab is enabled. Carries existing
    // store_assignment values forward when description+amount match.
    try {
      if (Array.isArray(llmResult.line_items)) {
        replaceInvoiceLineItems(inv.id, llmResult.line_items as any);
      }
    } catch (e) {
      console.warn(`[reparse] line-item persist failed for ${inv.id}:`, (e as Error).message);
    }

    try {
      appendAuditLog(inv.id, "llm_parse", before, {
        ok: true,
        manual_reparse: true,
        vendor_raw_name: llmResult.vendor_raw_name,
        invoice_number: llmResult.invoice_number,
        total: llmResult.total,
        line_item_count: Array.isArray(llmResult.line_items) ? llmResult.line_items.length : 0,
      } as any, req.email!);
    } catch {}
    // Round 7 follow-up: now that fields may have changed (invoice number,
    // vendor), re-run the QBO dup check. If it finds a match, the response
    // includes dup_check.found=true so the client can pop the auto-complete
    // confirmation modal.
    let dupCheck: Awaited<ReturnType<typeof runDuplicateCheck>> | null = null;
    if (updated && updated.status === "pending_review") {
      dupCheck = await runDuplicateCheck(inv.id, req.email!);
    }
    const finalInv = dupCheck?.invoice || updated;
    res.json({ ok: true, invoice: finalInv, dup_check: dupCheck });
  });

  app.post("/api/invoices/:id/remove-vendor", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const before = { ...inv };
    const updated = updateInvoice(inv.id, {
      vendor_qbo_id: null,
      vendor_qbo_name: null,
      vendor_match_status: "unmatched",
    });
    let alias_deleted = false;
    if (inv.vendor_raw_name) {
      const removed = deleteAliasByLowerName(inv.vendor_raw_name);
      alias_deleted = removed > 0;
    }
    appendAuditLog(inv.id, "remove_vendor", before, { ...updated, alias_deleted }, req.email!);
    res.json({ ...updated, alias_deleted });
  });

  // Round 7 follow-up: Re-match vendor — re-runs the smart matcher (and LLM
  // fallback if enabled) against the invoice's stored vendor_raw_name without
  // re-parsing the PDF. Cheap, fast, and useful when the matcher has been
  // improved or new aliases have been added since the original parse. Will not
  // overwrite a vendor that the user has already manually assigned.
  app.post("/api/invoices/:id/rematch-vendor", authMiddleware, async (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    if (inv.vendor_qbo_id) {
      return res.status(400).json({ message: "Vendor already matched. Click Remove first if you want to re-match." });
    }
    const rawName = inv.vendor_raw_name || null;
    if (!rawName) {
      return res.status(400).json({ message: "No vendor name on file to match against. Try Reparse first." });
    }
    const before = { ...inv };
    const patch: any = {};
    let source: "smart" | "llm" | "none" = "none";
    const local = smartMatchVendor(rawName);
    if (local?.vendor_qbo_id) {
      patch.vendor_qbo_id = local.vendor_qbo_id;
      patch.vendor_qbo_name = local.vendor_qbo_name;
      patch.vendor_match_status = local.vendor_match_status;
      source = "smart";
    } else if (isVendorMatcherLlmEnabled()) {
      try {
        const llmMatch = await matchVendorWithLlm(rawName);
        if (llmMatch?.vendor_qbo_id && llmMatch.confidence === "high") {
          patch.vendor_qbo_id = llmMatch.vendor_qbo_id;
          patch.vendor_qbo_name = llmMatch.vendor_qbo_name;
          patch.vendor_match_status = "aliased";
          source = "llm";
          try {
            learnVendorAlias(rawName, llmMatch.vendor_qbo_id, llmMatch.vendor_qbo_name || "", "learned-from-llm-high-confidence");
          } catch {}
        }
      } catch {}
    }
    if (!patch.vendor_qbo_id) {
      return res.json({ ok: false, matched: false, message: `No match found for "${rawName}". Use Change vendor to pick manually.`, invoice: inv });
    }
    const updated = updateInvoice(inv.id, patch);
    try {
      appendAuditLog(inv.id, "rematch_vendor", before, { ...updated, source } as any, req.email!);
    } catch {}
    // Round 7 follow-up: vendor changed, so re-check for QBO duplicates.
    let dupCheck: Awaited<ReturnType<typeof runDuplicateCheck>> | null = null;
    if (updated && updated.status === "pending_review") {
      dupCheck = await runDuplicateCheck(inv.id, req.email!);
    }
    const finalInv = dupCheck?.invoice || updated;
    res.json({ ok: true, matched: true, source, invoice: finalInv, dup_check: dupCheck });
  });

  app.get("/api/invoices/:id/qbo-payload", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    res.json(buildQboBillPayload(inv, getLineItems(inv.id)));
  });

  // Post invoice directly to QBO as a Bill
  app.post("/api/invoices/:id/post-to-qbo", authMiddleware, async (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });

    const qboStatus = getQboStatus();
    if (!qboStatus.connected) {
      return res.status(503).json({ message: "QuickBooks is not connected. Go to Settings → QuickBooks to connect." });
    }

    try {
      const lineItems = getLineItems(inv.id);
      const billPayload = buildQboBillPayload(inv, lineItems);
      const isCredit = !!inv.is_credit;
      // Vendor credits use a separate QBO entity (/vendorcredit) — same line structure but
      // posted as a reduction of vendor balance. Bills go to /bill.
      // VendorCredit does NOT accept DueDate or TotalAmt (read-only) — strip them.
      // Also use a positive Amount per QBO convention (entity type implies the sign).
      let payload = billPayload;
      if (isCredit) {
        const { DueDate, TotalAmt, ...rest } = billPayload as any;
        payload = {
          ...rest,
          Line: (billPayload.Line || []).map((l: any) => ({
            ...l,
            Amount: Math.abs(Number(l.Amount) || 0),
          })),
        };
        // Strip null/empty fields that QBO VendorCredit rejects (DocNumber=null, VendorRef=null, etc.)
        for (const key of Object.keys(payload)) {
          if (payload[key] === null || payload[key] === "" || payload[key] === undefined) {
            delete payload[key];
          }
        }
      }
      console.log(`[post-to-qbo] sending ${isCredit ? "VendorCredit" : "Bill"} payload:`, JSON.stringify(payload, null, 2));
      const result = isCredit ? await createVendorCredit(payload) : await createBill(payload);
      const docId = isCredit
        ? (result?.VendorCredit?.Id || result?.Id || null)
        : (result?.Bill?.Id || result?.Id || null);
      const updated = updateInvoice(inv.id, {
        status: "posted_qbo",
        qbo_bill_id: docId,
      });
      appendAuditLog(inv.id, isCredit ? "post_vendor_credit_to_qbo" : "post_to_qbo", inv, updated, req.email!);
      res.json({ invoice: updated, qbo_bill_id: docId, qbo_doc_id: docId, is_credit: isCredit });
    } catch (err: any) {
      console.error(`[post-to-qbo] Error (${inv.is_credit ? "vendor_credit" : "bill"}):`, err.message);
      // Auto-revert to pending_review so the user isn't stranded in approved_local with no retry path.
      // The audit log records the failed post + revert.
      try {
        const reverted = updateInvoice(inv.id, {
          status: "pending_review",
          approved_by: null,
          approved_at: null,
        });
        appendAuditLog(inv.id, "post_to_qbo_failed_reverted", inv, reverted, req.email!);
      } catch (revertErr: any) {
        console.error("[post-to-qbo] Failed to revert status:", revertErr.message);
      }
      res.status(500).json({ message: `QBO posting failed: ${err.message}`, reverted_to_pending: true });
    }
  });

  // Manual revert from approved_local back to pending_review (e.g. user wants to make edits)
  app.post("/api/invoices/:id/revert-to-pending", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    if (inv.status === "posted_qbo") {
      return res.status(400).json({ message: "Cannot revert: invoice is already posted to QBO" });
    }
    const updated = updateInvoice(inv.id, {
      status: "pending_review",
      approved_by: null,
      approved_at: null,
    });
    appendAuditLog(inv.id, "revert_to_pending", inv, updated, req.email!);
    res.json(updated);
  });

  // ---- Rules ----
  app.get("/api/rules", authMiddleware, (_req, res) => res.json(listRules()));
  app.post("/api/rules", authMiddleware, (req, res) => {
    const data = { ...req.body };
    if (data.split_data && typeof data.split_data !== "string") data.split_data = JSON.stringify(data.split_data);
    res.json(createRule(data));
  });
  app.patch("/api/rules/:id", authMiddleware, (req, res) => {
    const data = { ...req.body };
    if (data.split_data && typeof data.split_data !== "string") data.split_data = JSON.stringify(data.split_data);
    res.json(updateRule(parseInt(req.params.id), data));
  });
  app.delete("/api/rules/:id", authMiddleware, (req, res) => {
    deleteRule(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // ---- Aliases ----
  app.get("/api/aliases", authMiddleware, (_req, res) => res.json(listAliases()));
  app.post("/api/aliases", authMiddleware, (req, res) => {
    try {
      res.json(createAlias(req.body));
    } catch (e: any) {
      res.status(400).json({ message: e.message || "Failed to create alias" });
    }
  });
  app.delete("/api/aliases/:id", authMiddleware, (req, res) => {
    deleteAlias(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // ---- QBO vendor list (local JSON) ----
  app.get("/api/qbo-vendors", authMiddleware, (req, res) => {
    const q = String(req.query.q || "");
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    res.json(searchQboVendors(q, limit));
  });

  // Vendor suggestions for an unmatched invoice. Returns up to 5 ranked candidates,
  // first by local token-overlap, then asks Claude (if enabled) for an additional pick.
  app.get("/api/invoices/:id/vendor-suggestions", authMiddleware, async (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const raw = inv.vendor_raw_name || "";
    const local = rankVendorSuggestions(raw, 5);
    let llmSuggestion: any = null;
    if (isVendorMatcherLlmEnabled() && raw && local.length === 0) {
      try {
        const r = await matchVendorWithLlm(raw);
        if (r) {
          llmSuggestion = {
            vendor_qbo_id: r.vendor_qbo_id,
            vendor_qbo_name: r.vendor_qbo_name,
            confidence: r.confidence,
            reasoning: r.reasoning,
            alternatives: r.alternatives,
          };
        }
      } catch {}
    }
    res.json({ raw_name: raw, local_suggestions: local, llm_suggestion: llmSuggestion });
  });

  // ---- Manual PDF upload (for mailed paper invoices or one-offs) ----
  // Accepts up to 10 PDFs at once via multipart/form-data, runs each through the
  // same parse → match → dedup → QBO-check pipeline as Gmail polling.
  // Round 7 follow-up: dedicated upload diagnostics endpoint. Accepts ANY POST,
  // logs every header + every form-data part (file or value) to server.log AND
  // returns the same data in the JSON response so we can paste it back. No auth
  // required so we can hit it with curl. Use this to isolate whether "No file
  // received" is a client problem (browser / DevTools UI), a network problem
  // (proxy / ngrok stripping multipart), or a server problem (multer config).
  app.post("/api/debug/upload-echo", (req, res, next) => {
    const handler = uploadHandler.any();
    handler(req, res, (err: any) => {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v).slice(0, 500)])
      );
      const filesArr = ((req as any).files as Express.Multer.File[]) || [];
      const files = (Array.isArray(filesArr) ? filesArr : []).map(f => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        first_bytes: (f.buffer ? f.buffer.slice(0, 16).toString("hex") : null),
      }));
      const body_keys = Object.keys(req.body || {});
      const out = {
        ok: !err,
        multer_error: err ? { code: err.code || null, field: err.field || null, message: err.message || String(err) } : null,
        method: req.method,
        url: req.url,
        headers,
        file_count: files.length,
        files,
        body_keys,
        body_preview: Object.fromEntries(body_keys.slice(0, 10).map(k => [k, String((req.body as any)[k]).slice(0, 200)])),
      };
      console.log(`[upload-echo] ${JSON.stringify(out)}`);
      res.status(200).json(out);
    });
  });

  app.post("/api/invoices/upload", authMiddleware, (req, res, next) => {
    // Round 7 follow-up: log Content-Type + length for any upload attempt so we
    // can diagnose “No file received” errors. Multer requires multipart/form-data
    // with a boundary; if the browser/proxy strips it we want to know.
    const ct = req.headers["content-type"] || "";
    const cl = req.headers["content-length"] || "0";
    console.log(`[upload] incoming content-type="${ct}" content-length=${cl}`);
    // Accept files under ANY field name. multer.any() is the most tolerant
    // mode — if a file part is in the form-data, multer extracts it regardless
    // of field name. Server then logs which field names came through so we can
    // diagnose any client-side mismatch.
    const handler = uploadHandler.any();
    handler(req, res, (err: any) => {
      if (err) {
        const msg = err?.code === "LIMIT_FILE_SIZE" ? "File too large (50MB max per file)"
                  : err?.code === "LIMIT_FILE_COUNT" ? "Too many files (20 max per upload)"
                  : err?.code === "LIMIT_UNEXPECTED_FILE" ? `Unexpected form field “${err.field}” (expected “files” or “file”)`
                  : (err.message || "Upload error");
        console.log(`[upload] multer error: ${err?.code || ""} ${msg}`);
        return res.status(400).json({ message: msg, code: err?.code || null });
      }
      next();
    });
  }, async (req, res) => {
    // multer.any() returns an array directly under req.files.
    const filesArr = ((req as any).files as Express.Multer.File[]) || [];
    const files: Express.Multer.File[] = Array.isArray(filesArr) ? filesArr : [];
    if (files.length > 0) {
      console.log(`[upload] field names received: ${[...new Set(files.map(f => f.fieldname))].join(", ")}`);
    }
    if (!files || files.length === 0) {
      const ct = req.headers["content-type"] || "";
      const cl = req.headers["content-length"] || "0";
      const isMultipart = ct.toString().toLowerCase().includes("multipart/form-data");
      const hasBoundary = ct.toString().toLowerCase().includes("boundary=");
      console.log(`[upload] no files received. multipart=${isMultipart} boundary=${hasBoundary} cl=${cl} body-keys=${Object.keys(req.body || {}).join(",") || "(none)"}`);
      let detail = "No file received.";
      if (!isMultipart) detail += ` Content-Type was "${ct || "(missing)"}" — expected multipart/form-data.`;
      else if (!hasBoundary) detail += ` Content-Type "${ct}" missing boundary parameter — the form data is malformed.`;
      else if (cl === "0" || cl === 0) detail += ` Content-Length is 0 — the request had no body.`;
      else detail += " Try the file picker instead of drag-and-drop, or check the server log for diagnostics.";
      return res.status(400).json({
        message: detail,
        diagnostic: { content_type: ct, content_length: cl, multipart: isMultipart, has_boundary: hasBoundary },
      });
    }
    console.log(`[upload] received ${files.length} file(s): ${files.map(f => `${f.originalname || "(unnamed)"} (${f.mimetype || "?"}, ${f.size}b)`).join(", ")}`);

    // Sniff each file's first 5 bytes for the %PDF- magic header. If a file
    // doesn't look like a real PDF, reject up front with a useful message so
    // we don't waste an LLM call on a Word doc / zip / image.
    const isPdfBuffer = (buf: Buffer) => {
      if (!buf || buf.length < 5) return false;
      // Most PDFs start with %PDF- at byte 0. Some have a small UTF-8 BOM or
      // whitespace prefix — scan the first 1KB to be safe.
      const head = buf.slice(0, Math.min(buf.length, 1024)).toString("binary");
      return head.includes("%PDF-");
    };

    const results: any[] = [];
    const rejected: Array<{ filename: string; reason: string }> = [];
    for (const f of files) {
      let pdfBuffer: Buffer = f.buffer;
      let pdfFilename: string = f.originalname || "upload.pdf";
      let convertedFromImage = false;

      // If it's not already a PDF but it IS an image (JPG/PNG/HEIC),
      // convert image → single-page PDF on the fly so the rest of the
      // pipeline (parser, archive, Drive backup) keeps treating it as a PDF.
      if (!isPdfBuffer(f.buffer)) {
        if (looksLikeImage(f.buffer)) {
          try {
            const kind = sniffImageKind(f.buffer);
            console.log(`[upload] converting image (${kind}) → PDF: ${f.originalname || "(unnamed)"}`);
            pdfBuffer = await imageBufferToPdf(f.buffer, f.originalname || "upload");
            // Rename the file to .pdf so downstream code is consistent.
            const stem = (f.originalname || "upload").replace(/\.(heic|heif|jpe?g|png)$/i, "");
            pdfFilename = `${stem}.pdf`;
            convertedFromImage = true;
          } catch (convErr: any) {
            rejected.push({
              filename: f.originalname || "(unnamed)",
              reason: convErr.message || "Image conversion failed",
            });
            continue;
          }
        } else {
          rejected.push({
            filename: f.originalname || "(unnamed)",
            reason: `Not a PDF or supported image (got ${f.mimetype || "unknown type"}, ${f.size} bytes). Accepted: PDF, JPG, PNG, HEIC.`,
          });
          continue;
        }
      }
      try {
        const r = await processInvoicePdf({
          pdfBuffer,
          originalFilename: pdfFilename,
          source: convertedFromImage ? "manual-upload-image" : "manual-upload",
          sourceType: convertedFromImage ? "image_ocr" : "pdf",
          emailFrom: req.email || null,
          emailSubject: convertedFromImage
            ? `Manual upload (image): ${f.originalname}`
            : `Manual upload: ${f.originalname}`,
          emailDate: new Date().toISOString(),
          emailBody: null,
        });
        results.push({ filename: pdfFilename, original_filename: f.originalname, converted_from_image: convertedFromImage, ...r });
      } catch (err: any) {
        results.push({ filename: pdfFilename, status: "error", invoice_id: null, reason: err.message });
      }
    }

    // If every file was rejected as non-PDF, surface that as a 400 so the toast says why.
    if (results.length === 0 && rejected.length > 0) {
      return res.status(400).json({
        message: rejected.length === 1
          ? `${rejected[0].filename}: ${rejected[0].reason}`
          : `None of the ${rejected.length} files were valid PDF or image uploads.`,
        rejected,
      });
    }

    res.json({
      uploaded: files.length,
      results,
      rejected: rejected.length ? rejected : undefined,
    });
  });

  // ---- Acumatica (Winter Sports Retailers) on-demand pull ----
  app.get("/api/acumatica/status", authMiddleware, (_req, res) => {
    res.json({ ...getAcumaticaStatus(), error_log: getAcumaticaErrorLog(20) });
  });

  app.post("/api/acumatica/clear-error-log", authMiddleware, (_req, res) => {
    clearAcumaticaErrorLog();
    res.json({ ok: true });
  });
  app.post("/api/acumatica/run-now", authMiddleware, async (req, res) => {
    try {
      // ?debug=1 triggers a one-shot diagnostic run that dumps a screenshot,
      // iframe HTML, and DOM probe to ./debug/ then bails before per-row clicks.
      const debug = req.query?.debug === "1" || req.query?.debug === "true";
      const r = await runAcumaticaPullNow({ debug });
      res.json(r);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // One-time backfill: scan posted invoices and seed vendor_aliases.
  app.post("/api/vendor-aliases/backfill", authMiddleware, (_req, res) => {
    try {
      const result = backfillVendorAliasesFromPostedInvoices();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/qbo-accounts", authMiddleware, (_req, res) => {
    res.json(STORES.map((s) => ({
      id: s.qbo_account_id,
      name: s.qbo_account_name,
      store_key: s.key,
      store_label: s.label,
    })));
  });

  // ---- Smart re-match: backfill vendor + store on existing pending_review invoices ----
  // Only touches invoices that are still pending_review (won't disturb approved/posted/rejected).
  // Will not overwrite a vendor or store that the user has already set manually.
  app.post("/api/invoices/rematch-all", authMiddleware, (_req, res) => {
    const all = listInvoices({}).filter((i) => i.status === "pending_review");
    let vendorMatched = 0;
    let storeAssigned = 0;
    const updates: Array<{ id: string; vendor?: string; store?: string }> = [];
    for (const inv of all) {
      const patch: any = {};
      // Vendor: only re-match if currently unmatched
      if (inv.vendor_match_status === "unmatched") {
        const m = smartMatchVendor(inv.vendor_raw_name);
        if (m) {
          patch.vendor_qbo_id = m.vendor_qbo_id;
          patch.vendor_qbo_name = m.vendor_qbo_name;
          patch.vendor_match_status = m.vendor_match_status;
          vendorMatched++;
        }
      }
      // Store: only assign if currently null/empty (don't overwrite a user choice)
      if (!inv.ship_to_store) {
        const newVendorId = patch.vendor_qbo_id || inv.vendor_qbo_id;
        const store = resolveShipToStore((inv as any).store_hint, newVendorId);
        if (store) {
          patch.ship_to_store = store;
          patch.routing_data = JSON.stringify({ store });
          storeAssigned++;
        }
      }
      if (Object.keys(patch).length > 0) {
        updateInvoice(inv.id, patch);
        updates.push({ id: inv.id, vendor: patch.vendor_qbo_name, store: patch.ship_to_store });
      }
    }
    console.log(`[rematch-all] matched ${vendorMatched} vendors, assigned ${storeAssigned} stores across ${updates.length} invoices`);
    res.json({
      total_pending: all.length,
      vendor_matched: vendorMatched,
      store_assigned: storeAssigned,
      updated: updates,
    });
  });

  // ---- QBO OAuth ----
  app.get("/api/qbo/status", authMiddleware, (_req, res) => {
    res.json({ ...getQboStatus(), error_log: getQboErrorLog(20) });
  });

  app.post("/api/qbo/clear-error-log", authMiddleware, (_req, res) => {
    clearQboErrorLog();
    res.json({ ok: true });
  });

  app.get("/api/qbo/connect", (req, res) => {
    // Accept token via query param since this is a top-level browser redirect
    // (browsers can't attach Authorization header to a window.location navigation)
    const token = String(req.query.t || "");
    const session = token ? getSession(token) : null;
    if (!session) {
      return res.status(401).send("Unauthorized — please sign in to the dashboard first");
    }
    const state = crypto.randomBytes(16).toString("hex");
    const url = getAuthUrl(state);
    pendingOAuthStates.set(state, Date.now() + 10 * 60 * 1000);
    res.redirect(url);
  });

  app.get("/api/qbo/callback", async (req, res) => {
    const { code, realmId, state } = req.query as Record<string, string>;
    if (!code || !realmId) {
      return res.status(400).send("Missing code or realmId");
    }
    // Optional state check
    if (state && pendingOAuthStates.has(state)) {
      pendingOAuthStates.delete(state);
    }
    try {
      await exchangeCode(code, realmId, state);
      // Redirect back to the app's settings page
      res.redirect("/#/settings");
    } catch (err: any) {
      console.error("[qbo/callback] Error:", err.message);
      res.status(500).send(`QBO auth failed: ${err.message}`);
    }
  });

  app.post("/api/qbo/disconnect", authMiddleware, (_req, res) => {
    disconnectQbo();
    res.json({ ok: true });
  });

  // QBO vendor cache info (for Settings page)
  app.get("/api/qbo/vendors/status", authMiddleware, (_req, res) => {
    res.json(lastVendorSyncAge());
  });

  // Manual sync trigger — also runs in background every 24h on server start.
  app.post("/api/qbo/vendors/sync", authMiddleware, async (_req, res) => {
    try {
      const r = await syncQboVendorsFromApi();
      res.json({ ok: true, ...r });
    } catch (err: any) {
      console.error("[/api/qbo/vendors/sync] failed:", err.message);
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ---- Gmail ----
  app.get("/api/gmail/status", authMiddleware, (_req, res) => {
    res.json(getGmailStatus());
  });

  app.post("/api/gmail/poll-now", authMiddleware, async (_req, res) => {
    try {
      // v8.3: manual poll-now also gets the auto-retry on transient errors
      const result = await pollWithRetry();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // v8.3: Reingest emails matching a filter (e.g. resurface a credit memo that
  // was silently skipped by the old Stage 1 keyword list). Body params:
  //   { fromContains?: string, subjectContains?: string, sinceDays?: number }
  app.post("/api/gmail/reingest", adminMiddleware, async (req, res) => {
    try {
      const { fromContains, subjectContains, sinceDays } = req.body || {};
      if (!fromContains && !subjectContains) {
        return res.status(400).json({ message: "Provide at least fromContains or subjectContains" });
      }
      const result = await reingestEmails({
        fromContains: fromContains ? String(fromContains) : undefined,
        subjectContains: subjectContains ? String(subjectContains) : undefined,
        sinceDays: sinceDays ? parseInt(String(sinceDays), 10) : 30,
      });
      res.json({
        cleared_count: result.cleared.length,
        cleared: result.cleared,
        new_invoices: result.poll.new_invoices,
        errors: result.poll.errors,
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Lightweight credential test — connect, list folders, disconnect.
  // Used by the "Test connection" button on the Settings page.
  app.post("/api/gmail/test-connection", authMiddleware, async (_req, res) => {
    try {
      const result = await testGmailConnection();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Clear the Gmail recent-errors log (used by Settings page "Clear log" button).
  app.post("/api/gmail/clear-error-log", authMiddleware, (_req, res) => {
    clearGmailErrorLog();
    res.json({ ok: true });
  });

  // ---- Digest (with bucket counts) ----
  app.get("/api/digest", authMiddleware, (_req, res) => {
    const all = listInvoices();
    const today = new Date().toISOString().slice(0, 10);
    // weekStart = Monday-based week start (00:00:00)
    const now = new Date();
    const dow = now.getDay(); // 0=Sun..6=Sat
    const daysSinceMon = (dow + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - daysSinceMon);
    const weekStartIso = weekStart.toISOString();

    const pending = all.filter((i) => i.status === "pending_review");
    const oldestPending = pending.reduce<number | null>((acc, i) => {
      if (!i.created_at) return acc;
      const ts = new Date(i.created_at).getTime();
      if (Number.isNaN(ts)) return acc;
      return acc === null || ts < acc ? ts : acc;
    }, null);

    const digest = {
      // legacy fields kept for back-compat
      pending_review: pending.length,
      approved_local: all.filter((i) => i.status === "approved_local").length,
      posted_today: all.filter((i) => i.status === "posted_qbo" && (i.approved_at || "").slice(0, 10) === today).length,
      needs_vendor: all.filter((i) => i.vendor_match_status === "unmatched").length,
      low_confidence: all.filter((i) => i.parse_confidence === "low" && i.status === "pending_review").length,
      total_pending_amount: pending.reduce((s, i) => s + (i.total || 0), 0),
      // NEW: bucket workflow counts
      inbox_count: pending.length,
      receiving_count: all.filter((i) => i.status === "receiving").length,
      // Problem bucket is MANUAL ONLY: only count invoices Jake explicitly filed there.
      problem_count: all.filter((i) => i.status === "quarantined").length,
      skipped_count: countActiveSkippedUploads(),
      // NEW: dashboard metrics
      oldest_pending_age_hours: oldestPending ? Math.floor((Date.now() - oldestPending) / (1000 * 60 * 60)) : null,
      posted_this_week_amount: all.filter((i) => i.status === "posted_qbo" && (i.approved_at || "") >= weekStartIso).reduce((s, i) => s + (i.total || 0), 0),
      pending_approval_amount: pending.reduce((s, i) => s + (i.total || 0), 0),
    };
    res.json(digest);
  });

  // ===== Skipped Uploads (Round 7) =====
  // List all skipped uploads (active by default; pass ?include_restored=1 to see all).
  app.get("/api/skipped", authMiddleware, (req, res) => {
    const includeRestored = String(req.query.include_restored || "") === "1";
    const rows = listSkippedUploads({ includeRestored });
    res.json(rows);
  });

  // View the kept PDF for a skipped upload. Uses a signed token (same scheme
  // as invoice PDFs) so the <iframe>/<a> works without an Authorization header.
  app.get("/api/skipped/:id/pdf-token", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = getSkippedUpload(id);
    if (!row) return res.status(404).json({ message: "Not found" });
    const sessionToken = req.headers.authorization!.slice(7);
    const { token, expires } = signPdfToken(`skipped:${row.id}`, sessionToken);
    res.json({ token, expires, url: `/api/skipped/${row.id}/pdf?t=${token}&s=${encodeURIComponent(sessionToken)}` });
  });

  app.get("/api/skipped/:id/pdf", (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = getSkippedUpload(id);
    if (!row) return res.status(404).send("Not found");
    const t = String(req.query.t || "");
    const sessionToken = String(req.query.s || "");
    const sess = sessionToken ? getSession(sessionToken) : null;
    if (!sess) return res.status(401).send("Unauthorized");
    if (!verifyPdfToken(`skipped:${row.id}`, sessionToken, t)) return res.status(401).send("Bad or expired link");
    if (!row.pdf_url) return res.status(404).send("PDF not found");
    const baseDir = path.resolve(__dirname, "..", "private_assets");
    const fullPath = path.resolve(baseDir, row.pdf_url);
    if (!fullPath.startsWith(baseDir + path.sep) && fullPath !== baseDir) {
      return res.status(400).send("Invalid path");
    }
    if (!fs.existsSync(fullPath)) return res.status(404).send("PDF missing on disk");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${row.original_filename || row.pdf_url}"`);
    res.setHeader("Cache-Control", "private, no-cache");
    fs.createReadStream(fullPath).pipe(res);
  });

  // Restore a skipped upload as a real invoice. Re-runs the pipeline on the
  // same PDF, but with FORCE_REAL_INVOICE=1 so even if the LLM still flags it
  // as a non-invoice, we keep it as a normal pending_review invoice.
  app.post("/api/skipped/:id/restore", authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = getSkippedUpload(id);
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.restored_invoice_id) {
      return res.status(400).json({ message: "Already restored", invoice_id: row.restored_invoice_id });
    }
    if (!row.pdf_url) return res.status(400).json({ message: "No PDF on file" });
    const baseDir = path.resolve(__dirname, "..", "private_assets");
    const fullPath = path.resolve(baseDir, row.pdf_url);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ message: "PDF missing on disk" });
    let buf: Buffer;
    try { buf = fs.readFileSync(fullPath); }
    catch (e: any) { return res.status(500).json({ message: `Read failed: ${e.message}` }); }

    // Force-process: temporarily set env flag, run pipeline, then unset.
    const prevForce = process.env.FORCE_REAL_INVOICE;
    process.env.FORCE_REAL_INVOICE = "1";
    let result;
    try {
      result = await processInvoicePdf({
        pdfBuffer: buf,
        originalFilename: row.original_filename || row.pdf_url,
        source: `restore-from-skipped:${row.id}`,
        emailFrom: row.email_from || undefined,
        emailSubject: row.email_subject || undefined,
        emailDate: row.email_date || undefined,
      });
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_REAL_INVOICE;
      else process.env.FORCE_REAL_INVOICE = prevForce;
    }

    if (result.status !== "ingested" && result.status !== "duplicate_internal" && result.status !== "duplicate_qbo") {
      return res.status(502).json({ message: `Restore failed: ${result.reason || result.status}` });
    }
    if (result.invoice_id) {
      markSkippedUploadRestored(row.id, result.invoice_id);
      try { appendAuditLog(result.invoice_id, "restore_from_skipped", { skipped_id: row.id, llm_document_type: row.llm_document_type, llm_skip_reason: row.llm_skip_reason }, { invoice_id: result.invoice_id }, req.email!); } catch {}
    }
    res.json({ ok: true, invoice_id: result.invoice_id, status: result.status, reason: result.reason });
  });

  // Permanently delete a skipped upload (and its PDF on disk).
  app.delete("/api/skipped/:id", authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = getSkippedUpload(id);
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.restored_invoice_id) {
      return res.status(400).json({ message: "Already restored — manage from invoices instead" });
    }
    if (row.pdf_url) {
      const baseDir = path.resolve(__dirname, "..", "private_assets");
      const fullPath = path.resolve(baseDir, row.pdf_url);
      if (fullPath.startsWith(baseDir + path.sep) && fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch {}
      }
    }
    deleteSkippedUpload(id);
    res.json({ ok: true });
  });

  // NOTE: Earlier minimal /api/me handler removed in PR #7 — superseded by the
  // RBAC-aware /api/me defined near the top of registerRoutes() which returns
  // { email, role, name, user_id, permissions, roles }.

  // ---- All invoices (full search/filter) ----
  app.get("/api/all-invoices", authMiddleware, (req, res) => {
    const { q, vendor_qbo_id, status, ship_to_store, doc_type } = req.query as Record<string, string | undefined>;
    let list = listInvoices({
      status: status && status !== "all" ? status : undefined,
      vendor_qbo_id: vendor_qbo_id && vendor_qbo_id !== "all" ? vendor_qbo_id : undefined,
      ship_to_store: ship_to_store && ship_to_store !== "all" ? ship_to_store : undefined,
      doc_type: doc_type === "invoices" || doc_type === "credits" ? doc_type : undefined,
    });
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter((i) =>
        (i.vendor_qbo_name || "").toLowerCase().includes(needle) ||
        (i.vendor_raw_name || "").toLowerCase().includes(needle) ||
        (i.invoice_number || "").toLowerCase().includes(needle)
      );
    }
    res.json(list);
  });

  // ---- Buckets: move invoice to receiving / quarantined / pending_review ----
  app.post("/api/invoices/:id/bucket", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    const target = String((req.body && req.body.status) || "").trim();
    const ALLOWED = ["receiving", "quarantined", "pending_review"];
    if (!ALLOWED.includes(target)) return res.status(400).json({ message: `bucket must be one of ${ALLOWED.join(", ")}` });
    const before = { ...inv };
    const updated = updateInvoice(inv.id, { status: target } as any);
    appendAuditLog(inv.id, `bucket:${target}`, before, updated, req.email!);
    // record the action in the notes log too, for audit history
    const reason = String((req.body && req.body.reason) || "").trim();
    createInvoiceNote(inv.id, req.email || null, reason ? `Moved to ${target}: ${reason}` : `Moved to ${target}`);
    res.json(updated);
  });

  // ---- Bulk actions ----
  // Body: { ids: string[], action: "posted" | "quarantined" | "pending_review" | "receiving" | "rejected" }
  // Returns: { updated: number, failed: { id, reason }[] }
  app.post("/api/invoices/bulk-action", authMiddleware, (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map((x: any) => String(x)) : [];
    const action = String(req.body?.action || "").trim();
    const ALLOWED = ["posted", "quarantined", "pending_review", "receiving", "rejected"];
    if (!ALLOWED.includes(action)) {
      return res.status(400).json({ message: `action must be one of ${ALLOWED.join(", ")}` });
    }
    if (ids.length === 0) {
      return res.status(400).json({ message: "ids array required" });
    }
    let updated = 0;
    const failed: { id: string; reason: string }[] = [];
    for (const id of ids) {
      try {
        const inv = getInvoice(id);
        if (!inv) { failed.push({ id, reason: "not found" }); continue; }
        const before = { ...inv };
        const patch: any = { status: action };
        if (action === "posted") {
          // Mark as locally-confirmed posted (no QBO API call — use single-invoice post-to-qbo for that).
          patch.posted_at = inv.posted_at || new Date().toISOString();
        }
        const after = updateInvoice(id, patch);
        appendAuditLog(id, `bulk:${action}`, before, after, req.email!);
        createInvoiceNote(id, req.email || null, `Bulk action: ${action}`);
        updated++;
      } catch (e: any) {
        failed.push({ id, reason: e?.message || "unknown error" });
      }
    }
    res.json({ updated, failed, total: ids.length });
  });

  // ---- Invoice notes (append-only log) ----
  app.get("/api/invoices/:id/notes", authMiddleware, (req, res) => {
    res.json(listInvoiceNotes(req.params.id));
  });

  app.post("/api/invoices/:id/notes", authMiddleware, (req, res) => {
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ message: "text required" });
    if (!getInvoice(req.params.id)) return res.status(404).json({ message: "Invoice not found" });
    const note = createInvoiceNote(req.params.id, req.email || null, text);
    res.json(note);
  });

  // ===== Skip Senders (Round 6) =====
  // GET   /api/skip-senders                     -> list
  // POST  /api/skip-senders                     -> add { match_type, match_value, vendor_name? }
  // DELETE /api/skip-senders/:id                -> remove
  // POST  /api/invoices/:id/skip-sender         -> add sender from this invoice + reject this invoice
  app.get("/api/skip-senders", authMiddleware, (_req, res) => {
    res.json(listSkipSenders());
  });
  app.post("/api/skip-senders", authMiddleware, (req, res) => {
    const r = addSkipSender({
      match_type: req.body?.match_type,
      match_value: req.body?.match_value,
      vendor_name: req.body?.vendor_name || null,
      added_by: req.email || null,
    });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  });
  app.delete("/api/skip-senders/:id", authMiddleware, (req, res) => {
    const ok = removeSkipSender(Number(req.params.id));
    res.json({ ok });
  });

  // Drawer action: "Skip this sender going forward".
  // Body: { match_type: 'email'|'domain', confirm: 'SKIP' }
  // Adds the invoice's vendor email/domain to skip list, rejects the current invoice.
  app.post("/api/invoices/:id/skip-sender", authMiddleware, (req, res) => {
    if (req.body?.confirm !== "SKIP") {
      return res.status(400).json({ error: "Must confirm by typing SKIP" });
    }
    const match_type = req.body?.match_type;
    if (match_type !== "email" && match_type !== "domain") {
      return res.status(400).json({ error: "match_type must be 'email' or 'domain'" });
    }
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    const sender = (inv as any).email_from || "";
    if (!sender) return res.status(400).json({ error: "This invoice has no sender email — add it from Settings instead" });

    // email_from is often "Display Name" <user@host.com> — extract the bare email.
    const bare = extractBareEmail(sender);
    if (!bare) {
      return res.status(400).json({ error: "Could not parse a valid email from this invoice's sender — add the rule manually from Settings" });
    }
    let value = bare;
    if (match_type === "domain") {
      const at = bare.indexOf("@");
      if (at < 0) return res.status(400).json({ error: "Sender is not a valid email" });
      value = bare.slice(at + 1);
    }

    // All four writes (skip rule, status update, audit log, note) happen in one
    // transaction so a partial failure can't leave the skip rule persisted with
    // the invoice still marked pending_review.
    const result = skipSenderAndRejectInvoice({
      invoiceId: req.params.id,
      matchType: match_type,
      rawSender: sender,
      matchValue: value,
      vendorName: (inv as any).vendor_qbo_name || (inv as any).vendor_raw_name || null,
      userEmail: req.email || null,
    });
    if (!result.ok) {
      return res.status(500).json({ error: result.error || "Failed to skip sender" });
    }
    res.json({
      ok: true,
      match_type,
      match_value: value,
      skip_rule_already_existed: !!result.alreadyExisted,
    });
  });

  // ===== Vendor Groups (Round 7) =====
  // Parent companies that ship invoices for multiple sub-brands. Drawer uses
  // these to disambiguate which brand to attribute the inventory to.
  app.get("/api/vendor-groups", authMiddleware, (_req, res) => {
    res.json(listVendorGroups());
  });
  app.post("/api/vendor-groups", authMiddleware, (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "name required" });
    res.json(createVendorGroup({
      name,
      parent_qbo_id: req.body?.parent_qbo_id || null,
      parent_qbo_name: req.body?.parent_qbo_name || null,
    }));
  });
  app.patch("/api/vendor-groups/:id", authMiddleware, (req, res) => {
    const updated = updateVendorGroup(Number(req.params.id), req.body || {});
    if (!updated) return res.status(404).json({ message: "Not found" });
    res.json(updated);
  });
  app.delete("/api/vendor-groups/:id", authMiddleware, (req, res) => {
    res.json(deleteVendorGroup(Number(req.params.id)));
  });
  app.post("/api/vendor-groups/:id/members", authMiddleware, (req, res) => {
    const groupId = Number(req.params.id);
    if (!getVendorGroup(groupId)) return res.status(404).json({ message: "Group not found" });
    const vendor_qbo_id = String(req.body?.vendor_qbo_id || "").trim();
    const vendor_qbo_name = String(req.body?.vendor_qbo_name || "").trim();
    if (!vendor_qbo_id || !vendor_qbo_name) return res.status(400).json({ message: "vendor_qbo_id and vendor_qbo_name required" });
    res.json(addGroupMember({
      group_id: groupId,
      vendor_qbo_id,
      vendor_qbo_name,
      brand_keywords: req.body?.brand_keywords || null,
    }));
  });
  app.patch("/api/vendor-groups/members/:memberId", authMiddleware, (req, res) => {
    const updated = updateGroupMember(Number(req.params.memberId), req.body || {});
    if (!updated) return res.status(404).json({ message: "Not found" });
    res.json(updated);
  });
  app.delete("/api/vendor-groups/members/:memberId", authMiddleware, (req, res) => {
    res.json(deleteGroupMember(Number(req.params.memberId)));
  });

  // Per-invoice: returns the matching group (if any) + scored member suggestions
  // based on the invoice's PDF text and parsed line items. Drawer calls this to
  // render the brand picker.
  app.get("/api/invoices/:id/vendor-group", authMiddleware, (req, res) => {
    const inv = getInvoice(req.params.id);
    if (!inv) return res.status(404).json({ message: "Not found" });
    // Build haystack first — used either way.
    const lineItems: any[] = (() => {
      try { return JSON.parse((inv as any).line_items_json || "[]"); } catch { return []; }
    })();
    const haystackParts = [
      inv.vendor_raw_name || "",
      inv.email_subject || "",
      (inv as any).llm_notes || "",
      ...lineItems.map((li: any) => `${li.description || ""} ${li.sku || ""} ${li.brand || ""}`),
    ];
    const haystack = haystackParts.join("\n");
    // Path 1: matched vendor IS in a group → return that group.
    const direct = findGroupForVendor(inv.vendor_qbo_id);
    if (direct) {
      const suggestions = suggestGroupMember(direct, haystack);
      return res.json({ group: direct, suggestions, source: "vendor_match" });
    }
    // Path 2: no direct match — auto-detect via PDF text scan across all groups.
    const auto = autoDetectGroup(haystack);
    if (auto) {
      return res.json({ group: auto.group, suggestions: auto.suggestions, source: "auto_detect" });
    }
    res.json({ group: null, suggestions: [], source: "none" });
  });

  // ===== Feature 4: Google OAuth Routes =====

  app.get("/api/auth/google/login", (req, res) => {
    if (!isGoogleConfigured()) {
      return res.status(503).json({ message: "Google OAuth not configured" });
    }
    const redirectUri = process.env.GOOGLE_REDIRECT_URI_PROD || process.env.GOOGLE_REDIRECT_URI_LOCAL || `http://localhost:${process.env.PORT || 5000}/api/auth/google/callback`;
    const state = generateOAuthState("sso");
    const url = getSsoAuthUrl(redirectUri, state);
    res.redirect(url);
  });

  app.get("/api/auth/google/callback", async (req, res) => {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const error = String(req.query.error || "");

    if (error) {
      return res.redirect("/login?error=google_denied");
    }
    if (!verifyOAuthState(state, "sso")) {
      return res.redirect("/login?error=invalid_state");
    }
    if (!code) {
      return res.redirect("/login?error=no_code");
    }

    try {
      const redirectUri = process.env.GOOGLE_REDIRECT_URI_PROD || process.env.GOOGLE_REDIRECT_URI_LOCAL || `http://localhost:${process.env.PORT || 5000}/api/auth/google/callback`;
      const { email } = await exchangeSsoCode(code, redirectUri);
      const normalizedEmail = email.toLowerCase();

      // Look up user in app_users
      const appUser = getAppUserByEmail(normalizedEmail);
      if (!appUser || !appUser.enabled) {
        return res.redirect("/login?error=access_denied");
      }

      // Update last_login_at
      try { updateAppUser(appUser.id, { last_login_at: new Date().toISOString() }); } catch {}

      const token = createSession(normalizedEmail);
      console.log(`[AUTH] Google SSO login success for ${normalizedEmail}`);

      // Redirect to app with token in query string so client can store it
      res.redirect(`/login?sso_token=${encodeURIComponent(token)}&email=${encodeURIComponent(normalizedEmail)}`);
    } catch (e: any) {
      console.error("[AUTH] Google SSO callback error:", e.message);
      res.redirect("/login?error=sso_failed");
    }
  });

  // Drive connect: accepts Bearer header OR ?t= query param (browser redirect can't set headers)
  app.get("/api/auth/drive/connect", (req, res) => {
    // Auth via ?t= param (browser redirect from Settings page)
    const tParam = String(req.query.t || "");
    let authed = false;
    let isAdmin = false;
    if (tParam) {
      const sess = getSession(tParam);
      if (sess) {
        try {
          const appUser = getAppUserByEmail(sess.email);
          isAdmin = (appUser?.role || 'admin') === 'admin';
        } catch { isAdmin = true; }
        authed = true;
      }
    } else {
      // Fall back to Bearer header
      const auth = req.headers.authorization;
      if (auth?.startsWith("Bearer ")) {
        const sess = getSession(auth.slice(7));
        if (sess) {
          try {
            const appUser = getAppUserByEmail(sess.email);
            isAdmin = (appUser?.role || 'admin') === 'admin';
          } catch { isAdmin = true; }
          authed = true;
        }
      }
    }
    if (!authed) return res.status(401).json({ message: "Unauthorized" });
    if (!isAdmin) return res.status(403).json({ message: "Admin access required" });
    if (!isGoogleConfigured()) {
      return res.status(503).json({ message: "Google OAuth not configured" });
    }
    const redirectUri = process.env.GOOGLE_REDIRECT_URI_PROD || process.env.GOOGLE_REDIRECT_URI_LOCAL || `http://localhost:${process.env.PORT || 5000}/api/auth/drive/callback`;
    // Replace the SSO callback with drive callback
    const driveRedirectUri = redirectUri.replace("/auth/google/callback", "/auth/drive/callback");
    const state = generateOAuthState("drive");
    const url = getDriveAuthUrl(driveRedirectUri, state);
    res.redirect(url);
  });

  app.get("/api/auth/drive/callback", async (req, res) => {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const error = String(req.query.error || "");

    if (error) {
      return res.redirect("/settings?error=drive_denied&tab=backups");
    }
    if (!verifyOAuthState(state, "drive")) {
      return res.redirect("/settings?error=invalid_state&tab=backups");
    }
    if (!code) {
      return res.redirect("/settings?error=no_code&tab=backups");
    }

    try {
      const redirectUri = process.env.GOOGLE_REDIRECT_URI_PROD || process.env.GOOGLE_REDIRECT_URI_LOCAL || `http://localhost:${process.env.PORT || 5000}/api/auth/drive/callback`;
      const driveRedirectUri = redirectUri.replace("/auth/google/callback", "/auth/drive/callback");
      const tokens = await exchangeCodeForTokens(code, driveRedirectUri);

      // Get the email of the Drive account for display purposes
      let grantedEmail: string | undefined;
      try {
        const { google } = await import("googleapis");
        const oauth2 = (await import("./google-oauth")).getOAuth2Client(driveRedirectUri);
        oauth2.setCredentials(tokens as any);
        const people = google.oauth2({ version: "v2", auth: oauth2 });
        const info = await people.userinfo.get();
        grantedEmail = info.data.email || undefined;
      } catch {}

      setDriveTokens(tokens, grantedEmail);
      console.log(`[AUTH] Drive connected for ${grantedEmail || "unknown"}`);
      res.redirect("/settings?drive_connected=1&tab=backups");
    } catch (e: any) {
      console.error("[AUTH] Drive callback error:", e.message);
      res.redirect("/settings?error=drive_failed&tab=backups");
    }
  });

  app.post("/api/auth/drive/disconnect", adminMiddleware, (req, res) => {
    clearDriveTokens();
    res.json({ ok: true });
  });

  app.get("/api/auth/drive/status", authMiddleware, (req, res) => {
    const status = getDriveStatus();
    res.json({ ...status, configured: isGoogleConfigured() });
  });

  // ===== v8: In-app log viewer (admin only) =====
  // Reads the tail of <cwd>/logs/app.log produced by app-logger.ts. The
  // Settings → Logs tab uses this with auto-refresh so Jake can debug a
  // failing upload or a Gmail poll glitch without RDPing into the box.
  app.get("/api/admin/logs", adminMiddleware, async (req, res) => {
    const linesParam = parseInt((req.query.lines as string) || "200", 10);
    const maxLines = isNaN(linesParam) ? 200 : Math.max(10, Math.min(2000, linesParam));
    try {
      const { tailAppLog } = await import("./app-logger");
      const result = tailAppLog(maxLines);
      res.json({
        path: result.path,
        size: result.size,
        lines: result.lines,
        line_count: result.lines.length,
        max_lines: maxLines,
        fetched_at: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "failed to read log" });
    }
  });

  // ===== Feature 5: Users Routes (admin only) =====

  app.get("/api/users", adminMiddleware, (req, res) => {
    const users = listAppUsers();
    // Don't expose password hashes to clients
    res.json(users.map(u => ({ ...u, password_hash: undefined, password_salt: undefined })));
  });

  app.post("/api/users", adminMiddleware, (req, res) => {
    const { email, name, role, enabled } = req.body || {};
    if (!email) return res.status(400).json({ message: "email required" });
    if (role && !['admin', 'user'].includes(role)) return res.status(400).json({ message: "role must be admin or user" });
    try {
      const user = createAppUser({
        email: String(email).trim().toLowerCase(),
        name: name || null,
        role: role || 'user',
        enabled: enabled !== undefined ? (enabled ? 1 : 0) : 1,
      });
      res.json({ ...user, password_hash: undefined, password_salt: undefined });
    } catch (e: any) {
      if (/UNIQUE/i.test(e.message)) return res.status(400).json({ message: "Email already exists" });
      res.status(500).json({ message: e.message });
    }
  });

  app.patch("/api/users/:id", adminMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const { name, role, enabled } = req.body || {};
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (role !== undefined) {
      if (!['admin', 'user'].includes(role)) return res.status(400).json({ message: "role must be admin or user" });
      updates.role = role;
    }
    if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
    const user = updateAppUser(id, updates);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ ...user, password_hash: undefined, password_salt: undefined });
  });

  app.post("/api/users/:id/password", adminMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    const { password } = req.body || {};
    if (!password || password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
    const user = getAppUserById(id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 32);
    setAppUserPassword(id, salt.toString("hex"), hash.toString("hex"));
    res.json({ ok: true });
  });

  app.delete("/api/users/:id", adminMiddleware, (req, res) => {
    const id = parseInt(req.params.id);
    // Block deleting self
    const reqUser = req.email ? getAppUserByEmail(req.email) : null;
    if (reqUser && reqUser.id === id) return res.status(400).json({ message: "Cannot delete yourself" });
    const ok = deleteAppUser(id);
    if (!ok) return res.status(404).json({ message: "User not found" });
    res.json({ ok: true });
  });

  // ===== Feature 2: Backup Routes =====

  app.get("/api/backups/status", authMiddleware, (_req, res) => {
    res.json(getBackupStatus());
  });

  app.post("/api/backups/run", adminMiddleware, async (req, res) => {
    const kind = String(req.body?.kind || "");
    if (!kind) return res.status(400).json({ message: "kind required" });
    try {
      if (kind === "local_hourly") {
        await runLocalBackupWithTracking();
      } else if (kind === "drive_daily_db") {
        await runDriveDailyBackup();
      } else if (kind === "drive_weekly_full") {
        await runDriveWeeklyFullBackup();
      } else {
        return res.status(400).json({ message: `Unknown backup kind: ${kind}` });
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/backups/list", authMiddleware, async (_req, res) => {
    const localBackups = listLocalBackups();
    const driveStatus = getDriveStatus();
    res.json({ local: localBackups, drive_connected: driveStatus.connected });
  });

  // Download backup: supports ?t= query param for browser link clicks
  app.get("/api/backups/download/:filename", (req, res) => {
    // Auth via Bearer header or ?t= param
    const tParam = String(req.query.t || "");
    const auth = req.headers.authorization;
    let isAdmin = false;
    const tokenToCheck = tParam || (auth?.startsWith("Bearer ") ? auth.slice(7) : "");
    if (tokenToCheck) {
      const sess = getSession(tokenToCheck);
      if (sess) {
        try {
          const appUser = getAppUserByEmail(sess.email);
          isAdmin = (appUser?.role || 'admin') === 'admin';
        } catch { isAdmin = true; }
      }
    }
    if (!isAdmin) return res.status(403).json({ message: "Admin access required" });
    const filename = path.basename(req.params.filename); // sanitize
    if (!filename.endsWith(".db.gz")) {
      return res.status(400).json({ message: "Invalid file type" });
    }
    const filePath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File not found" });
    }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  // ===== Feature 3: Archive Routes =====

  app.get("/api/archive/status", authMiddleware, (_req, res) => {
    res.json(getArchiveStatus());
  });

  app.post("/api/archive/run", adminMiddleware, async (_req, res) => {
    try {
      const result = await runPdfArchive();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  return httpServer;
}

// Helper to extract auth token from request (for OAuth redirects)
function getAuthToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

// Short-lived in-memory state store for OAuth
const pendingOAuthStates = new Map<string, number>();
// Cleanup expired states every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of pendingOAuthStates) {
    if (exp < now) pendingOAuthStates.delete(k);
  }
}, 5 * 60 * 1000);
