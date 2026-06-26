import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  UserCircle, Loader2, AlertCircle, Mail, Phone, MapPin, Cake,
  Shirt, DollarSign, Calendar, History, Pencil, X, Save,
} from "lucide-react";

// ============================================================================
// PR #209 - My profile (self-view) page.
// ============================================================================
// Read-only view of the currently logged-in user's own employee record. Backed
// by GET /api/me/employee which already strips Shopify staff ID, Easyrent
// clerk GUID, Lighthouse clerk ID, ADP employee ID, and commission rate %
// before returning - none of those fields are interesting to the employee
// themselves, only to payroll admins.
//
// Visible to any authenticated user. If the user's app_users.person_id is not
// linked to a payroll_employees row, the server returns 404 and we show a
// helpful empty state. To link a login to an employee row, admin uses
// Settings -> Users or the link button on the Employees page.
//
// PR #211 - employee self-edit. The employee can now edit four fields about
// themselves (t-shirt size + emergency contact). Everything else stays
// read-only. The server-side PATCH /api/me/employee enforces the same
// whitelist as defense in depth, so even if this client sent more fields
// they would be dropped.

type SafeEmployee = {
  id: number;
  entity_id: number;
  full_name: string;
  email: string | null;
  phone: string | null;
  active: number;
  hired_at: string | null;
  notes: string | null;
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
  hourly_rate: number | null;
  vacation_hours_annual: number | null;
  sick_hours_annual: number | null;
  current_season_label: string | null;
  current_season_bonus: number | null;
  // Note: shopify_staff_member_id, easyrent_clerk_guid, ltm_clerk_id,
  // adp_employee_id, and commission_rate_pct are intentionally stripped by
  // the server and not in this type.
};

type BonusHistoryRow = {
  id: number;
  employee_id: number;
  season_label: string;
  bonus_amount: number;
  closed_at: string | null;
  created_at: string | null;
};

type MeResponse = {
  employee: SafeEmployee;
  bonus_history: BonusHistoryRow[];
};

type EntityRow = {
  id: number;
  location: string;
  legal_name: string;
};

// Display an ISO YYYY-MM-DD as MM/DD/YYYY. Matches PR #208 helper in
// PayrollEmployees.tsx; duplicated here to avoid cross-page imports.
function formatDateUS(s: string | null | undefined): string {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "\u2014";
  return `$${n.toFixed(2)}`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "\u2014";
  return String(n);
}

function fmtText(s: string | null | undefined): string {
  return s && s.trim() ? s : "\u2014";
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3 py-2 border-b border-border last:border-b-0">
      <div className="text-xs text-muted-foreground uppercase tracking-wide pt-0.5">{label}</div>
      <div className={mono ? "text-sm font-mono" : "text-sm"}>{value}</div>
    </div>
  );
}

// Single source of truth for the t-shirt sizes the system accepts. Matches
// the admin edit dialog in PayrollEmployees.tsx and the server-side validator
// in routes.ts (PR #211).
const TSHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"] as const;

