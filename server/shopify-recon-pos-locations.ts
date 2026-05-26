/**
 * server/shopify-recon-pos-locations.ts
 *
 * PR #125 — Per-line POS location attribution sourced from Shopify's
 * ShopifyQL `sales` dataset.
 *
 * ============================================================================
 * Why this module exists
 * ============================================================================
 *
 * The store-level allocation rule for Sno-Haus reads:
 *
 *   "POS attribution = per-line pos_location_id exactly as Shopify reports.
 *    Original sale lines → register that rang. Edit-add lines → register
 *    doing the edit, not original. Returns/refunds of original lines →
 *    original line's store. Tax/discount/return_fees ride with the line
 *    they're attached to."
 *
 * V2 (PR #97/#110) historically attributed every line of an order to the
 * single `recon_orders.location_id`, which is the parent order's POS
 * location. That works for single-store orders but produces $359/month of
 * drift against Shopify's Finance Summary on multi-store edges — confirmed
 * on 2026-05-26 for March 2026 Huntington across three orders (#37926,
 * #37234, #35471).
 *
 * Root cause: Shopify's Sale interface (in plain Admin GraphQL) does NOT
 * expose a per-row location field. Neither does LineItem. The only
 * GraphQL surface that carries location is OrderTransaction.location, but
 * mapping transactions back to sale lines requires re-implementing
 * Shopify's internal pairing logic — undocumented and brittle.
 *
 * ShopifyQL, by contrast, exposes `pos_location_id` and `pos_location_name`
 * as first-class columns on the `sales` table (probed and confirmed on
 * 2026-05-26 — see workspace devtools_pr125_ql_sale_identity.js). That
 * dataset is the same one Shopify Admin → Analytics → Finance Summary
 * reads from, so by ingesting from there we inherit Shopify's attribution
 * logic for every edge case (multi-location edits, cross-store exchanges,
 * tax-rate differentials, etc.) for free — definitionally penny-perfect
 * vs the Shopify Finance Summary by store.
 *
 * ============================================================================
 * Join strategy
 * ============================================================================
 *
 * recon_shopify_sales.id stores the Shopify Sale GID exactly as returned
 * by the GraphQL Order.agreements query:
 *
 *   gid://shopify/ProductSale/19976139276530
 *   gid://shopify/GiftCardSale/19979663409394
 *   gid://shopify/ShippingLineSale/...
 *   ...
 *
 * ShopifyQL `sales` returns sale_id as the bare numeric portion:
 *
 *   19976139276530
 *
 * We join by extracting the trailing numeric segment from the GID and
 * matching against ShopifyQL's sale_id. This is unambiguous because Shopify
 * Sale IDs are globally unique within a shop (the GID typename prefix is
 * decorative — the numeric portion alone is the primary key).
 *
 * We store the bare numeric back as a separate `sale_id_numeric` virtual
 * lookup column? No — we don't bother creating that column. Instead we
 * compute it once during upsert by using the SQLite expression:
 *
 *   substr(id, instr(id, 'Sale/') + 5)
 *
 * which works for every Sale GID variant (ProductSale, GiftCardSale,
 * ShippingLineSale, FeeSale, AdditionalFeeSale, DutySale, TipSale,
 * AdjustmentSale, UnknownSale) because they all end in "...Sale/{numeric}".
 *
 * ============================================================================
 * Idempotency
 * ============================================================================
 *
 * Re-running this ingest is a pure UPDATE — no rows are inserted, no rows
 * deleted, and a sale row's pos_location_id only changes if Shopify's
 * dataset reclassifies it (which happens, e.g., when a refund is later
 * voided and reissued at a different register). Last-write-wins is
 * correct in that case because ShopifyQL is the source of truth.
 *
 * If a recon_shopify_sales row exists locally but ShopifyQL has no
 * corresponding sale_id, we leave it untouched (pos_location_id stays
 * NULL). This handles the lag between agreements ingest landing first
 * and the ShopifyQL analytics pipeline catching up — usually <1 hour but
 * occasionally longer on Shopify's side.
 *
 * If ShopifyQL has a sale_id we don't have locally, we ignore it. That
 * means agreements ingest must run before this for full coverage. The
 * orchestrator in /api/recon/sales/ingest-pos-locations enforces this by
 * sequencing.
 *
 * ============================================================================
 * Pagination & limits
 * ============================================================================
 *
 * ShopifyQL's row limit is 1000 per query. To cover an arbitrary window
 * we slice the date range into ~5-day chunks (typically 1000 sale rows
 * per chunk in practice for Sno-Haus volume) and run them sequentially.
 * If a chunk hits the 1000-row cap we recursively halve the window until
 * it fits, mirroring the established pattern in shopify-shopifyql.ts /
 * v2-vs-shopifyql.
 *
 * No GROUP BY DAY in our query — we want raw line-level rows. We DO
 * group by all identity columns (sale_id, line_item_id, line_type,
 * pos_location_id, pos_location_name, order_id, order_name) so each
 * row is unique. Money columns are summed within that grain by Shopify,
 * which for a single sale_id is a no-op (one sale = one row).
 */

