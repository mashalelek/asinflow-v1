import { useState, useCallback, useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsDialog } from "@/components/settings-dialog";
import { ResultsTable, getRowValue } from "@/components/results-table";
import { GroupedTable, type GroupData } from "@/components/grouped-table";
import { ColumnManager } from "@/components/column-manager";
// Theme toggle is now in the top nav
import { loadSettings } from "@/lib/settings";
import { loadColumnConfig, type ColumnConfig } from "@/lib/columns";
import { Sun, Moon, BarChart3, Search, X, Filter } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { VisibilityToggles, loadShowGated, saveShowGated, loadShowMeltable, saveShowMeltable, loadShowArchived, saveShowArchived } from "@/components/visibility-toggles";
import { ActiveFiltersModal, getActiveFilterCount } from "@/components/active-filters-modal";
import { Input } from "@/components/ui/input";
import {
  type AsinResult,
  type PriceSource,
  type Settings,
  type ColumnId,
  getSelectedPrice,
} from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { useDateRange } from "@/contexts/date-range-context";
import { type ColFilter, type FilterMap, matchesFilters } from "@/components/column-filter";
import { computeAnalyticsMetrics } from "@/lib/analytics";
import { MetricTile, DualMetricTile } from "@/components/metric-tile";
import { ExportButtons } from "@/components/export-buttons";
import {
  getEffectivePrep,
  getEffectiveStorage,
  calculateProfit,
  extractDomain,
  calculateMaxCogs,
  appliesDgHazmatSurcharge,
} from "@shared/schema";

// ── localStorage keys (analytics-specific to avoid collisions) ──────
const A_DATE_PREFS_KEY = "fba-analytics-date-prefs";
const A_COL_CONFIG_KEY = "fba-analytics-col-config";
const A_COL_FILTERS_KEY = "fba-analytics-col-filters";
const A_SORT_KEY = "fba-analytics-sort";
const A_PAGE_SIZE_KEY = "fba-analytics-page-size";
const A_INBOUND_KEY = "fba-analytics-include-inbound";

function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function computeDateRange(preset: string, customStart: string, customEnd: string) {
  const today = new Date();
  if (preset === "last14") {
    const s = new Date(today); s.setDate(s.getDate() - 13);
    return { startDate: fmtDate(s), endDate: fmtDate(today) };
  }
  if (preset === "thisMonth") {
    const s = new Date(today.getFullYear(), today.getMonth(), 1);
    return { startDate: fmtDate(s), endDate: fmtDate(today) };
  }
  if (preset === "lastMonth") {
    const s = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const e = new Date(today.getFullYear(), today.getMonth(), 0);
    return { startDate: fmtDate(s), endDate: fmtDate(e) };
  }
  if (preset === "custom") return { startDate: customStart, endDate: customEnd };
  const s = new Date(today); s.setDate(s.getDate() - 29);
  return { startDate: fmtDate(s), endDate: fmtDate(today) };
}

function formatDateLabel(start: string, end: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const s = new Date(start + "T12:00:00").toLocaleDateString("en-US", opts);
  const e = new Date(end + "T12:00:00").toLocaleDateString("en-US", opts);
  return `${s} \u2013 ${e}`;
}

function loadDatePrefs() {
  try { const s = localStorage.getItem(A_DATE_PREFS_KEY); if (s) return JSON.parse(s); } catch {}
  return { preset: "last30", customStart: "", customEnd: "" };
}

function loadColConfig(): ColumnConfig {
  try {
    const s = localStorage.getItem(A_COL_CONFIG_KEY);
    if (s) {
      const p = JSON.parse(s);
      return { order: p.order, visible: new Set(p.visible) };
    }
  } catch {}
  return loadColumnConfig(); // fall back to main table config
}

function saveColConfig(config: ColumnConfig) {
  localStorage.setItem(A_COL_CONFIG_KEY, JSON.stringify({ order: config.order, visible: Array.from(config.visible) }));
}

function loadColFilters(): FilterMap {
  try { const s = localStorage.getItem(A_COL_FILTERS_KEY); if (s) return JSON.parse(s); } catch {}
  return {};
}

