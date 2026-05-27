/**
 * PR #143 — Unit tests for shopify-tax-aggregation.ts.
 *
 * No test framework in this repo. Run with: `npx tsx script/test-tax-aggregation.ts`.
 * Exits non-zero on any failure.
 */

import {
  aggregateByEntity,
  aggregateByJurisdiction,
  fromCents,
  parseTaxLines,
  quarterToMonths,
  sumEntities,
  toCents,
  type AggregatorInput,
  type LineForTax,
  type RefundForTax,
  type ShippingTaxForward,
  type ShippingTaxRefund,
  type TaxLine,
  type UnverifiedReturnTax,
} from "../server/shopify-tax-aggregation";

let failed = 0;
let passed = 0;

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL ${label}\n  actual:   ${a}\n  expected: ${e}`);
}

function assert(cond: boolean, label: string) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`FAIL ${label}`);
}

const names = new Map<number, string>([
  [0, 'Unallocated'],
  [1, 'Greenvale'],
  [2, 'Huntington'],
  [3, 'Hempstead'],
]);

// Helpers
function line(opts: Partial<LineForTax>): LineForTax {
  return {
    entity_id: 1,
    line_subtotal: 100,
    is_gift_card: 0,
    tax_channel_liable: 0,
    tax_lines: [],
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------
eq(toCents(12.34), 1234, "toCents 12.34");
eq(toCents(0), 0, "toCents 0");
eq(toCents(null), 0, "toCents null");
eq(toCents(NaN), 0, "toCents NaN");
eq(toCents(-5.55), -555, "toCents negative");
// Floating-point classic — 0.1 + 0.2 = 0.30000000000000004, integer cents fixes this.
eq(toCents(0.1) + toCents(0.2), 30, "toCents avoids float drift");
eq(fromCents(1234), "12.34", "fromCents 1234");
eq(fromCents(0), "0.00", "fromCents 0");
eq(fromCents(5), "0.05", "fromCents 5 cents");
eq(fromCents(-555), "-5.55", "fromCents negative");

// ---------------------------------------------------------------------------
// parseTaxLines
// ---------------------------------------------------------------------------
const tlsGood = parseTaxLines(JSON.stringify([
  { title: "NY State", rate: 0.04, price: 4.0, channel_liable: false, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE" },
  { title: "Nassau County", rate: 0.0425, price: 4.25, channel_liable: false, jurisdiction_name: "NASSAU COUNTY", jurisdiction_type: "COUNTY" },
]));
eq(tlsGood.length, 2, "parseTaxLines 2 entries");
eq(tlsGood[0].rate, 0.04, "parseTaxLines preserves rate");
eq(parseTaxLines(null), [], "parseTaxLines null");
eq(parseTaxLines(""), [], "parseTaxLines empty");
eq(parseTaxLines("not json"), [], "parseTaxLines malformed");
eq(parseTaxLines('{"not":"array"}'), [], "parseTaxLines non-array");

// ---------------------------------------------------------------------------
// aggregateByEntity — single line, single jurisdiction
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 1,
      line_subtotal: 100,
      tax_lines: [{ title: "NY", rate: 0.04, price: 4.0, channel_liable: false,
                    jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE" }],
    }),
    is_pos: true,
  }];
  const result = aggregateByEntity(inputs, names);
  eq(result.length, 1, "aggregate: one entity");
  eq(result[0].entity_id, 1, "aggregate: entity_id 1");
  eq(result[0].entity_name, "Greenvale", "aggregate: name");
  eq(result[0].gross_sales, "100.00", "aggregate: gross");
  eq(result[0].taxable_sales, "100.00", "aggregate: taxable");
  eq(result[0].tax_collected_gross, "4.00", "aggregate: tax_collected");
  eq(result[0].tax_owed, "4.00", "aggregate: tax_owed (no marketplace)");
  eq(result[0].marketplace_gross, "0.00", "aggregate: marketplace_gross zero");
  eq(result[0].pos_split, { gross: "100.00", tax: "4.00" }, "aggregate: POS split");
  eq(result[0].allocated_split, { gross: "0.00", tax: "0.00" }, "aggregate: allocated split empty");
}

// ---------------------------------------------------------------------------
// aggregateByEntity — marketplace facilitator: excluded from tax_owed
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 2,
      line_subtotal: 200,
      tax_channel_liable: 1,
      tax_lines: [{ title: "NY", rate: 0.04, price: 8.0, channel_liable: true,
                    jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE" }],
    }),
    is_pos: false,
  }];
  const result = aggregateByEntity(inputs, names);
  eq(result[0].entity_id, 2, "marketplace: entity_id");
  eq(result[0].gross_sales, "200.00", "marketplace: gross includes marketplace");
  eq(result[0].marketplace_gross, "200.00", "marketplace: marketplace_gross");
  eq(result[0].taxable_sales, "0.00", "marketplace: taxable=0 (channel_liable)");
  eq(result[0].tax_collected_gross, "8.00", "marketplace: collected_gross still includes mp");
  eq(result[0].marketplace_tax_collected, "8.00", "marketplace: marketplace_tax");
  eq(result[0].tax_owed, "0.00", "marketplace: tax_owed = 0 (Shopify already remitted)");
}

// ---------------------------------------------------------------------------
// aggregateByEntity — mixed channel_liable order
// (some lines marketplace, some not, same entity)
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [
    {
      line: line({
        entity_id: 1, line_subtotal: 100, tax_channel_liable: 0,
        tax_lines: [{ title: "NY", rate: 0.04, price: 4.0, channel_liable: false,
                      jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE" }],
      }),
      is_pos: false,
    },
    {
      line: line({
        entity_id: 1, line_subtotal: 50, tax_channel_liable: 1,
        tax_lines: [{ title: "NY", rate: 0.04, price: 2.0, channel_liable: true,
                      jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE" }],
      }),
      is_pos: false,
    },
  ];
  const result = aggregateByEntity(inputs, names);
  eq(result.length, 1, "mixed: one entity");
  eq(result[0].gross_sales, "150.00", "mixed: total gross");
  eq(result[0].taxable_sales, "100.00", "mixed: only non-marketplace is taxable");
  eq(result[0].marketplace_gross, "50.00", "mixed: marketplace portion");
  eq(result[0].tax_collected_gross, "6.00", "mixed: collected = 4 + 2");
  eq(result[0].marketplace_tax_collected, "2.00", "mixed: marketplace tax = 2");
  eq(result[0].tax_owed, "4.00", "mixed: owed = collected - marketplace");
}

// ---------------------------------------------------------------------------
// aggregateByEntity — gift cards excluded
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [
    {
      line: line({ entity_id: 1, line_subtotal: 100, is_gift_card: 1 }),
      is_pos: true,
    },
    {
      line: line({ entity_id: 1, line_subtotal: 50, is_gift_card: 0 }),
      is_pos: true,
    },
  ];
  const result = aggregateByEntity(inputs, names);
  eq(result[0].gross_sales, "50.00", "gift cards excluded from gross");
}

// ---------------------------------------------------------------------------
// aggregateByEntity — non-taxable (no tax_lines, not marketplace)
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({ entity_id: 1, line_subtotal: 100, tax_lines: [] }),
    is_pos: true,
  }];
  const result = aggregateByEntity(inputs, names);
  eq(result[0].gross_sales, "100.00", "non-tax: gross");
  eq(result[0].non_taxable_sales, "100.00", "non-tax: non_taxable bucket");
  eq(result[0].taxable_sales, "0.00", "non-tax: taxable=0");
  eq(result[0].tax_collected_gross, "0.00", "non-tax: tax=0");
}

// ---------------------------------------------------------------------------
// aggregateByEntity — ordering: POS entities first, Unallocated last
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [
    { line: line({ entity_id: 0, line_subtotal: 10 }), is_pos: false },
    { line: line({ entity_id: 3, line_subtotal: 10 }), is_pos: true },
    { line: line({ entity_id: 1, line_subtotal: 10 }), is_pos: true },
    { line: line({ entity_id: 2, line_subtotal: 10 }), is_pos: true },
  ];
  const result = aggregateByEntity(inputs, names);
  eq(result.map(e => e.entity_id), [1, 2, 3, 0], "ordering: 1,2,3,Unallocated");
}

// ---------------------------------------------------------------------------
// sumEntities
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [
    { line: line({ entity_id: 1, line_subtotal: 100,
                   tax_lines: [{ title: "NY", rate: 0.04, price: 4, channel_liable: false,
                                 jurisdiction_id: null, jurisdiction_name: "NY STATE", jurisdiction_type: "STATE" }] }),
      is_pos: true },
    { line: line({ entity_id: 2, line_subtotal: 200,
                   tax_lines: [{ title: "NY", rate: 0.04, price: 8, channel_liable: false,
                                 jurisdiction_id: null, jurisdiction_name: "NY STATE", jurisdiction_type: "STATE" }] }),
      is_pos: false },
  ];
  const ents = aggregateByEntity(inputs, names);
  const totals = sumEntities(ents);
  eq(totals.gross_sales, "300.00", "totals: gross");
  eq(totals.tax_collected_gross, "12.00", "totals: tax");
  eq(totals.taxable_sales, "300.00", "totals: taxable");
  eq(totals.pos_split.gross, "100.00", "totals: pos split");
  eq(totals.allocated_split.gross, "200.00", "totals: alloc split");
}

// ---------------------------------------------------------------------------
// aggregateByJurisdiction — split state + county + MCTD on one line
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 1,
      line_subtotal: 100,
      tax_lines: [
        { title: "NY State", rate: 0.04, price: 4.00, channel_liable: false,
          jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE" },
        { title: "Nassau County", rate: 0.0425, price: 4.25, channel_liable: false,
          jurisdiction_id: null, jurisdiction_name: "NASSAU COUNTY", jurisdiction_type: "COUNTY" },
        { title: "MCTD", rate: 0.00375, price: 0.38, channel_liable: false,
          jurisdiction_id: null, jurisdiction_name: "MCTD", jurisdiction_type: "SPECIAL" },
      ],
    }),
    is_pos: true,
  }];
  const result = aggregateByJurisdiction(inputs, names);
  eq(result.length, 1, "jur: one entity");
  eq(result[0].jurisdictions.length, 3, "jur: 3 jurisdictions");
  // Ordering: STATE → COUNTY → SPECIAL
  eq(result[0].jurisdictions[0].jurisdiction_type, "STATE", "jur: STATE first");
  eq(result[0].jurisdictions[1].jurisdiction_type, "COUNTY", "jur: COUNTY second");
  eq(result[0].jurisdictions[2].jurisdiction_type, "SPECIAL", "jur: SPECIAL third");
  // Each jurisdiction reports the SAME taxable_sales (= line subtotal).
  eq(result[0].jurisdictions[0].taxable_sales, "100.00", "jur: STATE taxable");
  eq(result[0].jurisdictions[1].taxable_sales, "100.00", "jur: COUNTY taxable");
  eq(result[0].jurisdictions[2].taxable_sales, "100.00", "jur: SPECIAL taxable");
  // tax_due per jurisdiction
  eq(result[0].jurisdictions[0].tax_due, "4.00", "jur: STATE tax_due");
  eq(result[0].jurisdictions[1].tax_due, "4.25", "jur: COUNTY tax_due");
  eq(result[0].jurisdictions[2].tax_due, "0.38", "jur: SPECIAL tax_due");
  // Totals (sum across jurisdictions)
  eq(result[0].totals.tax_due, "8.63", "jur: totals tax_due (4 + 4.25 + 0.38)");
}

// ---------------------------------------------------------------------------
// aggregateByJurisdiction — channel_liable goes to marketplace_* not tax_due
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 1, line_subtotal: 100, tax_channel_liable: 1,
      tax_lines: [
        { title: "NY", rate: 0.04, price: 4.00, channel_liable: true,
          jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE" },
      ],
    }),
    is_pos: false,
  }];
  const result = aggregateByJurisdiction(inputs, names);
  eq(result[0].jurisdictions[0].taxable_sales, "0.00", "jur mp: taxable=0");
  eq(result[0].jurisdictions[0].tax_due, "0.00", "jur mp: tax_due=0");
  eq(result[0].jurisdictions[0].marketplace_taxable, "100.00", "jur mp: marketplace_taxable");
  eq(result[0].jurisdictions[0].marketplace_tax, "4.00", "jur mp: marketplace_tax");
}

// ---------------------------------------------------------------------------
// aggregateByJurisdiction — mixed channel_liable on same jurisdiction
// (two lines, same NY STATE rate, one mp + one not — must group into one row)
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [
    { line: line({
        entity_id: 1, line_subtotal: 100, tax_channel_liable: 0,
        tax_lines: [{ title: "NY", rate: 0.04, price: 4, channel_liable: false,
                      jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE" }] }),
      is_pos: true },
    { line: line({
        entity_id: 1, line_subtotal: 50, tax_channel_liable: 1,
        tax_lines: [{ title: "NY", rate: 0.04, price: 2, channel_liable: true,
                      jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE" }] }),
      is_pos: false },
  ];
  const result = aggregateByJurisdiction(inputs, names);
  eq(result[0].jurisdictions.length, 1, "jur mixed: grouped into one row");
  eq(result[0].jurisdictions[0].taxable_sales, "100.00", "jur mixed: non-mp portion");
  eq(result[0].jurisdictions[0].tax_due, "4.00", "jur mixed: non-mp tax");
  eq(result[0].jurisdictions[0].marketplace_taxable, "50.00", "jur mixed: mp portion");
  eq(result[0].jurisdictions[0].marketplace_tax, "2.00", "jur mixed: mp tax");
}

// ---------------------------------------------------------------------------
// aggregateByJurisdiction — different rates → different rows
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [
    { line: line({
        entity_id: 1, line_subtotal: 100,
        tax_lines: [{ title: "Nassau", rate: 0.0425, price: 4.25, channel_liable: false,
                      jurisdiction_id: null, jurisdiction_name: "NASSAU COUNTY", jurisdiction_type: "COUNTY" }] }),
      is_pos: true },
    { line: line({
        entity_id: 1, line_subtotal: 100,
        tax_lines: [{ title: "Suffolk", rate: 0.0425, price: 4.25, channel_liable: false,
                      jurisdiction_id: null, jurisdiction_name: "SUFFOLK COUNTY", jurisdiction_type: "COUNTY" }] }),
      is_pos: true },
  ];
  const result = aggregateByJurisdiction(inputs, names);
  eq(result[0].jurisdictions.length, 2, "jur counties: 2 separate rows");
}

// ---------------------------------------------------------------------------
// quarterToMonths
// ---------------------------------------------------------------------------
eq(quarterToMonths("2026-Q1").months, ["2026-03", "2026-04", "2026-05"], "Q1=Mar-May");
eq(quarterToMonths("2026-Q2").months, ["2026-06", "2026-07", "2026-08"], "Q2=Jun-Aug");
eq(quarterToMonths("2026-Q3").months, ["2026-09", "2026-10", "2026-11"], "Q3=Sep-Nov");
eq(quarterToMonths("2026-Q4").months, ["2026-12", "2027-01", "2027-02"], "Q4=Dec-Feb (spans year)");

let threw = false;
try { quarterToMonths("2026-Q5"); } catch { threw = true; }
assert(threw, "quarterToMonths invalid format throws");

// ---------------------------------------------------------------------------
// PR #145 — Refund tax subtraction.
// ---------------------------------------------------------------------------

// Standard NY blended jurisdictions used by refund tests below.
const NY_STATE_TL = (price: number): TaxLine => ({
  title: "NY State", rate: 0.04, price, channel_liable: false,
  jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE",
});
const NASSAU_TL = (price: number): TaxLine => ({
  title: "Nassau County", rate: 0.0425, price, channel_liable: false,
  jurisdiction_id: null, jurisdiction_name: "NASSAU COUNTY", jurisdiction_type: "COUNTY",
});
const MCTD_TL = (price: number): TaxLine => ({
  title: "MCTD", rate: 0.00375, price, channel_liable: false,
  jurisdiction_id: null, jurisdiction_name: "MCTD", jurisdiction_type: "SPECIAL",
});

function refund(opts: Partial<RefundForTax>): RefundForTax {
  return {
    entity_id: 1,
    line_subtotal_refunded: 0,
    refund_tax: 0,
    tax_channel_liable: 0,
    original_tax_lines: [],
    is_pos: true,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// PR #145 #1 — Full refund subtracts from tax_owed correctly.
// ---------------------------------------------------------------------------
{
  // Sale: $100 line w/ $8.63 NY blended tax (4 + 4.25 + 0.38).
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 1, line_subtotal: 100,
      tax_lines: [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)],
    }),
    is_pos: true,
  }];
  // Refund: full line refund.
  const refunds: RefundForTax[] = [refund({
    entity_id: 1,
    line_subtotal_refunded: 100,
    refund_tax: 8.63,
    original_tax_lines: [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)],
    is_pos: true,
  })];
  const result = aggregateByEntity(inputs, names, refunds);
  eq(result[0].gross_sales, "0.00", "refund full: gross goes to 0");
  eq(result[0].taxable_sales, "0.00", "refund full: taxable goes to 0");
  eq(result[0].tax_collected_gross, "0.00", "refund full: tax_collected goes to 0");
  eq(result[0].tax_owed, "0.00", "refund full: tax_owed goes to 0");
  eq(result[0].pos_split, { gross: "0.00", tax: "0.00" }, "refund full: POS split nets to 0");
}

// ---------------------------------------------------------------------------
// PR #145 #2 — Partial refund (qty=2 of qty=5) pro-rates to 40%.
// The aggregator just consumes the refund's subtotal+tax (already pre-computed
// upstream by Shopify), so we verify that a 40%-magnitude refund subtracts
// exactly 40% of the gross/tax. Original: $500 sale, $43.13 tax across the
// blended NY jurisdictions ($20 + $21.25 + $1.88). Refund: $200, $17.25.
// ---------------------------------------------------------------------------
{
  const origTLs = [NY_STATE_TL(20.00), NASSAU_TL(21.25), MCTD_TL(1.88)];
  const inputs: AggregatorInput[] = [{
    line: line({ entity_id: 1, line_subtotal: 500, tax_lines: origTLs }),
    is_pos: true,
  }];
  const refunds: RefundForTax[] = [refund({
    entity_id: 1,
    line_subtotal_refunded: 200,      // 40% of 500
    refund_tax: 17.25,                // 40% of 43.13 (rounded)
    original_tax_lines: origTLs,
    is_pos: true,
  })];
  const result = aggregateByEntity(inputs, names, refunds);
  eq(result[0].gross_sales, "300.00", "partial refund: gross = 500 - 200");
  eq(result[0].taxable_sales, "300.00", "partial refund: taxable = 500 - 200");
  eq(result[0].tax_collected_gross, "25.88", "partial refund: tax = 43.13 - 17.25");
  eq(result[0].tax_owed, "25.88", "partial refund: owed = 43.13 - 17.25");
  eq(result[0].pos_split, { gross: "300.00", tax: "25.88" }, "partial refund: POS net");
}

// ---------------------------------------------------------------------------
// PR #145 #3 — Marketplace refund flows to marketplace_tax_collected (NOT tax_owed).
// Mirrors the forward rule: channel_liable lines are excluded from merchant
// tax liability, so refunds on those lines should also be excluded.
// ---------------------------------------------------------------------------
{
  const origMpTLs: TaxLine[] = [{
    title: "NY", rate: 0.08, price: 8.00, channel_liable: true,
    jurisdiction_id: null, jurisdiction_name: "NEW YORK STATE", jurisdiction_type: "STATE",
  }];
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 2, line_subtotal: 100, tax_channel_liable: 1,
      tax_lines: origMpTLs,
    }),
    is_pos: false,
  }];
  const refunds: RefundForTax[] = [refund({
    entity_id: 2,
    line_subtotal_refunded: 50,
    refund_tax: 4.00,
    tax_channel_liable: 1,
    original_tax_lines: origMpTLs,
    is_pos: false,
  })];
  const result = aggregateByEntity(inputs, names, refunds);
  eq(result[0].marketplace_gross, "50.00", "mp refund: marketplace_gross = 100 - 50");
  eq(result[0].marketplace_tax_collected, "4.00", "mp refund: marketplace_tax = 8 - 4");
  eq(result[0].taxable_sales, "0.00", "mp refund: taxable unaffected (was 0)");
  eq(result[0].tax_owed, "0.00", "mp refund: tax_owed stays 0 (was 0)");
  eq(result[0].tax_collected_gross, "4.00", "mp refund: collected_gross reduced");
}

// ---------------------------------------------------------------------------
// PR #145 #4 — Cross-month refund: refund subtracted in refund-month bucket only.
// The aggregator is month-agnostic; bucketing is done by the LOADER. We verify
// here that passing ONLY the refund (no original sale line) still produces a
// negative tax_collected_gross — proving that a 2025-12 sale refunded in
// 2026-01 will correctly show as a negative adjustment in 2026-01's aggregate
// without any echo of the sale's positive tax.
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = []; // no sale this month
  const refunds: RefundForTax[] = [refund({
    entity_id: 3,
    line_subtotal_refunded: 120,
    refund_tax: 10.35,
    original_tax_lines: [NY_STATE_TL(4.80), NASSAU_TL(5.10), MCTD_TL(0.45)],
    is_pos: true,
  })];
  const result = aggregateByEntity(inputs, names, refunds);
  eq(result.length, 1, "cross-month: one entity bucket created");
  eq(result[0].entity_id, 3, "cross-month: entity_id 3 (Hempstead)");
  eq(result[0].gross_sales, "-120.00", "cross-month: gross goes negative");
  eq(result[0].tax_collected_gross, "-10.35", "cross-month: tax_collected goes negative");
  eq(result[0].tax_owed, "-10.35", "cross-month: tax_owed goes negative");
  // Validates the user's "Hempstead 2026-04 = -$10.35" production case.
}

// ---------------------------------------------------------------------------
// PR #145 #5 — Per-jurisdiction refund split is penny-exact across jurisdictions.
// Refund of $8.63 split across (NY State $4.00) + (Nassau $4.25) + (MCTD $0.38).
// The aggregator pro-rates by the original line's tax_lines.price and assigns
// rounding remainder to the last bucket. Verify sum equals refund_tax exactly.
// ---------------------------------------------------------------------------
{
  const origTLs = [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)];
  // Two lines = $200 taxable, $17.26 tax pre-refund
  const inputs: AggregatorInput[] = [
    { line: line({ entity_id: 1, line_subtotal: 100, tax_lines: origTLs }), is_pos: true },
    { line: line({ entity_id: 1, line_subtotal: 100, tax_lines: origTLs }), is_pos: true },
  ];
  // Refund one line.
  const refunds: RefundForTax[] = [refund({
    entity_id: 1,
    line_subtotal_refunded: 100,
    refund_tax: 8.63,
    original_tax_lines: origTLs,
    is_pos: true,
  })];
  const result = aggregateByJurisdiction(inputs, names, refunds);
  eq(result[0].jurisdictions.length, 3, "jur refund: still 3 jurisdictions");
  // Each jurisdiction's taxable should be 200 (2 sales) - 100 (refund) = 100.
  for (const j of result[0].jurisdictions) {
    eq(j.taxable_sales, "100.00", `jur refund: ${j.jurisdiction_type} taxable=100`);
  }
  // Per-jurisdiction tax: original-line shares are 4.00, 4.25, 0.38 (sum 8.63).
  // Two-line tax total = 8.00 + 8.50 + 0.76 = 17.26. After refund of 8.63 it
  // should equal exactly: NY State 4.00, Nassau 4.25, MCTD 0.38.
  const state = result[0].jurisdictions.find(j => j.jurisdiction_type === "STATE")!;
  const county = result[0].jurisdictions.find(j => j.jurisdiction_type === "COUNTY")!;
  const mctd = result[0].jurisdictions.find(j => j.jurisdiction_type === "SPECIAL")!;
  eq(state.tax_due, "4.00", "jur refund: STATE tax_due = 8 - 4");
  eq(county.tax_due, "4.25", "jur refund: COUNTY tax_due = 8.50 - 4.25");
  eq(mctd.tax_due, "0.38", "jur refund: MCTD tax_due = 0.76 - 0.38");
  // Total = refund_tax exactly.
  const sumDue = toCents(parseFloat(state.tax_due))
                + toCents(parseFloat(county.tax_due))
                + toCents(parseFloat(mctd.tax_due));
  eq(sumDue, toCents(17.26 - 8.63), "jur refund: sum of per-jur tax_due is penny-exact");
}

// ---------------------------------------------------------------------------
// PR #145 #6 — Refund without a matching original line (e.g. adjustment-only):
// original_tax_lines is empty, so it still subtracts from gross + tax_owed
// at the entity level, but contributes nothing to per-jurisdiction breakdown.
// ---------------------------------------------------------------------------
{
  const refunds: RefundForTax[] = [refund({
    entity_id: 1,
    line_subtotal_refunded: 50,
    refund_tax: 4.31,
    original_tax_lines: [], // no jurisdictions — fall through
    is_pos: true,
  })];
  const ents = aggregateByEntity([], names, refunds);
  eq(ents[0].gross_sales, "-50.00", "no-tax-lines refund: gross still subtracts");
  eq(ents[0].tax_collected_gross, "-4.31", "no-tax-lines refund: tax_collected still subtracts");
  const jurs = aggregateByJurisdiction([], names, refunds);
  // No jurisdictions at all — aggregator skipped this refund for per-jur.
  eq(jurs.length, 0, "no-tax-lines refund: no jurisdiction rows produced");
}

// ---------------------------------------------------------------------------
// PR #145 #7 — Refund attribution to Unallocated when entity_id=0.
// ---------------------------------------------------------------------------
{
  const refunds: RefundForTax[] = [refund({
    entity_id: 0,
    line_subtotal_refunded: 10,
    refund_tax: 0.86,
    original_tax_lines: [NY_STATE_TL(0.40), NASSAU_TL(0.43), MCTD_TL(0.04)],
    is_pos: false,
  })];
  const result = aggregateByEntity([], names, refunds);
  eq(result[0].entity_id, 0, "refund unalloc: entity_id 0");
  eq(result[0].entity_name, "Unallocated", "refund unalloc: name");
  eq(result[0].gross_sales, "-10.00", "refund unalloc: gross negative");
  eq(result[0].tax_collected_gross, "-0.86", "refund unalloc: tax negative");
}

// ---------------------------------------------------------------------------
// PR #146 #1 — Per-jurisdiction rounding: 50 small refunds across 3 jurisdictions.
// Each refund is small enough that the proportional pro-rate produces a residual
// each time. Pre-#146 the last bucket absorbed each residual independently and
// accumulated drift. Post-#146 the entity-level residual pass forces
// Σ jurisdictions.tax_due === entity.tax_owed exactly.
// ---------------------------------------------------------------------------
{
  // Build a forward sale large enough to cover all refunds: $20,000 sale,
  // $1,725.00 tax (8.625% blended). 50 refunds of $10 / $0.86 each.
  const origTLs: TaxLine[] = [
    NY_STATE_TL(800.00),    // 4% of $20,000
    NASSAU_TL(850.00),      // 4.25% of $20,000
    MCTD_TL(75.00),         // 0.375% of $20,000
  ];
  const inputs: AggregatorInput[] = [{
    line: line({ entity_id: 1, line_subtotal: 20000, tax_lines: origTLs }),
    is_pos: true,
  }];

  // 50 refunds, each $10 / $0.86 (using original line's TL shape for pro-rate).
  // 50 * 0.86 = $43.00 refund tax total.
  const refundOrigTLs: TaxLine[] = [
    NY_STATE_TL(0.40), NASSAU_TL(0.43), MCTD_TL(0.04),  // 0.87 sums but refund_tax=0.86 (penny-off pro-rate)
  ];
  const refunds: RefundForTax[] = [];
  for (let i = 0; i < 50; i++) {
    refunds.push(refund({
      entity_id: 1,
      line_subtotal_refunded: 10,
      refund_tax: 0.86,
      original_tax_lines: refundOrigTLs,
      is_pos: true,
    }));
  }

  const ents = aggregateByEntity(inputs, names, refunds);
  // Entity tax_owed: 1725.00 - 50*0.86 = 1725.00 - 43.00 = 1682.00
  eq(ents[0].tax_owed, "1682.00", "50-refund accumulation: entity tax_owed exact");

  const jurs = aggregateByJurisdiction(inputs, names, refunds);
  assert(jurs.length === 1, "50-refund accumulation: one entity in jurisdiction breakdown");
  // Σ jurisdictions.tax_due must equal entity tax_owed exactly.
  const sumJurCents = jurs[0].jurisdictions.reduce((acc, j) => acc + Math.round(parseFloat(j.tax_due) * 100), 0);
  const entCents = Math.round(parseFloat(ents[0].tax_owed) * 100);
  eq(sumJurCents, entCents, "50-refund accumulation: Σ jurisdictions.tax_due === entity.tax_owed (penny-exact)");
  eq(jurs[0].totals.tax_due, "1682.00", "50-refund accumulation: totals.tax_due matches");
}

// ---------------------------------------------------------------------------
// PR #146 #2 — Shipping forward tax: increases tax_collected without changing
// taxable_sales (shipping has its own column in Shopify Finance Summary).
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 1, line_subtotal: 100,
      tax_lines: [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)],
    }),
    is_pos: false,
  }];
  // Shipping: $20 ship, $1.72 tax across same jurisdictions (8.625%).
  const shipping: ShippingTaxForward[] = [{
    entity_id: 1,
    tax_lines: [NY_STATE_TL(0.80), NASSAU_TL(0.85), MCTD_TL(0.07)],
    is_pos: false,
    tax_channel_liable: 0,
  }];
  const ents = aggregateByEntity(inputs, names, [], shipping);
  eq(ents[0].gross_sales, "100.00", "shipping forward: gross unchanged (no subtotal contribution)");
  eq(ents[0].taxable_sales, "100.00", "shipping forward: taxable_sales unchanged");
  // tax_collected = 8.63 (product) + 1.72 (shipping) = 10.35
  eq(ents[0].tax_collected_gross, "10.35", "shipping forward: tax_collected includes shipping tax");
  eq(ents[0].tax_owed, "10.35", "shipping forward: tax_owed includes shipping tax");
  eq(ents[0].allocated_split, { gross: "100.00", tax: "10.35" }, "shipping forward: allocated split has shipping tax");

  const jurs = aggregateByJurisdiction(inputs, names, [], shipping);
  // Shipping tax goes per-jurisdiction: each one gets its share.
  const sumJurCents = jurs[0].jurisdictions.reduce((acc, j) => acc + Math.round(parseFloat(j.tax_due) * 100), 0);
  eq(sumJurCents, 1035, "shipping forward: jurisdictions sum to 10.35 = entity tax_owed");
}

// ---------------------------------------------------------------------------
// PR #146 #3 — Shipping refund (adjustment_kind='shipping_refund'):
// caller passes ABS()'d cents; aggregator subtracts. No jurisdiction
// attribution available — entity residual pass absorbs into largest bucket.
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 1, line_subtotal: 100,
      tax_lines: [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)],
    }),
    is_pos: true,
  }];
  // Shipping refund: $0.90 ABS — should reduce tax_collected by 0.90.
  const shipRefunds: ShippingTaxRefund[] = [{
    entity_id: 1,
    refund_tax: 0.90,
    is_pos: true,
    tax_channel_liable: 0,
  }];
  const ents = aggregateByEntity(inputs, names, [], [], shipRefunds);
  eq(ents[0].tax_collected_gross, "7.73", "shipping refund: tax_collected = 8.63 - 0.90");
  eq(ents[0].tax_owed, "7.73", "shipping refund: tax_owed = 8.63 - 0.90");
  eq(ents[0].pos_split.tax, "7.73", "shipping refund: POS tax reduced");

  const jurs = aggregateByJurisdiction(inputs, names, [], [], shipRefunds);
  // Σ jurisdictions.tax_due === entity.tax_owed exactly (residual absorbed).
  const sumJurCents = jurs[0].jurisdictions.reduce((acc, j) => acc + Math.round(parseFloat(j.tax_due) * 100), 0);
  eq(sumJurCents, 773, "shipping refund: Σ jurisdictions === entity.tax_owed (residual absorbed into largest)");
  // Largest forward jurisdiction = NASSAU_TL(4.25) = 425c. After absorbing -90c residual = 335c.
  const nassau = jurs[0].jurisdictions.find(j => j.jurisdiction_name === "NASSAU COUNTY")!;
  eq(nassau.tax_due, "3.35", "shipping refund: residual absorbed into NASSAU COUNTY (largest)");
}

// ---------------------------------------------------------------------------
// PR #146 #4 — Marketplace shipping refund: NOT in tax_owed (mirrors marketplace
// item refund logic). expectedTaxOwedCents excludes it; jurisdictions don't
// need to change.
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 1, line_subtotal: 100,
      tax_lines: [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)],
    }),
    is_pos: true,
  }];
  const shipRefunds: ShippingTaxRefund[] = [{
    entity_id: 1,
    refund_tax: 0.90,
    is_pos: true,
    tax_channel_liable: 1,  // marketplace
  }];
  const ents = aggregateByEntity(inputs, names, [], [], shipRefunds);
  // tax_collected drops by 0.90 (gross collected), marketplace_tax drops by 0.90,
  // tax_owed = tax_collected - marketplace_tax = (8.63-0.90) - (-0.90) = 8.63
  eq(ents[0].tax_owed, "8.63", "marketplace shipping refund: tax_owed unchanged");
  eq(ents[0].marketplace_tax_collected, "-0.90", "marketplace shipping refund: marketplace_tax reduced");
}

// ---------------------------------------------------------------------------
// PR #146 #5 — Mixed: per-line tax + shipping forward + item refund + shipping
// refund + 50 small refunds. Final invariant: Σ jurisdictions.tax_due ===
// entity.tax_owed regardless of which paths fire.
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 1, line_subtotal: 5000,
      tax_lines: [NY_STATE_TL(200.00), NASSAU_TL(212.50), MCTD_TL(18.75)],
    }),
    is_pos: true,
  }];
  const shipping: ShippingTaxForward[] = [{
    entity_id: 1,
    tax_lines: [NY_STATE_TL(2.00), NASSAU_TL(2.12), MCTD_TL(0.19)],
    is_pos: true,
    tax_channel_liable: 0,
  }];
  const itemRefundTLs: TaxLine[] = [NY_STATE_TL(0.40), NASSAU_TL(0.43), MCTD_TL(0.04)];
  const refunds: RefundForTax[] = [];
  for (let i = 0; i < 30; i++) {
    refunds.push(refund({
      entity_id: 1, line_subtotal_refunded: 10, refund_tax: 0.86,
      original_tax_lines: itemRefundTLs, is_pos: true,
    }));
  }
  const shipRefunds: ShippingTaxRefund[] = [
    { entity_id: 1, refund_tax: 1.32, is_pos: true, tax_channel_liable: 0 },
    { entity_id: 1, refund_tax: 0.45, is_pos: true, tax_channel_liable: 0 },
  ];
  const ents = aggregateByEntity(inputs, names, refunds, shipping, shipRefunds);
  const entCents = Math.round(parseFloat(ents[0].tax_owed) * 100);

  const jurs = aggregateByJurisdiction(inputs, names, refunds, shipping, shipRefunds);
  const sumJurCents = jurs[0].jurisdictions.reduce((acc, j) => acc + Math.round(parseFloat(j.tax_due) * 100), 0);
  eq(sumJurCents, entCents, "mixed scenario: Σ jurisdictions === entity.tax_owed (penny-exact)");
  // Expected: 431.25 (forward) + 4.31 (ship) - 30*0.86 (item refunds) - 1.32 - 0.45 (ship refunds)
  //         = 431.25 + 4.31 - 25.80 - 1.32 - 0.45 = 407.99
  eq(ents[0].tax_owed, "407.99", "mixed scenario: tax_owed exact");
}

// ---------------------------------------------------------------------------
// PR #147 — Marketplace-only jurisdictions (Huntington FL/TX shape).
// Reproduces Huntington Dec 2025: most sales are NY (non-marketplace),
// but two FL/TX lines are marketplace-only (channel_liable=true with no
// non-marketplace tax in that jurisdiction). Before PR #147, the
// expectedTaxOwedCents map diverged from aggregateByEntity's tax_owed
// because the two functions used different marketplace-detection rules,
// leaking $1.32 into the residual reconciliation. After PR #147
// expectedTaxOwedCents is sourced from aggregateByEntity directly, so the
// marketplace-only jurisdictions cannot contribute to the residual target.
// ---------------------------------------------------------------------------
{
  const FL_STATE_TL = (price: number, mp: boolean): TaxLine => ({
    title: "FL State", rate: 0.06, price, channel_liable: mp,
    jurisdiction_id: null, jurisdiction_name: "FLORIDA STATE TAX", jurisdiction_type: "STATE",
  });
  const TX_STATE_TL = (price: number, mp: boolean): TaxLine => ({
    title: "TX State", rate: 0.0625, price, channel_liable: mp,
    jurisdiction_id: null, jurisdiction_name: "TEXAS STATE TAX", jurisdiction_type: "STATE",
  });

  const inputs: AggregatorInput[] = [];
  // 1000 normal NY lines, $100 ea, tax = NY 4 + Nassau 4.25 + MCTD 0.38 = 8.63
  for (let i = 0; i < 1000; i++) {
    inputs.push({
      line: line({
        entity_id: 2,
        line_subtotal: 100,
        tax_lines: [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)],
      }),
      is_pos: true,
    });
  }
  // 1 FL marketplace-only line: $185 subtotal, tax $12 (channel_liable on every tl)
  inputs.push({
    line: line({
      entity_id: 2,
      line_subtotal: 185,
      tax_channel_liable: 1,
      tax_lines: [FL_STATE_TL(12.00, true)],
    }),
    is_pos: false,
  });
  // 1 TX marketplace-only line: $42 subtotal, tax $3.56
  inputs.push({
    line: line({
      entity_id: 2,
      line_subtotal: 42,
      tax_channel_liable: 1,
      tax_lines: [TX_STATE_TL(3.56, true)],
    }),
    is_pos: false,
  });

  const ents = aggregateByEntity(inputs, names);
  const jurs = aggregateByJurisdiction(inputs, names, [], [], []);

  // tax_collected_gross = 1000*8.63 + 12 + 3.56 = 8645.56
  eq(ents[0].tax_collected_gross, "8645.56", "marketplace-only: tax_collected_gross");
  // marketplace_tax = 12 + 3.56 = 15.56
  eq(ents[0].marketplace_tax_collected, "15.56", "marketplace-only: marketplace_tax");
  // tax_owed = 8645.56 - 15.56 = 8630.00
  eq(ents[0].tax_owed, "8630.00", "marketplace-only: tax_owed");

  // Σ non-marketplace jurisdictions.tax_due === tax_owed (penny-exact)
  const sumJurCents = jurs[0].jurisdictions.reduce((a, j) => a + Math.round(parseFloat(j.tax_due) * 100), 0);
  eq(sumJurCents, 863000, "marketplace-only: Σ jur tax_due === tax_owed (Huntington-shape)");

  // Confirm FL/TX appear as marketplace-only (no tax_due, mp_tax > 0)
  const fl = jurs[0].jurisdictions.find(j => j.jurisdiction_name === "FLORIDA STATE TAX");
  const tx = jurs[0].jurisdictions.find(j => j.jurisdiction_name === "TEXAS STATE TAX");
  assert(fl != null && tx != null, "marketplace-only: FL and TX jurisdictions exist");
  eq(fl?.tax_due, "0.00", "marketplace-only: FL tax_due is zero");
  eq(fl?.marketplace_tax, "12.00", "marketplace-only: FL marketplace_tax");
  eq(tx?.tax_due, "0.00", "marketplace-only: TX tax_due is zero");
  eq(tx?.marketplace_tax, "3.56", "marketplace-only: TX marketplace_tax");
}

// ---------------------------------------------------------------------------
// PR #147 — Unverified-return tax (Rule #8).
// Same-order exchange with no refund row. By-store subtracts
// (total_tax − current_total_tax) from its Taxes column for these orders;
// by-entity must mirror that subtraction.
// ---------------------------------------------------------------------------
{
  const inputs: AggregatorInput[] = [{
    line: line({
      entity_id: 1,
      line_subtotal: 100,
      tax_lines: [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)],
    }),
    is_pos: true,
  }];
  // The unverified return: customer reversed $2.15 of tax via current_total_tax.
  // total_tax = 0, current_total_tax = -2.15 → delta = +2.15 cents to subtract.
  const unverified: UnverifiedReturnTax[] = [
    { entity_id: 1, tax_delta_cents: 215, is_pos: true },
  ];

  const ents = aggregateByEntity(inputs, names, [], [], [], unverified);
  // tax_collected = 8.63 - 2.15 = 6.48
  eq(ents[0].tax_collected_gross, "6.48", "unverified-return: tax_collected reduced by delta");
  eq(ents[0].tax_owed, "6.48", "unverified-return: tax_owed reduced by delta");
  eq(ents[0].pos_split.tax, "6.48", "unverified-return: POS-side tax reduced");

  const jurs = aggregateByJurisdiction(inputs, names, [], [], [], unverified);
  const sumJurCents = jurs[0].jurisdictions.reduce((a, j) => a + Math.round(parseFloat(j.tax_due) * 100), 0);
  eq(sumJurCents, 648, "unverified-return: Σ jur tax_due === tax_owed (residual absorbed)");
}

// ---------------------------------------------------------------------------
// PR #147 — Combined: marketplace + multiple refund kinds + unverified return.
// Stress the full reconciliation: forward + item refund + shipping forward +
// shipping refund + unverified return tax, with marketplace-only jurisdictions
// in the mix. End state must be penny-exact at both entity and jurisdiction
// levels.
// ---------------------------------------------------------------------------
{
  const FL_STATE_TL = (price: number, mp: boolean): TaxLine => ({
    title: "FL State", rate: 0.06, price, channel_liable: mp,
    jurisdiction_id: null, jurisdiction_name: "FLORIDA STATE TAX", jurisdiction_type: "STATE",
  });

  const inputs: AggregatorInput[] = [];
  // 50 NY lines @ $100 = $5,000 subtotal, $8.63 tax each
  for (let i = 0; i < 50; i++) {
    inputs.push({
      line: line({
        entity_id: 2,
        line_subtotal: 100,
        tax_lines: [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)],
      }),
      is_pos: true,
    });
  }
  // 1 FL marketplace-only line
  inputs.push({
    line: line({
      entity_id: 2,
      line_subtotal: 200,
      tax_channel_liable: 1,
      tax_lines: [FL_STATE_TL(12.00, true)],
    }),
    is_pos: false,
  });
  const shipping: ShippingTaxForward[] = [{
    entity_id: 2,
    tax_lines: [NY_STATE_TL(2.00), NASSAU_TL(2.13), MCTD_TL(0.19)],
    is_pos: true,
    tax_channel_liable: 0,
  }];
  const refunds: RefundForTax[] = [
    refund({
      entity_id: 2,
      line_subtotal_refunded: 100,
      refund_tax: 8.63,
      original_tax_lines: [NY_STATE_TL(4.00), NASSAU_TL(4.25), MCTD_TL(0.38)],
      is_pos: true,
    }),
  ];
  const shipRefunds: ShippingTaxRefund[] = [
    { entity_id: 2, refund_tax: 1.32, is_pos: true, tax_channel_liable: 0 },
  ];
  const unverified: UnverifiedReturnTax[] = [
    { entity_id: 2, tax_delta_cents: 215, is_pos: true },
  ];

  const ents = aggregateByEntity(inputs, names, refunds, shipping, shipRefunds, unverified);
  // Forward tax (50 NY lines): 50 * 8.63 = 431.50
  // FL marketplace: +12.00 to tax_collected, +12.00 to marketplace_tax
  // Shipping forward: +4.32
  // Item refund: -8.63
  // Shipping refund: -1.32
  // Unverified: -2.15
  // tax_collected_gross = 431.50 + 12.00 + 4.32 - 8.63 - 1.32 - 2.15 = 435.72
  eq(ents[0].tax_collected_gross, "435.72", "combined: tax_collected_gross");
  // marketplace_tax = 12.00
  eq(ents[0].marketplace_tax_collected, "12.00", "combined: marketplace_tax");
  // tax_owed = 435.72 - 12.00 = 423.72
  eq(ents[0].tax_owed, "423.72", "combined: tax_owed");

  const jurs = aggregateByJurisdiction(inputs, names, refunds, shipping, shipRefunds, unverified);
  const sumJurCents = jurs[0].jurisdictions.reduce((a, j) => a + Math.round(parseFloat(j.tax_due) * 100), 0);
  eq(sumJurCents, 42372, "combined: Σ jur tax_due === tax_owed (penny-exact)");
}

// ---------------------------------------------------------------------------
// Final tally
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