import { sqlite } from "./storage";
import { runShopifyql } from "./shopify-shopifyql";
import { ensureShopifyAgreementsSchema } from "./shopify-recon-agreements";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PosLocationIngestResult {
  start: string;
  end: string;
  windows_ran: number;
  ql_rows_fetched: number;
  sales_updated: number;
  sales_unchanged: number;
  unmatched_ql_rows: number; // ShopifyQL sale_id with no local recon_shopify_sales row
  duration_ms: number;
  warnings: string[];
}

interface QlSaleRow {
  sale_id: string;
  line_item_id: string | null;
  line_type: string | null;
  pos_location_id: string | null;
  pos_location_name: string | null;
  order_id: string | null;
  order_name: string | null;
}

// ---------------------------------------------------------------------------
// Date helpers — ShopifyQL SINCE/UNTIL is inclusive-exclusive on the date
// boundary (in the shop's timezone), so we treat ranges as [start, end)
// half-open and produce ISO date strings (YYYY-MM-DD).
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function diffDays(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / 86400000);
}

// ---------------------------------------------------------------------------
// Core query
// ---------------------------------------------------------------------------

/**
 * Build the ShopifyQL query for a [start, end) date window. Groups by all
 * row-identity columns so every row is unique at the sale_id grain.
 *
 * We include zero-money rows (the GROUP BY ensures every sale_id appears
 * even if its money totals are zero) by SHOWing gross_sales — a value of
 * 0 is still a valid row, ShopifyQL only suppresses NULL groupings.
 */
function buildQuery(start: string, end: string): string {
  // ShopifyQL SINCE is inclusive, UNTIL is inclusive — to express [start, end)
  // we shift end back by one day. Caller passes half-open intervals.
  const untilInclusive = addDays(end, -1);
  return [
    "FROM sales",
    "SHOW gross_sales",
    "GROUP BY sale_id, line_item_id, line_type, pos_location_id, pos_location_name, order_id, order_name",
    `SINCE ${start}`,
    `UNTIL ${untilInclusive}`,
    "LIMIT 1000",
  ].join(" ");
}

/**
 * Extract the bare numeric tail from a Sale GID:
 *   gid://shopify/ProductSale/19976139276530 → "19976139276530"
 *
 * Returns null if the input doesn't match the expected shape.
 */
function gidToNumeric(gid: string): string | null {
  // Match the segment after "Sale/" — all sale variants end in "...Sale/{n}".
  const m = gid.match(/Sale\/(\d+)$/);
  return m ? m[1] : null;
}

