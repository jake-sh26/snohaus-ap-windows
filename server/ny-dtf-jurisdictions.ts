/**
 * NY DTF jurisdiction codes (PR #168).
 *
 * Seed table mapping each NY taxing jurisdiction to its DTF reporting code
 * (e.g. Nassau "NA 2811"), combined rate in basis points, and the fractional
 * display NY prints on ST-810 (e.g. "8 5/8%"). Source: NY DTF Publication 718
 * (Local Sales and Use Tax Rates) + ST-810 jurisdiction code list.
 *
 * Used by the ST-810 endpoint to enrich each per-jurisdiction row with its DTF
 * code + fractional rate. Lookup is by county/jurisdiction NAME (the aggregator
 * groups by jurisdiction_name from tax_lines_json). Any jurisdiction present in
 * the data that does NOT map here is surfaced as a warning, not dropped.
 *
 * Rates are stored as integer basis points (8.625% = 8625) to keep math exact.
 * The list covers all 62 NY counties plus the five NYC boroughs' combined entry
 * (NYC files under a single jurisdiction code, NE 8091).
 */
import { sqlite } from "./storage";

export interface NyDtfJurisdiction {
  code: string;
  name: string;
  rate_basis_points: number;
  rate_display: string;
}

/**
 * All 62 NY counties + NYC. rate_display mirrors NY DTF's printed fraction.
 * Where a county's combined rate is a clean fraction we use it; otherwise the
 * formatRateAsFraction fallback (3dp percent) is fine — but the seed carries
 * the authoritative display so exports don't have to compute it.
 */
