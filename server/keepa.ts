// Keepa history (docs/claude_spec-patch-keepa-trends.md; spike docs/keepa-spike-2026-11-18.md; migration 121,
// 2026-11-18). The ONLY module that calls api.keepa.com.
//
//   fetch     GET /product?key&domain=1&asin=<≤ 20>&buybox=1&rating=1 — never `offers` (6 tokens a page, nothing
//             here needs it). 4 tokens per ASIN (base 1, +2 buybox, +1 rating — the spike); a 20-ASIN reply is
//             ~10 MB. `tokensLeft` / `refillIn` / `refillRate` are read from every reply and pace the next batch;
//             HTTP 429 (NOT_ENOUGH_TOKEN) → wait `refillIn`, retry; any other batch failure → 3 retries with
//             backoff, then those ASINs are `error:` outcomes and the job goes on.
//   convert   Keepa's change points `[keepaTime, value, …]` (minutes; -1 = no value; BUY_BOX_SHIPPING triples
//             time, price, shipping) → one integer per America/New_York day, the value in effect at the END of
//             the day (a value holds until the next change point), NULL for -1 / before the series began; the
//             series ends on the day of product.lastUpdate.
//             buy_box = csv[18] price + shipping · new_price = csv[1] · sales_rank = csv[3] · offers_new = csv[11]
//             · offers_new_fba = csv[34] COUNT_NEW_FBA (Keepa added it 2026-02; history from then) ·
//             rating_count = csv[17] · monthly_sold = monthlySoldHistory.
//   store     one transaction per ASIN: each series in the response REPLACES its keepa_series row (every pull is
//             the full history), keepa_fetch upserted; a series AF holds that the response lacks stays and the
//             outcome notes series_missing:<name>; a failed / partial response writes nothing for that ASIN.
//   job       component 33, Keepa jobs only (lane K). Scope ordered never-fetched first, then oldest fetched_at;
//             an ASIN fetched since the job's threshold (the daily job: 00:00 ET today; a new-ASIN job: when it
//             was queued) is `not_due`. The daily job runs queued new-ASIN jobs INLINE between its own batches
//             (they go ahead of it), and records `keepa_incomplete` = in-scope ASINs not fetched today when it
//             ends. Dead ASINs are never in scope; what is stored for them stays.
//
// KEEPA_API_KEY is server-side only (SPEC §24): it is in no client bundle and no API response (server/keepa.test.ts
// scans for it). Tests use the recorded product under __fixtures__/keepa/ — never a live call.
import { poolForLane } from "./db";
import { finishJob, recordComponentRun, writeProgress } from "./scheduler/jobs-repo";
import type { ComponentContext, ComponentResult, JobRow, JobSummary, QueryLike } from "./scheduler/types";

import { KEEPA_SERIES, type KeepaSeries } from "@shared/keepa";
export { KEEPA_SERIES, type KeepaSeries };
/** Batch size (spike S5: 20 ASINs = 10.3 MB / 1.9 s, within the 30 MB / 10 s rule). */
export const KEEPA_BATCH = 20;
/** Tokens per ASIN with buybox=1&rating=1 (spike S3) — the pacing estimate until a reply says otherwise. */
export const KEEPA_TOKENS_PER_ASIN = 4;
export const KEEPA_RETRIES = 3;
export const KEEPA_DOMAIN_US = 1;
/** Keepa time is minutes since this offset from the unix epoch. */
export const KEEPA_EPOCH_MIN = 21_564_000;
export const keepaTimeToMs = (keepaMin: number): number => (keepaMin + KEEPA_EPOCH_MIN) * 60_000;
const BASE_URL = "https://api.keepa.com/product";
const REQUEST_TIMEOUT_MS = 120_000;

export const keepaKey = (): string | null => process.env.KEEPA_API_KEY || null;
export const keepaMode = (): "on" | "off" => (keepaKey() ? "on" : "off");

/** Test seams. */
export const keepaDeps = {
  fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => new Date(),
};

