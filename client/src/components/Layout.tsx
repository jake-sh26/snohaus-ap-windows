import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Inbox,
  History,
  Settings as SettingsIcon,
  Sun,
  Moon,
  LogOut,
  Menu,
  X,
  PackageOpen,
  AlertTriangle,
  FolderOpen,
  FileX,
  DollarSign,
  ChevronDown,
  ChevronRight,
  Receipt,
  Wrench,
  Building2,
  Users,
  LineChart,
  CalendarRange,
  Store,
  SlidersHorizontal,
  TrendingUp,
} from "lucide-react";
import { Wordmark } from "./Logo";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: any;
  countKey?: "inbox_count" | "receiving_count" | "problem_count" | "skipped_count";
  toneIfPositive?: "amber" | "red";
  // Optional per-item RBAC gate, in addition to the parent section's gate.
  // Used for Finance > Sales Tax, which needs finance.sales_tax.view on top of
  // the Finance section's finance.view/payroll.view gate. Hidden if missing.
  permissionKey?: string;
};

type NavSection = {
  label: string;
  icon: any;
  items: NavItem[];
  // Optional: tone for the rolled-up badge shown on the master row when collapsed.
  // Falls back to amber if any amber-tone child has a positive count; red if any red-tone child does.
  href?: string; // if set and items is empty, master row navigates directly
  // Optional RBAC gate. If set, the whole section is hidden unless the
  // current user has this permission key for at least one entity. Used to
  // hide the System > Settings link from non-Owners while keeping the rest
  // of the sidebar (AP, Payroll) visible to everyone.
  permissionKey?: string;
  // Optional OR-gate: section is visible if the user has ANY of these keys.
  // Used for Finance's graceful cutover (finance.view OR legacy payroll.view),
  // mirroring the server's requireFinanceView() helper.
  anyPermissionKeys?: string[];
};

