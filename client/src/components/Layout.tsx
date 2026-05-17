import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Inbox, FileText, BookOpen, History, Settings as SettingsIcon, Sun, Moon, LogOut, Menu, X, PackageOpen, AlertTriangle, FolderOpen, FileX } from "lucide-react";
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
};

// Order per user preference: Inbox / Receiving / Problem / All / History / Vendor Rules / Aliases / Settings.
const NAV: NavItem[] = [
  { href: "/", label: "Inbox", icon: Inbox, countKey: "inbox_count", toneIfPositive: "amber" },
  { href: "/receiving", label: "In Receiving", icon: PackageOpen, countKey: "receiving_count" },
  { href: "/problem", label: "Problem invoices", icon: AlertTriangle, countKey: "problem_count", toneIfPositive: "red" },
  { href: "/skipped", label: "Skipped", icon: FileX, countKey: "skipped_count" },
  { href: "/all-invoices", label: "All Invoices", icon: FolderOpen },
  { href: "/posted", label: "History", icon: History },
  { href: "/rules", label: "Vendor Rules", icon: BookOpen },
  { href: "/aliases", label: "Aliases", icon: FileText },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { email, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Live counts for sidebar badges; refetches every 30s.
  const digestQ = useQuery<any>({ queryKey: ["/api/digest"] });
  const digest = digestQ.data || {};

  function handleNav() { setMobileNavOpen(false); }

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
        <nav className="px-3 pt-3 flex-1 space-y-0.5">
          {NAV.map((item) => {
            const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            const Icon = item.icon;
            const count = item.countKey ? digest[item.countKey] : undefined;
            const showBadge = typeof count === "number" && count > 0;
            const badgeTone = item.toneIfPositive === "red" ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
              : item.toneIfPositive === "amber" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
              : "bg-muted text-foreground/80 border-border";
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={handleNav}
                data-testid={`link-nav-${item.label.toLowerCase().replace(/ /g, "-")}`}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors hover-elevate",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:text-sidebar-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="flex-1">{item.label}</span>
                {showBadge && (
                  <span
                    className={cn("ml-auto text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-md border", badgeTone)}
                    data-testid={`badge-nav-${item.label.toLowerCase().replace(/ /g, "-")}`}
                  >
                    {count}
                  </span>
                )}
              </Link>
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
        {children}
      </main>
    </div>
  );
}
