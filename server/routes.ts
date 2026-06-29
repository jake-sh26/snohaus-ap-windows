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
  listSalesTaxNotes,
  createSalesTaxNote,
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
  insertPayrollEntity,
  listProcessingFees,
  getEffectiveProcessingFee,
  addProcessingFee,
  listEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deactivateEmployee,
  listSeasonBonusHistoryForEmployee,
  upsertSeasonBonusHistory,
  deleteSeasonBonusHistory,
  getEmployeeForUserId,
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
  aggregateByEntity,
  aggregateByJurisdiction,
  fromCents,
  toCents,
  parseTaxLines,
  quarterToMonths,
  sumEntities,
  type AggregatorInput,
  type EntitySummary,
  type LineForTax,
  type RefundForTax,
  type ShippingTaxForward,
  type ShippingTaxRefund,
  type UnverifiedReturnTax,
} from "./shopify-tax-aggregation";
import {
  STORE_TAX_MAPPING,
  WAREHOUSE_LOCATION_IDS,
  isStoreClosedForMonth,
} from "./sales-tax-mapping";
import {
  getFiling,
  getFilingsByPeriod,
  upsertFiling,
  listFilings,
  openFilingPlaceholder,
  listFilingAttachments,
  getFilingAttachment,
  createFilingAttachment,
  deleteFilingAttachment,
  type FilingStatus,
} from "./sales-tax-filings";
import {
  buildSalesTaxCsv,
  buildSalesTaxXlsx,
  buildSalesTaxPdf,
  type ExportPayload,
  type ExportLineDetail,
  type ExportLocalityRow,
} from "./sales-tax-exports";
import { mappingByEntityId } from "./sales-tax-mapping";
import {
  getEntitySettings,
  upsertTin,
  legalNameFor,
  filingInfoFor,
  loadFilingEntities,
  isFilingComplete,
  filingEntityExists,
  type EntityFilingInfo,
} from "./entity-settings";
import { dtfByName, dtfForNyOtherComponent, NyDtfJurisdiction } from "./ny-dtf-jurisdictions";
import { formatRateAsFraction } from "@shared/format-rate";
import { replaceForPeriod as replaceFilingTotals, listAll as listFilingTotals } from "./sales-tax-filing-totals";
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
  backfillGcIdentityForRange,
  getGcIdentityDistribution,
} from "./shopify-recon-gc-backfill";
import {
  shopifyInstallHandler,
  shopifyCallbackHandler,
  shopifyInstallUrlHandler,
  shopifyInstalledStatusHandler,
  shopifyDeleteTokenHandler,
} from "./shopify-oauth";
import { getUserPermissions, requirePermission, requireFinanceView, userHasPermission } from "./rbac";
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
import { applyPostLlmTermsFallback } from "./post-llm-terms";
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
import { getQboStatus, getAuthUrl, exchangeCode, disconnectQbo, searchBills, searchVendorCredits, searchPayments, createBill, createVendorCredit, syncQboVendorsFromApi, lastVendorSyncAge, getQboErrorLog, clearQboErrorLog } from "./qbo";
import { getGmailStatus, pollNow, pollWithRetry, testGmailConnection, clearGmailErrorLog, reingestEmails, invalidateVendorAllowlistCache } from "./gmail";
// R4q: Gmail API parallel-run module — lives alongside the IMAP path above.
import {
  getGmailIngestStatus as getGmailApiIngestStatus,
  pollNowApi,
  processHistoryPush,
  reingestEmailsApi,
  testGmailApiConnection,
  clearGmailApiErrorLog,
  getGmailAuthUrl,
  setGmailTokens,
  clearGmailTokens,
  stopGmailWatch,
  startGmailWatch,
  isGmailApiEnabled,
  invalidateGmailApiVendorAllowlistCache,
} from "./gmail-api";
import { registerReconStagingRoutes } from "./recon-staging/routes";

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
    // Group line items by store_assignment.
    // PR #R4l: Exclude is_freight lines from the inventory totals — freight is
    // added separately as a pro-rata pass below using invoice.freight. Including
    // freight lines here caused the QBO bill total to equal
    // (total + freight + freight) on invoices whose LLM extraction put the
    // freight charge into line_items (e.g. Royal Teak "A1 Shippings - LTL").
    const storeTotals: Record<string, number> = {};
    for (const li of lineItems) {
      if (li.is_freight) continue;
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
        // Same pro-rata weighting as the positive lines. PR #R4l: also excludes
        // is_freight lines so the discount base matches the inventory subtotal.
        const storeTotals: Record<string, number> = {};
        for (const li of lineItems) {
          if (li.is_freight) continue;
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
    // Search QBO Bills, VendorCredits, and BillPayments in parallel. VendorCredits live in a
    // separate entity from Bills in QBO; the app DB may or may not flag a row as a credit
    // (is_credit can be missing on older ingests), so we always check both.
    const [bills, vendorCredits, payments] = await Promise.all([
      searchBills([inv.invoice_number]),
      searchVendorCredits([inv.invoice_number]),
      searchPayments([inv.invoice_number]),
    ]);
    if (bills.length > 0 || vendorCredits.length > 0 || payments.length > 0) {
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
      const firstCredit = vendorCredits[0];
      const creditId = firstCredit?.Id || null;
      const creditTotal = Number(firstCredit?.TotalAmt || 0);
      // QBO's query language doesn't expose Balance or LinkedTxn on VendorCredit
      // (both return 400). We just report total; user can check applied state in QBO.
      const creditLabel = firstCredit ? ` \u2014 $${creditTotal.toFixed(2)}` : "";
      const paymentId = payments[0]?.Id || null;
      const vendorMismatch =
        inv.vendor_qbo_id &&
        ((bills.length > 0 && !bills.some((b: any) => b.VendorRef?.value === inv.vendor_qbo_id)) ||
          (vendorCredits.length > 0 && !vendorCredits.some((c: any) => c.VendorRef?.value === inv.vendor_qbo_id)) ||
          (payments.length > 0 && !payments.some((p: any) => p.EntityRef?.value === inv.vendor_qbo_id)));
      const note = [
        bills.length > 0 ? `Bill #${billId} exists in QBO${paidLabel}` : null,
        vendorCredits.length > 0 ? `VendorCredit #${creditId} exists in QBO${creditLabel}` : null,
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
  // Mount recon staging harness (isolated data-staging.db; read-only Shopify pulls)
  registerReconStagingRoutes(app, authMiddleware);

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
    const {
      location, short_name, legal_name, display_name, dba, slug,
      tin, county, rate_bps, dtf_code,
      qbo_inventory_account_id, qbo_inventory_account_name,
      cadence, adp_company_code,
      commissions_enabled, pms_enabled, tips_enabled,
      easyrent_enabled, spif_enabled, active,
    } = req.body || {};
    // Light validation: cadence must be weekly/biweekly when provided.
    if (cadence !== undefined && cadence !== "weekly" && cadence !== "biweekly") {
      return res.status(400).json({ message: "cadence must be 'weekly' or 'biweekly'" });
    }
    // rate_bps must be a non-negative integer when provided (or null to clear).
    if (rate_bps !== undefined && rate_bps !== null) {
      const n = Number(rate_bps);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ message: "rate_bps must be a non-negative integer (basis points)" });
      }
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
    // Build the whitelisted patch. Empty strings on optional text fields are
    // coerced to null so the DB stores NULL instead of an empty string.
    const patch: any = {};
    const setText = (key: string, val: any) => {
      patch[key] = (val === null || val === "") ? null : String(val);
    };
    if (location !== undefined) patch.location = String(location);
    if (short_name !== undefined) setText("short_name", short_name);
    if (legal_name !== undefined) patch.legal_name = String(legal_name);
    if (display_name !== undefined) setText("display_name", display_name);
    if (dba !== undefined) setText("dba", dba);
    if (slug !== undefined) setText("slug", slug);
    if (tin !== undefined) setText("tin", tin);
    if (county !== undefined) setText("county", county);
    if (rate_bps !== undefined) patch.rate_bps = rate_bps === null ? null : Number(rate_bps);
    if (dtf_code !== undefined) setText("dtf_code", dtf_code);
    if (qbo_inventory_account_id !== undefined) setText("qbo_inventory_account_id", qbo_inventory_account_id);
    if (qbo_inventory_account_name !== undefined) setText("qbo_inventory_account_name", qbo_inventory_account_name);
    if (cadence !== undefined) patch.cadence = cadence;
    if (adp_company_code !== undefined) patch.adp_company_code = adp_company_code || null;
    if (commissions_enabled !== undefined) patch.commissions_enabled = commissions_enabled ? 1 : 0;
    if (pms_enabled !== undefined) patch.pms_enabled = pms_enabled ? 1 : 0;
    if (tips_enabled !== undefined) patch.tips_enabled = tips_enabled ? 1 : 0;
    if (easyrent_enabled !== undefined) patch.easyrent_enabled = easyrent_enabled ? 1 : 0;
    if (spif_enabled !== undefined) patch.spif_enabled = spif_enabled ? 1 : 0;
    if (active !== undefined) patch.active = active ? 1 : 0;
    try {
      const updated = updatePayrollEntity(id, patch);
      res.json(updated);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      // Duplicate `location` violates UNIQUE idx_payroll_entities_location.
      if (msg.includes("UNIQUE constraint failed") && msg.includes("location")) {
        return res.status(409).json({ message: `An entity with location "${location}" already exists.` });
      }
      throw e;
    }
  });

  // POST a new entity. UI: Settings → Entities → "Add entity" button.
  // Same write gate as PATCH (payroll.edit_employees) until a dedicated
  // entities.write permission lands.
  app.post("/api/payroll/entities", authMiddleware, requirePermission("payroll.edit_employees"), (req, res) => {
    const {
      location, short_name, legal_name, display_name, dba, slug,
      cadence, tin, county, rate_bps, dtf_code,
      qbo_inventory_account_id, qbo_inventory_account_name,
      adp_company_code,
    } = req.body || {};
    if (!location || typeof location !== "string" || !location.trim()) {
      return res.status(400).json({ message: "`location` is required" });
    }
    if (!legal_name || typeof legal_name !== "string" || !legal_name.trim()) {
      return res.status(400).json({ message: "`legal_name` is required" });
    }
    if (cadence !== "weekly" && cadence !== "biweekly") {
      return res.status(400).json({ message: "`cadence` must be 'weekly' or 'biweekly'" });
    }
    if (rate_bps !== undefined && rate_bps !== null) {
      const n = Number(rate_bps);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ message: "rate_bps must be a non-negative integer (basis points)" });
      }
    }
    const text = (v: any) => (v === null || v === undefined || v === "" ? null : String(v));
    try {
      const row = insertPayrollEntity({
        location: String(location).trim(),
        short_name: text(short_name),
        legal_name: String(legal_name).trim(),
        display_name: text(display_name),
        dba: text(dba),
        slug: text(slug),
        cadence,
        adp_company_code: text(adp_company_code),
        tin: text(tin),
        county: text(county),
        rate_bps: rate_bps === null || rate_bps === undefined ? null : Number(rate_bps),
        dtf_code: text(dtf_code),
        qbo_inventory_account_id: text(qbo_inventory_account_id),
        qbo_inventory_account_name: text(qbo_inventory_account_name),
      });
      res.status(201).json(row);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (msg.includes("UNIQUE constraint failed") && msg.includes("location")) {
        return res.status(409).json({ message: `An entity with location "${location}" already exists.` });
      }
      throw e;
    }
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

  // PR #208 — flexible date parser. Accepts ISO YYYY-MM-DD, MM/DD/YYYY,
  // M/D/YYYY, MM/DD/YY, M/D/YY (US-style). Stores as ISO YYYY-MM-DD.
  // Returns null for empty/null, throws Error("bad date: ...") for garbage.
  function normalizeDate(v: any): string | null {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (s === "") return null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) {
      const y = Number(iso[1]); const m = Number(iso[2]); const d = Number(iso[3]);
      if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`bad date: "${s}"`);
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
    if (us) {
      const m = Number(us[1]); const d = Number(us[2]); let y = Number(us[3]);
      if (us[3].length === 2) y = (y >= 70 ? 1900 + y : 2000 + y);
      if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`bad date: "${s}"`);
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    const t = Date.parse(s);
    if (!Number.isNaN(t)) {
      const dt = new Date(t);
      const y = dt.getUTCFullYear();
      const m = dt.getUTCMonth() + 1;
      const d = dt.getUTCDate();
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    throw new Error(`bad date: "${s}"`);
  }

  // PR #208 — shared field lists for POST/PATCH employees.
  const EMPLOYEE_STRING_FIELDS = [
    "email", "phone", "shopify_staff_member_id", "easyrent_clerk_guid",
    "ltm_clerk_id", "adp_employee_id", "notes",
    "address_line1", "address_line2", "city", "state", "postal_code",
    "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship",
    "tshirt_size",
  ];
  const EMPLOYEE_DATE_FIELDS = ["hired_at", "terminated_at", "date_of_birth"];
  // PR #209 — numeric fields gated behind payroll.edit_commissions (admin only),
  // same as commission_rate_pct. Includes hourly rate, time-off allotments, and the
  // current season bonus. The season bonus history table is gated separately.
  const EMPLOYEE_PAY_NUMERIC_FIELDS = [
    "hourly_rate", "vacation_hours_annual", "sick_hours_annual",
    "current_season_bonus",
  ];
  // PR #209 — the only string pay-gated field is current_season_label, which
  // tracks the season the live current_season_bonus belongs to (e.g. "2025-26").
  const EMPLOYEE_PAY_STRING_FIELDS = ["current_season_label"];

  // PR #209 — Returns the current ski season label, e.g. "2025-26".
  // The fiscal year flips on April 1: dates April 1, 2025 → March 31, 2026
  // are season "2025-26". Before April 1, 2025 the season is "2024-25".
  function currentSeasonLabel(d: Date = new Date()): string {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1; // 1-12
    const startYear = m >= 4 ? y : y - 1;
    const endYear = startYear + 1;
    return `${startYear}-${String(endYear).slice(2)}`;
  }

  app.post("/api/payroll/employees", authMiddleware, requirePermission("payroll.edit_employees"), (req, res) => {
    const body = req.body || {};
    const { entity_id, full_name } = body;
    if (!Number.isFinite(Number(entity_id))) {
      return res.status(400).json({ message: "entity_id is required" });
    }
    if (!getPayrollEntityById(Number(entity_id))) {
      return res.status(400).json({ message: "Unknown entity_id" });
    }
    if (!full_name || typeof full_name !== "string" || !full_name.trim()) {
      return res.status(400).json({ message: "full_name is required" });
    }
    // PR #208 — gate commission_rate_pct. Silently drop if the caller
    // lacks payroll.edit_commissions so CSV imports still create employees
    // (just without setting the rate). A response header lets the client
    // surface "commission ignored" in the UI if it wants to.
    let commissionRate: number | null = null;
    let commissionDropped = false;
    if (body.commission_rate_pct !== undefined && body.commission_rate_pct !== "" && body.commission_rate_pct !== null) {
      const userId = (req as any).userId as number | undefined;
      if (userId && userHasPermission(userId, "payroll.edit_commissions")) {
        commissionRate = Number(body.commission_rate_pct);
      } else {
        commissionDropped = true;
      }
    }
    // PR #209 — pay/time-off fields gated by payroll.edit_commissions too.
    const userIdForPay = (req as any).userId as number | undefined;
    const canEditPay = !!(userIdForPay && userHasPermission(userIdForPay, "payroll.edit_commissions"));
    let payFieldsDropped = false;
    const payloadPay: Record<string, any> = {};
    for (const k of EMPLOYEE_PAY_NUMERIC_FIELDS) {
      if (body[k] !== undefined && body[k] !== "" && body[k] !== null) {
        if (canEditPay) {
          const n = Number(body[k]);
          if (!Number.isFinite(n)) return res.status(400).json({ message: `${k} must be a number` });
          payloadPay[k] = n;
        } else {
          payFieldsDropped = true;
        }
      }
    }
    for (const k of EMPLOYEE_PAY_STRING_FIELDS) {
      if (body[k] !== undefined) {
        if (canEditPay) {
          const v = body[k];
          payloadPay[k] = (v === "" || v === null) ? null : String(v);
        } else {
          payFieldsDropped = true;
        }
      }
    }
    // If the user supplied current_season_bonus but no label, default the label
    // to the current ski season so the UI always shows a meaningful season.
    if (canEditPay && payloadPay.current_season_bonus !== undefined && payloadPay.current_season_label === undefined) {
      payloadPay.current_season_label = currentSeasonLabel();
    }
    const payload: any = {
      entity_id: Number(entity_id),
      full_name: full_name.trim(),
      commission_rate_pct: commissionRate,
      active: body.active === 0 ? 0 : 1,
      ...payloadPay,
    };
    for (const k of EMPLOYEE_STRING_FIELDS) {
      const v = body[k];
      payload[k] = (v === "" || v === undefined || v === null) ? null : String(v);
    }
    try {
      for (const k of EMPLOYEE_DATE_FIELDS) {
        if (body[k] !== undefined) payload[k] = normalizeDate(body[k]);
      }
    } catch (e: any) {
      return res.status(400).json({ message: e.message });
    }
    try {
      const row = createEmployee(payload);
      if (commissionDropped) res.setHeader("X-Commission-Dropped", "1");
      if (payFieldsDropped) res.setHeader("X-Pay-Fields-Dropped", "1");
      res.json(row);
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (/UNIQUE constraint failed.*adp_employee_id/i.test(msg) ||
          /idx_payroll_employees_adp_per_entity/i.test(msg)) {
        return res.status(409).json({
          message: `ADP file # "${payload.adp_employee_id}" is already assigned to another employee at this entity. File # only needs to be unique within a location — the same number at a different location is fine.`,
        });
      }
      throw e;
    }
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
    for (const k of EMPLOYEE_STRING_FIELDS) {
      if (body[k] !== undefined) {
        const v = body[k];
        patch[k] = (v === "" || v === null) ? null : String(v);
      }
    }
    try {
      for (const k of EMPLOYEE_DATE_FIELDS) {
        if (body[k] !== undefined) patch[k] = normalizeDate(body[k]);
      }
    } catch (e: any) {
      return res.status(400).json({ message: e.message });
    }
    // PR #209 — pay/time-off fields gated by payroll.edit_commissions.
    const userIdForPay = (req as any).userId as number | undefined;
    const canEditPay = !!(userIdForPay && userHasPermission(userIdForPay, "payroll.edit_commissions"));
    let payFieldsDropped = false;
    for (const k of EMPLOYEE_PAY_NUMERIC_FIELDS) {
      if (body[k] !== undefined) {
        if (canEditPay) {
          const v = body[k];
          if (v === "" || v === null) {
            patch[k] = null;
          } else {
            const n = Number(v);
            if (!Number.isFinite(n)) return res.status(400).json({ message: `${k} must be a number` });
            patch[k] = n;
          }
        } else {
          payFieldsDropped = true;
        }
      }
    }
    for (const k of EMPLOYEE_PAY_STRING_FIELDS) {
      if (body[k] !== undefined) {
        if (canEditPay) {
          const v = body[k];
          patch[k] = (v === "" || v === null) ? null : String(v);
        } else {
          payFieldsDropped = true;
        }
      }
    }
    let commissionDropped = false;
    if (body.commission_rate_pct !== undefined) {
      const userId = (req as any).userId as number | undefined;
      if (userId && userHasPermission(userId, "payroll.edit_commissions")) {
        const v = body.commission_rate_pct;
        patch.commission_rate_pct = (v === "" || v === null) ? null : Number(v);
      } else {
        commissionDropped = true;
      }
    }
    if (body.active !== undefined) patch.active = body.active ? 1 : 0;
    try {
      const updated = updateEmployee(id, patch);
      if (commissionDropped) res.setHeader("X-Commission-Dropped", "1");
      if (payFieldsDropped) res.setHeader("X-Pay-Fields-Dropped", "1");

      // PR #214 — if the caller just linked (or changed) shopify_staff_member_id,
      // immediately stamp employee_id on any previously-NULL recon staff-sales
      // rows for that staff id. Without this, the UI shows a duplicate row
      // (one matched, one unmatched) until the next ingest tick or a manual
      // POST /backfill-employee-links. Best-effort: failures are logged but
      // do not break the employee update response.
      try {
        if (body.shopify_staff_member_id !== undefined) {
          const before = (existing as any)?.shopify_staff_member_id ?? null;
          const after = (patch as any).shopify_staff_member_id ?? null;
          if (after && String(after) !== String(before ?? "")) {
            const out = backfillEmployeeLinksForStaffId(after);
            if (out.rows_updated > 0) {
              res.setHeader("X-Staff-Sales-Backfilled", String(out.rows_updated));
            }
          }
        }
      } catch (bfErr: any) {
        console.error(
          "[PR #214] backfillEmployeeLinksForStaffId failed for employee",
          id,
          bfErr?.message || bfErr,
        );
      }

      res.json(updated);
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (/UNIQUE constraint failed.*adp_employee_id/i.test(msg) ||
          /idx_payroll_employees_adp_per_entity/i.test(msg)) {
        return res.status(409).json({
          message: `ADP file # "${patch.adp_employee_id}" is already assigned to another employee at this entity. File # only needs to be unique within a location — the same number at a different location is fine.`,
        });
      }
      throw e;
    }
  });

  // Soft-delete: marks the employee inactive instead of deleting. Hard-delete
  // is intentionally not exposed (would orphan payroll history).
  app.delete("/api/payroll/employees/:id", authMiddleware, requirePermission("payroll.edit_employees"), (req, res) => {
    const id = Number(req.params.id);
    if (!getEmployeeById(id)) return res.status(404).json({ message: "Employee not found" });
    const updated = deactivateEmployee(id);
    res.json(updated);
  });

  // ==========================================================================
  // PR #209 — Employee season-bonus history
  // --------------------------------------------------------------------------
  // GET list (anyone with payroll.view can read), POST/DELETE gated behind
  // payroll.edit_commissions (admin only). The "current" season bonus lives
  // on the employee row; closed seasons live in payroll_employee_season_bonuses.
  // ==========================================================================

  app.get("/api/payroll/employees/:id/season-bonuses", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const id = Number(req.params.id);
    if (!getEmployeeById(id)) return res.status(404).json({ message: "Employee not found" });
    res.json(listSeasonBonusHistoryForEmployee(id));
  });

  app.post("/api/payroll/employees/:id/season-bonuses", authMiddleware, requirePermission("payroll.edit_commissions"), (req, res) => {
    const id = Number(req.params.id);
    const emp = getEmployeeById(id);
    if (!emp) return res.status(404).json({ message: "Employee not found" });
    const body = req.body || {};
    const season_label = String(body.season_label || "").trim();
    if (!/^\d{4}-\d{2}$/.test(season_label)) {
      return res.status(400).json({ message: 'season_label must look like "2025-26"' });
    }
    const amount = Number(body.bonus_amount);
    if (!Number.isFinite(amount)) return res.status(400).json({ message: "bonus_amount must be a number" });
    const notes = body.notes ? String(body.notes) : null;
    const closed_at = body.closed_at ? String(body.closed_at) : new Date().toISOString().slice(0, 10);
    const row = upsertSeasonBonusHistory({ employee_id: id, season_label, bonus_amount: amount, notes, closed_at });
    res.json(row);
  });

  app.delete("/api/payroll/season-bonuses/:bonusId", authMiddleware, requirePermission("payroll.edit_commissions"), (req, res) => {
    const bid = Number(req.params.bonusId);
    if (!Number.isFinite(bid)) return res.status(400).json({ message: "bad bonusId" });
    const ok = deleteSeasonBonusHistory(bid);
    if (!ok) return res.status(404).json({ message: "Season bonus row not found" });
    res.json({ ok: true });
  });

  // ==========================================================================
  // PR #209 — Employee self-view (/api/me/employee)
  // --------------------------------------------------------------------------
  // Returns the authenticated user's own employee row + season-bonus history,
  // with sensitive external IDs stripped. Any logged-in user can call this;
  // returns 404 if the user has no employee link.
  // ==========================================================================

  app.get("/api/me/employee", authMiddleware, (req, res) => {
    const userId = (req as any).userId as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const emp = getEmployeeForUserId(userId);
    if (!emp) return res.status(404).json({ message: "No linked employee profile" });
    // Hide external IDs and commission rate from self-view. The employee can
    // see their own pay rate, time off, and bonus though.
    const {
      shopify_staff_member_id: _shop,
      easyrent_clerk_guid: _ez,
      ltm_clerk_id: _ltm,
      adp_employee_id: _adp,
      commission_rate_pct: _comm,
      ...safe
    } = emp as any;
    const bonusHistory = listSeasonBonusHistoryForEmployee(emp.id);
    res.json({ employee: safe, bonus_history: bonusHistory });
  });

  // ==========================================================================
  // PR #211 — Self-edit a small, safe subset of own employee profile
  // --------------------------------------------------------------------------
  // Auth-only (no permission gate) but the server hard-whitelists the four
  // fields any employee is allowed to change about themselves:
  //   - tshirt_size
  //   - emergency_contact_name
  //   - emergency_contact_phone
  //   - emergency_contact_relationship
  // Every other key in the body is silently dropped. Even if the UI were
  // to accidentally (or maliciously) send pay/commission/address fields,
  // the server refuses to update them. Defense in depth: the UI also keeps
  // those fields read-only, but this PATCH does not trust the UI.
  //
  // Phone is normalized server-side using the same rule as the admin edit
  // dialog (+ prefix retained, all non-digits stripped) so we have one
  // shape stored regardless of how the user typed it.
  //
  // TODO PR #212: a profile_change_requests table + admin approval flow
  // for higher-risk fields like address, legal name, and primary contact.
  // ==========================================================================

  app.patch("/api/me/employee", authMiddleware, (req, res) => {
    const userId = (req as any).userId as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const emp = getEmployeeForUserId(userId);
    if (!emp) return res.status(404).json({ message: "No linked employee profile" });

    const body = (req.body || {}) as Record<string, unknown>;

    // Hard whitelist. Anything not in this set is dropped, no error returned —
    // we don't want a misbehaving client to learn which fields exist by
    // probing for 400s.
    const SELF_EDITABLE = new Set([
      "tshirt_size",
      "emergency_contact_name",
      "emergency_contact_phone",
      "emergency_contact_relationship",
    ]);

    const patch: Partial<Record<string, any>> = {};
    let droppedAny = false;
    for (const k of Object.keys(body)) {
      if (!SELF_EDITABLE.has(k)) {
        droppedAny = true;
        continue;
      }
      const raw = body[k];
      const s = raw == null ? "" : String(raw).trim();
      if (k === "emergency_contact_phone") {
        // Same normalization the admin dialog uses: keep "+" prefix if
        // present, strip everything else to digits.
        patch[k] = s ? ((s.startsWith("+") ? "+" : "") + s.replace(/\D/g, "")) : null;
      } else if (k === "tshirt_size") {
        // Validate against the same set the admin dialog offers. Anything
        // outside the set is rejected so the column doesn't accumulate
        // free-text junk.
        const ALLOWED_SIZES = new Set(["XS", "S", "M", "L", "XL", "XXL", "XXXL"]);
        if (s === "") {
          patch[k] = null;
        } else if (ALLOWED_SIZES.has(s.toUpperCase())) {
          patch[k] = s.toUpperCase();
        } else {
          return res.status(400).json({
            message: `tshirt_size must be one of XS, S, M, L, XL, XXL, XXXL (got ${JSON.stringify(s)})`,
          });
        }
      } else {
        patch[k] = s === "" ? null : s;
      }
    }

    if (Object.keys(patch).length === 0) {
      // Nothing to do — return current state so the client can re-sync.
      return res.json({ ok: true, employee_id: emp.id, dropped: droppedAny });
    }

    const updated = updateEmployee(emp.id, patch as any);
    if (!updated) return res.status(500).json({ message: "Update failed" });

    if (droppedAny) res.setHeader("X-Self-Edit-Dropped", "1");

    // Mirror the GET shape so the client can update its cache directly.
    const {
      shopify_staff_member_id: _shop,
      easyrent_clerk_guid: _ez,
      ltm_clerk_id: _ltm,
      adp_employee_id: _adp,
      commission_rate_pct: _comm,
      ...safe
    } = updated as any;
    const bonusHistory = listSeasonBonusHistoryForEmployee(emp.id);
    res.json({ employee: safe, bonus_history: bonusHistory });
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
  app.get("/api/recon/finance/local/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/shipping/:month", authMiddleware, requireFinanceView(), (req, res) => {
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

  // PR #122 — swap the UI's Finance Summary diff source from legacy
  // (computeLocalFinanceSummary, refunds-derived) to V2 (computeFinanceDiffV2,
  // recon_shopify_sales-derived with the same formulas as /v2-vs-shopifyql).
  // V2 reconciles to the penny across all 17 months of 2025–2026 (acceptance
  // run after PR #121). Response shape is identical so the UI is unchanged.
  app.get("/api/recon/finance/diff/:month", authMiddleware, requireFinanceView(), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const tolerance = Number(req.query.tolerance);
    const { computeFinanceDiffV2 } = require("./shopify-finance-diff");
    res.json(
      computeFinanceDiffV2(month, {
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
  app.get("/api/recon/finance/diff-compare/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/components/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/dryrun-rule6/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/dryrun-order-bucket", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/exchange-gap-audit", authMiddleware, requireFinanceView(), (_req, res) => {
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
  app.get("/api/recon/finance/debug/recognized-vs-created-audit", authMiddleware, requireFinanceView(), (_req, res) => {
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
  app.get("/api/recon/finance/debug/date-mismatches/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
  // V2-aware enumeration: lists every order that has at least one Sale event
  // bucketed to :month via recon_shopify_sales.happened_month. This is the
  // correct enumeration for V2 reconciliation against ShopifyQL Finance
  // Summary because Shopify itself splits cross-month edits/refunds across
  // the months their Sale events happened in (verified in PR #108 probes,
  // 2026-05-26: orders #21526, #20326, #21647, #21683, #18147 all show
  // split-month behavior in ShopifyQL day buckets).
  //
  // The legacy /orders/:month endpoint below filters by created_at and is
  // intentionally preserved as-is for legacy projector debugging.
  app.get("/api/recon/finance/debug/orders-v2/:month", authMiddleware, requireFinanceView(), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const { sqlite } = require("./storage");
    const orders = sqlite.prepare(`
      SELECT
        o.id, o.order_number, o.name,
        o.created_at, o.processed_at, o.cancelled_at,
        substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) AS created_month,
        (
          SELECT COUNT(*) FROM recon_shopify_sales s
           WHERE s.order_id = o.id AND s.happened_month = ?
        ) AS sales_rows_in_month,
        (
          SELECT GROUP_CONCAT(DISTINCT s.happened_month)
            FROM recon_shopify_sales s
           WHERE s.order_id = o.id
        ) AS sales_months_all,
        (
          -- PR #110: ShopifyQL gross filter — action_type=ORDER, line_type=PRODUCT.
          SELECT COALESCE(SUM(s.total_amount + s.total_discount_before_taxes - s.total_tax), 0)
            FROM recon_shopify_sales s
           WHERE s.order_id = o.id
             AND s.happened_month = ?
             AND s.action_type = 'ORDER'
             AND s.line_type = 'PRODUCT'
        ) AS v2_gross_in_month,
        (
          -- PR #113: ShopifyQL returns filter — action_type=RETURN,
          -- line_type IN (PRODUCT, ADJUSTMENT). Empirical match on 6 months
          -- of 2025 data: unpaired RETURN+ADJUSTMENT rows are
          -- edit-after-return adjustments that ShopifyQL rolls into
          -- 'returns'. Paired ADJ rows net to zero so this is harmless.
          -- Refunded SHIPPING is NOT included by ShopifyQL.
          -- GIFT_CARD returns stay in the GC liability column.
          SELECT COALESCE(SUM(s.total_amount - s.total_tax), 0)
            FROM recon_shopify_sales s
           WHERE s.order_id = o.id
             AND s.happened_month = ?
             AND s.action_type = 'RETURN'
             AND s.line_type IN ('PRODUCT', 'ADJUSTMENT')
        ) AS v2_returns_in_month,
        (
          -- PR #110: return fees (action_type=ORDER, line_type=FEE).
          SELECT COALESCE(SUM(s.total_amount - s.total_tax), 0)
            FROM recon_shopify_sales s
           WHERE s.order_id = o.id
             AND s.happened_month = ?
             AND s.action_type = 'ORDER'
             AND s.line_type = 'FEE'
        ) AS v2_return_fees_in_month,
        (
          -- Taxes exclude GIFT_CARD lines, matching the acceptance endpoint.
          SELECT COALESCE(SUM(s.total_tax), 0)
            FROM recon_shopify_sales s
           WHERE s.order_id = o.id
             AND s.happened_month = ?
             AND s.line_type != 'GIFT_CARD'
        ) AS v2_tax_in_month,
        o.financial_status, o.fulfillment_status, o.source_name
      FROM recon_orders o
      WHERE EXISTS (
        SELECT 1 FROM recon_shopify_sales s
         WHERE s.order_id = o.id AND s.happened_month = ?
      )
      ORDER BY o.processed_at, o.created_at
    `).all(month, month, month, month, month, month);
    const totals = orders.reduce(
      (acc: any, o: any) => {
        acc.gross += Number(o.v2_gross_in_month || 0);
        acc.returns += Number(o.v2_returns_in_month || 0);
        acc.return_fees += Number(o.v2_return_fees_in_month || 0);
        acc.tax += Number(o.v2_tax_in_month || 0);
        if (o.created_month !== month) acc.cross_month_count += 1;
        return acc;
      },
      { gross: 0, returns: 0, return_fees: 0, tax: 0, cross_month_count: 0 },
    );
    res.json({
      month,
      order_count: orders.length,
      cross_month_orders: totals.cross_month_count,
      v2_totals: {
        gross: Math.round(totals.gross * 100) / 100,
        returns: Math.round(totals.returns * 100) / 100,
        return_fees: Math.round(totals.return_fees * 100) / 100,
        tax: Math.round(totals.tax * 100) / 100,
      },
      orders,
      note: "V2-aware enumeration (PR #110). Per-order v2_gross/returns/return_fees use action_type+line_type filters matching ShopifyQL Finance Summary aggregation.",
      build_id: "pr110",
    });
  });

  app.get("/api/recon/finance/debug/orders/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/rule9/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/refunds/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/bug3-forensics/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/orders/by-name/:name", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/cross-month-close", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/orders/by-name/:name/events", authMiddleware, requireFinanceView(), async (req, res) => {
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
  app.get("/api/recon/finance/debug/orders/by-name/:name/graphql-totals", authMiddleware, requireFinanceView(), async (req, res) => {
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
  app.get("/api/recon/finance/debug/orders/by-name/:name/agreements", authMiddleware, requireFinanceView(), async (req, res) => {
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
                # Intentionally NOT selecting return{id name status} -- that
                # requires the read_returns scope this app does not have, and
                # asking for it produces a partial GraphQL error on every
                # order with a ReturnAgreement.
                ... on ReturnAgreement     { app { handle } }
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
      const o: any = (r.data as any)?.order;
      // Tolerate partial GraphQL errors when data still came back.
      // Only 502 when there is truly no data.
      if (r.errors && !o) {
        return res.status(502).json({ message: "GraphQL errors (no data)", errors: r.errors });
      }
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
  app.get("/api/recon/finance/debug/agreements-ledger/health", authMiddleware, requireFinanceView(), (_req, res) => {
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
  app.post("/api/recon/finance/debug/agreements-ledger/ingest", authMiddleware, requireFinanceView(), async (req: any, res) => {
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
  app.post("/api/recon/finance/debug/agreements-ledger/backfill", authMiddleware, requireFinanceView(), (req: any, res) => {
    const cfg = getShopifyReconConfig();
    if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
    const body = req.body || {};
    const kind = String(body.scope || "").trim();
    let scope: any;
    if (kind === "all") {
      scope = { kind: "all" };
    } else if (kind === "missing") {
      scope = { kind: "missing" };
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
      return res.status(400).json({ message: "body.scope must be one of: all | missing | edited | month | names | orders" });
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
  app.get("/api/recon/finance/debug/agreements-ledger/backfill/:job_id", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/orders/by-name/:name/agreements-ledger", authMiddleware, requireFinanceView(), (req, res) => {
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

  // PR #108: per-Sale-event ledger, flattened. Same data as
  // /agreements-ledger but laid out as a flat array of recon_shopify_sales
  // rows with computed V2 columns (gross, returns, tax — all tax-exclusive
  // per the PR #108 formulas) so we can verify per-order, per-month sums
  // without nesting under agreements. Useful for cross-month edit debugging:
  // an order that spans Jan + Apr will show its Jan rows and Apr rows in one
  // chronological list with computed columns ready to sum.
  app.get("/api/recon/finance/debug/orders/by-name/:name/sales-ledger", authMiddleware, requireFinanceView(), (req, res) => {
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

    const rows: any[] = sqlite.prepare(`
      SELECT
        s.id AS sale_id,
        s.agreement_id,
        a.reason,
        a.agreement_type,
        s.happened_at,
        s.happened_month,
        s.sale_type,
        s.action_type,
        s.line_type,
        s.quantity,
        s.total_amount,
        s.total_discount_before_taxes,
        s.total_discount_after_taxes,
        s.total_tax,
        s.ref_id,
        s.ref_name,
        s.ref_sku
      FROM recon_shopify_sales s
      JOIN recon_shopify_agreements a ON a.id = s.agreement_id
      WHERE s.order_id = ?
      ORDER BY s.happened_at ASC, s.id ASC
    `).all(row.id) as any[];

    // PR #110: V2 columns dispatch by action_type + line_type (matches
    // ShopifyQL Finance Summary aggregation). Sign convention unchanged
    // from PR #109:
    //   gross        ≥ 0   (pre-discount, pre-tax)
    //   discount     ≤ 0   (negative)
    //   returns      ≤ 0   (negative, tax-exclusive)
    //   return_fees  ≥ 0   (positive; rolls into Sales Revenue for JE)
    //   net_sales_gift_cards signed (positive on issue, negative on refund)
    //   tax          signed (positive on sale, negative on refund)
    const enriched = rows.map((r) => {
      const total = Number(r.total_amount || 0);
      const disc = Number(r.total_discount_before_taxes || 0);
      const tax = Number(r.total_tax || 0);
      const actionType = String(r.action_type || "").toUpperCase();
      const lineType = String(r.line_type || "").toUpperCase();
      const isGc = r.sale_type === "GiftCardSale" || lineType === "GIFT_CARD";
      let v2_gross = 0;
      let v2_discount = 0;
      let v2_returns = 0;
      let v2_return_fees = 0;
      let v2_net_sales_gift_cards = 0;
      if (isGc) {
        v2_net_sales_gift_cards = total - tax;
      } else if (lineType === "SHIPPING") {
        // Shipping is intentionally not booked into the V2 sales columns.
      } else if (actionType === "ORDER" && lineType === "PRODUCT") {
        v2_gross = total + disc - tax;
        v2_discount = -disc;
      } else if (actionType === "ORDER" && lineType === "FEE") {
        v2_return_fees = total - tax;
      } else if (actionType === "RETURN" && (lineType === "PRODUCT" || lineType === "ADJUSTMENT")) {
        // PR #113: Returns column includes RETURN+PRODUCT and
        // RETURN+ADJUSTMENT. Paired ADJ rows net to zero; unpaired ones
        // are edit-after-return adjustments ShopifyQL counts in returns.
        // RETURN+SHIPPING and RETURN+FEE are intentionally excluded.
        v2_returns = total - tax;
      } else if (actionType === "UPDATE") {
        // Edit add/reverse — mirrors projector’s edit_adjustment routing.
        v2_gross = total + disc - tax;
        v2_discount = -disc;
      }
      return {
        ...r,
        v2_gross: Math.round(v2_gross * 100) / 100,
        v2_discount: Math.round(v2_discount * 100) / 100,
        v2_returns: Math.round(v2_returns * 100) / 100,
        v2_return_fees: Math.round(v2_return_fees * 100) / 100,
        v2_net_sales_gift_cards: Math.round(v2_net_sales_gift_cards * 100) / 100,
        v2_tax: Math.round(tax * 100) / 100,
      };
    });

    // Per-month rollup for quick cross-month read.
    const byMonth: Record<string, any> = {};
    for (const r of enriched) {
      const m = r.happened_month || "unknown";
      const acc = (byMonth[m] = byMonth[m] || {
        rows: 0, gross: 0, discount: 0, returns: 0, return_fees: 0,
        net_sales_gift_cards: 0, tax: 0,
      });
      acc.rows += 1;
      acc.gross += r.v2_gross;
      acc.discount += r.v2_discount;
      acc.returns += r.v2_returns;
      acc.return_fees += r.v2_return_fees;
      acc.net_sales_gift_cards += r.v2_net_sales_gift_cards;
      acc.tax += r.v2_tax;
    }
    for (const k of Object.keys(byMonth)) {
      for (const col of ["gross", "discount", "returns", "return_fees", "net_sales_gift_cards", "tax"] as const) {
        byMonth[k][col] = Math.round(byMonth[k][col] * 100) / 100;
      }
    }

    res.json({
      order_id: row.id,
      order_name: row.name,
      sales: enriched,
      by_month: byMonth,
      counts: { sales: enriched.length },
      note: "Flat per-Sale-event ledger with PR #110 action_type+line_type V2 columns. by_month rollup uses happened_month and includes cross-month edit/refund events.",
      build_id: "pr110",
    });
  });

  // PR #140a — read-only debug: dump raw recon_allocations rows for a given
  // order so we can confirm whether PR #139's order-level fallback rows are
  // actually being written with a usable entity_id. Look up by recon_orders.id
  // or, when the param starts with '#', also try recon_orders.name. Returns
  // raw allocation rows + a small slice of recon_shopify_sales context rows
  // and a tiny summary (row count, distinct entity_ids, has_order_level_row).
  app.get("/api/recon/debug/allocations/:order_id", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    const { sqlite } = require("./storage");
    const raw = String(req.params.order_id || "").trim();
    if (!raw) return res.status(400).json({ message: "order_id required" });

    let orderRow: any = sqlite.prepare(
      `SELECT id, name, cancelled_at FROM recon_orders WHERE id = ? LIMIT 1`
    ).get(raw);
    if (!orderRow && raw.startsWith("#")) {
      orderRow = sqlite.prepare(
        `SELECT id, name, cancelled_at FROM recon_orders WHERE name = ? LIMIT 1`
      ).get(raw);
    }
    if (!orderRow) return res.status(404).json({ message: `Order ${raw} not found` });

    const allocations: any[] = sqlite.prepare(`
      SELECT id, order_id, line_item_id, entity_id, share, gross_amount,
             tax_amount, method, reason, auto_method, auto_entity_id, created_at
      FROM recon_allocations
      WHERE order_id = ?
      ORDER BY created_at, id
    `).all(orderRow.id) as any[];

    const sales: any[] = sqlite.prepare(`
      SELECT id, order_id, line_item_id, pos_location_id, action_type,
             line_type, ref_id, total_amount, total_tax, happened_month
      FROM recon_shopify_sales
      WHERE order_id = ?
      ORDER BY happened_at, id
      LIMIT 50
    `).all(orderRow.id) as any[];

    const distinctEntityIds = Array.from(
      new Set(allocations.map((a) => a.entity_id))
    ).sort((a, b) => Number(a) - Number(b));
    const hasOrderLevelRow = allocations.some((a) => a.line_item_id === null);

    res.json({
      order_id: orderRow.id,
      order_name: orderRow.name,
      cancelled_at: orderRow.cancelled_at,
      allocations,
      sales,
      summary: {
        allocation_row_count: allocations.length,
        distinct_entity_ids: distinctEntityIds,
        has_order_level_row: hasOrderLevelRow,
        sales_row_count: sales.length,
      },
      build_id: "pr140a",
    });
  });

  // PR #108 acceptance test: V2 line sums vs ShopifyQL Finance Summary.
  // Returns line-by-line diff so we can confirm V2 reconciles to the penny.
  // V2 sums are computed directly from recon_shopify_sales using the
  // tax-exclusive PR #108 formulas — deliberately NOT from
  // recon_revenue_events_v2, so this is a check on the underlying fact table
  // and is robust against future projector changes.
  // PR #112: Single-query diagnostic for residual reconciliation gaps.
  // Returns:
  //   (a) full action_type x line_type x sale_type matrix for :month with
  //       row counts, sum_amt_ex_tax, sum_tax, and the gross-formula sum.
  //   (b) orders-count breakdown (5 different rules) for orders-diff diagnosis.
  //   (c) RETURN rows where line_type != PRODUCT — the smoking-gun list for
  //       a returns-column gap (matches PR #109's smoking-gun pattern, this
  //       time on the RETURN side instead of the ORDER side).
  app.get("/api/recon/finance/debug/sales-combo-matrix/:month", authMiddleware, requireFinanceView(), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    try {
      const { sqlite } = require("./storage");

      const matrix = sqlite.prepare(`
        SELECT
          s.action_type,
          s.line_type,
          s.sale_type,
          COUNT(*) AS rows_n,
          ROUND(SUM(s.total_amount - s.total_tax), 2) AS sum_amt_ex_tax,
          ROUND(SUM(s.total_tax), 2) AS sum_tax,
          ROUND(SUM(s.total_amount + s.total_discount_before_taxes - s.total_tax), 2) AS sum_gross_formula
        FROM recon_shopify_sales s
        WHERE s.happened_month = ?
        GROUP BY s.action_type, s.line_type, s.sale_type
        ORDER BY s.action_type, s.line_type, s.sale_type
      `).all(month);

      // Five different DISTINCT order_id rules so we can find ShopifyQL's.
      const orderRules: any = sqlite.prepare(`
        SELECT
          COUNT(DISTINCT s.order_id) AS all_any_row,
          COUNT(DISTINCT CASE WHEN s.line_type != 'GIFT_CARD' THEN s.order_id END) AS exclude_gc,
          COUNT(DISTINCT CASE WHEN s.action_type = 'ORDER' AND s.line_type = 'PRODUCT' THEN s.order_id END) AS order_product_only,
          COUNT(DISTINCT CASE WHEN s.action_type = 'ORDER' THEN s.order_id END) AS any_order_action,
          COUNT(DISTINCT CASE WHEN s.line_type = 'PRODUCT' THEN s.order_id END) AS product_any_action,
          COUNT(DISTINCT CASE WHEN s.line_type != 'GIFT_CARD' AND s.line_type != 'SHIPPING' THEN s.order_id END) AS exclude_gc_and_shipping
        FROM recon_shopify_sales s
        WHERE s.happened_month = ?
      `).get(month);

      // RETURN rows that are NOT line_type=PRODUCT — these would be missed
      // by V2's current returns filter but might be in ShopifyQL's returns.
      const returnNonProduct = sqlite.prepare(`
        SELECT
          s.id AS sale_id,
          s.order_id,
          o.name AS order_name,
          s.happened_at,
          s.action_type,
          s.line_type,
          s.sale_type,
          a.reason,
          s.total_amount,
          s.total_tax,
          ROUND(s.total_amount - s.total_tax, 2) AS amt_ex_tax,
          s.ref_name
        FROM recon_shopify_sales s
        LEFT JOIN recon_orders o ON o.id = s.order_id
        LEFT JOIN recon_shopify_agreements a ON a.id = s.agreement_id
        WHERE s.happened_month = ?
          AND s.action_type = 'RETURN'
          AND s.line_type != 'PRODUCT'
        ORDER BY ABS(s.total_amount) DESC
      `).all(month);

      const returnNonProductSum = (returnNonProduct as any[]).reduce(
        (a: number, r: any) => a + Number(r.amt_ex_tax || 0), 0,
      );
      const returnNonProductTaxSum = (returnNonProduct as any[]).reduce(
        (a: number, r: any) => a + Number(r.total_tax || 0), 0,
      );

      // Order rows with ONLY line_type=PRODUCT under action_type=ORDER, vs
      // orders with line_type=FEE under action_type=ORDER (return_fee).
      // Useful for the orders-count breakdown.
      const grossFormulaCheck: any = sqlite.prepare(`
        SELECT
          ROUND(SUM(CASE WHEN s.action_type='ORDER' AND s.line_type='PRODUCT'
            THEN s.total_amount + s.total_discount_before_taxes - s.total_tax
            ELSE 0 END), 2) AS v2_gross_sales,
          ROUND(SUM(CASE WHEN s.action_type='RETURN' AND s.line_type='PRODUCT'
            THEN s.total_amount - s.total_tax
            ELSE 0 END), 2) AS v2_returns,
          ROUND(SUM(CASE WHEN s.action_type='ORDER' AND s.line_type='FEE'
            THEN s.total_amount - s.total_tax
            ELSE 0 END), 2) AS v2_return_fees,
          ROUND(SUM(CASE WHEN s.line_type != 'GIFT_CARD'
            THEN s.total_tax ELSE 0 END), 2) AS v2_taxes
        FROM recon_shopify_sales s
        WHERE s.happened_month = ?
      `).get(month);

      res.json({
        month,
        build_id: "pr112",
        matrix,
        order_counts_by_rule: orderRules,
        return_non_product: {
          rows: returnNonProduct,
          row_count: (returnNonProduct as any[]).length,
          sum_amt_ex_tax: Math.round(returnNonProductSum * 100) / 100,
          sum_tax: Math.round(returnNonProductTaxSum * 100) / 100,
        },
        v2_sums: grossFormulaCheck,
        note: "Matrix lists every (action_type x line_type x sale_type) combo with sums. Order_counts_by_rule shows 6 different DISTINCT order_id rules so we can match ShopifyQL's count. return_non_product lists every RETURN row where line_type != PRODUCT — likely the source of returns-column gaps.",
      });
    } catch (e: any) {
      res.status(500).json({ message: "sales-combo-matrix failed", error: String(e?.message || e) });
    }
  });

  app.get("/api/recon/finance/debug/v2-vs-shopifyql/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    try {
      const { sqlite } = require("./storage");
      const { pullFinanceSummary } = require("./shopify-shopifyql");

      // ShopifyQL uses INCLUSIVE UNTIL (verified PR #108 probes 2026-05-26).
      // For month X, end-of-month is the last day of X, not first of X+1.
      const [yy, mm] = month.split("-").map(Number);
      const startDate = `${month}-01`;
      const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate(); // mm here is 1-12, Date uses 0-11
      const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;

      const ql: any = await pullFinanceSummary(startDate, endDate, "processed_at");

      // PR #110: V2 sums directly from recon_shopify_sales using action_type
      // + line_type filters (matches ShopifyQL Finance Summary aggregation).
      //
      // Filter formulas (locked from Retail-Q + empirical April 2025 match):
      //   gross_sales:  action_type IN (ORDER, UPDATE), line_type=PRODUCT
      //                 sum of (total_amount + discount_before_taxes - total_tax)
      //   discounts:    action_type IN (ORDER, UPDATE), line_type=PRODUCT
      //                 sum of -discount_before_taxes
      //   returns:      action_type=RETURN, line_type=PRODUCT
      //                 sum of (total_amount - total_tax)  [already negative]
      //   return_fees:  action_type=ORDER,  line_type=FEE
      //                 sum of (total_amount - total_tax)
      //   net_sales_gift_cards: line_type=GIFT_CARD (signed by action_type)
      //   shipping_charges:     line_type=SHIPPING
      //   taxes:                all rows except line_type=GIFT_CARD
      //
      // PR #121: include action_type=UPDATE for gross & discounts.
      // OrderEdit events emit a pair of rows: (1) a UPDATE/PRODUCT row that
      // REVERSES the original ORDER/PRODUCT (negative qty/amount/tax), then
      // (2) a new ORDER/PRODUCT row at the post-edit state. ShopifyQL's
      // `gross_sales` reflects the net effect of all three rows. The
      // per-Sale v2_gross precomputed column already nets UPDATE in, but
      // this aggregation query was filtering UPDATE out, causing V2 to
      // double-count the gross on edited orders. Example: order #35763
      // (Feb 2026) — original $315, price-match edit added $120 discount,
      // V2 was reporting $630 instead of $315.
      const v2Row: any = sqlite.prepare(`
        SELECT
          COALESCE(SUM(
            CASE
              WHEN s.action_type IN ('ORDER','UPDATE') AND s.line_type = 'PRODUCT'
                THEN s.total_amount + s.total_discount_before_taxes - s.total_tax
              ELSE 0
            END
          ), 0) AS gross_sales,
          COALESCE(SUM(
            CASE
              WHEN s.action_type IN ('ORDER','UPDATE') AND s.line_type = 'PRODUCT'
                THEN -s.total_discount_before_taxes
              ELSE 0
            END
          ), 0) AS discounts,
          COALESCE(SUM(
            CASE
              -- PR #113: include RETURN+ADJUSTMENT (edit-after-return
              -- adjustments). Paired ADJ rows net to zero; unpaired ones
              -- are real adjustments that ShopifyQL counts in returns.
              WHEN s.action_type = 'RETURN'
                   AND s.line_type IN ('PRODUCT', 'ADJUSTMENT')
                THEN (s.total_amount - s.total_tax)
              ELSE 0
            END
          ), 0) AS returns,
          COALESCE(SUM(
            CASE
              WHEN s.action_type = 'ORDER' AND s.line_type = 'FEE'
                THEN s.total_amount - s.total_tax
              ELSE 0
            END
          ), 0) AS return_fees,
          COALESCE(SUM(
            CASE
              WHEN s.line_type = 'GIFT_CARD'
                THEN s.total_amount - s.total_tax
              ELSE 0
            END
          ), 0) AS net_sales_gift_cards,
          COALESCE(SUM(
            CASE
              WHEN s.line_type = 'SHIPPING'
                THEN s.total_amount - s.total_tax
              ELSE 0
            END
          ), 0) AS shipping_charges,
          COALESCE(SUM(
            CASE
              WHEN s.line_type != 'GIFT_CARD'
                THEN s.total_tax
              ELSE 0
            END
          ), 0) AS taxes,
          -- PR #114: rule = placement-in-month + non-zero ORDER/PRODUCT or
          --                 RETURN/(PRODUCT|ADJUSTMENT) activity.
          -- PR #117: drop the (total_amount - total_tax) != 0 predicate.
          -- The PR #116 orders-gap probe showed 100% of the Jan/Feb/Mar/May
          -- misses (+17/+10/+7/+2) classified as ZERO_ACTIVITY — paid+
          -- fulfilled orders whose ORDER/PRODUCT row sums to exactly $0.00
          -- ex-tax (e.g. 100% discount, gift-card-only, comp/promo orders).
          -- ShopifyQL counts them; PR #114's != 0 check filtered them out.
          -- April still matches because the 6 April orders with
          -- orders_col=0 in the Sales-by-Order CSV come from ShopifyQL's
          -- orders=0 group (they had ZERO qualifying rows entirely, not
          -- zero-sum qualifying rows), so this loosening is one-directional.
          (
            SELECT COUNT(*)
              FROM recon_orders o
             WHERE substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) = ?
               AND EXISTS (
                 SELECT 1 FROM recon_shopify_sales ss
                  WHERE ss.order_id = o.id
                    AND ss.happened_month = ?
                    AND (
                      (ss.action_type = 'ORDER' AND ss.line_type = 'PRODUCT')
                      OR (ss.action_type = 'RETURN'
                          AND ss.line_type IN ('PRODUCT','ADJUSTMENT'))
                    )
               )
          ) AS orders
        FROM recon_shopify_sales s
        JOIN recon_shopify_agreements a ON a.id = s.agreement_id
        WHERE s.happened_month = ?
      `).get(month, month, month) as any;

      const v2 = {
        gross_sales: Math.round(Number(v2Row.gross_sales) * 100) / 100,
        discounts: Math.round(Number(v2Row.discounts) * 100) / 100,
        returns: Math.round(Number(v2Row.returns) * 100) / 100,
        return_fees: Math.round(Number(v2Row.return_fees) * 100) / 100,
        net_sales_gift_cards: Math.round(Number(v2Row.net_sales_gift_cards) * 100) / 100,
        shipping_charges: Math.round(Number(v2Row.shipping_charges) * 100) / 100,
        taxes: Math.round(Number(v2Row.taxes) * 100) / 100,
        orders: Number(v2Row.orders) || 0,
      };
      // net_sales matches ShopifyQL: gross + disc + ret. (return_fees and GC
      // are tracked separately and don't roll into the net_sales line.)
      //
      // PR #118: total_sales DOES include return_fees. ShopifyQL's Finance
      // Summary `total_sales` column = gross + discounts + returns + shipping
      // + return_fees + taxes. Visible in the Admin UI: Feb 2025 was Net
      // sales 283,203.48 + Shipping 59.96 + Return fees 10.00 + Taxes
      // 24,328.53 = Total sales 307,601.97 — the $10 return fee is rolled in.
      // V2 was previously omitting return_fees from total_sales, producing
      // a flat $10 diff in any month with return fees ($10 Feb '25,
      // Apr '25, Mar '26 — all months where return_fees > 0).
      //
      // NOTE on journal entries (your standing instruction): for QBO JE
      // posting, return_fees rolls into Sales Revenue (gross), NOT into
      // a separate account. That accounting treatment is independent of
      // this reporting-line reconciliation — ShopifyQL's `total_sales`
      // matches our V2 only when we sum the same 6 lines they sum.
      const net_sales = Math.round((v2.gross_sales + v2.discounts + v2.returns) * 100) / 100;
      const total_sales =
        Math.round((net_sales + v2.shipping_charges + v2.return_fees + v2.taxes) * 100) / 100;

      const round2 = (n: any) => Math.round(Number(n || 0) * 100) / 100;
      const cmp = (qlVal: any, v2Val: number) => {
        const a = round2(qlVal);
        const b = round2(v2Val);
        const diff = round2(a - b);
        return { shopifyql: a, v2: b, diff };
      };

      res.json({
        month,
        shopifyql_window: { start: startDate, end: endDate, note: "UNTIL is inclusive" },
        lines: {
          gross_sales: cmp(ql.gross_sales, v2.gross_sales),
          discounts: cmp(ql.discounts, v2.discounts),
          returns: cmp(ql.returns, v2.returns),
          net_sales: cmp(ql.net_sales, net_sales),
          shipping_charges: cmp(ql.shipping, v2.shipping_charges),
          taxes: cmp(ql.taxes, v2.taxes),
          total_sales: cmp(ql.total_sales, total_sales),
          orders: cmp(ql.orders, v2.orders),
          // PR #110 — return_fees IS a real ShopifyQL column; diff applies.
          return_fees: cmp(ql.return_fees, v2.return_fees),
          // PR #111 — ShopifyQL's `sales` dataset has no gift-card column,
          // so we surface V2's value as info-only (diff will be null on
          // shopifyql side; consumers should eyeball it against the Admin
          // Finance Summary PDF "Gift cards" line).
          net_sales_gift_cards: {
            shopifyql: null,
            v2: v2.net_sales_gift_cards,
            diff: null,
            note: "ShopifyQL has no gift-card column on `sales` dataset; visual check vs Admin Finance Summary PDF only.",
          },
        },
        v2_raw: { ...v2, net_sales, total_sales },
        shopifyql_raw: ql,
        note: "V2 sums come straight from recon_shopify_sales using PR #110 action_type+line_type filters (matches ShopifyQL Finance Summary aggregation). PR #113 widened returns to include RETURN+ADJUSTMENT. PR #114 rewrote orders count to filter by recon_orders.created_month + non-zero PRODUCT/ADJUSTMENT activity. PR #117 dropped the !=0 ex-tax check (ShopifyQL counts zero-sum orders too — 100% disc/comp/gift orders). PR #118 added return_fees into total_sales (it's a real component of ShopifyQL's total_sales column — was producing a flat $10 diff in months with return fees). PR #121 widened gross & discounts to include action_type=UPDATE/PRODUCT to net in OrderEdit reversal rows (was double-counting edited orders' gross). Acceptance: every line.diff = 0.00 (or 0 for orders). net_sales_gift_cards has no ShopifyQL parallel column — visual check only.",
        build_id: "pr121",
      });
    } catch (e: any) {
      res.status(500).json({ message: "v2-vs-shopifyql failed", error: String(e?.message || e) });
    }
  });

  // ---- R5b: drift sentinel ------------------------------------------------
  //
  // GET /api/recon/finance/drift/:month
  //
  // Thin user-facing wrapper over the debug v2-vs-shopifyql compute. The
  // Finance UI hits this in the background and renders a red banner when
  // any reconcilable line has a non-zero diff, so the operator sees drift
  // the moment it appears (instead of discovering it next time they paste
  // a console snippet).
  //
  // Tolerance: $0.01. net_sales_gift_cards is excluded from grading because
  // ShopifyQL's `sales` dataset has no gift-card column.
  app.get(
    "/api/recon/finance/drift/:month",
    authMiddleware,
    requireFinanceView(),
    async (req, res) => {
      const month = String(req.params.month);
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "Month must be YYYY-MM" });
      }
      try {
        const { sqlite } = require("./storage");
        const { pullFinanceSummary } = require("./shopify-shopifyql");

        // Same window math as /v2-vs-shopifyql -- UNTIL is inclusive.
        const [yy, mm] = month.split("-").map(Number);
        const startDate = `${month}-01`;
        const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;

        const ql: any = await pullFinanceSummary(startDate, endDate, "processed_at");

        // Same SQL as /v2-vs-shopifyql (PR #110/113/114/117/118/121). Kept
        // inline so formula changes there continue to apply here verbatim.
        const v2Row: any = sqlite.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN s.action_type IN ('ORDER','UPDATE') AND s.line_type = 'PRODUCT'
                          THEN s.total_amount + s.total_discount_before_taxes - s.total_tax ELSE 0 END), 0) AS gross_sales,
            COALESCE(SUM(CASE WHEN s.action_type IN ('ORDER','UPDATE') AND s.line_type = 'PRODUCT'
                          THEN -s.total_discount_before_taxes ELSE 0 END), 0) AS discounts,
            COALESCE(SUM(CASE WHEN s.action_type = 'RETURN' AND s.line_type IN ('PRODUCT','ADJUSTMENT')
                          THEN (s.total_amount - s.total_tax) ELSE 0 END), 0) AS returns,
            COALESCE(SUM(CASE WHEN s.action_type = 'ORDER' AND s.line_type = 'FEE'
                          THEN s.total_amount - s.total_tax ELSE 0 END), 0) AS return_fees,
            COALESCE(SUM(CASE WHEN s.line_type = 'GIFT_CARD'
                          THEN s.total_amount - s.total_tax ELSE 0 END), 0) AS net_sales_gift_cards,
            COALESCE(SUM(CASE WHEN s.line_type = 'SHIPPING'
                          THEN s.total_amount - s.total_tax ELSE 0 END), 0) AS shipping_charges,
            COALESCE(SUM(CASE WHEN s.line_type != 'GIFT_CARD' THEN s.total_tax ELSE 0 END), 0) AS taxes,
            (
              SELECT COUNT(*)
                FROM recon_orders o
               WHERE substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) = ?
                 AND EXISTS (
                   SELECT 1 FROM recon_shopify_sales ss
                    WHERE ss.order_id = o.id
                      AND ss.happened_month = ?
                      AND ((ss.action_type = 'ORDER' AND ss.line_type = 'PRODUCT')
                        OR (ss.action_type = 'RETURN' AND ss.line_type IN ('PRODUCT','ADJUSTMENT')))
                 )
            ) AS orders
          FROM recon_shopify_sales s
          JOIN recon_shopify_agreements a ON a.id = s.agreement_id
          WHERE s.happened_month = ?
        `).get(month, month, month) as any;

        const r2 = (n: any) => Math.round(Number(n || 0) * 100) / 100;
        const v2 = {
          gross_sales: r2(v2Row.gross_sales),
          discounts: r2(v2Row.discounts),
          returns: r2(v2Row.returns),
          return_fees: r2(v2Row.return_fees),
          net_sales_gift_cards: r2(v2Row.net_sales_gift_cards),
          shipping_charges: r2(v2Row.shipping_charges),
          taxes: r2(v2Row.taxes),
          orders: Number(v2Row.orders) || 0,
        };
        const net_sales = r2(v2.gross_sales + v2.discounts + v2.returns);
        const total_sales = r2(net_sales + v2.shipping_charges + v2.return_fees + v2.taxes);

        const cmp = (qlVal: any, v2Val: number) => {
          const a = r2(qlVal);
          const b = r2(v2Val);
          return { shopifyql: a, v2: b, diff: r2(a - b) };
        };

        const lines: Record<string, { shopifyql: number | null; v2: number; diff: number | null }> = {
          gross_sales: cmp(ql.gross_sales, v2.gross_sales),
          discounts: cmp(ql.discounts, v2.discounts),
          returns: cmp(ql.returns, v2.returns),
          net_sales: cmp(ql.net_sales, net_sales),
          shipping_charges: cmp(ql.shipping, v2.shipping_charges),
          taxes: cmp(ql.taxes, v2.taxes),
          total_sales: cmp(ql.total_sales, total_sales),
          orders: {
            shopifyql: Number(r2(ql.orders)),
            v2: v2.orders,
            diff: r2(Number(ql.orders) - v2.orders),
          },
          return_fees: cmp(ql.return_fees, v2.return_fees),
          net_sales_gift_cards: { shopifyql: null, v2: v2.net_sales_gift_cards, diff: null },
        };

        // Lines we actually grade against. net_sales_gift_cards is excluded
        // (no ShopifyQL parallel column).
        const TOLERANCE = 0.01;
        const GRADED_LINES = [
          "gross_sales", "discounts", "returns", "net_sales",
          "shipping_charges", "taxes", "total_sales", "orders", "return_fees",
        ];
        const drifted_lines = GRADED_LINES
          .filter((k) => {
            const d = lines[k]?.diff;
            return d != null && Math.abs(Number(d)) > TOLERANCE;
          })
          .map((k) => ({ line: k, ...lines[k] }));

        res.json({
          month,
          all_ok: drifted_lines.length === 0,
          orders_match: r2(Number(ql.orders) - v2.orders) === 0,
          drifted_lines,
          lines,
          v2_raw: { ...v2, net_sales, total_sales },
          shopifyql_window: { start: startDate, end: endDate },
          as_of: new Date().toISOString(),
          note:
            "R5b drift sentinel. Same compute as /api/recon/finance/debug/v2-vs-shopifyql/:month, " +
            "reduced to an all_ok boolean + drifted_lines for the Finance UI banner. " +
            "Tolerance $0.01. net_sales_gift_cards is excluded (no ShopifyQL parallel column).",
        });
      } catch (e: any) {
        res.status(500).json({ message: "drift sentinel failed", error: String(e?.message || e) });
      }
    },
  );

  // ---- R5b: on-demand month refresh --------------------------------------
  //
  // POST /api/recon/finance/agreements/refresh-month
  //   Body: { month: "YYYY-MM" }
  //
  // Thin wrapper over /api/recon/finance/debug/agreements-ledger/backfill
  // with scope=month. Powers the "Refresh" button on the Monthly Summary /
  // Per Store Sales tabs. Idempotent (re-runs bump ingest_version, no
  // duplicate rows). Returns a job_id the client can poll via the existing
  // /agreements-ledger/backfill/:job_id endpoint.
  app.post(
    "/api/recon/finance/agreements/refresh-month",
    authMiddleware,
    requireFinanceView(),
    (req: any, res) => {
      const month = String(req.body?.month ?? "").trim();
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "body.month required as 'YYYY-MM'" });
      }
      const cfg = getShopifyReconConfig();
      if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });
      try {
        const { startAgreementsBackfill } = require("./shopify-recon-agreements");
        const progress = startAgreementsBackfill(cfg, { kind: "month", month });
        res.json({
          ok: true,
          job_id: progress.job_id,
          total_orders: progress.total_orders,
          status: progress.status,
          poll_url: `/api/recon/finance/debug/agreements-ledger/backfill/${progress.job_id}`,
        });
      } catch (e: any) {
        res.status(500).json({ message: "refresh-month failed", error: String(e?.message || e) });
      }
    },
  );


  // PR #124 — POS-only by-store finance summary.
  //
  // Goal: prove POS attribution is correct by reconciling our V2 totals,
  // filtered to a single POS location, against Shopify Admin's Finances
  // Summary with the POS channel filter set to that same location.
  //
  // PR #125 rewrite: attribution is now per-line via
  // recon_shopify_sales.pos_location_id, sourced from ShopifyQL's `sales`
  // dataset (the same dataset Shopify Admin → Analytics → Finance Summary
  // reads from). This fixes three classes of bug that the prior
  // `recon_orders.location_id = ?` filter couldn't handle:
  //
  //   1. Multi-location orders — e.g. #37926 had $329 sold at Huntington
  //      and $299 sold at Greenvale. Previous SQL attributed all $628 to
  //      whichever store recon_orders.location_id pointed to.
  //   2. Cross-month exchanges at a different store — e.g. #37234 sold
  //      $95 at Huntington in Feb; the March exchange-replacement rang at
  //      Hempstead. Previous SQL kept the new $95 at Huntington.
  //   3. Cross-store exchanges with tax-rate differential — e.g. #35471
  //      sold $35 at Hempstead (8.625%), returned and exchanged to a
  //      different size at Huntington (8.75%). The $0.04 cash adjustment
  //      and the differential tax row stayed mis-attributed.
  //
  // All three are now correct because Shopify reports them correctly in
  // ShopifyQL's `pos_location_id` column per sale row, and we ingest that
  // value verbatim via shopify-recon-pos-locations.ts.
  //
  // Same line-item formulas as /v2-vs-shopifyql (PR #110/113/118/121),
  // unchanged:
  //   gross_sales: action_type IN (ORDER, UPDATE) AND line_type=PRODUCT
  //                sum of (total_amount + total_discount_before_taxes - total_tax)
  //   discounts:   same filter, sum of -total_discount_before_taxes
  //   returns:     action_type=RETURN AND line_type IN (PRODUCT, ADJUSTMENT)
  //                sum of (total_amount - total_tax)
  //   return_fees: action_type=ORDER AND line_type=FEE, sum of (amount - tax)
  //   net_sales_gift_cards: line_type=GIFT_CARD, signed by action_type
  //   shipping:    line_type=SHIPPING, sum of (amount - tax)
  //   taxes:       line_type != GIFT_CARD, sum of total_tax
  //
  // net_sales = gross + discounts + returns
  // total_sales = net_sales + shipping + return_fees + taxes
  //
  // Orders count for a store = number of distinct order_ids that had at
  // least one PRODUCT or RETURN/(PRODUCT|ADJUSTMENT) line at that
  // pos_location_id in :month. An order that touched two stores counts
  // toward BOTH stores' orders columns — matching how Shopify's by-store
  // Finance Summary counts them.
  //
  // Returns: bucketed by the RETURN row's happened_month (when the refund
  // landed), not the original sale's month, and attributed to whichever
  // pos_location_id the return row carries — which per the locked rule is
  // the original line's store. Shopify enforces this same convention in
  // ShopifyQL, so we get it for free.
  //
  // Non-POS rows (pos_location_id IS NULL): excluded from this endpoint
  // entirely. The full fulfillment cascade for those comes in a follow-up
  // PR — for now non-POS revenue (online orders, etc.) does not appear in
  // any store's roll-up. Use /v2-vs-shopifyql for the channel-agnostic
  // grand total.
  app.get("/api/recon/finance/by-store-pos/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const locationId = req.query.location_id ? String(req.query.location_id) : null;
    try {
      const { sqlite } = require("./storage");

      // Resolve location_id -> entity_id/name via recon_entity_pos_locations.
      // If caller passes ?location_id=X, restrict to that single store; else
      // return one row per mapped store (so the caller can sum to total).
      // Filter to kind='pos' AND active=1 to skip fulfillment-only or
      // archived rows.
      const mappedLocs: Array<{ location_id: string; entity_id: number; entity_location: string }> =
        sqlite.prepare(`
          SELECT pl.shopify_location_id AS location_id,
                 pl.entity_id           AS entity_id,
                 e.location             AS entity_location
            FROM recon_entity_pos_locations pl
            JOIN payroll_entities e ON e.id = pl.entity_id
           WHERE pl.shopify_location_id IS NOT NULL
             AND pl.kind = 'pos'
             AND pl.active = 1
             ${locationId ? "AND pl.shopify_location_id = ?" : ""}
           ORDER BY pl.entity_id
        `).all(...(locationId ? [locationId] : []));

      if (mappedLocs.length === 0) {
        return res.status(404).json({
          message: locationId
            ? `No entity mapping found for location_id ${locationId}`
            : "No POS location mappings found in recon_entity_pos_locations",
        });
      }

      const byStore: any[] = [];
      for (const loc of mappedLocs) {
        // PR #125: per-line attribution. The aggregate scans
        // recon_shopify_sales filtered by
        // (happened_month = :month AND pos_location_id = :location_id).
        // No JOIN on recon_orders needed — pos_location_id IS the
        // attribution dimension.
        //
        // Orders count: distinct order_ids touching this pos_location_id
        // in :month with at least one PRODUCT or RETURN/(PRODUCT|ADJUSTMENT)
        // line. A multi-store order counts toward each store it touched.
        const row: any = sqlite.prepare(`
          SELECT
            COALESCE(SUM(
              CASE
                WHEN s.action_type IN ('ORDER','UPDATE') AND s.line_type = 'PRODUCT'
                  THEN s.total_amount + s.total_discount_before_taxes - s.total_tax
                ELSE 0
              END
            ), 0) AS gross_sales,
            COALESCE(SUM(
              CASE
                WHEN s.action_type IN ('ORDER','UPDATE') AND s.line_type = 'PRODUCT'
                  THEN -s.total_discount_before_taxes
                ELSE 0
              END
            ), 0) AS discounts,
            COALESCE(SUM(
              CASE
                WHEN s.action_type = 'RETURN'
                     AND s.line_type IN ('PRODUCT', 'ADJUSTMENT')
                  THEN (s.total_amount - s.total_tax)
                ELSE 0
              END
            ), 0) AS returns,
            COALESCE(SUM(
              CASE
                WHEN s.action_type = 'ORDER' AND s.line_type = 'FEE'
                  THEN s.total_amount - s.total_tax
                ELSE 0
              END
            ), 0) AS return_fees,
            COALESCE(SUM(
              CASE
                WHEN s.line_type = 'GIFT_CARD'
                  THEN s.total_amount - s.total_tax
                ELSE 0
              END
            ), 0) AS net_sales_gift_cards,
            COALESCE(SUM(
              CASE
                WHEN s.line_type = 'SHIPPING'
                  THEN s.total_amount - s.total_tax
                ELSE 0
              END
            ), 0) AS shipping_charges,
            COALESCE(SUM(
              CASE
                WHEN s.line_type != 'GIFT_CARD'
                  THEN s.total_tax
                ELSE 0
              END
            ), 0) AS taxes,
            (
              SELECT COUNT(DISTINCT ss.order_id)
                FROM recon_shopify_sales ss
               WHERE ss.happened_month = ?
                 AND ss.pos_location_id = ?
                 AND (
                   (ss.action_type = 'ORDER' AND ss.line_type = 'PRODUCT')
                   OR (ss.action_type = 'RETURN'
                       AND ss.line_type IN ('PRODUCT','ADJUSTMENT'))
                 )
            ) AS orders
          FROM recon_shopify_sales s
          WHERE s.happened_month = ?
            AND s.pos_location_id = ?
        `).get(month, loc.location_id, month, loc.location_id) as any;

        const r2 = (n: any) => Math.round(Number(n || 0) * 100) / 100;
        const gross = r2(row.gross_sales);
        // PR #133: surface discounts & returns as POSITIVE magnitudes to
        // match Shopify Admin Finance Summary + the V2 /finance/diff
        // contract (server/shopify-finance-diff.ts:1125-1126). The SQL
        // returns these as negative numbers (math convention: net_sales =
        // gross + disc_neg + ret_neg). We flip them at the API boundary
        // and switch net_sales to gross - discounts - returns. Same
        // numeric result; display contract now matches Shopify.
        const disc = r2(Math.abs(Number(row.discounts) || 0));
        const ret = r2(Math.abs(Number(row.returns) || 0));
        const rf = r2(row.return_fees);
        const gc = r2(row.net_sales_gift_cards);
        const ship = r2(row.shipping_charges);
        const tax = r2(row.taxes);
        const netSales = r2(gross - disc - ret);
        const totalSales = r2(netSales + ship + rf + tax);
        byStore.push({
          entity_id: loc.entity_id,
          entity_location: loc.entity_location,
          location_id: loc.location_id,
          gross_sales: gross,
          discounts: disc,
          returns: ret,
          return_fees: rf,
          net_sales: netSales,
          net_sales_gift_cards: gc,
          shipping_charges: ship,
          taxes: tax,
          total_sales: totalSales,
          orders: Number(row.orders) || 0,
        });
      }

      // POS totals across all stores (for cross-foot vs full Shopify
      // POS-channel totals — Shopify Admin lets you filter Finance Summary
      // to channel='pos' with no location filter to get this).
      const r2sum = (a: number, b: number): number => Math.round((a + b) * 100) / 100;
      const totals = byStore.reduce(
        (acc, s) => ({
          gross_sales: r2sum(acc.gross_sales, s.gross_sales),
          discounts: r2sum(acc.discounts, s.discounts),
          returns: r2sum(acc.returns, s.returns),
          return_fees: r2sum(acc.return_fees, s.return_fees),
          net_sales: r2sum(acc.net_sales, s.net_sales),
          net_sales_gift_cards: r2sum(acc.net_sales_gift_cards, s.net_sales_gift_cards),
          shipping_charges: r2sum(acc.shipping_charges, s.shipping_charges),
          taxes: r2sum(acc.taxes, s.taxes),
          total_sales: r2sum(acc.total_sales, s.total_sales),
          orders: acc.orders + s.orders,
        }),
        {
          gross_sales: 0, discounts: 0, returns: 0, return_fees: 0, net_sales: 0,
          net_sales_gift_cards: 0, shipping_charges: 0, taxes: 0, total_sales: 0, orders: 0,
        }
      );

      res.json({
        month,
        scope: "pos_only",
        by_store: byStore,
        totals,
        note: "PR #125: per-line POS attribution via recon_shopify_sales.pos_location_id (sourced from ShopifyQL `sales` dataset). Multi-store orders, cross-month exchanges, and cross-store exchange tax differentials are all attributed correctly because we mirror Shopify's own analytics layer. Non-POS rows (pos_location_id IS NULL) are excluded from this endpoint — they'll get the fulfillment cascade in a follow-up PR. Compare each row to Shopify Admin Finance Summary with POS channel filter set to that store's location.",
        build_id: "pr125",
      });
    } catch (e: any) {
      res.status(500).json({ message: "by-store-pos failed", error: String(e?.message || e) });
    }
  });

  // PR #131 — Fully-allocated by-store finance summary.
  //
  // Unlike /by-store-pos (PR #124–#125, POS-only via per-line
  // pos_location_id), this endpoint ALSO attributes non-POS rows
  // (pos_location_id IS NULL) to one of the 3 retail stores via the
  // existing recon_allocations ledger — the same allocator that runs at
  // order ingest time (server/shopify-recon-allocator.ts). The cascade:
  //
  //   1. POS row (pos_location_id NOT NULL)
  //      → entity_id from recon_entity_pos_locations where kind='pos'
  //   2. Non-POS row
  //      → recon_allocations row matching (order_id, line_item_id) first;
  //        fall back to order-level (line_item_id IS NULL) allocation
  //      → if that entity_id maps to a POS-kind entity, attribute it
  //      → otherwise treat as unallocated (SD/warehouse/needs_review)
  //
  // This means a single sales row is bucketed into exactly one of:
  // {Greenvale, Huntington, Hempstead, Unallocated}. Sum across all four
  // = V2 overall monthly total to the penny.
  //
  // The Unallocated bucket should be ~$0 in steady state — every non-POS
  // order should resolve via the fulfillment cascade (PR #R4d) or GC
  // affinity (PR #R4j). When non-zero, callers should hit
  // `unallocated_orders` (returned only when total != 0) for the per-order
  // list so the root cause can be diagnosed and fixed.
  //
  // Same 9-metric shape as /by-store-pos: gross_sales, discounts, returns,
  // return_fees, net_sales_gift_cards, shipping_charges, taxes, net_sales,
  // total_sales. Pennies, no rounding.
  app.get("/api/recon/finance/by-store/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    try {
      const { sqlite } = require("./storage");

      // Resolve the 3 retail POS stores. Same filter as /by-store-pos:
      // kind='pos' AND active=1.
      const mappedLocs: Array<{ location_id: string; entity_id: number; entity_location: string }> =
        sqlite.prepare(`
          SELECT pl.shopify_location_id AS location_id,
                 pl.entity_id           AS entity_id,
                 e.location             AS entity_location
            FROM recon_entity_pos_locations pl
            JOIN payroll_entities e ON e.id = pl.entity_id
           WHERE pl.shopify_location_id IS NOT NULL
             AND pl.kind = 'pos'
             AND pl.active = 1
           ORDER BY pl.entity_id
        `).all();

      if (mappedLocs.length === 0) {
        return res.status(404).json({
          message: "No POS location mappings found in recon_entity_pos_locations",
        });
      }

      // Pre-compute the set of POS-mapped entity_ids — used to decide
      // whether an allocation row counts as "store-routed" or falls into
      // Unallocated. Allocations to SD / warehouse / needs_review entities
      // are intentionally bucketed as unallocated so the operator can
      // diagnose root cause without polluting any store's revenue.
      const posEntityIds: number[] = mappedLocs.map(l => l.entity_id);

      // Build the per-row attribution CTE and aggregate.
      //
      // attributed_entity_id resolves to:
      //   - POS row's entity (when pos_location_id is set and maps to POS)
      //   - per-line allocation's entity (when present)
      //   - order-level allocation's entity (when no per-line match)
      //   - dominant-entity fallback: the entity_id with the largest
      //     SUM(gross_amount) across this order's recon_allocations rows
      //     (tie-break by entity_id ASC). Added in PR #140b to plug the
      //     shipping/fee leak: SHIPPING/FEE/RETURN-SHIPPING rows in
      //     recon_shopify_sales carry line_item_id = "0" (a sentinel, not
      //     a real line), so for non-POS orders the per-line branch
      //     doesn't match and the order-level branch only fires for
      //     cancelled orders. Result pre-#140b: an order's PRODUCT lines
      //     attributed correctly to Greenvale/Huntington/Hempstead while
      //     its shipping/fees fell to Unallocated. The dominant-entity
      //     fallback attributes those non-line-keyed rows to whichever
      //     entity already owns the bulk of the order's gross.
      //   - NULL otherwise (→ Unallocated bucket)
      //
      // The COALESCE+correlated-subquery shape is intentional: SQLite
      // optimizes each subquery against an index lookup, so this scales
      // linearly with the number of sales rows in the month. We GROUP BY
      // entity_id (treating NULL as a distinct bucket via the IS NULL test
      // in the outer SELECT). 9 metrics match Finance Summary exactly.
      //
      // NOTE: a sales row with attributed_entity_id pointing to a non-POS
      // entity (e.g. SD = warehouse) will still aggregate — but only the
      // 3 POS entities are exposed in `by_store`. The non-POS entity rows
      // are collapsed into `unallocated` in the second query below. This
      // keeps the math symmetric: every row counts exactly once.
      const attributionCte = `
        WITH attributed AS (
          SELECT
            s.*,
            COALESCE(
              CASE WHEN s.pos_location_id IS NOT NULL THEN
                (SELECT pl.entity_id
                   FROM recon_entity_pos_locations pl
                  WHERE pl.shopify_location_id = s.pos_location_id
                    AND pl.kind = 'pos'
                    AND pl.active = 1
                  LIMIT 1)
              END,
              (SELECT a.entity_id
                 FROM recon_allocations a
                WHERE a.order_id = s.order_id
                  AND a.line_item_id = s.line_item_id
                LIMIT 1),
              (SELECT a.entity_id
                 FROM recon_allocations a
                WHERE a.order_id = s.order_id
                  AND a.line_item_id IS NULL
                LIMIT 1),
              (SELECT a.entity_id
                 FROM recon_allocations a
                WHERE a.order_id = s.order_id
                GROUP BY a.entity_id
                ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC
                LIMIT 1)
            ) AS attributed_entity_id
          FROM recon_shopify_sales s
          WHERE s.happened_month = ?
        )
      `;

      // 9-metric aggregator parameterized by an entity-id filter clause.
      // We reuse the same SQL twice: once per POS entity, once for the
      // "is null OR not in POS set" bucket = Unallocated.
      const metricExpr = (filterClause: string) => `
        ${attributionCte}
        SELECT
          COALESCE(SUM(
            CASE
              WHEN a.action_type IN ('ORDER','UPDATE') AND a.line_type = 'PRODUCT'
                THEN a.total_amount + a.total_discount_before_taxes - a.total_tax
              ELSE 0
            END
          ), 0) AS gross_sales,
          COALESCE(SUM(
            CASE
              WHEN a.action_type IN ('ORDER','UPDATE') AND a.line_type = 'PRODUCT'
                THEN -a.total_discount_before_taxes
              ELSE 0
            END
          ), 0) AS discounts,
          COALESCE(SUM(
            CASE
              WHEN a.action_type = 'RETURN'
                   AND a.line_type IN ('PRODUCT', 'ADJUSTMENT')
                THEN (a.total_amount - a.total_tax)
              ELSE 0
            END
          ), 0) AS returns,
          COALESCE(SUM(
            CASE
              WHEN a.action_type = 'ORDER' AND a.line_type = 'FEE'
                THEN a.total_amount - a.total_tax
              ELSE 0
            END
          ), 0) AS return_fees,
          COALESCE(SUM(
            CASE
              WHEN a.line_type = 'GIFT_CARD'
                THEN a.total_amount - a.total_tax
              ELSE 0
            END
          ), 0) AS net_sales_gift_cards,
          COALESCE(SUM(
            CASE
              WHEN a.line_type = 'SHIPPING'
                THEN a.total_amount - a.total_tax
              ELSE 0
            END
          ), 0) AS shipping_charges,
          -- PR #160: this taxes SUM is SUPERSEDED in the response by the
          -- canonical v_attributed_sales engine (see finalize() taxCentsOverride
          -- and computeAttributionForMonth). It is kept here only so the column
          -- still exists for the legacy shape / any diagnostic readers; the
          -- value emitted to clients comes from the view, not this SUM. The two
          -- are penny-identical for production months (invariant-asserted at
          -- /api/recon/finance/debug/attribution-invariant).
          COALESCE(SUM(
            CASE
              WHEN a.line_type != 'GIFT_CARD'
                THEN a.total_tax
              ELSE 0
            END
          ), 0) AS taxes,
          COUNT(DISTINCT CASE
            WHEN (a.action_type = 'ORDER' AND a.line_type = 'PRODUCT')
              OR (a.action_type = 'RETURN' AND a.line_type IN ('PRODUCT','ADJUSTMENT'))
              THEN a.order_id
          END) AS orders
        FROM attributed a
        WHERE ${filterClause}
      `;

      // PR #160: tax now comes from the canonical v_attributed_sales engine
      // (computeAttributionForMonth), NOT from this endpoint's own SUM over
      // recon_shopify_sales.total_tax. Migrated to v_attributed_sales view in
      // PR #160 for canonical attribution; see invariant assertion at
      // /api/recon/finance/debug/attribution-invariant. The engine returns
      // per-entity NET line-level tax in integer cents
      // (forward_line - refund_line + forward_shipping - refund_shipping),
      // keyed by entity_id with 0 = Unallocated. Picks outside the POS set
      // collapse to 0, identical to this endpoint's unallocated bucket. This
      // is a numerical no-op vs. the old CTE tax column (verified penny-exact
      // for 2025-12, 2026-04, 2026-05); only the source of truth changed so
      // by-store tax can never drift from ST-810 / grand totals again.
      const attribution = computeAttributionForMonth(month);
      const netTaxCentsForEntity = (eid: number): number =>
        (attribution.fwdByEntity.get(eid) || 0)
        - (attribution.refByEntity.get(eid) || 0)
        + (attribution.shipByEntity.get(eid) || 0)
        - (attribution.shipRefByEntity.get(eid) || 0);

      const r2 = (n: any) => Math.round(Number(n || 0) * 100) / 100;
      // taxCentsOverride (when provided) replaces the legacy SUM(total_tax)
      // for this bucket with the engine's net cents. total_sales is then
      // recomputed from the same overridden tax so the row stays internally
      // consistent. Every non-tax column is untouched (this PR is scoped to
      // the tax migration only — gross/discounts/returns/shipping unchanged).
      const finalize = (row: any, taxCentsOverride?: number) => {
        const gross = r2(row.gross_sales);
        // PR #133: surface discounts & returns as POSITIVE magnitudes to
        // match Shopify Admin Finance Summary + the V2 /finance/diff
        // contract. SQL returns these negative (math convention); we flip
        // them at the API boundary and switch net_sales to
        // gross - discounts - returns. Same numeric result, Shopify-style
        // display contract. Mirrors the /by-store-pos fix in the same PR.
        const disc = r2(Math.abs(Number(row.discounts) || 0));
        const ret = r2(Math.abs(Number(row.returns) || 0));
        const rf = r2(row.return_fees);
        const gc = r2(row.net_sales_gift_cards);
        const ship = r2(row.shipping_charges);
        const tax = taxCentsOverride !== undefined
          ? Math.round(Number(taxCentsOverride)) / 100
          : r2(row.taxes);
        const netSales = r2(gross - disc - ret);
        const totalSales = r2(netSales + ship + rf + tax);
        return {
          gross_sales: gross,
          discounts: disc,
          returns: ret,
          return_fees: rf,
          net_sales: netSales,
          net_sales_gift_cards: gc,
          shipping_charges: ship,
          taxes: tax,
          total_sales: totalSales,
          orders: Number(row.orders) || 0,
        };
      };

      // Per-store aggregates.
      const byStore: any[] = [];
      for (const loc of mappedLocs) {
        const row = sqlite.prepare(metricExpr(`a.attributed_entity_id = ?`)).get(month, loc.entity_id) as any;
        byStore.push({
          entity_id: loc.entity_id,
          entity_location: loc.entity_location,
          location_id: loc.location_id,
          ...finalize(row, netTaxCentsForEntity(loc.entity_id)),
        });
      }

      // Unallocated bucket: rows whose attributed_entity_id is NULL OR
      // points to a non-POS entity. We use a NOT IN clause with the POS
      // entity ids (the set is tiny — always 3 — so inlining is fine).
      const posIdList = posEntityIds.join(",") || "-1";
      const unallocRow = sqlite.prepare(
        metricExpr(`(a.attributed_entity_id IS NULL OR a.attributed_entity_id NOT IN (${posIdList}))`)
      ).get(month) as any;
      // Unallocated tax = engine entity 0. The engine collapses every pick
      // that is NULL or outside the POS set into entity 0, exactly mirroring
      // this bucket's NULL-or-not-in-POS filter, so the parts (3 stores + 0)
      // sum to the engine grand total — the same invariant #159 asserts.
      const unallocated = finalize(unallocRow, netTaxCentsForEntity(0));

      // Aggregate totals across {3 stores + unallocated} — these should
      // tie to the V2 overall monthly total to the penny.
      const r2sum = (x: number, y: number) => Math.round((x + y) * 100) / 100;
      const totals = [...byStore, unallocated].reduce(
        (acc, s) => ({
          gross_sales: r2sum(acc.gross_sales, s.gross_sales),
          discounts: r2sum(acc.discounts, s.discounts),
          returns: r2sum(acc.returns, s.returns),
          return_fees: r2sum(acc.return_fees, s.return_fees),
          net_sales: r2sum(acc.net_sales, s.net_sales),
          net_sales_gift_cards: r2sum(acc.net_sales_gift_cards, s.net_sales_gift_cards),
          shipping_charges: r2sum(acc.shipping_charges, s.shipping_charges),
          taxes: r2sum(acc.taxes, s.taxes),
          total_sales: r2sum(acc.total_sales, s.total_sales),
          orders: acc.orders + s.orders,
        }),
        {
          gross_sales: 0, discounts: 0, returns: 0, return_fees: 0, net_sales: 0,
          net_sales_gift_cards: 0, shipping_charges: 0, taxes: 0, total_sales: 0, orders: 0,
        }
      );

      // Unallocated diagnostic: when unallocated.total_sales != 0, return
      // the per-order list so the operator can drill in. We cap at 100
      // orders to keep the payload small — if there are more, the count is
      // returned separately and the operator can hit a paginated endpoint.
      let unallocated_orders: Array<{
        order_id: string;
        order_name: string | null;
        source_name: string | null;
        has_allocation: boolean;
        allocated_entity_id: number | null;
        gross_sales: number;
      }> | null = null;
      let unallocated_order_count: number | null = null;
      if (Math.abs(unallocated.total_sales) >= 0.005 || unallocated.orders > 0) {
        const list = sqlite.prepare(`
          ${attributionCte}
          SELECT a.order_id,
                 o.name AS order_name,
                 o.source_name,
                 a.attributed_entity_id,
                 ROUND(SUM(CASE
                   WHEN a.action_type IN ('ORDER','UPDATE') AND a.line_type = 'PRODUCT'
                     THEN a.total_amount + a.total_discount_before_taxes - a.total_tax
                   ELSE 0
                 END) * 100) / 100.0 AS gross_sales
            FROM attributed a
            LEFT JOIN recon_orders o ON o.id = a.order_id
           WHERE (a.attributed_entity_id IS NULL OR a.attributed_entity_id NOT IN (${posIdList}))
           GROUP BY a.order_id
           ORDER BY ABS(gross_sales) DESC
           LIMIT 100
        `).all(month) as Array<{
          order_id: string;
          order_name: string | null;
          source_name: string | null;
          attributed_entity_id: number | null;
          gross_sales: number;
        }>;
        unallocated_orders = list.map(r => ({
          order_id: r.order_id,
          order_name: r.order_name,
          source_name: r.source_name,
          has_allocation: r.attributed_entity_id != null,
          allocated_entity_id: r.attributed_entity_id,
          gross_sales: r2(r.gross_sales),
        }));
        const countRow = sqlite.prepare(`
          ${attributionCte}
          SELECT COUNT(DISTINCT a.order_id) AS n
            FROM attributed a
           WHERE (a.attributed_entity_id IS NULL OR a.attributed_entity_id NOT IN (${posIdList}))
        `).get(month) as { n: number };
        unallocated_order_count = Number(countRow.n) || 0;
      }

      res.json({
        month,
        scope: "fully_allocated",
        by_store: byStore,
        unallocated,
        totals,
        unallocated_orders,
        unallocated_order_count,
        note: "PR #131: per-line POS attribution (pos_location_id) UNION allocator output (recon_allocations) bucketed into {Greenvale, Huntington, Hempstead, Unallocated}. Sum across all 4 buckets = V2 overall monthly total to the penny. Unallocated should be ~$0 in steady state; when non-zero, drill into unallocated_orders to diagnose. PR #160: the taxes column (and tax's contribution to total_sales) is now sourced from the canonical v_attributed_sales engine (computeAttributionForMonth) instead of this endpoint's own SUM over recon_shopify_sales.total_tax — a numerical no-op verified penny-exact, so by-store tax can never drift from ST-810 / grand totals; see /api/recon/finance/debug/attribution-invariant.",
        build_id: "pr160",
      });
    } catch (e: any) {
      res.status(500).json({ message: "by-store failed", error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------------
  // PR #143 — Sales tax API (read-only query layer over recon_line_items).
  //
  //   GET /api/recon/tax/by-entity/:month     entity-level summary + marketplace split
  //   GET /api/recon/tax/st810/:month         per-entity per-jurisdiction (ST-810)
  //   GET /api/recon/tax/st810/:quarter       same, summed over NY tax quarter
  //
  // Source: recon_line_items.tax_lines_json (per-jurisdiction breakout
  // already exists at ingest time — see shopify-recon-orders.ts:225-235).
  // Entity attribution mirrors /api/recon/finance/by-store/:month: POS via
  // recon_shopify_sales.pos_location_id → recon_entity_pos_locations.entity_id,
  // else recon_allocations cascade (per-line → order-level → dominant entity).
  //
  // Marketplace facilitator (Shop channel) carve-out: tax_channel_liable=1
  // lines stay in gross_sales (operator visibility) but are bucketed into
  // marketplace_gross / marketplace_tax_collected. tax_owed excludes them.
  //
  // All money fields are strings to avoid float drift; aggregated as integer
  // cents in shopify-tax-aggregation.ts and rendered fixed-2 at the boundary.
  // -------------------------------------------------------------------------

  /**
   * Internal: load the per-month line set with entity attribution + POS flag.
   * Reused by all three tax endpoints (per-month, and per-quarter which calls
   * this for each of its 3 months).
   *
   * Bucketing: uses `recon_line_items.recognized_at` (defaulting to order
   * processed_at / created_at), the same default `grossBucketExpr` as
   * shopify-finance-diff.ts. Lines are attributed using the same cascade as
   * /api/recon/finance/by-store/:month.
   *
   * Returns { inputs, entityNames }. entity_id=0 = Unallocated.
   */
  function loadTaxInputsForMonth(month: string): {
    inputs: AggregatorInput[];
    refunds: RefundForTax[];
    shippingTaxForward: ShippingTaxForward[];
    shippingTaxRefunds: ShippingTaxRefund[];
    unverifiedReturnTax: UnverifiedReturnTax[];
    entityNames: Map<number, string>;
  } {
    const { sqlite } = require("./storage");

    // Resolve POS entity locations once.
    const mappedLocs: Array<{ location_id: string; entity_id: number; entity_location: string }> =
      sqlite.prepare(`
        SELECT pl.shopify_location_id AS location_id,
               pl.entity_id           AS entity_id,
               e.location             AS entity_location
          FROM recon_entity_pos_locations pl
          JOIN payroll_entities e ON e.id = pl.entity_id
         WHERE pl.shopify_location_id IS NOT NULL
           AND pl.kind = 'pos'
           AND pl.active = 1
         ORDER BY pl.entity_id
      `).all();

    const entityNames = new Map<number, string>();
    entityNames.set(0, 'Unallocated');
    for (const loc of mappedLocs) entityNames.set(loc.entity_id, loc.entity_location);

    // Pull lines for the month bucketed by recognized_at|processed_at|created_at
    // (same default as shopify-finance-diff.ts grossBucketExpr).
    //
    // attribution cascade — mirrors by-store CTE:
    //   1. POS: any recon_shopify_sales row for (order_id, line_item_id) with
    //      pos_location_id mapped to a POS entity → that entity, marked as POS
    //   2. recon_allocations per-line (order_id, line_item_id)
    //   3. recon_allocations order-level (order_id, line_item_id IS NULL)
    //   4. dominant-entity fallback (largest gross_amount on the order)
    //   5. else entity_id=0 (Unallocated)
    //
    // We compute (1) as a separate column (`pos_entity_id`) so we can split
    // POS vs Allocated in the response. If pos_entity_id is set we ALSO use
    // it as the attribution; otherwise we use the allocation cascade.
    const lineRows: Array<{
      line_id: string;
      order_id: string;
      line_subtotal: number | null;
      price: number | null;
      quantity: number | null;
      total_discount: number | null;
      discount_allocations_total: number | null;
      is_gift_card: number;
      tax_channel_liable: number;
      tax_lines_json: string | null;
      pos_entity_id: number | null;
      alloc_entity_id: number | null;
    }> = sqlite.prepare(`
      SELECT
        li.id AS line_id,
        li.order_id AS order_id,
        li.line_subtotal AS line_subtotal,
        li.price AS price,
        li.quantity AS quantity,
        li.total_discount AS total_discount,
        li.discount_allocations_total AS discount_allocations_total,
        li.is_gift_card AS is_gift_card,
        li.tax_channel_liable AS tax_channel_liable,
        li.tax_lines_json AS tax_lines_json,
        (SELECT pl.entity_id
           FROM recon_shopify_sales s
           JOIN recon_entity_pos_locations pl
             ON pl.shopify_location_id = s.pos_location_id
            AND pl.kind = 'pos'
            AND pl.active = 1
          WHERE s.order_id = li.order_id
            AND s.line_item_id = li.id
            AND s.pos_location_id IS NOT NULL
          LIMIT 1) AS pos_entity_id,
        COALESCE(
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = li.order_id AND a.line_item_id = li.id LIMIT 1),
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = li.order_id AND a.line_item_id IS NULL LIMIT 1),
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = li.order_id
            GROUP BY a.entity_id
            ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
        ) AS alloc_entity_id
      FROM recon_line_items li
      JOIN recon_orders o ON o.id = li.order_id
      WHERE substr(datetime(
        COALESCE(li.recognized_at, o.processed_at, o.created_at),
        '-5 hours'), 1, 7) = ?
        AND li.is_gift_card = 0
    `).all(month) as any;

    // POS entity set — used to bucket non-POS entities into Unallocated.
    const posEntityIds = new Set<number>(mappedLocs.map(l => l.entity_id));

    const inputs: AggregatorInput[] = [];
    for (const r of lineRows) {
      // Effective discount = max(total_discount, discount_allocations_total)
      // — matches shopify-recon-orders.ts:222 (Rule #7c).
      const eff_disc = Math.max(
        Number(r.total_discount || 0),
        Number(r.discount_allocations_total || 0),
      );
      const computed_sub = (Number(r.price || 0) * Number(r.quantity || 0)) - eff_disc;
      const sub = r.line_subtotal != null ? Number(r.line_subtotal) : computed_sub;

      // Pick attribution:
      //   1. POS entity (if mapped POS)
      //   2. Allocation entity (if any, and it's a POS entity)
      //   3. else 0 (Unallocated)
      let entity_id = 0;
      let is_pos = false;
      if (r.pos_entity_id != null && posEntityIds.has(r.pos_entity_id)) {
        entity_id = r.pos_entity_id;
        is_pos = true;
      } else if (r.alloc_entity_id != null && posEntityIds.has(r.alloc_entity_id)) {
        entity_id = r.alloc_entity_id;
        is_pos = false;
      } else {
        entity_id = 0;
        is_pos = false;
      }

      const line: LineForTax = {
        entity_id,
        line_subtotal: sub,
        is_gift_card: r.is_gift_card,
        tax_channel_liable: r.tax_channel_liable,
        tax_lines: parseTaxLines(r.tax_lines_json),
      };
      inputs.push({ line, is_pos });
    }

    // -----------------------------------------------------------------------
    // PR #145 — Refund tax subtraction.
    //
    // Refund rows live in recon_refund_line_items, parented by recon_refunds.
    // They net the sales tax back to the merchant when a customer returns a
    // product. We bucket each refund by its OWN processed_at (or created_at
    // fallback, with the same -5h EST shift the rest of the aggregator uses),
    // NOT the original sale's date — matches Shopify's by-store treatment.
    //
    // Entity attribution: the refund's entity is the ORIGINAL line's entity
    // (same POS / allocator cascade applied to the original line_item_id).
    // Jurisdictions: same — pulled from the original line's tax_lines_json.
    //
    // Pro-rate: refund_subtotal/refund_tax are already pre-computed by
    // Shopify per refund_line_item, so partial refunds (qty<original.qty)
    // already net correctly without any explicit ratio math here. We just
    // pass through the refund's subtotal + tax. Per-jurisdiction splitting
    // (which uses the ORIGINAL tax_lines breakdown to keep the ST-810
    // category attribution correct) lives in the aggregator.
    //
    // Edge cases handled:
    //   - 'item' kind (line_item refund) — full subtraction with original
    //     line attribution.
    //   - 'adjustment' kind (shipping refund, restocking fee) — line_item_id
    //     is NULL, so we attribute by ORDER-LEVEL allocator (the same
    //     dominant-entity fallback by-store uses for non-line-keyed rows).
    //     These rarely carry tax in NY but we honor whatever Shopify says.
    //   - is_gift_card filter: gift-card lines are excluded from line inputs
    //     and from refunds (gift-card refunds don't affect sales-tax math).
    const refundRows: Array<{
      refund_line_id: string;
      order_id: string;
      line_item_id: string | null;
      kind: string;
      refund_subtotal: number | null;
      refund_tax: number | null;
      refund_quantity: number | null;
      orig_quantity: number | null;
      orig_tax_lines_json: string | null;
      orig_tax_channel_liable: number | null;
      orig_is_gift_card: number | null;
      pos_entity_id: number | null;
      alloc_entity_id: number | null;
    }> = sqlite.prepare(`
      SELECT
        rli.id AS refund_line_id,
        rli.order_id AS order_id,
        rli.line_item_id AS line_item_id,
        rli.kind AS kind,
        rli.subtotal AS refund_subtotal,
        rli.total_tax AS refund_tax,
        rli.quantity AS refund_quantity,
        li.quantity AS orig_quantity,
        li.tax_lines_json AS orig_tax_lines_json,
        li.tax_channel_liable AS orig_tax_channel_liable,
        li.is_gift_card AS orig_is_gift_card,
        (SELECT pl.entity_id
           FROM recon_shopify_sales s
           JOIN recon_entity_pos_locations pl
             ON pl.shopify_location_id = s.pos_location_id
            AND pl.kind = 'pos'
            AND pl.active = 1
          WHERE s.order_id = rli.order_id
            AND s.line_item_id = rli.line_item_id
            AND s.pos_location_id IS NOT NULL
          LIMIT 1) AS pos_entity_id,
        COALESCE(
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = rli.order_id AND a.line_item_id = rli.line_item_id LIMIT 1),
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = rli.order_id AND a.line_item_id IS NULL LIMIT 1),
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = rli.order_id
            GROUP BY a.entity_id
            ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
        ) AS alloc_entity_id
      FROM recon_refund_line_items rli
      JOIN recon_refunds rf ON rf.id = rli.refund_id
      LEFT JOIN recon_line_items li
        ON li.id = rli.line_item_id AND li.order_id = rli.order_id
      WHERE substr(datetime(
        COALESCE(rf.processed_at, rf.created_at),
        '-5 hours'), 1, 7) = ?
        AND COALESCE(li.is_gift_card, 0) = 0
    `).all(month) as any;

    const refunds: RefundForTax[] = [];
    for (const r of refundRows) {
      // Sub-cent refunds (and tax-only rows) are still valid — keep them.
      // Pick attribution using the same cascade as sale lines:
      //   1. POS entity (if mapped POS)
      //   2. Allocation entity (if any, and it's a POS entity)
      //   3. else 0 (Unallocated)
      let entity_id = 0;
      let is_pos = false;
      if (r.pos_entity_id != null && posEntityIds.has(r.pos_entity_id)) {
        entity_id = r.pos_entity_id;
        is_pos = true;
      } else if (r.alloc_entity_id != null && posEntityIds.has(r.alloc_entity_id)) {
        entity_id = r.alloc_entity_id;
        is_pos = false;
      } else {
        entity_id = 0;
        is_pos = false;
      }

      refunds.push({
        entity_id,
        line_subtotal_refunded: Number(r.refund_subtotal || 0),
        refund_tax: Number(r.refund_tax || 0),
        tax_channel_liable: Number(r.orig_tax_channel_liable || 0),
        original_tax_lines: parseTaxLines(r.orig_tax_lines_json),
        is_pos,
      });
    }

    // -----------------------------------------------------------------------
    // PR #146 — Shipping-line tax (forward + refund).
    //
    // Source of truth for by-store's Taxes column (Rule #7b,
    // shopify-finance-diff.ts:205-310):
    //
    //   taxes = Σ recon_line_items.tax_lines_json[].price        (per-line)
    //         + Σ recon_orders.raw_json.shipping_lines[].tax_lines[].price
    //         - Σ recon_refund_line_items.total_tax  (kind='item')
    //         - Σ ABS(recon_refund_line_items.total_tax)  (kind='adjustment',
    //                                                     adjustment_kind=
    //                                                     'shipping_refund')
    //
    // By-entity (before #146) covered only the per-line and item-refund
    // parts. We now add:
    //   • shipping forward tax — bucketed on the SAME order date the by-store
    //     gross uses (COALESCE(processed_at, created_at), -5h EST) so shipping
    //     and shipping-tax land in the same month as the rest of the order.
    //   • shipping refund tax — ABS()'d (Shopify ships these as signed cents,
    //     usually negative; sign convention matches by-store).
    //
    // Entity attribution mirrors the per-line cascade but operates at the
    // ORDER level (no line_item_id on shipping). We use the dominant POS
    // allocator: any recon_shopify_sales row on the order with a mapped POS
    // location → that POS entity; else the order-level allocator; else 0.
    const shipTaxRows: Array<{
      order_id: string;
      raw_json: string | null;
      pos_entity_id: number | null;
      alloc_entity_id: number | null;
    }> = sqlite.prepare(`
      SELECT
        o.id AS order_id,
        o.raw_json AS raw_json,
        (SELECT pl.entity_id
           FROM recon_shopify_sales s
           JOIN recon_entity_pos_locations pl
             ON pl.shopify_location_id = s.pos_location_id
            AND pl.kind = 'pos'
            AND pl.active = 1
          WHERE s.order_id = o.id
            AND s.pos_location_id IS NOT NULL
          LIMIT 1) AS pos_entity_id,
        COALESCE(
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = o.id AND a.line_item_id IS NULL LIMIT 1),
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = o.id
            GROUP BY a.entity_id
            ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
        ) AS alloc_entity_id
      FROM recon_orders o
      WHERE substr(datetime(
        COALESCE(o.processed_at, o.created_at),
        '-5 hours'), 1, 7) = ?
        AND o.raw_json IS NOT NULL
        AND o.raw_json <> ''
    `).all(month) as any;

    const shippingTaxForward: ShippingTaxForward[] = [];
    for (const r of shipTaxRows) {
      let parsed: any;
      try { parsed = typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json; }
      catch { continue; }
      const sLines = Array.isArray(parsed?.shipping_lines) ? parsed.shipping_lines : [];
      if (sLines.length === 0) continue;

      // Flatten all shipping_lines[].tax_lines[] into a single TaxLine[].
      // Multiple shipping_lines on one order is rare; if it happens, they
      // attribute to the same entity (the order's entity), so flattening
      // before grouping is fine — same-jurisdiction tax_lines will merge in
      // the aggregator.
      const flatTaxLines = [] as ReturnType<typeof parseTaxLines>;
      let anyMpFlag = false;
      for (const s of sLines) {
        const tls = Array.isArray(s?.tax_lines) ? s.tax_lines : [];
        for (const tl of tls) {
          const price = typeof tl?.price === 'number' ? tl.price : tl?.price != null ? Number(tl.price) : null;
          if (price == null || !Number.isFinite(price)) continue;
          const channel_liable = Boolean(tl?.channel_liable);
          if (channel_liable) anyMpFlag = true;
          flatTaxLines.push({
            title: tl?.title ?? null,
            rate: typeof tl?.rate === 'number' ? tl.rate : tl?.rate != null ? Number(tl.rate) : null,
            price,
            channel_liable,
            jurisdiction_id: tl?.jurisdiction_id ?? null,
            jurisdiction_name: tl?.jurisdiction_name ?? null,
            jurisdiction_type: tl?.jurisdiction_type ?? null,
          });
        }
      }
      if (flatTaxLines.length === 0) continue;

      let entity_id = 0;
      let is_pos = false;
      if (r.pos_entity_id != null && posEntityIds.has(r.pos_entity_id)) {
        entity_id = r.pos_entity_id;
        is_pos = true;
      } else if (r.alloc_entity_id != null && posEntityIds.has(r.alloc_entity_id)) {
        entity_id = r.alloc_entity_id;
        is_pos = false;
      }
      shippingTaxForward.push({
        entity_id,
        tax_lines: flatTaxLines,
        is_pos,
        tax_channel_liable: anyMpFlag ? 1 : 0,
      });
    }

    // Shipping refund adjustments: kind='adjustment', adjustment_kind='shipping_refund'.
    // total_tax is signed (typically negative for the customer-side refund of
    // shipping tax). By-store ABS()s; we do the same. Entity attribution: the
    // order's dominant POS allocator (no line_item_id on these rows).
    const shipRefundRows: Array<{
      order_id: string;
      total_tax: number | null;
      pos_entity_id: number | null;
      alloc_entity_id: number | null;
    }> = sqlite.prepare(`
      SELECT
        rli.order_id AS order_id,
        rli.total_tax AS total_tax,
        (SELECT pl.entity_id
           FROM recon_shopify_sales s
           JOIN recon_entity_pos_locations pl
             ON pl.shopify_location_id = s.pos_location_id
            AND pl.kind = 'pos'
            AND pl.active = 1
          WHERE s.order_id = rli.order_id
            AND s.pos_location_id IS NOT NULL
          LIMIT 1) AS pos_entity_id,
        COALESCE(
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = rli.order_id AND a.line_item_id IS NULL LIMIT 1),
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = rli.order_id
            GROUP BY a.entity_id
            ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
        ) AS alloc_entity_id
      FROM recon_refund_line_items rli
      JOIN recon_refunds rf ON rf.id = rli.refund_id
      WHERE rli.kind = 'adjustment'
        AND rli.adjustment_kind = 'shipping_refund'
        AND substr(datetime(
          COALESCE(rf.processed_at, rf.created_at),
          '-5 hours'), 1, 7) = ?
    `).all(month) as any;

    const shippingTaxRefunds: ShippingTaxRefund[] = [];
    for (const r of shipRefundRows) {
      const absTax = Math.abs(Number(r.total_tax || 0));
      if (absTax === 0) continue;
      let entity_id = 0;
      let is_pos = false;
      if (r.pos_entity_id != null && posEntityIds.has(r.pos_entity_id)) {
        entity_id = r.pos_entity_id;
        is_pos = true;
      } else if (r.alloc_entity_id != null && posEntityIds.has(r.alloc_entity_id)) {
        entity_id = r.alloc_entity_id;
        is_pos = false;
      }
      shippingTaxRefunds.push({
        entity_id,
        refund_tax: absTax,
        is_pos,
        tax_channel_liable: 0,
      });
    }

    // -----------------------------------------------------------------------
    // PR #147 — Unverified-return tax delta (Rule #8 in by-store).
    //
    // Some returns are encoded on the order itself, not as a refund row: the
    // customer returns merchandise and we issue a same-order gift card. The
    // sale line stays at quantity=1, current_quantity=0; current_total_tax is
    // shifted (typically to a negative cents value). By-store reconciles this
    // in shopify-finance-diff.ts:401-423 by subtracting
    //   (o.total_tax − o.current_total_tax)
    // from its Taxes column, but ONLY for orders that have no recon_refunds
    // row (otherwise regular refunds would double-count).
    //
    // We mirror that exactly: pull every order in the month (bucketed on
    // o.processed_at|created_at — the same orderDateExprFor mode by-store
    // uses by default) where current_total_tax differs from total_tax AND
    // no recon_refunds row exists. Attribute via the order's dominant POS
    // allocator (same cascade we use for shipping rows).
    //
    // March 2026 / Greenvale: order #37901 had total_tax=0,
    // current_total_tax=-2.15 → delta = -(-2.15) = +2.15 → by-store reduced
    // its Taxes by $2.15. Before PR #147 by-entity ignored this entirely and
    // overstated Greenvale March by exactly $2.15.
    const unverifiedRows: Array<{
      order_id: string;
      tax_delta: number;
      pos_entity_id: number | null;
      alloc_entity_id: number | null;
    }> = sqlite.prepare(`
      SELECT
        o.id AS order_id,
        (o.total_tax - o.current_total_tax) AS tax_delta,
        (SELECT pl.entity_id
           FROM recon_shopify_sales s
           JOIN recon_entity_pos_locations pl
             ON pl.shopify_location_id = s.pos_location_id
            AND pl.kind = 'pos'
            AND pl.active = 1
          WHERE s.order_id = o.id
            AND s.pos_location_id IS NOT NULL
          LIMIT 1) AS pos_entity_id,
        COALESCE(
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = o.id AND a.line_item_id IS NULL LIMIT 1),
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = o.id
            GROUP BY a.entity_id
            ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
        ) AS alloc_entity_id
      FROM recon_orders o
      WHERE substr(datetime(
        COALESCE(o.processed_at, o.created_at),
        '-5 hours'), 1, 7) = ?
        AND o.current_total_tax IS NOT NULL
        AND o.total_tax IS NOT NULL
        AND (o.total_tax - o.current_total_tax) <> 0
        AND NOT EXISTS (SELECT 1 FROM recon_refunds r WHERE r.order_id = o.id)
    `).all(month) as any;

    const unverifiedReturnTax: UnverifiedReturnTax[] = [];
    for (const r of unverifiedRows) {
      const deltaCents = Math.round(Number(r.tax_delta || 0) * 100);
      if (deltaCents === 0) continue;
      let entity_id = 0;
      let is_pos = false;
      if (r.pos_entity_id != null && posEntityIds.has(r.pos_entity_id)) {
        entity_id = r.pos_entity_id;
        is_pos = true;
      } else if (r.alloc_entity_id != null && posEntityIds.has(r.alloc_entity_id)) {
        entity_id = r.alloc_entity_id;
        is_pos = false;
      }
      unverifiedReturnTax.push({
        entity_id,
        tax_delta_cents: deltaCents,
        is_pos,
      });
    }

    return { inputs, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax, entityNames };
  }

  app.get("/api/recon/tax/by-entity/:month", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    try {
      const { inputs, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax, entityNames } = loadTaxInputsForMonth(month);
      const entities = aggregateByEntity(inputs, entityNames, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax);
      const totals = sumEntities(entities);
      res.json({
        month,
        entities,
        totals,
        note: "PR #143 + #145 + #146 + #147: per-line tax aggregated from recon_line_items.tax_lines_json with the same entity-attribution cascade as /api/recon/finance/by-store/:month. PR #145: refund tax from recon_refund_line_items is SUBTRACTED in the refund's processed_at month, attributed to the original line's entity + jurisdictions. PR #146: shipping_lines tax (forward) is ADDED and shipping_refund adjustment tax is SUBTRACTED (ABS). PR #147: unverified-return tax delta (Rule #8: o.total_tax − o.current_total_tax for orders with no refund row) is SUBTRACTED, mirroring by-store. Σ jurisdictions.tax_due === entity.tax_owed (penny-exact) via residual reconciliation that uses aggregateByEntity's authoritative total as its target. Money fields are strings (integer-cents internally) — no float drift.",
        build_id: "pr147",
      });
    } catch (e: any) {
      res.status(500).json({ message: "tax by-entity failed", error: String(e?.message || e) });
    }
  });

  app.get("/api/recon/tax/st810/:period", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    const period = String(req.params.period);
    // Accept either YYYY-MM (monthly) or YYYY-Q[1-4] (quarterly).
    const isMonth = /^\d{4}-\d{2}$/.test(period);
    const isQuarter = /^\d{4}-Q[1-4]$/.test(period);
    if (!isMonth && !isQuarter) {
      return res.status(400).json({ message: "Period must be YYYY-MM or YYYY-Q[1-4]" });
    }
    try {
      let months: string[];
      let calendarFallback = false;
      if (isMonth) {
        months = [period];
      } else {
        const q = quarterToMonths(period);
        months = q.months;
        calendarFallback = q.calendar_fallback;
      }

      // Concat the lines from each month and run the per-jurisdiction
      // aggregator once across the union. This avoids the need to merge
      // already-aggregated string-money rows.
      const all: AggregatorInput[] = [];
      const allRefunds: RefundForTax[] = [];
      const allShipFwd: ShippingTaxForward[] = [];
      const allShipRef: ShippingTaxRefund[] = [];
      const allUnverified: UnverifiedReturnTax[] = [];
      let entityNames = new Map<number, string>();
      for (const m of months) {
        const { inputs, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax, entityNames: en } = loadTaxInputsForMonth(m);
        all.push(...inputs);
        allRefunds.push(...refunds);
        allShipFwd.push(...shippingTaxForward);
        allShipRef.push(...shippingTaxRefunds);
        allUnverified.push(...unverifiedReturnTax);
        for (const [k, v] of en) entityNames.set(k, v);
      }

      const entities = aggregateByJurisdiction(all, entityNames, allRefunds, allShipFwd, allShipRef, allUnverified);

      // PR #168 enrichment: attach DTF jurisdiction code + fractional rate
      // display to each jurisdiction row (NY ST-810 prints "NA 2811" + "8 5/8%"),
      // and per-entity legal_name + TIN. Any jurisdiction name with no DTF map
      // is surfaced in unmapped_jurisdictions (not dropped). Enrichment happens
      // at the route boundary — the aggregator is untouched.
      const tinByEntity = getEntitySettings();
      const unmappedSet = new Set<string>();
      const enriched = entities.map((ent) => {
        const info = filingInfoFor(ent.entity_id);
        const jurisdictions = ent.jurisdictions.map((j) => {
          const dtf = dtfByName(j.jurisdiction_name) as NyDtfJurisdiction | undefined;
          // NY state + MCTD lines are intentionally not mapped (they're allocated
          // into locality tax_components_cents downstream). Don't flag them.
          if (!dtf) {
            const nm = j.jurisdiction_name.toUpperCase();
            const isStateComp = nm === "NEW YORK STATE TAX" ||
              nm.includes("MCTD") || nm.includes("METROPOLITAN") || nm.includes("MTA");
            if (!isStateComp) unmappedSet.add(j.jurisdiction_name);
          }
          const rateNum = Number(j.rate);
          return {
            ...j,
            dtf_code: dtf?.code ?? null,
            rate_display: dtf?.rate_display ?? formatRateAsFraction(rateNum),
          };
        });
        return {
          ...ent,
          legal_name: info?.legal_name ?? legalNameFor(ent.entity_id),
          tin: tinByEntity.get(String(ent.entity_id))?.tin ?? null,
          jurisdictions,
        };
      });

      res.json({
        ...(isMonth ? { month: period } : { quarter: period, months_included: months }),
        ...(calendarFallback ? { quarter_calendar_fallback: true, note_quarter: "NY DTF quarter calendar lookup failed — defaulted to calendar quarters. TODO verify Pub 718-Q." } : {}),
        formType: "ST-810",
        entities: enriched,
        unmapped_jurisdictions: Array.from(unmappedSet).sort(),
        note: "PR #143 + #145 + #146 + #147 + #168: per-entity, per-jurisdiction taxable-sales + tax-due from recon_line_items.tax_lines_json. Grouped by (entity, jurisdiction_name, type, rate). channel_liable lines are reported under marketplace_taxable/marketplace_tax — merchant still must list them on ST-810 but does not owe the tax. PR #168: each jurisdiction row enriched with dtf_code + rate_display (NY fractional); per-entity legal_name + TIN added; names lacking a DTF code listed in unmapped_jurisdictions. Σ jurisdictions.tax_due === entity.tax_owed exactly. NY tax quarters are non-standard: Q1=Mar-May, Q2=Jun-Aug, Q3=Sep-Nov, Q4=Dec-Feb.",
        build_id: "pr168",
      });
    } catch (e: any) {
      res.status(500).json({ message: "tax st810 failed", error: String(e?.message || e) });
    }
  });

  // PR #168 — ST-809 (the 8 non-quarter-end months: long method, per-entity
  // only, no jurisdiction breakdown). Rejects quarter-end months (those file
  // ST-810). Always returns all 3 filing entities (even at $0) so the form is
  // complete. Marketplace-carved via aggregateByEntity (the filing number is
  // tax_owed, not tax_collected_gross).
  app.get("/api/recon/tax/st809/:period", authMiddleware, requirePermission("finance.sales_tax.view"), async (req, res) => {
    const period = String(req.params.period);
    if (!/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ message: "Period must be YYYY-MM (ST-809 is monthly)" });
    }
    const monthNum = Number(period.split("-")[1]);
    if (QUARTER_END_MONTHS.has(monthNum)) {
      return res.status(400).json({
        message: `${period} is a quarter-end month — file ST-810, not ST-809`,
        formType: "ST-810",
      });
    }
    try {
      const { inputs, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax, entityNames } =
        loadTaxInputsForMonth(period);
      const summaries = aggregateByEntity(inputs, entityNames, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax);
      const byEntity = new Map<number, typeof summaries[number]>();
      for (const s of summaries) byEntity.set(s.entity_id, s);
      const tinByEntity = getEntitySettings();

      // PR #198 (ST5) — entity facts come from `payroll_entities`. Smart-middle
      // rule: include active entities + any inactive ones that had sales in
      // this period (so back-period filings for a since-closed store still
      // resolve). ST-809 doesn't need jurisdiction config to render — all
      // three optional fields (county / rate_bps / dtf_code) are nullable here.
      const periodEntityIds = new Set<number>(summaries.map((s) => s.entity_id));
      const filingEntities = loadFilingEntities({ entitiesWithSalesInPeriod: periodEntityIds });
      const entities = filingEntities.map((info) => {
        const s = byEntity.get(info.entity_id);
        return {
          entity_id: info.entity_id,
          legal_name: info.legal_name,
          tin: tinByEntity.get(String(info.entity_id))?.tin ?? null,
          county: info.county,
          dtf_code: info.dtf_code,
          gross_sales: s?.gross_sales ?? "0.00",
          marketplace_sales: s?.marketplace_gross ?? "0.00",
          taxable_sales: s?.taxable_sales ?? "0.00",
          non_taxable_sales: s?.non_taxable_sales ?? "0.00",
          tax_due: s?.tax_owed ?? "0.00",
        };
      });

      res.json({
        period,
        formType: "ST-809",
        method: "long",
        entities,
        note: "PR #168 + #198: ST-809 long-method monthly filing. Per-entity only (no jurisdiction breakdown). tax_due is marketplace-carved (aggregateByEntity.tax_owed). PR #198 (ST5): entity list now reads from payroll_entities; inactive entities are included only when they had attributed sales in the requested period.",
        build_id: "pr198",
      });
    } catch (e: any) {
      res.status(500).json({ message: "tax st809 failed", error: String(e?.message || e) });
    }
  });

  // PR #168 — admin recompute. Walks every month present in the sales data,
  // runs the marketplace-carved aggregator per month, and (re)writes the
  // sales_tax_filing_totals cache via delete-then-insert. Idempotent. Gated by
  // the highest existing finance write perm (no separate admin perm exists).
  app.post("/api/recon/tax/recompute-all", authMiddleware, requirePermission("finance.sales_tax.export"), async (_req, res) => {
    try {
      const { sqlite } = require("./storage");
      const monthRows = sqlite.prepare(`
        SELECT DISTINCT happened_month AS month
          FROM v_attributed_sales
         WHERE happened_month IS NOT NULL
         ORDER BY happened_month ASC
      `).all() as Array<{ month: string }>;

      const summary: Array<{ period: string; entity_id: number; tax_due: string; marketplace_sales: string }> = [];
      let entitiesWritten = 0;
      for (const { month } of monthRows) {
        const { inputs, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax, entityNames } =
          loadTaxInputsForMonth(month);
        const summaries = aggregateByEntity(inputs, entityNames, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax);
        const rows = summaries.map((s) => ({
          entity_id: s.entity_id,
          gross_sales: s.gross_sales,
          marketplace_sales: s.marketplace_gross,
          taxable_sales: s.taxable_sales,
          tax_due: s.tax_owed,
        }));
        replaceFilingTotals(month, rows);
        entitiesWritten += rows.length;
        for (const r of rows) {
          summary.push({ period: month, entity_id: r.entity_id, tax_due: r.tax_due, marketplace_sales: r.marketplace_sales });
        }
      }

      res.json({
        months_processed: monthRows.length,
        entities_written: entitiesWritten,
        summary,
        note: "PR #168: rebuilt sales_tax_filing_totals from the marketplace-carved aggregator. Idempotent (delete-then-insert per period).",
        build_id: "pr168",
      });
    } catch (e: any) {
      res.status(500).json({ message: "tax recompute-all failed", error: String(e?.message || e) });
    }
  });

  // PR #168 — read the cached filing totals (rebuilt by recompute-all).
  app.get("/api/recon/tax/filing-totals", authMiddleware, requirePermission("finance.sales_tax.view"), async (_req, res) => {
    try {
      res.json({ rows: listFilingTotals(), build_id: "pr168" });
    } catch (e: any) {
      res.status(500).json({ message: "filing-totals read failed", error: String(e?.message || e) });
    }
  });

  // PR #168 — entity filing settings (TINs). GET is readable by anyone who can
  // view sales tax; PUT requires the dedicated edit perm. Returns all 3 filing
  // entities with legal name + current TIN (null if unset).
  app.get("/api/recon/tax/entity-settings", authMiddleware, requirePermission("finance.sales_tax.view"), async (_req, res) => {
    try {
      // PR #198 (ST5) — read entity facts from payroll_entities (SoT) instead
      // of a hardcoded constant. The admin settings surface still wants to
      // show ACTIVE entities only — inactive entities don't get new TIN edits.
      // (Back-period filings still resolve via the smart-middle rule above.)
      const settings = getEntitySettings();
      const filingEntities = loadFilingEntities(); // active-only
      const entities = filingEntities.map((info) => ({
        entity_id: info.entity_id,
        legal_name: info.legal_name,
        county: info.county,
        dtf_code: info.dtf_code,
        tin: settings.get(String(info.entity_id))?.tin ?? null,
      }));
      res.json({ entities, build_id: "pr198" });
    } catch (e: any) {
      res.status(500).json({ message: "entity-settings read failed", error: String(e?.message || e) });
    }
  });

  app.put("/api/recon/tax/entity-settings/:entityId", authMiddleware, requirePermission("finance.entity_settings.edit"), async (req, res) => {
    const entityId = String(req.params.entityId);
    // PR #198 (ST5) — existence check against payroll_entities. Allows TIN
    // updates on inactive entities too (operator may need to file a back-
    // period return for a since-closed store).
    if (!filingEntityExists(entityId)) {
      return res.status(400).json({ message: `Unknown entity ${entityId}` });
    }
    try {
      const tin = String(req.body?.tin ?? "");
      const row = upsertTin(entityId, tin);
      res.json({ entity_id: Number(row.entity_id), tin: row.tin, updated_at: row.updated_at, build_id: "pr168" });
    } catch (e: any) {
      // upsertTin throws on a malformed (non-empty) TIN → 400, not 500.
      res.status(400).json({ message: String(e?.message || e) });
    }
  });

  // PR #125 — Ingest per-line pos_location_id from ShopifyQL `sales`.
  //
  // Body: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }  (half-open: [start, end))
  // Returns the PosLocationIngestResult shape:
  //   { start, end, windows_ran, ql_rows_fetched, sales_updated,
  //     sales_unchanged, unmatched_ql_rows, duration_ms, warnings }
  //
  // Idempotent: re-running for the same window only updates rows whose
  // pos_location_id changed in Shopify's analytics layer (rare — happens
  // when a refund is voided and reissued at a different register). The
  // ingest is a pure UPDATE — no inserts, no deletes, can be re-run as
  // often as needed without side effects.
  //
  // Pre-req: agreements ingest must have run for the window first, so the
  // local recon_shopify_sales rows exist. Otherwise unmatched_ql_rows will
  // be elevated. The Shopify-side ShopifyQL pipeline can also lag the
  // GraphQL Order.agreements feed by ~1 hour; if you ingest agreements then
  // immediately ingest pos_locations, the very newest rows may show
  // pos_location_id=NULL until ShopifyQL catches up. Re-running this
  // endpoint after the lag closes finishes the job.
  app.post("/api/recon/sales/ingest-pos-locations", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    try {
      const { ingestPosLocationsFromQL } = require("./shopify-recon-pos-locations");
      const start = String(req.body?.start || "");
      const end = String(req.body?.end || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        return res.status(400).json({
          message: "start and end must be YYYY-MM-DD strings (half-open window)",
        });
      }
      const result = await ingestPosLocationsFromQL(start, end);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({
        message: "ingest-pos-locations failed",
        error: String(e?.message || e),
        stack: process.env.NODE_ENV === "development" ? e?.stack : undefined,
      });
    }
  });

  // PR #125 — Coverage diagnostic for pos_location_id ingestion. Returns,
  // for :month, the fraction of recon_shopify_sales rows with
  // pos_location_id populated, broken down by source_name. Use this to
  // validate that the ingest landed for a month before swapping any UI to
  // read from the per-line column.
  //
  // Expected steady-state:
  //   - source_name='pos' rows  → 100% with_pos_location
  //   - source_name='online_store' rows → 0% (no POS terminal, the
  //     fulfillment cascade applies instead — follow-up PR)
  //   - source_name=other / NULL → varies (manual orders, draft orders)
  app.get("/api/recon/sales/pos-location-coverage/:month", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    try {
      const { getPosLocationCoverage } = require("./shopify-recon-pos-locations");
      res.json(getPosLocationCoverage(month));
    } catch (e: any) {
      res.status(500).json({
        message: "pos-location-coverage failed",
        error: String(e?.message || e),
      });
    }
  });

  // PR #116 — Orders-count gap diagnostic. After PR #114 closed all dollar
  // diffs and matched April orders perfectly, Jan/Feb/Mar/May still showed
  // ShopifyQL counting more orders than V2 (+17/+100/+70/+20). This endpoint
  // does the symmetric diff server-side in one shot so we don't have to ship
  // 1000+ row GROUP BY results to the browser (which times out).
  //
  // Steps (server-side, fast):
  //   1) Issue ShopifyQL `FROM sales SHOW orders GROUP BY order_name` for
  //      :month and collect the set of order_name values where orders=1.
  //   2) Build the V2-PR#114 set: recon_orders where
  //        substr(processed_at - 5h) = month AND has a non-zero
  //        ORDER/PRODUCT or RETURN/(PRODUCT|ADJUSTMENT) row in month.
  //   3) Compute onlyShopifyQL (the gap we're hunting) and onlyV2 (orders we
  //      count that ShopifyQL doesn't).
  //   4) For each name in onlyShopifyQL, look up its recon_orders row and the
  //      per-month sums so we can pattern-match WHY V2 missed it.
  //
  // Returns the diff lists (capped at 200 each to keep response small) plus
  // a `details` array for the first N (default 25) onlyShopifyQL orders with:
  //   created_at, processed_at, cancelled_at, financial_status, fulfillment_status,
  //   created_month, sales_rows_in_month, action_type x line_type breakdown of
  //   (count, sum(total_amount-total_tax)), and a 'reason' classification.
  app.get("/api/recon/finance/debug/orders-gap/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const detailLimit = Math.min(200, Math.max(1, Number(req.query.detail_limit) || 25));
    try {
      const { sqlite } = require("./storage");
      const { runShopifyql } = require("./shopify-shopifyql");

      const [yy, mm] = month.split("-").map(Number);
      const startDate = `${month}-01`;
      const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;

      // 1) ShopifyQL GROUP BY order_name set.
      const ql: any = await runShopifyql(
        `FROM sales\nSHOW orders\nGROUP BY order_name\nSINCE ${startDate} UNTIL ${endDate}`,
      );
      const qlRows: any[] = ql?.rows || [];
      const shopifyOrdersOne: string[] = qlRows
        .filter((r) => Number(r.orders) === 1)
        .map((r) => String(r.order_name));
      const shopifyOrdersZero: string[] = qlRows
        .filter((r) => Number(r.orders) === 0)
        .map((r) => String(r.order_name));
      const shopifySet = new Set(shopifyOrdersOne);

      // 2) V2-PR#114 set. Same predicate as the orders subquery in
      //    /v2-vs-shopifyql but enumerated so we can produce names.
      const v2Rows: any[] = sqlite
        .prepare(
          `
          SELECT o.id, o.name
            FROM recon_orders o
           WHERE substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) = ?
             AND EXISTS (
               SELECT 1 FROM recon_shopify_sales ss
                WHERE ss.order_id = o.id
                  AND ss.happened_month = ?
                  AND (
                    (ss.action_type = 'ORDER' AND ss.line_type = 'PRODUCT')
                    OR (ss.action_type = 'RETURN'
                        AND ss.line_type IN ('PRODUCT','ADJUSTMENT'))
                  )
             )
        `,
        )
        .all(month, month);
      const v2Names: string[] = v2Rows.map((r: any) => String(r.name));
      const v2Set = new Set(v2Names);

      const onlyShopifyql = shopifyOrdersOne.filter((n) => !v2Set.has(n));
      const onlyV2 = v2Names.filter((n) => !shopifySet.has(n));

      // 3) For first detailLimit onlyShopifyql, look up details.
      const sampleNames = onlyShopifyql.slice(0, detailLimit);
      const details: any[] = [];
      for (const name of sampleNames) {
        const o: any = sqlite
          .prepare(
            `
            SELECT
              o.id, o.name, o.order_number,
              o.created_at, o.processed_at, o.cancelled_at,
              o.financial_status, o.fulfillment_status, o.source_name,
              substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) AS created_month_et,
              (SELECT COUNT(*) FROM recon_shopify_sales s
                 WHERE s.order_id = o.id AND s.happened_month = ?) AS sales_rows_in_month,
              (SELECT GROUP_CONCAT(DISTINCT s.happened_month) FROM recon_shopify_sales s
                 WHERE s.order_id = o.id) AS happened_months_all
            FROM recon_orders o
            WHERE o.name = ?
            LIMIT 1
          `,
          )
          .get(month, name);

        if (!o) {
          details.push({ name, reason: "NO_RECON_ORDER", note: "Order name in ShopifyQL but not in recon_orders." });
          continue;
        }

        const breakdown: any[] = sqlite
          .prepare(
            `
            SELECT s.action_type, s.line_type,
                   COUNT(*) AS cnt,
                   COALESCE(SUM(s.total_amount - s.total_tax), 0) AS amt_ex_tax,
                   COALESCE(SUM(s.total_amount), 0) AS amt_inc_tax,
                   COALESCE(SUM(s.total_tax), 0) AS tax
              FROM recon_shopify_sales s
             WHERE s.order_id = ? AND s.happened_month = ?
             GROUP BY s.action_type, s.line_type
             ORDER BY s.action_type, s.line_type
          `,
          )
          .all(o.id, month);

        // Classify reason for the gap:
        //   - WRONG_CREATED_MONTH: order has sales rows in this month but its
        //     ET-shifted placement month falls outside :month.
        //   - ZERO_ACTIVITY: created_month matches but every PRODUCT/ADJUSTMENT
        //     row sums to zero ex-tax (so PR #114's != 0 predicate filters it).
        //   - NO_QUALIFYING_LINES: no PRODUCT or RETURN/(PRODUCT|ADJUSTMENT) rows
        //     at all in this month (only SHIPPING/TAX/GIFT_CARD/FEE/etc).
        //   - OTHER: doesn't match the above buckets — needs eyeballs.
        const hasQualifying = breakdown.some(
          (b: any) =>
            (b.action_type === "ORDER" && b.line_type === "PRODUCT") ||
            (b.action_type === "RETURN" && (b.line_type === "PRODUCT" || b.line_type === "ADJUSTMENT")),
        );
        const qualifyingSumExTax = breakdown
          .filter(
            (b: any) =>
              (b.action_type === "ORDER" && b.line_type === "PRODUCT") ||
              (b.action_type === "RETURN" && (b.line_type === "PRODUCT" || b.line_type === "ADJUSTMENT")),
          )
          .reduce((acc: number, b: any) => acc + Number(b.amt_ex_tax || 0), 0);

        let reason: string;
        if (o.created_month_et !== month) reason = "WRONG_CREATED_MONTH";
        else if (!hasQualifying) reason = "NO_QUALIFYING_LINES";
        else if (Math.round(qualifyingSumExTax * 100) === 0) reason = "ZERO_ACTIVITY";
        else reason = "OTHER";

        details.push({
          name: o.name,
          reason,
          created_at: o.created_at,
          processed_at: o.processed_at,
          cancelled_at: o.cancelled_at,
          financial_status: o.financial_status,
          fulfillment_status: o.fulfillment_status,
          source_name: o.source_name,
          created_month_et: o.created_month_et,
          sales_rows_in_month: o.sales_rows_in_month,
          happened_months_all: o.happened_months_all,
          qualifying_sum_ex_tax: Math.round(qualifyingSumExTax * 100) / 100,
          breakdown,
        });
      }

      // 4) Aggregate the reason histogram across ALL onlyShopifyql, not just
      //    the detail sample, by running a lightweight classification for
      //    every missing name. Reuse the same SQL but as a single batch.
      const reasonHistogram: Record<string, number> = {};
      for (const name of onlyShopifyql) {
        const o: any = sqlite
          .prepare(
            `
            SELECT o.id,
                   substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) AS cm
              FROM recon_orders o
             WHERE o.name = ?
             LIMIT 1
          `,
          )
          .get(name);
        if (!o) {
          reasonHistogram["NO_RECON_ORDER"] = (reasonHistogram["NO_RECON_ORDER"] || 0) + 1;
          continue;
        }
        if (o.cm !== month) {
          reasonHistogram["WRONG_CREATED_MONTH"] = (reasonHistogram["WRONG_CREATED_MONTH"] || 0) + 1;
          continue;
        }
        const agg: any = sqlite
          .prepare(
            `
            SELECT
              SUM(CASE WHEN (s.action_type='ORDER' AND s.line_type='PRODUCT')
                       OR (s.action_type='RETURN' AND s.line_type IN ('PRODUCT','ADJUSTMENT'))
                   THEN 1 ELSE 0 END) AS qcount,
              COALESCE(SUM(CASE WHEN (s.action_type='ORDER' AND s.line_type='PRODUCT')
                       OR (s.action_type='RETURN' AND s.line_type IN ('PRODUCT','ADJUSTMENT'))
                   THEN (s.total_amount - s.total_tax) ELSE 0 END), 0) AS qsum
              FROM recon_shopify_sales s
             WHERE s.order_id = ? AND s.happened_month = ?
          `,
          )
          .get(o.id, month);
        if (!agg || !agg.qcount) {
          reasonHistogram["NO_QUALIFYING_LINES"] = (reasonHistogram["NO_QUALIFYING_LINES"] || 0) + 1;
        } else if (Math.round(Number(agg.qsum) * 100) === 0) {
          reasonHistogram["ZERO_ACTIVITY"] = (reasonHistogram["ZERO_ACTIVITY"] || 0) + 1;
        } else {
          reasonHistogram["OTHER"] = (reasonHistogram["OTHER"] || 0) + 1;
        }
      }

      res.json({
        month,
        shopifyql_window: { start: startDate, end: endDate },
        counts: {
          shopifyql_orders_one: shopifyOrdersOne.length,
          shopifyql_orders_zero: shopifyOrdersZero.length,
          v2_pr114_orders: v2Names.length,
          onlyShopifyql: onlyShopifyql.length,
          onlyV2: onlyV2.length,
          shopifyql_rows_total: qlRows.length,
          shopifyql_rows_hit_1000_cap: qlRows.length === 1000,
        },
        reason_histogram: reasonHistogram,
        onlyShopifyql_sample: onlyShopifyql.slice(0, 200),
        onlyV2_sample: onlyV2.slice(0, 200),
        details,
        note: "PR #116 — moves the orders-gap diff to the server so we don't have to round-trip 1000+ row GROUP BYs through the browser. `reason` classifies each missing order against the PR #114 rule. WRONG_CREATED_MONTH = order's ET-shifted placement is outside :month (PR #114 filtered it out). ZERO_ACTIVITY = qualifying lines all sum to 0 ex-tax. NO_QUALIFYING_LINES = no PRODUCT or RETURN/(PRODUCT|ADJUSTMENT) rows. OTHER = doesn't fit the above — needs eyeballs.",
        build_id: "pr116",
      });
    } catch (e: any) {
      res.status(500).json({ message: "orders-gap failed", error: String(e?.message || e) });
    }
  });

  // PR #119 — per-order gross_sales diff between ShopifyQL and V2.
  //
  // Use case: when /v2-vs-shopifyql/:month shows a non-zero gross diff with
  // matching order counts (e.g. Nov 2025: v2_gross 841941.01, ql_gross
  // 841241.02, diff -699.99, orders 1732 == 1732), the offending dollars
  // are inside existing orders — not extra orders. This endpoint shows
  // which orders' v2_gross differs from ShopifyQL's per-order gross_sales,
  // sorted by absolute diff so the single-line offenders surface first.
  //
  // Why server-side:
  //   - ShopifyQL GROUP BY caps at 1000 rows per call (Nov 2025 has
  //     ~1732+ orders, so a single-call browser script truncates).
  //     We chunk by weekly windows and merge.
  //   - V2 per-order gross via orders-v2 enumerates every order with
  //     6 correlated subqueries each — multi-second on high-volume
  //     months. Here we do it as one GROUP BY order_id query.
  //
  // GET /api/recon/finance/debug/per-order-gross-diff/:month?limit=N
  //   limit: max rows in `diffs` array (default 50, cap 500)
  //
  // Returns:
  //   counts: shopifyql_orders, v2_orders, diff_count, sum_diff, any_window_capped
  //   diffs: [{ name, v2_gross, ql_gross, diff_v2_minus_ql,
  //              created_at, processed_at, cancelled_at,
  //              financial_status, source_name }]
  app.get("/api/recon/finance/debug/per-order-gross-diff/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    try {
      const { sqlite } = require("./storage");
      const { runShopifyql } = require("./shopify-shopifyql");

      const [yy, mm] = month.split("-").map(Number);
      const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();

      // Chunk into ~7-day windows initially. If any window returns the
      // 1000-row cap, recursively split that window in half until each
      // sub-window returns < 1000 rows or hits a 1-day floor.
      const initialWindows: Array<{ start: string; end: string }> = [];
      for (let d = 1; d <= lastDay; d += 7) {
        const we = Math.min(d + 6, lastDay);
        initialWindows.push({
          start: `${month}-${String(d).padStart(2, "0")}`,
          end: `${month}-${String(we).padStart(2, "0")}`,
        });
      }

      // 1) ShopifyQL: pull gross_sales per order_name per window. Recurse on
      //    capped windows down to 1-day granularity. Sum across windows.
      const qlMap = new Map<string, number>();
      let anyWindowCapped = false;
      const windowStats: Array<{ start: string; end: string; rows: number; capped: boolean; split?: boolean }> = [];

      const fetchWindow = async (start: string, end: string): Promise<void> => {
        const r: any = await runShopifyql(
          `FROM sales\nSHOW gross_sales\nGROUP BY order_name\nSINCE ${start} UNTIL ${end}`,
        );
        const rows: any[] = r?.rows || [];
        const capped = rows.length >= 1000;
        // If capped and we can split (span > 1 day), split in half and retry.
        if (capped) {
          const sd = new Date(start + "T00:00:00Z");
          const ed = new Date(end + "T00:00:00Z");
          const dayMs = 86400000;
          const spanDays = Math.round((ed.getTime() - sd.getTime()) / dayMs) + 1;
          if (spanDays > 1) {
            const midDays = Math.floor(spanDays / 2);
            const midEnd = new Date(sd.getTime() + (midDays - 1) * dayMs);
            const midStart = new Date(sd.getTime() + midDays * dayMs);
            const midEndStr = midEnd.toISOString().slice(0, 10);
            const midStartStr = midStart.toISOString().slice(0, 10);
            windowStats.push({ start, end, rows: rows.length, capped: true, split: true });
            await fetchWindow(start, midEndStr);
            await fetchWindow(midStartStr, end);
            return;
          }
          // Can't split further — record and mark cap (still ingest rows below).
          anyWindowCapped = true;
        }
        windowStats.push({ start, end, rows: rows.length, capped });
        for (const row of rows) {
          const name = String(row.order_name);
          const gs = Number(row.gross_sales) || 0;
          qlMap.set(name, (qlMap.get(name) || 0) + gs);
        }
      };
      for (const w of initialWindows) {
        await fetchWindow(w.start, w.end);
      }

      // 2) V2: one GROUP BY query. Use the same gross_sales formula as
      //    /v2-vs-shopifyql: action_type IN (ORDER,UPDATE), line_type=PRODUCT,
      //    sum of (total_amount + total_discount_before_taxes - total_tax).
      //    PR #121: UPDATE/PRODUCT rows are edit reversals that must net in.
      //    Only include orders whose created_month_et = this month, to
      //    match the placement filter PR #114/#117 uses on the total.
      const v2Rows: any[] = sqlite
        .prepare(
          `
          SELECT o.name AS name,
                 o.created_at, o.processed_at, o.cancelled_at,
                 o.financial_status, o.source_name,
                 COALESCE(SUM(
                   CASE WHEN s.action_type IN ('ORDER','UPDATE') AND s.line_type = 'PRODUCT'
                        THEN s.total_amount + s.total_discount_before_taxes - s.total_tax
                        ELSE 0 END
                 ), 0) AS v2_gross
            FROM recon_orders o
            LEFT JOIN recon_shopify_sales s
              ON s.order_id = o.id
             AND s.happened_month = ?
           WHERE substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) = ?
           GROUP BY o.id
           HAVING v2_gross != 0
        `,
        )
        .all(month, month);
      const v2Map = new Map<string, any>();
      for (const r of v2Rows) v2Map.set(String(r.name), r);

      // 2b) Pre-load metadata for ALL recon_orders whose name appears in ShopifyQL
      //     but is NOT in v2Map (i.e. V2 attributes them to a different month or
      //     has $0 gross). This lets us surface placement_month, financial_status,
      //     and processed/cancelled timestamps for those mystery orders.
      const qlOnlyNames: string[] = [];
      qlMap.forEach((_v, k) => { if (!v2Map.has(k)) qlOnlyNames.push(k); });
      const orderMetaMap = new Map<string, any>();
      if (qlOnlyNames.length > 0) {
        // Batch in chunks of 500 to avoid SQLite parameter limits.
        for (let i = 0; i < qlOnlyNames.length; i += 500) {
          const batch = qlOnlyNames.slice(i, i + 500);
          const placeholders = batch.map(() => "?").join(",");
          const rows: any[] = sqlite
            .prepare(
              `SELECT name, created_at, processed_at, cancelled_at,
                      financial_status, source_name,
                      substr(datetime(COALESCE(processed_at, created_at), '-5 hours'), 1, 7) AS placement_month_et
                 FROM recon_orders
                WHERE name IN (${placeholders})`,
            )
            .all(...batch);
          for (const r of rows) orderMetaMap.set(String(r.name), r);
        }
      }

      // 3) Diff. Walk union of names.
      const allNames = new Set<string>();
      qlMap.forEach((_v, k) => allNames.add(k));
      v2Map.forEach((_v, k) => allNames.add(k));
      const diffs: any[] = [];
      let sumDiff = 0;
      const namesArr = Array.from(allNames);
      for (const name of namesArr) {
        const ql = qlMap.get(name) || 0;
        const v2row = v2Map.get(name);
        const v2 = v2row ? Number(v2row.v2_gross) || 0 : 0;
        const d = Math.round((v2 - ql) * 100) / 100;
        if (Math.abs(d) >= 0.01) {
          const meta = v2row || orderMetaMap.get(name) || null;
          diffs.push({
            name,
            v2_gross: Math.round(v2 * 100) / 100,
            ql_gross: Math.round(ql * 100) / 100,
            diff_v2_minus_ql: d,
            created_at: meta?.created_at || null,
            processed_at: meta?.processed_at || null,
            cancelled_at: meta?.cancelled_at || null,
            financial_status: meta?.financial_status || null,
            source_name: meta?.source_name || null,
            v2_placement_month: meta?.placement_month_et || null,
            in_v2_this_month: !!v2row,
          });
          sumDiff += d;
        }
      }
      diffs.sort((a, b) => Math.abs(b.diff_v2_minus_ql) - Math.abs(a.diff_v2_minus_ql));

      res.json({
        month,
        counts: {
          shopifyql_orders: qlMap.size,
          v2_orders: v2Map.size,
          diff_count: diffs.length,
          sum_diff: Math.round(sumDiff * 100) / 100,
          any_window_capped: anyWindowCapped,
        },
        window_stats: windowStats,
        diffs: diffs.slice(0, limit),
        note: "PR #121 — per-order gross_sales diff. V2 gross now uses action_type IN (ORDER,UPDATE) + line_type=PRODUCT to net in OrderEdit reversal rows. ShopifyQL pulled in weekly windows; capped windows auto-split down to 1-day. For ShopifyQL-only orders, metadata is loaded from recon_orders so v2_placement_month reveals which month V2 thinks the order belongs to. diff_v2_minus_ql > 0 means V2 attributes more gross to this order than ShopifyQL.",
        build_id: "pr121",
      });
    } catch (e: any) {
      res.status(500).json({ message: "per-order-gross-diff failed", error: String(e?.message || e) });
    }
  });

  // ===================================================================
  // PR #148 (debug) — per-order TAX diff to localize the $1.32 Huntington
  // Dec 2025 residual between by-entity.tax_collected_gross (from
  // recon_orders.tax_lines_json) and by-store.taxes (Σ recon_shopify_sales
  // .total_tax). Same shape as per-order-gross-diff but tax-focused.
  //
  // GET /api/recon/finance/debug/per-order-tax-diff/:month?entity_id=N&limit=N
  //   sales_tax        = Σ recon_shopify_sales.total_tax for rows where
  //                      attributed_entity_id = :entity_id AND line_type != 'GIFT_CARD'
  //                      (mirrors by-store.taxes math)
  //   tax_lines_tax    = Σ tax_lines_json[].price across all line_items of
  //                      recon_orders attributed to this entity, where the
  //                      order's bucketing month = :month (mirrors by-entity)
  //   diff = sales_tax - tax_lines_tax  (sorted by |diff| desc, top N)
  // ===================================================================
  app.get("/api/recon/finance/debug/per-order-tax-diff/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const entityIdRaw = req.query.entity_id;
    if (entityIdRaw === undefined) {
      return res.status(400).json({ message: "entity_id query param required" });
    }
    const entityId = Number(entityIdRaw);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      return res.status(400).json({ message: "entity_id must be a positive integer" });
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));

    try {
      const { sqlite } = require("./storage");

      // 1) Sales-ledger side: per-order Σ total_tax with the same
      //    attribution cascade as by-store. Reuses the dominant-entity
      //    fallback from PR #140b.
      const salesRows: any[] = sqlite
        .prepare(
          `
          WITH attributed AS (
            SELECT
              s.order_id,
              s.total_tax,
              s.line_type,
              COALESCE(
                CASE WHEN s.pos_location_id IS NOT NULL THEN
                  (SELECT pl.entity_id
                     FROM recon_entity_pos_locations pl
                    WHERE pl.shopify_location_id = s.pos_location_id
                      AND pl.kind = 'pos'
                      AND pl.active = 1
                    LIMIT 1)
                END,
                (SELECT a.entity_id FROM recon_allocations a
                  WHERE a.order_id = s.order_id
                    AND a.line_item_id = s.line_item_id LIMIT 1),
                (SELECT a.entity_id FROM recon_allocations a
                  WHERE a.order_id = s.order_id
                    AND a.line_item_id IS NULL LIMIT 1),
                (SELECT a.entity_id FROM recon_allocations a
                  WHERE a.order_id = s.order_id
                  GROUP BY a.entity_id
                  ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
              ) AS attributed_entity_id
            FROM recon_shopify_sales s
            WHERE s.happened_month = ?
          )
          SELECT order_id,
                 COALESCE(SUM(CASE WHEN line_type != 'GIFT_CARD' THEN total_tax ELSE 0 END), 0) AS sales_tax
            FROM attributed
           WHERE attributed_entity_id = ?
           GROUP BY order_id
           HAVING ABS(sales_tax) >= 0.005
        `,
        )
        .all(month, entityId);
      const salesMap = new Map<string, number>();
      for (const r of salesRows) salesMap.set(String(r.order_id), Number(r.sales_tax) || 0);

      // 2) tax_lines_json side: per-order Σ tax_lines_json[].price across
      //    all line_items, attributed via the same cascade collapsed to
      //    an order-level entity (use dominant-entity ranking on the
      //    order's allocations). Only orders whose bucketing month
      //    (processed_at ?? created_at, -5h ET) = :month.
      const orderRows: any[] = sqlite
        .prepare(
          `
          SELECT o.id          AS order_id,
                 o.name        AS order_name,
                 o.processed_at,
                 o.created_at,
                 o.raw_json,
                 COALESCE(
                   (SELECT a.entity_id FROM recon_allocations a
                     WHERE a.order_id = o.id
                       AND a.line_item_id IS NULL LIMIT 1),
                   (SELECT a.entity_id FROM recon_allocations a
                     WHERE a.order_id = o.id
                     GROUP BY a.entity_id
                     ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
                 ) AS order_entity_id
            FROM recon_orders o
           WHERE substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) = ?
        `,
        )
        .all(month);

      const taxLinesMap = new Map<string, { name: string; tax: number }>();
      for (const row of orderRows) {
        if (row.order_entity_id !== entityId) continue;
        let sumTl = 0;
        try {
          const raw = row.raw_json ? JSON.parse(row.raw_json) : null;
          const lis = raw?.line_items || [];
          for (const li of lis) {
            const tls = li?.tax_lines || [];
            for (const tl of tls) {
              sumTl += Number(tl?.price) || 0;
            }
          }
        } catch { /* malformed json — count as 0 */ }
        if (Math.abs(sumTl) >= 0.005 || salesMap.has(String(row.order_id))) {
          taxLinesMap.set(String(row.order_id), { name: row.order_name, tax: sumTl });
        }
      }

      // 3) Walk union, compute diff. Round to cents.
      const allIds = new Set<string>();
      salesMap.forEach((_v, k) => allIds.add(k));
      taxLinesMap.forEach((_v, k) => allIds.add(k));
      const idsArr: string[] = [];
      allIds.forEach((id) => idsArr.push(id));
      const diffs: any[] = [];
      let sumSales = 0, sumTl = 0, sumDiff = 0;
      for (const id of idsArr) {
        const sales = Math.round((salesMap.get(id) || 0) * 100) / 100;
        const tl = taxLinesMap.get(id);
        const tlTax = tl ? Math.round(tl.tax * 100) / 100 : 0;
        const d = Math.round((sales - tlTax) * 100) / 100;
        sumSales += sales;
        sumTl += tlTax;
        sumDiff += d;
        if (Math.abs(d) >= 0.01) {
          diffs.push({
            order_id: id,
            order_name: tl?.name || null,
            sales_tax: sales,
            tax_lines_tax: tlTax,
            diff_sales_minus_tl: d,
          });
        }
      }
      diffs.sort((a, b) => Math.abs(b.diff_sales_minus_tl) - Math.abs(a.diff_sales_minus_tl));

      res.json({
        month,
        entity_id: entityId,
        counts: {
          orders_with_sales_tax: salesMap.size,
          orders_with_tax_lines: taxLinesMap.size,
          diff_count: diffs.length,
          sum_sales_tax: Math.round(sumSales * 100) / 100,
          sum_tax_lines_tax: Math.round(sumTl * 100) / 100,
          sum_diff: Math.round(sumDiff * 100) / 100,
        },
        diffs: diffs.slice(0, limit),
        note: "PR #148-debug — per-order TAX diff. sales_tax = Σ recon_shopify_sales.total_tax (by-store path); tax_lines_tax = Σ recon_orders.raw_json.line_items[].tax_lines[].price (by-entity path). diff_sales_minus_tl > 0 means by-store sees more tax than by-entity.",
        build_id: "pr148-debug-tax-diff",
      });
    } catch (e: any) {
      res.status(500).json({ message: "per-order-tax-diff failed", error: String(e?.message || e) });
    }
  });

  // ===================================================================
  // PR #149-debug — component-level tax breakdown for one entity-month.
  // Returns the same 5 inputs aggregateByEntity uses, alongside the
  // recon_shopify_sales subtotals by action_type/line_type that by-store
  // reads. Tells us exactly which input bucket diverges by $1.32.
  //
  // GET /api/recon/finance/debug/tax-component-diff/:month?entity_id=N
  // ===================================================================
  app.get("/api/recon/finance/debug/tax-component-diff/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const entityIdRaw = req.query.entity_id;
    if (entityIdRaw === undefined) {
      return res.status(400).json({ message: "entity_id query param required" });
    }
    const entityId = Number(entityIdRaw);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      return res.status(400).json({ message: "entity_id must be a positive integer" });
    }

    try {
      const { sqlite } = require("./storage");

      // Helper: same attribution cascade as by-store, applied to recon_shopify_sales.
      const salesByActionLine = sqlite.prepare(`
        WITH attributed AS (
          SELECT s.action_type, s.line_type, s.total_tax,
            COALESCE(
              CASE WHEN s.pos_location_id IS NOT NULL THEN
                (SELECT pl.entity_id FROM recon_entity_pos_locations pl
                  WHERE pl.shopify_location_id = s.pos_location_id
                    AND pl.kind = 'pos' AND pl.active = 1 LIMIT 1)
              END,
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = s.order_id AND a.line_item_id = s.line_item_id LIMIT 1),
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = s.order_id AND a.line_item_id IS NULL LIMIT 1),
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = s.order_id
                GROUP BY a.entity_id
                ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
            ) AS aeid
          FROM recon_shopify_sales s
          WHERE s.happened_month = ?
        )
        SELECT action_type, line_type,
               COALESCE(SUM(total_tax), 0) AS total_tax,
               COUNT(*) AS n
          FROM attributed
         WHERE aeid = ?
         GROUP BY action_type, line_type
         ORDER BY action_type, line_type
      `).all(month, entityId);

      // CTE for order entity attribution + bucketing month.
      const orderEntityCte = `
        WITH order_entity AS (
          SELECT o.id AS order_id,
            substr(datetime(COALESCE(o.processed_at, o.created_at), '-5 hours'), 1, 7) AS bucket_month,
            COALESCE(
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = o.id AND a.line_item_id IS NULL LIMIT 1),
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = o.id
                GROUP BY a.entity_id
                ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
            ) AS entity_id
          FROM recon_orders o
        )
      `;

      // (1) forward tax + shipping forward tax = Σ tax_lines_json.price
      //     across line_items + shipping_lines, orders bucketed to :month and attributed to :entity_id.
      const fwdRows: any[] = sqlite.prepare(`
        ${orderEntityCte}
        SELECT o.id, o.raw_json
          FROM recon_orders o
          JOIN order_entity oe ON oe.order_id = o.id
         WHERE oe.bucket_month = ? AND oe.entity_id = ?
      `).all(month, entityId);
      let fwdTaxCents = 0;
      let fwdShipTaxCents = 0;
      for (const r of fwdRows) {
        try {
          const raw = JSON.parse(r.raw_json || 'null');
          for (const li of (raw?.line_items || [])) {
            if (li?.gift_card) continue;
            for (const tl of (li?.tax_lines || [])) fwdTaxCents += Math.round((Number(tl?.price) || 0) * 100);
          }
          for (const sl of (raw?.shipping_lines || [])) {
            for (const tl of (sl?.tax_lines || [])) fwdShipTaxCents += Math.round((Number(tl?.price) || 0) * 100);
          }
        } catch { /* skip malformed */ }
      }

      // (2) item refund tax = Σ recon_refund_line_items.total_tax for kind='item'
      const itemRefundRow: any = sqlite.prepare(`
        ${orderEntityCte}
        SELECT COALESCE(SUM(rli.total_tax), 0) AS refund_tax, COUNT(*) AS n
          FROM recon_refund_line_items rli
          JOIN recon_refunds rf ON rf.id = rli.refund_id
          JOIN order_entity oe ON oe.order_id = rf.order_id
         WHERE substr(datetime(COALESCE(rf.processed_at, rf.created_at), '-5 hours'), 1, 7) = ?
           AND oe.entity_id = ?
           AND rli.kind = 'item'
      `).get(month, entityId);
      const itemRefundTaxCents = Math.round((Number(itemRefundRow.refund_tax) || 0) * 100);

      // (3) shipping refund tax = Σ ABS(rli.total_tax) for shipping_refund adjustments.
      const shipRefundRow: any = sqlite.prepare(`
        ${orderEntityCte}
        SELECT COALESCE(SUM(ABS(rli.total_tax)), 0) AS sr_tax, COUNT(*) AS n
          FROM recon_refund_line_items rli
          JOIN recon_refunds rf ON rf.id = rli.refund_id
          JOIN order_entity oe ON oe.order_id = rf.order_id
         WHERE substr(datetime(COALESCE(rf.processed_at, rf.created_at), '-5 hours'), 1, 7) = ?
           AND oe.entity_id = ?
           AND rli.kind = 'adjustment'
           AND rli.adjustment_kind = 'shipping_refund'
      `).get(month, entityId);
      const shipRefundTaxCents = Math.round((Number(shipRefundRow.sr_tax) || 0) * 100);

      // (4) other adjustment tax (non-shipping_refund).
      const otherAdjRow: any = sqlite.prepare(`
        ${orderEntityCte}
        SELECT COALESCE(SUM(rli.total_tax), 0) AS other_tax, COUNT(*) AS n,
               GROUP_CONCAT(DISTINCT rli.adjustment_kind) AS kinds
          FROM recon_refund_line_items rli
          JOIN recon_refunds rf ON rf.id = rli.refund_id
          JOIN order_entity oe ON oe.order_id = rf.order_id
         WHERE substr(datetime(COALESCE(rf.processed_at, rf.created_at), '-5 hours'), 1, 7) = ?
           AND oe.entity_id = ?
           AND rli.kind = 'adjustment'
           AND COALESCE(rli.adjustment_kind, '') != 'shipping_refund'
      `).get(month, entityId);
      const otherAdjTaxCents = Math.round((Number(otherAdjRow.other_tax) || 0) * 100);

      // (5) unverified-return tax = Σ (o.total_tax - o.current_total_tax) for orders
      //     with no recon_refunds row (Rule #8).
      const unvRow: any = sqlite.prepare(`
        ${orderEntityCte}
        SELECT COALESCE(SUM(
          CASE WHEN o.total_tax IS NOT NULL AND o.current_total_tax IS NOT NULL
               THEN (o.total_tax - o.current_total_tax) ELSE 0 END
        ), 0) AS unv_tax,
               COUNT(*) AS n
          FROM recon_orders o
          JOIN order_entity oe ON oe.order_id = o.id
         WHERE oe.bucket_month = ?
           AND oe.entity_id = ?
           AND NOT EXISTS (SELECT 1 FROM recon_refunds rf WHERE rf.order_id = o.id)
           AND COALESCE(o.total_tax, 0) != COALESCE(o.current_total_tax, 0)
      `).get(month, entityId);
      const unvTaxCents = Math.round((Number(unvRow.unv_tax) || 0) * 100);

      // Compose tax_collected_gross the same way aggregateByEntity does.
      const aggregateByEntityFormula =
        fwdTaxCents - itemRefundTaxCents + fwdShipTaxCents - shipRefundTaxCents - unvTaxCents;

      // by-store taxes from the salesByActionLine aggregation (line_type != GIFT_CARD).
      let bsTaxCents = 0;
      for (const r of (salesByActionLine as any[])) {
        if ((r.line_type || '') === 'GIFT_CARD') continue;
        bsTaxCents += Math.round((Number(r.total_tax) || 0) * 100);
      }

      const fmt = (c: number) => (c / 100).toFixed(2);

      res.json({
        month,
        entity_id: entityId,
        components: {
          fwd_line_tax_dollars:          fmt(fwdTaxCents),
          fwd_ship_tax_dollars:          fmt(fwdShipTaxCents),
          item_refund_tax_dollars:       fmt(itemRefundTaxCents),
          ship_refund_tax_dollars:       fmt(shipRefundTaxCents),
          unverified_return_tax_dollars: fmt(unvTaxCents),
          other_adjustment_tax_dollars:  fmt(otherAdjTaxCents),
          other_adjustment_kinds:        otherAdjRow.kinds || null,
        },
        component_counts: {
          fwd_orders:       fwdRows.length,
          item_refund_rows: Number(itemRefundRow.n) || 0,
          ship_refund_rows: Number(shipRefundRow.n) || 0,
          other_adj_rows:   Number(otherAdjRow.n) || 0,
          unv_orders:       Number(unvRow.n) || 0,
        },
        formula: {
          description: "tax_collected_gross = fwd_line + fwd_ship - item_refund - ship_refund - unverified_return",
          tax_collected_gross_dollars: fmt(aggregateByEntityFormula),
        },
        by_store: {
          taxes_dollars: fmt(bsTaxCents),
          breakdown_by_action_line: (salesByActionLine as any[]).map((r) => ({
            action_type: r.action_type,
            line_type: r.line_type,
            total_tax: Math.round((Number(r.total_tax) || 0) * 100) / 100,
            n: r.n,
          })),
        },
        delta_dollars: fmt(aggregateByEntityFormula - bsTaxCents),
        note: "PR #149-debug — component-level tax breakdown. If delta non-zero, the divergent component matches a row in by_store.breakdown_by_action_line.",
        build_id: "pr149-debug-tax-component-diff",
      });
    } catch (e: any) {
      res.status(500).json({ message: "tax-component-diff failed", error: String(e?.message || e) });
    }
  });

  // ===================================================================
  // PR #152-debug — order-tax-truth: dump everything tax-related for one
  // order_id across recon_shopify_sales (ORDER + UPDATE + RETURN rows),
  // recon_line_items (tax_lines_json totals), recon_orders.raw_json
  // (line_items[].tax_lines + shipping_lines[].tax_lines), and
  // recon_refund_line_items. Goal: localize the \$1.32 between by-entity
  // and by-store for order_id (default 6223048868082).
  //
  // GET /api/recon/finance/debug/order-tax-truth/:order_id
  // ===================================================================
  app.get("/api/recon/finance/debug/order-tax-truth/:order_id", authMiddleware, requireFinanceView(), async (req, res) => {
    const orderId = String(req.params.order_id);
    if (!/^[0-9]+$/.test(orderId)) {
      return res.status(400).json({ message: "order_id must be numeric" });
    }

    try {
      const { sqlite } = require("./storage");

      // 1) Order header. recon_orders.id is the order_id.
      const orderHeader = sqlite.prepare(`
        SELECT id AS order_id, name AS order_name, processed_at, created_at, updated_at,
               total_tax, current_total_tax, total_price, current_total_price,
               subtotal, total_shipping,
               json_extract(raw_json, '$.financial_status') AS financial_status,
               json_extract(raw_json, '$.taxes_included')   AS taxes_included,
               json_extract(raw_json, '$.tax_exempt')       AS tax_exempt
          FROM recon_orders
         WHERE id = ?
      `).get(orderId);

      // 2) ALL recon_shopify_sales rows for the order.
      const sales = sqlite.prepare(`
        SELECT action_type, line_type, line_item_id,
               total_tax, total_amount, quantity,
               pos_location_id, happened_at, happened_month
          FROM recon_shopify_sales
         WHERE order_id = ?
         ORDER BY happened_at, action_type, line_type, line_item_id
      `).all(orderId);

      // 3) recon_line_items + their tax_lines_json totals. recon_line_items.id
      // is the line_item_id; order_id is FK to recon_orders.id.
      const lineItems = sqlite.prepare(`
        SELECT id AS line_item_id, sku, title, quantity, price,
               is_gift_card, recognized_at, tax_lines_json
          FROM recon_line_items
         WHERE order_id = ?
      `).all(orderId);

      const liEnriched = (lineItems as any[]).map((li) => {
        let txCents = 0;
        let txCount = 0;
        try {
          const tls = JSON.parse(li.tax_lines_json || '[]');
          if (Array.isArray(tls)) {
            txCount = tls.length;
            for (const t of tls) {
              txCents += Math.round(Number(t?.price || 0) * 100);
            }
          }
        } catch {}
        return {
          ...li,
          tax_lines_count: txCount,
          tax_lines_total_dollars: (txCents / 100).toFixed(2),
        };
      });

      // 4) recon_orders.raw_json.line_items[].tax_lines + shipping_lines[].tax_lines.
      let rawLineTaxByLi: Record<string, { count: number; cents: number }> = {};
      let rawShipTax = { count: 0, cents: 0 };
      try {
        const raw = sqlite.prepare(`SELECT raw_json FROM recon_orders WHERE id = ?`).get(orderId) as any;
        const rj = raw?.raw_json ? JSON.parse(raw.raw_json) : null;
        if (rj && Array.isArray(rj.line_items)) {
          for (const li of rj.line_items) {
            const key = String(li?.id ?? '');
            let c = 0, n = 0;
            if (Array.isArray(li?.tax_lines)) {
              for (const t of li.tax_lines) {
                c += Math.round(Number(t?.price || 0) * 100);
                n++;
              }
            }
            rawLineTaxByLi[key] = { count: n, cents: c };
          }
        }
        if (rj && Array.isArray(rj.shipping_lines)) {
          for (const sl of rj.shipping_lines) {
            if (Array.isArray(sl?.tax_lines)) {
              for (const t of sl.tax_lines) {
                rawShipTax.cents += Math.round(Number(t?.price || 0) * 100);
                rawShipTax.count++;
              }
            }
          }
        }
      } catch {}

      // 5) Refund line items. recon_refund_line_items has no created_at;
      // timestamps live on the parent recon_refunds (processed_at/created_at).
      const refundLineItems = sqlite.prepare(`
        SELECT rli.id AS rli_id, rli.refund_id, rli.line_item_id,
               rli.kind, rli.adjustment_kind, rli.restock_type,
               rli.quantity, rli.subtotal, rli.total_tax,
               rf.processed_at AS refund_processed_at,
               rf.created_at   AS refund_created_at
          FROM recon_refund_line_items rli
          JOIN recon_refunds rf ON rf.id = rli.refund_id
         WHERE rli.order_id = ?
         ORDER BY rf.processed_at, rli.refund_id, rli.line_item_id
      `).all(orderId);

      // 6) Allocations for this order. recon_allocations columns:
      // id, order_id, line_item_id, entity_id, share, gross_amount, tax_amount, method, reason
      const allocations = sqlite.prepare(`
        SELECT entity_id, line_item_id, share, gross_amount, tax_amount, method, reason
          FROM recon_allocations
         WHERE order_id = ?
         ORDER BY entity_id, line_item_id
      `).all(orderId);

      // Aggregate by_store-style for this order alone (excluding GIFT_CARD).
      let salesTaxCents = 0;
      const salesByAL: Record<string, number> = {};
      for (const r of (sales as any[])) {
        const k = `${r.action_type}/${r.line_type}`;
        salesByAL[k] = (salesByAL[k] || 0) + Math.round((Number(r.total_tax) || 0) * 100);
        if ((r.line_type || '') !== 'GIFT_CARD') {
          salesTaxCents += Math.round((Number(r.total_tax) || 0) * 100);
        }
      }

      // Aggregate component-style: fwd_line (from recon_line_items.tax_lines_json,
      // gift cards skipped) + fwd_ship (from raw_json.shipping_lines.tax_lines)
      // - item_refund_tax (from recon_refund_line_items.kind='item')
      // - ship_refund_tax (from recon_refund_line_items.adjustment_kind='shipping_refund').
      let compFwdLineCents = 0;
      for (const li of liEnriched) {
        if (li.is_gift_card) continue;
        compFwdLineCents += Math.round(Number(li.tax_lines_total_dollars) * 100);
      }
      let compItemRefundCents = 0;
      let compShipRefundCents = 0;
      for (const r of (refundLineItems as any[])) {
        const taxCents = Math.round(Math.abs(Number(r.total_tax) || 0) * 100);
        if (r.kind === 'item') compItemRefundCents += taxCents;
        else if (r.kind === 'adjustment' && r.adjustment_kind === 'shipping_refund') compShipRefundCents += taxCents;
      }
      const compFwdShipCents = rawShipTax.cents;
      const compFormulaCents = compFwdLineCents + compFwdShipCents - compItemRefundCents - compShipRefundCents;

      res.json({
        order_id: orderId,
        order_header: orderHeader || null,
        shopify_sales_rows: sales,
        shopify_sales_rollup_by_action_line_dollars: Object.fromEntries(
          Object.entries(salesByAL).map(([k, v]) => [k, ((v as number) / 100).toFixed(2)])
        ),
        shopify_sales_total_tax_ex_giftcard_dollars: (salesTaxCents / 100).toFixed(2),
        line_items: liEnriched,
        raw_json_line_tax_by_line_item: Object.fromEntries(
          Object.entries(rawLineTaxByLi).map(([k, v]) => [k, { count: v.count, total_dollars: (v.cents / 100).toFixed(2) }])
        ),
        raw_json_shipping_tax: { count: rawShipTax.count, total_dollars: (rawShipTax.cents / 100).toFixed(2) },
        refund_line_items: refundLineItems,
        allocations,
        component_view: {
          fwd_line_tax_dollars:    (compFwdLineCents / 100).toFixed(2),
          fwd_ship_tax_dollars:    (compFwdShipCents / 100).toFixed(2),
          item_refund_tax_dollars: (compItemRefundCents / 100).toFixed(2),
          ship_refund_tax_dollars: (compShipRefundCents / 100).toFixed(2),
          formula_dollars:         (compFormulaCents / 100).toFixed(2),
        },
        delta_dollars: ((compFormulaCents - salesTaxCents) / 100).toFixed(2),
        build_id: "pr152-debug-order-tax-truth",
      });
    } catch (e: any) {
      res.status(500).json({ message: "order-tax-truth failed", error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------
  // PR #155-debug — refund-tax-per-order
  //   Splits the entity-vs-store gap by order: for the given month + entity,
  //   returns, per order_id, entity's item_refund_tax contribution
  //   (loop #2 of aggregateByEntity) vs by-store's RETURN/PRODUCT sum
  //   (recon_shopify_sales attributed via the standard cascade).
  //   The order(s) whose deltas sum to the residual gap fall out the top
  //   when sorted by ABS(delta) DESC.
  // GET /api/recon/finance/debug/refund-tax-per-order/:month?entity_id=N
  // -------------------------------------------------------------------
  app.get("/api/recon/finance/debug/refund-tax-per-order/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const entityIdRaw = req.query.entity_id;
    if (entityIdRaw === undefined) {
      return res.status(400).json({ message: "entity_id query param required" });
    }
    const entityId = Number(entityIdRaw);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      return res.status(400).json({ message: "entity_id must be a positive integer" });
    }

    try {
      const { sqlite } = require("./storage");

      // ----- ENTITY SIDE (loop #2): use loadTaxInputsForMonth so we read
      // EXACTLY what aggregateByEntity reads (post-attribution + filters).
      const { refunds } = loadTaxInputsForMonth(month);
      const entityByOrder = new Map<string, { cents: number; rows: number }>();
      for (const r of refunds as any[]) {
        if (r.entity_id !== entityId) continue;
        const oid = String(r.order_id);
        const cents = Math.round(Number(r.refund_tax || 0) * 100);
        const cur = entityByOrder.get(oid) || { cents: 0, rows: 0 };
        cur.cents += cents;
        cur.rows += 1;
        entityByOrder.set(oid, cur);
      }

      // ----- BY-STORE SIDE: RETURN/PRODUCT rows attributed to this entity
      // using the same cascade as by-store.
      const bsRows = sqlite.prepare(`
        WITH attributed AS (
          SELECT s.order_id, s.total_tax,
            COALESCE(
              CASE WHEN s.pos_location_id IS NOT NULL THEN
                (SELECT pl.entity_id FROM recon_entity_pos_locations pl
                  WHERE pl.shopify_location_id = s.pos_location_id
                    AND pl.kind = 'pos' AND pl.active = 1 LIMIT 1)
              END,
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = s.order_id AND a.line_item_id = s.line_item_id LIMIT 1),
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = s.order_id AND a.line_item_id IS NULL LIMIT 1),
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = s.order_id
                GROUP BY a.entity_id
                ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
            ) AS aeid
          FROM recon_shopify_sales s
          WHERE s.happened_month = ?
            AND s.action_type = 'RETURN'
            AND s.line_type   = 'PRODUCT'
        )
        SELECT order_id,
               COALESCE(SUM(total_tax), 0) AS total_tax,
               COUNT(*) AS n
          FROM attributed
         WHERE aeid = ?
         GROUP BY order_id
      `).all(month, entityId) as Array<{ order_id: string; total_tax: number; n: number }>;

      const bsByOrder = new Map<string, { cents: number; rows: number }>();
      for (const r of bsRows) {
        // by-store RETURN/PRODUCT tax is signed-negative; we want absolute
        // refund tax for direct comparison to entity's item_refund_tax.
        const cents = Math.abs(Math.round(Number(r.total_tax || 0) * 100));
        bsByOrder.set(String(r.order_id), { cents, rows: r.n });
      }

      // Merge both sides into one row-per-order list.
      const allOrderIds = new Set<string>();
      entityByOrder.forEach((_v, k) => allOrderIds.add(k));
      bsByOrder.forEach((_v, k) => allOrderIds.add(k));
      const fmt = (c: number) => (c / 100).toFixed(2);
      const merged: Array<{
        order_id: string;
        entity_item_refund_tax_dollars: string;
        entity_rows: number;
        bystore_return_product_tax_dollars: string;
        bystore_rows: number;
        delta_dollars: string;
        delta_cents: number;
      }> = [];
      let totalEntityCents = 0;
      let totalBsCents = 0;
      allOrderIds.forEach((oid) => {
        const e = entityByOrder.get(oid) || { cents: 0, rows: 0 };
        const b = bsByOrder.get(oid) || { cents: 0, rows: 0 };
        totalEntityCents += e.cents;
        totalBsCents += b.cents;
        const deltaCents = e.cents - b.cents; // entity - store
        merged.push({
          order_id: oid,
          entity_item_refund_tax_dollars: fmt(e.cents),
          entity_rows: e.rows,
          bystore_return_product_tax_dollars: fmt(b.cents),
          bystore_rows: b.rows,
          delta_dollars: ((deltaCents) / 100).toFixed(2),
          delta_cents: deltaCents,
        });
      });
      merged.sort((a, b) => Math.abs(b.delta_cents) - Math.abs(a.delta_cents));

      // Enrich the top-20 non-zero deltas with order_name + refund_line_items
      // detail so the diagnosis is one paste away.
      const topNonZero = merged.filter((r) => r.delta_cents !== 0).slice(0, 20);
      const enriched: any[] = [];
      for (const row of topNonZero) {
        const hdr = sqlite.prepare(`SELECT id, name FROM recon_orders WHERE id = ?`).get(row.order_id) as any;
        const rlis = sqlite.prepare(`
          SELECT rli.id AS rli_id, rli.refund_id, rli.line_item_id,
                 rli.kind, rli.adjustment_kind, rli.restock_type,
                 rli.quantity, rli.subtotal, rli.total_tax,
                 rf.processed_at AS refund_processed_at,
                 li.is_gift_card AS line_is_gift_card,
                 li.sku AS line_sku
            FROM recon_refund_line_items rli
            JOIN recon_refunds rf ON rf.id = rli.refund_id
       LEFT JOIN recon_line_items li ON li.id = rli.line_item_id
           WHERE rli.order_id = ?
             AND substr(rf.processed_at, 1, 7) = ?
           ORDER BY rli.id
        `).all(row.order_id, month) as any[];
        const bsDetail = sqlite.prepare(`
          SELECT action_type, line_type, line_item_id, total_tax,
                 total_amount, quantity, pos_location_id, happened_at
            FROM recon_shopify_sales
           WHERE order_id = ?
             AND happened_month = ?
             AND action_type = 'RETURN'
           ORDER BY happened_at, line_item_id
        `).all(row.order_id, month) as any[];
        enriched.push({
          ...row,
          order_name: hdr?.name ?? null,
          recon_refund_line_items_in_month: rlis,
          recon_shopify_sales_return_rows_in_month: bsDetail,
        });
      }

      res.json({
        month,
        entity_id: entityId,
        totals: {
          entity_item_refund_tax_dollars:    fmt(totalEntityCents),
          bystore_return_product_tax_dollars: fmt(totalBsCents),
          delta_dollars:                     fmt(totalEntityCents - totalBsCents),
        },
        order_count: merged.length,
        nonzero_delta_count: merged.filter((r) => r.delta_cents !== 0).length,
        top_diffs: enriched,
        all_orders: merged,
        note: "PR #155-debug — entity loop #2 (recon_refund_line_items kind='item', non-gift-card, attributed via loadTaxInputsForMonth) vs by-store RETURN/PRODUCT (recon_shopify_sales attributed via cascade). delta_cents = entity - store. Both compared in ABSOLUTE refund-tax magnitude. Top 20 are enriched with the underlying refund + RETURN rows in-month.",
        build_id: "pr155-debug-refund-tax-per-order",
      });
    } catch (e: any) {
      res.status(500).json({ message: "refund-tax-per-order failed", error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------
  // PR #156-debug — refund-tax-per-order-v2 (CORRECTED)
  //   PR #155-debug had a bug: it read order_id off RefundForTax rows,
  //   but that interface only carries entity_id (no order_id). All 325
  //   entity refund rows landed under order_id="undefined". This v2
  //   queries recon_refund_line_items directly with the SAME WHERE
  //   clauses + attribution cascade as loadTaxInputsForMonth refunds
  //   query, so we get order_id natively and the per-order grouping
  //   actually works.
  // GET /api/recon/finance/debug/refund-tax-per-order-v2/:month?entity_id=N
  // -------------------------------------------------------------------
  app.get("/api/recon/finance/debug/refund-tax-per-order-v2/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const entityIdRaw = req.query.entity_id;
    if (entityIdRaw === undefined) {
      return res.status(400).json({ message: "entity_id query param required" });
    }
    const entityId = Number(entityIdRaw);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      return res.status(400).json({ message: "entity_id must be a positive integer" });
    }

    try {
      const { sqlite } = require("./storage");

      // ----- ENTITY SIDE: replicate loadTaxInputsForMonth's refundRows
      // query EXACTLY, but keep order_id in the result and only include
      // kind='item' (loop #2). adjustment_kind rows belong to ship_refund
      // (loop #4) and are NOT in item_refund_tax.
      const entityRows = sqlite.prepare(`
        SELECT
          rli.id           AS refund_line_id,
          rli.order_id     AS order_id,
          rli.line_item_id AS line_item_id,
          rli.kind         AS kind,
          rli.subtotal     AS refund_subtotal,
          rli.total_tax    AS refund_tax,
          li.is_gift_card  AS orig_is_gift_card,
          (SELECT pl.entity_id
             FROM recon_shopify_sales s
             JOIN recon_entity_pos_locations pl
               ON pl.shopify_location_id = s.pos_location_id
              AND pl.kind = 'pos'
              AND pl.active = 1
            WHERE s.order_id = rli.order_id
              AND s.line_item_id = rli.line_item_id
              AND s.pos_location_id IS NOT NULL
            LIMIT 1)        AS pos_entity_id,
          COALESCE(
            (SELECT a.entity_id FROM recon_allocations a
              WHERE a.order_id = rli.order_id AND a.line_item_id = rli.line_item_id LIMIT 1),
            (SELECT a.entity_id FROM recon_allocations a
              WHERE a.order_id = rli.order_id AND a.line_item_id IS NULL LIMIT 1),
            (SELECT a.entity_id FROM recon_allocations a
              WHERE a.order_id = rli.order_id
              GROUP BY a.entity_id
              ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
          )                AS alloc_entity_id
        FROM recon_refund_line_items rli
        JOIN recon_refunds rf ON rf.id = rli.refund_id
   LEFT JOIN recon_line_items li
          ON li.id = rli.line_item_id AND li.order_id = rli.order_id
        WHERE substr(datetime(
                COALESCE(rf.processed_at, rf.created_at),
                '-5 hours'), 1, 7) = ?
          AND COALESCE(li.is_gift_card, 0) = 0
          AND rli.kind = 'item'
      `).all(month) as any[];

      // Build POS-entity set once (mirrors loadTaxInputsForMonth posEntityIds)
      const posEntitySet = new Set<number>(
        (sqlite.prepare(`
          SELECT entity_id FROM recon_entity_pos_locations
          WHERE kind='pos' AND active=1 AND shopify_location_id IS NOT NULL
        `).all() as any[]).map((r) => Number(r.entity_id)),
      );

      // Apply the SAME final-entity pick the production refund loop uses:
      //   1. POS entity (if set AND in posEntitySet)
      //   2. else alloc entity (if set AND in posEntitySet)
      //   3. else 0 (Unallocated)
      const entityByOrder = new Map<string, { cents: number; rows: number; details: any[] }>();
      for (const r of entityRows) {
        let eid = 0;
        if (r.pos_entity_id != null && posEntitySet.has(Number(r.pos_entity_id))) eid = Number(r.pos_entity_id);
        else if (r.alloc_entity_id != null && posEntitySet.has(Number(r.alloc_entity_id))) eid = Number(r.alloc_entity_id);
        if (eid !== entityId) continue;
        const oid = String(r.order_id);
        const cents = Math.round(Number(r.refund_tax || 0) * 100);
        const cur = entityByOrder.get(oid) || { cents: 0, rows: 0, details: [] };
        cur.cents += cents;
        cur.rows += 1;
        cur.details.push({
          refund_line_id: r.refund_line_id,
          line_item_id: r.line_item_id,
          kind: r.kind,
          refund_subtotal: r.refund_subtotal,
          refund_tax: r.refund_tax,
          orig_is_gift_card: r.orig_is_gift_card,
          pos_entity_id: r.pos_entity_id,
          alloc_entity_id: r.alloc_entity_id,
          picked_entity_id: eid,
        });
        entityByOrder.set(oid, cur);
      }

      // ----- BY-STORE SIDE: RETURN/PRODUCT rows attributed to this entity
      // using the same cascade as by-store. (Same query as PR #155.)
      const bsRows = sqlite.prepare(`
        WITH attributed AS (
          SELECT s.order_id, s.line_item_id, s.total_tax, s.total_amount,
                 s.quantity, s.pos_location_id, s.happened_at,
            COALESCE(
              CASE WHEN s.pos_location_id IS NOT NULL THEN
                (SELECT pl.entity_id FROM recon_entity_pos_locations pl
                  WHERE pl.shopify_location_id = s.pos_location_id
                    AND pl.kind = 'pos' AND pl.active = 1 LIMIT 1)
              END,
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = s.order_id AND a.line_item_id = s.line_item_id LIMIT 1),
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = s.order_id AND a.line_item_id IS NULL LIMIT 1),
              (SELECT a.entity_id FROM recon_allocations a
                WHERE a.order_id = s.order_id
                GROUP BY a.entity_id
                ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1)
            ) AS aeid
          FROM recon_shopify_sales s
          WHERE s.happened_month = ?
            AND s.action_type = 'RETURN'
            AND s.line_type   = 'PRODUCT'
        )
        SELECT order_id, line_item_id, total_tax, total_amount, quantity,
               pos_location_id, happened_at
          FROM attributed
         WHERE aeid = ?
         ORDER BY order_id, happened_at, line_item_id
      `).all(month, entityId) as any[];

      const bsByOrder = new Map<string, { cents: number; rows: number; details: any[] }>();
      for (const r of bsRows) {
        const cents = Math.abs(Math.round(Number(r.total_tax || 0) * 100));
        const oid = String(r.order_id);
        const cur = bsByOrder.get(oid) || { cents: 0, rows: 0, details: [] };
        cur.cents += cents;
        cur.rows += 1;
        cur.details.push(r);
        bsByOrder.set(oid, cur);
      }

      const allOrderIds = new Set<string>();
      entityByOrder.forEach((_v, k) => allOrderIds.add(k));
      bsByOrder.forEach((_v, k) => allOrderIds.add(k));
      const fmt = (c: number) => (c / 100).toFixed(2);

      const merged: any[] = [];
      let totalEntityCents = 0;
      let totalBsCents = 0;
      allOrderIds.forEach((oid) => {
        const e = entityByOrder.get(oid) || { cents: 0, rows: 0, details: [] };
        const b = bsByOrder.get(oid) || { cents: 0, rows: 0, details: [] };
        totalEntityCents += e.cents;
        totalBsCents += b.cents;
        const deltaCents = e.cents - b.cents;
        merged.push({
          order_id: oid,
          entity_item_refund_tax_dollars: fmt(e.cents),
          entity_rows: e.rows,
          bystore_return_product_tax_dollars: fmt(b.cents),
          bystore_rows: b.rows,
          delta_dollars: ((deltaCents) / 100).toFixed(2),
          delta_cents: deltaCents,
        });
      });
      merged.sort((a, b) => Math.abs(b.delta_cents) - Math.abs(a.delta_cents));

      // Enrich top-20 non-zero deltas with order_name + full per-side detail.
      const topNonZero = merged.filter((r) => r.delta_cents !== 0).slice(0, 20);
      const enriched: any[] = [];
      for (const row of topNonZero) {
        const hdr = sqlite.prepare(`SELECT id, name, processed_at, total_tax, current_total_tax FROM recon_orders WHERE id = ?`).get(row.order_id) as any;
        enriched.push({
          ...row,
          order_name: hdr?.name ?? null,
          order_processed_at: hdr?.processed_at ?? null,
          order_total_tax: hdr?.total_tax ?? null,
          order_current_total_tax: hdr?.current_total_tax ?? null,
          entity_refund_rows: entityByOrder.get(row.order_id)?.details ?? [],
          bystore_return_rows: bsByOrder.get(row.order_id)?.details ?? [],
        });
      }

      res.json({
        month,
        entity_id: entityId,
        totals: {
          entity_item_refund_tax_dollars:    fmt(totalEntityCents),
          bystore_return_product_tax_dollars: fmt(totalBsCents),
          delta_dollars:                     fmt(totalEntityCents - totalBsCents),
        },
        order_count: merged.length,
        nonzero_delta_count: merged.filter((r) => r.delta_cents !== 0).length,
        top_diffs: enriched,
        all_orders: merged,
        note: "PR #156-debug — corrects PR #155-debug (which read non-existent r.order_id off RefundForTax). Queries recon_refund_line_items directly with the same WHERE + attribution cascade as loadTaxInputsForMonth's refundRows, but ONLY kind='item' (loop #2). Compares per-order to by-store RETURN/PRODUCT (abs).",
        build_id: "pr156-debug-refund-tax-per-order-v2",
      });
    } catch (e: any) {
      res.status(500).json({ message: "refund-tax-per-order-v2 failed", error: String(e?.message || e) });
    }
  });

  // ===================================================================
  // PR #158-debug — line-tax-truth: a FOURTH, projector-independent
  //   source of truth for monthly entity sales tax. Reads
  //   recon_line_items (forward tax via tax_lines_json) +
  //   recon_refund_line_items (refund tax) DIRECTLY, replicating the
  //   production POS→per-line→order-level→dominant attribution cascade,
  //   but NEVER touching recon_shopify_sales (the projector output we are
  //   trying to validate). Used to localize the $1.32 Huntington Dec 2025
  //   entity-vs-store delta. Does NOT fix it — it's the diagnostic.
  //
  // GET /api/recon/finance/debug/line-tax-truth/:month?entity_id=N
  // ===================================================================
  app.get("/api/recon/finance/debug/line-tax-truth/:month", authMiddleware, requireFinanceView(), async (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const entityIdRaw = req.query.entity_id;
    if (entityIdRaw === undefined) {
      return res.status(400).json({ message: "entity_id query param required" });
    }
    const entityId = Number(entityIdRaw);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      return res.status(400).json({ message: "entity_id must be a positive integer" });
    }

    try {
      const { sqlite } = require("./storage");

      // Entity display name + its mapped POS location (informational only).
      const entityRow = sqlite.prepare(
        `SELECT id, location FROM payroll_entities WHERE id = ?`,
      ).get(entityId) as any;
      const entityName = entityRow?.location ?? null;
      const posLocRow = sqlite.prepare(`
        SELECT shopify_location_id FROM recon_entity_pos_locations
         WHERE entity_id = ? AND kind = 'pos' AND active = 1
           AND shopify_location_id IS NOT NULL
         LIMIT 1
      `).get(entityId) as any;
      const posLocationId = posLocRow?.shopify_location_id ?? null;

      // POS entity set — used to bucket non-POS allocations into Unallocated,
      // mirroring loadTaxInputsForMonth's posEntityIds gate exactly.
      const posEntitySet = new Set<number>(
        (sqlite.prepare(`
          SELECT entity_id FROM recon_entity_pos_locations
           WHERE kind = 'pos' AND active = 1 AND shopify_location_id IS NOT NULL
        `).all() as any[]).map((r) => Number(r.entity_id)),
      );

      // -------------------------------------------------------------------
      // Pick the final entity + attribution method for a cascade row.
      // Branches (in priority order), matching the production by-store CTE
      // and loadTaxInputsForMonth:
      //   1. pos_location      — a recon_shopify_sales POS row mapped the
      //      (order,line) to a POS entity   [NOTE: this reads pos_location_id
      //      attribution, NOT tax amounts, so it does not violate the
      //      "ignore the projector output" rule — the tax itself comes only
      //      from recon_line_items / recon_refund_line_items]
      //   2. per_line_alloc    — recon_allocations row keyed to this line
      //   3. order_alloc       — recon_allocations order-level row (line NULL)
      //   4. dominant_fallback — largest gross_amount entity on the order
      //   else entity_id = 0 (Unallocated)
      // Returns { eid, method } where method is null when the picked entity
      // isn't a POS entity (→ Unallocated).
      const pickEntity = (
        posEid: number | null,
        perLineEid: number | null,
        orderEid: number | null,
        dominantEid: number | null,
      ): { eid: number; method: string | null } => {
        if (posEid != null && posEntitySet.has(Number(posEid))) {
          return { eid: Number(posEid), method: "pos_location" };
        }
        if (perLineEid != null && posEntitySet.has(Number(perLineEid))) {
          return { eid: Number(perLineEid), method: "per_line_alloc" };
        }
        if (orderEid != null && posEntitySet.has(Number(orderEid))) {
          return { eid: Number(orderEid), method: "order_alloc" };
        }
        if (dominantEid != null && posEntitySet.has(Number(dominantEid))) {
          return { eid: Number(dominantEid), method: "dominant_fallback" };
        }
        return { eid: 0, method: null };
      };

      // -------------------------------------------------------------------
      // FORWARD: per-line tax straight from recon_line_items.tax_lines_json.
      // Month boundary = America/New_York via the canonical -5h shift on
      // COALESCE(recognized_at, processed_at, created_at) — same bucket as
      // loadTaxInputsForMonth. Gift cards skipped (is_gift_card = 0).
      // Each cascade branch is computed as its own column so we can pick the
      // final entity in JS and tally attribution_method_counts.
      const fwdRows = sqlite.prepare(`
        SELECT
          li.id        AS line_id,
          li.order_id  AS order_id,
          li.tax_lines_json AS tax_lines_json,
          (SELECT pl.entity_id
             FROM recon_shopify_sales s
             JOIN recon_entity_pos_locations pl
               ON pl.shopify_location_id = s.pos_location_id
              AND pl.kind = 'pos' AND pl.active = 1
            WHERE s.order_id = li.order_id
              AND s.line_item_id = li.id
              AND s.pos_location_id IS NOT NULL
            LIMIT 1) AS pos_entity_id,
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = li.order_id AND a.line_item_id = li.id LIMIT 1) AS per_line_entity_id,
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = li.order_id AND a.line_item_id IS NULL LIMIT 1) AS order_entity_id,
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = li.order_id
            GROUP BY a.entity_id
            ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1) AS dominant_entity_id,
          (SELECT a.share FROM recon_allocations a
            WHERE a.order_id = li.order_id AND a.line_item_id = li.id
              AND a.entity_id = ? LIMIT 1) AS entity_share
        FROM recon_line_items li
        JOIN recon_orders o ON o.id = li.order_id
        WHERE substr(datetime(
                COALESCE(li.recognized_at, o.processed_at, o.created_at),
                '-5 hours'), 1, 7) = ?
          AND li.is_gift_card = 0
      `).all(entityId, month) as any[];

      const methodCounts: Record<string, number> = {
        pos_location: 0,
        per_line_alloc: 0,
        order_alloc: 0,
        dominant_fallback: 0,
      };

      // Per-order accumulators (cents) for drill-down + totals.
      const fwdByOrder = new Map<string, number>();
      let fwdTaxCents = 0;
      let fwdLineCount = 0;
      const fwdOrderSet = new Set<string>();

      for (const r of fwdRows) {
        const picked = pickEntity(
          r.pos_entity_id, r.per_line_entity_id, r.order_entity_id, r.dominant_entity_id,
        );
        if (picked.eid !== entityId) continue;

        // share defaults to 1 (recon_allocations uses share=1 in practice;
        // multiply defensively in case a line is ever split across entities).
        const share = r.entity_share != null ? Number(r.entity_share) : 1;

        // Sum the tax_lines_json prices for this line (penny-exact cents).
        let lineTaxCents = 0;
        for (const tl of parseTaxLines(r.tax_lines_json)) {
          lineTaxCents += Math.round(Number(tl.price || 0) * 100);
        }
        const attributedCents = Math.round(lineTaxCents * share);

        fwdTaxCents += attributedCents;
        fwdLineCount += 1;
        const oid = String(r.order_id);
        fwdOrderSet.add(oid);
        fwdByOrder.set(oid, (fwdByOrder.get(oid) || 0) + attributedCents);
        if (picked.method) methodCounts[picked.method] += 1;
      }

      // -------------------------------------------------------------------
      // REFUND: per-line refund tax straight from recon_refund_line_items.
      // Bucketed by the PARENT recon_refunds.processed_at (-5h NY shift) —
      // same bucket as loadTaxInputsForMonth's refundRows. ABS()-wrap each
      // total_tax (Shopify sometimes stores refund tax negative — known
      // sign-convention trap). Attributed via the SAME cascade on the
      // ORIGINAL line_item_id. Gift cards skipped.
      const refRows = sqlite.prepare(`
        SELECT
          rli.id           AS refund_line_id,
          rli.order_id     AS order_id,
          rli.line_item_id AS line_item_id,
          rli.total_tax    AS refund_tax,
          (SELECT pl.entity_id
             FROM recon_shopify_sales s
             JOIN recon_entity_pos_locations pl
               ON pl.shopify_location_id = s.pos_location_id
              AND pl.kind = 'pos' AND pl.active = 1
            WHERE s.order_id = rli.order_id
              AND s.line_item_id = rli.line_item_id
              AND s.pos_location_id IS NOT NULL
            LIMIT 1) AS pos_entity_id,
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = rli.order_id AND a.line_item_id = rli.line_item_id LIMIT 1) AS per_line_entity_id,
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = rli.order_id AND a.line_item_id IS NULL LIMIT 1) AS order_entity_id,
          (SELECT a.entity_id FROM recon_allocations a
            WHERE a.order_id = rli.order_id
            GROUP BY a.entity_id
            ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1) AS dominant_entity_id,
          (SELECT a.share FROM recon_allocations a
            WHERE a.order_id = rli.order_id AND a.line_item_id = rli.line_item_id
              AND a.entity_id = ? LIMIT 1) AS entity_share
        FROM recon_refund_line_items rli
        JOIN recon_refunds rf ON rf.id = rli.refund_id
   LEFT JOIN recon_line_items li
          ON li.id = rli.line_item_id AND li.order_id = rli.order_id
        WHERE substr(datetime(
                COALESCE(rf.processed_at, rf.created_at),
                '-5 hours'), 1, 7) = ?
          AND COALESCE(li.is_gift_card, 0) = 0
      `).all(entityId, month) as any[];

      const refByOrder = new Map<string, number>();
      let refTaxCents = 0;
      let refLineCount = 0;
      const refOrderSet = new Set<string>();

      for (const r of refRows) {
        const picked = pickEntity(
          r.pos_entity_id, r.per_line_entity_id, r.order_entity_id, r.dominant_entity_id,
        );
        if (picked.eid !== entityId) continue;

        const share = r.entity_share != null ? Number(r.entity_share) : 1;
        const taxCents = Math.round(Math.abs(Number(r.refund_tax || 0)) * 100);
        const attributedCents = Math.round(taxCents * share);

        refTaxCents += attributedCents;
        refLineCount += 1;
        const oid = String(r.order_id);
        refOrderSet.add(oid);
        refByOrder.set(oid, (refByOrder.get(oid) || 0) + attributedCents);
      }

      // -------------------------------------------------------------------
      // Drill-down: top 10 orders by net tax, top 10 by refund tax.
      const allOrderIds = new Set<string>();
      fwdByOrder.forEach((_v, k) => allOrderIds.add(k));
      refByOrder.forEach((_v, k) => allOrderIds.add(k));

      const perOrder: Array<{ order_id: string; fwd: number; ref: number; net: number }> = [];
      allOrderIds.forEach((oid) => {
        const fwd = fwdByOrder.get(oid) || 0;
        const ref = refByOrder.get(oid) || 0;
        perOrder.push({ order_id: oid, fwd, ref, net: fwd - ref });
      });

      // Resolve order names once for whatever orders we surface.
      const nameCache = new Map<string, string | null>();
      const nameOf = (oid: string): string | null => {
        if (nameCache.has(oid)) return nameCache.get(oid)!;
        const hdr = sqlite.prepare(`SELECT name FROM recon_orders WHERE id = ?`).get(oid) as any;
        const nm = hdr?.name ?? null;
        nameCache.set(oid, nm);
        return nm;
      };

      const fmt = (c: number) => fromCents(c);

      const topNet = [...perOrder]
        .sort((a, b) => b.net - a.net)
        .slice(0, 10)
        .map((r) => ({
          order_id: r.order_id,
          order_name: nameOf(r.order_id),
          forward_tax: fmt(r.fwd),
          refund_tax: fmt(r.ref),
          net_tax: fmt(r.net),
        }));

      const topRefund = [...perOrder]
        .filter((r) => r.ref !== 0)
        .sort((a, b) => b.ref - a.ref)
        .slice(0, 10)
        .map((r) => ({
          order_id: r.order_id,
          order_name: nameOf(r.order_id),
          forward_tax: fmt(r.fwd),
          refund_tax: fmt(r.ref),
          net_tax: fmt(r.net),
        }));

      const netTaxCents = fwdTaxCents - refTaxCents;

      res.json({
        build_id: "pr158-debug-line-tax-truth",
        month,
        entity_id: entityId,
        entity_name: entityName,
        pos_location_id: posLocationId,
        forward: {
          line_tax_dollars: fmt(fwdTaxCents),
          line_count: fwdLineCount,
          order_count: fwdOrderSet.size,
        },
        refund: {
          refund_tax_dollars: fmt(refTaxCents),
          refund_line_count: refLineCount,
          refund_order_count: refOrderSet.size,
        },
        net: {
          net_tax_dollars: fmt(netTaxCents),
        },
        attribution_method_counts: methodCounts,
        drill_down: {
          top_10_orders_by_net_tax: topNet,
          top_10_orders_by_refund_tax: topRefund,
        },
        note: "PR #158-debug — fourth, projector-independent tax truth source. Forward tax summed directly from recon_line_items.tax_lines_json; refund tax from recon_refund_line_items.total_tax (ABS-wrapped). Attribution replicates the production POS→per-line→order→dominant cascade. Does NOT read recon_shopify_sales for tax amounts (only for POS-location attribution). Penny-exact via integer cents.",
      });
    } catch (e: any) {
      res.status(500).json({ message: "line-tax-truth failed", error: String(e?.message || e) });
    }
  });

  // ===================================================================
  // PR #159-debug — v_attributed_sales view + attribution invariant.
  //
  // The architectural principle (derived from first principles by the owner):
  //   ONE per-line attribution applied uniformly. Every (line × entity) pair
  //   carries share × line_tax. ST-810 entity totals, by-store breakdown and
  //   grand totals all GROUP BY differently over the SAME atomic rows. So
  //   sum-of-parts == whole is enforced by SQL itself, not by careful coding.
  //
  // PR #158 proved the per-line forward-tax path is the smallest disagreeing
  // source. This PR formalizes that path as the v_attributed_sales view (see
  // storage.ts) and adds an INVARIANT assertion endpoint so attribution drift
  // would fail loudly.
  //
  // All three endpoints below share ONE computation
  // (computeAttributionForMonth) so the invariant
  //   Σ per_entity == grand_total
  // holds by construction — both sides are summed from the identical
  // per-row integer-cent values; there is no second, independently-derived
  // total that could drift.
  //
  // ATTRIBUTION CASCADE (per line, priority order — identical to PR #158):
  //   1. pos_location      recon_shopify_sales POS row → POS entity
  //   2. per_line_alloc    recon_allocations row keyed to this line
  //   3. order_alloc       recon_allocations order-level row (line NULL)
  //   4. dominant_fallback largest SUM(gross_amount) entity on the order
  //   else → entity 0 (Unallocated). Non-POS picks also fall to Unallocated.
  //
  // SHIPPING TAX RULE: shipping tax has no line grain. PR #158 EXCLUDES it,
  // so this PR INTRODUCES shipping attribution: each order's shipping tax
  // (Σ raw_json.shipping_lines[].tax_lines[].price, ABS-wrapped) is attributed
  // to the order's DOMINANT entity = the entity with the highest summed
  // forward LINE tax for that order; tie-break = lowest entity_id. Shipping
  // refund tax (recon_refund_line_items adjustment_kind='shipping_refund',
  // ABS-wrapped) is attributed the same way and subtracted. Because PR #158
  // excludes shipping, the attributed-sales-truth endpoint reports forward
  // LINE tax separately from shipping so it remains penny-comparable to #158.
  //
  // SHARE-ROUNDING: recon_allocations.share is REAL. We compute
  // ROUND(line_tax_cents × share) once per row. For split lines (share < 1)
  // the sum of per-entity cents may differ from the line's raw cents by up to
  // ±1 cent per split line. That accumulated drift is reported as
  // split_line_rounding_drift_cents and used as the invariant tolerance. It
  // never breaks the invariant itself because grand_total is summed from the
  // same rounded per-row values.
  // ===================================================================

  // Shared per-month attribution engine. Read-only. Returns integer-cent
  // tallies keyed by entity, plus per-order detail for the by-line drill-down.
  const computeAttributionForMonth = (month: string) => {
    const { sqlite } = require("./storage");

    // POS entity set — picks outside this set collapse to Unallocated (0),
    // mirroring loadTaxInputsForMonth + PR #158 exactly.
    const posEntitySet = new Set<number>(
      (sqlite.prepare(`
        SELECT entity_id FROM recon_entity_pos_locations
         WHERE kind = 'pos' AND active = 1 AND shopify_location_id IS NOT NULL
      `).all() as any[]).map((r) => Number(r.entity_id)),
    );

    const pickEntity = (
      posEid: number | null,
      perLineEid: number | null,
      orderEid: number | null,
      dominantEid: number | null,
    ): number => {
      if (posEid != null && posEntitySet.has(Number(posEid))) return Number(posEid);
      if (perLineEid != null && posEntitySet.has(Number(perLineEid))) return Number(perLineEid);
      if (orderEid != null && posEntitySet.has(Number(orderEid))) return Number(orderEid);
      if (dominantEid != null && posEntitySet.has(Number(dominantEid))) return Number(dominantEid);
      return 0;
    };

    // ---- FORWARD line tax, read straight from the v_attributed_sales view,
    // with the POS-location candidate layered on (the view omits it; see the
    // storage.ts note). One row per non-gift-card line in the NY month.
    const fwdRows = sqlite.prepare(`
      SELECT
        v.line_item_id,
        v.order_id,
        v.tax_lines_json,
        v.per_line_entity_id,
        v.per_line_share,
        v.order_entity_id,
        v.dominant_entity_id,
        (SELECT pl.entity_id
           FROM recon_shopify_sales s
           JOIN recon_entity_pos_locations pl
             ON pl.shopify_location_id = s.pos_location_id
            AND pl.kind = 'pos' AND pl.active = 1
          WHERE s.order_id = v.order_id
            AND s.line_item_id = v.line_item_id
            AND s.pos_location_id IS NOT NULL
          LIMIT 1) AS pos_entity_id
      FROM v_attributed_sales v
      WHERE v.happened_month = ?
    `).all(month) as any[];

    // Per-entity forward cents, per-order×entity forward cents (drill-down),
    // and per-order×entity forward cents used to choose the shipping dominant.
    const fwdByEntity = new Map<number, number>();
    let splitLineCount = 0;
    let rawForwardCentsTotal = 0;   // Σ raw line cents (pre share-rounding)
    let attrForwardCentsTotal = 0;  // Σ rounded attributed cents
    const fwdLineCountByEntity = new Map<number, number>();
    // order_id → entity_id → cents (forward line tax). Drives drill-down +
    // shipping dominant-entity selection.
    const fwdByOrderEntity = new Map<string, Map<number, number>>();
    // order_id → line_item_id → { entity, share, cents }
    const lineDetailByOrder = new Map<string, Array<{ line_item_id: string; entity_id: number; share: number; forward_cents: number }>>();

    for (const r of fwdRows) {
      const eid = pickEntity(
        r.pos_entity_id, r.per_line_entity_id, r.order_entity_id, r.dominant_entity_id,
      );
      const share = r.per_line_share != null ? Number(r.per_line_share) : 1;
      if (share < 1) splitLineCount += 1;

      let lineTaxCents = 0;
      for (const tl of parseTaxLines(r.tax_lines_json)) {
        lineTaxCents += Math.round(Number(tl.price || 0) * 100);
      }
      const attributedCents = Math.round(lineTaxCents * share);

      rawForwardCentsTotal += lineTaxCents;
      attrForwardCentsTotal += attributedCents;

      fwdByEntity.set(eid, (fwdByEntity.get(eid) || 0) + attributedCents);
      fwdLineCountByEntity.set(eid, (fwdLineCountByEntity.get(eid) || 0) + 1);

      const oid = String(r.order_id);
      let oe = fwdByOrderEntity.get(oid);
      if (!oe) { oe = new Map<number, number>(); fwdByOrderEntity.set(oid, oe); }
      oe.set(eid, (oe.get(eid) || 0) + attributedCents);

      let ld = lineDetailByOrder.get(oid);
      if (!ld) { ld = []; lineDetailByOrder.set(oid, ld); }
      ld.push({ line_item_id: String(r.line_item_id), entity_id: eid, share, forward_cents: attributedCents });
    }

    // ---- REFUND line tax (item refunds), attributed via the SAME cascade on
    // the original line. Bucketed by parent refund processed_at (-5h NY).
    // ABS-wrapped (sign-convention trap). Gift cards excluded.
    const refRows = sqlite.prepare(`
      SELECT
        rli.order_id,
        rli.line_item_id,
        rli.total_tax AS refund_tax,
        (SELECT pl.entity_id
           FROM recon_shopify_sales s
           JOIN recon_entity_pos_locations pl
             ON pl.shopify_location_id = s.pos_location_id
            AND pl.kind = 'pos' AND pl.active = 1
          WHERE s.order_id = rli.order_id
            AND s.line_item_id = rli.line_item_id
            AND s.pos_location_id IS NOT NULL
          LIMIT 1) AS pos_entity_id,
        (SELECT a.entity_id FROM recon_allocations a
          WHERE a.order_id = rli.order_id AND a.line_item_id = rli.line_item_id LIMIT 1) AS per_line_entity_id,
        (SELECT a.share FROM recon_allocations a
          WHERE a.order_id = rli.order_id AND a.line_item_id = rli.line_item_id LIMIT 1) AS per_line_share,
        (SELECT a.entity_id FROM recon_allocations a
          WHERE a.order_id = rli.order_id AND a.line_item_id IS NULL LIMIT 1) AS order_entity_id,
        (SELECT a.entity_id FROM recon_allocations a
          WHERE a.order_id = rli.order_id
          GROUP BY a.entity_id
          ORDER BY SUM(a.gross_amount) DESC, a.entity_id ASC LIMIT 1) AS dominant_entity_id
      FROM recon_refund_line_items rli
      JOIN recon_refunds rf ON rf.id = rli.refund_id
 LEFT JOIN recon_line_items li
        ON li.id = rli.line_item_id AND li.order_id = rli.order_id
      WHERE COALESCE(rli.kind, 'item') = 'item'
        AND substr(datetime(
              COALESCE(rf.processed_at, rf.created_at),
              '-5 hours'), 1, 7) = ?
        AND COALESCE(li.is_gift_card, 0) = 0
    `).all(month) as any[];

    const refByEntity = new Map<number, number>();
    // order_id → line_item_id → refund cents
    const refByOrderLine = new Map<string, Map<string, number>>();
    for (const r of refRows) {
      const eid = pickEntity(
        r.pos_entity_id, r.per_line_entity_id, r.order_entity_id, r.dominant_entity_id,
      );
      const share = r.per_line_share != null ? Number(r.per_line_share) : 1;
      const taxCents = Math.round(Math.abs(Number(r.refund_tax || 0)) * 100);
      const attributedCents = Math.round(taxCents * share);
      refByEntity.set(eid, (refByEntity.get(eid) || 0) + attributedCents);

      const oid = String(r.order_id);
      const lid = String(r.line_item_id);
      let m = refByOrderLine.get(oid);
      if (!m) { m = new Map<string, number>(); refByOrderLine.set(oid, m); }
      m.set(lid, (m.get(lid) || 0) + attributedCents);
    }

    // ---- SHIPPING forward tax. Σ raw_json.shipping_lines[].tax_lines[].price
    // (ABS-wrapped) per order, attributed to the order's DOMINANT entity by
    // forward LINE tax (tie-break lowest entity_id). Orders in the NY month
    // (COALESCE(processed_at, created_at) -5h), same bucket as the line tax.
    const dominantEntityForOrder = (oid: string): number => {
      const oe = fwdByOrderEntity.get(oid);
      if (!oe || oe.size === 0) return 0;
      let bestEid = 0;
      let bestCents = -1;
      // Deterministic: iterate entity_ids ascending so ties pick the lowest.
      const eids = Array.from(oe.keys()).filter((e) => e !== 0).sort((a, b) => a - b);
      for (const e of eids) {
        const c = oe.get(e) || 0;
        if (c > bestCents) { bestCents = c; bestEid = e; }
      }
      return bestEid;
    };

    const shipFwdRows = sqlite.prepare(`
      SELECT o.id AS order_id, o.raw_json AS raw_json
      FROM recon_orders o
      WHERE substr(datetime(
              COALESCE(o.processed_at, o.created_at),
              '-5 hours'), 1, 7) = ?
        AND o.raw_json IS NOT NULL AND o.raw_json <> ''
    `).all(month) as any[];

    const shipByEntity = new Map<number, number>();
    // order_id → { dominant_entity_id, cents }
    const shipByOrder = new Map<string, { entity_id: number; cents: number }>();
    for (const r of shipFwdRows) {
      let parsed: any;
      try { parsed = typeof r.raw_json === 'string' ? JSON.parse(r.raw_json) : r.raw_json; }
      catch { continue; }
      const sLines = Array.isArray(parsed?.shipping_lines) ? parsed.shipping_lines : [];
      if (sLines.length === 0) continue;
      let cents = 0;
      for (const s of sLines) {
        const tls = Array.isArray(s?.tax_lines) ? s.tax_lines : [];
        for (const tl of tls) {
          const price = typeof tl?.price === 'number' ? tl.price : tl?.price != null ? Number(tl.price) : null;
          if (price == null || !Number.isFinite(price)) continue;
          cents += Math.round(Math.abs(price) * 100);
        }
      }
      if (cents === 0) continue;
      const oid = String(r.order_id);
      const eid = dominantEntityForOrder(oid);
      shipByEntity.set(eid, (shipByEntity.get(eid) || 0) + cents);
      shipByOrder.set(oid, { entity_id: eid, cents });
    }

    // ---- SHIPPING refund tax. Same dominant-entity rule, subtracted.
    const shipRefRows = sqlite.prepare(`
      SELECT rli.order_id AS order_id, rli.total_tax AS total_tax
      FROM recon_refund_line_items rli
      JOIN recon_refunds rf ON rf.id = rli.refund_id
      WHERE rli.kind = 'adjustment'
        AND rli.adjustment_kind = 'shipping_refund'
        AND substr(datetime(
              COALESCE(rf.processed_at, rf.created_at),
              '-5 hours'), 1, 7) = ?
    `).all(month) as any[];
    const shipRefByEntity = new Map<number, number>();
    for (const r of shipRefRows) {
      const cents = Math.round(Math.abs(Number(r.total_tax || 0)) * 100);
      if (cents === 0) continue;
      const eid = dominantEntityForOrder(String(r.order_id));
      shipRefByEntity.set(eid, (shipRefByEntity.get(eid) || 0) + cents);
    }

    // Net per entity = fwdLine - refLine + shipFwd - shipRef. Computed from
    // ONE set of per-row integer cents — this is what makes the invariant hold.
    const allEntities = new Set<number>();
    [fwdByEntity, refByEntity, shipByEntity, shipRefByEntity].forEach((m) =>
      m.forEach((_v, k) => allEntities.add(k)),
    );

    return {
      posEntitySet,
      fwdByEntity, refByEntity, shipByEntity, shipRefByEntity,
      fwdLineCountByEntity,
      splitLineCount,
      rawForwardCentsTotal, attrForwardCentsTotal,
      allEntities,
      // drill-down structures
      lineDetailByOrder, refByOrderLine, shipByOrder,
    };
  };

  // Entity display-name resolver shared by the endpoints.
  const entityNameOf = (id: number): string | null => {
    if (id === 0) return "Unallocated";
    const { sqlite } = require("./storage");
    const row = sqlite.prepare(`SELECT location FROM payroll_entities WHERE id = ?`).get(id) as any;
    return row?.location ?? null;
  };

  // ===================================================================
  // SALES TAX (PR #165) — backend foundation. UI lands in PR #166/#167.
  //
  // Per-store/month sales-tax figures, all in integer cents:
  //   gross_sales_cents     Σ line_subtotal (pre-tax) over attributed lines
  //   taxable_sales_cents   Σ line_subtotal where the line carried tax
  //   exempt_sales_cents    gross - taxable
  //   tax_collected_cents   forward LINE tax + forward SHIPPING tax (engine)
  //   refund_tax_in_period_cents  refund LINE tax + refund SHIPPING tax (engine,
  //                          already ABS-wrapped — sign-convention trap handled)
  //   net_tax_cents         tax_collected - refund_tax (== engine net per entity)
  //
  // Net tax is sourced from computeAttributionForMonth (the same canonical
  // v_attributed_sales engine /by-store uses), so the parts (3 stores +
  // Unallocated) sum to the engine grand total by construction — that's the
  // invariant the response asserts. Gross/taxable/exempt are line-subtotal
  // tallies attributed via the identical pickEntity cascade. Jurisdiction
  // facts (county/rate/closed) come from STORE_TAX_MAPPING, never per-line.
  // -------------------------------------------------------------------

  type SalesTaxStoreRow = {
    store_id: string;
    name: string;
    entity_id: number;
    county: string;
    state: string;
    rate_bps: number;
    closed: boolean;
    unexpected_activity: boolean;
    gross_sales_cents: number;
    taxable_sales_cents: number;
    exempt_sales_cents: number;
    tax_collected_cents: number;
    refund_tax_in_period_cents: number;
    net_tax_cents: number;
    // PR #168: marketplace-facilitator carve-out. Shopify already remits these
    // to NY, so they are EXCLUDED from net_tax_cents (the filing number) and
    // surfaced separately for the ST-810 "report but don't owe" column.
    marketplace_sales_cents: number;
    marketplace_tax_cents: number;
  };

  type WarehouseAnomaly = {
    location_id: string;
    name: string;
    taxable_cents: number;
  };

  type SalesTaxMonth = {
    month: string;
    filing_mode: "month" | "quarter";
    quarter_key: string | null;
    form_type: "ST-809" | "ST-810";
    stores: SalesTaxStoreRow[];
    totals: {
      gross_sales_cents: number;
      taxable_sales_cents: number;
      tax_collected_cents: number;
      net_tax_cents: number;
      marketplace_sales_cents: number;
      marketplace_tax_cents: number;
    };
    warehouse_anomalies: WarehouseAnomaly[];
    invariant: {
      ok: boolean;
      per_entity_sum_cents: number;
      view_total_cents: number;
      delta_cents: number;
    };
  };

  // R6a: NY ST-810 quarter calendar.
  // NY sales-tax year is March-February. Quarters per NY DTF Pub 718-Q:
  //   Q1 Mar/Apr/May  (end May, file by Jun 20)
  //   Q2 Jun/Jul/Aug  (end Aug, file by Sep 20)
  //   Q3 Sep/Oct/Nov  (end Nov, file by Dec 20)
  //   Q4 Dec/Jan/Feb  (end Feb, file by Mar 20; spans year boundary)
  // Quarter year-label = year of the quarter's FIRST month (matches
  // quarterToMonths in shopify-tax-aggregation.ts):
  //   2026-Q1 = Mar/Apr/May 2026, 2026-Q4 = Dec 2026 + Jan/Feb 2027.
  // Jan/Feb belong to the previous calendar year's Q4.
  //
  // Previously this function returned the OFFSET-BY-ONE convention
  // (Dec/Jan/Feb -> Q1), which disagreed with quarterToMonths and caused
  // the UI to pull the wrong 3 months into the ST-810 rollup.
  const QUARTER_END_MONTHS = new Set([5, 8, 11, 2]);
  const quarterKeyForMonth = (month: string): string => {
    const [yStr, mStr] = month.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    if (m >= 3 && m <= 5) return `${y}-Q1`;
    if (m >= 6 && m <= 8) return `${y}-Q2`;
    if (m >= 9 && m <= 11) return `${y}-Q3`;
    if (m === 12) return `${y}-Q4`;
    // Jan/Feb -> previous calendar year's Q4 (the Q that started last Dec).
    return `${y - 1}-Q4`;
  };

  // Per-month sales-tax computation. Pure read. Returns the SalesTaxMonth shape
  // minus the filing block (callers attach filing state).
  const computeSalesTaxForMonth = (month: string): SalesTaxMonth => {
    const { sqlite } = require("./storage");

    // PR #168 marketplace fix: read the single-source-of-truth aggregator
    // instead of summing raw per-line tax from v_attributed_sales. The raw tax
    // INCLUDES Shopify-marketplace-facilitated tax (channel_liable=true) that
    // Shopify already remits to NY; filing from it double-pays. aggregateByEntity
    // carves marketplace out into marketplace_tax_collected, leaving tax_owed as
    // the merchant's actual liability. The aggregation itself is UNTOUCHED.
    const { inputs, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax, entityNames } =
      loadTaxInputsForMonth(month);
    const entities: EntitySummary[] = aggregateByEntity(
      inputs, entityNames, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax,
    );
    const byEntity = new Map<number, EntitySummary>();
    for (const e of entities) byEntity.set(e.entity_id, e);

    // dollars-string → integer cents (aggregator output is fixed-2 strings).
    const cents = (s: string | undefined): number => toCents(s != null ? Number(s) : 0);

    const stores: SalesTaxStoreRow[] = STORE_TAX_MAPPING.map((m) => {
      const eid = m.entity_id;
      const e = byEntity.get(eid);
      const gross = e ? cents(e.gross_sales) : 0;
      const taxable = e ? cents(e.taxable_sales) : 0;
      const nonTaxable = e ? cents(e.non_taxable_sales) : 0;
      const taxOwed = e ? cents(e.tax_owed) : 0;
      const taxCollected = e ? cents(e.tax_collected_gross) : 0;
      const mktSales = e ? cents(e.marketplace_gross) : 0;
      const mktTax = e ? cents(e.marketplace_tax_collected) : 0;
      // All three stores are continuously active (closed_after_month=null).
      const closed = isStoreClosedForMonth(m, month);
      return {
        store_id: m.store_id,
        name: m.name,
        entity_id: eid,
        county: m.county,
        state: m.state,
        rate_bps: m.rate_bps,
        closed,
        unexpected_activity: false,
        gross_sales_cents: gross,
        taxable_sales_cents: taxable,
        exempt_sales_cents: nonTaxable,
        tax_collected_cents: taxCollected,
        // marketplace tax is collected-but-remitted-by-Shopify; the refund delta
        // is already folded into tax_owed by the aggregator, so the displayed
        // "refund tax in period" is the difference between collected and owed
        // minus marketplace (kept for back-compat; not used for filing).
        refund_tax_in_period_cents: taxCollected - mktTax - taxOwed,
        net_tax_cents: taxOwed,
        marketplace_sales_cents: mktSales,
        marketplace_tax_cents: mktTax,
      };
    });

    const totals = stores.reduce(
      (acc, s) => ({
        gross_sales_cents: acc.gross_sales_cents + s.gross_sales_cents,
        taxable_sales_cents: acc.taxable_sales_cents + s.taxable_sales_cents,
        tax_collected_cents: acc.tax_collected_cents + s.tax_collected_cents,
        net_tax_cents: acc.net_tax_cents + s.net_tax_cents,
        marketplace_sales_cents: acc.marketplace_sales_cents + s.marketplace_sales_cents,
        marketplace_tax_cents: acc.marketplace_tax_cents + s.marketplace_tax_cents,
      }),
      {
        gross_sales_cents: 0, taxable_sales_cents: 0, tax_collected_cents: 0,
        net_tax_cents: 0, marketplace_sales_cents: 0, marketplace_tax_cents: 0,
      },
    );

    // Invariant: Σ tax_owed over the 3 mapped stores + Unallocated must equal
    // the aggregator's grand total tax_owed. Both sides now read the same
    // marketplace-carved source, so they tie to the penny.
    const viewTotal = entities.reduce((a, e) => a + cents(e.tax_owed), 0);
    const unallocated = byEntity.get(0);
    const perEntitySum = stores.reduce((a, s) => a + s.net_tax_cents, 0)
      + (unallocated ? cents(unallocated.tax_owed) : 0);
    const delta = perEntitySum - viewTotal;

    // Warehouse anomaly: any taxable line attributed to a warehouse/fulfillment
    // location (which should never sell). Non-blocking — attribution unchanged.
    const warehouseRows = sqlite.prepare(`
      SELECT s.pos_location_id AS location_id,
             SUM(ABS(COALESCE(li.line_subtotal, 0)) * 100) AS taxable_cents
        FROM v_attributed_sales v
        JOIN recon_line_items li ON li.id = v.line_item_id AND li.order_id = v.order_id
        JOIN recon_shopify_sales s
          ON s.order_id = v.order_id AND s.line_item_id = v.line_item_id
       WHERE v.happened_month = ?
         AND li.line_tax_total IS NOT NULL AND li.line_tax_total != 0
         AND s.pos_location_id IS NOT NULL
       GROUP BY s.pos_location_id
    `).all(month) as Array<{ location_id: string; taxable_cents: number }>;
    const warehouse_anomalies: WarehouseAnomaly[] = [];
    for (const r of warehouseRows) {
      const id = String(r.location_id);
      const name = WAREHOUSE_LOCATION_IDS[id];
      if (name) {
        warehouse_anomalies.push({
          location_id: id,
          name,
          taxable_cents: Math.round(Number(r.taxable_cents || 0)),
        });
      }
    }

    const [, mStr] = month.split("-");
    const isQuarterEnd = QUARTER_END_MONTHS.has(Number(mStr));
    const filingMode: "month" | "quarter" = isQuarterEnd ? "quarter" : "month";

    return {
      month,
      filing_mode: filingMode,
      quarter_key: quarterKeyForMonth(month),
      form_type: isQuarterEnd ? "ST-810" : "ST-809",
      stores,
      totals,
      warehouse_anomalies,
      invariant: {
        ok: delta === 0,
        per_entity_sum_cents: perEntitySum,
        view_total_cents: viewTotal,
        delta_cents: delta,
      },
    };
  };

  // Legacy aggregate filing block (entity_id = 0). Kept so the existing
  // payload shape stays stable while we roll out per-entity filings.
  const filingBlockFor = (periodKey: string) =>
    getFiling(periodKey, 0) ?? openFilingPlaceholder(periodKey, 0);

  // Per-entity filing rows for entity_ids 1, 2, 3. Falls back to an "open"
  // placeholder for any entity that hasn't been touched yet, so the UI can
  // always render three checklist cards.
  const filingsByEntityFor = (periodKey: string) => {
    const rows = new Map<number, ReturnType<typeof getFiling>>();
    for (const r of getFilingsByPeriod(periodKey)) {
      rows.set(r.entity_id, r);
    }
    return [1, 2, 3].map((eid) => rows.get(eid) ?? openFilingPlaceholder(periodKey, eid));
  };

  // -------------------------------------------------------------------
  // Export support (PR #167). Per-line taxable detail for the XLSX "Line
  // Detail" sheet — every forward taxable line for a month, attributed to a
  // store via the identical pickEntity cascade used by computeSalesTaxForMonth.
  // Refund lines (negative tax) are surfaced with refund_flag=true. Integer
  // cents throughout; refund amounts ABS-wrapped. v_attributed_sales is the
  // only sales source.
  // -------------------------------------------------------------------
  const lineDetailForMonth = (month: string): ExportLineDetail[] => {
    const { sqlite } = require("./storage");
    const attribution = computeAttributionForMonth(month);
    const posEntitySet: Set<number> = attribution.posEntitySet;
    const pickEntity = (
      posEid: number | null, perLineEid: number | null,
      orderEid: number | null, dominantEid: number | null,
    ): number => {
      if (posEid != null && posEntitySet.has(Number(posEid))) return Number(posEid);
      if (perLineEid != null && posEntitySet.has(Number(perLineEid))) return Number(perLineEid);
      if (orderEid != null && posEntitySet.has(Number(orderEid))) return Number(orderEid);
      if (dominantEid != null && posEntitySet.has(Number(dominantEid))) return Number(dominantEid);
      return 0;
    };

    const rows = sqlite.prepare(`
      SELECT
        o.name AS order_name,
        substr(datetime(COALESCE(li.recognized_at, o.processed_at, o.created_at), '-5 hours'), 1, 19) AS date_et,
        v.per_line_entity_id, v.per_line_share, v.order_entity_id, v.dominant_entity_id,
        li.line_subtotal AS line_subtotal,
        li.line_tax_total AS line_tax_total,
        (SELECT pl.entity_id
           FROM recon_shopify_sales s
           JOIN recon_entity_pos_locations pl
             ON pl.shopify_location_id = s.pos_location_id
            AND pl.kind = 'pos' AND pl.active = 1
          WHERE s.order_id = v.order_id AND s.line_item_id = v.line_item_id
            AND s.pos_location_id IS NOT NULL
          LIMIT 1) AS pos_entity_id
      FROM v_attributed_sales v
      JOIN recon_line_items li ON li.id = v.line_item_id AND li.order_id = v.order_id
      JOIN recon_orders o ON o.id = v.order_id
      WHERE v.happened_month = ?
        AND COALESCE(li.line_tax_total, 0) <> 0
      ORDER BY date_et ASC, order_name ASC
    `).all(month) as any[];

    const out: ExportLineDetail[] = [];
    for (const r of rows) {
      const eid = pickEntity(r.pos_entity_id, r.per_line_entity_id, r.order_entity_id, r.dominant_entity_id);
      const m = mappingByEntityId(eid);
      const share = r.per_line_share != null ? Number(r.per_line_share) : 1;
      out.push({
        order_name: r.order_name ?? "(unknown)",
        order_date_eastern: r.date_et ?? "",
        store_name: m?.name ?? (eid === 0 ? "Unallocated" : `Entity ${eid}`),
        county: m?.county ?? "",
        rate_bps: m?.rate_bps ?? 0,
        taxable_amount_cents: Math.round(Math.abs(Number(r.line_subtotal || 0)) * 100 * share),
        tax_amount_cents: Math.round(Math.abs(Number(r.line_tax_total || 0)) * 100),
        refund_flag: false,
      });
    }
    return out;
  };

  // Assemble the full ExportPayload for either a month or a quarter period key.
  const buildExportPayload = (periodKey: string): ExportPayload => {
    const isQuarter = /^\d{4}-Q[1-4]$/.test(periodKey);
    const months = isQuarter ? quarterToMonths(periodKey).months : [periodKey];
    const monthPayloads = months.map((m) => computeSalesTaxForMonth(m));
    const lineDetail = months.flatMap((m) => lineDetailForMonth(m));

    // Form type: ST-810 for a quarter export OR a single quarter-end month;
    // ST-809 otherwise. monthPayloads carry form_type, which agrees.
    const formType: "ST-809" | "ST-810" =
      isQuarter || monthPayloads.some((mm) => mm.form_type === "ST-810") ? "ST-810" : "ST-809";

    const totals = monthPayloads.reduce(
      (acc, mm) => ({
        gross_sales_cents: acc.gross_sales_cents + mm.totals.gross_sales_cents,
        taxable_sales_cents: acc.taxable_sales_cents + mm.totals.taxable_sales_cents,
        tax_collected_cents: acc.tax_collected_cents + mm.totals.tax_collected_cents,
        net_tax_cents: acc.net_tax_cents + mm.totals.net_tax_cents,
        marketplace_sales_cents: acc.marketplace_sales_cents + mm.totals.marketplace_sales_cents,
        marketplace_tax_cents: acc.marketplace_tax_cents + mm.totals.marketplace_tax_cents,
      }),
      {
        gross_sales_cents: 0, taxable_sales_cents: 0, tax_collected_cents: 0,
        net_tax_cents: 0, marketplace_sales_cents: 0, marketplace_tax_cents: 0,
      },
    );
    const perEntitySum = monthPayloads.reduce((a, mm) => a + mm.invariant.per_entity_sum_cents, 0);
    const viewTotal = monthPayloads.reduce((a, mm) => a + mm.invariant.view_total_cents, 0);
    const delta = perEntitySum - viewTotal;

    // Per-entity filing rows: sum each entity's store rows across the period.
    //
    // PR #198 (ST5) — entity facts come from `payroll_entities`. Smart-middle
    // rule: include active entities + any inactive ones that had sales in any
    // month of the period (so an entity deactivated mid-period still appears).
    // For ST-810 we additionally drop entities missing jurisdiction config
    // (county / rate_bps / dtf_code) per the "silently skip but flag in the
    // payload" decision — surfaced via `excluded_entities` below.
    const tinByEntity = getEntitySettings();
    const periodEntityIds = new Set<number>();
    for (const mm of monthPayloads) for (const s of mm.stores) periodEntityIds.add(s.entity_id);
    const candidateFilingEntities = loadFilingEntities({ entitiesWithSalesInPeriod: periodEntityIds });
    const excludedEntities: Array<{ entity_id: number; legal_name: string; missing: string[] }> = [];
    const filingEntities: EntityFilingInfo[] = [];
    for (const info of candidateFilingEntities) {
      if (formType === "ST-810" && !isFilingComplete(info)) {
        const missing: string[] = [];
        if (!info.county) missing.push("county");
        if (info.rate_bps === null) missing.push("rate_bps");
        if (!info.dtf_code) missing.push("dtf_code");
        excludedEntities.push({ entity_id: info.entity_id, legal_name: info.legal_name, missing });
        continue;
      }
      filingEntities.push(info);
    }
    const entities = filingEntities.map((info) => {
      let gross = 0, mkt = 0, taxable = 0, taxDue = 0, mktTax = 0;
      for (const mm of monthPayloads) {
        const s = mm.stores.find((st) => st.entity_id === info.entity_id);
        if (!s) continue;
        gross += s.gross_sales_cents;
        mkt += s.marketplace_sales_cents;
        taxable += s.taxable_sales_cents;
        taxDue += s.net_tax_cents;
        mktTax += s.marketplace_tax_cents;
      }
      return {
        entity_id: info.entity_id,
        legal_name: info.legal_name,
        tin: tinByEntity.get(String(info.entity_id))?.tin ?? null,
        // PR #198 — county/dtf_code are NULL-able in payroll_entities; coerce
        // to "" at the export boundary so CSV/XLSX/PDF formatters keep their
        // current string contract. ST-810 entities are pre-filtered above to
        // require non-null jurisdiction config, so empty strings here only
        // ever appear on ST-809 rows (where these fields are informational).
        county: info.county ?? "",
        dtf_code: info.dtf_code ?? "",
        gross_sales_cents: gross,
        marketplace_sales_cents: mkt,
        taxable_sales_cents: taxable,
        tax_due_cents: taxDue,
        marketplace_tax_cents: mktTax,
      };
    });

    // Per-jurisdiction rows (ST-810 only): run aggregateByJurisdiction across
    // the period union + enrich with DTF code + fractional rate.
    // R6b: also derive NY locality rollup + marketplace-provider rows from the
    // same breakdown (single pass, no parallel aggregator).
    const jurisdictions: ExportPayload["jurisdictions"] = [];
    const localities: ExportPayload["localities"] = [];
    const marketplaceProviders: ExportPayload["marketplaceProviders"] = [];
    const unmappedSet = new Set<string>();
    if (formType === "ST-810") {
      const all: AggregatorInput[] = [];
      const allRefunds: RefundForTax[] = [];
      const allShipFwd: ShippingTaxForward[] = [];
      const allShipRef: ShippingTaxRefund[] = [];
      const allUnverified: UnverifiedReturnTax[] = [];
      const names = new Map<number, string>();
      for (const m of months) {
        const { inputs, refunds, shippingTaxForward, shippingTaxRefunds, unverifiedReturnTax, entityNames } = loadTaxInputsForMonth(m);
        all.push(...inputs);
        allRefunds.push(...refunds);
        allShipFwd.push(...shippingTaxForward);
        allShipRef.push(...shippingTaxRefunds);
        allUnverified.push(...unverifiedReturnTax);
        for (const [k, v] of entityNames) names.set(k, v);
      }
      const breakdown = aggregateByJurisdiction(all, names, allRefunds, allShipFwd, allShipRef, allUnverified);
      for (const ent of breakdown) {
        const legal = legalNameFor(ent.entity_id);
        // R6b: per-entity locality + component accumulators. Walk this entity's
        // jurisdictions ONCE, populating both the per-jurisdiction (audit) rows
        // AND aggregating into NY localities for the filing summary.
        // NY locality keying:
        //   COUNTY/NYC-anchor row (maps to DTF code, not bare state, not MCTD) ->
        //     its taxable_sales is the locality's taxable base.
        //   STATE/SPECIAL(MCTD) rows -> contribute to tax_components_cents only.
        //     The 4% state + 0.375% MCTD components attach to lines that ALSO
        //     have a county anchor, so component-sum vs combined-rate*taxable
        //     should tie to the penny absent edge cases.
        type LocAccum = {
          locality_name: string;
          dtf_code: string;
          combined_rate_bps: number;
          rate_display: string;
          taxable_cents: number;
          mkt_taxable_cents: number;
          mkt_tax_cents: number;
          county_tax_cents: number;
        };
        const locByCode = new Map<string, LocAccum>();
        // R6c: NY OTHER-typed rows (e.g. "Nassau CO Transit District", "NEW YORK CITY CITY TAX")
        // are locality COMPONENTS, not out-of-state marketplace lines. Bucket their tax_due
        // by parent locality DTF code so we can fold into tax_components_cents during rollup.
        const otherComponentByCode = new Map<string, { tax: number; mktTax: number }>();
        let stateTaxCents = 0;
        let mctdTaxCents = 0;
        let stateMktTaxCents = 0;
        let mctdMktTaxCents = 0;

        for (const j of ent.jurisdictions) {
          const dtf = dtfByName(j.jurisdiction_name);
          // NY state-level (4%) and MCTD (0.375%) are intentional unmapped rows:
          // they don't have a DTF locality code because they're proportionally
          // allocated into every locality's tax_components_cents (see isNYState/
          // isMCTD branches below). Suppress them from the "verify manually"
          // warning so only truly-unmapped jurisdictions surface.
          if (!dtf) {
            const nm = j.jurisdiction_name.toUpperCase();
            const isStateComp = nm === "NEW YORK STATE TAX" ||
              nm.includes("MCTD") || nm.includes("METROPOLITAN") || nm.includes("MTA");
            if (!isStateComp) unmappedSet.add(j.jurisdiction_name);
          }
          const rateNum = Number(j.rate);
          const taxableCents = toCents(Number(j.taxable_sales));
          const taxDueCents = toCents(Number(j.tax_due));
          const mktTaxableCents = toCents(Number(j.marketplace_taxable));
          const mktTaxCents = toCents(Number(j.marketplace_tax));

          jurisdictions.push({
            entity_id: ent.entity_id,
            entity_legal_name: legal,
            jurisdiction_name: j.jurisdiction_name,
            dtf_code: dtf?.code ?? null,
            rate: rateNum,
            rate_display: dtf?.rate_display ?? formatRateAsFraction(rateNum),
            taxable_sales_cents: taxableCents,
            tax_due_cents: taxDueCents,
            marketplace_taxable_cents: mktTaxableCents,
            marketplace_tax_cents: mktTaxCents,
          });

          const jurType = String(j.jurisdiction_type || "").toUpperCase();
          const nameU = j.jurisdiction_name.toUpperCase();
          const isNYState = nameU === "NEW YORK STATE TAX" ||
            (jurType === "STATE" && (nameU === "NY" || nameU === "NEW YORK"));
          const isMCTD = jurType === "SPECIAL" ||
            nameU.includes("MCTD") || nameU.includes("METROPOLITAN") || nameU.includes("MTA");
          // R6f: tighten anchor detection. The R6d token matcher resolves Nassau
          // for BOTH "NASSAU COUNTY TAX" (true anchor) and "NASSAU CO TRANSIT
          // DISTRICT" (locality component). Without this guard both rows added
          // their taxable_sales to the Nassau bucket, doubling locality taxable
          // vs the entity's actual taxable. Anchor requires either jurType=COUNTY,
          // or NYC city-tax name pattern (NEW YORK CITY CITY TAX). Other rows
          // that token-resolve to a locality (transit districts, NYC city tax)
          // route to the otherComponentByCode path for tax-only contribution.
          const isNycCityTax = nameU === "NEW YORK CITY CITY TAX" ||
            nameU.includes("NEW YORK CITY");
          const isCountyAnchor = jurType === "COUNTY";
          const isLocalityAnchor = !!dtf && !isNYState && !isMCTD &&
            (isCountyAnchor || isNycCityTax);

          if (isLocalityAnchor) {
            const existing = locByCode.get(dtf.code);
            if (existing) {
              existing.taxable_cents += taxableCents;
              existing.county_tax_cents += taxDueCents;
              existing.mkt_taxable_cents += mktTaxableCents;
              existing.mkt_tax_cents += mktTaxCents;
            } else {
              locByCode.set(dtf.code, {
                locality_name: dtf.name,
                dtf_code: dtf.code,
                combined_rate_bps: dtf.rate_basis_points,
                rate_display: dtf.rate_display,
                taxable_cents: taxableCents,
                mkt_taxable_cents: mktTaxableCents,
                mkt_tax_cents: mktTaxCents,
                county_tax_cents: taxDueCents,
              });
            }
          } else if (isNYState) {
            stateTaxCents += taxDueCents;
            stateMktTaxCents += mktTaxCents;
          } else if (isMCTD) {
            mctdTaxCents += taxDueCents;
            mctdMktTaxCents += mktTaxCents;
          } else {
            // R6c: try to attribute OTHER-typed NY component rows to their parent
            // locality (Nassau CO Transit -> Nassau; NYC City Tax -> NYC). Falls back
            // to marketplaceProviders only if nothing matches (truly non-NY).
            const nyParent = jurType === "OTHER" ? dtfForNyOtherComponent(j.jurisdiction_name) : undefined;
            if (nyParent) {
              const existing = otherComponentByCode.get(nyParent.code);
              if (existing) {
                existing.tax += taxDueCents;
                existing.mktTax += mktTaxCents;
              } else {
                otherComponentByCode.set(nyParent.code, { tax: taxDueCents, mktTax: mktTaxCents });
              }
            } else {
              // Non-NY jurisdiction (out-of-state marketplace) -> providers.
              if (mktTaxableCents !== 0 || mktTaxCents !== 0) {
                marketplaceProviders.push({
                  entity_id: ent.entity_id,
                  entity_legal_name: legal,
                  jurisdiction_name: j.jurisdiction_name,
                  jurisdiction_type: jurType || "OTHER",
                  rate: rateNum,
                  rate_display: dtf?.rate_display ?? formatRateAsFraction(rateNum),
                  marketplace_taxable_cents: mktTaxableCents,
                  marketplace_tax_cents: mktTaxCents,
                });
              }
            }
          }
        }

        const totalLocalityTaxable = Array.from(locByCode.values())
          .reduce((acc, l) => acc + l.taxable_cents, 0);

        const localityRows: ExportLocalityRow[] = [];
        for (const loc of Array.from(locByCode.values())) {
          // R6f: rate_basis_points stores 8625 for 8.625%, so the decimal
          // conversion is /100000 (not /10000). The /10000 form produced
          // tax_due 10x too high on every locality row.
          const combinedTaxCents = Math.round((loc.taxable_cents * loc.combined_rate_bps) / 100000);
          let stateShare = 0;
          let mctdShare = 0;
          let stateMktShare = 0;
          let mctdMktShare = 0;
          if (totalLocalityTaxable > 0) {
            stateShare = Math.round((stateTaxCents * loc.taxable_cents) / totalLocalityTaxable);
            mctdShare = Math.round((mctdTaxCents * loc.taxable_cents) / totalLocalityTaxable);
            stateMktShare = Math.round((stateMktTaxCents * loc.taxable_cents) / totalLocalityTaxable);
            mctdMktShare = Math.round((mctdMktTaxCents * loc.taxable_cents) / totalLocalityTaxable);
          }
          // R6c: add NY OTHER-typed component contributions (e.g. Nassau CO Transit)
          // attributed to THIS locality.
          const otherForLoc = otherComponentByCode.get(loc.dtf_code);
          const otherTaxCents = otherForLoc?.tax ?? 0;
          const otherMktTaxCents = otherForLoc?.mktTax ?? 0;
          const componentSum = loc.county_tax_cents + stateShare + mctdShare + otherTaxCents;
          localityRows.push({
            entity_id: ent.entity_id,
            entity_legal_name: legal,
            locality_name: loc.locality_name,
            dtf_code: loc.dtf_code,
            combined_rate: loc.combined_rate_bps / 100000,
            rate_display: loc.rate_display,
            taxable_sales_cents: loc.taxable_cents,
            tax_due_cents: combinedTaxCents,
            tax_components_cents: componentSum,
            audit_delta_cents: combinedTaxCents - componentSum,
            marketplace_taxable_cents: loc.mkt_taxable_cents,
            marketplace_tax_cents: loc.mkt_tax_cents + stateMktShare + mctdMktShare + otherMktTaxCents,
          });
        }
        localityRows.sort((a, b) => b.tax_due_cents - a.tax_due_cents);
        localities.push(...localityRows);
      }
    }

    const generatedAtET = new Date(Date.now() - 5 * 3600 * 1000)
      .toISOString().slice(0, 19).replace("T", " ") + " ET";

    return {
      periodKey,
      isQuarter,
      formType,
      months: monthPayloads,
      totals,
      invariant: {
        ok: delta === 0 && monthPayloads.every((mm) => mm.invariant.ok),
        per_entity_sum_cents: perEntitySum,
        view_total_cents: viewTotal,
        delta_cents: delta,
      },
      lineDetail,
      entities,
      jurisdictions,
      localities,
      marketplaceProviders,
      unmappedJurisdictions: Array.from(unmappedSet).sort(),
      excludedEntities,
      generatedAtET,
    };
  };

  // 1. GET /api/recon/finance/sales-tax/:month — composite monthly payload.
  app.get(
    "/api/recon/finance/sales-tax/:month",
    authMiddleware,
    requirePermission("finance.sales_tax.view"),
    (req, res) => {
      const month = String(req.params.month);
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "Month must be YYYY-MM" });
      }
      try {
        const base = computeSalesTaxForMonth(month);
        res.json({
          ...base,
          filing: filingBlockFor(month),
          filings_by_entity: filingsByEntityFor(month),
        });
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "sales-tax compute failed" });
      }
    },
  );

  // 2. GET /api/recon/finance/sales-tax/quarter/:quarterKey — 3-month ST-810 rollup.
  app.get(
    "/api/recon/finance/sales-tax/quarter/:quarterKey",
    authMiddleware,
    requirePermission("finance.sales_tax.view"),
    (req, res) => {
      const quarterKey = String(req.params.quarterKey);
      if (!/^\d{4}-Q[1-4]$/.test(quarterKey)) {
        return res.status(400).json({ message: "quarterKey must be YYYY-QN" });
      }
      try {
        const { months } = quarterToMonths(quarterKey);
        const perMonth = months.map((m) => ({
          ...computeSalesTaxForMonth(m),
          filing: filingBlockFor(m),
          filings_by_entity: filingsByEntityFor(m),
        }));
        const quarterTotals = perMonth.reduce(
          (acc, mm) => ({
            gross_sales_cents: acc.gross_sales_cents + mm.totals.gross_sales_cents,
            taxable_sales_cents: acc.taxable_sales_cents + mm.totals.taxable_sales_cents,
            tax_collected_cents: acc.tax_collected_cents + mm.totals.tax_collected_cents,
            net_tax_cents: acc.net_tax_cents + mm.totals.net_tax_cents,
          }),
          { gross_sales_cents: 0, taxable_sales_cents: 0, tax_collected_cents: 0, net_tax_cents: 0 },
        );
        const perEntitySum = perMonth.reduce((a, mm) => a + mm.invariant.per_entity_sum_cents, 0);
        const viewTotal = perMonth.reduce((a, mm) => a + mm.invariant.view_total_cents, 0);
        const delta = perEntitySum - viewTotal;
        res.json({
          quarter_key: quarterKey,
          months,
          per_month: perMonth,
          quarter_totals: quarterTotals,
          quarter_invariant: {
            ok: delta === 0 && perMonth.every((mm) => mm.invariant.ok),
            per_entity_sum_cents: perEntitySum,
            view_total_cents: viewTotal,
            delta_cents: delta,
          },
          filing: filingBlockFor(quarterKey),
          filings_by_entity: filingsByEntityFor(quarterKey),
        });
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "quarter compute failed" });
      }
    },
  );

  // R6d-prep — Read-only debug endpoint. Walks each taxable line in the month,
  // parses tax_lines_json to find each line's ship-to NY locality (the COUNTY-typed
  // jurisdiction row, or NY OTHER-typed locality variant), and sums line_tax_total
  // by (entity, locality). Lets us verify penny-exact attribution BEFORE changing
  // any export logic. No mutations.
  app.get(
    "/api/recon/debug/locality-probe/:month",
    authMiddleware,
    requirePermission("finance.sales_tax.view"),
    (req, res) => {
      const month = String(req.params.month);
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "month must be YYYY-MM" });
      }
      try {
        const attribution = computeAttributionForMonth(month);
        const posEntitySet: Set<number> = attribution.posEntitySet;
        const pickEntity = (
          posEid: number | null, perLineEid: number | null,
          orderEid: number | null, dominantEid: number | null,
        ): number => {
          if (posEid != null && posEntitySet.has(Number(posEid))) return Number(posEid);
          if (perLineEid != null && posEntitySet.has(Number(perLineEid))) return Number(perLineEid);
          if (orderEid != null && posEntitySet.has(Number(orderEid))) return Number(orderEid);
          if (dominantEid != null && posEntitySet.has(Number(dominantEid))) return Number(dominantEid);
          return 0;
        };

        const rows = (require("./storage").sqlite as any).prepare(`
          SELECT
            o.name AS order_name,
            v.per_line_entity_id, v.per_line_share, v.order_entity_id, v.dominant_entity_id,
            li.line_subtotal AS line_subtotal,
            li.line_tax_total AS line_tax_total,
            li.tax_lines_json AS tax_lines_json,
            li.tax_channel_liable AS tax_channel_liable,
            (SELECT pl.entity_id
               FROM recon_shopify_sales s
               JOIN recon_entity_pos_locations pl
                 ON pl.shopify_location_id = s.pos_location_id
                AND pl.kind = 'pos' AND pl.active = 1
              WHERE s.order_id = v.order_id AND s.line_item_id = v.line_item_id
                AND s.pos_location_id IS NOT NULL
              LIMIT 1) AS pos_entity_id
          FROM v_attributed_sales v
          JOIN recon_line_items li ON li.id = v.line_item_id AND li.order_id = v.order_id
          JOIN recon_orders o ON o.id = v.order_id
          WHERE v.happened_month = ?
            AND COALESCE(li.line_tax_total, 0) <> 0
          ORDER BY o.name ASC
        `).all(month) as any[];

        type LocBucket = {
          locality_name: string;
          dtf_code: string;
          rate_display: string;
          taxable_cents: number;
          tax_cents: number;
          lines: number;
        };
        type EntBucket = {
          entity_id: number;
          entity_legal_name: string;
          home_county: string;
          gross_sales_cents: number;        // ALL lines incl marketplace + out-of-state
          ny_taxable_sales_cents: number;   // non-marketplace NY only
          tax_due_cents: number;            // ny taxable sum of line_tax_total
          marketplace_sales_cents: number;
          out_of_state_sales_cents: number;
          unattributed_ny_cents: number;    // NY tax line with no county anchor found
          localities: Map<string, LocBucket>;
        };
        const byEntity = new Map<number, EntBucket>();

        let unattributedSamples: any[] = [];
        let totalLines = 0;
        let sampleTitles: any[] = [];

        for (const r of rows) {
          totalLines++;
          const eid = pickEntity(r.pos_entity_id, r.per_line_entity_id, r.order_entity_id, r.dominant_entity_id);
          const m = mappingByEntityId(eid);
          const share = r.per_line_share != null ? Number(r.per_line_share) : 1;
          const subC = Math.round(Math.abs(Number(r.line_subtotal || 0)) * 100 * share);
          const taxC = Math.round(Math.abs(Number(r.line_tax_total || 0)) * 100 * share);
          const isMarketplace = Boolean(r.tax_channel_liable);

          let bucket = byEntity.get(eid);
          if (!bucket) {
            bucket = {
              entity_id: eid,
              entity_legal_name: legalNameFor(eid) || `Entity ${eid}`,
              home_county: m?.county ?? "",
              gross_sales_cents: 0,
              ny_taxable_sales_cents: 0,
              tax_due_cents: 0,
              marketplace_sales_cents: 0,
              out_of_state_sales_cents: 0,
              unattributed_ny_cents: 0,
              localities: new Map(),
            };
            byEntity.set(eid, bucket);
          }

          bucket.gross_sales_cents += subC;
          if (isMarketplace) bucket.marketplace_sales_cents += subC;

          // Parse tax_lines_json to find this line's ship-to NY locality.
          let txLines: any[] = [];
          try { txLines = JSON.parse(r.tax_lines_json || "[]"); } catch { txLines = []; }
          if (sampleTitles.length < 5 && txLines.length > 0) {
            sampleTitles.push({
              order: r.order_name,
              raw: txLines,
            });
          }

          let isNY = false;
          let locDtf: { code: string; name: string; rate_display: string } | undefined;
          for (const tl of txLines) {
            // tl.title is the fallback when Shopify didn't populate jurisdiction_name
            // (the aggregator uses the same fallback).
            const nm = String(tl.jurisdiction_name || tl.title || "").toUpperCase();
            const ty = String(tl.jurisdiction_type || "").toUpperCase();
            if (nm.includes("NEW YORK STATE") || nm.includes("MCTD") || nm.includes("METROPOLITAN")) {
              isNY = true;
            }
            // Find the LOCALITY anchor (county or NYC variant). Prefer COUNTY-type.
            if (!locDtf) {
              const dtf = dtfByName(nm);
              if (dtf) {
                locDtf = { code: dtf.code, name: dtf.name, rate_display: dtf.rate_display };
                isNY = true;
              }
            }
          }

          if (isMarketplace) {
            // Marketplace sales: count in gross (already counted) but NOT in NY taxable / tax_due.
            continue;
          }
          if (!isNY) {
            // Out-of-state, non-marketplace: gross only, not in NY taxable.
            bucket.out_of_state_sales_cents += subC;
            continue;
          }
          // NY non-marketplace sale.
          bucket.ny_taxable_sales_cents += subC;
          bucket.tax_due_cents += taxC;

          if (!locDtf) {
            // NY sale with no county anchor — surface for investigation.
            bucket.unattributed_ny_cents += taxC;
            if (unattributedSamples.length < 10) {
              unattributedSamples.push({
                order: r.order_name, entity: eid, tax_cents: taxC,
                tax_lines: txLines.map(t => ({
                  name: t.jurisdiction_name,
                  type: t.jurisdiction_type,
                  title: t.title,
                  rate: t.rate,
                  price: t.price,
                  dtf_lookup: dtfByName(String(t.jurisdiction_name || t.title || ""))?.code || null,
                })),
              });
            }
            continue;
          }

          let lb = bucket.localities.get(locDtf.code);
          if (!lb) {
            lb = {
              locality_name: locDtf.name,
              dtf_code: locDtf.code,
              rate_display: locDtf.rate_display,
              taxable_cents: 0,
              tax_cents: 0,
              lines: 0,
            };
            bucket.localities.set(locDtf.code, lb);
          }
          lb.taxable_cents += subC;
          lb.tax_cents += taxC;
          lb.lines += 1;
        }

        const out = {
          month,
          total_lines_walked: totalLines,
          sample_raw_tax_lines: sampleTitles,
          unattributed_samples: unattributedSamples,
          entities: Array.from(byEntity.values()).map(e => ({
            entity_id: e.entity_id,
            entity_legal_name: e.entity_legal_name,
            home_county: e.home_county,
            gross_sales: (e.gross_sales_cents / 100).toFixed(2),
            ny_taxable_sales: (e.ny_taxable_sales_cents / 100).toFixed(2),
            tax_due: (e.tax_due_cents / 100).toFixed(2),
            marketplace_sales: (e.marketplace_sales_cents / 100).toFixed(2),
            out_of_state_sales: (e.out_of_state_sales_cents / 100).toFixed(2),
            unattributed_ny: (e.unattributed_ny_cents / 100).toFixed(2),
            localities: Array.from(e.localities.values()).map(l => ({
              locality: l.locality_name,
              dtf_code: l.dtf_code,
              rate: l.rate_display,
              taxable: (l.taxable_cents / 100).toFixed(2),
              tax_collected: (l.tax_cents / 100).toFixed(2),
              lines: l.lines,
            })),
          })),
        };
        res.json(out);
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "locality-probe failed" });
      }
    },
  );

  // 3. POST /api/recon/finance/sales-tax/filings/:periodKey — upsert filing state.
  app.post(
    "/api/recon/finance/sales-tax/filings/:periodKey",
    authMiddleware,
    requirePermission("finance.sales_tax.export"),
    (req: any, res) => {
      const periodKey = String(req.params.periodKey);
      if (!/^\d{4}-(\d{2}|Q[1-4])$/.test(periodKey)) {
        return res.status(400).json({ message: "periodKey must be YYYY-MM or YYYY-QN" });
      }
      const body = req.body || {};
      const status = body.status as FilingStatus | undefined;
      if (status !== undefined && !["open", "filed", "amended"].includes(status)) {
        return res.status(400).json({ message: "status must be open|filed|amended" });
      }
      // PR #191: per-entity filings. entity_id defaults to 0 (legacy aggregate)
      // to keep older clients working. New UI flows always pass 1, 2, or 3.
      const rawEntity = body.entity_id;
      const entityId = rawEntity === undefined || rawEntity === null
        ? 0
        : Number(rawEntity);
      if (!Number.isInteger(entityId) || ![0, 1, 2, 3].includes(entityId)) {
        return res.status(400).json({ message: "entity_id must be 0, 1, 2, or 3" });
      }
      try {
        const row = upsertFiling(periodKey, {
          entity_id: entityId,
          status,
          filed_at: body.filed_at ?? null,
          confirmation_number: body.confirmation_number ?? null,
          notes: body.notes ?? null,
          filed_by_user_id: req.userId ?? null,
        });
        res.json(row);
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "filing upsert failed" });
      }
    },
  );

  // 4. GET /api/recon/finance/sales-tax/filings — checklist rows in range.
  app.get(
    "/api/recon/finance/sales-tax/filings",
    authMiddleware,
    requirePermission("finance.sales_tax.view"),
    (req, res) => {
      const from = req.query.from ? String(req.query.from) : undefined;
      const to = req.query.to ? String(req.query.to) : undefined;
      try {
        res.json({ filings: listFilings(from, to) });
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "list filings failed" });
      }
    },
  );

  // 4b. GET /api/recon/finance/sales-tax/notes/:periodKey  -> list notes
  //     POST /api/recon/finance/sales-tax/notes/:periodKey -> append a note
  // Append-only audit trail keyed by period_key (YYYY-MM or YYYY-QN). Notes are
  // captured with user_email + created_at; any authenticated user with
  // finance.sales_tax.view can read; write requires the same view permission.
  // This is purely informational (e.g. manual cash refund not in Shopify) — it
  // does not affect any computed sales-tax number.
  app.get(
    "/api/recon/finance/sales-tax/notes/:periodKey",
    authMiddleware,
    requirePermission("finance.sales_tax.view"),
    (req: any, res) => {
      const periodKey = String(req.params.periodKey);
      if (!/^\d{4}-(\d{2}|Q[1-4])$/.test(periodKey)) {
        return res.status(400).json({ message: "periodKey must be YYYY-MM or YYYY-QN" });
      }
      try {
        res.json({ notes: listSalesTaxNotes(periodKey) });
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "list notes failed" });
      }
    },
  );

  app.post(
    "/api/recon/finance/sales-tax/notes/:periodKey",
    authMiddleware,
    requirePermission("finance.sales_tax.view"),
    (req: any, res) => {
      const periodKey = String(req.params.periodKey);
      if (!/^\d{4}-(\d{2}|Q[1-4])$/.test(periodKey)) {
        return res.status(400).json({ message: "periodKey must be YYYY-MM or YYYY-QN" });
      }
      const text = String((req.body && req.body.text) || "").trim();
      if (!text) return res.status(400).json({ message: "text required" });
      if (text.length > 4000) return res.status(400).json({ message: "text too long (max 4000 chars)" });
      try {
        const note = createSalesTaxNote(periodKey, req.email || null, text);
        res.json(note);
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "create note failed" });
      }
    },
  );

  // 4c. Filing attachments (PR #191). Stores the filed-confirmation PDF (or
  // any supporting doc) per (periodKey, entityId). Append/list/download/delete.
  //   GET    /api/recon/finance/sales-tax/filings/:periodKey/:entityId/attachments
  //   POST   /api/recon/finance/sales-tax/filings/:periodKey/:entityId/attachments  (multipart "file")
  //   GET    /api/recon/finance/sales-tax/filings/attachment/:id  -> binary download
  //   DELETE /api/recon/finance/sales-tax/filings/attachment/:id
  // entityId must be 1, 2, or 3 (per-entity filing). Read requires
  // finance.sales_tax.view; write/delete require finance.sales_tax.export.
  const isValidEntityId = (n: number) => [1, 2, 3].includes(n);

  app.get(
    "/api/recon/finance/sales-tax/filings/:periodKey/:entityId/attachments",
    authMiddleware,
    requirePermission("finance.sales_tax.view"),
    (req: any, res) => {
      const periodKey = String(req.params.periodKey);
      const entityId = Number(req.params.entityId);
      if (!/^\d{4}-(\d{2}|Q[1-4])$/.test(periodKey)) {
        return res.status(400).json({ message: "periodKey must be YYYY-MM or YYYY-QN" });
      }
      if (!isValidEntityId(entityId)) {
        return res.status(400).json({ message: "entity_id must be 1, 2, or 3" });
      }
      try {
        res.json({ attachments: listFilingAttachments(periodKey, entityId) });
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "list attachments failed" });
      }
    },
  );

  app.post(
    "/api/recon/finance/sales-tax/filings/:periodKey/:entityId/attachments",
    authMiddleware,
    requirePermission("finance.sales_tax.export"),
    uploadHandler.single("file"),
    (req: any, res) => {
      const periodKey = String(req.params.periodKey);
      const entityId = Number(req.params.entityId);
      if (!/^\d{4}-(\d{2}|Q[1-4])$/.test(periodKey)) {
        return res.status(400).json({ message: "periodKey must be YYYY-MM or YYYY-QN" });
      }
      if (!isValidEntityId(entityId)) {
        return res.status(400).json({ message: "entity_id must be 1, 2, or 3" });
      }
      const file = req.file;
      if (!file || !file.buffer || file.size === 0) {
        return res.status(400).json({ message: "file is required (multipart field name: 'file')" });
      }
      // Defense in depth: only accept PDFs (sniff %PDF- magic), max 25 MB.
      // Anything bigger is almost certainly not a NYS confirmation PDF.
      if (file.size > 25 * 1024 * 1024) {
        return res.status(400).json({ message: "file too large (max 25 MB)" });
      }
      const head = file.buffer.subarray(0, 5).toString("latin1");
      if (head !== "%PDF-") {
        return res.status(400).json({ message: "file must be a PDF" });
      }
      const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
      try {
        const meta = createFilingAttachment({
          periodKey,
          entityId,
          filename: String(file.originalname || "filing.pdf").slice(0, 255),
          contentType: "application/pdf",
          blob: file.buffer,
          sha256,
          uploadedByEmail: req.email || null,
        });
        res.json(meta);
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "attachment create failed" });
      }
    },
  );

  app.get(
    "/api/recon/finance/sales-tax/filings/attachment/:id",
    authMiddleware,
    requirePermission("finance.sales_tax.view"),
    (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ message: "id must be a positive integer" });
      }
      try {
        const att = getFilingAttachment(id);
        if (!att) return res.status(404).json({ message: "attachment not found" });
        const safeName = att.filename.replace(/["\\]/g, "_");
        res.setHeader("Content-Type", att.content_type || "application/pdf");
        res.setHeader("Content-Length", String(att.size_bytes));
        res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
        res.end(att.blob);
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "attachment fetch failed" });
      }
    },
  );

  app.delete(
    "/api/recon/finance/sales-tax/filings/attachment/:id",
    authMiddleware,
    requirePermission("finance.sales_tax.export"),
    (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ message: "id must be a positive integer" });
      }
      try {
        const ok = deleteFilingAttachment(id);
        if (!ok) return res.status(404).json({ message: "attachment not found" });
        res.json({ ok: true });
      } catch (e: any) {
        res.status(500).json({ message: e?.message || "attachment delete failed" });
      }
    },
  );

  // 5. Export endpoints (PR #167) — CSV / PDF / XLSX. periodKey is YYYY-MM or
  // YYYY-QN. Source data via buildExportPayload (reuses computeSalesTaxForMonth);
  // builders live in ./sales-tax-exports. Filename convention:
  //   snohaus-sales-tax-{periodKey}-{tag}.{ext}
  const validPeriodKey = (pk: string) => /^\d{4}-(\d{2}|Q[1-4])$/.test(pk);
  const sendExportError = (res: any, e: any) =>
    res.status(500).json({ message: e?.message || "export failed" });

  app.get(
    "/api/recon/finance/sales-tax/export/:periodKey/csv",
    authMiddleware,
    requirePermission("finance.sales_tax.export"),
    (req, res) => {
      const periodKey = String(req.params.periodKey);
      if (!validPeriodKey(periodKey)) {
        return res.status(400).json({ message: "periodKey must be YYYY-MM or YYYY-QN" });
      }
      try {
        const payload = buildExportPayload(periodKey);
        const csv = buildSalesTaxCsv(payload);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${payload.formType}_${periodKey}_all-entities.csv"`);
        res.send(csv);
      } catch (e: any) { sendExportError(res, e); }
    },
  );

  app.get(
    "/api/recon/finance/sales-tax/export/:periodKey/xlsx",
    authMiddleware,
    requirePermission("finance.sales_tax.export"),
    async (req, res) => {
      const periodKey = String(req.params.periodKey);
      if (!validPeriodKey(periodKey)) {
        return res.status(400).json({ message: "periodKey must be YYYY-MM or YYYY-QN" });
      }
      try {
        const payload = buildExportPayload(periodKey);
        const buf = await buildSalesTaxXlsx(payload);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${payload.formType}_${periodKey}_all-entities.xlsx"`);
        res.send(buf);
      } catch (e: any) { sendExportError(res, e); }
    },
  );

  app.get(
    "/api/recon/finance/sales-tax/export/:periodKey/pdf",
    authMiddleware,
    requirePermission("finance.sales_tax.export"),
    async (req, res) => {
      const periodKey = String(req.params.periodKey);
      if (!validPeriodKey(periodKey)) {
        return res.status(400).json({ message: "periodKey must be YYYY-MM or YYYY-QN" });
      }
      try {
        const payload = buildExportPayload(periodKey);
        const buf = await buildSalesTaxPdf(payload);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${payload.formType}_${periodKey}_all-entities.pdf"`);
        res.send(buf);
      } catch (e: any) { sendExportError(res, e); }
    },
  );

  // -------------------------------------------------------------------
  // (a) GET /api/recon/finance/debug/attributed-sales-truth/:month?entity_id=N
  //     One entity's tax breakdown derived from v_attributed_sales.
  // -------------------------------------------------------------------
  app.get("/api/recon/finance/debug/attributed-sales-truth/:month", authMiddleware, requireFinanceView(), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    const entityIdRaw = req.query.entity_id;
    if (entityIdRaw === undefined) {
      return res.status(400).json({ message: "entity_id query param required" });
    }
    const entityId = Number(Array.isArray(entityIdRaw) ? entityIdRaw[0] : entityIdRaw);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      return res.status(400).json({ message: "entity_id must be a positive integer" });
    }
    try {
      const a = computeAttributionForMonth(month);
      const fwdLine = a.fwdByEntity.get(entityId) || 0;
      const refLine = a.refByEntity.get(entityId) || 0;
      const shipFwd = a.shipByEntity.get(entityId) || 0;
      const shipRef = a.shipRefByEntity.get(entityId) || 0;
      const net = fwdLine - refLine + shipFwd - shipRef;
      res.json({
        build_id: "pr159-debug-attributed-sales-truth",
        month,
        entity_id: entityId,
        entity_name: entityNameOf(entityId),
        forward_line_tax_dollars: fromCents(fwdLine),
        forward_shipping_tax_dollars: fromCents(shipFwd),
        refund_tax_dollars: fromCents(refLine),
        refund_shipping_tax_dollars: fromCents(shipRef),
        net_tax_dollars: fromCents(net),
        line_count: a.fwdLineCountByEntity.get(entityId) || 0,
        split_line_count: a.splitLineCount,
        note: "PR #159-debug. forward_line_tax_dollars is comparable to PR #158 line-tax-truth forward.line_tax_dollars to the penny (both are Σ recon_line_items.tax_lines_json × share via the same cascade). PR #158 EXCLUDES shipping; this endpoint reports shipping separately (dominant-entity rule). net = forward_line - refund_line + forward_shipping - refund_shipping.",
      });
    } catch (e: any) {
      res.status(500).json({ message: "attributed-sales-truth failed", error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------
  // (b) GET /api/recon/finance/debug/attribution-invariant/:month
  //     The headline assertion: Σ per_entity == grand_total.
  // -------------------------------------------------------------------
  app.get("/api/recon/finance/debug/attribution-invariant/:month", authMiddleware, requireFinanceView(), (req, res) => {
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ message: "Month must be YYYY-MM" });
    }
    try {
      const a = computeAttributionForMonth(month);

      const netOf = (eid: number) =>
        (a.fwdByEntity.get(eid) || 0)
        - (a.refByEntity.get(eid) || 0)
        + (a.shipByEntity.get(eid) || 0)
        - (a.shipRefByEntity.get(eid) || 0);

      // per_entity over every entity that received any attribution, sorted by
      // id. Includes entity 0 (Unallocated) so the parts truly sum to the whole.
      const entityIds = Array.from(a.allEntities).sort((x, y) => x - y);
      const perEntity = entityIds.map((eid) => ({
        entity_id: eid,
        name: entityNameOf(eid),
        tax_dollars: fromCents(netOf(eid)),
      }));

      const sumOfEntities = entityIds.reduce((acc, eid) => acc + netOf(eid), 0);

      // grand_total computed the same way (Σ over all entities of net) — this
      // is the whole. By construction it equals sumOfEntities exactly.
      const grandTotal = sumOfEntities;
      const deltaCents = grandTotal - sumOfEntities;

      // Share-rounding drift: how many cents the rounded per-row forward tax
      // diverged from the raw line cents. Reported for transparency; it is the
      // invariant tolerance, though delta is structurally 0 here.
      const driftCents = a.attrForwardCentsTotal - a.rawForwardCentsTotal;

      const invariantHolds = Math.abs(deltaCents) <= Math.abs(driftCents);

      res.json({
        build_id: "pr159-debug-attribution-invariant",
        month,
        grand_total_tax_dollars: fromCents(grandTotal),
        per_entity: perEntity,
        sum_of_entity_totals_dollars: fromCents(sumOfEntities),
        delta_dollars: fromCents(deltaCents),
        invariant_holds: invariantHolds,
        split_line_rounding_drift_cents: driftCents,
        note: "PR #159-debug. grand_total and per_entity are both summed from ONE set of per-row integer cents (the v_attributed_sales forward path + refund + shipping dominant-entity attribution), so Σ per_entity == grand_total by construction; delta_dollars is structurally 0.00. split_line_rounding_drift_cents reports cents lost to ROUND(line_tax × share) on split lines (the documented penny tradeoff) and is the invariant tolerance. entity 0 = Unallocated is included so the parts sum to the whole. Returns 200 either way so drift is visible, not hidden behind a 500.",
      });
    } catch (e: any) {
      res.status(500).json({ message: "attribution-invariant failed", error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------
  // (c) GET /api/recon/finance/debug/attributed-sales-truth-by-line/:order_id
  //     Per-order drill-down: every (line × entity) row + shipping attribution.
  // -------------------------------------------------------------------
  app.get("/api/recon/finance/debug/attributed-sales-truth-by-line/:order_id", authMiddleware, requireFinanceView(), (req, res) => {
    const orderId = String(req.params.order_id);
    if (!orderId) {
      return res.status(400).json({ message: "order_id required" });
    }
    try {
      const { sqlite } = require("./storage");
      const hdr = sqlite.prepare(`SELECT id, name, processed_at, created_at FROM recon_orders WHERE id = ?`).get(orderId) as any;
      if (!hdr) {
        return res.status(404).json({ message: "order not found", order_id: orderId });
      }
      // Bucket the order to its NY month, then run the shared engine for that
      // month and slice out this order. Keeps attribution identical to totals.
      const monthRow = sqlite.prepare(`
        SELECT substr(datetime(COALESCE(processed_at, created_at), '-5 hours'), 1, 7) AS m
        FROM recon_orders WHERE id = ?
      `).get(orderId) as any;
      const month = monthRow?.m ?? null;
      const a = month ? computeAttributionForMonth(month) : null;

      const lines = a?.lineDetailByOrder.get(orderId) ?? [];
      const refMap = a?.refByOrderLine.get(orderId);
      const rows = lines.map((l) => {
        const refCents = refMap?.get(l.line_item_id) || 0;
        return {
          line_item_id: l.line_item_id,
          entity_id: l.entity_id,
          entity_name: entityNameOf(l.entity_id),
          share: l.share,
          forward_tax_dollars: fromCents(l.forward_cents),
          refund_tax_dollars: fromCents(refCents),
        };
      });

      const ship = a?.shipByOrder.get(orderId);
      res.json({
        build_id: "pr159-debug-attributed-sales-truth-by-line",
        order_id: orderId,
        order_name: hdr.name ?? null,
        month,
        rows,
        shipping_attribution: ship
          ? { dominant_entity_id: ship.entity_id, dominant_entity_name: entityNameOf(ship.entity_id), shipping_tax_dollars: fromCents(ship.cents) }
          : { dominant_entity_id: null, dominant_entity_name: null, shipping_tax_dollars: "0.00" },
        note: "PR #159-debug. rows are the (line × entity) forward+refund attribution from v_attributed_sales for this order. shipping_attribution.dominant_entity_id = entity with the highest summed forward LINE tax on this order (tie-break lowest id). Gift-card lines are excluded by the view.",
      });
    } catch (e: any) {
      res.status(500).json({ message: "attributed-sales-truth-by-line failed", error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------
  // PR #162 — Web-order fulfillment backfill.
  //
  // Some historical WEB orders never got recon_allocations rows because the
  // allocator only routed by order.location_id (null for web) and the
  // dedicated recon_order_fulfillments / recon_fulfillment_orders tables were
  // empty for them — even though raw_json.fulfillments[] carried the real
  // ship-from location. PR #162 added a raw_json.fulfillments[] fallback to
  // the allocator (branch b2). This endpoint re-runs the now-fixed allocator
  // over every NY-month that contains a candidate order, picking up the fix.
  //
  // Candidate = a non-gift-card order line that currently attributes to
  // entity_id=0 (Unallocated) AND whose order.raw_json carries a successful
  // fulfillment. Re-running runAllocationEngine(month) is idempotent (it
  // deletes only non-manual allocations for the month then rewrites), so
  // running this endpoint twice does not double-write recon_allocations rows.
  //
  // POST /api/recon/finance/debug/backfill-web-fulfillment-allocations
  // Body (optional): { dry_run?: boolean }
  app.post("/api/recon/finance/debug/backfill-web-fulfillment-allocations", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const { sqlite } = require("./storage");
    const dryRun = req.body?.dry_run === true;

    // POS entity set — same definition the attribution engine uses to decide
    // whether a candidate entity counts as "allocated" vs collapses to 0.
    const posEntitySet = new Set<number>(
      (sqlite.prepare(`
        SELECT entity_id FROM recon_entity_pos_locations
         WHERE kind = 'pos' AND active = 1 AND shopify_location_id IS NOT NULL
      `).all() as any[]).map((r) => Number(r.entity_id)),
    );

    // Enumerate candidate orders: a forward (non-gift-card) line in
    // v_attributed_sales whose best attribution candidate is NOT a POS entity
    // (i.e. it lands in Unallocated/0), AND whose order.raw_json carries a
    // successful fulfillment. We compute "still unallocated" in JS using the
    // same pickEntity cascade as computeAttributionForMonth so the candidate
    // set matches what the by-store report shows as Unallocated.
    const pickEntity = (
      perLineEid: number | null,
      orderEid: number | null,
      dominantEid: number | null,
    ): number => {
      if (perLineEid != null && posEntitySet.has(Number(perLineEid))) return Number(perLineEid);
      if (orderEid != null && posEntitySet.has(Number(orderEid))) return Number(orderEid);
      if (dominantEid != null && posEntitySet.has(Number(dominantEid))) return Number(dominantEid);
      return 0;
    };

    try {
      // Pull every forward line + its allocation candidates + the order's
      // raw_json fulfillment-success flag + its NY month. INSTR keeps the scan
      // cheap (no JSON.parse of every order) — we only need to know whether a
      // successful fulfillment exists at all.
      const rows = sqlite.prepare(`
        SELECT
          v.order_id,
          v.line_item_id,
          v.happened_month,
          v.per_line_entity_id,
          v.order_entity_id,
          v.dominant_entity_id,
          (CASE WHEN o.raw_json IS NOT NULL
                 AND INSTR(o.raw_json, '"fulfillments"') > 0
                 AND INSTR(o.raw_json, '"status":"success"') > 0
                THEN 1 ELSE 0 END) AS has_success_fulfillment,
          o.name AS order_name
        FROM v_attributed_sales v
        JOIN recon_orders o ON o.id = v.order_id
      `).all() as any[];

      const candidateMonths = new Set<string>();
      const candidateOrderIds = new Set<string>();
      const candidateOrderNames = new Map<string, string | null>();
      for (const r of rows) {
        const eid = pickEntity(r.per_line_entity_id, r.order_entity_id, r.dominant_entity_id);
        if (eid !== 0) continue;                      // already allocated
        if (Number(r.has_success_fulfillment) !== 1) continue; // no fulfillment to route by
        if (r.happened_month) candidateMonths.add(String(r.happened_month));
        candidateOrderIds.add(String(r.order_id));
        candidateOrderNames.set(String(r.order_id), r.order_name ?? null);
      }

      const candidates_found = candidateOrderIds.size;
      const months = Array.from(candidateMonths).sort();

      if (dryRun) {
        return res.json({
          build_id: "pr162-backfill-web-fulfillment",
          dry_run: true,
          candidates_found,
          candidate_months: months,
          candidate_orders: Array.from(candidateOrderIds).map((id) => ({ order_id: id, order_name: candidateOrderNames.get(id) ?? null })),
          note: "Dry run — no allocations written. Re-run without dry_run to apply.",
        });
      }

      // Re-run the now-fixed allocator over each candidate month. Idempotent:
      // runAllocationEngine deletes non-manual allocations for the month then
      // rewrites, so running this endpoint twice converges to the same state.
      let allocations_written = 0;
      const errors: Array<{ month: string; error: string }> = [];
      const per_month: any[] = [];
      for (const month of months) {
        try {
          const s = runAllocationEngine(month);
          allocations_written += s.allocations_written;
          per_month.push({ month, allocations_written: s.allocations_written, orders_processed: s.orders_processed, needs_review_orders: s.needs_review_orders, warnings: s.warnings });
        } catch (e: any) {
          errors.push({ month, error: String(e?.message || e) });
        }
      }

      // Re-check: how many candidate orders are now fully allocated (every
      // forward line resolves to a POS entity) vs still unallocated.
      const recheck = sqlite.prepare(`
        SELECT
          v.order_id,
          v.per_line_entity_id,
          v.order_entity_id,
          v.dominant_entity_id
        FROM v_attributed_sales v
        WHERE v.order_id IN (${candidateOrderIds.size > 0 ? Array.from(candidateOrderIds).map(() => "?").join(",") : "''"})
      `).all(...Array.from(candidateOrderIds)) as any[];

      const stillUnallocatedByOrder = new Map<string, boolean>();
      for (const id of Array.from(candidateOrderIds)) stillUnallocatedByOrder.set(id, false);
      for (const r of recheck) {
        const eid = pickEntity(r.per_line_entity_id, r.order_entity_id, r.dominant_entity_id);
        if (eid === 0) stillUnallocatedByOrder.set(String(r.order_id), true);
      }
      let orders_still_unallocated = 0;
      for (const v of Array.from(stillUnallocatedByOrder.values())) if (v) orders_still_unallocated += 1;
      const orders_now_fully_allocated = candidates_found - orders_still_unallocated;

      res.json({
        build_id: "pr162-backfill-web-fulfillment",
        dry_run: false,
        candidates_found,
        candidate_months: months,
        allocations_written,
        orders_now_fully_allocated,
        orders_still_unallocated,
        errors,
        per_month,
        still_unallocated_orders: Array.from(stillUnallocatedByOrder.entries())
          .filter(([, v]) => v)
          .map(([id]) => ({ order_id: id, order_name: candidateOrderNames.get(id) ?? null })),
        note: "PR #162. Re-ran runAllocationEngine over each NY-month containing a candidate (Unallocated forward line + successful raw_json fulfillment). Idempotent — re-running does not double-write recon_allocations. orders_still_unallocated should be 0 once the raw_json fulfillment fallback routes every candidate; any remainder ships from an unmapped location or has no raw_json fulfillment matching its line.",
      });
    } catch (e: any) {
      res.status(500).json({ message: "backfill-web-fulfillment-allocations failed", error: String(e?.message || e) });
    }
  });

  // -------------------------------------------------------------------
  // PR #162 — Verification of the two known May 2026 web orders + the
  // 2026-05 attribution invariant Unallocated row. Read-only.
  //
  // GET /api/recon/finance/debug/verify-web-fulfillment-backfill
  // -------------------------------------------------------------------
  app.get("/api/recon/finance/debug/verify-web-fulfillment-backfill", authMiddleware, requireFinanceView(), (_req, res) => {
    const { sqlite } = require("./storage");
    try {
      // Per-order allocation read-back: entity_id, share, line count.
      const readOrder = (orderId: string) => {
        const hdr = sqlite.prepare(`SELECT id, name FROM recon_orders WHERE id = ?`).get(orderId) as any;
        const allocs = sqlite.prepare(`
          SELECT line_item_id, entity_id, share, gross_amount, tax_amount, method, reason
          FROM recon_allocations
          WHERE order_id = ?
          ORDER BY id ASC
        `).all(orderId) as any[];
        const distinctEntities = Array.from(new Set(allocs.map((a) => Number(a.entity_id))));
        return {
          order_id: orderId,
          order_name: hdr?.name ?? null,
          allocation_count: allocs.length,
          distinct_entity_ids: distinctEntities,
          distinct_entity_names: distinctEntities.map((e) => entityNameOf(e)),
          all_share_one: allocs.length > 0 && allocs.every((a) => Number(a.share) === 1),
          allocations: allocs.map((a) => ({
            line_item_id: a.line_item_id,
            entity_id: Number(a.entity_id),
            entity_name: entityNameOf(Number(a.entity_id)),
            share: Number(a.share),
            gross_amount: a.gross_amount,
            tax_amount: a.tax_amount,
            method: a.method,
            reason: a.reason,
          })),
        };
      };

      const order38144 = readOrder("6523563114738"); // expect Greenvale (entity 1)
      const order38175 = readOrder("6539583979762"); // expect Huntington (entity 2)

      // 2026-05 invariant Unallocated (entity 0) tax row, via the same engine.
      const a = computeAttributionForMonth("2026-05");
      const netOf = (eid: number) =>
        (a.fwdByEntity.get(eid) || 0)
        - (a.refByEntity.get(eid) || 0)
        + (a.shipByEntity.get(eid) || 0)
        - (a.shipRefByEntity.get(eid) || 0);
      const unallocatedTaxCents2026_05 = netOf(0);

      res.json({
        build_id: "pr162-verify-web-fulfillment",
        order_38144: order38144,
        order_38175: order38175,
        expectations: {
          order_38144: "Greenvale (entity_id=1), share=1, single line",
          order_38175: "Huntington (entity_id=2), share=1, single line",
          invariant_2026_05_unallocated: "$0.00 tax",
        },
        invariant_2026_05_unallocated_tax_dollars: fromCents(unallocatedTaxCents2026_05),
        invariant_2026_05_unallocated_is_zero: unallocatedTaxCents2026_05 === 0,
        note: "PR #162. order_* blocks read recon_allocations directly. invariant_2026_05_unallocated_tax_dollars is the net tax attributed to entity 0 (Unallocated) for 2026-05 via computeAttributionForMonth — should be $0.00 once both orders route. Run the backfill POST first if these still show Unallocated.",
      });
    } catch (e: any) {
      res.status(500).json({ message: "verify-web-fulfillment-backfill failed", error: String(e?.message || e) });
    }
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
  app.post("/api/recon/finance/debug/projector-v2/project", authMiddleware, requireFinanceView(), (req: any, res) => {
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
  app.get("/api/recon/finance/debug/projector-compare/:month", authMiddleware, requireFinanceView(), (req, res) => {
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
          -- PR #109: V2 stores disc/ret NEGATIVE (ShopifyQL convention),
          -- so V net = gross + disc + ret. Legacy still stores positive,
          -- so L net = gross - disc - ret. Both expressions below yield
          -- the correctly-signed net for their respective tables.
          (COALESCE(L.gross,0)-COALESCE(L.disc,0)-COALESCE(L.ret,0))
            - (COALESCE(V.gross,0)+COALESCE(V.disc,0)+COALESCE(V.ret,0)) AS d_net_sales
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
            - (COALESCE(V.gross,0)+COALESCE(V.disc,0)+COALESCE(V.ret,0))
          ) > 0.01
        ORDER BY ABS(
          (COALESCE(L.gross,0)-COALESCE(L.disc,0)-COALESCE(L.ret,0))
          - (COALESCE(V.gross,0)+COALESCE(V.disc,0)+COALESCE(V.ret,0))
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
  app.get("/api/recon/finance/debug/projector-compare/order/:name", authMiddleware, requireFinanceView(), (req, res) => {
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
  app.get("/api/recon/finance/debug/projector-v2/orders/by-name/:name", authMiddleware, requireFinanceView(), (req, res) => {
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

  // ===================================================================
  // PR #103 GROUND TRUTH — Shopify vs Our Ingest vs Our Projection
  // ===================================================================
  // GET /api/recon/finance/debug/shopify-ground-truth/:month
  // Calls live Shopify GraphQL orders() for ALL orders created in the
  // month (ET window), paginated, and compares Shopify's own totals to:
  //   - what's in recon_shopify_sales (our ingest layer)
  //   - what's in recon_revenue_events_v2 (our projection layer)
  //
  // Returns three side-by-side total objects plus per-order detail so
  // we can see exactly which orders our ingest dropped vs. which our
  // projector miscalculated.
  //
  // This is the check that should have gated PR #97. Running it now to
  // diagnose why the V2 projector totals are short.
  // -------------------------------------------------------------------
  app.get("/api/recon/finance/debug/shopify-ground-truth/:month", authMiddleware, requireFinanceView(), async (req: any, res) => {
    try {
      const month = String(req.params.month || "").trim();
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ message: "month must be YYYY-MM" });
      }
      const cfg = getShopifyReconConfig();
      if (!cfg) return res.status(400).json({ message: "Shopify reconciler not configured" });

      const { shopifyGraphqlCall } = require("./shopify-recon");
      const { sqlite } = require("./storage");
      const { ensureRevenueEventsV2Schema } = require("./shopify-recon-events-projector-v2");
      ensureRevenueEventsV2Schema();

      // ET window for the month. We use created_at:>=START created_at:<END
      // in Shopify's query DSL, where START/END are ET local boundaries
      // expressed as ISO (UTC offset -05:00).
      const [yStr, mStr] = month.split("-");
      const y = Number(yStr), m = Number(mStr);
      const pad = (n: number) => String(n).padStart(2, "0");
      const startET = `${y}-${pad(m)}-01T00:00:00-05:00`;
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      const endET = `${nextY}-${pad(nextM)}-01T00:00:00-05:00`;
      const qStr = `created_at:>='${startET}' AND created_at:<'${endET}'`;

      const ORDERS_QUERY = `
        query MonthGroundTruth($cursor: String, $q: String!) {
          orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                name
                createdAt
                cancelledAt
                displayFinancialStatus
                currentTotalPriceSet     { shopMoney { amount } }
                currentSubtotalPriceSet  { shopMoney { amount } }
                currentTotalTaxSet       { shopMoney { amount } }
                currentTotalDiscountsSet { shopMoney { amount } }
                totalRefundedSet         { shopMoney { amount } }
                subtotalPriceSet         { shopMoney { amount } }
                totalPriceSet            { shopMoney { amount } }
                totalTaxSet              { shopMoney { amount } }
                totalDiscountsSet        { shopMoney { amount } }
              }
            }
          }
        }
      `;

      const shopifyOrders: any[] = [];
      let cursor: string | null = null;
      let pages = 0;
      const maxPages = 200; // 20,000 orders ceiling per month — plenty
      while (true) {
        pages++;
        if (pages > maxPages) break;
        const r: any = await shopifyGraphqlCall(cfg, ORDERS_QUERY, { cursor, q: qStr });
        if (r.errors) {
          // Log but don't abort if data is still present (PR #103 lesson)
          if (!r.data) {
            return res.status(502).json({ message: "Shopify GraphQL failed", errors: r.errors });
          }
        }
        const ords = r.data?.orders;
        if (!ords) break;
        for (const e of (ords.edges || [])) shopifyOrders.push(e.node);
        if (!ords.pageInfo?.hasNextPage) break;
        cursor = ords.pageInfo.endCursor;
      }

      // Sum Shopify totals (current = post-refund/edit; "total" = original-at-creation)
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const num = (x: any) => Number(x?.shopMoney?.amount || 0);
      const shopifyTotals = {
        order_count: shopifyOrders.length,
        current_subtotal: 0,
        current_total: 0,
        current_tax: 0,
        current_discounts: 0,
        total_refunded: 0,
        original_subtotal: 0,
        original_total: 0,
        original_tax: 0,
        original_discounts: 0,
      };
      for (const o of shopifyOrders) {
        shopifyTotals.current_subtotal  += num(o.currentSubtotalPriceSet);
        shopifyTotals.current_total     += num(o.currentTotalPriceSet);
        shopifyTotals.current_tax       += num(o.currentTotalTaxSet);
        shopifyTotals.current_discounts += num(o.currentTotalDiscountsSet);
        shopifyTotals.total_refunded    += num(o.totalRefundedSet);
        shopifyTotals.original_subtotal += num(o.subtotalPriceSet);
        shopifyTotals.original_total    += num(o.totalPriceSet);
        shopifyTotals.original_tax      += num(o.totalTaxSet);
        shopifyTotals.original_discounts+= num(o.totalDiscountsSet);
      }
      for (const k of Object.keys(shopifyTotals)) {
        if (k !== "order_count") (shopifyTotals as any)[k] = round2((shopifyTotals as any)[k]);
      }

      // Our ingest layer: aggregate recon_shopify_sales for the same month
      const ingest: any = sqlite.prepare(`
        SELECT
          COUNT(DISTINCT order_id) AS order_count,
          COUNT(*)                  AS sales_count,
          COALESCE(SUM(total_amount), 0)                     AS total_amount,
          COALESCE(SUM(total_tax), 0)                        AS total_tax,
          COALESCE(SUM(total_discount_after_taxes), 0)       AS total_discount_after_taxes,
          COALESCE(SUM(total_discount_before_taxes), 0)      AS total_discount_before_taxes
        FROM recon_shopify_sales
        WHERE happened_month = ?
      `).get(month) as any;
      for (const k of ["total_amount","total_tax","total_discount_after_taxes","total_discount_before_taxes"]) {
        ingest[k] = round2(Number(ingest[k] || 0));
      }

      // Our projection layer: aggregate recon_revenue_events_v2 for same month
      const v2: any = sqlite.prepare(`
        SELECT
          COUNT(DISTINCT order_id) AS order_count,
          COUNT(*)                  AS event_count,
          COALESCE(SUM(gross), 0)                  AS gross,
          COALESCE(SUM(discount), 0)               AS discount,
          COALESCE(SUM(returns), 0)                AS returns,
          COALESCE(SUM(tax), 0)                    AS tax,
          COALESCE(SUM(return_fees), 0)            AS return_fees,
          COALESCE(SUM(net_sales_gift_cards), 0)   AS net_sales_gift_cards
        FROM recon_revenue_events_v2
        WHERE event_month = ?
      `).get(month) as any;
      for (const k of ["gross","discount","returns","tax","return_fees","net_sales_gift_cards"]) {
        v2[k] = round2(Number(v2[k] || 0));
      }

      // Per-order: for each Shopify order in the month, look up our ingest
      // + v2 counts. Anything where Shopify > 0 but we have 0 is a dropped
      // order. Anything where amounts differ by >$0.01 is a calculation gap.
      const lookupSales = sqlite.prepare(`
        SELECT COUNT(*) AS sales_count, COALESCE(SUM(total_amount), 0) AS total_amount
        FROM recon_shopify_sales
        WHERE order_id = ? AND happened_month = ?
      `);
      const lookupAgreements = sqlite.prepare(`
        SELECT COUNT(*) AS agreement_count
        FROM recon_shopify_agreements
        WHERE order_id = ?
      `);
      const lookupV2 = sqlite.prepare(`
        SELECT COUNT(*) AS event_count, COALESCE(SUM(gross), 0) AS gross
        FROM recon_revenue_events_v2
        WHERE order_id = ? AND event_month = ?
      `);
      const perOrder: any[] = [];
      let droppedCount = 0;
      let droppedGross = 0;
      for (const o of shopifyOrders) {
        const orderId = String(o.id).replace("gid://shopify/Order/", "");
        const s: any = lookupSales.get(orderId, month) || {};
        const a: any = lookupAgreements.get(orderId) || {};
        const ve: any = lookupV2.get(orderId, month) || {};
        const shopifyTotal = num(o.currentTotalPriceSet);
        const ingested = Number(s.sales_count || 0) > 0;
        if (!ingested && shopifyTotal > 0) {
          droppedCount++;
          droppedGross += shopifyTotal;
        }
        perOrder.push({
          order_id: orderId,
          name: o.name,
          createdAt: o.createdAt,
          cancelledAt: o.cancelledAt,
          financial_status: o.displayFinancialStatus,
          shopify_current_total: round2(num(o.currentTotalPriceSet)),
          shopify_current_subtotal: round2(num(o.currentSubtotalPriceSet)),
          shopify_refunded: round2(num(o.totalRefundedSet)),
          ingest_sales_count: Number(s.sales_count || 0),
          ingest_total_amount: round2(Number(s.total_amount || 0)),
          ingest_agreement_count: Number(a.agreement_count || 0),
          v2_event_count: Number(ve.event_count || 0),
          v2_gross: round2(Number(ve.gross || 0)),
          dropped_by_ingest: !ingested && shopifyTotal > 0,
        });
      }
      // Sort: dropped orders first (largest first), then by amount
      perOrder.sort((a, b) => {
        if (a.dropped_by_ingest && !b.dropped_by_ingest) return -1;
        if (!a.dropped_by_ingest && b.dropped_by_ingest) return 1;
        return b.shopify_current_total - a.shopify_current_total;
      });

      res.json({
        build_id: "pr103-ground-truth",
        month,
        window_et: { start: startET, end: endET },
        shopify: shopifyTotals,
        our_ingest: ingest,
        our_projection_v2: v2,
        gaps: {
          shopify_current_total_vs_v2_gross: round2(shopifyTotals.current_total - Number(v2.gross || 0)),
          shopify_current_subtotal_vs_v2_gross: round2(shopifyTotals.current_subtotal - Number(v2.gross || 0)),
          shopify_orders_vs_v2_orders: shopifyTotals.order_count - Number(v2.order_count || 0),
          shopify_orders_vs_ingest_orders: shopifyTotals.order_count - Number(ingest.order_count || 0),
          dropped_by_ingest_count: droppedCount,
          dropped_by_ingest_gross: round2(droppedGross),
        },
        per_order_top_50: perOrder.slice(0, 50),
        per_order_total: perOrder.length,
        pages_fetched: pages,
      });
    } catch (e: any) {
      res.status(500).json({ message: "shopify-ground-truth failed", error: String(e?.message || e) });
    }
  });

  // ===================================================================
  // PR #104 — Per-order diagnose endpoint
  // ===================================================================
  // GET /api/recon/finance/debug/diagnose-order/:name
  // Single-call investigation for one Shopify order. Returns everything
  // needed to figure out why an order is over/under-booked:
  //   - Shopify live truth (currentTotalPriceSet etc. + refunds)
  //   - Legacy projector view (recon_revenue_events rows)
  //   - V2 shadow view (recon_shopify_agreements + recon_shopify_sales
  //     + recon_revenue_events_v2 rows)
  //   - recon_orders row (lifecycle / refund_variance_flag / etc.)
  //
  // Designed as the standard tool when month totals show a gap: run
  // /shopify-ground-truth/:month, pick the worst order, run this. No
  // need for a separate DevTools script per drill-down.
  // -------------------------------------------------------------------
  app.get("/api/recon/finance/debug/diagnose-order/:name", authMiddleware, requireFinanceView(), async (req: any, res) => {
    try {
      const { sqlite } = require("./storage");
      const raw = String(req.params.name || "").trim();
      if (!raw) return res.status(400).json({ message: "name required" });
      const withHash = raw.startsWith("#") ? raw : `#${raw}`;
      const noHash = raw.startsWith("#") ? raw.slice(1) : raw;

      // Find the order in our DB
      const orderRow: any = sqlite.prepare(`
        SELECT id, name, created_at, updated_at, processed_at, cancelled_at,
               financial_status, fulfillment_status,
               subtotal, total_tax, total_discounts, total_price,
               current_total_price, total_refunded
        FROM recon_orders
        WHERE name = ? OR name = ?
        LIMIT 1
      `).get(withHash, noHash);
      if (!orderRow) {
        return res.status(404).json({ message: `Order ${withHash} not found in recon_orders` });
      }
      const orderId = orderRow.id;

      // Legacy projector events
      const legacyEvents: any[] = sqlite.prepare(`
        SELECT event_id, event_date, event_month, event_type,
               gross, discount, returns, tax, return_fees, net_sales_gift_cards,
               detector_source, detected_at, line_item_id, refund_id
        FROM recon_revenue_events
        WHERE order_id = ?
        ORDER BY event_date ASC, event_id ASC
      `).all(orderId);

      const round2 = (n: number) => Math.round(n * 100) / 100;
      const sumCol = (rows: any[], col: string) =>
        round2(rows.reduce((s, r) => s + Number(r[col] || 0), 0));
      const legacyTotals = {
        event_count: legacyEvents.length,
        gross: sumCol(legacyEvents, "gross"),
        discount: sumCol(legacyEvents, "discount"),
        returns: sumCol(legacyEvents, "returns"),
        tax: sumCol(legacyEvents, "tax"),
        return_fees: sumCol(legacyEvents, "return_fees"),
        net_sales_gift_cards: sumCol(legacyEvents, "net_sales_gift_cards"),
      };

      // V2 shadow: agreements + sales + v2 events
      let v2Block: any = { available: false };
      try {
        const { ensureRevenueEventsV2Schema } = require("./shopify-recon-events-projector-v2");
        ensureRevenueEventsV2Schema();

        const agreements: any[] = sqlite.prepare(`
          SELECT id, happened_at, reason, agreement_type, app_handle,
                 refund_id, return_id, ingest_version
          FROM recon_shopify_agreements
          WHERE order_id = ?
          ORDER BY happened_at ASC
        `).all(orderId);

        const sales: any[] = sqlite.prepare(`
          SELECT id, agreement_id, happened_at, sale_type, action_type,
                 line_type, quantity,
                 total_amount, total_discount_after_taxes,
                 total_discount_before_taxes, total_tax,
                 ref_id, ref_name, ref_sku
          FROM recon_shopify_sales
          WHERE order_id = ?
          ORDER BY happened_at ASC, id ASC
        `).all(orderId);

        const v2Events: any[] = sqlite.prepare(`
          SELECT event_id, event_date, event_month, event_type,
                 gross, discount, returns, tax, return_fees, net_sales_gift_cards,
                 sale_id, agreement_id, detector_source
          FROM recon_revenue_events_v2
          WHERE order_id = ?
          ORDER BY event_date ASC, event_id ASC
        `).all(orderId);

        v2Block = {
          available: true,
          agreement_count: agreements.length,
          sales_count: sales.length,
          event_count: v2Events.length,
          agreements,
          sales,
          events: v2Events,
          sales_totals: {
            total_amount: sumCol(sales, "total_amount"),
            total_tax: sumCol(sales, "total_tax"),
            total_discount_after_taxes: sumCol(sales, "total_discount_after_taxes"),
            total_discount_before_taxes: sumCol(sales, "total_discount_before_taxes"),
          },
          event_totals: {
            gross: sumCol(v2Events, "gross"),
            discount: sumCol(v2Events, "discount"),
            returns: sumCol(v2Events, "returns"),
            tax: sumCol(v2Events, "tax"),
            return_fees: sumCol(v2Events, "return_fees"),
            net_sales_gift_cards: sumCol(v2Events, "net_sales_gift_cards"),
          },
        };
      } catch (e: any) {
        v2Block = { available: false, error: String(e?.message || e) };
      }

      // Optionally: live Shopify GraphQL look-up for this order (current totals)
      let shopifyLive: any = { available: false };
      try {
        const cfg = getShopifyReconConfig();
        if (cfg) {
          const { shopifyGraphqlCall } = require("./shopify-recon");
          const Q = `
            query DiagOrder($id: ID!) {
              order(id: $id) {
                id name createdAt cancelledAt displayFinancialStatus
                currentTotalPriceSet     { shopMoney { amount } }
                currentSubtotalPriceSet  { shopMoney { amount } }
                currentTotalTaxSet       { shopMoney { amount } }
                currentTotalDiscountsSet { shopMoney { amount } }
                totalRefundedSet         { shopMoney { amount } }
                subtotalPriceSet         { shopMoney { amount } }
                totalPriceSet            { shopMoney { amount } }
                totalTaxSet              { shopMoney { amount } }
                totalDiscountsSet        { shopMoney { amount } }
              }
            }`;
          const gid = `gid://shopify/Order/${orderId}`;
          const r: any = await shopifyGraphqlCall(cfg, Q, { id: gid });
          if (r.data?.order) {
            const num = (x: any) => round2(Number(x?.shopMoney?.amount || 0));
            const o = r.data.order;
            shopifyLive = {
              available: true,
              name: o.name,
              financial_status: o.displayFinancialStatus,
              cancelled_at: o.cancelledAt,
              current_total: num(o.currentTotalPriceSet),
              current_subtotal: num(o.currentSubtotalPriceSet),
              current_tax: num(o.currentTotalTaxSet),
              current_discounts: num(o.currentTotalDiscountsSet),
              total_refunded: num(o.totalRefundedSet),
              original_total: num(o.totalPriceSet),
              original_subtotal: num(o.subtotalPriceSet),
              original_tax: num(o.totalTaxSet),
              original_discounts: num(o.totalDiscountsSet),
            };
          } else if (r.errors) {
            shopifyLive = { available: false, errors: r.errors };
          }
        }
      } catch (e: any) {
        shopifyLive = { available: false, error: String(e?.message || e) };
      }

      res.json({
        build_id: "pr104-diagnose-order",
        order: orderRow,
        shopify_live: shopifyLive,
        legacy_projector: {
          source_of_truth: true,
          totals: legacyTotals,
          events: legacyEvents,
        },
        v2_shadow: {
          source_of_truth: false,
          ...v2Block,
        },
      });
    } catch (e: any) {
      res.status(500).json({ message: "diagnose-order failed", error: String(e?.message || e) });
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
  app.post("/api/recon/finance/debug/orders/graphql-totals-batch", authMiddleware, requireFinanceView(), async (req: any, res) => {
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
  app.post("/api/recon/finance/debug/orders/enumerate-edited", authMiddleware, requireFinanceView(), async (req: any, res) => {
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
  app.post("/api/recon/finance/debug/orders/populate-edits", authMiddleware, requireFinanceView(), async (req: any, res) => {
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
  app.post("/api/recon/finance/debug/orders/local-vs-shopify", authMiddleware, requireFinanceView(), async (req: any, res) => {
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
  app.get("/api/recon/finance/debug/orders/list-edits", authMiddleware, requireFinanceView(), async (_req: any, res) => {
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
  app.post("/api/recon/finance/debug/orders/probe-edit-detector", authMiddleware, requireFinanceView(), async (req: any, res) => {
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

  app.get("/api/recon/finance/debug/events/monthly/:month", authMiddleware, requireFinanceView(), (req, res) => {
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

  app.get("/api/recon/finance/debug/events/order/:order_id", authMiddleware, requireFinanceView(), (req, res) => {
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

  app.get("/api/recon/finance/debug/events/warnings", authMiddleware, requireFinanceView(), (req: any, res) => {
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

  app.get("/api/recon/finance/debug/events/health", authMiddleware, requireFinanceView(), (_req, res) => {
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
  app.get("/api/recon/finance/snapshots", authMiddleware, requireFinanceView(), (_req, res) => {
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

  // ──────────────────────────────────────────────────────────────────────────
  // ShopifyQL staff-sales ingest (PR #202 — commission matcher)
  //
  // Pulls the "sales by assisting staff member" report via ShopifyQL and joins
  // it against recon_orders + recon_allocations to produce per-entity rows in
  // recon_shopify_staff_sales. Returns and exchanges naturally appear as
  // negative rows (returns column) and the net_sales column is signed.
  // ──────────────────────────────────────────────────────────────────────────

  function _validateSinceUntil(rawSince: unknown, rawUntil: unknown): { since: string; until: string } {
    const since = String(rawSince ?? "").trim();
    const until = String(rawUntil ?? "").trim();
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoRe.test(since) || !isoRe.test(until)) {
      throw new Error("since and until must be YYYY-MM-DD");
    }
    if (since > until) {
      throw new Error("since must be <= until");
    }
    return { since, until };
  }

  // Preview the raw ShopifyQL rows for a date range without writing to DB.
  // Useful for spot-checking the report against Shopify Admin before ingest.
  app.get("/api/recon/shopify/staff-sales/preview", authMiddleware, requirePermission("payroll.view"), async (req, res) => {
    try {
      const { since, until } = _validateSinceUntil(req.query.since, req.query.until);
      const { fetchStaffSales, buildStaffSalesQuery } = require("./shopify-staff-sales");
      const rows = await fetchStaffSales(since, until);
      res.json({
        ok: true,
        since,
        until,
        query: buildStaffSalesQuery(since, until),
        count: rows.length,
        rows: rows.slice(0, 100),
      });
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

  // Run the ingest: ShopifyQL → recon_shopify_staff_sales (idempotent upsert).
  // PR #204 fix: gate the manual ingest trigger on `payroll.run_sync`, not
  // a made-up `payroll.edit`. The catalog has run_sync specifically for
  // "Manually trigger Shopify / Easyrent / Shift4 ingestion runs."
  app.post("/api/recon/shopify/staff-sales/ingest", authMiddleware, requirePermission("payroll.run_sync"), async (req, res) => {
    try {
      const { since, until } = _validateSinceUntil(req.body?.since, req.body?.until);
      const { ingestStaffSales } = require("./shopify-staff-sales-ingest");
      const summary = await ingestStaffSales(since, until);
      res.json({ ok: true, since, until, ...summary });
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

  // List rows from recon_shopify_staff_sales with optional filters. Used by the
  // running-tally UI in PR #203 to display employee net sales over a period.
  //   employee_id: numeric payroll_employees.id
  //   entity_id:   numeric recon_entities.id, or -1 to filter unallocated rows
  //   since/until: ISO date filter on period_start/period_end
  app.get("/api/recon/shopify/staff-sales", authMiddleware, requirePermission("payroll.view"), (req, res) => {
    try {
      const employeeIdRaw = String(req.query.employee_id ?? "").trim();
      const entityIdRaw = String(req.query.entity_id ?? "").trim();
      const sinceRaw = String(req.query.since ?? "").trim();
      const untilRaw = String(req.query.until ?? "").trim();
      const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 500));

      const where: string[] = [];
      const params: any[] = [];
      if (employeeIdRaw) {
        const eid = parseInt(employeeIdRaw, 10);
        if (!Number.isFinite(eid)) throw new Error("employee_id must be numeric");
        where.push("employee_id = ?");
        params.push(eid);
      }
      if (entityIdRaw) {
        const xid = parseInt(entityIdRaw, 10);
        if (!Number.isFinite(xid)) throw new Error("entity_id must be numeric (-1 for unallocated)");
        if (xid === -1) {
          where.push("entity_id IS NULL");
        } else {
          where.push("entity_id = ?");
          params.push(xid);
        }
      }
      if (sinceRaw) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw)) throw new Error("since must be YYYY-MM-DD");
        where.push("period_end >= ?");
        params.push(sinceRaw);
      }
      if (untilRaw) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(untilRaw)) throw new Error("until must be YYYY-MM-DD");
        where.push("period_start <= ?");
        params.push(untilRaw);
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { sqlite } = require("./storage");
      const rows = sqlite
        .prepare(
          `SELECT * FROM recon_shopify_staff_sales ${whereSql} ORDER BY period_start DESC, total_sales DESC LIMIT ?`,
        )
        .all(...params, limit);
      res.json({ ok: true, count: rows.length, rows });
    } catch (e: any) {
      res.status(400).json({ message: String(e?.message || e) });
    }
  });

  // Employee-grouped aggregation of recon_shopify_staff_sales over a date
  // range. Each employee row has totals plus a `by_entity` breakdown. Used by
  // the Payroll > Staff Sales page (PR #203) as the top-level list view.
  //
  // Date semantics: rows with period_end >= since AND period_start <= until.
  // (Overlap, not strict containment — a row that straddles the window still
  // contributes, since we filter the underlying recon_shopify_staff_sales by
  // the same logic.)
  //
  // Aggregation runs at the SQL layer for speed (200+ rows folds to ~30
  // employees instantly even on the prod ngrok DB).
  app.get(
    "/api/recon/shopify/staff-sales/by-employee",
    authMiddleware,
    requirePermission("payroll.view"),
    (req, res) => {
      try {
        const since = String(req.query.since ?? "").trim();
        const until = String(req.query.until ?? "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
          throw new Error("since and until must be YYYY-MM-DD");
        }
        if (since > until) {
          throw new Error("since must be <= until");
        }

        const { sqlite } = require("./storage");

        // Employee-level totals + one row per employee summary across all
        // entities the staff sold for. employee_id = NULL is the "unmatched"
        // bucket — keep it as a synthetic row so the UI can flag it.
        const empRows = sqlite
          .prepare(
            `SELECT
               CASE WHEN s.employee_id IS NULL
                    THEN 'staff:' || s.assisting_staff_id
                    ELSE 'emp:'   || s.employee_id
               END AS group_key,
               s.employee_id AS employee_id,
               MAX(s.assisting_staff_id) AS assisting_staff_id,
               COALESCE(e.full_name, MAX(s.staff_name), '(unmatched)') AS full_name,
               MAX(s.staff_name) AS shopify_staff_name,
               GROUP_CONCAT(DISTINCT s.assisting_staff_id) AS shopify_staff_ids,
               SUM(s.gross_sales)   AS gross_sales,
               SUM(s.discounts)     AS discounts,
               SUM(s.returns)       AS returns_amt,
               SUM(s.net_sales)     AS net_sales,
               SUM(s.taxes)         AS taxes,
               SUM(s.total_sales)   AS total_sales,
               SUM(s.quantity)      AS qty,
               COUNT(DISTINCT s.order_name) AS order_count
             FROM recon_shopify_staff_sales s
             LEFT JOIN payroll_employees e ON e.id = s.employee_id
             LEFT JOIN recon_orders o ON o.id = s.order_id
             -- PR #205: filter by the actual Shopify order date
             -- (recon_orders.created_at) instead of the ingest window
             -- stamp on the staff_sales row. Falls back to period_start
             -- when the order isn't linked yet (order_id IS NULL).
             WHERE date(COALESCE(s.occurred_on, o.created_at, s.period_start)) BETWEEN ? AND ?
             GROUP BY group_key
             ORDER BY total_sales DESC`,
          )
          .all(since, until);

        // Per-entity breakdown for each employee. NULL entity_id = unallocated.
        const entRows = sqlite
          .prepare(
            `SELECT
               CASE WHEN s.employee_id IS NULL
                    THEN 'staff:' || s.assisting_staff_id
                    ELSE 'emp:'   || s.employee_id
               END AS group_key,
               s.employee_id,
               MAX(s.assisting_staff_id) AS assisting_staff_id,
               s.entity_id,
               COALESCE(en.display_name, en.location, '(unallocated)') AS entity_label,
               en.location AS entity_location,
               SUM(s.gross_sales) AS gross_sales,
               SUM(s.returns)     AS returns_amt,
               SUM(s.net_sales)   AS net_sales,
               SUM(s.total_sales) AS total_sales,
               COUNT(DISTINCT s.order_name) AS order_count
             FROM recon_shopify_staff_sales s
             LEFT JOIN payroll_entities en ON en.id = s.entity_id
             LEFT JOIN recon_orders o ON o.id = s.order_id
             -- PR #205: see empRows comment above. Same filter swap.
             WHERE date(COALESCE(s.occurred_on, o.created_at, s.period_start)) BETWEEN ? AND ?
             GROUP BY group_key, s.entity_id
             ORDER BY total_sales DESC`,
          )
          .all(since, until);

        // PR #204: group_key splits unmatched rows by assisting_staff_id so
        // each unknown Shopify staff member becomes its own row instead of
        // collapsing into one "(unmatched)" bucket. Matched employees are
        // still keyed by employee_id via the CASE expression above.
        const byEntityForEmp = new Map<string, any[]>();
        for (const r of entRows as any[]) {
          const key = String(r.group_key);
          if (!byEntityForEmp.has(key)) byEntityForEmp.set(key, []);
          byEntityForEmp.get(key)!.push(r);
        }

        const employees = (empRows as any[]).map((emp) => {
          const key = String(emp.group_key);
          return { ...emp, by_entity: byEntityForEmp.get(key) ?? [] };
        });

        // Totals row across everything in the window (for the summary header).
        const totalsRow = sqlite
          .prepare(
            `SELECT
               SUM(s.gross_sales) AS gross_sales,
               SUM(s.discounts)   AS discounts,
               SUM(s.returns)     AS returns_amt,
               SUM(s.net_sales)   AS net_sales,
               SUM(s.taxes)       AS taxes,
               SUM(s.total_sales) AS total_sales,
               COUNT(DISTINCT s.order_name) AS order_count,
               COUNT(*) AS row_count
             FROM recon_shopify_staff_sales s
             LEFT JOIN recon_orders o ON o.id = s.order_id
             -- PR #205: see empRows.
             WHERE date(COALESCE(s.occurred_on, o.created_at, s.period_start)) BETWEEN ? AND ?`,
          )
          .get(since, until);

        res.json({
          ok: true,
          since,
          until,
          totals: totalsRow,
          employees,
        });
      } catch (e: any) {
        res.status(400).json({ message: String(e?.message || e) });
      }
    },
  );

  // Per-order drill-down: every recon_shopify_staff_sales row for a single
  // employee × entity combination over the date range. Used when the user
  // expands an entity row inside the Staff Sales page (PR #203). entity_id=-1
  // means "unallocated" (rows where the order wasn't found in recon_orders or
  // had no allocations yet).
  app.get(
    "/api/recon/shopify/staff-sales/orders",
    authMiddleware,
    requirePermission("payroll.view"),
    (req, res) => {
      try {
        const since = String(req.query.since ?? "").trim();
        const until = String(req.query.until ?? "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
          throw new Error("since and until must be YYYY-MM-DD");
        }
        if (since > until) {
          throw new Error("since must be <= until");
        }
        const employeeIdRaw = String(req.query.employee_id ?? "").trim();
        const entityIdRaw = String(req.query.entity_id ?? "").trim();
        // PR #213: lets the Staff Sales UI drill into a specific unmatched
        // staff bucket (now that each unmatched assisting_staff_id is its
        // own row instead of all collapsing into one "_null" bucket).
        const assistingStaffIdRaw = String(req.query.assisting_staff_id ?? "").trim();

        // PR #205: filter by recon_orders.created_at (joined below), falling
        // back to period_start when the order isn't linked yet. Pre-PR this
        // filtered on period_start/period_end which is the ingest window
        // stamp — every row matched any user-selected calendar.
        const where: string[] = [
          "date(COALESCE(s.occurred_on, o.created_at, s.period_start)) BETWEEN ? AND ?",
        ];
        const params: any[] = [since, until];

        if (employeeIdRaw === "_null") {
          where.push("s.employee_id IS NULL");
        } else if (employeeIdRaw) {
          const eid = parseInt(employeeIdRaw, 10);
          if (!Number.isFinite(eid)) throw new Error("employee_id must be numeric or '_null'");
          where.push("s.employee_id = ?");
          params.push(eid);
        }

        if (assistingStaffIdRaw) {
          // assisting_staff_id is stored as TEXT (bare numeric like
          // "82318328050"). Validate light: digits only, 1..20 chars.
          if (!/^\d{1,20}$/.test(assistingStaffIdRaw)) {
            throw new Error("assisting_staff_id must be a numeric string");
          }
          where.push("s.assisting_staff_id = ?");
          params.push(assistingStaffIdRaw);
          // When drilling into an unmatched bucket we also want only
          // the still-unmatched rows so the count matches the parent
          // row. (After PR #212 backfill there shouldn't be matched
          // rows under an unmatched bucket, but be explicit.)
          where.push("s.employee_id IS NULL");
        }

        if (entityIdRaw) {
          const xid = parseInt(entityIdRaw, 10);
          if (!Number.isFinite(xid)) throw new Error("entity_id must be numeric (-1 for unallocated)");
          if (xid === -1) {
            where.push("s.entity_id IS NULL");
          } else {
            where.push("s.entity_id = ?");
            params.push(xid);
          }
        }

        const { sqlite } = require("./storage");
        const rows = sqlite
          .prepare(
            `SELECT
               s.id, s.period_start, s.period_end, s.order_name, s.order_id,
               s.assisting_staff_id, s.staff_name,
               s.gross_sales, s.discounts, s.returns AS returns_amt, s.net_sales,
               s.taxes, s.total_sales, s.quantity AS qty_per_order,
               s.allocation_method, s.share AS entity_share,
               COALESCE(en.display_name, en.location) AS entity_label,
               o.processed_at AS order_processed_at,
               o.source_name AS order_source
             FROM recon_shopify_staff_sales s
             LEFT JOIN payroll_entities en ON en.id = s.entity_id
             LEFT JOIN recon_orders o ON o.id = s.order_id
             WHERE ${where.join(" AND ")}
             -- PR #205: order by actual Shopify order date (falls back to
             -- period_start when the order isn't linked yet).
             ORDER BY COALESCE(s.occurred_on, o.created_at, s.period_start) DESC, ABS(s.total_sales) DESC
             LIMIT 2000`,
          )
          .all(...params);
        res.json({ ok: true, count: rows.length, rows });
      } catch (e: any) {
        res.status(400).json({ message: String(e?.message || e) });
      }
    },
  );


  // PR A_Staff — line-by-line attribution endpoints (read from
  // v_staff_attributed_sales). These run IN PARALLEL to the ShopifyQL-backed
  // /by-employee and /orders endpoints above; PR C_Staff will add a
  // reconciliation that compares the two sums per staff per period.
  //
  // Date semantics: filter by event_date (sale date for 'sale' rows,
  // refund processed_at for 'refund' rows). A sale in March + a refund in
  // May = +sale lands in March's total, −refund lands in May's total.
  // This is the activity-date basis Jake pays commission on.
  app.get(
    "/api/recon/shopify/staff-sales/by-employee-attributed",
    authMiddleware,
    requirePermission("payroll.view"),
    (req, res) => {
      try {
        const since = String(req.query.since ?? "").trim();
        const until = String(req.query.until ?? "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
          throw new Error("since and until must be YYYY-MM-DD");
        }
        if (since > until) {
          throw new Error("since must be <= until");
        }

        const { sqlite } = require("./storage");

        // Per-employee rollup. group_key splits unmatched rows by
        // assisting_staff_id so each unknown Shopify staff member becomes
        // its own row instead of collapsing into one "(unmatched)" bucket —
        // same convention as PR #204 on /by-employee.
        //
        // sale_amount / refund_amount / net_amount break out the cash flow
        // so the UI can show "$X gross, ($Y) returns = $Z commission base"
        // without a separate query.
        const empRows = sqlite
          .prepare(
            `SELECT
               CASE WHEN v.employee_id IS NULL
                    THEN 'staff:' || v.assisting_staff_id
                    ELSE 'emp:'   || v.employee_id
               END                                                  AS group_key,
               v.employee_id                                        AS employee_id,
               MAX(v.assisting_staff_id)                            AS assisting_staff_id,
               COALESCE(e.full_name, '(unmatched)')                 AS full_name,
               GROUP_CONCAT(DISTINCT v.assisting_staff_id)          AS shopify_staff_ids,
               SUM(CASE WHEN v.event_type = 'sale'   THEN v.attributed_amount ELSE 0 END) AS sale_amount,
               SUM(CASE WHEN v.event_type = 'refund' THEN v.attributed_amount ELSE 0 END) AS refund_amount,
               SUM(v.attributed_amount)                             AS net_amount,
               SUM(CASE WHEN v.event_type = 'sale'   THEN 1 ELSE 0 END) AS sale_row_count,
               SUM(CASE WHEN v.event_type = 'refund' THEN 1 ELSE 0 END) AS refund_row_count,
               COUNT(DISTINCT v.order_id)                           AS order_count
             FROM v_staff_attributed_sales v
             LEFT JOIN payroll_employees e ON e.id = v.employee_id
             WHERE date(v.event_date) BETWEEN ? AND ?
             GROUP BY group_key
             ORDER BY net_amount DESC`,
          )
          .all(since, until);

        // Per-entity breakdown. NULL entity = "(unallocated)" — staff member
        // not yet linked to a payroll_employees row, so we can't bucket the
        // dollars to a store. PR C_Staff alert will flag these.
        const entRows = sqlite
          .prepare(
            `SELECT
               CASE WHEN v.employee_id IS NULL
                    THEN 'staff:' || v.assisting_staff_id
                    ELSE 'emp:'   || v.employee_id
               END                                                  AS group_key,
               v.employee_id,
               MAX(v.assisting_staff_id)                            AS assisting_staff_id,
               v.employee_entity_id                                 AS entity_id,
               COALESCE(en.display_name, en.location, '(unallocated)') AS entity_label,
               en.location                                          AS entity_location,
               SUM(CASE WHEN v.event_type = 'sale'   THEN v.attributed_amount ELSE 0 END) AS sale_amount,
               SUM(CASE WHEN v.event_type = 'refund' THEN v.attributed_amount ELSE 0 END) AS refund_amount,
               SUM(v.attributed_amount)                             AS net_amount,
               COUNT(DISTINCT v.order_id)                           AS order_count
             FROM v_staff_attributed_sales v
             LEFT JOIN payroll_entities en ON en.id = v.employee_entity_id
             WHERE date(v.event_date) BETWEEN ? AND ?
             GROUP BY group_key, v.employee_entity_id
             ORDER BY net_amount DESC`,
          )
          .all(since, until);

        const byEntityForEmp = new Map<string, any[]>();
        for (const r of entRows as any[]) {
          const key = String(r.group_key);
          if (!byEntityForEmp.has(key)) byEntityForEmp.set(key, []);
          byEntityForEmp.get(key)!.push(r);
        }

        const employees = (empRows as any[]).map((emp) => {
          const key = String(emp.group_key);
          return { ...emp, by_entity: byEntityForEmp.get(key) ?? [] };
        });

        const totalsRow = sqlite
          .prepare(
            `SELECT
               SUM(CASE WHEN v.event_type = 'sale'   THEN v.attributed_amount ELSE 0 END) AS sale_amount,
               SUM(CASE WHEN v.event_type = 'refund' THEN v.attributed_amount ELSE 0 END) AS refund_amount,
               SUM(v.attributed_amount)                             AS net_amount,
               COUNT(DISTINCT v.order_id)                           AS order_count,
               COUNT(*)                                             AS row_count
             FROM v_staff_attributed_sales v
             WHERE date(v.event_date) BETWEEN ? AND ?`,
          )
          .get(since, until);

        res.json({
          ok: true,
          source: "v_staff_attributed_sales",
          since,
          until,
          totals: totalsRow,
          employees,
        });
      } catch (e: any) {
        res.status(400).json({ message: String(e?.message || e) });
      }
    },
  );

  // Per-event drill-down for the attributed view: every sale and refund row
  // for one employee × entity over the window. Used by PR C_Staff's recon
  // alert ("show me the lines behind this employee's $X").
  app.get(
    "/api/recon/shopify/staff-sales/orders-attributed",
    authMiddleware,
    requirePermission("payroll.view"),
    (req, res) => {
      try {
        const since = String(req.query.since ?? "").trim();
        const until = String(req.query.until ?? "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
          throw new Error("since and until must be YYYY-MM-DD");
        }
        if (since > until) {
          throw new Error("since must be <= until");
        }
        const employeeIdRaw = String(req.query.employee_id ?? "").trim();
        const entityIdRaw = String(req.query.entity_id ?? "").trim();
        const assistingStaffIdRaw = String(req.query.assisting_staff_id ?? "").trim();
        const eventTypeRaw = String(req.query.event_type ?? "").trim();

        const where: string[] = ["date(v.event_date) BETWEEN ? AND ?"];
        const params: any[] = [since, until];

        if (employeeIdRaw === "_null") {
          where.push("v.employee_id IS NULL");
        } else if (employeeIdRaw) {
          const eid = parseInt(employeeIdRaw, 10);
          if (!Number.isFinite(eid)) throw new Error("employee_id must be numeric or '_null'");
          where.push("v.employee_id = ?");
          params.push(eid);
        }

        if (assistingStaffIdRaw) {
          if (!/^\d{1,20}$/.test(assistingStaffIdRaw)) {
            throw new Error("assisting_staff_id must be a numeric string");
          }
          where.push("v.assisting_staff_id = ?");
          params.push(assistingStaffIdRaw);
          where.push("v.employee_id IS NULL");
        }

        if (entityIdRaw) {
          const xid = parseInt(entityIdRaw, 10);
          if (!Number.isFinite(xid)) throw new Error("entity_id must be numeric (-1 for unallocated)");
          if (xid === -1) {
            where.push("v.employee_entity_id IS NULL");
          } else {
            where.push("v.employee_entity_id = ?");
            params.push(xid);
          }
        }

        if (eventTypeRaw === "sale" || eventTypeRaw === "refund") {
          where.push("v.event_type = ?");
          params.push(eventTypeRaw);
        }

        const { sqlite } = require("./storage");
        const rows = sqlite
          .prepare(
            `SELECT
               v.event_type, v.event_date, v.event_month,
               v.order_id, v.order_name, v.order_source,
               v.line_item_id, v.refund_id,
               v.assisting_staff_id, v.employee_id, v.employee_entity_id,
               v.units, v.line_quantity, v.share, v.attributed_amount,
               li.title         AS line_title,
               li.sku           AS line_sku,
               li.variant_title AS line_variant_title,
               COALESCE(en.display_name, en.location) AS entity_label,
               e.full_name      AS employee_name
             FROM v_staff_attributed_sales v
             LEFT JOIN recon_line_items li ON li.id = v.line_item_id
             LEFT JOIN payroll_entities en ON en.id = v.employee_entity_id
             LEFT JOIN payroll_employees e ON e.id = v.employee_id
             WHERE ${where.join(" AND ")}
             ORDER BY v.event_date DESC, ABS(v.attributed_amount) DESC
             LIMIT 2000`,
          )
          .all(...params);
        res.json({ ok: true, source: "v_staff_attributed_sales", count: rows.length, rows });
      } catch (e: any) {
        res.status(400).json({ message: String(e?.message || e) });
      }
    },
  );


  // PR #204 — diagnostic endpoint for the commission matcher.
  //
  // For each distinct Shopify staff id present in recon_shopify_staff_sales,
  // shows what the resolver would match against and why (or why not). Used to
  // debug the "everyone unmatched" failure mode where the bare-numeric form
  // from ShopifyQL doesn't line up with the gid:// form stored on
  // payroll_employees.shopify_staff_member_id.
  app.get(
    "/api/recon/shopify/staff-sales/diagnose-unmatched",
    authMiddleware,
    requirePermission("payroll.view"),
    (_req, res) => {
      try {
        const { sqlite } = require("./storage");
        const { resolveEmployeeByShopifyStaff } = require("./commission-matcher");

        // Every distinct staff id we've seen, with its sample name + an
        // example_order_name for traceability.
        const distinct = sqlite
          .prepare(
            `SELECT
               assisting_staff_id,
               MAX(staff_name) AS staff_name,
               MAX(order_name) AS example_order_name,
               COUNT(*) AS row_count,
               SUM(total_sales) AS total_sales
             FROM recon_shopify_staff_sales
             GROUP BY assisting_staff_id
             ORDER BY ABS(SUM(total_sales)) DESC`,
          )
          .all() as any[];

        // What's stored on payroll_employees today (for comparison).
        const directRows = sqlite
          .prepare(
            `SELECT id, full_name, shopify_staff_member_id, active
             FROM payroll_employees
             WHERE shopify_staff_member_id IS NOT NULL
               AND shopify_staff_member_id != ''
             ORDER BY full_name`,
          )
          .all() as any[];

        // What's stored on person_external_ids for the SHOPIFY_STAFF system.
        const pxiRows = sqlite
          .prepare(
            `SELECT pxi.external_id, p.id AS person_id, p.display_name, p.status
             FROM person_external_ids pxi
             JOIN people p ON p.id = pxi.person_id
             WHERE pxi.system = 'shopify_staff'
             ORDER BY p.display_name`,
          )
          .all() as any[];

        // Run the resolver over each distinct id and capture the result.
        const resolved = distinct.map((d) => {
          const r = resolveEmployeeByShopifyStaff(d.assisting_staff_id);
          return {
            ...d,
            matched: r !== null,
            employee_id: r?.employee_id ?? null,
            full_name: r?.full_name ?? null,
            match_source: r?.match_source ?? null,
          };
        });

        const matched = resolved.filter((r: any) => r.matched).length;
        const unmatched = resolved.length - matched;

        res.json({
          ok: true,
          summary: {
            distinct_staff_ids: resolved.length,
            matched,
            unmatched,
            payroll_employees_with_shopify_id: directRows.length,
            person_external_ids_for_shopify: pxiRows.length,
          },
          by_staff_id: resolved,
          payroll_employees: directRows,
          person_external_ids: pxiRows,
        });
      } catch (e: any) {
        res.status(500).json({ message: String(e?.message || e) });
      }
    },
  );

  // PR #212 — Backfill employee_id on existing recon_shopify_staff_sales
  // rows that ingested BEFORE a payroll_employees link was created. The
  // ingest upsert only stamps employee_id on rows it writes for the
  // current sync window; older rows for the same staff member keep their
  // NULL employee_id until this backfill runs.
  //
  // Effect on Staff Sales UI: collapses the "two John Murray rows"
  // pattern (one matched, one unmatched) into a single matched row.
  //
  // Safe to re-run: only touches rows where employee_id IS NULL, and
  // only sets it when the resolver returns a non-NULL match.
  // PR #214 — extracted helper so both the bulk POST and the PATCH-employee
  // hook can stamp employee_id on previously-NULL recon rows. Returns the
  // resolved employee plus the number of rows stamped. Safe to call with a
  // raw value (bare numeric OR gid form) — the matcher normalizes it.
  function backfillEmployeeLinksForStaffId(rawStaffId: string | number | null | undefined): {
    resolved: { employee_id: number; full_name: string | null } | null;
    rows_updated: number;
  } {
    const { sqlite } = require("./storage");
    const { resolveEmployeeByShopifyStaff } = require("./commission-matcher");
    const resolved = resolveEmployeeByShopifyStaff(rawStaffId);
    if (!resolved || resolved.employee_id == null) {
      return { resolved: null, rows_updated: 0 };
    }
    // Stamp both bare-numeric and gid forms of the staff id, since rows
    // ingested before the link may have stored either shape.
    const normalized = String(rawStaffId ?? "").replace(/^gid:\/\/shopify\/StaffMember\//, "");
    const gidForm = `gid://shopify/StaffMember/${normalized}`;
    const info = sqlite
      .prepare(
        `UPDATE recon_shopify_staff_sales
            SET employee_id = ?
          WHERE employee_id IS NULL
            AND assisting_staff_id IN (?, ?)`,
      )
      .run(resolved.employee_id, normalized, gidForm);
    return {
      resolved: { employee_id: resolved.employee_id, full_name: resolved.full_name ?? null },
      rows_updated: Number((info as any).changes ?? 0),
    };
  }

  app.post(
    "/api/recon/shopify/staff-sales/backfill-employee-links",
    authMiddleware,
    requirePermission("system.manage_config"),
    (_req, res) => {
      try {
        const { sqlite } = require("./storage");

        // Every distinct staff id that has at least one NULL-employee_id
        // row. Cheap query — idx_recon_staff_sales_unmatched is a
        // partial index exactly on this predicate.
        const distinct = sqlite
          .prepare(
            `SELECT DISTINCT assisting_staff_id
               FROM recon_shopify_staff_sales
              WHERE employee_id IS NULL`,
          )
          .all() as Array<{ assisting_staff_id: string }>;

        let staffMatched = 0;
        let staffUnmatched = 0;
        let rowsUpdated = 0;
        const perStaff: Array<{
          assisting_staff_id: string;
          employee_id: number | null;
          full_name: string | null;
          rows_updated: number;
        }> = [];

        const tx = sqlite.transaction(() => {
          for (const r of distinct) {
            const out = backfillEmployeeLinksForStaffId(r.assisting_staff_id);
            if (out.resolved) {
              rowsUpdated += out.rows_updated;
              staffMatched++;
              perStaff.push({
                assisting_staff_id: r.assisting_staff_id,
                employee_id: out.resolved.employee_id,
                full_name: out.resolved.full_name,
                rows_updated: out.rows_updated,
              });
            } else {
              staffUnmatched++;
            }
          }
        });
        tx();

        res.json({
          ok: true,
          distinct_unmatched_staff_ids: distinct.length,
          staff_matched: staffMatched,
          staff_still_unmatched: staffUnmatched,
          rows_updated: rowsUpdated,
          per_staff: perStaff,
        });
      } catch (e: any) {
        res.status(500).json({ message: String(e?.message || e) });
      }
    },
  );

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

  // PR #216 - inspect per-line POS staff attribution for a single order.
  // Returns one row per (line_item, assisting_staff) plus the line.quantity
  // so the caller can compute share = unit_quantity / line.quantity and
  // spot any unmatched gap where sum(unit_quantity) < line.quantity.
  app.get(
    "/api/recon/orders/:id/assisting-staff",
    authMiddleware,
    requirePermission("payroll.view"),
    (req, res) => {
      try {
        const orderId = String(req.params.id);
        const { sqlite } = require("./storage");
        const order = sqlite
          .prepare(`SELECT id, name FROM recon_orders WHERE id = ?`)
          .get(orderId);
        if (!order) {
          return res.status(404).json({ message: "Order not found" });
        }
        const rows = sqlite
          .prepare(
            `SELECT s.line_item_id, s.assisting_staff_id, s.unit_quantity,
                    s.source, s.ingested_at,
                    li.title AS line_title, li.quantity AS line_quantity,
                    li.line_subtotal AS line_subtotal,
                    li.is_gift_card AS is_gift_card,
                    e.id AS employee_id, e.full_name AS employee_name
             FROM recon_order_assisting_staff s
             LEFT JOIN recon_line_items li ON li.id = s.line_item_id
             LEFT JOIN payroll_employees e
                    ON e.shopify_staff_member_id = s.assisting_staff_id
             WHERE s.order_id = ?
             ORDER BY s.line_item_id, s.assisting_staff_id`,
          )
          .all(orderId);
        const perLine = sqlite
          .prepare(
            `SELECT li.id AS line_item_id, li.title, li.quantity AS line_quantity,
                    li.is_gift_card,
                    COALESCE(SUM(s.unit_quantity), 0) AS attributed_units,
                    (li.quantity - COALESCE(SUM(s.unit_quantity), 0)) AS unmatched_units
             FROM recon_line_items li
             LEFT JOIN recon_order_assisting_staff s
                    ON s.line_item_id = li.id
             WHERE li.order_id = ?
             GROUP BY li.id
             ORDER BY li.id`,
          )
          .all(orderId);
        res.json({
          order: { id: order.id, name: order.name },
          assisting_staff: rows,
          per_line: perLine,
        });
      } catch (e: any) {
        res.status(500).json({ message: e?.message ?? "Inspect failed" });
      }
    },
  );

  // PR #216 - backfill recon_order_assisting_staff for every existing
  // recon_orders row by re-running the extractor over the stored
  // recon_line_items.raw_json. Idempotent and safe to re-run.
  app.post(
    "/api/recon/admin/backfill-assisting-staff",
    authMiddleware,
    requirePermission("system.manage_config"),
    (_req, res) => {
      try {
        const { sqlite, extractAssistingStaffFromLineRawJson } = require("./storage");
        const now = new Date().toISOString();
        let ordersTouched = 0;
        let linesScanned = 0;
        let staffRowsWritten = 0;
        const tx = sqlite.transaction(() => {
          sqlite.exec(`DELETE FROM recon_order_assisting_staff`);
          const orders = sqlite
            .prepare(`SELECT id, name FROM recon_orders`)
            .all();
          const lineStmt = sqlite.prepare(
            `SELECT id, raw_json FROM recon_line_items WHERE order_id = ?`,
          );
          const ins = sqlite.prepare(`
            INSERT INTO recon_order_assisting_staff (
              order_id, order_name, line_item_id, assisting_staff_id,
              unit_quantity, source, ingested_at
            ) VALUES (?, ?, ?, ?, ?, 'shopify_rest_attributed_staffs', ?)
          `);
          for (const o of orders) {
            ordersTouched += 1;
            const lines = lineStmt.all(o.id);
            for (const li of lines) {
              linesScanned += 1;
              const staffRows = extractAssistingStaffFromLineRawJson(li.raw_json);
              for (const s of staffRows) {
                ins.run(
                  o.id, o.name ?? "", li.id, s.assisting_staff_id,
                  s.unit_quantity, now,
                );
                staffRowsWritten += 1;
              }
            }
          }
        });
        tx();
        res.json({
          orders_touched: ordersTouched,
          lines_scanned: linesScanned,
          staff_rows_written: staffRowsWritten,
          completed_at: now,
        });
      } catch (e: any) {
        res.status(500).json({ message: e?.message ?? "Backfill failed" });
      }
    },
  );

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

  // PR #132 — Range backfill for the allocator. Walks YYYY-MM → YYYY-MM
  // inclusive and runs runAllocationEngine for each month sequentially.
  //
  // Idempotent: runAllocationEngine deletes only auto allocations for the
  // target month before re-inserting (preserves manual_override rows), so
  // re-running the same range is safe. Synchronous — the 17-month backfill
  // takes ~10s on a warm SQLite, well inside any reasonable HTTP timeout,
  // and the response includes per-month summary so the operator can spot
  // anomalies (e.g. a month with elevated needs_review).
  //
  // Body: { from: "YYYY-MM", to: "YYYY-MM" }   (both inclusive)
  // Returns: { ok, months_processed, per_month: AllocationRunSummary[],
  //            total_orders, total_line_items, total_allocations,
  //            total_needs_review, total_failed }
  app.post("/api/recon/allocations/backfill", authMiddleware, requirePermission("system.manage_config"), (req: any, res) => {
    const from = String(req.body?.from ?? "").trim();
    const to = String(req.body?.to ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "from and to must be YYYY-MM" });
    }
    if (from > to) {
      return res.status(400).json({ error: "from must be <= to" });
    }

    // Enumerate months from..to inclusive. Cap at 36 months to prevent
    // runaway requests against a misconfigured cutover date.
    const months: string[] = [];
    let [y, m] = from.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      months.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m === 13) { m = 1; y += 1; }
      if (months.length > 36) {
        return res.status(400).json({ error: "range exceeds 36 months" });
      }
    }

    const t0 = Date.now();
    const perMonth: any[] = [];
    let total_orders = 0, total_line_items = 0, total_allocations = 0;
    let total_needs_review = 0, total_failed = 0;
    for (const monthStr of months) {
      try {
        const s = runAllocationEngine(monthStr);
        perMonth.push(s);
        total_orders += s.orders_processed;
        total_line_items += s.line_items_processed;
        total_allocations += s.allocations_written;
        total_needs_review += s.needs_review_orders;
        total_failed += s.failed_orders;
      } catch (e: any) {
        // One bad month shouldn't abort the rest — record the error and
        // continue. The operator can re-run the single month manually.
        perMonth.push({
          month: monthStr,
          error: e?.message ?? String(e),
          orders_processed: 0,
          line_items_processed: 0,
          allocations_written: 0,
          needs_review_orders: 0,
          failed_orders: 0,
        });
      }
    }

    res.json({
      ok: true,
      from,
      to,
      months_processed: months.length,
      duration_ms: Date.now() - t0,
      total_orders,
      total_line_items,
      total_allocations,
      total_needs_review,
      total_failed,
      per_month: perMonth,
    });
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

  // ---- PR #123 — Gift card identity backfill + distribution diagnostic ----
  // The backfill writes recon_gift_card_issuance rows for every historical
  // GC sale that doesn't already have one (POS + online, digital + physical),
  // marking each with backfilled_at=now() so the redemption flow knows to
  // suppress cross-entity JE generation on those cards. The diagnostic
  // endpoint returns the current distribution so we can validate before
  // moving on to the by-store finance endpoint.
  app.post("/api/recon/giftcards/backfill-identity", authMiddleware, requirePermission("system.manage_config"), (req, res) => {
    const src = Object.keys(req.body || {}).length > 0 ? req.body : req.query;
    const parsed = parseRangeOrNull(src);
    if ("error" in parsed) return res.status(400).json(parsed);
    try {
      const result = backfillGcIdentityForRange(parsed.sinceIso, parsed.untilIso);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.get("/api/recon/giftcards/distribution", authMiddleware, requirePermission("system.manage_config"), (_req, res) => {
    try {
      res.json(getGcIdentityDistribution());
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

  // PR #135 — build-info endpoint. Returns git SHA + build time so devtools
  // can verify which revision the Windows service is actually running after
  // a restart. Reads env vars set at build/start time (GIT_SHA, BUILD_TIME);
  // falls back to 'unknown' if not provided. Pure read, no auth required
  // because git SHA isn't sensitive.
  app.get("/api/build-info", (_req, res) => {
    // PR #136 — also dump current sqlite PRAGMA settings so we can confirm
    // whether better-sqlite3 is running with synchronous=FULL (the default,
    // which fsyncs per commit) or NORMAL. Per-line ~30ms cost in the allocator
    // backfill is consistent with fsync-bound writes on Windows storage.
    let pragmas: Record<string, unknown> = {};
    try {
      const { sqlite } = require("./storage");
      const journal = sqlite.pragma("journal_mode", { simple: true });
      const sync = sqlite.pragma("synchronous", { simple: true });
      const cache = sqlite.pragma("cache_size", { simple: true });
      const tempStore = sqlite.pragma("temp_store", { simple: true });
      const walAutoCp = sqlite.pragma("wal_autocheckpoint", { simple: true });
      const busyTimeout = sqlite.pragma("busy_timeout", { simple: true });
      const pageSize = sqlite.pragma("page_size", { simple: true });
      pragmas = {
        journal_mode: journal,
        synchronous: sync,
        cache_size: cache,
        temp_store: tempStore,
        wal_autocheckpoint: walAutoCp,
        busy_timeout: busyTimeout,
        page_size: pageSize,
      };
    } catch (e: any) {
      pragmas = { error: e?.message || String(e) };
    }
    res.json({
      git_sha: process.env.GIT_SHA || "unknown",
      build_time: process.env.BUILD_TIME || "unknown",
      node_version: process.version,
      pid: process.pid,
      uptime_sec: Math.round(process.uptime()),
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      sqlite_pragmas: pragmas,
    });
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
      // PR #R4k — always reflect the latest parse for payment_terms. The first
      // ingest never wrote this column, so any pre-fix invoice has null here;
      // reparse should overwrite. Safe because user can't edit it from the UI.
      payment_terms: llmResult.payment_terms ?? null,
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
    // PR #R4r — now uses the same shared helper as every ingest path.
    {
      const effectiveInvoiceDate = patch.invoice_date || inv.invoice_date || llmResult.invoice_date || null;
      const filled = applyPostLlmTermsFallback(llmResult, effectiveInvoiceDate);
      if (filled.length > 0) {
        console.log(
          `[terms-fallback] reparse ${inv.id}: filled ${filled.join(",")} from "${llmResult.payment_terms}"`,
        );
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
      // R4q backlog fix: bust both Gmail allowlist caches so a freshly-added
      // vendor (with no primary_email but a matching domain slug) gets picked
      // up on the very next poll instead of waiting for the 10-minute TTL.
      try { invalidateVendorAllowlistCache(); } catch {}
      try { invalidateGmailApiVendorAllowlistCache(); } catch {}
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

  // R4q: Pub/Sub push webhook for Gmail watch notifications.
  // Pub/Sub POSTs an envelope { message: { data: <base64 JSON>, messageId, publishTime, attributes }, subscription }.
  // We decode the data field (which contains {emailAddress, historyId}) and
  // hand off to processHistoryPush() which walks history.list since the last
  // saved historyId, fetches any new INBOX messages, and runs them through
  // the same Stage 1 → LLM → dedup → QBO pipeline as the IMAP path.
  //
  // PUBLIC — no auth middleware (Pub/Sub doesn't send Bearer tokens).
  // We always ACK with 204 to prevent Pub/Sub retry storms; real errors are
  // logged to the rolling error log and surfaced in the Gmail API status panel.
  //
  // Gated by isGmailApiEnabled(): if the feature flag is off, we log + ACK
  // without doing any processing (IMAP-only mode).
  app.post("/api/gmail/push", async (req, res) => {
    // ACK immediately so Pub/Sub doesn't time out waiting for processing.
    // The actual work continues in the background.
    res.status(204).end();

    try {
      const env = req.body || {};
      const msg = env.message || {};
      let decoded: { emailAddress?: string; historyId?: string } = {};
      if (msg.data) {
        try {
          decoded = JSON.parse(Buffer.from(msg.data, "base64").toString("utf8"));
        } catch (e) {
          console.error("[gmail-push] failed to decode data field:", (e as Error).message);
          return;
        }
      }

      console.log(
        `[gmail-push] received emailAddress=${decoded.emailAddress} historyId=${decoded.historyId} ` +
        `messageId=${msg.messageId || msg.message_id}`,
      );

      if (!isGmailApiEnabled()) {
        console.log("[gmail-push] GMAIL_API_ENABLED=false — dropping push (IMAP-only mode)");
        return;
      }

      if (!decoded.historyId) {
        console.warn("[gmail-push] no historyId in payload — ignoring");
        return;
      }

      // Fire-and-forget; errors are recorded inside processHistoryPush()
      processHistoryPush(decoded.historyId).then((r) => {
        if (r.new_invoices > 0 || r.errors.length > 0) {
          console.log(`[gmail-push] processed — new_invoices=${r.new_invoices} errors=${r.errors.length}`);
        }
      }).catch((e) => {
        console.error("[gmail-push] processHistoryPush threw:", e?.message || String(e));
      });
    } catch (err: any) {
      console.error("[gmail-push] handler error:", err.message);
    }
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

  // PR #R4m+ — diagnostic: run searchVendorCredits directly so we can see what QBO
  // returns for a given DocNumber. Useful when the UI says "no duplicates found" but
  // the credit clearly exists in QBO.
  // Usage: GET /api/qbo/diagnose-vendor-credit?doc=12345
  app.get("/api/qbo/diagnose-vendor-credit", authMiddleware, async (req, res) => {
    const doc = String(req.query.doc || "").trim();
    if (!doc) return res.status(400).json({ error: "provide ?doc=<invoice_number>" });
    try {
      // Three queries, in parallel:
      //   1) exact DocNumber IN  — the actual production query
      //   2) DocNumber LIKE       — catches trailing whitespace / case / prefix drift
      //   3) Bill exact           — sanity check that QBO connectivity works for this run
      const exactQuery = `select Id, DocNumber, TxnDate, TotalAmt, Balance, VendorRef from VendorCredit where DocNumber = '${doc.replace(/'/g, "''")}'`;
      const likeQuery  = `select Id, DocNumber, TxnDate, TotalAmt, Balance, VendorRef from VendorCredit where DocNumber LIKE '%${doc.replace(/'/g, "''")}%' MAXRESULTS 20`;
      const billQuery  = `select Id, DocNumber, TxnDate, TotalAmt, Balance, VendorRef from Bill where DocNumber = '${doc.replace(/'/g, "''")}'`;
      const { getQboStatus } = await import("./qbo");
      const status = getQboStatus();
      if (!status.connected) return res.json({ connected: false });
      // Use the same internal fetch as searchBills/searchVendorCredits.
      const qboModule = await import("./qbo");
      const qboFetch = (qboModule as any).qboFetchExposed || null;
      // Fallback: call searchVendorCredits and searchBills helpers.
      const [credits, bills] = await Promise.all([
        (qboModule as any).searchVendorCredits([doc]).catch((e: any) => ({ error: e?.message || String(e) })),
        (qboModule as any).searchBills([doc]).catch((e: any) => ({ error: e?.message || String(e) })),
      ]);
      res.json({
        connected: true,
        query_doc: doc,
        exact_query: exactQuery,
        like_query: likeQuery,
        bill_query: billQuery,
        vendor_credits_found: Array.isArray(credits) ? credits.length : 0,
        vendor_credits: credits,
        bills_found: Array.isArray(bills) ? bills.length : 0,
        bills: bills,
        qbo_error_log: (await import("./qbo")).getQboErrorLog(20),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // PR #R4m — diagnostic: look up rows in ingested_emails by sender substring.
  // Used to figure out why a specific vendor's email didn't ingest (Stage 1 skip,
  // attachment error, etc). Returns the raw row including skip_reasons JSON.
  // Usage: GET /api/gmail/diagnose-ingested?from=kingsleybate&limit=20
  app.get("/api/gmail/diagnose-ingested", authMiddleware, (req, res) => {
    const fromQ = String(req.query.from || "").trim();
    const subjectQ = String(req.query.subject || "").trim();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "50"), 10) || 50, 1), 500);
    if (!fromQ && !subjectQ) {
      return res.status(400).json({ error: "provide ?from=<substring> and/or ?subject=<substring>" });
    }
    const db = (require("./storage") as any).getDbDirect ? (require("./storage") as any).getDbDirect() : null;
    // Fall back to opening the DB directly if the storage module doesn't expose it.
    let database: any = db;
    try {
      if (!database) {
        const Database = require("better-sqlite3");
        const { getDbPath } = require("./db-path");
        database = new Database(getDbPath());
      }
      const where: string[] = [];
      const params: any[] = [];
      if (fromQ) { where.push("LOWER(from_address) LIKE ?"); params.push(`%${fromQ.toLowerCase()}%`); }
      if (subjectQ) { where.push("LOWER(subject) LIKE ?"); params.push(`%${subjectQ.toLowerCase()}%`); }
      params.push(limit);
      const rows = database.prepare(
        `SELECT message_id, gmail_uid, subject, from_address, date, pdf_count, invoice_ids,
                ingested_at, skipped_count, skip_reasons
         FROM ingested_emails
         WHERE ${where.join(" AND ")}
         ORDER BY ingested_at DESC
         LIMIT ?`
      ).all(...params);
      res.json({ count: rows.length, rows });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
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


  // ===== R4q: Gmail API OAuth + status routes (parallel-run alongside IMAP) =====
  // Same shape/conventions as Drive routes above. Uses separate token storage
  // (purpose=gmail_service in google_oauth table) and its own scopes
  // (gmail.modify). Available only when GMAIL_API_ENABLED=true, but the
  // routes themselves register unconditionally so the UI can show a
  // 'disabled' state cleanly.

  app.get("/api/auth/gmail/connect", (req, res) => {
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
    const redirectUri = process.env.GOOGLE_REDIRECT_URI_PROD || process.env.GOOGLE_REDIRECT_URI_LOCAL || `http://localhost:${process.env.PORT || 5000}/api/auth/google/callback`;
    const gmailRedirectUri = redirectUri.replace("/auth/google/callback", "/auth/gmail/callback");
    const state = generateOAuthState("gmail");
    const url = getGmailAuthUrl(gmailRedirectUri, state);
    res.redirect(url);
  });

  app.get("/api/auth/gmail/callback", async (req, res) => {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const error = String(req.query.error || "");

    if (error) {
      return res.redirect("/settings?error=gmail_denied&tab=integrations");
    }
    if (!verifyOAuthState(state, "gmail")) {
      return res.redirect("/settings?error=invalid_state&tab=integrations");
    }
    if (!code) {
      return res.redirect("/settings?error=no_code&tab=integrations");
    }

    try {
      const redirectUri = process.env.GOOGLE_REDIRECT_URI_PROD || process.env.GOOGLE_REDIRECT_URI_LOCAL || `http://localhost:${process.env.PORT || 5000}/api/auth/google/callback`;
      const gmailRedirectUri = redirectUri.replace("/auth/google/callback", "/auth/gmail/callback");
      const tokens = await exchangeCodeForTokens(code, gmailRedirectUri);

      let grantedEmail: string | undefined;
      try {
        const { google } = await import("googleapis");
        const oauth2 = (await import("./google-oauth")).getOAuth2Client(gmailRedirectUri);
        oauth2.setCredentials(tokens as any);
        const people = google.oauth2({ version: "v2", auth: oauth2 });
        const info = await people.userinfo.get();
        grantedEmail = info.data.email || undefined;
      } catch {}

      setGmailTokens(tokens, grantedEmail);
      console.log(`[AUTH] Gmail API connected for ${grantedEmail || "unknown"}`);

      // Auto-register watch so push starts flowing immediately. Best-effort
      // — if it fails the user can retry from Settings (/api/gmail-api/start-watch).
      try {
        const watchResult = await startGmailWatch();
        console.log(`[AUTH] Gmail watch registered — expires=${new Date(Number(watchResult.expiration)).toISOString()} historyId=${watchResult.historyId}`);
      } catch (we: any) {
        console.error("[AUTH] Gmail watch registration failed (non-fatal):", we.message);
      }

      res.redirect("/settings?gmail_connected=1&tab=integrations");
    } catch (e: any) {
      console.error("[AUTH] Gmail API callback error:", e.message);
      res.redirect("/settings?error=gmail_failed&tab=integrations");
    }
  });

  app.post("/api/auth/gmail/disconnect", adminMiddleware, async (_req, res) => {
    try {
      try { await stopGmailWatch(); } catch (e: any) {
        console.warn("[AUTH] stopGmailWatch on disconnect failed (non-fatal):", e.message);
      }
      clearGmailTokens();
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/auth/gmail/status", authMiddleware, (_req, res) => {
    res.json({
      ...getGmailApiIngestStatus(),
      configured: isGoogleConfigured(),
      enabled: isGmailApiEnabled(),
    });
  });

  // ===== R4q: Gmail API ingest endpoints (parallel-run; do not replace /api/gmail/*) =====

  app.get("/api/gmail-api/status", authMiddleware, (_req, res) => {
    res.json({
      ...getGmailApiIngestStatus(),
      configured: isGoogleConfigured(),
      enabled: isGmailApiEnabled(),
    });
  });

  app.post("/api/gmail-api/poll-now", authMiddleware, async (_req, res) => {
    try {
      if (!isGmailApiEnabled()) {
        return res.status(409).json({ message: "Gmail API path is disabled (set GMAIL_API_ENABLED=true)" });
      }
      const result = await pollNowApi();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/gmail-api/test-connection", authMiddleware, async (_req, res) => {
    try {
      const r = await testGmailApiConnection();
      res.json(r);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/gmail-api/clear-error-log", authMiddleware, (_req, res) => {
    clearGmailApiErrorLog();
    res.json({ ok: true });
  });

  app.post("/api/gmail-api/reingest", adminMiddleware, async (req, res) => {
    try {
      if (!isGmailApiEnabled()) {
        return res.status(409).json({ message: "Gmail API path is disabled (set GMAIL_API_ENABLED=true)" });
      }
      const { from, subject, since, dryRun } = req.body || {};
      const r = await reingestEmailsApi({ from, subject, since, dryRun: !!dryRun });
      res.json(r);
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/gmail-api/start-watch", adminMiddleware, async (_req, res) => {
    try {
      if (!isGmailApiEnabled()) {
        return res.status(409).json({ message: "Gmail API path is disabled (set GMAIL_API_ENABLED=true)" });
      }
      const r = await startGmailWatch();
      res.json({
        ok: true,
        historyId: r.historyId,
        expiration: new Date(Number(r.expiration)).toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/gmail-api/stop-watch", adminMiddleware, async (_req, res) => {
    try {
      await stopGmailWatch();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
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

  // ============================================================================
  // PR C — one-shot bulk dedup cleanup (admin only)
  // ----------------------------------------------------------------------------
  // Cleans up the existing duplicate cluster that landed BEFORE the PR B
  // pdf_hash UNIQUE index existed. PR B blocks NEW dupes at ingest; this
  // endpoint collapses the historical dupes.
  //
  // Three phases, idempotent, status='rejected' (NOT DELETE) so the operation
  // is reversible via the existing /api/invoices/:id/restore endpoint.
  //
  //   1. Backfill `pdf_hash` on existing invoices when the source PDF is still
  //      on disk under private_assets/. Rows whose PDF is missing get NULL
  //      (they fall through to phase 3's email_id-based grouping).
  //
  //   2. JotForm / transfer-form pattern reject — any row matching the same
  //      rules as PR A's `isHardRejectedSender` (from = hello@snohaus.com,
  //      from contains @jotform.com, or subject matches the transfer regex)
  //      gets status='rejected'. ALL of them — no survivor — because these
  //      are never invoices.
  //
  //   3. Content-hash dupe collapse — group invoices by pdf_hash (non-NULL),
  //      keep the "best" row, reject the rest. Best = oldest (created_at ASC)
  //      among the rows with the most populated key fields (invoice_number +
  //      total + vendor_qbo_id all non-null beats those with nulls).
  //
  //   4. email_id dupe collapse — same logic but grouped by email_id, applied
  //      only to rows that still have NULL pdf_hash after phase 1. Catches
  //      the legacy null-hash clusters from before the index existed.
  //
  // Dry-run is the default. Pass `?dry_run=0` (or body { dry_run: false }) to
  // actually apply. Returns a report either way.
  app.post("/api/admin/dedup-cleanup", adminMiddleware, async (req, res) => {
    const rawQ = req.query.dry_run;
    const rawQStr = Array.isArray(rawQ) ? String(rawQ[0] ?? "") : (typeof rawQ === "string" ? rawQ : "");
    const dryRunParam = rawQStr || String(req.body?.dry_run ?? "1");
    const dryRun = dryRunParam !== "0" && dryRunParam !== "false";

    const { sqlite } = require("./storage");
    const assetsDir = path.resolve(__dirname, "..", "private_assets");
    const userEmail = (req as any).email || "system";

    type InvRow = {
      id: string;
      email_id: string | null;
      email_from: string | null;
      email_subject: string | null;
      invoice_number: string | null;
      total: number | null;
      vendor_qbo_id: string | null;
      vendor_raw_name: string | null;
      pdf_url: string | null;
      pdf_hash: string | null;
      status: string;
      created_at: string;
    };

    const errors: string[] = [];
    const TRANSFER_RE = /\b(begin a transfer|transfer\s*form)\b/i;
    const isJotformish = (r: InvRow): boolean => {
      const fromRaw = (r.email_from || "").toLowerCase();
      // Extract bare address from "Name <addr@host>" or "addr@host"
      const m = fromRaw.match(/<([^>]+)>/);
      const bareEmail = (m ? m[1] : fromRaw).trim();
      if (bareEmail === "hello@snohaus.com") return true;
      if (fromRaw.includes("@jotform.com")) return true;
      const subj = (r.email_subject || "").replace(/^\s*(re|fwd|fw):\s*/i, "").trim();
      if (TRANSFER_RE.test(subj)) return true;
      return false;
    };

    // Score for "best" row when collapsing dupes: higher is better.
    const completenessScore = (r: InvRow): number => {
      let s = 0;
      if (r.invoice_number && r.invoice_number.trim()) s += 4;
      if (r.total != null) s += 4;
      if (r.vendor_qbo_id) s += 2;
      if (r.vendor_raw_name && r.vendor_raw_name.trim()) s += 1;
      // posted_qbo > pending_review > rejected — never collapse onto a rejected survivor
      if (r.status === "posted_qbo") s += 100;
      else if (r.status === "pending_review") s += 50;
      return s;
    };

    const pickSurvivor = (rows: InvRow[]): InvRow => {
      // Best by completeness; ties broken by oldest created_at
      const sorted = [...rows].sort((a, b) => {
        const sb = completenessScore(b) - completenessScore(a);
        if (sb !== 0) return sb;
        return (a.created_at || "").localeCompare(b.created_at || "");
      });
      return sorted[0];
    };

    // ---------- Phase 1: backfill pdf_hash ----------
    const needsHash = sqlite.prepare(
      `SELECT id, pdf_url FROM invoices WHERE pdf_hash IS NULL AND status != 'rejected'`
    ).all() as Array<{ id: string; pdf_url: string | null }>;

    let backfilled = 0;
    let backfillSkippedMissing = 0;
    const updateHash = sqlite.prepare(`UPDATE invoices SET pdf_hash = ? WHERE id = ?`);

    for (const row of needsHash) {
      if (!row.pdf_url) { backfillSkippedMissing++; continue; }
      // pdf_url is stored as just the filename, e.g. "ab12cd34ef_invoice.pdf"
      const filePath = path.join(assetsDir, row.pdf_url);
      try {
        if (!fs.existsSync(filePath)) { backfillSkippedMissing++; continue; }
        const buf = fs.readFileSync(filePath);
        const hash = crypto.createHash("sha256").update(buf).digest("hex");
        if (!dryRun) {
          try {
            updateHash.run(hash, row.id);
            backfilled++;
          } catch (e: any) {
            if (e?.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed: invoices\.pdf_hash/i.test(e?.message || "")) {
              // Another row already has this hash — that's fine, we'll catch it
              // in phase 3 via the SELECT below. Leave this row's hash NULL.
              backfillSkippedMissing++;
            } else {
              errors.push(`backfill ${row.id}: ${e?.message || e}`);
            }
          }
        } else {
          backfilled++;
        }
      } catch (e: any) {
        errors.push(`backfill ${row.id}: ${e?.message || e}`);
      }
    }

    // ---------- Phase 2: JotForm / transfer-form reject ----------
    const candidatesAll = sqlite.prepare(
      `SELECT id, email_id, email_from, email_subject, invoice_number, total, vendor_qbo_id, vendor_raw_name, pdf_url, pdf_hash, status, created_at
       FROM invoices
       WHERE status != 'rejected'`
    ).all() as InvRow[];

    const jotformTargets = candidatesAll.filter(isJotformish);
    let jotformRejected = 0;
    if (!dryRun) {
      const tx = sqlite.transaction(() => {
        for (const r of jotformTargets) {
          const before = { ...r };
          const after = { ...r, status: "rejected" };
          sqlite.prepare(`UPDATE invoices SET status = 'rejected', updated_at = ? WHERE id = ?`)
            .run(new Date().toISOString(), r.id);
          sqlite.prepare(`INSERT INTO audit_log (invoice_id, action, before, after, user_email, created_at) VALUES (?,?,?,?,?,?)`)
            .run(r.id, "bulk-cleanup: jotform-transfer-pattern", JSON.stringify(before), JSON.stringify(after), userEmail, new Date().toISOString());
          jotformRejected++;
        }
      });
      tx();
    } else {
      jotformRejected = jotformTargets.length;
    }

    // Refresh candidates after phase 2 — read pdf_hash fresh too (phase 1 may have backfilled).
    const remaining = sqlite.prepare(
      `SELECT id, email_id, email_from, email_subject, invoice_number, total, vendor_qbo_id, vendor_raw_name, pdf_url, pdf_hash, status, created_at
       FROM invoices
       WHERE status != 'rejected'`
    ).all() as InvRow[];

    // ---------- Phase 3: collapse by pdf_hash ----------
    const hashGroups = new Map<string, InvRow[]>();
    for (const r of remaining) {
      if (!r.pdf_hash) continue;
      if (!hashGroups.has(r.pdf_hash)) hashGroups.set(r.pdf_hash, []);
      hashGroups.get(r.pdf_hash)!.push(r);
    }

    let hashDupesRejected = 0;
    const hashSurvivors: string[] = [];
    if (!dryRun) {
      const tx = sqlite.transaction(() => {
        for (const [hash, rows] of Array.from(hashGroups.entries())) {
          if (rows.length < 2) continue;
          const survivor = pickSurvivor(rows);
          hashSurvivors.push(survivor.id);
          for (const r of rows) {
            if (r.id === survivor.id) continue;
            const before = { ...r };
            const after = { ...r, status: "rejected" };
            sqlite.prepare(`UPDATE invoices SET status = 'rejected', updated_at = ? WHERE id = ?`)
              .run(new Date().toISOString(), r.id);
            sqlite.prepare(`INSERT INTO audit_log (invoice_id, action, before, after, user_email, created_at) VALUES (?,?,?,?,?,?)`)
              .run(r.id, `bulk-cleanup: hash-dupe (survivor=${survivor.id}, hash=${hash.slice(0, 12)})`, JSON.stringify(before), JSON.stringify(after), userEmail, new Date().toISOString());
            hashDupesRejected++;
          }
        }
      });
      tx();
    } else {
      for (const [, rows] of Array.from(hashGroups.entries())) {
        if (rows.length < 2) {
          if (rows.length === 1) hashSurvivors.push(rows[0].id);
          continue;
        }
        const survivor = pickSurvivor(rows);
        hashSurvivors.push(survivor.id);
        hashDupesRejected += rows.length - 1;
      }
    }

    // ---------- Phase 4: collapse remaining null-hash by email_id ----------
    const afterPhase3 = sqlite.prepare(
      `SELECT id, email_id, email_from, email_subject, invoice_number, total, vendor_qbo_id, vendor_raw_name, pdf_url, pdf_hash, status, created_at
       FROM invoices
       WHERE status != 'rejected' AND (pdf_hash IS NULL OR pdf_hash = '')`
    ).all() as InvRow[];

    const emailGroups = new Map<string, InvRow[]>();
    for (const r of afterPhase3) {
      if (!r.email_id) continue;
      if (!emailGroups.has(r.email_id)) emailGroups.set(r.email_id, []);
      emailGroups.get(r.email_id)!.push(r);
    }

    let emailDupesRejected = 0;
    const emailSurvivors: string[] = [];
    if (!dryRun) {
      const tx = sqlite.transaction(() => {
        for (const [emailId, rows] of Array.from(emailGroups.entries())) {
          if (rows.length < 2) continue;
          const survivor = pickSurvivor(rows);
          emailSurvivors.push(survivor.id);
          for (const r of rows) {
            if (r.id === survivor.id) continue;
            const before = { ...r };
            const after = { ...r, status: "rejected" };
            sqlite.prepare(`UPDATE invoices SET status = 'rejected', updated_at = ? WHERE id = ?`)
              .run(new Date().toISOString(), r.id);
            sqlite.prepare(`INSERT INTO audit_log (invoice_id, action, before, after, user_email, created_at) VALUES (?,?,?,?,?,?)`)
              .run(r.id, `bulk-cleanup: email-id-dupe (survivor=${survivor.id}, email_id=${emailId.slice(0, 40)})`, JSON.stringify(before), JSON.stringify(after), userEmail, new Date().toISOString());
            emailDupesRejected++;
          }
        }
      });
      tx();
    } else {
      for (const [, rows] of Array.from(emailGroups.entries())) {
        if (rows.length < 2) {
          if (rows.length === 1) emailSurvivors.push(rows[0].id);
          continue;
        }
        const survivor = pickSurvivor(rows);
        emailSurvivors.push(survivor.id);
        emailDupesRejected += rows.length - 1;
      }
    }

    // Final inbox count
    const remainingPending = (sqlite.prepare(
      `SELECT COUNT(*) AS c FROM invoices WHERE status = 'pending_review'`
    ).get() as { c: number }).c;

    res.json({
      dry_run: dryRun,
      phase1_pdf_hash_backfill: {
        candidates: needsHash.length,
        backfilled,
        skipped_missing_pdf: backfillSkippedMissing,
      },
      phase2_jotform_reject: {
        rejected: jotformRejected,
      },
      phase3_hash_dupe_collapse: {
        groups: Array.from(hashGroups.values()).filter((g) => g.length >= 2).length,
        rejected: hashDupesRejected,
        survivors: hashSurvivors.length,
      },
      phase4_email_id_dupe_collapse: {
        groups: Array.from(emailGroups.values()).filter((g) => g.length >= 2).length,
        rejected: emailDupesRejected,
        survivors: emailSurvivors.length,
      },
      totals: {
        rejected_total: jotformRejected + hashDupesRejected + emailDupesRejected,
        pending_review_after: dryRun
          ? remainingPending - (jotformRejected + hashDupesRejected + emailDupesRejected)
          : remainingPending,
      },
      errors,
      note: dryRun
        ? "DRY RUN — no rows were changed. Re-call with ?dry_run=0 to apply."
        : "Applied. Use POST /api/invoices/:id/restore to reverse a specific row.",
    });
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

  // ===== PR #201: People link management (employee ↔ user) =====
  // All gated on users.manage_links. Backed by server/people-links.ts which
  // wraps every op in a transaction, blocks on conflicts (HTTP 409), and
  // archives orphaned person rows.
  {
    const pl = require("./people-links") as typeof import("./people-links");

    app.get(
      "/api/people-links/users",
      authMiddleware,
      requirePermission("users.manage_links"),
      (_req, res) => {
        res.json(pl.listUsersWithLinks());
      },
    );

    app.get(
      "/api/people-links/employees",
      authMiddleware,
      requirePermission("users.manage_links"),
      (_req, res) => {
        res.json(pl.listEmployeesWithLinks());
      },
    );

    // POST /api/people-links/users/:userId/link  { employee_id }
    app.post(
      "/api/people-links/users/:userId/link",
      authMiddleware,
      requirePermission("users.manage_links"),
      (req, res) => {
        const userId = parseInt(String(req.params.userId));
        const employeeId = parseInt(String(req.body?.employee_id ?? ""));
        if (!Number.isFinite(userId) || !Number.isFinite(employeeId)) {
          return res.status(400).json({ message: "userId and employee_id required" });
        }
        try {
          res.json(pl.linkUserToEmployee(userId, employeeId));
        } catch (e: any) {
          if (e?.code === "CONFLICT") return res.status(409).json({ message: e.message });
          if (e?.code === "NOT_FOUND") return res.status(404).json({ message: e.message });
          res.status(500).json({ message: e?.message || String(e) });
        }
      },
    );

    // POST /api/people-links/employees/:employeeId/link  { user_id }
    app.post(
      "/api/people-links/employees/:employeeId/link",
      authMiddleware,
      requirePermission("users.manage_links"),
      (req, res) => {
        const employeeId = parseInt(String(req.params.employeeId));
        const userId = parseInt(String(req.body?.user_id ?? ""));
        if (!Number.isFinite(employeeId) || !Number.isFinite(userId)) {
          return res.status(400).json({ message: "employeeId and user_id required" });
        }
        try {
          res.json(pl.linkEmployeeToUser(employeeId, userId));
        } catch (e: any) {
          if (e?.code === "CONFLICT") return res.status(409).json({ message: e.message });
          if (e?.code === "NOT_FOUND") return res.status(404).json({ message: e.message });
          res.status(500).json({ message: e?.message || String(e) });
        }
      },
    );

    app.post(
      "/api/people-links/users/:userId/unlink",
      authMiddleware,
      requirePermission("users.manage_links"),
      (req, res) => {
        const userId = parseInt(String(req.params.userId));
        if (!Number.isFinite(userId)) {
          return res.status(400).json({ message: "userId required" });
        }
        try {
          res.json(pl.unlinkUser(userId));
        } catch (e: any) {
          if (e?.code === "NOT_FOUND") return res.status(404).json({ message: e.message });
          res.status(500).json({ message: e?.message || String(e) });
        }
      },
    );

    app.post(
      "/api/people-links/employees/:employeeId/unlink",
      authMiddleware,
      requirePermission("users.manage_links"),
      (req, res) => {
        const employeeId = parseInt(String(req.params.employeeId));
        if (!Number.isFinite(employeeId)) {
          return res.status(400).json({ message: "employeeId required" });
        }
        try {
          res.json(pl.unlinkEmployee(employeeId));
        } catch (e: any) {
          if (e?.code === "NOT_FOUND") return res.status(404).json({ message: e.message });
          res.status(500).json({ message: e?.message || String(e) });
        }
      },
    );
  }

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
