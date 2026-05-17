import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AlertTriangle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

/**
 * Round 6 — Skip Senders dialog.
 *
 * Two modes:
 *  - mode="invoice"  ->  Invoked from InvoiceDrawer. Posts to /api/invoices/:id/skip-sender
 *                        which adds the sender rule AND rejects the current invoice
 *                        in one transaction. The current invoice is the "first occurrence".
 *  - mode="manual"   ->  Invoked from Settings. Posts to /api/skip-senders to add a rule
 *                        with no associated invoice.
 *
 * Spec (locked with Jake):
 *  - No default radio choice; user must pick "exact email" or "whole domain".
 *  - User must type SKIP exactly to enable Confirm.
 *  - First occurrence routes to Rejected (not Receiving).
 *  - Bulk action not supported in v1.
 */

type Mode = "invoice" | "manual";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: Mode;
  /** Email from the invoice (mode=invoice) or empty/prefill (mode=manual). */
  senderEmail?: string | null;
  /** Optional vendor name to record alongside the rule. */
  vendorName?: string | null;
  /** Required for mode=invoice — invoice we are rejecting alongside adding the rule. */
  invoiceId?: string | null;
  /** Called after a successful add. Caller can also rely on query invalidation. */
  onAdded?: () => void;
};

/**
 * Pull the bare email out of a free-form From string like
 *   "Dove Window Cleaning LLC" <mail@thecustomerfactor.com>
 * Returns lowercase email or empty string.
 */
function extractBareEmail(input?: string | null): string {
  if (!input) return "";
  const s = String(input).trim();
  const angle = s.match(/<\s*([^<>\s"]+@[^<>\s"]+)\s*>/);
  if (angle && angle[1]) return angle[1].trim().toLowerCase();
  const bare = s.match(/[^\s<>"',;()]+@[^\s<>"',;()]+\.[^\s<>"',;()]+/);
  if (bare && bare[0]) return bare[0].trim().toLowerCase();
  return "";
}

function deriveDomain(email?: string | null): string {
  const bare = extractBareEmail(email);
  if (!bare) return "";
  const at = bare.lastIndexOf("@");
  if (at < 0) return "";
  return bare.slice(at + 1).trim().toLowerCase();
}

