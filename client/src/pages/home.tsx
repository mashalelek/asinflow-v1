import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { RevivalDialog, type RevivalCandidate } from "@/components/revival-dialog";
import { OfferAddPreviewDialog, type PreviewResponse, type SubmitResponse } from "@/components/offer-add-preview-dialog";
import { VerificationChip } from "@/components/verification-chip";
import { VerificationPanel } from "@/components/verification-panel";
import { getUnverified, submissionCategory, type UnverifiedResponse } from "@/lib/submissions-api";
import { LegendApprovalDialog, type PendingLegendItem, type ApprovedBrandOption } from "@/components/legend-approval-dialog";
import { FileUpload } from "@/components/file-upload";
import { ResultsTable, getRowValue, isSubmissionPending } from "@/components/results-table";
import { ExportButtons } from "@/components/export-buttons";
import { SummaryCards, type FilterMode } from "@/components/summary-cards";
import { ColumnManager } from "@/components/column-manager";
import { useTheme } from "@/components/theme-provider";
import { loadSettings, loadIncludeInbound, saveIncludeInbound, loadPriceSource, savePriceSource } from "@/lib/settings";
import { useSearch } from "wouter";
import { loadColumnConfig, type ColumnConfig } from "@/lib/columns";
import { JobsDialog } from "@/components/jobs-dialog";
import { useJobs } from "@/hooks/use-jobs";
import { enqueueRefresh, cancelJob, getJob, runningLabel, queuedLabel, completionText, FOCUS_ASIN_EVENT, type Job } from "@/lib/jobs-api";
import { refreshPlan, queuedJobIdFromMessage, duplicateJobFromMessage, applyStreamedRow } from "@/lib/upload-flow";
import { rowsToRefresh, mergeRefreshedRows, RowRefresher, staleRowsDue } from "@/lib/row-refresh";
import { buildFilterChips, addedHiddenReport, type FilterChipKey } from "@/lib/filter-chips";
import { FilterChipsBar } from "@/components/filter-chips-bar";
import { formatFilterValue } from "@/components/active-filters-modal";
import { ALL_COLUMNS as ALL_COLUMN_DEFS } from "@shared/schema";
import { ToastAction } from "@/components/ui/toast";
import { loadBuyList, saveBuyList, loadOnHoldList, saveOnHoldList } from "@/lib/buy-hold";
import { planBulkSetToggle, bulkToggleLabel, applyBulkPlan } from "@/lib/bulk-buy-hold";
import { fetchLongSync } from "@/lib/long-sync";
import { Sun, Moon, BarChart3, Zap, AlertTriangle, X, Search, RefreshCw, Archive, Sheet, Database, ShoppingCart, DollarSign, FileSpreadsheet, Upload, Plus, ScanSearch, History } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  appliesDgHazmatSurcharge,
} from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { useDateRange } from "@/contexts/date-range-context";
import { OPEN_SETTINGS_EVENT } from "@/components/layout/top-nav";
import { ViewPresets } from "@/components/view-presets";
import { StockHistoryModal } from "@/components/stock-history-modal";
import { type ColFilter, type FilterMap, matchesFilters } from "@/components/column-filter";
import { VisibilityToggles, loadShowGated, saveShowGated, loadShowMeltable, saveShowMeltable, loadShowParked, saveShowParked, loadShowDead, saveShowDead } from "@/components/visibility-toggles";
import { getEstimatedProfit } from "@/lib/profit";
import { isProfitable, isReplens } from "@shared/profitability";
import { ActiveFiltersModal, getActiveFilterCount } from "@/components/active-filters-modal";
import { Filter, Loader2 } from "lucide-react";

const DATE_PREFS_KEY = "fba-date-prefs";
const COL_FILTERS_KEY = "fba-col-filters";

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

// loadIncludeInbound moved to @/lib/settings (2026-09-09) — one key for
// every page (§21 settings-drift fix).

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

type SbSummary = {
  emitted: number;
  asins: number;
  periods: number;
  rawRowsRead: number;
  blankAsinRows: number;
  includedRows: number;
  templateRowsLoaded: number;
  templateRowsDropped: number;
  skips: {
    excludedByStatus: number; badDate: number; excludedNonYtd: number; badCost: number;
    badQty: number; sameDateMerged: number; fractionalCollapsed: number; fractionalRounded: number;
    notInSb: number; inSbNoUsableSku: number;
  };
  notInSbAsins: string[];
  inSbNoUsableSkuAsins: string[];
  badQtyRows: { asin: string; date: string; rawQty: string; mode: string }[];
  fractionalCollapsed: { asin: string; rowsFolded: number; qty: number; cost: number; date: string }[];
  fractionalRounded: { asin: string; rawSum: number; rounded: number }[];
};

// Amazon sourcing cost export (Manage Your Sourcing Cost bulk update). No
// SP-API exists for this, so the flow is: download Amazon's workbook → run it
// through here → upload the filled copy in Seller Central.
type ScSummary = {
  from: string;
  to: string;
  rowsWritten: number;
  asinsWritten: number;
  purchasedAsins: number;
  asinsWithPoCogs: number;
  sheetsScanned: number;
  workbookRowsRead: number;
  workbookAsins: number;
  rawRowsRead: number;
  blankAsinRows: number;
  includedRows: number;
  skips: {
    excludedByStatus: number; badDate: number; outOfRange: number;
    noCogsRow: number; notPoSourced: number; badCost: number;
    notInWorkbook: number; alreadyApproved: number; wouldLowerApproved: number;
  };
  noCogsRowAsins: string[];
  notPoSourcedAsins: { asin: string; source: string | null }[];
  badCostAsins: { asin: string; cogs: string }[];
  notInWorkbookAsins: string[];
  alreadyApprovedAsins: string[];
  wouldLowerAsins: { asin: string; approved: number; cost: number; source: string | null }[];
  written: { asin: string; fnskus: string[]; cost: number; wasApproved: number | null; source: string | null }[];
};

type ScExportRecord = {
  id: number;
  filename: string;
  rangeStart: string;
  rangeEnd: string;
  purchasedAsins: number;
  asinsWritten: number;
  rowsWritten: number;
  createdAt: string;
};

