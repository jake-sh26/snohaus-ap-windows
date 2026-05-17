import { useMemo } from "react";
import { fmtMoney } from "@/lib/format";

/**
 * Footer row that sums the total field across the currently visible rows.
 * Renders inside a <table> as a <tfoot>. The colspan props let each invoice
 * list page tell us which column the dollar figure should land under.
 *
 * Net-of-credits handling: when both invoices and credits are present, we
 * subtract credit totals from invoice totals and surface a "net of credits"
 * hint so Jake doesn't think the totals are wrong.
 */
export function TableFooterTotal({
  rows,
  beforeTotalCols,
  afterTotalCols,
  label = "invoices",
  isLoading,
}: {
  rows: any[];
  beforeTotalCols: number; // # of columns BEFORE the total column (incl. checkbox)
  afterTotalCols: number;  // # of columns AFTER the total column
  label?: string;
  isLoading?: boolean;
}) {
  const totals = useMemo(() => {
    let count = 0, invCount = 0, credCount = 0, invSum = 0, credSum = 0;
    for (const i of rows || []) {
      count++;
      const t = Number(i.total) || 0;
      if (i.is_credit) { credCount++; credSum += t; }
      else { invCount++; invSum += t; }
    }
    return { count, invCount, credCount, invSum, credSum, net: invSum - credSum };
  }, [rows]);

  if (isLoading || totals.count === 0) return null;

  const mixed = totals.credCount > 0 && totals.invCount > 0;
  const singular = totals.count === 1;

  return (
    <tfoot className="bg-muted/40 border-t border-border text-xs">
      <tr>
        {beforeTotalCols > 1 && <td className="px-4 py-2.5" />}
        <td
          className="px-4 py-2.5 font-medium text-muted-foreground uppercase tracking-wide"
          colSpan={Math.max(1, beforeTotalCols - 1)}
        >
          {totals.count} {singular ? label.replace(/s$/, "") : label}
          {mixed && (
            <span className="ml-1 normal-case tracking-normal text-muted-foreground/80">
              ({totals.invCount} inv · {totals.credCount} credit{totals.credCount === 1 ? "" : "s"})
            </span>
          )}
        </td>
        <td
          className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold"
          data-testid="text-filtered-total"
        >
          {fmtMoney(totals.net)}
          {mixed && <div className="text-[10px] font-normal text-muted-foreground">net of credits</div>}
        </td>
        {afterTotalCols > 0 && <td className="px-4 py-2.5" colSpan={afterTotalCols} />}
      </tr>
    </tfoot>
  );
}
