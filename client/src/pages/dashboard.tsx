/**
 * Dashboard (SPEC §28, patch docs/claude_spec-patch-analytics-dashboard.md):
 * the Spend · Sales · Profit grid over one of four range sets, the coverage
 * header, and the three charts under it (DashboardCharts, their own range).
 *
 * Rule (§2.1): this page NEVER reads or writes the global date range — the
 * set selector and the charts' own picker are its only range controls; the
 * server resolves "today" (Eastern for Spend, Pacific for Sales).
 */
import { useCallback, useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { MetricGrid, fmtRangeLabel } from "@/components/metric-grid";
import { DashboardCharts } from "@/components/dashboard-charts";
import { SET_COLUMN_LABELS, type RangeSetKey } from "@/lib/dashboard-sets";
import type { DashboardGrid } from "@shared/dashboard";

/** Remembered per browser (moves with the Buy-List-to-DB patch like the column widths and the Buy List). */
export const RANGE_SET_KEY = "af-dashboard-range-set";

function loadSet(): RangeSetKey {
  try { const v = Number(localStorage.getItem(RANGE_SET_KEY)); return v === 2 || v === 3 || v === 4 ? v : 1; } catch { return 1; }
}
function saveSet(set: RangeSetKey) { try { localStorage.setItem(RANGE_SET_KEY, String(set)); } catch { /* per-browser convenience only */ } }

const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");

export default function Dashboard() {
  const [set, setSet] = useState<RangeSetKey>(loadSet);
  const today = ymdLocal(new Date());
  const [custom, setCustom] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const [grid, setGrid] = useState<DashboardGrid | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (set === 4 && !(custom.from && custom.to && custom.from <= custom.to)) return;
    setLoading(true); setError(null);
    try {
      const q = new URLSearchParams({ set: String(set) });
      if (set === 4) { q.set("from", custom.from); q.set("to", custom.to); }
      const res = await fetch(`/api/dashboard/grid?${q.toString()}`);
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || `HTTP ${res.status}`); }
      setGrid(await res.json());
    } catch (e: any) { setError(e.message ?? String(e)); }
    finally { setLoading(false); }
  }, [set, custom.from, custom.to]);
  useEffect(() => { void load(); }, [load]);

  const cov = grid?.coverage;
  return (
    <div className="p-6 space-y-4" data-testid="page-dashboard">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-xs text-muted-foreground">Spend by PO date (Eastern) · Sales by Amazon's Pacific day</p>
        </div>
        <div className="flex-1" />
        {/* Coverage header (§2.3 guard): what the Sales cells can know. */}
        {cov && (
          <div className="text-right text-xs text-muted-foreground" data-testid="dashboard-coverage">
            <div>Sales through <span className="text-foreground">{cov.newestSaleDate ? fmtRangeLabel(cov.newestSaleDate, cov.newestSaleDate) : "—"}</span> · synced {fmtTime(cov.lastSalesSyncAt)}{cov.earliestSaleDate ? ` · data from ${fmtRangeLabel(cov.earliestSaleDate, cov.earliestSaleDate)}` : ""}</div>
            {cov.rebackfillPending && (
              <div data-testid="dashboard-rebackfill-pending">Orders not loaded yet — run <code className="font-mono">backfill:sales</code> for the Pacific-day basis</div>
            )}
            {!cov.rebackfillPending && cov.ordersFrom && cov.earliestSaleDate && cov.ordersFrom > cov.earliestSaleDate && (
              <div data-testid="dashboard-orders-from">Orders from {fmtRangeLabel(cov.ordersFrom, cov.ordersFrom)} (earlier sales stay on the old day basis)</div>
            )}
          </div>
        )}
      </div>

      {/* Range set selector (§2.2): one segmented control, the choice remembered per browser; set 4 adds a two-date control local to the grid. */}
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup type="single" variant="outline" size="sm" value={String(set)} onValueChange={(v) => { if (v) { const n = Number(v) as RangeSetKey; setSet(n); saveSet(n); } }} className="justify-start flex-wrap" data-testid="dashboard-range-set">
          {([1, 2, 3, 4] as RangeSetKey[]).map((n) => (
            <ToggleGroupItem key={n} value={String(n)} className="h-8 px-3 text-xs" data-testid={`dashboard-set-${n}`}>{SET_COLUMN_LABELS[n]}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        {set === 4 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="dashboard-custom-range">
            <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground" data-testid="input-dashboard-from" />
            <span>to</span>
            <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground" data-testid="input-dashboard-to" />
          </div>
        )}
      </div>

      {error && (
        <div className="text-sm text-muted-foreground" data-testid="dashboard-error">
          Couldn't load the grid: {error}. <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void load()}>Retry</Button>
        </div>
      )}
      <MetricGrid grid={grid} loading={loading} />
      <DashboardCharts />
    </div>
  );
}
