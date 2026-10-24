// Listing hygiene — component 24, delete (SPEC §11, patch rules 3 + 4).
import { describe, it, expect, beforeEach } from "vitest";
import { evaluateDelete, oosClock, velocityOnHandByAsin, DELETE_BLOCKING, type Basis } from "./listing-hygiene";
import { BUCKET_FIELDS } from "./sku-fba-inventory";
import { runHygiene, hygieneDeps } from "./listing-hygiene-run";
import { componentsForJob } from "./scheduler/runner";
import { facts, fakeSc, dbRow, ctxOf } from "./listing-hygiene.test-fixtures";
import type { JobRow } from "./scheduler/types";

const NOW = new Date("2026-10-19T14:00:00Z"); // ET date 2026-10-19
const PASS = new Date("2026-10-19T13:00:00Z");
const basis: Basis = { now: NOW, inventoryFrom: PASS, listingFrom: PASS };
const closedListing = { checkedAt: new Date("2026-10-19T13:20:00Z"), createdAt: new Date("2026-03-01T00:00:00Z"), offerEndAt: new Date("2026-10-13T12:29:10Z") };
const dead = (p: any = {}, inv: Record<string, number> = {}) => facts({ listing: closedListing, ledgerLastStocked: "2026-07-01", ...p }, inv);

describe("delete predicate (rule 3)", () => {
  it("closed, all-zero, no pipeline, clock run → would_delete", () => {
    expect(evaluateDelete(dead(), basis)).toMatchObject({ outcome: "would_delete", candidate: true });
  });
  it("every bucket blocks — Unfulfillable and Researching included", () => {
    expect([...DELETE_BLOCKING].sort()).toEqual([...BUCKET_FIELDS].sort());
    for (const b of BUCKET_FIELDS) expect(evaluateDelete(dead({}, { [b]: 1 }), basis).outcome).toBe(`skip_has_stock:${b}`);
  });
  it("an open listing is never deleted", () => {
    expect(evaluateDelete(dead({ listing: { ...closedListing, offerEndAt: null } }), basis).outcome).toBe("skip_not_closed");
    expect(evaluateDelete(dead({ listing: { ...closedListing, offerEndAt: new Date("2026-11-01T00:00:00Z") } }), basis).outcome).toBe("skip_not_closed");
  });
  it("each pipeline source alone blocks", () => {
    expect(evaluateDelete(dead({ pipeline: { on_order: 2, at_prep: 0 } }), basis).outcome).toBe("skip_pipeline:on_order");
    expect(evaluateDelete(dead({ pipeline: { on_order: 0, at_prep: 1 } }), basis).outcome).toBe("skip_pipeline:at_prep");
    expect(evaluateDelete(dead({ velocityOnHand: 3 }), basis).outcome).toBe("skip_pipeline:velocity");
  });
  it("Velocity not read → velocity_unavailable (never treated as zero)", () => {
    expect(evaluateDelete(dead({ velocityOnHand: null }), basis).outcome).toBe("velocity_unavailable");
  });
  it("pending §19 submission and amzn.gr skip", () => {
    expect(evaluateDelete(dead({ pendingSubmission: true }), basis).outcome).toBe("skip_pending_submission");
    // amzn.gr.* follows its own rule since 2026-10-21 (see "amzn_gr rule" below).
    expect(evaluateDelete(dead({ sku: "amzn.gr.x-1" }), basis).outcome).toBe("would_delete:amzn_gr");
  });
});

