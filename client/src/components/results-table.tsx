import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink, AlertTriangle, ArrowUp, ArrowDown } from "lucide-react";
import {
  type AsinResult,
  type PriceSource,
  type Settings,
  type ColumnId,
  ALL_COLUMNS,
  getSelectedPrice,
  calculateProfit,
  getEffectivePrep,
  getEffectiveStorage,
  extractDomain,
} from "@shared/schema";
import { type ColumnConfig } from "@/lib/columns";
import { type FilterMode } from "@/components/summary-cards";

interface ResultsTableProps {
  results: AsinResult[];
  priceSource: PriceSource;
  settings: Settings;
  columnConfig: ColumnConfig;
  activeFilter: FilterMode;
  buySet: Set<string>;
  onToggleBuy: (asin: string) => void;
  sortCol: ColumnId | null;
  sortDir: "asc" | "desc";
  onSort: (colId: ColumnId) => void;
}

function fmt(value: number | null): string {
  if (value == null) return "-";
  return `$${value.toFixed(2)}`;
}

function fmtPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function fmtBsr(rank: number | null, category: string | null): string {
  if (rank == null) return "-";
  const formatted = rank.toLocaleString();
  if (category) return `#${formatted} in ${category}`;
  return `#${formatted}`;
}

function getRowValue(
  result: AsinResult,
  colId: ColumnId,
  priceSource: PriceSource,
  settings: Settings
): number | string | null {
  const { price } = getSelectedPrice(result, priceSource);
  const prep = getEffectivePrep(result, settings);
  const storage = getEffectiveStorage(result, settings);

  let profitData: ReturnType<typeof calculateProfit> | null = null;
  if (price != null && !result.error) {
    profitData = calculateProfit(
      price, result.cogs,
      result.feesData.fbaFulfillmentFee ?? 0,
      result.feesData.referralFee ?? 0,
      result.feesData.feesEstimatePrice,
      result.catalogData.weightLbs,
      prep.value,
      storage.value,
      settings
    );
  }

  switch (colId) {
    case "asin": return result.asin;
    case "image": return result.catalogData.imageUrl;
    case "name": return result.catalogData.title;
    case "eligible": return result.eligibilityData?.status ?? "check";
    case "supplier": return extractDomain(result.buyLink);
    case "cogs": return result.cogs;
    case "salePrice": return price;
    case "profit": return profitData?.profit ?? null;
    case "margin": return profitData?.margin ?? null;
    case "roi": return profitData?.roi ?? null;
    case "fbaFee": return profitData?.totalFbaFee ?? result.feesData.fbaFulfillmentFee;
    case "referralFee": return profitData?.adjustedReferralFee ?? result.feesData.referralFee;
    case "inboundShipping": return profitData?.inboundShipping ?? null;
    case "prep": return prep.value;
    case "storage": return storage.value;
    case "bsr": return result.catalogData.bsrRank;
    case "sellersFba": return result.pricingData.sellersFba;
    case "sellersFbm": return result.pricingData.sellersFbm;
    default: return null;
  }
}

function isProfitable(result: AsinResult, priceSource: PriceSource, settings: Settings): boolean | null {
  if (result.error) return null;
  const { price } = getSelectedPrice(result, priceSource);
  if (price == null) return null;
  const prep = getEffectivePrep(result, settings);
  const storage = getEffectiveStorage(result, settings);
  const calc = calculateProfit(
    price, result.cogs,
    result.feesData.fbaFulfillmentFee ?? 0,
    result.feesData.referralFee ?? 0,
    result.feesData.feesEstimatePrice,
    result.catalogData.weightLbs,
    prep.value, storage.value, settings
  );
  return calc.roi >= settings.minRoiThreshold && calc.margin >= settings.minMarginThreshold;
}

