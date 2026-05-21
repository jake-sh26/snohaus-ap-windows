/**
 * Shopify OAuth install flow (PR #R2e).
 *
 * Implements the standard Shopify OAuth authorization code grant for the
 * Reconciler app. This is the modern, supported path for non-embedded
 * backend apps that need long-lived Admin API access tokens (shpat_*).
 *
 * Flow:
 *   1. User clicks "Install app" in Shopify admin (or hits /api/auth/shopify/install).
 *   2. Shopify redirects to /api/auth/shopify/callback with ?code=...&shop=...&hmac=...
 *   3. We verify the HMAC against our SHOPIFY_API_SECRET.
 *   4. We POST the code + client_id + client_secret to /admin/oauth/access_token.
 *   5. Shopify returns {access_token, scope}.
 *   6. We store the token in recon_shopify_oauth_tokens (PR #R2e schema).
 *   7. From then on, every Admin API call uses that token.
 *
 * Why this path (and not client_credentials or token exchange):
 *   - client_credentials only works on dev stores ("shop_not_permitted" on paid)
 *   - token exchange requires App Bridge / embedded context
 *   - App Automation Tokens (atkn_*) are for Shopify CLI only, not Admin API
 *   - This OAuth flow is the only path that yields a permanent shpat_ token
 *     for a backend, non-embedded custom app installed on a paid store.
 */

import crypto from "crypto";
import type { Request, Response } from "express";
import { getShopifyReconConfig } from "./shopify-recon";
import { upsertShopifyOAuthToken, getShopifyOAuthToken, deleteShopifyOAuthToken } from "./storage";
import { recordIntegrationError, recordIntegrationWarn } from "./error-log";

function oauthError(scope: string, msg: string) {
  recordIntegrationError("shopify-oauth", scope, msg, "error");
}
function oauthWarn(scope: string, msg: string) {
  recordIntegrationWarn("shopify-oauth", scope, msg);
}

/**
 * The exact scopes the app needs. MUST match what the user configured in the
 * Dev Dashboard app version — Shopify rejects scope mismatches at the
 * /authorize step. Listed alphabetically for diff stability.
 */
const REQUIRED_SCOPES = [
  "read_all_orders",
  "read_customers",
  "read_fulfillments",
  "read_gift_cards",
  "read_inventory",
  "read_locations",
  "read_orders",
  "read_products",
  "read_shopify_payments_disputes",
  "read_shopify_payments_payouts",
].join(",");

/**
 * Verify Shopify's HMAC signature on an install callback. Shopify signs all
 * query params except `hmac` itself with the app's client secret. Returns
 * true on valid signature.
 *
 * The signature format depends on the install flow:
 *   - Legacy flow: HMAC-SHA256 of the sorted query string (without `hmac`)
 *     using the client secret as the key.
 */
export function verifyShopifyHmac(query: Record<string, any>, clientSecret: string): boolean {
  const { hmac, ...rest } = query;
  if (!hmac || typeof hmac !== "string") return false;
  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("&");
  const computed = crypto
    .createHmac("sha256", clientSecret)
    .update(message)
    .digest("hex");
  // Constant-time compare to avoid timing leaks.
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(hmac, "hex"));
  } catch {
    return false;
  }
}

/**
 * Validates that the `shop` query param is a real myshopify.com domain. Without
 * this check an attacker could pass `?shop=evil.com` to redirect the install
 * elsewhere. Shopify shop domains match `<handle>.myshopify.com` exactly.
 */
export function isValidShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
}

/**
 * GET /api/auth/shopify/install
 *
 * Optional helper endpoint that bounces the user into Shopify's authorize URL
 * for our app. The user can hit this directly (e.g. from the Test Console)
 * to start the install flow without going through Dev Dashboard.
 */
