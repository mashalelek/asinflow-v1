// Listing hygiene manual entry points (SPEC §11 components 22 / 24).
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { createListingHygieneRouter } from "./listing-hygiene-routes";
import { componentsForJob } from "./scheduler/runner";

let close: (() => void) | null = null;
afterEach(() => { close?.(); close = null; });

async function serve(opts: { role?: string; env?: Record<string, string>; held?: number }) {
  const inserted: any[] = [];
  const query = async (sql: string, params?: any[]) => {
    if (sql.includes("INSERT INTO jobs")) {
      const job = { id: 77, kind: "refresh", trigger: params![0], include_daily: params![3], scope_asins: params![4], components: params![5], params: JSON.parse(params![6]), status: "queued", progress: { done: [] }, queued_at: new Date() };
      inserted.push(job);
      return { rows: [job], rowCount: 1 };
    }
    if (sql.includes("count(*)::int AS n FROM listing_actions")) return { rows: [{ n: opts.held ?? 0 }], rowCount: 1 };
    if (sql.includes("FROM jobs")) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected ${sql.slice(0, 60)}`);
  };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { userId: 1, role: opts.role ?? "admin" }; next(); });
  app.use(createListingHygieneRouter({ query: query as any, env: () => (opts.env ?? {}) as any }));
  const server = app.listen(0);
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: any) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { post, inserted };
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
