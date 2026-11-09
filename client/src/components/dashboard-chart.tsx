/**
 * DashboardChart (SPEC §28 §2.6) — AF's first chart component; one shared
 * component for the three charts under the Dashboard tiles (30-day running,
 * Monthly, Weekly). Spend as bars on the left $ axis, Sales as a line on the
 * right $ axis (tiles patch 2026-11-04 — the 2026-11-03 build had them the
 * other way round); each series has a checkbox that removes it AND its axis.
 * Running sums come from the server, never computed here. Colour follows the
 * entity, not the mark: Sales keeps the blue slot, Spend the teal one.
 *
 * Marks (dataviz): bars capped at 24 px with 4 px rounded data-ends, a 2 px
 * line, hairline solid grid, text in text tokens only, both series in the
 * legend row (the checkboxes double as the legend), one tooltip listing every
 * series at the hovered period, a table view twin. Series colours are AF's
 * chart tokens for light mode and validated dark-mode steps (the dataviz
 * validator passes both pairs: CVD ΔE 23.3 light / 18.9 dark).
 */
import { useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { useTheme } from "@/components/theme-provider";
import { fmtMoney, fmtInt, fmtRangeLabel } from "@/components/metric-grid";
import type { DashboardSeries, SeriesKind, SeriesPoint } from "@shared/dashboard";

/** Series colours: light = AF's --chart-1 / --chart-2; dark = steps validated on the dark card surface (#292524). */
export const SERIES_COLORS = {
  light: { sales: "#0a5adb", spend: "#12a190" },
  dark: { sales: "#3c83f6", spend: "#12a594" },
} as const;

export const CHART_TITLES: Record<SeriesKind, string> = { running30: "30-day running", monthly: "Monthly", weekly: "Weekly" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The x tick: a short date for days / weeks, "Oct '26" for months. */
export function tickLabel(kind: SeriesKind, period: string): string {
  const [y, m, d] = period.split("-").map(Number);
  if (kind === "monthly") return `${MONTHS[m - 1]} '${String(y).slice(2)}`;
  return `${m}/${d}`;
}
/** The tooltip's period line: what the point covers, "(to date)" on a partial period. */
export function periodLabel(kind: SeriesKind, period: string, partial: boolean): string {
  const [y, m] = period.split("-").map(Number);
  const toDate = partial ? " (to date)" : "";
  if (kind === "monthly") return `${MONTHS[m - 1]} ${y}${toDate}`;
  if (kind === "weekly") return `Week of ${fmtRangeLabel(period, period)}${toDate}`;
  return `30 days to ${fmtRangeLabel(period, period)}${partial ? " (today)" : ""}`;
}
/** Compact $ axis ticks: $0 / $5K / $20K / $1.2M. */
export function axisMoney(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M` : a >= 10_000 ? `${Math.round(a / 1000)}K` : a >= 1000 ? `${(a / 1000).toFixed(1)}K` : String(Math.round(a));
  return `${v < 0 ? "-" : ""}$${s}`;
}

export interface DashboardChartProps {
  kind: SeriesKind;
  series: DashboardSeries | null;
  loading: boolean;
  showSales: boolean;
  showSpend: boolean;
  onToggle: (which: "sales" | "spend", on: boolean) => void;
}

export function DashboardChart({ kind, series, loading, showSales, showSpend, onToggle }: DashboardChartProps) {
  const { theme } = useTheme();
  const colors = theme === "dark" ? SERIES_COLORS.dark : SERIES_COLORS.light;
  const [table, setTable] = useState(false);
  const points = series?.points ?? [];
  const partialLast = points.length > 0 && points[points.length - 1].partial;
  const data = useMemo(() => points.map((p) => ({ ...p, tick: tickLabel(kind, p.period) })), [points, kind]);
  const nothingOn = !showSales && !showSpend;
  const mutedInk = "hsl(var(--muted-foreground))";
  return (
    <Card className={`p-4 transition-opacity ${loading && series ? "opacity-60" : ""}`} data-testid={`dashboard-chart-${kind}`} aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">{CHART_TITLES[kind]}</h2>
        {/* The legend row: a checkbox per series, the swatch mirrors the mark (rect for the Spend bars, line for the Sales line). */}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer" data-testid={`toggle-${kind}-spend`}>
          <input type="checkbox" checked={showSpend} onChange={(e) => onToggle("spend", e.target.checked)} />
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: colors.spend }} aria-hidden />
          Spend
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer" data-testid={`toggle-${kind}-sales`}>
          <input type="checkbox" checked={showSales} onChange={(e) => onToggle("sales", e.target.checked)} />
          <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: colors.sales }} aria-hidden />
          Sales
        </label>
        <div className="flex-1" />
        <button type="button" onClick={() => setTable((t) => !t)} className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline" data-testid={`button-${kind}-table`}>{table ? "Chart" : "Table"}</button>
      </div>
      {(series?.salesFrom || partialLast) && (
        <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`note-${kind}`}>
          {series?.salesFrom ? `Sales from ${fmtRangeLabel(series.salesFrom, series.salesFrom)} — earlier periods have no sales data. ` : ""}
          {partialLast ? "The last period is to date." : ""}
        </p>
      )}
      {table ? (
        <div className="mt-3 max-h-[320px] overflow-auto text-xs">
          <table className="w-full border-collapse tabular-nums">
            <thead><tr className="text-muted-foreground"><th className="py-1 text-left font-medium">Period</th><th className="py-1 text-right font-medium">Sales</th><th className="py-1 text-right font-medium">Spend</th><th className="py-1 text-right font-medium">POs</th><th className="py-1 text-right font-medium">ASIN units</th><th className="py-1 text-right font-medium">Orders</th></tr></thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.period} style={{ borderTop: "0.5px solid hsl(var(--border))" }}>
                  <td className="py-1 whitespace-nowrap">{periodLabel(kind, p.period, p.partial)}</td>
                  <td className="py-1 text-right">{fmtMoney(p.sales)}</td><td className="py-1 text-right">{fmtMoney(p.spend)}</td>
                  <td className="py-1 text-right">{fmtInt(p.poCount)}</td><td className="py-1 text-right">{fmtInt(p.units)}</td><td className="py-1 text-right">{fmtInt(p.orders)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : nothingOn ? (
        <div className="mt-3 flex h-[280px] items-center justify-center text-xs text-muted-foreground">Tick Spend or Sales to draw the chart.</div>
      ) : points.length === 0 ? (
        <div className="mt-3 flex h-[280px] items-center justify-center text-xs text-muted-foreground">{loading ? "Loading…" : "No data in this range."}</div>
      ) : (
        <div className="mt-3" style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: showSales ? 8 : 16, left: 8, bottom: 4 }} barCategoryGap="20%">
              <CartesianGrid stroke="hsl(var(--border))" strokeWidth={1} vertical={false} />
              <XAxis dataKey="tick" tick={{ fontSize: 10, fill: mutedInk }} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} minTickGap={kind === "running30" ? 48 : 12} />
              {showSpend && <YAxis yAxisId="spend" tick={{ fontSize: 10, fill: mutedInk }} tickLine={false} axisLine={false} tickFormatter={axisMoney} width={56} />}
              {showSales && <YAxis yAxisId="sales" orientation="right" tick={{ fontSize: 10, fill: mutedInk }} tickLine={false} axisLine={false} tickFormatter={axisMoney} width={56} />}
              <Tooltip cursor={{ fill: "hsl(var(--muted) / 0.4)" }} content={(p: any) => <ChartTip kind={kind} active={p.active} payload={p.payload} colors={colors} showSales={showSales} showSpend={showSpend} />} />
              {showSpend && <Bar yAxisId="spend" dataKey="spend" name="Spend" fill={colors.spend} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />}
              {showSales && <Line yAxisId="sales" type="monotone" dataKey="sales" name="Sales" stroke={colors.sales} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

/** One tooltip, every series: period · Sales · Spend · POs · units · orders — values lead, labels follow. */
function ChartTip({ kind, active, payload, colors, showSales, showSpend }: { kind: SeriesKind; active?: boolean; payload?: Array<{ payload: SeriesPoint }>; colors: { sales: string; spend: string }; showSales: boolean; showSpend: boolean }) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  const Row = ({ swatch, value, label }: { swatch?: React.ReactNode; value: string; label: string }) => (
    <div className="flex items-center gap-2">
      <span className="w-3 flex justify-center">{swatch}</span>
      <span className="font-medium tabular-nums">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
  return (
    <div className="rounded-md border px-3 py-2 text-xs shadow-sm" style={{ background: "hsl(var(--card))", borderColor: "hsl(var(--border))" }}>
      <div className="mb-1 text-muted-foreground">{periodLabel(kind, p.period, p.partial)}</div>
      {showSpend && <Row swatch={<span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: colors.spend }} />} value={fmtMoney(p.spend)} label="Spend" />}
      {showSales && <Row swatch={<span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: colors.sales }} />} value={fmtMoney(p.sales)} label="Sales" />}
      <Row value={fmtInt(p.poCount)} label={`PO${p.poCount === 1 ? "" : "s"}`} />
      <Row value={fmtInt(p.units)} label="ASIN units sold" />
      <Row value={fmtInt(p.orders)} label="orders" />
    </div>
  );
}