export function ResultsTable({
  results, priceSource, settings, columnConfig,
  activeFilter, buySet, onToggleBuy,
  sortCol, sortDir, onSort,
}: ResultsTableProps) {
  const colMap = useMemo(() => new Map(ALL_COLUMNS.map((c) => [c.id, c])), []);

  const visibleCols = useMemo(
    () => columnConfig.order.filter((id) => columnConfig.visible.has(id)),
    [columnConfig]
  );

  const filteredResults = useMemo(() => {
    if (activeFilter === "all") return results;
    if (activeFilter === "buyList") return results.filter((r) => buySet.has(r.asin));
    if (activeFilter === "profitable") return results.filter((r) => isProfitable(r, priceSource, settings) === true);
    if (activeFilter === "unprofitable") return results.filter((r) => isProfitable(r, priceSource, settings) === false);
    return results;
  }, [results, activeFilter, buySet, priceSource, settings]);

  const sortedResults = useMemo(() => {
    if (!sortCol) return filteredResults;
    const sorted = [...filteredResults].sort((a, b) => {
      const va = getRowValue(a, sortCol, priceSource, settings);
      const vb = getRowValue(b, sortCol, priceSource, settings);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") {
        return sortDir === "asc" ? va - vb : vb - va;
      }
      const sa = String(va).toLowerCase();
      const sb = String(vb).toLowerCase();
      return sortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
    return sorted;
  }, [filteredResults, sortCol, sortDir, priceSource, settings]);

  if (results.length === 0) return null;

  const frozenColWidth = { rowNum: 40, buy: 40, asin: 120 };
  const buyLeft = frozenColWidth.rowNum;
  const asinLeft = buyLeft + frozenColWidth.buy;
  const asinVisible = visibleCols.includes("asin");

  return (
    <div className="w-full overflow-auto relative border-y border-border" style={{ maxHeight: "calc(100vh - 280px)" }}>
      <table className="w-full border-collapse text-sm" data-testid="results-table">
        <thead className="sticky top-0 z-20">
          <tr className="border-b border-border bg-muted/80 backdrop-blur">
            <th
              className="sticky left-0 z-30 bg-muted text-center text-xs font-medium text-muted-foreground px-2 py-2 border-r border-border"
              style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}
            >
              #
            </th>
            <th
              className="sticky z-30 bg-muted text-center text-xs font-medium text-muted-foreground px-1 py-2 border-r border-border"
              style={{ left: buyLeft, width: frozenColWidth.buy, minWidth: frozenColWidth.buy }}
            >
              ☑
            </th>
            {asinVisible && (
              <th
                className="sticky z-30 bg-muted text-left text-xs font-medium px-2 py-2 border-r border-border cursor-pointer select-none hover:bg-muted/70 transition-colors"
                style={{ left: asinLeft, width: frozenColWidth.asin, minWidth: frozenColWidth.asin }}
                onClick={() => onSort("asin")}
                data-testid="header-asin"
              >
                <span className="inline-flex items-center gap-1">
                  ASIN
                  {sortCol === "asin" && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                </span>
              </th>
            )}
            {visibleCols.filter((id) => id !== "asin").map((colId) => {
              const col = colMap.get(colId)!;
              const isActive = sortCol === colId;
              return (
                <th
                  key={colId}
                  className={`cursor-pointer select-none whitespace-nowrap hover:bg-muted/70 transition-colors px-3 py-2 text-xs font-medium ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${colId === "image" ? "w-[56px]" : ""}`}
                  onClick={() => onSort(colId)}
                  data-testid={`header-${colId}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {isActive && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedResults.map((result, idx) => {
            const { price, label } = getSelectedPrice(result, priceSource);
            const hasError = !!result.error;
            const notAvailable = price == null && !hasError;
            const prep = getEffectivePrep(result, settings);
            const storage = getEffectiveStorage(result, settings);
            const isBuy = buySet.has(result.asin);

            let rowBg = "";
            let profitData: ReturnType<typeof calculateProfit> | null = null;

            if (!hasError && price != null) {
              profitData = calculateProfit(
                price, result.cogs,
                result.feesData.fbaFulfillmentFee ?? 0,
                result.feesData.referralFee ?? 0,
                result.feesData.feesEstimatePrice,
                result.catalogData.weightLbs,
                prep.value, storage.value, settings
              );

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

            const buyHighlight = isBuy ? "!bg-blue-500/8 dark:!bg-blue-500/12" : "";
            const frozenBg = isBuy ? "bg-blue-50 dark:bg-blue-950/30" : "bg-background";

            return (
              <tr
                key={`${result.asin}-${idx}`}
                className={`${rowBg} ${buyHighlight} border-b border-border transition-colors hover:bg-muted/30`}
                data-testid={`row-result-${result.asin}`}
              >
                <td
                  className={`sticky left-0 z-10 text-center text-xs text-muted-foreground px-2 py-1.5 border-r border-border ${frozenBg}`}
                  style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}
                >
                  {idx + 1}
                </td>
                <td
                  className={`sticky z-10 text-center px-1 py-1.5 border-r border-border ${frozenBg}`}
                  style={{ left: buyLeft, width: frozenColWidth.buy, minWidth: frozenColWidth.buy }}
                >
                  <input
                    type="checkbox"
                    checked={isBuy}
                    onChange={() => onToggleBuy(result.asin)}
                    className="h-3.5 w-3.5 accent-blue-500 cursor-pointer"
                    data-testid={`checkbox-buy-${result.asin}`}
                  />
                </td>
                {asinVisible && (
                  <td
                    className={`sticky z-10 px-2 py-1.5 border-r border-border ${frozenBg}`}
                    style={{ left: asinLeft, width: frozenColWidth.asin, minWidth: frozenColWidth.asin }}
                  >
                    {renderCell("asin", result, price, label, hasError, profitData, settings, prep, storage)}
                  </td>
                )}
                {visibleCols.filter((id) => id !== "asin").map((colId) => {
                  const col = colMap.get(colId)!;
                  return (
                    <td
                      key={colId}
                      className={`px-3 py-1.5 ${col.align === "right" ? "text-right" : ""} ${
                        colId === "image" ? "p-1" : ""
                      }`}
                    >
                      {renderCell(colId, result, price, label, hasError, profitData, settings, prep, storage)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderCell(
  colId: ColumnId,
  result: AsinResult,
  price: number | null,
  priceLabel: string,
  hasError: boolean,
  profitData: ReturnType<typeof calculateProfit> | null,
  settings: Settings,
  prep: { value: number; isOverride: boolean },
  storage: { value: number; isOverride: boolean },
) {
  switch (colId) {
    case "asin":
      return (
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
      );

    case "image":
      return result.catalogData.imageUrl ? (
        <img
          src={result.catalogData.imageUrl}
          alt={result.catalogData.title ?? result.asin}
          className="w-10 h-10 object-contain rounded"
          loading="lazy"
          data-testid={`img-product-${result.asin}`}
        />
      ) : (
        <div className="w-10 h-10 bg-muted rounded flex items-center justify-center text-muted-foreground text-[10px]">
          N/A
        </div>
      );

    case "name": {
      const title = result.catalogData.title;
      if (!title) return <span className="text-muted-foreground text-sm">-</span>;
      const truncated = title.length > 40 ? title.substring(0, 40) + "…" : title;
      if (title.length > 40) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm cursor-help" data-testid={`text-name-${result.asin}`}>
                {truncated}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[350px]">
              <p className="text-xs">{title}</p>
            </TooltipContent>
          </Tooltip>
        );
      }
      return <span className="text-sm" data-testid={`text-name-${result.asin}`}>{title}</span>;
    }

    case "eligible": {
      const elig = result.eligibilityData;
      const status = elig?.status ?? "check";
      if (status === "yes") {
        return (
          <span
            className="text-sm font-medium text-emerald-500"
            data-testid={`text-eligible-${result.asin}`}
          >
            Yes
          </span>
        );
      }
      if (status === "no") {
        return (
          <span
            className="text-sm font-medium text-red-500"
            data-testid={`text-eligible-${result.asin}`}
          >
            No
          </span>
        );
      }
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="text-sm font-medium text-amber-500 cursor-default"
              data-testid={`text-eligible-${result.asin}`}
            >
              Check
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">FBA eligibility could not be determined — check manually</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    case "supplier": {
      const domain = extractDomain(result.buyLink);
      if (!domain) return <span className="text-muted-foreground text-sm">-</span>;
      return (
        <a
          href={result.buyLink!}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-primary text-sm hover:underline"
          data-testid={`link-supplier-${result.asin}`}
        >
          {domain}
          <ExternalLink className="h-3 w-3" />
        </a>
      );
    }

    case "cogs":
      return <span className="font-mono text-sm">{fmt(result.cogs)}</span>;

    case "salePrice":
      if (hasError) {
        const isRestricted = result.error?.includes("Restricted");
        const isNoData = result.error?.includes("No data") || result.error?.includes("No pricing");
        let errorLabel = "Error";
        if (isRestricted) errorLabel = "Restricted";
        else if (isNoData) errorLabel = "No data";
        return (
          <Tooltip>
            <TooltipTrigger>
              <span className="flex items-center gap-1 justify-end text-destructive text-sm font-medium">
                <AlertTriangle className="h-3 w-3" />
                {errorLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[300px]">
              <p className="text-xs">{result.error}</p>
            </TooltipContent>
          </Tooltip>
        );
      }
      if (price != null) {
        return (
          <div className="flex items-center gap-1.5 justify-end">
            <span className="font-mono text-sm">{fmt(price)}</span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {priceLabel}
            </Badge>
          </div>
        );
      }
      return <span className="text-muted-foreground text-sm">N/A</span>;

    case "profit":
      return (
        <span className={`font-mono text-sm font-semibold ${
          profitData
            ? profitData.profit >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
            : ""
        }`}>
          {profitData ? fmt(profitData.profit) : "-"}
        </span>
      );

    case "margin":
      return (
        <span className={`font-mono text-sm ${
          profitData
            ? profitData.margin >= settings.minMarginThreshold
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
            : ""
        }`}>
          {profitData ? fmtPct(profitData.margin) : "-"}
        </span>
      );

    case "roi":
      return (
        <span className={`font-mono text-sm ${
          profitData
            ? profitData.roi >= settings.minRoiThreshold
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
            : ""
        }`}>
          {profitData ? fmtPct(profitData.roi) : "-"}
        </span>
      );

    case "fbaFee":
      return <span className="font-mono text-sm">{profitData ? fmt(profitData.totalFbaFee) : fmt(result.feesData.fbaFulfillmentFee)}</span>;

    case "referralFee":
      return (
        <span className="font-mono text-sm">
          {profitData ? fmt(profitData.adjustedReferralFee) : fmt(result.feesData.referralFee)}
        </span>
      );

    case "inboundShipping": {
      if (profitData && profitData.inboundShipping == null) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-sm text-amber-500 cursor-help" data-testid={`text-inboundShipping-${result.asin}`}>
                ? <AlertTriangle className="inline h-3 w-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">Weight unavailable — inbound shipping could not be calculated</p>
            </TooltipContent>
          </Tooltip>
        );
      }
      return <span className="font-mono text-sm" data-testid={`text-inboundShipping-${result.asin}`}>{profitData ? fmt(profitData.inboundShipping ?? 0) : "-"}</span>;
    }

    case "prep":
      return (
        <span className="font-mono text-sm">
          {fmt(prep.value)}
          {prep.isOverride && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-primary ml-0.5 cursor-help">*</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Per-ASIN value from uploaded file</p>
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      );

    case "storage":
      return (
        <span className="font-mono text-sm">
          {fmt(storage.value)}
          {storage.isOverride && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-primary ml-0.5 cursor-help">*</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p className="text-xs">Per-ASIN value from uploaded file</p>
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      );

    case "bsr":
      return (
        <span className="text-sm whitespace-nowrap">
          {fmtBsr(result.catalogData.bsrRank, result.catalogData.bsrCategory)}
        </span>
      );

    case "sellersFba":
      return <span className="font-mono text-sm" data-testid={`text-sellersFba-${result.asin}`}>{result.pricingData.sellersFba !== null && result.pricingData.sellersFba !== undefined ? result.pricingData.sellersFba : "-"}</span>;

    case "sellersFbm":
      return <span className="font-mono text-sm" data-testid={`text-sellersFbm-${result.asin}`}>{result.pricingData.sellersFbm !== null && result.pricingData.sellersFbm !== undefined ? result.pricingData.sellersFbm : "-"}</span>;

    default:
      return "-";
  }
}
