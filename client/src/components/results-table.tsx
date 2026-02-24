import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink, AlertTriangle } from "lucide-react";
import { type AsinResult, type PriceSource, type Settings, getSelectedPrice, calculateProfit } from "@shared/schema";

interface ResultsTableProps {
  results: AsinResult[];
  priceSource: PriceSource;
  settings: Settings;
}

function formatCurrency(value: number | null): string {
  if (value == null) return "-";
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function ResultsTable({ results, priceSource, settings }: ResultsTableProps) {
  if (results.length === 0) return null;

  return (
    <ScrollArea className="w-full" style={{ maxHeight: "calc(100vh - 280px)" }}>
      <div className="min-w-[1200px]">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-border">
              <TableHead className="w-[130px] sticky top-0 bg-background z-10">ASIN</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">COGS</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">Sale Price</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">FBA Fee</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">Referral Fee</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">Inbound Ship.</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">Prep</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">Storage</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">Profit/Unit</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">Margin</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">ROI</TableHead>
              <TableHead className="text-right sticky top-0 bg-background z-10">Sellers</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((result, idx) => {
              const { price, label } = getSelectedPrice(result, priceSource);
              const hasError = !!result.error;
              const notAvailable = price == null && !hasError;

              let rowBg = "";
              let profitData = null;

              if (!hasError && price != null) {
                const fbaFee = result.feesData.fbaFulfillmentFee ?? 0;
                const referralFee = result.feesData.referralFee ?? 0;
                const weight = result.catalogData.weightLbs ?? 0;

                profitData = calculateProfit(price, result.cogs, fbaFee, referralFee, result.feesData.feesEstimatePrice, weight, settings);

                const meetsCriteria =
                  profitData.roi >= settings.minRoiThreshold &&
                  profitData.margin >= settings.minMarginThreshold;

                rowBg = meetsCriteria
                  ? "bg-emerald-500/8 dark:bg-emerald-500/10"
                  : "bg-red-500/8 dark:bg-red-500/10";
              }

              if (notAvailable || hasError) {
                rowBg = "opacity-50";
              }

              return (
                <TableRow
                  key={`${result.asin}-${idx}`}
                  className={`${rowBg} transition-colors`}
                  data-testid={`row-result-${result.asin}`}
                >
                  <TableCell>
                    <a
                      href={`https://amazon.com/dp/${result.asin}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-primary font-mono text-sm"
                      data-testid={`link-asin-${result.asin}`}
                    >
                      {result.asin}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatCurrency(result.cogs)}
                  </TableCell>
                  <TableCell className="text-right">
                    {hasError ? (
                      <Tooltip>
                        <TooltipTrigger>
                          <span className="flex items-center gap-1 justify-end text-destructive text-sm">
                            <AlertTriangle className="h-3 w-3" />
                            Error
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[300px]">
                          <p className="text-xs">{result.error}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : price != null ? (
                      <div className="flex items-center gap-1.5 justify-end">
                        <span className="font-mono text-sm">{formatCurrency(price)}</span>
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {label}
                        </Badge>
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-sm">N/A</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatCurrency(result.feesData.fbaFulfillmentFee)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {profitData ? formatCurrency(profitData.adjustedReferralFee) : formatCurrency(result.feesData.referralFee)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {profitData ? formatCurrency(profitData.inboundShipping) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatCurrency(settings.prepCost)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatCurrency(settings.storageFee)}
                  </TableCell>
                  <TableCell className={`text-right font-mono text-sm font-semibold ${
                    profitData
                      ? profitData.profit >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                      : ""
                  }`}>
                    {profitData ? formatCurrency(profitData.profit) : "-"}
                  </TableCell>
                  <TableCell className={`text-right font-mono text-sm ${
                    profitData
                      ? profitData.margin >= settings.minMarginThreshold
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                      : ""
                  }`}>
                    {profitData ? formatPercent(profitData.margin) : "-"}
                  </TableCell>
                  <TableCell className={`text-right font-mono text-sm ${
                    profitData
                      ? profitData.roi >= settings.minRoiThreshold
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400"
                      : ""
                  }`}>
                    {profitData ? formatPercent(profitData.roi) : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {result.pricingData.numberOfSellers ?? "-"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </ScrollArea>
  );
}
