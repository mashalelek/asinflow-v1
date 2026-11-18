// Keepa trend endpoints (docs/claude_spec-patch-keepa-trends.md "API", "Trend line", "Gaps", "Scales"; commit 4).
// The ONE place the bucket and scale math lives; the client only draws.
//
//   GET /api/keepa/trends?asins=…&range=1y|all   per ASIN and series: the 14 bucket values and the scale bounds
//   GET /api/keepa/history/:asin?range=1y|all    one ASIN's daily values, every series (loaded on first hover)
//
// Range: 1y = the 365 days ending today (ET); all = from the ASIN's earliest stored Keepa day to today. The range
// is cut into 14 equal time buckets; a bucket's value is the mean of its daily values, or a GAP (null) when fewer
// than half its days have a value. Days before a series begins, and after its lastUpdate, are NULL. Scales are per
// cell, per ASIN, from the bucket values; hiding a line in the client never changes them (they are computed here
// over both lines of the cell).
import express, { type Router, type Request, type Response } from "express";
import { query as defaultQuery } from "./db";
import type { QueryLike } from "./scheduler/types";
import { addDays, dayIndex, etDayOf } from "./keepa";
import {
  KEEPA_SERIES, KEEPA_RANGES, TREND_BUCKETS, TREND_YEAR_DAYS, KEEPA_CELLS,
  type KeepaSeries, type KeepaRange, type AsinTrends, type TrendsResponse, type HistoryResponse, type TrendScaleKey,
} from "@shared/keepa";

export const MAX_TRENDS_ASINS = 250;

interface StoredSeries { asin: string; series: KeepaSeries; first_day: string; vals: Array<number | null> }

/** The stored series of these ASINs. `from` = the earliest day needed (1y); null = everything (all). */
export async function loadStoredSeries(query: QueryLike, asins: readonly string[], from: string | null): Promise<StoredSeries[]> {
  if (asins.length === 0) return [];
  const r = from
    ? await query(
      // Slice in SQL so a 1-year read never moves six years of integers: Postgres clamps a lower bound below 1 to 1,
      // and an upper bound below the lower yields an empty array (a series that ended before the range).
      `SELECT asin, series, GREATEST(first_day, $2::date)::text AS first_day,
              vals[(($2::date - first_day) + 1):cardinality(vals)] AS vals
         FROM keepa_series WHERE asin = ANY($1::text[])`,
      [asins, from],
    )
    : await query(`SELECT asin, series, first_day::text AS first_day, vals FROM keepa_series WHERE asin = ANY($1::text[])`, [asins]);
  return r.rows.map((x: any) => ({ asin: String(x.asin), series: x.series as KeepaSeries, first_day: String(x.first_day).slice(0, 10), vals: (x.vals ?? []) as Array<number | null> }));
}

/** The daily values of one stored series over [start, start + days): NULL outside what is stored. */
export function windowOf(s: Pick<StoredSeries, "first_day" | "vals">, start: string, days: number): Array<number | null> {
  const offset = dayIndex(start) - dayIndex(s.first_day); // index into vals of `start`
  const out: Array<number | null> = new Array(days);
  for (let i = 0; i < days; i++) {
    const j = offset + i;
    out[i] = j >= 0 && j < s.vals.length ? (s.vals[j] ?? null) : null;
  }
  return out;
}

/** 14 equal time buckets; a bucket = the mean of its non-null days, or null when fewer than half its days have one. */
export function bucketize(daily: ReadonlyArray<number | null>, n: number = TREND_BUCKETS): Array<number | null> {
  const out: Array<number | null> = [];
  const len = daily.length;
  for (let b = 0; b < n; b++) {
    const s = Math.floor((b * len) / n), e = Math.floor(((b + 1) * len) / n);
    let sum = 0, cnt = 0;
    for (let i = s; i < e; i++) { const v = daily[i]; if (v != null) { sum += v; cnt++; } }
    out.push(cnt > 0 && cnt * 2 >= e - s ? sum / cnt : null);
  }
  return out;
}

const ext = (arrs: Array<ReadonlyArray<number | null> | undefined>): [number, number] | null => {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrs) for (const v of a ?? []) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo === Infinity ? null : [lo, hi];
};

/** The scale bounds per cell from the bucket values (patch "Scales"); absent when the cell has no data. */
export function scalesOf(b: Partial<Record<KeepaSeries, Array<number | null>>>): Partial<Record<TrendScaleKey, [number, number]>> {
  const out: Partial<Record<TrendScaleKey, [number, number]>> = {};
  const price = ext([b.buy_box, b.new_price]);
  if (price) { const pad = (price[1] - price[0]) * 0.1 || 1; out.price = [price[0] - pad, price[1] + pad]; }
  const sold = ext([b.monthly_sold]);
  if (sold) out.sold = [0, sold[1] * 1.2];
  const rank = ext([b.sales_rank]);
  if (rank) out.rank = [rank[0], rank[1]]; // the client maps the larger rank higher, as Keepa's chart does
  const offers = ext([b.offers_new]) ?? ext([b.offers_new_fba]);
  if (offers) out.offers = [0, offers[1] * 1.1];
  const rating = ext([b.rating_count]);
  if (rating) out.rating = [rating[0] - (rating[1] - rating[0]) * 0.3, rating[1]];
  return out;
}

