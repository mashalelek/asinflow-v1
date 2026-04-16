import { useState, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingsDialog } from "@/components/settings-dialog";
import { FileUpload } from "@/components/file-upload";
import { ResultsTable, getRowValue } from "@/components/results-table";
import { ExportButtons } from "@/components/export-buttons";
import { SummaryCards, type FilterMode } from "@/components/summary-cards";
import { ColumnManager } from "@/components/column-manager";
import { useTheme } from "@/components/theme-provider";
import { loadSettings } from "@/lib/settings";
import { loadColumnConfig, type ColumnConfig } from "@/lib/columns";
import { Sun, Moon, BarChart3, Zap, AlertTriangle, X, Search, RefreshCw, Archive, Sheet, Database, ShoppingCart } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  type AsinInput,
  type AsinResult,
  type PriceSource,
  type Settings,
  type ProgressUpdate,
  type ColumnId,
  getSelectedPrice,
  calculateProfit,
  getEffectivePrep,
  getEffectiveStorage,
  extractDomain,
} from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { DateRangePicker } from "@/components/date-range-picker";
import { ViewPresets } from "@/components/view-presets";
import { StockHistoryModal } from "@/components/stock-history-modal";
import { type ColFilter, type FilterMap, matchesFilters } from "@/components/column-filter";

const BUY_LIST_KEY = "fba-buy-list";
const DATE_PREFS_KEY = "fba-date-prefs";
const INBOUND_KEY = "fba-include-inbound";
const COL_FILTERS_KEY = "fba-col-filters";

function loadBuyList(): Set<string> {
  try {
    const stored = localStorage.getItem(BUY_LIST_KEY);
    if (stored) return new Set(JSON.parse(stored));
  } catch {}
  return new Set();
}

function saveBuyList(set: Set<string>) {
  localStorage.setItem(BUY_LIST_KEY, JSON.stringify(Array.from(set)));
}

function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function computeDateRange(preset: string, customStart: string, customEnd: string): { startDate: string; endDate: string } {
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
  if (preset === "custom") {
    return { startDate: customStart, endDate: customEnd };
  }
  // default: last 30 days
  const s = new Date(today); s.setDate(s.getDate() - 29);
  return { startDate: fmtDate(s), endDate: fmtDate(today) };
}

function formatDateLabel(start: string, end: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const s = new Date(start + "T12:00:00").toLocaleDateString("en-US", opts);
  const e = new Date(end + "T12:00:00").toLocaleDateString("en-US", opts);
  return `${s} – ${e}`;
}

