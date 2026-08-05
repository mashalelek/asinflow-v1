import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "wouter";
import { Database, RefreshCw, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ResultsTable, getRowValue } from "@/components/results-table";
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
  "meltable", "hazmat", "suppressed", "dateAdded",
]);
// supplierSku is defaultVisible:false on the MAIN page (not in any preset);
// on the bulk page it defaults visible — supplier sheets are the input here
// and the export must carry it (§21).
const BULK_COLUMNS = ALL_COLUMNS.filter((c) => BULK_COLUMN_IDS.has(c.id))
  .map((c) => (c.id === "supplierSku" ? { ...c, defaultVisible: true } : c));
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
    buyLink: null,
    prepOverride: null,
    storageOverride: null,
    supplierSku: row.supplier_sku ?? null,
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
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{ asins: AsinInput[]; filename: string } | null>(null);
  const [newListName, setNewListName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

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

  // "Refresh Prices" — POST the NDJSON refresh stream, then reload the
  // snapshot. Never touches the main catalog (bulk sink, §21).
  const runRefresh = useCallback(async (listId: string) => {
    setRefreshing(true);
    setRefreshProgress(null);
    setPageError(null);
    try {
      const res = await fetch(`/api/bulk-lists/${listId}/refresh`, { method: "POST" });
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
            if (msg.type === "progress") {
              setRefreshProgress(`${msg.data.current}/${msg.data.total} — ${msg.data.asin}`);
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

  // Upload CSV → name the list → create → auto-run the first analyze.
  const handleFileProcessed = useCallback((asins: AsinInput[], sourceFilename?: string) => {
    const base = (sourceFilename ?? "list").replace(/\.[^.]+$/, "");
    setPendingUpload({ asins, filename: sourceFilename ?? "" });
    setNewListName(base);
  }, []);

  const createList = useCallback(async () => {
    if (!pendingUpload || !newListName.trim()) return;
    setPageError(null);
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
      setPageError(e.message);
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
    if (!sortCol) return results;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...results].sort((a, b) => {
      const va = getRowValue(a, sortCol, "lowestFba", settings);
      const vb = getRowValue(b, sortCol, "lowestFba", settings);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [results, sortCol, sortDir, settings]);

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
        <Button variant="outline" size="sm" className="h-8 text-xs" data-testid="button-refresh-prices"
          disabled={!selectedListId || refreshing}
          onClick={() => selectedListId && runRefresh(selectedListId)}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing..." : "Refresh Prices"}
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
          sortCol={sortCol}
          sortDir={sortDir}
          onSort={handleSort}
          onResultUpdate={(asin, updates) => setResults((prev) => prev.map((r) => (r.asin === asin ? { ...r, ...updates } : r)))}
          columns={BULK_COLUMNS}
          productBadge={productBadge}
          cogsSaveUrl={cogsSaveUrl}
          onSupplierSkuSave={onSupplierSkuSave}
        />
      ) : (
        <div className="text-sm text-muted-foreground py-16 text-center" data-testid="text-bulk-empty">
          {lists.length === 0
            ? "Upload a CSV of ASINs (supplier catalog, substitution list, wholesale sheet) to get started."
            : "Select a list or upload a new CSV."}
        </div>
      )}

      {/* Name-the-list dialog (after upload mapping) */}
      <Dialog open={pendingUpload != null} onOpenChange={(v) => { if (!v) setPendingUpload(null); }}>
        <DialogContent className="sm:max-w-sm" data-testid="dialog-name-list">
          <DialogHeader>
            <DialogTitle>Save list</DialogTitle>
            <DialogDescription>
              {pendingUpload?.asins.length ?? 0} ASINs parsed. Name this list — prices fetch right after.
            </DialogDescription>
          </DialogHeader>
          <Input value={newListName} onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createList(); }} autoFocus data-testid="input-list-name" />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingUpload(null)} data-testid="button-name-cancel">Cancel</Button>
            <Button onClick={createList} disabled={!newListName.trim()} data-testid="button-name-save">Create list</Button>
          </DialogFooter>
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
