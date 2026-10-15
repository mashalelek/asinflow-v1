import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("../index", () => ({ log: () => {} }));

import { runJob, setRunnerLogger } from "./runner";
import { resolveBulkScope, runBulkPublic, copyMainToBulk, enqueueBulkRefresh, bulkRefreshStatus, type BulkPasses } from "./bulk";
import type { JobRow, QueryLike, ComponentDef } from "./types";

// Scheduler patch commit 3: Bulk Calc Refresh is a bulk-target job
// (decision 5). Catalog ASINs run the main components then copy main →
// bulk; non-catalog ASINs run the public components against bulk tables
// only; nothing ever writes bulk → main.

setRunnerLogger(() => {});

const LIST = "11111111-1111-1111-1111-111111111111";

function bulkJob(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 5, kind: "refresh", trigger: "bulk", target: "bulk", bulk_list_id: LIST, include_daily: true,
    scope_asins: null, components: null, status: "running", progress: { done: [] }, summary: null, requested_by: null,
    queued_at: new Date(), started_at: new Date(), finished_at: null, error: null, ...over,
  };
}

/** Shim DB: list rows, catalog membership, bulk_list_asins writes recorded. */
function makeDb(opts: { listAsins: string[]; catalog: string[]; job: JobRow }) {
  const sql: Array<{ s: string; params: any[] }> = [];
  const job = opts.job;
  const ledger: any[] = [];
  const query: QueryLike = async (text, params = []) => {
    const s = text.replace(/\s+/g, " ").trim();
    sql.push({ s, params });
    if (s.startsWith("SELECT asin FROM bulk_list_asins WHERE list_id")) return { rows: opts.listAsins.map((asin) => ({ asin })), rowCount: 0 };
    if (s.startsWith("SELECT asin, fetched_at, price_outcome FROM bulk_list_asins")) return { rows: opts.listAsins.map((asin) => ({ asin, fetched_at: null, price_outcome: null })), rowCount: 0 };
    if (s.startsWith("SELECT asin FROM asins WHERE asin = ANY")) return { rows: opts.catalog.filter((a) => params[0].includes(a)).map((asin) => ({ asin })), rowCount: 0 };
    if (s.startsWith("SELECT asin, category FROM bulk_list_asins")) return { rows: params[1].map((asin: string) => ({ asin, category: null })), rowCount: 0 };
    if (s.startsWith("UPDATE jobs SET progress")) { job.progress = JSON.parse(params[1]); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("SELECT status FROM jobs")) return { rows: [{ status: job.status }], rowCount: 1 };
    if (s.startsWith("UPDATE jobs SET status = $2, summary")) { job.status = params[1]; job.summary = JSON.parse(params[2]); job.error = params[3]; return { rows: [], rowCount: 1 }; }
    if (s.startsWith("INSERT INTO refresh_runs")) { ledger.push({ stage: params[2], scope: params[3], requested: params[4], counts: JSON.parse(params[5]) }); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("UPDATE bulk_list_asins b SET")) return { rows: [], rowCount: params[1].length };
    if (s.startsWith("UPDATE bulk_list_asins")) return { rows: [], rowCount: 1 };
    if (s.startsWith("INSERT INTO jobs")) return { rows: [{ ...job, id: 9, status: "queued", scope_asins: params[4], trigger: params[0], target: params[1], bulk_list_id: params[2], include_daily: params[3] }], rowCount: 1 };
    if (s.startsWith("SELECT id, kind, trigger, target, bulk_list_id, include_daily, scope_asins, components, status, progress, summary, requested_by, queued_at, started_at, finished_at, error FROM jobs WHERE status IN")) return { rows: [], rowCount: 0 };
    throw new Error(`unhandled SQL in bulk shim: ${s.slice(0, 90)}`);
  };
  return { sql, ledger, job, query };
}

