// Keepa trend columns — the cells, the header chips / toggles, the Trend range switch and the hover popup
// (docs/claude_spec-patch-keepa-trends.md "How the columns behave"; the approved mockup
// docs/mockups/keepa-trends-2026-11-18.html is the spec for layout, wording and look — its script's cell(), path(),
// hover and toggle code is what this file does in React; its CSS is keepa-trends.css). The server computes the 14
// bucket values and the scales (server/keepa-trends.ts); this file only draws. Values appear on hover: the
// popup reads the STORED daily values (GET /api/keepa/history/:asin, loaded on first hover, cached for the page
// session), not the bucket averages, and is a fixed-position portal so the table's scroll box never clips it.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  KEEPA_CELLS, KEEPA_LINE, KEEPA_HOVER_MARKER, TREND_BUCKETS, keepaValueText,
  type AsinTrends, type HistoryResponse, type KeepaCellId, type KeepaRange, type KeepaSeries, type TrendsResponse,
} from "@shared/keepa";
import { type KeepaPrefs, type ColumnConfig, DEFAULT_KEEPA_PREFS } from "@/lib/columns";
import { KEEPA_COLUMN_IDS } from "@shared/schema";
import "./keepa-trends.css";

/** The chart's height and the SVG widths the mockup draws (150 / 150 / 150 / 120). */
export const KEEPA_CHART_H = 36;
export const KEEPA_CHART_W: Record<KeepaCellId, number> = { priceTrend: 150, salesVelocityTrend: 150, offerCount: 150, ratingCount: 120 };
/** The column widths the mockup's grid gives the four columns (170 / 210 / 180 / 140). */
export const KEEPA_COL_W: Record<KeepaCellId, number> = { priceTrend: 170, salesVelocityTrend: 210, offerCount: 180, ratingCount: 140 };
const TRENDS_CHUNK = 200;

// ── data: one cache per page session ─────────────────────────────────────────
const trendsCache = new Map<string, AsinTrends | null>();          // `${range}:${asin}` → trends, or null = nothing stored
const pending = new Map<string, Promise<void>>();                   // in-flight chunk keys
const historyCache = new Map<string, Promise<HistoryResponse | null>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
/** Tests / the jobs hook: forget everything cached (a Keepa job finished). */
export function clearKeepaTrendsCache(): void { trendsCache.clear(); historyCache.clear(); notify(); }

async function fetchTrends(asins: string[], range: KeepaRange): Promise<void> {
  const key = `${range}:${asins.join(",")}`;
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    try {
      const r = await fetch(`/api/keepa/trends?asins=${encodeURIComponent(asins.join(","))}&range=${range}`, { credentials: "same-origin" });
      const body = r.ok ? ((await r.json()) as TrendsResponse) : null;
      for (const a of asins) trendsCache.set(`${range}:${a}`, body?.asins[a] ?? null);
    } catch {
      for (const a of asins) trendsCache.set(`${range}:${a}`, null);
    } finally { pending.delete(key); notify(); }
  })();
  pending.set(key, p);
  return p;
}

