// Components 20 / 21 (Finances API patch commit 6): the windows per pass and the runs on seams — never a live call.
import { describe, it, expect, beforeEach } from "vitest";
import { refunds, refundsDeps, financesWindowFor, FINANCES_HOURLY_DAYS, FINANCES_DAILY_DAYS, FINANCES_WINDOW_KEY } from "./components/20-refunds";
import { actualFees, actualFeesDeps, rebuildPlanFor, REBUILD_HOURLY_DAYS, REBUILD_DAILY_DAYS } from "./components/21-actual-fees";
import { ComponentError, type ComponentContext, type JobRow } from "./types";

const NOW = new Date("2026-11-20T18:00:00Z");
const job = (over: Partial<JobRow> = {}): JobRow => ({ id: 7, kind: "refresh", trigger: "scheduled", target: "main", bulk_list_id: null, include_daily: false, scope_asins: null, components: null, params: null, status: "running", progress: { done: [] }, summary: null, requested_by: null, queued_at: NOW, started_at: NOW, finished_at: null, error: null, ...over });
let storageMonthsHave: string[] = [];
const ctxFor = (j: JobRow) => { const logs: string[] = []; const progress: any[] = []; const cache = new Map<string, unknown>(); const ctx: ComponentContext = { job: j, query: async (sql: string) => (/FROM fba_storage_fees/.test(sql) ? { rows: storageMonthsHave.map((month) => ({ month })), rowCount: storageMonthsHave.length } : { rows: [], rowCount: 0 }), log: (m) => logs.push(m), sellerId: "S", asins: [], scopeAsins: [], checkpoint: async () => {}, setProgress: async (p, t, u) => { progress.push([p, t, u]); }, cache }; return { ctx, logs, progress, cache }; };
beforeEach(() => { refundsDeps.now = () => NOW; actualFeesDeps.now = () => NOW; });

describe("financesWindowFor / rebuildPlanFor", () => {
  it("hourly = trailing 3 days; the 00:00 pass 60 days; a backfill window from params, clamped to Amazon's 730 days", () => {
    const h = financesWindowFor(null, false); expect(h.source).toBe("hourly"); expect((h.to.getTime() - h.from.getTime()) / 86400_000).toBe(FINANCES_HOURLY_DAYS); expect(NOW.getTime() - h.to.getTime()).toBe(5 * 60_000); // postedBefore 5 min behind now
    const d = financesWindowFor(null, true); expect(d.source).toBe("daily"); expect((d.to.getTime() - d.from.getTime()) / 86400_000).toBe(FINANCES_DAILY_DAYS);
    const p = financesWindowFor({ finances_window: { from: "2024-05-01", to: "2024-12-31" } }, false);
    expect(p.source).toBe("params"); expect(p.from.toISOString().slice(0, 10)).toBe("2024-11-21"); // 730 days back from NOW expect(p.to.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(financesWindowFor({ finances_window: { from: "bad" } }, false).source).toBe("hourly");
  });
  it("the rebuild covers 60 days hourly without reports, 120 days with the reports at 00:00, the whole window on a backfill", () => {
    expect(rebuildPlanFor(null, false)).toEqual({ from: "2026-09-21", to: "2026-11-20", reports: false, source: "hourly" });
    expect(rebuildPlanFor(null, true)).toEqual({ from: "2026-07-23", to: "2026-11-20", reports: true, source: "daily" });
    expect(rebuildPlanFor({ finances_window: { from: "2026-08-01", to: "2026-08-31" } }, false)).toEqual({ from: "2026-08-01", to: "2026-11-20", reports: true, source: "params" });
    expect(REBUILD_HOURLY_DAYS).toBe(60); expect(REBUILD_DAILY_DAYS).toBe(120);
  });
});

