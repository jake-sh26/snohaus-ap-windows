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
  /** Legacy field. PR #194 — prefer `short_name` for new code. */
  location: string;
  /** PR #194 — tight UI label (e.g. "Greenvale"). Backfilled from `location`. */
  short_name: string | null;
  legal_name: string;
  /** PR #192 — user-facing brand label (e.g. "Sno-Haus Greenvale"). */
  display_name: string | null;
  /** PR #194 — NY-registered DBA, a legal fact (e.g. "Sno-Haus Greenvale"). */
  dba: string | null;
  /** PR #192 — URL slug bridging AP StoreKey to integer ids ("greenvale"). */
  slug: string | null;
  /** PR #192 — EIN / corporate TIN (e.g. "86-3624190"). */
  tin: string | null;
  /** PR #192 — NY county for ST-810 jurisdiction selection. */
  county: string | null;
  /** PR #192 — Combined state+local sales tax rate in basis points (8625 = 8.625%). */
  rate_bps: number | null;
  /** PR #192 — NY DTF jurisdiction code (e.g. "NA 2811"). */
  dtf_code: string | null;
  /** PR #192 — QBO inventory account id this entity's POs route to. */
  qbo_inventory_account_id: string | null;
  /** PR #192 — QBO inventory account name (display only, snapshot). */
  qbo_inventory_account_name: string | null;
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
  //
  // PR #194 — surfaces the full canonical entity-name model + jurisdiction
  // fields. `location` is kept editable for one release cycle so callers that
  // still read it don't break; new code should treat `short_name` as the SoT.
  const [location, setLocation] = useState(entity.location);
  const [shortName, setShortName] = useState(entity.short_name ?? entity.location ?? "");
  const [legalName, setLegalName] = useState(entity.legal_name);
  const [displayName, setDisplayName] = useState(entity.display_name ?? "");
  const [dba, setDba] = useState(entity.dba ?? "");
  const [slug, setSlug] = useState(entity.slug ?? "");
  const [tin, setTin] = useState(entity.tin ?? "");
  const [county, setCounty] = useState(entity.county ?? "");
  const [rateBpsStr, setRateBpsStr] = useState(
    entity.rate_bps != null ? (entity.rate_bps / 1000).toFixed(3).replace(/\.?0+$/, "") : "",
  );
  const [dtfCode, setDtfCode] = useState(entity.dtf_code ?? "");
  const [qboAcctId, setQboAcctId] = useState(entity.qbo_inventory_account_id ?? "");
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

  // Parse rate input "8.625" → 8625 bps. Empty / NaN means "don't change".
  // We keep the string form as the form's SoT so the user's typing isn't
  // reformatted on every keystroke.
  const parsedRateBps: number | null = (() => {
    const t = rateBpsStr.trim();
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 1000);
  })();

  // Detect any drift from the server row. Treat null and "" as equivalent
  // so loading a row with NULL fields doesn't immediately mark it dirty.
  const eq = (a: string, b: string | null | undefined) => a.trim() === (b ?? "").trim();
  const hasChanges =
    !eq(location, entity.location) ||
    !eq(shortName, entity.short_name) ||
    !eq(legalName, entity.legal_name) ||
    !eq(displayName, entity.display_name) ||
    !eq(dba, entity.dba) ||
    !eq(slug, entity.slug) ||
    !eq(tin, entity.tin) ||
    !eq(county, entity.county) ||
    parsedRateBps !== (entity.rate_bps ?? null) ||
    !eq(dtfCode, entity.dtf_code) ||
    !eq(qboAcctId, entity.qbo_inventory_account_id) ||
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
        short_name: shortName.trim() || null,
        legal_name: legalName.trim(),
        display_name: displayName.trim() || null,
        dba: dba.trim() || null,
        slug: slug.trim() || null,
        tin: tin.trim() || null,
        county: county.trim() || null,
        rate_bps: parsedRateBps,
        dtf_code: dtfCode.trim() || null,
        qbo_inventory_account_id: qboAcctId.trim() || null,
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
    setShortName(entity.short_name ?? entity.location ?? "");
    setLegalName(entity.legal_name);
    setDisplayName(entity.display_name ?? "");
    setDba(entity.dba ?? "");
    setSlug(entity.slug ?? "");
    setTin(entity.tin ?? "");
    setCounty(entity.county ?? "");
    setRateBpsStr(
      entity.rate_bps != null ? (entity.rate_bps / 1000).toFixed(3).replace(/\.?0+$/, "") : "",
    );
    setDtfCode(entity.dtf_code ?? "");
    setQboAcctId(entity.qbo_inventory_account_id ?? "");
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
              {/* PR #194 — brand label on top (display_name), then legal
                  name as subtext. Falls back to short_name → location so
                  pre-backfill rows still render. */}
              <div className="text-base font-semibold truncate">
                {entity.display_name || entity.short_name || entity.location}
              </div>
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

      {/* ====================================================================
           PR #194 — Entity name model (5 fields). Each field has a distinct
           job: see per-field help text for which one lands on a tax filing
           vs. a brand surface vs. a URL.
           ==================================================================== */}
      <div className="rounded-md border border-border p-3 mb-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Names
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Short name</Label>
            <Input
              value={shortName}
              onChange={(e) => setShortName(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. Greenvale"
              data-testid={`input-short-name-${entity.id}`}
            />
            <div className="text-[11px] text-muted-foreground">Tight UI label used in tables, dropdowns, breadcrumbs.</div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Display name</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. Sno-Haus Greenvale"
              data-testid={`input-display-name-${entity.id}`}
            />
            <div className="text-[11px] text-muted-foreground">Brand-prefixed label used on cards, summaries, dashboards.</div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">DBA <span className="text-muted-foreground">(NY-registered)</span></Label>
            <Input
              value={dba}
              onChange={(e) => setDba(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. Sno-Haus Greenvale"
              data-testid={`input-dba-${entity.id}`}
            />
            <div className="text-[11px] text-muted-foreground">Doing-Business-As name on file with NY State. A legal fact.</div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Legal entity name</Label>
            <Input
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. SD Ski and Patio Inc"
              data-testid={`input-legal-name-${entity.id}`}
            />
            <div className="text-[11px] text-muted-foreground">Corporate name on NY DTF filings (ST-810 / ST-100 / payroll tax).</div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Slug <span className="text-muted-foreground">(URL key)</span></Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              disabled={!canEdit}
              placeholder="e.g. greenvale"
              data-testid={`input-slug-${entity.id}`}
            />
            <div className="text-[11px] text-muted-foreground">Lowercase key bridging AP module to payroll entities. Avoid changing.</div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Location <span className="text-muted-foreground">(legacy)</span></Label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              disabled={!canEdit}
              data-testid={`input-location-${entity.id}`}
            />
            <div className="text-[11px] text-muted-foreground">Legacy field. Keep in sync with Short name. Will be dropped next release.</div>
          </div>
        </div>
      </div>

      {/* PR #194 — Sales-tax jurisdiction fields. Previously only edited via
          direct DB poke; surfaced here so a rate or DTF code change doesn't
          need a deploy. */}
      <div className="rounded-md border border-border p-3 mb-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Sales tax
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">TIN <span className="text-muted-foreground">(EIN)</span></Label>
            <Input
              value={tin}
              onChange={(e) => setTin(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. 86-3624190"
              data-testid={`input-tin-${entity.id}`}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">NY county</Label>
            <Input
              value={county}
              onChange={(e) => setCounty(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. Nassau"
              data-testid={`input-county-${entity.id}`}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Tax rate <span className="text-muted-foreground">(%)</span></Label>
            <Input
              value={rateBpsStr}
              onChange={(e) => setRateBpsStr(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. 8.625"
              data-testid={`input-rate-${entity.id}`}
            />
            <div className="text-[11px] text-muted-foreground">Combined state + local. Stored as basis points internally.</div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">DTF jurisdiction code</Label>
            <Input
              value={dtfCode}
              onChange={(e) => setDtfCode(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. NA 2811"
              data-testid={`input-dtf-code-${entity.id}`}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs">QBO inventory account id <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              value={qboAcctId}
              onChange={(e) => setQboAcctId(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. 81"
              data-testid={`input-qbo-acct-${entity.id}`}
            />
            {entity.qbo_inventory_account_name && (
              <div className="text-[11px] text-muted-foreground">Currently linked: {entity.qbo_inventory_account_name}</div>
            )}
          </div>
        </div>
      </div>

      {/* Cadence + ADP */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
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
