import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2, Pencil, BookOpen } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { STORE_LABELS } from "@/lib/format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { useAuth } from "@/lib/auth";

type Rule = any;

export default function Rules() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canEditRules = hasPermission("ap.edit_rules");
  const rulesQ = useQuery<Rule[]>({ queryKey: ["/api/rules"] });
  const [editing, setEditing] = useState<Rule | null>(null);
  const [creating, setCreating] = useState(false);

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/rules/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/rules"] }); toast({ title: "Rule deleted" }); },
  });

  return (
    <div className="px-8 pt-6 pb-12 max-w-[1100px] mx-auto">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Vendor Rules</h1>
        {canEditRules && <Button size="sm" onClick={() => setCreating(true)} data-testid="button-add-rule"><Plus className="size-4 mr-1" /> Add rule</Button>}
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Default routing per vendor. New invoices use these rules to suggest a store assignment.
      </p>

      <Card className="border-card-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Vendor</th>
              <th className="px-4 py-2.5 text-left font-medium">QBO ID</th>
              <th className="px-4 py-2.5 text-left font-medium">Default store</th>
              <th className="px-4 py-2.5 text-left font-medium">Note</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rulesQ.isLoading && Array.from({ length: 4 }).map((_, i) => (
              <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>
            ))}
            {!rulesQ.isLoading && (rulesQ.data || []).length === 0 && (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                <BookOpen className="size-6 mx-auto mb-2 opacity-50" />
                <div className="text-sm">No rules yet. Add one to automate vendor routing.</div>
              </td></tr>
            )}
            {(rulesQ.data || []).map((r) => (
              <tr key={r.id} data-testid={`row-rule-${r.id}`}>
                <td className="px-4 py-3 font-medium">{r.vendor_name}</td>
                <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{r.vendor_qbo_id || "—"}</td>
                <td className="px-4 py-3 text-xs">{r.default_store ? STORE_LABELS[r.default_store] : <span className="text-muted-foreground">—</span>}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground max-w-[300px] truncate">{r.note || "—"}</td>
                <td className="px-4 py-3 text-right">
                  {canEditRules ? (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(r)} data-testid={`button-edit-rule-${r.id}`}><Pencil className="size-3.5" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Delete rule for ${r.vendor_name}?`)) deleteMut.mutate(r.id); }} data-testid={`button-delete-rule-${r.id}`}>
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>

      {(editing || creating) && (
        <RuleDialog
          rule={editing || null}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["/api/rules"] }); }}
        />
      )}
    </div>
  );
}

function RuleDialog({ rule, onClose, onSaved }: { rule: Rule | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [vendorName, setVendorName] = useState(rule?.vendor_name || "");
  const [vendorId, setVendorId] = useState(rule?.vendor_qbo_id || "");
  const [defaultStore, setDefaultStore] = useState(rule?.default_store || "greenvale");
  const [note, setNote] = useState(rule?.note || "");
  const [vendorPickerOpen, setVendorPickerOpen] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");

  const vendorsQ = useQuery<any[]>({
    queryKey: ["/api/qbo-vendors", vendorSearch ? `?q=${encodeURIComponent(vendorSearch)}` : ""],
    enabled: vendorPickerOpen,
  });

  const save = useMutation({
    mutationFn: async () => {
      // rule_type is hidden in the UI now — always default to 100_percent.
      const body = { vendor_qbo_id: vendorId, vendor_name: vendorName, rule_type: "100_percent", default_store: defaultStore, note };
      const res = rule
        ? await apiRequest("PATCH", `/api/rules/${rule.id}`, body)
        : await apiRequest("POST", `/api/rules`, body);
      return res.json();
    },
    onSuccess: () => { toast({ title: rule ? "Rule updated" : "Rule created" }); onSaved(); onClose(); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New vendor rule"}</DialogTitle>
          <DialogDescription>Set default routing for invoices from this vendor.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Vendor</Label>
            <Popover open={vendorPickerOpen} onOpenChange={setVendorPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start font-normal" data-testid="button-pick-vendor-rule">
                  {vendorName || "Select QBO vendor…"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[360px] p-0">
                <Command shouldFilter={false}>
                  <CommandInput placeholder="Search vendors…" value={vendorSearch} onValueChange={setVendorSearch} />
                  <CommandList>
                    <CommandEmpty>No vendors</CommandEmpty>
                    <CommandGroup>
                      {(vendorsQ.data || []).slice(0, 30).map((v) => (
                        <CommandItem key={v.Id} value={v.Id} onSelect={() => { setVendorId(v.Id); setVendorName(v.DisplayName); setVendorPickerOpen(false); }}>
                          <span className="flex-1">{v.DisplayName}</span>
                          <span className="text-[10px] text-muted-foreground">#{v.Id}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div>
            <Label className="text-xs">Default store</Label>
            <Select value={defaultStore} onValueChange={setDefaultStore}>
              <SelectTrigger data-testid="select-rule-store"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="greenvale">Sno-Haus Greenvale</SelectItem>
                <SelectItem value="hempstead">Sno-Haus Hempstead</SelectItem>
                <SelectItem value="huntington">Sno-Haus Huntington</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Note</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Patio umbrellas, ship to Greenvale" data-testid="input-rule-note" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-rule">Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !vendorName} data-testid="button-save-rule">{save.isPending ? "Saving…" : "Save"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
