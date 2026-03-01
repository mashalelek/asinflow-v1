import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Package, DollarSign, ShoppingCart } from "lucide-react";
import {
  type AsinResult,
  type PriceSource,
  type Settings,
  getSelectedPrice,
  calculateProfit,
  getEffectivePrep,
  getEffectiveStorage,
} from "@shared/schema";

export type FilterMode = "all" | "profitable" | "unprofitable" | "buyList";

interface SummaryCardsProps {
  results: AsinResult[];
  priceSource: PriceSource;
  settings: Settings;
  activeFilter: FilterMode;
  onFilterChange: (filter: FilterMode) => void;
  buyListCount: number;
}

export function SummaryCards({ results, priceSource, settings, activeFilter, onFilterChange, buyListCount }: SummaryCardsProps) {
  if (results.length === 0) return null;

  let profitable = 0;
  let unprofitable = 0;
  let totalProfit = 0;
  let totalCogs = 0;
  let calculated = 0;

  results.forEach((r) => {
    if (r.error) return;
    const { price } = getSelectedPrice(r, priceSource);
    if (price == null) return;

    const prep = getEffectivePrep(r, settings);
    const storage = getEffectiveStorage(r, settings);

    const calc = calculateProfit(
      price, r.cogs,
      r.feesData.fbaFulfillmentFee ?? 0,
      r.feesData.referralFee ?? 0,
      r.feesData.feesEstimatePrice,
      r.catalogData.weightLbs,
      prep.value,
      storage.value,
      settings
    );

    calculated++;
    totalProfit += calc.profit;
    totalCogs += r.cogs;

    if (calc.roi >= settings.minRoiThreshold && calc.margin >= settings.minMarginThreshold) {
      profitable++;
    } else {
      unprofitable++;
    }
  });

  const avgRoi = totalCogs > 0 ? (totalProfit / totalCogs) * 100 : 0;

  function handleClick(filter: FilterMode) {
    onFilterChange(activeFilter === filter ? "all" : filter);
  }

  const cards = [
    {
      label: "Total ASINs",
      value: results.length.toString(),
      sub: `${calculated} calculated`,
      icon: Package,
      color: "text-primary",
      filter: "all" as FilterMode,
    },
    {
      label: "Profitable",
      value: profitable.toString(),
      sub: `meets thresholds`,
      icon: TrendingUp,
      color: "text-emerald-500",
      filter: "profitable" as FilterMode,
    },
    {
      label: "Unprofitable",
      value: unprofitable.toString(),
      sub: `below thresholds`,
      icon: TrendingDown,
      color: "text-red-500",
      filter: "unprofitable" as FilterMode,
    },
    {
      label: `Buy List (${buyListCount})`,
      value: buyListCount.toString(),
      sub: "checked items",
      icon: ShoppingCart,
      color: "text-blue-500",
      filter: "buyList" as FilterMode,
    },
    {
      label: "Avg ROI",
      value: `${avgRoi.toFixed(1)}%`,
      sub: `$${totalProfit.toFixed(2)} total profit`,
      icon: DollarSign,
      color: avgRoi >= settings.minRoiThreshold ? "text-emerald-500" : "text-red-500",
      filter: null,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      {cards.map((card) => {
        const isActive = card.filter != null && activeFilter === card.filter;
        const isClickable = card.filter != null;

        return (
          <Card
            key={card.label}
            className={`p-4 transition-all ${isClickable ? "cursor-pointer hover:shadow-md" : ""} ${
              isActive
                ? "ring-2 ring-primary bg-primary/5 dark:bg-primary/10"
                : ""
            }`}
            onClick={isClickable ? () => handleClick(card.filter!) : undefined}
            data-testid={`card-filter-${card.filter ?? "avg-roi"}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs text-muted-foreground">{card.label}</p>
                <p className={`text-2xl font-bold mt-0.5 ${card.color}`} data-testid={`text-summary-${card.label.toLowerCase().replace(/\s/g, "-").replace(/[()]/g, "")}`}>
                  {card.value}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">{card.sub}</p>
              </div>
              <card.icon className={`h-5 w-5 ${card.color} opacity-60`} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
