import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

vi.mock("../index", () => ({ log: () => {} }));
vi.mock("../db", () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), default: {} }));

import { sales, salesDeps, salesWindowFor, salesResultToComponent, SALES_WINDOW_HOURS, ONBOARD_SALES_ASINS } from "./components/19-sales";
import { SalesSyncError, type SalesSyncResult } from "../sales-sync";
import { ComponentError, type ComponentContext, type JobRow, type QueryLike } from "./types";
import { parseBackfillWindow } from "./routes";

// Component 19 (2026-10-16): window from params.sales_window or 48 h; per-chunk
// results in the outcomes; onboarded ASINs get ONE onboarding job; a chunk
// failure is a ComponentError carrying the partial result.

const job = (over: Partial<JobRow> = {}): JobRow => ({
  id: 9, kind: "refresh", trigger: "manual", target: "main", bulk_list_id: null, include_daily: false,
  scope_asins: null, components: [19], params: null, status: "running", progress: { done: [] }, summary: null,
  requested_by: null, queued_at: new Date(), started_at: new Date(), finished_at: null, error: null, ...over,
});

function ctxFor(j: JobRow, inject: Record<string, unknown> = {}) {
  const inserted: any[] = [];
  const logs: string[] = [];
  const progress: any[] = [];
  const query: QueryLike = async (sql, params) => {
    if (sql.includes("unnest(scope_asins)")) return { rows: [], rowCount: 0 }; // no active onboarding job covers anything
    if (sql.includes("INSERT INTO jobs")) { inserted.push(params); return { rows: [{ id: 77, kind: "refresh", trigger: params![0], include_daily: params![3], scope_asins: params![4], components: params![5], params: null, status: "queued", progress: {} }], rowCount: 1 }; }
    throw new Error(`unexpected sql ${sql.slice(0, 50)}`);
  };
  const cache = new Map<string, unknown>(Object.entries(inject));
  const ctx: ComponentContext = { job: j, query, log: (m) => logs.push(m), sellerId: "S", asins: [], scopeAsins: [], checkpoint: async () => {}, setProgress: async (p, t, u) => { progress.push([p, t, u]); }, cache };
  return { ctx, inserted, logs, progress };
}

const okResult = (over: Partial<SalesSyncResult> = {}): SalesSyncResult => ({
  daysProcessed: 3, asinsUpdated: 2, totalOrders: 5, onboarded: [], invalidAsins: [], minDate: "2024-05-02", maxDate: "2024-05-29",
  chunks: [{ start: "2024-05-01", end: "2024-05-30", status: "ok", orders: 5, days: 3, asins: 2, onboarded: [], invalidAsins: [], minDate: "2024-05-02", maxDate: "2024-05-29" }],
  ...over,
});

beforeEach(() => { salesDeps.sync = async () => okResult(); });

describe("salesWindowFor", () => {
  it("uses params.sales_window when valid", () => {
    expect(salesWindowFor({ sales_window: { from: "2024-05-01", to: "2026-10-16" } })).toEqual({ start: "2024-05-01", end: "2026-10-16", source: "params" });
  });
  it("falls back to the trailing 48 hours otherwise", () => {
    const now = new Date(2026, 9, 16, 12, 0, 0);
    expect(salesWindowFor(null, now)).toEqual({ start: "2026-10-14", end: "2026-10-16", source: "default" });
    expect(salesWindowFor({ sales_window: { from: "bad", to: "2026-10-16" } }, now).source).toBe("default");
    expect(salesWindowFor({ sales_window: { from: "2026-10-17", to: "2026-10-16" } }, now).source).toBe("default");
    expect(SALES_WINDOW_HOURS).toBe(48);
  });
});

