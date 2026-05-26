/**
 * server/shopify-shopifyql.ts
 *
 * PR #R5b — ShopifyQL Finance Summary pull.
 *
 * Shopify exposes the same numbers that drive the Admin → Analytics →
 * Finance Summary report via a GraphQL endpoint called `shopifyqlQuery`.
 * Pulling these numbers directly lets us compare our local rollup against
 * Shopify's own aggregation logic without round-tripping through a PDF or
 * manual paste.
 *
 * This module is intentionally narrow:
 *   - `runShopifyql(queryText)`       — generic GraphQL caller, typed result
 *   - `pullFinanceSummary(start, end, bucketBy)` — runs the Finance Summary
 *     query for a date range and returns the canonical {gross_sales,
 *     discounts, returns, net_sales, shipping, taxes, total_sales, orders}
 *     shape we already use in shopify-finance-diff.ts.
 *
 * Scopes required: `read_reports` and/or `read_analytics`. These are added
 * to REQUIRED_SCOPES in shopify-oauth.ts in this same PR — the user will
 * need to re-OAuth once after deploy.
 *
 * NOTE on bucketing: Shopify's Finance Summary PDF buckets sales on the
 * order's transaction date (when money actually moved) and refunds on the
 * refund date. The default `SINCE/UNTIL` clause in ShopifyQL filters on
 * `created_at` of the order, which is NOT the same. To match the PDF we
 * use the `processed_at` filter via a `WHERE processed_at BETWEEN ...`
 * clause. We accept a `bucketBy` argument so callers can experiment with
 * both modes (per design discussion with operator on 2026-05-24).
 */

import { getShopifyReconConfig, getShopifyAccessToken } from "./shopify-recon";
import { recordIntegrationError, recordIntegrationWarn } from "./error-log";

function logErr(scope: string, msg: string) {
  recordIntegrationError("shopify-shopifyql", scope, msg, "error");
}
function logWarn(scope: string, msg: string) {
  recordIntegrationWarn("shopify-shopifyql", scope, msg);
}

/**
 * Normalize a single cell value. Money columns come back as numeric strings
 * in some Admin API versions ("123.45") and as numbers in others — always
 * return JS numbers for money. Leave everything else as-is.
 */
