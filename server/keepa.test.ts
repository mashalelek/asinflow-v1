// Keepa history (docs/claude_spec-patch-keepa-trends.md "Tests", commit 2). Every Keepa answer here is the recorded
// product under __fixtures__/keepa/ (B08G6J2PY5, the spike's test ASIN) or a hand-built one; the suite never calls Keepa.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("./db", () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), poolForLane: () => { throw new Error("no pool in tests"); }, default: {} }));
import {
  KEEPA_SERIES, KEEPA_BATCH, KEEPA_EPOCH_MIN, keepaTimeToMs, keepaProductUrl, fetchKeepaProducts, KeepaError, keepaDeps,
  etDayOf, etDayStartMs, changePointsToDaily, productToSeries, storeKeepaProduct, fetchKeepaForAsins, dueAsins, fetchThreshold,
  waitMsForTokens, freshTokenState, runKeepaJob, runQueuedNewAsinJobs, resolveKeepaScope, keepaTx, type KeepaProduct, type TokenState,
} from "./keepa";
import { runKeepaDailyTick, setScheduleLogger } from "./scheduler/schedule";
import { COMPONENTS } from "./scheduler/components";
import { componentsForJob } from "./scheduler/runner";
import { KEEPA_COMPONENTS, laneOf, LANE_TRIGGERS, LANE_KIND, keepaTriggersAhead, type JobRow, type QueryLike, type ComponentContext } from "./scheduler/types";
import { claimNextJob, enqueueDailyKeepaJob, enqueueNewAsinKeepaJob } from "./scheduler/jobs-repo";

setScheduleLogger(() => {});
const FIX = join(__dirname, "__fixtures__", "keepa");
const fixture = JSON.parse(readFileSync(join(FIX, "B08G6J2PY5.json"), "utf8"));
const product: KeepaProduct = fixture.products[0];
const kt = (iso: string) => Math.round(new Date(iso).getTime() / 60_000) - KEEPA_EPOCH_MIN;
const row = (over: Partial<JobRow>): JobRow => ({
  id: 1, kind: "keepa", trigger: "scheduled", target: "main", bulk_list_id: null, include_daily: false, scope_asins: null,
  components: null, params: null, status: "running", progress: { done: [] }, summary: null, requested_by: null,
  queued_at: new Date("2026-11-18T15:00:00Z"), started_at: null, finished_at: null, error: null, ...over,
});

beforeEach(() => { keepaDeps.sleep = async () => {}; keepaDeps.now = () => new Date("2026-11-18T21:00:00Z"); });

