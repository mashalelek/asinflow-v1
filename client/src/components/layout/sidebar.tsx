import { useState } from "react";
import { useLocation, Link } from "wouter";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Package,
  BarChart3,
  ShoppingCart,
  CreditCard,
  TrendingUp,
  Truck,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

const SIDEBAR_KEY = "fba-sidebar-collapsed";

interface NavItem {
  path: string;
  label: string;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { path: "/asins", label: "ASINs", icon: Package },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/purchase-orders", label: "Purchase Orders", icon: ShoppingCart },
  { path: "/gift-cards", label: "Gift Cards", icon: CreditCard },
  { path: "/repricer", label: "Repricer", icon: TrendingUp },
  { path: "/fba-shipments", label: "FBA Shipments", icon: Truck },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === "true"; } catch { return true; }
  });
  const [location] = useLocation();

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(SIDEBAR_KEY, String(next));
  }

  return (
    <aside
      className={`flex-shrink-0 h-screen sticky top-0 bg-background border-r border-border flex flex-col transition-[width] duration-200 ${
        collapsed ? "w-16" : "w-56"
      }`}
    >
      {/* Toggle */}
      <div className="flex items-center justify-end p-2 border-b border-border">
        <button
          onClick={toggle}
          className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-2 space-y-0.5 px-2">
        {NAV_ITEMS.map((item) => {
          const isActive = location === item.path || (item.path === "/asins" && location === "/");
          const Icon = item.icon;
          const button = (
            <Link
              key={item.path}
              href={item.path}
              className={`flex items-center gap-3 rounded-md transition-colors text-sm ${
                collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5"
              } ${
                isActive
                  ? "bg-primary/10 text-primary border-l-2 border-primary -ml-2 pl-[calc(0.75rem-2px)]"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="h-4.5 w-4.5 flex-shrink-0" style={{ width: 18, height: 18 }} />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.path}>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  <p className="text-xs">{item.label}</p>
                </TooltipContent>
              </Tooltip>
            );
          }
          return button;
        })}
      </nav>
    </aside>
  );
}
