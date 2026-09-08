import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "wouter";
import { Database, RefreshCw, Trash2, Pencil, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ResultsTable, getRowValue, DATE_VALUE_COLS } from "@/components/results-table";
import { matchesFilters, type FilterMap } from "@/components/column-filter";
import { ColumnManager } from "@/components/column-manager";
import { ExportButtons } from "@/components/export-buttons";
import { FileUpload } from "@/components/file-upload";
import { SettingsDialog } from "@/components/settings-dialog";
import { OPEN_SETTINGS_EVENT } from "@/components/layout/top-nav";
import {
  ALL_COLUMNS,
  type AsinInput,
  type AsinResult,
  type ColumnId,
  type Settings,
} from "@shared/schema";
import { loadColumnConfig, type ColumnConfig } from "@/lib/columns";
import { loadSettings } from "@/lib/settings";
import { loadBuyList, saveBuyList, loadOnHoldList, saveOnHoldList } from "@/lib/buy-hold";

// §21 column subset: Description + full Estimates + full Sellers + the four
// Additional-info columns. Stock and Actuals excluded (no data path — honest
// labeling, §14); Tags/Notes/Promos/Sourcing/Submission excluded (no source
// or account state).
const BULK_COLUMN_IDS = new Set<ColumnId>([
  "product", "category", "brand", "supplier", "supplierSku",
  "estCogs", "prep", "salePrice", "profit", "roi", "margin",
  "fbaFee", "referralFee", "inboundShipping", "storage", "maxCogs",
  "sellersFba", "sellers", "sellers7d", "sellers30d", "fba7d", "fba30d",
  // tags + promos + notes are BULK-LOCAL fields (§21, 2026-09-04 / notes
  // 2026-09-08) — free text on the bulk row, unrelated to the main page's.
  "tags", "promos", "notes", "meltable", "hazmat", "suppressed", "dateAdded",
]);
// supplierSku is defaultVisible:false on the MAIN page (not in any preset);
// on the bulk page it defaults visible — supplier sheets are the input here
// and the export must carry it (§21).
// promos/dateAdded default hidden on the MAIN page; here they default
// visible (like supplierSku) — these fields are this page's import payload,
// and Export CSV carries visible columns only (§21).
const BULK_DEFAULT_VISIBLE = new Set<ColumnId>(["supplierSku", "promos", "notes", "dateAdded"]);
const BULK_DATE_FILTER_COLS = new Set<ColumnId>(["dateAdded"]); // §21 date filter opt-in (2026-09-08)
const BULK_COLUMNS = ALL_COLUMNS.filter((c) => BULK_COLUMN_IDS.has(c.id))
  .map((c) => (BULK_DEFAULT_VISIBLE.has(c.id) ? { ...c, defaultVisible: true } : c));
const BULK_COLUMNS_KEY = "fba-bulk-column-config";
const BULK_SELECTED_LIST_KEY = "fba-bulk-selected-list";

interface BulkListMeta {
  id: string;
  name: string;
  source_filename: string | null;
  asin_count: number;
  created_at: string;
  last_fetched_at: string | null;
}

