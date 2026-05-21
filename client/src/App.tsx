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
import Rules from "@/pages/Rules";
import Aliases from "@/pages/Aliases";
import Posted from "@/pages/Posted";
import AllInvoices from "@/pages/AllInvoices";
import Receiving from "@/pages/Receiving";
import Problem from "@/pages/Problem";
import Skipped from "@/pages/Skipped";
import Settings from "@/pages/Settings";
import Payroll from "@/pages/Payroll";
import PayrollEntities from "@/pages/PayrollEntities";
import PayrollEmployees from "@/pages/PayrollEmployees";
import ReconcilerTest from "@/pages/ReconcilerTest";
import NotFound from "@/pages/not-found";

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
        <Route path="/rules" component={Rules} />
        <Route path="/aliases" component={Aliases} />
        <Route path="/settings" component={Settings} />
        <Route path="/payroll" component={Payroll} />
        <Route path="/payroll/entities" component={PayrollEntities} />
        <Route path="/payroll/employees" component={PayrollEmployees} />
        <Route path="/reconciler/test" component={ReconcilerTest} />
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
