import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, FileText } from "lucide-react";
import { StatusBadge, VendorMatchBadge } from "@/components/Badges";
import { fmtMoney, fmtDate, STORE_SHORT } from "@/lib/format";
import { InvoiceDrawer } from "@/components/InvoiceDrawer";
import { useBulkSelection, BulkSelectHeader, BulkSelectCell, BulkActionBar } from "@/components/BulkActionBar";
import { TableFooterTotal } from "@/components/TableFooterTotal";
import { DueDateCell } from "@/components/DueDateCell";
import { useIsMobile } from "@/hooks/use-media-query";

type Invoice = any;

export default function AllInvoices() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [storeFilter, setStoreFilter] = useState<string>("all");
  const [vendorFilter, setVendorFilter] = useState<string>("all");
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const bulk = useBulkSelection();
  const isMobile = useIsMobile();

  const params = new URLSearchParams();
  if (statusFilter !== "all") params.set("status", statusFilter);
  if (storeFilter !== "all") params.set("ship_to_store", storeFilter);
  if (docTypeFilter !== "all") params.set("doc_type", docTypeFilter);
  if (search.trim()) params.set("q", search.trim());
  const qs = params.toString();

  const q = useQuery<Invoice[]>({ queryKey: ["/api/all-invoices", qs ? `?${qs}` : ""] });

  const filtered = useMemo(() => {
    const list = q.data || [];
    return vendorFilter === "all" ? list : list.filter((i) => i.vendor_qbo_id === vendorFilter);
  }, [q.data, vendorFilter]);

  const vendors = useMemo(() => {
    const map = new Map<string, string>();
    (q.data || []).forEach((i) => i.vendor_qbo_id && map.set(i.vendor_qbo_id, i.vendor_qbo_name));
    return Array.from(map.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [q.data]);

  return (
    <div className="px-8 pt-6 pb-12 max-w-[1400px] mx-auto">
      <h1 className="text-xl font-semibold tracking-tight mb-1">All Invoices</h1>
      <p className="text-sm text-muted-foreground mb-6">Search and filter every invoice across all buckets.</p>

      <Card className="border-card-border mb-4">
        <div className="p-3 flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search vendor, raw name, or invoice #"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
              data-testid="input-search-all"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-[170px]" data-testid="select-status-all"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="pending_review">Pending review</SelectItem>
              <SelectItem value="receiving">In Receiving</SelectItem>
              <SelectItem value="quarantined">Quarantined</SelectItem>
              <SelectItem value="approved_local">Approved (local)</SelectItem>
              <SelectItem value="posted_qbo">Posted to QBO</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
          <Select value={storeFilter} onValueChange={setStoreFilter}>
            <SelectTrigger className="h-9 w-[150px]" data-testid="select-store-all"><SelectValue placeholder="Ship to" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stores</SelectItem>
              <SelectItem value="greenvale">Greenvale</SelectItem>
              <SelectItem value="hempstead">Hempstead</SelectItem>
              <SelectItem value="huntington">Huntington</SelectItem>
            </SelectContent>
          </Select>
          <Select value={vendorFilter} onValueChange={setVendorFilter}>
            <SelectTrigger className="h-9 w-[170px]" data-testid="select-vendor-all"><SelectValue placeholder="Vendor" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All vendors</SelectItem>
              {vendors.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={docTypeFilter} onValueChange={setDocTypeFilter}>
            <SelectTrigger className="h-9 w-[150px]" data-testid="select-doctype-all"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="invoices">Invoices only</SelectItem>
              <SelectItem value="credits">Credits only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card className="border-card-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {!isMobile && <BulkSelectHeader visibleIds={filtered.map((i: any) => i.id)} selected={bulk.selected} toggleAll={bulk.toggleAll} />}
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
              {q.isLoading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}><td colSpan={isMobile ? 3 : 8} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>
              ))}
              {!q.isLoading && filtered.length === 0 && (
                <tr><td colSpan={isMobile ? 3 : 8} className="px-4 py-12 text-center text-muted-foreground">
                  <FileText className="size-6 mx-auto mb-2 opacity-50" />
                  <div className="text-sm">No invoices match your filters.</div>
                </td></tr>
              )}
              {filtered.map((inv) => (
                <tr key={inv.id} onClick={() => setOpenInvoice(inv.id)} className="cursor-pointer hover-elevate" data-testid={`row-allinv-${inv.id}`}>
                  {!isMobile && <BulkSelectCell id={inv.id} isSelected={bulk.isSelected} toggle={bulk.toggle} />}
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{fmtDate(inv.invoice_date)}</td>
                  <td className="px-4 py-3 max-w-[160px]">
                    <div className="font-medium truncate">{inv.vendor_qbo_name || inv.vendor_raw_name || <span className="text-muted-foreground italic">Unknown</span>}</div>
                    <VendorMatchBadge status={inv.vendor_match_status} aliasFrom={inv.vendor_match_status === "aliased" ? inv.vendor_raw_name : null} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs hidden md:table-cell">{inv.invoice_number || "—"}</td>
                  <td className={`px-4 py-3 text-right font-mono tabular-nums ${inv.is_credit ? "text-red-600 dark:text-red-400" : ""}`}>{fmtMoney(inv.total)}</td>
                  <td className="px-4 py-3 text-xs hidden md:table-cell">{STORE_SHORT[inv.ship_to_store] || "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs hidden md:table-cell"><DueDateCell invoice={inv} /></td>
                  <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
            <TableFooterTotal
              rows={filtered}
              beforeTotalCols={isMobile ? 1 : 4}
              afterTotalCols={isMobile ? 1 : 3}
              isLoading={q.isLoading}
            />
          </table>
        </div>
      </Card>

      <InvoiceDrawer invoiceId={openInvoice} onClose={() => setOpenInvoice(null)} />
      {!isMobile && <BulkActionBar selected={bulk.selected} clear={bulk.clear} actions={["posted", "pending_review", "receiving", "quarantined", "rejected"]} />}
    </div>
  );
}
