#!/usr/bin/env tsx
/**
 * Standalone headless runner for the recon staging harness.
 *
 *   npx tsx scripts/stage-month.ts [month]
 *
 * Defaults to 2025-04 when no month argument is provided.
 *
 * Pulls Shopify → staging tables, projects events, prints the rollup.
 * Safe to rerun for the same month (upserts on primary keys).
 */

import { ingestMonth } from "../server/recon-staging/ingest";
import { projectEvents } from "../server/recon-staging/project-events";
import { rollupMonth, rollupByDay } from "../server/recon-staging/rollup";

const month = (process.argv[2] || "2025-04").trim();
if (!/^\d{4}-\d{2}$/.test(month)) {
  console.error(`Bad month '${month}'. Pass YYYY-MM like 2025-04.`);
  process.exit(2);
}

async function main() {
  console.log(`[stage-month] starting for ${month}`);
  const t0 = Date.now();

  console.log(`[stage-month] step 1/3: ingest from Shopify…`);
  const ing = await ingestMonth({ month });
  console.log(`[stage-month] ingest: ${JSON.stringify(ing, null, 2)}`);
  if (!ing.ok) {
    console.error("[stage-month] ingest failed — stopping.");
    process.exit(1);
  }

  console.log(`[stage-month] step 2/3: project events…`);
  const proj = projectEvents({ month });
  console.log(`[stage-month] projection: ${JSON.stringify(proj, null, 2)}`);

  console.log(`[stage-month] step 3/3: rollup…`);
  const summary = rollupMonth({ month });
  console.log(`[stage-month] rollup:`);
  console.log(JSON.stringify(summary, null, 2));

  console.log(`[stage-month] by-day:`);
  console.table(rollupByDay({ month }));

  console.log(`[stage-month] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("[stage-month] failed:", e);
  process.exit(1);
});
