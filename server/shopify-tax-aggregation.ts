/**
 * PR #143 — Sales tax aggregation (read-only query layer).
 *
 * Builds per-entity, per-jurisdiction tax aggregates from
 * `recon_line_items.tax_lines_json` for:
 *   - GET /api/recon/tax/by-entity/:month
 *   - GET /api/recon/tax/st810/:month
 *   - GET /api/recon/tax/st810/:quarter
 *
 * Source of truth: `recon_line_items.tax_lines_json` (per-jurisdiction tax
 * already broken out at ingest time — see shopify-recon-orders.ts:225-235).
 * Entity attribution mirrors the cascade in /api/recon/finance/by-store/:month
 * (pos_location_id → per-line allocation → order-level allocation → dominant
 * entity fallback). Lines that don't attribute fall into the "Unallocated"
 * bucket (entity_id=0); in steady state this should be ~$0.
 *
 * Numbers are aggregated as INTEGER CENTS internally and rendered as
 * fixed-2 strings at the response boundary to avoid float drift.
 *
 * Marketplace facilitator handling: any tax_line with channel_liable=true
 * was remitted by Shopify (Shop channel). Those sales are still included in
 * `gross_sales` (operator visibility) but bucketed into
 * `marketplace_gross` / `marketplace_tax` instead of `taxable_sales` /
 * `tax_due`. The merchant does not owe tax on them.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaxLine {
  title: string | null;
  rate: number | null;
  price: number | null;
  channel_liable: boolean;
  jurisdiction_id: string | null;
  jurisdiction_name: string | null;
  jurisdiction_type: string | null;
}

/**
 * Input shape for the pure aggregator. Decoupled from SQLite so the function
 * is unit-testable with hand-built fixtures.
 */
export interface LineForTax {
  /** entity_id from the attribution cascade. 0 = Unallocated. */
  entity_id: number;
  /** line subtotal in dollars: price*quantity - effectiveDiscount */
  line_subtotal: number;
  /** 1 if the line is gift card (non-taxable; tracked separately) */
  is_gift_card: number;
  /** 1 if the line's order/line is marketplace-facilitator */
  tax_channel_liable: number;
  /** Parsed tax_lines array (from tax_lines_json). May be empty. */
  tax_lines: TaxLine[];
}

/**
 * Refund input for the aggregator. PR #145 — subtracts refund tax from the
 * original selling entity's totals in the month the refund was processed.
 *
 * Source: `recon_refund_line_items` joined to `recon_refunds.processed_at`.
 * Bucketed by the REFUND's processed_at (not the original sale's date), so a
 * 2025-12 sale refunded in 2026-01 appears as a negative adjustment in
 * 2026-01 — matches Shopify Admin and by-store's `taxes` field.
 *
 * Per locked decisions:
 *   - entity attribution: original sale's entity (from the same allocator
 *     cascade we use for the sale line itself — looked up by line_item_id
 *     in the loader).
 *   - jurisdictions: original line's tax_lines_json, with each tax_line's
 *     price pro-rated by (refund_total_tax / sum_of_original_tax_lines_price).
 *     This preserves penny-exact subtraction at the entity level while
 *     splitting per-jurisdiction in proportion to the original.
 *   - line_subtotal_refunded: pre-tax refund subtotal (we subtract from
 *     gross_sales + taxable_sales / marketplace_gross).
 *   - tax_channel_liable: copied from the original line — marketplace
 *     refunds reduce `marketplace_tax_collected`, NOT `tax_owed`.
 */
export interface RefundForTax {
  /** entity_id from the original line's attribution. 0 = Unallocated. */
  entity_id: number;
  /** pre-tax refund subtotal (positive dollars; we negate internally) */
  line_subtotal_refunded: number;
  /** total refund tax (positive dollars; we negate internally) */
  refund_tax: number;
  /** 1 if the original line was marketplace-facilitator */
  tax_channel_liable: number;
  /**
   * Original line's tax_lines (already parsed) — used for per-jurisdiction
   * proportional subtraction. Empty array if the original line had no tax.
   */
  original_tax_lines: TaxLine[];
  /** true if the original sale was attributed via POS (pos_location_id) */
  is_pos: boolean;
}

