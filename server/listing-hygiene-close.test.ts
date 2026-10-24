// Listing hygiene — component 22, close (SPEC §11, patch rules 2 + 5).
import { describe, it, expect, beforeEach } from "vitest";
import { evaluateClose, buildClosePatchBody, CLOSE_BLOCKING, type SkuFacts, type Basis } from "./listing-hygiene";
import { BORN_CLOSED_END_AT, findForbiddenQuantityPaths } from "./offer-add";
import { runHygiene, hygieneDeps } from "./listing-hygiene-run";
import { componentsForJob } from "./scheduler/runner";
import type { JobRow } from "./scheduler/types";
import { facts, fakeQuery, dbRow, fakeSc, ctxOf, okRun } from "./listing-hygiene.test-fixtures";

const NOW = new Date("2026-10-19T14:00:00Z");
const PASS = new Date("2026-10-19T13:00:00Z");
const basis: Basis = { now: NOW, inventoryFrom: PASS, listingFrom: PASS };

describe("close predicate (rule 2)", () => {
  it("all-zero, open, fresh → would_close", () => {
    expect(evaluateClose(facts(), basis)).toMatchObject({ outcome: "would_close", candidate: true });
  });
  for (const b of CLOSE_BLOCKING) {
    it(`${b} alone blocks`, () => {
      expect(evaluateClose(facts({}, { [b]: 1 }), basis)).toMatchObject({ outcome: `skip_has_stock:${b}`, candidate: false });
    });
  }
  it("Available, Inbound ×3, FC Transfer, FC Processing, Reserved and future supply are the blocking set — exactly", () => {
    expect([...CLOSE_BLOCKING].sort()).toEqual(["fulfillable", "future_supply", "inbound_receiving", "inbound_shipped", "inbound_working", "reserved_customer", "reserved_fc_processing", "reserved_fc_transfer"]);
  });
  it("unfulfillable alone does NOT block", () => {
    expect(evaluateClose(facts({}, { unfulfillable: 3 }), basis).outcome).toBe("would_close");
  });
  it("researching alone does NOT block", () => {
    expect(evaluateClose(facts({}, { researching: 2 }), basis).outcome).toBe("would_close");
  });
  it("On Order / At Prep / Velocity are never read by close", () => {
    expect(evaluateClose(facts({ pipeline: { on_order: 50, at_prep: 12 }, velocityOnHand: 30 }), basis).outcome).toBe("would_close");
  });
  it("already closed, no listing, pending §19 submission, amzn.gr, accepted-unverified repeat", () => {
    expect(evaluateClose(facts({ listing: { ...facts().listing, offerEndAt: new Date("2026-10-15T01:55:12Z") } }), basis).outcome).toBe("skip_already_closed");
    expect(evaluateClose(facts({ listing: { ...facts().listing, createdAt: null } }), basis).outcome).toBe("skip_no_listing");
    expect(evaluateClose(facts({ pendingSubmission: true }), basis).outcome).toBe("skip_pending_submission");
    expect(evaluateClose(facts({ sku: "amzn.gr.abc-123" }), basis).outcome).toBe("skip_amzn_gr");
    expect(evaluateClose(facts({ actionPending: true }), basis).outcome).toBe("skip_action_pending");
  });
  it("fail-closed freshness: inventory not from this pass, or 15 incomplete → skip_no_fresh_inventory", () => {
    expect(evaluateClose(facts({ inventory: { ...facts().inventory!, observedAt: new Date("2026-10-19T11:00:00Z") } }), basis).outcome).toBe("skip_no_fresh_inventory");
    expect(evaluateClose(facts(), { ...basis, inventoryFrom: null }).outcome).toBe("skip_no_fresh_inventory");
    expect(evaluateClose(facts({ inventory: null }), basis).outcome).toBe("skip_no_fresh_inventory");
  });
  it("16 transient for the ASIN this pass (stamp not from this pass) → skip_probe_transient", () => {
    expect(evaluateClose(facts({ listing: { ...facts().listing, checkedAt: new Date("2026-10-19T12:20:00Z") } }), basis).outcome).toBe("skip_probe_transient");
  });
});

