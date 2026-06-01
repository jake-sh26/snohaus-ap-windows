/**
 * RBAC (Role-Based Access Control) — permission resolver and Express middleware.
 *
 * Three-dimensional access model:
 *   1. Module access  — which features can the user see at all
 *   2. Entity scope   — `user_roles.entity_id_scope` (NULL = all entities)
 *   3. Action scope   — read vs export vs edit vs admin (encoded in permission keys)
 *
 * Back-compat: anyone with `app_users.role='admin'` is automatically granted the
 * 'Owner' role via the seedRbacBaseline() migration in storage.ts. Permission
 * checks here will therefore treat legacy admins as if they have every permission
 * across every entity. New routes can adopt requirePermission() without breaking
 * existing flows.
 */
import type { Request, Response, NextFunction } from "express";
import { sqlite } from "./storage";

/** A single permission grant: key + the entity it applies to (null = all). */
export type PermissionGrant = {
  key: string;
  entity_id_scope: number | null;
};

/**
 * Resolve the full set of permission grants for a user. Pulls from user_roles →
 * roles → role_permissions → permissions. Returns deduplicated grants.
 *
 * If the user has the same permission via multiple roles, the most permissive
 * scope wins: a grant with entity_id_scope=NULL ("all entities") supersedes
 * any scoped grant for the same permission key.
 */
export function getUserPermissions(userId: number): PermissionGrant[] {
  const rows = sqlite.prepare(`
    SELECT p.key AS key, ur.entity_id_scope AS entity_id_scope
    FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = ?
  `).all(userId) as Array<{ key: string; entity_id_scope: number | null }>;

  // Dedupe + collapse: if any grant for a key has scope=NULL, drop the others.
  const byKey = new Map<string, Set<number | null>>();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, new Set());
    byKey.get(r.key)!.add(r.entity_id_scope);
  }
  const out: PermissionGrant[] = [];
  for (const [key, scopes] of byKey.entries()) {
    if (scopes.has(null)) {
      out.push({ key, entity_id_scope: null });
    } else {
      for (const s of scopes) out.push({ key, entity_id_scope: s });
    }
  }
  return out;
}

/**
 * Does this user have the given permission for the given entity?
 *
 * @param userId
 * @param permissionKey   e.g. "payroll.export_adp"
 * @param entityId        null = caller doesn't care about scope (any grant counts).
 *                        number = must have either an all-entity grant OR a
 *                                 specific grant for this entity.
 */
export function userHasPermission(
  userId: number,
  permissionKey: string,
  entityId: number | null = null,
): boolean {
  // Fast path: check if the user has the legacy admin flag (= Owner role from seed).
  // We still do the SQL lookup below because the Owner assignment is what actually
  // grants permissions — this fast path is just for the case where the seed
  // somehow hasn't run yet.
  if (entityId === null) {
    const row = sqlite.prepare(`
      SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ? AND p.key = ?
      LIMIT 1
    `).get(userId, permissionKey);
    return !!row;
  }

  const row = sqlite.prepare(`
    SELECT 1 FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = ?
      AND p.key = ?
      AND (ur.entity_id_scope IS NULL OR ur.entity_id_scope = ?)
    LIMIT 1
  `).get(userId, permissionKey, entityId);
  return !!row;
}

/**
 * Returns the list of entity IDs this user can access for a given permission.
 * If they have an all-entity grant, returns null (= unrestricted).
 * Otherwise returns the list of specific entity IDs they're scoped to.
 *
 * Used by API routes that need to filter rows: e.g. GET /api/payroll/lines
 * should only return rows for entities the user is allowed to see.
 */
export function getEntityScopesForPermission(
  userId: number,
  permissionKey: string,
): { unrestricted: boolean; entityIds: number[] } {
  const rows = sqlite.prepare(`
    SELECT DISTINCT ur.entity_id_scope AS scope
    FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = ? AND p.key = ?
  `).all(userId, permissionKey) as Array<{ scope: number | null }>;

  if (rows.length === 0) return { unrestricted: false, entityIds: [] };
  if (rows.some((r) => r.scope === null)) return { unrestricted: true, entityIds: [] };
  return { unrestricted: false, entityIds: rows.map((r) => r.scope!).filter((s) => s != null) };
}

/**
 * Express middleware factory. Use AFTER authMiddleware so `req.email` and
 * (preferably) `req.userId` are populated.
 *
 * Usage:
 *   app.get("/api/payroll/lines", authMiddleware, requirePermission("payroll.view"), handler);
 *
 * With entity scoping (entity_id must be on the request):
 *   app.post(
 *     "/api/payroll/export/:entityId",
 *     authMiddleware,
 *     requirePermission("payroll.export_adp", { entityIdFrom: "params.entityId" }),
 *     handler,
 *   );
 */
export function requirePermission(
  permissionKey: string,
  opts: {
    /**
     * Path inside `req` to the entity_id to scope-check against.
     * e.g. "params.entityId" or "body.entity_id" or "query.entityId".
     * If omitted, no entity scope check is performed (any grant for the
     * permission counts).
     */
    entityIdFrom?: string;
  } = {},
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).userId as number | undefined;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    let entityId: number | null = null;
    if (opts.entityIdFrom) {
      const parts = opts.entityIdFrom.split(".");
      let cursor: any = req;
      for (const p of parts) cursor = cursor?.[p];
      const parsed = Number(cursor);
      if (Number.isFinite(parsed)) entityId = parsed;
    }
    if (!userHasPermission(userId, permissionKey, entityId)) {
      return res.status(403).json({
        message: "Forbidden",
        required_permission: permissionKey,
        entity_id: entityId,
      });
    }
    next();
  };
}

/**
 * Finance-section gate with graceful cutover (PR #165).
 *
 * The Finance section is migrating from `payroll.view` to the new
 * `finance.view` permission. During the cutover, /api/recon/finance/* routes
 * accept EITHER permission: a user passes if they have finance.view OR the
 * legacy payroll.view. The seedRbacBaseline() auto-grant gives finance.view to
 * every payroll.view holder on boot, so in practice both checks succeed for
 * existing users; the OR keeps the very first boot (pre-grant) from locking
 * anyone out. New sales-tax routes do NOT use this — they require the strict
 * finance.sales_tax.* keys with no legacy fallback.
 */
export function requireFinanceView() {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).userId as number | undefined;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (
      userHasPermission(userId, "finance.view") ||
      userHasPermission(userId, "payroll.view")
    ) {
      return next();
    }
    return res.status(403).json({
      message: "Forbidden",
      required_permission: "finance.view",
    });
  };
}
