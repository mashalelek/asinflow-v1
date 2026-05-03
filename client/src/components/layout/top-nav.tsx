import { useLocation, Link } from "wouter";
import { useTheme } from "@/components/theme-provider";
import { Sun, Moon, Package, BarChart3, ShoppingCart, CreditCard, TrendingUp, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NavItem {
  path: string;
  label: string;
  icon: React.ElementType;
  disabled?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { path: "/asins", label: "ASINs", icon: Package },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/purchase-orders", label: "POs", icon: ShoppingCart, disabled: true },
  { path: "/gift-cards", label: "Gift Cards", icon: CreditCard, disabled: true },
  { path: "/repricer", label: "Repricer", icon: TrendingUp, disabled: true },
  { path: "/fba-shipments", label: "Shipments", icon: Truck, disabled: true },
];

export function TopNav() {
  const [location] = useLocation();
  const { theme, toggleTheme } = useTheme();

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

      {/* Right side utilities */}
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          onClick={toggleTheme}
          className="text-inherit hover:bg-white/10"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}
