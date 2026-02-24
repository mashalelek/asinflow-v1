import { useState, useMemo } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
} from "@shared/schema";
import { type ColumnConfig } from "@/lib/columns";

interface ResultsTableProps {
  results: AsinResult[];
  priceSource: PriceSource;
  settings: Settings;
  columnConfig: ColumnConfig;
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

type SortDir = "asc" | "desc";

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
      result.catalogData.weightLbs ?? 0,
      prep.value,
      storage.value,
      settings
    );
  }

  switch (colId) {
    case "asin": return result.asin;
    case "image": return result.catalogData.imageUrl;
    case "name": return result.catalogData.title;
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

export function ResultsTable({ results, priceSource, settings, columnConfig }: ResultsTableProps) {
  const [sortCol, setSortCol] = useState<ColumnId | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const colMap = useMemo(() => new Map(ALL_COLUMNS.map((c) => [c.id, c])), []);

  const visibleCols = useMemo(
    () => columnConfig.order.filter((id) => columnConfig.visible.has(id)),
    [columnConfig]
  );

  const sortedResults = useMemo(() => {
    if (!sortCol) return results;
    const sorted = [...results].sort((a, b) => {
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
  }, [results, sortCol, sortDir, priceSource, settings]);

  const handleSort = (colId: ColumnId) => {
    if (sortCol === colId) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(colId);
      setSortDir("asc");
    }
  };

  if (results.length === 0) return null;

  return (
    <div className="w-full overflow-auto border rounded-md" style={{ maxHeight: "calc(100vh - 280px)" }}>
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="border-b border-border">
            {visibleCols.map((colId) => {
              const col = colMap.get(colId)!;
              const isActive = sortCol === colId;
              return (
                <TableHead
                  key={colId}
                  className={`cursor-pointer select-none whitespace-nowrap hover:bg-muted/50 transition-colors ${
                    col.align === "right" ? "text-right" : ""
                  } ${colId === "image" ? "w-[56px]" : ""}`}
                  onClick={() => handleSort(colId)}
                  data-testid={`header-${colId}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {isActive && (
                      sortDir === "asc"
                        ? <ArrowUp className="h-3 w-3" />
                        : <ArrowDown className="h-3 w-3" />
                    )}
                  </span>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedResults.map((result, idx) => {
            const { price, label } = getSelectedPrice(result, priceSource);
            const hasError = !!result.error;
            const notAvailable = price == null && !hasError;
            const prep = getEffectivePrep(result, settings);
            const storage = getEffectiveStorage(result, settings);

            let rowBg = "";
            let profitData: ReturnType<typeof calculateProfit> | null = null;

            if (!hasError && price != null) {
              profitData = calculateProfit(
                price, result.cogs,
                result.feesData.fbaFulfillmentFee ?? 0,
                result.feesData.referralFee ?? 0,
                result.feesData.feesEstimatePrice,
                result.catalogData.weightLbs ?? 0,
                prep.value,
                storage.value,
                settings
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

            return (
              <TableRow
                key={`${result.asin}-${idx}`}
                className={`${rowBg} transition-colors`}
                data-testid={`row-result-${result.asin}`}
              >
                {visibleCols.map((colId) => {
                  const col = colMap.get(colId)!;
                  return (
                    <TableCell
                      key={colId}
                      className={`${col.align === "right" ? "text-right" : ""} ${
                        colId === "image" ? "p-1" : ""
                      }`}
                    >
                      {renderCell(colId, result, price, label, hasError, profitData, settings, prep, storage)}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
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

    case "cogs":
      return <span className="font-mono text-sm">{fmt(result.cogs)}</span>;

    case "salePrice":
      if (hasError) {
        return (
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

    case "inboundShipping":
      return <span className="font-mono text-sm">{profitData ? fmt(profitData.inboundShipping) : "-"}</span>;

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
      return <span className="font-mono text-sm">{result.pricingData.sellersFba != null ? result.pricingData.sellersFba : "-"}</span>;

    case "sellersFbm":
      return <span className="font-mono text-sm">{result.pricingData.sellersFbm != null ? result.pricingData.sellersFbm : "-"}</span>;

    default:
      return "-";
  }
}
