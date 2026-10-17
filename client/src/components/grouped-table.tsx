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
  appliesDgHazmatSurcharge,
} from "@shared/schema";
import { type ColumnConfig } from "@/lib/columns";
import { type AnalyticsMetrics } from "@/lib/analytics";
import { ColumnFilterButton, type ColFilter, type FilterMap, type MultiSelectOption } from "./column-filter";
import { useTagGroups, compareTagKeys } from "@/lib/use-tag-groups";
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
  startIndex?: number;
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
  product: 400, category: 160, brand: 100, supplier: 100,
  stock: 75, availableFba: 80, onOrder: 80, atPrep: 75, reserved: 75, sentToFba: 80, daysLeft: 80,
  cogs: 90, actPrepCost: 85, actUnitsSold: 85, actRefunds: 80, actRefundPct: 80,
  actAvgSalePrice: 100, actRevenue: 95, actProfit: 100, actProfitPerUnit: 90, actRoi: 80, actMargin: 80,
  estCogs: 90, salePrice: 95, profit: 90, margin: 80, roi: 80,
  fbaFee: 85, referralFee: 95, inboundShipping: 100, prep: 85, storage: 105, maxCogs: 90,
  sellersFba: 85, sellers: 80, sellers7d: 85, sellers30d: 90, fba7d: 80, fba30d: 85,
  tags: 100, notes: 100, sourcing: 80, meltable: 85, hazmat: 80, suppressed: 90, dateAdded: 95,
};

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
  startIndex = 0,
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
  const tagMeta = useTagGroups();
  const tagOptions: MultiSelectOption[] = useMemo(() => {
    const counts = new Map<string, { color: string; count: number; name: string }>();
    let noTagCount = 0;
    for (const r of allResults) {
      if (!r.tags || r.tags.length === 0) { noTagCount++; continue; }
      for (const t of r.tags) {
        const key = t.name.toLowerCase();
        const existing = counts.get(key);
        if (existing) existing.count++; else counts.set(key, { color: t.color, count: 1, name: t.name });
      }
    }
    const opts: MultiSelectOption[] = [{ value: "__none__", label: "No tags", count: noTagCount }];
    for (const [key, { color, count, name }] of Array.from(counts.entries()).sort((a, b) => compareTagKeys(a[0], b[0], tagMeta))) {
      opts.push({ value: key, label: name, color, count, group: tagMeta.get(key)?.group ?? undefined });
    }
    return opts;
  }, [allResults, tagMeta]);

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
    // Column order locked to schema definition
    () => ALL_COLUMNS.map((c) => c.id).filter((id) => columnConfig.visible.has(id) && colMap.has(id)),
    [columnConfig, colMap],
  );
  const dataCols = visibleCols.filter((id) => id !== "product");
  const productVisible = visibleCols.includes("product");
  // Group band was removed — these are no longer needed

  if (groups.length === 0) return null;

  const frozenColWidth = { rowNum: 36, sel: 32 };
  const selLeft = frozenColWidth.rowNum;
  const productLeft = selLeft + frozenColWidth.sel;

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
    <div className="w-full overflow-auto relative" style={{ maxHeight: "calc(100vh - 280px)" }}>
      <table className="border-collapse text-sm w-full">
        <thead className="sticky top-0 z-20">
          {/* Column header row */}
          <tr className="table-header-stone">
            <th className="sticky left-0 z-30 table-header-stone text-center text-xs font-medium px-1 py-2" style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>#</th>
            <th className="sticky z-30 table-header-stone text-center text-xs font-medium px-1 py-2" style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
              <input type="checkbox" className="h-3.5 w-3.5 accent-blue-500 cursor-pointer" disabled />
            </th>
            {productVisible && (
              <th className="sticky z-30 table-header-stone text-left text-xs font-medium px-2 py-2 relative" style={{ left: productLeft, width: colWidths["product"] ?? DEFAULT_COL_WIDTHS.product, minWidth: 200, borderRight: "0.5px solid hsl(var(--border))" }}>
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
                  className={`relative cursor-pointer select-none hover:opacity-80 transition-colors px-2 py-2 text-xs font-medium overflow-hidden ${col.align === "right" ? "text-right" : "text-left"}`}
                  style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}
                  onClick={() => onSort(colId)}
                >
                  <span className="inline-flex items-center gap-1 pr-2 overflow-hidden">
                    <span className={`flex flex-col leading-tight ${col.qualifier ? "" : "justify-end"}`}>
                      {col.qualifier && <span className="text-[9px] opacity-60">{col.qualifier}</span>}
                      <span>{col.label}</span>
                    </span>
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
          {groups.map((group, groupIdx) => {
            const isExpanded = expandedGroups.has(group.key);
            const m = group.metrics;
            return (
              <GroupRows
                key={group.key}
                group={group}
                groupIndex={startIndex + groupIdx + 1}
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
                productLeft={productLeft}
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
  group, groupIndex, isExpanded, onToggle, dataCols, productVisible, colWidths,
  colMap, priceSource, settings, includeInboundShipping,
  selectedSet, onToggleSelect, frozenColWidth, selLeft, productLeft,
}: {
  group: GroupData;
  groupIndex: number;
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
  productLeft: number;
}) {
  const m = group.metrics;
  const Chevron = isExpanded ? ChevronDown : ChevronRight;

  return (
    <>
      {/* Group summary row */}
      <tr
        className="bg-muted/40 dark:bg-muted/20 hover:bg-muted/60 cursor-pointer transition-colors table-zebra-stone"
        onClick={onToggle}
      >
        <td className="sticky left-0 z-10 text-center px-1 py-2 bg-muted/40 dark:bg-muted/20" style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>
          <Chevron className="h-3.5 w-3.5 mx-auto text-muted-foreground" />
        </td>
        <td className="sticky z-10 text-center px-1 py-2 bg-muted/40 dark:bg-muted/20" style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
          <span className="text-xs text-muted-foreground font-semibold">{groupIndex}</span>
        </td>
        {productVisible && (
          <td className="sticky z-10 px-2 py-2 bg-muted/40 dark:bg-muted/20" style={{ left: productLeft, width: colWidths["product"] ?? (DEFAULT_COL_WIDTHS.product ?? 400), minWidth: 200, borderRight: "0.5px solid hsl(var(--border))" }}>
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

        if (!hasError && price != null && result.estimatedCogs != null) {
          profitData = calculateProfit(price, result.estimatedCogs, result.feesData.fbaFulfillmentFee ?? 0, result.feesData.referralFee ?? 0, result.feesData.feesEstimatePrice, result.catalogData.weightLbs, prep.value, storage.value, settings, includeInboundShipping, appliesDgHazmatSurcharge(result), result.category ?? null);
        }
        if (price == null || hasError) rowBg = "opacity-50";

        const isSelected = selectedSet.has(result.asin);
        const frozenBg = isSelected ? "bg-blue-50 dark:bg-blue-950/30" : "bg-background";

        return (
          <tr key={`${result.asin}-${idx}`} className={`${rowBg} ${isSelected ? "!bg-blue-500/8 dark:!bg-blue-500/12" : ""} transition-colors hover:bg-muted/30 table-zebra-stone`}>
            <td className={`sticky left-0 z-10 text-center text-xs text-muted-foreground px-1 py-1.5 ${frozenBg}`} style={{ width: frozenColWidth.rowNum, minWidth: frozenColWidth.rowNum }}>
              {idx + 1}
            </td>
            <td className={`sticky z-10 text-center px-1 py-1.5 ${frozenBg}`} style={{ left: selLeft, width: frozenColWidth.sel, minWidth: frozenColWidth.sel }}>
              <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(result.asin)} className="h-3.5 w-3.5 accent-blue-500 cursor-pointer" />
            </td>
            {productVisible && (
              <td className={`sticky z-10 px-2 py-1.5 overflow-hidden ${frozenBg}`} style={{ left: productLeft, width: colWidths["product"] ?? (DEFAULT_COL_WIDTHS.product ?? 400), minWidth: 200, maxWidth: colWidths["product"] ?? (DEFAULT_COL_WIDTHS.product ?? 400), borderRight: "0.5px solid hsl(var(--border))" }}>
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