export const NY_DTF_JURISDICTIONS: NyDtfJurisdiction[] = [
  { code: "AL 0181", name: "Albany", rate_basis_points: 8000, rate_display: "8%" },
  { code: "AL 0221", name: "Allegany", rate_basis_points: 8500, rate_display: "8 1/2%" },
  { code: "BR 0381", name: "Broome", rate_basis_points: 8000, rate_display: "8%" },
  { code: "CA 0481", name: "Cattaraugus", rate_basis_points: 8000, rate_display: "8%" },
  { code: "CA 0521", name: "Cayuga", rate_basis_points: 8000, rate_display: "8%" },
  { code: "CH 0681", name: "Chautauqua", rate_basis_points: 8000, rate_display: "8%" },
  { code: "CH 0721", name: "Chemung", rate_basis_points: 8000, rate_display: "8%" },
  { code: "CH 0781", name: "Chenango", rate_basis_points: 8000, rate_display: "8%" },
  { code: "CL 0921", name: "Clinton", rate_basis_points: 8000, rate_display: "8%" },
  { code: "CO 1021", name: "Columbia", rate_basis_points: 8000, rate_display: "8%" },
  { code: "CO 1121", name: "Cortland", rate_basis_points: 8000, rate_display: "8%" },
  { code: "DE 1221", name: "Delaware", rate_basis_points: 8000, rate_display: "8%" },
  { code: "DU 1311", name: "Dutchess", rate_basis_points: 8125, rate_display: "8 1/8%" },
  { code: "ER 1451", name: "Erie", rate_basis_points: 8750, rate_display: "8 3/4%" },
  { code: "ES 1521", name: "Essex", rate_basis_points: 8000, rate_display: "8%" },
  { code: "FR 1621", name: "Franklin", rate_basis_points: 8000, rate_display: "8%" },
  { code: "FU 1721", name: "Fulton", rate_basis_points: 8000, rate_display: "8%" },
  { code: "GE 1821", name: "Genesee", rate_basis_points: 8000, rate_display: "8%" },
  { code: "GR 1921", name: "Greene", rate_basis_points: 8000, rate_display: "8%" },
  { code: "HA 2021", name: "Hamilton", rate_basis_points: 8000, rate_display: "8%" },
  { code: "HE 2121", name: "Herkimer", rate_basis_points: 8250, rate_display: "8 1/4%" },
  { code: "JE 2221", name: "Jefferson", rate_basis_points: 8000, rate_display: "8%" },
  { code: "LE 2421", name: "Lewis", rate_basis_points: 8000, rate_display: "8%" },
  { code: "LI 2521", name: "Livingston", rate_basis_points: 8000, rate_display: "8%" },
  { code: "MA 2621", name: "Madison", rate_basis_points: 8000, rate_display: "8%" },
  { code: "MO 2611", name: "Monroe", rate_basis_points: 8000, rate_display: "8%" },
  { code: "MO 2721", name: "Montgomery", rate_basis_points: 8000, rate_display: "8%" },
  { code: "NA 2811", name: "Nassau", rate_basis_points: 8625, rate_display: "8 5/8%" },
  { code: "NE 8091", name: "New York City", rate_basis_points: 8875, rate_display: "8 7/8%" },
  { code: "NI 2911", name: "Niagara", rate_basis_points: 8000, rate_display: "8%" },
  { code: "ON 3021", name: "Oneida", rate_basis_points: 8750, rate_display: "8 3/4%" },
  { code: "ON 3111", name: "Onondaga", rate_basis_points: 8000, rate_display: "8%" },
  { code: "ON 3221", name: "Ontario", rate_basis_points: 7500, rate_display: "7 1/2%" },
  { code: "OR 3311", name: "Orange", rate_basis_points: 8125, rate_display: "8 1/8%" },
  { code: "OR 3421", name: "Orleans", rate_basis_points: 8000, rate_display: "8%" },
  { code: "OS 3521", name: "Oswego", rate_basis_points: 8000, rate_display: "8%" },
  { code: "OT 3621", name: "Otsego", rate_basis_points: 8000, rate_display: "8%" },
  { code: "PU 3721", name: "Putnam", rate_basis_points: 8375, rate_display: "8 3/8%" },
  { code: "RE 3911", name: "Rensselaer", rate_basis_points: 8000, rate_display: "8%" },
  { code: "RO 4321", name: "Rockland", rate_basis_points: 8375, rate_display: "8 3/8%" },
  { code: "ST 4421", name: "St. Lawrence", rate_basis_points: 8000, rate_display: "8%" },
  { code: "SA 4121", name: "Saratoga", rate_basis_points: 7000, rate_display: "7%" },
  { code: "SC 4221", name: "Schenectady", rate_basis_points: 8000, rate_display: "8%" },
  { code: "SC 4321", name: "Schoharie", rate_basis_points: 8000, rate_display: "8%" },
  { code: "SC 4421", name: "Schuyler", rate_basis_points: 8000, rate_display: "8%" },
  { code: "SE 4521", name: "Seneca", rate_basis_points: 8000, rate_display: "8%" },
  { code: "ST 4621", name: "Steuben", rate_basis_points: 8000, rate_display: "8%" },
  { code: "SU 4711", name: "Suffolk", rate_basis_points: 8750, rate_display: "8 3/4%" },
  { code: "SU 4821", name: "Sullivan", rate_basis_points: 8000, rate_display: "8%" },
  { code: "TI 4921", name: "Tioga", rate_basis_points: 8000, rate_display: "8%" },
  { code: "TO 5021", name: "Tompkins", rate_basis_points: 8000, rate_display: "8%" },
  { code: "UL 5121", name: "Ulster", rate_basis_points: 8000, rate_display: "8%" },
  { code: "WA 5221", name: "Warren", rate_basis_points: 7000, rate_display: "7%" },
  { code: "WA 5321", name: "Washington", rate_basis_points: 7000, rate_display: "7%" },
  { code: "WA 5421", name: "Wayne", rate_basis_points: 8000, rate_display: "8%" },
  { code: "WE 5511", name: "Westchester", rate_basis_points: 8375, rate_display: "8 3/8%" },
  { code: "WY 5621", name: "Wyoming", rate_basis_points: 8000, rate_display: "8%" },
  { code: "YA 5721", name: "Yates", rate_basis_points: 8000, rate_display: "8%" },
  // NYC borough names sometimes arrive as the borough rather than "New York
  // City"; all five report under the NYC jurisdiction code NE 8091.
  { code: "NE 8091", name: "New York", rate_basis_points: 8875, rate_display: "8 7/8%" },
  { code: "NE 8091", name: "Bronx", rate_basis_points: 8875, rate_display: "8 7/8%" },
  { code: "NE 8091", name: "Kings", rate_basis_points: 8875, rate_display: "8 7/8%" },
  { code: "NE 8091", name: "Queens", rate_basis_points: 8875, rate_display: "8 7/8%" },
  { code: "NE 8091", name: "Richmond", rate_basis_points: 8875, rate_display: "8 7/8%" },
];

