import { useLocation, Link } from "wouter";
import { useTheme } from "@/components/theme-provider";
import { Sun, Moon, Package, BarChart3, Calculator, ShoppingCart, CreditCard, TrendingUp, Truck, Settings, LogOut, UserRound, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useDateRange } from "@/contexts/date-range-context";
import { useAuth } from "@/contexts/auth-context";
import { DataStudioDatePicker } from "@/components/data-studio-date-picker";
import { ActionRequired } from "@/components/action-required";

interface NavItem {
  path: string;
  label: string;
  icon: React.ElementType;
  disabled?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { path: "/asins", label: "ASINs", icon: Package },
  { path: "/bulk-calc", label: "Bulk Calc", icon: Calculator },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/purchase-orders", label: "POs", icon: ShoppingCart },
  { path: "/subscriptions", label: "Subscriptions", icon: Repeat },
  { path: "/gift-cards", label: "Gift Cards", icon: CreditCard, disabled: true },
  { path: "/repricer", label: "Repricer", icon: TrendingUp },
  { path: "/fba-shipments", label: "Shipments", icon: Truck, disabled: true },
];

// Routes that opt into the global date picker.
// /purchase-orders dropped: the shell page has no date-driven content; the
// Velocity upload dialog (§11) carries its own date-range picker.
const DATE_PICKER_ROUTES = ["/", "/asins", "/analytics"];
// Routes that expose a Settings icon (each page owns its own dialog and
// listens for the custom event below).
// §23 (2026-09-15): Repricer takes the settings gear but NOT the date picker
// — its 7-day window is fixed (same precedent as Bulk Calc, §21).
const SETTINGS_ROUTES = ["/", "/asins", "/bulk-calc", "/repricer"];
export const OPEN_SETTINGS_EVENT = "asinflow:open-settings";

export function TopNav() {
  const [location] = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { range, setRange } = useDateRange();
  const { user, logout } = useAuth();

  // Match exact route or its subtree where appropriate.
  const showDatePicker = DATE_PICKER_ROUTES.some((p) => location === p || (p === "/asins" && location === "/"));
  const showSettings   = SETTINGS_ROUTES.some((p) => location === p);

  return (
    <header
      className="sticky top-0 z-50 flex items-center h-[52px] px-4 gap-6"
      style={{ backgroundColor: "hsl(var(--nav))", color: "hsl(var(--nav-foreground))" }}
    >
      {/* Logo */}
      <Link href="/asins" className="flex items-center gap-2 font-semibold text-sm tracking-tight shrink-0">
        <BarChart3 className="h-5 w-5" />
        AsinFlow
      </Link>

      {/* Nav items */}
      <nav className="flex items-center gap-1">
        {NAV_ITEMS.map((item) => {
          const isActive = location === item.path || (item.path === "/asins" && location === "/");
          const Icon = item.icon;

          if (item.disabled) {
            return (
              <span
                key={item.path}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs opacity-40 cursor-default select-none"
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
                <span className="text-[9px] uppercase tracking-wider opacity-60">Soon</span>
              </span>
            );
          }

          return (
            <Link
              key={item.path}
              href={item.path}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors ${
                isActive
                  ? "font-medium"
                  : "opacity-70 hover:opacity-100"
              }`}
              style={isActive ? { backgroundColor: "hsl(var(--nav-active))" } : undefined}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Right side utilities — order: Date Picker | Theme toggle | Settings | User */}
      <div className="ml-auto flex items-center gap-2">
        {/* Listing hygiene: a held close / delete run, on every page until released. */}
        {user && <ActionRequired />}

        {showDatePicker && (
          <DataStudioDatePicker value={range} onApply={setRange} />
        )}

        <Button
          size="icon"
          variant="ghost"
          onClick={toggleTheme}
          className="text-inherit hover:bg-white/10"
          title="Toggle theme"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>

        {showSettings && (
          <Button
            size="icon"
            variant="ghost"
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT))}
            className="text-inherit hover:bg-white/10"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        )}

        {/* User menu (SPEC §25): display name + Log out, on every route. The
            settings gear is per-page and absent on some routes, so the
            account menu is its own control rather than an item inside it. */}
        {user && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="text-inherit hover:bg-white/10 gap-1.5 px-2 h-8 text-xs"
                title={user.email}
                data-testid="button-user-menu"
              >
                <UserRound className="h-4 w-4" />
                <span className="max-w-[12rem] truncate">{user.displayName}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              <DropdownMenuLabel className="font-normal">
                <div className="text-sm font-medium truncate">{user.displayName}</div>
                <div className="text-xs text-muted-foreground truncate">{user.email}</div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">{user.role}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { void logout(); }} data-testid="menu-logout">
                <LogOut className="h-4 w-4 mr-2" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </header>
  );
}
