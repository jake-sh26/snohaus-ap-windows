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
  phone: string | null;
  shopify_staff_member_id: string | null;
  easyrent_clerk_guid: string | null;
  ltm_clerk_id: string | null;
  adp_employee_id: string | null;
  commission_rate_pct: number | null;
  active: number;
  hired_at: string | null;
  terminated_at: string | null;
  notes: string | null;
  // PR #208 — extended profile fields
  date_of_birth: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  tshirt_size: string | null;
  // PR #209 - payroll/time-off fields. Read by anyone with payroll.view,
  // edited only by payroll.edit_commissions (admin).
  hourly_rate: number | null;
  vacation_hours_annual: number | null;
  sick_hours_annual: number | null;
  current_season_label: string | null;
  current_season_bonus: number | null;
  created_at: string | null;
  updated_at: string | null;
};

// PR #208 — display an ISO YYYY-MM-DD as MM/DD/YYYY for read views.
// Leaves non-ISO strings alone so legacy bad data still renders.
function formatDateUS(s: string | null | undefined): string {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

type EntityRow = {
  id: number;
  location: string;
  legal_name: string;
  active: number;
};

export default function PayrollEmployees() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("payroll.edit_employees");
  const canEditCommissions = hasPermission("payroll.edit_commissions");
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
        e.phone || "",
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
                  {/* PR #209 - simplified table view. Sensitive IDs + commission
                      are no longer columns; they live in the edit dialog where
                      they're gated by payroll.edit_commissions (admin only). */}
                  <th className="text-left px-4 py-2.5 font-medium">Name</th>
                  <th className="text-left px-4 py-2.5 font-medium">Store</th>
                  <th className="text-left px-4 py-2.5 font-medium">Email</th>
                  <th className="text-left px-4 py-2.5 font-medium">Phone</th>
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
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant="outline" className="text-xs">
                          {ent?.location || `#${emp.entity_id}`}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-xs" data-testid={`text-employee-email-${emp.id}`}>
                        {emp.email || "—"}
                      </td>
                      <td className="px-4 py-2.5 text-xs tabular-nums" data-testid={`text-employee-phone-${emp.id}`}>
                        {emp.phone || "—"}
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
          canEditCommissions={canEditCommissions}
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
          canEditCommissions={canEditCommissions}
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
  canEditCommissions,
  onClose,
}: {
  mode: "create" | "edit";
  entities: EntityRow[];
  employee?: EmployeeRow;
  defaultEntityId?: number;
  canEditCommissions: boolean;
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
  const [phone, setPhone] = useState(employee?.phone || "");
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

  // PR #208 — extended profile fields
  const [dob, setDob] = useState(employee?.date_of_birth || "");
  const [addr1, setAddr1] = useState(employee?.address_line1 || "");
  const [addr2, setAddr2] = useState(employee?.address_line2 || "");
  const [city, setCity] = useState(employee?.city || "");
  const [stateRegion, setStateRegion] = useState(employee?.state || "");
  const [postal, setPostal] = useState(employee?.postal_code || "");
  const [ecName, setEcName] = useState(employee?.emergency_contact_name || "");
  const [ecPhone, setEcPhone] = useState(employee?.emergency_contact_phone || "");
  const [ecRel, setEcRel] = useState(employee?.emergency_contact_relationship || "");
  const [tshirt, setTshirt] = useState(employee?.tshirt_size || "");

  // PR #209 - payroll/time-off fields. Stored as strings so empty stays
  // distinct from 0. Server gates the payload on the way in - if the
  // caller lacks payroll.edit_commissions, those fields are silently
  // dropped and X-Pay-Fields-Dropped: 1 is set on the response.
  const [hourlyRate, setHourlyRate] = useState<string>(
    employee?.hourly_rate != null ? String(employee.hourly_rate) : "",
  );
  const [vacationHours, setVacationHours] = useState<string>(
    employee?.vacation_hours_annual != null ? String(employee.vacation_hours_annual) : "",
  );
  const [sickHours, setSickHours] = useState<string>(
    employee?.sick_hours_annual != null ? String(employee.sick_hours_annual) : "",
  );
  // Default season label: current fiscal year (Apr 1 - Mar 31). Matches
  // server's currentSeasonLabel() so a brand-new employee gets the right
  // label before the rollover cron runs.
  const defaultSeasonLabel = (() => {
    const d = new Date();
    const startYear = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
    const endYY = String((startYear + 1) % 100).padStart(2, "0");
    return `${startYear}-${endYY}`;
  })();
  const [seasonLabel, setSeasonLabel] = useState<string>(
    employee?.current_season_label || defaultSeasonLabel,
  );
  const [seasonBonus, setSeasonBonus] = useState<string>(
    employee?.current_season_bonus != null ? String(employee.current_season_bonus) : "",
  );

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

      // PR #208 — emergency contact phone normalization (same rule as employee phone)
      const ecPhoneRaw = ecPhone.trim();
      const ecPhoneClean = ecPhoneRaw
        ? (ecPhoneRaw.startsWith("+") ? "+" : "") + ecPhoneRaw.replace(/\D/g, "")
        : null;

      if (!fullName.trim()) throw new Error("Name is required");
      if (!entityId) throw new Error("Entity is required");

      // PR #207 — light email/phone normalization. Empty stays null. We
      // do NOT block on bad shapes (Jake can fix later); we just clean up.
      // Email: lowercase + trim. Basic shape check warns but doesn't block.
      const emailClean = email.trim().toLowerCase() || null;
      if (emailClean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
        throw new Error("Email doesn't look right (expected name@domain.tld)");
      }
      // Phone: keep + prefix if user typed it, strip everything else to
      // digits. "(516) 555-1234" → "5165551234"; "+1 516 555 1234" →
      // "+15165551234". We don't enforce a length so extensions etc. work.
      const phoneRaw = phone.trim();
      const phoneClean = phoneRaw
        ? (phoneRaw.startsWith("+") ? "+" : "") + phoneRaw.replace(/\D/g, "")
        : null;

      const payload: Record<string, any> = {
        full_name: fullName.trim(),
        entity_id: Number(entityId),
        email: emailClean,
        phone: phoneClean,
        shopify_staff_member_id: shopifyId.trim() || null,
        easyrent_clerk_guid: easyrentGuid.trim() || null,
        ltm_clerk_id: ltmId.trim() || null,
        adp_employee_id: adpId.trim() || null,
        hired_at: hiredAt.trim() || null,
        notes: notes.trim() || null,
        // PR #208 — extended profile fields
        date_of_birth: dob.trim() || null,
        address_line1: addr1.trim() || null,
        address_line2: addr2.trim() || null,
        city: city.trim() || null,
        state: stateRegion.trim() || null,
        postal_code: postal.trim() || null,
        emergency_contact_name: ecName.trim() || null,
        emergency_contact_phone: ecPhoneClean,
        emergency_contact_relationship: ecRel.trim() || null,
        tshirt_size: tshirt.trim() || null,
      };
      // Only include commission_rate_pct + payroll/time-off fields if the
      // user has permission. Server gates this too, but omitting here
      // avoids the X-Commission-Dropped / X-Pay-Fields-Dropped response
      // headers when non-admins save.
      if (canEditCommissions) {
        payload.commission_rate_pct = commission_rate_pct;
        const parseOptionalNumber = (s: string, name: string): number | null => {
          if (s.trim() === "") return null;
          const n = Number(s);
          if (!Number.isFinite(n) || n < 0) {
            throw new Error(`${name} must be a non-negative number`);
          }
          return n;
        };
        payload.hourly_rate = parseOptionalNumber(hourlyRate, "Hourly rate");
        payload.vacation_hours_annual = parseOptionalNumber(vacationHours, "Annual vacation hours");
        payload.sick_hours_annual = parseOptionalNumber(sickHours, "Annual sick hours");
        payload.current_season_bonus = parseOptionalNumber(seasonBonus, "Current season bonus");
        const labelTrim = seasonLabel.trim();
        if (labelTrim && !/^\d{4}-\d{2}$/.test(labelTrim)) {
          throw new Error("Season label must look like 2025-26");
        }
        payload.current_season_label = labelTrim || null;
      }

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
      {/* PR #210 - constrain to viewport, scroll the middle, pin header/footer.
          p-0 removes shadcn DialogContent default padding so the scroll
          container can own its own padding. */}
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-2 border-b border-border">
          <DialogTitle>
            {mode === "create" ? "Add employee" : `Edit ${employee?.full_name}`}
          </DialogTitle>
          <DialogDescription>
            Map this person to their Shopify, Easyrent, Lighthouse, and ADP IDs so
            payroll can attribute their sales and tips.
          </DialogDescription>
        </DialogHeader>

        {/* PR #210 - scrollable middle. Flex-1 takes remaining height
            between header and footer; overflow-y-auto handles the
            scroll. */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <Label htmlFor="phone" className="text-xs">
                Phone
              </Label>
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                data-testid="input-phone"
                placeholder="(516) 555-1234"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="commission_pct" className="text-xs">
                Commission rate %
                {!canEditCommissions && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground">(admin only)</span>
                )}
              </Label>
              <Input
                id="commission_pct"
                value={commissionPctText}
                onChange={(e) => setCommissionPctText(e.target.value)}
                data-testid="input-commission-pct"
                placeholder="e.g. 5 for 5%"
                inputMode="decimal"
                disabled={!canEditCommissions}
                title={!canEditCommissions ? "Admin only — you can view but not edit commission rates" : undefined}
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

          {/* PR #208 — Personal details (DOB, t-shirt) */}
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Personal details
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dob" className="text-xs">Date of birth</Label>
                <Input
                  id="dob"
                  type="date"
                  value={dob}
                  onChange={(e) => setDob(e.target.value)}
                  data-testid="input-dob"
                />
                {dob && (
                  <div className="text-[11px] text-muted-foreground">{formatDateUS(dob)}</div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tshirt" className="text-xs">T-shirt size</Label>
                <Select
                  value={tshirt || "__none__"}
                  onValueChange={(v) => setTshirt(v === "__none__" ? "" : v)}
                >
                  <SelectTrigger id="tshirt" data-testid="select-tshirt">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">—</SelectItem>
                    <SelectItem value="XS">XS</SelectItem>
                    <SelectItem value="S">S</SelectItem>
                    <SelectItem value="M">M</SelectItem>
                    <SelectItem value="L">L</SelectItem>
                    <SelectItem value="XL">XL</SelectItem>
                    <SelectItem value="XXL">XXL</SelectItem>
                    <SelectItem value="XXXL">XXXL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* PR #208 — Address */}
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Address
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="addr1" className="text-xs">Address line 1</Label>
              <Input id="addr1" value={addr1} onChange={(e) => setAddr1(e.target.value)} data-testid="input-addr1" placeholder="123 Main St" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="addr2" className="text-xs">Address line 2</Label>
              <Input id="addr2" value={addr2} onChange={(e) => setAddr2(e.target.value)} data-testid="input-addr2" placeholder="Apt, suite, etc. (optional)" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="city" className="text-xs">City</Label>
                <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} data-testid="input-city" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="state" className="text-xs">State</Label>
                <Input id="state" value={stateRegion} onChange={(e) => setStateRegion(e.target.value)} data-testid="input-state" placeholder="NY" maxLength={2} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="postal" className="text-xs">ZIP</Label>
                <Input id="postal" value={postal} onChange={(e) => setPostal(e.target.value)} data-testid="input-postal" placeholder="11743" />
              </div>
            </div>
          </div>

          {/* PR #208 — Emergency contact */}
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Emergency contact
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ec_name" className="text-xs">Name</Label>
                <Input id="ec_name" value={ecName} onChange={(e) => setEcName(e.target.value)} data-testid="input-ec-name" placeholder="Full name" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ec_phone" className="text-xs">Phone</Label>
                <Input id="ec_phone" type="tel" value={ecPhone} onChange={(e) => setEcPhone(e.target.value)} data-testid="input-ec-phone" placeholder="(516) 555-1234" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ec_rel" className="text-xs">Relationship</Label>
              <Input id="ec_rel" value={ecRel} onChange={(e) => setEcRel(e.target.value)} data-testid="input-ec-rel" placeholder="Parent, spouse, sibling, etc." />
            </div>
          </div>

          {/* PR #209 - Pay & time off. Read by anyone with payroll.view;
              edit gated by payroll.edit_commissions (admin only, just
              Jake). Season bonus auto-rolls over April 1 via the server
              cron in server/season-bonus-rollover.ts. */}
          <PayAndTimeOffSection
            mode={mode}
            employeeId={employee?.id}
            canEditCommissions={canEditCommissions}
            hourlyRate={hourlyRate} setHourlyRate={setHourlyRate}
            vacationHours={vacationHours} setVacationHours={setVacationHours}
            sickHours={sickHours} setSickHours={setSickHours}
            seasonLabel={seasonLabel} setSeasonLabel={setSeasonLabel}
            seasonBonus={seasonBonus} setSeasonBonus={setSeasonBonus}
          />

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

        <DialogFooter className="px-6 py-4 border-t border-border flex items-center justify-between sm:justify-between">
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

// ============================================================================
// PR #209 - Pay & time off section + season bonus history
// ============================================================================
// Embedded inside EmployeeDialog. All inputs disabled unless
// canEditCommissions. The history sub-list fetches GET /api/payroll/
// employees/:id/season-bonuses (payroll.view) and lets admins add closed
// seasons via POST or remove rows via DELETE /api/payroll/season-bonuses/:id.
// History is hidden in create mode (no employee id yet).

type SeasonBonusHistoryRow = {
  id: number;
  employee_id: number;
  season_label: string;
  bonus_amount: number;
  closed_at: string | null;
  created_at: string | null;
};

function PayAndTimeOffSection({
  mode,
  employeeId,
  canEditCommissions,
  hourlyRate, setHourlyRate,
  vacationHours, setVacationHours,
  sickHours, setSickHours,
  seasonLabel, setSeasonLabel,
  seasonBonus, setSeasonBonus,
}: {
  mode: "create" | "edit";
  employeeId?: number;
  canEditCommissions: boolean;
  hourlyRate: string; setHourlyRate: (v: string) => void;
  vacationHours: string; setVacationHours: (v: string) => void;
  sickHours: string; setSickHours: (v: string) => void;
  seasonLabel: string; setSeasonLabel: (v: string) => void;
  seasonBonus: string; setSeasonBonus: (v: string) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Pay & time off
        </div>
        {!canEditCommissions && (
          <span className="text-[10px] text-muted-foreground">(admin only - view)</span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="hourly_rate" className="text-xs">Hourly rate ($/hr)</Label>
          <Input
            id="hourly_rate"
            value={hourlyRate}
            onChange={(e) => setHourlyRate(e.target.value)}
            data-testid="input-hourly-rate"
            placeholder="e.g. 22.50"
            inputMode="decimal"
            disabled={!canEditCommissions}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vacation_hours" className="text-xs">Vacation hrs / yr</Label>
          <Input
            id="vacation_hours"
            value={vacationHours}
            onChange={(e) => setVacationHours(e.target.value)}
            data-testid="input-vacation-hours"
            placeholder="e.g. 80"
            inputMode="decimal"
            disabled={!canEditCommissions}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sick_hours" className="text-xs">Sick hrs / yr</Label>
          <Input
            id="sick_hours"
            value={sickHours}
            onChange={(e) => setSickHours(e.target.value)}
            data-testid="input-sick-hours"
            placeholder="e.g. 40"
            inputMode="decimal"
            disabled={!canEditCommissions}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="season_label" className="text-xs">Current season</Label>
          <Input
            id="season_label"
            value={seasonLabel}
            onChange={(e) => setSeasonLabel(e.target.value)}
            data-testid="input-season-label"
            placeholder="2025-26"
            disabled={!canEditCommissions}
          />
          <div className="text-[10px] text-muted-foreground">Apr 1 - Mar 31. Auto-rolls over.</div>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="season_bonus" className="text-xs">Current season bonus ($)</Label>
          <Input
            id="season_bonus"
            value={seasonBonus}
            onChange={(e) => setSeasonBonus(e.target.value)}
            data-testid="input-season-bonus"
            placeholder="e.g. 1500"
            inputMode="decimal"
            disabled={!canEditCommissions}
          />
        </div>
      </div>
      {mode === "edit" && employeeId != null && (
        <SeasonBonusHistory employeeId={employeeId} canEdit={canEditCommissions} />
      )}
    </div>
  );
}

function SeasonBonusHistory({
  employeeId,
  canEdit,
}: {
  employeeId: number;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const histQ = useQuery<SeasonBonusHistoryRow[]>({
    queryKey: [`/api/payroll/employees/${employeeId}/season-bonuses`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/payroll/employees/${employeeId}/season-bonuses`);
      return (await res.json()) as SeasonBonusHistoryRow[];
    },
  });
  const [addLabel, setAddLabel] = useState("");
  const [addAmount, setAddAmount] = useState("");

  const addMut = useMutation({
    mutationFn: async () => {
      const label = addLabel.trim();
      if (!/^\d{4}-\d{2}$/.test(label)) throw new Error("Season label must look like 2024-25");
      const amt = Number(addAmount);
      if (!Number.isFinite(amt) || amt < 0) throw new Error("Bonus amount must be a non-negative number");
      const res = await apiRequest("POST", `/api/payroll/employees/${employeeId}/season-bonuses`, {
        season_label: label,
        bonus_amount: amt,
      });
      return await res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/payroll/employees/${employeeId}/season-bonuses`] });
      setAddLabel(""); setAddAmount("");
      toast({ title: "Bonus history saved" });
    },
    onError: (e: any) => toast({ title: "Could not save bonus", description: e?.message || "Unknown error", variant: "destructive" }),
  });

  const delMut = useMutation({
    mutationFn: async (bonusId: number) => {
      const res = await apiRequest("DELETE", `/api/payroll/season-bonuses/${bonusId}`);
      return await res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/payroll/employees/${employeeId}/season-bonuses`] });
      toast({ title: "Bonus removed" });
    },
    onError: (e: any) => toast({ title: "Could not remove", description: e?.message || "Unknown error", variant: "destructive" }),
  });

  const rows = histQ.data || [];
  return (
    <div className="pt-2 border-t border-border space-y-2">
      <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        Prior season bonuses
      </div>
      {histQ.isLoading ? (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" />Loading history—
        </div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">No prior season bonuses yet.</div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between px-2.5 py-1.5 text-xs" data-testid={`row-bonus-history-${r.id}`}>
              <div className="flex items-center gap-3">
                <Badge variant="outline" className="font-mono text-[10px]">{r.season_label}</Badge>
                <span className="tabular-nums">${r.bonus_amount.toFixed(2)}</span>
                {r.closed_at && (
                  <span className="text-[10px] text-muted-foreground">closed {formatDateUS(r.closed_at.slice(0, 10))}</span>
                )}
              </div>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-destructive hover:text-destructive"
                  onClick={() => {
                    if (confirm(`Remove ${r.season_label} bonus of $${r.bonus_amount.toFixed(2)}?`)) {
                      delMut.mutate(r.id);
                    }
                  }}
                  disabled={delMut.isPending}
                  data-testid={`button-delete-bonus-${r.id}`}
                >
                  <UserX className="size-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-end pt-1">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Season</Label>
            <Input
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="2024-25"
              className="h-8 text-xs"
              data-testid="input-add-bonus-label"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">Bonus ($)</Label>
            <Input
              value={addAmount}
              onChange={(e) => setAddAmount(e.target.value)}
              placeholder="e.g. 1500"
              className="h-8 text-xs"
              inputMode="decimal"
              data-testid="input-add-bonus-amount"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => addMut.mutate()}
            disabled={addMut.isPending || !addLabel.trim() || !addAmount.trim()}
            data-testid="button-add-bonus"
          >
            {addMut.isPending ? <Loader2 className="size-3 animate-spin" /> : "Add"}
          </Button>
        </div>
      )}
    </div>
  );
}
