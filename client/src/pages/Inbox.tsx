import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Search, Filter, RefreshCw, Wand2, ChevronUp, ChevronDown, Upload, Loader2, SlidersHorizontal } from "lucide-react";
import { getAuthToken } from "@/lib/queryClient";
import { StatusBadge, ConfidenceBadge, VendorMatchBadge, DuplicateBadge } from "@/components/Badges";
import { fmtMoney, fmtDate, STORE_SHORT } from "@/lib/format";
import { InvoiceDrawer } from "@/components/InvoiceDrawer";
import { useBulkSelection, BulkSelectHeader, BulkSelectCell, BulkActionBar } from "@/components/BulkActionBar";
import { TableFooterTotal } from "@/components/TableFooterTotal";
import { DueDateCell } from "@/components/DueDateCell";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-media-query";

type Invoice = any;
type SortKey = "date" | "vendor" | "invoice_number" | "total" | "due_date" | "status";
type SortDir = "asc" | "desc";

export default function Inbox() {
  // Inbox is now strictly the "pending review" bucket — no status switcher.
  const [vendorFilter, setVendorFilter] = useState<string>("all");
  const [storeFilter, setStoreFilter] = useState<string>("all");
  const [confidenceFilter, setConfidenceFilter] = useState<string>("all");
  // Round 7: filter between invoices (charges) and vendor credits
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const bulk = useBulkSelection();
  const isMobile = useIsMobile();
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const { hasPermission } = useAuth();
  const canApproveAp = hasPermission("ap.approve");

  const digestQuery = useQuery<any>({ queryKey: ["/api/digest"] });
  const { toast } = useToast();
  const qc = useQueryClient();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadMutation = useMutation({
    mutationFn: async (files: FileList | File[]) => {
      // Round 7 follow-up: aggressive client-side diagnostics. Logs are visible
      // in the browser DevTools Console (F12) so we can see exactly what is
      // being sent before the request leaves the browser.
      const arr: File[] = Array.isArray(files) ? files : Array.from(files);
      console.log(`[upload-client] FileList size=${files.length}`, arr.map(f => ({
        name: f.name,
        type: f.type,
        size: f.size,
        lastModified: f.lastModified,
      })));
      // Round 7 follow-up: catch 0-byte files BEFORE we waste a network round
      // trip. On Android Chrome with cloud-only Drive files, the picker returns
      // a File reference but the actual bytes never get attached, so size=0 and
      // the multipart body ends up empty (Content-Length ~44, just the boundary
      // delimiters). Surface a clear message with a recovery suggestion.
      const empty = arr.filter(f => f.size === 0);
      if (empty.length === arr.length) {
        throw new Error(
          `All selected file(s) are 0 bytes — ${empty.map(f => f.name).join(", ")}. ` +
          `On mobile, this usually means the file is cloud-only in Google Drive. ` +
          `Tap the PDF in Drive first to download it, then try uploading from "Files" / "Downloads" instead. ` +
          `Or upload from a desktop browser.`
        );
      }
      if (empty.length > 0) {
        console.warn(`[upload-client] dropping ${empty.length} zero-byte file(s)`, empty.map(f => f.name));
      }
      const usable = arr.filter(f => f.size > 0);
      const fd = new FormData();
      usable.forEach((f) => fd.append("files", f));
      // Also dump every entry that ended up in the FormData.
      const fdEntries: any[] = [];
      // @ts-ignore - FormData.entries() exists in all modern browsers
      for (const [k, v] of fd.entries()) {
        if (v instanceof File) fdEntries.push({ key: k, kind: "file", name: v.name, type: v.type, size: v.size });
        else fdEntries.push({ key: k, kind: "value", value: String(v).slice(0, 200) });
      }
      console.log(`[upload-client] FormData entries:`, fdEntries);
      const token = getAuthToken();
      console.log(`[upload-client] auth token present=${!!token} length=${token?.length || 0}`);
      const res = await fetch("/api/invoices/upload", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      console.log(`[upload-client] response status=${res.status} ok=${res.ok}`);
      if (!res.ok) {
        let msg = `Upload failed: ${res.status}`;
        try {
          const j = await res.json();
          if (j?.message) msg = j.message;
        } catch {}
        throw new Error(msg);
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      const ingested = (data.results || []).filter((r: any) => r.status === "ingested").length;
      const dup = (data.results || []).filter((r: any) => r.status === "duplicate_internal" || r.status === "duplicate_qbo").length;
      const skip = (data.results || []).filter((r: any) => r.status === "skipped_non_invoice").length;
      toast({
        title: "Upload complete",
        description: skip > 0
          ? `${ingested} ingested · ${dup} duplicate · ${skip} skipped (non-invoice) — review in Skipped`
          : `${ingested} ingested · ${dup} duplicate · ${skip} skipped (non-invoice)`,
      });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
    },
    onError: (e: any) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const rematchMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/invoices/rematch-all");
      return res.json();
    },
    onSuccess: (data: any) => {
      const v = data.vendor_matched ?? 0;
      const s = data.store_assigned ?? 0;
      toast({
        title: "Re-match complete",
        description: `Matched ${v} vendor${v === 1 ? "" : "s"} and assigned ${s} store${s === 1 ? "" : "s"} across ${data.total_pending} pending invoices.`,
      });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
    },
    onError: (e: any) => toast({ title: "Re-match failed", description: e.message, variant: "destructive" }),
  });

  const params = new URLSearchParams();
  params.set("status", "pending_review");
  if (storeFilter !== "all") params.set("ship_to_store", storeFilter);
  if (confidenceFilter !== "all") params.set("confidence", confidenceFilter);
  if (docTypeFilter !== "all") params.set("doc_type", docTypeFilter);
  const qs = params.toString();

  // Round 7: replace the Refresh button with a real "Pull new invoices now".
  // Hits Gmail poll + Acumatica run in parallel and reports a combined toast.
  const pullNowMutation = useMutation({
    mutationFn: async () => {
      const [gmailRes, acumaticaRes] = await Promise.allSettled([
        apiRequest("POST", "/api/gmail/poll-now").then((r) => r.json()),
        apiRequest("POST", "/api/acumatica/run-now").then((r) => r.json()),
      ]);
      return { gmail: gmailRes, acumatica: acumaticaRes };
    },
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.gmail.status === "fulfilled") {
        const g = r.gmail.value || {};
        const ingested = g.ingested ?? g.processed ?? 0;
        parts.push(`Gmail: ${ingested} new`);
      } else {
        parts.push(`Gmail: failed`);
      }
      if (r.acumatica.status === "fulfilled") {
        const a = r.acumatica.value || {};
        const ingested = a.ingested ?? a.processed ?? 0;
        parts.push(`Acumatica: ${ingested} new`);
      } else {
        parts.push(`Acumatica: failed`);
      }
      toast({ title: "Pull complete", description: parts.join(" · ") });
      qc.invalidateQueries({ queryKey: ["/api/invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/all-invoices"] });
      qc.invalidateQueries({ queryKey: ["/api/digest"] });
    },
    onError: (e: any) => toast({ title: "Pull failed", description: e.message, variant: "destructive" }),
  });

  const invoicesQuery = useQuery<Invoice[]>({
    queryKey: ["/api/invoices", qs ? `?${qs}` : ""],
  });

  const filtered = useMemo(() => {
    const list = invoicesQuery.data || [];
    let out = list;
    if (vendorFilter !== "all") out = out.filter((i) => i.vendor_qbo_id === vendorFilter);
    // Note: doc_type already filtered server-side; this is a safety net for stale data.
    if (docTypeFilter === "invoices") out = out.filter((i) => !i.is_credit);
    else if (docTypeFilter === "credits") out = out.filter((i) => !!i.is_credit);
    if (search.trim()) {
      const s = search.toLowerCase();
      out = out.filter((i) =>
        (i.vendor_qbo_name || "").toLowerCase().includes(s) ||
        (i.invoice_number || "").toLowerCase().includes(s) ||
        (i.vendor_raw_name || "").toLowerCase().includes(s)
      );
    }
    // sort
    const dir = sortDir === "asc" ? 1 : -1;
    const sorted = [...out].sort((a, b) => {
      let av: any, bv: any;
      switch (sortKey) {
        case "date": av = a.invoice_date || a.created_at || ""; bv = b.invoice_date || b.created_at || ""; break;
        case "vendor": av = (a.vendor_qbo_name || a.vendor_raw_name || "").toLowerCase(); bv = (b.vendor_qbo_name || b.vendor_raw_name || "").toLowerCase(); break;
        case "invoice_number": av = (a.invoice_number || "").toLowerCase(); bv = (b.invoice_number || "").toLowerCase(); break;
        case "total": av = a.total || 0; bv = b.total || 0; break;
        case "due_date": av = a.due_date || "9999-99-99"; bv = b.due_date || "9999-99-99"; break;
        case "status":
          // status sort uses confidence + duplicate as a composite for usefulness
          av = `${a.parse_confidence || ""}|${a.duplicate_check_status || ""}|${a.status || ""}`;
          bv = `${b.parse_confidence || ""}|${b.duplicate_check_status || ""}|${b.status || ""}`;
          break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return sorted;
  }, [invoicesQuery.data, vendorFilter, docTypeFilter, search, sortKey, sortDir]);

  const vendors = useMemo(() => {
    const list = invoicesQuery.data || [];
    const map = new Map<string, string>();
    list.forEach((i) => i.vendor_qbo_id && map.set(i.vendor_qbo_id, i.vendor_qbo_name));
    return Array.from(map.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [invoicesQuery.data]);

  const digest = digestQuery.data;

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "date" || key === "total" ? "desc" : "asc");
    }
  }

  return (
    <div className="px-8 pt-6 pb-12 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            // Accept PDFs OR common image formats so users can upload an iPhone
            // photo of a paper invoice without scanning to PDF first. Server
            // converts images to single-page PDFs on intake. We list specific
            // MIME types AND extensions because iPhone Files / Photos pickers
            // sometimes report "" or "application/octet-stream" for HEIC.
            accept="application/pdf,image/jpeg,image/png,image/heic,image/heif,.pdf,.jpg,.jpeg,.png,.heic,.heif"
            multiple
            className="hidden"
            onChange={(e) => {
              const input = e.target;
              const list = input.files;
              console.log(`[upload-client] picker onChange: FileList.length=${list?.length || 0}`);
              // CRITICAL: snapshot the File references into a real array RIGHT
              // NOW — before resetting input.value or yielding back to React.
              // Resetting e.target.value invalidates the live FileList in some
              // Chrome builds, so by the time the async mutation reads files,
              // the FileList is empty. Copying to File[] gives us stable refs.
              const snapshot: File[] = list && list.length > 0 ? Array.from(list) : [];
              console.log(`[upload-client] snapshotted ${snapshot.length} file(s):`, snapshot.map(f => ({ name: f.name, size: f.size, type: f.type })));
              // Reset AFTER snapshotting so the same file can be re-picked.
              input.value = "";
              if (snapshot.length === 0) {
                toast({
                  title: "No file selected",
                  description: "The file picker returned 0 files. Try again, or drag-and-drop the PDF onto the page.",
                  variant: "destructive",
                });
                return;
              }
              uploadMutation.mutate(snapshot);
            }}
            data-testid="input-upload-invoice"
          />
          {canApproveAp && <button
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
            data-testid="button-upload-invoice"
          >
            {uploadMutation.isPending ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
            {uploadMutation.isPending ? " Uploading…" : " Manual invoice upload"}
          </button>}
          <button
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
            onClick={() => rematchMutation.mutate()}
            disabled={rematchMutation.isPending}
            data-testid="button-rematch-all"
          >
            <Wand2 className="size-3" /> {rematchMutation.isPending ? "Re-matching…" : "Re-match vendors & stores"}
          </button>
          <button
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 disabled:opacity-50"
            onClick={() => pullNowMutation.mutate()}
            disabled={pullNowMutation.isPending}
            data-testid="button-pull-now"
            title="Run a fresh Gmail + Acumatica pull right now"
          >
            {pullNowMutation.isPending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {pullNowMutation.isPending ? " Pulling…" : " Pull new invoices now"}
          </button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-6">Review parsed invoices, match vendors, and approve for posting to QuickBooks.</p>

      {/* Home dashboard metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <KpiCard label="Awaiting action" value={digest?.inbox_count} testId="kpi-inbox-count" tone="amber" />
        <KpiCard
          label="Oldest unfiled"
          value={digest?.oldest_pending_age_hours == null ? "—" : digest.oldest_pending_age_hours < 24 ? `${digest.oldest_pending_age_hours}h` : `${Math.floor(digest.oldest_pending_age_hours / 24)}d`}
          testId="kpi-oldest-age"
          tone={(digest?.oldest_pending_age_hours ?? 0) > 48 ? "red" : (digest?.oldest_pending_age_hours ?? 0) > 24 ? "amber" : undefined}
        />
        <KpiCard label="In Receiving" value={digest?.receiving_count} testId="kpi-receiving" />
        <KpiCard label="Problem invoices" value={digest?.problem_count} testId="kpi-problem" tone={(digest?.problem_count ?? 0) > 0 ? "red" : undefined} />
        <KpiCard label="Posted this week" value={digest ? fmtMoney(digest.posted_this_week_amount) : undefined} testId="kpi-posted-week" tone="emerald" />
        <KpiCard label="Pending approval $" value={digest ? fmtMoney(digest.pending_approval_amount) : undefined} testId="kpi-pending-amount" />
      </div>

      {/* Filters */}
      <Card className="border-card-border mb-4">
        <div className="p-3 flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Search vendor or invoice #"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
              data-testid="input-search-invoices"
            />
          </div>
          {/* Desktop filters — hidden on mobile */}
          <div className="hidden md:flex gap-2 items-center flex-wrap">
            <Select value={vendorFilter} onValueChange={setVendorFilter}>
              <SelectTrigger className="h-9 w-[170px]" data-testid="select-vendor-filter"><SelectValue placeholder="Vendor" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All vendors</SelectItem>
                {vendors.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={storeFilter} onValueChange={setStoreFilter}>
              <SelectTrigger className="h-9 w-[150px]" data-testid="select-store-filter"><SelectValue placeholder="Ship to" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stores</SelectItem>
                <SelectItem value="greenvale">Greenvale</SelectItem>
                <SelectItem value="hempstead">Hempstead</SelectItem>
                <SelectItem value="huntington">Huntington</SelectItem>
              </SelectContent>
            </Select>
            <Select value={confidenceFilter} onValueChange={setConfidenceFilter}>
              <SelectTrigger className="h-9 w-[150px]" data-testid="select-confidence-filter"><SelectValue placeholder="Confidence" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any confidence</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
            <Select value={docTypeFilter} onValueChange={setDocTypeFilter}>
              <SelectTrigger className="h-9 w-[150px]" data-testid="select-doc-type-filter"><SelectValue placeholder="Document type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All documents</SelectItem>
                <SelectItem value="invoices">Invoices only</SelectItem>
                <SelectItem value="credits">Credits only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {/* Mobile: single Filters button that opens a sheet */}
          <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="md:hidden h-9 gap-1.5" data-testid="button-mobile-filters">
                <SlidersHorizontal className="size-4" /> Filters
                {[vendorFilter, storeFilter, confidenceFilter, docTypeFilter].some(f => f !== "all") && (
                  <span className="ml-0.5 size-2 rounded-full bg-primary inline-block" />
                )}
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-2xl">
              <SheetHeader className="mb-4">
                <SheetTitle>Filters</SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-3 pb-4">
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5 font-medium">Vendor</div>
                  <Select value={vendorFilter} onValueChange={setVendorFilter}>
                    <SelectTrigger className="w-full" data-testid="select-vendor-filter-mobile"><SelectValue placeholder="All vendors" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All vendors</SelectItem>
                      {vendors.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5 font-medium">Ship to</div>
                  <Select value={storeFilter} onValueChange={setStoreFilter}>
                    <SelectTrigger className="w-full" data-testid="select-store-filter-mobile"><SelectValue placeholder="All stores" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All stores</SelectItem>
                      <SelectItem value="greenvale">Greenvale</SelectItem>
                      <SelectItem value="hempstead">Hempstead</SelectItem>
                      <SelectItem value="huntington">Huntington</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5 font-medium">Confidence</div>
                  <Select value={confidenceFilter} onValueChange={setConfidenceFilter}>
                    <SelectTrigger className="w-full" data-testid="select-confidence-filter-mobile"><SelectValue placeholder="Any confidence" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any confidence</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5 font-medium">Document type</div>
                  <Select value={docTypeFilter} onValueChange={setDocTypeFilter}>
                    <SelectTrigger className="w-full" data-testid="select-doc-type-filter-mobile"><SelectValue placeholder="All documents" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All documents</SelectItem>
                      <SelectItem value="invoices">Invoices only</SelectItem>
                      <SelectItem value="credits">Credits only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button variant="outline" onClick={() => { setVendorFilter("all"); setStoreFilter("all"); setConfidenceFilter("all"); setDocTypeFilter("all"); setFilterSheetOpen(false); }}>
                  Clear all filters
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </Card>

      {/* Table */}
      <Card className="border-card-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                {/* Bulk select — hidden on mobile */}
                {!isMobile && canApproveAp && <BulkSelectHeader visibleIds={filtered.map((i: any) => i.id)} selected={bulk.selected} toggleAll={bulk.toggleAll} />}
                {/* Date — hidden on mobile (shown inline with vendor on mobile) */}
                <SortableTh active={sortKey === "date"} dir={sortDir} onClick={() => toggleSort("date")} className="hidden md:table-cell">Date</SortableTh>
                <SortableTh active={sortKey === "vendor"} dir={sortDir} onClick={() => toggleSort("vendor")}>Vendor</SortableTh>
                <SortableTh active={sortKey === "invoice_number"} dir={sortDir} onClick={() => toggleSort("invoice_number")}>Invoice #</SortableTh>
                <SortableTh active={sortKey === "total"} dir={sortDir} onClick={() => toggleSort("total")} className="text-right">Total</SortableTh>
                {/* Secondary columns — hidden on mobile */}
                <Th className="hidden md:table-cell">Ship to</Th>
                <SortableTh active={sortKey === "due_date"} dir={sortDir} onClick={() => toggleSort("due_date")} className="hidden md:table-cell">Due</SortableTh>
                <SortableTh active={sortKey === "status"} dir={sortDir} onClick={() => toggleSort("status")}>Status</SortableTh>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {invoicesQuery.isLoading && Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: isMobile ? 4 : 8 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><Skeleton className="h-4 w-full" /></td>
                  ))}
                </tr>
              ))}
              {!invoicesQuery.isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={isMobile ? 4 : 8} className="px-4 py-16 text-center text-muted-foreground" data-testid="text-empty-inbox">
                    <Filter className="size-6 mx-auto mb-2 opacity-50" />
                    <div className="text-sm font-medium text-foreground mb-0.5">Inbox zero</div>
                    <div className="text-xs">No invoices match your filters.</div>
                  </td>
                </tr>
              )}
              {filtered.map((inv) => (
                <tr
                  key={inv.id}
                  onClick={() => setOpenInvoice(inv.id)}
                  className="cursor-pointer hover-elevate transition-colors"
                  data-testid={`row-invoice-${inv.id}`}
                >
                  {!isMobile && canApproveAp && <BulkSelectCell id={inv.id} isSelected={bulk.isSelected} toggle={bulk.toggle} />}
                  <td className="px-4 py-3 whitespace-nowrap text-muted-foreground hidden md:table-cell">{fmtDate(inv.invoice_date)}</td>
                  <td className="px-4 py-3 max-w-[160px]">
                    <div className="font-medium truncate" data-testid={`text-vendor-name-${inv.id}`}>{inv.vendor_qbo_name || <span className="text-muted-foreground italic">Unknown</span>}</div>
                    <VendorMatchBadge status={inv.vendor_match_status} aliasFrom={inv.vendor_match_status === "aliased" ? inv.vendor_raw_name : null} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{inv.invoice_number || "—"}</td>
                  <td className={cn("px-4 py-3 text-right font-mono tabular-nums", inv.is_credit && "text-red-600 dark:text-red-400")} data-testid={`text-total-${inv.id}`}>
                    {fmtMoney(inv.total)}
                    {!isMobile && inv.freight ? <div className="text-[10px] text-muted-foreground">+ {fmtMoney(inv.freight)} frt</div> : null}
                  </td>
                  <td className="px-4 py-3 text-xs hidden md:table-cell">{STORE_SHORT[inv.ship_to_store] || "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs hidden md:table-cell"><DueDateCell invoice={inv} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {/* On mobile, only show confidence dot + status badge */}
                      {!isMobile && <ConfidenceBadge confidence={inv.parse_confidence} />}
                      {!isMobile && <DuplicateBadge status={inv.duplicate_check_status} />}
                      <StatusBadge status={inv.status} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <TableFooterTotal
              rows={filtered}
              beforeTotalCols={isMobile ? 2 : 4}
              afterTotalCols={isMobile ? 1 : 3}
              isLoading={invoicesQuery.isLoading}
            />
          </table>
        </div>
      </Card>

      <InvoiceDrawer invoiceId={openInvoice} onClose={() => setOpenInvoice(null)} />
      {!isMobile && canApproveAp && <BulkActionBar selected={bulk.selected} clear={bulk.clear} />}
    </div>
  );
}

function Th({ children, className = "" }: { children: any; className?: string }) {
  return <th className={cn("px-4 py-2.5 text-left font-medium", className)}>{children}</th>;
}

function SortableTh({ children, active, dir, onClick, className = "" }: { children: any; active: boolean; dir: SortDir; onClick: () => void; className?: string }) {
  return (
    <th className={cn("px-4 py-2.5 text-left font-medium", className)}>
      <button
        type="button"
        onClick={onClick}
        className={cn("inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground transition-colors", active && "text-foreground")}
        data-testid={`sort-${String(children).toLowerCase().replace(/\s+/g, "-").replace(/#/g, "num")}`}
      >
        <span>{children}</span>
        {active ? (dir === "asc" ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />) : null}
      </button>
    </th>
  );
}

function KpiCard({ label, value, testId, tone }: { label: string; value: any; testId: string; tone?: "amber" | "red" | "emerald" }) {
  const toneCls = tone === "amber" ? "text-amber-600 dark:text-amber-400"
    : tone === "red" ? "text-red-600 dark:text-red-400"
    : tone === "emerald" ? "text-emerald-600 dark:text-emerald-400"
    : "text-foreground";
  return (
    <Card className="border-card-border p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className={cn("text-xl font-semibold mt-1 tabular-nums", toneCls)} data-testid={testId}>
        {value === undefined ? <Skeleton className="h-7 w-16" /> : (value === null ? "—" : value)}
      </div>
    </Card>
  );
}
