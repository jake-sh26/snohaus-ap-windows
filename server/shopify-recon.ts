/**
 * Shopify Admin API client for the multi-entity reconciler (PR #R2).
 *
 * SEPARATE from the existing Pipedream-brokered Shopify connection used by
 * the payroll module (PR #6, table `payroll_shopify_*`). That path pulls
 * staff sales for commissions. This one pulls the full order/payout dataset
 * used for per-entity revenue + sales-tax reconciliation, hence the direct
 * Admin API.
 *
 * Auth: Shopify "app automation token" (modern replacement for legacy
 * custom-app `shpat_*` tokens — those were deprecated Jan 1, 2026).
 *
 * Env vars (no-op when any required ones are missing):
 *   SHOPIFY_SHOP_DOMAIN       e.g. sundown-ski-patio-greenvale.myshopify.com
 *   SHOPIFY_CLIENT_ID         App Client ID — used to mint Admin API tokens via
 *                             the OAuth 2.0 client_credentials grant. This is
 *                             the recommended path for server-to-server work
 *                             post-Jan-2026 (shpat_ tokens minted this way
 *                             expire after 24h, so we cache + auto-refresh).
 *   SHOPIFY_API_SECRET        Client Secret — used both for client_credentials
 *                             token minting AND for webhook HMAC verification.
 *   SHOPIFY_API_VERSION       e.g. 2026-04
 *   SHOPIFY_PUBLIC_BASE_URL   public ngrok/edge URL used for webhook callbacks
 *
 *   SHOPIFY_ADMIN_TOKEN       (optional override) skip client_credentials and
 *                             use a static token. Auto-detected by prefix:
 *                             - atkn_*  → `Authorization: Bearer <token>`
 *                             - other   → `X-Shopify-Access-Token: <token>`
 *                             Mostly useful for testing with a hand-minted token.
 */

import { recordIntegrationError, recordIntegrationWarn, getIntegrationErrorLog, clearIntegrationErrorLog } from "./error-log";

function shopifyError(scope: string, msg: string) { recordIntegrationError("shopify-recon", scope, msg, "error"); }
function shopifyWarn(scope: string, msg: string) { recordIntegrationWarn("shopify-recon", scope, msg); }
export function getShopifyReconErrorLog(limit = 20) { return getIntegrationErrorLog("shopify-recon", limit); }
export function clearShopifyReconErrorLog() { clearIntegrationErrorLog("shopify-recon"); }

export type ShopifyReconConfig = {
  shopDomain: string;
  // EITHER clientId is set (preferred — we'll mint shpat_ tokens via OAuth)
  // OR adminToken is set (manual override path).
  clientId: string | null;
  adminToken: string | null;
  apiSecret: string;
  apiVersion: string;
  publicBaseUrl: string;
};

/**
 * Returns the env config or null when REQUIRED vars are missing. Required:
 *   - SHOPIFY_SHOP_DOMAIN, SHOPIFY_API_SECRET, SHOPIFY_API_VERSION,
 *     SHOPIFY_PUBLIC_BASE_URL
 *   - AT LEAST ONE of (SHOPIFY_CLIENT_ID, SHOPIFY_ADMIN_TOKEN)
 *
 * Callers MUST gracefully no-op on null — the module must not throw at boot in
 * unconfigured environments (mirrors the acumatica.ts / gmail.ts pattern).
 */
export function getShopifyReconConfig(): ShopifyReconConfig | null {
  const shopDomain = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
  const clientId = (process.env.SHOPIFY_CLIENT_ID || "").trim() || null;
  const adminToken = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim() || null;
  const apiSecret = (process.env.SHOPIFY_API_SECRET || "").trim();
  const apiVersion = (process.env.SHOPIFY_API_VERSION || "").trim();
  const publicBaseUrl = (process.env.SHOPIFY_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!shopDomain || !apiSecret || !apiVersion || !publicBaseUrl) return null;
  if (!clientId && !adminToken) return null;
  return { shopDomain, clientId, adminToken, apiSecret, apiVersion, publicBaseUrl };
}

