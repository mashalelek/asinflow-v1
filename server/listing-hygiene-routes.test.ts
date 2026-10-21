// Listing hygiene manual entry points (SPEC §11 components 22 / 24).
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { createListingHygieneRouter } from "./listing-hygiene-routes";
import { componentsForJob } from "./scheduler/runner";

let close: (() => void) | null = null;
afterEach(() => { close?.(); close = null; });

async function serve(opts: { role?: string; env?: Record<string, string>; held?: number; priorRelease?: { id: number; status: string }; holdGroups?: any[] }) {
  const inserted: any[] = [];
  const query = async (sql: string, params?: any[]) => {
    if (sql.includes("INSERT INTO jobs")) {
      const job = { id: 77, kind: "refresh", trigger: params![0], include_daily: params![3], scope_asins: params![4], components: params![5], params: JSON.parse(params![6]), status: "queued", progress: { done: [] }, queued_at: new Date() };
      inserted.push(job);
      return { rows: [job], rowCount: 1 };
    }
    if (sql.includes("count(*)::int AS n FROM listing_actions")) return { rows: [{ n: opts.held ?? 0 }], rowCount: 1 };
    if (sql.includes("GROUP BY la.job_id, la.action")) return { rows: opts.holdGroups ?? [], rowCount: (opts.holdGroups ?? []).length };
    if (sql.includes("params->'listing_hygiene'->>'mode' = 'release'")) {
      const p = opts.priorRelease;
      return { rows: p && ["queued", "running", "done"].includes(p.status) ? [p] : [], rowCount: p ? 1 : 0 };
    }
    if (sql.includes("FROM jobs")) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected ${sql.slice(0, 60)}`);
  };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { userId: 1, role: opts.role ?? "admin" }; next(); });
  const locks: Array<[number, string]> = [];
  app.use(createListingHygieneRouter({
    query: query as any, env: () => (opts.env ?? {}) as any,
    inReleaseLock: async (jobId, action, fn) => { locks.push([jobId, action]); return fn(query as any); },
  }));
  const server = app.listen(0);
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string) => fetch(base + path);
  const post = (path: string, body: any) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { post, get, inserted, locks };
}

describe("POST /api/listing-hygiene/run", () => {
  it("dry run of close → a one-component lane-M job [22] over the scheduled scope, which the runner will actually run", async () => {
    const s = await serve({});
    const r = await s.post("/api/listing-hygiene/run", { action: "close", dryRun: true });
    expect(r.status).toBe(202);
    const job = s.inserted[0];
    expect(job).toMatchObject({ trigger: "manual", components: [22], scope_asins: null, params: { listing_hygiene: { action: "close", mode: "run", dry_run: true } } });
    expect(componentsForJob(job).map((c) => c.n)).toEqual([22]);
  });
  it("delete → [24]", async () => {
    const s = await serve({});
    await s.post("/api/listing-hygiene/run", { action: "delete", dryRun: true });
    expect(s.inserted[0].components).toEqual([24]);
  });
  it("a live run is refused (409) while the gate is unset", async () => {
    const s = await serve({});
    const r = await s.post("/api/listing-hygiene/run", { action: "close", dryRun: false });
    expect(r.status).toBe(409);
    expect((await r.json()).message).toMatch(/LISTING_CLOSE_LIVE is not set/);
    expect(s.inserted).toHaveLength(0);
  });
  it("admin only; action and dryRun validated", async () => {
    expect((await (await serve({ role: "member" })).post("/api/listing-hygiene/run", { action: "close", dryRun: true })).status).toBe(403);
    const s = await serve({});
    expect((await s.post("/api/listing-hygiene/run", { action: "reopen", dryRun: true })).status).toBe(400);
    expect((await s.post("/api/listing-hygiene/run", { action: "close" })).status).toBe(400);
  });
});

describe("POST /api/listing-hygiene/release", () => {
  it("enqueues a release job for the held candidates of that job", async () => {
    const s = await serve({ env: { LISTING_CLOSE_LIVE: "true" }, held: 30 });
    const r = await s.post("/api/listing-hygiene/release", { job_id: 41, action: "close" });
    expect(r.status).toBe(202);
    expect((await r.json()).held).toBe(30);
    expect(s.inserted[0]).toMatchObject({ components: [22], params: { listing_hygiene: { action: "close", mode: "release", release_of_job: 41 } } });
  });
  it("refused when the gate is unset, or nothing is held", async () => {
    expect((await (await serve({ held: 30 })).post("/api/listing-hygiene/release", { job_id: 41, action: "close" })).status).toBe(409);
    expect((await (await serve({ env: { LISTING_CLOSE_LIVE: "true" }, held: 0 })).post("/api/listing-hygiene/release", { job_id: 41, action: "close" })).status).toBe(409);
  });
});

describe("no duplicate releases (Maria 2026-10-21)", () => {
  for (const status of ["queued", "running", "done"]) {
    it(`a release already ${status} for the job + action → 409 already_released, nothing enqueued`, async () => {
      const s = await serve({ env: { LISTING_DELETE_LIVE: "true" }, held: 162, priorRelease: { id: 136, status } });
      const r = await s.post("/api/listing-hygiene/release", { job_id: 123, action: "delete" });
      expect(r.status).toBe(409);
      const b = await r.json();
      expect(b.error).toBe("already_released");
      expect(b.message).toMatch(/already released \(job #136/);
      expect(s.inserted).toHaveLength(0);
    });
  }
  it("a failed (or cancelled) release does not block a retry", async () => {
    const s = await serve({ env: { LISTING_DELETE_LIVE: "true" }, held: 5, priorRelease: { id: 136, status: "failed" } });
    expect((await s.post("/api/listing-hygiene/release", { job_id: 123, action: "delete" })).status).toBe(202);
  });
  it("the check and the enqueue run inside the per-(job, action) lock", async () => {
    const s = await serve({ env: { LISTING_CLOSE_LIVE: "true" }, held: 3 });
    await s.post("/api/listing-hygiene/release", { job_id: 41, action: "close" });
    expect(s.locks).toEqual([[41, "close"]]);
    expect(s.inserted).toHaveLength(1);
  });
});

describe("superseded holds and the pending endpoint (Action required)", () => {
  const g = (job_id: number, action: string, total: number, open: number, released = false) => ({ job_id, action, total, open, released, held_at: "2026-10-21T05:42:49Z" });
  it("releasing an older hold after a newer night's hold → 409 superseded", async () => {
    const s = await serve({ env: { LISTING_DELETE_LIVE: "true" }, held: 30, holdGroups: [g(123, "delete", 162, 30), g(140, "delete", 31, 31)] });
    const r = await s.post("/api/listing-hygiene/release", { job_id: 123, action: "delete" });
    expect(r.status).toBe(409);
    expect((await r.json()).message).toMatch(/superseded by job #140/);
    expect(s.inserted).toHaveLength(0);
  });
  it("GET /pending returns the newest unreleased hold per action", async () => {
    const s = await serve({ holdGroups: [g(123, "delete", 162, 162, true), g(140, "delete", 31, 31), g(140, "close", 60, 60)] });
    const b = await (await s.get("/api/listing-hygiene/pending")).json();
    expect(b.pending.delete).toMatchObject({ job_id: 140, count: 31 });
    expect(b.pending.close).toMatchObject({ job_id: 140, count: 60 });
  });
});