/** The range for one ASIN: 1y = 365 days ending today; all = its earliest stored day to today. */
export function rangeOf(range: KeepaRange, today: string, firstDays: readonly string[]): { start: string; end: string; days: number } {
  if (range === "1y") return { start: addDays(today, -(TREND_YEAR_DAYS - 1)), end: today, days: TREND_YEAR_DAYS };
  const earliest = firstDays.length ? firstDays.reduce((a, b) => (a < b ? a : b)) : today;
  const days = Math.max(1, dayIndex(today) - dayIndex(earliest) + 1);
  return { start: earliest, end: today, days };
}

export function parseRange(v: unknown): KeepaRange | null {
  return v == null || v === "" ? "1y" : KEEPA_RANGES.includes(v as KeepaRange) ? (v as KeepaRange) : null;
}
const ASIN_RE = /^[A-Z0-9]{10}$/;
export function parseAsins(v: unknown): string[] | null {
  const list = Array.from(new Set(String(v ?? "").split(",").map((a) => a.trim().toUpperCase()).filter(Boolean)));
  if (list.length === 0 || list.length > MAX_TRENDS_ASINS || list.some((a) => !ASIN_RE.test(a))) return null;
  return list;
}

/** The trends of these ASINs over the range, today being `now`'s ET day. An ASIN with nothing stored is absent. */
export async function loadTrends(query: QueryLike, asins: readonly string[], range: KeepaRange, now: Date = new Date()): Promise<TrendsResponse> {
  const today = etDayOf(now.getTime());
  const from = range === "1y" ? addDays(today, -(TREND_YEAR_DAYS - 1)) : null;
  const rows = await loadStoredSeries(query, asins, from);
  const byAsin = new Map<string, StoredSeries[]>();
  for (const r of rows) { const l = byAsin.get(r.asin) ?? []; l.push(r); byAsin.set(r.asin, l); }
  const out: Record<string, AsinTrends> = {};
  byAsin.forEach((list, asin) => {
    const { start, end, days } = rangeOf(range, today, list.map((s) => s.first_day));
    const buckets: Partial<Record<KeepaSeries, Array<number | null>>> = {};
    for (const s of list) {
      const b = bucketize(windowOf(s, start, days));
      if (b.some((v) => v != null)) buckets[s.series] = b;
    }
    out[asin] = { asin, start, end, days, buckets, scales: scalesOf(buckets) };
  });
  return { range, end: today, asins: out };
}

/** One ASIN's daily values over the range, every series it has (the hover popup). */
export async function loadHistory(query: QueryLike, asin: string, range: KeepaRange, now: Date = new Date()): Promise<HistoryResponse> {
  const today = etDayOf(now.getTime());
  const from = range === "1y" ? addDays(today, -(TREND_YEAR_DAYS - 1)) : null;
  const rows = await loadStoredSeries(query, [asin], from);
  const { start, end, days } = rangeOf(range, today, rows.map((s) => s.first_day));
  const series: Partial<Record<KeepaSeries, Array<number | null>>> = {};
  for (const s of rows) series[s.series] = windowOf(s, start, days);
  return { asin, range, start, end, days, series };
}

export function createKeepaRouter(deps: { query?: QueryLike; now?: () => Date } = {}): Router {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const now = deps.now ?? (() => new Date());
  const router = express.Router();
  router.get("/api/keepa/trends", async (req: Request, res: Response) => {
    const asins = parseAsins(req.query.asins);
    const range = parseRange(req.query.range);
    if (!asins) { res.status(400).json({ error: "invalid_asins", message: `asins: 1–${MAX_TRENDS_ASINS} comma-separated ASINs` }); return; }
    if (!range) { res.status(400).json({ error: "invalid_range", message: "range: 1y or all" }); return; }
    try { res.json(await loadTrends(query, asins, range, now())); }
    catch (err: any) { res.status(500).json({ error: "keepa_trends_failed", message: err?.message ?? String(err) }); }
  });
  router.get("/api/keepa/history/:asin", async (req: Request, res: Response) => {
    const asin = String(req.params.asin ?? "").toUpperCase();
    const range = parseRange(req.query.range);
    if (!ASIN_RE.test(asin)) { res.status(400).json({ error: "invalid_asin" }); return; }
    if (!range) { res.status(400).json({ error: "invalid_range", message: "range: 1y or all" }); return; }
    try { res.json(await loadHistory(query, asin, range, now())); }
    catch (err: any) { res.status(500).json({ error: "keepa_history_failed", message: err?.message ?? String(err) }); }
  });
  return router;
}

// Referenced so a stale cell list is a type error here, not a runtime surprise in the client.
export const KEEPA_CELL_SERIES: readonly KeepaSeries[] = Object.values(KEEPA_CELLS).flatMap((c) => [...c.lines]);
void KEEPA_SERIES;