describe("the sales component", () => {
  it("passes the params window to the sync and ledgers per-chunk results + earliest/latest returned", async () => {
    let got: any;
    salesDeps.sync = async (s, e, scope, opts) => { got = { s, e, scope, hasOnboard: !!opts?.onboard }; return okResult(); };
    const { ctx } = ctxFor(job({ params: { sales_window: { from: "2024-05-01", to: "2024-05-30" } } }), { [ONBOARD_SALES_ASINS]: async () => {} });
    const r = await sales.run(ctx);
    expect(got).toEqual({ s: "2024-05-01", e: "2024-05-30", scope: undefined, hasOnboard: true });
    expect(r.counts).toEqual({ days: 3, asins: 2, orders: 5, chunks: 1, chunks_failed: 0, onboarded_from_sales: 0, invalid_asins_skipped: 0 });
    expect(r.outcomes._window).toBe("2024-05-01..2024-05-30 (params)");
    expect(r.outcomes._earliest_sale_date_returned).toBe("2024-05-02");
    expect(r.outcomes._latest_sale_date_returned).toBe("2024-05-29");
    expect(r.outcomes["_chunk_01 2024-05-01..2024-05-30"]).toBe("ok · orders 5 · days 3 · asins 2 · onboarded 0 · returned 2024-05-02..2024-05-29");
  });

  it("a backfill (window from params) reports progress in chunks: 0/N at start, then i/N after each chunk", async () => {
    salesDeps.sync = async (_s, _e, _scope, opts) => {
      const r = okResult();
      await opts?.onChunk?.(r.chunks[0], 0, 1);
      return r;
    };
    const { ctx, progress } = ctxFor(job({ params: { sales_window: { from: "2024-05-01", to: "2024-05-30" } } }), { [ONBOARD_SALES_ASINS]: async () => {} });
    await sales.run(ctx);
    expect(progress).toEqual([[0, 1, "chunk"], [1, 1, "chunk"]]);
  });

  it("the hourly (default-window) sales run reports no chunk progress", async () => {
    salesDeps.sync = async (_s, _e, _scope, opts) => { const r = okResult(); await opts?.onChunk?.(r.chunks[0], 0, 1); return r; };
    const { ctx, progress } = ctxFor(job(), { [ONBOARD_SALES_ASINS]: async () => {} });
    await sales.run(ctx);
    expect(progress).toEqual([]);
  });

  it("default window carries window_hours=48 in the counts", async () => {
    const { ctx } = ctxFor(job(), { [ONBOARD_SALES_ASINS]: async () => {} });
    const r = await sales.run(ctx);
    expect(r.counts.window_hours).toBe(48);
    expect(r.outcomes._window).toMatch(/\(default\)$/);
  });

  it("enqueues ONE onboarding job for every ASIN the sync onboarded (deduped against active onboarding jobs), and lists them", async () => {
    salesDeps.sync = async () => okResult({ onboarded: ["N1", "N2", "N3"] });
    const { ctx, inserted, logs } = ctxFor(job(), { [ONBOARD_SALES_ASINS]: async () => {} });
    const r = await sales.run(ctx);
    expect(inserted).toHaveLength(1);
    expect(inserted[0][0]).toBe("onboarding"); // trigger
    expect(inserted[0][3]).toBe(true);         // include_daily
    expect(inserted[0][4]).toEqual(["N1", "N2", "N3"]);
    expect(r.counts.onboarded_from_sales).toBe(3);
    expect(r.outcomes._onboarded_from_sales).toBe("N1, N2, N3");
    expect(logs.join("\n")).toMatch(/3 ASIN\(s\) onboarded from sales; onboarding job #77 queued/);
  });

  it("a chunk failure is a ComponentError carrying the partial counts and the failed chunk — and still enqueues what was onboarded", async () => {
    const partial = okResult({
      onboarded: ["N1"],
      chunks: [
        { start: "2024-05-01", end: "2024-05-30", status: "ok", orders: 5, days: 3, asins: 2, onboarded: ["N1"], invalidAsins: [], minDate: "2024-05-02", maxDate: "2024-05-29" },
        { start: "2024-05-31", end: "2024-06-29", status: "failed", orders: 0, days: 0, asins: 0, onboarded: [], invalidAsins: [], minDate: null, maxDate: null, error: "Report R2 failed: FATAL" },
      ],
    });
    salesDeps.sync = async () => { throw new SalesSyncError("chunk 2/2 failed: Report R2 failed: FATAL", partial); };
    const { ctx, inserted } = ctxFor(job(), { [ONBOARD_SALES_ASINS]: async () => {} });
    const err = await sales.run(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ComponentError);
    expect(err.message).toMatch(/chunk 2\/2 failed/);
    expect(err.partial.counts).toMatchObject({ chunks: 2, chunks_failed: 1, orders: 5, onboarded_from_sales: 1 });
    expect(err.partial.outcomes["_chunk_02 2024-05-31..2024-06-29"]).toBe("error: Report R2 failed: FATAL");
    expect(inserted).toHaveLength(1); // the onboarding job for N1 still queued
  });

  it("without the injected onboarder it says so and runs without onboarding", async () => {
    let hadOnboard: boolean | undefined;
    salesDeps.sync = async (_s, _e, _scope, opts) => { hadOnboard = !!opts?.onboard; return okResult(); };
    const { ctx, logs } = ctxFor(job());
    await sales.run(ctx);
    expect(hadOnboard).toBe(false);
    expect(logs.join("\n")).toMatch(/onboardSalesAsins is not injected/);
  });

  it("lists malformed ASIN strings the report carried, under invalid_asins_skipped", () => {
    const r = salesResultToComponent(okResult({ invalidAsins: ["UNKNOW"] }), { start: "a", end: "b", source: "params" });
    expect(r.counts.invalid_asins_skipped).toBe(1);
    expect(r.outcomes._invalid_asins_skipped).toBe("UNKNOW");
  });

  it("salesResultToComponent: no window_hours when the window came from params", () => {
    const r = salesResultToComponent(okResult(), { start: "a", end: "b", source: "params" });
    expect(r.counts.window_hours).toBeUndefined();
  });
});

describe("parseBackfillWindow", () => {
  it("validates the pair", () => {
    expect(parseBackfillWindow({ from: "2024-05-01", to: "2026-10-16" }, "2026-10-16")).toEqual({ from: "2024-05-01", to: "2026-10-16" });
    expect(parseBackfillWindow({ from: "2024-5-1", to: "2026-10-16" }, "2026-10-16")).toHaveProperty("error");
    expect(parseBackfillWindow({ from: "2026-10-17", to: "2026-10-16" }, "2026-10-16")).toHaveProperty("error");
    expect(parseBackfillWindow({ from: "2026-10-01", to: "2026-10-17" }, "2026-10-16")).toHaveProperty("error");
    expect(parseBackfillWindow({}, "2026-10-16")).toHaveProperty("error");
  });
});

describe("wiring (structural)", () => {
  const here = __dirname;
  it("migration 054 adds jobs.params and nothing else", () => {
    const f = join(here, "..", "..", "database", "migrations", "054_jobs_params.sql");
    expect(existsSync(f)).toBe(true);
    const s = readFileSync(f, "utf8");
    expect(s).toMatch(/ALTER TABLE jobs ADD COLUMN params JSONB;/);
    expect(s).not.toMatch(/DROP|DELETE|UPDATE /);
  });
  it("the backfill route is admin-only, enqueues component 19 alone with the window in params", () => {
    const s = readFileSync(join(here, "routes.ts"), "utf8");
    const r = s.slice(s.indexOf('router.post("/api/jobs/backfill-sales"'), s.indexOf('router.get("/api/jobs/scheduler"'));
    expect(r).toMatch(/requireRole\("admin"\)/);
    expect(r).toMatch(/components: \[19\]/);
    expect(r).toMatch(/includeDaily: false/);
    expect(r).toMatch(/params: \{ sales_window: \{ from: w\.from, to: w\.to \} \}/);
    expect(r).toMatch(/res\.status\(202\)/);
  });
  it("the npm script enqueues the same job and index.ts injects the onboarder", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
    expect(pkg.scripts["backfill:sales"]).toBe("tsx script/backfill-sales.ts");
    const sc = readFileSync(join(here, "..", "..", "script", "backfill-sales.ts"), "utf8");
    expect(sc).toMatch(/components: \[19\]/);
    expect(sc).toMatch(/parseBackfillWindow/);
    expect(sc).toMatch(/2024-05-01/);
    const idx = readFileSync(join(here, "..", "index.ts"), "utf8");
    expect(idx).toMatch(/onboardSalesAsins: getOnboardSalesAsins\(\)/);
  });
  it("sales onboarding goes through the shared insert path with the 'Sales import' tag and never sets lead_source", () => {
    const s = readFileSync(join(here, "..", "routes.ts"), "utf8");
    const fn = s.slice(s.indexOf("async function onboardSalesAsins"), s.indexOf("onboardSalesAsinsRef = onboardSalesAsins"));
    expect(fn).toMatch(/tags: \["Sales import"\]/);
    expect(fn).toMatch(/await insertNewAsinRows\(inputs, \(\) => \{\}, mainCatalogSink\)/);
    expect(fn).not.toMatch(/leadSource|lead_source/);
    expect(fn).not.toMatch(/enqueueJob/); // the component enqueues once, at the end
    const sync = readFileSync(join(here, "..", "sales-sync.ts"), "utf8");
    expect(sync).toMatch(/`SELECT id, asin FROM asins`/); // no status filter
    expect(sync).not.toMatch(/status IN \('active', 'parked'\)/);
  });
});
