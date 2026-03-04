import { useState, useEffect } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { LoginScreen } from "@/components/login-screen";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";

interface AuthUser {
  id: number;
  email: string;
}

function Router({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  return (
    <Switch>
      <Route path="/">
        {() => <Home user={user} onLogout={onLogout} />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch("/api/me")
      .then((res) => {
        if (res.ok) return res.json();
        return null;
      })
      .then((data) => {
        if (data && data.id) setUser(data);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  const handleLogout = async () => {
    await fetch("/api/logout").catch(() => {});
    setUser(null);
  };

  if (checking) {
    return (
      <ThemeProvider>
        <div className="min-h-screen bg-background flex items-center justify-center">
          <div className="animate-pulse text-muted-foreground text-sm">Loading...</div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          {user ? (
            <Router user={user} onLogout={handleLogout} />
          ) : (
            <LoginScreen onAuthenticated={(u) => setUser(u)} />
          )}
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
