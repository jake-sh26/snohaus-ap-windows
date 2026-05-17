import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileX, Eye, Undo2, Trash2 } from "lucide-react";
import { fmtMoney, fmtDate } from "@/lib/format";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type SkippedRow = {
  id: number;
  pdf_url: string | null;
  original_filename: string | null;
  source: string | null;
  email_from: string | null;
  email_subject: string | null;
  email_date: string | null;
  llm_document_type: string | null;
  llm_skip_reason: string | null;
  llm_notes: string | null;
  llm_vendor_raw_name: string | null;
  llm_total: number | null;
  llm_invoice_number: string | null;
  restored_invoice_id: string | null;
  restored_at: string | null;
  created_at: string;
};

function docTypeLabel(t: string | null | undefined): string {
  if (!t) return "Unknown";
  const map: Record<string, string> = {
    sales_order: "Sales order",
    order_confirmation: "Order confirmation",
    statement: "Statement",
    shipment_notification: "Shipment notice",
    login_link: "Login link",
    warranty_replacement: "Warranty / $0",
    autopay: "Autopay vendor",
    credit_memo: "Credit memo",
    credit_card_purchase: "Card purchase",
  };
  return map[t] || t.replace(/_/g, " ");
}

export default function Skipped() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery<SkippedRow[]>({ queryKey: ["/api/skipped"] });
  const data = useMemo(() => q.data || [], [q.data]);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function viewPdf(id: number) {
    try {
      const res = await apiRequest("GET", `/api/skipped/${id}/pdf-token`);
      const j = await res.json();
      window.open(j.url, "_blank");
    } catch (e: any) {
      toast({ title: "Could not open PDF", description: e.message, variant: "destructive" });
    }
  }

  const restoreMutation = useMutation({
    mutationFn: async (id: number) => {
      setBusyId(id);
      try {
        const res = await apiRequest("POST", `/api/skipped/${id}/restore`);
        return res.json();
      } finally {
        setBusyId(null);
      }
    },
    onSuccess: (data: any) => {
      toast({
        title: "Restored as invoice",
        description: data.invoice_id ? `Now in pending review (#${data.invoice_id})` : "Pipeline ran successfully.",
      });
      qc.invalidateQueries({ queryKey: ["/api/skipped"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
    },
    onError: (e: any) => toast({ title: "Restore failed", description: (e.message || "").replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      setBusyId(id);
      try {
        const res = await apiRequest("DELETE", `/api/skipped/${id}`);
        return res.json();
      } finally {
        setBusyId(null);
      }
    },
    onSuccess: () => {
      toast({ title: "Deleted" });
      qc.invalidateQueries({ queryKey: ["/api/skipped"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
    },
    onError: (e: any) => toast({ title: "Delete failed", description: (e.message || "").replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  return (
    <div className="px-8 pt-6 pb-12 max-w-[1400px] mx-auto">
      <h1 className="text-xl font-semibold tracking-tight mb-1">Skipped uploads</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Files the LLM classified as non-invoices (sales orders, statements, autopay utilities, $0 warranty replacements, etc).
        Restore any that were misclassified — they'll re-enter the pipeline as a normal invoice.
      </p>

      <Card className="border-card-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Skipped on</th>
              <th className="px-4 py-2.5 text-left font-medium">Type</th>
              <th className="px-4 py-2.5 text-left font-medium">Reason</th>
              <th className="px-4 py-2.5 text-left font-medium">From / file</th>
              <th className="px-4 py-2.5 text-left font-medium">Vendor (parsed)</th>
              <th className="px-4 py-2.5 text-right font-medium">Total (parsed)</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {q.isLoading && Array.from({ length: 4 }).map((_, i) => (
              <tr key={i}><td colSpan={7} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>
            ))}
            {!q.isLoading && data.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                <FileX className="size-6 mx-auto mb-2 opacity-50" />
                <div className="text-sm">No skipped uploads. Files classified as non-invoices will appear here.</div>
              </td></tr>
            )}
            {data.map((row) => (
              <tr key={row.id} className="hover:bg-muted/20" data-testid={`row-skipped-${row.id}`}>
                <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{fmtDate(row.created_at)}</td>
                <td className="px-4 py-3"><Badge variant="outline" className="font-normal">{docTypeLabel(row.llm_document_type)}</Badge></td>
                <td className="px-4 py-3 text-xs text-muted-foreground max-w-xs">
                  <div className="truncate" title={row.llm_skip_reason || row.llm_notes || ""}>
                    {row.llm_skip_reason || row.llm_notes || "—"}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs">
                  {row.email_from ? (
                    <>
                      <div className="truncate max-w-[220px]" title={row.email_from}>{row.email_from}</div>
                      {row.email_subject && <div className="truncate max-w-[220px] text-muted-foreground" title={row.email_subject}>{row.email_subject}</div>}
                    </>
                  ) : (
                    <div className="text-muted-foreground truncate max-w-[220px]" title={row.original_filename || ""}>{row.original_filename || row.source || "—"}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">{row.llm_vendor_raw_name || <span className="text-muted-foreground">—</span>}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-xs">{row.llm_total != null ? fmtMoney(row.llm_total) : <span className="text-muted-foreground">—</span>}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => viewPdf(row.id)}
                      disabled={!row.pdf_url}
                      data-testid={`button-skipped-view-${row.id}`}
                      title="View PDF"
                    >
                      <Eye className="size-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => restoreMutation.mutate(row.id)}
                      disabled={busyId === row.id || !row.pdf_url}
                      data-testid={`button-skipped-restore-${row.id}`}
                      title="Restore as invoice (re-runs pipeline, lands in Pending review)"
                    >
                      <Undo2 className="size-3.5 mr-1" /> Restore
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!confirm("Permanently delete this skipped upload and its PDF?")) return;
                        deleteMutation.mutate(row.id);
                      }}
                      disabled={busyId === row.id}
                      data-testid={`button-skipped-delete-${row.id}`}
                      title="Permanently delete"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>
    </div>
  );
}
