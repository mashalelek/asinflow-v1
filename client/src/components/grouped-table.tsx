import { useMemo, useState, useRef, useCallback } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronRight, ChevronDown, ArrowUp, ArrowDown } from "lucide-react";
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
import { type AnalyticsMetrics } from "@/lib/analytics";
import { ColumnFilterButton, type ColFilter, type FilterMap, type MultiSelectOption } from "./column-filter";
import { renderCell } from "./results-table";

// ── Types ────────────────────────────────────────────────────────────
export interface GroupData {
  key: string;
  label: string;
  rows: AsinResult[];
  metrics: AnalyticsMetrics;
}

interface GroupedTableProps {
  groups: GroupData[];
  priceSource: PriceSource;
  settings: Settings;
  columnConfig: ColumnConfig;
  expandedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  sortCol: ColumnId | null;
  sortDir: "asc" | "desc";
  onSort: (colId: ColumnId) => void;
  includeInboundShipping: boolean;
  dateRangeLabel?: string;
  colFilters: FilterMap;
  onFilterApply: (f: ColFilter) => void;
  onFilterClear: (colId: ColumnId) => void;
  selectedSet: Set<string>;
  onToggleSelect: (asin: string) => void;
  allResults: AsinResult[];
}

// ── Column helpers ───────────────────────────────────────────────────
const DEFAULT_COL_WIDTHS: Partial<Record<ColumnId, number>> = {
  product: 400, brand: 100, supplier: 100, cogs: 80, salePrice: 90,
  profit: 90, margin: 75, roi: 75, fbaFee: 80, referralFee: 85,
  inboundShipping: 85, prep: 80, storage: 80, bsr: 90, sellersFba: 80,
  sellersFbm: 80, fba7d: 75, fba30d: 80, fbm7d: 75, fbm30d: 80,
  tags: 100, notes: 100, stock: 75, daysLeft: 80, actUnitsSold: 80,
  actRevenue: 90, actRefunds: 75, actRefundPct: 75, actProfit: 90,
  actProfitPerUnit: 85, actMargin: 75, actRoi: 75, meltable: 85,
  hazmat: 80, suppressed: 90, lastReviewed: 100, dateAdded: 95,
  category: 160, maxCogs: 90,
};

const ESTIMATES_COLS = new Set<ColumnId>([
  "salePrice", "cogs", "profit", "margin", "roi",
  "fbaFee", "referralFee", "inboundShipping", "prep", "storage",
  "bsr", "sellersFba", "sellersFbm",
  "fba7d", "fba30d", "fbm7d", "fbm30d",
]);
const ACTUALS_COLS = new Set<ColumnId>([
  "actUnitsSold", "actRevenue", "actRefunds", "actRefundPct",
  "actProfit", "actProfitPerUnit", "actMargin", "actRoi",
]);