export default function Analytics() {
  // Theme toggle moved to top nav
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(loadColConfig);
  const [results, setResults] = useState<AsinResult[]>([]);
  const [priceSource, setPriceSource] = useState<PriceSource>("lowestFba");
  const [dbLoaded, setDbLoaded] = useState(false);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  const [sortCol, setSortCol] = useState<ColumnId | null>(() => {
    try { const s = localStorage.getItem(A_SORT_KEY); if (s) return JSON.parse(s).col; } catch {} return "roi";
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    try { const s = localStorage.getItem(A_SORT_KEY); if (s) return JSON.parse(s).dir; } catch {} return "desc";
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [colFilters, setColFilters] = useState<FilterMap>(loadColFilters);
  const [showGated, setShowGated] = useState(loadShowGated);
  const [showMeltable, setShowMeltable] = useState(loadShowMeltable);
  const [showArchived, setShowArchived] = useState(loadShowArchived);
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => {
    try { const v = localStorage.getItem(A_PAGE_SIZE_KEY); return v ? parseInt(v) : 100; } catch { return 100; }
  });
  const [includeInboundShipping, setIncludeInboundShipping] = useState(() => {
    try { const v = localStorage.getItem(A_INBOUND_KEY); if (v !== null) return v === "true"; } catch {} return true;
  });

  // Grouping — persisted in URL query param
  type GroupByOption = "none" | "category" | "brand" | "supplier";
  const searchStr = useSearch();
  const [, setLocation] = useLocation();
  const groupBy: GroupByOption = useMemo(() => {
    const params = new URLSearchParams(searchStr);
    const v = params.get("groupBy");
    if (v === "category" || v === "brand" || v === "supplier") return v;
    return "none";
  }, [searchStr]);
  const setGroupBy = useCallback((v: GroupByOption) => {
    const params = new URLSearchParams(searchStr);
    if (v === "none") params.delete("groupBy"); else params.set("groupBy", v);
    const qs = params.toString();
    setLocation(`/analytics${qs ? `?${qs}` : ""}`, { replace: true });
  }, [searchStr, setLocation]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Collapse all when groupBy changes
  useEffect(() => { setExpandedGroups(new Set()); setPage(1); }, [groupBy]);

  // Date range is global (top-nav DataStudioDatePicker), shared across pages.
  const { range: dateRange } = useDateRange();
  const startDate = dateRange.start;
  const endDate = dateRange.end;
  const dateRangeLabel = useMemo(() => formatDateLabel(startDate, endDate), [startDate, endDate]);

  // Persist prefs (date range persisted by DateRangeContext)
  useEffect(() => { localStorage.setItem(A_INBOUND_KEY, String(includeInboundShipping)); }, [includeInboundShipping]);
  useEffect(() => { localStorage.setItem(A_COL_FILTERS_KEY, JSON.stringify(colFilters)); }, [colFilters]);

  // Fetch data
  const fetchAsins = useCallback((start: string, end: string, archived = false) => {
    return fetch(`/api/asins?startDate=${start}&endDate=${end}${archived ? "&includeArchived=true" : ""}`)
      .then((r) => r.json())
      .then((data: AsinResult[]) => { if (data.length > 0) setResults(data); setDbLoaded(true); })
      .catch(() => setDbLoaded(true));
  }, []);

  useEffect(() => { fetchAsins(startDate, endDate, showArchived); }, [startDate, endDate, showArchived, fetchAsins]);

  // Column config persistence
  const handleColumnConfigChange = useCallback((config: ColumnConfig) => {
    setColumnConfig(config);
    saveColConfig(config);
  }, []);

  const handleSort = useCallback((colId: ColumnId) => {
    setSortCol(colId);
    setSortDir((prev) => {
      const newDir = sortCol === colId ? (prev === "asc" ? "desc" : "asc") : "asc";
      localStorage.setItem(A_SORT_KEY, JSON.stringify({ col: colId, dir: newDir }));
      return newDir;
    });
    setPage(1);
  }, [sortCol]);

  // ── Filtering ─────────────────────────────────────────────────────
  const filteredResults = useMemo(() => {
    let out = results;

    // Search
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        r.asin.toLowerCase().includes(q) ||
        (r.catalogData.title ?? "").toLowerCase().includes(q) ||
        (r.catalogData.brand ?? "").toLowerCase().includes(q)
      );
    }

    // Meltable seasonal
    // Visibility toggles
    if (!showGated) out = out.filter((r) => (r.eligibilityData?.status ?? "check") !== "no");
    if (!showMeltable) out = out.filter((r) => !r.isMeltable);

    // Column filters
    if (Object.keys(colFilters).length > 0) {
      out = out.filter((r) => {
        const { price } = getSelectedPrice(r, priceSource);
        const prep = getEffectivePrep(r, settings);
        const storage = getEffectiveStorage(r, settings);
        let profitData: ReturnType<typeof calculateProfit> | null = null;
        if (price != null && !r.error) {
          if (r.estimatedCogs != null) profitData = calculateProfit(price, r.estimatedCogs, r.feesData.fbaFulfillmentFee ?? 0, r.feesData.referralFee ?? 0, r.feesData.feesEstimatePrice, r.catalogData.weightLbs, prep.value, storage.value, settings, includeInboundShipping, appliesDgHazmatSurcharge(r));
        }
        return matchesFilters(r as any, colFilters, (colId) => {
          switch (colId) {
            case "brand": return r.catalogData.brand;
            case "supplier": return r.buyLink ? extractDomain(r.buyLink) : null;
            case "cogs": return r.actualCogs ?? null;
            case "estCogs": return r.estimatedCogs ?? null;
            case "salePrice": return price;
            case "profit": return profitData?.profit ?? null;
            case "margin": return profitData?.margin ?? null;
            case "roi": return profitData?.roi ?? null;
            case "fbaFee": return profitData?.totalFbaFee ?? r.feesData.fbaFulfillmentFee;
            case "referralFee": return profitData?.adjustedReferralFee ?? r.feesData.referralFee;
            case "sellersFba": return r.pricingData.sellersFba;
            case "sellers": return (r.pricingData.sellersFba ?? 0) + (r.pricingData.sellersFbm ?? 0) || null;
            case "stock": return r.stock?.total ?? null;
            case "availableFba": return r.stock?.available_fba ?? null;
            case "ordered": return r.stock?.ordered ?? null;
            case "reserved": return r.stock?.reserved ?? null;
            case "sentToFba": return r.stock?.inbound ?? null;
            case "actAvgSalePrice": { const u = r.actuals?.units_sold ?? 0; return u > 0 ? r.actuals!.revenue / u : null; }
            case "actPrepCost": return r.prepOverride ?? 0;
            case "sellers7d": return r.sellersDelta ? (r.sellersDelta.fba_7d ?? 0) + (r.sellersDelta.fbm_7d ?? 0) : null;
            case "sellers30d": return r.sellersDelta ? (r.sellersDelta.fba_30d ?? 0) + (r.sellersDelta.fbm_30d ?? 0) : null;
            case "actUnitsSold": return r.actuals?.units_sold ?? null;
            case "actRevenue": return r.actuals?.revenue ?? null;
            case "actRefunds": return r.actuals?.units_refunded ?? null;
            case "tags": return r.tags?.map((t) => t.name).join(", ") ?? null;
            case "notes": return r.notes ?? null;
            case "category": return r.category ?? null;
            case "sourcing": {
              const w = r.isWholesale ?? false;
              const o = r.isOa ?? false;
              if (w && o) return "w + oa";
              if (w) return "w";
              if (o) return "oa";
              return null;
            }
            case "maxCogs": {
              const mc = calculateMaxCogs(price, r.feesData.fbaFulfillmentFee, r.feesData.referralFee, r.feesData.feesEstimatePrice, r.catalogData.weightLbs, prep.value, storage.value, settings, includeInboundShipping, appliesDgHazmatSurcharge(r));
              return mc;
            }
            default: return null;
          }
        });
      });
    }

    return out;
  }, [results, searchQuery, showGated, showMeltable, colFilters, priceSource, settings, includeInboundShipping]);

  // Sorting
  const sortedFilteredResults = useMemo(() => {
    if (!sortCol) return filteredResults;
    return [...filteredResults].sort((a, b) => {
      const va = getRowValue(a, sortCol, priceSource, settings);
      const vb = getRowValue(b, sortCol, priceSource, settings);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return sortDir === "asc" ? va - vb : vb - va;
      const sa = String(va).toLowerCase();
      const sb = String(vb).toLowerCase();
      return sortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
  }, [filteredResults, sortCol, sortDir, priceSource, settings]);

  // ── Metrics ───────────────────────────────────────────────────────
  // Selection wins over filters
  const metricsRows = useMemo(() => {
    if (selectedSet.size > 0) {
      return sortedFilteredResults.filter((r) => selectedSet.has(r.asin));
    }
    return sortedFilteredResults;
  }, [sortedFilteredResults, selectedSet]);

  const metrics = useMemo(
    () => computeAnalyticsMetrics(metricsRows, priceSource, settings, includeInboundShipping),
    [metricsRows, priceSource, settings, includeInboundShipping],
  );

  // ── Grouping ──────────────────────────────────────────────────────
  // Frontend grouping is fine for current scale; push to SQL if dataset grows past ~10k ASINs.
  const allGroups: GroupData[] = useMemo(() => {
    if (groupBy === "none") return [];
    const map = new Map<string, AsinResult[]>();
    for (const r of sortedFilteredResults) {
      let key: string;
      if (groupBy === "category") key = r.category || "";
      else if (groupBy === "brand") key = r.catalogData.brand || "";
      else key = (r.buyLink ? extractDomain(r.buyLink) : "") || "";
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    const fallbackLabels: Record<string, string> = { category: "Uncategorized", brand: "Unknown Brand", supplier: "Unknown" };
    return Array.from(map.entries())
      .map(([key, rows]) => ({
        key: key || `__empty_${groupBy}`,
        label: key || fallbackLabels[groupBy] || "Other",
        rows,
        metrics: computeAnalyticsMetrics(rows, priceSource, settings, includeInboundShipping),
      }))
      .sort((a, b) => (b.metrics.totalRevenue ?? 0) - (a.metrics.totalRevenue ?? 0));
  }, [groupBy, sortedFilteredResults, priceSource, settings, includeInboundShipping]);

  // Page reset
  useEffect(() => { setPage(1); }, [searchQuery, colFilters, showGated, showMeltable, showArchived]);

  // Pagination: group-level when grouped, ASIN-level when flat
  const isGrouped = groupBy !== "none";
  const totalItems = isGrouped ? allGroups.length : sortedFilteredResults.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedResults = useMemo(
    () => isGrouped ? [] : sortedFilteredResults.slice((safePage - 1) * pageSize, safePage * pageSize),
    [isGrouped, sortedFilteredResults, safePage, pageSize],
  );
  const paginatedGroups = useMemo(
    () => isGrouped ? allGroups.slice((safePage - 1) * pageSize, safePage * pageSize) : [],
    [isGrouped, allGroups, safePage, pageSize],
  );

  const handleSelectAll = useCallback(() => {
    setSelectedSet(new Set(paginatedResults.map((r) => r.asin)));
  }, [paginatedResults]);

  const activeFilterCount = getActiveFilterCount(colFilters, searchQuery);

  function clearFilters() {
    setSearchQuery("");
    setColFilters({});
  }

  return (
    <div className="bg-background">
      <div className="py-6 space-y-6">
        {/* Controls row */}
        <div className="flex items-center gap-4 flex-wrap px-4">
          <SettingsDialog onSettingsChange={setSettings} />
          <div className="flex items-center gap-3">
            <Label className="text-sm text-muted-foreground whitespace-nowrap">Price Source:</Label>
            <div className="flex items-center gap-2">
              <span className={`text-sm ${priceSource === "lowestFba" ? "font-semibold" : "text-muted-foreground"}`}>Lowest FBA</span>
              <Switch checked={priceSource === "buyBox"} onCheckedChange={(c) => setPriceSource(c ? "buyBox" : "lowestFba")} />
              <span className={`text-sm ${priceSource === "buyBox" ? "font-semibold" : "text-muted-foreground"}`}>Buy Box</span>
            </div>
          </div>
<div className="flex items-center gap-2">
            <Switch id="a-inbound" checked={includeInboundShipping} onCheckedChange={setIncludeInboundShipping} />
            <Label htmlFor="a-inbound" className="text-sm text-muted-foreground whitespace-nowrap cursor-pointer">Include Inbound Shipping</Label>
          </div>
        </div>

        {/* Metric tiles */}
        {results.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3 px-4">
            <DualMetricTile label="Avg. ROI" estValue={metrics.estRoi} actValue={metrics.actRoi} format="percent" />
            <DualMetricTile label="Avg. Margin" estValue={metrics.estMargin} actValue={metrics.actMargin} format="percent" />
            <DualMetricTile label="Avg. Profit/Unit" estValue={metrics.estProfitPerUnit} actValue={metrics.actProfitPerUnit} format="currency" />
            <MetricTile label="Avg. COGS" value={metrics.avgCogs} format="currency" />
            <MetricTile label="Avg. Max COGS" value={metrics.avgMaxCogs} format="currency" />
            <MetricTile label="Avg. Sale Price" value={metrics.avgSalePrice} format="currency" />
            <MetricTile label="# of ASINs" value={metrics.asinCount} format="integer" />
            <MetricTile label="Total Units Sold" value={metrics.totalUnitsSold} format="integer" />
            <MetricTile label="Total Revenue" value={metrics.totalRevenue} format="currency" />
            <MetricTile label="Total Profit" value={metrics.totalProfit} format="currency" />
          </div>
        )}

        {/* Search + toggles */}
        {results.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-4 flex-wrap px-4">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 mr-1">
                  <Checkbox
                    id="a-select-all"
                    checked={paginatedResults.length > 0 && paginatedResults.every((r) => selectedSet.has(r.asin))}
                    onCheckedChange={(checked) => checked ? handleSelectAll() : setSelectedSet(new Set())}
                  />
                  <label htmlFor="a-select-all" className="text-xs text-muted-foreground cursor-pointer select-none">All</label>
                </div>
                {selectedSet.size > 0 && (
                  <span className="text-xs text-primary font-medium">
                    {selectedSet.size} selected — tiles reflect selection
                    <button className="ml-2 text-muted-foreground hover:text-foreground underline" onClick={() => setSelectedSet(new Set())}>Clear</button>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Group By segmented control */}
                <div className="flex items-center bg-muted rounded-md p-0.5 text-xs">
                  {(["none", "category", "brand", "supplier"] as const).map((opt) => (
                    <button
                      key={opt}
                      className={`px-2.5 py-1 rounded transition-colors ${
                        groupBy === opt
                          ? "bg-background text-foreground shadow-sm font-medium"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setGroupBy(opt)}
                    >
                      {opt === "none" ? "None" : opt.charAt(0).toUpperCase() + opt.slice(1)}
                    </button>
                  ))}
                </div>
                <ExportButtons results={sortedFilteredResults} priceSource={priceSource} settings={settings} columnConfig={columnConfig} />
                <ColumnManager config={columnConfig} onChange={handleColumnConfigChange} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 px-4">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search ASIN, name, or brand..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>
              <VisibilityToggles
                showGated={showGated}
                onShowGatedChange={(v) => { setShowGated(v); saveShowGated(v); }}
                showMeltable={showMeltable}
                onShowMeltableChange={(v) => { setShowMeltable(v); saveShowMeltable(v); }}
                showArchived={showArchived}
                onShowArchivedChange={(v) => { setShowArchived(v); saveShowArchived(v); }}
              />
              {activeFilterCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFiltersModalOpen(true)}
                  className="h-9 text-xs text-amber-600 border-amber-300 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:hover:bg-amber-950"
                >
                  <Filter className="h-3.5 w-3.5 mr-1.5" />
                  Active filters ({activeFilterCount})
                </Button>
              )}
              {filteredResults.length !== results.length && (
                <span className="text-xs text-muted-foreground ml-1">{filteredResults.length} of {results.length} shown</span>
              )}
            </div>

            {/* Table */}
            {isGrouped ? (
              <GroupedTable
                groups={paginatedGroups}
                startIndex={(safePage - 1) * pageSize}
                priceSource={priceSource}
                settings={settings}
                columnConfig={columnConfig}
                expandedGroups={expandedGroups}
                onToggleGroup={(key) => setExpandedGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key); else next.add(key);
                  return next;
                })}
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
                includeInboundShipping={includeInboundShipping}
                dateRangeLabel={dateRangeLabel}
                colFilters={colFilters}
                onFilterApply={(f) => setColFilters((prev) => ({ ...prev, [f.colId]: f }))}
                onFilterClear={(colId) => setColFilters((prev) => { const next = { ...prev }; delete next[colId]; return next; })}
                selectedSet={selectedSet}
                onToggleSelect={(asin) => {
                  setSelectedSet((prev) => {
                    const next = new Set(prev);
                    if (next.has(asin)) next.delete(asin); else next.add(asin);
                    return next;
                  });
                }}
                allResults={results}
              />
            ) : (
              <ResultsTable
                results={paginatedResults}
                allResults={results}
                startIndex={(safePage - 1) * pageSize}
                priceSource={priceSource}
                settings={settings}
                columnConfig={columnConfig}
                activeFilter="all"
                buySet={new Set()}
                onToggleBuy={() => {}}
                onHoldSet={new Set()}
                onToggleHold={() => {}}
                selectedSet={selectedSet}
                onToggleSelect={(asin) => {
                  setSelectedSet((prev) => {
                    const next = new Set(prev);
                    if (next.has(asin)) next.delete(asin); else next.add(asin);
                    return next;
                  });
                }}
                onSelectAllPage={(asins) => setSelectedSet(new Set(asins))}
                onClearSelection={() => setSelectedSet(new Set())}
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
                includeInboundShipping={includeInboundShipping}
                dateRangeLabel={dateRangeLabel}
                colFilters={colFilters}
                onFilterApply={(f) => setColFilters((prev) => ({ ...prev, [f.colId]: f }))}
                onFilterClear={(colId) => setColFilters((prev) => { const next = { ...prev }; delete next[colId]; return next; })}
                onResultUpdate={(asin, updates) => setResults((prev) => prev.map((r) => r.asin === asin ? { ...r, ...updates } : r))}
              />
            )}

            {/* Pagination */}
            <div className="flex items-center justify-between px-4 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Showing {((safePage - 1) * pageSize) + 1}\u2013{Math.min(safePage * pageSize, totalItems)} of {totalItems.toLocaleString()}{isGrouped ? " groups" : ""}</span>
                <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(parseInt(v)); localStorage.setItem(A_PAGE_SIZE_KEY, v); setPage(1); }}>
                  <SelectTrigger className="w-[80px] h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[25, 50, 100, 500, 5000].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setPage(1)} disabled={safePage <= 1}>&laquo;</Button>
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>&lsaquo;</Button>
                <span className="text-xs text-muted-foreground px-2">Page {safePage} of {totalPages}</span>
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>&rsaquo;</Button>
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setPage(totalPages)} disabled={safePage >= totalPages}>&raquo;</Button>
              </div>
            </div>
          </>
        )}

        <ActiveFiltersModal
          open={filtersModalOpen}
          onOpenChange={setFiltersModalOpen}
          colFilters={colFilters}
          searchQuery={searchQuery}
          onRemoveFilter={(colId) => setColFilters((prev) => { const next = { ...prev }; delete next[colId]; return next; })}
          onClearSearch={() => setSearchQuery("")}
          onClearAll={clearFilters}
        />

        {dbLoaded && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <BarChart3 className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <h2 className="text-lg font-medium text-muted-foreground">No ASIN data</h2>
            <p className="text-sm text-muted-foreground/70 mt-1">Go to ASINs to upload and analyze products first.</p>
          </div>
        )}
      </div>
    </div>
  );
}
