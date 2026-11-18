import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Two-lane runner (Maria, 2026-10-16): lane S = the scheduled pass, lane M =
// manual / onboarding / bulk; both run concurrently in one process, one job
// at a time within a lane. Onboarding jobs run the per-ASIN components only
// and are deduped by ASIN against queued/running onboarding jobs.

vi.mock("../index", () => ({ log: () => {} }));
vi.mock("../db", () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), default: {} }));

import { claimNextJob, laneAhead, enqueueOnboardingJob } from "./jobs-repo";
import { componentsForJob, startRunner, setRunnerLogger } from "./runner";
import { runScheduledTick, setScheduleLogger } from "./schedule";
import { ONBOARDING_COMPONENTS, laneOf, LANE_TRIGGERS, type ComponentDef, type JobRow, type QueryLike } from "./types";

setRunnerLogger(() => {});
setScheduleLogger(() => {});

const row = (over: Partial<JobRow>): JobRow => ({
  id: 1, kind: "refresh", trigger: "manual", target: "main", bulk_list_id: null, include_daily: true, scope_asins: ["A1"],
  components: null, params: null, status: "queued", progress: { done: [] }, summary: null, requested_by: null,
  queued_at: new Date("2026-10-16T12:00:00Z"), started_at: null, finished_at: null, error: null, ...over,
});

describe("lanes", () => {
  it("laneOf / LANE_TRIGGERS", () => {
    expect(laneOf({ kind: "refresh", trigger: "scheduled" })).toBe("S");
    for (const t of ["manual", "onboarding", "bulk"] as const) expect(laneOf({ kind: "refresh", trigger: t })).toBe("M");
    expect(LANE_TRIGGERS.S).toEqual(["scheduled"]);
    expect(LANE_TRIGGERS.M).toEqual(["manual", "onboarding", "bulk"]);
    expect(laneOf({ kind: "keepa", trigger: "onboarding" })).toBe("K"); // lane K (2026-11-18): kind decides, not the trigger
  });

  it("claimNextJob filters by the lane's triggers (resume first, then queue order)", async () => {
    const sql: { text: string; params?: any[] }[] = [];
    const q: QueryLike = async (text, params) => { sql.push({ text, params }); return { rows: [], rowCount: 0 }; };
    await claimNextJob(q, "M");
    const claim = sql.find((s) => s.text.includes("FROM jobs"))!;
    expect(claim.text).toMatch(/status IN \('running','queued'\) AND trigger = ANY\(\$1::text\[\]\) AND kind = \$2/);
    expect(claim.text).toMatch(/ORDER BY \(status = 'running'\) DESC, \(kind = 'keepa' AND trigger = 'onboarding'\) DESC, \(kind = 'keepa' AND trigger = 'scheduled'\) DESC, queued_at ASC, id ASC/); // lane K: new-ASIN, daily, bulk
    expect(claim.params).toEqual([["manual", "onboarding", "bulk"], "refresh"]);
    sql.length = 0;
    await claimNextJob(q, "S");
    expect(sql.find((s) => s.text.includes("FROM jobs"))!.params).toEqual([["scheduled"], "refresh"]);
  });

  it("laneAhead counts lane M jobs only — the scheduled pass never counts", () => {
    const mine = row({ id: 5, queued_at: new Date("2026-10-16T12:05:00Z") });
    const active = [
      row({ id: 1, trigger: "scheduled", status: "running" }),
      row({ id: 2, trigger: "manual", status: "running", queued_at: new Date("2026-10-16T12:01:00Z") }),
      row({ id: 3, trigger: "onboarding", status: "queued", queued_at: new Date("2026-10-16T12:02:00Z") }),
      row({ id: 4, trigger: "scheduled", status: "queued", queued_at: new Date("2026-10-16T12:03:00Z") }),
      mine,
      row({ id: 6, trigger: "manual", status: "queued", queued_at: new Date("2026-10-16T12:06:00Z") }),
    ];
    expect(laneAhead(mine, active)).toBe(2); // #2 running, #3 queued earlier; not #1/#4 (lane S), not #6 (later)
  });
});

