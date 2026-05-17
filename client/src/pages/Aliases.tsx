import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2, Tag, ArrowRight } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";

export default function Aliases() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const aliasesQ = useQuery<any[]>({ queryKey: ["/api/aliases"] });
  const [creating, setCreating] = useState(false);

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/aliases/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/aliases"] }); toast({ title: "Alias deleted" }); },
  });

  return (
    <div className="px-8 pt-6 pb-12 max-w-[1100px] mx-auto">
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Vendor Aliases</h1>
        <Button size="sm" onClick={() => setCreating(true)} data-testid="button-add-alias"><Plus className="size-4 mr-1" /> Add alias</Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Map invoice header names to QBO vendor records. Useful when a parent company sends bills under a different name.
      </p>

      <Card className="border-card-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Invoice name</th>
              <th className="px-4 py-2.5 text-left font-medium"></th>
              <th className="px-4 py-2.5 text-left font-medium">QBO Vendor</th>
              <th className="px-4 py-2.5 text-left font-medium">Note</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {aliasesQ.isLoading && Array.from({ length: 2 }).map((_, i) => (
              <tr key={i}><td colSpan={5} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>
            ))}
            {!aliasesQ.isLoading && (aliasesQ.data || []).length === 0 && (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                <Tag className="size-6 mx-auto mb-2 opacity-50" />
                <div className="text-sm">No aliases yet.</div>
              </td></tr>
            )}
            {(aliasesQ.data || []).map((a) => (
              <tr key={a.id} data-testid={`row-alias-${a.id}`}>
                <td className="px-4 py-3 font-medium">{a.alias}</td>
                <td className="px-4 py-3 text-muted-foreground"><ArrowRight className="size-3.5" /></td>
                <td className="px-4 py-3">{a.vendor_name} <span className="text-xs text-muted-foreground ml-1">#{a.vendor_qbo_id}</span></td>
                <td className="px-4 py-3 text-xs text-muted-foreground max-w-[300px] truncate">{a.note || "—"}</td>
                <td className="px-4 py-3 text-right">
                  <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Delete alias "${a.alias}"?`)) deleteMut.mutate(a.id); }} data-testid={`button-delete-alias-${a.id}`}>
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>

      {creating && <AliasDialog onClose={() => setCreating(false)} onSaved={() => qc.invalidateQueries({ queryKey: ["/api/aliases"] })} />}
    </div>
  );
}

function AliasDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [alias, setAlias] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const vendorsQ = useQuery<any[]>({
    queryKey: ["/api/qbo-vendors", search ? `?q=${encodeURIComponent(search)}` : ""],
    enabled: open,
  });

  const save = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/aliases", { alias, vendor_qbo_id: vendorId, vendor_name: vendorName, note }).then((r) => r.json()),
    onSuccess: () => { toast({ title: "Alias saved" }); onSaved(); onClose(); },
  });

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New vendor alias</DialogTitle>
          <DialogDescription>Map a header name found on invoices to a QBO vendor.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Invoice name (alias)</Label>
            <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="e.g. N-Brands" data-testid="input-alias" />
          </div>
          <div>
            <Label className="text-xs">QBO Vendor</Label>
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start font-normal" data-testid="button-pick-vendor-alias">
                  {vendorName || "Select QBO vendor…"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[360px] p-0">
                <Command shouldFilter={false}>
                  <CommandInput placeholder="Search…" value={search} onValueChange={setSearch} />
                  <CommandList>
                    <CommandEmpty>No vendors</CommandEmpty>
                    <CommandGroup>
                      {(vendorsQ.data || []).slice(0, 30).map((v) => (
                        <CommandItem key={v.Id} value={v.Id} onSelect={() => { setVendorId(v.Id); setVendorName(v.DisplayName); setOpen(false); }}>
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
            <Label className="text-xs">Note</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} data-testid="input-alias-note" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !alias || !vendorId} data-testid="button-save-alias">{save.isPending ? "Saving…" : "Save"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
