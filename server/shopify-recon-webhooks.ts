/**
 * Shopify webhook handling for the reconciler (PR #R2).
 *
 * Topics subscribed:
 *   - orders/create      → upsert into recon_orders + line items
 *   - orders/updated     → same (handles edits, partial refunds, financial status)
 *   - orders/cancelled   → same (Shopify still sends the full payload)
 *
 * Verification: HMAC-SHA256 of the raw request body using SHOPIFY_API_SECRET,
 * compared to the X-Shopify-Hmac-Sha256 header (base64). Constant-time compare.
 *
 * We rely on `req.rawBody` being captured by the global express.json verify
 * hook in server/index.ts (already in place since the Stripe-style webhook
 * pattern was added). DO NOT change to `req.body` — JSON.stringify(req.body)
 * is NOT byte-identical to the original and HMAC will fail.
 *
 * Idempotency: `upsertOrderFromShopify` is itself idempotent (upsert + line
 * delete-then-insert). Replaying the same webhook produces no duplicates and
 * just bumps `ingest_version` — useful for testing.
 */

import crypto from "node:crypto";
import type { Request, Response } from "express";
import { getShopifyReconConfig, shopifyRestCall } from "./shopify-recon";
import { upsertOrderFromShopify } from "./shopify-recon-orders";
import { ingestAgreementsForOrder } from "./shopify-recon-agreements";
import { startReconSync, finishReconSync } from "./storage";
import { recordIntegrationError, recordIntegrationWarn } from "./error-log";

function whError(scope: string, msg: string) { recordIntegrationError("shopify-recon", scope, msg, "error"); }
function whWarn(scope: string, msg: string) { recordIntegrationWarn("shopify-recon", scope, msg); }

// Topics we care about (kept as an exported const so the registration code
// and the handler stay in lockstep).
// R5b added orders/edited + refunds/create so the agreements ledger
// (recon_shopify_sales) stays current inside a live month without waiting
// for the hourly safety-net cron. The cron uses scope=missing which skips
// orders that already have any rows, so edits/refunds on previously
// ingested orders fall through the gap.
export const SHOPIFY_RECON_WEBHOOK_TOPICS = [
  "orders/create",
  "orders/updated",
  "orders/cancelled",
  "orders/edited",
  "refunds/create",
] as const;
export type ShopifyReconWebhookTopic = typeof SHOPIFY_RECON_WEBHOOK_TOPICS[number];

/**
 * Verify the HMAC signature on an inbound webhook. Returns true when valid.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyShopifyHmac(rawBody: Buffer | string, headerHmac: string | null, secret: string): boolean {
  if (!headerHmac) return false;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const computed = crypto.createHmac("sha256", secret).update(body).digest("base64");
  // Both must be same length for timingSafeEqual; bail otherwise.
  if (computed.length !== headerHmac.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(headerHmac));
  } catch {
    return false;
  }
}

/**
 * Express handler for POST /api/recon/webhooks/shopify.
 * MUST be mounted such that req.rawBody is the raw request bytes — see module
 * docstring above.
 */