describe("onboarding jobs", () => {
  it("run the per-ASIN components only: 2–8 and 10–17, never 1, 9, 18–21", () => {
    const ns = componentsForJob(row({ trigger: "onboarding", include_daily: true })).map((c) => c.n);
    expect(ns).toEqual([2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(ns).toEqual([...ONBOARDING_COMPONENTS]);
    for (const n of [1, 9, 18, 19, 20, 21]) expect(ns).not.toContain(n);
    // manual and bulk keep the full rule
    expect(componentsForJob(row({ trigger: "manual", include_daily: true })).map((c) => c.n)).toHaveLength(21);
    expect(componentsForJob(row({ trigger: "bulk", include_daily: true })).map((c) => c.n)).toHaveLength(21);
  });

  it("enqueueOnboardingJob drops ASINs an active onboarding job already covers; nothing left = no job", async () => {
    const inserts: any[] = [];
    const q: QueryLike = async (text, params) => {
      if (text.includes("array_agg(x ORDER BY x)")) return { rows: [], rowCount: 0 }; // onboarding dedupe (2026-10-18): no repeat in the window
      if (text.includes("unnest(scope_asins)")) return { rows: [{ asin: "B000000001" }, { asin: "B000000002" }], rowCount: 2 };
      if (text.includes("INSERT INTO jobs")) { inserts.push(params); return { rows: [{ id: 9, trigger: "onboarding", scope_asins: params![4], progress: {} }], rowCount: 1 }; }
      throw new Error(`unexpected ${text.slice(0, 40)}`);
    };
    const r = await enqueueOnboardingJob(["b000000001", "B000000003", "B000000003"], { requestedBy: 4 }, q);
    expect(r.covered).toEqual(["B000000001"]);
    expect(r.enqueued).toEqual(["B000000003"]);
    expect(r.job?.id).toBe(9);
    expect(inserts[0][0]).toBe("onboarding");
    expect(inserts[0][4]).toEqual(["B000000003"]);
    expect(inserts[0][7]).toBe(4);
    const none = await enqueueOnboardingJob(["B000000001", "B000000002"], {}, q);
    expect(none.job).toBeNull();
    expect(inserts).toHaveLength(1);
    expect((await enqueueOnboardingJob([], {}, q)).job).toBeNull();
  });

  it("inserting ASINs enqueues exactly ONE new-ASIN Keepa job beside the refresh onboarding job — from the same helper (commit 3, 2026-11-18); none without a key", async () => {
    const inserts: any[][] = [];
    const q: QueryLike = async (text, params) => {
      if (text.includes("array_agg(x ORDER BY x)")) return { rows: [], rowCount: 0 };
      if (text.includes("unnest(scope_asins)")) return { rows: [], rowCount: 0 };
      if (text.includes("INSERT INTO jobs")) { inserts.push(params!); return { rows: [{ id: inserts.length, kind: params![8], trigger: params![0], scope_asins: params![4], progress: {} }], rowCount: 1 }; }
      throw new Error(`unexpected ${text.slice(0, 40)}`);
    };
    const r = await enqueueOnboardingJob(["B000000001", "B000000002"], { keepaEnabled: () => true }, q);
    expect(r.job?.id).toBe(1);
    expect(r.keepaJob?.id).toBe(2);
    expect(inserts.map((p) => [p[8], p[0], p[4]])).toEqual([["refresh", "onboarding", ["B000000001", "B000000002"]], ["keepa", "onboarding", ["B000000001", "B000000002"]]]);
    inserts.length = 0;
    const off = await enqueueOnboardingJob(["B000000003"], { keepaEnabled: () => false }, q);
    expect(off.keepaJob).toBeNull();
    expect(inserts.map((p) => p[8])).toEqual(["refresh"]);
    // the sites: every insert path enqueues through this helper and none builds a Keepa job by hand
    const routes = readFileSync(join(__dirname, "..", "routes.ts"), "utf8");
    expect(routes).not.toMatch(/kind: "keepa"/);
    expect(readFileSync(join(__dirname, "components", "19-sales.ts"), "utf8")).not.toMatch(/keepa/i);
  });

  it("every onboarding enqueue site goes through the dedup helper", () => {
    const routes = readFileSync(join(__dirname, "..", "routes.ts"), "utf8");
    const sales = readFileSync(join(__dirname, "components", "19-sales.ts"), "utf8");
    expect(routes).not.toMatch(/enqueueJob\(\{ trigger: "onboarding"/);
    expect(sales).not.toMatch(/enqueueJob\(/);
    expect((routes.match(/enqueueOnboardingJob\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(sales).toMatch(/enqueueOnboardingJob\(asins/);
    // the insert path only enqueues rows that exist
    expect(routes).toMatch(/not inserted \(no asins row after insert\) — not enqueued/);
  });
});

describe("the schedule tick looks at lane S only", () => {
  it("a running MANUAL job is not an overrun; a running SCHEDULED pass is", async () => {
    const lines: string[] = [];
    setScheduleLogger((m) => lines.push(m));
    const q = (active: Partial<JobRow>[]): QueryLike => async (sql) => {
      if (/FROM jobs WHERE status IN \('running','queued'\)/.test(sql)) return { rows: active, rowCount: active.length };
      throw new Error("unexpected");
    };
    const enqueue = vi.fn(async () => row({ id: 20 }));
    await runScheduledTick(false, { enqueue, query: q([row({ id: 10, status: "running", trigger: "manual" })]) });
    expect(lines.at(-1)).toBe("scheduled pass (hourly) enqueued as job 20");
    await runScheduledTick(false, { enqueue, query: q([row({ id: 11, status: "running", trigger: "scheduled" })]) });
    expect(lines.at(-1)).toMatch(/scheduled pass #11 is still running \(overrun\)/);
    setScheduleLogger(() => {});
  });
});

// ── the runner with a fake pool: both lanes live in one process ────────────
function fakePool(seed: JobRow[], scope: string[]) {
  const jobs = seed.map((j) => ({ ...j }));
  const claims: Array<{ id: number; lane: string[]; kind: string }> = [];
  // lane K's claim order (the SQL's two DESC flags): new-ASIN 0, daily 1, bulk 2; refresh kinds all 2 (queue order)
  const kp = (j: any) => (j.kind === "keepa" && j.trigger === "onboarding" ? 0 : j.kind === "keepa" && j.trigger === "scheduled" ? 1 : 2);
  const q = async (text: string, params: any[] = []) => {
    const s = text.replace(/\s+/g, " ").trim();
    if (/pg_try_advisory_lock/.test(s)) return { rows: [{ ok: true }], rowCount: 1 };
    if (/pg_advisory_unlock/.test(s)) return { rows: [], rowCount: 0 };
    if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (s.includes("FROM jobs WHERE status IN ('running','queued') AND trigger = ANY")) {
      const want: string[] = params[0];
      const kind: string = params[1];
      const c = jobs.filter((j) => (j.status === "running" || j.status === "queued") && want.includes(j.trigger) && j.kind === kind)
        .sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || kp(a) - kp(b) || +new Date(a.queued_at) - +new Date(b.queued_at) || a.id - b.id);
      if (c[0]) claims.push({ id: c[0].id, lane: want, kind });
      return { rows: c.slice(0, 1), rowCount: c.length ? 1 : 0 };
    }
    if (s.startsWith("UPDATE jobs SET status = 'running'")) { const j = jobs.find((x) => x.id === params[0])!; j.status = "running"; j.started_at = j.started_at ?? new Date(); return { rows: [j], rowCount: 1 }; }
    if (s.startsWith("SELECT asin FROM asins WHERE asin = ANY")) return { rows: scope.filter((a) => params[0].includes(a)).map((asin) => ({ asin })), rowCount: 0 };
    if (s.startsWith("SELECT asin FROM asins WHERE status IN")) return { rows: scope.map((asin) => ({ asin })), rowCount: 0 };
    if (s.startsWith("UPDATE jobs SET progress")) { const j = jobs.find((x) => x.id === params[0])!; j.progress = JSON.parse(params[1]); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("SELECT status FROM jobs")) return { rows: [{ status: jobs.find((x) => x.id === params[0])!.status }], rowCount: 1 };
    if (s.startsWith("UPDATE jobs SET status = $2, summary")) { const j = jobs.find((x) => x.id === params[0])!; j.status = params[1]; j.summary = JSON.parse(params[2]); j.finished_at = new Date(); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("INSERT INTO refresh_runs")) return { rows: [], rowCount: 1 };
    throw new Error(`unhandled SQL in pool shim: ${s.slice(0, 70)}`);
  };
  const pool: any = { query: q, connect: async () => ({ query: q, release: () => {} }) };
  return { pool, jobs, claims };
}
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const stub = (n: number, run: ComponentDef["run"], kind: ComponentDef["kind"] = "derived"): ComponentDef =>
  ({ n, key: `${String(n).padStart(2, "0")}_stub`, name: `stub ${n}`, tier: "hourly", kind, call: "none", run });
const tick = () => new Promise<void>((r) => setTimeout(r, 15));
const waitFor = async (pred: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await tick(); } };

describe("two lanes in one runner", () => {
  it("a manual job starts while the scheduled pass is mid-prices, and both finish; the pass never waited", async () => {
    const pricesGate = gate();
    const order: string[] = [];
    const comps = [
      stub(10, async (ctx) => { order.push(`10:${ctx.job.trigger}:start`); if (ctx.job.trigger === "scheduled") await pricesGate.p; order.push(`10:${ctx.job.trigger}:end`); return { counts: {}, outcomes: {} }; }),
      stub(13, async (ctx) => { order.push(`13:${ctx.job.trigger}`); return { counts: {}, outcomes: {} }; }),
    ];
    const seed = [row({ id: 1, trigger: "scheduled", scope_asins: null, queued_at: new Date("2026-10-16T12:00:00Z") })];
    const f = fakePool(seed, ["A1", "A2"]);
    const h = startRunner({ pool: f.pool, sellerId: "S", components: comps, pollMs: 10 });
    await waitFor(() => order.includes("10:scheduled:start"));
    // the pass is parked inside prices; now a manual job arrives
    f.jobs.push(row({ id: 2, trigger: "manual", scope_asins: ["A1"], queued_at: new Date("2026-10-16T12:01:00Z") }));
    await waitFor(() => f.jobs.find((j) => j.id === 2)!.status === "done");
    expect(order).toEqual(["10:scheduled:start", "10:manual:start", "10:manual:end", "13:manual"]); // manual ran to completion while S was parked
    expect(f.jobs.find((j) => j.id === 1)!.status).toBe("running");
    pricesGate.open();
    await waitFor(() => f.jobs.find((j) => j.id === 1)!.status === "done");
    expect(order.slice(-2)).toEqual(["10:scheduled:end", "13:scheduled"]);
    await h.stop();
  });

  it("two manual jobs serialize in lane M, and a queued manual job never delays a scheduled pass", async () => {
    const g1 = gate();
    const order: string[] = [];
    const comps = [stub(10, async (ctx) => { order.push(`start:${ctx.job.id}`); if (ctx.job.id === 2) await g1.p; order.push(`end:${ctx.job.id}`); return { counts: {}, outcomes: {} }; })];
    const seed = [
      row({ id: 2, trigger: "manual", scope_asins: ["A1"], queued_at: new Date("2026-10-16T12:00:00Z") }),
      row({ id: 3, trigger: "manual", scope_asins: ["A1"], queued_at: new Date("2026-10-16T12:00:01Z") }),
      row({ id: 4, trigger: "scheduled", scope_asins: null, queued_at: new Date("2026-10-16T12:00:02Z") }),
    ];
    const f = fakePool(seed, ["A1"]);
    const h = startRunner({ pool: f.pool, sellerId: "S", components: comps, pollMs: 10 });
    await waitFor(() => f.jobs.find((j) => j.id === 4)!.status === "done"); // the pass finished while manual #2 is still parked
    expect(order).toContain("start:2");
    expect(order).toContain("end:4");
    expect(order).not.toContain("start:3"); // lane M: #3 waits for #2
    expect(f.jobs.find((j) => j.id === 3)!.status).toBe("queued");
    g1.open();
    await waitFor(() => f.jobs.find((j) => j.id === 3)!.status === "done");
    expect(order.indexOf("start:3")).toBeGreaterThan(order.indexOf("end:2"));
    await h.stop();
  });

  it("resume on boot restores BOTH lanes' running jobs", async () => {
    const ran: number[] = [];
    const comps = [stub(10, async (ctx) => { ran.push(ctx.job.id); return { counts: {}, outcomes: {} }; })];
    const seed = [
      row({ id: 7, trigger: "scheduled", scope_asins: null, status: "running", started_at: new Date(), progress: { done: [], component: 10, asin_cursor: null } }),
      row({ id: 8, trigger: "onboarding", scope_asins: ["A1"], status: "running", started_at: new Date(), progress: { done: [] } }),
      row({ id: 9, trigger: "manual", scope_asins: ["A1"], status: "queued" }),
    ];
    const f = fakePool(seed, ["A1"]);
    const h = startRunner({ pool: f.pool, sellerId: "S", components: comps, pollMs: 10 });
    await waitFor(() => [7, 8, 9].every((id) => f.jobs.find((j) => j.id === id)!.status === "done"));
    expect(ran.slice(0, 2).sort()).toEqual([7, 8]); // both running rows resumed first
    expect(ran[2]).toBe(9);                          // then lane M's queued job
    expect(f.claims.filter((c) => c.id === 7).every((c) => c.lane.includes("scheduled"))).toBe(true);
    expect(f.claims.filter((c) => c.id === 8).every((c) => c.lane.includes("onboarding"))).toBe(true);
    await h.stop();
  });

  it("lane K: a Keepa job runs while S and M each have a running job; a waiting Keepa job never delays a lane-S claim (2026-11-18)", async () => {
    const gS = gate(), gM = gate(), gK = gate();
    const order: string[] = [];
    const comps = [
      stub(10, async (ctx) => { order.push(`start:${ctx.job.id}`); if (ctx.job.id === 1) await gS.p; if (ctx.job.id === 2) await gM.p; order.push(`end:${ctx.job.id}`); return { counts: {}, outcomes: {} }; }),
      stub(33, async (ctx) => { order.push(`start:${ctx.job.id}`); if (ctx.job.id === 3) await gK.p; order.push(`end:${ctx.job.id}`); return { counts: {}, outcomes: {} }; }),
    ];
    const seed = [
      row({ id: 1, trigger: "scheduled", scope_asins: null, queued_at: new Date("2026-11-18T05:00:00Z") }),
      row({ id: 2, trigger: "manual", scope_asins: ["A1"], queued_at: new Date("2026-11-18T05:00:01Z") }),
      row({ id: 3, kind: "keepa", trigger: "scheduled", scope_asins: null, queued_at: new Date("2026-11-18T05:00:02Z") }),
    ];
    const f = fakePool(seed, ["A1"]);
    const h = startRunner({ pool: f.pool, sellerId: "S", components: comps, pollMs: 10 });
    await waitFor(() => ["start:1", "start:2", "start:3"].every((x) => order.includes(x))); // all three lanes busy at once
    // a queued Keepa job (new-ASIN) waits behind #3 in lane K; a new scheduled pass is claimed by lane S the moment #1 ends
    f.jobs.push(row({ id: 4, kind: "keepa", trigger: "onboarding", scope_asins: ["A1"], queued_at: new Date("2026-11-18T06:00:00Z") }));
    f.jobs.push(row({ id: 5, trigger: "scheduled", scope_asins: null, queued_at: new Date("2026-11-18T06:00:01Z") }));
    gS.open();
    await waitFor(() => f.jobs.find((j) => j.id === 5)!.status === "done");
    expect(f.jobs.find((j) => j.id === 4)!.status).toBe("queued"); // lane K still on #3
    expect(f.jobs.find((j) => j.id === 3)!.status).toBe("running");
    gK.open(); gM.open();
    await waitFor(() => [2, 3, 4].every((id) => f.jobs.find((j) => j.id === id)!.status === "done"));
    expect(f.claims.filter((c) => c.id === 3 || c.id === 4).every((c) => c.kind === "keepa")).toBe(true);
    expect(f.claims.filter((c) => c.id === 1 || c.id === 5).every((c) => c.kind === "refresh" && c.lane.join() === "scheduled")).toBe(true);
    await h.stop();
  });

  it("lane K: a queued new-ASIN Keepa job is claimed ahead of a queued daily Keepa job", async () => {
    const order: number[] = [];
    const comps = [stub(33, async (ctx) => { order.push(ctx.job.id); return { counts: {}, outcomes: {} }; })];
    const seed = [
      row({ id: 11, kind: "keepa", trigger: "scheduled", scope_asins: null, queued_at: new Date("2026-11-18T05:00:00Z") }),
      row({ id: 12, kind: "keepa", trigger: "onboarding", scope_asins: ["A1"], queued_at: new Date("2026-11-18T05:00:05Z") }),
    ];
    const f = fakePool(seed, ["A1"]);
    const h = startRunner({ pool: f.pool, sellerId: "S", components: comps, pollMs: 10 });
    await waitFor(() => [11, 12].every((id) => f.jobs.find((j) => j.id === id)!.status === "done"));
    expect(order).toEqual([12, 11]);
    await h.stop();
  });

  it("lane K order: new-ASIN, daily, bulk — a bulk job queued during the daily job starts when the daily job ends (Maria 2026-11-18)", async () => {
    const order: number[] = [];
    const gK = gate();
    const comps = [stub(33, async (ctx) => { order.push(ctx.job.id); if (ctx.job.id === 21) await gK.p; return { counts: {}, outcomes: {} }; })];
    const seed = [row({ id: 21, kind: "keepa", trigger: "scheduled", scope_asins: null, queued_at: new Date("2026-11-18T05:00:00Z") })];
    const f = fakePool(seed, ["A1"]);
    const h = startRunner({ pool: f.pool, sellerId: "S", components: comps, pollMs: 10 });
    await waitFor(() => order.includes(21)); // the daily job runs
    f.jobs.push(row({ id: 22, kind: "keepa", trigger: "bulk", bulk_list_id: "L1", scope_asins: ["B0BULKONLY1"], queued_at: new Date("2026-11-18T06:00:00Z") }));
    f.jobs.push(row({ id: 23, kind: "keepa", trigger: "onboarding", scope_asins: ["A1"], queued_at: new Date("2026-11-18T06:00:01Z") }));
    f.jobs.push(row({ id: 24, kind: "keepa", trigger: "scheduled", scope_asins: null, queued_at: new Date("2026-11-18T06:00:02Z") }));
    await new Promise((r) => setTimeout(r, 50));
    expect(f.jobs.filter((j) => j.id > 21).map((j) => j.status)).toEqual(["queued", "queued", "queued"]); // lane K is on #21
    gK.open();
    await waitFor(() => [22, 23, 24].every((id) => f.jobs.find((j) => j.id === id)!.status === "done"));
    expect(order).toEqual([21, 23, 24, 22]); // then: the new-ASIN job, the (next) daily job, the bulk job last
    expect(f.claims.filter((c) => c.id === 22).every((c) => c.kind === "keepa" && c.lane.includes("bulk"))).toBe(true);
    await h.stop();
  });

  it("no duplicate onboarding when both lanes discover the same ASIN: the second enqueue is dropped", async () => {
    // Lane S's component found N1 and enqueued; lane M's run finds N1 too.
    const activeCover = new Set<string>();
    const inserts: any[] = [];
    const q: QueryLike = async (text, params) => {
      if (text.includes("array_agg(x ORDER BY x)")) return { rows: [], rowCount: 0 }; // onboarding dedupe (2026-10-18): no repeat in the window
      if (text.includes("unnest(scope_asins)")) return { rows: Array.from(activeCover).map((asin) => ({ asin })), rowCount: 0 };
      if (text.includes("INSERT INTO jobs")) { inserts.push(params![4]); for (const a of params![4]) activeCover.add(a); return { rows: [{ id: inserts.length, trigger: "onboarding", scope_asins: params![4], progress: {} }], rowCount: 1 }; }
      throw new Error("unexpected");
    };
    const first = await enqueueOnboardingJob(["N000000001"], {}, q);  // lane S
    const second = await enqueueOnboardingJob(["N000000001", "N000000002"], {}, q); // lane M, moments later
    expect(first.job?.id).toBe(1);
    expect(second.enqueued).toEqual(["N000000002"]);
    expect(second.covered).toEqual(["N000000001"]);
    expect(inserts).toEqual([["N000000001"], ["N000000002"]]);
  });
});

describe("surfaces", () => {
  it("GET /api/jobs/current returns one running job per lane plus the queue", () => {
    const s = readFileSync(join(__dirname, "routes.ts"), "utf8");
    const r = s.slice(s.indexOf('router.get("/api/jobs/current"'), s.indexOf('router.get("/api/jobs", '));
    expect(r).toMatch(/scheduled: active\.find\(\(j\) => j\.status === "running" && j\.kind === "refresh" && j\.trigger === "scheduled"\)/);
    expect(r).toMatch(/manual: active\.find\(\(j\) => j\.status === "running" && j\.kind === "refresh" && j\.trigger !== "scheduled"\)/);
    expect(r).toMatch(/keepa: active\.find\(\(j\) => j\.status === "running" && j\.kind === "keepa"\)/);
    expect(r).toMatch(/queued: active\.filter\(\(j\) => j\.status === "queued"\)/);
    expect(s).toMatch(/laneAhead\(job, await listActive\(query\)\)/);
    expect(readFileSync(join(__dirname, "bulk.ts"), "utf8")).toMatch(/laneAhead\(job, await listActive\(query\)\)/);
  });
});