// ── The request ──────────────────────────────────────────────────────────────
export interface KeepaReply {
  tokensLeft: number; refillIn: number; refillRate: number; tokensConsumed: number; processingTimeInMs?: number;
  products?: KeepaProduct[]; error?: { type?: string; message?: string } | null;
}
export interface KeepaProduct {
  asin: string;
  lastUpdate?: number;
  csv?: Array<number[] | null> | null;
  monthlySoldHistory?: number[] | null;
}
export class KeepaError extends Error {
  constructor(public status: number, public type: string | null, message: string, public refill?: { tokensLeft: number; refillIn: number; refillRate: number } | null) { super(message); }
}

/** The one URL builder: key, US domain, the ASIN list, buybox + rating. `offers` is never a parameter (the test pins it). */
export function keepaProductUrl(asins: readonly string[], key: string): string {
  if (asins.length === 0 || asins.length > KEEPA_BATCH) throw new Error(`Keepa batch must be 1–${KEEPA_BATCH} ASINs, got ${asins.length}`);
  const qs = new URLSearchParams({ key, domain: String(KEEPA_DOMAIN_US), asin: asins.join(","), buybox: "1", rating: "1" });
  return `${BASE_URL}?${qs}`;
}

/** One Keepa call. 429 → KeepaError(429, NOT_ENOUGH_TOKEN, refill); any other non-2xx → KeepaError. */
export async function fetchKeepaProducts(asins: readonly string[], key: string | null = keepaKey()): Promise<KeepaReply> {
  if (!key) throw new KeepaError(0, "no_key", "KEEPA_API_KEY not set");
  const res = await keepaDeps.fetch(keepaProductUrl(asins, key), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const refill = body && typeof body.tokensLeft === "number" ? { tokensLeft: Number(body.tokensLeft), refillIn: Number(body.refillIn ?? 60_000), refillRate: Number(body.refillRate ?? 20) } : null;
  if (res.status === 429) throw new KeepaError(429, body?.error?.type ?? "NOT_ENOUGH_TOKEN", body?.error?.message ?? "Keepa: not enough tokens", refill);
  if (res.status < 200 || res.status >= 300 || !body) throw new KeepaError(res.status, body?.error?.type ?? null, `Keepa HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : text ? `: ${text.slice(0, 120)}` : ""}`, refill);
  return body as KeepaReply;
}

// ── Token pacing ─────────────────────────────────────────────────────────────
export interface TokenState { tokensLeft: number | null; refillIn: number; refillRate: number }
export const freshTokenState = (): TokenState => ({ tokensLeft: null, refillIn: 60_000, refillRate: 20 });
export function applyReply(s: TokenState, r: { tokensLeft: number; refillIn: number; refillRate: number }): void {
  s.tokensLeft = r.tokensLeft; s.refillIn = r.refillIn; s.refillRate = Math.max(1, r.refillRate);
}
/**
 * How long to wait before a call that needs `need` tokens: nothing while the bucket covers it (or is unknown — the
 * reply will say); otherwise Keepa's next refill (`refillIn` ms) plus one minute per further `refillRate` tokens.
 */
export function waitMsForTokens(need: number, s: TokenState): number {
  if (s.tokensLeft == null || s.tokensLeft >= need) return 0;
  const minutes = Math.ceil((need - s.tokensLeft) / s.refillRate);
  return s.refillIn + (minutes - 1) * 60_000 + 500;
}

// ── Change points → daily values (America/New_York) ──────────────────────────
const ET = "America/New_York";
const ET_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" });
const ET_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: ET, hourCycle: "h23", hour: "2-digit" });
/** The ET calendar day (YYYY-MM-DD) of an instant. */
export function etDayOf(ms: number): string { return ET_DAY.format(new Date(ms)); }
const dayStartCache = new Map<string, number>();
/** The instant 00:00 ET begins on `ymd` (DST-aware: Intl says which hour the EST guess lands on). */
export function etDayStartMs(ymd: string): number {
  const hit = dayStartCache.get(ymd);
  if (hit != null) return hit;
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 5); // 00:00 EST
  const hour = Number(ET_HOUR.format(new Date(guess)).replace(/\D/g, ""));
  const ms = guess - hour * 3_600_000; // 01:00 EDT → one hour earlier
  dayStartCache.set(ymd, ms);
  return ms;
}
export const dayIndex = (ymd: string): number => { const [y, m, d] = ymd.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86_400_000); };
export const dayFromIndex = (i: number): string => new Date(i * 86_400_000).toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number): string => dayFromIndex(dayIndex(ymd) + n);