function loadDatePrefs(): { preset: string; customStart: string; customEnd: string } {
  try {
    const stored = localStorage.getItem(DATE_PREFS_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return { preset: "last30", customStart: "", customEnd: "" };
}

function loadColFilters(): FilterMap {
  try {
    const stored = localStorage.getItem(COL_FILTERS_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return {};
}

function loadIncludeInbound(): boolean {
  try {
    const v = localStorage.getItem(INBOUND_KEY);
    if (v !== null) return v === "true";
  } catch {}
  return true;
}

export default function Home() {
  const { theme, toggleTheme } = useTheme();
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(loadColumnConfig);
  const [asins, setAsins] = useState<AsinInput[]>([]);
  const [results, setResults] = useState<AsinResult[]>([]);
  const [priceSource, setPriceSource] = useState<PriceSource>("lowestFba");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [credentialsConfigured, setCredentialsConfigured] = useState<boolean | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterMode>("all");
  const [buySet, setBuySet] = useState<Set<string>>(loadBuyList);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  const [sortCol, setSortCol] = useState<ColumnId | null>(() => {
    try { const s = localStorage.getItem("fba-sort"); if (s) { const p = JSON.parse(s); return p.col; } } catch {} return "roi";
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    try { const s = localStorage.getItem("fba-sort"); if (s) { const p = JSON.parse(s); return p.dir; } } catch {} return "desc";
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [filterEligible, setFilterEligible] = useState("all");
  const [colFilters, setColFilters] = useState<FilterMap>(loadColFilters);
  const [showArchived, setShowArchived] = useState(false);
  const [presetFilter, setPresetFilter] = useState<string | null>(null);
  const [meltableHidden, setMeltableHidden] = useState(() => {
    const now = new Date();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    return (m > 4 || (m === 4 && d >= 15)) && (m < 9 || (m === 9 && d <= 15));
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => {
    try { const v = localStorage.getItem("fba-page-size"); return v ? parseInt(v) : 100; } catch { return 100; }
  });
  const [historyAsin, setHistoryAsin] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [dbLoaded, setDbLoaded] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncingInventory, setIsSyncingInventory] = useState(false);
  const [isSyncingSales, setIsSyncingSales] = useState(false);

  const [datePrefs] = useState(loadDatePrefs);
  const [datePreset, setDatePreset] = useState(datePrefs.preset);
  const [customStart, setCustomStart] = useState(datePrefs.customStart);
  const [customEnd, setCustomEnd] = useState(datePrefs.customEnd);
  const [includeInboundShipping, setIncludeInboundShipping] = useState(loadIncludeInbound);

  const { startDate, endDate } = useMemo(
    () => computeDateRange(datePreset, customStart, customEnd),
    [datePreset, customStart, customEnd]
  );

  const dateRangeLabel = useMemo(() => formatDateLabel(startDate, endDate), [startDate, endDate]);

  useEffect(() => {
    localStorage.setItem(DATE_PREFS_KEY, JSON.stringify({ preset: datePreset, customStart, customEnd }));
  }, [datePreset, customStart, customEnd]);

  useEffect(() => {
    localStorage.setItem(INBOUND_KEY, String(includeInboundShipping));
  }, [includeInboundShipping]);

  useEffect(() => {
    localStorage.setItem(COL_FILTERS_KEY, JSON.stringify(colFilters));
  }, [colFilters]);

  const fetchAsins = useCallback((start: string, end: string, archived = false) => {
    return fetch(`/api/asins?startDate=${start}&endDate=${end}${archived ? "&includeArchived=true" : ""}`)
      .then((r) => r.json())
      .then((data: AsinResult[]) => {
        if (data.length > 0) setResults(data);
        setSavedCount(data.length);
        setDbLoaded(true);
      })
      .catch(() => setDbLoaded(true));
  }, []);

  useEffect(() => {
    fetchAsins(startDate, endDate, showArchived);
  }, [startDate, endDate, showArchived]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch("/api/credentials-status")
      .then((r) => r.json())
      .then((d) => setCredentialsConfigured(d.configured))
      .catch(() => setCredentialsConfigured(false));
  }, []);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);

  const handleFileProcessed = useCallback((parsed: AsinInput[]) => {
    setAsins(parsed);
    const hasPrepOverrides = parsed.some((a) => a.prepOverride != null);
    const hasStorageOverrides = parsed.some((a) => a.storageOverride != null);
    let msg = `Found ${parsed.length} ASINs ready for analysis.`;
    if (hasPrepOverrides || hasStorageOverrides) {
      const parts: string[] = [];
      if (hasPrepOverrides) parts.push("Prep Cost");
      if (hasStorageOverrides) parts.push("Additional Fees");
      msg += ` Per-ASIN ${parts.join(" and ")} overrides detected.`;
    }
    toast({ title: "File parsed", description: msg });
  }, [toast]);

  const runAnalysis = useCallback(async (asinsToAnalyze: AsinInput[]) => {
    setIsAnalyzing(true);
    setProgress({ current: 0, total: asinsToAnalyze.length, asin: "" });

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins: asinsToAnalyze }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Analysis failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === "progress") {
                setProgress(msg.data);
              } else if (msg.type === "result") {
                const resultData = msg.data;
                if (resultData._update) {
                  delete resultData._update;
                  setResults((prev) =>
                    prev.map((r) => (r.asin === resultData.asin ? resultData : r))
                  );
                } else {
                  setResults((prev) => {
                    const idx = prev.findIndex((r) => r.asin === resultData.asin);
                    if (idx >= 0) return prev.map((r, i) => i === idx ? resultData : r);
                    setSavedCount((c) => (c ?? 0) + 1);
                    return [...prev, resultData];
                  });
                }
              } else if (msg.type === "complete") {
                setProgress(null);
              }
            } catch {}
          }
        }
      }
    } catch (err: any) {
      toast({
        title: "Analysis failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
      setProgress(null);
    }
  }, [toast]);

  const handleAnalyze = useCallback(async () => {
    if (asins.length > 0) {
      await runAnalysis(asins);
    } else if (results.length > 0) {
      // Re-analyze all DB-loaded ASINs
      const fromDb: AsinInput[] = results.map((r) => ({
        asin: r.asin,
        cogs: r.cogs,
        buyLink: r.buyLink,
        prepOverride: r.prepOverride,
        storageOverride: r.storageOverride,
      }));
      await runAnalysis(fromDb);
    }
  }, [asins, results, runAnalysis]);

  const handleToggleBuy = useCallback((asin: string) => {
    setBuySet((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      saveBuyList(next);
      return next;
    });
  }, []);

  const handleClearBuyList = useCallback(() => {
    setBuySet(new Set());
    saveBuyList(new Set());
    if (activeFilter === "buyList") setActiveFilter("all");
  }, [activeFilter]);

  const handleToggleSelect = useCallback((asin: string) => {
    setSelectedSet((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedSet(new Set());
  }, []);

  const handleSort = useCallback((colId: ColumnId) => {
    setSortCol(colId);
    setSortDir((prev) => {
      const newDir = sortCol === colId ? (prev === "asc" ? "desc" : "asc") : "asc";
      localStorage.setItem("fba-sort", JSON.stringify({ col: colId, dir: newDir }));
      return newDir;
    });
    setPage(1);
  }, [sortCol]);

  const handleRefreshSelected = useCallback(async () => {
    if (selectedSet.size === 0) return;
    if (selectedSet.size >= 2000) {
      const confirmed = window.confirm(`Refresh all ${selectedSet.size.toLocaleString()} ASINs? This may take several minutes.`);
      if (!confirmed) return;
    }
    const toRefresh: AsinInput[] = results
      .filter((r) => selectedSet.has(r.asin))
      .map((r) => ({
        asin: r.asin,
        cogs: r.cogs,
        buyLink: r.buyLink,
        prepOverride: r.prepOverride,
        storageOverride: r.storageOverride,
      }));
    await runAnalysis(toRefresh);
  }, [selectedSet, results, runAnalysis]);

  const handleSyncSheet = useCallback(async () => {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/sheets/sync");
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Sync failed");
      toast({ title: `Synced PO data`, description: `Updated ${data.updated} ASINs, skipped ${data.skipped}` });
      // Refresh displayed data
      await fetchAsins(startDate, endDate);
    } catch (err: any) {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSyncing(false);
    }
  }, [toast]);

  const handleSyncInventory = useCallback(async () => {
    setIsSyncingInventory(true);
    try {
      const res = await fetch("/api/inventory/sync");
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Inventory sync failed");
      toast({ title: "Inventory synced", description: `${data.synced} ASINs synced, ${data.skipped} skipped` });
      await fetchAsins(startDate, endDate);
    } catch (err: any) {
      toast({ title: "Inventory sync failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSyncingInventory(false);
    }
  }, [toast, fetchAsins, startDate, endDate]);

  const handleSyncSales = useCallback(async () => {
    setIsSyncingSales(true);
    try {
      const res = await fetch("/api/sales/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Sales sync failed");
      toast({ title: "Sales synced", description: `${data.daysProcessed} days, ${data.asinsUpdated} ASINs updated` });
      await fetchAsins(startDate, endDate);
    } catch (err: any) {
      toast({ title: "Sales sync failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSyncingSales(false);
    }
  }, [toast, fetchAsins, startDate, endDate]);

  const handleArchiveSelected = useCallback(async (archive = true) => {
    if (selectedSet.size === 0) return;
    const asinList = Array.from(selectedSet);
    const label = archive ? "Archive" : "Unarchive";
    const confirmed = window.confirm(`${label} ${asinList.length} selected ASIN${asinList.length !== 1 ? "s" : ""}?`);
    if (!confirmed) return;
    try {
      await fetch("/api/asins/archive", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins: asinList, archive }),
      });
      if (archive && !showArchived) {
        const archivedAsins = new Set(asinList);
        setResults((prev) => prev.filter((r) => !archivedAsins.has(r.asin)));
        setSavedCount((c) => Math.max(0, (c ?? 0) - asinList.length));
      } else {
        await fetchAsins(startDate, endDate, showArchived);
      }
      setSelectedSet(new Set());
      toast({ title: `${label}d ${asinList.length} ASIN${asinList.length !== 1 ? "s" : ""}` });
    } catch {
      toast({ title: `${label} failed`, variant: "destructive" });
    }
  }, [selectedSet, toast, showArchived, fetchAsins, startDate, endDate]);

  const buyListCount = useMemo(() => {
    return results.filter((r) => buySet.has(r.asin)).length;
  }, [results, buySet]);

  const queryFilteredResults = useMemo(() => {
    let out = results;

    // Scorecard filter (Total / Profitable / Unprofitable / Buy List)
    if (activeFilter === "buyList") {
      out = out.filter((r) => buySet.has(r.asin));
    } else if (activeFilter === "profitable" || activeFilter === "unprofitable") {
      out = out.filter((r) => {
        if (r.error) return activeFilter === "unprofitable";
        const { price } = getSelectedPrice(r, priceSource);
        if (price == null) return activeFilter === "unprofitable";
        const prep = getEffectivePrep(r, settings);
        const storage = getEffectiveStorage(r, settings);
        const p = calculateProfit(price, r.cogs, r.feesData.fbaFulfillmentFee ?? 0, r.feesData.referralFee ?? 0, r.feesData.feesEstimatePrice, r.catalogData.weightLbs, prep.value, storage.value, settings, includeInboundShipping, r.isHazmat ?? false);
        const meets = p.roi >= settings.minRoiThreshold && p.margin >= settings.minMarginThreshold;
        return activeFilter === "profitable" ? meets : !meets;
      });
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        r.asin.toLowerCase().includes(q) ||
        (r.catalogData.title ?? "").toLowerCase().includes(q) ||
        (r.catalogData.brand ?? "").toLowerCase().includes(q)
      );
    }
    if (filterEligible !== "all") {
      out = out.filter((r) => (r.eligibilityData?.status ?? "check") === filterEligible);
    }
    // Seasonal meltable auto-filter
    if (meltableHidden) {
      out = out.filter((r) => !r.isMeltable);
    }
    // Apply replenishment preset filter
    if (presetFilter === "replenishment") {
      out = out.filter((r) => {
        const stk = r.stock?.total ?? 0;
        const us = r.actuals?.units_sold ?? 0;
        const dws = r.actuals?.days_with_sales ?? 0;
        if (us === 0 || dws === 0) return false;
        const adjustedMonthlyVelocity = (us / dws) * 30;
        const needsRestock = stk < 0.8 * adjustedMonthlyVelocity;
        if (!needsRestock) return false;
        // Profitability tiers
        const { price } = getSelectedPrice(r, priceSource);
        if (!price || r.error) return false;
        const prep = getEffectivePrep(r, settings);
        const storage = getEffectiveStorage(r, settings);
        const p = calculateProfit(price, r.cogs, r.feesData.fbaFulfillmentFee ?? 0, r.feesData.referralFee ?? 0, r.feesData.feesEstimatePrice, r.catalogData.weightLbs, prep.value, storage.value, settings, includeInboundShipping, r.isHazmat ?? false);
        return (p.roi > 25 && p.margin > 10) || (p.roi > 20 && p.margin > 12) || (p.roi > 15 && p.margin > 14);
      });
    }
    // Apply column filters
    if (Object.keys(colFilters).length > 0) {
      out = out.filter((r) => {
        const { price } = getSelectedPrice(r, priceSource);
        const prep = getEffectivePrep(r, settings);
        const storage = getEffectiveStorage(r, settings);
        let profitData: ReturnType<typeof calculateProfit> | null = null;
        if (price != null && !r.error) {
          profitData = calculateProfit(price, r.cogs, r.feesData.fbaFulfillmentFee ?? 0, r.feesData.referralFee ?? 0, r.feesData.feesEstimatePrice, r.catalogData.weightLbs, prep.value, storage.value, settings, includeInboundShipping, r.isHazmat ?? false);
        }
        return matchesFilters(r as any, colFilters, (colId) => {
          switch (colId) {
            case "brand": return r.catalogData.brand;
            case "supplier": return r.buyLink ? extractDomain(r.buyLink) : null;
            case "cogs": return r.cogs;
            case "salePrice": return price;
            case "profit": return profitData?.profit ?? null;
            case "margin": return profitData?.margin ?? null;
            case "roi": return profitData?.roi ?? null;
            case "fbaFee": return profitData?.totalFbaFee ?? r.feesData.fbaFulfillmentFee;
            case "referralFee": return profitData?.adjustedReferralFee ?? r.feesData.referralFee;
            case "bsr": return r.catalogData.bsrRank;
            case "sellersFba": return r.pricingData.sellersFba;
            case "sellersFbm": return r.pricingData.sellersFbm;
            case "stock": return r.stock?.total ?? null;
            case "daysLeft": {
              const stk = r.stock?.total ?? 0;
              const us = r.actuals?.units_sold ?? 0;
              const dis = r.actuals?.days_in_stock ?? 0;
              const dws = r.actuals?.days_with_sales ?? 0;
              const ad = dis >= 7 ? dis : dws;
              if (us === 0 || ad === 0) return null;
              return Math.round(stk / (us / ad));
            }
            case "fba7d": return r.sellersDelta?.fba_7d ?? null;
            case "fba30d": return r.sellersDelta?.fba_30d ?? null;
            case "fbm7d": return r.sellersDelta?.fbm_7d ?? null;
            case "fbm30d": return r.sellersDelta?.fbm_30d ?? null;
            case "actUnitsSold": return r.actuals?.units_sold ?? null;
            case "actRevenue": return r.actuals?.revenue ?? null;
            case "actRefunds": return r.actuals?.units_refunded ?? null;
            case "tags": return r.tags?.map((t) => t.name).join(", ") ?? null;
            case "notes": return r.notes ?? null;
            case "meltable": return r.isMeltable ? "Yes" : "No";
            case "hazmat": return r.isHazmat ? "Yes" : "No";
            case "suppressed": return r.isSearchSuppressed ? "Yes" : "No";
            default: return null;
          }
        });
      });
    }
    return out;
  }, [results, searchQuery, filterEligible, priceSource, settings, includeInboundShipping, colFilters, presetFilter, meltableHidden, activeFilter, buySet]);

  // Sort all filtered results before paginating
  const sortedFilteredResults = useMemo(() => {
    if (!sortCol) return queryFilteredResults;
    return [...queryFilteredResults].sort((a, b) => {
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
  }, [queryFilteredResults, sortCol, sortDir, priceSource, settings]);

  // Reset to page 1 when any filter/view changes
  useEffect(() => { setPage(1); }, [searchQuery, filterEligible, colFilters, presetFilter, activeFilter, meltableHidden, showArchived]);

  const totalFiltered = sortedFilteredResults.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedResults = useMemo(
    () => sortedFilteredResults.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sortedFilteredResults, safePage, pageSize]
  );

  const handleSelectAll = useCallback(() => {
    setSelectedSet(new Set(paginatedResults.map((r) => r.asin)));
  }, [paginatedResults]);

  const activeFilterCount = [
    searchQuery.trim() !== "" ? 1 : 0,
    filterEligible !== "all" ? 1 : 0,
    Object.keys(colFilters).length,
  ].reduce((a, b) => a + b, 0);

  function clearSearchFilters() {
    setSearchQuery("");
    setFilterEligible("all");
    setColFilters({});
  }

  const progressPercent = progress
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="px-4">
          <div className="flex items-center justify-between gap-4 h-14">
            <div className="flex items-center gap-2.5">
              <BarChart3 className="h-6 w-6 text-primary" />
              <h1 className="text-base font-semibold tracking-tight">FBA Profitability Analyzer</h1>
              {dbLoaded && savedCount !== null && savedCount > 0 && (
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  · {savedCount.toLocaleString()} saved
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <SettingsDialog onSettingsChange={setSettings} />
              <Button
                size="icon"
                variant="ghost"
                onClick={toggleTheme}
                data-testid="button-theme-toggle"
              >
                {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="py-6 space-y-6">
        <div className="px-4">
          {credentialsConfigured === false && (
            <Alert variant="destructive" data-testid="alert-credentials" className="mb-6">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                SP-API credentials are not configured. Add <code className="font-mono text-xs">SP_API_CLIENT_ID</code>, <code className="font-mono text-xs">SP_API_CLIENT_SECRET</code>, and <code className="font-mono text-xs">SP_API_REFRESH_TOKEN</code> to your Replit Secrets for live data. The app will still work but won't fetch real pricing data.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <FileUpload onFileProcessed={handleFileProcessed} isAnalyzing={isAnalyzing} compact />
            <Button
              size="sm"
              onClick={handleAnalyze}
              disabled={(asins.length === 0 && results.length === 0) || isAnalyzing}
              className="h-8 text-xs"
              data-testid="button-analyze"
            >
              <Zap className="h-3.5 w-3.5 mr-1.5" />
              {isAnalyzing ? "Analyzing..." : `Analyze${asins.length > 0 ? ` ${asins.length}` : results.length > 0 ? ` ${results.length}` : ""}`}
            </Button>
            <Button variant="outline" size="sm" onClick={handleSyncSheet} disabled={isSyncing || isAnalyzing} className="h-8 text-xs">
              <Sheet className="h-3.5 w-3.5 mr-1.5" />
              {isSyncing ? "Syncing..." : "Sync PO"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleSyncInventory} disabled={isSyncingInventory || isAnalyzing} className="h-8 text-xs">
              <Database className="h-3.5 w-3.5 mr-1.5" />
              {isSyncingInventory ? "Syncing..." : "Sync Inventory"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleSyncSales} disabled={isSyncingSales || isAnalyzing} className="h-8 text-xs">
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isSyncingSales ? "animate-spin" : ""}`} />
              {isSyncingSales ? "Syncing..." : "Sync Sales"}
            </Button>
          </div>

          {isAnalyzing && progress && (
            <div className="space-y-2 mt-6">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Fetching {progress.current} of {progress.total} ASINs...
                </span>
                <span className="font-mono text-xs">{progressPercent}%</span>
              </div>
              <Progress value={progressPercent} className="h-2" data-testid="progress-analysis" />
              {progress.asin && (
                <p className="text-xs text-muted-foreground font-mono">
                  Current: {progress.asin}
                </p>
              )}
            </div>
          )}
        </div>

        {results.length > 0 && (
          <>
            <div className="px-4">
              <SummaryCards
                results={results}
                priceSource={priceSource}
                settings={settings}
                activeFilter={activeFilter}
                onFilterChange={setActiveFilter}
                buyListCount={buyListCount}
              />
            </div>

            <div className="flex items-center justify-between gap-4 flex-wrap px-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <Label className="text-sm text-muted-foreground whitespace-nowrap">Price Source:</Label>
                  <div className="flex items-center gap-2">
                    <span className={`text-sm ${priceSource === "lowestFba" ? "font-semibold" : "text-muted-foreground"}`}>
                      Lowest FBA
                    </span>
                    <Switch
                      checked={priceSource === "buyBox"}
                      onCheckedChange={(checked) =>
                        setPriceSource(checked ? "buyBox" : "lowestFba")
                      }
                      data-testid="switch-price-source"
                    />
                    <span className={`text-sm ${priceSource === "buyBox" ? "font-semibold" : "text-muted-foreground"}`}>
                      Buy Box
                    </span>
                  </div>
                </div>

                <DateRangePicker
                  preset={datePreset}
                  onPresetChange={setDatePreset}
                  customStart={customStart}
                  customEnd={customEnd}
                  onCustomStartChange={setCustomStart}
                  onCustomEndChange={setCustomEnd}
                  dateRangeLabel={dateRangeLabel}
                />

                <div className="flex items-center gap-2">
                  <Switch
                    id="inbound-toggle"
                    checked={includeInboundShipping}
                    onCheckedChange={setIncludeInboundShipping}
                  />
                  <Label htmlFor="inbound-toggle" className="text-sm text-muted-foreground whitespace-nowrap cursor-pointer">
                    Include Inbound Shipping
                  </Label>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 mr-1">
                  <Checkbox
                    id="select-all"
                    checked={paginatedResults.length > 0 && paginatedResults.every((r) => selectedSet.has(r.asin))}
                    onCheckedChange={(checked) => checked ? handleSelectAll() : handleClearSelection()}
                  />
                  <label htmlFor="select-all" className="text-xs text-muted-foreground cursor-pointer select-none">
                    All
                  </label>
                </div>
                {selectedSet.size > 0 && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRefreshSelected}
                      disabled={isAnalyzing}
                      className="text-xs h-8"
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Refresh ({selectedSet.size})
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleArchiveSelected(true)}
                      className="text-xs h-8 text-muted-foreground"
                    >
                      <Archive className="h-3 w-3 mr-1" />
                      Archive ({selectedSet.size})
                    </Button>
                    {showArchived && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleArchiveSelected(false)}
                        className="text-xs h-8 text-muted-foreground"
                      >
                        <Archive className="h-3 w-3 mr-1" />
                        Unarchive ({selectedSet.size})
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleClearBuyList}
                      className="text-xs text-muted-foreground h-8"
                      data-testid="button-clear-buy-list"
                    >
                      <X className="h-3 w-3 mr-1" />
                      Clear
                    </Button>
                  </>
                )}
                <ExportButtons results={results} priceSource={priceSource} settings={settings} />
                <ViewPresets
                  columnConfig={columnConfig}
                  onColumnConfigChange={setColumnConfig}
                  onSortChange={(col, dir) => { setSortCol(col); setSortDir(dir); localStorage.setItem("fba-sort", JSON.stringify({ col, dir })); }}
                  onPresetFilterChange={setPresetFilter}
                />
                <ColumnManager config={columnConfig} onChange={setColumnConfig} />
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
                  data-testid="input-search"
                />
              </div>
              <Select value={filterEligible} onValueChange={setFilterEligible}>
                <SelectTrigger className="w-[148px] h-9" data-testid="select-filter-eligible">
                  <SelectValue placeholder="Eligibility" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Eligibility</SelectItem>
                  <SelectItem value="yes">Yes (Ungated)</SelectItem>
                  <SelectItem value="no">No (Gated)</SelectItem>
                  <SelectItem value="check">Check</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1.5">
                <Switch
                  id="show-archived"
                  checked={showArchived}
                  onCheckedChange={setShowArchived}
                />
                <Label htmlFor="show-archived" className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
                  Show Archived
                </Label>
              </div>
              {meltableHidden && (
                <div className="flex items-center gap-1.5 text-xs text-amber-500 bg-amber-500/10 px-2 py-1 rounded">
                  <span>Meltable items hidden (summer restriction)</span>
                  <button className="underline hover:no-underline" onClick={() => setMeltableHidden(false)}>Show anyway</button>
                </div>
              )}
              {activeFilterCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearSearchFilters}
                  className="h-9 text-muted-foreground"
                  data-testid="button-clear-filters"
                >
                  <X className="h-3 w-3 mr-1" />
                  Clear ({activeFilterCount})
                </Button>
              )}
              {queryFilteredResults.length !== results.length && (
                <span className="text-xs text-muted-foreground ml-1">
                  {queryFilteredResults.length} of {results.length} shown
                </span>
              )}
            </div>

            <ResultsTable
              results={paginatedResults}
              priceSource={priceSource}
              settings={settings}
              columnConfig={columnConfig}
              activeFilter={activeFilter}
              buySet={buySet}
              onToggleBuy={handleToggleBuy}
              selectedSet={selectedSet}
              onToggleSelect={handleToggleSelect}
              onSelectAllPage={(asins) => setSelectedSet(new Set(asins))}
              onClearSelection={handleClearSelection}
              sortCol={sortCol}
              sortDir={sortDir}
              onSort={handleSort}
              includeInboundShipping={includeInboundShipping}
              dateRangeLabel={dateRangeLabel}
              colFilters={colFilters}
              onFilterApply={(f) => setColFilters((prev) => ({ ...prev, [f.colId]: f }))}
              onFilterClear={(colId) => setColFilters((prev) => { const next = { ...prev }; delete next[colId]; return next; })}
              onResultUpdate={(asin, updates) => setResults((prev) => prev.map((r) => r.asin === asin ? { ...r, ...updates } : r))}
              onStockClick={(asin) => setHistoryAsin(asin)}
            />

            {/* Pagination */}
            <div className="flex items-center justify-between px-4 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Showing {((safePage - 1) * pageSize) + 1}–{Math.min(safePage * pageSize, totalFiltered)} of {totalFiltered.toLocaleString()}</span>
                <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(parseInt(v)); localStorage.setItem("fba-page-size", v); setPage(1); }}>
                  <SelectTrigger className="w-[80px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[25, 50, 100, 500, 5000].map((n) => (
                      <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setPage(1)} disabled={safePage <= 1}>«</Button>
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>‹</Button>
                <span className="text-xs text-muted-foreground px-2">Page {safePage} of {totalPages}</span>
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>›</Button>
                <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => setPage(totalPages)} disabled={safePage >= totalPages}>»</Button>
              </div>
            </div>
          </>
        )}

        {!isAnalyzing && results.length === 0 && asins.length === 0 && dbLoaded && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <BarChart3 className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <h2 className="text-lg font-medium text-muted-foreground">
              Upload a CSV/XLSX to get started
            </h2>
            <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
              Click "Upload File" above to import ASINs with COGS data, then click "Analyze" to fetch pricing from Amazon SP-API.
            </p>
          </div>
        )}
      </main>

      {historyAsin && (
        <StockHistoryModal
          asin={historyAsin}
          title={results.find((r) => r.asin === historyAsin)?.catalogData.title ?? null}
          startDate={startDate}
          endDate={endDate}
          onClose={() => setHistoryAsin(null)}
        />
      )}
    </div>
  );
}
