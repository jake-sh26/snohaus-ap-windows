import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";

/**
 * Gates rendering of children behind an RBAC permission check.
 *
 * Usage:
 *   <PermissionGate perm="users.view">
 *     <SettingsSidebarLink />
 *   </PermissionGate>
 *
 *   <PermissionGate perm="payroll.export_adp" entityId={1}>
 *     <ExportButton />
 *   </PermissionGate>
 *
 * Omit `entityId` to check whether the user has the permission for ANY entity
 * (e.g. just to decide whether a top-level link should appear). Pass an
 * entityId to require a grant that covers that specific entity (either an
 * all-entities grant or a grant scoped to that entity).
 *
 * Renders `fallback` (default: null) when the user lacks the permission, so
 * non-Owners simply don't see admin-only affordances.
 */
export function PermissionGate({
  perm,
  entityId,
  children,
  fallback = null,
}: {
  perm: string;
  entityId?: number;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { hasPermission } = useAuth();
  if (!hasPermission(perm, entityId)) return <>{fallback}</>;
  return <>{children}</>;
}
