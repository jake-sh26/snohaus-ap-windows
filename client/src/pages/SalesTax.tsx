/**
 * Sales Tax — placeholder page (PR #166).
 *
 * Route /finance/sales-tax. The real content (ST-810 reporting, filing
 * checklist, exports) lands in PR #167; this is the registered, nav-linked,
 * permission-gated shell so the route + nav item exist now.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Receipt } from "lucide-react";

export default function SalesTax() {
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales Tax</h1>
        <p className="text-sm text-muted-foreground mt-1">
          ST-810 reporting, filing checklist, and exports. (Content lands in PR #167.)
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="size-4" /> Coming in PR #167
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground"
            data-testid="empty-sales-tax"
          >
            <Receipt className="size-8 opacity-40" />
            <p className="text-sm">
              The Sales Tax workspace is under construction. ST-810 figures, the
              monthly/quarterly filing checklist, and CSV/PDF/XLSX exports arrive in PR #167.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
