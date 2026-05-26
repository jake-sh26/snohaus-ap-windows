/**
 * PR #96 — Shopify Agreements Ledger (schema only)
 * ================================================
 *
 * PURPOSE
 * -------
 * Mirror Shopify's `Order.agreements -> sales` ledger directly into our
 * database so we can project recon_revenue_events 1:1 from the same
 * source that powers Shopify's own finance reports.
 *
 * Path A (synthesize edit-deltas from our hand-rolled detector rules) was
 * abandoned because it kept drifting from Shopify in edge cases (returns,
 * partial refunds with tax recalc, mixed edits). The PR #96 probe (#99)
 * proved that Shopify exposes the exact ledger we need:
 *
 *   - SalesAgreement.happenedAt is the date Shopify books a sale to (so an
 *     OrderEditAgreement on Nov 4 books to Nov, not the May order date)
 *   - SalesAgreement.reason ∈ { ORDER, ORDER_EDIT, REFUND, RETURN, ... }
 *   - Each Sale carries totalAmount, totalDiscountAmount*, totalTaxAmount,
 *     plus per-subtype back-references (lineItem / shippingLine / fee /
 *     additionalFee / duty) and a tax_breakdown array.
 *
 * Path B (this PR + #97 + #98 + #99) replaces the synthesize-deltas logic
 * with direct ingestion of agreements/sales, then projects events 1:1.
 *
 *
 * DATA MODEL
 * ----------
 * Two tables, both keyed on the Shopify Sale/Agreement GIDs so re-ingest
 * is idempotent.
 *
 *   recon_shopify_agreements
 *     id                Shopify SalesAgreement GID (PRIMARY KEY)
 *     order_id          FK to recon_orders(id) ON DELETE CASCADE
 *     happened_at       ISO timestamp; date Shopify books the sales to
 *     happened_month    GENERATED column: YYYY-MM in store-local (ET)
 *     reason            ORDER | ORDER_EDIT | REFUND | RETURN | ...
 *     agreement_type    OrderAgreement | OrderEditAgreement |
 *                       RefundAgreement | ReturnAgreement | ...
 *     app_handle        Shopify app that created the agreement
 *                       (pos, shopify_web, point_of_sale, ...)
 *     refund_id         Shopify Refund GID when agreement_type=RefundAgreement
 *     return_id         Shopify Return GID when agreement_type=ReturnAgreement
 *     raw_json          full agreement node payload for forensics
 *     ingested_at       ISO timestamp of upsert
 *     ingest_version    bumped on every re-ingest
 *
 *   recon_shopify_sales
 *     id                Shopify Sale GID (PRIMARY KEY)
 *     agreement_id      FK to recon_shopify_agreements(id) ON DELETE CASCADE
 *     order_id          FK to recon_orders(id) ON DELETE CASCADE (denorm)
 *     happened_at       denorm copy of agreement.happenedAt — this is the
 *                       `recognized_at` for the event projector in PR #98
 *     happened_month    GENERATED column matching agreements table
 *     sale_type         Shopify __typename: ProductSale | GiftCardSale |
 *                       TipSale | ShippingLineSale | FeeSale |
 *                       AdditionalFeeSale | DutySale | AdjustmentSale |
 *                       UnknownSale
 *     action_type       Shopify SaleActionType: ORDER | UPDATE | RETURN |
 *                       REFUND | ...
 *     line_type         Shopify SaleLineType: PRODUCT | TIP | GIFT_CARD |
 *                       SHIPPING | DUTY | FEE | ADJUSTMENT | UNKNOWN
 *     quantity          signed quantity (negative on UPDATE reversals)
 *     total_amount      signed money amount (negative on reversals/refunds)
 *     total_discount_after_taxes   total discount applied (positive number)
 *     total_discount_before_taxes  pre-tax discount applied (positive)
 *     total_tax         signed tax amount
 *     ref_id            subtype-specific back-reference id
 *                         ProductSale, GiftCardSale, TipSale → lineItem.id
 *                         ShippingLineSale                   → shippingLine.id
 *                         FeeSale                            → fee.id
 *                         AdditionalFeeSale                  → additionalFee.id
 *                         DutySale                           → duty.id
 *                         AdjustmentSale, UnknownSale        → NULL
 *     ref_name          human-readable name from the back-ref
 *     ref_sku           SKU for product/gift-card sales
 *     tax_breakdown_json   JSON array: [{title, rate, amount, price}]
 *     raw_json          full sale node payload for forensics
 *     ingested_at       ISO timestamp of upsert
 *     ingest_version    bumped on every re-ingest
 *
 *
 * PROJECTION (PR #98, NOT THIS PR)
 * --------------------------------
 * In PR #98 the events projector will read recon_shopify_sales directly:
 *
 *   FOR each sale row:
 *     event_id   = deterministic hash of sale.id
 *     event_date = sale.happened_at                ← critical: uses Shopify's
 *                                                    booking date, not order date
 *     event_type = mapEventType(sale.action_type, sale.line_type, sale.sale_type)
 *     order_id   = sale.order_id
 *     gross/discount/tax/returns derived from sale columns
 *
 * The current projector (synthesize-deltas) stays behind a feature flag
 * during the A/B phase until events-vs-Shopify is clean across all 17
 * months. Then the synthesize-deltas detectors retire.
 *
 *
 * READ-ONLY GUARANTEE
 * -------------------
 * Phase 1 reconciler is read-only. Nothing in this PR (schema only) or
 * the subsequent ingest PR (#97) writes back to Shopify. We only READ
 * `Order.agreements -> sales` and project them into our local DB for
 * accounting.
 *
 *
 * IDEMPOTENCE
 * -----------
 * Both tables use the Shopify GID as PRIMARY KEY. Re-ingesting the same
 * agreements yields the same rows — re-runs are safe. `ingest_version`
 * bumps so we can detect re-ingests in audit queries.
 *
 *
 * WARNINGS
 * --------
 * Re-uses the existing `recon_event_warnings` table from
 * shopify-recon-revenue-events.ts. Malformed sale nodes (missing
 * happenedAt, unrecognized sale_type, etc.) log a warning and skip.
 * The schema migration itself never throws.
 */