export interface DailySeries { first_day: string; vals: Array<number | null> }

/**
 * Change points → one value per ET day from the first point's day to `endDay` inclusive: the value in effect at the
 * end of each day (the last point before the next day begins), NULL when that value is -1 or no point exists yet.
 * `stride` 2 = [time, value]; 3 = [time, price, shipping] (value = price + shipping, shipping -1 → 0; price -1 → NULL).
 */
export function changePointsToDaily(points: readonly number[] | null | undefined, stride: 2 | 3, endDay: string): DailySeries | null {
  if (!points || points.length < stride) return null;
  const firstDay = etDayOf(keepaTimeToMs(points[0]));
  const n = dayIndex(endDay) - dayIndex(firstDay) + 1;
  if (n <= 0) return null;
  const vals: Array<number | null> = new Array(n);
  let i = 0; // index of the next point not yet applied
  let current: number | null = null;
  let day = firstDay;
  for (let k = 0; k < n; k++) {
    const nextStart = etDayStartMs(addDays(day, 1));
    while (i < points.length && keepaTimeToMs(points[i]) < nextStart) {
      const v = points[i + 1];
      if (stride === 3) current = v < 0 ? null : v + Math.max(0, points[i + 2] ?? 0);
      else current = v < 0 ? null : v;
      i += stride;
    }
    vals[k] = current;
    day = addDays(day, 1);
  }
  return { first_day: firstDay, vals };
}

const CSV_OF: Partial<Record<KeepaSeries, { idx: number; stride: 2 | 3 }>> = {
  buy_box: { idx: 18, stride: 3 }, new_price: { idx: 1, stride: 2 }, sales_rank: { idx: 3, stride: 2 },
  offers_new: { idx: 11, stride: 2 }, offers_new_fba: { idx: 34, stride: 2 }, rating_count: { idx: 17, stride: 2 },
};

/** Every series the product carries, converted; a series absent from the product is absent from the map. */
export function productToSeries(p: KeepaProduct, now: Date = keepaDeps.now()): Map<KeepaSeries, DailySeries> {
  const endDay = p.lastUpdate ? etDayOf(keepaTimeToMs(p.lastUpdate)) : etDayOf(now.getTime());
  const out = new Map<KeepaSeries, DailySeries>();
  for (const s of KEEPA_SERIES) {
    const points = s === "monthly_sold" ? p.monthlySoldHistory : p.csv?.[CSV_OF[s]!.idx];
    const d = changePointsToDaily(points, s === "monthly_sold" ? 2 : CSV_OF[s]!.stride, endDay);
    if (d) out.set(s, d);
  }
  return out;
}

// ── Storage ──────────────────────────────────────────────────────────────────
/** A single-connection transaction on the current lane's pool (the job pool inside a job). */
export async function withKeepaTx<T>(fn: (q: QueryLike) => Promise<T>): Promise<T> {
  const c = await poolForLane().connect();
  const q: QueryLike = (sql, params) => c.query(sql, params);
  try {
    await q("BEGIN");
    const out = await fn(q);
    await q("COMMIT");
    return out;
  } catch (err) {
    await q("ROLLBACK").catch(() => {});
    throw err;
  } finally { c.release(); }
}

/**
 * Store one product inside `tx` (a single connection, already in a transaction): replace each series present, keep
 * the stored ones the response lacks, upsert keepa_fetch. Returns the missing series names.
 */
