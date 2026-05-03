import { useState, useCallback, useEffect, useMemo, useRef } from "react";
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
import { Sun, Moon, BarChart3, Zap, AlertTriangle, X, Search, RefreshCw, Archive, Sheet, Database, ShoppingCart, DollarSign } from "lucide-react";
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
  calculateMaxCogs,
} from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { DateRangePicker } from "@/components/date-range-picker";
import { ViewPresets } from "@/components/view-presets";
import { StockHistoryModal } from "@/components/stock-history-modal";
import { type ColFilter, type FilterMap, matchesFilters } from "@/components/column-filter";
import { VisibilityToggles, loadShowGated, saveShowGated, loadShowMeltable, saveShowMeltable, loadShowArchived, saveShowArchived } from "@/components/visibility-toggles";
import { getEstimatedProfit } from "@/lib/profit";
import { ActiveFiltersModal, getActiveFilterCount } from "@/components/active-filters-modal";
import { Filter } from "lucide-react";

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

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "never";
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function MultiSearch({
  results,
  searchQuery,
  onSearchQueryChange,
  selectedAsins,
  onSelectedAsinsChange,
}: {
  results: AsinResult[];
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  selectedAsins: Set<string>;
  onSelectedAsinsChange: (s: Set<string>) => void;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = searchQuery.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!q || q.length < 1) return [];
    return results.filter((r) =>
      r.asin.toLowerCase().includes(q) ||
      (r.catalogData.title ?? "").toLowerCase().includes(q) ||
      (r.catalogData.brand ?? "").toLowerCase().includes(q) ||
      (r.skus ?? []).some((s) => s.toLowerCase().includes(q)) ||
      (r.sku ?? "").toLowerCase().includes(q)
    ).slice(0, 50);
  }, [results, q]);

  function handleInputChange(value: string) {
    onSearchQueryChange(value);
    // Auto-detect pasted multi-ASIN input (comma/newline separated)
    const parts = value.split(/[\n,]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{10}$/.test(s));
    if (parts.length >= 2) {
      const found = new Set<string>();
      const asinSet = new Set(results.map((r) => r.asin));
      for (const p of parts) { if (asinSet.has(p)) found.add(p); }
      if (found.size > 0) {
        onSelectedAsinsChange(found);
        onSearchQueryChange("");
        setDropdownOpen(false);
        return;
      }
    }
    setDropdownOpen(value.trim().length > 0);
  }

  function toggleAsin(asin: string) {
    const next = new Set(selectedAsins);
    if (next.has(asin)) next.delete(asin); else next.add(asin);
    onSelectedAsinsChange(next);
  }

  function selectAllMatches() {
    const next = new Set(selectedAsins);
    for (const r of matches) next.add(r.asin);
    onSelectedAsinsChange(next);
    setDropdownOpen(false);
    onSearchQueryChange("");
  }

  function clearAll() {
    onSelectedAsinsChange(new Set());
    onSearchQueryChange("");
  }

  return (
    <div className="relative flex-1 min-w-[200px]">
      {/* Chips for selected ASINs */}
      {selectedAsins.size > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {Array.from(selectedAsins).slice(0, 20).map((asin) => {
            const r = results.find((r) => r.asin === asin);
            return (
              <span key={asin} className="inline-flex items-center gap-1 bg-primary/10 text-primary text-[10px] px-1.5 py-0.5 rounded-full">
                {asin}
                {r?.catalogData.title && <span className="text-muted-foreground truncate max-w-[80px]">· {r.catalogData.title}</span>}
                <button onClick={() => toggleAsin(asin)} className="hover:text-red-500 ml-0.5"><X className="h-2.5 w-2.5" /></button>
              </span>
            );
          })}
          {selectedAsins.size > 20 && (
            <span className="text-[10px] text-muted-foreground">+{selectedAsins.size - 20} more</span>
          )}
          <button onClick={clearAll} className="text-[10px] text-muted-foreground hover:text-foreground underline ml-1">
            Clear all
          </button>
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          placeholder={selectedAsins.size > 0 ? "Add more ASINs..." : "Search ASIN, name, brand, or paste multiple ASINs..."}
          value={searchQuery}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => { if (q.length > 0) setDropdownOpen(true); }}
          onBlur={() => setTimeout(() => setDropdownOpen(false), 200)}
          className="pl-9 h-9"
          data-testid="input-search"
        />
      </div>
      {/* Dropdown */}
      {dropdownOpen && matches.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-background border border-border rounded-md shadow-lg max-h-64 overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border text-[10px] text-muted-foreground">
            <span>{matches.length} match{matches.length !== 1 ? "es" : ""}</span>
            <button className="hover:text-foreground" onMouseDown={(e) => { e.preventDefault(); selectAllMatches(); }}>
              Select all
            </button>
          </div>
          {matches.map((r) => (
            <label
              key={r.asin}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted cursor-pointer text-xs"
              onMouseDown={(e) => e.preventDefault()}
            >
              <input
                type="checkbox"
                checked={selectedAsins.has(r.asin)}
                onChange={() => toggleAsin(r.asin)}
                className="h-3 w-3 accent-blue-500 flex-shrink-0"
              />
              {r.catalogData.imageUrl && (
                <img src={r.catalogData.imageUrl} alt="" className="w-7 h-7 object-contain rounded flex-shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="font-mono text-primary">{r.asin}</span>
                  {r.sku && <span className="text-muted-foreground">· {r.sku}</span>}
                </div>
                {r.catalogData.title && (
                  <div className="text-muted-foreground truncate text-[10px]">{r.catalogData.title}</div>
                )}
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  // Theme toggle is now in the top nav
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
  const [selectedSearchAsins, setSelectedSearchAsins] = useState<Set<string>>(new Set());
  const [colFilters, setColFilters] = useState<FilterMap>(loadColFilters);
  const [showGated, setShowGated] = useState(loadShowGated);
  const [showMeltable, setShowMeltable] = useState(loadShowMeltable);
  const [showArchived, setShowArchived] = useState(loadShowArchived);
  const [presetFilter, setPresetFilter] = useState<string | null>(null);
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
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
  const [isRefreshingPrices, setIsRefreshingPrices] = useState(false);
  const [pricesLastRefreshedAt, setPricesLastRefreshedAt] = useState<string | null>(null);
  const [lastRefreshFailedCount, setLastRefreshFailedCount] = useState(0);
  const [filterNoPrices, setFilterNoPrices] = useState(false);
  const [filterUncalculated, setFilterUncalculated] = useState(false);

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

  const fetchPriceStatus = useCallback(() => {
    fetch("/api/prices/status")
      .then((r) => r.json())
      .then((d: { lastRefreshedAt: string | null }) => setPricesLastRefreshedAt(d.lastRefreshedAt))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchPriceStatus(); }, [fetchPriceStatus]);
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

  // Consume an NDJSON analyze stream (progress / result / complete messages).
  // Shared between the ASIN-list endpoint and the "analyze all" endpoint.
  const consumeAnalyzeStream = useCallback(async (res: Response) => {
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    if (!reader) return;
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
          }
        } catch {}
      }
    }
  }, []);

  const BATCH_SIZE_LIMIT = 200;
  const FRONTEND_BATCH_SIZE = 100;

  const runAnalysis = useCallback(async (asinsToAnalyze: AsinInput[]) => {
    setIsAnalyzing(true);
    setProgress({ current: 0, total: asinsToAnalyze.length, asin: "" });

    try {
      // For large CSV-upload flows, split into client-side batches to avoid
      // "request entity too large" on /api/analyze.
      if (asinsToAnalyze.length > BATCH_SIZE_LIMIT) {
        const total = asinsToAnalyze.length;
        const batches = Math.ceil(total / FRONTEND_BATCH_SIZE);
        for (let b = 0; b < batches; b++) {
          const start = b * FRONTEND_BATCH_SIZE;
          const end = Math.min(start + FRONTEND_BATCH_SIZE, total);
          const slice = asinsToAnalyze.slice(start, end);
          setProgress({ current: start, total, asin: `Batch ${b + 1} of ${batches} (ASINs ${start + 1}-${end})` });
          try {
            const res = await fetch("/api/analyze", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ asins: slice }),
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err.message || `Batch ${b + 1} failed`);
            }
            await consumeAnalyzeStream(res);
          } catch (err: any) {
            toast({
              title: `Batch ${b + 1} failed`,
              description: `${err.message} — continuing with remaining batches`,
              variant: "destructive",
            });
          }
        }
        toast({ title: "Analysis complete", description: `Processed ${total} ASINs in ${batches} batches` });
      } else {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asins: asinsToAnalyze }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.message || "Analysis failed");
        }
        await consumeAnalyzeStream(res);
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
      fetchPriceStatus();
      fetchAsins(startDate, endDate, showArchived);
    }
  }, [toast, consumeAnalyzeStream, fetchPriceStatus, fetchAsins, startDate, endDate, showArchived]);

  const runAnalyzeAllFromDb = useCallback(async (totalEstimate: number) => {
    setIsAnalyzing(true);
    setProgress({ current: 0, total: totalEstimate, asin: "Starting full-catalog analysis..." });
    try {
      const res = await fetch("/api/analyze/all", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Analyze all failed");
      }
      await consumeAnalyzeStream(res);
    } catch (err: any) {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    } finally {
      setIsAnalyzing(false);
      setProgress(null);
      fetchPriceStatus();
      fetchAsins(startDate, endDate, showArchived);
    }
  }, [toast, consumeAnalyzeStream, fetchPriceStatus, fetchAsins, startDate, endDate, showArchived]);

  const handleAnalyze = useCallback(async () => {
    if (asins.length > 0) {
      await runAnalysis(asins);
    } else if (results.length > 0) {
      // Re-analyze the full catalog via the DB-backed endpoint — avoids
      // sending the entire ASIN list in the request body.
      await runAnalyzeAllFromDb(results.length);
    }
  }, [asins, results, runAnalysis, runAnalyzeAllFromDb]);

  const handleRefreshPrices = useCallback(async () => {
    setIsRefreshingPrices(true);
    setProgress({ current: 0, total: results.length || 0, asin: "Refreshing prices..." });
    try {
      const res = await fetch("/api/prices/refresh", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Price refresh failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let updated = 0;
      let failed = 0;
      let skipped = 0;
      let retried = 0;
      let recovered = 0;
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
              } else if (msg.type === "complete") {
                updated = msg.data?.updated ?? 0;
                failed = msg.data?.failed ?? 0;
                skipped = msg.data?.skipped ?? 0;
                retried = msg.data?.retried ?? 0;
                recovered = msg.data?.recovered ?? 0;
              }
            } catch {}
          }
        }
      }
      setLastRefreshFailedCount(skipped);
      const parts = [`Updated ${updated} ASIN${updated === 1 ? "" : "s"}`];
      if (recovered > 0) parts.push(`${recovered} recovered via targeted retry`);
      if (skipped > 0) parts.push(`${skipped} still missing`);
      toast({ title: "Prices refreshed", description: parts.join(", ") });
      await fetchAsins(startDate, endDate, showArchived);
    } catch (err: any) {
      toast({ title: "Price refresh failed", description: err.message, variant: "destructive" });
    } finally {
      setIsRefreshingPrices(false);
      setProgress(null);
      fetchPriceStatus();
    }
  }, [toast, results.length, fetchAsins, startDate, endDate, showArchived, fetchPriceStatus]);

  const [isSyncingCogs, setIsSyncingCogs] = useState(false);

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
    await fetchAsins(startDate, endDate, showArchived);
  }, [selectedSet, results, runAnalysis, fetchAsins, startDate, endDate, showArchived]);

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

  // Serialize the Set to a stable string key so useMemo detects changes reliably
  const selectedSearchAsinsKey = useMemo(
    () => Array.from(selectedSearchAsins).sort().join(","),
    [selectedSearchAsins],
  );

  const queryFilteredResults = useMemo(() => {
    let out = results;

    // Scorecard filter (Total / Profitable / Unprofitable / Buy List)
    if (activeFilter === "buyList") {
      out = out.filter((r) => buySet.has(r.asin));
    } else if (activeFilter === "profitable" || activeFilter === "unprofitable") {
      out = out.filter((r) => {
        if (r.error) return activeFilter === "unprofitable";
        const { price } = getSelectedPrice(r, priceSource);
        if (price == null || r.estimatedCogs == null) return activeFilter === "unprofitable";
        const prep = getEffectivePrep(r, settings);
        const storage = getEffectiveStorage(r, settings);
        const p = calculateProfit(price, r.estimatedCogs, r.feesData.fbaFulfillmentFee ?? 0, r.feesData.referralFee ?? 0, r.feesData.feesEstimatePrice, r.catalogData.weightLbs, prep.value, storage.value, settings, includeInboundShipping, r.isHazmat ?? false);
        const meets = p.roi >= settings.minRoiThreshold && p.margin >= settings.minMarginThreshold;
        return activeFilter === "profitable" ? meets : !meets;
      });
    }

    // "No prices" filter: show only ASINs missing all price data
    if (filterNoPrices) {
      out = out.filter((r) =>
        r.pricingData.lowestFbaPrice == null &&
        r.pricingData.buyBoxPrice == null &&
        r.pricingData.lowestPrice == null
      );
    }

    // "Uncalculated" filter: ASINs with error OR no selected price
    if (filterUncalculated) {
      out = out.filter((r) => {
        if (r.error) return true;
        const { price } = getSelectedPrice(r, priceSource);
        return price == null;
      });
    }

    // Multi-select search: if user has explicitly selected ASINs, filter to those
    if (selectedSearchAsins.size > 0) {
      out = out.filter((r) => selectedSearchAsins.has(r.asin));
    } else {
      const q = searchQuery.trim().toLowerCase();
      if (q) {
        out = out.filter((r) =>
          r.asin.toLowerCase().includes(q) ||
          (r.catalogData.title ?? "").toLowerCase().includes(q) ||
          (r.catalogData.brand ?? "").toLowerCase().includes(q) ||
          (r.skus ?? []).some((s) => s.toLowerCase().includes(q)) ||
          (r.sku ?? "").toLowerCase().includes(q)
        );
      }
    }
    // Visibility toggles (scope controls, not filters)
    if (!showGated) {
      out = out.filter((r) => (r.eligibilityData?.status ?? "check") !== "no");
    }
    if (!showMeltable) {
      out = out.filter((r) => !r.isMeltable);
    }
    // Apply replenishment preset filter
    if (presetFilter === "replenishment") {
      out = out.filter((r) => {
        // (A) Estimated profitability tiers — uses the same estimatedCogs + current price
        // computation shown in the Est. ROI / Est. Margin table columns
        const est = getEstimatedProfit(r, priceSource, settings, includeInboundShipping);
        if (!est) return false;
        const passesProfit =
          (est.roi > 25 && est.margin > 10) ||
          (est.roi > 20 && est.margin > 12) ||
          (est.roi > 15 && est.margin > 14);
        if (!passesProfit) return false;
        // (B) Minimum profit per unit — $3.00 floor
        if (est.profit < 3) return false;
        // (C) Sales gate — must have >0 units sold in the current date range
        const unitsSold = r.actuals?.units_sold ?? 0;
        return unitsSold > 0;
      });
    }
    // Apply column filters
    if (Object.keys(colFilters).length > 0) {
      out = out.filter((r) => {
        const { price } = getSelectedPrice(r, priceSource);
        const prep = getEffectivePrep(r, settings);
        const storage = getEffectiveStorage(r, settings);
        let profitData: ReturnType<typeof calculateProfit> | null = null;
        if (price != null && !r.error && r.estimatedCogs != null) {
          profitData = calculateProfit(price, r.estimatedCogs, r.feesData.fbaFulfillmentFee ?? 0, r.feesData.referralFee ?? 0, r.feesData.feesEstimatePrice, r.catalogData.weightLbs, prep.value, storage.value, settings, includeInboundShipping, r.isHazmat ?? false);
        }
        return matchesFilters(r as any, colFilters, (colId) => {
          switch (colId) {
            case "cogs": return r.actualCogs ?? null;
            case "estCogs": return r.estimatedCogs ?? null;
            case "brand": return r.catalogData.brand;
            case "supplier": return r.buyLink ? extractDomain(r.buyLink) : null;
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
            case "actRefundPct":
              return r.actuals && r.actuals.units_sold > 0
                ? (r.actuals.units_refunded / r.actuals.units_sold) * 100 : null;
            case "actProfit":
            case "actProfitPerUnit":
            case "actMargin":
            case "actRoi": {
              if (!r.actuals || r.actuals.units_sold === 0 || r.actualCogs == null) return null;
              const au = r.actuals.units_sold;
              const ar = r.actuals.revenue;
              const ap = getEffectivePrep(r, settings);
              const as2 = getEffectiveStorage(r, settings);
              const ac = calculateProfit(ar / au, r.actualCogs, r.feesData.fbaFulfillmentFee ?? 0, r.feesData.referralFee ?? 0, r.feesData.feesEstimatePrice, r.catalogData.weightLbs, ap.value, as2.value, settings, includeInboundShipping, r.isHazmat ?? false);
              if (colId === "actProfit") return ac.profit * au;
              if (colId === "actProfitPerUnit") return ac.profit;
              if (colId === "actMargin") return ac.margin;
              return ac.roi;
            }
            case "tags": return r.tags?.map((t) => t.name).join(", ") ?? null;
            case "notes": return r.notes ?? null;
            case "meltable": return r.isMeltable ? "Yes" : "No";
            case "hazmat": return r.isHazmat ? "Yes" : "No";
            case "suppressed": return r.isSearchSuppressed ? "Yes" : "No";
            case "lastReviewed": return r.lastReviewedAt ?? null;
            case "dateAdded": return r.addedAt ?? null;
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
              const { price: mcP } = getSelectedPrice(r, priceSource);
              const mcPrep = getEffectivePrep(r, settings);
              const mcStor = getEffectiveStorage(r, settings);
              return calculateMaxCogs(mcP, r.feesData.fbaFulfillmentFee, r.feesData.referralFee, r.feesData.feesEstimatePrice, r.catalogData.weightLbs, mcPrep.value, mcStor.value, settings, includeInboundShipping, r.isHazmat ?? false);
            }
            default: return null;
          }
        });
      });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, searchQuery, selectedSearchAsinsKey, showGated, showMeltable, priceSource, settings, includeInboundShipping, colFilters, presetFilter, activeFilter, buySet, filterNoPrices, filterUncalculated]);

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
  useEffect(() => { setPage(1); }, [searchQuery, selectedSearchAsinsKey, showGated, showMeltable, showArchived, colFilters, presetFilter, activeFilter, filterNoPrices, filterUncalculated]);

  const handleBulkSyncCogs = useCallback(async () => {
    const targetAsins = selectedSet.size > 0
      ? Array.from(selectedSet)
      : sortedFilteredResults.map((r) => r.asin);
    const eligible = targetAsins.filter((asin) => {
      const r = results.find((x) => x.asin === asin);
      return r && r.estimatedCogsSource === "manual";
    });
    if (eligible.length === 0) {
      toast({ title: "Nothing to sync", description: "No ASINs with manual/CSV Est. COGS in the current view." });
      return;
    }
    const confirmed = window.confirm(
      `This will overwrite manually-edited Est. COGS values with the latest PO COGS for ${eligible.length} ASIN${eligible.length !== 1 ? "s" : ""}. ASINs without PO data will be left unchanged. Continue?`
    );
    if (!confirmed) return;
    setIsSyncingCogs(true);
    try {
      const res = await fetch("/api/cogs/bulk-sync-from-po", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins: eligible }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Sync failed");
      toast({ title: "Est. COGS synced", description: `Synced ${data.synced} ASIN${data.synced !== 1 ? "s" : ""} from PO sheet. ${data.skipped} skipped (no PO data).` });
      await fetchAsins(startDate, endDate, showArchived);
    } catch (err: any) {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSyncingCogs(false);
    }
  }, [selectedSet, sortedFilteredResults, results, toast, fetchAsins, startDate, endDate, showArchived]);

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

  const activeFilterCount = getActiveFilterCount(colFilters, searchQuery) + (selectedSearchAsins.size > 0 ? 1 : 0) + (filterNoPrices ? 1 : 0) + (filterUncalculated ? 1 : 0);

  function clearSearchFilters() {
    setSearchQuery("");
    setSelectedSearchAsins(new Set());
    setColFilters({});
    setFilterNoPrices(false);
    setFilterUncalculated(false);
  }

  const progressPercent = progress
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="bg-background">
      <div className="py-6 space-y-6">
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
            <SettingsDialog onSettingsChange={setSettings} />
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
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefreshPrices}
              disabled={isRefreshingPrices || isAnalyzing}
              className="h-8 text-xs"
              data-testid="button-refresh-prices"
            >
              <DollarSign className={`h-3.5 w-3.5 mr-1.5 ${isRefreshingPrices ? "animate-pulse" : ""}`} />
              {isRefreshingPrices ? "Refreshing..." : "Refresh Prices"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleBulkSyncCogs}
              disabled={isSyncingCogs || isAnalyzing}
              className="h-8 text-xs"
            >
              <Sheet className="h-3.5 w-3.5 mr-1.5" />
              {isSyncingCogs ? "Syncing..." : "Reset Est. COGS to PO"}
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
                filterUncalculated={filterUncalculated}
                onFilterUncalculatedChange={setFilterUncalculated}
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
                  <span
                    className="text-xs text-muted-foreground whitespace-nowrap"
                    title={pricesLastRefreshedAt ? new Date(pricesLastRefreshedAt).toLocaleString() : undefined}
                    data-testid="text-prices-staleness"
                  >
                    · Prices: {formatRelativeTime(pricesLastRefreshedAt)}
                  </span>
                  {lastRefreshFailedCount > 0 && !filterNoPrices && (
                    <button
                      className="text-xs text-amber-500 hover:text-amber-400 whitespace-nowrap"
                      onClick={() => setFilterNoPrices(true)}
                    >
                      · {lastRefreshFailedCount} missing
                    </button>
                  )}
                  {filterNoPrices && (
                    <span className="inline-flex items-center gap-1 text-xs text-amber-500 whitespace-nowrap">
                      · Showing no-price ASINs
                      <button
                        className="text-muted-foreground hover:text-foreground underline"
                        onClick={() => setFilterNoPrices(false)}
                      >
                        Clear
                      </button>
                    </span>
                  )}
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
                <ExportButtons results={sortedFilteredResults} priceSource={priceSource} settings={settings} columnConfig={columnConfig} />
                <ViewPresets
                  columnConfig={columnConfig}
                  onColumnConfigChange={setColumnConfig}
                  onSortChange={(col, dir) => { setSortCol(col); setSortDir(dir); localStorage.setItem("fba-sort", JSON.stringify({ col, dir })); }}
                  onPresetFilterChange={setPresetFilter}
                  sortCol={sortCol}
                  sortDir={sortDir}
                  colFilters={colFilters}
                  onColFiltersChange={setColFilters}
                />
                <ColumnManager config={columnConfig} onChange={setColumnConfig} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 px-4">
              <MultiSearch
                results={results}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                selectedAsins={selectedSearchAsins}
                onSelectedAsinsChange={setSelectedSearchAsins}
              />
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
              {queryFilteredResults.length !== results.length && (
                <span className="text-xs text-muted-foreground ml-1">
                  {queryFilteredResults.length} of {results.length} shown
                </span>
              )}
            </div>

            <ResultsTable
              results={paginatedResults}
              allResults={results}
              startIndex={(safePage - 1) * pageSize}
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
      </div>

      <ActiveFiltersModal
        open={filtersModalOpen}
        onOpenChange={setFiltersModalOpen}
        colFilters={colFilters}
        searchQuery={searchQuery}
        onRemoveFilter={(colId) => setColFilters((prev) => { const next = { ...prev }; delete next[colId]; return next; })}
        onClearSearch={() => setSearchQuery("")}
        onClearAll={clearSearchFilters}
      />

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