export function isShopifyReconConfigured(): boolean {
  return getShopifyReconConfig() !== null;
}

/**
 * Surface-level status used by the Settings UI tile. Never throws — only
 * inspects env. Detailed connectivity check (ping) lives in pingShopify().
 */
export function getShopifyReconStatus(): {
  configured: boolean;
  shopDomain: string | null;
  apiVersion: string | null;
  publicBaseUrl: string | null;
  authMode: "client_credentials" | "static_token" | "none";
  tokenStatus: { hasToken: boolean; expiresAt: string | null; expiresInSec: number | null };
  missing: string[];
} {
  const missing: string[] = [];
  if (!process.env.SHOPIFY_SHOP_DOMAIN) missing.push("SHOPIFY_SHOP_DOMAIN");
  // Either CLIENT_ID or ADMIN_TOKEN must be present.
  if (!process.env.SHOPIFY_CLIENT_ID && !process.env.SHOPIFY_ADMIN_TOKEN) {
    missing.push("SHOPIFY_CLIENT_ID (or SHOPIFY_ADMIN_TOKEN)");
  }
  if (!process.env.SHOPIFY_API_SECRET) missing.push("SHOPIFY_API_SECRET");
  if (!process.env.SHOPIFY_API_VERSION) missing.push("SHOPIFY_API_VERSION");
  if (!process.env.SHOPIFY_PUBLIC_BASE_URL) missing.push("SHOPIFY_PUBLIC_BASE_URL");
  const hasClientId = !!(process.env.SHOPIFY_CLIENT_ID || "").trim();
  const hasAdminToken = !!(process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
  const authMode: "client_credentials" | "static_token" | "none" =
    hasClientId ? "client_credentials" : hasAdminToken ? "static_token" : "none";
  const now = Date.now();
  const tokenStatus = tokenCache && tokenCache.expiresAt > now
    ? {
        hasToken: true,
        expiresAt: new Date(tokenCache.expiresAt).toISOString(),
        expiresInSec: Math.max(0, Math.floor((tokenCache.expiresAt - now) / 1000)),
      }
    : { hasToken: false, expiresAt: null, expiresInSec: null };
  return {
    configured: missing.length === 0,
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || null,
    apiVersion: process.env.SHOPIFY_API_VERSION || null,
    publicBaseUrl: process.env.SHOPIFY_PUBLIC_BASE_URL || null,
    authMode,
    tokenStatus,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Token manager — client_credentials flow.
//
// When SHOPIFY_CLIENT_ID is set, we mint a short-lived Admin API access token
// by POSTing to /admin/oauth/access_token with grant_type=client_credentials.
// Shopify returns { access_token: "shpat_...", scope, expires_in }. We cache
// the token in-memory and refresh ~60s before expiry. Refresh is lazy — the
// next REST call after expiry mints a new one, so no background timer needed.
//
// When SHOPIFY_ADMIN_TOKEN is set instead (no client_id), we just use that
// token verbatim — useful for testing with a hand-minted token. atkn_*
// prefixed tokens use Bearer auth, everything else uses X-Shopify-Access-Token.
// ---------------------------------------------------------------------------

type TokenCache = { token: string; expiresAt: number; scope: string };
let tokenCache: TokenCache | null = null;

/**
 * Returns a valid shpat_ access token, minting one via client_credentials if
 * needed. Cached in-process and reused until ~60s before expiry. Throws on
 * config or HTTP failure (caller surfaces via the error log).
 *
 * Exported for the test console — clears + re-mints to verify creds.
 */
export async function getShopifyAccessToken(cfg: ShopifyReconConfig, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  // Static token override path — no minting, just return what was configured.
  if (!cfg.clientId && cfg.adminToken) return cfg.adminToken;
  if (!cfg.clientId) throw new Error("Shopify client_credentials not configured (missing SHOPIFY_CLIENT_ID)");

  const now = Date.now();
  if (!opts.forceRefresh && tokenCache && tokenCache.expiresAt > now + 5_000) {
    return tokenCache.token;
  }

  const url = `https://${cfg.shopDomain}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.apiSecret,
  }).toString();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body,
    });
  } catch (e: any) {
    shopifyError("oauth", `client_credentials network failure: ${e?.message ?? e}`);
    throw e;
  }

  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 400);
    shopifyError("oauth", `client_credentials -> ${res.status}: ${snippet}`);
    throw new Error(`Shopify client_credentials failed: ${res.status} ${snippet}`);
  }

  let parsed: any;
  try { parsed = JSON.parse(text); } catch {
    shopifyError("oauth", `client_credentials: malformed JSON response: ${text.slice(0, 200)}`);
    throw new Error("Shopify client_credentials: malformed JSON response");
  }

  const accessToken: string = parsed?.access_token;
  const expiresIn: number = Number(parsed?.expires_in) || 0;
  const scope: string = String(parsed?.scope || "");
  if (!accessToken || !expiresIn) {
    shopifyError("oauth", `client_credentials: missing access_token or expires_in in response`);
    throw new Error("Shopify client_credentials: missing access_token or expires_in");
  }

  // Refresh 60s before actual expiry so an in-flight call never gets a 401
  // from a token that expired mid-request.
  tokenCache = {
    token: accessToken,
    expiresAt: now + Math.max(60_000, (expiresIn - 60) * 1000),
    scope,
  };
  return accessToken;
}

/**
 * Clears the in-memory token cache. Exposed for the test console so the user
 * can force a fresh mint without restarting the server.
 */
export function clearShopifyTokenCache(): void { tokenCache = null; }

// ---------------------------------------------------------------------------
// REST helpers (orders + payouts use the REST Admin API — its pagination via
// Link headers is much friendlier than GraphQL cursors for our incremental
// `updated_at_min` pull pattern, and tax_lines structure matches our schema
// one-to-one).
// ---------------------------------------------------------------------------

type RestResponse = {
  status: number;
  json: any;
  linkHeader: string | null;
  retryAfter: number | null;
};

/**
 * Low-level Shopify REST call with:
 *   - automatic 429 retry honouring Retry-After header (Shopify's leaky-bucket)
 *   - automatic 5xx retry with capped exponential backoff (3 attempts)
 *   - throws on permanent failure so the sync log records the error
 *
 * Returns the parsed body, status, and Link header (used for cursor pagination).
 */
export async function shopifyRestCall(
  cfg: ShopifyReconConfig,
  pathOrUrl: string,
  init: { method?: string; query?: Record<string, string | number | undefined>; body?: any } = {},
): Promise<RestResponse> {
  const method = init.method || "GET";
  // Allow callers to pass an absolute URL straight from a Link header.
  let url: string;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    url = pathOrUrl;
  } else {
    const base = `https://${cfg.shopDomain}/admin/api/${cfg.apiVersion}`;
    const q = init.query
      ? "?" + Object.entries(init.query)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    url = `${base}${pathOrUrl.startsWith("/") ? pathOrUrl : "/" + pathOrUrl}${q}`;
  }

  let attempt = 0;
  // 3 tries total for transient failures.
  while (true) {
    attempt++;
    let res: Response;
    try {
      // Get a valid token. When SHOPIFY_CLIENT_ID is configured this mints
      // (or returns a cached) shpat_ token via client_credentials. When
      // SHOPIFY_ADMIN_TOKEN is configured instead it just returns that.
      const accessToken = await getShopifyAccessToken(cfg);
      // atkn_* tokens (the new "access token" format) require Bearer auth.
      // shpat_* tokens (what client_credentials returns) use the legacy
      // X-Shopify-Access-Token header. Anything else we default to the
      // header form for backward-compat.
      const authHeaders: Record<string, string> = accessToken.startsWith("atkn_")
        ? { "Authorization": `Bearer ${accessToken}` }
        : { "X-Shopify-Access-Token": accessToken };
      res = await fetch(url, {
        method,
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (e: any) {
      if (attempt >= 3) {
        shopifyError("rest", `${method} ${url} network failure: ${e?.message ?? e}`);
        throw e;
      }
      await sleep(500 * attempt);
      continue;
    }

    const retryAfter = res.headers.get("Retry-After");
    const linkHeader = res.headers.get("Link");

    // 429: rate limit. Honour Retry-After (Shopify gives seconds) and retry indefinitely
    // for up to 5 attempts before bailing — this is a normal part of bulk ingest.
    if (res.status === 429 && attempt < 5) {
      const waitMs = Math.max(500, Math.ceil((Number(retryAfter) || 2) * 1000));
      shopifyWarn("rest", `429 from ${url} — sleeping ${waitMs}ms (attempt ${attempt})`);
      await sleep(waitMs);
      continue;
    }

    // 5xx: transient — retry up to 3 attempts with capped backoff.
    if (res.status >= 500 && res.status < 600 && attempt < 3) {
      const waitMs = 500 * attempt;
      shopifyWarn("rest", `${res.status} from ${url} — retrying in ${waitMs}ms (attempt ${attempt})`);
      await sleep(waitMs);
      continue;
    }

    let body: any = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = { _raw: text }; }
    }

    if (!res.ok) {
      const snippet = text.slice(0, 400);
      shopifyError("rest", `${method} ${url} -> ${res.status}: ${snippet}`);
      throw new Error(`Shopify ${method} ${pathOrUrl} failed: ${res.status} ${snippet}`);
    }

    return {
      status: res.status,
      json: body,
      linkHeader,
      retryAfter: retryAfter ? Number(retryAfter) : null,
    };
  }
}

/**
 * Extracts the `rel="next"` URL from a Shopify Link header. Returns null when
 * there are no more pages. Format: `<...page_info=xyz>; rel="next", <...>; rel="previous"`.
 */
export function parseNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const p of parts) {
    const m = p.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Sanity check the credentials by hitting /shop.json. Returns the shop name
 * on success, throws on failure. Used by the Settings UI ping button and
 * by the boot-time self-test.
 */
export async function pingShopify(): Promise<{
  ok: boolean;
  shopName: string | null;
  myshopifyDomain: string | null;
  primaryLocationId: string | null;
  error?: string;
}> {
  const cfg = getShopifyReconConfig();
  if (!cfg) return { ok: false, shopName: null, myshopifyDomain: null, primaryLocationId: null, error: "Shopify reconciler not configured" };
  try {
    const r = await shopifyRestCall(cfg, "/shop.json");
    const shop = r.json?.shop || {};
    return {
      ok: true,
      shopName: shop.name ?? null,
      myshopifyDomain: shop.myshopify_domain ?? null,
      primaryLocationId: shop.primary_location_id != null ? String(shop.primary_location_id) : null,
    };
  } catch (e: any) {
    return { ok: false, shopName: null, myshopifyDomain: null, primaryLocationId: null, error: e?.message ?? String(e) };
  }
}

/**
 * Lists all active Shopify locations. Used by the Settings UI to populate the
 * dropdown next to each legal entity ↔ POS mapping row (the user picks which
 * Shopify location belongs to which entity).
 */
export async function listShopifyLocations(): Promise<Array<{
  id: string;
  name: string;
  active: boolean;
  legacy: boolean;
}>> {
  const cfg = getShopifyReconConfig();
  if (!cfg) return [];
  const r = await shopifyRestCall(cfg, "/locations.json");
  const locs = (r.json?.locations || []) as any[];
  return locs.map(l => ({
    id: String(l.id),
    name: String(l.name ?? ""),
    active: Boolean(l.active),
    legacy: Boolean(l.legacy),
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