const fakePasses = (): BulkPasses & { seen: Record<string, string[]> } => {
  const seen: Record<string, string[]> = { catalog: [], hazmat: [], gating: [], prices: [], fees: [] };
  return {
    seen,
    fetchCatalogBatch: async (asins) => { seen.catalog.push(...asins); return new Map(asins.map((a) => [a, { kind: "parsed", data: { title: `T ${a}`, imageUrl: null, brand: "B", weightLbs: 1, bsrRank: 5, bsrCategory: "Cat", isMeltable: false, isDangerousGood: false, isCatalogDeleted: false } } as any])); },
    getInboundHazmat: async (a) => { seen.hazmat.push(a); return { kind: "ok", isHazmat: false }; },
    getEligibility: async (a) => { seen.gating.push(a); return { kind: "ok", status: "yes" }; },
    runPricePass: async (asins, write) => {
      seen.prices.push(...asins);
      const parsed = new Map<string, any>();
      for (const a of asins) { const po: any = { lowestFbaPrice: 12, buyBoxPrice: 12, buyBoxFulfillment: "FBA", lowestPrice: 12, numberOfSellers: 1, sellersFba: 1, sellersFbm: 0, competitivePriceThreshold: null, noOffers: false }; parsed.set(a, po); if (write) await write(a, po); }
      return { counts: { updated: asins.length, no_offers: 0, restricted: 0, not_found: 0, invalid_asin: 0, throttled: 0, error: 0 } as any, outcomes: {}, parsed };
    },
    runFeesPass: async (items, write) => { seen.fees.push(...items.map((i) => i.asin)); for (const i of items) if (write) await write(i.asin, { fbaFulfillmentFee: 3, referralFee: 1.8, feesEstimatePrice: i.price }); return { counts: { updated: items.length, error: 0 }, outcomes: {} }; },
  };
};

describe("resolveBulkScope", () => {
  it("partitions the list into catalog vs public-only, honouring an explicit subset", async () => {
    const db = makeDb({ listAsins: ["A1", "A2", "A3", "A4"], catalog: ["A2", "A4"], job: bulkJob() });
    const s = await resolveBulkScope(db.job, db.query);
    expect(s).toEqual({ listId: LIST, listAsins: ["A1", "A2", "A3", "A4"], inCatalog: ["A2", "A4"], publicOnly: ["A1", "A3"] });
    const db2 = makeDb({ listAsins: ["A1", "A2", "A3"], catalog: ["A2"], job: bulkJob({ scope_asins: ["A1", "A2"] }) });
    expect((await resolveBulkScope(db2.job, db2.query)).listAsins).toEqual(["A1", "A2"]);
  });
});