function fmt(value: number | null): string {
  if (value == null) return "\u2014";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(value: number | null): string {
  if (value == null) return "\u2014";
  return `${value.toFixed(1)}%`;
}

function fmtInt(value: number | null): string {
  if (value == null) return "\u2014";
  return value.toLocaleString();
}

/** Map a column ID to its corresponding group-level metric value. */
function getGroupCellValue(colId: ColumnId, m: AnalyticsMetrics): string {
  switch (colId) {
    case "salePrice": return fmt(m.avgSalePrice);
    case "cogs": return fmt(m.avgCogs);
    case "profit": return fmt(m.estProfitPerUnit);
    case "margin": return fmtPct(m.estMargin);
    case "roi": return fmtPct(m.estRoi);
    case "maxCogs": return fmt(m.avgMaxCogs);
    case "actUnitsSold": return fmtInt(m.totalUnitsSold);
    case "actRevenue": return fmt(m.totalRevenue);
    case "actProfit": return fmt(m.totalProfit);
    case "actProfitPerUnit": return fmt(m.actProfitPerUnit);
    case "actMargin": return fmtPct(m.actMargin);
    case "actRoi": return fmtPct(m.actRoi);
    default: return "\u2014";
  }
}

// ── Component ────────────────────────────────────────────────────────
export function GroupedTable({
  groups,
  priceSource,
  settings,
  columnConfig,
  expandedGroups,
  onToggleGroup,
  sortCol,
  sortDir,
  onSort,
  includeInboundShipping,
  dateRangeLabel,
  colFilters,
  onFilterApply,
  onFilterClear,
  selectedSet,
  onToggleSelect,
  allResults,
}: GroupedTableProps) {
  const colMap = useMemo(() => new Map(ALL_COLUMNS.map((c) => [c.id, c])), []);

  // Column resize state
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try { const s = localStorage.getItem("fba-col-widths"); if (s) return JSON.parse(s); } catch {} return {};
  });
  const resizeRef = useRef<{ colId: string; startX: number; startW: number } | null>(null);
  const widthSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const saveWidths = useCallback((widths: Record<string, number>) => {
    clearTimeout(widthSaveTimer.current);
    widthSaveTimer.current = setTimeout(() => localStorage.setItem("fba-col-widths", JSON.stringify(widths)), 300);
  }, []);
  const handleResizeStart = useCallback((e: React.MouseEvent, colId: string) => {
    e.preventDefault(); e.stopPropagation();
    const th = (e.target as HTMLElement).closest("th");
    if (!th) return;
    const startW = th.getBoundingClientRect().width;
    resizeRef.current = { colId, startX: e.clientX, startW };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = ev.clientX - resizeRef.current.startX;
      const newW = Math.max(50, resizeRef.current.startW + delta);
      setColWidths((prev) => { const next = { ...prev, [resizeRef.current!.colId]: newW }; saveWidths(next); return next; });
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  }, [saveWidths]);

  // Multi-select filter options
  const tagOptions: MultiSelectOption[] = useMemo(() => {
    const counts = new Map<string, { color: string; count: number }>();
    let noTagCount = 0;
    for (const r of allResults) {
      if (!r.tags || r.tags.length === 0) { noTagCount++; continue; }
      for (const t of r.tags) {
        const key = t.name.toLowerCase();
        const existing = counts.get(key);
        if (existing) existing.count++; else counts.set(key, { color: t.color, count: 1 });
      }
    }
    const opts: MultiSelectOption[] = [{ value: "__none__", label: "No tags", count: noTagCount }];
    for (const [key, { color, count }] of Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      opts.push({ value: key, label: key.charAt(0).toUpperCase() + key.slice(1), color, count });
    }
    return opts;
  }, [allResults]);

  const supplierOptions: MultiSelectOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    let noCount = 0;
    for (const r of allResults) {
      const d = extractDomain(r.buyLink);
      if (!d) { noCount++; continue; }
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const opts: MultiSelectOption[] = [{ value: "__none__", label: "No supplier", count: noCount }];
    for (const [d, c] of Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))) opts.push({ value: d, label: d, count: c });
    return opts;
  }, [allResults]);

  const categoryOptions: MultiSelectOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    let noCount = 0;
    for (const r of allResults) {
      const cat = r.category;
      if (!cat) { noCount++; continue; }
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    const opts: MultiSelectOption[] = [{ value: "__none__", label: "No category", count: noCount }];
    for (const [cat, c] of Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))) opts.push({ value: cat.toLowerCase(), label: cat, count: c });
    return opts;
  }, [allResults]);

  const visibleCols = useMemo(
    () => columnConfig.order.filter((id) => columnConfig.visible.has(id) && colMap.has(id)),
    [columnConfig, colMap],
  );
  const dataCols = visibleCols.filter((id) => id !== "product");
  const productVisible = visibleCols.includes("product");
  const estimatesCount = dataCols.filter((id) => ESTIMATES_COLS.has(id)).length;
  const actualsCount = dataCols.filter((id) => ACTUALS_COLS.has(id)).length;
  const hasGroups = estimatesCount > 0 || actualsCount > 0;

  if (groups.length === 0) return null;

  const frozenColWidth = { rowNum: 36, sel: 32 };
  const selLeft = frozenColWidth.rowNum;

  function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
    const lineRef = useRef<HTMLDivElement>(null);
    return (
      <div onMouseDown={onMouseDown}
        onMouseEnter={() => { if (lineRef.current) lineRef.current.style.background = "hsl(var(--primary) / 0.5)"; }}
        onMouseLeave={() => { if (lineRef.current) lineRef.current.style.background = "transparent"; }}
        style={{ position: "absolute", right: -3, top: 0, bottom: 0, width: 7, cursor: "col-resize", zIndex: 10 }}
      >
        <div ref={lineRef} style={{ position: "absolute", right: 3, top: "15%", bottom: "15%", width: 2, borderRadius: 1, background: "transparent", transition: "background 0.15s" }} />
      </div>
    );
  }

  return (
    <div className="w-full overflow-auto relative border-y border-border" style={{ maxHeight: "calc(100vh - 280px)" }}>
      <table className="border-collapse text-sm w-full">
        <thead className="sticky top-0 z-20">
          {/* Group header row (Estimates / Actuals labels) */}
          {hasGroups && (
            <tr className="border-b border-border bg-muted backdrop-blur">
              <th className="sticky left-0 z-30 bg-muted border-r border-border" style={{ width: frozenColWidth.rowNum }} />
              <th className="sticky z-30 bg-muted border-r border-border" style={{ left: selLeft, width: frozenColWidth.sel }} />
              {productVisible && <th className="bg-muted border-r border-border" />}
              {dataCols.map((colId, i) => {
                if (ESTIMATES_COLS.has(colId) && (i === 0 || !ESTIMATES_COLS.has(dataCols[i - 1]))) {
                  return <th key={`grp-est-${i}`} colSpan={estimatesCount} className="text-center text-xs font-semibold text-muted-foreground px-3 py-1 border-r border-border bg-blue-500/5">Estimates</th>;
                }
                if (ESTIMATES_COLS.has(colId)) return null;
                if (ACTUALS_COLS.has(colId) && (i === 0 || !ACTUALS_COLS.has(dataCols[i - 1]))) {
                  return <th key={`grp-act-${i}`} colSpan={actualsCount} className="text-center text-xs font-semibold text-muted-foreground px-3 py-1 border-r border-border bg-emerald-500/5">Actuals{dateRangeLabel ? ` (${dateRangeLabel})` : ""}</th>;
                }
                if (ACTUALS_COLS.has(colId)) return null;
                return <th key={`grp-other-${colId}`} className="bg-muted" />;
              })}
            </tr>
          )}
          {/* Column header row */}
          <tr className="border-b border-border bg-muted/80 backdrop-blur">
            <th className="sticky left-0 z-30 bg-muted text-center text-xs font-medium text-muted-foreground px-1 py-2 border-r border-border" style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>#</th>
            <th className="sticky z-30 bg-muted text-center text-xs font-medium text-muted-foreground px-1 py-2 border-r border-border" style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
              <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500 cursor-pointer" disabled />
            </th>
            {productVisible && (
              <th className="text-left text-xs font-medium px-2 py-2 border-r border-border relative" style={{ width: colWidths["product"] ?? DEFAULT_COL_WIDTHS.product, minWidth: 200 }}>
                Product
                <ResizeHandle onMouseDown={(e) => handleResizeStart(e, "product")} />
              </th>
            )}
            {dataCols.map((colId) => {
              const col = colMap.get(colId)!;
              const isActive = sortCol === colId;
              const w = colWidths[colId] ?? DEFAULT_COL_WIDTHS[colId];
              return (
                <th key={colId}
                  className={`relative cursor-pointer select-none whitespace-nowrap hover:bg-muted/70 transition-colors px-3 py-2 text-xs font-medium ${col.align === "right" ? "text-right" : "text-left"} ${ESTIMATES_COLS.has(colId) ? "bg-blue-500/5" : ACTUALS_COLS.has(colId) ? "bg-emerald-500/5" : ""}`}
                  style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}
                  onClick={() => onSort(colId)}
                >
                  <span className="inline-flex items-center gap-1 pr-2 overflow-hidden">
                    {col.label}
                    {isActive && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                    <ColumnFilterButton
                      colId={colId}
                      currentFilter={colFilters[colId]}
                      onApply={onFilterApply}
                      onClear={() => onFilterClear(colId)}
                      multiSelectOptions={colId === "tags" ? tagOptions : colId === "supplier" ? supplierOptions : colId === "category" ? categoryOptions : undefined}
                    />
                  </span>
                  <ResizeHandle onMouseDown={(e) => { e.stopPropagation(); handleResizeStart(e, colId); }} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const isExpanded = expandedGroups.has(group.key);
            const m = group.metrics;
            return (
              <GroupRows
                key={group.key}
                group={group}
                isExpanded={isExpanded}
                onToggle={() => onToggleGroup(group.key)}
                dataCols={dataCols}
                productVisible={productVisible}
                colWidths={colWidths}
                colMap={colMap}
                priceSource={priceSource}
                settings={settings}
                includeInboundShipping={includeInboundShipping}
                selectedSet={selectedSet}
                onToggleSelect={onToggleSelect}
                frozenColWidth={frozenColWidth}
                selLeft={selLeft}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Group row + child rows ───────────────────────────────────────────
function GroupRows({
  group, isExpanded, onToggle, dataCols, productVisible, colWidths,
  colMap, priceSource, settings, includeInboundShipping,
  selectedSet, onToggleSelect, frozenColWidth, selLeft,
}: {
  group: GroupData;
  isExpanded: boolean;
  onToggle: () => void;
  dataCols: ColumnId[];
  productVisible: boolean;
  colWidths: Record<string, number>;
  colMap: Map<ColumnId, { id: ColumnId; label: string; align: "left" | "right" }>;
  priceSource: PriceSource;
  settings: Settings;
  includeInboundShipping: boolean;
  selectedSet: Set<string>;
  onToggleSelect: (asin: string) => void;
  frozenColWidth: { rowNum: number; sel: number };
  selLeft: number;
}) {
  const m = group.metrics;
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  return (
    <>
      {/* Group summary row */}
      <tr
        className="border-b border-border bg-muted/40 dark:bg-muted/20 hover:bg-muted/60 cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="sticky left-0 z-10 text-center px-1 py-2 border-r border-border bg-muted/40 dark:bg-muted/20" style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>
          <Chevron className="h-3.5 w-3.5 mx-auto text-muted-foreground" />
        </td>
        <td className="sticky z-10 text-center px-1 py-2 border-r border-border bg-muted/40 dark:bg-muted/20" style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
          <span className="text-xs text-muted-foreground font-semibold">{group.rows.length}</span>
        </td>
        {productVisible && (
          <td className="px-2 py-2 border-r border-border" style={{ width: colWidths["product"] ?? (DEFAULT_COL_WIDTHS.product ?? 400), minWidth: 200 }}>
            <span className="font-semibold text-sm">{group.label}</span>
            <span className="text-xs text-muted-foreground ml-2">({group.rows.length} ASINs)</span>
          </td>
        )}
        {dataCols.map((colId) => {
          const col = colMap.get(colId)!;
          const w = colWidths[colId] ?? DEFAULT_COL_WIDTHS[colId];
          const cellValue = getGroupCellValue(colId, m);
          return (
            <td key={colId} className={`px-3 py-2 font-mono text-sm font-medium ${col.align === "right" ? "text-right" : ""}`} style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}>
              {cellValue}
            </td>
          );
        })}
      </tr>

      {/* Expanded ASIN rows */}
      {isExpanded && group.rows.map((result, idx) => {
        const { price, label, isFallback: priceFallback } = getSelectedPrice(result, priceSource);
        const hasError = !!result.error;
        const prep = getEffectivePrep(result, settings);
        const storage = getEffectiveStorage(result, settings);
        let profitData: ReturnType<typeof calculateProfit> | null = null;
        let rowBg = "";

        if (!hasError && price != null) {
          profitData = calculateProfit(price, result.cogs, result.feesData.fbaFulfillmentFee ?? 0, result.feesData.referralFee ?? 0, result.feesData.feesEstimatePrice, result.catalogData.weightLbs, prep.value, storage.value, settings, includeInboundShipping, result.isHazmat ?? false);
          const meets = profitData.roi >= settings.minRoiThreshold && profitData.margin >= settings.minMarginThreshold;
          rowBg = meets ? "bg-emerald-500/8 dark:bg-emerald-500/10" : "bg-red-500/8 dark:bg-red-500/10";
        }
        if (price == null || hasError) rowBg = "opacity-50";

        const isSelected = selectedSet.has(result.asin);
        const frozenBg = isSelected ? "bg-blue-50 dark:bg-blue-950/30" : "bg-background";

        return (
          <tr key={`${result.asin}-${idx}`} className={`${rowBg} ${isSelected ? "!bg-blue-500/8 dark:!bg-blue-500/12" : ""} border-b border-border transition-colors hover:bg-muted/30`}>
            <td className={`sticky left-0 z-10 text-center text-xs text-muted-foreground px-1 py-1.5 border-r border-border ${frozenBg}`} style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>
              {idx + 1}
            </td>
            <td className={`sticky z-10 text-center px-1 py-1.5 border-r border-border ${frozenBg}`} style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
              <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(result.asin)} className="h-3.5 w-3.5 accent-blue-500 cursor-pointer" />
            </td>
            {productVisible && (
              <td className="px-2 py-1.5 border-r border-border overflow-hidden" style={{ width: colWidths["product"] ?? (DEFAULT_COL_WIDTHS.product ?? 400), minWidth: 200, maxWidth: colWidths["product"] ?? (DEFAULT_COL_WIDTHS.product ?? 400) }}>
                <div className="flex items-start gap-2">
                  {result.catalogData.imageUrl && (
                    <img src={result.catalogData.imageUrl} alt="" className="w-[40px] h-[40px] object-contain rounded flex-shrink-0" loading="lazy" />
                  )}
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-1 text-xs">
                      <a href={`https://amazon.com/dp/${result.asin}`} target="_blank" rel="noopener noreferrer" className="text-primary font-mono hover:underline" onClick={(e) => e.stopPropagation()}>{result.asin}</a>
                      {result.sku && <span className="text-muted-foreground truncate max-w-[100px]">· {result.sku}</span>}
                    </div>
                    {result.catalogData.title && <div className="text-sm truncate">{result.catalogData.title}</div>}
                  </div>
                </div>
              </td>
            )}
            {dataCols.map((colId) => {
              const col = colMap.get(colId)!;
              const w = colWidths[colId] ?? DEFAULT_COL_WIDTHS[colId];
              const content = renderCell(colId, result, price, label, hasError, profitData, settings, prep, storage, includeInboundShipping, priceFallback);
              return (
                <td key={colId} className={`px-3 py-1.5 overflow-hidden ${col.align === "right" ? "text-right" : ""}`} style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}>
                  {content}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}