describe("the close PATCH (§18 rails)", () => {
  const body = buildClosePatchBody("FOOD_STORAGE_CONTAINER");
  it("op merge on /attributes/purchasable_offer — never replace", () => {
    expect(body.patches).toHaveLength(1);
    expect(body.patches[0]).toMatchObject({ op: "merge", path: "/attributes/purchasable_offer" });
    expect(JSON.stringify(body)).not.toMatch(/"replace"/);
  });
  it("end_at = the born-closed date, from the shared helper", () => {
    expect(body.patches[0].value[0].end_at).toEqual({ value: BORN_CLOSED_END_AT });
    expect(body.patches[0].value[0]).toMatchObject({ marketplace_id: "ATVPDKIKX0DER", audience: "ALL", currency: "USD" });
  });
  it("no price field, no quantity key, productType from the listing", () => {
    expect(JSON.stringify(body)).not.toMatch(/our_price|value_with_tax|price/);
    expect(findForbiddenQuantityPaths(body)).toEqual([]);
    expect(body.productType).toBe("FOOD_STORAGE_CONTAINER");
  });
});

const live = (on: boolean) => { hygieneDeps.env = () => (on ? { LISTING_CLOSE_LIVE: "true", LISTING_DELETE_LIVE: "true" } : {}) as any; };
const skus = (n: number) => Array.from({ length: n }, (_, i) => `ZZ-SKU-${String(i).padStart(3, "0")}`);