describe("OOS clock (rule 4)", () => {
  it("ever-stocked: 60 days = no, 61 = yes", () => {
    expect(evaluateDelete(dead({ ledgerLastStocked: "2026-08-20" }), basis).outcome).toBe("skip_clock:60/60");
    expect(evaluateDelete(dead({ ledgerLastStocked: "2026-08-19" }), basis).outcome).toBe("would_delete");
  });
  it("never-stocked (no ledger, never nonzero in 15): created 14 days ago = no, 15 = yes", () => {
    const born = (iso: string) => dead({ ledgerLastStocked: null, listing: { ...closedListing, createdAt: new Date(iso) } });
    expect(evaluateDelete(born("2026-10-05T16:00:00Z"), basis).outcome).toBe("skip_clock:14/14");
    expect(evaluateDelete(born("2026-10-04T16:00:00Z"), basis).outcome).toBe("would_delete");
  });
  it("max(ledger, inventory): a lagging ledger can never make a recently stocked SKU look old", () => {
    const f = dead({ ledgerLastStocked: "2026-01-01", inventory: { ...facts().inventory!, lastNonzeroAt: new Date("2026-10-01T15:00:00Z") } });
    expect(oosClock(f, NOW)).toMatchObject({ branch: "ever_stocked", last_stocked: "2026-10-01", days: 18, pass: false });
    expect(evaluateDelete(f, basis).outcome).toBe("skip_clock:18/60");
    // and the other way round: inventory older than the ledger
    const g = dead({ ledgerLastStocked: "2026-10-10", inventory: { ...facts().inventory!, lastNonzeroAt: new Date("2026-02-01T15:00:00Z") } });
    expect(oosClock(g, NOW).last_stocked).toBe("2026-10-10");
  });
  it("inventory_last_nonzero_at alone counts as ever-stocked", () => {
    const f = dead({ ledgerLastStocked: null, inventory: { ...facts().inventory!, lastNonzeroAt: new Date("2026-10-10T15:00:00Z") } });
    expect(oosClock(f, NOW)).toMatchObject({ branch: "ever_stocked", days: 9 });
  });
});

describe("velocityOnHandByAsin", () => {
  it("Σ quantity_remaining > 0 per ASIN, one count per order_id across /inbound and /inventory", () => {
    const m = velocityOnHandByAsin([
      { order_id: "1", asin: "b000000001", quantity_remaining: 4 } as any,
      { order_id: "1", asin: "B000000001", quantity_remaining: 4 } as any,
      { order_id: "2", asin: "B000000001", quantity_remaining: 0 } as any,
      { order_id: "3", asin: "B000000002", quantity_remaining: 2 } as any,
    ]);
    expect(Object.fromEntries(m)).toEqual({ B000000001: 4, B000000002: 2 });
  });
});

// ── runHygiene('delete') against fakes ──────────────────────────────────

