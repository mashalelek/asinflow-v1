import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BarChart3, Lock, Mail, Eye, EyeOff } from "lucide-react";

interface LoginScreenProps {
  onAuthenticated: (user: { id: number; email: string }) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;

    setLoading(true);
    setError("");

    try {
      const endpoint = mode === "login" ? "/api/login" : "/api/register";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const data = await res.json();

      if (res.ok) {
        onAuthenticated({ id: data.id, email: data.email });
      } else {
        setError(data.message || "Something went wrong");
      }
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setMode((m) => (m === "login" ? "register" : "login"));
    setError("");
    setPassword("");
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-sm p-8">
        <div className="flex flex-col items-center gap-3 mb-6">
          <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <BarChart3 className="h-6 w-6 text-primary" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold">FBA Profitability Analyzer</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {mode === "login" ? "Sign in to your account" : "Create a new account"}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="pl-9"
                autoFocus
                data-testid="input-email"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "register" ? "Min 6 characters" : "Enter password"}
                className="pl-9 pr-9"
                data-testid="input-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive" data-testid="text-auth-error">{error}</p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={loading || !email.trim() || !password.trim()}
            data-testid="button-submit"
          >
            {loading
              ? mode === "login" ? "Signing in..." : "Creating account..."
              : mode === "login" ? "Sign In" : "Create Account"}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={toggleMode}
            className="text-sm text-muted-foreground hover:text-primary transition-colors"
            data-testid="button-toggle-mode"
          >
            {mode === "login"
              ? "Don't have an account? Register"
              : "Already have an account? Sign in"}
          </button>
        </div>
      </Card>
    </div>
  );
}
