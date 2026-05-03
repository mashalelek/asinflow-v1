import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Package, ShoppingCart } from "lucide-react";
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
  filterUncalculated?: boolean;
  onFilterUncalculatedChange?: (v: boolean) => void;
}

export function SummaryCards({ results, priceSource, settings, activeFilter, onFilterChange, buyListCount, filterUncalculated, onFilterUncalculatedChange }: SummaryCardsProps) {
  if (results.length === 0) return null;

  let profitable = 0;
  let unprofitable = 0;
  let calculated = 0;

  results.forEach((r) => {
    if (r.error) return;
    const { price } = getSelectedPrice(r, priceSource);
    if (price == null || r.estimatedCogs == null) return;

    const prep = getEffectivePrep(r, settings);
    const storage = getEffectiveStorage(r, settings);

    const calc = calculateProfit(
      price, r.estimatedCogs,
      r.feesData.fbaFulfillmentFee ?? 0,
      r.feesData.referralFee ?? 0,
      r.feesData.feesEstimatePrice,
      r.catalogData.weightLbs,
      prep.value,
      storage.value,
      settings,
      true,
      r.isHazmat ?? false
    );

    calculated++;

    if (calc.roi >= settings.minRoiThreshold && calc.margin >= settings.minMarginThreshold) {
      profitable++;
    } else {
      unprofitable++;
    }
  });

  function handleClick(filter: FilterMode) {
    onFilterChange(activeFilter === filter ? "all" : filter);
  }

  const cards = [
    {
      label: "Total ASINs",
      value: results.length.toString(),
      sub: null, // rendered custom below
      _calculated: calculated,
      icon: Package,
      color: "text-primary",
      accent: "#3B82F6",
      accentDark: "#60A5FA",
      filter: "all" as FilterMode,
    },
    {
      label: "Profitable",
      value: profitable.toString(),
      sub: `meets thresholds`,
      icon: TrendingUp,
      color: "text-emerald-500",
      accent: "#10B981",
      accentDark: "#34D399",
      filter: "profitable" as FilterMode,
    },
    {
      label: "Unprofitable",
      value: unprofitable.toString(),
      sub: `below thresholds`,
      icon: TrendingDown,
      color: "text-red-500",
      accent: "#EF4444",
      accentDark: "#F87171",
      filter: "unprofitable" as FilterMode,
    },
    {
      label: `Buy List (${buyListCount})`,
      value: buyListCount.toString(),
      sub: "checked items",
      icon: ShoppingCart,
      color: "text-blue-500",
      accent: "#8B5CF6",
      accentDark: "#A78BFA",
      filter: "buyList" as FilterMode,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((card) => {
        const isActive = card.filter != null && activeFilter === card.filter;
        const isClickable = card.filter != null;

        return (
          <Card
            key={card.label}
            className={`p-4 transition-all border-l-[3px] ${isClickable ? "cursor-pointer hover:shadow-md" : ""} ${
              isActive
                ? "ring-2 ring-primary bg-primary/5 dark:bg-primary/10"
                : ""
            }`}
            style={{ borderLeftColor: card.accent }}
            onClick={isClickable ? () => handleClick(card.filter!) : undefined}
            data-testid={`card-filter-${card.filter ?? "avg-roi"}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs text-muted-foreground">{card.label}</p>
                <p className={`text-2xl font-bold mt-0.5 ${card.color}`} data-testid={`text-summary-${card.label.toLowerCase().replace(/\s/g, "-").replace(/[()]/g, "")}`}>
                  {card.value}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {card.sub != null ? card.sub : card._calculated != null ? (
                    filterUncalculated ? (
                      <span className="inline-flex items-center gap-1 text-amber-500">
                        {results.length - card._calculated} uncalculated
                        <button
                          className="text-muted-foreground hover:text-foreground underline"
                          onClick={(e) => { e.stopPropagation(); onFilterUncalculatedChange?.(false); }}
                        >
                          Clear
                        </button>
                      </span>
                    ) : (
                      <button
                        className="text-amber-500 hover:text-amber-400"
                        onClick={(e) => { e.stopPropagation(); onFilterUncalculatedChange?.(true); }}
                      >
                        {card._calculated} calculated
                      </button>
                    )
                  ) : null}
                </p>
              </div>
              <card.icon className={`h-5 w-5 ${card.color} opacity-60`} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
