import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { History } from "lucide-react";
import { fmtMoney, fmtDate, STORE_SHORT } from "@/lib/format";
import { StatusBadge } from "@/components/Badges";
import { InvoiceDrawer } from "@/components/InvoiceDrawer";
import { useBulkSelection, BulkSelectHeader, BulkSelectCell, BulkActionBar } from "@/components/BulkActionBar";
import { TableFooterTotal } from "@/components/TableFooterTotal";
import { DueDateCell } from "@/components/DueDateCell";
import { useIsMobile } from "@/hooks/use-media-query";

export default function Posted() {
  const [open, setOpen] = useState<string | null>(null);
  const bulk = useBulkSelection();
  const isMobile = useIsMobile();
  // Show approved_local + posted_qbo + rejected
  const allQ = useQuery<any[]>({ queryKey: ["/api/invoices", "?status=all"] });
  const data = (allQ.data || []).filter((i) => ["approved_local", "posted_qbo", "rejected"].includes(i.status));

  return (
    <div className="px-8 pt-6 pb-12 max-w-[1400px] mx-auto">
      <h1 className="text-xl font-semibold tracking-tight mb-1">History</h1>
      <p className="text-sm text-muted-foreground mb-6">Approved, posted, and rejected invoices.</p>

      <Card className="border-card-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {!isMobile && <BulkSelectHeader visibleIds={data.map((i: any) => i.id)} selected={bulk.selected} toggleAll={bulk.toggleAll} />}
                <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Date</th>
                <th className="px-4 py-2.5 text-left font-medium">Vendor</th>
                <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Invoice #</th>
                <th className="px-4 py-2.5 text-right font-medium">Total</th>
                <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Ship to</th>
                <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Type</th>
                <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">QBO Doc #</th>
                <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Due</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {allQ.isLoading && Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}><td colSpan={isMobile ? 3 : 10} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>
              ))}
              {!allQ.isLoading && data.length === 0 && (
                <tr><td colSpan={isMobile ? 3 : 10} className="px-4 py-12 text-center text-muted-foreground">
                  <History className="size-6 mx-auto mb-2 opacity-50" />
                  <div className="text-sm">No posted invoices yet.</div>
                </td></tr>
              )}
              {data.map((inv) => (
                <tr key={inv.id} onClick={() => setOpen(inv.id)} className="cursor-pointer hover-elevate" data-testid={`row-posted-${inv.id}`}>
                  {!isMobile && <BulkSelectCell id={inv.id} isSelected={bulk.isSelected} toggle={bulk.toggle} />}
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{fmtDate(inv.invoice_date)}</td>
                  <td className="px-4 py-3 font-medium max-w-[160px] truncate">{inv.vendor_qbo_name || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs hidden md:table-cell">{inv.invoice_number || "—"}</td>
                  <td className={`px-4 py-3 text-right font-mono tabular-nums ${inv.is_credit ? "text-red-600 dark:text-red-400" : ""}`}>{fmtMoney(inv.total)}</td>
                  <td className="px-4 py-3 text-xs hidden md:table-cell">{STORE_SHORT[inv.ship_to_store] || "—"}</td>
                  <td className="px-4 py-3 text-xs hidden md:table-cell">
                    {inv.is_credit
                      ? <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-red-500/15 text-red-700 dark:text-red-400 border border-red-500/30 font-medium">Vendor credit</span>
                      : <span className="text-muted-foreground">Bill</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs hidden md:table-cell">
                    {inv.qbo_bill_id
                      ? <span>{inv.is_credit ? "VC " : ""}#{inv.qbo_bill_id}</span>
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs hidden md:table-cell"><DueDateCell invoice={inv} /></td>
                  <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
            <TableFooterTotal
              rows={data}
              beforeTotalCols={isMobile ? 1 : 4}
              afterTotalCols={isMobile ? 1 : 4}
              isLoading={allQ.isLoading}
            />
          </table>
        </div>
      </Card>

      <InvoiceDrawer invoiceId={open} onClose={() => setOpen(null)} />
      {!isMobile && <BulkActionBar selected={bulk.selected} clear={bulk.clear} actions={["pending_review", "quarantined"]} />}
    </div>
  );
}