export async function handleShopifyWebhook(req: Request, res: Response): Promise<void> {
  const cfg = getShopifyReconConfig();
  if (!cfg) {
    // 503 not 500 — config issue, not crash. Shopify will retry.
    res.status(503).json({ message: "Shopify reconciler not configured" });
    return;
  }

  const topic = String(req.header("X-Shopify-Topic") || "");
  const hmac = req.header("X-Shopify-Hmac-Sha256") || null;
  const shopDomain = String(req.header("X-Shopify-Shop-Domain") || "");
  const webhookId = String(req.header("X-Shopify-Webhook-Id") || "");

  // Raw body captured by express.json({ verify }). Cast through unknown for type safety.
  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody) {
    whError("webhook", `no rawBody on webhook ${topic} id=${webhookId}`);
    res.status(400).json({ message: "Missing raw body" });
    return;
  }

  if (!verifyShopifyHmac(rawBody, hmac, cfg.apiSecret)) {
    whWarn("webhook", `HMAC mismatch topic=${topic} shop=${shopDomain} webhookId=${webhookId}`);
    res.status(401).json({ message: "HMAC mismatch" });
    return;
  }

  // Defensive: confirm shop domain matches our configured shop.
  if (shopDomain && shopDomain.toLowerCase() !== cfg.shopDomain.toLowerCase()) {
    whWarn("webhook", `shop mismatch header=${shopDomain} configured=${cfg.shopDomain}`);
    res.status(401).json({ message: "Shop mismatch" });
    return;
  }

  // Acknowledge BEFORE processing for slow paths? Shopify gives us 5s to ACK.
  // Our upsert is fast (~5ms) so we process inline. If we ever block, switch
  // to queuing into a table and returning 200 immediately.
  let body: any = null;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch (e: any) {
    whError("webhook", `JSON parse failed topic=${topic}: ${e?.message ?? e}`);
    res.status(400).json({ message: "Invalid JSON" });
    return;
  }

  // Log every webhook to the sync log for testing visibility.
  const logId = startReconSync(`webhook:${topic}`, `shopify:${webhookId || "unknown"}`, null);

  // R5b: fire-and-forget agreements re-ingest for a given order id. Best
  // effort — never throws to the webhook handler. Shopify gives us 5s to
  // ACK and we already finished the synchronous DB upsert; this kicks the
  // GraphQL agreements pull on the next tick so the response goes back
  // promptly. Errors land in the integration error log instead of 500'ing
  // the webhook (Shopify retries on 5xx, which would loop endlessly on a
  // transient GraphQL failure).
  const reingestAgreements = (orderId: string, scope: string) => {
    setImmediate(async () => {
      try {
        await ingestAgreementsForOrder(cfg, orderId);
      } catch (e: any) {
        whWarn(
          "webhook-agreements-reingest",
          `${scope} order=${orderId} failed: ${e?.message ?? e}`,
        );
      }
    });
  };

  try {
    if (
      topic === "orders/create" ||
      topic === "orders/updated" ||
      topic === "orders/cancelled" ||
      topic === "orders/edited"
    ) {
      const { orderId, outcome, lineCount } = upsertOrderFromShopify(body);
      // R5b — re-ingest the agreements ledger for this order. Same
      // idempotent function the hourly safety-net cron uses. Fixes the
      // live-month gross/discounts/returns drift that the missing-only
      // cron can't catch (it skips orders that already have any rows).
      reingestAgreements(String(orderId), topic);
      finishReconSync(logId, {
        status: "success",
        rows_ingested: 1,
        cursor: `${topic}:${orderId}:${outcome}:lines=${lineCount}`,
      });
      res.status(200).json({ ok: true, orderId, outcome, lineCount });
      return;
    }

    // refunds/create — the payload's `order_id` is the parent order. We
    // don't upsert recon_orders here (the matching orders/updated webhook
    // handles that); we only re-ingest agreements so the new RETURN rows
    // land immediately.
    if (topic === "refunds/create") {
      const refundOrderId = body?.order_id != null ? String(body.order_id) : null;
      if (!refundOrderId) {
        whWarn("webhook", `refunds/create with no order_id (refund id=${body?.id ?? "?"})`);
        finishReconSync(logId, {
          status: "success",
          rows_ingested: 0,
          cursor: `${topic}:no_order_id`,
        });
        res.status(200).json({ ok: true, ignored: true, reason: "no order_id" });
        return;
      }
      reingestAgreements(refundOrderId, topic);
      finishReconSync(logId, {
        status: "success",
        rows_ingested: 0,
        cursor: `${topic}:${refundOrderId}:reingest_queued`,
      });
      res.status(200).json({ ok: true, orderId: refundOrderId, reingest: "queued" });
      return;
    }

    // Unhandled topic — still ACK so Shopify doesn't retry forever.
    whWarn("webhook", `unhandled topic ${topic}`);
    finishReconSync(logId, {
      status: "success",
      rows_ingested: 0,
      cursor: `${topic}:ignored`,
    });
    res.status(200).json({ ok: true, ignored: true, topic });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    whError("webhook", `processing failed topic=${topic}: ${msg}`);
    finishReconSync(logId, { status: "failure", rows_ingested: 0, error_message: msg });
    // 500 → Shopify will retry with backoff.
    res.status(500).json({ message: msg });
  }
}

// ---------------------------------------------------------------------------
// Subscription bootstrap. Reconciles our desired topic list with what's
// already subscribed and creates only the missing ones. Idempotent — safe
// to call on every boot.
// ---------------------------------------------------------------------------

export type WebhookRegistrationResult = {
  topic: ShopifyReconWebhookTopic;
  state: "kept" | "created" | "updated" | "error";
  address: string;
  webhookId: string | null;
  error?: string;
};