/** The trends of the rows on screen for `range`; fetched once per ASIN and range, shared by every table on the page. */
export function useKeepaTrends(asins: readonly string[], range: KeepaRange, enabled: boolean): Record<string, AsinTrends | null | undefined> {
  const [, bump] = useState(0);
  useEffect(() => { const l = () => bump((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  const asinKey = asins.join(",");
  useEffect(() => {
    if (!enabled) return;
    const missing = Array.from(new Set(asins)).filter((a) => !trendsCache.has(`${range}:${a}`));
    for (let i = 0; i < missing.length; i += TRENDS_CHUNK) void fetchTrends(missing.slice(i, i + TRENDS_CHUNK), range);
  }, [asinKey, range, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const out: Record<string, AsinTrends | null | undefined> = {};
    for (const a of asins) out[a] = trendsCache.get(`${range}:${a}`);
    return out;
  }, [asinKey, range, enabled, trendsCache.size]); // eslint-disable-line react-hooks/exhaustive-deps
}

function loadHistory(asin: string, range: KeepaRange): Promise<HistoryResponse | null> {
  const key = `${range}:${asin}`;
  let p = historyCache.get(key);
  if (!p) {
    p = fetch(`/api/keepa/history/${asin}?range=${range}`, { credentials: "same-origin" }).then((r) => (r.ok ? (r.json() as Promise<HistoryResponse>) : null)).catch(() => null);
    historyCache.set(key, p);
  }
  return p;
}

// ── drawing (the mockup's path(): 14 points, a gap breaks the path, nothing is drawn across it) ──
export function trendPath(v: ReadonlyArray<number | null>, lo: number, hi: number, W: number, H: number = KEEPA_CHART_H): string {
  const dx = W / (v.length - 1), span = hi - lo || 1;
  let d = "", pen = false;
  for (let i = 0; i < v.length; i++) {
    const y = v[i];
    if (y == null) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${(i * dx).toFixed(1)} ${(H - 3 - ((y - lo) / span) * (H - 6)).toFixed(1)}`;
    pen = true;
  }
  return d || "M0 0";
}

/** Which of a cell's lines are drawn / listed, given the two header toggles (the first listed is drawn on top). */
export function visibleLines(cell: KeepaCellId, prefs: KeepaPrefs): KeepaSeries[] {
  return KEEPA_CELLS[cell].lines.filter((s) => (s === "new_price" ? prefs.showNew : s === "offers_new_fba" ? prefs.showFba : true));
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `Mar 4, 2026` for the day `i` days after `start` (YYYY-MM-DD). */
export function hoverDate(start: string, i: number): string {
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// ── the cell ─────────────────────────────────────────────────────────────────
export function KeepaTrendCell({ cell, asin, trends, prefs }: { cell: KeepaCellId; asin: string; trends: AsinTrends | null | undefined; prefs: KeepaPrefs }) {
  const W = KEEPA_CHART_W[cell], H = KEEPA_CHART_H;
  const [hover, setHover] = useState<{ i: number; x: number; left: number; top: number } | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const lines = visibleLines(cell, prefs);
  const drawn = trends ? lines.filter((s) => trends.buckets[s]) : [];
  // A cell with no data is empty (no chart, no hover).
  if (!trends || KEEPA_CELLS[cell].lines.every((s) => !trends.buckets[s])) return <div style={{ width: W, height: H }} data-testid={`keepa-${cell}-${asin}-empty`} />;
  const n = trends.days;
  const scaleOf = (s: KeepaSeries): [number, number] => trends.scales[(KEEPA_CELLS[cell].scale as Record<string, keyof AsinTrends["scales"]>)[s]] ?? [0, 1];

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
    const x = (i / (n - 1)) * r.width;
    setHover({ i, x, left: r.left + x, top: r.top - 6 });
    if (!history) void loadHistory(asin, prefs.range).then((h) => { if (h) setHistory(h); });
  };
  const rows = hover ? lines.map((s) => {
    const v = history && history.start === trends.start ? history.series[s]?.[hover.i] ?? null : null;
    return { s, text: `${KEEPA_LINE[s].label} ${history ? keepaValueText(s, v) : "…"}` };
  }) : [];

  return (
    <div ref={ref} className="kp-sw" style={{ width: W }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} data-testid={`keepa-${cell}-${asin}`}>
      <svg className="kp-sp" width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <path d={hover ? `M${hover.x.toFixed(1)} 0V${H}` : "M0 0"} stroke={KEEPA_HOVER_MARKER} strokeWidth={1} />
        {/* the first listed line is drawn on top → draw in reverse order */}
        {[...drawn].reverse().map((s) => {
          const [lo, hi] = scaleOf(s);
          return <path key={s} d={trendPath(trends.buckets[s]!, lo, hi, W, H)} stroke={KEEPA_LINE[s].color} strokeWidth={KEEPA_LINE[s].width} data-series={s} />;
        })}
      </svg>
      {hover && createPortal(
        <div className="kp-tip" style={{ left: hover.left, top: hover.top }} role="tooltip" data-testid={`keepa-tip-${cell}-${asin}`}>
          <span className="kp-mut">{hoverDate(trends.start, hover.i)}</span>
          {rows.map((r) => <span key={r.s} style={{ color: KEEPA_LINE[r.s].color }}>{r.text}</span>)}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── the header chips (the New / New, FBA chips are toggles) ──────────────────
export function KeepaHeaderChips({ cell, prefs, onPrefsChange }: { cell: KeepaCellId; prefs: KeepaPrefs; onPrefsChange?: (p: KeepaPrefs) => void }) {
  const def = KEEPA_CELLS[cell];
  return (
    <div className="kp-lg" onClick={(e) => e.stopPropagation()}>
      {def.lines.map((s) => {
        const line = KEEPA_LINE[s];
        if (def.toggle !== s) {
          return <span key={s} className="kp-chip" style={{ color: line.color }}><span className="kp-dot" style={{ background: line.color }} />{line.label}</span>;
        }
        const on = s === "new_price" ? prefs.showNew : prefs.showFba;
        const flip = () => onPrefsChange?.(s === "new_price" ? { ...prefs, showNew: !on } : { ...prefs, showFba: !on });
        return (
          <button key={s} type="button" className={`kp-chip${on ? "" : " off"}`} aria-pressed={on} style={{ color: line.color }} onClick={flip} title={on ? `Hide the ${line.label} line` : `Show the ${line.label} line`} data-testid={`keepa-toggle-${s}`}>
            <span className="kp-dot" style={{ background: line.color }} />{line.label}
          </button>
        );
      })}
    </div>
  );
}

// ── the Trend range switch (table toolbar; shown while a Keepa column is visible) ──
export function KeepaRangeSwitch({ prefs, onPrefsChange }: { prefs: KeepaPrefs; onPrefsChange: (p: KeepaPrefs) => void }) {
  const set = (range: KeepaRange) => { if (range !== prefs.range) onPrefsChange({ ...prefs, range }); };
  return (
    <span className="kp-range" data-testid="keepa-range">
      <span className="kp-mut">Trend range</span>
      <span className="kp-seg" role="group" aria-label="Trend range">
        <button type="button" className={prefs.range === "1y" ? "on" : ""} onClick={() => set("1y")} data-testid="keepa-range-1y">1 year</button>
        <button type="button" className={prefs.range === "all" ? "on" : ""} onClick={() => set("all")} data-testid="keepa-range-all">All</button>
      </span>
    </span>
  );
}

/**
 * A page's Keepa prefs: read from its column config, written back through `onConfigChange` (the page saves the config
 * under its own key, so the Repricer tab and Bulk Calc keep their own); `visible` = at least one of the four columns is on.
 */
export function useKeepaPrefs(config: ColumnConfig, onConfigChange: (next: ColumnConfig) => void): { prefs: KeepaPrefs; visible: boolean; setPrefs: (p: KeepaPrefs) => void } {
  const prefs = config.keepa ?? DEFAULT_KEEPA_PREFS;
  const visible = KEEPA_COLUMN_IDS.some((id) => config.visible.has(id));
  return { prefs, visible, setPrefs: (p) => onConfigChange({ ...config, keepa: p }) };
}

void TREND_BUCKETS;
