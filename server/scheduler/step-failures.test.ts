// Step failures (Maria 2026-11-05): a step with failures is marked failed with the reason; known-persistent ASINs
// (same ASIN, same error, 3 passes in a row) are listed and do not fail it; bad data and by-design skips never count.
import { describe, it, expect, vi } from "vitest";
vi.mock("../index", () => ({ log: () => {} }));
import { failuresOf, judgeStep, persistentAsins, stepNotes, persistentLabel } from "./step-failures";
import { runJob, setRunnerLogger } from "./runner";
import { lastPassOf } from "./routes";
import type { ComponentDef, JobRow, QueryLike } from "./types";

setRunnerLogger(() => {});
const def = { n: 13, key: "13_fees", name: "FBA fee estimate" };
const A = "B000000001", B = "B000000002", C = "B000000003";

describe("what counts as a failure", () => {
  it("per-ASIN error: / skipped_transient / skip_probe_transient; non-ASIN error notes; the failure counters", () => {
    const f = failuresOf({ counts: { error: 2, updated: 9 }, outcomes: { [A]: "error: no fee in response", [B]: "skipped_transient", [C]: "skipped_no_price", _ingest: "error: Gmail 500", _window: "a..b" } });
    expect(Array.from(f.asins)).toEqual([[A, "error: no fee in response"], [B, "skipped_transient"]]);
    expect(f.notes).toEqual(["ingest: error: Gmail 500"]);
    expect(f.counted).toBe(2);
  });
  it("bad data and by-design skips are not failures: 10 Prices invalid_asin, 19 Sales' UNKNOW, skip_*, 14's incomplete, 20 / 21 skipped", () => {
    const r = judgeStep({ n: 10, key: "10_prices", name: "prices" }, { counts: { updated: 5, invalid_asin: 1, no_offers: 3 }, outcomes: { [A]: "invalid_asin: B000000001 is an invalid ASIN", [B]: "no_offers" } }, new Set());
    expect(r.failure).toBeNull();
    expect(judgeStep({ n: 19, key: "19_sales", name: "sales" }, { counts: { invalid_asins_skipped: 1 }, outcomes: { _invalid_asins_skipped: "UNKNOW" } }, new Set()).failure).toBeNull();
    expect(judgeStep({ n: 22, key: "22_close_oos", name: "close" }, { counts: { skip_no_listing: 900, "skip_has_stock:fulfillable": 40 }, outcomes: { "SKU-1": "skip_no_listing" } }, new Set()).failure).toBeNull();
    expect(judgeStep({ n: 14, key: "14_profit", name: "profit" }, { counts: {}, outcomes: { [A]: "incomplete: missing price, fee" } }, new Set()).failure).toBeNull();
    expect(judgeStep({ n: 20, key: "20_refunds", name: "refunds" }, { counts: { skipped: 1 }, outcomes: { _all: "skipped: finances_patch_pending" } }, new Set()).failure).toBeNull();
  });
  it("24's whole pass held for stale inputs (skip_probe_transient, per SKU) fails the step", () => {
    const r = judgeStep({ n: 24, key: "24_delete_dead", name: "delete dead" }, { counts: { skip_probe_transient: 2145 }, outcomes: { "SKU-1": "skip_probe_transient" } }, new Set());
    expect(r.failure).toMatchObject({ count: 2145, reason: "2145 failures with no ASIN named" });
  });
  it("a whole call failing (a 29-style failure row, a counter without outcomes) fails the step", () => {
    expect(judgeStep({ n: 26, key: "26_po_tracking_push", name: "push" }, { counts: { push_failed: 2, pushed: 3 }, outcomes: {} }, new Set()).failure?.reason).toBe("2 failures with no ASIN named");
  });
});

describe("known-persistent: same ASIN, same error, 3 passes in a row", () => {
  const result = { counts: { error: 3, updated: 10 }, outcomes: { [A]: "error: no fee in response", [B]: "error: no fee in response", [C]: "error: There is an internal service failure." } };
  it("persistent ASINs are listed and do not fail the step; the rest fail it with the reason", () => {
    const r = judgeStep(def, result, new Set([A, B]));
    expect(r.persistent).toEqual({ label: "2 ASINs without fees", asins: [{ asin: A, outcome: "error: no fee in response" }, { asin: B, outcome: "error: no fee in response" }] });
    expect(r.failure).toEqual({ n: 13, key: "13_fees", name: "FBA fee estimate", count: 1, reason: "1 ASIN: error: There is an internal service failure." });
    expect(judgeStep(def, result, new Set([A, B, C])).failure).toBeNull();
    expect(stepNotes(r)._step_failed).toBe("1 ASIN: error: There is an internal service failure.");
    expect(persistentLabel("99_x", 1)).toBe("1 ASIN failing every pass");
  });
  it("from the two scheduled passes before this job: the same outcome in both; a different error or a success breaks the streak", async () => {
    const calls: any[] = [];
    const q = (rows: any[]) => (async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; }) as unknown as QueryLike;
    const failing = new Map(Object.entries(result.outcomes));
    const prev = [{ o: { [A]: "error: no fee in response", [B]: "error: no fee in response", [C]: "error: no fee in response" } }, { o: { [A]: "error: no fee in response" } }];
    expect(Array.from(await persistentAsins(q(prev), "13_fees", { id: 9 }, failing))).toEqual([A]);
    expect(calls[0].sql).toMatch(/j\.trigger = 'scheduled' AND rr\.job_id <> \$2/);
    expect(calls[0].params).toEqual(["13_fees", 9, [A, B, C]]);
    expect((await persistentAsins(q(prev.slice(0, 1)), "13_fees", { id: 9 }, failing)).size).toBe(0); // fewer than 2 earlier passes
    const broken = (async () => { throw new Error("db down"); }) as unknown as QueryLike;
    expect((await persistentAsins(broken, "13_fees", { id: 9 }, failing)).size).toBe(0); // never persistent on a failed read
  });
});

