import { CheckCircle2, AlertCircle, AlertTriangle, Tag, Eye, Send, X, Clock, Package, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

type StatusKey = "pending_review" | "approved_local" | "posted_qbo" | "rejected" | "needs_vendor" | "receiving" | "quarantined";

const STATUS_STYLES: Record<StatusKey, { label: string; cls: string; icon: any }> = {
  pending_review: { label: "Pending review", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30", icon: Clock },
  approved_local: { label: "Approved — not posted", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30", icon: AlertCircle },
  posted_qbo: { label: "Posted to QBO", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", icon: Send },
  rejected: { label: "Rejected", cls: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30", icon: X },
  needs_vendor: { label: "Needs vendor", cls: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30", icon: AlertCircle },
  receiving: { label: "In Receiving", cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30", icon: Package },
  quarantined: { label: "Quarantined", cls: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30", icon: ShieldAlert },
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const key = (status || "pending_review") as StatusKey;
  const cfg = STATUS_STYLES[key] || STATUS_STYLES.pending_review;
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border", cfg.cls)} data-testid={`badge-status-${key}`}>
      <Icon className="size-3" />
      {cfg.label}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string | null | undefined }) {
  if (!confidence) return null;
  const cfg = {
    high: { label: "High", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
    medium: { label: "Medium", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
    low: { label: "Low", cls: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20" },
  }[confidence] || { label: confidence, cls: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border uppercase tracking-wide", cfg.cls)} data-testid={`badge-confidence-${confidence}`}>
      {cfg.label}
    </span>
  );
}

export function VendorMatchBadge({ status, aliasFrom }: { status: string | null | undefined; aliasFrom?: string | null }) {
  if (status === "matched") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" data-testid="badge-vendor-matched">
        <CheckCircle2 className="size-3" /> Matched
      </span>
    );
  }
  if (status === "aliased") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" data-testid="badge-vendor-aliased" title={aliasFrom ? `via "${aliasFrom}" alias` : undefined}>
        <Tag className="size-3" /> Aliased{aliasFrom ? ` · ${aliasFrom}` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20" data-testid="badge-vendor-unmatched">
      <AlertTriangle className="size-3" /> Needs vendor
    </span>
  );
}

export function DuplicateBadge({ status }: { status: string | null | undefined }) {
  if (status === "clean") return (
    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400" data-testid="badge-duplicate-clean">
      <CheckCircle2 className="size-3.5" /> Clean
    </span>
  );
  if (status === "duplicate_found") return (
    <span className="inline-flex items-center gap-1 text-[11px] text-red-700 dark:text-red-400" data-testid="badge-duplicate-found">
      <AlertCircle className="size-3.5" /> Duplicate
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="badge-duplicate-unchecked">
      <Eye className="size-3.5" /> Unchecked
    </span>
  );
}
