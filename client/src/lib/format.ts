export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = parseLocalDate(v);
  if (!d) return v;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Parse YYYY-MM-DD (or YYYY-MM-DDTHH:MM:SS…) as LOCAL midnight, not UTC.
 * Plain `new Date("2026-06-11")` is parsed as UTC midnight and renders as Jun 10 in EDT —
 * that off-by-one bug bit every date column in the app. Always use this helper for
 * any user-facing date that came from the DB as a YYYY-MM-DD string.
 */
export function parseLocalDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  // Fast path: YYYY-MM-DD or YYYY-MM-DDT… → build a local-time Date
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(
      parseInt(iso[1], 10),
      parseInt(iso[2], 10) - 1,
      parseInt(iso[3], 10),
    );
    return isNaN(d.getTime()) ? null : d;
  }
  // Fallback: M/D/YYYY (already local) or other JS-parseable
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdy) {
    const yyyy = parseInt(mdy[3], 10) < 100 ? 2000 + parseInt(mdy[3], 10) : parseInt(mdy[3], 10);
    const d = new Date(yyyy, parseInt(mdy[1], 10) - 1, parseInt(mdy[2], 10));
    return isNaN(d.getTime()) ? null : d;
  }
  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback;
}

export const STORE_LABELS: Record<string, string> = {
  greenvale: "Sundown Greenvale",
  hempstead: "Sno-Haus Hempstead",
  huntington: "Sno-Haus Huntington",
};

export const STORE_SHORT: Record<string, string> = {
  greenvale: "Greenvale",
  hempstead: "Hempstead",
  huntington: "Huntington",
};