describe("the runner marks the step failed and keeps going", () => {
  it("a step with fresh failures: summary.failedSteps, the ledger's _step_failed, the next step still runs, the job reads done", async () => {
    const job: JobRow = { id: 7, kind: "refresh", trigger: "scheduled", target: "main", bulk_list_id: null, include_daily: false, scope_asins: null, components: null, params: null, status: "running", progress: { done: [] }, summary: null, requested_by: null, queued_at: new Date(), started_at: new Date(), finished_at: null, error: null };
    const ledger: any[] = [];
    const query: QueryLike = async (sql, params = []) => {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("SELECT asin FROM asins WHERE status IN")) return { rows: [{ asin: A }, { asin: B }], rowCount: 2 };
      if (s.startsWith("UPDATE jobs SET progress")) return { rows: [], rowCount: 1 };
      if (s.startsWith("SELECT status FROM jobs")) return { rows: [{ status: "running" }], rowCount: 1 };
      if (s.startsWith("UPDATE jobs SET status = $2, summary")) { job.status = params[1]; job.summary = JSON.parse(params[2]); return { rows: [], rowCount: 1 }; }
      if (s.startsWith("INSERT INTO refresh_runs")) { ledger.push({ stage: params[2], outcomes: JSON.parse(params[6]), error: params[7] }); return { rows: [], rowCount: 1 }; }
      if (s.includes("FROM refresh_runs rr JOIN jobs j")) return { rows: [{ o: { [A]: "error: no fee in response" } }, { o: { [A]: "error: no fee in response" } }], rowCount: 2 };
      throw new Error(`unhandled SQL: ${s.slice(0, 80)}`);
    };
    const ran: number[] = [];
    const comps: ComponentDef[] = [
      { n: 13, key: "13_fees", name: "FBA fee estimate", tier: "hourly", kind: "batch", call: "x", run: async () => { ran.push(13); return { counts: { error: 2, updated: 0 }, outcomes: { [A]: "error: no fee in response", [B]: "error: There is an internal service failure." } }; } },
      { n: 14, key: "14_profit", name: "profit", tier: "hourly", kind: "derived", call: "x", run: async () => { ran.push(14); return { counts: {}, outcomes: {} }; } },
    ];
    const s = await runJob(job, { query, sellerId: "S", components: comps, now: () => 0 });
    expect(ran).toEqual([13, 14]);
    expect(job.status).toBe("done");
    expect(s.failedSteps).toEqual([{ n: 13, key: "13_fees", name: "FBA fee estimate", count: 1, reason: "1 ASIN: error: There is an internal service failure." }]);
    expect(s.persistent).toEqual({ "13_fees": { label: "1 ASIN without fees", asins: [{ asin: A, outcome: "error: no fee in response" }] } });
    expect(ledger[0]).toMatchObject({ stage: "13_fees", error: null }); // never refresh_runs.error: listing hygiene reads it as "data not trusted"
    expect(ledger[0].outcomes._step_failed).toBe("1 ASIN: error: There is an internal service failure.");
    expect(ledger[0].outcomes._persistent).toMatch(/^1 ASIN without fees/);
    expect(ledger[1].outcomes._step_failed).toBeUndefined();
    expect(lastPassOf({ id: 7, status: "done", finished_at: null, summary: s })!.failedSteps).toHaveLength(1);
  });
  it("the last pass: clean → no failed steps; a failed pass from before failedSteps still counts as one", () => {
    expect(lastPassOf({ id: 1, status: "done", finished_at: null, summary: { components: {} } })!.failedSteps).toEqual([]);
    expect(lastPassOf({ id: 2, status: "failed", finished_at: null, summary: { stoppedAt: 29 } })!.failedSteps).toHaveLength(1);
    expect(lastPassOf(null)).toBeNull();
  });
});
