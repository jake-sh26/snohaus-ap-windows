import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import { Layout } from "@/components/Layout";
import Login from "@/pages/Login";
import Inbox from "@/pages/Inbox";
import Posted from "@/pages/Posted";
import AllInvoices from "@/pages/AllInvoices";
import Receiving from "@/pages/Receiving";
import Problem from "@/pages/Problem";
import Skipped from "@/pages/Skipped";
import Settings from "@/pages/Settings";
import ApSettings from "@/pages/accounts-payable/ApSettings";
import Payroll from "@/pages/Payroll";
import PayrollEntities from "@/pages/PayrollEntities";
import PayrollEmployees from "@/pages/PayrollEmployees";
import ReconcilerTest from "@/pages/ReconcilerTest";
import SalesTax from "@/pages/SalesTax";
import NotFound from "@/pages/not-found";

/**
 * Backward-compat redirect for the old flat Reconciler route (PR #166).
 *
 * The single /reconciler/test page split into 4 Finance routes. We map the old
 * URL — including its ?tab= deep links — to the new home:
 *   ?tab=bystore            -> /finance/per-store-sales
 *   ?tab=sync|mapping|setup -> /finance/options?tab=<tab>
 *   ?tab=reconcile / none   -> /finance/monthly-summary
 */
function ReconcilerRedirect() {
  const [location, navigate] = useLocation();
  useEffect(() => {
    const qIdx = location.indexOf("?");
    const tab = qIdx >= 0 ? new URLSearchParams(location.slice(qIdx + 1)).get("tab") : null;
    let target = "/finance/monthly-summary";
    if (tab === "bystore") target = "/finance/per-store-sales";
    else if (tab === "sync" || tab === "mapping" || tab === "setup") {
      target = `/finance/options?tab=${tab}`;
    }
    navigate(target, { replace: true });
  }, [location, navigate]);
  return null;
}

/**
 * Backward-compat redirect for the legacy flat AP routes /rules and /aliases.
 *
 * They moved into the AP Settings hub at /accounts-payable/settings/* and now
 * share a single sidebar entry. Anyone with a bookmark to the old URL lands
 * on the matching hub tab; the back button still works because we `replace`.
 */
function ApLegacyRedirect({ tab }: { tab: "rules" | "aliases" }) {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate(`/accounts-payable/settings/${tab}`, { replace: true });
  }, [tab, navigate]);
  return null;
}

function ProtectedRoutes() {
  const { token } = useAuth();
  const [location, navigate] = useLocation();

  useEffect(() => {
    if (!token && location !== "/login") {
      navigate("/login");
    } else if (token && location === "/login") {
      navigate("/");
    }
  }, [token, location, navigate]);

  if (!token) {
    return (
      <Switch>
        <Route path="/login" component={Login} />
        <Route component={Login} />
      </Switch>
    );
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Inbox} />
        <Route path="/receiving" component={Receiving} />
        <Route path="/problem" component={Problem} />
        <Route path="/skipped" component={Skipped} />
        <Route path="/all-invoices" component={AllInvoices} />
        <Route path="/posted" component={Posted} />
        {/* AP Settings hub — module-local settings for Accounts Payable.
            Default landing tab is Rules (most-frequent operator workflow). */}
        <Route path="/accounts-payable/settings">
          {() => <ApSettings tab="rules" />}
        </Route>
        <Route path="/accounts-payable/settings/rules">
          {() => <ApSettings tab="rules" />}
        </Route>
        <Route path="/accounts-payable/settings/aliases">
          {() => <ApSettings tab="aliases" />}
        </Route>
        <Route path="/accounts-payable/settings/vendor-groups">
          {() => <ApSettings tab="vendor-groups" />}
        </Route>
        {/* Backward-compat: legacy flat /rules + /aliases URLs. */}
        <Route path="/rules">{() => <ApLegacyRedirect tab="rules" />}</Route>
        <Route path="/aliases">{() => <ApLegacyRedirect tab="aliases" />}</Route>
        <Route path="/settings" component={Settings} />
        <Route path="/payroll" component={Payroll} />
        <Route path="/payroll/entities" component={PayrollEntities} />
        <Route path="/payroll/employees" component={PayrollEmployees} />
        <Route path="/finance/monthly-summary">
          {() => <ReconcilerTest view="monthly-summary" />}
        </Route>
        <Route path="/finance/per-store-sales">
          {() => <ReconcilerTest view="per-store-sales" />}
        </Route>
        <Route path="/finance/options">
          {() => <ReconcilerTest view="options" />}
        </Route>
        <Route path="/finance/sales-tax" component={SalesTax} />
        {/* Backward-compat: old flat Reconciler URL + its ?tab= deep links. */}
        <Route path="/reconciler/test" component={ReconcilerRedirect} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            <Toaster />
            <Router hook={useHashLocation}>
              <ProtectedRoutes />
            </Router>
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
