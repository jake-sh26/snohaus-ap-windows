import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PackageOpen } from "lucide-react";
import { fmtMoney, fmtDate, STORE_SHORT } from "@/lib/format";
import { StatusBadge } from "@/components/Badges";
import { InvoiceDrawer } from "@/components/InvoiceDrawer";
import { useBulkSelection, BulkSelectHeader, BulkSelectCell, BulkActionBar } from "@/components/BulkActionBar";
import { TableFooterTotal } from "@/components/TableFooterTotal";
import { DueDateCell } from "@/components/DueDateCell";
import { useIsMobile } from "@/hooks/use-media-query";

export default function Receiving() {
  const [open, setOpen] = useState<string | null>(null);
  const bulk = useBulkSelection();
  const isMobile = useIsMobile();
  const q = useQuery<any[]>({ queryKey: ["/api/invoices", "?status=receiving"] });
  const data = q.data || [];

  return (
    <div className="px-8 pt-6 pb-12 max-w-[1400px] mx-auto">
      <h1 className="text-xl font-semibold tracking-tight mb-1">In Receiving</h1>
      <p className="text-sm text-muted-foreground mb-6">Invoices on hold pending physical receipt or vendor confirmation.</p>

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
                <th className="px-4 py-2.5 text-left font-medium hidden md:table-cell">Due</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {q.isLoading && Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}><td colSpan={isMobile ? 3 : 8} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>
              ))}
              {!q.isLoading && data.length === 0 && (
                <tr><td colSpan={isMobile ? 3 : 8} className="px-4 py-12 text-center text-muted-foreground">
                  <PackageOpen className="size-6 mx-auto mb-2 opacity-50" />
                  <div className="text-sm">Nothing on hold. Use "In Receiving" inside an invoice to move it here.</div>
                </td></tr>
              )}
              {data.map((inv) => (
                <tr key={inv.id} onClick={() => setOpen(inv.id)} className="cursor-pointer hover-elevate" data-testid={`row-receiving-${inv.id}`}>
                  {!isMobile && <BulkSelectCell id={inv.id} isSelected={bulk.isSelected} toggle={bulk.toggle} />}
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{fmtDate(inv.invoice_date)}</td>
                  <td className="px-4 py-3 font-medium max-w-[160px] truncate">{inv.vendor_qbo_name || inv.vendor_raw_name || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs hidden md:table-cell">{inv.invoice_number || "—"}</td>
                  <td className={`px-4 py-3 text-right font-mono tabular-nums ${inv.is_credit ? "text-red-600 dark:text-red-400" : ""}`}>{fmtMoney(inv.total)}</td>
                  <td className="px-4 py-3 text-xs hidden md:table-cell">{STORE_SHORT[inv.ship_to_store] || "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs hidden md:table-cell"><DueDateCell invoice={inv} /></td>
                  <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
            <TableFooterTotal
              rows={data}
              beforeTotalCols={isMobile ? 1 : 4}
              afterTotalCols={isMobile ? 1 : 2}
              isLoading={q.isLoading}
            />
          </table>
        </div>
      </Card>

      <InvoiceDrawer invoiceId={open} onClose={() => setOpen(null)} />
      {!isMobile && <BulkActionBar selected={bulk.selected} clear={bulk.clear} actions={["posted", "pending_review", "quarantined", "rejected"]} />}
    </div>
  );
}