export function SkipSenderDialog({
  open,
  onOpenChange,
  mode,
  senderEmail,
  vendorName,
  invoiceId,
  onAdded,
}: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();

  // Manual mode: user types the email/domain. Invoice mode: pulled from invoice.
  const [manualEmail, setManualEmail] = useState("");
  const [matchType, setMatchType] = useState<"" | "email" | "domain">("");
  const [confirmText, setConfirmText] = useState("");

  // Reset state whenever the dialog opens (or invoice/sender changes).
  useEffect(() => {
    if (open) {
      setManualEmail("");
      setMatchType("");
      setConfirmText("");
    }
  }, [open, invoiceId, senderEmail]);

  const effectiveEmail = useMemo(() => {
    const raw = mode === "invoice" ? (senderEmail || "") : manualEmail;
    return (raw || "").trim();
  }, [mode, senderEmail, manualEmail]);

  const domain = useMemo(() => deriveDomain(effectiveEmail), [effectiveEmail]);

  // The actual value we'll send to the server.
  // For 'email' mode, strip any "Display Name" <...> wrapper so the server gets a bare email.
  const bareEmail = useMemo(() => extractBareEmail(effectiveEmail), [effectiveEmail]);
  const matchValue = matchType === "email" ? bareEmail : matchType === "domain" ? domain : "";

  const hasValidSender = !!bareEmail;
  const skipTyped = confirmText === "SKIP";
  const canConfirm = hasValidSender && !!matchType && !!matchValue && skipTyped;

  const mut = useMutation({
    mutationFn: async () => {
      if (mode === "invoice") {
        if (!invoiceId) throw new Error("Missing invoice id");
        return apiRequest("POST", `/api/invoices/${invoiceId}/skip-sender`, {
          match_type: matchType,
          confirm: "SKIP",
        });
      } else {
        return apiRequest("POST", `/api/skip-senders`, {
          match_type: matchType,
          match_value: matchValue,
          vendor_name: vendorName || null,
        });
      }
    },
    onSuccess: () => {
      // Invalidate invoice lists (mode=invoice rejects the current one) and skip-senders list.
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
      qc.invalidateQueries({ queryKey: ["/api/skip-senders"] });
      if (invoiceId) {
        qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      }
      toast({
        title: mode === "invoice" ? "Sender skipped — invoice rejected" : "Sender added to skip list",
        description: matchType === "email"
          ? `Future emails from ${matchValue} will be auto-rejected.`
          : `Future emails from @${matchValue} will be auto-rejected.`,
      });
      onAdded?.();
      onOpenChange(false);
    },
    onError: (err: any) => {
      toast({
        title: "Could not add skip rule",
        description: err?.message || "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!mut.isPending) onOpenChange(v); }}>
      <DialogContent className="max-w-md" data-testid="dialog-skip-sender">
        <DialogHeader>
          <DialogTitle>Skip this sender going forward</DialogTitle>
          <DialogDescription>
            {mode === "invoice"
              ? "This invoice will be rejected, and future emails from this sender will be auto-rejected before any processing."
              : "Future emails from this sender will be auto-rejected before any processing. Use this for monthly subscriptions and other senders that don't need AP review."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {mode === "manual" && (
            <div className="space-y-1.5">
              <Label htmlFor="skip-manual-email">Email address</Label>
              <Input
                id="skip-manual-email"
                placeholder="billing@vendor.com"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                data-testid="input-skip-manual-email"
              />
            </div>
          )}

          {mode === "invoice" && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
              <div className="text-muted-foreground text-xs">Sender</div>
              <div className="font-mono text-sm break-all" data-testid="text-skip-sender-email">
                {effectiveEmail || <span className="text-muted-foreground italic">No sender on file</span>}
              </div>
              {vendorName && (
                <div className="text-xs text-muted-foreground mt-1">Vendor: {vendorName}</div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label>Match type</Label>
            <RadioGroup
              value={matchType}
              onValueChange={(v) => setMatchType(v as "email" | "domain")}
              data-testid="radio-skip-match-type"
            >
              <div className="flex items-start gap-2 rounded-md border border-border p-2 hover-elevate">
                <RadioGroupItem value="email" id="skip-match-email" disabled={!hasValidSender} className="mt-0.5" />
                <Label htmlFor="skip-match-email" className="flex-1 cursor-pointer font-normal">
                  <div className="text-sm font-medium">Just this exact email</div>
                  <div className="text-xs text-muted-foreground font-mono break-all">
                    {effectiveEmail || "—"}
                  </div>
                </Label>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-border p-2 hover-elevate">
                <RadioGroupItem value="domain" id="skip-match-domain" disabled={!domain} className="mt-0.5" />
                <Label htmlFor="skip-match-domain" className="flex-1 cursor-pointer font-normal">
                  <div className="text-sm font-medium">Whole domain</div>
                  <div className="text-xs text-muted-foreground font-mono break-all">
                    {domain ? `@${domain}` : "—"}
                  </div>
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs flex gap-2">
            <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <div>
              {mode === "invoice"
                ? "This rejects the current invoice and prevents future emails from this sender from being processed at all."
                : "Future emails from this sender will be skipped before any processing."}
              {" "}You can remove the rule any time from Settings.
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skip-confirm">
              Type <span className="font-mono font-bold">SKIP</span> to confirm
            </Label>
            <Input
              id="skip-confirm"
              placeholder="SKIP"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              data-testid="input-skip-confirm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mut.isPending} data-testid="button-skip-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={!canConfirm || mut.isPending}
            data-testid="button-skip-confirm"
          >
            {mut.isPending ? "Adding…" : mode === "invoice" ? "Skip & reject invoice" : "Add skip rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
