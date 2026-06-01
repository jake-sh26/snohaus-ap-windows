/**
 * Fractional sales-tax rate display (PR #168).
 *
 * NY ST-809/ST-810 forms print combined rates as fractions (8 5/8%, 8 3/4%,
 * 8 7/8%) rather than decimals. This util converts a decimal rate to that form
 * for PDF + XLSX rendering. CSV keeps the raw decimal.
 *
 * Lives in shared/ so both the server export renderers and the client UI use
 * one implementation. Pure + dependency-free.
 */

/** Known NY combined-rate fractions, keyed by decimal rate (rounded to 5dp). */
const KNOWN_FRACTIONS: Record<string, string> = {
  "0.04": "4%",
  "0.07": "7%",
  "0.075": "7 1/2%",
  "0.08": "8%",
  "0.08125": "8 1/8%",
  "0.0825": "8 1/4%",
  "0.08375": "8 3/8%",
  "0.085": "8 1/2%",
  "0.08625": "8 5/8%",
  "0.0875": "8 3/4%",
  "0.08875": "8 7/8%",
  "0.04375": "4 3/8%",
};

/**
 * Format a decimal rate (e.g. 0.08625) as its NY fractional display ("8 5/8%").
 * Falls back to a 3-decimal percent ("8.625%") for non-standard rates so the
 * caller always gets a printable string.
 */
export function formatRateAsFraction(rateDecimal: number): string {
  if (rateDecimal == null || !Number.isFinite(rateDecimal)) return "";
  // Normalize to a stable key — strip trailing zeros so 0.08750 === 0.0875.
  const key = String(Number(rateDecimal.toFixed(5)));
  const known = KNOWN_FRACTIONS[key];
  if (known) return known;
  return `${(rateDecimal * 100).toFixed(3)}%`;
}
