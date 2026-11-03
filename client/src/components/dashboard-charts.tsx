/**
 * The three Dashboard charts (SPEC §28 §2.6) under one range control —
 * Last 12 months (default: 12 calendar months ending with the current one,
 * the partial period "to date") or Custom (two dates) — local state,
 * remembered per browser (af-dashboard-chart-range). The three series load
 * in parallel; a refetch keeps the previous frame at reduced opacity.
 * Never touches the global date range.
 */
import { useCallback, useEffect, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { DashboardChart } from "@/components/dashboard-chart";
import { SERIES_KINDS, type DashboardSeries, type SeriesKind } from "@shared/dashboard";

export const CHART_RANGE_KEY = "af-dashboard-chart-range";
export type ChartRangeMode = "last12" | "custom";
export interface ChartRange { mode: ChartRangeMode; from: string; to: string }

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The remembered chart range, or Last 12 months with a custom default of the current year to date. */
export function loadChartRange(raw: string | null, today = ymdLocal(new Date())): ChartRange {
  const fallback: ChartRange = { mode: "last12", from: `${today.slice(0, 4)}-01-01`, to: today };
  if (!raw) return fallback;
  try {
    const p = JSON.parse(raw);
    const mode: ChartRangeMode = p.mode === "custom" ? "custom" : "last12";
    const from = YMD.test(String(p.from)) ? String(p.from) : fallback.from;
    const to = YMD.test(String(p.to)) ? String(p.to) : fallback.to;
    return from <= to ? { mode, from, to } : { ...fallback, mode };
  } catch { return fallback; }
}
/** The query string for one series request: nothing for Last 12 months (the server resolves it), from/to for Custom. */
export function seriesQuery(kind: SeriesKind, range: ChartRange): string {
  const q = new URLSearchParams({ kind });
  if (range.mode === "custom") { q.set("from", range.from); q.set("to", range.to); }
  return q.toString();
}

type Shown = Record<SeriesKind, { sales: boolean; spend: boolean }>;
const allOn = (): Shown => ({ running30: { sales: true, spend: true }, monthly: { sales: true, spend: true }, weekly: { sales: true, spend: true } });

export function DashboardCharts() {
  const [range, setRange] = useState<ChartRange>(() => { try { return loadChartRange(localStorage.getItem(CHART_RANGE_KEY)); } catch { return loadChartRange(null); } });
  const [series, setSeries] = useState<Partial<Record<SeriesKind, DashboardSeries>>>({});
  const [shown, setShown] = useState<Shown>(allOn);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { try { localStorage.setItem(CHART_RANGE_KEY, JSON.stringify(range)); } catch { /* per-browser convenience only */ } }, [range]);

  const load = useCallback(async () => {
    if (range.mode === "custom" && !(YMD.test(range.from) && YMD.test(range.to) && range.from <= range.to)) return;
    setLoading(true); setError(null);
    try {
      const results = await Promise.all(SERIES_KINDS.map(async (kind) => {
        const res = await fetch(`/api/dashboard/series?${seriesQuery(kind, range)}`);
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || `HTTP ${res.status}`); }
        return [kind, (await res.json()) as DashboardSeries] as const;
      }));
      setSeries(Object.fromEntries(results) as Partial<Record<SeriesKind, DashboardSeries>>);
    } catch (e: any) { setError(e.message ?? String(e)); }
    finally { setLoading(false); }
  }, [range]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="space-y-3" data-testid="dashboard-charts">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Charts</h2>
        <ToggleGroup type="single" variant="outline" size="sm" value={range.mode} onValueChange={(v) => { if (v) setRange({ ...range, mode: v as ChartRangeMode }); }} data-testid="dashboard-chart-range">
          <ToggleGroupItem value="last12" className="h-8 px-3 text-xs" data-testid="chart-range-last12">Last 12 months</ToggleGroupItem>
          <ToggleGroupItem value="custom" className="h-8 px-3 text-xs" data-testid="chart-range-custom">Custom</ToggleGroupItem>
        </ToggleGroup>
        {range.mode === "custom" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground" data-testid="input-chart-from" />
            <span>to</span>
            <input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground" data-testid="input-chart-to" />
          </div>
        )}
        {error && <span className="text-xs text-muted-foreground" data-testid="dashboard-charts-error">Couldn't load the charts: {error}. <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void load()}>Retry</Button></span>}
      </div>
      {SERIES_KINDS.map((kind) => (
        <DashboardChart key={kind} kind={kind} series={series[kind] ?? null} loading={loading}
          showSales={shown[kind].sales} showSpend={shown[kind].spend}
          onToggle={(which, on) => setShown({ ...shown, [kind]: { ...shown[kind], [which]: on } })} />
      ))}
    </section>
  );
}
