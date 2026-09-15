import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { ResultsTable, getRowValue, DATE_VALUE_COLS } from "@/components/results-table";
import { ColumnManager } from "@/components/column-manager";
import { ExportButtons } from "@/components/export-buttons";
import { matchesFilters, type ColFilter, type FilterMap } from "@/components/column-filter";
import { Button } from "@/components/ui/button";
import { loadColumnConfig, type ColumnConfig } from "@/lib/columns";
import { loadSettings, loadIncludeInbound, loadPriceSource } from "@/lib/settings";
import { loadBuyList, saveBuyList, loadOnHoldList, saveOnHoldList } from "@/lib/buy-hold";
import { ALL_COLUMNS, type AsinResult, type ColumnId, type PriceSource, type Settings } from "@shared/schema";

// §23 Repricer — zero-sales view (Phase 1b, 2026-09-15).
//
// SC-Active listings (has_buyable_offer = TRUE) with at-FBA stock that sold
// NOTHING in the trailing 7 days. The whole filter lives on the BACKEND
// (GET /api/repricer/zero-sales) — this page never re-derives the population,
// so what the operator sees can't drift from what the rules say.
//
// Read-only: no writers. Column config is parameterized (§21 precedent) so it
// never clobbers the main table's saved layout.
const REPRICER_COLUMNS_KEY = "fba-repricer-column-config";