export function shopifyInstallHandler(req: Request, res: Response): void {
  const cfg = getShopifyReconConfig();
  if (!cfg) {
    res.status(400).send("Shopify reconciler not configured (missing env vars).");
    return;
  }
  if (!cfg.clientId) {
    res.status(400).send("SHOPIFY_CLIENT_ID env var is required for the OAuth install flow.");
    return;
  }
  const shop = String(req.query.shop || cfg.shopDomain || "").trim();
  if (!isValidShopDomain(shop)) {
    res.status(400).send(`Invalid shop domain: ${shop}`);
    return;
  }
  const redirectUri = `${cfg.publicBaseUrl}/api/auth/shopify/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  // We could store `state` in a short-lived cookie for CSRF protection. For an
  // internal single-user tool the HMAC check on the callback is sufficient.
  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(cfg.clientId)}` +
    `&scope=${encodeURIComponent(REQUIRED_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&grant_options[]=`; // empty = offline access token (permanent)
  res.redirect(authUrl);
}

/**
 * GET /api/auth/shopify/callback
 *
 * Shopify redirects here after the merchant clicks "Install" with:
 *   ?code=<auth_code>
 *   &hmac=<signature>
 *   &shop=<shop>.myshopify.com
 *   &state=<our state>
 *   &timestamp=<unix>
 *
 * We verify the HMAC, exchange the code for an offline access token, and
 * store it in the DB. From then on the Reconciler uses that token for all
 * Admin API calls.
 */
export async function shopifyCallbackHandler(req: Request, res: Response): Promise<void> {
  const cfg = getShopifyReconConfig();
  if (!cfg) {
    res.status(400).send("Shopify reconciler not configured.");
    return;
  }
  if (!cfg.clientId) {
    res.status(400).send("SHOPIFY_CLIENT_ID env var is required.");
    return;
  }

  // Extract + sanitize.
  const code = String(req.query.code || "").trim();
  const shop = String(req.query.shop || "").trim();
  const hmac = String(req.query.hmac || "").trim();

  if (!code) {
    oauthWarn("callback", `Callback hit without ?code= param. Query: ${JSON.stringify(req.query)}`);
    res.status(400).send(
      "<h1>Shopify install incomplete</h1>" +
      "<p>The callback didn't include an authorization code. " +
      "This usually means the app version doesn't have 'Use legacy install flow' enabled. " +
      "Check Dev Dashboard → Versions → New version → enable 'Use legacy install flow' → Release → re-install.</p>"
    );
    return;
  }
  if (!isValidShopDomain(shop)) {
    oauthError("callback", `Invalid shop domain in callback: ${shop}`);
    res.status(400).send("Invalid shop domain.");
    return;
  }
  if (!hmac || !verifyShopifyHmac(req.query as any, cfg.apiSecret)) {
    oauthError("callback", `HMAC verification failed for shop ${shop}`);
    res.status(401).send("HMAC verification failed.");
    return;
  }

  // Exchange the code for an offline access token.
  const tokenUrl = `https://${shop}/admin/oauth/access_token`;
  let tokenRes: Response;
  let tokenBody: any;
  try {
    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.apiSecret,
        code,
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      oauthError("callback", `Token exchange failed: ${r.status} ${text.slice(0, 400)}`);
      res.status(502).send(`<h1>Token exchange failed</h1><pre>${r.status}: ${escapeHtml(text)}</pre>`);
      return;
    }
    try { tokenBody = JSON.parse(text); } catch {
      oauthError("callback", `Token exchange: malformed JSON: ${text.slice(0, 200)}`);
      res.status(502).send("Token exchange returned non-JSON.");
      return;
    }
  } catch (e: any) {
    oauthError("callback", `Token exchange network failure: ${e?.message ?? e}`);
    res.status(502).send(`Token exchange network failure: ${escapeHtml(String(e?.message ?? e))}`);
    return;
  }

  const accessToken: string = tokenBody?.access_token;
  const scope: string = String(tokenBody?.scope || "");
  if (!accessToken) {
    oauthError("callback", "Token exchange response missing access_token");
    res.status(502).send("Shopify response missing access_token.");
    return;
  }

  // Persist. The user identity comes from the existing AP-app session cookie
  // (if present) — we don't enforce it here because Shopify's HMAC already
  // authenticates the request.
  const installedBy = (req as any).user?.email || "shopify_oauth";
  upsertShopifyOAuthToken(shop, accessToken, scope, installedBy);

  // Friendly landing page. Avoid redirecting to a deep app URL since the
  // server isn't necessarily authenticated as a logged-in AP user here.
  res.send(
    `<!doctype html><html><head><title>Sno-Haus Reconciler installed</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:24px;}h1{color:#0a7a30}</style>` +
    `</head><body>` +
    `<h1>\u2713 Shopify app installed</h1>` +
    `<p>Successfully connected <code>${escapeHtml(shop)}</code> to the Sno-Haus Reconciler.</p>` +
    `<p>Token prefix: <code>${escapeHtml(accessToken.slice(0, 12))}\u2026</code></p>` +
    `<p>Granted scopes: <code>${escapeHtml(scope)}</code></p>` +
    `<p>You can close this window. Head back to the <a href="/reconciler/test">Test Console</a> and click <b>Ping Shopify</b>.</p>` +
    `</body></html>`
  );
}