export interface EntitySummary {
  entity_id: number;
  entity_name: string;
  gross_sales: string;            // gross dollars of all PRODUCT lines (including marketplace)
  non_taxable_sales: string;      // PRODUCT lines with no tax_lines, non-marketplace (e.g. exempt)
  taxable_sales: string;          // non-marketplace taxable subtotal
  tax_collected_gross: string;    // total tax collected including marketplace
  marketplace_gross: string;      // marketplace (channel_liable) sales subtotal
  marketplace_tax_collected: string; // tax Shopify remitted on marketplace lines
  tax_owed: string;               // tax owed by merchant = collected_gross - marketplace_tax
  pos_split: { gross: string; tax: string };
  allocated_split: { gross: string; tax: string };
}

export interface JurisdictionRow {
  jurisdiction_name: string;
  jurisdiction_type: string;
  rate: string;
  taxable_sales: string;
  tax_due: string;
  marketplace_taxable: string;
  marketplace_tax: string;
}

export interface EntityJurisdictionBreakdown {
  entity_id: number;
  entity_name: string;
  jurisdictions: JurisdictionRow[];
  totals: { taxable_sales: string; tax_due: string };
}

// ---------------------------------------------------------------------------
// Money helpers (integer cents — no float drift)
// ---------------------------------------------------------------------------

