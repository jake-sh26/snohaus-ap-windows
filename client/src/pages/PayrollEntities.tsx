import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, Save, Percent, Plus, History, AlertTriangle,
  Loader2, CheckCircle2, XCircle,
} from "lucide-react";

// ============================================================================
// Payroll > Entities — admin page for the 3 legal entities (Greenvale,
// Huntington, Hempstead). Feature flags control which payroll modules
// (commissions, tips, easyrent, etc.) apply to each entity. The CC fee %
// is editable per-entity and time-bounded (history kept for old payroll runs).
// ============================================================================

type EntityRow = {
  id: number;
  location: string;
  legal_name: string;
  cadence: "weekly" | "biweekly";
  adp_company_code: string | null;
  commissions_enabled: number;
  pms_enabled: number;
  tips_enabled: number;
  easyrent_enabled: number;
  spif_enabled: number;
  active: number;
  current_tip_cc_fee_pct: number | null;
  current_tip_cc_fee_id: number | null;
};

type FeeRow = {
  id: number;
  entity_id: number;
  fee_kind: string;
  fee_pct: number;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at: string | null;
};

export default function PayrollEntities() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("payroll.edit_employees");
  const entitiesQ = useQuery<EntityRow[]>({ queryKey: ["/api/payroll/entities"] });
  const entities = entitiesQ.data || [];

  return (
    <div className="px-8 pt-6 pb-12 max-w-[1100px] mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Entities</h1>
        {!canEdit && (
          <Badge variant="outline" className="text-[11px]">View only</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        The legal entities payroll runs against. Toggle which payroll modules
        apply to each entity. Tip CC fee % is the Shift4 processing fee
        deducted from credit-card tips before they go to ADP.
      </p>

      {entitiesQ.isLoading && (
        <div className="text-sm text-muted-foreground py-10 text-center">
          <Loader2 className="size-4 animate-spin inline mr-2" />Loading entities…
        </div>
      )}

      <div className="space-y-4">
        {entities.map((e) => (
          <EntityCard key={e.id} entity={e} canEdit={canEdit} />
        ))}
      </div>
    </div>
  );
}

function EntityCard({ entity, canEdit }: { entity: EntityRow; canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  // Local form state, seeded from server. We track the pristine row so we can
  // detect unsaved changes and enable/disable Save.
  const [location, setLocation] = useState(entity.location);
  const [legalName, setLegalName] = useState(entity.legal_name);
  const [cadence, setCadence] = useState<"weekly" | "biweekly">(entity.cadence);
  const [adpCode, setAdpCode] = useState(entity.adp_company_code || "");
  const [commissionsEnabled, setCommissionsEnabled] = useState(entity.commissions_enabled === 1);
  const [pmsEnabled, setPmsEnabled] = useState(entity.pms_enabled === 1);
  const [tipsEnabled, setTipsEnabled] = useState(entity.tips_enabled === 1);
  const [easyrentEnabled, setEasyrentEnabled] = useState(entity.easyrent_enabled === 1);
  const [spifEnabled, setSpifEnabled] = useState(entity.spif_enabled === 1);
  const [active, setActive] = useState(entity.active === 1);
  const [feeDialogOpen, setFeeDialogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Detect any drift from the server row.
  const hasChanges =
    location !== entity.location ||
    legalName !== entity.legal_name ||
    cadence !== entity.cadence ||
    (adpCode || "") !== (entity.adp_company_code || "") ||
    commissionsEnabled !== (entity.commissions_enabled === 1) ||
    pmsEnabled !== (entity.pms_enabled === 1) ||
    tipsEnabled !== (entity.tips_enabled === 1) ||
    easyrentEnabled !== (entity.easyrent_enabled === 1) ||
    spifEnabled !== (entity.spif_enabled === 1) ||
    active !== (entity.active === 1);

  const saveMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/payroll/entities/${entity.id}`, {
        location: location.trim(),
        legal_name: legalName.trim(),
        cadence,
        adp_company_code: adpCode.trim() || null,
        commissions_enabled: commissionsEnabled ? 1 : 0,
        pms_enabled: pmsEnabled ? 1 : 0,
        tips_enabled: tipsEnabled ? 1 : 0,
        easyrent_enabled: easyrentEnabled ? 1 : 0,
        spif_enabled: spifEnabled ? 1 : 0,
        active: active ? 1 : 0,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Entity saved" });
      qc.invalidateQueries({ queryKey: ["/api/payroll/entities"] });
      qc.invalidateQueries({ queryKey: ["/api/settings/entities"] });
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  function discard() {
    setLocation(entity.location);
    setLegalName(entity.legal_name);
    setCadence(entity.cadence);
    setAdpCode(entity.adp_company_code || "");
    setCommissionsEnabled(entity.commissions_enabled === 1);
    setPmsEnabled(entity.pms_enabled === 1);
    setTipsEnabled(entity.tips_enabled === 1);
    setEasyrentEnabled(entity.easyrent_enabled === 1);
    setSpifEnabled(entity.spif_enabled === 1);
    setActive(entity.active === 1);
  }

  return (
    <Card className="border-card-border p-5">
      {/* Header — location is primary, legal name is subtext (per PR #5 spec) */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <Building2 className="size-5 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-base font-semibold truncate">{entity.location}</div>
              {!active && <Badge variant="outline" className="text-[10px] text-slate-500">Inactive</Badge>}
            </div>
            <div className="text-xs text-muted-foreground truncate">{entity.legal_name}</div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-muted-foreground">Tip CC fee</div>
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => canEdit && setFeeDialogOpen(true)}
            className="text-sm font-medium tabular-nums hover:underline disabled:no-underline disabled:cursor-default"
            data-testid={`button-edit-fee-${entity.id}`}
          >
            {entity.current_tip_cc_fee_pct !== null
              ? `${(entity.current_tip_cc_fee_pct * 100).toFixed(2)}%`
              : "Not set"}
          </button>
        </div>
      </div>

      {/* Editable fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Location</Label>
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            disabled={!canEdit}
            data-testid={`input-location-${entity.id}`}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Legal entity name</Label>
          <Input
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            disabled={!canEdit}
            data-testid={`input-legal-name-${entity.id}`}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Pay cadence</Label>
          <Select value={cadence} onValueChange={(v) => setCadence(v as any)} disabled={!canEdit}>
            <SelectTrigger className="h-9" data-testid={`select-cadence-${entity.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="biweekly">Bi-weekly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">ADP company code <span className="text-muted-foreground">(optional)</span></Label>
          <Input
            value={adpCode}
            onChange={(e) => setAdpCode(e.target.value)}
            disabled={!canEdit}
            placeholder="e.g. SDP"
            data-testid={`input-adp-code-${entity.id}`}
          />
        </div>
      </div>

      {/* Feature flags */}
      <div className="rounded-md border border-border p-3 space-y-2 mb-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
          Payroll modules
        </div>
        <FeatureToggle
          label="Commissions"
          description="Weekly Shopify sales-based commission calculations."
          checked={commissionsEnabled}
          onCheckedChange={setCommissionsEnabled}
          disabled={!canEdit}
          testId={`toggle-commissions-${entity.id}`}
        />
        <FeatureToggle
          label="PMs (price match bonuses)"
          description="Monthly bonus payments — paid in first weekly run of the next month."
          checked={pmsEnabled}
          onCheckedChange={setPmsEnabled}
          disabled={!canEdit}
          testId={`toggle-pms-${entity.id}`}
        />
        <FeatureToggle
          label="Tips"
          description="Shift4 LTM credit-card tips, reduced by the CC fee % above."
          checked={tipsEnabled}
          onCheckedChange={setTipsEnabled}
          disabled={!canEdit}
          testId={`toggle-tips-${entity.id}`}
        />
        <FeatureToggle
          label="Easyrent"
          description="Ski/snowboard rental commissions from Wintersteiger Easyrent."
          checked={easyrentEnabled}
          onCheckedChange={setEasyrentEnabled}
          disabled={!canEdit}
          testId={`toggle-easyrent-${entity.id}`}
        />
        <FeatureToggle
          label="SPIFs"
          description="Vendor SPIF programs (manufacturer incentive spiff payouts)."
          checked={spifEnabled}
          onCheckedChange={setSpifEnabled}
          disabled={!canEdit}
          testId={`toggle-spif-${entity.id}`}
        />
      </div>

      {/* Active toggle (separate row, more emphasis) */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 mb-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Active</div>
          <div className="text-[11px] text-muted-foreground">
            Inactive entities are hidden from payroll runs and reports but their history is preserved.
          </div>
        </div>
        <Switch
          checked={active}
          onCheckedChange={setActive}
          disabled={!canEdit}
          data-testid={`toggle-active-${entity.id}`}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => saveMut.mutate()}
          disabled={!canEdit || !hasChanges || saveMut.isPending}
          data-testid={`button-save-entity-${entity.id}`}
        >
          {saveMut.isPending ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Save className="size-3.5 mr-1.5" />}
          Save
        </Button>
        {hasChanges && (
          <Button size="sm" variant="ghost" onClick={discard} data-testid={`button-discard-entity-${entity.id}`}>
            Discard
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => setHistoryOpen(true)}
          data-testid={`button-fee-history-${entity.id}`}
        >
          <History className="size-3.5 mr-1.5" /> Fee history
        </Button>
      </div>

      {feeDialogOpen && (
        <FeeDialog
          entity={entity}
          onClose={() => setFeeDialogOpen(false)}
          onSaved={() => {
            setFeeDialogOpen(false);
            qc.invalidateQueries({ queryKey: ["/api/payroll/entities"] });
            qc.invalidateQueries({ queryKey: [`/api/payroll/entities/${entity.id}/fees`] });
          }}
        />
      )}
      {historyOpen && (
        <FeeHistoryDialog
          entity={entity}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </Card>
  );
}

function FeatureToggle({
  label, description, checked, onCheckedChange, disabled, testId,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} data-testid={testId} />
    </div>
  );
}

function FeeDialog({
  entity, onClose, onSaved,
}: {
  entity: EntityRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  // Default the new fee to today, but use the existing pct as a starting value
  // so the dialog shows what the rate currently is.
  const [pctStr, setPctStr] = useState(
    entity.current_tip_cc_fee_pct !== null
      ? (entity.current_tip_cc_fee_pct * 100).toFixed(3).replace(/\.?0+$/, "")
      : "",
  );
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");

  const saveMut = useMutation({
    mutationFn: async () => {
      const pct = Number(pctStr) / 100;
      const res = await apiRequest("POST", `/api/payroll/entities/${entity.id}/fees`, {
        fee_kind: "tip_cc_fee",
        fee_pct: pct,
        effective_from: effectiveFrom,
        note: note.trim() || null,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Fee updated" });
      onSaved();
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const pctNum = Number(pctStr);
  const valid = Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 100 && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tip CC fee — {entity.location}</DialogTitle>
          <DialogDescription>
            Set a new credit-card processing fee % that gets deducted from tips
            before they go to ADP. The previous rate is preserved in history so
            older payroll runs still resolve to the rate that was in effect at
            the time.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Fee %</Label>
            <div className="relative">
              <Input
                value={pctStr}
                onChange={(e) => setPctStr(e.target.value)}
                placeholder="3.8"
                inputMode="decimal"
                data-testid="input-fee-pct"
              />
              <Percent className="size-3.5 text-muted-foreground absolute right-3 top-1/2 -translate-y-1/2" />
            </div>
            <div className="text-[11px] text-muted-foreground">
              Enter a percentage (e.g. 3.8 for 3.8%). Stored as 0.038 in the database.
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Effective from</Label>
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              data-testid="input-fee-from"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Note (optional)</Label>
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why is this changing?"
              data-testid="input-fee-note"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              size="sm"
              disabled={!valid || saveMut.isPending}
              onClick={() => saveMut.mutate()}
              data-testid="button-save-fee"
            >
              {saveMut.isPending && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FeeHistoryDialog({ entity, onClose }: { entity: EntityRow; onClose: () => void }) {
  const q = useQuery<FeeRow[]>({ queryKey: [`/api/payroll/entities/${entity.id}/fees`] });
  const rows = q.data || [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Fee history — {entity.location}</DialogTitle>
          <DialogDescription>
            All processing-fee changes for this entity. Newest first.
          </DialogDescription>
        </DialogHeader>
        {q.isLoading && (
          <div className="text-sm text-muted-foreground py-4 text-center">
            <Loader2 className="size-4 animate-spin inline mr-2" />Loading…
          </div>
        )}
        {!q.isLoading && rows.length === 0 && (
          <div className="text-sm text-muted-foreground py-4 text-center">
            No fee history yet. Click the fee % above to set one.
          </div>
        )}
        <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
          {rows.map((r, idx) => (
            <div
              key={r.id}
              className="rounded-md border border-border p-2.5 text-sm flex items-start gap-3"
              data-testid={`fee-history-row-${r.id}`}
            >
              <div className="shrink-0 mt-0.5">
                {idx === 0 ? (
                  <CheckCircle2 className="size-4 text-emerald-500" />
                ) : (
                  <XCircle className="size-4 text-muted-foreground/50" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium tabular-nums">{(r.fee_pct * 100).toFixed(2)}%</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">{r.fee_kind}</Badge>
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {r.effective_from} → {r.effective_to || "current"}
                </div>
                {r.note && (
                  <div className="text-[11px] text-muted-foreground mt-1 italic">{r.note}</div>
                )}
              </div>
            </div>
          ))}
        </div>
        {rows.length > 0 && rows[0].fee_pct > 0.1 && (
          <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 p-2 text-xs text-amber-800 dark:text-amber-300">
            <AlertTriangle className="size-3.5 inline mr-1.5" />
            Current rate is above 10% — double-check before payroll runs.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