// bulk_list_asins row → AsinResult. sale_price slots into the pricingData
// field named by price_source; with priceSource="lowestFba",
// getSelectedPrice's fallback order (lowest_fba → buy_box → lowest)
// reproduces the stored snapshot price with the correct label.
function mapBulkRow(row: any): AsinResult {
  const num = (v: any) => (v != null ? parseFloat(v) : null);
  const price = num(row.sale_price);
  const pricingData = {
    lowestFbaPrice: null as number | null,
    buyBoxPrice: null as number | null,
    buyBoxFulfillment: null,
    lowestPrice: null as number | null,
    avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: null,
    sellersFba: row.sellers_fba != null ? parseInt(row.sellers_fba) : null,
    sellersFbm: row.sellers_fbm != null ? parseInt(row.sellers_fbm) : null,
  };
  if (price != null) {
    if (row.price_source === "buy_box") pricingData.buyBoxPrice = price;
    else if (row.price_source === "lowest") pricingData.lowestPrice = price;
    else pricingData.lowestFbaPrice = price;
  }
  return {
    asin: row.asin,
    cogs: num(row.estimated_cogs) ?? 0,
    estimatedCogs: num(row.estimated_cogs),
    estimatedCogsSource: row.estimated_cogs_source ?? null,
    actualCogs: null,
    buyLink: row.buy_link ?? null,
    prepOverride: null,
    storageOverride: null,
    supplierSku: row.supplier_sku ?? null,
    // §21 bulk-local tags: free text, rendered as neutral slate chips (no
    // color by design — the shared chip renderer falls back to #64748b).
    tags: Array.isArray(row.tags) ? row.tags.map((name: string) => ({ name, color: "#64748b" })) : [],
    promoNotes: row.promo_notes ?? null,
    notes: row.notes ?? null,
    priceOutcome: row.price_outcome ?? null,
    catalogOutcome: row.catalog_outcome ?? null,
    pricingData,
    feesData: {
      fbaFulfillmentFee: num(row.fba_fee),
      referralFee: num(row.referral_fee),
      feesEstimatePrice: num(row.fees_estimate_price),
      variableClosingFee: num(row.variable_closing_fee),
    },
    catalogData: {
      weightLbs: num(row.weight_lb),
      title: row.title ?? null,
      brand: row.brand ?? null,
      imageUrl: row.image_url ?? null,
      bsrRank: row.bsr != null ? parseInt(row.bsr) : null,
      bsrCategory: row.category ?? null,
      lengthIn: num(row.length_in),
      widthIn: num(row.width_in),
      heightIn: num(row.height_in),
    },
    eligibilityData: { status: (row.eligibility_status as any) ?? "check" },
    error: row.error ?? null,
    isMeltable: row.is_meltable === true,
    isHazmat: row.is_hazmat,
    isDangerousGood: row.is_dangerous_good,
    category: row.category ?? null,
    addedAt: row.added_at ?? null,
    pricesFetchedAt: row.fetched_at ?? null,
  };
}

