import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { DateRangeProvider } from "@/contexts/date-range-context";
import { Layout } from "@/components/layout/layout";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import BulkCalc from "@/pages/bulk-calc";
import Repricer from "@/pages/repricer";
import Analytics from "@/pages/analytics";
import ComingSoon from "@/pages/coming-soon";
import PurchaseOrders, { PurchaseOrderDetailPlaceholder } from "@/pages/purchase-orders";
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

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <DateRangeProvider>
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </DateRangeProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