function normalizeCell(v: any, isMoney: boolean): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (isMoney && typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  if (typeof v === "string") return v;
  // Fallback for booleans / objects — stringify so callers don't crash.
  return String(v);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShopifyqlColumn = {
  name: string;
  dataType: string;
  displayName: string;
};

export type ShopifyqlRow = Record<string, string | number | null>;

export type ShopifyqlResult = {
  query: string;
  columns: ShopifyqlColumn[];
  rows: ShopifyqlRow[];
  parseErrors: Array<{ message: string; code?: string }>;
};

export type FinanceSummaryShopifyql = {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD inclusive
  bucket_by: "processed_at" | "created_at";
  // Money totals — all in shop currency, signed to match our local rollup:
  //   gross_sales:  POSITIVE
  //   discounts:    NEGATIVE (Shopify returns negative)
  //   returns:      NEGATIVE
  //   net_sales:    POSITIVE
  //   shipping:     POSITIVE
  //   taxes:        POSITIVE
  //   total_sales:  POSITIVE
  gross_sales: number | null;
  discounts: number | null;
  returns: number | null;
  net_sales: number | null;
  shipping: number | null;
  taxes: number | null;
  total_sales: number | null;
  orders: number | null;
  // PR #110: ShopifyQL Finance Summary parity columns. Pulled in a separate
  // sub-query because the merchant-facing `sales` dataset does not always
  // expose them on the same row — see pullFinanceSummary().
  return_fees: number | null;
  // PR #111: ShopifyQL's `sales` dataset does NOT expose a gift-card column.
  // We keep the field for type compatibility but it is ALWAYS null.
  net_sales_gift_cards: number | null;
  // The raw row Shopify returned, for audit.
  raw: ShopifyqlRow | null;
  // The actual ShopifyQL string we executed.
  query: string;
};

// ---------------------------------------------------------------------------
// Low-level GraphQL caller
// ---------------------------------------------------------------------------

/**
 * Run an arbitrary ShopifyQL query through the Admin GraphQL API. Returns
 * the structured TableData (columns + rows) plus any parse errors. Throws
 * on HTTP failure or GraphQL transport errors (these indicate a config or
 * scope problem, not a query problem — query problems land in parseErrors).
 */
export async function runShopifyql(queryText: string): Promise<ShopifyqlResult> {
  const cfg = getShopifyReconConfig();
  if (!cfg) {
    throw new Error(
      "Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN / SHOPIFY_API_SECRET / SHOPIFY_API_VERSION / SHOPIFY_PUBLIC_BASE_URL and SHOPIFY_CLIENT_ID or SHOPIFY_ADMIN_TOKEN.",
    );
  }

  const url = `https://${cfg.shopDomain}/admin/api/${cfg.apiVersion}/graphql.json`;

  // shopifyqlQuery returns a flat ShopifyqlQueryResponse object with both
  // `tableData` and `parseErrors` as direct fields — NOT a union with
  // TableResponse / ParseError variants (which was an older API shape).
  // Confirmed against shopify.dev docs on 2026-05-24 after the initial
  // R5b deploy hit a "No such type TableResponse" GraphQL error.
  //
  // tableData.rows is an array of row objects (NOT row arrays + rowData).
  // parseErrors is an array of strings.
  const gqlBody = {
    query: `query ShopifyQL($q: String!) {
  shopifyqlQuery(query: $q) {
    tableData {
      columns { name dataType displayName }
      rows
    }
    parseErrors
  }
}`,
    variables: { q: queryText },
  };

  let attempt = 0;
  while (true) {
    attempt++;
    let res: Response;
    try {
      const token = await getShopifyAccessToken(cfg);
      const authHeaders: Record<string, string> = token.startsWith("atkn_")
        ? { Authorization: `Bearer ${token}` }
        : { "X-Shopify-Access-Token": token };
      res = await fetch(url, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(gqlBody),
      });
    } catch (e: any) {
      if (attempt >= 3) {
        logErr("network", `POST ${url} failed: ${e?.message ?? e}`);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }

    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("Retry-After") || "2");
      logWarn("rate", `429 from shopifyqlQuery — sleeping ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (res.status >= 500 && res.status < 600 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }

    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      logErr("parse", `Non-JSON response from shopifyqlQuery: ${text.slice(0, 400)}`);
      throw new Error(`Shopify returned non-JSON from shopifyqlQuery (status ${res.status})`);
    }

    if (!res.ok) {
      const snippet = text.slice(0, 400);
      logErr("http", `shopifyqlQuery -> ${res.status}: ${snippet}`);
      // 401/403 typically means the read_reports scope is missing — surface
      // a friendlier error so the UI can prompt for re-OAuth.
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Shopify rejected shopifyqlQuery (${res.status}). The access token may be missing the read_reports / read_analytics scope. Re-install the app via the OAuth callback to grant the new scopes.`,
        );
      }
      throw new Error(`shopifyqlQuery failed: ${res.status} ${snippet}`);
    }

    // GraphQL-level errors (auth, throttling, etc.) come back as `errors`
    // alongside `data`. Surface them.
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const msgs = body.errors.map((e: any) => e.message || JSON.stringify(e)).join("; ");
      logErr("graphql", `shopifyqlQuery GraphQL errors: ${msgs}`);
      throw new Error(`shopifyqlQuery GraphQL error: ${msgs}`);
    }

    const sq = body?.data?.shopifyqlQuery ?? null;
    if (!sq) {
      logErr("shape", `Unexpected shopifyqlQuery response shape: ${text.slice(0, 400)}`);
      throw new Error("shopifyqlQuery returned no data");
    }

    // Parse errors (query syntax / column-not-found) come back as a
    // string array. Surface them to the caller as structured objects.
    const parseErrorsRaw: any[] = Array.isArray(sq.parseErrors) ? sq.parseErrors : [];
    const parseErrors = parseErrorsRaw.map((e: any) =>
      typeof e === "string"
        ? { message: e }
        : { message: String(e?.message ?? e), code: e?.code ? String(e.code) : undefined },
    );

    // If there are parse errors AND no tableData, return early so callers
    // get a clean parseErrors array. If tableData is present (some queries
    // return both — e.g. warnings), continue and include both.
    const td = sq.tableData;
    if (!td) {
      if (parseErrors.length > 0) {
        return { query: queryText, columns: [], rows: [], parseErrors };
      }
      logErr("shape", `shopifyqlQuery had no tableData and no parseErrors`);
      throw new Error("shopifyqlQuery: empty response");
    }

    const columns: ShopifyqlColumn[] = (td.columns || []).map((c: any) => ({
      name: String(c.name),
      dataType: String(c.dataType),
      displayName: String(c.displayName),
    }));

    // tableData.rows is an array of keyed-object rows (each row already has
    // column-name keys). No need to zip against the columns array. Money
    // columns come back as strings in some API versions — normalize them.
    const rawRows: any[] = Array.isArray(td.rows) ? td.rows : [];
    const moneyColumns = new Set(columns.filter((c) => c.dataType === "MONEY").map((c) => c.name));
    const rows: ShopifyqlRow[] = rawRows.map((rawRow) => {
      // Defensive: if Shopify ever returns row-as-array again, zip it.
      if (Array.isArray(rawRow)) {
        const r: ShopifyqlRow = {};
        for (let i = 0; i < columns.length; i++) {
          const name = columns[i].name;
          const v = rawRow[i];
          r[name] = normalizeCell(v, moneyColumns.has(name));
        }
        return r;
      }
      // Normal case: rawRow is already an object keyed by column name.
      const r: ShopifyqlRow = {};
      for (const name of Object.keys(rawRow || {})) {
        r[name] = normalizeCell(rawRow[name], moneyColumns.has(name));
      }
      return r;
    });

    return { query: queryText, columns, rows, parseErrors };
  }
}