function formatSnapshotAge(iso: string | null): string {
  if (!iso) return "never analyzed";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function BulkCalc() {
  const [lists, setLists] = useState<BulkListMeta[]>([]);
  const [selectedListId, setSelectedListId] = useState<string | null>(
    () => localStorage.getItem(BULK_SELECTED_LIST_KEY),
  );
  const [results, setResults] = useState<AsinResult[]>([]);
  const [inDbSet, setInDbSet] = useState<Set<string>>(new Set());
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(
    () => loadColumnConfig(BULK_COLUMNS_KEY, BULK_COLUMNS),
  );
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [buySet, setBuySet] = useState<Set<string>>(loadBuyList);
  const [onHoldSet, setOnHoldSet] = useState<Set<string>>(loadOnHoldList);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  const [sortCol, setSortCol] = useState<ColumnId | null>(null);
  // §21 column filters (2026-09-04) — enables the Tags dropdown among others.
  const [colFilters, setColFilters] = useState<FilterMap>({});
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<string | null>(null);
  // §21 bulk run results (2026-09-09): per-stage counts + outcomes + rate
  // deltas from the run's complete event — drives the results dialog.
  const [refreshResult, setRefreshResult] = useState<any | null>(null);
  const [refreshResultOpen, setRefreshResultOpen] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{ asins: AsinInput[]; filename: string } | null>(null);
  const [newListName, setNewListName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  // Create-list failures render INSIDE the Save-list dialog (2026-09-07):
  // pageError renders behind the open dialog, so a 413 looked like a no-op.
  const [createError, setCreateError] = useState<string | null>(null);

  const selectedList = lists.find((l) => l.id === selectedListId) ?? null;

  // Settings opened from the top-nav gear (§8 SETTINGS_ROUTES).
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handler);
  }, []);

  const fetchLists = useCallback(async (): Promise<BulkListMeta[]> => {
    try {
      const res = await fetch("/api/bulk-lists");
      const data = await res.json();
      setLists(data);
      return data;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => { fetchLists(); }, [fetchLists]);

  const loadRows = useCallback(async (listId: string) => {
    setPageError(null);
    try {
      const res = await fetch(`/api/bulk-lists/${listId}`);
      if (!res.ok) {
        if (res.status === 404) {
          localStorage.removeItem(BULK_SELECTED_LIST_KEY);
          setSelectedListId(null);
          setResults([]);
        }
        return;
      }
      const { rows } = await res.json();
      const mapped: AsinResult[] = rows.map(mapBulkRow);
      setResults(mapped);
      setSelectedSet(new Set());
      // §21 in_database: the single sanctioned main-DB read — set-based
      // EXISTS, computed at render time, never stored.
      const asins = mapped.map((r) => r.asin);
      if (asins.length > 0) {
        fetch("/api/asins/in-database", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asins }),
        })
          .then((r) => r.json())
          .then((d) => setInDbSet(new Set(d.present ?? [])))
          .catch(() => setInDbSet(new Set()));
      } else {
        setInDbSet(new Set());
      }
    } catch (e: any) {
      setPageError(e.message);
    }
  }, []);

  useEffect(() => {
    if (selectedListId) {
      localStorage.setItem(BULK_SELECTED_LIST_KEY, selectedListId);
      loadRows(selectedListId);
    } else {
      setResults([]);
    }
  }, [selectedListId, loadRows]);

  // "Refresh" (§21 bulk run, 2026-09-09) — POST the staged NDJSON stream
  // (prices → fees → catalog → gating → hazmat) and render per-stage
  // progress. The SERVER run continues if this stream dies (SPEC §21
  // lifecycle decision); attachToRun below re-attaches via the status
  // route. scope 'failed' (default) covers failed + never-fetched rows;
  // 'all' is the Refresh-all option; asins = Retry failed.
  const runRefresh = useCallback(async (listId: string, opts: { scope?: "failed" | "all"; asins?: string[] } = {}) => {
    setRefreshing(true);
    setRefreshProgress(null);
    setPageError(null);
    setRefreshResult(null);
    try {
      const res = await fetch(`/api/bulk-lists/${listId}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: opts.scope ?? "failed", asins: opts.asins }),
      });
      if (res.status === 409) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? "A run for this list is already in progress.");
      }
      if (!res.ok || !res.body) throw new Error(`Refresh failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "stage") {
              setRefreshProgress(`${msg.stage} ${msg.current}/${msg.total}${msg.asin ? ` — ${msg.asin}` : ""}`);
            } else if (msg.type === "complete") {
              if (msg.data?.error) throw new Error(msg.data.error);
              setRefreshResult(msg.data);
              setRefreshResultOpen(true);
            } else if (msg.type === "error") {
              throw new Error(msg.message ?? "Refresh error");
            }
          } catch (e: any) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      await fetchLists();
      await loadRows(listId);
    } catch (e: any) {
      setPageError(e.message);
    } finally {
      setRefreshing(false);
      setRefreshProgress(null);
    }
  }, [fetchLists, loadRows]);

  // Retry failed (N) — every ASIN whose prices outcome was throttled/error
  // (transients), same exclusion rule as the ASINs page (invalid_asin and
  // no_offers are conclusive; catalog absent is a fact, not a failure).
  const refreshFailedAsins = useMemo(() => {
    const s = refreshResult?.stages?.prices?.outcomes ?? {};
    return Object.entries(s)
      .filter(([, v]) => String(v).startsWith("throttled") || String(v).startsWith("error"))
      .map(([asin]) => asin);
  }, [refreshResult]);

  // Re-attach (SPEC §21): if a run for the selected list is live (this tab
  // reloaded, or another tab started it), poll the status route until it
  // finishes, then reload the snapshot.
  useEffect(() => {
    if (!selectedListId) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/bulk-lists/${selectedListId}/refresh/status`);
        if (cancelled) return;
        if (res.status === 204) {
          if (timer) { clearInterval(timer); timer = null; setRefreshing(false); setRefreshProgress(null); await loadRows(selectedListId); }
          return;
        }
        const st = await res.json();
        if (st.stage === "done" || st.stage === "failed") {
          if (timer) { clearInterval(timer); timer = null; }
          setRefreshing(false); setRefreshProgress(null);
          await loadRows(selectedListId);
          return;
        }
        setRefreshing(true);
        setRefreshProgress(`${st.stage} ${st.current}/${st.total} (re-attached)`);
        if (!timer) timer = setInterval(poll, 2000);
      } catch {}
    };
    void poll();
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [selectedListId, loadRows]);

  // Upload CSV → name the list → create → auto-run the first analyze.
  const handleFileProcessed = useCallback((asins: AsinInput[], sourceFilename?: string) => {
    const base = (sourceFilename ?? "list").replace(/\.[^.]+$/, "");
    setPendingUpload({ asins, filename: sourceFilename ?? "" });
    setNewListName(base);
  }, []);

  const createList = useCallback(async () => {
    if (!pendingUpload || !newListName.trim()) return;
    setCreateError(null);
    try {
      const res = await fetch("/api/bulk-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newListName.trim(),
          sourceFilename: pendingUpload.filename || null,
          asins: pendingUpload.asins,
        }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || "Failed to create list"); }
      const created = await res.json();
      setPendingUpload(null);
      await fetchLists();
      setSelectedListId(created.id);
      runRefresh(created.id);
    } catch (e: any) {
      setCreateError(e.message);
    }
  }, [pendingUpload, newListName, fetchLists, runRefresh]);

  const renameList = useCallback(async () => {
    if (!selectedListId || !renameVal.trim()) return;
    const res = await fetch(`/api/bulk-lists/${selectedListId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: renameVal.trim() }),
    });
    if (res.ok) { setRenameOpen(false); await fetchLists(); }
  }, [selectedListId, renameVal, fetchLists]);

  const deleteList = useCallback(async () => {
    if (!selectedListId) return;
    const res = await fetch(`/api/bulk-lists/${selectedListId}`, { method: "DELETE" });
    if (res.ok) {
      setDeleteOpen(false);
      localStorage.removeItem(BULK_SELECTED_LIST_KEY);
      setSelectedListId(null);
      setResults([]);
      await fetchLists();
    }
  }, [selectedListId, fetchLists]);

  // Buy List + On Hold — SHARED with the main page (same localStorage keys,
  // same mutual-eviction semantics as home.tsx's handlers).
  const handleToggleBuy = useCallback((asin: string) => {
    setBuySet((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      saveBuyList(next);
      return next;
    });
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

  const handleSort = useCallback((colId: ColumnId) => {
    setSortCol((prev) => {
      if (prev === colId) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortDir("desc");
      return colId;
    });
  }, []);

  const sortedResults = useMemo(() => {
    const filtered = Object.keys(colFilters).length > 0
      ? results.filter((r) => matchesFilters(r, colFilters, (colId) => getRowValue(r, colId, "lowestFba", settings)))
      : results;
    if (!sortCol) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = getRowValue(a, sortCol, "lowestFba", settings);
      const vb = getRowValue(b, sortCol, "lowestFba", settings);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      // Date-valued columns sort on the actual timestamp (2026-09-08) —
      // never the formatted string.
      if (DATE_VALUE_COLS.has(sortCol)) {
        const ta = new Date(String(va)).getTime(), tb = new Date(String(vb)).getTime();
        if (!isNaN(ta) && !isNaN(tb)) return (ta - tb) * dir;
      }
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [results, sortCol, sortDir, settings, colFilters]);

  // Export scope (§21): rows selected → export selected; none → export all.
  const exportResults = useMemo(
    () => (selectedSet.size > 0 ? sortedResults.filter((r) => selectedSet.has(r.asin)) : sortedResults),
    [sortedResults, selectedSet],
  );
  const exportFilename = `bulk-${(selectedList?.name ?? "list").replace(/[^A-Za-z0-9._-]+/g, "_")}.csv`;

  // §21 in_database badge — the Product-cell slot the main table uses for
  // has_live_offer. Database icon (visually distinct from the shopping bag),
  // linking to the main ASINs page pre-filtered via ?q=. Absent → dash.
  const productBadge = useCallback((result: AsinResult) => {
    if (inDbSet.has(result.asin)) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link href={`/asins?q=${result.asin}`} onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
              <Database className="h-3 w-3 text-blue-500" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top"><p className="text-xs">In your AsinFlow database</p></TooltipContent>
        </Tooltip>
      );
    }
    return <span className="text-muted-foreground/50 text-xs flex-shrink-0">{"—"}</span>;
  }, [inDbSet]);

  const cogsSaveUrl = useCallback(
    (asin: string) => `/api/bulk-lists/${selectedListId}/asins/${asin}/cogs`,
    [selectedListId],
  );

  // §21 user-controlled inline edits — bulk endpoints only (isolation).
  const bulkPut = useCallback(async (asin: string, path: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/bulk-lists/${selectedListId}/asins/${asin}/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || "Failed to save"); }
    return res.json();
  }, [selectedListId]);
  const onBulkTagsSave = useCallback((asin: string, csvText: string | null) => bulkPut(asin, "tags", { tags: csvText }), [bulkPut]);
  const onBuyLinkSave = useCallback((asin: string, url: string | null) => bulkPut(asin, "buy-link", { buy_link: url }), [bulkPut]);
  const onDateAddedSave = useCallback((asin: string, value: string) => bulkPut(asin, "date-added", { added_at: value }), [bulkPut]);
  const promosSaveUrl = useCallback((asin: string) => `/api/bulk-lists/${selectedListId}/asins/${asin}/promos`, [selectedListId]);
  const notesSaveUrl = useCallback((asin: string) => `/api/bulk-lists/${selectedListId}/asins/${asin}/notes`, [selectedListId]);

  const onSupplierSkuSave = useCallback(async (asin: string, value: string | null) => {
    const res = await fetch(`/api/bulk-lists/${selectedListId}/asins/${asin}/supplier-sku`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supplier_sku: value }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || "Failed to save"); }
    return res.json();
  }, [selectedListId]);

  return (
    <div className="p-4 space-y-3">
      {/* Toolbar: list selector + snapshot age + actions (§21 toolbar set) */}
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-semibold mr-2">Bulk Profit Calculator</h1>
        <Select value={selectedListId ?? ""} onValueChange={(v) => setSelectedListId(v || null)}>
          <SelectTrigger className="w-[240px] h-8 text-sm" data-testid="select-bulk-list">
            <SelectValue placeholder="Select a list..." />
          </SelectTrigger>
          <SelectContent>
            {lists.map((l) => (
              <SelectItem key={l.id} value={l.id} data-testid={`option-bulk-list-${l.id}`}>
                {l.name} ({l.asin_count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedList && (
          <span className="text-xs text-muted-foreground" data-testid="text-snapshot-age">
            snapshot: {formatSnapshotAge(selectedList.last_fetched_at)}
          </span>
        )}
        {selectedList && (
          <>
            <Button variant="ghost" size="sm" className="h-8 px-2" data-testid="button-rename-list"
              onClick={() => { setRenameVal(selectedList.name); setRenameOpen(true); }}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2 text-destructive" data-testid="button-delete-list"
              onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        <div className="flex-1" />
        <FileUpload onFileProcessed={handleFileProcessed} isAnalyzing={refreshing} compact cogsOptional />
        {/* "Refresh" (was "Refresh Prices", 2026-09-09): full bulk pipeline —
            prices, fees, catalog, gating, hazmat. Default scope failed +
            never-fetched; "Refresh all" covers everything (§21). */}
        <Button variant="outline" size="sm" className="h-8 text-xs" data-testid="button-bulk-refresh"
          disabled={!selectedListId || refreshing}
          onClick={() => selectedListId && runRefresh(selectedListId)}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? (refreshProgress ? `Refresh · ${refreshProgress.split(" — ")[0]}` : "Refreshing...") : "Refresh"}
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs px-2" data-testid="button-bulk-refresh-all"
          disabled={!selectedListId || refreshing}
          title="Re-run every row, including conclusive ones"
          onClick={() => selectedListId && runRefresh(selectedListId, { scope: "all" })}>
          all
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs px-2" data-testid="button-bulk-refresh-results"
          disabled={!refreshResult}
          title="Last run results"
          onClick={() => setRefreshResultOpen(true)}>
          <History className="h-3.5 w-3.5" />
        </Button>
        <ExportButtons results={exportResults} priceSource="lowestFba" settings={settings} columnConfig={columnConfig} filename={exportFilename} includeSkuSubColumn={false} />
        <ColumnManager config={columnConfig} onChange={setColumnConfig} columns={BULK_COLUMNS} storageKey={BULK_COLUMNS_KEY} />
      </div>

      {refreshProgress && (
        <div className="text-xs text-muted-foreground" data-testid="text-refresh-progress">{refreshProgress}</div>
      )}
      {pageError && (
        <div className="text-sm text-destructive" data-testid="text-bulk-error">{pageError}</div>
      )}
      {selectedSet.size > 0 && (
        <div className="text-xs text-muted-foreground" data-testid="text-selection-hint">
          {selectedSet.size} selected — Export downloads the selection. <button className="underline" onClick={() => setSelectedSet(new Set())}>Clear</button>
        </div>
      )}

      {results.length > 0 ? (
        <ResultsTable
          results={sortedResults}
          priceSource="lowestFba"
          settings={settings}
          columnConfig={columnConfig}
          activeFilter="all"
          buySet={buySet}
          onToggleBuy={handleToggleBuy}
          onHoldSet={onHoldSet}
          onToggleHold={handleToggleHold}
          selectedSet={selectedSet}
          onToggleSelect={(asin) => setSelectedSet((prev) => {
            const next = new Set(prev);
            if (next.has(asin)) next.delete(asin);
            else next.add(asin);
            return next;
          })}
          onSelectAllPage={(asins) => setSelectedSet(new Set(asins))}
          onClearSelection={() => setSelectedSet(new Set())}
          dateFilterCols={BULK_DATE_FILTER_COLS}
          sortCol={sortCol}
          sortDir={sortDir}
          onSort={handleSort}
          onResultUpdate={(asin, updates) => setResults((prev) => prev.map((r) => (r.asin === asin ? { ...r, ...updates } : r)))}
          columns={BULK_COLUMNS}
          productBadge={productBadge}
          cogsSaveUrl={cogsSaveUrl}
          onSupplierSkuSave={onSupplierSkuSave}
          promosSaveUrl={promosSaveUrl}
          notesSaveUrl={notesSaveUrl}
          onBulkTagsSave={onBulkTagsSave}
          onBuyLinkSave={onBuyLinkSave}
          onDateAddedSave={onDateAddedSave}
          colFilters={colFilters}
          onFilterApply={(f) => setColFilters((prev) => ({ ...prev, [f.colId]: f }))}
          onFilterClear={(colId) => setColFilters((prev) => { const n = { ...prev }; delete n[colId]; return n; })}
        />
      ) : (
        <div className="text-sm text-muted-foreground py-16 text-center" data-testid="text-bulk-empty">
          {lists.length === 0
            ? "Upload a CSV of ASINs (supplier catalog, substitution list, wholesale sheet) to get started."
            : "Select a list or upload a new CSV."}
        </div>
      )}

      {/* Name-the-list dialog (after upload mapping) */}
      <Dialog open={pendingUpload != null} onOpenChange={(v) => { if (!v) { setPendingUpload(null); setCreateError(null); } }}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-name-list">
          <DialogHeader>
            <DialogTitle>Save list</DialogTitle>
            <DialogDescription>
              {pendingUpload?.asins.length ?? 0} ASINs parsed. Name this list — prices fetch right after.
            </DialogDescription>
          </DialogHeader>
          <Input value={newListName} onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createList(); }} autoFocus data-testid="input-list-name" />
          {createError && (
            <p className="text-sm text-destructive" data-testid="text-create-list-error">{createError}</p>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setPendingUpload(null); setCreateError(null); }} data-testid="button-name-cancel">Cancel</Button>
            <Button onClick={createList} disabled={!newListName.trim()} data-testid="button-name-save">Create list</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* §21 bulk run results dialog (2026-09-09) — same shape as the ASINs
          page: per-stage counts, expandable outcomes, rate deltas, Retry
          failed (N). Title matches the refresh_runs scope string. */}
      <Dialog open={refreshResultOpen} onOpenChange={setRefreshResultOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto" data-testid="dialog-bulk-refresh-results">
          <DialogHeader>
            <DialogTitle>Refresh · bulk:{selectedList?.name ?? ""}</DialogTitle>
            <DialogDescription>
              Prices + fees + catalog + gating + hazmat for this list only. Rate-limit stats prove the pacing (0 throttled = healthy).
            </DialogDescription>
          </DialogHeader>
          {refreshResult && (
            <div className="space-y-3 text-xs">
              {Object.entries(refreshResult.stages ?? {}).map(([stage, s]: [string, any]) => (
                <details key={stage} className="border rounded p-2">
                  <summary className="cursor-pointer">
                    <span className="font-semibold">{stage}</span>
                    {" — "}{Object.entries(s.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "no counts"}
                  </summary>
                  {Object.keys(s.outcomes ?? {}).length > 0 ? (
                    <div className="mt-2 max-h-48 overflow-y-auto font-mono">
                      {Object.entries(s.outcomes).map(([asin, o]) => (
                        <p key={asin}>{asin}: {String(o)}</p>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-muted-foreground">No per-item exceptions.</p>
                  )}
                </details>
              ))}
              <details className="border rounded p-2">
                <summary className="cursor-pointer font-semibold">Rate limits</summary>
                <div className="mt-2 font-mono">
                  {Object.entries(refreshResult.rateLimits ?? {}).map(([bucket, s]: [string, any]) => (
                    <p key={bucket}>{bucket}: {s.sent} sent, {s.throttled} throttled{s.adjusted ? ", rate adjusted by Amazon header" : ""}</p>
                  ))}
                </div>
              </details>
              <div className="flex justify-end gap-2">
                {refreshFailedAsins.length > 0 && (
                  <Button size="sm" className="h-8 text-xs" disabled={refreshing}
                    onClick={() => { setRefreshResultOpen(false); if (selectedListId) runRefresh(selectedListId, { asins: refreshFailedAsins }); }}
                    data-testid="button-bulk-retry-failed">
                    Retry failed ({refreshFailedAsins.length})
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setRefreshResultOpen(false)}>Close</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-rename-list">
          <DialogHeader><DialogTitle>Rename list</DialogTitle></DialogHeader>
          <Input value={renameVal} onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") renameList(); }} autoFocus data-testid="input-rename" />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button onClick={renameList} disabled={!renameVal.trim()} data-testid="button-rename-save">Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-delete-list">
          <DialogHeader>
            <DialogTitle>Delete list?</DialogTitle>
            <DialogDescription>
              "{selectedList?.name}" and its {selectedList?.asin_count} rows will be deleted. The main catalog is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={deleteList} data-testid="button-delete-confirm">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings — opened via the top-nav gear (OPEN_SETTINGS_EVENT). Same
          global settings as the main table (§21). */}
      <SettingsDialog onSettingsChange={setSettings} open={settingsOpen} onOpenChange={setSettingsOpen} hideTrigger />
    </div>
  );
}
