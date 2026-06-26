// ============================================================================
// PR #209 — Season bonus auto-rollover
// ============================================================================
// Ski-season fiscal year: a season runs roughly April 1 -> March 31 and is
// labeled by its starting calendar year, e.g. "2025-26" = Apr 1 2025 to
// Mar 31 2026.
//
// On / after April 1 each year, any employee whose current_season_label is
// the just-ended season AND whose current_season_bonus is non-null gets:
//
//   1. A row written to payroll_employee_season_bonuses (employee_id,
//      season_label, bonus_amount, closed_at = today). Idempotent via the
//      (employee_id, season_label) unique index.
//   2. current_season_bonus cleared to null and current_season_label
//      advanced to the new season label (e.g. "2025-26" -> "2026-27").
//
// The rollover is idempotent: re-running it after April 1 is a no-op once
// every applicable row has been advanced. We schedule it daily at server
// start; it's a tiny operation.
// ============================================================================

import { sqlite } from "./storage";

export function currentSeasonLabel(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  const startYear = m >= 4 ? y : y - 1;
  const endYear = startYear + 1;
  return `${startYear}-${String(endYear).slice(2)}`;
}

// Given a label like "2025-26", return "2026-27".
export function nextSeasonLabel(label: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) return label;
  const startYear = Number(m[1]) + 1;
  const endYear = startYear + 1;
  return `${startYear}-${String(endYear).slice(2)}`;
}

export type RolloverSummary = {
  ranAt: string;
  currentSeason: string;
  closedCount: number;
  closed: Array<{ employee_id: number; season_label: string; bonus_amount: number }>;
};

export function runSeasonBonusRollover(now: Date = new Date()): RolloverSummary {
  const today = now.toISOString().slice(0, 10);
  const currentSeason = currentSeasonLabel(now);

  // Find employees whose current_season_label is an OLD season (not the current
  // one) AND who have a current_season_bonus set. Those need rolling over.
  const stale = sqlite
    .prepare(
      `SELECT id, current_season_label, current_season_bonus
         FROM payroll_employees
        WHERE current_season_bonus IS NOT NULL
          AND current_season_label IS NOT NULL
          AND current_season_label != ?`
    )
    .all(currentSeason) as Array<{
      id: number;
      current_season_label: string;
      current_season_bonus: number;
    }>;

  const closed: RolloverSummary["closed"] = [];

  const upsert = sqlite.prepare(`
    INSERT INTO payroll_employee_season_bonuses
      (employee_id, season_label, bonus_amount, notes, closed_at, created_at)
    VALUES (?, ?, ?, NULL, ?, ?)
    ON CONFLICT(employee_id, season_label) DO UPDATE SET
      bonus_amount = excluded.bonus_amount,
      closed_at = excluded.closed_at
  `);
  const updateEmp = sqlite.prepare(`
    UPDATE payroll_employees
       SET current_season_bonus = NULL,
           current_season_label = ?,
           updated_at = ?
     WHERE id = ?
  `);

  const nowIso = now.toISOString();
  const txn = sqlite.transaction((rows: typeof stale) => {
    for (const r of rows) {
      upsert.run(r.id, r.current_season_label, r.current_season_bonus, today, nowIso);
      // Advance the label by one (so the UI shows the season they're now in
      // and the admin can drop in a new bonus when ready).
      updateEmp.run(currentSeason, nowIso, r.id);
      closed.push({
        employee_id: r.id,
        season_label: r.current_season_label,
        bonus_amount: r.current_season_bonus,
      });
    }
  });
  txn(stale);

  return {
    ranAt: nowIso,
    currentSeason,
    closedCount: closed.length,
    closed,
  };
}

/**
 * Schedule the rollover: run once at startup (5s delay) and then every
 * 24 hours. The function is idempotent, so daily re-runs are safe.
 */
export function scheduleSeasonBonusRollover(): void {
  setTimeout(() => {
    try {
      const r = runSeasonBonusRollover();
      if (r.closedCount > 0) {
        console.log(
          `[season-bonus-rollover] closed ${r.closedCount} season(s) into history at ${r.ranAt}`
        );
      }
    } catch (e) {
      console.error("[season-bonus-rollover] startup run failed:", e);
    }
  }, 5000);
  setInterval(() => {
    try {
      runSeasonBonusRollover();
    } catch (e) {
      console.error("[season-bonus-rollover] daily run failed:", e);
    }
  }, 24 * 60 * 60 * 1000);
}
