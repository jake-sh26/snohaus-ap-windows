import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CheckSquare, Square, Loader2, X, AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export type BulkAction = "posted" | "quarantined" | "pending_review" | "receiving" | "rejected";

const ACTION_LABELS: Record<BulkAction, string> = {
  posted: "Mark Posted",
  quarantined: "Quarantine",
  pending_review: "Send to Problem",
  receiving: "In Receiving",
  rejected: "Reject",
};

/**
 * Shared bulk-selection hook — gives every list page the same selection model.
 *
 * Returned helpers:
 *   selected:    Set of selected invoice IDs
 *   isSelected:  (id) => boolean
 *   toggle:      (id) => toggle one row
 *   toggleAll:   (visibleIds) => select all visible / clear if all already selected
 *   clear:       () => clear all
 *   stopPropagation: (e) => for the checkbox cell so row-click doesn't fire
 */
export function useBulkSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function isSelected(id: string) {
    return selected.has(id);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(visibleIds: string[]) {
    setSelected((prev) => {
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      if (allSelected) {
        // Clear visible ones (keep selections from other pages? We only ever show one page at a time, so just clear.)
        return new Set();
      }
      return new Set(visibleIds);
    });
  }

  function clear() {
    setSelected(new Set());
  }

  function stopPropagation(e: React.MouseEvent | React.ChangeEvent) {
    e.stopPropagation();
  }

  return { selected, isSelected, toggle, toggleAll, clear, stopPropagation };
}

/**
 * Header checkbox cell — goes in the <thead><tr> as the first <th>.
 */
export function BulkSelectHeader({
  visibleIds,
  selected,
  toggleAll,
}: {
  visibleIds: string[];
  selected: Set<string>;
  toggleAll: (ids: string[]) => void;
}) {
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = !allSelected && visibleIds.some((id) => selected.has(id));
  return (
    <th className="px-3 py-2.5 w-9">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggleAll(visibleIds); }}
        className="inline-flex items-center justify-center size-5 rounded border border-border hover:border-foreground/40 transition-colors"
        aria-label={allSelected ? "Clear selection" : "Select all visible"}
        data-testid="bulk-select-all"
      >
        {allSelected ? (
          <CheckSquare className="size-4 text-primary" />
        ) : someSelected ? (
          <Square className="size-4 text-primary fill-primary/20" />
        ) : (
          <Square className="size-4 text-muted-foreground" />
        )}
      </button>
    </th>
  );
}

/**
 * Per-row checkbox cell — first <td> of each row. Stops click propagation so
 * the row click (which opens the drawer) doesn't fire.
 */
export function BulkSelectCell({
  id,
  isSelected,
  toggle,
}: {
  id: string;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
}) {
  const checked = isSelected(id);
  return (
    <td className="px-3 py-3 w-9" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggle(id); }}
        className="inline-flex items-center justify-center size-5 rounded border border-border hover:border-foreground/40 transition-colors"
        aria-label={checked ? "Unselect" : "Select"}
        data-testid={`bulk-select-${id}`}
      >
        {checked ? (
          <CheckSquare className="size-4 text-primary" />
        ) : (
          <Square className="size-4 text-muted-foreground" />
        )}
      </button>
    </td>
  );
}

/**
 * Floating bulk-action bar. Appears at the bottom when 1+ rows are selected.
 * Posts to /api/invoices/bulk-action and invalidates list queries.
 */
export function BulkActionBar({
  selected,
  clear,
  actions,
}: {
  selected: Set<string>;
  clear: () => void;
  /** Which actions to show. Default: all 5. */
  actions?: BulkAction[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  const [confirming, setConfirming] = useState<BulkAction | null>(null);
  const visibleActions: BulkAction[] = actions || ["posted", "quarantined", "pending_review", "receiving", "rejected"];

  const mut = useMutation({
    mutationFn: async (action: BulkAction) => {
      const ids = Array.from(selected);
      const res = await apiRequest("POST", "/api/invoices/bulk-action", { ids, action });
      return res.json();
    },
    onSuccess: (data: any, action) => {
      const failed = data?.failed?.length || 0;
      toast({
        title: `Bulk ${ACTION_LABELS[action]}`,
        description: `${data?.updated || 0} updated${failed ? ` · ${failed} failed` : ""}`,
        variant: failed > 0 ? "destructive" : "default",
      });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
      clear();
      setPendingAction(null);
      setConfirming(null);
    },
    onError: (e: any) => {
      toast({ title: "Bulk action failed", description: e.message, variant: "destructive" });
      setPendingAction(null);
      setConfirming(null);
    },
  });

  if (selected.size === 0 && !confirming) return null;

  function runAction(action: BulkAction) {
    // Confirm destructive actions
    if (action === "rejected" || action === "posted") {
      setConfirming(action);
      return;
    }
    setPendingAction(action);
    mut.mutate(action);
  }

  return (
    <>
      {/* Confirmation overlay for destructive actions */}
      {confirming && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setConfirming(null)}>
          <div className="bg-background border border-border rounded-lg shadow-2xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{ACTION_LABELS[confirming]} {selected.size} invoice{selected.size === 1 ? "" : "s"}?</div>
                <div className="text-sm text-muted-foreground mt-1">
                  {confirming === "rejected" && "Rejected invoices are removed from active queues. This can be undone manually."}
                  {confirming === "posted" && "This marks the invoices as posted to QuickBooks locally — it does NOT push them to QBO. Use the single-invoice flow to post via API."}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)} disabled={mut.isPending}>Cancel</Button>
              <Button size="sm" onClick={() => { setPendingAction(confirming); mut.mutate(confirming); }} disabled={mut.isPending} data-testid="button-bulk-confirm">
                {mut.isPending ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" />Working…</> : `Yes, ${ACTION_LABELS[confirming].toLowerCase()}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Floating bar */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-foreground text-background rounded-lg shadow-2xl border border-border/20 px-3 py-2.5 flex items-center gap-2 min-w-[400px]" data-testid="bulk-action-bar">
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center justify-center size-7 rounded hover:bg-background/10"
          aria-label="Clear selection"
          data-testid="button-bulk-clear"
        >
          <X className="size-4" />
        </button>
        <span className="text-sm font-medium px-1">{selected.size} selected</span>
        <div className="h-5 w-px bg-background/20 mx-1" />
        {visibleActions.map((a) => (
          <Button
            key={a}
            size="sm"
            variant="secondary"
            disabled={mut.isPending}
            onClick={() => runAction(a)}
            className="h-7 px-2.5 text-xs"
            data-testid={`button-bulk-${a}`}
          >
            {pendingAction === a && mut.isPending ? <Loader2 className="size-3 mr-1 animate-spin" /> : null}
            {ACTION_LABELS[a]}
          </Button>
        ))}
      </div>
    </>
  );
}
