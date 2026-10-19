// Listing hygiene — component 22, close (SPEC §11, patch rules 2 + 5).
import { describe, it, expect, beforeEach } from "vitest";
import { evaluateClose, buildClosePatchBody, CLOSE_BLOCKING, type SkuFacts, type Basis } from "./listing-hygiene";
import { BUCKET_FIELDS } from "./sku-fba-inventory";
import { BORN_CLOSED_END_AT, findForbiddenQuantityPaths } from "./offer-add";
import { runHygiene, hygieneDeps } from "./listing-hygiene-run";
import { componentsForJob } from "./scheduler/runner";
import type { ComponentContext, JobRow } from "./scheduler/types";

const NOW = new Date("2026-10-19T14:00:00Z");
const PASS = new Date("2026-10-19T13:00:00Z");
const zero = () => Object.fromEntries(BUCKET_FIELDS.map((f) => [f, 0])) as any;
export function facts(p: Partial<SkuFacts> = {}, inv: Record<string, number> = {}): SkuFacts {
  return {
    sku: "ABC-DEF-001", asin: "B000000001", asins: ["B000000001"],
    listing: { checkedAt: new Date("2026-10-19T13:20:00Z"), createdAt: new Date("2026-03-01T00:00:00Z"), offerEndAt: null },
    inventory: { ...zero(), ...inv, observedAt: new Date("2026-10-19T13:05:00Z"), lastNonzeroAt: null },
    pendingSubmission: false, actionPending: false, ledgerLastStocked: null,
    pipeline: { on_order: 0, at_prep: 0 }, velocityOnHand: 0, ...p,
  };
}
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

// ── runHygiene against a fake DB + fake SC ──────────────────────────────

interface World {
  run15?: { error: string | null; finished_at: Date; started_at: Date } | null;
  run16?: { error: string | null; finished_at: Date; started_at: Date } | null;
  rows: any[];
  breaker?: number;
  held?: any[];
}
export function fakeQuery(w: World) {
  const inserts: any[][] = [];
  const updates: any[][] = [];
  const query = async (sql: string, params?: any[]) => {
    if (sql.includes("FROM refresh_runs")) {
      const r = params?.[0] === "15_inventory" ? w.run15 : params?.[0] === "16_live_offer" ? w.run16 : null;
      return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
    }
    if (sql.includes("FROM asin_skus s JOIN asins a")) return { rows: w.rows, rowCount: w.rows.length };
    if (sql.includes("FROM settings WHERE key")) return { rows: w.breaker == null ? [] : [{ value: w.breaker }], rowCount: 1 };
    if (sql.includes("INSERT INTO listing_actions")) { inserts.push(params!); return { rows: [], rowCount: 1 }; }
    if (sql.includes("FROM listing_actions") && sql.includes("status = 'held'")) return { rows: w.held ?? [], rowCount: (w.held ?? []).length };
    if (sql.includes("UPDATE listing_actions")) { updates.push(params!); return { rows: [], rowCount: 1 }; }
    if (sql.includes("po_asins")) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  };
  return { query, inserts, updates };
}
export function dbRow(sku: string, inv: Record<string, number> = {}, listing: Partial<{ created: string | null; end: string | null; checked: string }> = {}) {
  return {
    asin: "B000000001", sku,
    listing_created_at: listing.created === undefined ? "2026-03-01T00:00:00Z" : listing.created,
    offer_end_at: listing.end ?? null, listing_checked_at: listing.checked ?? "2026-10-19T13:20:00Z",
    ...zero(), ...inv, observed_at: "2026-10-19T13:05:00Z", last_nonzero_at: null, has_inventory: true,
    last_stocked_date: null, newest_submission: "live", action_pending: false,
  };
}
const okRun = { error: null, started_at: PASS, finished_at: new Date("2026-10-19T13:40:00Z") };
export function fakeSc(listing: Record<string, { end: string | null } | "404">, inventory: Record<string, Record<string, number>> = {}) {
  const patches: any[] = [];
  const deletes: string[] = [];
  let velocityCalls = 0;
  hygieneDeps.sc = {
    get: async (endpoint: string, params?: any) => {
      if (endpoint.startsWith("/fba/inventory")) {
        const skus = String(params.sellerSkus).split(",");
        return { payload: { inventorySummaries: skus.filter((s) => inventory[s]).map((s) => ({ asin: "B000000001", sellerSku: s, inventoryDetails: { fulfillableQuantity: inventory[s].fulfillable ?? 0 } })) } };
      }
      const sku = decodeURIComponent(endpoint.split("/").pop()!);
      const st = listing[sku] ?? { end: null };
      if (st === "404") { const e: any = new Error("404"); e.response = { status: 404 }; throw e; }
      return {
        summaries: [{ marketplaceId: "ATVPDKIKX0DER", productType: "PRODUCT_X", createdDate: "2026-03-01T00:00:00Z", status: ["DISCOVERABLE"] }],
        attributes: { purchasable_offer: [{ marketplace_id: "ATVPDKIKX0DER", audience: "ALL", currency: "USD", end_at: { value: st.end } }] },
      };
    },
    patch: async (endpoint: string, body: any) => { patches.push({ endpoint, body }); return { status: "ACCEPTED", submissionId: `sub-${patches.length}` }; },
    del: async (endpoint: string) => { deletes.push(endpoint); return { status: "ACCEPTED", submissionId: `del-${deletes.length}` }; },
    velocity: async () => { velocityCalls++; return []; },
  };
  return { patches, deletes, velocity: () => velocityCalls };
}
export function ctxOf(query: any, params: any = null, trigger: JobRow["trigger"] = "scheduled"): ComponentContext {
  return {
    job: { id: 42, trigger, params } as any, query, log: () => {}, sellerId: "SELLER", asins: [], scopeAsins: ["B000000001"],
    checkpoint: async () => {}, setProgress: async () => {}, cache: new Map(),
  } as unknown as ComponentContext;
}
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
  it("scheduled hourly pass includes 22; a manual Refresh does not", () => {
    const row = (p: Partial<JobRow>) => ({ trigger: "scheduled", include_daily: false, components: null, params: null, ...p }) as JobRow;
    expect(componentsForJob(row({})).map((c) => c.n)).toContain(22);
    expect(componentsForJob(row({ trigger: "manual", include_daily: true })).map((c) => c.n)).not.toContain(22);
  });
});