describe("runHygiene('close')", () => {
  beforeEach(() => { hygieneDeps.now = () => NOW; });

  it("gate unset → dry run: would_close + would_fire rows, ZERO PATCH", async () => {
    live(false);
    const sc = fakeSc({});
    const db = fakeQuery({ run15: okRun, run16: okRun, rows: [dbRow("A-1"), dbRow("A-2", { fulfillable: 4 })] });
    const r = await runHygiene("close", ctxOf(db.query));
    expect(r.outcomes["A-1"]).toBe("would_close");
    expect(r.outcomes["A-2"]).toBe("skip_has_stock:fulfillable");
    expect(sc.patches).toHaveLength(0);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0][4]).toBe(true);           // dry_run
    expect(db.inserts[0][6]).toBe("would_fire");
  });

  it("incomplete / failed 15 → zero closes (every SKU skip_no_fresh_inventory)", async () => {
    live(true);
    const sc = fakeSc({});
    const db = fakeQuery({ run15: { ...okRun, error: "HTTP 500 on page 7" }, run16: okRun, rows: [dbRow("A-1"), dbRow("A-2")] });
    const r = await runHygiene("close", ctxOf(db.query));
    expect(Object.values(r.outcomes).filter((o) => !String(o).includes(" "))).toEqual(["skip_no_fresh_inventory", "skip_no_fresh_inventory"]);
    expect(sc.patches).toHaveLength(0);
  });

  it("live, under the breaker → PATCHes each candidate with the merge body, ledger rows accepted, Changes listed", async () => {
    live(true);
    const sc = fakeSc({});
    const db = fakeQuery({ run15: okRun, run16: okRun, rows: [dbRow("A-1"), dbRow("A-2")], breaker: 25 });
    const r = await runHygiene("close", ctxOf(db.query));
    expect(sc.patches).toHaveLength(2);
    expect(sc.patches[0].body.patches[0].op).toBe("merge");
    expect(r.outcomes["A-1"]).toBe("closed");
    expect(db.inserts.map((p) => p[6])).toEqual(["accepted", "accepted"]);
    expect(r.listingActions).toEqual([{ action: "close", asin: "B000000001", sku: "A-1" }, { action: "close", asin: "B000000001", sku: "A-2" }]);
  });

  it("pre-flight: a SKU closed since the probe is not written", async () => {
    live(true);
    const sc = fakeSc({ "A-1": { end: "2026-10-19T13:50:00Z" } });
    const db = fakeQuery({ run15: okRun, run16: okRun, rows: [dbRow("A-1")] });
    const r = await runHygiene("close", ctxOf(db.query));
    expect(sc.patches).toHaveLength(0);
    expect(r.outcomes["A-1"]).toBe("skip_already_closed");
  });

  it("breaker: 25 candidates fire; 26 → nothing written to SC, every candidate held", async () => {
    live(true);
    let sc = fakeSc({});
    let db = fakeQuery({ run15: okRun, run16: okRun, rows: skus(25).map((s) => dbRow(s)), breaker: 25 });
    await runHygiene("close", ctxOf(db.query));
    expect(sc.patches).toHaveLength(25);

    sc = fakeSc({});
    db = fakeQuery({ run15: okRun, run16: okRun, rows: skus(26).map((s) => dbRow(s)), breaker: 25 });
    const r = await runHygiene("close", ctxOf(db.query));
    expect(sc.patches).toHaveLength(0);
    expect(db.inserts).toHaveLength(26);
    expect(new Set(db.inserts.map((p) => p[6]))).toEqual(new Set(["held"]));
    expect(r.counts.held).toBe(26);
  });

  it("release re-evaluates live: a held SKU that gained stock is dropped, the rest fire", async () => {
    live(true);
    const sc = fakeSc({}, { "ZZ-SKU-001": { fulfillable: 5 } });
    const db = fakeQuery({
      run15: okRun, run16: okRun, rows: [dbRow("ZZ-SKU-000"), dbRow("ZZ-SKU-001")],
      held: [{ id: 1, sku: "ZZ-SKU-000", asin: "B000000001" }, { id: 2, sku: "ZZ-SKU-001", asin: "B000000001" }],
    });
    const r = await runHygiene("close", ctxOf(db.query, { listing_hygiene: { action: "close", mode: "release", release_of_job: 41 } }, "manual"));
    expect(sc.patches.map((p) => decodeURIComponent(p.endpoint.split("/").pop()))).toEqual(["ZZ-SKU-000"]);
    expect(r.outcomes["ZZ-SKU-001"]).toBe("skip_has_stock:fulfillable");
    expect(r.outcomes["ZZ-SKU-000"]).toBe("closed");
    const statusUpdate = db.updates.find((u) => u[0] === 1)!;
    expect(statusUpdate[1]).toBe("accepted");
  });

  it("release is refused when the live gate is unset", async () => {
    live(false);
    fakeSc({});
    const db = fakeQuery({ run15: okRun, run16: okRun, rows: [], held: [] });
    await expect(runHygiene("close", ctxOf(db.query, { listing_hygiene: { action: "close", mode: "release", release_of_job: 41 } }, "manual"))).rejects.toThrow(/LISTING_CLOSE_LIVE is not set/);
  });

  it("a manual run with dryRun stays a dry run even with the gate set", async () => {
    live(true);
    const sc = fakeSc({});
    const db = fakeQuery({ run15: okRun, run16: okRun, rows: [dbRow("A-1")] });
    const r = await runHygiene("close", ctxOf(db.query, { listing_hygiene: { action: "close", mode: "run", dry_run: true } }, "manual"));
    expect(r.outcomes["A-1"]).toBe("would_close");
    expect(sc.patches).toHaveLength(0);
  });

  it("close never calls Velocity", async () => {
    live(true);
    const sc = fakeSc({});
    const db = fakeQuery({ run15: okRun, run16: okRun, rows: [dbRow("A-1")] });
    await runHygiene("close", ctxOf(db.query));
    expect(sc.velocity()).toBe(0);
  });
});

