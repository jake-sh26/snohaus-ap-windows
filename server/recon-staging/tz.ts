/**
 * Shop-local timezone helpers for the recon staging harness.
 *
 * All date bucketing in the harness uses these — NEVER raw UTC strings —
 * because the goal is to match Shopify's Finance Summary which groups by
 * the shop's local date.
 *
 * `Intl.DateTimeFormat` is used (Node 18+) — no external tz lib needed.
 */

const FALLBACK_TZ = "America/New_York";

let cachedShopTz: string | null = null;

export function setShopTimezone(tz: string | null | undefined): void {
  cachedShopTz = (tz && tz.trim().length > 0) ? tz : FALLBACK_TZ;
}

export function getShopTimezone(): string {
  return cachedShopTz || FALLBACK_TZ;
}

/**
 * Convert an ISO timestamp (any TZ) to YYYY-MM-DD in shop-local time.
 * Returns '' for null/invalid input.
 */
export function shopLocalDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: getShopTimezone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA renders as 'YYYY-MM-DD' by default
  return fmt.format(d);
}

/** Convert an ISO timestamp to YYYY-MM in shop-local time. */
export function shopLocalMonth(iso: string | null | undefined): string {
  const d = shopLocalDate(iso);
  return d ? d.slice(0, 7) : "";
}

/**
 * Build the `processed_at:>=X processed_at:<Y` filter string for a given
 * YYYY-MM month, in shop-local time.
 *
 * Shopify's query filter expects ISO datetimes — we convert the
 * month's local boundaries to the UTC instants Shopify expects.
 */
export function monthFilterRange(yyyyMm: string): { startUtc: string; endUtc: string; q: string } {
  const [y, m] = yyyyMm.split("-").map(Number);
  if (!y || !m) throw new Error(`Bad month '${yyyyMm}' (want YYYY-MM)`);
  const start = localMidnightToUtcIso(y, m, 1);
  // first day of NEXT month
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  const end = localMidnightToUtcIso(ny, nm, 1);
  const q = `processed_at:>=${start} processed_at:<${end}`;
  return { startUtc: start, endUtc: end, q };
}

/**
 * Convert (year, month, day) at 00:00 in shop-local TZ to the UTC ISO instant.
 *
 * Algorithm: form an approximate UTC date at the wall-clock time, ask the
 * shop's TZ what wall-clock that UTC corresponds to, compute the offset,
 * and subtract. Works across DST.
 */
function localMidnightToUtcIso(y: number, m: number, d: number): string {
  const tz = getShopTimezone();
  // First approximation: treat the wall-clock as UTC.
  const approx = Date.UTC(y, m - 1, d, 0, 0, 0);
  // What wall-clock does that UTC look like in shop TZ?
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(approx)).map((p) => [p.type, p.value]),
  );
  const localY = Number(parts.year);
  const localM = Number(parts.month);
  const localD = Number(parts.day);
  // Note: en-US `hour` returns "24" for midnight in some node versions; normalize.
  let localH = Number(parts.hour);
  if (localH === 24) localH = 0;
  const localMin = Number(parts.minute);
  const localS = Number(parts.second);
  const localAsUtc = Date.UTC(localY, localM - 1, localD, localH, localMin, localS);
  const offsetMs = localAsUtc - approx; // positive if local is ahead of UTC
  const realUtc = approx - offsetMs;
  return new Date(realUtc).toISOString();
}