export async function storeKeepaProduct(tx: QueryLike, p: KeepaProduct, tokens: number | null, now: Date): Promise<{ series: KeepaSeries[]; missing: KeepaSeries[] }> {
  const series = productToSeries(p, now);
  const held = new Set<string>((await tx(`SELECT series FROM keepa_series WHERE asin = $1`, [p.asin])).rows.map((r: any) => String(r.series)));
  for (const [name, d] of Array.from(series.entries())) {
    await tx(
      `INSERT INTO keepa_series (asin, series, first_day, vals) VALUES ($1, $2, $3::date, $4::integer[])
       ON CONFLICT (asin, series) DO UPDATE SET first_day = EXCLUDED.first_day, vals = EXCLUDED.vals`,
      [p.asin, name, d.first_day, d.vals],
    );
  }
  const missing = KEEPA_SERIES.filter((s) => held.has(s) && !series.has(s));
  await tx(
    `INSERT INTO keepa_fetch (asin, fetched_at, keepa_last_update, tokens, status, error) VALUES ($1, $2, $3, $4, 'fetched', NULL)
     ON CONFLICT (asin) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, keepa_last_update = EXCLUDED.keepa_last_update, tokens = EXCLUDED.tokens, status = 'fetched', error = NULL`,
    [p.asin, now, p.lastUpdate ? new Date(keepaTimeToMs(p.lastUpdate)) : null, tokens],
  );
  return { series: Array.from(series.keys()), missing };
}

async function recordFetchOutcome(q: QueryLike, asin: string, status: "not_found" | "error", error: string | null, now: Date): Promise<void> {
  await q(
    `INSERT INTO keepa_fetch (asin, fetched_at, status, error) VALUES ($1, $2, $3, $4)
     ON CONFLICT (asin) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, status = EXCLUDED.status, error = EXCLUDED.error`,
    [asin, now, status, error],
  );
}

// ── The job ──────────────────────────────────────────────────────────────────
/** The transaction runner the job uses (test seam: the suite swaps in an in-memory store). */
export const keepaTx = { run: withKeepaTx };

export interface KeepaFetchDeps {
  query: QueryLike;
  log: (m: string) => void;
  tx?: typeof withKeepaTx;
  /** Called after each batch with the ASINs done so far (progress + cancel check). */
  onBatch?: (done: number, total: number, lastAsin: string) => Promise<void>;
  /** Called BEFORE each batch (the daily job runs queued new-ASIN jobs here). */
  beforeBatch?: () => Promise<void>;
  tokens: TokenState;
  key?: string | null;
}

/** The ASINs to fetch, in order: never fetched first, then oldest `fetched_at`; those fetched since `threshold` are not due. */
export async function dueAsins(query: QueryLike, scope: readonly string[], threshold: Date): Promise<{ due: string[]; notDue: string[] }> {
  if (scope.length === 0) return { due: [], notDue: [] };
  const r = await query(`SELECT asin, fetched_at FROM keepa_fetch WHERE asin = ANY($1::text[])`, [scope]);
  const at = new Map<string, number>(r.rows.map((x: any) => [String(x.asin), new Date(x.fetched_at).getTime()]));
  const due: string[] = [], notDue: string[] = [];
  for (const a of scope) ((at.get(a) ?? 0) >= threshold.getTime() ? notDue : due).push(a);
  due.sort((a, b) => (at.get(a) ?? 0) - (at.get(b) ?? 0));
  return { due, notDue };
}

/** The job's threshold: the daily job = 00:00 ET today; a new-ASIN job = when it was queued (a restart refetches nothing). */
export function fetchThreshold(job: Pick<JobRow, "trigger" | "queued_at">, now: Date): Date {
  return job.trigger === "scheduled" ? new Date(etDayStartMs(etDayOf(now.getTime()))) : new Date(job.queued_at);
}

/**
 * Fetch `asins` in batches of KEEPA_BATCH with token pacing, storing each product. Returns counts + per-ASIN outcomes
 * (fetched ASINs are counted, not listed; not_found / error / series_missing are listed).
 */
