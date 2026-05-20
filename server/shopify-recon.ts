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
 * Env vars (no-op when any are missing):
 *   SHOPIFY_SHOP_DOMAIN       e.g. sundown-ski-patio-greenvale.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN       app automation token (header X-Shopify-Access-Token)
 *   SHOPIFY_API_SECRET        client secret — used for webhook HMAC verification
 *   SHOPIFY_API_VERSION       e.g. 2026-04
 *   SHOPIFY_PUBLIC_BASE_URL   public ngrok/edge URL used for webhook callbacks
 */

import { recordIntegrationError, recordIntegrationWarn, getIntegrationErrorLog, clearIntegrationErrorLog } from "./error-log";

function shopifyError(scope: string, msg: string) { recordIntegrationError("shopify-recon", scope, msg, "error"); }
function shopifyWarn(scope: string, msg: string) { recordIntegrationWarn("shopify-recon", scope, msg); }
export function getShopifyReconErrorLog(limit = 20) { return getIntegrationErrorLog("shopify-recon", limit); }
export function clearShopifyReconErrorLog() { clearIntegrationErrorLog("shopify-recon"); }

export type ShopifyReconConfig = {
  shopDomain: string;
  adminToken: string;
  apiSecret: string;
  apiVersion: string;
  publicBaseUrl: string;
};

/**
 * Returns the env config or null when ANY required var is missing. Callers
 * MUST gracefully no-op on null — the module must not throw at boot in
 * unconfigured environments (mirrors the acumatica.ts / gmail.ts pattern).
 */
export function getShopifyReconConfig(): ShopifyReconConfig | null {
  const shopDomain = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
  const adminToken = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
  const apiSecret = (process.env.SHOPIFY_API_SECRET || "").trim();
  const apiVersion = (process.env.SHOPIFY_API_VERSION || "").trim();
  const publicBaseUrl = (process.env.SHOPIFY_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!shopDomain || !adminToken || !apiSecret || !apiVersion || !publicBaseUrl) return null;
  return { shopDomain, adminToken, apiSecret, apiVersion, publicBaseUrl };
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
  missing: string[];
} {
  const missing: string[] = [];
  if (!process.env.SHOPIFY_SHOP_DOMAIN) missing.push("SHOPIFY_SHOP_DOMAIN");
  if (!process.env.SHOPIFY_ADMIN_TOKEN) missing.push("SHOPIFY_ADMIN_TOKEN");
  if (!process.env.SHOPIFY_API_SECRET) missing.push("SHOPIFY_API_SECRET");
  if (!process.env.SHOPIFY_API_VERSION) missing.push("SHOPIFY_API_VERSION");
  if (!process.env.SHOPIFY_PUBLIC_BASE_URL) missing.push("SHOPIFY_PUBLIC_BASE_URL");
  return {
    configured: missing.length === 0,
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || null,
    apiVersion: process.env.SHOPIFY_API_VERSION || null,
    publicBaseUrl: process.env.SHOPIFY_PUBLIC_BASE_URL || null,
    missing,
  };
}

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
      res = await fetch(url, {
        method,
        headers: {
          "X-Shopify-Access-Token": cfg.adminToken,
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