// Sidebar is grouped into modules. Each section is a collapsible master menu with
// its own children. Future modules (Sales Reporting, Inventory) plug in here.
const NAV_SECTIONS: NavSection[] = [
  {
    label: "Accounts Payable",
    icon: Receipt,
    items: [
      { href: "/", label: "Inbox", icon: Inbox, countKey: "inbox_count", toneIfPositive: "amber" },
      { href: "/receiving", label: "In Receiving", icon: PackageOpen, countKey: "receiving_count" },
      { href: "/problem", label: "Problem invoices", icon: AlertTriangle, countKey: "problem_count", toneIfPositive: "red" },
      // R4s: Skipped page hidden from sidebar — feature was broken (email
      // ingest paths never called recordSkippedUpload) and Jake hasn't used
      // it. Server routes (/api/skipped/*), DB table (skipped_uploads),
      // and page component (pages/Skipped.tsx + /skipped route) are all
      // intact and still reachable by direct URL. To restore: uncomment
      // the line below. To fully fix the underlying feature, see TODO in
      // gmail.ts/gmail-api.ts: needs recordSkippedUpload() call where
      // is_real_invoice=false instead of fs.unlinkSync(filePath).
      // { href: "/skipped", label: "Skipped", icon: FileX, countKey: "skipped_count" },
      { href: "/all-invoices", label: "All Invoices", icon: FolderOpen },
      { href: "/posted", label: "History", icon: History },
      // AP-module-local settings hub: collapses what used to be 2 sidebar
      // items (Vendor Rules, Aliases) + 1 card in global Settings
      // (Vendor Groups) into one entry that opens a tabbed sub-page.
      { href: "/accounts-payable/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
  {
    label: "Payroll",
    icon: DollarSign,
    items: [
      { href: "/payroll", label: "Overview", icon: Wrench },
      // Entities moved to Settings → Entities (audit doc E3 / H3): it's a
      // global SoT consumed by Payroll, Sales Tax, AP. Legacy URL
      // /payroll/entities still redirects so bookmarks keep working.
      { href: "/payroll/employees", label: "Employees", icon: Users },
      // PR #203 — running tally of Shopify staff sales with entity breakdown.
      // Underlying data is refreshed automatically every 6h by the orders sync.
      { href: "/payroll/staff-sales", label: "Staff Sales", icon: TrendingUp },
    ],
  },
  {
    label: "Finance",
    icon: LineChart,
    // Graceful cutover: visible to finance.view holders OR legacy payroll.view
    // holders, matching the server's requireFinanceView().
    anyPermissionKeys: ["finance.view", "payroll.view"],
    items: [
      { href: "/finance/monthly-summary", label: "Monthly Summary", icon: CalendarRange },
      { href: "/finance/per-store-sales", label: "Per Store Sales", icon: Store },
      // Sales Tax needs the extra finance.sales_tax.view grant on top of the
      // section gate; content lands in PR #167.
      { href: "/finance/sales-tax", label: "Sales Tax", icon: Receipt, permissionKey: "finance.sales_tax.view" },
      { href: "/finance/options", label: "Finance Options", icon: SlidersHorizontal },
    ],
  },
  {
    // Renamed from "System" (audit doc H2) — the label "System" was
    // non-obvious. This is the global Settings hub. Each child gates
    // itself so we don't section-gate everything behind users.view
    // (which would hide Entities from non-admin operators).
    label: "Settings",
    icon: SettingsIcon,
    items: [
      // Global Settings page (QBO/Gmail integrations, users, RBAC,
      // skip senders). users.view gate matches the page's contents.
      { href: "/settings", label: "General", icon: SettingsIcon, permissionKey: "users.view" },
      // Entities — stores / legal entities SoT. Consumed by Payroll,
      // Sales Tax, AP. Currently visible to anyone who can view
      // Payroll; eventually wants its own gate (entities.view).
      { href: "/settings/entities", label: "Entities", icon: Building2, permissionKey: "payroll.view" },
    ],
  },
];

const SIDEBAR_STORAGE_KEY = "sidebar-expanded-sections-v1";

// Determine which section a given URL belongs to. Used to auto-expand the
// section the user is currently inside.
//
// Matching is segment-aware so `/payroll` does NOT count as active when the
// user is on `/payroll/employees` (the Employees child wins instead).
function matchesNav(path: string, href: string): boolean {
  if (path === href) return true;
  if (href === "/") return false;
  // Only count as a prefix match if the next char is a `/` (i.e. a sub-route),
  // never a partial-string match like `/payroll` vs `/payroll-foo`.
  return path.startsWith(href + "/");
}

function sectionForPath(path: string): string | null {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (matchesNav(path, item.href)) {
        return section.label;
      }
    }
  }
  return null;
}

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { email, logout, hasPermission } = useAuth();

  // PR #R4g — Session-expired banner. queryClient.ts dispatches a window
  // "auth-expired" event on any 401 response; we surface a clear banner with
  // a one-click "Sign in again" CTA so the operator isn't staring at a
  // silently-401ing page. The state is auto-cleared as soon as the user
  // either signs in (token returns) or dismisses; we also drop the banner
  // on any successful navigation away from a 401 state.
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onExpired = () => setSessionExpired(true);
    window.addEventListener("auth-expired", onExpired);
    return () => window.removeEventListener("auth-expired", onExpired);
  }, []);
  // If the token comes back (user re-logged in), clear the banner.
  useEffect(() => {
    if (!sessionExpired) return;
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("snohaus_token")) setSessionExpired(false);
  }, [sessionExpired, location]);
  function signInAgain() {
    try { localStorage.removeItem("snohaus_token"); } catch {}
    setSessionExpired(false);
    if (typeof window !== "undefined") window.location.hash = "#/login";
  }

  // Filter sidebar sections + their children by RBAC permission. A section is
  // hidden unless the user satisfies its `permissionKey` (single) AND/OR
  // `anyPermissionKeys` (OR-gate). Per-item `permissionKey` further hides
  // individual children. Owner gets all permissions (via seedRbacBaseline) so
  // these gates are invisible for them.
  const sectionVisible = (s: NavSection): boolean => {
    if (s.permissionKey && !hasPermission(s.permissionKey)) return false;
    if (s.anyPermissionKeys && !s.anyPermissionKeys.some((k) => hasPermission(k))) return false;
    return true;
  };
  const visibleSections = NAV_SECTIONS
    .filter(sectionVisible)
    .map((s) => ({
      ...s,
      items: s.items.filter((it) => !it.permissionKey || hasPermission(it.permissionKey)),
    }))
    .filter((s) => s.items.length > 0);
  const { theme, toggle } = useTheme();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Live counts for sidebar badges; refetches every 30s.
  const digestQ = useQuery<any>({ queryKey: ["/api/digest"] });
  const digest = digestQ.data || {};

  // Track which sections are expanded. On first load:
  //   - active section is expanded
  //   - all others are collapsed
  // After that, user toggles are remembered in localStorage so manually-opened
  // sections stay open across page navigations and reloads.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch {}
    const activeSection = sectionForPath(location);
    const init: Record<string, boolean> = {};
    for (const s of NAV_SECTIONS) init[s.label] = s.label === activeSection;
    return init;
  });

  // Whenever the user navigates, make sure the active section is expanded.
  // We don't collapse anything they had open — only auto-open the active one.
  useEffect(() => {
    const activeSection = sectionForPath(location);
    if (!activeSection) return;
    setExpanded((prev) => (prev[activeSection] ? prev : { ...prev, [activeSection]: true }));
  }, [location]);

  // Persist expanded state across reloads.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(expanded));
    } catch {}
  }, [expanded]);

  function toggleSection(label: string) {
    setExpanded((prev) => ({ ...prev, [label]: !prev[label] }));
  }

  function handleNav() {
    setMobileNavOpen(false);
  }

  // Compute the rolled-up badge for a section (shown on the master row).
  // If the section has any child with a positive count, show the highest-priority
  // tone (red > amber > muted) and the sum across children.
  function sectionBadge(section: NavSection): { count: number; tone: "red" | "amber" | "muted" } | null {
    let total = 0;
    let tone: "red" | "amber" | "muted" = "muted";
    for (const item of section.items) {
      if (!item.countKey) continue;
      const n = digest[item.countKey];
      if (typeof n !== "number" || n <= 0) continue;
      total += n;
      if (item.toneIfPositive === "red") tone = "red";
      else if (item.toneIfPositive === "amber" && tone !== "red") tone = "amber";
    }
    return total > 0 ? { count: total, tone } : null;
  }

  const badgeToneClass = (tone: "red" | "amber" | "muted") =>
    tone === "red"
      ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
      : tone === "amber"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
        : "bg-muted text-foreground/80 border-border";

  return (
    <div className="min-h-screen bg-background flex">
      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 h-14 bg-sidebar border-b border-sidebar-border flex items-center justify-between px-4">
        <Wordmark />
        <Button variant="ghost" size="sm" onClick={() => setMobileNavOpen((o) => !o)} data-testid="button-mobile-nav-toggle">
          {mobileNavOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </Button>
      </div>
      {mobileNavOpen && (
        <div className="lg:hidden fixed inset-0 top-14 z-30 bg-background/80 backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed lg:static inset-y-0 left-0 top-14 lg:top-0 z-40 w-60 shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col transition-transform",
          "lg:translate-x-0",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
        data-testid="sidebar"
      >
        <div className="px-5 pt-5 pb-6 hidden lg:block">
          <Wordmark />
        </div>
        <nav className="px-2 pt-2 flex-1 space-y-1 overflow-y-auto">
          {visibleSections.map((section) => {
            const SectionIcon = section.icon;
            const isExpanded = !!expanded[section.label];
            const isSingleItem = section.items.length === 1;
            // Pick the most specific match — longest href that matches —
            // so `/settings/entities` activates the Entities child, not General.
            const activeChild = section.items
              .filter((item) => matchesNav(location, item.href))
              .sort((a, b) => b.href.length - a.href.length)[0];
            const isActiveSection = !!activeChild;
            const badge = sectionBadge(section);

            // Single-item sections: the master row is itself a Link to the child's href
            // (no expand/collapse, no chevron). Saves a click on Settings/Overview/etc.
            if (isSingleItem) {
              const onlyItem = section.items[0];
              const ItemIcon = section.icon; // use the section icon, not the child icon, for visual consistency
              return (
                <div key={section.label}>
                  <Link
                    href={onlyItem.href}
                    onClick={handleNav}
                    data-testid={`link-nav-${section.label.toLowerCase().replace(/ /g, "-")}`}
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors hover-elevate",
                      isActiveSection
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:text-sidebar-foreground",
                    )}
                  >
                    <ItemIcon className="size-4 shrink-0" />
                    <span className="flex-1">{section.label}</span>
                  </Link>
                </div>
              );
            }

            return (
              <div key={section.label}>
                {/* Master row: clickable, toggles expand/collapse */}
                <button
                  type="button"
                  onClick={() => toggleSection(section.label)}
                  data-testid={`section-toggle-${section.label.toLowerCase().replace(/ /g, "-")}`}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors hover-elevate text-left",
                    isActiveSection
                      ? "text-sidebar-foreground"
                      : "text-sidebar-foreground/80 hover:text-sidebar-foreground",
                  )}
                  aria-expanded={isExpanded}
                >
                  <SectionIcon className="size-4 shrink-0" />
                  <span className="flex-1">{section.label}</span>
                  {/* Rolled-up badge only when collapsed, so it's visible at a glance */}
                  {!isExpanded && badge && (
                    <span
                      className={cn(
                        "text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-md border",
                        badgeToneClass(badge.tone),
                      )}
                      data-testid={`badge-section-${section.label.toLowerCase().replace(/ /g, "-")}`}
                    >
                      {badge.count}
                    </span>
                  )}
                  {isExpanded ? (
                    <ChevronDown className="size-3.5 shrink-0 text-sidebar-foreground/50" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-sidebar-foreground/50" />
                  )}
                </button>

                {/* Children: indented and only rendered when expanded */}
                {isExpanded && (
                  <div className="mt-0.5 ml-2 pl-3 border-l border-sidebar-border/60 space-y-0.5">
                  {(() => {
                    // Apply the same most-specific-wins rule for child highlighting.
                    const mostSpecificHref = section.items
                      .filter((item) => matchesNav(location, item.href))
                      .sort((a, b) => b.href.length - a.href.length)[0]?.href;
                    return section.items.map((item) => {
                      const active = item.href === mostSpecificHref;
                      const Icon = item.icon;
                      const count = item.countKey ? digest[item.countKey] : undefined;
                      const showBadge = typeof count === "number" && count > 0;
                      const badgeTone = item.toneIfPositive === "red"
                        ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
                        : item.toneIfPositive === "amber"
                          ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
                          : "bg-muted text-foreground/80 border-border";
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={handleNav}
                          data-testid={`link-nav-${item.label.toLowerCase().replace(/ /g, "-")}`}
                          className={cn(
                            "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors hover-elevate",
                            active
                              ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                              : "text-sidebar-foreground/75 hover:text-sidebar-foreground",
                          )}
                        >
                          <Icon className="size-3.5 shrink-0" />
                          <span className="flex-1">{item.label}</span>
                          {showBadge && (
                            <span
                              className={cn(
                                "ml-auto text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-md border",
                                badgeTone,
                              )}
                              data-testid={`badge-nav-${item.label.toLowerCase().replace(/ /g, "-")}`}
                            >
                              {count}
                            </span>
                          )}
                        </Link>
                      );
                    });
                  })()}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border space-y-2">
          <div className="px-2 py-1.5 text-xs">
            <div className="text-muted-foreground">Signed in as</div>
            <div className="truncate font-medium" data-testid="text-current-email">{email}</div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="flex-1 justify-start gap-2" onClick={toggle} data-testid="button-toggle-theme">
              {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              <span className="text-xs">{theme === "dark" ? "Light" : "Dark"}</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={logout} data-testid="button-logout" title="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 overflow-x-hidden pt-14 lg:pt-0">
        {sessionExpired && (
          <div
            className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
            data-testid="banner-session-expired"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" />
              <span>Your session has expired. Sign in again to keep working.</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={signInAgain}
              data-testid="button-session-expired-relogin"
            >
              Sign in again
            </Button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