export default function Me() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const meQ = useQuery<MeResponse>({
    queryKey: ["/api/me/employee"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/me/employee");
      return (await res.json()) as MeResponse;
    },
    // 404 means "no employee linked to this login" - that's a real state,
    // not an error to retry.
    retry: false,
  });

  // Entities for human-readable store name. We always fetch all entities so
  // the store name resolves even for ex-active stores.
  const entitiesQ = useQuery<EntityRow[]>({ queryKey: ["/api/payroll/entities"] });
  const entityById = new Map<number, EntityRow>();
  for (const e of entitiesQ.data || []) entityById.set(e.id, e);

  // --- PR #211: edit state for the two self-editable cards -----------------
  // Two cards independently toggle into edit mode: T-shirt size, and
  // Emergency contact. We deliberately keep these separate so saving one
  // doesn't open the other, and so a "Cancel" on one card doesn't blow away
  // the other's unsaved edits.
  const [editingTshirt, setEditingTshirt] = useState(false);
  const [editingEmergency, setEditingEmergency] = useState(false);

  // Drafts mirror the live values. We seed them from the server response and
  // re-seed any time the server snapshot changes (e.g. after a save).
  const [tshirtDraft, setTshirtDraft] = useState<string>("");
  const [ecNameDraft, setEcNameDraft] = useState<string>("");
  const [ecPhoneDraft, setEcPhoneDraft] = useState<string>("");
  const [ecRelDraft, setEcRelDraft] = useState<string>("");

  useEffect(() => {
    const emp = meQ.data?.employee;
    if (!emp) return;
    if (!editingTshirt) setTshirtDraft(emp.tshirt_size || "");
    if (!editingEmergency) {
      setEcNameDraft(emp.emergency_contact_name || "");
      setEcPhoneDraft(emp.emergency_contact_phone || "");
      setEcRelDraft(emp.emergency_contact_relationship || "");
    }
  }, [meQ.data?.employee, editingTshirt, editingEmergency]);

  const saveMut = useMutation({
    mutationFn: async (patch: Record<string, string | null>) => {
      const res = await apiRequest("PATCH", "/api/me/employee", patch);
      return (await res.json()) as MeResponse;
    },
    onSuccess: (data) => {
      // Write the fresh server snapshot directly into the cache so the page
      // reflects the new values without a second round-trip.
      qc.setQueryData(["/api/me/employee"], data);
      toast({ title: "Saved", description: "Your profile has been updated." });
      setEditingTshirt(false);
      setEditingEmergency(false);
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't save",
        description: err?.message || "Something went wrong. Please try again.",
        variant: "destructive",
      });
    },
  });

  function saveTshirt() {
    const v = tshirtDraft.trim();
    saveMut.mutate({ tshirt_size: v ? v : null });
  }

  function saveEmergency() {
    // Phone is normalized server-side too, but we trim here so a blank-with-
    // spaces value clears the field rather than storing "   ".
    saveMut.mutate({
      emergency_contact_name: ecNameDraft.trim() || null,
      emergency_contact_phone: ecPhoneDraft.trim() || null,
      emergency_contact_relationship: ecRelDraft.trim() || null,
    });
  }

  if (meQ.isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card className="p-10 flex items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin mr-2" />
          Loading your profile{"\u2026"}
        </Card>
      </div>
    );
  }

  if (meQ.isError || !meQ.data) {
    // Likely 404 - this login is not linked to an employee row yet.
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card className="p-10 text-center text-sm text-muted-foreground space-y-2">
          <AlertCircle className="size-6 mx-auto opacity-60" />
          <div className="font-medium text-foreground">No employee profile linked</div>
          <p>
            Your login isn't connected to a payroll employee record yet. Ask an admin
            to link your login on the Employees page (look for the key icon).
          </p>
        </Card>
      </div>
    );
  }

  const { employee: emp, bonus_history } = meQ.data;
  const ent = entityById.get(emp.entity_id);
  const isSaving = saveMut.isPending;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <UserCircle className="size-6 text-muted-foreground" />
          My profile
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Most fields are read-only. You can update your t-shirt size and emergency
          contact below. For anything else, reach out to payroll.
        </p>
      </div>

      <Card className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-lg font-semibold">{emp.full_name}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {ent?.location || `Entity #${emp.entity_id}`}
              {ent?.legal_name && (
                <span className="text-muted-foreground/70"> {"\u2014"} {ent.legal_name}</span>
              )}
            </div>
          </div>
          <Badge
            className={
              emp.active === 1
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-xs"
                : "text-xs"
            }
            variant={emp.active === 1 ? "default" : "outline"}
          >
            {emp.active === 1 ? "Active" : "Inactive"}
          </Badge>
        </div>

        <div>
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1.5">
            <Mail className="size-3.5" /> Contact
          </div>
          <Row label="Email" value={fmtText(emp.email)} />
          <Row label="Phone" value={fmtText(emp.phone)} />
          {/* TODO PR #212 - email/phone are currently read-only here. A future
              profile_change_requests table + admin approval flow will let
              employees propose updates to these "main contact" fields and
              their address without immediately writing them. */}
        </div>
      </Card>

      <Card className="p-5 space-y-1">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
            <Cake className="size-3.5" /> Personal
          </div>
          {!editingTshirt && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditingTshirt(true)}
              data-testid="button-edit-tshirt"
              className="h-7 text-xs gap-1"
            >
              <Pencil className="size-3" /> Edit t-shirt size
            </Button>
          )}
        </div>
        <Row label="Date of birth" value={emp.date_of_birth ? formatDateUS(emp.date_of_birth) : "\u2014"} />
        <Row label="Hired" value={emp.hired_at ? formatDateUS(emp.hired_at) : "\u2014"} />
        <Row
          label="T-shirt size"
          value={
            editingTshirt ? (
              <Select
                value={tshirtDraft || "__none__"}
                onValueChange={(v) => setTshirtDraft(v === "__none__" ? "" : v)}
              >
                <SelectTrigger className="h-8 w-32" data-testid="select-tshirt">
                  <SelectValue placeholder={"\u2014"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{"\u2014"}</SelectItem>
                  {TSHIRT_SIZES.map((sz) => (
                    <SelectItem key={sz} value={sz}>{sz}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="flex items-center gap-1.5">
                <Shirt className="size-3.5 text-muted-foreground" />
                {fmtText(emp.tshirt_size)}
              </span>
            )
          }
        />
        {editingTshirt && (
          <div className="flex justify-end gap-2 pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditingTshirt(false);
                setTshirtDraft(emp.tshirt_size || "");
              }}
              disabled={isSaving}
              data-testid="button-cancel-tshirt"
            >
              <X className="size-3.5 mr-1" /> Cancel
            </Button>
            <Button
              size="sm"
              onClick={saveTshirt}
              disabled={isSaving}
              data-testid="button-save-tshirt"
            >
              {isSaving ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <Save className="size-3.5 mr-1" />}
              Save
            </Button>
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-1">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1.5">
          <MapPin className="size-3.5" /> Address
        </div>
        <Row label="Street" value={fmtText(emp.address_line1)} />
        {emp.address_line2 && <Row label="Line 2" value={emp.address_line2} />}
        <Row
          label="City / State / ZIP"
          value={fmtText(
            [emp.city, emp.state, emp.postal_code].filter(Boolean).join(" ").trim() || null,
          )}
        />
        {/* TODO PR #212 - address edits go through the change-request flow. */}
      </Card>

      <Card className="p-5 space-y-1">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
            <Phone className="size-3.5" /> Emergency contact
          </div>
          {!editingEmergency && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditingEmergency(true)}
              data-testid="button-edit-emergency"
              className="h-7 text-xs gap-1"
            >
              <Pencil className="size-3" /> Edit
            </Button>
          )}
        </div>
        {editingEmergency ? (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
              <Label htmlFor="ec-name" className="text-xs text-muted-foreground uppercase tracking-wide">Name</Label>
              <Input
                id="ec-name"
                value={ecNameDraft}
                onChange={(e) => setEcNameDraft(e.target.value)}
                placeholder="Full name"
                data-testid="input-emergency-name"
                className="h-9"
              />
            </div>
            <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
              <Label htmlFor="ec-phone" className="text-xs text-muted-foreground uppercase tracking-wide">Phone</Label>
              <Input
                id="ec-phone"
                value={ecPhoneDraft}
                onChange={(e) => setEcPhoneDraft(e.target.value)}
                placeholder="(555) 555-1234"
                data-testid="input-emergency-phone"
                className="h-9"
              />
            </div>
            <div className="grid grid-cols-[160px_1fr] gap-3 items-center">
              <Label htmlFor="ec-rel" className="text-xs text-muted-foreground uppercase tracking-wide">Relationship</Label>
              <Input
                id="ec-rel"
                value={ecRelDraft}
                onChange={(e) => setEcRelDraft(e.target.value)}
                placeholder="e.g. Parent, Spouse, Sibling"
                data-testid="input-emergency-rel"
                className="h-9"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditingEmergency(false);
                  setEcNameDraft(emp.emergency_contact_name || "");
                  setEcPhoneDraft(emp.emergency_contact_phone || "");
                  setEcRelDraft(emp.emergency_contact_relationship || "");
                }}
                disabled={isSaving}
                data-testid="button-cancel-emergency"
              >
                <X className="size-3.5 mr-1" /> Cancel
              </Button>
              <Button
                size="sm"
                onClick={saveEmergency}
                disabled={isSaving}
                data-testid="button-save-emergency"
              >
                {isSaving ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <Save className="size-3.5 mr-1" />}
                Save
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Row label="Name" value={fmtText(emp.emergency_contact_name)} />
            <Row label="Phone" value={fmtText(emp.emergency_contact_phone)} />
            <Row label="Relationship" value={fmtText(emp.emergency_contact_relationship)} />
          </>
        )}
      </Card>

      <Card className="p-5 space-y-1">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1.5">
          <DollarSign className="size-3.5" /> Pay & time off
        </div>
        <Row
          label="Hourly rate"
          value={emp.hourly_rate != null ? `$${emp.hourly_rate.toFixed(2)} / hr` : "\u2014"}
        />
        <Row label="Vacation hrs / yr" value={fmtNum(emp.vacation_hours_annual)} />
        <Row label="Sick hrs / yr" value={fmtNum(emp.sick_hours_annual)} />
      </Card>

      <Card className="p-5 space-y-1">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1.5">
          <Calendar className="size-3.5" /> Current season bonus
        </div>
        <Row
          label="Season"
          value={emp.current_season_label || "\u2014"}
        />
        <Row
          label="Bonus to date"
          value={fmtMoney(emp.current_season_bonus)}
        />
        <p className="text-[11px] text-muted-foreground pt-1.5">
          Season bonus resets every April 1 and the prior amount moves to history below.
        </p>
      </Card>

      <Card className="p-5">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <History className="size-3.5" /> Bonus history
        </div>
        {bonus_history.length === 0 ? (
          <div className="text-xs text-muted-foreground py-2">No prior season bonuses on record yet.</div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {bonus_history.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="font-mono text-[10px]">{r.season_label}</Badge>
                  {r.closed_at && (
                    <span className="text-[11px] text-muted-foreground">
                      closed {formatDateUS(r.closed_at.slice(0, 10))}
                    </span>
                  )}
                </div>
                <span className="tabular-nums font-medium">${r.bonus_amount.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
