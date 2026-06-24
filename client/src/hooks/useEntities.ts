import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

// ============================================================================
// useEntities — canonical client-side accessor for the 3 Sno-Haus entities
// (Greenvale, Huntington, Hempstead). Returns DB-backed names so we never
// ship a hardcoded constant that drifts from `payroll_entities` again.
//
// PR #194 introduced this hook to kill the `ENTITY_LEGAL_NAMES` const that
// lived inside `SalesTax.tsx` (which was already out of sync with the DB).
// Going forward, any client code that needs an entity's display label,
// legal name, DBA, county, tax rate, etc. should pull it from here.
//
// API source of truth: GET /api/settings/entities → listPayrollEntities().
// Permission gate: `users.view`. The 3 base rows are always present.
//
// Naming model (5 fields — read `settings-audit.md` for the full spec):
//   • slug         — URL key, lowercase (`greenvale`)
//   • short_name   — tight UI label (`Greenvale`)
//   • display_name — brand-prefixed UI label (`Sno-Haus Greenvale`)
//   • dba          — NY-registered DBA, a LEGAL FACT (`Sno-Haus Greenvale`)
//   • legal_name   — corporate name on NY DTF filings (`SD Ski and Patio Inc`)
// ============================================================================

/** Raw row shape returned by GET /api/settings/entities. */
export type Entity = {
  id: number;
  /** Legacy field — prefer `short_name`. Kept for one release cycle. */
  location: string;
  short_name: string | null;
  display_name: string | null;
  dba: string | null;
  legal_name: string;
  slug: string | null;
  cadence: string;
  adp_company_code: string | null;
  tin: string | null;
  county: string | null;
  rate_bps: number | null;
  dtf_code: string | null;
  qbo_inventory_account_id: string | null;
  qbo_inventory_account_name: string | null;
  commissions_enabled: number;
  pms_enabled: number;
  tips_enabled: number;
  easyrent_enabled: number;
  spif_enabled: number;
  active: number;
  current_tip_cc_fee_pct: number | null;
  current_tip_cc_fee_id: number | null;
};

/**
 * Convenience view of an entity with safe fallbacks.
 *
 * Callers should prefer the *resolved* helper fields (`shortName`,
 * `displayName`) over the raw nullable columns — the helpers fall back
 * sensibly so the UI never renders an empty string just because a row
 * predates a backfill.
 */
export type EntityView = Entity & {
  /** Best UI short label: short_name → location → "Entity {id}". */
  shortName: string;
  /** Best UI brand label: display_name → short_name → location → "Entity {id}". */
  displayName: string;
};

function toView(e: Entity): EntityView {
  const shortName = (e.short_name?.trim() || e.location?.trim() || `Entity ${e.id}`);
  const displayName = (e.display_name?.trim() || shortName);
  return { ...e, shortName, displayName };
}

/**
 * Fetches all entities (active + inactive). Filter on `active === 1`
 * client-side when the caller only wants live entities.
 */
export function useEntities(): UseQueryResult<EntityView[]> & {
  /** Lookup by integer id — undefined while loading or for unknown ids. */
  byId: (id: number) => EntityView | undefined;
  /** Lookup by slug — undefined while loading or for unknown slugs. */
  bySlug: (slug: string) => EntityView | undefined;
} {
  const q = useQuery<Entity[]>({ queryKey: ["/api/settings/entities"] });
  const views = useMemo(() => (q.data ?? []).map(toView), [q.data]);

  const byId = useMemo(() => {
    const m = new Map(views.map((v) => [v.id, v] as const));
    return (id: number) => m.get(id);
  }, [views]);

  const bySlug = useMemo(() => {
    const m = new Map(views.filter((v) => v.slug).map((v) => [v.slug as string, v] as const));
    return (slug: string) => m.get(slug);
  }, [views]);

  // Cast through unknown so we can attach helpers without fighting React-Query's
  // generic union. `data` is already typed as EntityView[] via the cast below.
  return { ...q, data: views, byId, bySlug } as unknown as UseQueryResult<EntityView[]> & {
    byId: (id: number) => EntityView | undefined;
    bySlug: (slug: string) => EntityView | undefined;
  };
}

/** Single-entity convenience wrapper for callers that already know an id. */
export function useEntity(id: number | null | undefined): EntityView | undefined {
  const { byId } = useEntities();
  if (id == null) return undefined;
  return byId(id);
}
