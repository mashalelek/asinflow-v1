import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { Layout } from "@/components/layout/layout";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Analytics from "@/pages/analytics";
import ComingSoon from "@/pages/coming-soon";
import { ShoppingCart, CreditCard, TrendingUp, Truck } from "lucide-react";

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/">
          <Redirect to="/asins" />
        </Route>
        <Route path="/asins" component={Home} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/purchase-orders">
          <ComingSoon title="Purchase Orders" icon={ShoppingCart} />
        </Route>
        <Route path="/gift-cards">
          <ComingSoon title="Gift Cards" icon={CreditCard} />
        </Route>
        <Route path="/repricer">
          <ComingSoon title="Repricer" icon={TrendingUp} />
        </Route>
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
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