/**
 * Idempotent schema-ensure + seed. Called once at startup from
 * bootstrapSchema(). Upserts every row so rate corrections in a future deploy
 * propagate (the code is the stable key; for the NYC borough aliases, name is
 * part of the key so each alias persists).
 */
export function ensureNyDtfJurisdictionsSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ny_dtf_jurisdictions (
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      rate_basis_points INTEGER NOT NULL,
      rate_display TEXT NOT NULL,
      PRIMARY KEY (code, name)
    );
  `);
  const upsert = sqlite.prepare(`
    INSERT INTO ny_dtf_jurisdictions (code, name, rate_basis_points, rate_display)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(code, name) DO UPDATE SET
      rate_basis_points = excluded.rate_basis_points,
      rate_display = excluded.rate_display
  `);
  const tx = sqlite.transaction(() => {
    for (const j of NY_DTF_JURISDICTIONS) {
      upsert.run(j.code, j.name, j.rate_basis_points, j.rate_display);
    }
  });
  tx();
}

/** Normalize a jurisdiction name for lookup: strip "County", punctuation, case. */
function normalizeName(name: string): string {
  return String(name || "")
    .toUpperCase()
    .replace(/\bCOUNTY\b/g, "")
    .replace(/[.\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let _byName: Map<string, NyDtfJurisdiction> | null = null;
function nameIndex(): Map<string, NyDtfJurisdiction> {
  if (_byName) return _byName;
  const m = new Map<string, NyDtfJurisdiction>();
  for (const j of NY_DTF_JURISDICTIONS) {
    m.set(normalizeName(j.name), j);
  }
  // Common synonyms.
  m.set(normalizeName("NYC"), m.get(normalizeName("New York City"))!);
  m.set(normalizeName("ST LAWRENCE"), m.get(normalizeName("St. Lawrence"))!);
  _byName = m;
  return m;
}

/**
 * Look up a DTF jurisdiction by (county/jurisdiction) name. Returns undefined if
 * the name doesn't map — the caller surfaces that as a warning. Matching is
 * case-insensitive and tolerant of a trailing "County" + punctuation.
 */
export function dtfByName(name: string): NyDtfJurisdiction | undefined {
  return nameIndex().get(normalizeName(name));
}

/**
 * R6c — Recognize NY-locality component rows that arrive with `jurisdiction_type=OTHER`
 * and a name that embeds a county/borough (e.g. "NASSAU CO TRANSIT DISTRICT" is the
 * Nassau MTA piece; "NEW YORK CITY CITY TAX" is the NYC local portion). These ARE NY
 * locality components — not out-of-state marketplace lines — and must roll up into the
 * matching locality's tax_components_cents for audit-delta to be meaningful.
 *
 * Returns the DTF jurisdiction this component belongs to, or undefined if the OTHER row
 * doesn't look like an NY locality component (genuinely out-of-state / marketplace).
 */
export function dtfForNyOtherComponent(name: string): NyDtfJurisdiction | undefined {
  const n = normalizeName(name);
  // Each NY DTF name (county or NYC alias) — if the OTHER row's normalized name
  // CONTAINS that locality token, attribute the OTHER row to that locality.
  // Use the longest match wins to avoid "NEW YORK" matching before "NEW YORK CITY".
  const idx = nameIndex();
  let best: NyDtfJurisdiction | undefined;
  let bestLen = 0;
  for (const [key, j] of Array.from(idx.entries())) {
    if (key.length <= bestLen) continue;
    // Token-boundary contains: surround both with spaces so "ERIE" doesn't match
    // "WERIES". normalizeName already collapses whitespace.
    if ((" " + n + " ").includes(" " + key + " ")) {
      best = j;
      bestLen = key.length;
    }
  }
  return best;
}

/** All seeded jurisdictions (deduped by code, NYC aliases collapsed). */
export function allDtf(): NyDtfJurisdiction[] {
  const seen = new Set<string>();
  const out: NyDtfJurisdiction[] = [];
  for (const j of NY_DTF_JURISDICTIONS) {
    if (seen.has(j.code)) continue;
    seen.add(j.code);
    out.push(j);
  }
  return out;
}