export async function fetchKeepaForAsins(asins: readonly string[], deps: KeepaFetchDeps): Promise<ComponentResult> {
  const counts: Record<string, number> = { fetched: 0, not_found: 0, error: 0, tokens: 0, batches: 0 };
  const outcomes: Record<string, string> = {};
  const tx = deps.tx ?? keepaTx.run;
  const key = deps.key === undefined ? keepaKey() : deps.key;
  let perAsin = KEEPA_TOKENS_PER_ASIN;
  for (let start = 0; start < asins.length; start += KEEPA_BATCH) {
    const batch = asins.slice(start, start + KEEPA_BATCH);
    if (deps.beforeBatch) await deps.beforeBatch();
    let reply: KeepaReply | null = null;
    let lastErr: KeepaError | Error | null = null;
    for (let attempt = 0; attempt <= KEEPA_RETRIES; ) {
      const wait = waitMsForTokens(Math.ceil(batch.length * perAsin), deps.tokens);
      if (wait > 0) { deps.log(`waiting ${Math.round(wait / 1000)} s for Keepa tokens (${deps.tokens.tokensLeft} left, +${deps.tokens.refillRate}/min)`); await keepaDeps.sleep(wait); deps.tokens.tokensLeft = (deps.tokens.tokensLeft ?? 0) + Math.ceil(wait / 60_000) * deps.tokens.refillRate; }
      try {
        reply = await fetchKeepaProducts(batch, key);
        applyReply(deps.tokens, reply);
        break;
      } catch (err: any) {
        lastErr = err;
        if (err instanceof KeepaError && err.status === 429) {
          // Not a retry: the bucket was shorter than estimated. Take Keepa's numbers; the wait at the top of the loop
          // (refillIn, plus a minute per further refillRate the batch needs) runs before the same batch is tried again.
          if (err.refill) applyReply(deps.tokens, err.refill); else deps.tokens.tokensLeft = 0;
          deps.log(`Keepa 429 (${deps.tokens.tokensLeft} tokens left, refill in ${Math.round(deps.tokens.refillIn / 1000)} s)`);
          continue;
        }
        attempt++;
        if (attempt > KEEPA_RETRIES) break;
        const backoff = 2_000 * 2 ** (attempt - 1);
        deps.log(`Keepa batch failed (${err?.message ?? err}); retry ${attempt}/${KEEPA_RETRIES} in ${backoff / 1000} s`);
        await keepaDeps.sleep(backoff);
      }
    }
    const now = keepaDeps.now();
    if (!reply) {
      const msg = String(lastErr?.message ?? "unknown error").split("\n")[0].slice(0, 200);
      for (const a of batch) { counts.error++; outcomes[a] = `error: ${msg}`; await recordFetchOutcome(deps.query, a, "error", msg, now).catch(() => {}); }
    } else {
      counts.tokens += Number(reply.tokensConsumed ?? 0);
      counts.batches++;
      if (reply.tokensConsumed && batch.length) perAsin = Math.max(1, reply.tokensConsumed / batch.length);
      const tokensEach = reply.tokensConsumed ? Math.round(reply.tokensConsumed / batch.length) : null;
      const byAsin = new Map<string, KeepaProduct>((reply.products ?? []).map((p) => [String(p.asin).toUpperCase(), p]));
      for (const a of batch) {
        const p = byAsin.get(a);
        if (!p) { counts.not_found++; outcomes[a] = "not_found"; await recordFetchOutcome(deps.query, a, "not_found", null, now).catch(() => {}); continue; }
        try {
          const r = await tx((q) => storeKeepaProduct(q, { ...p, asin: a }, tokensEach, now));
          counts.fetched++;
          if (r.missing.length) outcomes[a] = `series_missing:${r.missing.join(",")}`;
        } catch (err: any) {
          const msg = String(err?.message ?? err).split("\n")[0].slice(0, 200);
          counts.error++; outcomes[a] = `error: ${msg}`;
          await recordFetchOutcome(deps.query, a, "error", msg, now).catch(() => {});
        }
      }
    }
    if (deps.onBatch) await deps.onBatch(Math.min(start + KEEPA_BATCH, asins.length), asins.length, batch[batch.length - 1]);
  }
  return { counts, outcomes };
}

/**
 * Queued new-ASIN Keepa jobs, run to completion INLINE by the daily job between its batches (lane K runs one job at
 * a time, so this is how a new-ASIN job goes ahead of a running daily job). Each gets its own ledger row and summary.
 */