describe("22 runs only where it may", () => {
  const row = (p: Partial<JobRow>) => ({ trigger: "scheduled", include_daily: false, components: null, params: null, ...p }) as JobRow;
  it("daily since 2026-10-20: an hourly scheduled pass skips 22", () => {
    expect(componentsForJob(row({})).map((c) => c.n)).not.toContain(22);
  });
  it("the 00:00 pass runs 22, after 15 and 16 and before 23 and 24", () => {
    const ns = componentsForJob(row({ include_daily: true })).map((c) => c.n);
    const at = (n: number) => ns.indexOf(n);
    expect(at(22)).toBeGreaterThan(-1);
    expect(at(22)).toBeGreaterThan(at(16));
    expect(at(16)).toBeGreaterThan(at(15));
    expect(at(22)).toBeLessThan(at(23));
    expect(at(22)).toBeLessThan(at(24));
  });
  it("a manual Refresh never runs it; its own run / release entry still does", () => {
    expect(componentsForJob(row({ trigger: "manual", include_daily: true })).map((c) => c.n)).not.toContain(22);
    expect(componentsForJob(row({ trigger: "manual", components: [22], params: { listing_hygiene: { action: "close", mode: "run", dry_run: true } } })).map((c) => c.n)).toEqual([22]);
    expect(componentsForJob(row({ trigger: "manual", components: [22], params: { listing_hygiene: { action: "close", mode: "release", release_of_job: 1 } } })).map((c) => c.n)).toEqual([22]);
  });
});

describe("breaker defaults (Maria 2026-10-21)", () => {
  it("close 50, delete 25 when settings has no row; a settings row wins", async () => {
    const { breakerFor, DEFAULT_BREAKER } = await import("./listing-hygiene");
    expect(DEFAULT_BREAKER).toEqual({ close: 50, delete: 25 });
    const none = async () => ({ rows: [], rowCount: 0 });
    expect(await breakerFor("close", none as any)).toBe(50);
    expect(await breakerFor("delete", none as any)).toBe(25);
    expect(await breakerFor("close", (async () => ({ rows: [{ value: 40 }], rowCount: 1 })) as any)).toBe(40);
  });
  it("migration 065 sets production to close 50 / delete 25", () => {
    const sql = require("fs").readFileSync(require("path").join(__dirname, "..", "database", "migrations", "065_hygiene_close_breaker_50.sql"), "utf8");
    expect(sql).toMatch(/'hygiene_close_breaker', '50'::jsonb/);
    expect(sql).toMatch(/'hygiene_delete_breaker', '25'::jsonb/);
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/);
  });
});

describe("hygiene scope: every SKU with an SC listing, whatever the ASIN's AF status (Maria 2026-10-24)", () => {
  beforeEach(() => { hygieneDeps.now = () => NOW; });
  const dead = (sku: string, listing: Parameters<typeof dbRow>[2] = {}) => ({ ...dbRow(sku, {}, listing), asin: "B0DEAD0001" });
  it("a dead ASIN's SKU with an open listing and 0 stock is closed", async () => {
    live(true);
    const sc = fakeSc({});
    const db = fakeQuery({ run15: okRun, run16: okRun, rows: [dbRow("A-1", { fulfillable: 3 }), dead("D-1")], breaker: 25, deadWithListing: ["B0DEAD0001"] });
    const r = await runHygiene("close", ctxOf(db.query)); // scheduled scope = ["B000000001"] only
    expect(r.outcomes["D-1"]).toBe("closed");
    expect(sc.patches.map((p) => decodeURIComponent(p.endpoint.split("/").pop()))).toEqual(["D-1"]);
  });
  it("a dead ASIN with no SC listing stays out of scope — no outcome, no PATCH", async () => {
    live(true);
    const sc = fakeSc({});
    const db = fakeQuery({ run15: okRun, run16: okRun, rows: [dead("D-1")], breaker: 25, deadWithListing: [] });
    const r = await runHygiene("close", ctxOf(db.query));
    expect(r.outcomes["D-1"]).toBeUndefined();
    expect(sc.patches).toHaveLength(0);
  });
  it("a subset job (scope_asins) never widens to dead ASINs", async () => {
    const { hygieneScope } = await import("./listing-hygiene");
    const q = (async () => ({ rows: [{ asin: "B0DEAD0001" }] })) as any;
    expect(await hygieneScope(q, ["B000000001"], ["B000000001"])).toEqual(["B000000001"]);
    expect(await hygieneScope(q, ["B000000001"], null)).toEqual(["B000000001", "B0DEAD0001"]);
    expect(await hygieneScope(q, ["B0DEAD0001"], null)).toEqual(["B0DEAD0001"]);
  });
});
