import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Package, DollarSign } from "lucide-react";
import { type AsinResult, type PriceSource, type Settings, getSelectedPrice, calculateProfit } from "@shared/schema";

interface SummaryCardsProps {
  results: AsinResult[];
  priceSource: PriceSource;
  settings: Settings;
}

export function SummaryCards({ results, priceSource, settings }: SummaryCardsProps) {
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

    const calc = calculateProfit(
      price, r.cogs,
      r.feesData.fbaFulfillmentFee ?? 0,
      r.feesData.referralFee ?? 0,
      r.catalogData.weightLbs ?? 0,
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

  const cards = [
    {
      label: "Total ASINs",
      value: results.length.toString(),
      sub: `${calculated} calculated`,
      icon: Package,
      color: "text-primary",
    },
    {
      label: "Profitable",
      value: profitable.toString(),
      sub: `meets thresholds`,
      icon: TrendingUp,
      color: "text-emerald-500",
    },
    {
      label: "Unprofitable",
      value: unprofitable.toString(),
      sub: `below thresholds`,
      icon: TrendingDown,
      color: "text-red-500",
    },
    {
      label: "Avg ROI",
      value: `${avgRoi.toFixed(1)}%`,
      sub: `$${totalProfit.toFixed(2)} total profit`,
      icon: DollarSign,
      color: avgRoi >= settings.minRoiThreshold ? "text-emerald-500" : "text-red-500",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((card) => (
        <Card key={card.label} className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p className={`text-2xl font-bold mt-0.5 ${card.color}`} data-testid={`text-summary-${card.label.toLowerCase().replace(/\s/g, "-")}`}>
                {card.value}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{card.sub}</p>
            </div>
            <card.icon className={`h-5 w-5 ${card.color} opacity-60`} />
          </div>
        </Card>
      ))}
    </div>
  );
}