export async function runQueuedNewAsinJobs(ctx: Pick<ComponentContext, "query" | "log">, tokens: TokenState, stage: string, tx?: typeof withKeepaTx): Promise<number> {
  const r = await ctx.query(`SELECT id, trigger, queued_at, scope_asins FROM jobs WHERE kind = 'keepa' AND trigger = 'onboarding' AND status = 'queued' ORDER BY queued_at, id`);
  let ran = 0;
  for (const row of r.rows) {
    const id = Number(row.id);
    const u = await ctx.query(`UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1 AND status = 'queued' RETURNING id`, [id]);
    if (u.rows.length === 0) continue; // the lane loop or another instance took it
    const startedAt = keepaDeps.now();
    const scope = (await ctx.query(`SELECT asin FROM asins WHERE asin = ANY($1::text[]) ORDER BY id`, [row.scope_asins ?? []])).rows.map((x: any) => String(x.asin));
    const { due, notDue } = await dueAsins(ctx.query, scope, fetchThreshold({ trigger: "onboarding", queued_at: row.queued_at }, startedAt));
    ctx.log(`new-ASIN Keepa job #${id} runs inline: ${due.length} ASIN(s)${notDue.length ? `, ${notDue.length} already fetched` : ""}`);
    const result = await fetchKeepaForAsins(due, {
      query: ctx.query, log: (m) => ctx.log(`#${id}: ${m}`), tokens, tx,
      onBatch: (done, total) => writeProgress(id, { done: [], component: 33, position: done, total, unit: "ASINs" }, ctx.query),
    });
    result.counts.not_due = notDue.length;
    const summary: JobSummary = { asins: scope.length, durationMs: keepaDeps.now().getTime() - startedAt.getTime(), components: { [stage]: result.counts }, flips: [] };
    await recordComponentRun({ jobId: id, trigger: "onboarding", stage, scope: "subset", requested: due.length, startedAt, result, error: null }, ctx.query);
    await finishJob(id, "done", summary, null, ctx.query);
    ran++;
  }
  return ran;
}

/** Component 33's body. */
export async function runKeepaJob(ctx: ComponentContext, stage: string): Promise<ComponentResult> {
  if (keepaMode() === "off") { ctx.log("KEEPA_API_KEY not set — skipped"); return { counts: { skipped_no_key: 1 }, outcomes: {} }; }
  const now = keepaDeps.now();
  const threshold = fetchThreshold(ctx.job, now);
  const scope = ctx.scopeAsins;
  const { due, notDue } = await dueAsins(ctx.query, scope, threshold);
  const daily = ctx.job.trigger === "scheduled";
  ctx.log(`${daily ? "daily" : "new-ASIN"} Keepa job: ${due.length} ASIN(s) to fetch, ${notDue.length} not due (fetched since ${threshold.toISOString()})`);
  const tokens = freshTokenState();
  let inlineJobs = 0;
  const result = await fetchKeepaForAsins(due, {
    query: ctx.query, log: ctx.log, tokens,
    beforeBatch: daily ? async () => { inlineJobs += await runQueuedNewAsinJobs(ctx, tokens, stage); } : undefined,
    onBatch: async (done, total, lastAsin) => { await ctx.checkpoint(lastAsin); await ctx.setProgress(done, total, "ASINs"); },
  });
  result.counts.not_due = notDue.length;
  if (inlineJobs) result.counts.new_asin_jobs_inline = inlineJobs;
  if (daily && scope.length) {
    const r = await ctx.query(
      `SELECT count(*)::int AS n FROM unnest($1::text[]) a(asin) LEFT JOIN keepa_fetch f ON f.asin = a.asin
        WHERE f.asin IS NULL OR f.fetched_at < $2 OR f.status <> 'fetched'`,
      [scope, threshold],
    );
    const incomplete = Number(r.rows[0]?.n ?? 0);
    if (incomplete) { result.counts.keepa_incomplete = incomplete; result.outcomes._keepa_incomplete = `${incomplete} in-scope ASIN(s) not fetched today`; }
  }
  ctx.log(`done: fetched=${result.counts.fetched} not_found=${result.counts.not_found} error=${result.counts.error} tokens=${result.counts.tokens}${result.counts.keepa_incomplete ? ` keepa_incomplete=${result.counts.keepa_incomplete}` : ""}`);
  return result;
}