describe("runJob with target bulk", () => {
  const stub = (n: number, kind: ComponentDef["kind"], seen: Record<number, string[]>): ComponentDef =>
    ({ n, key: `${String(n).padStart(2, "0")}_stub`, name: "", tier: "hourly", kind, call: "", run: async (ctx) => { seen[n] = ctx.asins; return { counts: { seen: ctx.asins.length }, outcomes: {} }; } });

  it("catalog ASINs: main components see only them; then the public pass runs the rest; then main → bulk copy", async () => {
    const seen: Record<number, string[]> = {};
    const comps = [stub(10, "batch", seen), stub(15, "account", seen)];
    const passes = fakePasses();
    const db = makeDb({ listAsins: ["A1", "A2", "A3", "A4"], catalog: ["A2", "A4"], job: bulkJob() });
    const sum = await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0, bulkPasses: passes });
    expect(db.job.status).toBe("done");
    expect(seen[10]).toEqual(["A2", "A4"]);
    expect(seen[15]).toEqual(["A2", "A4"]);
    expect(passes.seen.catalog).toEqual(["A1", "A3"]);
    expect(passes.seen.prices).toEqual(["A1", "A3"]);
    expect(passes.seen.fees).toEqual(["A1", "A3"]);
    // order: main components, then the bulk public stages, then the copy
    const order = db.sql.map((x) => x.s);
    const copyIdx = order.findIndex((s) => s.startsWith("UPDATE bulk_list_asins b SET"));
    const lastBulkWrite = order.map((s, i) => (s.startsWith("UPDATE bulk_list_asins SET") ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(copyIdx).toBeGreaterThan(lastBulkWrite);
    expect(db.sql[copyIdx].params).toEqual([LIST, ["A2", "A4"]]);
    expect(sum.components["bulk:copy"]).toEqual({ copied: 2 });
    expect(sum.components["bulk:prices"]).toMatchObject({ updated: 2 });
    expect(db.ledger.map((l) => [l.stage, l.scope])).toEqual([
      ["10_stub", `bulk:${LIST}`], ["15_stub", `bulk:${LIST}`],
      ["bulk:catalog", `bulk:${LIST}`], ["bulk:hazmat", `bulk:${LIST}`], ["bulk:gating", `bulk:${LIST}`], ["bulk:prices", `bulk:${LIST}`], ["bulk:fees", `bulk:${LIST}`],
    ]);
    expect(sum.asins).toBe(4);
  });

  it("a list with no catalog ASINs runs no main component; public-only everything", async () => {
    const seen: Record<number, string[]> = {};
    const comps = [stub(1, "account", seen), stub(10, "batch", seen)];
    const passes = fakePasses();
    const db = makeDb({ listAsins: ["A1", "A3"], catalog: [], job: bulkJob() });
    const sum = await runJob(db.job, { query: db.query, sellerId: "S", components: comps, now: () => 0, bulkPasses: passes });
    expect(seen).toEqual({});
    expect(passes.seen.hazmat).toEqual(["A1", "A3"]);
    expect(sum.components["bulk:copy"]).toEqual({ copied: 0 });
    expect(db.job.status).toBe("done");
  });

  it("the public pass never writes asins / asin_estimates (bulk → main is impossible)", async () => {
    const passes = fakePasses();
    const db = makeDb({ listAsins: ["A1"], catalog: [], job: bulkJob() });
    await runBulkPublic({ job: db.job, query: db.query, listId: LIST, asins: ["A1"], log: () => {}, passes });
    const writes = db.sql.map((x) => x.s).filter((s) => /^(UPDATE|INSERT INTO|DELETE FROM)/.test(s) && !s.startsWith("INSERT INTO refresh_runs"));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((s) => s.startsWith("UPDATE bulk_list_asins"))).toBe(true);
  });

  it("source: bulk.ts has no asins / asin_estimates write statement at all", () => {
    const src = readFileSync(join(__dirname, "bulk.ts"), "utf8");
    expect(src).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+asins\b/);
    expect(src).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+asin_estimates\b/);
    expect(src).toMatch(/UPDATE bulk_list_asins b SET/); // the one main → bulk copy
    expect(src).not.toMatch(/bulk_gating_hazmat_cache|staleOrNever|THIRTY_D/);
  });

  it("copyMainToBulk is a no-op for an empty list", async () => {
    const db = makeDb({ listAsins: [], catalog: [], job: bulkJob() });
    expect(await copyMainToBulk(LIST, [], db.query)).toBe(0);
    expect(db.sql).toHaveLength(0);
  });
});

describe("enqueueBulkRefresh + status", () => {
  it("scope 'failed' = never-fetched / non-conclusive rows, falling back to all; explicit asins win", async () => {
    const db = makeDb({ listAsins: ["A1", "A2"], catalog: [], job: bulkJob() });
    const r = await enqueueBulkRefresh(LIST, { scope: "failed" }, db.query);
    expect(r.kind).toBe("queued");
    if (r.kind === "queued") {
      expect(r.job.scope_asins).toEqual(["A1", "A2"]);
      expect(r.job.target).toBe("bulk");
      expect(r.job.include_daily).toBe(true);
    }
    const r2 = await enqueueBulkRefresh(LIST, { scope: "all", asins: ["a2"] }, db.query);
    expect(r2.kind === "queued" && r2.job.scope_asins).toEqual(["A2"]);
  });

  it("an empty list is reported, not queued", async () => {
    const db = makeDb({ listAsins: [], catalog: [], job: bulkJob() });
    expect((await enqueueBulkRefresh(LIST, { scope: "all" }, db.query)).kind).toBe("empty");
  });

  it("status maps the active job's progress into the shape the Bulk Calc page polls", async () => {
    const q: QueryLike = async () => ({ rows: [{ id: 5, status: "running", progress: { component: 10, position: 3, total: 8 }, started_at: "x", finished_at: null, error: null }], rowCount: 1 });
    expect(await bulkRefreshStatus(LIST, q)).toMatchObject({ jobId: 5, status: "running", stage: "component 10", current: 3, total: 8 });
    const none: QueryLike = async () => ({ rows: [], rowCount: 0 });
    expect(await bulkRefreshStatus(LIST, none)).toBeNull();
  });
});