/**
 * Run a single ShopifyQL window and return its rows. If the window hits
 * the 1000-row cap, recursively halve and rerun.
 *
 * Returns { rows, windowsRan } so the caller can track total subdivisions.
 */
async function runWindow(
  start: string,
  end: string,
  warnings: string[],
): Promise<{ rows: QlSaleRow[]; windowsRan: number }> {
  if (diffDays(start, end) <= 1) {
    // Cannot subdivide further — accept truncation if it happens.
    const q = buildQuery(start, end);
    const result = await runShopifyql(q);
    if (result.parseErrors && result.parseErrors.length > 0) {
      warnings.push(
        `ShopifyQL parseErrors for ${start}..${end}: ${result.parseErrors
          .map((e) => e.message || JSON.stringify(e))
          .join("; ")}`,
      );
    }
    const rows = (result.rows || []).map(coerceRow);
    if (rows.length === 1000) {
      warnings.push(
        `Single-day window ${start} hit 1000-row cap — possible truncation.`,
      );
    }
    return { rows, windowsRan: 1 };
  }

  const q = buildQuery(start, end);
  const result = await runShopifyql(q);
  if (result.parseErrors && result.parseErrors.length > 0) {
    warnings.push(
      `ShopifyQL parseErrors for ${start}..${end}: ${result.parseErrors
        .map((e) => e.message || JSON.stringify(e))
        .join("; ")}`,
    );
  }
  const rows = (result.rows || []).map(coerceRow);

  if (rows.length < 1000) {
    return { rows, windowsRan: 1 };
  }

  // Hit cap → split in half and recurse. The two halves form the same
  // [start, end) window but smaller, so we union their rows.
  const mid = addDays(start, Math.floor(diffDays(start, end) / 2));
  const [left, right] = await Promise.all([
    runWindow(start, mid, warnings),
    runWindow(mid, end, warnings),
  ]);
  return {
    rows: [...left.rows, ...right.rows],
    windowsRan: left.windowsRan + right.windowsRan,
  };
}