/**
 * Lists existing webhook subscriptions filtered by our handler address. This
 * keeps the dev workflow clean: when the ngrok URL changes, we don't pile up
 * stale subscriptions pointed at dead endpoints (we update in place).
 */
async function listOurWebhooks(handlerUrl: string): Promise<Array<{ id: string; topic: string; address: string }>> {
  const cfg = getShopifyReconConfig();
  if (!cfg) return [];
  // Pull the full list and filter client-side — there's usually <20 total.
  const r = await shopifyRestCall(cfg, "/webhooks.json", { query: { limit: 250 } });
  const hooks = (r.json?.webhooks || []) as any[];
  // Match by "starts with our base URL" so any path drift is still recognised.
  const base = handlerUrl.replace(/\/+$/, "");
  return hooks
    .filter(h => typeof h.address === "string" && h.address.startsWith(base.replace(/\/api.*/, "")))
    .map(h => ({ id: String(h.id), topic: String(h.topic), address: String(h.address) }));
}

/**
 * Ensure all desired webhook topics are subscribed and pointing at our
 * current public base URL. Returns a per-topic outcome list.
 */
export async function ensureShopifyWebhooks(): Promise<WebhookRegistrationResult[]> {
  const cfg = getShopifyReconConfig();
  if (!cfg) return [];

  const handlerUrl = `${cfg.publicBaseUrl}/api/recon/webhooks/shopify`;
  const results: WebhookRegistrationResult[] = [];

  let existing: Array<{ id: string; topic: string; address: string }> = [];
  try {
    existing = await listOurWebhooks(handlerUrl);
  } catch (e: any) {
    whError("webhook-register", `failed to list webhooks: ${e?.message ?? e}`);
    // Fall through with empty list — we'll attempt creates. Shopify will 422
    // on duplicates which we handle below.
  }

  for (const topic of SHOPIFY_RECON_WEBHOOK_TOPICS) {
    const existingForTopic = existing.find(h => h.topic === topic);
    try {
      if (existingForTopic && existingForTopic.address === handlerUrl) {
        results.push({ topic, state: "kept", address: handlerUrl, webhookId: existingForTopic.id });
        continue;
      }
      if (existingForTopic && existingForTopic.address !== handlerUrl) {
        // Address changed (likely ngrok URL rotation) — update in place.
        await shopifyRestCall(cfg, `/webhooks/${existingForTopic.id}.json`, {
          method: "PUT",
          body: { webhook: { id: Number(existingForTopic.id), address: handlerUrl } },
        });
        results.push({ topic, state: "updated", address: handlerUrl, webhookId: existingForTopic.id });
        continue;
      }
      // Create new.
      const createRes = await shopifyRestCall(cfg, "/webhooks.json", {
        method: "POST",
        body: { webhook: { topic, address: handlerUrl, format: "json" } },
      });
      const newId = createRes.json?.webhook?.id != null ? String(createRes.json.webhook.id) : null;
      results.push({ topic, state: "created", address: handlerUrl, webhookId: newId });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // Shopify returns 422 for "address has already been taken" when we race
      // ourselves on boot. Treat as kept.
      if (/already been taken/i.test(msg)) {
        results.push({ topic, state: "kept", address: handlerUrl, webhookId: existingForTopic?.id ?? null });
      } else {
        whError("webhook-register", `${topic} failed: ${msg}`);
        results.push({ topic, state: "error", address: handlerUrl, webhookId: null, error: msg });
      }
    }
  }
  return results;
}

/**
 * Delete every webhook subscription pointing at our public base URL. Used by
 * the Settings UI "reset webhooks" button. Returns the count removed.
 */
export async function deleteAllOurWebhooks(): Promise<number> {
  const cfg = getShopifyReconConfig();
  if (!cfg) return 0;
  const handlerUrl = `${cfg.publicBaseUrl}/api/recon/webhooks/shopify`;
  const existing = await listOurWebhooks(handlerUrl);
  let count = 0;
  for (const h of existing) {
    try {
      await shopifyRestCall(cfg, `/webhooks/${h.id}.json`, { method: "DELETE" });
      count++;
    } catch (e: any) {
      whWarn("webhook-register", `delete failed for ${h.id}: ${e?.message ?? e}`);
    }
  }
  return count;
}
