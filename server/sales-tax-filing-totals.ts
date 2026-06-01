/**
 * Sales Tax — derived filing-totals cache (PR #168).
 *
 * `sales_tax_filings` is a STATUS tracker (open/filed/amended), not a computed-
 * totals store. The recompute-all admin endpoint needs somewhere to persist the
 * per-(period, entity) marketplace-carved totals it backfills, so it can be
 * queried later without re-running the aggregator. This is that store.
 *
 * Rows are a CACHE derived from the single-source-of-truth aggregator
 * (aggregateByEntity in shopify-tax-aggregation.ts). `replaceForPeriod` is a
 * delete-then-insert so a re-run is idempotent and never leaves stale entities.
 *
 * Money is stored as fixed-2 decimal strings (mirroring the aggregator's output
 * contract) so the recompute endpoint can write straight through without a cents
 * round-trip.
 */
import { sqlite } from "./storage";

export interface FilingTotalRow {
  period_key: string;
  entity_id: number;
  gross_sales: string;
  marketplace_sales: string;
  taxable_sales: string;
  tax_due: string;
  computed_at: string;
}

/** Idempotent schema-ensure. Called once at startup from bootstrapSchema(). */
export function ensureSalesTaxFilingTotalsSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sales_tax_filing_totals (
      period_key TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      gross_sales TEXT NOT NULL,
      marketplace_sales TEXT NOT NULL,
      taxable_sales TEXT NOT NULL,
      tax_due TEXT NOT NULL,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (period_key, entity_id)
    );
  `);
}

/** Input shape for one row to (re)write. computed_at is set by the writer. */
export interface FilingTotalInput {
  entity_id: number;
  gross_sales: string;
  marketplace_sales: string;
  taxable_sales: string;
  tax_due: string;
}

/**
 * Replace all rows for a period in one transaction (delete-then-insert).
 * Idempotent: re-running with the same data leaves an identical table, and a
 * shrinking entity set never leaves orphans.
 */
export function replaceForPeriod(periodKey: string, rows: FilingTotalInput[]): void {
  const del = sqlite.prepare(`DELETE FROM sales_tax_filing_totals WHERE period_key = ?`);
  const ins = sqlite.prepare(`
    INSERT INTO sales_tax_filing_totals
      (period_key, entity_id, gross_sales, marketplace_sales, taxable_sales, tax_due, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const tx = sqlite.transaction(() => {
    del.run(periodKey);
    for (const r of rows) {
      ins.run(periodKey, r.entity_id, r.gross_sales, r.marketplace_sales, r.taxable_sales, r.tax_due);
    }
  });
  tx();
}

/** All cached rows, newest period first then entity ascending. */
export function listAll(): FilingTotalRow[] {
  return sqlite
    .prepare(`
      SELECT period_key, entity_id, gross_sales, marketplace_sales, taxable_sales, tax_due, computed_at
        FROM sales_tax_filing_totals
       ORDER BY period_key DESC, entity_id ASC
    `)
    .all() as FilingTotalRow[];
}
