import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { matchesFilters, IN_DB_SENTINEL, type FilterMap } from "@/components/column-filter";
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
  type Settings, type PriceSource } from "@shared/schema";
import { loadColumnConfig, type ColumnConfig } from "@/lib/columns";
import { loadSettings, loadIncludeInbound, saveIncludeInbound, loadPriceSource, savePriceSource } from "@/lib/settings";
import { loadShowGated, saveShowGated, loadShowMeltable, saveShowMeltable, loadShowParked, loadShowDead } from "@/components/visibility-toggles";
import { loadBuyList, saveBuyList, loadOnHoldList, saveOnHoldList } from "@/lib/buy-hold";
import { planBulkSetToggle, bulkToggleLabel, promoteTargets, applyBulkPlan, type BulkSetPlan } from "@/lib/bulk-buy-hold";
import { useToast } from "@/hooks/use-toast";

// §21 column subset: Description + full Estimates + full Sellers + the four
// Additional-info columns. Stock and Actuals excluded (no data path — honest
// labeling, §14), so the 2026-10-17 On Order / At Prep columns do not
// appear here either (patch asins-on-order-from-pos §3.6: a bulk row has
// no PO rows to derive from — nothing to show, not "—"); Tags/Notes/Promos/
// Sourcing/Submission excluded (no source or account state).
const BULK_COLUMN_IDS = new Set<ColumnId>([
  "product", "category", "brand", "supplier", "supplierSku",
  "estCogs", "prep", "salePrice", "profit", "roi", "margin",
  "fbaFee", "referralFee", "inboundShipping", "storage", "maxCogs",
  "sellersFba", "sellers", "sellers7d", "sellers30d", "fba7d", "fba30d",
  // tags + promos + notes are BULK-LOCAL fields (§21, 2026-09-04 / notes
  // 2026-09-08) — free text on the bulk row, unrelated to the main page's.
  "tags", "promos", "notes", "meltable", "hazmat", "suppressed", "dateAdded", "lastReviewed",
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

// bulk_list_asins row → AsinResult. All three parsed prices stored
// verbatim (migration 039) — getSelectedPrice picks by the toggle and
// falls back with the same labels as the main page.
function mapBulkRow(row: any): AsinResult {
  const num = (v: any) => (v != null ? parseFloat(v) : null);
  const pricingData = {
    lowestFbaPrice: num(row.sale_price),
    buyBoxPrice: num(row.sale_price_buy_box),
    buyBoxFulfillment: null,
    lowestPrice: num(row.sale_price_lowest),
    avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: null,
    sellersFba: row.sellers_fba != null ? parseInt(row.sellers_fba) : null,
    sellersFbm: row.sellers_fbm != null ? parseInt(row.sellers_fbm) : null,
  };
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
    lastReviewedAt: row.last_reviewed_at ?? null,
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
  const { toast } = useToast();
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(
    () => loadColumnConfig(BULK_COLUMNS_KEY, BULK_COLUMNS),
  );
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // §21 settings-drift fix (2026-09-09): SAME key as the ASINs page
  // (fba-include-inbound) — this page silently hard-defaulted to true.
  const [includeInboundShipping, setIncludeInboundShipping] = useState(loadIncludeInbound);
  useEffect(() => { saveIncludeInbound(includeInboundShipping); }, [includeInboundShipping]);
  // Applied Display Options (2026-09-09): shared keys with the main page —
  // gated/meltable filter rows here with identical semantics; price source
  // picks which stored price feeds calculateProfit.
  const [showGated, setShowGated] = useState(loadShowGated);
  const [showMeltable, setShowMeltable] = useState(loadShowMeltable);
  const [priceSource, setPriceSource] = useState<PriceSource>(loadPriceSource);
  const [buySet, setBuySet] = useState<Set<string>>(loadBuyList);
  const [onHoldSet, setOnHoldSet] = useState<Set<string>>(loadOnHoldList);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  // §21 bulk cart/hold confirm — non-null ONLY when the plan would promote
  // (§14: the dialog appears only when the side-effect count is non-zero,
  // so it never becomes noise people click through).
  const [pendingBulkSet, setPendingBulkSet] = useState<
    { which: "buy" | "hold"; plan: BulkSetPlan; toPromote: string[] } | null
  >(null);
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
  // Scheduler v1 (2026-10-15): POST enqueues a bulk-target job and returns
  // 202 + the job; the status route below is polled until it ends. The
  // results dialog is built from the job's per-component ledger rows.
  const watchedJobRef = useRef<number | null>(null);
  const [pollTick, setPollTick] = useState(0);
  const runRefresh = useCallback(async (listId: string, opts: { scope?: "failed" | "all"; asins?: string[] } = {}) => {
    setRefreshing(true);
    setRefreshProgress("queuing…");
    setPageError(null);
    setRefreshResult(null);
    try {
      const res = await fetch(`/api/bulk-lists/${listId}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: opts.scope ?? "failed", asins: opts.asins }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) throw new Error(body.message ?? "A refresh for this list is already queued or running.");
      if (!res.ok) throw new Error(body.message ?? `Refresh failed (${res.status})`);
      watchedJobRef.current = body.job?.id ?? null;
      setRefreshProgress(body.ahead > 0 ? `queued (${body.ahead} ahead)` : "queued");
      setPollTick((t) => t + 1);
    } catch (e: any) {
      setPageError(e.message);
      setRefreshing(false);
      setRefreshProgress(null);
    }
  }, []);

  // Retry failed (N) — every ASIN whose prices outcome was throttled/error
  // (transients), same exclusion rule as the ASINs page (invalid_asin and
  // no_offers are conclusive; catalog absent is a fact, not a failure).
  const refreshFailedAsins = useMemo(() => {
    // Every component of the job (scheduler v1): error/throttled outcomes,
    // component-level notes (keys starting with _) excluded.
    const set = new Set<string>();
    for (const s of Object.values(refreshResult?.stages ?? {}) as any[]) {
      for (const [asin, v] of Object.entries(s?.outcomes ?? {})) {
        if (asin.startsWith("_")) continue;
        if (String(v).startsWith("throttled") || String(v).startsWith("error")) set.add(asin);
      }
    }
    return Array.from(set).sort();
  }, [refreshResult]);

  // Re-attach (SPEC §21 lifecycle, now the job queue): poll the list's job
  // status until it ends — this tab's own run (pollTick), a reload, or a
  // run another tab started. Rows reload on every component transition and
  // at the end; the results dialog opens only for a run this tab started.
  useEffect(() => {
    if (!selectedListId) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let pollStage: string | null = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const poll = async () => {
      try {
        const res = await fetch(`/api/bulk-lists/${selectedListId}/refresh/status`);
        if (cancelled) return;
        if (res.status === 204) {
          stop();
          if (refreshing) { setRefreshing(false); setRefreshProgress(null); await loadRows(selectedListId); }
          return;
        }
        const st = await res.json();
        const active = st.status === "queued" || st.status === "running";
        if (!active) {
          stop();
          setRefreshing(false); setRefreshProgress(null);
          await loadRows(selectedListId);
          await fetchLists();
          if (st.status === "failed" && st.error) setPageError(st.error);
          if (watchedJobRef.current === st.jobId) {
            watchedJobRef.current = null;
            try {
              const d = await (await fetch(`/api/jobs/${st.jobId}`)).json();
              const stages: Record<string, any> = {};
              for (const c of d.components ?? []) stages[c.stage] = { counts: c.counts ?? {}, outcomes: c.outcomes ?? {}, error: c.error ?? null };
              setRefreshResult({ stages, rateLimits: {}, job: d.job });
              setRefreshResultOpen(true);
            } catch { /* the rows reloaded; the dialog is a nicety */ }
          }
          return;
        }
        setRefreshing(true);
        if (pollStage !== null && pollStage !== st.stage) { void loadRows(selectedListId); void fetchLists(); }
        pollStage = st.stage;
        setRefreshProgress(st.status === "queued" ? "queued" : `${st.stage} ${st.current}/${st.total}`);
        if (!timer) timer = setInterval(poll, 3000);
      } catch {}
    };
    void poll();
    return () => { cancelled = true; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedListId, loadRows, fetchLists, pollTick]);

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
  // §21 Promote to database (2026-09-09): the one user-initiated bulk →
  // main write. Returns per-ASIN outcomes; callers decide UI.
  const promoteAsins = useCallback(async (asinList: string[]) => {
    const res = await fetch(`/api/bulk-lists/${selectedListId}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asins: asinList }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message ?? `Promote failed (${res.status})`); }
    return res.json() as Promise<{ counts: { added: number; already_in_database: number; error: number }; results: Array<{ asin: string; outcome: string; message?: string }> }>;
  }, [selectedListId]);

  const handleAddToDatabase = useCallback(async () => {
    if (selectedSet.size === 0) return;
    const asinList = Array.from(selectedSet);
    try {
      const { counts, results } = await promoteAsins(asinList);
      const already = results.filter((r) => r.outcome === "already_in_database").map((r) => r.asin);
      const errors = results.filter((r) => r.outcome === "error");
      setInDbSet((prev) => {
        const next = new Set(prev);
        for (const r of results) if (r.outcome === "added" || r.outcome === "already_in_database") next.add(r.asin);
        return next;
      });
      toast({
        title: `Added ${counts.added} to your database` + (counts.already_in_database ? ` · already in database (${counts.already_in_database})` : "") + (counts.error ? ` · errors (${counts.error})` : ""),
        description: (counts.added ? "They're now separate from this list — edits no longer flow between the two. " : "")
          + (already.length ? `Already there: ${already.slice(0, 10).join(", ")}${already.length > 10 ? ` +${already.length - 10} more` : ""}. ` : "")
          + errors.map((e) => `${e.asin}: ${e.message}`).slice(0, 3).join("; "),
      });
    } catch (e: any) {
      toast({ title: "Add to database failed", description: e.message, variant: "destructive" });
    }
  }, [selectedSet, promoteAsins, toast]);

  // §21 auto-add (decision): cart/hold on a row NOT in the database
  // promotes it silently, then updates the set. Optimistic icon flip —
  // set + inDb updated immediately, reverted with a toast if the promote
  // fails. Already-in-DB rows: the click only touches the set, as always.
  const withAutoPromote = useCallback((asin: string, addingToSet: boolean, applySet: () => void, revertSet: () => void) => {
    applySet();
    if (!addingToSet || inDbSet.has(asin)) return;
    setInDbSet((prev) => new Set(prev).add(asin)); // optimistic icon flip
    promoteAsins([asin]).then(({ results }) => {
      const r = results[0];
      if (r?.outcome === "error") throw new Error(r.message ?? "promote failed");
      toast({ title: `Added ${asin} to your database`, description: "It's now separate from this list — edits no longer flow between the two." });
    }).catch((e: any) => {
      setInDbSet((prev) => { const next = new Set(prev); next.delete(asin); return next; });
      revertSet();
      toast({ title: `Couldn't add ${asin} to your database`, description: e.message, variant: "destructive" });
    });
  }, [inDbSet, promoteAsins, toast]);

  const applyBuyToggle = useCallback((asin: string, add: boolean) => {
    setBuySet((prev) => {
      const next = new Set(prev);
      if (add) next.add(asin); else next.delete(asin);
      saveBuyList(next);
      return next;
    });
    if (add) setOnHoldSet((prev) => {
      if (!prev.has(asin)) return prev;
      const next = new Set(prev); next.delete(asin); saveOnHoldList(next); return next;
    });
  }, []);

  const applyHoldToggle = useCallback((asin: string, add: boolean) => {
    setOnHoldSet((prev) => {
      const next = new Set(prev);
      if (add) next.add(asin); else next.delete(asin);
      saveOnHoldList(next);
      return next;
    });
    if (add) setBuySet((prev) => {
      if (!prev.has(asin)) return prev;
      const next = new Set(prev); next.delete(asin); saveBuyList(next); return next;
    });
  }, []);

  const handleToggleBuy = useCallback((asin: string) => {
    const adding = !buySet.has(asin);
    withAutoPromote(asin, adding, () => applyBuyToggle(asin, adding), () => applyBuyToggle(asin, false));
  }, [buySet, withAutoPromote, applyBuyToggle]);

  const handleToggleHold = useCallback((asin: string) => {
    const adding = !onHoldSet.has(asin);
    withAutoPromote(asin, adding, () => applyHoldToggle(asin, adding), () => applyHoldToggle(asin, false));
  }, [onHoldSet, withAutoPromote, applyHoldToggle]);


  // §21 Bulk Buy List / Hold (2026-10-03). Differs from the single-row path
  // above in ORDER: promote FIRST, then add only what landed. A bulk action
  // can fail for an arbitrary subset, so there is no coherent optimistic
  // revert — the set must only ever contain ASINs that really made it.
  const buyPlan = useMemo(
    () => planBulkSetToggle(Array.from(selectedSet), buySet),
    [selectedSet, buySet],
  );
  const holdPlan = useMemo(
    () => planBulkSetToggle(Array.from(selectedSet), onHoldSet),
    [selectedSet, onHoldSet],
  );

  const commitBulkSet = useCallback(async (which: "buy" | "hold", plan: BulkSetPlan, toPromote: string[]) => {
    const name = which === "buy" ? "Buy List" : "Hold";
    // landed = may be written to the set. Starts as everything the plan
    // targets; promote failures are removed below.
    const landed = new Set(plan.targets);
    let promotedCount = 0;
    const failed: Array<{ asin: string; message?: string }> = [];

    if (toPromote.length > 0) {
      try {
        const { counts, results } = await promoteAsins(toPromote);
        promotedCount = counts.added;
        for (const r of results) {
          // already_in_database is NOT an error — it proceeds normally.
          if (r.outcome === "error") { landed.delete(r.asin); failed.push(r); }
        }
        setInDbSet((prev) => {
          const next = new Set(prev);
          for (const r of results) if (r.outcome === "added" || r.outcome === "already_in_database") next.add(r.asin);
          return next;
        });
      } catch (e: any) {
        // Whole-request failure: nothing was promoted, so nothing that
        // needed promoting may enter the set.
        for (const a of toPromote) { landed.delete(a); }
        toast({ title: `Couldn't add to ${name}`, description: e.message, variant: "destructive" });
        return;
      }
    }

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

    const written = plan.targets.filter((a) => landed.has(a)).length;
    const parts = [plan.direction === "add" ? `Added ${written} to ${name}` : `Removed ${written} from ${name}`];
    if (promotedCount > 0) parts.push(`${promotedCount} added to database`);
    if (failed.length > 0) parts.push(`${failed.length} failed (see list)`);
    toast({
      title: parts.join(" · "),
      description: failed.length > 0
        ? `Failed: ${failed.map((f) => `${f.asin}${f.message ? ` (${f.message})` : ""}`).join(", ")}`
        : undefined,
      variant: failed.length > 0 ? "destructive" : undefined,
    });
  }, [promoteAsins, buySet, onHoldSet, toast]);

  const startBulkSet = useCallback((which: "buy" | "hold") => {
    const plan = which === "buy" ? buyPlan : holdPlan;
    if (plan.selectedCount === 0 || plan.targets.length === 0) return;
    const toPromote = promoteTargets(plan, inDbSet);
    // Confirm ONLY when something would be promoted (§14).
    if (toPromote.length > 0) { setPendingBulkSet({ which, plan, toPromote }); return; }
    void commitBulkSet(which, plan, []);
  }, [buyPlan, holdPlan, inDbSet, commitBulkSet]);

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
    // Visibility toggles (scope controls, not filters) — same semantics as
    // the main page: toggle off → rows with that status hidden, and hidden
    // rows drop out of export's filtered set the same way.
    let scoped = results;
    if (!showGated) scoped = scoped.filter((r) => (r.eligibilityData?.status ?? "check") !== "no");
    if (!showMeltable) scoped = scoped.filter((r) => !r.isMeltable);
    const filtered = Object.keys(colFilters).length > 0
      ? scoped.filter((r) => matchesFilters(r, colFilters, (colId) =>
          (colId as string) === IN_DB_SENTINEL ? (inDbSet.has(r.asin) ? "yes" : "no") : getRowValue(r, colId, priceSource, settings, includeInboundShipping)))
      : scoped;
    if (!sortCol) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = getRowValue(a, sortCol, priceSource, settings, includeInboundShipping);
      const vb = getRowValue(b, sortCol, priceSource, settings, includeInboundShipping);
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
  }, [results, sortCol, sortDir, settings, colFilters, includeInboundShipping, showGated, showMeltable, priceSource, inDbSet]);

  // §21 in-database filter (2026-09-12): a promoted row rightly vanishes
  // from a "Not in database" view on refetch — prune the selection to
  // VISIBLE rows so a hidden row is never carried into the next action.
  useEffect(() => {
    setSelectedSet((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(sortedResults.map((r) => r.asin));
      const next = new Set(Array.from(prev).filter((a) => visible.has(a)));
      return next.size === prev.size ? prev : next;
    });
  }, [sortedResults]);

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
  const reviewedSaveUrl = useCallback((asin: string) => `/api/bulk-lists/${selectedListId}/asins/${asin}/last-reviewed`, [selectedListId]);

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
        {/* §21 Promote (2026-09-09): selection-scoped, never "all" — a
            1,946-row promote must be deliberate. Label grep clean per §8. */}
        <Button variant="outline" size="sm" className="h-8 text-xs" data-testid="button-add-to-database"
          disabled={selectedSet.size === 0}
          title={selectedSet.size === 0 ? "Select rows to add to your database" : undefined}
          onClick={handleAddToDatabase}>
          <Database className="h-3.5 w-3.5 mr-1.5" />
          Add to database{selectedSet.size > 0 ? ` (${selectedSet.size})` : ""}
        </Button>
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
        <ExportButtons results={exportResults} priceSource={priceSource} settings={settings} columnConfig={columnConfig} filename={exportFilename} includeSkuSubColumn={false} includeInboundShipping={includeInboundShipping} />
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
          priceSource={priceSource}
          settings={settings}
          columnConfig={columnConfig}
          activeFilter="all"
          buySet={buySet}
          onBulkBuy={() => startBulkSet("buy")}
          onBulkHold={() => startBulkSet("hold")}
          bulkBuyLabel={bulkToggleLabel(buyPlan, "Buy List")}
          bulkHoldLabel={bulkToggleLabel(holdPlan, "Hold")}
          bulkActionsDisabled={selectedSet.size === 0}
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
          includeInboundShipping={includeInboundShipping}
          dateFilterCols={BULK_DATE_FILTER_COLS}
          inDbFilterOnProduct
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
          reviewedSaveUrl={reviewedSaveUrl}
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

      {/* §21 bulk cart/hold confirm (2026-10-03). Shown ONLY when the plan
          would promote — zero to promote goes straight through (§14). It
          names the promote count, which is the side effect the button
          label does not mention. */}
      <Dialog open={pendingBulkSet != null} onOpenChange={(v) => { if (!v) setPendingBulkSet(null); }}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-bulk-set-confirm">
          <DialogHeader>
            <DialogTitle>
              {pendingBulkSet
                ? `${pendingBulkSet.plan.direction === "add" ? "Add" : "Remove"} ${pendingBulkSet.plan.selectedCount} ${pendingBulkSet.plan.direction === "add" ? "to" : "from"} ${pendingBulkSet.which === "buy" ? "Buy List" : "Hold"}`
                : ""}
            </DialogTitle>
            <DialogDescription data-testid="text-bulk-set-promote-count">
              {pendingBulkSet
                ? `${pendingBulkSet.toPromote.length} of these aren't in your database yet and will be added.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingBulkSet(null)} data-testid="button-bulk-set-cancel">Cancel</Button>
            <Button
              data-testid="button-bulk-set-confirm"
              onClick={() => {
                const p = pendingBulkSet;
                setPendingBulkSet(null);
                if (p) void commitBulkSet(p.which, p.plan, p.toPromote);
              }}
            >
              Confirm
            </Button>
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
              One refresh job for this list: catalog ASINs through the main components (then copied here), the rest through the public components against the bulk tables only (scheduler v1).
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
      {/* §21: the SAME dialog + storage key as the ASINs page. Controls this
          page cannot honor render DISABLED with a reason — never hidden. */}
      <SettingsDialog
        onSettingsChange={setSettings}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        hideTrigger
        movedToggles={{
          includeInboundShipping,
          onIncludeInboundShippingChange: setIncludeInboundShipping,
          priceSource,
          onPriceSourceChange: (v) => { setPriceSource(v); savePriceSource(v); },
          showGated,
          onShowGatedChange: (v) => { setShowGated(v); saveShowGated(v); },
          showMeltable,
          onShowMeltableChange: (v) => { setShowMeltable(v); saveShowMeltable(v); },
          showParked: loadShowParked(),
          onShowParkedChange: () => {},
          showDead: loadShowDead(),
          onShowDeadChange: () => {},
          onResetCogs: () => {},
          isResettingCogs: false,
          disabledReasons: {
            showParked: "Parked/dead are statuses of ASINs in your main catalog; bulk rows don't have them.",
            showDead: "Parked/dead are statuses of ASINs in your main catalog; bulk rows don't have them.",
            resetCogs: "Acts on the main catalog's estimates — this page never writes there (§21 isolation).",
          },
        }}
      />
    </div>
  );
}
