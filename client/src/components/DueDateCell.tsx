import { fmtDate, parseLocalDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Renders a due date with color-coded urgency:
 *   - Overdue (past today)         → red
 *   - Due today / next 7 days      → amber
 *   - Further out                  → muted
 *   - Already-paid statuses        → muted (no urgency coloring needed once posted/rejected)
 *
 * Pass the entire invoice so we can suppress urgency on terminal statuses.
 */
export function DueDateCell({ invoice }: { invoice: any }) {
  const due = invoice?.due_date;
  if (!due) return <span className="text-muted-foreground">—</span>;

  const d = parseLocalDate(due);
  if (!d) return <span className="text-muted-foreground">{due}</span>;

  // Days until due — negative = overdue.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueOnly = new Date(d);
  dueOnly.setHours(0, 0, 0, 0);
  const days = Math.round((dueOnly.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  // Suppress urgency colors on terminal statuses.
  const terminal = ["posted_qbo", "approved_local", "rejected"].includes(invoice?.status);
  const overdue = !terminal && days < 0;
  const dueSoon = !terminal && days >= 0 && days <= 7;

  return (
    <div className="flex flex-col leading-tight">
      <span
        className={cn(
          "tabular-nums",
          overdue && "text-red-600 dark:text-red-400 font-medium",
          dueSoon && "text-amber-600 dark:text-amber-400 font-medium",
          !overdue && !dueSoon && "text-muted-foreground"
        )}
      >
        {fmtDate(due)}
      </span>
      {overdue && (
        <span className="text-[10px] text-red-600/80 dark:text-red-400/80">
          {Math.abs(days)}d overdue
        </span>
      )}
      {dueSoon && days === 0 && (
        <span className="text-[10px] text-amber-600/80 dark:text-amber-400/80">due today</span>
      )}
      {dueSoon && days > 0 && (
        <span className="text-[10px] text-amber-600/80 dark:text-amber-400/80">in {days}d</span>
      )}
    </div>
  );
}

// parseDate replaced by parseLocalDate in @/lib/format — fixes YYYY-MM-DD
// being interpreted as UTC midnight and rendering a day early in EDT.