const okRun = { error: null, started_at: PASS, finished_at: new Date("2026-10-19T13:40:00Z") };
const goodLedger = { error: null, finished_at: new Date("2026-10-19T04:30:00Z"), counts: { conclusive: 1 } };
function world(o: { ledgerRun?: any; coverage?: any; rows: any[]; breaker?: number }) {
  const inserts: any[][] = [];
  const query = async (sql: string, params?: any[]) => {
    if (sql.includes("stage = '23_ledger'")) return { rows: o.ledgerRun === undefined ? [goodLedger] : o.ledgerRun ? [o.ledgerRun] : [], rowCount: 1 };
    if (sql.includes("FROM refresh_runs")) return { rows: [okRun], rowCount: 1 };
    if (sql.includes("FROM asin_skus s JOIN asins a")) return { rows: o.rows, rowCount: o.rows.length };
    if (sql.includes("FROM settings WHERE key")) {
      if (params?.[0] === "hygiene_ledger_coverage") return { rows: o.coverage === null ? [] : [{ value: o.coverage ?? { from: "2025-04-19", to: "2026-10-18" } }], rowCount: 1 };
      return { rows: [{ value: o.breaker ?? 25 }], rowCount: 1 };
    }
    if (sql.includes("po_asins")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO listing_actions")) { inserts.push(params!); return { rows: [], rowCount: 1 }; }
    if (sql.includes("a.status = 'dead'")) return { rows: [], rowCount: 0 }; // hygiene scope: no dead ASIN with a listing here
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
  return { query, inserts };
}
const deadRow = (sku: string) => ({ ...dbRow(sku, {}, { end: "2026-10-13T12:29:10Z" }), last_stocked_date: "2026-07-01" });
const live = (on: boolean) => { hygieneDeps.env = () => (on ? { LISTING_DELETE_LIVE: "true" } : {}) as any; };

describe("runHygiene('delete')", () => {
  beforeEach(() => { hygieneDeps.now = () => NOW; });

  it("dry run: would_delete, ZERO DELETE", async () => {
    live(false);
    const sc = fakeSc({ "D-1": { end: "2026-10-13T12:29:10Z" } });
    const w = world({ rows: [deadRow("D-1")] });
    const r = await runHygiene("delete", ctxOf(w.query));
    expect(r.outcomes["D-1"]).toBe("would_delete");
    expect(sc.deletes).toHaveLength(0);
    expect(w.inserts[0][6]).toBe("would_fire");
  });

  it("live: DELETE fires after a pre-flight read confirms still closed", async () => {
    live(true);
    const sc = fakeSc({ "D-1": { end: "2026-10-13T12:29:10Z" }, "D-2": { end: null } });
    const w = world({ rows: [deadRow("D-1"), deadRow("D-2")] });
    const r = await runHygiene("delete", ctxOf(w.query));
    expect(sc.deletes.map((e) => decodeURIComponent(e.split("/").pop()!))).toEqual(["D-1"]);
    expect(r.outcomes["D-1"]).toBe("deleted");
    expect(r.outcomes["D-2"]).toBe("skip_not_closed"); // reopened in SC after the probe
    expect(r.listingActions).toEqual([{ action: "delete", asin: "B000000001", sku: "D-1" }]);
  });

  it("empty / inconclusive ledger tonight → zero deletes, every SKU ledger_unavailable", async () => {
    live(true);
    const sc = fakeSc({ "D-1": { end: "2026-10-13T12:29:10Z" } });
    const w = world({ ledgerRun: { ...goodLedger, counts: { conclusive: 0, inconclusive: 1 } }, rows: [deadRow("D-1"), deadRow("D-2")] });
    const r = await runHygiene("delete", ctxOf(w.query));
    expect(r.outcomes["D-1"]).toBe("ledger_unavailable");
    expect(r.outcomes["D-2"]).toBe("ledger_unavailable");
    expect(sc.deletes).toHaveLength(0);
    expect(sc.velocity()).toBe(0);
  });

  it("ledger coverage short of 18 months (backfill not run) → ledger_unavailable", async () => {
    live(true);
    const sc = fakeSc({});
    const r = await runHygiene("delete", ctxOf(world({ coverage: { from: "2026-10-12", to: "2026-10-18" }, rows: [deadRow("D-1")] }).query));
    expect(r.outcomes["D-1"]).toBe("ledger_unavailable");
    expect(r.outcomes._ledger).toMatch(/run the backfill/);
    expect(sc.deletes).toHaveLength(0);
  });

  it("any Velocity leg failing → zero deletes, every SKU velocity_unavailable", async () => {
    live(true);
    const sc = fakeSc({ "D-1": { end: "2026-10-13T12:29:10Z" } });
    hygieneDeps.sc.velocity = async () => { throw new Error("Velocity /inventory coverage incomplete: fetched 180 of 200"); };
    const r = await runHygiene("delete", ctxOf(world({ rows: [deadRow("D-1"), deadRow("D-2")] }).query));
    expect(r.outcomes["D-1"]).toBe("velocity_unavailable");
    expect(r.outcomes["D-2"]).toBe("velocity_unavailable");
    expect(sc.deletes).toHaveLength(0);
  });

  it("breaker: 26 delete candidates → nothing deleted, all held", async () => {
    live(true);
    const rows = Array.from({ length: 26 }, (_, i) => deadRow(`ZZ-DEL-${i}`));
    const sc = fakeSc(Object.fromEntries(rows.map((r) => [r.sku, { end: "2026-10-13T12:29:10Z" }])));
    const w = world({ rows, breaker: 25 });
    const r = await runHygiene("delete", ctxOf(w.query));
    expect(sc.deletes).toHaveLength(0);
    expect(r.counts.held).toBe(26);
  });
});

describe("24 runs only in the 00:00 pass (and its own entry points)", () => {
  const row = (p: Partial<JobRow>) => ({ trigger: "scheduled", include_daily: false, components: null, params: null, ...p }) as JobRow;
  it("00:00 pass yes; hourly pass no; manual Refresh no", () => {
    expect(componentsForJob(row({ include_daily: true })).map((c) => c.n)).toContain(24);
    expect(componentsForJob(row({})).map((c) => c.n)).not.toContain(24);
    expect(componentsForJob(row({ trigger: "manual", include_daily: true })).map((c) => c.n)).not.toContain(24);
  });
  it("the manual entry point: components [24] + params.listing_hygiene.action = delete", () => {
    expect(componentsForJob(row({ trigger: "manual", components: [24], params: { listing_hygiene: { action: "delete", mode: "run", dry_run: true } } })).map((c) => c.n)).toEqual([24]);
  });
});

describe("amzn_gr delete rule (Maria 2026-10-21)", () => {
  const openListing = { checkedAt: new Date("2026-10-19T13:20:00Z"), createdAt: new Date("2026-10-18T00:00:00Z"), offerEndAt: null };
  const gr = (p: any = {}, inv: Record<string, number> = {}) =>
    facts({ sku: "amzn.gr.DG-KQD5-CI6K-wzvNsv2Ebw8vUIXe-VG", listing: openListing, ledgerLastStocked: "2026-10-18", pipeline: { on_order: 9, at_prep: 4 }, velocityOnHand: 7, ...p }, inv);

  it("all buckets 0 and an OPEN listing → delete — no closed state, no clock, no pipeline", () => {
    const e = evaluateDelete(gr(), basis);
    expect(e).toMatchObject({ outcome: "would_delete:amzn_gr", candidate: true });
    expect(e.evidence.rule).toBe("amzn_gr");
  });
  it("Velocity not read (run-wide outage) does not matter to it", () => {
    expect(evaluateDelete(gr({ velocityOnHand: null }), basis).outcome).toBe("would_delete:amzn_gr");
  });
  it("any bucket > 0 → skip_has_stock:<bucket> (Unfulfillable and Researching included)", () => {
    for (const b of BUCKET_FIELDS) expect(evaluateDelete(gr({}, { [b]: 2 }), basis).outcome).toBe(`skip_has_stock:${b}`);
  });
  it("keeps the freshness gate and the action-pending guard; no listing → skip_no_listing first", () => {
    expect(evaluateDelete(gr({ inventory: { ...facts().inventory!, observedAt: new Date("2026-10-19T11:00:00Z") } }), basis).outcome).toBe("skip_no_fresh_inventory");
    expect(evaluateDelete(gr({ actionPending: true }), basis).outcome).toBe("skip_action_pending");
    expect(evaluateDelete(gr({ listing: { ...openListing, createdAt: null } }), basis).outcome).toBe("skip_no_listing");
  });
  it("component 22 still never closes an amzn.gr SKU; with no listing it reports skip_no_listing", async () => {
    const { evaluateClose } = await import("./listing-hygiene");
    expect(evaluateClose(gr(), basis).outcome).toBe("skip_amzn_gr");
    expect(evaluateClose(gr({ listing: { ...openListing, createdAt: null } }), basis).outcome).toBe("skip_no_listing");
  });
  it("live: the DELETE fires on an open listing (no skip_not_closed pre-flight) and records deleted:amzn_gr", async () => {
    live(true);
    hygieneDeps.now = () => NOW;
    const sku = "amzn.gr.DG-KQD5-CI6K-wzvNsv2Ebw8vUIXe-VG";
    const sc = fakeSc({ [sku]: { end: null } });
    const row = { ...dbRow(sku), last_stocked_date: "2026-10-18" };
    const w = world({ rows: [row] });
    const r = await runHygiene("delete", ctxOf(w.query));
    expect(sc.deletes.map((e) => decodeURIComponent(e.split("/").pop()!))).toEqual([sku]);
    expect(r.outcomes[sku]).toBe("deleted:amzn_gr");
    expect(w.inserts[0][6]).toBe("accepted");
    expect(JSON.parse(w.inserts[0][5]).rule).toBe("amzn_gr");
  });
  it("a run-wide ledger outage skips the regular deletes but still evaluates amzn.gr SKUs", async () => {
    live(false);
    hygieneDeps.now = () => NOW;
    const sku = "amzn.gr.X2-TEST-0000-aaaa-PO";
    fakeSc({ [sku]: { end: null } });
    const w = world({ ledgerRun: { ...goodLedger, counts: { conclusive: 0 } }, rows: [deadRow("D-1"), dbRow(sku)] });
    const r = await runHygiene("delete", ctxOf(w.query));
    expect(r.outcomes["D-1"]).toBe("ledger_unavailable");
    expect(r.outcomes[sku]).toBe("would_delete:amzn_gr");
  });
});
