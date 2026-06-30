// AP Settings hub — module-local settings for the Accounts Payable module.
//
// Replaces the global "Vendor Rules" + "Aliases" sidebar entries and the
// "Vendor Groups" card buried in /settings with a single "⚙ Settings"
// item under Accounts Payable that opens this hub.
//
// Sub-pages live at:
//   /accounts-payable/settings/rules          → Rules.tsx (unmodified)
//   /accounts-payable/settings/aliases        → Aliases.tsx (unmodified)
//   /accounts-payable/settings/vendor-groups  → VendorGroups.tsx
//
// /accounts-payable/settings (no sub-path) lands on the Rules tab as the
// default — chosen because rules drive the most frequent operator workflow
// (vendor → store routing).
//
// Layout strategy: the hub renders a slim tab strip; each child page below
// renders its own header + padding + Card stack. This keeps Rules.tsx and
// Aliases.tsx unchanged (no embedded/standalone bifurcation) and lets the
// VendorGroups tab match the same visual rhythm via its own thin wrapper.

import { useLocation } from "wouter";
import { BookOpen, FileText, Layers, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import Rules from "@/pages/Rules";
import Aliases from "@/pages/Aliases";
import VendorGroups from "@/pages/accounts-payable/VendorGroups";
import SkipSenders from "@/pages/accounts-payable/SkipSenders";

// PR #238 — Skip Senders added as a 4th tab. It used to be a card on the
// global /settings page but it only governs AP email intake, so it now
// lives with the other AP module-local settings.
type ApSettingsTab = "rules" | "aliases" | "vendor-groups" | "skip-senders";

const TABS: Array<{ id: ApSettingsTab; label: string; icon: typeof BookOpen; href: string }> = [
  { id: "rules",         label: "Vendor Rules",  icon: BookOpen, href: "/accounts-payable/settings/rules" },
  { id: "aliases",       label: "Aliases",       icon: FileText, href: "/accounts-payable/settings/aliases" },
  { id: "vendor-groups", label: "Vendor Groups", icon: Layers,   href: "/accounts-payable/settings/vendor-groups" },
  { id: "skip-senders",  label: "Skip Senders",  icon: Ban,      href: "/accounts-payable/settings/skip-senders" },
];

export default function ApSettings({ tab = "rules" }: { tab?: ApSettingsTab }) {
  const [, navigate] = useLocation();

  return (
    <div>
      {/* Tab strip — clicking a tab updates the URL so deep links + back
          button work. Width-aligned with the children's max-w-[1100px]. */}
      <div className="px-8 pt-6 max-w-[1100px] mx-auto">
        <div className="border-b border-border">
          <nav className="flex gap-1 -mb-px" aria-label="AP Settings tabs">
            {TABS.map((t) => {
              const active = t.id === tab;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => navigate(t.href)}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors",
                    active
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                  )}
                  data-testid={`tab-ap-settings-${t.id}`}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon className="size-3.5" />
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Tab body — each child supplies its own h1, intro copy, and Card
          stack inside a max-w-[1100px] container, so the visual hierarchy
          below the tabs reads as: tab strip → section h1 → content. */}
      {tab === "rules" && <Rules />}
      {tab === "aliases" && <Aliases />}
      {tab === "vendor-groups" && <VendorGroupsTabBody />}
      {tab === "skip-senders" && <SkipSenders />}
    </div>
  );
}

// Vendor Groups didn't previously have its own page wrapper (it was a card
// inside Settings.tsx). Add a thin shell so it matches Rules/Aliases.
function VendorGroupsTabBody() {
  return (
    <div className="px-8 pt-6 pb-12 max-w-[1100px] mx-auto">
      <div className="mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Vendor Groups</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Parent companies that ship invoices for multiple sub-brands. The invoice drawer
        uses these to auto-suggest the right QBO vendor for an invoice's inventory.
      </p>
      <VendorGroups />
    </div>
  );
}