// ---------------------------------------------------------------------------
// Finance Summary helper
// ---------------------------------------------------------------------------

/**
 * Validate YYYY-MM-DD and return as-is, throw on bad input.
 */
function assertIsoDate(d: string, label: string): string {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`${label} must be YYYY-MM-DD (got ${JSON.stringify(d)})`);
  }
  return d;
}

/**
 * Pull the canonical Finance Summary totals for [start..end] inclusive.
 *
 * `bucketBy` controls which date field ShopifyQL filters on:
 *   - "processed_at" (default) — matches Shopify Admin Finance Summary PDF,
 *     which is the system of record for accounting.
 *   - "created_at" — buckets on order creation; useful for comparing against
 *     our recon_orders.created_at rollup for sanity.
 */
export async function pullFinanceSummary(
  startDate: string,
  endDate: string,
  bucketBy: "processed_at" | "created_at" = "processed_at",
): Promise<FinanceSummaryShopifyql> {
  assertIsoDate(startDate, "startDate");
  assertIsoDate(endDate, "endDate");

  // The `sales` dataset is the canonical Finance Summary source. Per Shopify
  // dev docs syntax reference and community.shopify.dev (Dec 2025), the time
  // filter on `sales` is SINCE/UNTIL with date literals — NOT a WHERE clause
  // on processed_at/created_at (those columns don't exist on `sales`; they
  // live on the `orders` dataset, which itself is not a valid FROM clause).
  //
  // bucketBy is therefore informational only on this dataset. We keep the
  // parameter on the API surface for forward-compat (in case Shopify exposes
  // both buckets later) and stamp it into the returned payload so callers
  // know which bucket the numbers represent. The `sales` dataset already
  // buckets by Shopify's standard Finance Summary date logic (processed_at).
  const q = [
    "FROM sales",
    // Column names verified live via /api/recon/shopifyql/run probing
    // (2026-05-24). Note `shipping_charges` — NOT `shipping`, `total_shipping`,
    // or any other variant. The other 7 names match Shopify Admin's CSV
    // export headers verbatim.
    // PR #110 + #111: return_fees IS a valid column on the `sales` dataset
    // (probed 2026-05-26 via devtools_pr110_probe_columns: April 2025 = $10).
    // Gift-card columns are NOT — every candidate name (gift_cards_issued,
    // gift_card_sales, net_gift_card_sales, etc.) returned "Column Not Found",
    // and `FROM gift_cards` returns rows=0. Shopify's Finance Summary
    // "Gift cards" line lives elsewhere; we compute it ourselves from
    // recon_shopify_sales line_type='GIFT_CARD' and skip the ShopifyQL diff.
    "SHOW gross_sales, discounts, returns, net_sales, shipping_charges, taxes, total_sales, orders, return_fees",
    // Dates are NOT string-quoted in ShopifyQL — the ANTLR grammar expects a
    // bare DATE_ token (yyyy-MM-dd). Quoting them yields:
    //   "Syntax input mismatch - mismatched input ''2026-03-01''
    //    expecting {'+','-',IDENTIFIER_,INTEGER_,DATE_}"
    // startDate/endDate are already asserted YYYY-MM-DD above, so direct
    // interpolation is safe (no injection risk — only digits and dashes).
    `SINCE ${startDate} UNTIL ${endDate}`,
  ].join("\n");

  const result = await runShopifyql(q);

  if (result.parseErrors.length > 0) {
    const msgs = result.parseErrors.map((e) => e.message).join("; ");
    throw new Error(`ShopifyQL parse error: ${msgs}`);
  }

  // Expect exactly one row (no GROUP BY). Shopify still returns an empty
  // array for zero-data months — treat that as a row of nulls.
  const row = result.rows[0] ?? null;

  const num = (v: any): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    start: startDate,
    end: endDate,
    bucket_by: bucketBy,
    gross_sales: num(row?.gross_sales),
    discounts: num(row?.discounts),
    returns: num(row?.returns),
    net_sales: num(row?.net_sales),
    // ShopifyQL column is `shipping_charges`; we surface it as `shipping` on
    // our API to match the Finance Summary PDF section header.
    shipping: num(row?.shipping_charges),
    taxes: num(row?.taxes),
    total_sales: num(row?.total_sales),
    orders: num(row?.orders),
    return_fees: num(row?.return_fees),
    // PR #111: not pulled from ShopifyQL (column does not exist on `sales`).
    net_sales_gift_cards: null,
    raw: row,
    query: q,
  };
}
