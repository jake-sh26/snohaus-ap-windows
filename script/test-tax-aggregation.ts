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
// Final tally
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
