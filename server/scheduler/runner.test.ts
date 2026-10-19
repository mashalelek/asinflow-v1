import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// server/index.ts boots Express (migrations + listen) on import. The runner
// itself never imports it, but the component bodies reach it through
// spapi.ts / suppression-sync.ts, so it is mocked here like every other test.
vi.mock("../index", () => ({ log: () => {} }));

import { COMPONENTS } from "./components";
import { runJob, componentsForJob, remainingAfterCursor, resolveScope, RUNNER_LOCK_KEY, setRunnerLogger } from "./runner";
import { applySuppressions, parseFypReport } from "../suppression-sync";
import type { ComponentDef, JobRow, QueryLike, ComponentContext } from "./types";
import { ASIN_CHECKPOINT_EVERY, ComponentError } from "./types";

// Scheduler v1 (SPEC §11 "Refresh job"). The runner is exercised against a
// jobs/ledger shim and a stub component list; the real component list is
// checked for order and shape only (its bodies call SP-API).

setRunnerLogger(() => {});

describe("the component sequence is fixed", () => {
  // 1–21 (scheduler v1) + the listing-hygiene components (SPEC §11, 2026-10-19).
  const SEQUENCE = Array.from({ length: 24 }, (_, i) => i + 1);
  it("the components, numbered in array order, daily block = 2..8 + 23 (ledger) + 24 (delete), hourly otherwise", () => {
    expect(COMPONENTS.map((c) => c.n)).toEqual(SEQUENCE);
    expect(COMPONENTS.filter((c) => c.tier === "daily").map((c) => c.n)).toEqual([2, 3, 4, 5, 6, 7, 8, 23, 24]);
    expect(COMPONENTS[0].key).toBe("01_sc_discovery");
    expect(COMPONENTS[20].key).toBe("21_actual_fees");
    expect(new Set(COMPONENTS.map((c) => c.key)).size).toBe(SEQUENCE.length);
  });
  it("one file per component in components/, numbered as the table", () => {
    const files = readdirSync(join(__dirname, "components")).filter((f) => /^\d{2}-.*\.ts$/.test(f)).sort();
    expect(files.map((f) => Number(f.slice(0, 2)))).toEqual(SEQUENCE);
  });
  it("componentsForJob: the daily block runs only with include_daily", () => {
    const hourly = componentsForJob({ include_daily: false } as JobRow).map((c) => c.n);
    expect(hourly).toEqual([1, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(componentsForJob({ include_daily: true } as JobRow).map((c) => c.n)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  });
  it("componentsForJob: an explicit components list wins, tier ignored, sequence order kept (decision 9)", () => {
    // Add to SC: component 8 only — a DAILY component, run without include_daily.
    expect(componentsForJob({ include_daily: false, components: [8] } as JobRow).map((c) => c.n)).toEqual([8]);
    // Push to Aura: component 9 only.
    expect(componentsForJob({ include_daily: false, components: [9] } as JobRow).map((c) => c.n)).toEqual([9]);
    // Order is the sequence's, not the caller's; unknown numbers are dropped.
    expect(componentsForJob({ include_daily: true, components: [13, 99, 10] } as JobRow).map((c) => c.n)).toEqual([10, 13]);
    // NULL / empty = the usual rule.
    expect(componentsForJob({ include_daily: false, components: null } as JobRow).map((c) => c.n)[0]).toBe(1);
    expect(componentsForJob({ include_daily: false, components: [] } as unknown as JobRow).length).toBe(14);
  });
  it("runner never imports ./index; index.ts starts the runner after registerRoutes", () => {
    for (const f of ["runner.ts", "jobs-repo.ts", "routes.ts", "types.ts"]) {
      expect(readFileSync(join(__dirname, f), "utf8")).not.toMatch(/from\s+["']\.\.\/index["']/);
    }
    const idx = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
    expect(idx.indexOf("startRunner({")).toBeGreaterThan(idx.indexOf("await registerRoutes(httpServer, app)"));
    expect(idx).toMatch(/app\.use\(createJobsRouter\(/);
    expect(RUNNER_LOCK_KEY).toBe(7342002);
  });
});

// ── jobs/ledger shim ─────────────────────────────────────────────────────────
function makeDb(opts: { scope: string[]; job: Partial<JobRow> }) {
  const job: JobRow = {
    id: 1, kind: "refresh", trigger: "manual", target: "main", bulk_list_id: null, include_daily: true,
    scope_asins: null, components: null, params: null, status: "running", progress: { done: [] }, summary: null, requested_by: null,
    queued_at: new Date(), started_at: new Date(), finished_at: null, error: null, ...opts.job,
  };
  const ledger: any[] = [];
  const progressWrites: any[] = [];
  const query: QueryLike = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT asin FROM asins WHERE asin = ANY")) return { rows: opts.scope.filter((a) => params[0].includes(a)).map((asin) => ({ asin })), rowCount: 0 };
    if (s.startsWith("SELECT asin FROM asins WHERE status IN")) return { rows: opts.scope.map((asin) => ({ asin })), rowCount: 0 };
    if (s.startsWith("UPDATE jobs SET progress")) { job.progress = JSON.parse(params[1]); progressWrites.push(job.progress); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("SELECT status FROM jobs")) return { rows: [{ status: job.status }], rowCount: 1 };
    if (s.startsWith("UPDATE jobs SET status = $2, summary")) { job.status = params[1]; job.summary = JSON.parse(params[2]); job.error = params[3]; return { rows: [], rowCount: 1 }; }
    if (s.startsWith("INSERT INTO refresh_runs")) { ledger.push({ trigger: params[1], stage: params[2], scope: params[3], requested: params[4], counts: JSON.parse(params[5]), outcomes: JSON.parse(params[6]), error: params[7], job_id: params[8] }); return { rows: [], rowCount: 1 }; }
    throw new Error(`unhandled SQL in shim: ${s.slice(0, 80)}`);
  };
  return { job, ledger, progressWrites, query };
}

const stub = (n: number, tier: "hourly" | "daily", kind: ComponentDef["kind"], run: ComponentDef["run"]): ComponentDef =>
  ({ n, key: `${String(n).padStart(2, "0")}_stub`, name: `stub ${n}`, tier, kind, call: "none", run });

const ok = (n: number, tier: "hourly" | "daily" = "hourly", kind: ComponentDef["kind"] = "derived") =>
  stub(n, tier, kind, async (ctx) => ({ counts: { seen: ctx.asins.length }, outcomes: {} }));

describe("runJob", () => {
  it("runs components in order, ledgers each with job_id, marks done with a summary", async () => {
    const order: number[] = [];
    const comps = [1, 2, 3].map((n) => stub(n, "hourly", "derived", async (ctx) => { order.push(n); return { counts: { seen: ctx.asins.length }, outcomes: {} }; }));
    const db = makeDb({ scope: ["A1", "A2", "A3"], job: {} });
    const s = await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0 });
    expect(order).toEqual([1, 2, 3]);
    expect(db.job.status).toBe("done");
    expect(db.ledger.map((l) => l.stage)).toEqual(["01_stub", "02_stub", "03_stub"]);
    expect(db.ledger.every((l) => l.job_id === 1 && l.trigger === "manual" && l.scope === "full")).toBe(true);
    expect(s.components["02_stub"]).toEqual({ seen: 3 });
    expect(db.job.progress.done).toEqual([1, 2, 3]);
  });

  it("a ComponentError's partial result is ledgered and summarised, and the job still fails (sales backfill, 2026-10-16)", async () => {
    const partial = { counts: { chunks: 2, chunks_failed: 1, orders: 5 }, outcomes: { "_chunk_02 a..b": "error: FATAL" } };
    const comps = [stub(19, "hourly", "account", async () => { throw new ComponentError("chunk 2/2 failed: FATAL", partial); })];
    const db = makeDb({ scope: ["A1"], job: { include_daily: false } });
    const s = await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0 });
    expect(db.job.status).toBe("failed");
    expect(db.job.error).toMatch(/component 19 19_stub: chunk 2\/2 failed: FATAL/);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0].counts).toEqual(partial.counts);
    expect(db.ledger[0].outcomes).toEqual(partial.outcomes);
    expect(db.ledger[0].error).toMatch(/FATAL/);
    expect(s.components["19_stub"]).toEqual(partial.counts);
    expect(s.stoppedAt).toBe(19);
  });

  it("ctx.setProgress writes position/total/unit; the next component starts without a unit (2026-10-16)", async () => {
    const comps = [
      stub(19, "hourly", "account", async (ctx) => { await ctx.setProgress(3, 30, "chunk"); return { counts: {}, outcomes: {} }; }),
      stub(20, "hourly", "account", async () => ({ counts: {}, outcomes: {} })),
    ];
    const db = makeDb({ scope: ["A1"], job: { include_daily: false } });
    await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0 });
    const withUnit = db.progressWrites.find((p) => p.unit === "chunk");
    expect(withUnit).toMatchObject({ component: 19, position: 3, total: 30, unit: "chunk" });
    const next = db.progressWrites.find((p) => p.component === 20);
    expect(next.unit).toBeUndefined();
  });

  it("skips the daily block when include_daily is false", async () => {
    const ran: number[] = [];
    const comps = [stub(1, "hourly", "derived", async () => { ran.push(1); return { counts: {}, outcomes: {} }; }), stub(2, "daily", "derived", async () => { ran.push(2); return { counts: {}, outcomes: {} }; }), stub(9, "hourly", "derived", async () => { ran.push(9); return { counts: {}, outcomes: {} }; })];
    const db = makeDb({ scope: ["A1"], job: { include_daily: false } });
    await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0 });
    expect(ran).toEqual([1, 9]);
    expect(db.ledger.map((l) => l.stage)).toEqual(["01_stub", "09_stub"]);
  });

  it("resume: skips done components, restarts the current per-ASIN one at the cursor, whole-scope for the rest", async () => {
    const seen: Record<number, string[]> = {};
    const comps = [
      stub(1, "hourly", "account", async (ctx) => { seen[1] = ctx.asins; return { counts: {}, outcomes: {} }; }),
      stub(7, "hourly", "asin", async (ctx) => { seen[7] = ctx.asins; return { counts: {}, outcomes: {} }; }),
      stub(10, "hourly", "batch", async (ctx) => { seen[10] = ctx.asins; return { counts: {}, outcomes: {} }; }),
    ];
    const db = makeDb({ scope: ["A1", "A2", "A3", "A4"], job: { progress: { done: [1], component: 7, asin_cursor: "A2" } } });
    await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0 });
    expect(seen[1]).toBeUndefined();                 // done → skipped
    expect(seen[7]).toEqual(["A3", "A4"]);           // restarted at the cursor
    expect(seen[10]).toEqual(["A1", "A2", "A3", "A4"]); // untouched component → whole scope
    expect(db.ledger.map((l) => l.stage)).toEqual(["07_stub", "10_stub"]);
    expect(db.ledger[0].requested).toBe(2);
    expect(db.job.progress.done).toEqual([1, 7, 10]);
  });

  it("resume of an account-level component ignores the cursor (reruns whole)", async () => {
    let seen: string[] = [];
    const comps = [stub(15, "hourly", "account", async (ctx) => { seen = ctx.asins; return { counts: {}, outcomes: {} }; })];
    const db = makeDb({ scope: ["A1", "A2", "A3"], job: { progress: { done: [], component: 15, asin_cursor: "A2" } } });
    await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0 });
    expect(seen).toEqual(["A1", "A2", "A3"]);
  });

  it("checkpoint writes progress with the cursor and honours a cancel mid-component", async () => {
    const comps = [stub(7, "hourly", "asin", async (ctx) => {
      await ctx.checkpoint("A1");
      (db.job as any).status = "cancelled"; // operator cancels while it runs
      await ctx.checkpoint("A2");
      throw new Error("should not get here");
    }), ok(9)];
    const db = makeDb({ scope: ["A1", "A2", "A3"], job: {} });
    const s = await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0 });
    expect(db.job.status).toBe("cancelled");
    expect(s.stoppedAt).toBe(7);
    expect(db.progressWrites.some((p) => p.component === 7 && p.asin_cursor === "A2")).toBe(true);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({ stage: "07_stub", error: "cancelled" });
    expect(db.ledger.find((l) => l.stage === "09_stub")).toBeUndefined(); // later components do not run
  });

  it("a throwing component fails the job with its number, ledgers the error, and stops the sequence", async () => {
    const comps = [ok(1), stub(10, "hourly", "batch", async () => { throw new Error("429 throttled"); }), ok(13)];
    const db = makeDb({ scope: ["A1"], job: {} });
    const s = await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0 });
    expect(db.job.status).toBe("failed");
    expect(db.job.error).toBe("component 10 10_stub: 429 throttled");
    expect(s.stoppedAt).toBe(10);
    expect(db.ledger.map((l) => [l.stage, l.error])).toEqual([["01_stub", null], ["10_stub", "429 throttled"]]);
  });

  it("flips from components land in the summary; injected deps land in the cache", async () => {
    const comps = [stub(8, "hourly", "asin", async (ctx) => ({ counts: {}, outcomes: {}, flips: [{ asin: "A1", field: "gating" as const, from: "gated", to: "ungated" }] })),
      stub(9, "hourly", "account", async (ctx) => ({ counts: { injected: typeof ctx.cache.get("runSheetsSync") === "function" ? 1 : 0 }, outcomes: {} }))];
    const db = makeDb({ scope: ["A1"], job: {} });
    const s = await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0, inject: { runSheetsSync: async () => ({}) } });
    expect(s.flips).toEqual([{ asin: "A1", field: "gating", from: "gated", to: "ungated" }]);
    expect(s.components["09_stub"]).toEqual({ injected: 1 });
  });

  it("scope: explicit ASINs are taken in asins.id order; a subset job ledgers scope=subset", async () => {
    const db = makeDb({ scope: ["A1", "A2", "A3"], job: { scope_asins: ["A3", "A1", "ZZ"] } });
    expect(await resolveScope(db.job, db.query)).toEqual(["A1", "A3"]);
    await runJob(db.job, { query: db.query, sellerId: "S", components: [ok(1)], now: () => 0 });
    expect(db.ledger[0]).toMatchObject({ scope: "subset", requested: 2 });
  });

  it("remainingAfterCursor", () => {
    expect(remainingAfterCursor(["a", "b", "c"], "b")).toEqual(["c"]);
    expect(remainingAfterCursor(["a", "b", "c"], null)).toEqual(["a", "b", "c"]);
    expect(remainingAfterCursor(["a", "b", "c"], "zz")).toEqual(["a", "b", "c"]);
    expect(ASIN_CHECKPOINT_EVERY).toBe(50);
  });

  it("a bulk-target job without a list id is refused (bulk jobs are covered in bulk.test.ts)", async () => {
    const db = makeDb({ scope: ["A1"], job: { target: "bulk", bulk_list_id: null } });
    await expect(runJob(db.job, { query: db.query, sellerId: "S", components: [ok(1)] })).rejects.toThrow(/bulk target without bulk_list_id/);
  });
});