function coerceRow(r: Record<string, any>): QlSaleRow {
  return {
    sale_id: String(r.sale_id ?? ""),
    line_item_id: r.line_item_id != null ? String(r.line_item_id) : null,
    line_type: r.line_type != null ? String(r.line_type) : null,
    pos_location_id: r.pos_location_id != null ? String(r.pos_location_id) : null,
    pos_location_name:
      r.pos_location_name != null ? String(r.pos_location_name) : null,
    order_id: r.order_id != null ? String(r.order_id) : null,
    order_name: r.order_name != null ? String(r.order_name) : null,
  };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Ingest pos_location_id / pos_location_name from ShopifyQL for the given
 * date window and stamp them onto recon_shopify_sales by matching on the
 * numeric tail of the sale GID.
 *
 * The window applies to the ShopifyQL SINCE/UNTIL filter, which Shopify
 * applies against the sale's happened_at in shop timezone. Pass dates as
 * YYYY-MM-DD. The window is half-open: [start, end).
 *
 * Typical chunking: pass ~5 days per call. The function itself will
 * subdivide further if any chunk hits the 1000-row cap.
 */
export async function ingestPosLocationsFromQL(
  start: string,
  end: string,
): Promise<PosLocationIngestResult> {
  ensureShopifyAgreementsSchema();
  const t0 = Date.now();
  const warnings: string[] = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error(
      `ingestPosLocationsFromQL: start/end must be YYYY-MM-DD (got ${start}..${end})`,
    );
  }
  if (diffDays(start, end) <= 0) {
    throw new Error(
      `ingestPosLocationsFromQL: end must be strictly after start (got ${start}..${end})`,
    );
  }

  // Walk the window in 5-day stripes. Each stripe gets passed to runWindow
  // which will further subdivide if it hits the 1000-row cap.
  // eslint-disable-next-line no-console
  console.log(`[pos-locations] starting ingest for ${start}..${end}`);
  const STRIPE_DAYS = 5;
  const allRows: QlSaleRow[] = [];
  let windowsRan = 0;
  let cursor = start;
  while (cursor < end) {
    const stripeEnd = addDays(cursor, STRIPE_DAYS);
    const cappedEnd = stripeEnd > end ? end : stripeEnd;
    const tStripe = Date.now();
    const { rows, windowsRan: w } = await runWindow(cursor, cappedEnd, warnings);
    allRows.push(...rows);
    windowsRan += w;
    // eslint-disable-next-line no-console
    console.log(
      `[pos-locations] stripe ${cursor}..${cappedEnd}: ${rows.length} rows in ${w} window(s), ${Date.now() - tStripe}ms (total rows so far: ${allRows.length})`,
    );
    cursor = cappedEnd;
  }

  // ---------------------------------------------------------------------
  // UPSERT pos_location_id back onto recon_shopify_sales.
  //
  // PR #126 PERF REWRITE — the original PR #125 implementation had two
  // killer bugs that caused the ingest to hang the server:
  //   1. The UPDATE / SELECT predicates used `substr(id, instr(id,
  //      'Sale/') + 5) = ?` which is NOT sargable — SQLite has to scan
  //      every row of recon_shopify_sales (~50k rows) for every probe.
  //   2. `sqlite.prepare(...)` was called inside the per-row loop —
  //      re-preparing a fresh statement for every QL row.
  // Combined cost: ~50k rows × ~1700 QL rows/month × 17 months = ~1.4B
  // string comparisons. That's why the ingest hung Node.
  //
  // The fix:
  //   - Build an in-memory Map<numericTail, gid> once at the start of
  //     ingest by streaming `SELECT id FROM recon_shopify_sales` (one
  //     full-scan, ~50ms for 50k rows). This is the index we need.
  //   - UPDATE by primary key `id = ?` (recon_shopify_sales.id is the
  //     PK — already indexed). Single B-tree lookup, microseconds each.
  //   - Process all rows in chunked transactions (CHUNK_SIZE) so the
  //     write lock doesn't hold for the entire window.
  //   - Log progress to server stdout so it's visible during long runs.
  // ---------------------------------------------------------------------

  // Step 1: build numeric-tail -> id Map by streaming all sale IDs once.
  // We only need rows whose happened_month overlaps [start, end) since
  // ShopifyQL's window will only return sales from that range. Pull a bit
  // wider (one calendar month either side) to handle any timezone fuzz on
  // the boundaries.
  const t1 = Date.now();
  const monthStart = start.slice(0, 7);
  const monthEnd = end.slice(0, 7);
  // Compute one month wider on each side for safety.
  const widenMonth = (m: string, delta: number) => {
    const [y, mm] = m.split("-").map(Number);
    const d = new Date(Date.UTC(y, mm - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const idIndexRows = sqlite
    .prepare(
      `SELECT id FROM recon_shopify_sales
        WHERE happened_month >= ? AND happened_month <= ?`,
    )
    .all(widenMonth(monthStart, -1), widenMonth(monthEnd, 1)) as Array<{
    id: string;
  }>;
  const numericToGid = new Map<string, string>();
  for (const row of idIndexRows) {
    const numeric = gidToNumeric(row.id);
    if (numeric) numericToGid.set(numeric, row.id);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[pos-locations] ${start}..${end} index built: ${numericToGid.size} sale gids in ${Date.now() - t1}ms`,
  );

  // Step 2: prepared statements outside the loop. UPDATE by PK —
  // microseconds per row.
  const update = sqlite.prepare(`
    UPDATE recon_shopify_sales
       SET pos_location_id   = ?,
           pos_location_name = ?,
           line_item_id      = COALESCE(?, line_item_id)
     WHERE id = ?
       AND (
              pos_location_id   IS NOT ?
           OR pos_location_name IS NOT ?
           OR (line_item_id IS NULL AND ? IS NOT NULL)
           )
  `);

  let updated = 0;
  let unchanged = 0;
  let unmatched = 0;

  // Step 3: chunked transactions. Each chunk commits its own write so
  // concurrent readers (e.g., the coverage endpoint, the UI's polling
  // queries) can interleave between chunks.
  const CHUNK_SIZE = 500;
  const totalChunks = Math.ceil(allRows.length / CHUNK_SIZE);
  const t2 = Date.now();

  const processChunk = sqlite.transaction((rows: QlSaleRow[]) => {
    for (const r of rows) {
      if (!r.sale_id) {
        unmatched++;
        continue;
      }
      const gid = numericToGid.get(r.sale_id);
      if (!gid) {
        unmatched++;
        continue;
      }
      const res = update.run(
        r.pos_location_id,
        r.pos_location_name,
        r.line_item_id,
        gid,
        r.pos_location_id,
        r.pos_location_name,
        r.line_item_id,
      );
      if (res.changes && res.changes > 0) {
        updated++;
      } else {
        unchanged++;
      }
    }
  });

  for (let i = 0; i < allRows.length; i += CHUNK_SIZE) {
    const chunk = allRows.slice(i, i + CHUNK_SIZE);
    processChunk(chunk);
    if (totalChunks > 1) {
      // eslint-disable-next-line no-console
      console.log(
        `[pos-locations] ${start}..${end} chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${totalChunks} done (${updated} updated, ${unchanged} unchanged, ${unmatched} unmatched, ${Date.now() - t2}ms total)`,
      );
    }
  }

  return {
    start,
    end,
    windows_ran: windowsRan,
    ql_rows_fetched: allRows.length,
    sales_updated: updated,
    sales_unchanged: unchanged,
    unmatched_ql_rows: unmatched,
    duration_ms: Date.now() - t0,
    warnings,
  };
}

/**
 * Coverage diagnostic — returns the fraction of recon_shopify_sales rows
 * in a YYYY-MM bucket that have pos_location_id populated, split by
 * line_type and source_name. Used by the validation endpoint to confirm
 * the ingest landed before we swap the by-store SQL to read from it.
 */
export function getPosLocationCoverage(month: string): {
  month: string;
  total_sales_rows: number;
  with_pos_location: number;
  without_pos_location: number;
  coverage_pct: number;
  by_source: Array<{
    source_name: string | null;
    total: number;
    with_pos_location: number;
    pct: number;
  }>;
} {
  ensureShopifyAgreementsSchema();
  const totals = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.pos_location_id IS NOT NULL THEN 1 ELSE 0 END) AS with_loc
         FROM recon_shopify_sales s
        WHERE s.happened_month = ?`,
    )
    .get(month) as { total: number; with_loc: number };
  const bySource = sqlite
    .prepare(
      `SELECT o.source_name AS source_name,
              COUNT(*) AS total,
              SUM(CASE WHEN s.pos_location_id IS NOT NULL THEN 1 ELSE 0 END) AS with_loc
         FROM recon_shopify_sales s
         JOIN recon_orders o ON o.id = s.order_id
        WHERE s.happened_month = ?
        GROUP BY o.source_name
        ORDER BY COUNT(*) DESC`,
    )
    .all(month) as Array<{
    source_name: string | null;
    total: number;
    with_loc: number;
  }>;
  const total = totals.total || 0;
  const withLoc = totals.with_loc || 0;
  return {
    month,
    total_sales_rows: total,
    with_pos_location: withLoc,
    without_pos_location: total - withLoc,
    coverage_pct: total > 0 ? Math.round((withLoc / total) * 10000) / 100 : 0,
    by_source: bySource.map((r) => ({
      source_name: r.source_name,
      total: r.total,
      with_pos_location: r.with_loc,
      pct: r.total > 0 ? Math.round((r.with_loc / r.total) * 10000) / 100 : 0,
    })),
  };
}
