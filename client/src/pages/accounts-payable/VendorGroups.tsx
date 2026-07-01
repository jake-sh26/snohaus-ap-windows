// Vendor Groups settings — moved out of /settings into AP-module-local
// /accounts-payable/settings/vendor-groups (PR: AP Settings hub).
//
// Lets Jake configure parent companies and their sub-brands. Each group has
// members (real QBO vendors) with brand keywords. The invoice drawer reads
// these to auto-suggest which brand an invoice's inventory should code to.
//
// The card body and helper text live here; the parent ApSettings page wraps
// it in tabbed chrome. The implementation is a verbatim move of the
// VendorGroupsCard / VendorGroupRow / VendorGroupMemberRow trio that used to
// live in pages/Settings.tsx (Round 7), preserved so React-Query keys and
// `data-testid`s stay stable.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
} from "@/components/ui/command";
import { Layers, ChevronDown, Plus, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";

interface VendorGroup {
  id: number;
  name: string;
  parent_qbo_id: string | null;
  parent_qbo_name: string | null;
  members: Array<{
    id: number;
    group_id: number;
    vendor_qbo_id: string;
    vendor_qbo_name: string;
    brand_keywords: string | null;
  }>;
}

export default function VendorGroups() {
  return (
    <Card className="border-card-border p-5">
      <div className="flex items-center gap-3 mb-2">
        <Layers className="size-4 text-muted-foreground" />
        <div className="text-sm font-medium">Vendor Groups</div>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Group parent companies that ship invoices for multiple sub-brands
        (e.g. <span className="font-medium">Amer Sports</span> → Atomic, Salomon).
        When an invoice matches a group, the drawer shows a brand picker so you
        can route inventory to the right QBO vendor. Brand keywords help auto-suggest
        the correct brand from PDF text.
      </p>
      <VendorGroupsCard />
    </Card>
  );
}

function VendorGroupsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canEditRules = hasPermission("ap.edit_rules");
  const groupsQ = useQuery<VendorGroup[]>({ queryKey: ["/api/vendor-groups"] });
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/vendor-groups", { name: newName.trim() });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Group created" });
      setNewName("");
      setCreatingOpen(false);
      qc.invalidateQueries({ queryKey: ["/api/vendor-groups"] });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/vendor-groups/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/vendor-groups"] });
    },
  });

  const groups = groupsQ.data || [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {groups.length === 0 ? "No groups yet." : `${groups.length} group${groups.length === 1 ? "" : "s"}`}
        </div>
        {canEditRules && <Button size="sm" variant="outline" onClick={() => setCreatingOpen(true)} data-testid="button-add-vendor-group">
          <Plus className="size-3 mr-1" /> Add group
        </Button>}
      </div>
      {groups.map((g) => (
        <VendorGroupRow key={g.id} group={g} canEditRules={canEditRules} onDelete={() => {
          if (window.confirm(`Delete group "${g.name}" and all its members?`)) deleteMut.mutate(g.id);
        }} />
      ))}
      <Dialog open={creatingOpen} onOpenChange={setCreatingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New vendor group</DialogTitle>
            <DialogDescription>Give it a name like "Amer Sports" or "Rossignol Groupe". You'll add member brands next.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Group name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Amer Sports" data-testid="input-new-group-name" />
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => setCreatingOpen(false)}>Cancel</Button>
            <Button onClick={() => createMut.mutate()} disabled={!newName.trim() || createMut.isPending} data-testid="button-confirm-create-group">
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function VendorGroupRow({ group, onDelete, canEditRules }: { group: VendorGroup; onDelete: () => void; canEditRules: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(true);
  const [vendorPickerOpen, setVendorPickerOpen] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");
  const [pendingVendor, setPendingVendor] = useState<{ id: string; name: string } | null>(null);
  const [keywords, setKeywords] = useState("");

  const vendorsQ = useQuery<any[]>({
    queryKey: ["/api/qbo-vendors", vendorSearch ? `?q=${encodeURIComponent(vendorSearch)}` : ""],
    enabled: vendorPickerOpen,
  });

  const addMemberMut = useMutation({
    mutationFn: async (data: { vendor_qbo_id: string; vendor_qbo_name: string; brand_keywords: string | null }) => {
      const res = await apiRequest("POST", `/api/vendor-groups/${group.id}/members`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Brand added" });
      setPendingVendor(null);
      setKeywords("");
      qc.invalidateQueries({ queryKey: ["/api/vendor-groups"] });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const updateMemberMut = useMutation({
    mutationFn: async (data: { id: number; brand_keywords: string }) => {
      const res = await apiRequest("PATCH", `/api/vendor-groups/members/${data.id}`, { brand_keywords: data.brand_keywords });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/vendor-groups"] }),
  });

  const removeMemberMut = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/vendor-groups/members/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/vendor-groups"] }),
  });

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <button
          className="flex items-center gap-2 text-left flex-1 min-w-0"
          onClick={() => setExpanded(!expanded)}
          data-testid={`button-toggle-group-${group.id}`}
        >
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} />
          <div className="font-medium text-sm">{group.name}</div>
          <div className="text-xs text-muted-foreground">{group.members.length} brand{group.members.length === 1 ? "" : "s"}</div>
        </button>
        {canEditRules && <Button size="sm" variant="ghost" onClick={onDelete} data-testid={`button-delete-group-${group.id}`}>
          <Trash2 className="size-3.5 text-muted-foreground" />
        </Button>}
      </div>
      {expanded && (
        <div className="mt-3 space-y-2">
          {group.members.map((m) => (
            <VendorGroupMemberRow
              key={m.id}
              member={m}
              canEditRules={canEditRules}
              onSaveKeywords={(kw) => updateMemberMut.mutate({ id: m.id, brand_keywords: kw })}
              onRemove={() => {
                if (window.confirm(`Remove ${m.vendor_qbo_name} from ${group.name}?`)) removeMemberMut.mutate(m.id);
              }}
            />
          ))}
          {/* Add member */}
          {canEditRules && <div className="rounded-md border border-dashed border-border p-2 space-y-2">
            <div className="flex items-center gap-2">
              <Popover open={vendorPickerOpen} onOpenChange={setVendorPickerOpen}>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" data-testid={`button-pick-vendor-${group.id}`}>
                    {pendingVendor ? pendingVendor.name : "Pick QBO vendor…"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[320px] p-0">
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Search QBO vendors…" value={vendorSearch} onValueChange={setVendorSearch} />
                    <CommandList className="max-h-[280px] overflow-y-auto">
                      <CommandEmpty>No vendors found.</CommandEmpty>
                      <CommandGroup>
                        {(vendorsQ.data || []).map((v: any) => {
                          // QBO vendor list uses { Id, DisplayName } shape.
                          const id = v.Id || v.qbo_id || v.id;
                          const name = v.DisplayName || v.name || "";
                          return (
                            <CommandItem
                              key={id}
                              value={id}
                              onSelect={() => {
                                setPendingVendor({ id, name });
                                setVendorPickerOpen(false);
                                setVendorSearch("");
                              }}
                            >
                              {name}
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <Input
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="Brand keywords (comma-separated, optional)"
                className="flex-1 h-9 text-sm"
                data-testid={`input-brand-keywords-${group.id}`}
              />
              <Button
                size="sm"
                onClick={() => {
                  if (!pendingVendor) return;
                  addMemberMut.mutate({
                    vendor_qbo_id: pendingVendor.id,
                    vendor_qbo_name: pendingVendor.name,
                    brand_keywords: keywords.trim() || null,
                  });
                }}
                disabled={!pendingVendor || addMemberMut.isPending}
                data-testid={`button-add-member-${group.id}`}
              >
                <Plus className="size-3 mr-1" /> Add
              </Button>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Pick a real QBO vendor and (optionally) list keywords found in invoices for this brand. Example for Atomic: <span className="font-mono">atomic, redster, backland</span>.
            </div>
          </div>}
        </div>
      )}
    </div>
  );
}

function VendorGroupMemberRow({ member, onSaveKeywords, onRemove, canEditRules }: {
  member: { id: number; vendor_qbo_id: string; vendor_qbo_name: string; brand_keywords: string | null };
  onSaveKeywords: (kw: string) => void;
  onRemove: () => void;
  canEditRules: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(member.brand_keywords || "");
  return (
    <div className="flex items-center gap-2 rounded-md bg-card border border-border px-2 py-1.5">
      <div className="font-medium text-sm w-40 truncate">{member.vendor_qbo_name}</div>
      {!canEditRules ? (
        <span className="flex-1 text-left text-xs text-muted-foreground truncate">
          {member.brand_keywords || <span className="italic">no brand keywords</span>}
        </span>
      ) : editing ? (
        <Input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="brand keywords"
          className="flex-1 h-8 text-xs"
          autoFocus
          onBlur={() => { setEditing(false); if (val !== (member.brand_keywords || "")) onSaveKeywords(val); }}
          onKeyDown={(e) => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setVal(member.brand_keywords || ""); setEditing(false); } }}
          data-testid={`input-member-keywords-${member.id}`}
        />
      ) : (
        <button
          className="flex-1 text-left text-xs text-muted-foreground hover:text-foreground truncate"
          onClick={() => setEditing(true)}
          data-testid={`button-edit-member-keywords-${member.id}`}
          title="Click to edit"
        >
          {member.brand_keywords || <span className="italic">click to add brand keywords…</span>}
        </button>
      )}
      {canEditRules && <Button size="sm" variant="ghost" onClick={onRemove} data-testid={`button-remove-member-${member.id}`}>
        <Trash2 className="size-3.5 text-muted-foreground" />
      </Button>}
    </div>
  );
}