describe("Keepa time and ET days", () => {
  it("keepaTimeToMs: minutes since 21564000 min after the epoch (the spike's lastUpdate)", () => {
    expect(new Date(keepaTimeToMs(8353175)).toISOString()).toBe("2026-11-18T19:35:00.000Z");
    expect(keepaTimeToMs(0)).toBe(21_564_000 * 60_000);
  });
  it("etDayOf / etDayStartMs across both DST edges", () => {
    expect(etDayOf(Date.parse("2026-07-01T03:59:00Z"))).toBe("2026-06-30"); // 23:59 EDT
    expect(etDayOf(Date.parse("2026-07-01T04:00:00Z"))).toBe("2026-07-01"); // 00:00 EDT
    expect(etDayOf(Date.parse("2026-01-15T04:59:00Z"))).toBe("2026-01-14"); // 23:59 EST
    expect(etDayOf(Date.parse("2026-01-15T05:00:00Z"))).toBe("2026-01-15");
    expect(new Date(etDayStartMs("2026-07-01")).toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(new Date(etDayStartMs("2026-01-15")).toISOString()).toBe("2026-01-15T05:00:00.000Z");
    expect(new Date(etDayStartMs("2026-03-08")).toISOString()).toBe("2026-03-08T05:00:00.000Z"); // spring-forward day starts in EST
    expect(new Date(etDayStartMs("2026-03-09")).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(new Date(etDayStartMs("2026-11-01")).toISOString()).toBe("2026-11-01T04:00:00.000Z"); // fall-back day starts in EDT
    expect(new Date(etDayStartMs("2026-11-02")).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("change points → daily values", () => {
  it("a value holds until the next change point; the day's value is the one in effect at its end; -1 → NULL; ends at endDay", () => {
    const pts = [kt("2026-03-01T15:00:00Z"), 1000, kt("2026-03-04T02:00:00Z"), 1200, kt("2026-03-06T12:00:00Z"), -1, kt("2026-03-08T12:00:00Z"), 900];
    const d = changePointsToDaily(pts, 2, "2026-03-10")!;
    expect(d.first_day).toBe("2026-03-01");
    //          Mar 1  2     3     4     5     6     7     8    9    10
    expect(d.vals).toEqual([1000, 1000, 1200, 1200, 1200, null, null, 900, 900, 900]); // Mar 4 02:00Z = Mar 3 21:00 ET → Mar 3 ends at 1200
  });
  it("a change at 23:59 ET lands on that day; one at 00:00 ET on the next (ET boundary, not UTC)", () => {
    const pts = [kt("2026-07-02T03:59:00Z"), 5, kt("2026-07-03T04:00:00Z"), 6];
    const d = changePointsToDaily(pts, 2, "2026-07-03")!;
    expect(d.first_day).toBe("2026-07-01");
    expect(d.vals).toEqual([5, 5, 6]);
  });
  it("BUY_BOX_SHIPPING triples: price + shipping; shipping -1 counts as 0; price -1 → NULL", () => {
    const pts = [kt("2026-05-01T12:00:00Z"), 2500, 499, kt("2026-05-02T12:00:00Z"), 2530, -1, kt("2026-05-03T12:00:00Z"), -1, -1];
    expect(changePointsToDaily(pts, 3, "2026-05-03")!.vals).toEqual([2999, 2530, null]);
  });
  it("empty / null → null; a first point after endDay → null", () => {
    expect(changePointsToDaily(null, 2, "2026-01-01")).toBeNull();
    expect(changePointsToDaily([], 2, "2026-01-01")).toBeNull();
    expect(changePointsToDaily([kt("2026-02-01T12:00:00Z"), 1], 2, "2026-01-01")).toBeNull();
  });
});

describe("the recorded product B08G6J2PY5 (spike S1 / S4)", () => {
  const series = productToSeries(product);
  const last = (s: (typeof KEEPA_SERIES)[number]) => series.get(s)!.vals.at(-1);
  const on = (s: (typeof KEEPA_SERIES)[number], day: string) => { const d = series.get(s)!; const i = Math.round((Date.parse(day) - Date.parse(d.first_day)) / 86_400_000); return d.vals[i]; };
  it("every series is present and ends on lastUpdate's ET day with Keepa's current values", () => {
    expect(Array.from(series.keys()).sort()).toEqual([...KEEPA_SERIES].sort());
    const endLen = (s: (typeof KEEPA_SERIES)[number]) => { const d = series.get(s)!; return new Date(Date.parse(d.first_day) + (d.vals.length - 1) * 86_400_000).toISOString().slice(0, 10); };
    for (const s of KEEPA_SERIES) expect(endLen(s)).toBe("2026-11-18");
    expect(last("buy_box")).toBe(2530);
    expect(last("new_price")).toBe(2525);
    expect(last("sales_rank")).toBe(175887);
    expect(last("offers_new")).toBe(7);
    expect(last("offers_new_fba")).toBe(3);
    expect(last("rating_count")).toBe(222);
    expect(last("monthly_sold")).toBeNull();
    expect(series.get("new_price")!.first_day).toBe("2020-09-07");
  });
  it("Monthly Sold matches Keepa's chart: 50 Oct 25 → Dec 6, gap, 50 Dec 12 → Jan 16, nothing since (S4)", () => {
    expect(on("monthly_sold", "2025-11-15")).toBe(50);
    expect(on("monthly_sold", "2025-12-08")).toBeNull();
    expect(on("monthly_sold", "2025-12-20")).toBe(50);
    expect(on("monthly_sold", "2026-01-14")).toBe(50);
    expect(on("monthly_sold", "2026-01-15")).toBeNull(); // the -1 point is 2026-01-16T03:22Z = Jan 15, 22:22 ET: the day ends with no value
    expect(on("monthly_sold", "2026-01-20")).toBeNull();
    expect(on("monthly_sold", "2026-06-01")).toBeNull();
  });
  it("New, FBA (csv[34]) starts in February 2026 — NULL before, a count after", () => {
    const d = series.get("offers_new_fba")!;
    expect(d.first_day).toBe("2026-02-10");
    expect(d.vals.every((v) => v == null || v >= 0)).toBe(true);
    expect(on("offers_new_fba", "2026-10-01")).toBeGreaterThanOrEqual(0);
  });
  it("the fixture holds only public catalog data and no key", () => {
    const raw = readFileSync(join(FIX, "B08G6J2PY5.json"), "utf8");
    expect(raw).not.toMatch(/key=/i);
    expect(statSync(join(FIX, "B08G6J2PY5.json")).size).toBeLessThan(2_000_000);
  });
});

describe("the request", () => {
  it("URL: key, domain 1, the ASIN list, buybox=1, rating=1 — never offers; 1–20 ASINs", () => {
    const u = new URL(keepaProductUrl(["B08G6J2PY5", "B000000001"], "K"));
    expect(u.origin + u.pathname).toBe("https://api.keepa.com/product");
    expect(u.searchParams.get("key")).toBe("K");
    expect(u.searchParams.get("domain")).toBe("1");
    expect(u.searchParams.get("asin")).toBe("B08G6J2PY5,B000000001");
    expect(u.searchParams.get("buybox")).toBe("1");
    expect(u.searchParams.get("rating")).toBe("1");
    expect(u.searchParams.has("offers")).toBe(false);
    expect(u.searchParams.has("update")).toBe(false);
    expect(() => keepaProductUrl([], "K")).toThrow();
    expect(() => keepaProductUrl(Array.from({ length: KEEPA_BATCH + 1 }, (_, i) => `B0${String(i).padStart(8, "0")}`), "K")).toThrow();
  });
  it("the source names `offers` only to forbid it; the key is in no client file", () => {
    const src = readFileSync(join(__dirname, "keepa.ts"), "utf8");
    expect(src.match(/[?&]offers=/g)).toBeNull();
    const walk = (dir: string, out: string[] = []): string[] => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p); } return out; };
    for (const f of walk(join(__dirname, "..", "client", "src"))) expect(readFileSync(f, "utf8"), f).not.toMatch(/KEEPA_API_KEY|api\.keepa\.com/);
    for (const f of walk(join(__dirname, "..", "shared"))) expect(readFileSync(f, "utf8"), f).not.toMatch(/KEEPA_API_KEY/);
    // only this module calls api.keepa.com
    const callers = walk(join(__dirname)).filter((f) => !f.endsWith(".test.ts") && readFileSync(f, "utf8").includes("api.keepa.com"));
    expect(callers.map((f) => f.split("/").pop())).toEqual(["keepa.ts"]);
  });
  it("no key → KeepaError; 429 → KeepaError with Keepa's refill numbers; 5xx → KeepaError", async () => {
    await expect(fetchKeepaProducts(["B08G6J2PY5"], null)).rejects.toBeInstanceOf(KeepaError);
    keepaDeps.fetch = async () => new Response(JSON.stringify({ tokensLeft: -3, refillIn: 42_000, refillRate: 20, error: { type: "NOT_ENOUGH_TOKEN", message: "no tokens" } }), { status: 429 });
    const e = await fetchKeepaProducts(["B08G6J2PY5"], "K").catch((x) => x) as KeepaError;
    expect(e.status).toBe(429);
    expect(e.refill).toEqual({ tokensLeft: -3, refillIn: 42_000, refillRate: 20 });
    keepaDeps.fetch = async () => new Response("bad gateway", { status: 502 });
    await expect(fetchKeepaProducts(["B08G6J2PY5"], "K")).rejects.toMatchObject({ status: 502 });
  });
});

describe("token pacing follows Keepa's refill values", () => {
  it("no wait while the bucket covers the batch or is unknown; otherwise refillIn plus one minute per further refillRate", () => {
    expect(waitMsForTokens(80, freshTokenState())).toBe(0);
    expect(waitMsForTokens(80, { tokensLeft: 80, refillIn: 5_000, refillRate: 21 })).toBe(0);
    expect(waitMsForTokens(80, { tokensLeft: 10, refillIn: 5_000, refillRate: 21 })).toBe(5_000 + 3 * 60_000 + 500); // 70 short = 4 refills
    expect(waitMsForTokens(80, { tokensLeft: 70, refillIn: 9_000, refillRate: 21 })).toBe(9_500); // one refill
  });
});

// ── a fake store + fake Keepa for the fetch loop ─────────────────────────────
function fakeStore() {
  const fetchRows = new Map<string, { fetched_at: Date; status: string; error: string | null }>();
  const seriesRows = new Map<string, Map<string, { first_day: string; vals: Array<number | null> }>>();
  const log: string[] = [];
  const q: QueryLike = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    log.push(s.slice(0, 40));
    if (s.startsWith("SELECT asin, fetched_at FROM keepa_fetch")) return { rows: (params[0] as string[]).filter((a) => fetchRows.has(a)).map((a) => ({ asin: a, fetched_at: fetchRows.get(a)!.fetched_at })), rowCount: 0 };
    if (s.startsWith("SELECT series FROM keepa_series")) return { rows: Array.from(seriesRows.get(params[0])?.keys() ?? []).map((series) => ({ series })), rowCount: 0 };
    if (s.startsWith("INSERT INTO keepa_series")) { const m = seriesRows.get(params[0]) ?? new Map(); m.set(params[1], { first_day: params[2], vals: params[3] }); seriesRows.set(params[0], m); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("INSERT INTO keepa_fetch (asin, fetched_at, keepa_last_update")) { fetchRows.set(params[0], { fetched_at: params[1], status: "fetched", error: null }); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("INSERT INTO keepa_fetch (asin, fetched_at, status, error)")) { fetchRows.set(params[0], { fetched_at: params[1], status: params[2], error: params[3] }); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("SELECT count(*)::int AS n FROM unnest")) { const scope = params[0] as string[]; const t = (params[1] as Date).getTime(); return { rows: [{ n: scope.filter((a) => { const f = fetchRows.get(a); return !f || f.fetched_at.getTime() < t || f.status !== "fetched"; }).length }], rowCount: 1 };
    }
    if (s.startsWith("SELECT id, trigger, queued_at, scope_asins FROM jobs WHERE kind = 'keepa'")) return { rows: [], rowCount: 0 };
    throw new Error(`unhandled SQL in keepa store: ${s.slice(0, 80)}`);
  };
  // a transaction that rolls back on a throw: writes go to a copy, merged on commit
  const tx = async <T>(fn: (q: QueryLike) => Promise<T>): Promise<T> => {
    const snapF = new Map(fetchRows), snapS = new Map(Array.from(seriesRows, ([k, v]) => [k, new Map(v)]));
    try { return await fn(q); }
    catch (err) { fetchRows.clear(); snapF.forEach((v, k) => fetchRows.set(k, v)); seriesRows.clear(); snapS.forEach((v, k) => seriesRows.set(k, v)); throw err; }
  };
  return { q, tx, fetchRows, seriesRows, log };
}
const reply = (products: KeepaProduct[], over: Partial<{ tokensLeft: number; refillIn: number; refillRate: number; tokensConsumed: number }> = {}) =>
  new Response(JSON.stringify({ tokensLeft: 1000, refillIn: 30_000, refillRate: 21, tokensConsumed: products.length * 4, products, ...over }), { status: 200 });

describe("the fetch loop", () => {
  it("stores every product in the batch, counts tokens, lists not_found; the batch's ASINs come back in one call", async () => {
    const st = fakeStore();
    const urls: string[] = [];
    keepaDeps.fetch = async (url) => { urls.push(url); return reply([product]); };
    const r = await fetchKeepaForAsins(["B08G6J2PY5", "B0NOTFOUND"], { query: st.q, log: () => {}, tx: st.tx, tokens: freshTokenState(), key: "K" });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get("asin")).toBe("B08G6J2PY5,B0NOTFOUND");
    expect(r.counts).toMatchObject({ fetched: 1, not_found: 1, error: 0, tokens: 4, batches: 1 });
    expect(r.outcomes).toEqual({ B0NOTFOUND: "not_found" });
    expect(st.fetchRows.get("B08G6J2PY5")!.status).toBe("fetched");
    expect(st.fetchRows.get("B0NOTFOUND")!.status).toBe("not_found");
    expect(Array.from(st.seriesRows.get("B08G6J2PY5")!.keys()).sort()).toEqual([...KEEPA_SERIES].sort());
  });

  it("HTTP 429 → wait refillIn, retry the same batch (not counted as a retry); then the reply paces the next batch", async () => {
    const st = fakeStore();
    const sleeps: number[] = [];
    keepaDeps.sleep = async (ms) => { sleeps.push(ms); };
    let calls = 0;
    keepaDeps.fetch = async (url) => {
      const asins = new URL(url).searchParams.get("asin")!.split(",");
      return ++calls === 1
        ? new Response(JSON.stringify({ tokensLeft: 2, refillIn: 12_000, refillRate: 21, error: { type: "NOT_ENOUGH_TOKEN" } }), { status: 429 })
        : reply(asins.map((a) => ({ ...product, asin: a })), { tokensLeft: 3, refillIn: 20_000, tokensConsumed: asins.length * 4 });
    };
    const tokens: TokenState = freshTokenState();
    const asins = ["B08G6J2PY5", ...Array.from({ length: 20 }, (_, i) => `B0${String(i).padStart(8, "0")}`)]; // two batches: 20 + 1
    const r = await fetchKeepaForAsins(asins, { query: st.q, log: () => {}, tx: st.tx, tokens, key: "K" });
    expect(calls).toBe(3);
    expect(sleeps[0]).toBe(12_000 + 3 * 60_000 + 500); // the 429's refillIn plus the three further refills the 80-token batch needs
    expect(sleeps[1]).toBe(20_000 + 500);              // batch 2 needs 4 tokens, 3 left → one refill
    expect(r.counts.fetched).toBe(21);
    expect(tokens.refillRate).toBe(21);
  });

  it("another failure → 3 retries with backoff, then every ASIN of the batch is `error:` and the next batch goes on", async () => {
    const st = fakeStore();
    const sleeps: number[] = [];
    keepaDeps.sleep = async (ms) => { sleeps.push(ms); };
    let calls = 0;
    keepaDeps.fetch = async () => (++calls <= 4 ? new Response("boom", { status: 500 }) : reply([{ asin: "B0000000AA", lastUpdate: product.lastUpdate, csv: product.csv }]));
    const asins = [...Array.from({ length: 20 }, (_, i) => `B0${String(i).padStart(8, "0")}`), "B0000000AA"];
    const r = await fetchKeepaForAsins(asins, { query: st.q, log: () => {}, tx: st.tx, tokens: freshTokenState(), key: "K" });
    expect(calls).toBe(5);
    expect(sleeps).toEqual([2_000, 4_000, 8_000]);
    expect(r.counts.error).toBe(20);
    expect(r.counts.fetched).toBe(1);
    expect(r.outcomes.B000000000).toMatch(/^error: Keepa HTTP 500/);
    expect(st.fetchRows.get("B000000000")!.status).toBe("error");
  });

  it("a successful response lacking a series AF holds keeps the stored series and notes series_missing", async () => {
    const st = fakeStore();
    keepaDeps.fetch = async () => reply([product]);
    await fetchKeepaForAsins(["B08G6J2PY5"], { query: st.q, log: () => {}, tx: st.tx, tokens: freshTokenState(), key: "K" });
    const before = st.seriesRows.get("B08G6J2PY5")!.get("monthly_sold");
    keepaDeps.fetch = async () => reply([{ ...product, monthlySoldHistory: null }]);
    const r = await fetchKeepaForAsins(["B08G6J2PY5"], { query: st.q, log: () => {}, tx: st.tx, tokens: freshTokenState(), key: "K" });
    expect(r.outcomes.B08G6J2PY5).toBe("series_missing:monthly_sold");
    expect(st.seriesRows.get("B08G6J2PY5")!.get("monthly_sold")).toEqual(before);
    expect(r.counts.fetched).toBe(1);
  });

  it("a partial response (a product that fails to store) writes nothing for that ASIN — the transaction rolls back", async () => {
    const st = fakeStore();
    keepaDeps.fetch = async () => reply([product]);
    await fetchKeepaForAsins(["B08G6J2PY5"], { query: st.q, log: () => {}, tx: st.tx, tokens: freshTokenState(), key: "K" });
    const snapshot = JSON.stringify(Array.from(st.seriesRows.get("B08G6J2PY5")!.entries()));
    const fetchedAt = st.fetchRows.get("B08G6J2PY5")!.fetched_at;
    keepaDeps.now = () => new Date("2026-11-19T01:00:00Z");
    keepaDeps.fetch = async () => reply([{ ...product, lastUpdate: 1e15 }]); // an impossible lastUpdate → the conversion throws inside the transaction
    const r = await fetchKeepaForAsins(["B08G6J2PY5"], { query: st.q, log: () => {}, tx: st.tx, tokens: freshTokenState(), key: "K" });
    expect(r.counts.error).toBe(1);
    expect(JSON.stringify(Array.from(st.seriesRows.get("B08G6J2PY5")!.entries()))).toBe(snapshot);
    expect(st.fetchRows.get("B08G6J2PY5")!.status).toBe("error"); // the fetch record says so, outside the transaction
    expect(st.fetchRows.get("B08G6J2PY5")!.fetched_at).not.toEqual(fetchedAt);
  });
});

describe("the job: order, not_due, restart, inline new-ASIN jobs, keepa_incomplete", () => {
  it("dueAsins: never fetched first, then oldest; fetched since the threshold = not due", async () => {
    const st = fakeStore();
    st.fetchRows.set("B000000002", { fetched_at: new Date("2026-11-17T10:00:00Z"), status: "fetched", error: null });
    st.fetchRows.set("B000000003", { fetched_at: new Date("2026-11-16T10:00:00Z"), status: "fetched", error: null });
    st.fetchRows.set("B000000004", { fetched_at: new Date("2026-11-18T10:00:00Z"), status: "fetched", error: null });
    const r = await dueAsins(st.q, ["B000000001", "B000000002", "B000000003", "B000000004"], new Date("2026-11-18T05:00:00Z"));
    expect(r.due).toEqual(["B000000001", "B000000003", "B000000002"]);
    expect(r.notDue).toEqual(["B000000004"]);
  });
  it("threshold: the daily job and a Bulk Calc job = 00:00 ET today; a new-ASIN job = its queued_at — so a restart refetches nothing already fetched", () => {
    const now = new Date("2026-11-18T21:00:00Z");
    expect(fetchThreshold(row({ trigger: "scheduled" }), now).toISOString()).toBe("2026-11-18T05:00:00.000Z");
    expect(fetchThreshold(row({ trigger: "bulk", queued_at: new Date("2026-11-18T15:00:00Z") }), now).toISOString()).toBe("2026-11-18T05:00:00.000Z");
    expect(fetchThreshold(row({ trigger: "onboarding", queued_at: new Date("2026-11-18T15:00:00Z") }), now).toISOString()).toBe("2026-11-18T15:00:00.000Z");
  });

  it("Bulk Calc job scope (SPEC §21): the enqueue call's ASIN list verbatim — no bulk table, no catalog table is read", async () => {
    const seen: string[] = [];
    const q: QueryLike = async (text) => { seen.push(text); return { rows: [], rowCount: 0 }; };
    expect(await resolveKeepaScope(q, { trigger: "bulk", scope_asins: ["b0bulkonly1", "B0BULKONLY1", " B0INCATALOG "] })).toEqual(["B0BULKONLY1", "B0INCATALOG"]);
    expect(seen).toEqual([]);
    expect(keepaTriggersAhead("onboarding")).toEqual([]);
    expect(keepaTriggersAhead("scheduled")).toEqual(["onboarding"]);
    expect(keepaTriggersAhead("bulk")).toEqual(["onboarding", "scheduled"]);
    // the module names no bulk table and no catalog write
    const src = readFileSync(join(__dirname, "keepa.ts"), "utf8");
    expect(src).not.toMatch(/bulk_list/);
    expect(src).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM) (asins|asin_estimates|bulk_)/);
  });

  function ctxFor(job: JobRow, scope: string[], q: QueryLike): ComponentContext & { checkpoints: string[]; progress: any[] } {
    const checkpoints: string[] = [], progress: any[] = [];
    return {
      job, query: q, log: () => {}, sellerId: "S", asins: scope, scopeAsins: scope, cache: new Map(),
      checkpoint: async (a) => { checkpoints.push(a!); }, setProgress: async (p, t, u) => { progress.push([p, t, u]); }, checkpoints, progress,
    };
  }

  it("the daily job: fetches the due ASINs, checkpoints per batch with ASIN progress, records keepa_incomplete for what is still unfetched", async () => {
    process.env.KEEPA_API_KEY = "K";
    const st = fakeStore();
    keepaTx.run = st.tx;
    st.fetchRows.set("B000000009", { fetched_at: new Date("2026-11-18T12:00:00Z"), status: "fetched", error: null }); // already today
    keepaDeps.fetch = async (url) => { const asins = new URL(url).searchParams.get("asin")!.split(","); return reply(asins.filter((a) => a !== "B0NOTFOUND").map((a) => ({ ...product, asin: a }))); };
    const ctx = ctxFor(row({ trigger: "scheduled" }), ["B08G6J2PY5", "B000000009", "B0NOTFOUND"], st.q);
    const r = await runKeepaJob(ctx, "33_keepa");
    expect(r.counts).toMatchObject({ fetched: 1, not_found: 1, not_due: 1, keepa_incomplete: 1 });
    expect(r.outcomes._keepa_incomplete).toMatch(/1 in-scope ASIN/);
    expect(ctx.checkpoints).toEqual(["B0NOTFOUND"]);
    expect(ctx.progress).toEqual([[2, 2, "ASINs"]]);
    delete process.env.KEEPA_API_KEY;
  });

  it("without a key the component skips with a note and writes nothing", async () => {
    delete process.env.KEEPA_API_KEY;
    const st = fakeStore();
    const r = await runKeepaJob(ctxFor(row({}), ["B08G6J2PY5"], st.q), "33_keepa");
    expect(r.counts).toEqual({ skipped_no_key: 1 });
    expect(st.log).toEqual([]);
  });

  it("a queued new-ASIN job is run inline by the daily job between batches: it goes ahead, gets its own ledger row and summary", async () => {
    process.env.KEEPA_API_KEY = "K";
    const st = fakeStore();
    keepaTx.run = st.tx;
    const jobs: any[] = [{ id: 50, trigger: "onboarding", queued_at: new Date("2026-11-18T20:00:00Z"), scope_asins: ["B0NEWASIN1"], status: "queued" }];
    const ledger: any[] = [], finished: any[] = [];
    const q: QueryLike = async (sql, params = []) => {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("SELECT id, trigger, queued_at, scope_asins FROM jobs WHERE kind = 'keepa'")) return { rows: jobs.filter((j) => j.status === "queued"), rowCount: 0 };
      if (s.startsWith("UPDATE jobs SET status = 'running'")) { const j = jobs.find((x) => x.id === params[0] && x.status === "queued"); if (!j) return { rows: [], rowCount: 0 }; j.status = "running"; return { rows: [{ id: j.id }], rowCount: 1 }; }
      if (s.startsWith("SELECT asin FROM asins WHERE asin = ANY")) return { rows: (params[0] as string[]).map((asin) => ({ asin })), rowCount: 0 };
      if (s.startsWith("UPDATE jobs SET progress")) return { rows: [], rowCount: 1 };
      if (s.startsWith("INSERT INTO refresh_runs")) { ledger.push({ stage: params[2], scope: params[3], requested: params[4], job_id: params[8] }); return { rows: [], rowCount: 1 }; }
      if (s.startsWith("UPDATE jobs SET status = $2, summary")) { finished.push({ id: params[0], status: params[1], summary: JSON.parse(params[2]) }); jobs.find((x) => x.id === params[0]).status = params[1]; return { rows: [], rowCount: 1 }; }
      return st.q(sql, params);
    };
    const order: string[] = [];
    keepaDeps.fetch = async (url) => { const asins = new URL(url).searchParams.get("asin")!.split(","); order.push(asins.join(",")); return reply(asins.map((a) => ({ ...product, asin: a }))); };
    const tokens = freshTokenState();
    const ran = await runQueuedNewAsinJobs({ query: q, log: () => {} }, tokens, "33_keepa", st.tx);
    expect(ran).toBe(1);
    expect(order).toEqual(["B0NEWASIN1"]);
    expect(ledger).toEqual([{ stage: "33_keepa", scope: "subset", requested: 1, job_id: 50 }]);
    expect(finished).toEqual([{ id: 50, status: "done", summary: expect.objectContaining({ asins: 1, components: { "33_keepa": expect.objectContaining({ fetched: 1, not_due: 0 }) } }) }]);
    // the daily job's loop calls it before every batch
    const ctx = ctxFor(row({ trigger: "scheduled" }), ["B08G6J2PY5"], q);
    jobs.push({ id: 51, trigger: "onboarding", queued_at: new Date("2026-11-18T20:30:00Z"), scope_asins: ["B0NEWASIN2"], status: "queued" });
    const r = await runKeepaJob(ctx, "33_keepa");
    expect(order.slice(1)).toEqual(["B0NEWASIN2", "B08G6J2PY5"]); // the new-ASIN job first, then the daily batch
    expect(r.counts.jobs_ahead_inline).toBe(1);
    delete process.env.KEEPA_API_KEY;
  });

  it("a Bulk Calc job: skips the list's ASINs fetched since 00:00 ET, yields to a queued daily job and a queued new-ASIN job (new-ASIN first), and touches only keepa_series / keepa_fetch / jobs / refresh_runs", async () => {
    process.env.KEEPA_API_KEY = "K";
    const st = fakeStore();
    keepaTx.run = st.tx;
    st.fetchRows.set("B0INCATALOG", { fetched_at: new Date("2026-11-18T06:00:00Z"), status: "fetched", error: null }); // the daily job had it today
    const jobs: any[] = [
      { id: 60, trigger: "scheduled", queued_at: new Date("2026-11-18T05:00:00Z"), scope_asins: null, status: "queued" },
      { id: 61, trigger: "onboarding", queued_at: new Date("2026-11-18T20:10:00Z"), scope_asins: ["B0NEWASIN1"], status: "queued" },
    ];
    const tables: string[] = [];
    const finished: any[] = [];
    const q: QueryLike = async (sql, params = []) => {
      const s = sql.replace(/\s+/g, " ").trim();
      Array.from(s.matchAll(/(?:FROM|INTO|UPDATE|JOIN) ([a-z_]+)/g)).forEach((m) => tables.push(m[1]));
      if (s.startsWith("SELECT id, trigger, queued_at, scope_asins FROM jobs WHERE kind = 'keepa'")) return { rows: jobs.filter((j) => j.status === "queued" && (params[0] as string[]).includes(j.trigger)).sort((a, b) => (a.trigger === "onboarding" ? 0 : 1) - (b.trigger === "onboarding" ? 0 : 1)), rowCount: 0 };
      if (s.startsWith("UPDATE jobs SET status = 'running'")) { const j = jobs.find((x) => x.id === params[0] && x.status === "queued"); if (!j) return { rows: [], rowCount: 0 }; j.status = "running"; return { rows: [{ id: j.id }], rowCount: 1 }; }
      if (s.startsWith("SELECT asin FROM asins WHERE status IN")) return { rows: [{ asin: "B0INCATALOG" }], rowCount: 0 };
      if (s.startsWith("SELECT asin FROM asins WHERE asin = ANY")) return { rows: (params[0] as string[]).map((asin) => ({ asin })), rowCount: 0 };
      if (s.startsWith("UPDATE jobs SET progress")) return { rows: [], rowCount: 1 };
      if (s.startsWith("INSERT INTO refresh_runs")) return { rows: [], rowCount: 1 };
      if (s.startsWith("UPDATE jobs SET status = $2, summary")) { finished.push({ id: params[0], status: params[1] }); jobs.find((x) => x.id === params[0]).status = params[1]; return { rows: [], rowCount: 1 }; }
      return st.q(sql, params);
    };
    const order: string[] = [];
    keepaDeps.fetch = async (url) => { const asins = new URL(url).searchParams.get("asin")!.split(","); order.push(asins.join(",")); return reply(asins.map((a) => ({ ...product, asin: a }))); };
    const ctx = ctxFor(row({ trigger: "bulk", queued_at: new Date("2026-11-18T20:00:00Z"), scope_asins: ["B0BULKONLY1", "B0INCATALOG"] }), ["B0BULKONLY1", "B0INCATALOG"], q);
    const r = await runKeepaJob(ctx, "33_keepa");
    expect(order).toEqual(["B0NEWASIN1", "B0BULKONLY1"]); // the new-ASIN job, then the daily job (its one ASIN already fetched today → nothing), then the list
    expect(r.counts).toMatchObject({ fetched: 1, not_due: 1, jobs_ahead_inline: 2 });
    expect(r.counts.keepa_incomplete).toBeUndefined(); // only the daily job records it
    expect(finished.map((f) => [f.id, f.status])).toEqual([[61, "done"], [60, "done"]]);
    // the ASIN writes (keepa_series + keepa_fetch) go through the per-ASIN transaction (st.tx); the pool saw: `asins`
    // = the inline DAILY job's scope read, jobs / refresh_runs = the ledger, keepa_fetch = due / not-due; nothing bulk_*
    expect(Array.from(new Set(tables)).filter((t) => t !== "unnest").sort()).toEqual(["asins", "jobs", "keepa_fetch", "refresh_runs"]);
    expect(Array.from(st.seriesRows.keys()).sort()).toEqual(["B0BULKONLY1", "B0NEWASIN1"]);
    delete process.env.KEEPA_API_KEY;
  });
});

