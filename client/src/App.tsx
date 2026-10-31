import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { DateRangeProvider } from "@/contexts/date-range-context";
import { AuthProvider, useAuth } from "@/contexts/auth-context";
import { Layout } from "@/components/layout/layout";
import { LoginScreen } from "@/components/login-screen";
import { UpdateBanner } from "@/components/update-banner";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import BulkCalc from "@/pages/bulk-calc";
import Repricer from "@/pages/repricer";
import Analytics from "@/pages/analytics";
import ComingSoon from "@/pages/coming-soon";
import PurchaseOrders, { PurchaseOrderDetailPlaceholder } from "@/pages/purchase-orders";
import PoNew from "@/pages/po-new";
import { CreditCard, TrendingUp, Truck } from "lucide-react";

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/">
          <Redirect to="/asins" />
        </Route>
        <Route path="/asins" component={Home} />
        <Route path="/bulk-calc" component={BulkCalc} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/purchase-orders" component={PurchaseOrders} />
        <Route path="/purchase-orders/:id" component={PurchaseOrderDetailPlaceholder} />
        {/* Capture PO (po-ai-prefill §4.5): the extension opens /pos/new?prefill=<id>. */}
        <Route path="/pos/new" component={PoNew} />
        <Route path="/gift-cards">
          <ComingSoon title="Gift Cards" icon={CreditCard} />
        </Route>
        <Route path="/repricer" component={Repricer} />
        <Route path="/fba-shipments">
          <ComingSoon title="FBA Shipments" icon={Truck} />
        </Route>
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

// Auth gate (SPEC §25): the app renders only behind an authenticated session.
// `loading` is the one /api/auth/me round-trip on page load — a blank page
// beats flashing the login form at a signed-in user.
function AuthGate() {
  const { state } = useAuth();
  if (state.status === "loading") return <div className="min-h-screen bg-background" aria-busy="true" />;
  if (state.status === "anonymous") return <LoginScreen />;
  return <Router />;
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DateRangeProvider>
            <TooltipProvider>
              <Toaster />
              <UpdateBanner />
              <AuthGate />
            </TooltipProvider>
          </DateRangeProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