export default function Home() {
  // Theme toggle is now in the top nav
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(loadColumnConfig);
  const [asins, setAsins] = useState<AsinInput[]>([]);
  const queuedJobIdsRef = useRef<number[]>([]);
  const [results, setResults] = useState<AsinResult[]>([]);
  // Shared + persisted (2026-09-09): fba-price-source, same key as Bulk Calc.
  const [priceSource, setPriceSource] = useState<PriceSource>(loadPriceSource);
  useEffect(() => { savePriceSource(priceSource); }, [priceSource]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [credentialsConfigured, setCredentialsConfigured] = useState<boolean | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterMode>("all");
  const [buySet, setBuySet] = useState<Set<string>>(loadBuyList);
  const [onHoldSet, setOnHoldSet] = useState<Set<string>>(loadOnHoldList);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  // Mirrors sortedFilteredResults so selection-aware handlers (declared before
  // the memo) can read the latest filtered working set without a TDZ.
  const sortedFilteredResultsRef = useRef<AsinResult[]>([]);
  const [sortCol, setSortCol] = useState<ColumnId | null>(() => {
    try { const s = localStorage.getItem("fba-sort"); if (s) { const p = JSON.parse(s); return p.col; } } catch {} return "roi";
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    try { const s = localStorage.getItem("fba-sort"); if (s) { const p = JSON.parse(s); return p.dir; } } catch {} return "desc";
  });
  const [searchQuery, setSearchQuery] = useState("");

  // §21 pre-filter link target: /asins?q=<ASIN> (the bulk page's in_database
  // icon). Seeds the search box from the ?q= param; inert when absent.
  // Parked/dead ASINs stay hidden (toggles off) — same as a manual search.
  const urlSearch = useSearch();
  useEffect(() => {
    const q = new URLSearchParams(urlSearch).get("q");
    if (q) setSearchQuery(q);
  }, [urlSearch]);
  const [selectedSearchAsins, setSelectedSearchAsins] = useState<Set<string>>(new Set());
  const [colFilters, setColFilters] = useState<FilterMap>(loadColFilters);
  const [showGated, setShowGated] = useState(loadShowGated);
  const [showMeltable, setShowMeltable] = useState(loadShowMeltable);
  // §14 parked/dead (2026-09-07): Show parked replaced Show archived (same
  // persistence); Show dead is a new default-off scope toggle.
  const [showParked, setShowParked] = useState(loadShowParked);
  const [showDead, setShowDead] = useState(loadShowDead);
  const [filtersModalOpen, setFiltersModalOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(() => {
    try { const v = localStorage.getItem("fba-page-size"); return v ? parseInt(v) : 100; } catch { return 100; }
  });
  const [historyAsin, setHistoryAsin] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [dbLoaded, setDbLoaded] = useState(false);
  // The full-list load (2026-10-18): a slow or failed load must never look
  // like an empty page — "loading" shows an indicator in the table area,
  // "error" shows the reason and a Retry.
  const [listLoad, setListLoad] = useState<{ state: "loading" | "ready" | "error"; error?: string }>({ state: "loading" });
  // Added-ASIN report (2026-10-18): after Upload File / Sync Sourcing, how many of the
  // added ASINs the current filters hide; "Show" reveals just those past every filter.
  const [revealAsins, setRevealAsins] = useState<Set<string>>(new Set());
  const [pendingAdded, setPendingAdded] = useState<{ asins: string[]; title: string; base: string } | null>(null);
  const addedWatchRef = useRef<{ asins: string[]; hidden: number; recheck: boolean } | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  // Scheduler v1 (SPEC §11 "Refresh job", 2026-10-15): ONE Refresh button
  // enqueues a job; the jobs dialog is the history and the per-component
  // report. Product Info / Prices & Stock and their dialogs are gone.
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobsInitialId, setJobsInitialId] = useState<number | null>(null);
  const [isSyncingSourcing, setIsSyncingSourcing] = useState(false);
  const [isPushingAura, setIsPushingAura] = useState(false);
  // §18 full-scope listing scan (item 8): streaming progress + report dialog.
  // SellerBoard COGS export (interim). File picker → upload template → download
  // CSV from the JSON response → show summary modal.
  const [isExportingSb, setIsExportingSb] = useState(false);
  const [sbResult, setSbResult] = useState<{ filename: string; summary: SbSummary } | null>(null);
  const sbFileInputRef = useRef<HTMLInputElement>(null);
  // Amazon sourcing cost export. Same file-picker shape as the SB export, but
  // the uploaded workbook IS the output — we fill one column and hand it back.
  const [isExportingSc, setIsExportingSc] = useState(false);
  const [scResult, setScResult] = useState<{ filename: string; summary: ScSummary } | null>(null);
  const [scHistory, setScHistory] = useState<ScExportRecord[] | null>(null);
  const [scHistoryOpen, setScHistoryOpen] = useState(false);
  const scFileInputRef = useRef<HTMLInputElement>(null);

  // DA-3: revival dialog state. Populated by checkRevivalCandidates after
  // every analyze-completion path (handleAnalyze, runAnalyzeAllFromDb,
  // handleSyncSourcing). Cleared on confirm/cancel.
  const [revivalCandidates, setRevivalCandidates] = useState<RevivalCandidate[]>([]);
  const [revivalDialogOpen, setRevivalDialogOpen] = useState(false);

  // 2D-3: offer-add preview dialog state. Triggered by "Add to SC" toolbar
  // button (selection-aware) or per-row "+" button. Dry-run only — no live
  // putListingsItem fires from this UI.
  const [offerAddOpen, setOfferAddOpen] = useState(false);
  const [offerAddLoading, setOfferAddLoading] = useState(false);

  // Post-submit verification: chip count + panel data. Refetched on mount, when
  // the offer-add dialog closes (new pending rows), and after verify/resolve.
  const [unverified, setUnverified] = useState<UnverifiedResponse | null>(null);
  const [verifyPanelOpen, setVerifyPanelOpen] = useState(false);
  const fetchUnverified = useCallback(async () => {
    try { setUnverified(await getUnverified()); } catch { /* non-blocking status widget */ }
  }, []);
  useEffect(() => { fetchUnverified(); }, [fetchUnverified]);
  const [offerAddData, setOfferAddData] = useState<PreviewResponse | null>(null);
  const [offerAddError, setOfferAddError] = useState<string | null>(null);
  // Remember the ASINs being previewed so we can re-fetch after legend approvals.
  const [offerAddAsins, setOfferAddAsins] = useState<string[]>([]);

  // 2D-2: legend approval sub-dialog state. Launched from preview's "Need approval" section.
  const [legendDialogOpen, setLegendDialogOpen] = useState(false);
  const [legendPending, setLegendPending] = useState<PendingLegendItem[]>([]);
  const [approvedBrands, setApprovedBrands] = useState<ApprovedBrandOption[]>([]);
  const [pricesLastRefreshedAt, setPricesLastRefreshedAt] = useState<string | null>(null);
  const [filterUncalculated, setFilterUncalculated] = useState(false);

  const [includeInboundShipping, setIncludeInboundShipping] = useState(loadIncludeInbound);

  // Date range is global (top-nav DataStudioDatePicker) and persisted by the
  // context. This page only reads from it.
  const { range: dateRange } = useDateRange();
  const startDate = dateRange.start;
  const endDate = dateRange.end;
  const dateRangeLabel = useMemo(() => formatDateLabel(startDate, endDate), [startDate, endDate]);

  // Settings dialog: top-nav settings icon dispatches a window event we listen for.
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handler);
  }, []);

  useEffect(() => {
    saveIncludeInbound(includeInboundShipping);
  }, [includeInboundShipping]);

  useEffect(() => {
    localStorage.setItem(COL_FILTERS_KEY, JSON.stringify(colFilters));
  }, [colFilters]);

  const fetchAsins = useCallback((start: string, end: string, parked = false, dead = false) => {
    setListLoad({ state: "loading" });
    return fetch(`/api/asins?startDate=${start}&endDate=${end}${parked ? "&includeParked=true" : ""}${dead ? "&includeDead=true" : ""}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({} as any));
          throw new Error(body?.message || `the server answered ${r.status}`);
        }
        return r.json();
      })
      .then((data: AsinResult[]) => {
        if (!Array.isArray(data)) throw new Error("unexpected response from the server");
        staleAsinsRef.current.clear(); // a full list is fresh
        if (data.length > 0) setResults(data);
        setSavedCount(data.length);
        setDbLoaded(true);
        setListLoad({ state: "ready" });
      })
      .catch((err: any) => {
        setDbLoaded(true);
        setListLoad({ state: "error", error: err?.message ?? String(err) });
      });
  }, []);

  useEffect(() => {
    fetchAsins(startDate, endDate, showParked, showDead);
  }, [startDate, endDate, showParked, showDead]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // DA-3: cheap GET against the standing-state predicate. Fires after every
  // analyze-completion path. Empty result → no dialog (silent).
  // Declared ahead of the analyze handlers because their useCallback closures
  // reference it.
  const checkRevivalCandidates = useCallback(async () => {
    try {
      const res = await fetch("/api/asins/revival-candidates");
      if (!res.ok) return;
      const candidates = await res.json();
      if (Array.isArray(candidates) && candidates.length > 0) {
        setRevivalCandidates(candidates);
        setRevivalDialogOpen(true);
      }
    } catch {
      // Non-critical UX nicety — swallow errors silently.
    }
  }, []);

  const handleRevive = useCallback(async (selectedAsins: string[]) => {
    try {
      const res = await fetch("/api/asins/revive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins: selectedAsins }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Revive failed");
      const desc = data.skipped?.length > 0
        ? `Unarchived ${data.revived.length}; ${data.skipped.length} skipped (no longer eligible)`
        : `Unarchived ${data.revived.length}`;
      toast({ title: "Catalog revival", description: desc });
      setRevivalDialogOpen(false);
      await fetchAsins(startDate, endDate, showParked, showDead);
    } catch (err: any) {
      toast({ title: "Revive failed", description: err.message, variant: "destructive" });
    }
  }, [toast, fetchAsins, startDate, endDate, showParked, showDead]);

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
          const queuedId = queuedJobIdFromMessage(msg);
          const dup = duplicateJobFromMessage(msg);
          if (dup) {
            // Refused as a repeat (same ASINs onboarded < 10 min ago): no longer pending.
            setAsins([]);
            toast({ title: "Already onboarded", description: `These ASINs were onboarded a few minutes ago (job #${dup.jobId}, ${dup.status}) — not run again.` });
          } else if (queuedId != null) {
            // The upload is on the queue now: it is no longer pending (fix
            // 2026-10-18) — the next Refresh click is a normal Refresh.
            queuedJobIdsRef.current.push(queuedId);
            setAsins([]);
          } else if (msg.type === "progress") {
            setProgress(msg.data);
          } else if (msg.type === "result") {
            const resultData = msg.data;
            // Non-empty-wins merge (fix 2026-10-18): a streamed row — e.g. an
            // onboarding placeholder with empty catalog / pricing — adds a row
            // that is not on screen but never blanks a value already shown.
            if (resultData._update) delete resultData._update;
            setResults((prev) => {
              if (prev.findIndex((r) => r.asin === resultData.asin) < 0) setSavedCount((c) => (c ?? 0) + 1);
              return applyStreamedRow(prev, resultData);
            });
          }
        } catch {}
      }
    }
  }, []);

  const BATCH_SIZE_LIMIT = 200;
  const FRONTEND_BATCH_SIZE = 100;

  // Upload path (until scheduler commit 3 rewires onboarding to enqueue):
  // a pending CSV upload is onboarded through /api/analyze, which inserts
  // the rows and runs their first Product Info + prices + fees inline.
  const runAnalysis = useCallback(async (asinsToAnalyze: AsinInput[]) => {
    let uploaded: string[] | null = null;
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
      } else {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asins: asinsToAnalyze }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.message || "Upload failed");
        }
        await consumeAnalyzeStream(res);
      }
      uploaded = Array.from(new Set(asinsToAnalyze.map((a) => a.asin.trim().toUpperCase())));
    } catch (err: any) {
      toast({
        title: "Upload failed",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
      setProgress(null);
      fetchPriceStatus();
      await fetchAsins(startDate, endDate, showParked, showDead);
      // "11 added — 8 hidden by your filters [Show]", once the list holds them.
      if (uploaded) setPendingAdded({ asins: uploaded, title: "Upload onboarded", base: "" });
      await checkRevivalCandidates(); // DA-3
    }
  }, [toast, consumeAnalyzeStream, fetchPriceStatus, fetchAsins, startDate, endDate, showParked, showDead, checkRevivalCandidates]);

  // (runAnalyzeAllFromDb and handleAnalyze removed 2026-10-15: the Refresh
  // job replaces Product Info — see handleRefresh.)


  const [isSyncingCogs, setIsSyncingCogs] = useState(false);

  // Mutual exclusivity: an ASIN is in Buy List, On Hold, or neither — never
  // both. Both toggles enforce this in the SAME synchronous handler so the
  // two sets can't drift apart between renders. Single source of truth: these
  // two toggles are the ONLY callers that mutate either set (besides
  // handleClearBuyList for the Buy List).
  const handleToggleBuy = useCallback((asin: string) => {
    setBuySet((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      saveBuyList(next);
      return next;
    });
    // If we're ADDING to Buy List (not removing), evict from On Hold.
    setOnHoldSet((prev) => {
      if (!prev.has(asin)) return prev;
      const next = new Set(prev);
      next.delete(asin);
      saveOnHoldList(next);
      return next;
    });
  }, []);

  const handleToggleHold = useCallback((asin: string) => {
    setOnHoldSet((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      saveOnHoldList(next);
      return next;
    });
    setBuySet((prev) => {
      if (!prev.has(asin)) return prev;
      const next = new Set(prev);
      next.delete(asin);
      saveBuyList(next);
      return next;
    });
  }, []);


  // §21 Bulk Buy List / Hold (2026-10-03). Same shared sets, same toggle
  // semantics as Bulk Calc — minus the promote step: everything on this
  // page is already in `asins`, so every selected ASIN lands.
  const buyPlan = useMemo(
    () => planBulkSetToggle(Array.from(selectedSet), buySet),
    [selectedSet, buySet],
  );
  const holdPlan = useMemo(
    () => planBulkSetToggle(Array.from(selectedSet), onHoldSet),
    [selectedSet, onHoldSet],
  );

  const runBulkSet = useCallback((which: "buy" | "hold") => {
    const plan = which === "buy" ? buyPlan : holdPlan;
    if (plan.selectedCount === 0 || plan.targets.length === 0) return;
    const landed = new Set(plan.targets); // nothing to promote → all land
    const next = applyBulkPlan(plan, landed, {
      target: which === "buy" ? buySet : onHoldSet,
      other: which === "buy" ? onHoldSet : buySet,
    });
    if (which === "buy") {
      setBuySet(next.target); saveBuyList(next.target);
      setOnHoldSet(next.other); saveOnHoldList(next.other);
    } else {
      setOnHoldSet(next.target); saveOnHoldList(next.target);
      setBuySet(next.other); saveBuyList(next.other);
    }
    const name = which === "buy" ? "Buy List" : "Hold";
    toast({
      title: plan.direction === "add"
        ? `Added ${plan.targets.length} to ${name}`
        : `Removed ${plan.targets.length} from ${name}`,
    });
  }, [buyPlan, holdPlan, buySet, onHoldSet, toast]);

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

  // Compute the current working set for selection-aware sync handlers.
  // Selection wins; otherwise we send the current filtered view explicitly.
  //
  // MUST be useCallback (not a plain function re-created each render). As a
  // plain function, every caller has to remember to list `selectedSet` in
  // their own deps — and any caller that forgets gets a stale closure that
  // silently falls through to the filtered-view branch. That bit Add-to-SC
  // on 2026-06-29 — user selected 3 rows, action resolved 90 (the active
  // Buy List filter view). A stable reference removes the footgun.
  //
  // sortedFilteredResultsRef is a ref → stable across renders, no dep needed.
  const currentWorkingSet = useCallback((): string[] => {
    return selectedSet.size > 0
      ? Array.from(selectedSet)
      : sortedFilteredResultsRef.current.map((r) => r.asin);
  }, [selectedSet]);

  const handleSyncSheet = useCallback(async () => {
    const ws = currentWorkingSet();
    if (ws.length === 0) return;
    setIsSyncing(true);
    try {
      const data = await fetchLongSync("/api/sheets/sync", { asins: ws });
      // Two outcomes (patch po-sheet-sync §4): the whole-sheet PO sync first,
      // then the per-ASIN COGS/ordered-qty sync for the working set.
      const po = data.poSync;
      const poLine = !po ? "POs: not run"
        : "error" in po ? `POs: FAILED — ${po.error}`
        : po.stop ? `POs: STOPPED, nothing written — ${po.stop}`
        : `POs: +${po.counts.inserted} new${po.counts.sheetDiffers ? `, ${po.counts.sheetDiffers} existing differ from the sheet (AF owns them — not applied)` : ""}${po.counts.tombstoned ? `, ${po.counts.tombstoned} deleted in AF (not re-imported)` : ""}${po.counts.skippedBadCells ? `, ${po.counts.skippedBadCells} skipped (bad cell)` : ""}`;
      const asinLine = `ASINs: updated ${data.updated}, skipped ${data.skipped}${data.cleared ? `, cleared ${data.cleared} stale qty` : ""}`;
      const poFailed = !po || "error" in po || Boolean(po.stop);
      toast({ title: poFailed ? "Synced ASINs; PO sync did not complete" : "Synced POs and ASINs", description: `${poLine}. ${asinLine}`, variant: poFailed ? "destructive" : undefined });
      await fetchAsins(startDate, endDate, showParked, showDead);
    } catch (err: any) {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSyncing(false);
    }
  }, [toast, currentWorkingSet, fetchAsins, startDate, endDate, showParked, showDead]);

  // ── Scheduler v1 (SPEC §11 "Refresh job", 2026-10-15) ────────────────────
  // Job-finish row refresh (performance, 2026-10-18): a finished job reloads
  // only the rows of its scope that are on the current page — never the full
  // list; a scheduled pass (no scope) reloads the visible page once. One
  // request at a time per tab (RowRefresher coalesces), each job handled once.
  const visibleAsinsRef = useRef<string[]>([]);
  const loadedAsinsRef = useRef<string[]>([]);
  const staleAsinsRef = useRef<Set<string>>(new Set());
  const rangeRef = useRef({ startDate, endDate, showParked, showDead });
  rangeRef.current = { startDate, endDate, showParked, showDead };
  const rowRefresher = useMemo(() => new RowRefresher(async (asins) => {
    const { startDate: s, endDate: e, showParked: p, showDead: d } = rangeRef.current;
    const res = await fetch(`/api/asins?startDate=${s}&endDate=${e}${p ? "&includeParked=true" : ""}${d ? "&includeDead=true" : ""}&asins=${encodeURIComponent(asins.join(","))}`);
    if (!res.ok) return;
    const fresh: AsinResult[] = await res.json();
    setResults((prev) => mergeRefreshedRows(prev, fresh, asins));
  }), []);
  const refreshJobRows = useCallback((job: Job) => {
    if (!rowRefresher.seenJob(job.id)) return;
    // The ASINs just added by an upload / sourcing sync count as on screen until their
    // onboarding job finishes — their gating (and so whether a filter hides them) is
    // only known then, and a hidden row would otherwise never be refreshed.
    const watch = addedWatchRef.current;
    const extra = watch && job.scope_asins ? watch.asins.filter((a) => job.scope_asins!.map((x) => String(x).toUpperCase()).includes(a)) : [];
    if (watch && extra.length > 0) watch.recheck = true;
    const asins = Array.from(new Set([...rowsToRefresh(job, visibleAsinsRef.current), ...extra]));
    // Rows of the job's scope that are loaded but off screen are now stale: they
    // refresh when they come on screen (paging, a filter change), not before.
    const now = new Set(asins);
    const loaded = loadedAsinsRef.current;
    const touched = job.scope_asins == null ? loaded : job.scope_asins.map((a) => String(a).toUpperCase()).filter((a) => loaded.includes(a));
    for (const a of touched) if (!now.has(a)) staleAsinsRef.current.add(a);
    if (asins.length > 0) void rowRefresher.request(asins);
  }, [rowRefresher]);

  // Completion notification (decision 16): a toast for jobs this tab is
  // watching — its own manual jobs, and any scheduled job that finishes
  // while the tab is open — with a Changes link when the job flipped any
  // gating or suppression state. Never price counts. The table reloads so
  // the new values show.
  const onJobFinished = useCallback((job: Job) => {
    const { title, description } = completionText(job);
    const flips = job.summary?.flips?.length ?? 0;
    toast({
      title,
      description,
      variant: job.status === "failed" ? "destructive" : undefined,
      action: flips > 0
        ? <ToastAction altText="Show changes" onClick={() => { setJobsInitialId(job.id); setJobsOpen(true); }}>Changes</ToastAction>
        : undefined,
    });
    refreshJobRows(job);
    fetchPriceStatus();
  }, [toast, refreshJobRows, fetchPriceStatus]);
  // Any other finished job (onboarding, another tab's Refresh, bulk): only
  // the rows of its scope that are on screen reload (2026-10-18).
  const onJobSettled = useCallback((job: Job) => { refreshJobRows(job); }, [refreshJobRows]);
  const jobs = useJobs(onJobFinished, onJobSettled);

  // Refresh (N): scope = the checkbox selection, else every row of the
  // current filtered view (decision 15). asinsOverride powers Retry failed.
  // A pending CSV upload is onboarded first (scheduler commit 3 moves that
  // onto the queue too).
  const handleRefresh = useCallback(async (asinsOverride?: string[]) => {
    // A pending upload is onboarded ONCE; its "job_queued" message clears it,
    // so every later click is a normal Refresh (fix 2026-10-18).
    const plan = asinsOverride ? { kind: "refresh" as const } : refreshPlan(asins);
    if (plan.kind === "onboard_upload") {
      queuedJobIdsRef.current = [];
      await runAnalysis(plan.asins);
      for (const id of queuedJobIdsRef.current) {
        try { const { job } = await getJob(id); jobs.watch(job); } catch { /* the job dialog still lists it */ }
      }
      return;
    }
    const ws = asinsOverride ?? currentWorkingSet();
    if (ws.length === 0) return;
    try {
      const { job, ahead } = await enqueueRefresh(ws);
      jobs.watch(job);
      toast({
        title: ahead > 0 ? `Refresh queued (${ahead} ahead)` : "Refresh queued",
        description: `${ws.length} ASIN${ws.length === 1 ? "" : "s"}, all components. Progress shows on the button.`,
      });
    } catch (err: any) {
      toast({ title: "Refresh could not be queued", description: err.message, variant: "destructive" });
    }
  }, [asins, runAnalysis, currentWorkingSet, jobs, toast]);

  const handleCancelMine = useCallback(async () => {
    const j = jobs.mine?.job;
    if (!j) return;
    try {
      await cancelJob(j.id);
      toast({ title: "Refresh cancelled", description: `Job #${j.id} stops at its next checkpoint; partial results stay in the ledger.` });
      void jobs.refresh();
    } catch (err: any) {
      toast({ title: "Cancel failed", description: err.message, variant: "destructive" });
    }
  }, [jobs, toast]);

  // The Changes panel's ASIN links: filter the table to that row.
  useEffect(() => {
    const h = (e: Event) => {
      const asin = (e as CustomEvent).detail?.asin;
      if (asin) { setSearchQuery(String(asin)); setJobsOpen(false); }
    };
    window.addEventListener(FOCUS_ASIN_EVENT, h);
    return () => window.removeEventListener(FOCUS_ASIN_EVENT, h);
  }, []);



  // Push to Aura — POSTs to /api/sync/aura/push. Selection-aware: when ASINs
  // are checked, scopes to those; otherwise all. The server reads the PO
  // sheet for that selection first (a component-9 job on the queue, scheduler
  // decision 9), then pushes — so the costs pushed are this minute's.
  const handlePushAura = useCallback(async () => {
    setIsPushingAura(true);
    const selected = Array.from(selectedSet);
    try {
      const data = await fetchLongSync("/api/sync/aura/push", selected.length > 0 ? { asins: selected } : {});
      const prefix = selected.length > 0 ? `Aura (${selected.length} selected)` : "Aura";
      const notIn = (data.notInAura?.length ?? 0) > 0 ? `, ${data.notInAura.length} not in Aura` : "";
      toast({ title: "Aura push complete", description: `${prefix}: ${data.pushed} pushed, ${data.unchanged} unchanged, ${data.skipped} skipped${notIn}` });
    } catch (err: any) {
      toast({ title: "Aura push failed", description: err.message, variant: "destructive" });
    } finally {
      setIsPushingAura(false);
    }
  }, [toast, selectedSet]);

  // SellerBoard COGS export — opens the template file picker; the upload+download
  // happens in handleSbTemplateSelected.
  const handleExportSbCogs = useCallback(() => {
    sbFileInputRef.current?.click();
  }, []);

  const handleSbTemplateSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setIsExportingSb(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/export/sellerboard-cogs", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "SellerBoard COGS export failed");
      // Build the download from the CSV string in the response.
      const blob = new Blob([data.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
      setSbResult({ filename: data.filename, summary: data.summary });
    } catch (err: any) {
      toast({ title: "SB COGS export failed", description: err.message, variant: "destructive" });
    } finally {
      setIsExportingSb(false);
    }
  }, [toast]);

  // Amazon sourcing cost export — opens the workbook picker; the upload +
  // download happens in handleScWorkbookSelected.
  const handleExportSourcingCost = useCallback(() => {
    scFileInputRef.current?.click();
  }, []);

  const handleScWorkbookSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setIsExportingSc(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("from", startDate);
      fd.append("to", endDate);
      const res = await fetch("/api/export/sourcing-cost", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "COGS update export failed");
      // Rebuild the xlsx from base64 — the response is JSON so the summary can
      // ride along with the file.
      const bytes = Uint8Array.from(atob(data.xlsxBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
      setScResult({ filename: data.filename, summary: data.summary });
      setScHistory(null); // stale — refetched on next open
    } catch (err: any) {
      toast({ title: "COGS update export failed", description: err.message, variant: "destructive" });
    } finally {
      setIsExportingSc(false);
    }
  }, [toast, startDate, endDate]);

  const handleOpenScHistory = useCallback(async () => {
    setScHistoryOpen(true);
    if (scHistory) return;
    try {
      const res = await fetch("/api/export/sourcing-cost/history");
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Could not load export history");
      setScHistory(data.exports);
    } catch (err: any) {
      toast({ title: "Export history failed", description: err.message, variant: "destructive" });
    }
  }, [toast, scHistory]);


  // Insert-only sync from the sourcing Google Sheet. Pre-existing ASINs in AF
  // are skipped server-side — the sheet only adds. Streams NDJSON: sync_summary
  // line up front, then standard analyze progress/result chunks for each new
  // ASIN, then complete with final counts.
  const handleSyncSourcing = useCallback(async () => {
    setIsSyncingSourcing(true);
    let plan: { newCount: number; skippedExisting: number; toArchiveCount: number } | null = null;
    let final: { inserted: number; archivedNew: number; skippedExisting: number; errors: string[] } | null = null;
    const addedAsins = new Set<string>();
    try {
      const res = await fetch("/api/sync/sourcing-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Sourcing sync failed");
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
              if (msg.type === "sync_summary") {
                plan = msg.data;
                if (plan && plan.newCount > 0) {
                  setProgress({ current: 0, total: plan.newCount, asin: "Fetching new ASIN data..." });
                }
              } else if (msg.type === "progress") {
                setProgress(msg.data);
              } else if (msg.type === "result" && msg.data?.asin) {
                addedAsins.add(String(msg.data.asin).toUpperCase());
              } else if (msg.type === "complete") {
                final = msg.data;
              } else if (msg.type === "error") {
                throw new Error(msg.data?.message || "Sourcing sync failed");
              }
            } catch (parseErr: any) {
              if (parseErr?.message && parseErr.message !== "Sourcing sync failed") continue;
              throw parseErr;
            }
          }
        }
      }
      const f = final ?? { inserted: plan?.newCount ?? 0, archivedNew: 0, skippedExisting: plan?.skippedExisting ?? 0, errors: [] };
      await fetchAsins(startDate, endDate, showParked, showDead);
      // One toast: the sync counts + how many of the added ASINs the filters hide [Show].
      setPendingAdded({ asins: Array.from(addedAsins), title: "Sourcing sheet synced", base: `${f.inserted} inserted, ${f.archivedNew} archived (discontinued), ${f.skippedExisting} already in AF` });
      await checkRevivalCandidates(); // DA-3
    } catch (err: any) {
      toast({ title: "Sourcing sync failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSyncingSourcing(false);
      setProgress(null);
    }
  }, [toast, fetchAsins, startDate, endDate, showParked, showDead, checkRevivalCandidates]);

  // 2D-3: open preview dialog for a set of ASINs. Fires POST /api/offer-add/preview
  // (server runs the orchestrator with dryRun=true). Result rendered in dialog.
  const openOfferAddPreview = useCallback(async (asinsToPreview: string[]) => {
    if (asinsToPreview.length === 0) return;
    setOfferAddAsins(asinsToPreview);
    setOfferAddOpen(true);
    setOfferAddLoading(true);
    setOfferAddData(null);
    setOfferAddError(null);
    try {
      // NDJSON with heartbeats (scheduler decision 9): the server first probes
      // gating live for these ASINs through the job queue — behind a running
      // scheduled pass that can take a while — then assembles the preview.
      const data = await fetchLongSync("/api/offer-add/preview", { asins: asinsToPreview });
      setOfferAddData(data);
    } catch (err: any) {
      setOfferAddError(err.message);
    } finally {
      setOfferAddLoading(false);
    }
  }, []);

  // 2D-2: extract legend_pending items from the current preview, fetch the
  // fresh approved-brand list (for the merge dropdown), open the sub-dialog.
  const handleReviewApprovals = useCallback(async () => {
    if (!offerAddData) return;
    // Dedupe pending by (type, rawValue) — multiple ASINs may share a brand
    const seen = new Set<string>();
    const pending: PendingLegendItem[] = [];
    for (const row of offerAddData.perAsin) {
      if (row.outcome.kind !== "legend_pending" || !row.outcome.pending) continue;
      const p = row.outcome.pending;
      for (const which of ["brand", "dept"] as const) {
        const entry = p[which];
        if (!entry) continue;
        const key = `${which}:${entry.rawValue.toLowerCase().trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pending.push({
          type: which,
          rawValue: entry.rawValue,
          proposedCode: entry.proposedCode,
          legendId: entry.legendId ?? null,
        });
      }
    }
    if (pending.length === 0) return;

    // Fetch approved brands FRESH on dialog open (per Maria's spec point)
    try {
      const r = await fetch("/api/sku-legend/brands");
      const brands = r.ok ? await r.json() : [];
      setApprovedBrands(brands);
    } catch {
      setApprovedBrands([]);
    }
    setLegendPending(pending);
    setLegendDialogOpen(true);
  }, [offerAddData]);

  // 2D-4 substep 4: fire the LIVE submit endpoint. This is the ONLY place in
  // the frontend that triggers real putListingsItem calls. Operator edits to
  // SKU segments (TTL/NNN) flow through as skuOverrides — the server validates
  // each override and refuses to fire on format mismatch or collision.
  const handleSubmitOfferAdd = useCallback(async (asinsToSubmit: string[], skuOverrides: Record<string, string>): Promise<SubmitResponse> => {
    const res = await fetch("/api/offer-add/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asins: asinsToSubmit, skuOverrides }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Submit failed");

    // §18 pending half (2026-09-21): flip the catalog icon on the RESPONSE,
    // like Bulk Calc's cart flip — the server already wrote has_live_offer
    // for every ACCEPTED row, so this just spares the user a refetch. The
    // synthetic 'pending' ledger entry is what renders the pending style;
    // the next /api/asins load replaces it with the real row.
    const accepted: string[] = ((data as any)?.perAsin ?? [])
      .filter((r: any) => r?.outcome?.kind === "created")
      .map((r: any) => r.asin);
    if (accepted.length > 0) {
      const now = new Date().toISOString();
      setResults((prev) => prev.map((r) => accepted.includes(r.asin)
        ? {
            ...r,
            hasLiveOffer: true,
            submission: {
              latest: { sku: "", status: "pending", submittedAt: now, verifiedAt: null, issues: [], reviewFlags: [], terminalConflict: false, acknowledged: false },
              history: r.submission?.history ?? [],
            } as any,
          }
        : r));
    }
    return data as SubmitResponse;
  }, []);

  const handleApproveLegendItems = useCallback(async (items: any[]) => {
    const res = await fetch("/api/sku-legend/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Approval failed");
    return data;
  }, []);

  const handleLegendDialogClose = useCallback(async () => {
    setLegendDialogOpen(false);
    // Re-fetch the preview so previously-blocked ASINs re-resolve
    if (offerAddAsins.length > 0) {
      await openOfferAddPreview(offerAddAsins);
    }
  }, [offerAddAsins, openOfferAddPreview]);

  // Add to SC is selection-ONLY by design — diverges from the Sync convention.
  // This is the only live-write path to Seller Central; silently operating on
  // the entire filtered view (potentially thousands of rows) is too dangerous.
  // Caller MUST check explicit rows. The button is disabled when selectedSet
  // is empty (real gate); the empty-guard below is defense-in-depth.
  // Does NOT go through currentWorkingSet — no filtered-view fallback at all.
  // §19 (2026-09-21): a row whose latest submission is still unresolved is
  // already "submitted (pending)" — re-firing would create a second offer
  // for the same ASIN while the first is materializing. Dropped from the
  // set here rather than silently succeeding.
  const pendingSubmitAsins = useMemo(
    () => new Set(results.filter((r) => isSubmissionPending(r)).map((r) => r.asin)),
    [results],
  );

  const handleAddToSC = useCallback(() => {
    if (selectedSet.size === 0) {
      toast({ title: "Select ASINs first", description: "Add to SC operates only on checked rows.", variant: "destructive" });
      return;
    }
    const chosen = Array.from(selectedSet);
    const eligible = chosen.filter((a) => !pendingSubmitAsins.has(a));
    const skipped = chosen.length - eligible.length;
    if (eligible.length === 0) {
      toast({ title: "Already submitted", description: `${skipped} selected ASIN${skipped === 1 ? " is" : "s are"} still pending at Amazon — wait for the icon to turn solid.`, variant: "destructive" });
      return;
    }
    if (skipped > 0) {
      toast({ title: `Skipping ${skipped} pending`, description: "Those ASINs already have a submission waiting for Amazon to publish." });
    }
    openOfferAddPreview(eligible);
  }, [openOfferAddPreview, toast, selectedSet, pendingSubmitAsins]);

  // Per-row "+" — single ASIN.
  const handleAddOneToSC = useCallback((asin: string) => {
    if (pendingSubmitAsins.has(asin)) {
      toast({ title: "Already submitted", description: `${asin} is waiting for Amazon to publish — the icon turns solid when it's live.`, variant: "destructive" });
      return;
    }
    openOfferAddPreview([asin]);
  }, [openOfferAddPreview, pendingSubmitAsins, toast]);

  // Park/Unpark (was Archive/Unarchive, 2026-09-07) — same route, new labels.
  const handleParkSelected = useCallback(async (park = true) => {
    if (selectedSet.size === 0) return;
    const asinList = Array.from(selectedSet);
    const label = park ? "Park" : "Unpark";
    const confirmed = window.confirm(`${label} ${asinList.length} selected ASIN${asinList.length !== 1 ? "s" : ""}?`);
    if (!confirmed) return;
    try {
      await fetch("/api/asins/archive", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins: asinList, archive: park }),
      });
      if (park && !showParked) {
        const parkedAsins = new Set(asinList);
        setResults((prev) => prev.filter((r) => !parkedAsins.has(r.asin)));
        setSavedCount((c) => Math.max(0, (c ?? 0) - asinList.length));
      } else {
        await fetchAsins(startDate, endDate, showParked, showDead);
      }
      setSelectedSet(new Set());
      toast({ title: `${label}ed ${asinList.length} ASIN${asinList.length !== 1 ? "s" : ""}` });
    } catch {
      toast({ title: `${label} failed`, variant: "destructive" });
    }
  }, [selectedSet, toast, showParked, showDead, fetchAsins, startDate, endDate]);

  // Mark dead / Revive (2026-09-07) — PUT /api/asins/status. Dead requires a
  // reason: preset ip_complaint / not_sourceable, or free text.
  const handleMarkDeadSelected = useCallback(async () => {
    if (selectedSet.size === 0) return;
    const asinList = Array.from(selectedSet);
    const raw = window.prompt(
      `Mark ${asinList.length} ASIN${asinList.length !== 1 ? "s" : ""} dead.\nReason — type 1 (ip_complaint), 2 (not_sourceable), or free text:`,
    );
    if (raw === null) return;
    const reason = raw.trim() === "1" ? "ip_complaint" : raw.trim() === "2" ? "not_sourceable" : raw.trim();
    if (!reason) { toast({ title: "Mark dead needs a reason", variant: "destructive" }); return; }
    try {
      const res = await fetch("/api/asins/status", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins: asinList, status: "dead", reason }),
      });
      if (!res.ok) throw new Error(await res.text());
      if (!showDead) {
        const deadAsins = new Set(asinList);
        setResults((prev) => prev.filter((r) => !deadAsins.has(r.asin)));
        setSavedCount((c) => Math.max(0, (c ?? 0) - asinList.length));
      } else {
        await fetchAsins(startDate, endDate, showParked, showDead);
      }
      setSelectedSet(new Set());
      toast({ title: `Marked ${asinList.length} dead (${reason})` });
    } catch {
      toast({ title: "Mark dead failed", variant: "destructive" });
    }
  }, [selectedSet, toast, showParked, showDead, fetchAsins, startDate, endDate]);

  const handleReviveSelected = useCallback(async () => {
    if (selectedSet.size === 0) return;
    const asinList = Array.from(selectedSet);
    const confirmed = window.confirm(`Revive ${asinList.length} selected ASIN${asinList.length !== 1 ? "s" : ""} back to active?`);
    if (!confirmed) return;
    try {
      const res = await fetch("/api/asins/status", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asins: asinList, status: "active" }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchAsins(startDate, endDate, showParked, showDead);
      setSelectedSet(new Set());
      toast({ title: `Revived ${asinList.length} ASIN${asinList.length !== 1 ? "s" : ""}` });
    } catch {
      toast({ title: "Revive failed", variant: "destructive" });
    }
  }, [selectedSet, toast, showParked, showDead, fetchAsins, startDate, endDate]);

  const buyListCount = useMemo(() => {
    return results.filter((r) => buySet.has(r.asin)).length;
  }, [results, buySet]);
  const onHoldCount = useMemo(() => {
    return results.filter((r) => onHoldSet.has(r.asin)).length;
  }, [results, onHoldSet]);

  // Serialize the Set to a stable string key so useMemo detects changes reliably
  const selectedSearchAsinsKey = useMemo(
    () => Array.from(selectedSearchAsins).sort().join(","),
    [selectedSearchAsins],
  );

  const filteredNoReveal = useMemo(() => {
    let out = results;

    // Scorecard filter (Total / Profitable / Unprofitable / Replens / Buy List)
    // Uses shared/profitability helpers for symmetric counts vs. tile face.
    // Uncalculated rows are EXCLUDED from both Profitable and Unprofitable
    // (fixes the pre-B2 asymmetry where Unprofitable also swept uncalculated).
    if (activeFilter === "buyList") {
      out = out.filter((r) => buySet.has(r.asin));
    }
    if (activeFilter === "onHold") {
      out = out.filter((r) => onHoldSet.has(r.asin));
    } else if (activeFilter === "profitable") {
      out = out.filter((r) => isProfitable(r, priceSource, settings, includeInboundShipping));
    } else if (activeFilter === "unprofitable") {
      out = out.filter((r) => {
        // Calculable but failed thresholds. Mirrors evaluate() gate so we don't
        // sweep in error/no-price/no-cogs rows.
        if (r.error) return false;
        if (r.estimatedCogs == null) return false;
        const anyPrice =
          r.pricingData.lowestFbaPrice != null
          || r.pricingData.buyBoxPrice != null
          || r.pricingData.lowestPrice != null;
        if (!anyPrice) return false;
        return !isProfitable(r, priceSource, settings, includeInboundShipping);
      });
    } else if (activeFilter === "replens") {
      out = out.filter((r) => isReplens(r, priceSource, settings, includeInboundShipping));
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
// Apply column filters
    if (Object.keys(colFilters).length > 0) {
      out = out.filter((r) =>
        // ONE accessor (2026-09-17): the main page used to carry its own
        // near-copy of getRowValue here. It drifted — it had never heard of
        // fbaStock (so "FBA Stock > 0" matched nothing while sorting the same
        // column worked), and it returned raw nulls, bypassing the numeric
        // null→0 coercion that makes "ROI ≤ 0" include no-data rows. Render,
        // sort, filter, and CSV now all read getRowValue.
        matchesFilters(r as any, colFilters, (colId) =>
          getRowValue(r, colId, priceSource, settings, includeInboundShipping)));
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, searchQuery, selectedSearchAsinsKey, showGated, showMeltable, priceSource, settings, includeInboundShipping, colFilters, activeFilter, buySet, onHoldSet, filterUncalculated]);
  // ASINs revealed by an added-ASIN report's "Show" pass every filter (they alone).
  const queryFilteredResults = useMemo(() => {
    if (revealAsins.size === 0) return filteredNoReveal;
    const keep = new Set(filteredNoReveal.map((r) => r.asin));
    return results.filter((r) => keep.has(r.asin) || revealAsins.has(r.asin.toUpperCase()));
  }, [filteredNoReveal, revealAsins, results]);

  // Added-ASIN report: once the list holds the added ASINs, count those the filters hide.
  useEffect(() => {
    if (!pendingAdded || listLoad.state !== "ready") return;
    const report = addedHiddenReport(pendingAdded.asins, results, filteredNoReveal);
    const added = `${pendingAdded.asins.length} added — ${report.hidden.length} hidden by your filters`;
    toast({
      title: pendingAdded.title,
      description: pendingAdded.base ? `${pendingAdded.base} · ${added}` : added,
      action: report.hidden.length > 0
        ? <ToastAction altText="Show the hidden added ASINs" onClick={() => setRevealAsins((prev) => new Set([...Array.from(prev), ...report.hidden]))} data-testid="button-show-hidden-added">Show</ToastAction>
        : undefined,
    });
    addedWatchRef.current = { asins: pendingAdded.asins, hidden: report.hidden.length, recheck: false };
    setPendingAdded(null);
  }, [pendingAdded, listLoad.state, results, filteredNoReveal, toast]);
  // …and once more when their onboarding job has filled gating in, if more are hidden now.
  useEffect(() => {
    const watch = addedWatchRef.current;
    if (!watch || !watch.recheck) return;
    const report = addedHiddenReport(watch.asins, results, filteredNoReveal);
    if (report.hidden.length <= watch.hidden) return;
    watch.recheck = false; watch.hidden = report.hidden.length;
    toast({
      title: "Added ASINs now hidden",
      description: `${report.hidden.length} of the ${watch.asins.length} added ASINs are hidden by your filters now that their gating is known`,
      action: <ToastAction altText="Show the hidden added ASINs" onClick={() => setRevealAsins((prev) => new Set([...Array.from(prev), ...report.hidden]))}>Show</ToastAction>,
    });
  }, [results, filteredNoReveal, toast]);


  // Sort all filtered results before paginating
  const sortedFilteredResults = useMemo(() => {
    if (!sortCol) return queryFilteredResults;
    return [...queryFilteredResults].sort((a, b) => {
      const va = getRowValue(a, sortCol, priceSource, settings, includeInboundShipping);
      const vb = getRowValue(b, sortCol, priceSource, settings, includeInboundShipping);
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
  }, [queryFilteredResults, sortCol, sortDir, priceSource, settings, includeInboundShipping]);

  // Keep ref in sync so selection-aware handlers (declared above) can read
  // the latest filtered working set without TDZ.
  useEffect(() => { sortedFilteredResultsRef.current = sortedFilteredResults; }, [sortedFilteredResults]);

  // Count + style for selection-aware button labels. Selection wins; otherwise
  // we surface the current filtered view count.
  const workingSetCount = selectedSet.size > 0 ? selectedSet.size : sortedFilteredResults.length;
  const workingSetIsSelection = selectedSet.size > 0;
  /** Formats "Label N" (no selection) or "Label (N)" (with selection). */
  const btnSuffix = (count: number, isSelection: boolean) =>
    count <= 0 ? "" : isSelection ? ` (${count})` : ` ${count}`;

  // Reset to page 1 when any filter/view changes
  useEffect(() => { setPage(1); }, [searchQuery, selectedSearchAsinsKey, showGated, showMeltable, showParked, showDead, colFilters, activeFilter, filterUncalculated]);

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
      await fetchAsins(startDate, endDate, showParked, showDead);
    } catch (err: any) {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    } finally {
      setIsSyncingCogs(false);
    }
  }, [selectedSet, sortedFilteredResults, results, toast, fetchAsins, startDate, endDate, showParked, showDead]);

  const totalFiltered = sortedFilteredResults.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedResults = useMemo(
    () => sortedFilteredResults.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sortedFilteredResults, safePage, pageSize]
  );
  visibleAsinsRef.current = paginatedResults.map((r) => r.asin);
  loadedAsinsRef.current = results.map((r) => r.asin.toUpperCase());
  // Stale rows coming on screen refresh then (only those).
  useEffect(() => {
    const due = staleRowsDue(staleAsinsRef.current, paginatedResults.map((r) => r.asin));
    if (due.length > 0) void rowRefresher.request(due);
  }, [paginatedResults, rowRefresher]);

  const handleSelectAll = useCallback(() => {
    setSelectedSet(new Set(paginatedResults.map((r) => r.asin)));
  }, [paginatedResults]);

  const activeFilterCount = getActiveFilterCount(colFilters, searchQuery, selectedSearchAsins.size) + (filterUncalculated ? 1 : 0);

  function clearSearchFilters() {
    setSearchQuery("");
    setSelectedSearchAsins(new Set());
    setColFilters({});
    setFilterUncalculated(false);
  }

  // Active filters, always visible (2026-10-18): a chip per filter that can hide a
  // loaded ASIN — the visibility toggles included — and how many rows they hide.
  const colLabelById = useMemo(() => new Map(ALL_COLUMN_DEFS.map((c) => [c.id as string, c.label])), []);
  const filterChips = useMemo(() => buildFilterChips(
    { activeFilter, filterUncalculated, searchQuery, selectedCount: selectedSearchAsins.size, showGated, showMeltable, colFilters, revealedCount: results.filter((r) => revealAsins.has(r.asin.toUpperCase())).length },
    (id) => colLabelById.get(id) ?? id,
    (id) => (colFilters[id] ? formatFilterValue(colFilters[id]) : ""),
  ), [activeFilter, filterUncalculated, searchQuery, selectedSearchAsins, showGated, showMeltable, colFilters, colLabelById, revealAsins, results]);
  const hiddenByFilters = results.length - queryFilteredResults.length;
  function clearFilterChip(key: FilterChipKey) {
    if (key === "tile") setActiveFilter("all");
    else if (key === "uncalculated") setFilterUncalculated(false);
    else if (key === "search") setSearchQuery("");
    else if (key === "selection") { setSelectedSearchAsins(new Set()); setSearchQuery(""); }
    else if (key === "gated") { setShowGated(true); saveShowGated(true); }
    else if (key === "meltable") { setShowMeltable(true); saveShowMeltable(true); }
    else if (key === "reveal") setRevealAsins(new Set());
    else if (key.startsWith("col:")) { const id = key.slice(4); setColFilters((prev) => { const next = { ...prev }; delete next[id]; return next; }); }
  }
  function clearAllFilters() {
    clearSearchFilters();
    setRevealAsins(new Set());
    setActiveFilter("all");
    setShowGated(true); saveShowGated(true);
    setShowMeltable(true); saveShowMeltable(true);
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

          {/* Row 1: action buttons. All sync buttons are selection-aware:
              "(N)" suffix when rows are selected, " N" suffix when operating on
              the current filtered view. Park/Unpark/Mark dead/Revive appear only with selection. */}
          {/* Row 1 (§8 toolbar order, 2026-09-07): LEFT = Add to SC, then the
              sync pair + push-out buttons in the spec's exact order; RIGHT =
              Upload | Export | status actions. */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            {/* LEFT — Add to SC | Product Info | Prices & Stock | Sync Sourcing | Sync POs | Push to Aura | Export SB COGS | Update COGS in SC */}
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddToSC}
                // §19 (2026-09-21): also disabled when EVERY selected row is
                // already pending at Amazon — no double submits.
                disabled={isAnalyzing || selectedSet.size === 0 || Array.from(selectedSet).every((a) => pendingSubmitAsins.has(a))}
                title={selectedSet.size === 0
                  ? "Select ASINs to add to Seller Central"
                  : Array.from(selectedSet).every((a) => pendingSubmitAsins.has(a))
                    ? "Every selected ASIN is already submitted and waiting for Amazon to publish"
                    : undefined}
                className="h-8 text-xs"
                data-testid="button-add-to-sc"
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Add to SC{selectedSet.size > 0 ? ` (${selectedSet.size})` : ""}
              </Button>
              <VerificationChip count={unverified?.count ?? 0} onClick={() => setVerifyPanelOpen(true)} />
              <span className="h-6 w-px bg-border" aria-hidden="true" />
              {/* 1. Refresh (scheduler v1, 2026-10-15): ONE button, ONE job,
                  all 21 components for the working set. Replaces Product
                  Info + Prices & Stock. A pending CSV upload is onboarded
                  first (until commit 3 moves onboarding onto the queue). */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRefresh()}
                    disabled={isAnalyzing || (asins.length === 0 && results.length === 0)}
                    className="h-8 text-xs"
                    data-testid="button-refresh"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${(jobs.mine || isAnalyzing) ? "animate-spin" : ""}`} />
                    {isAnalyzing
                      ? "Onboarding upload…"
                      : jobs.mine
                        ? (jobs.mine.job.status === "running" ? runningLabel(jobs.mine.job) : queuedLabel(jobs.mine.ahead))
                        : asins.length > 0
                          ? `Refresh ${asins.length} uploaded`
                          : `Refresh${btnSuffix(workingSetCount, workingSetIsSelection)}`}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  All 21 components for the selection, else the current view. Prices last synced {formatRelativeTime(pricesLastRefreshedAt)}
                  {jobs.manual && !jobs.mine ? ` · a ${jobs.manual.trigger} job is running; yours will queue behind it` : jobs.scheduled && !jobs.mine ? " · the scheduled pass is running; yours starts right away in its own lane" : ""}
                </TooltipContent>
              </Tooltip>
              {jobs.mine && (
                <Button variant="ghost" size="sm" className="h-8 text-xs px-2" onClick={() => handleCancelMine()} title="Cancel this refresh" data-testid="button-refresh-cancel">
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setJobsOpen(true)} className="h-8 text-xs px-2" title="Refresh jobs and history" data-testid="button-jobs-history">
                <History className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" onClick={handleSyncSourcing} disabled={isSyncingSourcing || isAnalyzing} className="h-8 text-xs">
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />
                {isSyncingSourcing ? "Syncing..." : "Sync Sourcing"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleSyncSheet} disabled={isSyncing || isAnalyzing} className="h-8 text-xs">
                <Sheet className="h-3.5 w-3.5 mr-1.5" />
                {isSyncing ? "Syncing..." : `Sync POs${btnSuffix(workingSetCount, workingSetIsSelection)}`}
              </Button>
              <Button variant="outline" size="sm" onClick={handlePushAura} disabled={isPushingAura || isAnalyzing} className="h-8 text-xs">
                <DollarSign className="h-3.5 w-3.5 mr-1.5" />
                {isPushingAura ? "Pushing..." : `Push to Aura${selectedSet.size > 0 ? ` (${selectedSet.size})` : ""}`}
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportSbCogs} disabled={isExportingSb} className="h-8 text-xs" title="Upload a SellerBoard products export; downloads YTD PO cost periods as CSV" data-testid="button-export-sb-cogs">
                <DollarSign className="h-3.5 w-3.5 mr-1.5" />
                {isExportingSb ? "Exporting..." : "Export SB COGS"}
              </Button>
              <input ref={sbFileInputRef} type="file" accept=".xlsx" onChange={handleSbTemplateSelected} className="hidden" data-testid="input-sb-template" />
              <Button variant="outline" size="sm" onClick={handleExportSourcingCost} disabled={isExportingSc} className="h-8 text-xs" title={`Upload Amazon's Manage Your Sourcing Cost bulk-update workbook; fills Seller New Cost from PO actual COGS for ASINs purchased ${dateRangeLabel}. Amazon has no API for this — the filled file goes back through Seller Central by hand.`} data-testid="button-update-cogs-sc">
                <DollarSign className="h-3.5 w-3.5 mr-1.5" />
                {isExportingSc ? "Filling..." : "Update COGS in SC"}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleOpenScHistory} className="h-8 text-xs px-2" title="COGS update workbooks already generated" data-testid="button-sc-history">
                <History className="h-3.5 w-3.5" />
              </Button>
              <input ref={scFileInputRef} type="file" accept=".xlsx" onChange={handleScWorkbookSelected} className="hidden" data-testid="input-sc-workbook" />
              {/* Reset Est. COGS to PO moved to Settings modal (2026-06-29). */}
            </div>

            {/* RIGHT — data-in + presentation: Upload | Export | status actions */}
            <div className="flex items-center gap-2 flex-wrap">
              <FileUpload onFileProcessed={handleFileProcessed} isAnalyzing={isAnalyzing} compact />
              <ExportButtons results={sortedFilteredResults} priceSource={priceSource} settings={settings} columnConfig={columnConfig} includeInboundShipping={includeInboundShipping} />
              {selectedSet.size > 0 && (
                <>
                  <span className="h-6 w-px bg-border" aria-hidden="true" />
                  <Button
                    size="sm"
                    onClick={() => handleParkSelected(true)}
                    className="h-8 text-xs bg-transparent border border-[var(--action-archive-border)] text-[var(--action-archive-text)] hover:bg-[var(--action-archive-border)]/10"
                    data-testid="button-park"
                  >
                    <Archive className="h-3 w-3 mr-1" />
                    Park ({selectedSet.size})
                  </Button>
                  {showParked && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleParkSelected(false)}
                      className="h-8 text-xs text-muted-foreground"
                      data-testid="button-unpark"
                    >
                      <Archive className="h-3 w-3 mr-1" />
                      Unpark ({selectedSet.size})
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleMarkDeadSelected}
                    className="h-8 text-xs text-destructive border-destructive/40 hover:bg-destructive/10"
                    data-testid="button-mark-dead"
                  >
                    <X className="h-3 w-3 mr-1" />
                    Mark dead ({selectedSet.size})
                  </Button>
                  {showDead && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleReviveSelected}
                      className="h-8 text-xs text-muted-foreground"
                      data-testid="button-revive"
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Revive ({selectedSet.size})
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* The full-width Refresh progress bar was removed 2026-10-17: the
              Refresh button shows this tab's own job (stage n/total, Cancel),
              the jobs dialog (clock icon) shows every running job incl. the
              scheduled pass, and the completion toast reports finish / failure. */}
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

        <FilterChipsBar chips={filterChips} hiddenCount={hiddenByFilters} onClear={clearFilterChip} onClearAll={clearAllFilters} />
        {listLoad.state === "loading" && results.length > 0 && (
          <div className="mx-4 mb-1 flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="asins-reloading">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating the list…
          </div>
        )}
        {results.length > 0 && (
          <>
            {/* Row 2: search → counts → merged Active-filters pill → Clear-selection pill | views + columns */}
            <div className="flex items-center justify-between gap-4 flex-wrap px-4">
              <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
                <MultiSearch
                  results={results}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                  selectedAsins={selectedSearchAsins}
                  onSelectedAsinsChange={setSelectedSearchAsins}
                />
                {queryFilteredResults.length !== results.length && (
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {queryFilteredResults.length} of {results.length} shown
                  </span>
                )}
                {/* MERGED Active-filters pill: body opens modal, ✕ clears ALL filters
                    (calls clearSearchFilters — same handler the modal's "Clear All" uses).
                    Hidden entirely when activeFilterCount === 0. */}
                {activeFilterCount > 0 && (
                  <div className="inline-flex items-center h-8 rounded-md border border-amber-300 dark:border-amber-700 text-amber-600 dark:text-amber-400 text-xs overflow-hidden">
                    <button
                      onClick={() => setFiltersModalOpen(true)}
                      className="pl-2.5 pr-2 h-full flex items-center gap-1.5 hover:bg-amber-50 dark:hover:bg-amber-950"
                      data-testid="button-active-filters"
                    >
                      <Filter className="h-3.5 w-3.5" />
                      Active filters ({activeFilterCount})
                    </button>
                    <button
                      onClick={clearSearchFilters}
                      className="px-1.5 h-full border-l border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900 flex items-center"
                      aria-label="Clear all filters"
                      data-testid="button-clear-filters"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
                {/* Option A: row-selection clear stays as its own pill, repurposed label,
                    moved here from the right group. Handler + trigger condition unchanged. */}
                {selectedSet.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearSelection}
                    className="text-xs text-muted-foreground h-8"
                    data-testid="button-clear-selection"
                    title="Clear row selection"
                  >
                    <X className="h-3 w-3 mr-1" />
                    Clear {selectedSet.size} selected
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2">
                {/* Export moved to Row 1 (right group). */}
                <ViewPresets
                  columnConfig={columnConfig}
                  onColumnConfigChange={setColumnConfig}
                  onSortChange={(col, dir) => { setSortCol(col); setSortDir(dir); localStorage.setItem("fba-sort", JSON.stringify({ col, dir })); }}
                  sortCol={sortCol}
                  sortDir={sortDir}
                  colFilters={colFilters}
                  onColFiltersChange={setColFilters}
                />
                <ColumnManager config={columnConfig} onChange={setColumnConfig} />
              </div>
            </div>

            {/* KPI cards — sits directly above the table (relocated from above-toolbar in B4). */}
            <div className="px-4">
              <SummaryCards
                results={results}
                priceSource={priceSource}
                settings={settings}
                includeInboundShipping={includeInboundShipping}
                activeFilter={activeFilter}
                onFilterChange={setActiveFilter}
                buyListCount={buyListCount}
                onHoldCount={onHoldCount}
                filterUncalculated={filterUncalculated}
                onFilterUncalculatedChange={setFilterUncalculated}
              />
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
              onHoldSet={onHoldSet}
              onToggleHold={handleToggleHold}
              onToggleBuy={handleToggleBuy}
              onBulkBuy={() => runBulkSet("buy")}
              onBulkHold={() => runBulkSet("hold")}
              bulkBuyLabel={bulkToggleLabel(buyPlan, "Buy List")}
              bulkHoldLabel={bulkToggleLabel(holdPlan, "Hold")}
              bulkActionsDisabled={selectedSet.size === 0}
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

        {/* List load state (2026-10-18): indicator while the list loads, the reason + Retry when it fails. */}
        {listLoad.state === "loading" && results.length === 0 && asins.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4" role="status" aria-live="polite" data-testid="asins-loading">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">Loading ASINs…</p>
          </div>
        )}
        {listLoad.state === "error" && (
          <div className="mx-4 my-6 flex flex-col items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-6 text-center" role="alert" data-testid="asins-load-error">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <p className="text-sm font-medium">The ASIN list didn't load.</p>
            <p className="text-xs text-muted-foreground">{listLoad.error}</p>
            <Button size="sm" variant="outline" onClick={() => void fetchAsins(startDate, endDate, showParked, showDead)} data-testid="button-retry-asins">Retry</Button>
          </div>
        )}

        {!isAnalyzing && results.length === 0 && asins.length === 0 && dbLoaded && listLoad.state === "ready" && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <BarChart3 className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <h2 className="text-lg font-medium text-muted-foreground">
              Upload a CSV/XLSX to get started
            </h2>
            <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
              Click "Upload File" above to import ASINs with COGS data, then click "Product Info" to fetch catalog data from Amazon SP-API.
            </p>
          </div>
        )}
      </div>

      {/* Page-level mounts (modals + page-wide dialogs). Settings is opened
          via the OPEN_SETTINGS_EVENT dispatched by the top-nav gear icon. */}
      <SettingsDialog
        onSettingsChange={setSettings}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        hideTrigger
        movedToggles={{
          includeInboundShipping,
          onIncludeInboundShippingChange: setIncludeInboundShipping,
          priceSource,
          onPriceSourceChange: setPriceSource,
          showGated,
          onShowGatedChange: (v) => { setShowGated(v); saveShowGated(v); },
          showMeltable,
          onShowMeltableChange: (v) => { setShowMeltable(v); saveShowMeltable(v); },
          showParked,
          onShowParkedChange: (v) => { setShowParked(v); saveShowParked(v); },
          showDead,
          onShowDeadChange: (v) => { setShowDead(v); saveShowDead(v); },
          onResetCogs: handleBulkSyncCogs,
          isResettingCogs: isSyncingCogs,
        }}
      />

      <RevivalDialog
        candidates={revivalCandidates}
        open={revivalDialogOpen}
        onClose={() => setRevivalDialogOpen(false)}
        onConfirm={handleRevive}
      />

      <VerificationPanel
        open={verifyPanelOpen}
        onClose={() => setVerifyPanelOpen(false)}
        data={unverified}
        onRefetch={fetchUnverified}
      />

      {/* Scheduler v1 jobs / history dialog (SPEC §11 "Refresh job"). */}
      <JobsDialog
        open={jobsOpen}
        onOpenChange={(o) => { setJobsOpen(o); if (!o) setJobsInitialId(null); }}
        initialJobId={jobsInitialId}
        onRetry={(failed) => { void handleRefresh(failed); }}
      />

      <OfferAddPreviewDialog
        open={offerAddOpen}
        onClose={() => { setOfferAddOpen(false); fetchUnverified(); }}
        loading={offerAddLoading}
        data={offerAddData}
        errorMessage={offerAddError}
        onReviewApprovals={handleReviewApprovals}
        onSubmit={handleSubmitOfferAdd}
      />

      <LegendApprovalDialog
        open={legendDialogOpen}
        pending={legendPending}
        approvedBrands={approvedBrands}
        onClose={handleLegendDialogClose}
        onApprove={handleApproveLegendItems}
      />

      <ActiveFiltersModal
        open={filtersModalOpen}
        onOpenChange={setFiltersModalOpen}
        colFilters={colFilters}
        searchQuery={searchQuery}
        selectedAsins={selectedSearchAsins}
        onRemoveFilter={(colId) => setColFilters((prev) => { const next = { ...prev }; delete next[colId]; return next; })}
        onClearSearch={() => { setSearchQuery(""); setSelectedSearchAsins(new Set()); }}
        onClearSelectedAsins={() => setSelectedSearchAsins(new Set())}
        onClearAll={clearSearchFilters}
      />

      <Dialog open={!!sbResult} onOpenChange={(o) => { if (!o) setSbResult(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>SellerBoard COGS export</DialogTitle>
            <DialogDescription>
              Downloaded {sbResult?.filename}. Interim bandage — superseded by the Actuals audit.
            </DialogDescription>
          </DialogHeader>
          {sbResult && (
            <div className="text-sm space-y-2">
              <div><span className="font-semibold">{sbResult.summary.emitted}</span> rows · {sbResult.summary.asins} ASINs · {sbResult.summary.periods} periods</div>
              <div className="text-muted-foreground text-xs">Template rows loaded: {sbResult.summary.templateRowsLoaded} (dropped blank stubs: {sbResult.summary.templateRowsDropped})</div>
              <div className="text-xs">
                Orders rows — read: {sbResult.summary.rawRowsRead}, blank ASIN: {sbResult.summary.blankAsinRows}, canceled: {sbResult.summary.skips.excludedByStatus}, bad date: {sbResult.summary.skips.badDate}, non-YTD: {sbResult.summary.skips.excludedNonYtd}, bad cost: {sbResult.summary.skips.badCost}, bad qty: {sbResult.summary.skips.badQty}, included: {sbResult.summary.includedRows}
              </div>
              <div className="text-xs">
                Same-date merged: {sbResult.summary.skips.sameDateMerged} · fractional collapsed: {sbResult.summary.skips.fractionalCollapsed} · rounded: {sbResult.summary.skips.fractionalRounded} · not in SB: {sbResult.summary.skips.notInSb} · in SB, no usable SKU: {sbResult.summary.skips.inSbNoUsableSku}
              </div>
              {sbResult.summary.fractionalCollapsed.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Fractional collapsed — {sbResult.summary.fractionalCollapsed.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto space-y-0.5">
                    {sbResult.summary.fractionalCollapsed.map((f, i) => (
                      <div key={i}>{f.asin} · {f.rowsFolded} rows → qty {f.qty} @ {f.cost.toFixed(2)} from {f.date}</div>
                    ))}
                  </div>
                </details>
              )}
              {sbResult.summary.fractionalRounded.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Fractional rounded — {sbResult.summary.fractionalRounded.length} batches (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto space-y-0.5">
                    {sbResult.summary.fractionalRounded.map((f, i) => (
                      <div key={i}>{f.asin} · {f.rawSum} → {f.rounded}{f.rounded === 0 ? " (dropped)" : ""}</div>
                    ))}
                  </div>
                </details>
              )}
              {sbResult.summary.notInSbAsins.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Not in SB — {sbResult.summary.notInSbAsins.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto break-words">{sbResult.summary.notInSbAsins.join(", ")}</div>
                </details>
              )}
              {sbResult.summary.inSbNoUsableSkuAsins.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">In SB, no usable SKU — {sbResult.summary.inSbNoUsableSkuAsins.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto break-words">{sbResult.summary.inSbNoUsableSkuAsins.join(", ")}</div>
                </details>
              )}
              {sbResult.summary.badQtyRows.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Bad qty — {sbResult.summary.badQtyRows.length} rows (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto space-y-0.5">
                    {sbResult.summary.badQtyRows.map((r, i) => (
                      <div key={i}>{r.asin} · {r.date} · qty="{r.rawQty}" ({r.mode})</div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!scResult} onOpenChange={(o) => { if (!o) setScResult(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Update COGS in SC</DialogTitle>
            <DialogDescription>
              Downloaded {scResult?.filename}. Upload it under Bulk Update on the Manage Your
              Sourcing Cost page — Amazon has no API for this. Have the matching invoices ready:
              submissions are gated on document review.
            </DialogDescription>
          </DialogHeader>
          {scResult && (
            <div className="text-sm space-y-2">
              <div>
                <span className="font-semibold">{scResult.summary.rowsWritten}</span> costs written ·{" "}
                {scResult.summary.asinsWritten} ASINs
                {scResult.summary.rowsWritten > scResult.summary.asinsWritten && (
                  <span className="text-muted-foreground"> (multi-FNSKU fan-out)</span>
                )}
              </div>
              <div className="text-muted-foreground text-xs">
                Purchased {scResult.summary.from}..{scResult.summary.to}: {scResult.summary.purchasedAsins} ASINs,
                {" "}{scResult.summary.asinsWithPoCogs} with a PO cost. Workbook: {scResult.summary.workbookRowsRead} rows /
                {" "}{scResult.summary.workbookAsins} ASINs over {scResult.summary.sheetsScanned} sheet(s).
              </div>
              <div className="text-xs">
                PO rows — read: {scResult.summary.rawRowsRead}, blank ASIN: {scResult.summary.blankAsinRows}, canceled:{" "}
                {scResult.summary.skips.excludedByStatus}, bad date: {scResult.summary.skips.badDate}, out of range:{" "}
                {scResult.summary.skips.outOfRange}, included: {scResult.summary.includedRows}
              </div>
              <div className="text-xs">
                Skipped — no estimates row: {scResult.summary.skips.noCogsRow} · not PO-sourced:{" "}
                {scResult.summary.skips.notPoSourced} · bad cost: {scResult.summary.skips.badCost} · not in workbook:{" "}
                {scResult.summary.skips.notInWorkbook} · already approved: {scResult.summary.skips.alreadyApproved} · would
                {" "}lower approval: {scResult.summary.skips.wouldLowerApproved}
              </div>
              {scResult.summary.skips.wouldLowerApproved > 0 && (
                <div className="text-xs rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
                  Held back {scResult.summary.skips.wouldLowerApproved} row(s) whose PO cost is below Amazon's
                  approved value. Amazon accepts reductions far more readily than increases, so submitting these
                  would lower your reimbursement basis with little chance of undoing it.
                </div>
              )}
              {scResult.summary.written.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Costs written — {scResult.summary.written.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto space-y-0.5">
                    {scResult.summary.written.map((w, i) => (
                      <div key={i}>
                        {w.asin} → {w.cost.toFixed(2)}
                        {w.wasApproved != null && ` (was ${w.wasApproved.toFixed(2)}${w.source ? ` / ${w.source}` : ""})`}
                        {w.fnskus.length > 1 && ` ×${w.fnskus.length} FNSKU`}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {scResult.summary.wouldLowerAsins.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Would lower approval — {scResult.summary.wouldLowerAsins.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto space-y-0.5">
                    {scResult.summary.wouldLowerAsins.map((x, i) => (
                      <div key={i}>{x.asin} · approved {x.approved.toFixed(2)} → PO {x.cost.toFixed(2)}{x.source ? ` (${x.source})` : ""}</div>
                    ))}
                  </div>
                </details>
              )}
              {scResult.summary.notPoSourcedAsins.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Not PO-sourced — {scResult.summary.notPoSourcedAsins.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto space-y-0.5">
                    {scResult.summary.notPoSourcedAsins.map((x, i) => (
                      <div key={i}>{x.asin} · source={x.source ?? "null"}</div>
                    ))}
                  </div>
                </details>
              )}
              {scResult.summary.noCogsRowAsins.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">No estimates row — {scResult.summary.noCogsRowAsins.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto break-words">{scResult.summary.noCogsRowAsins.join(", ")}</div>
                </details>
              )}
              {scResult.summary.badCostAsins.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Bad cost — {scResult.summary.badCostAsins.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto space-y-0.5">
                    {scResult.summary.badCostAsins.map((x, i) => (
                      <div key={i}>{x.asin} · cogs={x.cogs}</div>
                    ))}
                  </div>
                </details>
              )}
              {scResult.summary.notInWorkbookAsins.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Not in Amazon's workbook — {scResult.summary.notInWorkbookAsins.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto break-words">{scResult.summary.notInWorkbookAsins.join(", ")}</div>
                </details>
              )}
              {scResult.summary.alreadyApprovedAsins.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Already approved at this cost — {scResult.summary.alreadyApprovedAsins.length} ASINs (expand)</summary>
                  <div className="mt-1 font-mono max-h-40 overflow-auto break-words">{scResult.summary.alreadyApprovedAsins.join(", ")}</div>
                </details>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={scHistoryOpen} onOpenChange={setScHistoryOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>COGS update history</DialogTitle>
            <DialogDescription>
              Files generated, newest first. This records what AsinFlow produced — Seller Central
              gives no upload receipt, so it cannot confirm what Amazon accepted.
            </DialogDescription>
          </DialogHeader>
          {scHistory === null ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : scHistory.length === 0 ? (
            <div className="text-sm text-muted-foreground">No exports yet.</div>
          ) : (
            <div className="text-xs font-mono max-h-80 overflow-auto space-y-1">
              {scHistory.map((h) => (
                <div key={h.id} className="flex justify-between gap-3">
                  <span className="truncate">{h.filename}</span>
                  <span className="text-muted-foreground whitespace-nowrap">
                    {h.rowsWritten} rows / {h.asinsWritten} ASINs
                  </span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

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
