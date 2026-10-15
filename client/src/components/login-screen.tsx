/**
 * Login page (SPEC §25, commit 2). Replaces the Replit-era screen that
 * posted to a /api/login that never existed.
 *
 * Email, password, Remember me, submit. Every rejection shows the SAME one
 * line — unknown email, wrong password, locked and disabled accounts are
 * indistinguishable here by design (the server log says which). Warm stone
 * palette via the theme tokens (SPEC §7): page bg, white card, no border
 * outlines.
 */
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { BarChart3, Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { loginErrorText } from "@/lib/auth";

export function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const r = await login({ email: email.trim(), password, remember });
      if (!r.ok) {
        setError(loginErrorText(r.reason));
        setPassword("");
      }
      // On success the provider flips to authenticated and this page unmounts.
    } catch {
      setError(loginErrorText("error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-sm p-8 shadow-sm border-0">
        <div className="flex flex-col items-center gap-3 mb-6">
          <div
            className="h-11 w-11 rounded-full flex items-center justify-center"
            style={{ backgroundColor: "hsl(var(--nav))", color: "hsl(var(--nav-foreground))" }}
          >
            <BarChart3 className="h-5 w-5" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold tracking-tight">AsinFlow</h1>
            <p className="text-sm text-muted-foreground mt-1">Sign in to continue</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoFocus
              data-testid="input-email"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <div className="relative">
              <Input
                id="login-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-9"
                data-testid="input-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="login-remember"
              checked={remember}
              onCheckedChange={(v) => setRemember(v === true)}
              data-testid="checkbox-remember"
            />
            <Label htmlFor="login-remember" className="text-sm font-normal cursor-pointer">
              Remember me for 30 days
            </Label>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="text-auth-error">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={!canSubmit} data-testid="button-submit">
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
