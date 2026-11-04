/**
 * Dashboard (SPEC §28, patch docs/claude_spec-patch-analytics-dashboard.md):
 * the Spend · Sales · Profit grid over one of four range sets (the range-set
 * dropdown in the header), and the three charts under it (DashboardCharts,
 * their own range). The coverage line lives in a tooltip on the SALES label.
 *
 * Rule (§2.1): this page NEVER reads or writes the global date range — the
 * set selector and the charts' own picker are its only range controls; the
 * server resolves "today" (Eastern for Spend, Pacific for Sales).
 */
import { useCallback, useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { MetricGrid } from "@/components/metric-grid";
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

  return (
    <div className="p-6 space-y-4" data-testid="page-dashboard">
      {/* Page header (tiles patch 2026-11-04): the title only on the left; on the right the range-set dropdown
          ("Date ranges", the four sets; "Custom range…" shows the two-date control beside it). The coverage
          lines moved into a tooltip on every tile's SALES label (coverageTooltip). */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex flex-wrap items-center gap-2.5" data-testid="dashboard-range-set">
          <label htmlFor="dashboard-range-set" className="text-xs text-muted-foreground">Date ranges</label>
          <Select value={String(set)} onValueChange={(v) => { const n = Number(v) as RangeSetKey; setSet(n); saveSet(n); }}>
            <SelectTrigger id="dashboard-range-set" className="h-8 w-auto gap-2 text-xs font-medium" data-testid="select-dashboard-range-set"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              {([1, 2, 3, 4] as RangeSetKey[]).map((n) => (
                <SelectItem key={n} value={String(n)} className="text-xs" data-testid={`dashboard-set-${n}`}>{SET_COLUMN_LABELS[n]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {set === 4 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="dashboard-custom-range">
              <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground" data-testid="input-dashboard-from" />
              <span>to</span>
              <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground" data-testid="input-dashboard-to" />
            </div>
          )}
        </div>
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