/** Convert dollars (possibly null/NaN) to integer cents. */
export function toCents(dollars: number | null | undefined): number {
  if (dollars == null || !Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

/** Convert integer cents to fixed-2 string for the response boundary. */
export function fromCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${neg ? '-' : ''}${whole}.${String(frac).padStart(2, '0')}`;
}

/** Parse tax_lines_json defensively. Empty array on any error. */
export function parseTaxLines(json: string | null | undefined): TaxLine[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.map((tl: any) => ({
      title: tl?.title ?? null,
      rate: typeof tl?.rate === 'number' ? tl.rate : tl?.rate != null ? Number(tl.rate) : null,
      price: typeof tl?.price === 'number' ? tl.price : tl?.price != null ? Number(tl.price) : null,
      channel_liable: Boolean(tl?.channel_liable),
      jurisdiction_id: tl?.jurisdiction_id ?? null,
      jurisdiction_name: tl?.jurisdiction_name ?? null,
      jurisdiction_type: tl?.jurisdiction_type ?? null,
    })).filter((tl: TaxLine) => tl.price !== null && Number.isFinite(tl.price));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pure aggregator: lines + POS membership → entity summary rows
// ---------------------------------------------------------------------------

/**
 * Aggregate per-entity tax data. POS vs Allocated split is driven by an
 * external predicate (caller decides — usually "did this line have a
 * pos_location_id?"). All other math is jurisdiction-agnostic.
 *
 * `entityNames` maps entity_id → display label. entity_id=0 means
 * "Unallocated" and the caller should pre-include it in the map.
 */
export interface AggregatorInput {
  line: LineForTax;
  /** true if this line was attributed via POS (pos_location_id), else allocated */
  is_pos: boolean;
}

interface EntityCents {
  gross: number;
  non_taxable: number;
  taxable: number;
  tax_collected: number;
  marketplace_gross: number;
  marketplace_tax: number;
  pos_gross: number;
  pos_tax: number;
  allocated_gross: number;
  allocated_tax: number;
}

function blankEntityCents(): EntityCents {
  return {
    gross: 0, non_taxable: 0, taxable: 0, tax_collected: 0,
    marketplace_gross: 0, marketplace_tax: 0,
    pos_gross: 0, pos_tax: 0, allocated_gross: 0, allocated_tax: 0,
  };
}

/**
 * Reduce a list of lines into per-entity totals. Gift-card lines are
 * excluded from every total (they're non-taxable and tracked elsewhere).
 *
 * Marketplace-facilitator rule: if ANY tax_line on a line has
 * channel_liable=true OR the line's tax_channel_liable=1, the line's
 * subtotal counts as marketplace_gross (NOT taxable_sales) and the line's
 * tax counts as marketplace_tax (NOT tax_due). This matches Shopify's
 * own treatment in Finance Summary.
 */
export function aggregateByEntity(
  inputs: AggregatorInput[],
  entityNames: Map<number, string>,
  refunds: RefundForTax[] = [],
): EntitySummary[] {
  const buckets = new Map<number, EntityCents>();

  for (const { line, is_pos } of inputs) {
    if (line.is_gift_card) continue;
    const eid = line.entity_id ?? 0;
    let b = buckets.get(eid);
    if (!b) { b = blankEntityCents(); buckets.set(eid, b); }

    const lineCents = toCents(line.line_subtotal);
    const lineTaxCents = line.tax_lines.reduce((acc, tl) => acc + toCents(tl.price), 0);
    const isMarketplace =
      Boolean(line.tax_channel_liable) ||
      line.tax_lines.some(tl => tl.channel_liable);

    b.gross += lineCents;
    b.tax_collected += lineTaxCents;

    if (isMarketplace) {
      b.marketplace_gross += lineCents;
      b.marketplace_tax += lineTaxCents;
    } else if (lineTaxCents > 0) {
      b.taxable += lineCents;
    } else {
      b.non_taxable += lineCents;
    }

    if (is_pos) {
      b.pos_gross += lineCents;
      b.pos_tax += lineTaxCents;
    } else {
      b.allocated_gross += lineCents;
      b.allocated_tax += lineTaxCents;
    }
  }

  // PR #145 — Subtract refund tax + refund subtotal from the original selling
  // entity, bucketed in the refund's month (the caller already filtered the
  // refunds array to the target month before passing it in).
  //
  // Marketplace refunds: tax_channel_liable=1 means the original sale was
  // facilitated by Shopify, so the refund tax reduces `marketplace_tax`
  // (Shopify will reverse the remittance) — NOT `tax_owed`. Mirrors the
  // forward-flow rule above.
  for (const r of refunds) {
    const eid = r.entity_id ?? 0;
    let b = buckets.get(eid);
    if (!b) { b = blankEntityCents(); buckets.set(eid, b); }

    const subCents = toCents(r.line_subtotal_refunded);
    const taxCents = toCents(r.refund_tax);
    const isMarketplace =
      Boolean(r.tax_channel_liable) ||
      r.original_tax_lines.some(tl => tl.channel_liable);

    b.gross -= subCents;
    b.tax_collected -= taxCents;

    if (isMarketplace) {
      b.marketplace_gross -= subCents;
      b.marketplace_tax -= taxCents;
    } else if (taxCents > 0) {
      b.taxable -= subCents;
    } else {
      b.non_taxable -= subCents;
    }

    if (r.is_pos) {
      b.pos_gross -= subCents;
      b.pos_tax -= taxCents;
    } else {
      b.allocated_gross -= subCents;
      b.allocated_tax -= taxCents;
    }
  }

  const out: EntitySummary[] = [];
  // Stable ordering: known POS entities first (by id), then Unallocated last.
  const ids = Array.from(buckets.keys()).sort((a, b) => {
    if (a === 0) return 1;
    if (b === 0) return -1;
    return a - b;
  });
  for (const eid of ids) {
    const b = buckets.get(eid)!;
    out.push({
      entity_id: eid,
      entity_name: entityNames.get(eid) ?? (eid === 0 ? 'Unallocated' : `Entity ${eid}`),
      gross_sales: fromCents(b.gross),
      non_taxable_sales: fromCents(b.non_taxable),
      taxable_sales: fromCents(b.taxable),
      tax_collected_gross: fromCents(b.tax_collected),
      marketplace_gross: fromCents(b.marketplace_gross),
      marketplace_tax_collected: fromCents(b.marketplace_tax),
      tax_owed: fromCents(b.tax_collected - b.marketplace_tax),
      pos_split: { gross: fromCents(b.pos_gross), tax: fromCents(b.pos_tax) },
      allocated_split: { gross: fromCents(b.allocated_gross), tax: fromCents(b.allocated_tax) },
    });
  }
  return out;
}

/** Sum a list of EntitySummary rows into a single totals row (entity_id=-1). */
export function sumEntities(entities: EntitySummary[]): EntitySummary {
  const acc: EntityCents = blankEntityCents();
  const addCents = (s: string) => Math.round(parseFloat(s) * 100);
  for (const e of entities) {
    acc.gross += addCents(e.gross_sales);
    acc.non_taxable += addCents(e.non_taxable_sales);
    acc.taxable += addCents(e.taxable_sales);
    acc.tax_collected += addCents(e.tax_collected_gross);
    acc.marketplace_gross += addCents(e.marketplace_gross);
    acc.marketplace_tax += addCents(e.marketplace_tax_collected);
    acc.pos_gross += addCents(e.pos_split.gross);
    acc.pos_tax += addCents(e.pos_split.tax);
    acc.allocated_gross += addCents(e.allocated_split.gross);
    acc.allocated_tax += addCents(e.allocated_split.tax);
  }
  return {
    entity_id: -1,
    entity_name: 'TOTAL',
    gross_sales: fromCents(acc.gross),
    non_taxable_sales: fromCents(acc.non_taxable),
    taxable_sales: fromCents(acc.taxable),
    tax_collected_gross: fromCents(acc.tax_collected),
    marketplace_gross: fromCents(acc.marketplace_gross),
    marketplace_tax_collected: fromCents(acc.marketplace_tax),
    tax_owed: fromCents(acc.tax_collected - acc.marketplace_tax),
    pos_split: { gross: fromCents(acc.pos_gross), tax: fromCents(acc.pos_tax) },
    allocated_split: { gross: fromCents(acc.allocated_gross), tax: fromCents(acc.allocated_tax) },
  };
}

// ---------------------------------------------------------------------------
// Per-jurisdiction aggregator for ST-810
// ---------------------------------------------------------------------------

interface JurKey {
  name: string;
  type: string;
  rate: string; // canonical rate string (4dp) — groups jurisdictions per rate
}

interface JurCents {
  taxable: number;
  tax_due: number;
  marketplace_taxable: number;
  marketplace_tax: number;
}

function canonRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '0';
  // Up to 5 decimal places — covers 0.00375 (MCTD) cleanly.
  return rate.toFixed(5).replace(/\.?0+$/, '') || '0';
}

/**
 * Group lines by (entity, jurisdiction_name, jurisdiction_type, rate).
 * For each jurisdiction, sum taxable_sales (the line subtotal) and tax_due
 * (the tax_line.price).
 *
 * Important: a line may have multiple tax_lines (state + county + MCTD).
 * Each tax_line contributes the LINE'S subtotal to its jurisdiction's
 * taxable_sales — this is how ST-810 works: the same taxable sale is
 * reported under State, County, and Special Districts independently.
 *
 * For marketplace-facilitator lines, the subtotal + tax goes into
 * `marketplace_*` columns; merchant doesn't owe but must still report.
 */
export function aggregateByJurisdiction(
  inputs: AggregatorInput[],
  entityNames: Map<number, string>,
  refunds: RefundForTax[] = [],
): EntityJurisdictionBreakdown[] {
  // entity_id → Map<jur-key-string, JurCents>
  const perEntity = new Map<number, Map<string, JurCents & JurKey>>();

  for (const { line } of inputs) {
    if (line.is_gift_card) continue;
    if (line.tax_lines.length === 0) continue; // non-taxable line — no jurisdiction
    const eid = line.entity_id ?? 0;
    let jurMap = perEntity.get(eid);
    if (!jurMap) { jurMap = new Map(); perEntity.set(eid, jurMap); }

    const lineSubCents = toCents(line.line_subtotal);
    const lineIsMarketplace = Boolean(line.tax_channel_liable);

    for (const tl of line.tax_lines) {
      const name = (tl.jurisdiction_name || tl.title || 'UNKNOWN').toString().toUpperCase();
      const type = (tl.jurisdiction_type || inferType(name)).toString().toUpperCase();
      const rate = canonRate(tl.rate);
      const key = `${name}|${type}|${rate}`;
      let bucket = jurMap.get(key);
      if (!bucket) {
        bucket = {
          name, type, rate,
          taxable: 0, tax_due: 0,
          marketplace_taxable: 0, marketplace_tax: 0,
        };
        jurMap.set(key, bucket);
      }
      const isMp = lineIsMarketplace || tl.channel_liable;
      const taxCents = toCents(tl.price);
      if (isMp) {
        bucket.marketplace_taxable += lineSubCents;
        bucket.marketplace_tax += taxCents;
      } else {
        bucket.taxable += lineSubCents;
        bucket.tax_due += taxCents;
      }
    }
  }

  // PR #145 — Subtract refunds per-jurisdiction. The refund's total tax is
  // distributed across the ORIGINAL line's jurisdictions in proportion to
  // each jurisdiction's share of the original line's tax. Penny-exact: the
  // largest share absorbs the cumulative rounding remainder so that the sum
  // of subtracted per-jurisdiction tax equals the refund's total tax exactly.
  //
  // Same logic for `taxable_sales`: the refund subtotal is allocated 1× to
  // each jurisdiction's `taxable_sales` (mirrors the forward flow where every
  // jurisdiction reports the same line subtotal as its taxable_sales).
  for (const r of refunds) {
    if (r.original_tax_lines.length === 0) continue; // no jurisdictions to attribute to
    const eid = r.entity_id ?? 0;
    let jurMap = perEntity.get(eid);
    if (!jurMap) { jurMap = new Map(); perEntity.set(eid, jurMap); }

    const subCents = toCents(r.line_subtotal_refunded);
    const totalRefundTaxCents = toCents(r.refund_tax);
    const origTaxCentsTotal = r.original_tax_lines.reduce((acc, tl) => acc + toCents(tl.price), 0);
    const refundIsMarketplace =
      Boolean(r.tax_channel_liable) ||
      r.original_tax_lines.some(tl => tl.channel_liable);

    // Pro-rate refund tax per original tax_line.price. Allocate to all but
    // the LAST jurisdiction, then assign the remainder to the last entry so
    // the per-jurisdiction subtractions sum penny-exact to totalRefundTaxCents.
    const perJurRefundCents: number[] = new Array(r.original_tax_lines.length).fill(0);
    if (origTaxCentsTotal > 0 && totalRefundTaxCents !== 0) {
      let allocated = 0;
      for (let i = 0; i < r.original_tax_lines.length - 1; i++) {
        const share = Math.round(
          (toCents(r.original_tax_lines[i].price) * totalRefundTaxCents) / origTaxCentsTotal,
        );
        perJurRefundCents[i] = share;
        allocated += share;
      }
      perJurRefundCents[r.original_tax_lines.length - 1] = totalRefundTaxCents - allocated;
    }

    for (let i = 0; i < r.original_tax_lines.length; i++) {
      const tl = r.original_tax_lines[i];
      const name = (tl.jurisdiction_name || tl.title || 'UNKNOWN').toString().toUpperCase();
      const type = (tl.jurisdiction_type || inferType(name)).toString().toUpperCase();
      const rate = canonRate(tl.rate);
      const key = `${name}|${type}|${rate}`;
      let bucket = jurMap.get(key);
      if (!bucket) {
        bucket = {
          name, type, rate,
          taxable: 0, tax_due: 0,
          marketplace_taxable: 0, marketplace_tax: 0,
        };
        jurMap.set(key, bucket);
      }
      const isMp = refundIsMarketplace || tl.channel_liable;
      const refundTaxThisJur = perJurRefundCents[i];
      if (isMp) {
        bucket.marketplace_taxable -= subCents;
        bucket.marketplace_tax -= refundTaxThisJur;
      } else {
        bucket.taxable -= subCents;
        bucket.tax_due -= refundTaxThisJur;
      }
    }
  }

  const out: EntityJurisdictionBreakdown[] = [];
  const eids = Array.from(perEntity.keys()).sort((a, b) => {
    if (a === 0) return 1;
    if (b === 0) return -1;
    return a - b;
  });
  for (const eid of eids) {
    const jurMap = perEntity.get(eid)!;
    const jurisdictions: JurisdictionRow[] = Array.from(jurMap.values())
      .sort((a, b) => {
        // STATE → COUNTY → SPECIAL → other, then by name
        const order = (t: string) => t === 'STATE' ? 0 : t === 'COUNTY' ? 1 : t === 'SPECIAL' ? 2 : 3;
        const d = order(a.type) - order(b.type);
        return d !== 0 ? d : a.name.localeCompare(b.name);
      })
      .map(j => ({
        jurisdiction_name: j.name,
        jurisdiction_type: j.type,
        rate: j.rate,
        taxable_sales: fromCents(j.taxable),
        tax_due: fromCents(j.tax_due),
        marketplace_taxable: fromCents(j.marketplace_taxable),
        marketplace_tax: fromCents(j.marketplace_tax),
      }));
    const totals = Array.from(jurMap.values()).reduce(
      (acc, j) => ({ taxable: acc.taxable + j.taxable, tax_due: acc.tax_due + j.tax_due }),
      { taxable: 0, tax_due: 0 },
    );
    out.push({
      entity_id: eid,
      entity_name: entityNames.get(eid) ?? (eid === 0 ? 'Unallocated' : `Entity ${eid}`),
      jurisdictions,
      totals: { taxable_sales: fromCents(totals.taxable), tax_due: fromCents(totals.tax_due) },
    });
  }
  return out;
}

/** Heuristic when jurisdiction_type isn't supplied (older Shopify rows). */
function inferType(name: string): string {
  const u = name.toUpperCase();
  if (u.includes('MCTD') || u.includes('METROPOLITAN') || u.includes('MTA')) return 'SPECIAL';
  if (u.includes('COUNTY')) return 'COUNTY';
  if (u.includes('STATE') || u === 'NY' || u === 'NEW YORK') return 'STATE';
  return 'OTHER';
}

// ---------------------------------------------------------------------------
// NY sales tax quarter calendar
// ---------------------------------------------------------------------------

/**
 * NY State sales tax filing quarters are NON-STANDARD: they shift by one
 * month vs calendar quarters. Filed at the end of the third month.
 *
 *   Q1 = Mar / Apr / May   (filed by 2026-06-20 etc.)
 *   Q2 = Jun / Jul / Aug
 *   Q3 = Sep / Oct / Nov
 *   Q4 = Dec / Jan / Feb   (← spans year boundary; Dec belongs to the
 *                            following year's Q4 in NY terminology — i.e.
 *                            "2026-Q4" = Dec 2026, Jan 2027, Feb 2027.
 *                            See NY DTF Pub 718-Q.)
 *
 * Verified against NY DTF ST-810 instructions (Form ST-810-I). If you
 * disagree, change DEFAULT_TO_CALENDAR=true below and the endpoint will
 * fall back to calendar quarters with a TODO marker in the response.
 */
const NY_QUARTER_START_MONTH: Record<string, number> = {
  Q1: 3, Q2: 6, Q3: 9, Q4: 12,
};

export function quarterToMonths(quarter: string): { months: string[]; calendar_fallback: boolean } {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) throw new Error(`Bad quarter: ${quarter} (want YYYY-Q[1-4])`);
  const year = parseInt(m[1], 10);
  const qNum = parseInt(m[2], 10);
  const startMonth = NY_QUARTER_START_MONTH[`Q${qNum}` as keyof typeof NY_QUARTER_START_MONTH];
  const months: string[] = [];
  for (let i = 0; i < 3; i++) {
    let mo = startMonth + i;
    let yr = year;
    if (mo > 12) { mo -= 12; yr += 1; }
    months.push(`${yr}-${String(mo).padStart(2, '0')}`);
  }
  return { months, calendar_fallback: false };
}