interface Freshness {
  salesThrough: string | null;
  salesRunAt: string | null;
  inventoryAsOf: string | null;
  inventoryRunAt: string | null;
  listingsCheckedAt: string | null;
  listingsRunAt: string | null;
  windowDays: number;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Repricer() {
  const [rows, setRows] = useState<AsinResult[]>([]);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [notYetChecked, setNotYetChecked] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [settings] = useState<Settings>(loadSettings);
  const [includeInboundShipping] = useState(loadIncludeInbound);
  const [priceSource] = useState<PriceSource>(loadPriceSource);
  const [columnConfig, setColumnConfig] = useState<ColumnConfig>(
    () => loadColumnConfig(REPRICER_COLUMNS_KEY, ALL_COLUMNS),
  );
  const [buySet, setBuySet] = useState<Set<string>>(loadBuyList);
  const [onHoldSet, setOnHoldSet] = useState<Set<string>>(loadOnHoldList);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  const [colFilters, setColFilters] = useState<FilterMap>({});
  const [sortCol, setSortCol] = useState<ColumnId | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/repricer/zero-sales");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const body = await res.json();
      setRows(body.rows ?? []);
      setFreshness(body.freshness ?? null);
      setNotYetChecked(body.notYetChecked ?? 0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sortedResults = useMemo(() => {
    const filtered = Object.keys(colFilters).length > 0
      ? rows.filter((r) => matchesFilters(r, colFilters, (colId) => getRowValue(r, colId, priceSource, settings, includeInboundShipping)))
      : rows;
    if (!sortCol) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = getRowValue(a, sortCol, priceSource, settings, includeInboundShipping);
      const vb = getRowValue(b, sortCol, priceSource, settings, includeInboundShipping);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      if (DATE_VALUE_COLS.has(sortCol)) {
        const ta = new Date(String(va)).getTime(), tb = new Date(String(vb)).getTime();
        if (!isNaN(ta) && !isNaN(tb)) return (ta - tb) * dir;
      }
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, colFilters, sortCol, sortDir, priceSource, settings, includeInboundShipping]);

  // Export scope mirrors every other table: selection if any, else the
  // filtered set.
  const exportResults = useMemo(
    () => (selectedSet.size > 0 ? sortedResults.filter((r) => selectedSet.has(r.asin)) : sortedResults),
    [sortedResults, selectedSet],
  );

  const handleSort = useCallback((colId: ColumnId) => {
    setSortCol((prev) => {
      if (prev === colId) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return prev; }
      setSortDir("desc");
      return colId;
    });
  }, []);

  const toggleIn = (set: Set<string>, asin: string) => {
    const next = new Set(set);
    if (next.has(asin)) next.delete(asin); else next.add(asin);
    return next;
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold" data-testid="text-repricer-title">Zero sales — last 7 days</h1>
          <p className="text-xs text-muted-foreground">
            Active listings in Seller Central with stock at FBA and no units sold in the trailing {freshness?.windowDays ?? 7} days.
          </p>
        </div>
        <span className="text-xs text-muted-foreground" data-testid="text-repricer-count">
          {loading ? "loading…" : `${sortedResults.length} ASIN${sortedResults.length === 1 ? "" : "s"}`}
        </span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => void load()} disabled={loading} data-testid="button-repricer-reload">
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Reload
        </Button>
        <ExportButtons
          results={exportResults}
          priceSource={priceSource}
          settings={settings}
          columnConfig={columnConfig}
          filename="repricer-zero-sales.csv"
          includeInboundShipping={includeInboundShipping}
        />
        <ColumnManager config={columnConfig} onChange={setColumnConfig} columns={ALL_COLUMNS} storageKey={REPRICER_COLUMNS_KEY} />
      </div>

      {/* Data-as-of (§23): crons are OFF, so every input is only as fresh as
          the last manual Prices & Stock run. A sales gap silently manufactures
          "zero sales" — it must be visible, never mistaken for a dead ASIN. */}
      {freshness && (
        <div className="flex items-center gap-4 flex-wrap text-[11px] text-muted-foreground border rounded px-3 py-2" data-testid="text-repricer-freshness">
          <span>Sales through <strong>{freshness.salesThrough ?? "—"}</strong> (run {ago(freshness.salesRunAt)})</span>
          <span>Inventory as of <strong>{freshness.inventoryAsOf ? new Date(freshness.inventoryAsOf).toLocaleString() : "—"}</strong></span>
          <span>Listings checked <strong>{ago(freshness.listingsCheckedAt)}</strong></span>
        </div>
      )}

      {notYetChecked > 0 && (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 border border-amber-500/40 rounded px-3 py-2" data-testid="text-repricer-unchecked">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            Not yet checked: <strong>{notYetChecked}</strong> — these have stock and no sales, but their listing status has never been
            probed, so they're excluded rather than assumed active. Run Prices &amp; Stock (listings stage) to resolve them.
          </span>
        </div>
      )}

      {error && <div className="text-sm text-destructive" data-testid="text-repricer-error">{error}</div>}

      {!loading && rows.length === 0 && !error && (
        <div className="text-sm text-muted-foreground py-16 text-center" data-testid="text-repricer-empty">
          No ASINs match — every SC-active listing with stock sold at least one unit in the last {freshness?.windowDays ?? 7} days.
        </div>
      )}

      {rows.length > 0 && (
        <ResultsTable
          results={sortedResults}
          priceSource={priceSource}
          settings={settings}
          columnConfig={columnConfig}
          activeFilter="all"
          buySet={buySet}
          onToggleBuy={(asin) => setBuySet((prev) => { const n = toggleIn(prev, asin); saveBuyList(n); return n; })}
          onHoldSet={onHoldSet}
          onToggleHold={(asin) => setOnHoldSet((prev) => { const n = toggleIn(prev, asin); saveOnHoldList(n); return n; })}
          selectedSet={selectedSet}
          onToggleSelect={(asin) => setSelectedSet((prev) => toggleIn(prev, asin))}
          onSelectAllPage={(asins) => setSelectedSet(new Set(asins))}
          onClearSelection={() => setSelectedSet(new Set())}
          includeInboundShipping={includeInboundShipping}
          sortCol={sortCol}
          sortDir={sortDir}
          onSort={handleSort}
          colFilters={colFilters}
          onFilterApply={(f: ColFilter) => setColFilters((prev) => ({ ...prev, [f.colId]: f }))}
          onFilterClear={(colId) => setColFilters((prev) => { const n = { ...prev }; delete n[colId]; return n; })}
          columns={ALL_COLUMNS}
        />
      )}
    </div>
  );
}
