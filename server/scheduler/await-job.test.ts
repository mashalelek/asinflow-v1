import { describe, it, expect } from "vitest";
import { runJobAndWait, describeJobState, JobFailedError, AWAIT_TIMEOUT_MS } from "./await-job";
import type { JobRow, QueryLike } from "./types";

// Decision 9 (scheduler patch commit 4): Add to SC and Push to Aura enqueue
// a one-component manual job for their selection and WAIT for it. This is
// the waiting primitive, driven here by an in-memory jobs table whose
// status the test script flips between polls.

function fakeJobs(script: Array<(row: any) => void>) {
  const rows: any[] = [];
  const sql: string[] = [];
  let step = 0;
  const query: QueryLike = async (text, params) => {
    sql.push(text);
    const t = text.replace(/\s+/g, " ").trim();
    if (t.startsWith("INSERT INTO jobs")) {
      const row = {
        id: rows.length + 1, kind: "refresh", trigger: params![0], target: params![1], bulk_list_id: params![2],
        include_daily: params![3], scope_asins: params![4], components: params![5], requested_by: params![6],
        status: "queued", progress: {}, summary: null, queued_at: new Date(2026, 9, 15, 12, 0, rows.length), started_at: null, finished_at: null, error: null,
      };
      rows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/^SELECT .* FROM jobs WHERE id = \$1/.test(t)) return { rows: rows.filter((r) => r.id === params![0]), rowCount: 1 };
    if (/^SELECT .* FROM jobs WHERE status IN \('running','queued'\)/.test(t)) return { rows: rows.filter((r) => r.status === "running" || r.status === "queued"), rowCount: 1 };
    if (t.startsWith("UPDATE jobs SET status = 'cancelled'")) {
      const r = rows.find((x) => x.id === params![0] && (x.status === "queued" || x.status === "running"));
      if (!r) return { rows: [], rowCount: 0 };
      r.status = "cancelled";
      return { rows: [r], rowCount: 1 };
    }
    throw new Error(`unexpected sql: ${t.slice(0, 80)}`);
  };
  // Each sleep runs the next script step against the newest job.
  const sleep = async () => { const fn = script[step++]; if (fn) fn(rows[rows.length - 1]); };
  return { query, sleep, rows, sql };
}

describe("runJobAndWait", () => {
  it("enqueues with the explicit component list and resolves with the finished job", async () => {
    const f = fakeJobs([
      (r) => { r.status = "running"; r.progress = { component: 8, position: 1, total: 3, done: [] }; },
      (r) => { r.status = "done"; r.summary = { asins: 3, durationMs: 10, components: { "08_gating": { updated: 3 } }, flips: [] }; },
    ]);
    const seen: string[] = [];
    const job = await runJobAndWait(
      { trigger: "manual", includeDaily: false, components: [8], scopeAsins: ["B1", "B2", "B3"], requestedBy: 7 },
      { query: f.query, sleep: f.sleep, onStatus: (s) => seen.push(s) },
    );
    expect(job.status).toBe("done");
    expect(job.summary?.components["08_gating"]).toEqual({ updated: 3 });
    // The INSERT carried components=[8], the selection, and who asked.
    expect(f.rows[0].components).toEqual([8]);
    expect(f.rows[0].scope_asins).toEqual(["B1", "B2", "B3"]);
    expect(f.rows[0].requested_by).toBe(7);
    expect(f.rows[0].include_daily).toBe(false);
    expect(seen).toEqual(["queued", "running component 8 1/3", "done"]);
  });

  it("reports the queue position while a pass runs ahead of it", async () => {
    const f = fakeJobs([(r) => { r.status = "done"; }]);
    // a scheduled pass already running
    await f.query(`INSERT INTO jobs (kind, trigger, target, bulk_list_id, include_daily, scope_asins, components, requested_by) VALUES ('refresh', $1, $2, $3, $4, $5, $6, $7) RETURNING x`, ["scheduled", "main", null, false, null, null, null]);
    f.rows[0].status = "running";
    const seen: string[] = [];
    await runJobAndWait({ trigger: "manual", includeDaily: false, components: [9], scopeAsins: null }, { query: f.query, sleep: f.sleep, onStatus: (s) => seen.push(s) });
    expect(seen[0]).toBe("queued (1 ahead)");
  });

  it("rejects with JobFailedError when the job fails — the caller must not proceed", async () => {
    const f = fakeJobs([(r) => { r.status = "failed"; r.error = "throttled"; r.summary = { asins: 1, durationMs: 1, components: {}, flips: [], stoppedAt: 8 }; }]);
    await expect(runJobAndWait({ trigger: "manual", includeDaily: false, components: [8], scopeAsins: ["B1"] }, { query: f.query, sleep: f.sleep }))
      .rejects.toThrow(/refresh job 1 failed at component 8: throttled/);
  });

  it("rejects when the job is cancelled from elsewhere", async () => {
    const f = fakeJobs([(r) => { r.status = "cancelled"; }]);
    await expect(runJobAndWait({ trigger: "manual", includeDaily: false, components: [9], scopeAsins: null }, { query: f.query, sleep: f.sleep }))
      .rejects.toBeInstanceOf(JobFailedError);
  });

  it("cancels the job and rejects when the timeout elapses first", async () => {
    const f = fakeJobs([() => {}, () => {}, () => {}]);
    let t = 0;
    const now = () => t;
    const sleep = async () => { t += 10_000; await f.sleep(); };
    await expect(runJobAndWait({ trigger: "manual", includeDaily: false, components: [8], scopeAsins: ["B1"] }, { query: f.query, sleep, now, timeoutMs: 25_000 }))
      .rejects.toThrow(/did not finish within 0 min .*cancelled/);
    expect(f.rows[0].status).toBe("cancelled");
  });

  it("the default timeout is an hour — long enough to queue behind a full scheduled pass", () => {
    expect(AWAIT_TIMEOUT_MS).toBe(60 * 60_000);
  });

  it("describeJobState", () => {
    expect(describeJobState({ status: "queued" } as JobRow, 0)).toBe("queued");
    expect(describeJobState({ status: "queued" } as JobRow, 2)).toBe("queued (2 ahead)");
    expect(describeJobState({ status: "running", progress: { component: 9, done: [] } } as unknown as JobRow, 0)).toBe("running component 9");
    expect(describeJobState({ status: "running", progress: { component: 8, position: 40, total: 100, done: [] } } as unknown as JobRow, 0)).toBe("running component 8 40/100");
  });
});
