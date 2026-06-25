import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Users, Plus, Pencil, UserX, Loader2, Search, Eye, EyeOff,
  KeyRound, Link2Off, AlertCircle,
} from "lucide-react";

// ============================================================================
// Payroll > Employees — master table of every payable person across the 3
// legal entities. This is the bridge between Shopify staff IDs, Easyrent
// clerk GUIDs, Lighthouse Transaction Manager clerk IDs, and ADP employee
// IDs. Without an employee row, payroll can't attribute sales to a person.
//
// Soft-delete only: deactivating sets active=0 and terminated_at=today so
// historical payroll runs still resolve correctly.
// ============================================================================

type EmployeeRow = {
  id: number;
  entity_id: number;
  full_name: string;
  email: string | null;
  shopify_staff_member_id: string | null;
  easyrent_clerk_guid: string | null;
  ltm_clerk_id: string | null;
  adp_employee_id: string | null;
  commission_rate_pct: number | null;
  active: number;
  hired_at: string | null;
  terminated_at: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type EntityRow = {
  id: number;
  location: string;
  legal_name: string;
  active: number;
};

export default function PayrollEmployees() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("payroll.edit_employees");
  const canManageLinks = hasPermission("users.manage_links");

  const [entityFilter, setEntityFilter] = useState<string>("all"); // "all" or entity id as string
  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [linkDialog, setLinkDialog] = useState<{
    employeeId: number;
    employeeName: string;
    currentUserId: number | null;
    currentUserEmail: string | null;
  } | null>(null);

  // Link state (PR #201) — employee ↔ user via person_id. Only fetched if the
  // viewer has the manage-links perm so we don't burn calls for non-admins.
  const linksQ = useQuery<any[]>({
    queryKey: ["/api/people-links/employees"],
    enabled: canManageLinks,
  });
  const linkByEmpId = new Map<number, any>();
  for (const row of linksQ.data || []) linkByEmpId.set(row.employee_id, row);

  // Build the query key carefully so React Query refetches when filters change.
  const empQ = useQuery<EmployeeRow[]>({
    queryKey: ["/api/payroll/employees", entityFilter, includeInactive],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (entityFilter !== "all") params.set("entity_id", entityFilter);
      if (includeInactive) params.set("include_inactive", "1");
      const qs = params.toString();
      const url = `/api/payroll/employees${qs ? `?${qs}` : ""}`;
      const res = await apiRequest("GET", url);
      return (await res.json()) as EmployeeRow[];
    },
  });

  // Entities for filter dropdown + lookup in rows. We always fetch all
  // entities (including inactive) so historical employees still display
  // their entity name even after the entity is turned off.
  const entitiesQ = useQuery<EntityRow[]>({ queryKey: ["/api/payroll/entities"] });
  const entities = entitiesQ.data || [];
  const entityById = useMemo(() => {
    const m = new Map<number, EntityRow>();
    for (const e of entities) m.set(e.id, e);
    return m;
  }, [entities]);

  const employees = empQ.data || [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => {
      const haystack = [
        e.full_name,
        e.email || "",
        e.shopify_staff_member_id || "",
        e.easyrent_clerk_guid || "",
        e.ltm_clerk_id || "",
        e.adp_employee_id || "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [employees, search]);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Users className="size-6 text-muted-foreground" />
            Employees
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Master list of payable people. Maps each person to their Shopify, Easyrent,
            Lighthouse, and ADP IDs so payroll can attribute sales and tips correctly.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!canEdit && (
            <Badge variant="outline" className="text-xs">
              View only
            </Badge>
          )}
          {canEdit && (
            <Button onClick={() => setCreating(true)} data-testid="button-add-employee">
              <Plus className="size-4 mr-1.5" />
              Add employee
            </Button>
          )}
        </div>
      </div>

      {/* Filters + search */}
      <Card className="p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Entity</Label>
            <Select value={entityFilter} onValueChange={setEntityFilter}>
              <SelectTrigger className="w-56 h-9" data-testid="select-entity-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entities</SelectItem>
                {entities.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.location}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email, Shopify ID, clerk ID…"
                className="pl-8 h-9"
                data-testid="input-employee-search"
              />
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setIncludeInactive((v) => !v)}
            data-testid="button-toggle-inactive"
            className="gap-1.5"
          >
            {includeInactive ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            {includeInactive ? "Showing inactive" : "Hiding inactive"}
          </Button>
        </div>
      </Card>

      {/* List */}
      {empQ.isLoading ? (
        <Card className="p-10 flex items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin mr-2" />
          Loading employees…
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground text-sm">
          {employees.length === 0
            ? "No employees yet. Add your first one above."
            : "No employees match the current filters."}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">Name</th>
                  <th className="text-left px-4 py-2.5 font-medium">Entity</th>
                  <th className="text-left px-4 py-2.5 font-medium">Shopify staff</th>
                  <th className="text-left px-4 py-2.5 font-medium">Easyrent clerk</th>
                  <th className="text-left px-4 py-2.5 font-medium">ADP ID</th>
                  <th className="text-right px-4 py-2.5 font-medium">Commission %</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  {canManageLinks && (
                    <th className="text-left px-4 py-2.5 font-medium">Login</th>
                  )}
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((emp) => {
                  const ent = entityById.get(emp.entity_id);
                  const isActive = emp.active === 1;
                  return (
                    <tr
                      key={emp.id}
                      className={`border-t border-border ${isActive ? "" : "opacity-50"}`}
                      data-testid={`row-employee-${emp.id}`}
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium" data-testid={`text-employee-name-${emp.id}`}>
                          {emp.full_name}
                        </div>
                        {emp.email && (
                          <div className="text-xs text-muted-foreground">{emp.email}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant="outline" className="text-xs">
                          {ent?.location || `#${emp.entity_id}`}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                        {emp.shopify_staff_member_id || "—"}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                        {emp.easyrent_clerk_guid || "—"}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                        {emp.adp_employee_id || "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {emp.commission_rate_pct != null
                          ? `${(emp.commission_rate_pct * 100).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        {isActive ? (
                          <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-xs">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">
                            Inactive
                          </Badge>
                        )}
                      </td>
                      {canManageLinks && (
                        <td className="px-4 py-2.5">
                          {(() => {
                            const link = linkByEmpId.get(emp.id);
                            if (link?.linked_user_id) {
                              return (
                                <div className="flex items-center gap-1.5 text-xs">
                                  <KeyRound className="size-3 text-emerald-500" />
                                  <span className="font-mono truncate max-w-[180px]" data-testid={`text-linked-user-${emp.id}`}>
                                    {link.linked_user_email}
                                  </span>
                                </div>
                              );
                            }
                            if (linksQ.data) {
                              return (
                                <span className="text-xs text-muted-foreground flex items-center gap-1" data-testid={`text-no-login-${emp.id}`}>
                                  <AlertCircle className="size-3 opacity-50" />
                                  No login
                                </span>
                              );
                            }
                            return <span className="text-xs text-muted-foreground">—</span>;
                          })()}
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex justify-end gap-0.5">
                          {canManageLinks && (() => {
                            const link = linkByEmpId.get(emp.id);
                            return (
                              <Button
                                variant="ghost"
                                size="sm"
                                title={link?.linked_user_id ? "Change linked login" : "Link to a login"}
                                onClick={() =>
                                  setLinkDialog({
                                    employeeId: emp.id,
                                    employeeName: emp.full_name,
                                    currentUserId: link?.linked_user_id ?? null,
                                    currentUserEmail: link?.linked_user_email ?? null,
                                  })
                                }
                                data-testid={`button-link-user-${emp.id}`}
                              >
                                <KeyRound className="size-3.5" />
                              </Button>
                            );
                          })()}
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditing(emp)}
                              data-testid={`button-edit-employee-${emp.id}`}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Create dialog */}
      {creating && (
        <EmployeeDialog
          mode="create"
          entities={entities}
          defaultEntityId={entityFilter !== "all" ? Number(entityFilter) : undefined}
          onClose={() => setCreating(false)}
        />
      )}

      {/* Edit dialog */}
      {editing && (
        <EmployeeDialog
          mode="edit"
          entities={entities}
          employee={editing}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Link to login dialog (PR #201) */}
      {linkDialog && (
        <EmployeeLinkUserDialog
          employeeId={linkDialog.employeeId}
          employeeName={linkDialog.employeeName}
          currentUserId={linkDialog.currentUserId}
          currentUserEmail={linkDialog.currentUserEmail}
          onClose={() => setLinkDialog(null)}
          onSaved={() => setLinkDialog(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Add / edit dialog
// ============================================================================

function EmployeeDialog({
  mode,
  entities,
  employee,
  defaultEntityId,
  onClose,
}: {
  mode: "create" | "edit";
  entities: EntityRow[];
  employee?: EmployeeRow;
  defaultEntityId?: number;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [fullName, setFullName] = useState(employee?.full_name || "");
  const [entityId, setEntityId] = useState<string>(
    employee
      ? String(employee.entity_id)
      : defaultEntityId !== undefined
        ? String(defaultEntityId)
        : entities[0]
          ? String(entities[0].id)
          : "",
  );
  const [email, setEmail] = useState(employee?.email || "");
  const [shopifyId, setShopifyId] = useState(employee?.shopify_staff_member_id || "");
  const [easyrentGuid, setEasyrentGuid] = useState(employee?.easyrent_clerk_guid || "");
  const [ltmId, setLtmId] = useState(employee?.ltm_clerk_id || "");
  const [adpId, setAdpId] = useState(employee?.adp_employee_id || "");
  // Commission % is stored as 0-1 in DB; we present it as e.g. "5.0" meaning 5%.
  const [commissionPctText, setCommissionPctText] = useState(
    employee?.commission_rate_pct != null
      ? (employee.commission_rate_pct * 100).toFixed(2)
      : "",
  );
  const [hiredAt, setHiredAt] = useState(employee?.hired_at || "");
  const [notes, setNotes] = useState(employee?.notes || "");
  const [active, setActive] = useState(employee ? employee.active === 1 : true);

  const saveMut = useMutation({
    mutationFn: async () => {
      // Parse commission % from user-friendly percent input into 0-1 fraction.
      let commission_rate_pct: number | null = null;
      if (commissionPctText.trim() !== "") {
        const n = Number(commissionPctText);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          throw new Error("Commission % must be between 0 and 100");
        }
        commission_rate_pct = n / 100;
      }

      if (!fullName.trim()) throw new Error("Name is required");
      if (!entityId) throw new Error("Entity is required");

      const payload: Record<string, any> = {
        full_name: fullName.trim(),
        entity_id: Number(entityId),
        email: email.trim() || null,
        shopify_staff_member_id: shopifyId.trim() || null,
        easyrent_clerk_guid: easyrentGuid.trim() || null,
        ltm_clerk_id: ltmId.trim() || null,
        adp_employee_id: adpId.trim() || null,
        commission_rate_pct,
        hired_at: hiredAt.trim() || null,
        notes: notes.trim() || null,
      };

      if (mode === "create") {
        const res = await apiRequest("POST", "/api/payroll/employees", payload);
        return await res.json();
      } else {
        // On edit, also include `active` so the toggle in the dialog works.
        payload.active = active ? 1 : 0;
        const res = await apiRequest(
          "PATCH",
          `/api/payroll/employees/${employee!.id}`,
          payload,
        );
        return await res.json();
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/payroll/employees"] });
      toast({
        title: mode === "create" ? "Employee added" : "Employee updated",
        description: fullName,
      });
      onClose();
    },
    onError: (e: any) => {
      toast({
        title: "Could not save",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    },
  });

  // Soft-delete (deactivate) only available on edit. Hard delete is intentionally
  // not exposed — payroll history needs to keep resolving this employee.
  const deactivateMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/payroll/employees/${employee!.id}`);
      return await res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/payroll/employees"] });
      toast({
        title: "Employee deactivated",
        description: `${employee!.full_name} marked inactive`,
      });
      onClose();
    },
    onError: (e: any) => {
      toast({
        title: "Could not deactivate",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Add employee" : `Edit ${employee?.full_name}`}
          </DialogTitle>
          <DialogDescription>
            Map this person to their Shopify, Easyrent, Lighthouse, and ADP IDs so
            payroll can attribute their sales and tips.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="full_name" className="text-xs">
                Full name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="full_name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                data-testid="input-full-name"
                placeholder="Jane Doe"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Entity <span className="text-destructive">*</span>
              </Label>
              <Select value={entityId} onValueChange={setEntityId}>
                <SelectTrigger data-testid="select-entity">
                  <SelectValue placeholder="Pick an entity" />
                </SelectTrigger>
                <SelectContent>
                  {entities.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.location}{" "}
                      <span className="text-muted-foreground">— {e.legal_name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-xs">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="input-email"
                placeholder="jane@snohaus.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hired_at" className="text-xs">
                Hired
              </Label>
              <Input
                id="hired_at"
                type="date"
                value={hiredAt}
                onChange={(e) => setHiredAt(e.target.value)}
                data-testid="input-hired-at"
              />
            </div>
          </div>

          {/* External system IDs — these are the whole point of this page. */}
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              External system IDs
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="shopify_id" className="text-xs">
                  Shopify staff member ID
                </Label>
                <Input
                  id="shopify_id"
                  value={shopifyId}
                  onChange={(e) => setShopifyId(e.target.value)}
                  data-testid="input-shopify-id"
                  placeholder="gid://shopify/StaffMember/12345"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="easyrent_guid" className="text-xs">
                  Easyrent clerk GUID
                </Label>
                <Input
                  id="easyrent_guid"
                  value={easyrentGuid}
                  onChange={(e) => setEasyrentGuid(e.target.value)}
                  data-testid="input-easyrent-guid"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ltm_id" className="text-xs">
                  Lighthouse clerk ID
                </Label>
                <Input
                  id="ltm_id"
                  value={ltmId}
                  onChange={(e) => setLtmId(e.target.value)}
                  data-testid="input-ltm-id"
                  placeholder="Shift4 LTM clerk"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adp_id" className="text-xs">
                  ADP employee ID
                </Label>
                <Input
                  id="adp_id"
                  value={adpId}
                  onChange={(e) => setAdpId(e.target.value)}
                  data-testid="input-adp-id"
                  placeholder="Used in ADP Run CSV export"
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="commission_pct" className="text-xs">
                Commission rate %
              </Label>
              <Input
                id="commission_pct"
                value={commissionPctText}
                onChange={(e) => setCommissionPctText(e.target.value)}
                data-testid="input-commission-pct"
                placeholder="e.g. 5 for 5%"
                inputMode="decimal"
              />
              <div className="text-[11px] text-muted-foreground">
                Default commission rate. Per-product overrides come later via SPIF rules.
              </div>
            </div>
            {mode === "edit" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Status</Label>
                <div className="flex items-center gap-3 h-9">
                  <Switch
                    checked={active}
                    onCheckedChange={setActive}
                    data-testid="switch-active"
                  />
                  <span className="text-sm">{active ? "Active" : "Inactive"}</span>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes" className="text-xs">
              Notes
            </Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="input-notes"
              placeholder="Optional — role, department, anything that doesn't fit above"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <div>
            {mode === "edit" && employee?.active === 1 && (
              <Button
                variant="outline"
                onClick={() => {
                  if (confirm(`Mark ${employee.full_name} as inactive? Payroll history will be preserved.`)) {
                    deactivateMut.mutate();
                  }
                }}
                disabled={deactivateMut.isPending}
                data-testid="button-deactivate"
                className="text-destructive hover:text-destructive"
              >
                {deactivateMut.isPending ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <UserX className="size-3.5 mr-1.5" />
                )}
                Deactivate
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} data-testid="button-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
              data-testid="button-save-employee"
            >
              {saveMut.isPending && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
              {mode === "create" ? "Add employee" : "Save changes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Employee → Login link dialog (PR #201)
// ============================================================================
// Mirror of UserLinkEmployeeDialog (in Settings.tsx), initiated from the
// Employees page. Picks a target login (app_users row) to link to this
// employee. Block-on-conflict: 409 if that login is already attached to a
// different employee — operator must unlink there first.

function EmployeeLinkUserDialog({
  employeeId,
  employeeName,
  currentUserId,
  currentUserEmail,
  onClose,
  onSaved,
}: {
  employeeId: number;
  employeeName: string;
  currentUserId: number | null;
  currentUserEmail: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const usersQ = useQuery<any[]>({ queryKey: ["/api/people-links/users"] });
  const all = usersQ.data || [];
  const filtered = search.trim()
    ? all.filter((u: any) =>
        (u.user_email || "").toLowerCase().includes(search.toLowerCase()) ||
        (u.user_name || "").toLowerCase().includes(search.toLowerCase()),
      )
    : all;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["/api/people-links/users"] });
    qc.invalidateQueries({ queryKey: ["/api/people-links/employees"] });
  }

  async function pick(userId: number) {
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", `/api/people-links/employees/${employeeId}/link`, { user_id: userId });
      const body = await res.json().catch(() => ({}));
      if (body?.archived_person_id) {
        toast({
          title: "Linked",
          description: `Old standalone person (id ${body.archived_person_id}) archived because nothing else referenced it.`,
        });
      } else {
        toast({ title: "Linked" });
      }
      invalidate();
      onSaved();
    } catch (e: any) {
      const msg = e?.message || String(e);
      toast({
        title: msg.includes("already linked") ? "Already linked" : "Error",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function unlink() {
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", `/api/people-links/employees/${employeeId}/unlink`, {});
      const body = await res.json().catch(() => ({}));
      if (body?.archived_person_id) {
        toast({
          title: "Unlinked",
          description: `Old shared person (id ${body.archived_person_id}) archived because nothing else referenced it.`,
        });
      } else {
        toast({ title: "Unlinked" });
      }
      invalidate();
      onSaved();
    } catch (e: any) {
      toast({ title: "Error", description: e?.message || String(e), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link login</DialogTitle>
          <DialogDescription>
            Employee <span className="font-medium text-foreground">{employeeName}</span> is currently{" "}
            {currentUserId
              ? <>linked to login <span className="font-mono">{currentUserEmail}</span>.</>
              : <>not linked to any login user.</>}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder="Search logins by email or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            data-testid="input-link-user-search"
          />
          <div className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
            {usersQ.isLoading && (
              <div className="text-sm text-muted-foreground py-4 text-center">
                <Loader2 className="size-4 animate-spin inline mr-2" />Loading logins…
              </div>
            )}
            {!usersQ.isLoading && filtered.length === 0 && (
              <div className="text-sm text-muted-foreground py-4 text-center">No logins match.</div>
            )}
            {filtered.map((u: any) => {
              const isCurrent = u.user_id === currentUserId;
              const claimedByOther = u.linked_employee_id && u.linked_employee_id !== employeeId;
              return (
                <button
                  key={u.user_id}
                  type="button"
                  disabled={submitting || isCurrent}
                  onClick={() => pick(u.user_id)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                    isCurrent ? "bg-muted/40" : "hover:bg-muted/60"
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                  data-testid={`link-user-row-${u.user_id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs truncate">{u.user_email}</div>
                    {u.user_name && (
                      <div className="text-xs text-muted-foreground truncate">{u.user_name}</div>
                    )}
                  </div>
                  {isCurrent && <Badge variant="outline" className="text-[10px]">Current</Badge>}
                  {!isCurrent && claimedByOther && (
                    <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">
                      Linked to {u.linked_employee_name || `#${u.linked_employee_id}`}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Picking a login already linked to another employee will be blocked.
            Unlink that employee first.
          </p>
        </div>
        <div className="flex justify-between gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={unlink}
            disabled={submitting || !currentUserId}
            data-testid="button-unlink-user"
          >
            <Link2Off className="size-3.5 mr-1.5" />
            Unlink (keep separate)
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
