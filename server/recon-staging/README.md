# Recon Staging Harness

Read-only Shopify finance reconciliation **test harness**. Isolated from
production reconciliation logic, isolated from the main app DB.

## What it does

1. Pulls every Shopify order for a given month (shop-local) into normalized
   staging tables: orders, lines, shipping, tax lines, refunds, refund lines,
   order edits.
2. Projects those rows into a single `staging.shopify_finance_events` ledger,
   one row per economic event, **dated by the event's own timestamp** (not the
   parent order timestamp).
3. Rolls events up to the Shopify Finance Summary fields: gross_sales,
   discounts, returns, net_sales, shipping, taxes, total_sales,
   net_sales_gift_cards.
4. Compares against the Shopify dashboard's Finance Summary numbers you paste
   in manually.

## Data layout

- All staging tables live in **`data-staging.db`** (sibling of `data.db`).
- That file is ATTACHed into every connection as the schema alias `staging`.
- Production `data.db` is **never touched** by this harness.
- Reset the harness = delete `data-staging.db` and call any endpoint
  (or run any script) — the tables are recreated on first open.

## Files

| File | Purpose |
|---|---|
| `staging-db.ts` | Opens the in-memory shim + ATTACHes `data-staging.db` as `staging`, bootstraps schema. |
| `tz.ts` | Shop-local TZ helpers (Intl-based). |
| `graphql.ts` | The single GraphQL query (more fields than production ingest). |
| `ingest.ts` | Pull Shopify → staging tables. |
| `project-events.ts` | Project staged rows → `staging.shopify_finance_events`. |
| `rollup.ts` | Monthly + by-day rollup queries. |
| `routes.ts` | Express routes mounted at `/api/recon/staging/*`. |
| `migrations/001_staging.sql` | Hand-runnable SQL DDL (matches `staging-db.ts`). |
| `migrations/002_monthly_rollup_view.sql` | `v_staging_finance_summary` view for ad-hoc inspection. |
| `shared/staging-schema.ts` | Drizzle ORM types (read-only mirror). |

## Endpoints (all require token auth + `payroll.view`)

| Method+Path | Purpose |
|---|---|
| `POST /api/recon/staging/ingest/:month` | Pull Shopify orders/refunds/edits for `YYYY-MM`. Idempotent. |
| `POST /api/recon/staging/project/:month` | Rebuild `staging.shopify_finance_events` for the month. |
| `GET /api/recon/staging/rollup/:month` | Returns the 8-field Finance Summary rollup + by-day. |
| `GET /api/recon/staging/orders/:month` | Per-order dump for triage. |
| `GET /api/recon/staging/events/:month` | Raw event rows. |
| `GET /api/recon/staging/runs` | Last 50 ingest runs. |
| `POST /api/recon/staging/reset` | Wipe staging for a month (or all if no body). |

All endpoints respond with `{ ok: boolean, ... }`.

## Local run checklist (April 2025)

```bash
# 1. Start the app as usual (dev server)
npm run dev

# 2. From DevTools console (logged in), paste:
#    workspace/devtools_staging_run_and_diff.js
#
#    That will:
#      a) POST /api/recon/staging/ingest/2025-04
#      b) POST /api/recon/staging/project/2025-04
#      c) GET  /api/recon/staging/rollup/2025-04
#      d) Print the 8 rollup numbers
#
# 3. Open Shopify admin → Analytics → Reports → Finance summary → April 2025
# 4. Copy each value into SHOPIFY_FINANCE_SUMMARY at the bottom of the script
# 5. Re-paste the script. It prints the diff table.
# 6. If anything is off, paste devtools_staging_suspicious_orders.js to drill in.
```

Or headless:

```bash
npx tsx scripts/stage-month.ts 2025-04
```

## Critical rules (do not violate)

- Every row in `staging.shopify_finance_events` uses the **event's own**
  `event_date_utc`/`shop_local_date`, never the parent order's date.
- Monthly rollup groups by `shop_local_month` (shop-local TZ), not UTC.
- Refunds processed in May against April orders end up in **May**.
- Order edits dated by `edit.createdAt`, not the order's `createdAt`.
- Raw JSON preserved on every staging row.
- Idempotent: rerun the same month, same data, no duplicates.
- Cancelled orders are **pulled** but excluded from default rollup
  (matches Shopify Finance Summary). Toggle with `includeCancelled=1`.
- Gift card lines tracked separately via `is_gift_card`; their amounts
  show in `net_sales_gift_cards` (a SEPARATE field from `net_sales`).

## Open caveat: order-edit delta precision

Shopify GraphQL exposes `order.events` (created/edited/refunded list) but
**not per-event monetary deltas**. The harness attributes the entire
`current_*  -  original_*` delta to the **last** edit event for the order.
That's fine for the typical case (one edit in a single month). When an
order has multiple edits across months, the harness will land the whole
delta in the later month — that's the most defensible default but may
need refinement later via the Bulk Order Edits API or webhook snapshots.