describe("component 20", () => {
  it("ingests the window week by week, ledgers the counts, leaves the window in the cache; a backfill reports week progress", async () => {
    const calls: any[] = [];
    refundsDeps.ingestRange = async (from, to, opts) => { calls.push([from.toISOString(), to.toISOString()]); const rs = [1, 2].map((i) => ({ window: { from: `2026-08-0${i}T00:00:00Z`, to: "" }, read: 10 * i, stored: 9 * i, released: i, superseded: i, calls: 1, days: { from: null, to: null } })); for (let i = 0; i < rs.length; i++) await opts?.onWindow?.(rs[i], i, rs.length); return rs; };
    const { ctx, progress, cache } = ctxFor(job({ params: { finances_window: { from: "2026-08-01", to: "2026-08-14" } } }));
    const r = await refunds.run(ctx);
    expect(r.counts).toMatchObject({ weeks: 2, transactions_read: 30, transactions_stored: 27, deferred_superseded: 3 });
    expect(progress).toEqual([[1, 2, "week"], [2, 2, "week"]]); expect(cache.get(FINANCES_WINDOW_KEY)).toBeTruthy();
    expect(r.outcomes._window).toBe("2026-08-01..2026-08-15 (params)");
  });
  it("a failed window fails the component with the weeks so far recorded (ComponentError)", async () => {
    refundsDeps.ingestRange = async (_f, _t, opts) => { await opts?.onWindow?.({ window: { from: "2026-11-17T00:00:00Z", to: "" }, read: 5, stored: 5, released: 0, superseded: 0, calls: 1, days: { from: null, to: null } }, 0, 2); throw new Error("HTTP 500"); };
    const { ctx } = ctxFor(job());
    await expect(refunds.run(ctx)).rejects.toBeInstanceOf(ComponentError);
    try { await refunds.run(ctx); } catch (e: any) { expect(e.partial.counts.weeks).toBe(1); expect(e.partial.outcomes._error).toMatch(/^error: HTTP 500/); }
  });
});

describe("component 21", () => {
  it("hourly: rebuild only; 00:00: the three reports (storage for the months whose rows can have posted) then the rebuild; a report failure is an error outcome, the rebuild still runs", async () => {
    const seen: string[] = [];
    actualFeesDeps.ingestReturns = async (f, t) => { seen.push(`returns ${f}..${t}`); return { chunks: 2, rows: 3, failed: [{ from: "2026-11-17", to: "2026-11-20", error: "report ended FATAL" }] }; };
    actualFeesDeps.ingestRemovals = async () => { throw new Error("quota"); };
    actualFeesDeps.ingestStorageMonth = async (m) => { seen.push(`storage ${m}`); return { rows: 2, total: 1.5 }; };
    actualFeesDeps.rebuildFinancesDaily = async (f, t) => { seen.push(`rebuild ${f}..${t}`); return { rows: 42 }; };
    const h = await actualFees.run(ctxFor(job()).ctx);
    expect(seen).toEqual(["rebuild 2026-09-21..2026-11-20"]); expect(h.counts.daily_rows).toBe(42);
    seen.length = 0;
    const d = await actualFees.run(ctxFor(job({ include_daily: true })).ctx);
    expect(seen[0]).toBe("returns 2026-09-21..2026-11-20"); expect(seen).toContain("storage 2026-10"); expect(seen).toContain("storage 2026-09"); expect(seen[seen.length - 1]).toBe("rebuild 2026-07-23..2026-11-20");
    expect(d.counts.storage_months_asked).toBe(3); // the newest two + the one older month the 120-day window wants (2026-08)
    expect(d.outcomes._removals).toMatch(/^error: quota/); expect(d.counts.report_failures).toBe(2); expect(d.counts.returns_rows).toBe(3); expect(d.counts.returns_chunks_failed).toBe(1); expect(d.outcomes["_returns_failed_01 2026-11-17..2026-11-20"]).toBe("error: report ended FATAL");
  });
  it("a backfill asks the newest two storage months plus three missing older ones per pass (the report quota), records a failed month and names the rest", async () => {
    const asked: string[] = [];
    actualFeesDeps.ingestReturns = async () => ({ chunks: 1, rows: 0, failed: [] });
    actualFeesDeps.ingestRemovals = async () => ({ chunks: 1, rows: 0, failed: [] });
    actualFeesDeps.ingestStorageMonth = async (m) => { asked.push(m); if (m === "2024-12") throw new Error("HTTP 429 QuotaExceeded"); return { rows: 1, total: 1 }; };
    actualFeesDeps.rebuildFinancesDaily = async () => ({ rows: 1 });
    storageMonthsHave = ["2024-10"];
    const r = await actualFees.run(ctxFor(job({ params: { finances_window: { from: "2024-11-21", to: "2026-11-20" } } })).ctx);
    expect(asked).toEqual(["2024-11", "2024-12", "2025-01", "2026-09", "2026-10"]); // 2024-10 is already there
    expect(r.counts.storage_months_failed).toBe(1); expect(r.outcomes["_storage_failed_2024-12"]).toMatch(/^error: HTTP 429/);
    expect(r.outcomes._storage_still_missing).toMatch(/^19 month\(s\) wait for later passes: 2025-02, 2025-03/); // 25 wanted − 1 held − 5 asked
    storageMonthsHave = [];
  });
  it("a rebuild failure fails the component (ComponentError) with what ran before it", async () => {
    actualFeesDeps.rebuildFinancesDaily = async () => { throw new Error("57014"); };
    await expect(actualFees.run(ctxFor(job()).ctx)).rejects.toBeInstanceOf(ComponentError);
  });
});