describe("suppressions: stage-then-swap leaves no empty window", () => {
  function makeClient(initial: Record<string, boolean>) {
    const flags = { ...initial };
    const statements: string[] = [];
    let staged = new Map<string, string>();
    let inTx = false;
    const client = {
      async query(sql: string, params: any[] = []) {
        const s = sql.replace(/\s+/g, " ").trim();
        statements.push(s);
        if (s === "BEGIN") { inTx = true; return { rows: [], rowCount: 0 }; }
        if (s === "COMMIT" || s === "ROLLBACK") { inTx = false; return { rows: [], rowCount: 0 }; }
        if (s.startsWith("CREATE TEMP TABLE fyp_stage")) { staged = new Map(); return { rows: [], rowCount: 0 }; }
        if (s.startsWith("INSERT INTO fyp_stage")) { params[0].forEach((a: string, i: number) => staged.set(a, params[1][i])); return { rows: [], rowCount: params[0].length }; }
        if (s.startsWith("SELECT a.asin, COALESCE(a.is_search_suppressed, FALSE) AS was")) {
          return { rows: Object.entries(flags).filter(([a, v]) => v !== staged.has(a)).map(([a, v]) => ({ asin: a, was: v, now: staged.has(a) })), rowCount: 0 };
        }
        if (s.startsWith("UPDATE asins a SET is_search_suppressed = (s.asin IS NOT NULL)")) {
          expect(inTx).toBe(true);
          for (const a of Object.keys(flags)) flags[a] = staged.has(a);
          return { rows: [], rowCount: 0 };
        }
        if (s.startsWith("SELECT count(*)::int AS n FROM asins WHERE is_search_suppressed = TRUE")) return { rows: [{ n: Object.values(flags).filter(Boolean).length }], rowCount: 1 };
        throw new Error(`unhandled: ${s.slice(0, 60)}`);
      },
      release: vi.fn(),
    };
    return { client, flags, statements, pool: { connect: async () => client } };
  }

  it("one transactional UPDATE sets every flag from the staged set; no clear-all statement exists", async () => {
    const m = makeClient({ A1: true, A2: false, A3: true });
    const r = await applySuppressions(new Map([["A2", ["reason x"]], ["A3", []]]), m.pool);
    expect(m.flags).toEqual({ A1: false, A2: true, A3: true });
    expect(r.newlySuppressed).toBe(1);
    expect(r.cleared).toBe(1);
    expect(r.flips).toEqual([{ asin: "A1", from: true, to: false }, { asin: "A2", from: false, to: true }]);
    expect(m.statements.some((s) => /SET is_search_suppressed = FALSE/.test(s))).toBe(false);
    expect(m.statements.filter((s) => s.startsWith("UPDATE asins"))).toHaveLength(1);
    expect(m.statements[0]).toBe("BEGIN");
    expect(m.statements[m.statements.length - 1]).toBe("COMMIT");
  });

  it("an empty report clears everything through the same single statement", async () => {
    const m = makeClient({ A1: true, A2: true });
    const r = await applySuppressions(new Map(), m.pool);
    expect(m.flags).toEqual({ A1: false, A2: false });
    expect(r.cleared).toBe(2);
    expect(r.inReport).toBe(0);
  });

  it("parseFypReport aggregates distinct reasons per ASIN", () => {
    const tsv = "sku\tasin\treason\ncq-1\tB001\tMissing image\ncq-2\tB001\tMissing image\ncq-3\tB001\tTitle too long\ncq-4\tB002\t\n";
    const m = parseFypReport(tsv);
    expect(m.get("B001")).toEqual(["Missing image", "Title too long"]);
    expect(m.get("B002")).toEqual([]);
    expect(parseFypReport("").size).toBe(0);
  });
});

describe("in_catalog has no writers left", () => {
  it("inventory, sales and the phase-c onboarding no longer set it", () => {
    for (const f of ["inventory-sync.ts", "sales-sync.ts", "routes.ts"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf8").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/in_catalog\s*=\s*TRUE/);
      expect(src, f).not.toMatch(/\bin_catalog\b/);
    }
  });
});