/**
 * DELETE /api/auth/shopify/token
 * Removes the stored token. Used when re-authing after rotating the client
 * secret or revoking the install.
 */
export function shopifyDeleteTokenHandler(req: Request, res: Response): void {
  const cfg = getShopifyReconConfig();
  if (!cfg) { res.status(400).json({ ok: false, error: "Not configured", deleted: false }); return; }
  const existed = !!getShopifyOAuthToken(cfg.shopDomain);
  deleteShopifyOAuthToken(cfg.shopDomain);
  res.json({ ok: true, deleted: existed });
}

/**
 * GET /api/auth/shopify/install-url
 * Returns the URL the user should open to start the install flow. Used by the
 * Test Console "Install via OAuth" button.
 */
export function shopifyInstallUrlHandler(req: Request, res: Response): void {
  const cfg = getShopifyReconConfig();
  if (!cfg) { res.status(400).json({ ok: false, error: "Not configured" }); return; }
  if (!cfg.clientId) { res.status(400).json({ ok: false, error: "SHOPIFY_CLIENT_ID required" }); return; }
  const redirectUri = `${cfg.publicBaseUrl}/api/auth/shopify/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl =
    `https://${cfg.shopDomain}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(cfg.clientId)}` +
    `&scope=${encodeURIComponent(REQUIRED_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&grant_options[]=`;
  res.json({ ok: true, url: authUrl, scopes: REQUIRED_SCOPES });
}

/**
 * GET /api/auth/shopify/installed-status
 * Quick check of whether we have a stored token for the configured shop.
 * Used by the Test Console to show install state.
 */
export function shopifyInstalledStatusHandler(_req: Request, res: Response): void {
  const cfg = getShopifyReconConfig();
  if (!cfg) {
    res.json({ installed: false, shopDomain: null, scopes: null, installedAt: null, lastUsedAt: null, reason: "not_configured" });
    return;
  }
  const tok = getShopifyOAuthToken(cfg.shopDomain);
  if (!tok) {
    res.json({ installed: false, shopDomain: cfg.shopDomain, scopes: null, installedAt: null, lastUsedAt: null, reason: "no_token" });
    return;
  }
  // Scope is stored as comma-separated string from Shopify; expose as array for the UI.
  const scopes = typeof tok.scope === "string" && tok.scope.length > 0
    ? tok.scope.split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0)
    : null;
  res.json({
    installed: true,
    shopDomain: tok.shop_domain,
    scopes,
    installedAt: tok.installed_at,
    lastUsedAt: tok.last_used_at,
    // Diagnostics (kept for backwards-compat with any curl-based checks).
    tokenPrefix: tok.access_token.slice(0, 12) + "…",
    tokenLength: tok.access_token.length,
    installedBy: tok.installed_by,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