describe("lane K and the job plumbing", () => {
  it("laneOf: kind keepa → K whatever the trigger; LANE_TRIGGERS / LANE_KIND", () => {
    expect(laneOf({ kind: "keepa", trigger: "scheduled" })).toBe("K");
    expect(laneOf({ kind: "keepa", trigger: "onboarding" })).toBe("K");
    expect(laneOf({ kind: "refresh", trigger: "scheduled" })).toBe("S");
    expect(laneOf({ kind: "refresh", trigger: "onboarding" })).toBe("M");
    expect(LANE_TRIGGERS.K).toEqual(["scheduled", "onboarding", "bulk"]); // + Bulk Calc jobs (Maria 2026-11-18)
    expect(laneOf({ kind: "keepa", trigger: "bulk" })).toBe("K");
    expect(LANE_KIND).toEqual({ S: "refresh", M: "refresh", K: "keepa" });
  });
  it("claimNextJob('K') claims kind keepa only, a queued new-ASIN job ahead of a queued daily job; lanes S / M claim kind refresh", async () => {
    const sql: { text: string; params?: any[] }[] = [];
    const q: QueryLike = async (text, params) => { sql.push({ text, params }); return { rows: [], rowCount: 0 }; };
    await claimNextJob(q, "K");
    const claim = sql.find((s) => s.text.includes("FROM jobs"))!;
    expect(claim.text).toMatch(/AND kind = \$2/);
    expect(claim.text).toMatch(/\(kind = 'keepa' AND trigger = 'onboarding'\) DESC, \(kind = 'keepa' AND trigger = 'scheduled'\) DESC, queued_at ASC/); // new-ASIN, daily, bulk
    expect(claim.params).toEqual([["scheduled", "onboarding", "bulk"], "keepa"]);
    sql.length = 0;
    await claimNextJob(q, "S");
    expect(sql.find((s) => s.text.includes("FROM jobs"))!.params).toEqual([["scheduled"], "refresh"]);
  });
  it("component 33 exists (daily tier, batch kind) and appears in NO refresh job's plan — scheduled, manual, onboarding, bulk, explicit list; a Keepa job runs it alone", () => {
    const c = COMPONENTS.find((x) => x.n === 33)!;
    expect([c.key, c.tier, c.kind]).toEqual(["33_keepa", "daily", "batch"]);
    expect(KEEPA_COMPONENTS).toEqual([33]);
    const refresh = (over: Partial<JobRow>) => componentsForJob(row({ kind: "refresh", ...over })).map((x) => x.n);
    expect(refresh({ trigger: "scheduled", include_daily: true })).not.toContain(33);
    expect(refresh({ trigger: "manual", include_daily: true })).not.toContain(33);
    expect(refresh({ trigger: "onboarding", include_daily: true, scope_asins: ["A"] })).not.toContain(33);
    expect(refresh({ trigger: "bulk", include_daily: true, scope_asins: ["A"] })).not.toContain(33);
    expect(refresh({ trigger: "manual", components: [33, 10] })).toEqual([10]);
    expect(componentsForJob(row({ kind: "keepa", trigger: "scheduled" })).map((x) => x.n)).toEqual([33]);
    expect(componentsForJob(row({ kind: "keepa", trigger: "onboarding", scope_asins: ["A"] })).map((x) => x.n)).toEqual([33]);
  });
  it("enqueueDailyKeepaJob: one scheduled Keepa job at most; enqueueNewAsinKeepaJob: exactly one job, ASINs an active new-ASIN job covers dropped", async () => {
    const inserts: any[][] = [];
    const active: any[] = [];
    const covered: string[] = [];
    const q: QueryLike = async (text, params = []) => {
      if (text.includes("kind = 'keepa' AND trigger = 'scheduled' AND status IN")) return { rows: active, rowCount: active.length };
      if (text.includes("unnest(scope_asins)")) return { rows: covered.map((asin) => ({ asin })), rowCount: 0 };
      if (text.includes("INSERT INTO jobs")) { inserts.push(params); return { rows: [{ id: inserts.length, kind: params[8], trigger: params[0], scope_asins: params[4], status: "queued", progress: {} }], rowCount: 1 }; }
      throw new Error(`unexpected ${text.slice(0, 50)}`);
    };
    const a = await enqueueDailyKeepaJob(q);
    expect(a.existing).toBe(false);
    expect(inserts[0][8]).toBe("keepa"); expect(inserts[0][0]).toBe("scheduled"); expect(inserts[0][4]).toBeNull();
    active.push({ id: 1, kind: "keepa", trigger: "scheduled", status: "queued", progress: {} });
    const b = await enqueueDailyKeepaJob(q);
    expect(b.existing).toBe(true); expect(inserts).toHaveLength(1);
    covered.push("B000000001");
    const n = await enqueueNewAsinKeepaJob(["b000000001", "B000000002", "B000000002"], q);
    expect(n.enqueued).toEqual(["B000000002"]);
    expect(inserts[1][8]).toBe("keepa"); expect(inserts[1][0]).toBe("onboarding"); expect(inserts[1][4]).toEqual(["B000000002"]);
    expect((await enqueueNewAsinKeepaJob(["B000000001"], q)).job).toBeNull();
    expect(inserts).toHaveLength(2);
  });
  it("the 00:00 Keepa tick: enqueues once, skips while one is active, off without a key, and never touches the refresh enqueue", async () => {
    const calls: string[] = [];
    const enqueueKeepa = vi.fn(async () => { calls.push("k"); return { job: row({ id: 3, status: "queued" }), existing: calls.length > 1 }; });
    expect((await runKeepaDailyTick({ keepaEnabled: () => true, enqueueKeepa }))?.id).toBe(3);
    await runKeepaDailyTick({ keepaEnabled: () => true, enqueueKeepa });
    expect(enqueueKeepa).toHaveBeenCalledTimes(2);
    expect(await runKeepaDailyTick({ keepaEnabled: () => false, enqueueKeepa })).toBeNull();
    expect(enqueueKeepa).toHaveBeenCalledTimes(2);
    const sched = readFileSync(join(__dirname, "scheduler", "schedule.ts"), "utf8");
    expect(sched).toMatch(/if \(next\.includeDaily\) \{\s*try \{ await runKeepaDailyTick\(deps\); \}/);
  });
  it("GET /api/jobs/current carries the running Keepa job as `keepa`", () => {
    const s = readFileSync(join(__dirname, "scheduler", "routes.ts"), "utf8");
    expect(s).toMatch(/keepa: active\.find\(\(j\) => j\.status === "running" && j\.kind === "keepa"\)/);
  });
});
