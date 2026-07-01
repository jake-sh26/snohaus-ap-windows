import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  X, FileText, ExternalLink, RefreshCw, ChevronDown, Copy, Check, AlertTriangle,
  CheckCircle2, ChevronRight, Clock, History, Send, ChevronUp, MoreHorizontal,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, fmtDate, STORE_LABELS, STORE_SHORT } from "@/lib/format";
import { StatusBadge, ConfidenceBadge, VendorMatchBadge, DuplicateBadge } from "./Badges";
import { PdfPreview } from "./PdfPreview";
import { PdfDebugHud } from "./PdfDebugHud";
import { SkipSenderDialog } from "./SkipSenderDialog";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-media-query";
import { useAuth } from "@/lib/auth";

const STORES = ["greenvale", "hempstead", "huntington"] as const;
type StoreKey = typeof STORES[number];

type Invoice = any;

// Round 4 helper: invalidate every list-style query so Inbox / Problem / History
// / Posted / All Invoices update in real time after any drawer mutation.
// All list pages start their queryKey with one of these prefixes.
function invalidateAllInvoiceLists(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["/api/invoices"] });
  qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
  qc.invalidateQueries({ queryKey: ["/api/digest"] });
}

export function InvoiceDrawer({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const open = !!invoiceId;
  const qc = useQueryClient();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const { hasPermission } = useAuth();
  const canApproveAp = hasPermission("ap.approve");
  const canManageSkipSenders = hasPermission("ap.skip_senders");
  const [pdfExpanded, setPdfExpanded] = useState(false);
  // DEBUG MODE — toggleable on-screen HUD that captures viewport, container,
  // and touch event diagnostics. Can also be enabled via ?debug=pdf in URL or
  // by setting localStorage.SNOHAUS_PDF_DEBUG = '1'.
  const [debugOn, setDebugOn] = useState(() => {
    try {
      if (typeof window === 'undefined') return false;
      if (new URLSearchParams(window.location.search).get('debug') === 'pdf') return true;
      if (window.localStorage?.getItem('SNOHAUS_PDF_DEBUG') === '1') return true;
    } catch {}
    return false;
  });
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const debugLogRef = (window as any).__snohausDebugLog || ((window as any).__snohausDebugLog = []);
  const dlog = (msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${msg}`;
    debugLogRef.push(line);
    if (debugLogRef.length > 200) debugLogRef.shift();
    // eslint-disable-next-line no-console
    console.log('[PDF-DEBUG]', line);
    setDebugLog([...debugLogRef]);
  };
  // Expose state to window for inspection from devtools.
  useEffect(() => {
    (window as any).__snohausPdfState = { pdfExpanded, isMobile, invoiceId };
  }, [pdfExpanded, isMobile, invoiceId]);

  // Reset fullscreen PDF state when invoice changes — prevents stuck-expanded
  // bug when opening a different drawer after expanding a previous one.
  useEffect(() => {
    setPdfExpanded(false);
  }, [invoiceId]);

  // While fullscreen PDF is open, intercept the Sheet's outside-click / escape
  // handlers so closing the PDF doesn't also close the drawer behind it.
  useEffect(() => {
    if (!pdfExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        setPdfExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pdfExpanded]);

  // DEBUG: log every pdfExpanded transition + sample viewport metrics.
  useEffect(() => {
    if (!debugOn) return;
    dlog(`pdfExpanded=${pdfExpanded} | innerH=${window.innerHeight} | visualH=${(window as any).visualViewport?.height || 'n/a'} | dpr=${window.devicePixelRatio}`);
  }, [pdfExpanded, debugOn]);

  // DEBUG: capture document-level pointer/touch events while expanded so we can
  // see which element actually receives the tap that closes the drawer.
  useEffect(() => {
    if (!debugOn || !pdfExpanded) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      const path = t?.getAttribute?.('data-testid') || t?.tagName || '?';
      dlog(`pointerdown on ${path} (${e.clientX},${e.clientY}) bubbles=${e.bubbles}`);
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const path = t?.getAttribute?.('data-testid') || t?.tagName || '?';
      dlog(`click on ${path} target.closest(overlay)=${!!t?.closest?.('[data-testid="pdf-fullscreen-overlay"]')}`);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [debugOn, pdfExpanded]);

  // Signed PDF URL: short-lived, refreshes when drawer opens / invoice changes.
  const pdfUrlQ = useQuery<{ url: string }>({
    queryKey: [`/api/invoices/${invoiceId}/pdf-token`],
    enabled: !!invoiceId,
    staleTime: 4 * 60 * 1000, // 4min, token expires at 5min
  });

  const invQ = useQuery<Invoice>({
    queryKey: [`/api/invoices/${invoiceId}`],
    enabled: open,
  });
  const inv = invQ.data;

  // PR #R4h — Single source of truth for the displayed due date. When the
  // user has the early-pay discount selected the Due Date input must show
  // the discount-window date (e.g. 10 days out for "2% 10 Net 30"), not the
  // full Net date. For "net_with_discount" terms the discount is automatic
  // and discount_due_date IS the due date. The QBO payload builder in
  // buildQboBillPayload computes the same value; we hoist it here so the
  // input field, the discount card summary, and the payload all agree.
  const discountActiveTop = !!(inv?.discount_applied && inv?.discount_terms_pct && inv?.discount_kind);
  const effectiveDueDate: string | null =
    discountActiveTop && inv?.discount_due_date
      ? inv.discount_due_date
      : (inv?.due_date ?? null);

  const [routingMode, setRoutingMode] = useState<"single_store" | "percent_split" | "line_item_split">("single_store");
  const [singleStore, setSingleStore] = useState<StoreKey>("greenvale");
  const [percentSplit, setPercentSplit] = useState<Record<StoreKey, number>>({ greenvale: 100, hempstead: 0, huntington: 0 });
  const [lineAssignments, setLineAssignments] = useState<Record<number, StoreKey>>({});
  const [showPayload, setShowPayload] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [editTotal, setEditTotal] = useState<string>("");
  const [editFreight, setEditFreight] = useState<string>("");
  // v8: editable invoice number / invoice date — OCR sometimes mis-reads these,
  // and the duplicate-detector keys off invoice_number, so a typo means we miss
  // a real duplicate. We save on blur (or Enter) and re-run the dup check.
  const [editInvoiceNumber, setEditInvoiceNumber] = useState<string>("");
  const [editInvoiceDate, setEditInvoiceDate] = useState<string>("");
  // v8.1: due_date is what QBO posts as Bill.DueDate — separate from invoice_date.
  const [editDueDate, setEditDueDate] = useState<string>("");
  // v8: latest fuzzy duplicate match (returned from POST /recheck-duplicates).
  // Falls back to inv.fuzzy_dup_hint (server-persisted) when not yet checked.
  const [fuzzyMatch, setFuzzyMatch] = useState<{
    id: string;
    invoice_number: string | null;
    confidence: number;
    reason: string;
  } | null>(null);
  const [skipDialogOpen, setSkipDialogOpen] = useState(false);
  // Round 7 follow-up: when reparse / rematch / recheck discovers the invoice
  // is already in QBO, we pop a confirmation modal so the user can sign off on
  // auto-completing it. State stores the dup info from the server response.
  const [dupModal, setDupModal] = useState<{
    bill_id: string | null;
    payment_id: string | null;
    note: string | null;
    paid_label: string;
    total: number;
    balance: number;
  } | null>(null);

  // Sync state when invoice loads
  useEffect(() => {
    if (!inv) return;
    setRoutingMode(inv.routing_mode || "single_store");
    let rd: any = {};
    try { rd = inv.routing_data ? JSON.parse(inv.routing_data) : {}; } catch {}
    if (inv.routing_mode === "single_store") setSingleStore((rd.store || inv.ship_to_store || "greenvale") as StoreKey);
    else if (inv.routing_mode === "percent_split") setPercentSplit({ greenvale: 0, hempstead: 0, huntington: 0, ...(rd.percentages || {}) });
    else if (inv.routing_mode === "line_item_split") {
      const lm: Record<number, StoreKey> = {};
      (inv.line_items || []).forEach((li: any) => { if (li.store_assignment) lm[li.id] = li.store_assignment; });
      setLineAssignments(lm);
    }
    if (inv.ship_to_store && (!rd.store && inv.routing_mode === "single_store")) {
      setSingleStore(inv.ship_to_store);
    }
    setEditTotal(inv.total != null ? String(inv.total) : "");
    setEditFreight(inv.freight != null ? String(inv.freight) : "");
    setEditInvoiceNumber(inv.invoice_number || "");
    setEditInvoiceDate(inv.invoice_date || "");
    // PR #R4h — seed from effectiveDueDate so toggling the discount visibly
    // updates the input. Falls back to inv.due_date when no discount applies.
    setEditDueDate(effectiveDueDate || "");
    // Hydrate fuzzyMatch from the persisted hint on the invoice row, if any.
    try {
      if (inv.fuzzy_dup_hint) {
        const parsed = typeof inv.fuzzy_dup_hint === "string" ? JSON.parse(inv.fuzzy_dup_hint) : inv.fuzzy_dup_hint;
        if (parsed?.matched_invoice_id) {
          setFuzzyMatch({
            id: parsed.matched_invoice_id,
            invoice_number: parsed.matched_invoice_number || null,
            confidence: parsed.confidence || 0,
            reason: parsed.reason || "",
          });
        } else {
          setFuzzyMatch(null);
        }
      } else {
        setFuzzyMatch(null);
      }
    } catch {
      setFuzzyMatch(null);
    }

    // Auto-recheck duplicate if unchecked. If the recheck discovers a dup,
    // pop the auto-complete modal so the user can sign off.
    if (inv.duplicate_check_status === "unchecked") {
      apiRequest("POST", `/api/invoices/${inv.id}/recheck-duplicate`)
        .then((r) => r.json())
        .then((data: any) => {
          qc.invalidateQueries({ queryKey: [`/api/invoices/${inv.id}`] });
          if (data?.dup_check?.found && inv.status === "pending_review") {
            setDupModal({
              bill_id: data.dup_check.bill?.id || null,
              payment_id: data.dup_check.payment_id || null,
              note: data.dup_check.note,
              paid_label: data.dup_check.bill?.paid_label || "",
              total: data.dup_check.bill?.total || 0,
              balance: data.dup_check.bill?.balance || 0,
            });
          }
        })
        .catch(() => {});
    }
  }, [inv?.id]);

  // PR #R4h — keep the Due Date input in sync with the discount toggle.
  // The bigger useEffect above only re-fires on inv.id change; toggling the
  // discount (which mutates inv.discount_applied) needs its own pass so the
  // field flips between the discount-window date and the full-Net date as
  // the user clicks "Take 2% discount" / "Pay full amount."
  useEffect(() => {
    if (!inv) return;
    setEditDueDate(effectiveDueDate || "");
  }, [effectiveDueDate, inv?.id]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const routing_data =
        routingMode === "single_store" ? { store: singleStore }
        : routingMode === "percent_split" ? { percentages: percentSplit }
        : { default_store: singleStore };
      const body: any = {
        routing_mode: routingMode,
        routing_data,
        total: editTotal === "" ? null : parseFloat(editTotal),
        freight: editFreight === "" ? 0 : parseFloat(editFreight),
      };
      if (routingMode === "line_item_split") {
        body.line_items = (inv?.line_items || []).map((li: any) => ({ id: li.id, store_assignment: lineAssignments[li.id] || null }));
      }
      const res = await apiRequest("PATCH", `/api/invoices/${invoiceId}`, body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "Invoice updated." });
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  // Approve & post to QBO in one step. If post fails, server auto-reverts to pending_review.
  const approveMutation = useMutation({
    mutationFn: async () => {
      // Save first
      await saveMutation.mutateAsync();
      // Step 1: approve locally (sets status to approved_local)
      const approveRes = await apiRequest("POST", `/api/invoices/${invoiceId}/approve`);
      const approveData = await approveRes.json();
      // Step 2: immediately try to post to QBO via direct OAuth
      try {
        const postRes = await apiRequest("POST", `/api/invoices/${invoiceId}/post-to-qbo`);
        const postData = await postRes.json();
        return { ...approveData, posted: true, qbo_bill_id: postData.qbo_bill_id };
      } catch (postErr: any) {
        // Server auto-reverts to pending_review on failure. Surface the real error.
        const msg = (postErr.message || "Unknown error").replace(/^\d+:\s*/, "");
        throw new Error(msg);
      }
    },
    onSuccess: (data) => {
      const docLabel = data.is_credit ? "Vendor credit" : "Bill";
      toast({
        title: data.is_credit ? "Vendor credit posted to QBO" : "Posted to QBO",
        description: data.qbo_bill_id ? `QBO ${docLabel.toLowerCase()} #${data.qbo_bill_id}` : `${docLabel} created in QuickBooks`,
      });
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
    },
    onError: (e: any) => {
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      toast({
        title: "QBO post failed",
        description: `${e.message} — Reverted to pending so you can fix and retry.`,
        variant: "destructive",
      });
    },
  });

  // Direct retry post-to-QBO (used by the approved_local state's Retry button)
  const postToQboMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/post-to-qbo`);
      return res.json();
    },
    onSuccess: (data) => {
      const docLabel = data.is_credit ? "Vendor credit" : "Bill";
      toast({
        title: data.is_credit ? "Vendor credit posted to QBO" : "Posted to QBO",
        description: data.qbo_bill_id ? `QBO ${docLabel.toLowerCase()} #${data.qbo_bill_id}` : `${docLabel} created`,
      });
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
    },
    onError: (e: any) => {
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      toast({
        title: "QBO post failed",
        description: `${(e.message || "").replace(/^\d+:\s*/, "")} — Reverted to pending so you can fix and retry.`,
        variant: "destructive",
      });
    },
  });

  // Manual revert from approved_local back to pending_review (for editing)
  const revertToPendingMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/revert-to-pending`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Reverted to pending" });
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
    },
    onError: (e: any) => toast({ title: "Revert failed", description: (e.message || "").replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: async () => {
      const reason = window.prompt("Reason for rejection?");
      if (reason === null) throw new Error("cancelled");
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/reject`, { reason });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rejected" });
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
      onClose();
    },
    onError: (e: any) => { if (e.message !== "cancelled") toast({ title: "Reject failed", description: e.message, variant: "destructive" }); },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/restore`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Restored", description: "Invoice is back in pending review." });
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
    },
    onError: (e: any) => toast({ title: "Restore failed", description: e.message.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const recheckMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/invoices/${invoiceId}/recheck-duplicate`).then((r) => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      // Round 7 follow-up: pop the auto-complete sign-off if a dup was found.
      if (data?.dup_check?.found && data.status === "pending_review") {
        setDupModal({
          bill_id: data.dup_check.bill?.id || null,
          payment_id: data.dup_check.payment_id || null,
          note: data.dup_check.note,
          paid_label: data.dup_check.bill?.paid_label || "",
          total: data.dup_check.bill?.total || 0,
          balance: data.dup_check.bill?.balance || 0,
        });
      } else if (data?.duplicate_check_status === "clean") {
        toast({ title: "No duplicate found", description: "This invoice is not in QBO yet." });
      }
    },
  });

  // v8: combined fuzzy + QBO recheck. Triggered when the user edits the
  // invoice number (or clicks "Re-check duplicates" on the fuzzy banner).
  // Returns both the QBO dup_check and the internal_fuzzy_match.
  const fuzzyRecheckMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/invoices/${invoiceId}/recheck-duplicates`).then((r) => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      // QBO dup found → reuse the existing auto-complete modal flow.
      if (data?.dup_check?.found && data.status === "pending_review") {
        setDupModal({
          bill_id: data.dup_check.bill?.id || null,
          payment_id: data.dup_check.payment_id || null,
          note: data.dup_check.note,
          paid_label: data.dup_check.bill?.paid_label || "",
          total: data.dup_check.bill?.total || 0,
          balance: data.dup_check.bill?.balance || 0,
        });
      }
      // Internal fuzzy match (60–99%): surface a banner in the right panel.
      if (data?.internal_fuzzy_match) {
        setFuzzyMatch({
          id: data.internal_fuzzy_match.id,
          invoice_number: data.internal_fuzzy_match.invoice_number,
          confidence: data.internal_fuzzy_match.confidence,
          reason: data.internal_fuzzy_match.reason,
        });
      } else {
        setFuzzyMatch(null);
      }
    },
  });

  // v8: save invoice_number / invoice_date edits, then re-run dup checks.
  // Called from the editable card on blur (or when the user hits Enter).
  const saveInvoiceFieldsMutation = useMutation({
    mutationFn: async (patch: { invoice_number?: string | null; invoice_date?: string | null }) => {
      const res = await apiRequest("PATCH", `/api/invoices/${invoiceId}`, patch);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      invalidateAllInvoiceLists(qc);
      // Edit may have surfaced a duplicate that the OCR-typo'd number masked.
      fuzzyRecheckMutation.mutate();
    },
    onError: (e: any) => toast({ title: "Save failed", description: (e.message || "").replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  // v8.4.5: toggle the early-pay discount on this invoice.
  const discountToggleMutation = useMutation({
    mutationFn: async (applied: boolean) => {
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/discount-applied`, { applied });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      invalidateAllInvoiceLists(qc);
    },
    onError: (e: any) => toast({ title: "Discount toggle failed", description: (e.message || "").replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  // Re-run the LLM parser on this invoice's PDF. Used to recover from
  // truncation / transient API errors without needing to re-upload.
  const reparseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/reparse`);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Reparsed", description: "Vendor and totals refreshed from the PDF." });
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      invalidateAllInvoiceLists(qc);
      // Round 7 follow-up: reparse may have changed the invoice number / vendor,
      // so the server also re-runs the dup check. If a dup was found, pop the modal.
      if (data?.dup_check?.found && data.invoice?.status === "pending_review") {
        setDupModal({
          bill_id: data.dup_check.bill?.id || null,
          payment_id: data.dup_check.payment_id || null,
          note: data.dup_check.note,
          paid_label: data.dup_check.bill?.paid_label || "",
          total: data.dup_check.bill?.total || 0,
          balance: data.dup_check.bill?.balance || 0,
        });
      }
    },
    onError: (e: any) => toast({ title: "Reparse failed", description: (e.message || "").replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  // Bucket actions: move invoice to Receiving (hold) or Quarantined (discrepancy).
  const bucketMutation = useMutation({
    mutationFn: async ({ status, reason }: { status: string; reason?: string }) => {
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/bucket`, { status, reason });
      return res.json();
    },
    onSuccess: (_d, vars) => {
      toast({ title: vars.status === "receiving" ? "Moved to In Receiving" : vars.status === "quarantined" ? "Quarantined" : "Returned to Inbox" });
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}/notes`] });
      invalidateAllInvoiceLists(qc);
      // Round 4: close drawer so the moved invoice disappears from the current
      // page in real time without needing a refresh.
      onClose();
    },
    onError: (e: any) => toast({ title: "Move failed", description: e.message, variant: "destructive" }),
  });

  // Round 7 follow-up: when the user switches to a different invoice while a
  // mutation (Reparse, Approve, Post-to-QBO, etc.) is still in flight on the
  // previous invoice, the mutation hooks keep `isPending=true` against the new
  // invoice's render — so spinners and "Reparsing…" labels visually leak across
  // invoices. The in-flight request itself targets the right invoice on the
  // server (URL captured at .mutate() call time), but we reset the hook state
  // here so the UI for the newly-opened invoice always starts clean.
  useEffect(() => {
    reparseMutation.reset();
    approveMutation.reset();
    postToQboMutation.reset();
    revertToPendingMutation.reset();
    rejectMutation.reset();
    restoreMutation.reset();
    recheckMutation.reset();
    bucketMutation.reset();
    saveMutation.reset();
    // Also clear any pending duplicate confirmation — it belongs to the previous invoice.
    setDupModal(null);
    // Only react to invoiceId changes — the mutation objects are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  // Live computed payload preview
  const livePayload = useMemo(() => {
    if (!inv) return null;
    return computeLivePayload({
      invoice: inv,
      total: editTotal === "" ? inv.total : parseFloat(editTotal),
      freight: editFreight === "" ? 0 : parseFloat(editFreight),
      routingMode,
      singleStore,
      percentSplit,
      lineAssignments,
    });
  }, [inv, routingMode, singleStore, percentSplit, lineAssignments, editTotal, editFreight]);

  const totalForCheck = editTotal === "" ? inv?.total : parseFloat(editTotal);
  // Approve is allowed from pending_review, receiving, or quarantined buckets.
  // The desktop action footer already shows an Approve button in receiving/quarantined,
  // so canApprove must include those statuses or the button is disabled with a misleading
  // "total is missing" message even when the total is present.
  const canApprove = inv && inv.vendor_match_status !== "unmatched"
    && inv.duplicate_check_status !== "duplicate_found"
    && (inv.is_credit || (totalForCheck && totalForCheck !== 0))
    && (inv.status === "pending_review" || inv.status === "receiving" || inv.status === "quarantined");

  // Compute the precise reason approve is blocked, so the hint message is accurate
  // (was always falling through to "total is missing" even when the real cause was different).
  const approveBlockReason: string | null = (() => {
    if (!inv) return null;
    if (inv.vendor_match_status === "unmatched") return "vendor unmatched";
    if (inv.duplicate_check_status === "duplicate_found") return "duplicate found";
    if (!inv.is_credit && (!totalForCheck || totalForCheck === 0)) return "total is missing";
    return null;
  })();

  const percentSum = percentSplit.greenvale + percentSplit.hempstead + percentSplit.huntington;
  const percentValid = Math.abs(percentSum - 100) < 0.01;

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) { invalidateAllInvoiceLists(qc); onClose(); } }}>
      <SheetContent
        side="right"
        className="!max-w-none w-full sm:w-[95vw] lg:w-[92vw] xl:w-[1200px] p-0 flex flex-col gap-0"
        data-testid="drawer-invoice"
        // While the fullscreen PDF overlay is open:
        //  - Block Radix's outside-click / Escape handlers from dismissing the Sheet.
        //  - Disable pointer events on the entire drawer body so any tap that
        //    leaks past our overlay (or hits the Sheet's built-in ✕ button at
        //    top-right) does NOT close the drawer. The fullscreen overlay sits
        //    in its own portal sibling and has pointer-events:auto so it still
        //    receives input.
        style={pdfExpanded ? { pointerEvents: 'none' } : undefined}
        onPointerDownOutside={(e) => { if (pdfExpanded) e.preventDefault(); }}
        onInteractOutside={(e) => { if (pdfExpanded) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (pdfExpanded) e.preventDefault(); }}
      >
        <SheetTitle className="sr-only">{inv?.vendor_qbo_name || inv?.vendor_raw_name || "Invoice details"}</SheetTitle>
        <SheetDescription className="sr-only">Invoice review drawer</SheetDescription>
        {!inv ? (
          <DrawerSkeleton />
        ) : (
          <>
            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-border bg-card/50">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-semibold tracking-tight truncate" data-testid="text-drawer-vendor">
                    {inv.vendor_qbo_name || inv.vendor_raw_name || "Unknown vendor"}
                  </h2>
                  <VendorMatchBadge status={inv.vendor_match_status} aliasFrom={inv.vendor_match_status === "aliased" ? inv.vendor_raw_name : null} />
                  <StatusBadge status={inv.status} />
                  <ConfidenceBadge confidence={inv.parse_confidence} />
                </div>
                <div className="text-sm text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                  <span>Invoice <span className="font-mono text-foreground">{inv.invoice_number || "—"}</span></span>
                  <span className="text-border">·</span>
                  <span>{fmtDate(inv.invoice_date)}</span>
                  <span className="text-border">·</span>
                  <span className="font-mono text-foreground tabular-nums" data-testid="text-drawer-total">{fmtMoney(inv.total)}</span>
                  {inv.freight ? <><span className="text-border">·</span><span>+ {fmtMoney(inv.freight)} freight</span></> : null}
                </div>
                {inv.notes && (
                  <div className="text-xs text-amber-700 dark:text-amber-400 mt-2 flex items-start gap-1.5">
                    <AlertTriangle className="size-3.5 shrink-0 mt-0.5" /> {inv.notes}
                  </div>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => { invalidateAllInvoiceLists(qc); onClose(); }} data-testid="button-close-drawer"><X className="size-4" /></Button>
            </div>

            {/* Body — split */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 overflow-hidden">
              {/* PDF preview — mobile: 30vh default, tap to expand fullscreen */}
              <div className={cn(
                "border-r border-border bg-muted/30 p-3 lg:overflow-hidden flex flex-col",
                isMobile ? "min-h-0" : "min-h-[400px]"
              )} style={isMobile ? { height: '30vh', minHeight: 160 } : undefined}>
                {pdfUrlQ.data?.url ? (() => {
                  const fullPdfUrl = pdfUrlQ.data.url;
                  return (
                    <>
                      <div className="flex items-center justify-between text-xs text-muted-foreground pb-2 px-1">
                        <span className="flex items-center gap-1.5"><FileText className="size-3.5" /> Source PDF</span>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => reparseMutation.mutate()}
                            disabled={reparseMutation.isPending}
                            className="hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
                            data-testid="link-reparse-pdf"
                            title="Re-run the LLM parser against this PDF (only fills missing fields, never overwrites your edits)"
                          >
                            <RefreshCw className={cn("size-3", reparseMutation.isPending && "animate-spin")} />
                            {reparseMutation.isPending ? "Reparsing\u2026" : "Reparse"}
                          </button>
                          {/* Open in new tab — available on desktop AND mobile (user requested) */}
                          <a href={fullPdfUrl} target="_blank" rel="noreferrer" className="hover:text-foreground inline-flex items-center gap-1" data-testid="link-open-pdf">
                            Open in tab <ExternalLink className="size-3" />
                          </a>
                          {/* Mobile only: expand toggle */}
                          {isMobile && (
                            <button
                              onClick={() => setPdfExpanded(true)}
                              className="hover:text-foreground inline-flex items-center gap-1"
                              aria-label="Expand PDF to full screen"
                              data-testid="button-expand-pdf"
                            >
                              <ChevronUp className="size-3.5" /> Expand
                            </button>
                          )}
                          {/* DEBUG toggle — always visible so user can flip on/off in production */}
                          {isMobile && (
                            <button
                              onClick={() => {
                                const next = !debugOn;
                                setDebugOn(next);
                                try { window.localStorage?.setItem('SNOHAUS_PDF_DEBUG', next ? '1' : '0'); } catch {}
                              }}
                              className={cn("text-[10px] px-1.5 py-0.5 rounded border", debugOn ? "bg-yellow-300 text-black border-yellow-500" : "border-border text-muted-foreground")}
                              aria-label="Toggle PDF debug HUD"
                              data-testid="button-toggle-pdf-debug"
                            >
                              {debugOn ? 'DBG•ON' : 'DBG'}
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Inline PDF — must be flex column with min-h-0 so the inner
                          PdfPreview's overflow-y-auto has a constrained height to scroll within.
                          Without min-h-0 the flex child grows to content height, defeating overflow. */}
                      <div className="flex-1 min-h-0 flex flex-col" style={{ touchAction: 'pan-y pan-x pinch-zoom' }}>
                        <PdfPreview url={fullPdfUrl} />
                      </div>

                      {/* Mobile fullscreen PDF overlay.
                          - Rendered via portal to document.body and stops pointer/click events
                            so taps don't bubble up to the underlying Sheet (which would close the drawer).
                          - Full-height scrollable container with pinch-zoom enabled.
                          - Close button (✕) only collapses the PDF, leaves drawer open. */}
                      {isMobile && pdfExpanded && createPortal(
                        <div
                          data-testid="pdf-fullscreen-overlay"
                          // Fullscreen PDF overlay using the iOS native PDF viewer
                          // via <iframe>. We stopped using PdfPreview (PDF.js canvas)
                          // here because pinch-zoom is disabled on canvases inside
                          // PWA standalone mode. The native viewer in an iframe
                          // gives free pinch-zoom + scroll + page navigation.
                          //
                          // We also REMOVED the onTouchStart/onTouchEnd stopPropagation
                          // handlers — those were swallowing gesture events before iOS
                          // could process them as pinches. The drawer behind has
                          // pointer-events:none while expanded, so leaking events
                          // can't dismiss it anyway.
                          style={{
                            position: 'fixed',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            width: '100vw',
                            height: '100dvh',
                            minHeight: '100vh',
                            zIndex: 2147483600,
                            background: '#000',
                            display: 'flex',
                            flexDirection: 'column',
                            pointerEvents: 'auto',
                          }}
                        >
                          <div className="flex items-center justify-between px-4 py-3 bg-background border-b border-border shrink-0" style={{ height: 56 }}>
                            <span className="text-sm font-medium flex items-center gap-1.5"><FileText className="size-4" /> PDF</span>
                            <div className="flex items-center gap-1">
                              <a
                                href={fullPdfUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-muted"
                                data-testid="link-open-pdf-fullscreen"
                              >
                                Open in tab <ExternalLink className="size-3" />
                              </a>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  // Defer the unmount by a tick so the in-flight click event
                                  // finishes its bubbling/cleanup BEFORE the overlay disappears.
                                  // Without this, the underlying Radix Sheet briefly sees the
                                  // pointerdown as an "outside click" and closes the drawer.
                                  setTimeout(() => setPdfExpanded(false), 0);
                                }}
                                onPointerDown={(e) => e.stopPropagation()}
                                onPointerUp={(e) => e.stopPropagation()}
                                className="h-8 w-8 p-0"
                                aria-label="Close fullscreen PDF"
                                data-testid="button-close-pdf-fullscreen"
                              >
                                <X className="size-5" />
                              </Button>
                            </div>
                          </div>
                          {/* Native iOS PDF viewer in an iframe.
                              IMPORTANT: iOS Safari's native PDF viewer inside an
                              iframe will only scroll horizontally when the iframe
                              is sized exactly to the available space — the inner
                              PDF document is taller than the iframe but iOS
                              treats the iframe as a fixed window. The fix is to
                              wrap in a scrolling DIV and give the iframe its
                              FULL document height (we can't easily measure it,
                              so we set a generous fixed height of 200dvh and
                              let the wrapper scroll). */}
                          <div
                            style={{
                              flex: '1 1 auto',
                              width: '100%',
                              height: 'calc(100dvh - 56px)',
                              overflow: 'auto',
                              WebkitOverflowScrolling: 'touch' as any,
                              background: '#222',
                            }}
                            data-testid="pdf-fullscreen-scrollwrap"
                          >
                            <iframe
                              src={fullPdfUrl}
                              title="PDF"
                              data-testid="iframe-pdf-fullscreen"
                              // Tall iframe so the OUTER div can scroll. iOS
                              // Safari renders the entire PDF inside the iframe
                              // at native size; the wrapper div provides the
                              // vertical scroll. 200dvh = 2x viewport height,
                              // enough for a typical 1-3 page invoice. For
                              // longer PDFs the user can pinch-zoom out and the
                              // PDF viewer will paginate internally.
                              style={{
                                width: '100%',
                                height: '200dvh',
                                minHeight: '1400px',
                                border: '0',
                                background: '#222',
                                display: 'block',
                              }}
                              scrolling="yes"
                              allowFullScreen
                            />
                          </div>
                          {debugOn && <PdfDebugHud log={debugLog} />}
                        </div>,
                        document.body
                      )}
                    </>
                  );
                })()
 : pdfUrlQ.isLoading ? (
                  <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Loading PDF\u2026</div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">No PDF available</div>
                )}
              </div>

              {/* Right panel scroll */}
              <div className="overflow-y-auto p-5 space-y-4">
                {/* v8: OCR-source warning — image_ocr means this came from a phone
                    snapshot (JPG/PNG/HEIC) so OCR may have garbled the invoice
                    number. Tells Jake to verify the field below before posting. */}
                {inv.source_type === "image_ocr" && (
                  <Card className="border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-950/30 p-3" data-testid="banner-ocr-warning">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="size-4 text-yellow-700 dark:text-yellow-400 shrink-0 mt-0.5" />
                      <div className="text-xs text-yellow-900 dark:text-yellow-100">
                        <span className="font-medium">Image upload — verify the invoice number.</span>
                        {" "}This invoice was converted from a photo (JPG/PNG/HEIC). OCR can mis-read characters (O↔0, I↔1, S↔5). Double-check the invoice number below before approving.
                      </div>
                    </div>
                  </Card>
                )}

                {/* v8: Editable invoice number / date — saves on blur and re-runs
                    the dup check, since the dedup key is the invoice number. */}
                <Card className="border-card-border p-4" data-testid="card-invoice-number">
                  <div className="text-sm font-medium mb-2">Invoice number, date &amp; due date</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <Label className="text-xs">Invoice #</Label>
                      <Input
                        value={editInvoiceNumber}
                        onChange={(e) => setEditInvoiceNumber(e.target.value)}
                        onBlur={() => {
                          const next = editInvoiceNumber.trim();
                          const prev = (inv.invoice_number || "").trim();
                          if (next !== prev) {
                            saveInvoiceFieldsMutation.mutate({ invoice_number: next || null });
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                        className="font-mono h-9"
                        placeholder="e.g. INV-1024"
                        data-testid="input-invoice-number"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Invoice date</Label>
                      <Input
                        type="date"
                        value={editInvoiceDate ? editInvoiceDate.slice(0, 10) : ""}
                        onChange={(e) => setEditInvoiceDate(e.target.value)}
                        onBlur={() => {
                          const next = editInvoiceDate ? editInvoiceDate.slice(0, 10) : "";
                          const prev = inv.invoice_date ? inv.invoice_date.slice(0, 10) : "";
                          if (next !== prev) {
                            saveInvoiceFieldsMutation.mutate({ invoice_date: next || null });
                          }
                        }}
                        className="h-9"
                        data-testid="input-invoice-date"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">
                        Due date
                        {!inv.due_date && <span className="ml-1 text-amber-600 dark:text-amber-400">• missing</span>}
                      </Label>
                      <Input
                        type="date"
                        value={editDueDate ? editDueDate.slice(0, 10) : ""}
                        onChange={(e) => setEditDueDate(e.target.value)}
                        onBlur={() => {
                          const next = editDueDate ? editDueDate.slice(0, 10) : "";
                          // PR #R4h — compare against the *effective* due date
                          // (which is the value the input was actually showing),
                          // not inv.due_date. Otherwise toggling the discount
                          // back off would fire a redundant save against the
                          // newly-revealed Net date.
                          const prev = effectiveDueDate ? effectiveDueDate.slice(0, 10) : "";
                          if (next === prev) return;
                          // PR #R4h — if a discount was applied, a manual edit
                          // to the Due Date is an override: clear the discount
                          // flag so the user's typed date wins over the toggle.
                          // Sent as a single patch to keep AP aging consistent.
                          const patch: { due_date: string | null; discount_applied?: 0 } = { due_date: next || null };
                          if (discountActiveTop) patch.discount_applied = 0;
                          saveInvoiceFieldsMutation.mutate(patch as any);
                        }}
                        className={cn("h-9", !inv.due_date && "border-amber-300 dark:border-amber-700")}
                        data-testid="input-due-date"
                      />
                    </div>
                  </div>
                  {!inv.due_date && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-400 mt-2">
                      Due date is required to post to QBO with correct AP aging. Set it from the invoice's terms (e.g. invoice date + Net 30) or the printed Due Date.
                    </div>
                  )}
                  {saveInvoiceFieldsMutation.isPending && (
                    <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
                      <RefreshCw className="size-3 animate-spin" /> Saving…
                    </div>
                  )}
                </Card>

                {/* v8.4.5: Discount terms card. Shown only when the parser
                    detected discount_kind on this invoice. For early_pay the
                    user chooses; for net_with_discount the discount is automatic
                    per Jake's spec and the card just reports what will post. */}
                {inv.discount_kind && inv.discount_terms_pct ? (
                  <DiscountTermsCard
                    invoice={inv}
                    total={editTotal === "" ? inv.total : parseFloat(editTotal)}
                    freight={editFreight === "" ? 0 : parseFloat(editFreight)}
                    onToggle={(applied: boolean) => discountToggleMutation.mutate(applied)}
                    saving={discountToggleMutation.isPending}
                  />
                ) : null}

                {/* v8: Fuzzy duplicate hint — shows when the detector finds an
                    OCR-similar invoice number for the same vendor (60–99%). */}
                {fuzzyMatch && (
                  <Card className="border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950/30 p-3" data-testid="banner-fuzzy-dup">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="size-4 text-orange-700 dark:text-orange-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0 text-xs text-orange-900 dark:text-orange-100">
                        <div className="font-medium">
                          Possible duplicate ({fuzzyMatch.confidence}% confidence)
                        </div>
                        <div className="mt-0.5 break-words">{fuzzyMatch.reason}</div>
                        <div className="mt-1 text-[11px] opacity-80">
                          Match: <span className="font-mono">{fuzzyMatch.invoice_number || "(no number)"}</span>
                          {" — "}invoice id <span className="font-mono">{fuzzyMatch.id}</span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => fuzzyRecheckMutation.mutate()}
                        disabled={fuzzyRecheckMutation.isPending}
                        data-testid="button-fuzzy-recheck"
                      >
                        <RefreshCw className={cn("size-3 mr-1", fuzzyRecheckMutation.isPending && "animate-spin")} /> Re-check
                      </Button>
                    </div>
                  </Card>
                )}

                {/* Parse failure banner — shows when the LLM parser hit max_tokens or failed.
                    Lets the user retry without re-uploading the PDF. */}
                {inv.parse_failure_reason && (
                  <Card className="border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-amber-900 dark:text-amber-200">PDF parse failed</div>
                        <div className="text-xs text-amber-800 dark:text-amber-300 mt-1 break-words">
                          {inv.parse_failure_reason}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          Vendor name and totals may be missing. Use Reparse to try again, or fill them in by hand.
                        </div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => reparseMutation.mutate()} disabled={reparseMutation.isPending} data-testid="button-reparse">
                        <RefreshCw className={cn("size-3 mr-1", reparseMutation.isPending && "animate-spin")} />
                        {reparseMutation.isPending ? "Reparsing…" : "Reparse"}
                      </Button>
                    </div>
                  </Card>
                )}

                {/* Vendor match card */}
                <VendorMatchCard invoice={inv} onChanged={(payload?: any) => {
                  qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
                  invalidateAllInvoiceLists(qc);
                  // Round 7 follow-up: rematch may have triggered a server-side
                  // dup check that found this invoice already in QBO. Pop the
                  // auto-complete sign-off modal in that case.
                  if (payload?.dup_check?.found && payload?.invoice?.status === "pending_review") {
                    setDupModal({
                      bill_id: payload.dup_check.bill?.id || null,
                      payment_id: payload.dup_check.payment_id || null,
                      note: payload.dup_check.note,
                      paid_label: payload.dup_check.bill?.paid_label || "",
                      total: payload.dup_check.bill?.total || 0,
                      balance: payload.dup_check.bill?.balance || 0,
                    });
                  }
                }} />

                {/* Vendor Group disambiguation — only renders when this invoice's
                    QBO vendor belongs to a parent-company group (e.g. Amer Sports
                    → Atomic / Salomon). Lets Jake pick the actual brand. */}
                <VendorGroupCard invoice={inv} onChanged={() => { qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] }); invalidateAllInvoiceLists(qc); }} />

                {/* Duplicate check */}
                <Card className="border-card-border p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">Duplicate check</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {inv.duplicate_check_status === "clean" && "No duplicate found in QBO."}
                        {inv.duplicate_check_status === "duplicate_found" && "A bill with these details already exists."}
                        {inv.duplicate_check_status === "unchecked" && "Not yet verified."}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <DuplicateBadge status={inv.duplicate_check_status} />
                      <Button size="sm" variant="outline" onClick={() => recheckMutation.mutate()} disabled={recheckMutation.isPending} data-testid="button-recheck-duplicate">
                        <RefreshCw className={cn("size-3 mr-1", recheckMutation.isPending && "animate-spin")} /> Re-check
                      </Button>
                    </div>
                  </div>
                </Card>

                {/* Routing card */}
                <Card className="border-card-border p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="text-sm font-medium">Routing</div>
                      <div className="text-xs text-muted-foreground mt-0.5">Every line must code to a store inventory account.</div>
                    </div>
                  </div>
                  <Tabs value={routingMode} onValueChange={(v) => setRoutingMode(v as any)}>
                    <TabsList className="grid grid-cols-3 w-full">
                      <TabsTrigger value="single_store" data-testid="tab-single-store">Single store</TabsTrigger>
                      <TabsTrigger value="percent_split" data-testid="tab-percent-split">Percent split</TabsTrigger>
                      <TabsTrigger value="line_item_split" disabled={!(inv.line_items || []).some((li: any) => !li.is_freight)} data-testid="tab-line-items">
                        Line items {(() => {
                          const routable = (inv.line_items || []).filter((li: any) => !li.is_freight);
                          return !routable.length ? "(no lines)" : `(${routable.length})`;
                        })()}
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="single_store" className="pt-4 space-y-2">
                      <Label className="text-xs">Inventory account</Label>
                      <Select value={singleStore} onValueChange={(v) => setSingleStore(v as StoreKey)}>
                        <SelectTrigger data-testid="select-single-store"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {STORES.map((s) => <SelectItem key={s} value={s}>{STORE_LABELS[s]}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">All amounts (including freight) post to {STORE_LABELS[singleStore]}.</p>
                    </TabsContent>
                    <TabsContent value="percent_split" className="pt-4 space-y-3">
                      {STORES.map((s) => (
                        <div key={s}>
                          <div className="flex justify-between text-xs mb-1">
                            <Label className="font-normal">{STORE_SHORT[s]}</Label>
                            <span className="font-mono tabular-nums">{percentSplit[s]}% · {fmtMoney(((parseFloat(editTotal) || 0) - (parseFloat(editFreight) || 0)) * percentSplit[s] / 100)}</span>
                          </div>
                          <Slider
                            value={[percentSplit[s]]}
                            onValueChange={([v]) => setPercentSplit((p) => ({ ...p, [s]: v }))}
                            max={100}
                            step={1}
                            data-testid={`slider-percent-${s}`}
                          />
                        </div>
                      ))}
                      <div className={cn("text-xs mt-2", percentValid ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")} data-testid="text-percent-sum">
                        Total: {percentSum}% {percentValid ? "✓" : "(must equal 100%)"}
                      </div>
                      {(parseFloat(editFreight) || 0) > 0 && (
                        <div className="text-xs text-muted-foreground">Freight is split pro-rata using the same percentages.</div>
                      )}
                    </TabsContent>
                    <TabsContent value="line_item_split" className="pt-4">
                      {(() => {
                        // PR #R4l: separate routable inventory lines from freight lines.
                        // Freight lines (is_freight=1) are pro-rated automatically by the
                        // server using invoice.freight — they should not be independently
                        // assigned to a store or summed into the inventory totals, which
                        // previously double-counted freight on the QBO post.
                        const routableLines = (inv.line_items || []).filter((li: any) => !li.is_freight);
                        const freightLines = (inv.line_items || []).filter((li: any) => li.is_freight);
                        return routableLines.length ? (
                        <div className="space-y-3">
                          {/* Quick action: assign all unassigned lines to one store */}
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-muted-foreground">Assign all to:</span>
                            <Select value="" onValueChange={(v) => {
                              const next: Record<number, StoreKey> = {};
                              for (const li of routableLines) next[li.id] = v as StoreKey;
                              setLineAssignments(next);
                            }}>
                              <SelectTrigger className="h-7 text-xs w-32" data-testid="select-bulk-line-store">
                                <SelectValue placeholder="Pick store" />
                              </SelectTrigger>
                              <SelectContent>
                                {STORES.map((s) => <SelectItem key={s} value={s}>{STORE_LABELS[s]}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <button
                              type="button"
                              className="text-xs text-muted-foreground hover:text-foreground underline"
                              onClick={() => setLineAssignments({})}
                              data-testid="button-clear-line-assignments"
                            >
                              Clear
                            </button>
                          </div>
                          <div className="space-y-1 max-h-[260px] overflow-y-auto pr-1">
                            {routableLines.map((li: any) => (
                              <div key={li.id} className="grid grid-cols-[1fr,auto,140px] gap-2 items-center text-xs py-1 border-b border-border last:border-0">
                                <div className="min-w-0">
                                  <div className="font-mono text-[11px] text-muted-foreground">{li.sku || "—"}{li.qty ? ` · qty ${li.qty}` : ""}</div>
                                  <div className="truncate" title={li.description}>{li.description}</div>
                                </div>
                                <div className="font-mono tabular-nums whitespace-nowrap">{fmtMoney(li.amount)}</div>
                                <Select value={lineAssignments[li.id] || ""} onValueChange={(v) => setLineAssignments((m) => ({ ...m, [li.id]: v as StoreKey }))}>
                                  <SelectTrigger className="h-8 text-xs" data-testid={`select-line-store-${li.id}`}><SelectValue placeholder="Default" /></SelectTrigger>
                                  <SelectContent>
                                    {STORES.map((s) => <SelectItem key={s} value={s}>{STORE_SHORT[s]}</SelectItem>)}
                                  </SelectContent>
                                </Select>
                              </div>
                            ))}
                            {freightLines.map((li: any) => (
                              <div key={li.id} className="grid grid-cols-[1fr,auto,140px] gap-2 items-center text-xs py-1 border-b border-border last:border-0 opacity-70">
                                <div className="min-w-0">
                                  <div className="font-mono text-[11px] text-muted-foreground">{li.sku || "—"} · freight</div>
                                  <div className="truncate" title={li.description}>{li.description}</div>
                                </div>
                                <div className="font-mono tabular-nums whitespace-nowrap">{fmtMoney(li.amount)}</div>
                                <div className="text-[11px] text-muted-foreground italic text-right pr-2">Pro-rata</div>
                              </div>
                            ))}
                          </div>
                          {/* Per-store totals preview */}
                          {(() => {
                            const totals: Record<string, { amt: number; count: number }> = {};
                            let unassigned = 0;
                            let unassignedCount = 0;
                            for (const li of routableLines) {
                              const s = lineAssignments[li.id];
                              if (s) {
                                totals[s] = totals[s] || { amt: 0, count: 0 };
                                totals[s].amt += (li.amount || 0);
                                totals[s].count += 1;
                              } else {
                                unassigned += (li.amount || 0);
                                unassignedCount += 1;
                              }
                            }
                            return (
                              <div className="text-xs space-y-0.5 bg-muted/30 rounded p-2">
                                {STORES.map((s) => totals[s] ? (
                                  <div key={s} className="flex justify-between">
                                    <span>{STORE_SHORT[s]} · {totals[s].count} line{totals[s].count === 1 ? "" : "s"}</span>
                                    <span className="font-mono tabular-nums">{fmtMoney(totals[s].amt)}</span>
                                  </div>
                                ) : null)}
                                {unassignedCount > 0 && (
                                  <div className="flex justify-between text-amber-600 dark:text-amber-400">
                                    <span>Unassigned → {STORE_SHORT[singleStore]} · {unassignedCount} line{unassignedCount === 1 ? "" : "s"}</span>
                                    <span className="font-mono tabular-nums">{fmtMoney(unassigned)}</span>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                          {(parseFloat(editFreight) || 0) > 0 && (
                            <div className="text-[11px] text-muted-foreground">
                              Freight ({fmtMoney(parseFloat(editFreight))}) pro-rates across stores by line totals.
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground">
                            Default store (for unassigned lines): {STORE_LABELS[singleStore]}
                          </div>
                        </div>
                        ) : (
                        <div className="text-sm text-muted-foreground py-4 text-center space-y-2">
                          <div>No line items parsed for this invoice.</div>
                          <div className="text-xs">Try Re-parse to extract them, or use Single store / Percent split.</div>
                        </div>
                        );
                      })()}
                    </TabsContent>
                  </Tabs>
                </Card>

                {/* Edit totals card */}
                <Card className="border-card-border p-4">
                  <div className="text-sm font-medium mb-2">Totals</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Invoice total</Label>
                      <Input type="number" step="0.01" value={editTotal} onChange={(e) => setEditTotal(e.target.value)} className="font-mono h-9" data-testid="input-edit-total" />
                    </div>
                    <div>
                      <Label className="text-xs">Freight</Label>
                      <Input type="number" step="0.01" value={editFreight} onChange={(e) => setEditFreight(e.target.value)} className="font-mono h-9" data-testid="input-edit-freight" />
                    </div>
                  </div>
                </Card>

                {/* QBO payload preview */}
                <Card className="border-card-border p-4">
                  <button
                    className="w-full flex items-center justify-between text-sm font-medium"
                    onClick={() => setShowPayload((s) => !s)}
                    data-testid="button-toggle-payload"
                  >
                    <span>QBO Bill payload preview</span>
                    {showPayload ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                  </button>
                  {showPayload && livePayload && (
                    <div className="mt-3">
                      <pre className="text-[11px] bg-muted/40 border border-border rounded-md p-3 overflow-x-auto max-h-[260px] font-mono leading-relaxed" data-testid="text-payload-json">
                        {JSON.stringify(livePayload, null, 2)}
                      </pre>
                      <Button variant="outline" size="sm" className="mt-2" onClick={() => { navigator.clipboard?.writeText(JSON.stringify(livePayload, null, 2)); toast({ title: "Copied" }); }} data-testid="button-copy-payload">
                        <Copy className="size-3 mr-1" /> Copy JSON
                      </Button>
                    </div>
                  )}
                </Card>

                {/* Audit log */}
                <Card className="border-card-border p-4">
                  <button
                    className="w-full flex items-center justify-between text-sm font-medium"
                    onClick={() => setAuditOpen((s) => !s)}
                    data-testid="button-toggle-audit"
                  >
                    <span className="flex items-center gap-1.5"><History className="size-4" /> Audit log{inv.audit_log?.length ? ` (${inv.audit_log.length})` : ""}</span>
                    {auditOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                  </button>
                  {auditOpen && (
                    <div className="mt-3 space-y-2">
                      {(inv.audit_log || []).length === 0 && <div className="text-xs text-muted-foreground">No changes yet.</div>}
                      {(inv.audit_log || []).map((entry: any) => (
                        <div key={entry.id} className="text-xs border-l-2 border-primary/30 pl-3 py-1">
                          <div className="font-medium">{entry.action}</div>
                          <div className="text-muted-foreground">{entry.user_email} · {fmtDate(entry.created_at)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                {/* Notes (per-invoice append-only log) */}
                <NotesCard invoiceId={inv.id} />
              </div>
            </div>

            {/* Action footer — mobile: primary button full-width + More dropdown */}
            <div className={cn(
              "border-t border-border px-4 py-3 bg-card/50",
              isMobile ? "flex flex-col gap-2" : "flex items-center justify-between gap-2 flex-wrap px-6"
            )}>
              {!isMobile && (
                <div className="text-xs text-muted-foreground">
                  {(inv.status === "pending_review" || inv.status === "receiving" || inv.status === "quarantined") && approveBlockReason && (
                    <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="size-3.5" /> Cannot approve: {approveBlockReason}
                    </span>
                  )}
                  {inv.status === "approved_local" && <span className="text-amber-600 dark:text-amber-400">Approved — not yet posted to QBO. Click Retry below.</span>}
                  {inv.status === "posted_qbo" && <span className="text-emerald-600 dark:text-emerald-400">Posted to QBO {inv.qbo_bill_id ? `\u00b7 ${inv.is_credit ? "vendor credit" : "bill"} ${inv.qbo_bill_id}` : ""}</span>}
                  {inv.status === "rejected" && <span className="text-red-600 dark:text-red-400">Rejected{inv.notes ? ` \u00b7 ${inv.notes}` : ""}</span>}
                </div>
              )}

              {/* Desktop action buttons row */}
              {!isMobile && (
                <div className="flex items-center gap-2 ml-auto">
                  {canApproveAp && inv.status === "pending_review" && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => bucketMutation.mutate({ status: "receiving" })} disabled={bucketMutation.isPending} data-testid="button-hold-receiving">In Receiving</Button>
                      <Button variant="outline" size="sm" onClick={() => bucketMutation.mutate({ status: "quarantined" })} disabled={bucketMutation.isPending} data-testid="button-quarantine">Quarantine</Button>
                      {canManageSkipSenders && <Button variant="outline" size="sm" onClick={() => setSkipDialogOpen(true)} disabled={!inv.email_from} data-testid="button-skip-sender">Skip sender…</Button>}
                      <MarkPostedDialog mode="already-in-qbo" invoiceId={inv.id} payload={livePayload} onDone={() => { qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] }); invalidateAllInvoiceLists(qc); }} />
                      <Button variant="outline" onClick={() => rejectMutation.mutate()} disabled={rejectMutation.isPending} data-testid="button-reject">Reject</Button>
                      <Button variant="outline" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-draft">{saveMutation.isPending ? "Saving…" : "Save draft"}</Button>
                      <Button onClick={() => approveMutation.mutate()} disabled={!canApprove || approveMutation.isPending || (routingMode === "percent_split" && !percentValid)} data-testid="button-approve">
                        {approveMutation.isPending ? (inv.is_credit ? "Approving & posting credit…" : "Approving & posting…") : (inv.is_credit ? "Approve & post vendor credit" : "Approve & post to QBO")}
                      </Button>
                    </>
                  )}
                  {canApproveAp && (inv.status === "receiving" || inv.status === "quarantined") && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => bucketMutation.mutate({ status: "pending_review", reason: "Returned to inbox" })} disabled={bucketMutation.isPending} data-testid="button-return-to-inbox">Return to Inbox</Button>
                      <Button variant="outline" size="sm" onClick={() => rejectMutation.mutate()} disabled={rejectMutation.isPending} data-testid="button-reject-from-bucket">Reject</Button>
                      <MarkPostedDialog mode="already-in-qbo" invoiceId={inv.id} payload={livePayload} onDone={() => { qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] }); invalidateAllInvoiceLists(qc); }} />
                      <Button variant="outline" size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-draft-bucket">{saveMutation.isPending ? "Saving…" : "Save"}</Button>
                      <Button onClick={() => approveMutation.mutate()} disabled={!canApprove || approveMutation.isPending || (routingMode === "percent_split" && !percentValid)} data-testid="button-approve-from-bucket">
                        {approveMutation.isPending ? (inv.is_credit ? "Approving & posting credit…" : "Approving & posting…") : (inv.is_credit ? "Approve & post vendor credit" : "Approve & post to QBO")}
                      </Button>
                    </>
                  )}
                  {canApproveAp && inv.status === "approved_local" && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => revertToPendingMutation.mutate()} disabled={revertToPendingMutation.isPending} data-testid="button-revert-pending">{revertToPendingMutation.isPending ? "Reverting…" : "Revert to pending"}</Button>
                      <MarkPostedDialog invoiceId={inv.id} payload={livePayload} onDone={() => { qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] }); invalidateAllInvoiceLists(qc); }} />
                      <Button onClick={() => postToQboMutation.mutate()} disabled={postToQboMutation.isPending} data-testid="button-retry-post-qbo">
                        <Send className="size-3 mr-1" /> {postToQboMutation.isPending ? "Posting…" : (inv.is_credit ? "Retry post vendor credit" : "Retry post to QBO")}
                      </Button>
                    </>
                  )}
                  {canApproveAp && inv.status === "rejected" && (
                    <Button variant="outline" onClick={() => restoreMutation.mutate()} disabled={restoreMutation.isPending} data-testid="button-restore">{restoreMutation.isPending ? "Restoring…" : "Restore to pending"}</Button>
                  )}
                </div>
              )}

              {/* Mobile action buttons: primary full-width + More dropdown */}
              {isMobile && (
                <>
                  {/* Status hint */}
                  <div className="text-xs text-muted-foreground">
                    {(inv.status === "pending_review" || inv.status === "receiving" || inv.status === "quarantined") && approveBlockReason && (
                      <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="size-3.5" /> Cannot approve: {approveBlockReason}
                      </span>
                    )}
                    {inv.status === "approved_local" && <span className="text-amber-600 dark:text-amber-400">Approved — not yet posted to QBO</span>}
                    {inv.status === "posted_qbo" && <span className="text-emerald-600 dark:text-emerald-400">Posted to QBO</span>}
                    {inv.status === "rejected" && <span className="text-red-600 dark:text-red-400">Rejected</span>}
                  </div>
                  {/* Primary + More row */}
                  <div className="flex items-center gap-2">
                    {canApproveAp && (inv.status === "pending_review" || inv.status === "receiving" || inv.status === "quarantined") && (
                      <>
                        <Button
                          className="flex-1"
                          onClick={() => approveMutation.mutate()}
                          disabled={!canApprove || approveMutation.isPending || (routingMode === "percent_split" && !percentValid)}
                          data-testid="button-approve-mobile"
                        >
                          {approveMutation.isPending ? "Posting\u2026" : (inv.is_credit ? "Post credit" : "Approve & post")}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" className="shrink-0" data-testid="button-more-actions">
                              <MoreHorizontal className="size-4" /> More
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>Save draft</DropdownMenuItem>
                            {inv.status === "pending_review" && <DropdownMenuItem onClick={() => bucketMutation.mutate({ status: "receiving" })}>In Receiving</DropdownMenuItem>}
                            {inv.status === "pending_review" && <DropdownMenuItem onClick={() => bucketMutation.mutate({ status: "quarantined" })}>Quarantine</DropdownMenuItem>}
                            {(inv.status === "receiving" || inv.status === "quarantined") && <DropdownMenuItem onClick={() => bucketMutation.mutate({ status: "pending_review", reason: "Returned to inbox" })}>Return to Inbox</DropdownMenuItem>}
                            <DropdownMenuItem onClick={() => rejectMutation.mutate()} disabled={rejectMutation.isPending}>Reject</DropdownMenuItem>
                            {canManageSkipSenders && inv.email_from && <DropdownMenuItem onClick={() => setSkipDialogOpen(true)}>Skip sender…</DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    )}
                    {canApproveAp && inv.status === "approved_local" && (
                      <>
                        <Button className="flex-1" onClick={() => postToQboMutation.mutate()} disabled={postToQboMutation.isPending} data-testid="button-retry-post-qbo-mobile">
                          <Send className="size-3 mr-1" /> {postToQboMutation.isPending ? "Posting\u2026" : "Retry post to QBO"}
                        </Button>
                        <Button variant="outline" className="shrink-0" onClick={() => revertToPendingMutation.mutate()} disabled={revertToPendingMutation.isPending}>Revert</Button>
                      </>
                    )}
                    {canApproveAp && inv.status === "rejected" && (
                      <Button className="flex-1" variant="outline" onClick={() => restoreMutation.mutate()} disabled={restoreMutation.isPending}>{restoreMutation.isPending ? "Restoring…" : "Restore to pending"}</Button>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* Legacy approval-payload dialog removed — Approve now posts directly to QBO via OAuth. */}
        {inv && (
          <SkipSenderDialog
            open={skipDialogOpen}
            onOpenChange={setSkipDialogOpen}
            mode="invoice"
            senderEmail={inv.email_from}
            vendorName={inv.vendor_name}
            invoiceId={inv.id}
            onAdded={() => onClose()}
          />
        )}
        {/* Round 7 follow-up: duplicate-found auto-complete sign-off. Pops when
            reparse / rematch / recheck discovers this invoice already exists in
            QBO. User can confirm to move it to Completed (calling mark-posted)
            or keep it in Pending review. */}
        {inv && dupModal && (
          <DuplicateAutoCompleteDialog
            invoiceId={inv.id}
            invoice={inv}
            dup={dupModal}
            onClose={() => setDupModal(null)}
            onCompleted={() => {
              setDupModal(null);
              qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
              invalidateAllInvoiceLists(qc);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function VendorMatchCard({ invoice, onChanged }: { invoice: any; onChanged: (payload?: any) => void }) {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canApproveAp = hasPermission("ap.approve");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Per Jake: every manual pick auto-saves as an alias so future invoices match.
  // The checkbox UI is removed.
  const vendorsQ = useQuery<any[]>({
    queryKey: ["/api/qbo-vendors", search ? `?q=${encodeURIComponent(search)}` : ""],
    enabled: open,
  });

  // Ranked suggestions for unmatched invoices (token-overlap on raw name + Claude fallback)
  const suggestionsQ = useQuery<any>({
    queryKey: [`/api/invoices/${invoice.id}/vendor-suggestions`],
    enabled: open && invoice.vendor_match_status === "unmatched" && !!invoice.vendor_raw_name,
  });

  const assign = useMutation({
    mutationFn: async (v: { id: string; name: string }) => {
      const res = await apiRequest("POST", `/api/invoices/${invoice.id}/assign-vendor`, {
        vendor_qbo_id: v.id,
        vendor_name: v.name,
        // save_as_alias defaults true on the server now; explicitly true for clarity.
        save_as_alias: true,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Vendor assigned" });
      setOpen(false);
      onChanged();
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Round 7 follow-up: Re-match vendor — re-runs smart matcher + LLM fallback
  // against the stored vendor_raw_name without re-parsing the PDF. Useful when
  // matcher logic improved or new aliases were added after this invoice parsed.
  const rematch = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoice.id}/rematch-vendor`);
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data?.matched) {
        toast({
          title: "Vendor matched",
          description: `"${invoice.vendor_raw_name}" → ${data.invoice?.vendor_qbo_name || "vendor"}${data.source === "llm" ? " (AI)" : ""}`,
        });
        // Pass the full payload so the parent can react to dup_check.
        onChanged(data);
      } else {
        toast({
          title: "No match found",
          description: data?.message || `No QBO vendor matched "${invoice.vendor_raw_name}". Use Change vendor to pick manually.`,
        });
      }
    },
    onError: (e: any) => toast({ title: "Re-match failed", description: e.message, variant: "destructive" }),
  });

  // Round 4: Remove vendor — clears the vendor match on this invoice AND removes
  // the alias for vendor_raw_name if one exists, so a wrong AI match doesn't keep
  // re-applying to future invoices with the same title.
  const remove = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoice.id}/remove-vendor`);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Vendor removed",
        description: data?.alias_deleted
          ? `Also deleted alias for "${invoice.vendor_raw_name}" — future invoices with this title will not auto-match.`
          : undefined,
      });
      setOpen(false);
      onChanged();
    },
    onError: (e: any) => toast({ title: "Remove failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Card className="border-card-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Vendor match</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {invoice.vendor_match_status === "matched" && `Matched to QBO vendor #${invoice.vendor_qbo_id}`}
            {invoice.vendor_match_status === "aliased" && `Aliased from "${invoice.vendor_raw_name}" → ${invoice.vendor_qbo_name}`}
            {invoice.vendor_match_status === "unmatched" && "No QBO vendor matched yet — assign one to enable approval."}
          </div>
          <div className="mt-2">
            <span className="text-sm font-medium">{invoice.vendor_qbo_name || "—"}</span>
            {invoice.vendor_qbo_id && <span className="text-xs text-muted-foreground ml-2">QBO ID {invoice.vendor_qbo_id}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canApproveAp && !invoice.vendor_qbo_id && invoice.vendor_raw_name && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => rematch.mutate()}
              disabled={rematch.isPending}
              data-testid="button-rematch-vendor"
              title={`Re-run vendor matcher against "${invoice.vendor_raw_name}". Doesn’t re-parse the PDF.`}
            >
              {rematch.isPending ? "Matching…" : "Re-match"}
            </Button>
          )}
          {canApproveAp && invoice.vendor_qbo_id && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (window.confirm(`Remove vendor "${invoice.vendor_qbo_name || ""}" from this invoice?\n\nThis will also delete the alias for "${invoice.vendor_raw_name || ""}" so future invoices with this title don\u2019t auto-match the same vendor.`)) {
                  remove.mutate();
                }
              }}
              disabled={remove.isPending}
              data-testid="button-remove-vendor"
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          )}
        {canApproveAp && <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" data-testid="button-change-vendor">Change vendor</Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-[360px] p-0"
            // Stop wheel events from bubbling to parent Drawer/Dialog scroll-lock,
            // which otherwise swallows mouse-wheel and trackpad scrolling inside cmdk.
            onWheel={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
          >
            <Command shouldFilter={false}>
              <CommandInput placeholder="Search QBO vendors…" value={search} onValueChange={setSearch} data-testid="input-vendor-search" />
              <CommandList className="max-h-[320px] overflow-y-auto overscroll-contain">
                <CommandEmpty>No vendors found.</CommandEmpty>
                {/* Suggested matches based on the parsed raw vendor name */}
                {invoice.vendor_match_status === "unmatched" && (suggestionsQ.data?.local_suggestions?.length > 0 || suggestionsQ.data?.llm_suggestion?.vendor_qbo_id) && !search && (
                  <CommandGroup heading={`Suggested for "${suggestionsQ.data?.raw_name || invoice.vendor_raw_name}"`}>
                    {(suggestionsQ.data?.local_suggestions || []).map((s: any) => (
                      <CommandItem
                        key={`sug-${s.vendor_qbo_id}`}
                        value={`sug-${s.vendor_qbo_id}`}
                        onSelect={() => assign.mutate({ id: s.vendor_qbo_id, name: s.vendor_qbo_name })}
                        data-testid={`item-suggestion-${s.vendor_qbo_id}`}
                      >
                        <span className="flex-1">{s.vendor_qbo_name}</span>
                        <span className="text-[10px] text-emerald-600 dark:text-emerald-400">match {s.score}</span>
                      </CommandItem>
                    ))}
                    {suggestionsQ.data?.llm_suggestion?.vendor_qbo_id && (
                      <CommandItem
                        key={`llm-${suggestionsQ.data.llm_suggestion.vendor_qbo_id}`}
                        value={`llm-${suggestionsQ.data.llm_suggestion.vendor_qbo_id}`}
                        onSelect={() => assign.mutate({ id: suggestionsQ.data.llm_suggestion.vendor_qbo_id, name: suggestionsQ.data.llm_suggestion.vendor_qbo_name })}
                        data-testid={`item-llm-suggestion`}
                      >
                        <span className="flex-1">{suggestionsQ.data.llm_suggestion.vendor_qbo_name}</span>
                        <span className="text-[10px] text-blue-600 dark:text-blue-400">AI {suggestionsQ.data.llm_suggestion.confidence}</span>
                      </CommandItem>
                    )}
                  </CommandGroup>
                )}
                <CommandGroup heading="QBO Vendors">
                  {(vendorsQ.data || []).map((v) => (
                    <CommandItem key={v.Id} value={v.Id} onSelect={() => assign.mutate({ id: v.Id, name: v.DisplayName })} data-testid={`item-vendor-${v.Id}`}>
                      <span className="flex-1">{v.DisplayName}</span>
                      <span className="text-[10px] text-muted-foreground">#{v.Id}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
              <div className="p-2 border-t border-border text-xs text-muted-foreground">
                Picking a vendor saves an alias so future invoices with this vendor name match automatically.
              </div>
            </Command>
          </PopoverContent>
        </Popover>}
        </div>
      </div>
    </Card>
  );
}

/**
 * Renders when this invoice's vendor belongs to a Vendor Group. Shows scored
 * brand suggestions (matched by keywords against PDF text + line items) and
 * lets the user pick the real sub-brand. Picking a member calls assign-vendor
 * just like the regular VendorMatchCard.
 */
function VendorGroupCard({ invoice, onChanged }: { invoice: any; onChanged: () => void }) {
  const { toast } = useToast();
  const { hasPermission } = useAuth();
  const canApproveAp = hasPermission("ap.approve");
  const qc = useQueryClient();
  // Round 7 follow-up: query runs for every invoice, not just ones already
  // matched to a QBO vendor. Server auto-detects groups via PDF text when the
  // matched vendor isn't part of any group yet.
  const groupQ = useQuery<{ group: any | null; suggestions: any[]; source?: string }>({
    queryKey: [`/api/invoices/${invoice.id}/vendor-group`],
  });
  const assign = useMutation({
    mutationFn: async (v: { id: string; name: string }) => {
      const res = await apiRequest("POST", `/api/invoices/${invoice.id}/assign-vendor`, {
        vendor_qbo_id: v.id,
        vendor_name: v.name,
        save_as_alias: true,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Brand assigned" });
      onChanged();
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  if (!groupQ.data?.group) return null;
  const group = groupQ.data.group;
  const suggestions = groupQ.data.suggestions || [];
  const source = groupQ.data.source;
  const top = suggestions[0];
  const hasAutoMatch = top && top.score > 0;
  const isAutoDetected = source === "auto_detect";
  return (
    <Card className="border-blue-300 dark:border-blue-700 bg-blue-50/40 dark:bg-blue-950/20 p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-blue-900 dark:text-blue-200">
            Pick a brand — part of {group.name}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {isAutoDetected
              ? <>Detected brand keywords in this PDF for the {group.name} group. Pick the brand the inventory should code to.</>
              : <>This vendor is a parent company. Choose which brand the inventory should code to.</>}
            {hasAutoMatch && (
              <> Suggested: <span className="font-medium text-foreground">{top.vendor_qbo_name}</span>{top.matched_keywords?.length ? <> (matched: {top.matched_keywords.join(", ")})</> : null}.</>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs shrink-0"
          onClick={() => qc.invalidateQueries({ queryKey: [`/api/invoices/${invoice.id}/vendor-group`] })}
          disabled={groupQ.isFetching}
          data-testid="button-refresh-vendor-group"
          title="Refresh after editing groups in Settings"
        >
          <RefreshCw className={cn("size-3 mr-1", groupQ.isFetching && "animate-spin")} /> Refresh
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {suggestions.map((m: any) => {
          const selected = invoice.vendor_qbo_id === m.vendor_qbo_id;
          return (
            <Button
              key={m.id}
              size="sm"
              variant={selected ? "default" : (m.score > 0 ? "secondary" : "outline")}
              onClick={() => { if (!selected) assign.mutate({ id: m.vendor_qbo_id, name: m.vendor_qbo_name }); }}
              disabled={assign.isPending || !canApproveAp}
              data-testid={`button-group-member-${m.vendor_qbo_id}`}
              title={m.brand_keywords ? `Keywords: ${m.brand_keywords}` : undefined}
            >
              {selected && <Check className="size-3 mr-1" />}
              {m.vendor_qbo_name}
              {m.score > 0 && <span className="ml-1.5 text-[10px] opacity-70">({m.matched_keywords.length})</span>}
            </Button>
          );
        })}
        {suggestions.length === 0 && (
          <div className="text-xs text-muted-foreground">No members configured — add brands in Settings → Vendor Groups.</div>
        )}
      </div>
    </Card>
  );
}

function MarkPostedDialog({ invoiceId, payload, onDone, mode = "approved" }: { invoiceId: string; payload: any; onDone: () => void; mode?: "approved" | "already-in-qbo" }) {
  const [open, setOpen] = useState(false);
  const [billId, setBillId] = useState("");
  const { toast } = useToast();
  const mut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/mark-posted`, { qbo_bill_id: billId || null });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: mode === "already-in-qbo" ? "Marked as already in QBO" : "Marked as posted" });
      setOpen(false);
      onDone();
    },
  });
  if (mode === "already-in-qbo") {
    return (
      <>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="button-already-in-qbo" title="This bill was already entered in QBO directly. Mark it as posted without sending anything.">
          Already in QBO
        </Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Already in QBO</DialogTitle>
              <DialogDescription>This will mark the invoice as posted to QBO without sending it. Use when you've already entered the bill in QBO directly. Optionally enter the QBO bill ID for traceability.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label className="text-xs">QBO Bill ID (optional)</Label>
              <Input value={billId} onChange={(e) => setBillId(e.target.value)} placeholder="e.g. 12345" data-testid="input-qbo-bill-id-already" />
            </div>
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="outline" onClick={() => setOpen(false)} data-testid="button-cancel-already-in-qbo">Cancel</Button>
              <Button onClick={() => mut.mutate()} disabled={mut.isPending} data-testid="button-confirm-already-in-qbo">
                {mut.isPending ? "Saving…" : "Mark as already in QBO"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)); toast({ title: "Payload copied" }); }} data-testid="button-copy-payload-footer">
        <Copy className="size-3 mr-1" /> Copy payload
      </Button>
      <Button onClick={() => setOpen(true)} data-testid="button-mark-posted">
        <Send className="size-3 mr-1" /> Mark posted in QBO
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark posted to QBO</DialogTitle>
            <DialogDescription>Optionally enter the QBO bill ID for traceability.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">QBO Bill ID (optional)</Label>
            <Input value={billId} onChange={(e) => setBillId(e.target.value)} placeholder="e.g. 12345" data-testid="input-qbo-bill-id" />
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => setOpen(false)} data-testid="button-cancel-mark-posted">Cancel</Button>
            <Button onClick={() => mut.mutate()} disabled={mut.isPending} data-testid="button-confirm-mark-posted">
              {mut.isPending ? "Saving…" : "Mark posted"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DrawerSkeleton() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      <div className="grid grid-cols-2 gap-4 mt-6">
        <Skeleton className="h-[400px]" />
        <div className="space-y-3">
          <Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" />
        </div>
      </div>
    </div>
  );
}

// Local helper to compute live payload (mirrors server logic)
function computeLivePayload(args: {
  invoice: any;
  total: number;
  freight: number;
  routingMode: string;
  singleStore: StoreKey;
  percentSplit: Record<StoreKey, number>;
  lineAssignments: Record<number, StoreKey>;
}) {
  const STORE_DEF: Record<StoreKey, { id: string; name: string; label: string }> = {
    greenvale: { id: "38", name: "Inventory Asset", label: STORE_LABELS.greenvale },
    hempstead: { id: "1150040012", name: "Inventory for Hempstead", label: STORE_LABELS.hempstead },
    huntington: { id: "1150040011", name: "Inventory for Huntington", label: STORE_LABELS.huntington },
  };
  const inv = args.invoice;
  const total = args.total || 0;
  const freight = args.freight || 0;
  const subtotal = total - freight;
  const lines: any[] = [];

  if (args.routingMode === "single_store") {
    const acc = STORE_DEF[args.singleStore];
    if (subtotal !== 0) lines.push({
      DetailType: "AccountBasedExpenseLineDetail", Amount: round2(subtotal), Description: `Inventory — ${acc.label}`,
      AccountBasedExpenseLineDetail: { AccountRef: { value: acc.id, name: acc.name } },
    });
    if (freight) lines.push({
      DetailType: "AccountBasedExpenseLineDetail", Amount: round2(freight), Description: `Freight (landed cost) — ${acc.label}`,
      AccountBasedExpenseLineDetail: { AccountRef: { value: acc.id, name: acc.name } },
    });
  } else if (args.routingMode === "percent_split") {
    for (const k of STORES) {
      const pct = args.percentSplit[k] || 0;
      if (!pct) continue;
      const acc = STORE_DEF[k];
      lines.push({ DetailType: "AccountBasedExpenseLineDetail", Amount: round2(subtotal * pct / 100), Description: `Inventory — ${acc.label} (${pct}%)`, AccountBasedExpenseLineDetail: { AccountRef: { value: acc.id, name: acc.name } } });
      if (freight) lines.push({ DetailType: "AccountBasedExpenseLineDetail", Amount: round2(freight * pct / 100), Description: `Freight (pro-rata ${pct}%) — ${acc.label}`, AccountBasedExpenseLineDetail: { AccountRef: { value: acc.id, name: acc.name } } });
    }
  } else if (args.routingMode === "line_item_split") {
    const totals: Record<string, number> = {};
    for (const li of (inv.line_items || [])) {
      const store = args.lineAssignments[li.id] || args.singleStore;
      totals[store] = (totals[store] || 0) + (li.amount || 0);
    }
    for (const [k, amt] of Object.entries(totals)) {
      const acc = STORE_DEF[k as StoreKey];
      lines.push({ DetailType: "AccountBasedExpenseLineDetail", Amount: round2(amt), Description: `Inventory (line items) — ${acc.label}`, AccountBasedExpenseLineDetail: { AccountRef: { value: acc.id, name: acc.name } } });
    }
    if (freight) {
      const sumAssigned = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
      for (const [k, amt] of Object.entries(totals)) {
        const acc = STORE_DEF[k as StoreKey];
        lines.push({ DetailType: "AccountBasedExpenseLineDetail", Amount: round2((amt / sumAssigned) * freight), Description: `Freight (pro-rata) — ${acc.label}`, AccountBasedExpenseLineDetail: { AccountRef: { value: acc.id, name: acc.name } } });
      }
    }
  }

  // v8.4.5: discount lines mirror server logic in buildQboBillPayload. When
  // discount_applied=1, append negative line(s) against the same inventory
  // accounts used by the positive lines, pro-rata across stores.
  const discountActive = !!(inv.discount_applied && inv.discount_terms_pct && inv.discount_kind);
  const discountPct = discountActive ? Number(inv.discount_terms_pct) : 0;
  const discountTotal = discountActive ? (subtotal * discountPct) / 100 : 0;
  if (discountActive && discountTotal > 0) {
    const desc = `${discountPct}% terms discount`;
    if (args.routingMode === "single_store") {
      const acc = STORE_DEF[args.singleStore];
      lines.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: -round2(discountTotal),
        Description: `${desc} — ${acc.label}`,
        AccountBasedExpenseLineDetail: { AccountRef: { value: acc.id, name: acc.name } },
      });
    } else if (args.routingMode === "percent_split") {
      for (const k of STORES) {
        const pct = args.percentSplit[k] || 0;
        if (!pct) continue;
        const acc = STORE_DEF[k];
        lines.push({
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: -round2((discountTotal * pct) / 100),
          Description: `${desc} — ${acc.label} (${pct}%)`,
          AccountBasedExpenseLineDetail: { AccountRef: { value: acc.id, name: acc.name } },
        });
      }
    } else if (args.routingMode === "line_item_split") {
      const totals: Record<string, number> = {};
      for (const li of (inv.line_items || [])) {
        const store = args.lineAssignments[li.id] || args.singleStore;
        totals[store] = (totals[store] || 0) + (li.amount || 0);
      }
      const sumAssigned = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
      for (const [k, amt] of Object.entries(totals)) {
        const acc = STORE_DEF[k as StoreKey];
        lines.push({
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: -round2((amt / sumAssigned) * discountTotal),
          Description: `${desc} — ${acc.label}`,
          AccountBasedExpenseLineDetail: { AccountRef: { value: acc.id, name: acc.name } },
        });
      }
    }
  }

  const effectiveTotal = round2(total - discountTotal);
  const effectiveDueDate =
    discountActive && inv.discount_kind === "early_pay" && inv.discount_due_date
      ? inv.discount_due_date
      : inv.due_date;

  return {
    VendorRef: inv.vendor_qbo_id ? { value: inv.vendor_qbo_id, name: inv.vendor_qbo_name } : null,
    TxnDate: inv.invoice_date,
    DueDate: effectiveDueDate,
    DocNumber: inv.invoice_number,
    TotalAmt: effectiveTotal,
    PrivateNote: inv.notes || undefined,
    Line: lines,
  };
}

function round2(v: number): number { return Math.round(v * 100) / 100; }

/**
 * v8.4.5: Discount terms card. Surfaces parsed discount terms and — for
 * early_pay (e.g. "2% 10 Net 30") — lets the user choose whether to take the
 * discount. For net_with_discount (e.g. "Net 90 10%") the discount is
 * automatic per Jake's spec and only the summary is shown.
 */
function DiscountTermsCard({
  invoice,
  total,
  freight,
  onToggle,
  saving,
}: {
  invoice: any;
  total: number;
  freight: number;
  onToggle: (applied: boolean) => void;
  saving: boolean;
}) {
  const pct: number = Number(invoice.discount_terms_pct) || 0;
  const kind: "early_pay" | "net_with_discount" = invoice.discount_kind;
  const applied = !!invoice.discount_applied;
  const subtotal = (Number(total) || 0) - (Number(freight) || 0);
  const discountAmount = round2((subtotal * pct) / 100);
  const effectiveTotal = round2((Number(total) || 0) - discountAmount);
  const isEditable = invoice.status === "pending_review" || invoice.status === "receiving" || invoice.status === "quarantined";

  const headerLabel = kind === "early_pay"
    ? `Early-payment discount detected: ${pct}% off if paid within ${invoice.discount_days} day${invoice.discount_days === 1 ? "" : "s"}`
    : `Terms discount: ${pct}% off if paid within ${invoice.discount_days} day${invoice.discount_days === 1 ? "" : "s"}`;

  return (
    <Card
      className={cn(
        "border-card-border p-4",
        applied && "border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-950/20"
      )}
      data-testid="card-discount-terms"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium">{headerLabel}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Discount applies to subtotal ({fmtMoney(subtotal)}), not freight. {kind === "net_with_discount" ? "This discount is automatic per the vendor's terms." : "Choose how to post."}
          </div>
        </div>
        {invoice.discount_warning ? (
          <div
            className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded-md px-2 py-1"
            data-testid="chip-discount-warning"
            title={invoice.discount_warning}
          >
            <AlertTriangle className="size-3 shrink-0" />
            <span className="truncate max-w-[200px]">{invoice.discount_warning}</span>
          </div>
        ) : null}
      </div>

      {kind === "early_pay" ? (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!isEditable || saving}
            onClick={() => { if (!applied) onToggle(true); }}
            className={cn(
              "text-left rounded-md border px-3 py-2 transition-colors",
              applied
                ? "border-emerald-500 dark:border-emerald-500 bg-emerald-100/60 dark:bg-emerald-900/30"
                : "border-border hover:bg-muted/50",
              (!isEditable || saving) && "opacity-60 cursor-not-allowed"
            )}
            data-testid="option-discount-take"
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              <span
                className={cn(
                  "size-3.5 rounded-full border flex items-center justify-center shrink-0",
                  applied ? "border-emerald-600 bg-emerald-600" : "border-muted-foreground"
                )}
              >
                {applied ? <Check className="size-2.5 text-white" /> : null}
              </span>
              Take {pct}% discount
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 pl-5">
              Pay {fmtMoney(effectiveTotal)} — due {fmtDate(invoice.discount_due_date)}
            </div>
          </button>
          <button
            type="button"
            disabled={!isEditable || saving}
            onClick={() => { if (applied) onToggle(false); }}
            className={cn(
              "text-left rounded-md border px-3 py-2 transition-colors",
              !applied
                ? "border-foreground/60 bg-muted/40"
                : "border-border hover:bg-muted/50",
              (!isEditable || saving) && "opacity-60 cursor-not-allowed"
            )}
            data-testid="option-discount-skip"
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              <span
                className={cn(
                  "size-3.5 rounded-full border flex items-center justify-center shrink-0",
                  !applied ? "border-foreground bg-foreground" : "border-muted-foreground"
                )}
              >
                {!applied ? <Check className="size-2.5 text-background" /> : null}
              </span>
              Pay full amount
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 pl-5">
              Pay {fmtMoney(Number(total) || 0)} — due {fmtDate(invoice.due_date)}
            </div>
          </button>
        </div>
      ) : (
        <div className="mt-3 text-xs rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-950/20 px-3 py-2">
          <div className="flex items-center gap-2 font-medium">
            <Check className="size-3.5 text-emerald-700 dark:text-emerald-400" />
            Discount automatically applied: −{fmtMoney(discountAmount)}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1 pl-6">
            {/* PR #R4h — for net_with_discount the discount IS automatic and
                the actual due date is the (single) discount window. Was
                showing invoice.due_date which on most "Net 90 10%" rows
                matches discount_due_date anyway, but if the LLM populated
                only discount_due_date the prior line displayed an empty
                "due" tail. discount_due_date is the canonical field. */}
            Bill will post as {fmtMoney(effectiveTotal)} due {fmtDate(invoice.discount_due_date || invoice.due_date)}.
          </div>
        </div>
      )}
      {saving && (
        <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
          <RefreshCw className="size-3 animate-spin" /> Saving…
        </div>
      )}
    </Card>
  );
}

function NotesCard({ invoiceId }: { invoiceId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const notesQ = useQuery<any[]>({ queryKey: [`/api/invoices/${invoiceId}/notes`] });
  const addNote = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/notes`, { text: text.trim() });
      return res.json();
    },
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}/notes`] });
    },
    onError: (e: any) => toast({ title: "Add note failed", description: e.message, variant: "destructive" }),
  });
  const list = notesQ.data || [];
  return (
    <Card className="border-card-border p-4">
      <div className="text-sm font-medium mb-2">Notes</div>
      <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1" data-testid="list-notes">
        {list.length === 0 && <div className="text-xs text-muted-foreground">No notes yet.</div>}
        {list.map((n: any) => (
          <div key={n.id} className="text-xs border-l-2 border-primary/30 pl-3 py-1" data-testid={`note-${n.id}`}>
            <div className="whitespace-pre-wrap">{n.text}</div>
            <div className="text-muted-foreground mt-0.5">{n.user_email || "system"} · {fmtDate(n.created_at)}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a note (e.g. 'Vendor confirmed price by phone')…"
          className="min-h-[60px] text-xs"
          data-testid="input-note-text"
        />
        <Button
          size="sm"
          disabled={!text.trim() || addNote.isPending}
          onClick={() => addNote.mutate()}
          data-testid="button-add-note"
        >
          {addNote.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Round 7 follow-up: confirmation dialog that pops when an invoice is found to
 * be a duplicate in QBO (after reparse / rematch / auto-recheck). Per Jake's
 * choice, the move to Completed isn't silent — the user signs off here. Calls
 * the existing /mark-posted endpoint with the matched QBO bill id, which
 * mirrors the auto-skip ingestion path exactly.
 */
function DuplicateAutoCompleteDialog({
  invoiceId,
  invoice,
  dup,
  onClose,
  onCompleted,
}: {
  invoiceId: string;
  invoice: any;
  dup: { bill_id: string | null; payment_id: string | null; note: string | null; paid_label: string; total: number; balance: number };
  onClose: () => void;
  onCompleted: () => void;
}) {
  const { toast } = useToast();
  const mut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/invoices/${invoiceId}/mark-posted`, {
        qbo_bill_id: dup.bill_id || null,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Moved to Completed",
        description: dup.bill_id ? `Linked to QBO Bill #${dup.bill_id}.` : "Marked as already posted.",
      });
      onCompleted();
    },
    onError: (e: any) => toast({ title: "Auto-complete failed", description: e.message, variant: "destructive" }),
  });
  return (
    <Dialog open={true} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>This invoice is already in QuickBooks</DialogTitle>
          <DialogDescription>
            We re-checked QBO and found this bill is already posted. You can move it to Completed now, or keep it in Pending review to handle manually.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-xs">
          <div className="rounded-md border border-card-border p-3 space-y-1 bg-muted/30">
            <div><span className="text-muted-foreground">Vendor: </span>{invoice.vendor_qbo_name || invoice.vendor_raw_name || "—"}</div>
            <div><span className="text-muted-foreground">Invoice #: </span>{invoice.invoice_number || "—"}</div>
            {dup.bill_id && (
              <div><span className="text-muted-foreground">QBO Bill: </span>#{dup.bill_id}{dup.paid_label ? ` — ${dup.paid_label.replace(/^—\s*/, "")}` : ""}</div>
            )}
            {dup.payment_id && (
              <div><span className="text-muted-foreground">QBO Payment: </span>#{dup.payment_id}</div>
            )}
            {dup.note && (
              <div className="text-[11px] text-muted-foreground pt-1 border-t border-card-border mt-1">{dup.note}</div>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Moving to Completed is reversible — use “Revert to pending” in the drawer if you change your mind.
          </p>
        </div>
        <div className="flex justify-end gap-2 mt-2">
          <Button variant="outline" onClick={onClose} disabled={mut.isPending} data-testid="button-keep-in-pending">
            Keep in Pending
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending} data-testid="button-confirm-auto-complete">
            {mut.isPending ? "Completing…" : "Move to Completed"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