import { sqlite } from "./storage";
import { shopifyGraphqlCall, type ShopifyReconConfig } from "./shopify-recon";

let schemaEnsured = false;

// ---------------------------------------------------------------------------
// PR #97 — GraphQL query (mirrors the PR #96 probe v2 endpoint shape).
// ---------------------------------------------------------------------------

const AGREEMENTS_QUERY = `
  query OrderAgreementsIngest($id: ID!, $agreementsCursor: String, $salesFirst: Int!) {
    order(id: $id) {
      id
      agreements(first: 50, after: $agreementsCursor) {
        edges {
          cursor
          node {
            id
            happenedAt
            reason
            __typename
            ... on OrderAgreement      { app { handle } }
            ... on OrderEditAgreement  { app { handle } }
            ... on RefundAgreement     { app { handle } refund { id processedAt createdAt } }
            # NOTE: We intentionally do NOT select return{id name status}
            # here -- that field requires the read_returns Shopify scope,
            # which this app does not have. Asking for it returned a partial
            # GraphQL error on every order that had a ReturnAgreement, and
            # the old ingest code threw on r.errors, silently dropping
            # ~1,778 orders. return_id is not used downstream by the V2
            # projector; leaving it NULL is correct.
            ... on ReturnAgreement     { app { handle } }
            sales(first: $salesFirst) {
              edges {
                cursor
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
                  ... on ProductSale       { lineItem { id name sku quantity originalUnitPriceSet { shopMoney { amount } } } }
                  ... on GiftCardSale      { lineItem { id name sku } }
                  ... on TipSale           { lineItem { id name } }
                  ... on ShippingLineSale  { shippingLine { id title code originalPriceSet { shopMoney { amount } } } }
                  ... on FeeSale           { fee { id } }
                  ... on AdditionalFeeSale { additionalFee { id name } }
                  ... on DutySale          { duty { id } }
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

// Inner-only query for paginating a single agreement's sales when it has
// more than `salesFirst` entries. Cheaper than re-running the outer query.
const AGREEMENT_SALES_PAGE_QUERY = `
  query OneAgreementSalesPage($id: ID!, $cursor: String!) {
    node(id: $id) {
      ... on SalesAgreement {
        id
        sales(first: 250, after: $cursor) {
          edges {
            cursor
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
              ... on ProductSale       { lineItem { id name sku quantity originalUnitPriceSet { shopMoney { amount } } } }
              ... on GiftCardSale      { lineItem { id name sku } }
              ... on TipSale           { lineItem { id name } }
              ... on ShippingLineSale  { shippingLine { id title code originalPriceSet { shopMoney { amount } } } }
              ... on FeeSale           { fee { id } }
              ... on AdditionalFeeSale { additionalFee { id name } }
              ... on DutySale          { duty { id } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Helpers — money parsing, subtype-aware back-ref extraction.
// ---------------------------------------------------------------------------

const num = (mb: any): number | null =>
  mb?.shopMoney?.amount != null ? Number(mb.shopMoney.amount) : null;

function extractRef(s: any): {
  ref_id: string | null;
  ref_name: string | null;
  ref_sku: string | null;
} {
  let ref_id: string | null = null;
  let ref_name: string | null = null;
  let ref_sku: string | null = null;
  switch (s.__typename) {
    case "ProductSale":
    case "GiftCardSale":
      ref_id = s.lineItem?.id || null;
      ref_name = s.lineItem?.name || null;
      ref_sku = s.lineItem?.sku || null;
      break;
    case "TipSale":
      ref_id = s.lineItem?.id || null;
      ref_name = s.lineItem?.name || null;
      break;
    case "ShippingLineSale":
      ref_id = s.shippingLine?.id || null;
      ref_name = s.shippingLine?.title || s.shippingLine?.code || null;
      break;
    case "FeeSale":
      ref_id = s.fee?.id || null;
      break;
    case "AdditionalFeeSale":
      ref_id = s.additionalFee?.id || null;
      ref_name = s.additionalFee?.name || null;
      break;
    case "DutySale":
      ref_id = s.duty?.id || null;
      break;
    // AdjustmentSale, UnknownSale: no back-ref
  }
  return { ref_id, ref_name, ref_sku };
}

function buildTaxBreakdown(
  taxes: any[] | null | undefined,
): { amount: number | null; title: string | null; rate: number | null; price: number | null }[] {
  return (taxes || []).map((t: any) => ({
    amount: num(t.amount),
    title: t.taxLine?.title || null,
    rate: t.taxLine?.rate ?? null,
    price: num(t.taxLine?.priceSet),
  }));
}

// ---------------------------------------------------------------------------
// Warnings logging — reuses recon_event_warnings table from PR #94.
// ---------------------------------------------------------------------------

function logWarning(
  order_id: string,
  reason: string,
  detail: any,
): void {
  try {
    sqlite.prepare(`
      INSERT INTO recon_event_warnings
        (order_id, refund_id, line_item_id, event_type, reason, detail_json, logged_at)
      VALUES (?, NULL, NULL, 'agreements_ingest', ?, ?, ?)
    `).run(order_id, reason, JSON.stringify(detail), new Date().toISOString());
  } catch {
    // Warnings are best-effort; never throw from inside the ingest path.
  }
}

/**
 * Idempotent schema migration for the Shopify agreements/sales ledger.
 * Safe to call repeatedly — uses CREATE TABLE IF NOT EXISTS + CREATE INDEX
 * IF NOT EXISTS. No data is inserted here; ingest lands in PR #97.
 */
export function ensureShopifyAgreementsSchema(): void {
  if (schemaEnsured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recon_shopify_agreements (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES recon_orders(id) ON DELETE CASCADE,
      happened_at TEXT NOT NULL,
      -- Store-local (ET) YYYY-MM bucket. Matches recon_revenue_events
      -- convention so the two ledgers join cleanly on event_month.
      happened_month TEXT GENERATED ALWAYS AS
        (substr(datetime(happened_at, '-5 hours'), 1, 7)) VIRTUAL,
      reason TEXT NOT NULL,
      agreement_type TEXT NOT NULL,
      app_handle TEXT,
      refund_id TEXT,
      return_id TEXT,
      raw_json TEXT,
      ingested_at TEXT NOT NULL,
      ingest_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_agreements_order
      ON recon_shopify_agreements(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_agreements_month
      ON recon_shopify_agreements(happened_month);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_agreements_reason
      ON recon_shopify_agreements(reason);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_agreements_happened_at
      ON recon_shopify_agreements(happened_at);

    CREATE TABLE IF NOT EXISTS recon_shopify_sales (
      id TEXT PRIMARY KEY,
      agreement_id TEXT NOT NULL REFERENCES recon_shopify_agreements(id) ON DELETE CASCADE,
      order_id TEXT NOT NULL REFERENCES recon_orders(id) ON DELETE CASCADE,
      -- Denormalized from agreement so the events projector can read this
      -- table alone without a join. This is the value that will become
      -- event_date / recognized_at in the new projector (PR #98).
      happened_at TEXT NOT NULL,
      happened_month TEXT GENERATED ALWAYS AS
        (substr(datetime(happened_at, '-5 hours'), 1, 7)) VIRTUAL,
      sale_type TEXT NOT NULL,
      action_type TEXT,
      line_type TEXT,
      quantity INTEGER,
      total_amount REAL,
      total_discount_after_taxes REAL,
      total_discount_before_taxes REAL,
      total_tax REAL,
      ref_id TEXT,
      ref_name TEXT,
      ref_sku TEXT,
      tax_breakdown_json TEXT,
      raw_json TEXT,
      ingested_at TEXT NOT NULL,
      ingest_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_agreement
      ON recon_shopify_sales(agreement_id);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_order
      ON recon_shopify_sales(order_id);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_month
      ON recon_shopify_sales(happened_month);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_type
      ON recon_shopify_sales(sale_type);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_action
      ON recon_shopify_sales(action_type);
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_happened_at
      ON recon_shopify_sales(happened_at);
  `);

  // PR #125 — Store-attribution columns sourced from ShopifyQL `sales`
  // dataset (Shopify's analytics layer). Plain GraphQL Sale nodes do NOT
  // expose pos_location_id (confirmed against the SalesAgreement /
  // Sale / LineItem schemas on 2026-05-26), but ShopifyQL exposes it as a
  // first-class column on the `sales` table. We ingest it in a separate
  // pass keyed by sale_id (which is the same Shopify-issued sale GID we
  // already store as recon_shopify_sales.id, just the bare numeric).
  //
  // pos_location_id is NULL for non-POS rows (online orders, etc.). For
  // those, the by-store endpoint falls back to a fulfillment cascade per
  // the locked allocation rule (PR #125 SQL change).
  //
  // ALTER TABLE ADD COLUMN is idempotent only via try/catch in SQLite —
  // there's no IF NOT EXISTS clause. Errors swallowed below indicate the
  // column already exists, which is the desired state.
  for (const ddl of [
    `ALTER TABLE recon_shopify_sales ADD COLUMN pos_location_id TEXT`,
    `ALTER TABLE recon_shopify_sales ADD COLUMN pos_location_name TEXT`,
    `ALTER TABLE recon_shopify_sales ADD COLUMN line_item_id TEXT`,
  ]) {
    try { sqlite.exec(ddl); } catch { /* column already present */ }
  }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_recon_shopify_sales_pos_location
      ON recon_shopify_sales(pos_location_id);
  `);

  schemaEnsured = true;
}

/**
 * Lightweight introspection used by debug endpoints and PR #97 ingest
 * progress tracking. Returns 0/0 in a fresh DB.
 */
export function getShopifyAgreementsCounts(): {
  agreements: number;
  sales: number;
} {
  ensureShopifyAgreementsSchema();
  const a = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recon_shopify_agreements`)
    .get() as any;
  const s = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recon_shopify_sales`)
    .get() as any;
  return { agreements: a?.n ?? 0, sales: s?.n ?? 0 };
}

export function getOrderAgreementsCounts(order_id: string): {
  agreements: number;
  sales: number;
} {
  ensureShopifyAgreementsSchema();
  const a = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recon_shopify_agreements WHERE order_id = ?`)
    .get(order_id) as any;
  const s = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM recon_shopify_sales WHERE order_id = ?`)
    .get(order_id) as any;
  return { agreements: a?.n ?? 0, sales: s?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// PR #97 — Per-order ingest.
// ---------------------------------------------------------------------------

export interface IngestOrderResult {
  order_id: string;
  agreements_upserted: number;
  sales_upserted: number;
  graphql_calls: number;
  warnings: number;
  duration_ms: number;
}

/**
 * Fetches Order.agreements -> sales from Shopify and upserts into
 * recon_shopify_agreements + recon_shopify_sales. Read-only against
 * Shopify. Idempotent: re-running yields the same rows but bumps
 * ingest_version. Pagination is handled on both the outer (agreements)
 * and inner (sales) connections.
 */
export async function ingestAgreementsForOrder(
  cfg: ShopifyReconConfig,
  order_id: string,
): Promise<IngestOrderResult> {
  ensureShopifyAgreementsSchema();
  const started = Date.now();
  const orderGid = `gid://shopify/Order/${order_id}`;
  const now = new Date().toISOString();

  let graphqlCalls = 0;
  let warnings = 0;
  const agreementNodes: any[] = [];

  // ---- Outer pagination: agreements ----
  let agreementsCursor: string | null = null;
  for (let safetyPage = 0; safetyPage < 50; safetyPage++) {
    graphqlCalls++;
    const r = await shopifyGraphqlCall(cfg, AGREEMENTS_QUERY, {
      id: orderGid,
      agreementsCursor,
      salesFirst: 250,
    });
    // Partial GraphQL errors are normal in Shopify — e.g. a missing scope on
    // one fragment returns an error on that path but still ships the rest of
    // the data. Only treat r.errors as fatal when no data came back.
    const order: any = (r.data as any)?.order;
    if (r.errors) {
      logWarning(order_id, "graphql_errors", { errors: r.errors });
      warnings++;
      if (!order) {
        throw new Error(`agreements graphql errors (no data): ${JSON.stringify(r.errors).slice(0, 500)}`);
      }
    }
    if (!order) {
      logWarning(order_id, "order_null", { orderGid });
      warnings++;
      return {
        order_id,
        agreements_upserted: 0,
        sales_upserted: 0,
        graphql_calls: graphqlCalls,
        warnings,
        duration_ms: Date.now() - started,
      };
    }
    const edges = order.agreements?.edges || [];
    for (const e of edges) agreementNodes.push(e.node);
    const pi = order.agreements?.pageInfo;
    if (!pi?.hasNextPage) break;
    agreementsCursor = pi.endCursor || null;
    if (!agreementsCursor) break;
  }

  // ---- Inner pagination: per-agreement sales (rare; most have <250) ----
  for (const a of agreementNodes) {
    let salesCursor: string | null = a.sales?.pageInfo?.hasNextPage
      ? a.sales?.pageInfo?.endCursor || null
      : null;
    while (salesCursor) {
      graphqlCalls++;
      const r = await shopifyGraphqlCall(cfg, AGREEMENT_SALES_PAGE_QUERY, {
        id: a.id,
        cursor: salesCursor,
      });
      const node: any = (r.data as any)?.node;
      if (r.errors) {
        // Same partial-error tolerance as the outer paginator — only bail
        // when no data came back at all.
        logWarning(order_id, "sales_page_graphql_errors", {
          agreement_id: a.id,
          errors: r.errors,
        });
        warnings++;
        if (!node) break;
      }
      const moreEdges = node?.sales?.edges || [];
      a.sales.edges.push(...moreEdges);
      const pi = node?.sales?.pageInfo;
      if (!pi?.hasNextPage) break;
      salesCursor = pi.endCursor || null;
    }
  }

  // ---- Upsert in a single transaction ----
  const upsertAgreement = sqlite.prepare(`
    INSERT INTO recon_shopify_agreements
      (id, order_id, happened_at, reason, agreement_type, app_handle,
       refund_id, return_id, raw_json, ingested_at, ingest_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      happened_at    = excluded.happened_at,
      reason         = excluded.reason,
      agreement_type = excluded.agreement_type,
      app_handle     = excluded.app_handle,
      refund_id      = excluded.refund_id,
      return_id      = excluded.return_id,
      raw_json       = excluded.raw_json,
      ingested_at    = excluded.ingested_at,
      ingest_version = ingest_version + 1
  `);
  const upsertSale = sqlite.prepare(`
    INSERT INTO recon_shopify_sales
      (id, agreement_id, order_id, happened_at, sale_type, action_type,
       line_type, quantity, total_amount, total_discount_after_taxes,
       total_discount_before_taxes, total_tax, ref_id, ref_name, ref_sku,
       tax_breakdown_json, raw_json, ingested_at, ingest_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      agreement_id                = excluded.agreement_id,
      order_id                    = excluded.order_id,
      happened_at                 = excluded.happened_at,
      sale_type                   = excluded.sale_type,
      action_type                 = excluded.action_type,
      line_type                   = excluded.line_type,
      quantity                    = excluded.quantity,
      total_amount                = excluded.total_amount,
      total_discount_after_taxes  = excluded.total_discount_after_taxes,
      total_discount_before_taxes = excluded.total_discount_before_taxes,
      total_tax                   = excluded.total_tax,
      ref_id                      = excluded.ref_id,
      ref_name                    = excluded.ref_name,
      ref_sku                     = excluded.ref_sku,
      tax_breakdown_json          = excluded.tax_breakdown_json,
      raw_json                    = excluded.raw_json,
      ingested_at                 = excluded.ingested_at,
      ingest_version              = ingest_version + 1
  `);

  let agreementsUpserted = 0;
  let salesUpserted = 0;

  const tx = sqlite.transaction(() => {
    for (const a of agreementNodes) {
      if (!a?.id || !a?.happenedAt || !a?.reason) {
        logWarning(order_id, "agreement_missing_required", {
          agreement_id: a?.id,
          happened_at: a?.happenedAt,
          reason: a?.reason,
        });
        warnings++;
        continue;
      }
      upsertAgreement.run(
        a.id,
        order_id,
        a.happenedAt,
        a.reason,
        a.__typename || "Unknown",
        a.app?.handle || null,
        a.refund?.id || null,
        a.return?.id || null,
        JSON.stringify(a),
        now,
      );
      agreementsUpserted++;

      for (const se of a.sales?.edges || []) {
        const s = se.node;
        if (!s?.id || !s?.__typename) {
          logWarning(order_id, "sale_missing_required", {
            agreement_id: a.id,
            sale_id: s?.id,
            typename: s?.__typename,
          });
          warnings++;
          continue;
        }
        const ref = extractRef(s);
        const taxBreakdown = buildTaxBreakdown(s.taxes);
        upsertSale.run(
          s.id,
          a.id,
          order_id,
          a.happenedAt,            // denormalized so projector reads sales alone
          s.__typename,
          s.actionType || null,
          s.lineType || null,
          s.quantity ?? null,
          num(s.totalAmount),
          num(s.totalDiscountAmountAfterTaxes),
          num(s.totalDiscountAmountBeforeTaxes),
          num(s.totalTaxAmount),
          ref.ref_id,
          ref.ref_name,
          ref.ref_sku,
          JSON.stringify(taxBreakdown),
          JSON.stringify(s),
          now,
        );
        salesUpserted++;
      }
    }
  });
  tx();

  return {
    order_id,
    agreements_upserted: agreementsUpserted,
    sales_upserted: salesUpserted,
    graphql_calls: graphqlCalls,
    warnings,
    duration_ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// PR #97 — Backfill across many orders.
// ---------------------------------------------------------------------------

export type BackfillScope =
  | { kind: "orders"; ids: string[] }    // explicit list of order ids
  | { kind: "names"; names: string[] }   // explicit list of order names (#22338, 21840)
  | { kind: "edited" }                   // orders where updated_at > processed_at (Bug 3 blast radius)
  | { kind: "month"; month: string }     // 'YYYY-MM' (created_at OR updated_at)
  | { kind: "missing" }                  // orders in recon_orders with ZERO rows in recon_shopify_agreements (used to recover the ~1,778 orders the pre-fix ingest dropped)
  | { kind: "all" };                     // every order in recon_orders

export interface BackfillProgress {
  job_id: string;
  scope: BackfillScope;
  started_at: string;
  finished_at: string | null;
  total_orders: number;
  processed: number;
  agreements_upserted: number;
  sales_upserted: number;
  graphql_calls: number;
  warnings: number;
  errors: { order_id: string; message: string }[];
  status: "running" | "completed" | "failed";
}

// In-process job registry. Backfills run inside this Node process; a
// crash loses progress (re-run picks up where it left off because
// upserts are idempotent and we can skip orders that already have rows).
const backfillJobs = new Map<string, BackfillProgress>();

export function getBackfillProgress(job_id: string): BackfillProgress | null {
  return backfillJobs.get(job_id) || null;
}

function resolveBackfillTargets(scope: BackfillScope): { id: string; name: string }[] {
  switch (scope.kind) {
    case "orders":
      return sqlite
        .prepare(
          `SELECT id, name FROM recon_orders WHERE id IN (${scope.ids.map(() => "?").join(",")})`,
        )
        .all(...scope.ids) as any[];
    case "names": {
      const withHash = scope.names.map((n) => (n.startsWith("#") ? n : `#${n}`));
      const noHash = scope.names.map((n) => (n.startsWith("#") ? n.slice(1) : n));
      const placeholders = withHash.map(() => "?").join(",");
      return sqlite
        .prepare(
          `SELECT id, name FROM recon_orders
             WHERE name IN (${placeholders})
                OR name IN (${placeholders})
                OR order_number IN (${placeholders})`,
        )
        .all(...withHash, ...noHash, ...noHash) as any[];
    }
    case "edited":
      return sqlite
        .prepare(
          `SELECT id, name FROM recon_orders
             WHERE updated_at IS NOT NULL
               AND processed_at IS NOT NULL
               AND datetime(updated_at) > datetime(processed_at)
             ORDER BY processed_at ASC`,
        )
        .all() as any[];
    case "month":
      return sqlite
        .prepare(
          `SELECT id, name FROM recon_orders
             WHERE substr(datetime(created_at, '-5 hours'), 1, 7) = ?
                OR substr(datetime(updated_at, '-5 hours'), 1, 7) = ?
             ORDER BY created_at ASC`,
        )
        .all(scope.month, scope.month) as any[];
    case "missing":
      // Orders with no agreement rows. Designed to re-pick-up the orders
      // that the pre-fix ingest dropped because of the read_returns scope
      // error on ReturnAgreement.return.
      return sqlite
        .prepare(
          `SELECT o.id, o.name FROM recon_orders o
             LEFT JOIN recon_shopify_agreements a ON a.order_id = o.id
             WHERE a.order_id IS NULL
             ORDER BY o.created_at ASC`,
        )
        .all() as any[];
    case "all":
      return sqlite
        .prepare(`SELECT id, name FROM recon_orders ORDER BY created_at ASC`)
        .all() as any[];
  }
}

/**
 * Kicks off a background backfill. Returns the job id immediately; poll
 * via getBackfillProgress(jobId). Safe to call repeatedly — ingest is
 * idempotent and re-runs bump ingest_version.
 *
 * Throttling: a 100 ms delay between orders keeps us well under
 * Shopify's GraphQL cost budget (each order costs ~12 cost units; at 10
 * orders/sec we burn ~120/sec while the bucket refills at ~50/sec
 * sustained, so we'll naturally back off via the 429 retry inside
 * shopifyGraphqlCall when needed).
 */
export function startAgreementsBackfill(
  cfg: ShopifyReconConfig,
  scope: BackfillScope,
): BackfillProgress {
  ensureShopifyAgreementsSchema();
  const targets = resolveBackfillTargets(scope);
  const job_id = `bf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const progress: BackfillProgress = {
    job_id,
    scope,
    started_at: new Date().toISOString(),
    finished_at: null,
    total_orders: targets.length,
    processed: 0,
    agreements_upserted: 0,
    sales_upserted: 0,
    graphql_calls: 0,
    warnings: 0,
    errors: [],
    status: "running",
  };
  backfillJobs.set(job_id, progress);

  // Fire-and-forget background loop.
  (async () => {
    try {
      for (const t of targets) {
        try {
          const r = await ingestAgreementsForOrder(cfg, t.id);
          progress.agreements_upserted += r.agreements_upserted;
          progress.sales_upserted += r.sales_upserted;
          progress.graphql_calls += r.graphql_calls;
          progress.warnings += r.warnings;
        } catch (e: any) {
          progress.errors.push({
            order_id: t.id,
            message: String(e?.message || e).slice(0, 300),
          });
        }
        progress.processed++;
        // Light throttle. 100 ms = max 10 orders/sec. Cooperative with
        // shopifyGraphqlCall's 429 retry; never starves the event loop.
        await new Promise((r) => setTimeout(r, 100));
      }
      progress.status = "completed";
    } catch (e: any) {
      progress.status = "failed";
      progress.errors.push({ order_id: "(loop)", message: String(e?.message || e).slice(0, 300) });
    } finally {
      progress.finished_at = new Date().toISOString();
    }
  })();

  return progress;
}
