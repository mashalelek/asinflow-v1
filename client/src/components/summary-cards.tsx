import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TrendingUp, TrendingDown, Package, ShoppingCart, Repeat, Clock } from "lucide-react";
import { type AsinResult, type PriceSource, type Settings } from "@shared/schema";
import { isProfitable, isReplens } from "@shared/profitability";

export type FilterMode = "all" | "profitable" | "unprofitable" | "replens" | "buyList" | "onHold";

interface SummaryCardsProps {
  results: AsinResult[];
  priceSource: PriceSource;
  settings: Settings;
  /** Current toolbar/settings value — must mirror what the click filters use, otherwise tile vs. row counts diverge. */
  includeInboundShipping: boolean;
  activeFilter: FilterMode;
  onFilterChange: (filter: FilterMode) => void;
  buyListCount: number;
  onHoldCount: number;
  filterUncalculated?: boolean;
  onFilterUncalculatedChange?: (v: boolean) => void;
}

interface TileSpec {
  label: string;
  value: string;
  sub: string | null;
  _calculated?: number;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  accent: string;
  filter: FilterMode;
  tooltip: string | null;
}

export function SummaryCards({
  results, priceSource, settings, includeInboundShipping,
  activeFilter, onFilterChange, buyListCount, onHoldCount,
  filterUncalculated, onFilterUncalculatedChange,
}: SummaryCardsProps) {
  if (results.length === 0) return null;

  // Single-pass count via the shared helpers — same gates the row click
  // filters use, so tile face = row count after click. Calculability gate
  // here mirrors evaluate() inside shared/profitability.ts (error / cogs /
  // any usable price).
  let profitable = 0;
  let unprofitable = 0;
  let replens = 0;
  let calculated = 0;

  for (const r of results) {
    if (r.error) continue;
    if (r.estimatedCogs == null) continue;
    const anyPrice =
      r.pricingData.lowestFbaPrice != null
      || r.pricingData.buyBoxPrice != null
      || r.pricingData.lowestPrice != null;
    if (!anyPrice) continue;

    calculated++;
    if (isProfitable(r, priceSource, settings, includeInboundShipping)) profitable++;
    else unprofitable++;
    if (isReplens(r, priceSource, settings, includeInboundShipping)) replens++;
  }

  function handleClick(filter: FilterMode) {
    onFilterChange(activeFilter === filter ? "all" : filter);
  }

  const profTooltip =
    `ROI ≥ ${settings.minRoiThreshold}% AND Margin ≥ ${settings.minMarginThreshold}% AND Profit/Unit ≥ $${settings.minProfitUnitThreshold.toFixed(2)}\n\nThresholds from Settings → Profitability Thresholds.`;
  const unprofTooltip =
    `Calculated ASINs that don't meet the Profitable thresholds.\n\nExcludes ASINs with errors, no price, or no COGS.`;
  const replensTooltip =
    `Replenishment candidates. Passes if:\n• Tier 1: ROI > 25% AND Margin > 10%, OR\n• Tier 2: ROI > 20% AND Margin > 12%, OR\n• Tier 3: ROI > 15% AND Margin > 14%\nAND Profit/Unit ≥ $${settings.minProfitUnitThreshold.toFixed(2)}\nAND units sold > 0 in the selected date range.`;

  const tiles: TileSpec[] = [
    {
      label: "Total ASINs",
      value: results.length.toString(),
      sub: null,
      _calculated: calculated,
      icon: Package,
      color: "text-primary",
      accent: "#3B82F6",
      filter: "all",
      tooltip: null,
    },
    {
      label: "Profitable",
      value: profitable.toString(),
      sub: "meets thresholds",
      icon: TrendingUp,
      color: "text-emerald-500",
      accent: "#10B981",
      filter: "profitable",
      tooltip: profTooltip,
    },
    {
      label: "Unprofitable",
      value: unprofitable.toString(),
      sub: "below thresholds",
      icon: TrendingDown,
      color: "text-red-500",
      accent: "#EF4444",
      filter: "unprofitable",
      tooltip: unprofTooltip,
    },
    {
      label: "Replens",
      value: replens.toString(),
      sub: "restock candidates",
      icon: Repeat,
      color: "text-amber-500",
      accent: "#F59E0B",
      filter: "replens",
      tooltip: replensTooltip,
    },
    {
      label: `Buy List (${buyListCount})`,
      value: buyListCount.toString(),
      sub: "checked items",
      icon: ShoppingCart,
      color: "text-blue-500",
      accent: "#8B5CF6",
      filter: "buyList",
      tooltip: null,
    },
    {
      label: "Buy List (on hold)",
      value: onHoldCount.toString(),
      sub: "deferred items",
      icon: Clock,
      color: "text-amber-500",
      accent: "#B45309",       // amber-700 — distinct from Replens (#F59E0B) and Buy List (#8B5CF6)
      filter: "onHold",
      tooltip: null,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {tiles.map((card) => {
        const isActive = activeFilter === card.filter;

        const body = (
          <Card
            className={`p-4 transition-all border-l-[3px] cursor-pointer hover:shadow-md ${
              isActive ? "ring-2 ring-primary bg-primary/5 dark:bg-primary/10" : ""
            }`}
            style={{ borderLeftColor: card.accent }}
            onClick={() => handleClick(card.filter)}
            data-testid={`card-filter-${card.filter}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs text-muted-foreground leading-tight">{card.label}</p>
                <p
                  className={`text-2xl font-bold mt-0.5 ${card.color}`}
                  data-testid={`text-summary-${card.label.toLowerCase().replace(/\s/g, "-").replace(/[()]/g, "")}`}
                >
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

        if (!card.tooltip) return <div key={card.label}>{body}</div>;
        return (
          <Tooltip key={card.label}>
            <TooltipTrigger asChild>{body}</TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs whitespace-pre-line text-xs">
              {card.tooltip}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
