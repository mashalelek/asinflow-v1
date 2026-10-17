import { describe, it, expect } from "vitest";
import { syncScShipments, parseStaName, isVelocityShipFrom, allocateReceived, MATCH_WINDOW_MS, type ScSyncDeps } from "./shipment-sync-sc";

// Component B (patch docs/claude_spec-patch-shipment-reconciliation.md §4)
// on the probed fixture: Velocity 73917fcd… shipped 2026-10-15 18:03:37 GMT
// ↔ the five SC shipments "FBA STA (10/15/2026 18:01)-<FC>"; Velocity
// 97c1d401… 19:21:27 GMT ↔ "FBA STA (10/15/2026 19:16)-MEM2". Received
// allocation on the Twilight ASIN spanning two POs (1 + 9), oldest first.

const V1 = "73917fcd-bc7b-4790-9513-b44dd5fe16f7";
const V2 = "97c1d401-2e50-4ac5-a90c-c8cfbc811059";
const V3 = "aaaaaaaa-0000-0000-0000-000000000003"; // no SC group at all → unmatched
const lines = [
  { order_number: "SHOP533384", asin: "B004WZ4CLW", amazon_sku: "EQL-NUL-CLW-OPE-001", quantity_shipped: 60 },
  { order_number: "102003843107733", asin: "0349125937", amazon_sku: "ATO-BOO-937-TDC-001", quantity_shipped: 1 },
  { order_number: "102003840691113", asin: "0349125937", amazon_sku: "ATO-BOO-937-TDC-001", quantity_shipped: 9 },
  { order_number: "200015279183885", asin: "B076YKY47B", amazon_sku: "GOL-PET-47B-SPW-002", quantity_shipped: 1 },
];
const velocity = (over: any[] = []) => [
  { id: V1, shipped_at: "2026-10-15", shipped_at_ts: new Date("2026-10-15T18:03:37Z"), status: "shipped", raw: { detail: { orders: lines } }, sc_shipment_ids: [], sc_match: "none" },
  { id: V2, shipped_at: "2026-10-15", shipped_at_ts: new Date("2026-10-15T19:21:27Z"), status: "shipped", raw: { detail: { orders: [{ order_number: "x", asin: "B0KAY00001", amazon_sku: "KAY-BPC-TCK-OVO-001", quantity_shipped: 5 }] } }, sc_shipment_ids: [], sc_match: "none" },
  { id: V3, shipped_at: "2026-09-01", shipped_at_ts: new Date("2026-09-01T15:00:00Z"), status: "shipped", raw: { detail: { orders: [] } }, sc_shipment_ids: [], sc_match: "none" },
  ...over,
];
const rows = [
  { id: "r-eql", po_asin_id: "a-eql", velocity_shipment_id: V1, qty_shipped: "10.00", qty_received: null, fba_shipment_ids: [], sc_match: "none", asin: "B004WZ4CLW", po_id: "p-eql", order_date: "2026-10-10", order_id: "SHOP533384" },
  { id: "r-tw1", po_asin_id: "a-tw1", velocity_shipment_id: V1, qty_shipped: "1.00", qty_received: null, fba_shipment_ids: [], sc_match: "none", asin: "0349125937", po_id: "p-tw1", order_date: "2026-10-10", order_id: "102003843107733" },
  { id: "r-tw2", po_asin_id: "a-tw2", velocity_shipment_id: V1, qty_shipped: "9.00", qty_received: null, fba_shipment_ids: [], sc_match: "none", asin: "0349125937", po_id: "p-tw2", order_date: "2026-10-09", order_id: "102003840691113" },
  { id: "r-gr1", po_asin_id: "a-gr1", velocity_shipment_id: V1, qty_shipped: "1.00", qty_received: null, fba_shipment_ids: [], sc_match: "none", asin: "B076YKY47B", po_id: "p-gr1", order_date: "2026-10-09", order_id: "200015279183885" },
  { id: "r-kay", po_asin_id: "a-kay", velocity_shipment_id: V2, qty_shipped: "5.00", qty_received: null, fba_shipment_ids: [], sc_match: "none", asin: "B0KAY00001", po_id: "p-kay", order_date: "2026-10-01", order_id: "x" },
];
const FIVE = ["FBA19T7ZQ9JQ:IND9", "FBA19T7TWVK4:MDW2", "FBA19T7XBNZC:GYR3", "FBA19T81WCMB:RMN3", "FBA19T7Y1DV1:LGB8"];
const scShipment = (id: string, name: string, status = "IN_TRANSIT", from = "Velocity Prep") => ({ ShipmentId: id, ShipmentName: name, ShipFromAddress: { Name: from }, DestinationFulfillmentCenterId: name.split("-").pop(), ShipmentStatus: status });
const SC = [
  ...FIVE.map((x) => { const [id, fc] = x.split(":"); return scShipment(id, `FBA STA (10/15/2026 18:01)-${fc}`); }),
  scShipment("FBA19T84285M", "FBA STA (10/15/2026 19:16)-MEM2"),
  scShipment("FBA19CANCEL1", "FBA STA (10/15/2026 18:01)-XXX1", "CANCELLED"),              // same group key, excluded from the match
  scShipment("FBA19OTHER01", "FBA STA (10/15/2026 18:01)-YYY1", "CLOSED", "Maria Peters"),  // not Velocity ship-from, filtered out
  scShipment("FBA19OLDCLSD", "FBA STA (09/20/2026 10:00)-ONT8", "CLOSED"),
];
const ITEMS: Record<string, any[]> = {
  FBA19T7ZQ9JQ: [{ SellerSKU: "EQL-NUL-CLW-OPE-001", QuantityShipped: 10, QuantityReceived: 10 }, { SellerSKU: "ATO-BOO-937-TDC-001", QuantityShipped: 4, QuantityReceived: 4 }],
  FBA19T7TWVK4: [{ SellerSKU: "ATO-BOO-937-TDC-001", QuantityShipped: 6, QuantityReceived: 3 }],
  FBA19T7XBNZC: [{ SellerSKU: "GOL-PET-47B-SPW-002", QuantityShipped: 5, QuantityReceived: 5 }],  // 5 received vs 1 on the row → stored as 5, counted over-received
  FBA19T81WCMB: [{ SellerSKU: "UNKNOWN-SKU", QuantityShipped: 1, QuantityReceived: 1 }],
  FBA19T7Y1DV1: [],
  FBA19T84285M: [{ SellerSKU: "KAY-BPC-TCK-OVO-001", QuantityShipped: 5, QuantityReceived: 0 }],
  FBA19CANCEL1: [{ SellerSKU: "EQL-NUL-CLW-OPE-001", QuantityShipped: 99, QuantityReceived: 99 }],
  FBA19OLDCLSD: [{ SellerSKU: "OLD", QuantityShipped: 1, QuantityReceived: 1 }],
};

function fakeDb(state: { velocity?: any[]; rows?: any[]; cached?: any[]; cachedItems?: any[] } = {}) {
  const writes: Array<{ sql: string; params?: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    const s = sql.trim();
    if (s.startsWith("SELECT id, shipped_at::text AS shipped_at, shipped_at_ts, status, raw, sc_shipment_ids, sc_match FROM velocity_shipments")) return { rows: state.velocity ?? velocity(), rowCount: 0 };
    if (s.startsWith("SELECT shipment_id, status FROM sc_inbound_shipments")) return { rows: state.cached ?? [], rowCount: 0 };
    if (s.startsWith("SELECT shipment_id, seller_sku, fnsku, qty_shipped, qty_received FROM sc_inbound_items")) return { rows: state.cachedItems ?? [], rowCount: 0 };
    if (s.startsWith("SELECT s.sku, a.asin FROM asin_skus")) return { rows: [{ sku: "KAY-BPC-TCK-OVO-001", asin: "B0KAY00001" }], rowCount: 1 };
    if (s.startsWith("SELECT s.id, s.po_asin_id, s.velocity_shipment_id")) return { rows: state.rows ?? rows, rowCount: 0 };
    writes.push({ sql: s, params }); return { rows: [], rowCount: 1 };
  };
  return { query, connect: async () => ({ query, release: () => { writes.push({ sql: "RELEASE" }); } }), writes };
}
const deps = (over: Partial<ScSyncDeps> = {}): ScSyncDeps & { itemCalls: string[]; since: Date[] } => {
  const itemCalls: string[] = []; const since: Date[] = [];
  return { itemCalls, since, listShipments: async (s) => { since.push(s); return SC; }, listItems: async (id) => { itemCalls.push(id); return ITEMS[id] ?? []; }, now: () => new Date("2026-10-17T12:00:00Z"), ...over };
};

describe("helpers", () => {
  it("parseStaName reads the UTC timestamp out of Velocity's STA name; isVelocityShipFrom filters ship-from", () => {
    expect(parseStaName("FBA STA (10/15/2026 18:01)-IND9")?.toISOString()).toBe("2026-10-15T18:01:00.000Z");
    expect(parseStaName("Shipment #2")).toBeNull();
    expect(isVelocityShipFrom("Velocity Prep La Grande")).toBe(true);
    expect(isVelocityShipFrom("Maria Peters")).toBe(false);
    expect(MATCH_WINDOW_MS).toBe(15 * 60 * 1000);
  });
  it("allocateReceived: oldest PO first; the last row takes the remainder so the total equals SC's number, never capped (D2, 2026-10-17)", () => {
    const rs = [{ id: "new", qty_shipped: 1, order_date: "2026-10-10", order_id: "b" }, { id: "old", qty_shipped: 9, order_date: "2026-10-09", order_id: "a" }];
    expect(Object.fromEntries(allocateReceived(rs, 7))).toEqual({ old: 7, new: 0 });
    expect(Object.fromEntries(allocateReceived(rs, 10))).toEqual({ old: 9, new: 1 });
    expect(Object.fromEntries(allocateReceived(rs, 12))).toEqual({ old: 9, new: 3 });   // over-receipt lands on the newest PO
    expect(Object.fromEntries(allocateReceived(rs, 0))).toEqual({ old: 0, new: 0 });
    expect(Object.fromEntries(allocateReceived([rs[1]], 11))).toEqual({ old: 11 });   // single row: stored as reported
  });
});

describe("syncScShipments", () => {
  it("dry run: minute match on the STA name timestamp (UTC), cancelled/non-Velocity excluded, received allocated oldest PO first, nothing written", async () => {
    const db = fakeDb(); const d = deps();
    const r = await syncScShipments({ dryRun: true, deps: d, db });
    expect(r.wrote).toBe(false); expect(db.writes).toEqual([]);
    expect(d.since[0].toISOString()).toBe("2026-08-31T15:00:00.000Z"); // earliest Velocity shipped_at − 1 day
    expect(r.counts).toMatchObject({ velocityShipments: 3, scShipmentsListed: 9, scShipmentsVelocity: 8, scShipmentsItemsFetched: 8, matched: 2, matchedByMinute: 2, matchedByOverlap: 0, ambiguous: 0, unmatched: 1, rowsFbaIdsUpdated: 5, rowsReceivedUpdated: 5, rowsUnchanged: 0, overReceivedRows: 1 });
    expect(r.unmatchedShipments).toEqual([{ shipment: V3, shippedAt: "2026-09-01" }]);
    expect(r.samples[0]).toBe(`73917fcd 2026-10-15 → 5 SC shipment(s) FBA19T7TWVK4, FBA19T7XBNZC, FBA19T7Y1DV1, FBA19T7ZQ9JQ, FBA19T81WCMB by minute (Δ 3 min)`);
    expect(r.samples).toContainEqual(`73917fcd 2026-10-15 · 0349125937: SC received 7 of 10 → 102003840691113 7/9, 102003843107733 0/1 (oldest PO first)`);
    expect(r.samples).toContainEqual(`97c1d401 2026-10-15 → 1 SC shipment(s) FBA19T84285M by minute (Δ 5 min)`);
  });

  it("live run: cache + velocity_shipments + rows, with the five FBA ids on every row of the Velocity shipment; never qty_shipped", async () => {
    const db = fakeDb();
    const r = await syncScShipments({ dryRun: false, deps: deps(), db });
    expect(r.wrote).toBe(true);
    const sql = db.writes.map((w) => w.sql);
    expect(sql[0]).toBe("BEGIN"); expect(sql[sql.length - 2]).toBe("COMMIT");
    expect(db.writes.filter((w) => w.sql.startsWith("INSERT INTO sc_inbound_shipments")).map((w) => w.params?.[0])).toEqual(["FBA19T7ZQ9JQ", "FBA19T7TWVK4", "FBA19T7XBNZC", "FBA19T81WCMB", "FBA19T7Y1DV1", "FBA19T84285M", "FBA19CANCEL1", "FBA19OLDCLSD"]);
    const nameTs = db.writes.find((w) => w.sql.startsWith("INSERT INTO sc_inbound_shipments"))!.params?.[2];
    expect(nameTs).toEqual(new Date("2026-10-15T18:01:00Z"));
    expect(db.writes.filter((w) => w.sql.startsWith("INSERT INTO sc_inbound_items")).length).toBe(8);
    const vs = db.writes.filter((w) => w.sql.startsWith("UPDATE velocity_shipments"));
    expect(vs.map((w) => [w.params?.[0], w.params?.[1], w.params?.[2]])).toEqual([
      [V1, ["FBA19T7TWVK4", "FBA19T7XBNZC", "FBA19T7Y1DV1", "FBA19T7ZQ9JQ", "FBA19T81WCMB"], "matched"],
      [V2, ["FBA19T84285M"], "matched"],
      [V3, [], "unmatched"],
    ]);
    const ups = db.writes.filter((w) => w.sql.startsWith("UPDATE po_asin_shipments"));
    const byId = Object.fromEntries(ups.map((w) => [w.params?.[0], w]));
    expect(byId["r-eql"].sql).toBe("UPDATE po_asin_shipments SET fba_shipment_ids = $2::text[], sc_match = $3, qty_received = $4, updated_at = $5 WHERE id = $1");
    expect(byId["r-eql"].params?.slice(1, 4)).toEqual([["FBA19T7TWVK4", "FBA19T7XBNZC", "FBA19T7Y1DV1", "FBA19T7ZQ9JQ", "FBA19T81WCMB"], "matched", 10]);
    expect(byId["r-tw2"].params?.[3]).toBe(7);
    expect(byId["r-tw1"].params?.[3]).toBe(0);
    expect(byId["r-gr1"].params?.[3]).toBe(5);   // 5 received against 1 shipped: stored as reported ("received 5 of 1")
    expect(byId["r-kay"].params?.[3]).toBe(0);   // matched, nothing received yet
    for (const w of db.writes) expect(w.sql).not.toMatch(/qty_shipped =|qty_at_prep/);
    expect(r.touchedPoIds.sort()).toEqual(["p-eql", "p-gr1", "p-kay", "p-tw1", "p-tw2"]);
  });

  it("re-run: terminal cached shipments are not refetched, open ones are; unchanged rows stay untouched", async () => {
    const cached = SC.filter((s) => isVelocityShipFrom(s.ShipFromAddress.Name)).map((s) => ({ shipment_id: s.ShipmentId, status: s.ShipmentStatus }));
    const cachedItems = Object.entries(ITEMS).flatMap(([sid, its]) => its.map((it) => ({ shipment_id: sid, seller_sku: it.SellerSKU, fnsku: null, qty_shipped: it.QuantityShipped, qty_received: it.QuantityReceived })));
    const done = rows.map((r) => ({ ...r, fba_shipment_ids: r.velocity_shipment_id === V1 ? ["FBA19T7TWVK4", "FBA19T7XBNZC", "FBA19T7Y1DV1", "FBA19T7ZQ9JQ", "FBA19T81WCMB"] : ["FBA19T84285M"], sc_match: "matched", qty_received: { "r-eql": "10.00", "r-tw1": "0.00", "r-tw2": "7.00", "r-gr1": "5.00", "r-kay": "0.00" }[r.id] }));
    const vel = velocity().map((v) => ({ ...v, sc_match: v.id === V3 ? "unmatched" : "matched", sc_shipment_ids: v.id === V1 ? ["FBA19T7TWVK4", "FBA19T7XBNZC", "FBA19T7Y1DV1", "FBA19T7ZQ9JQ", "FBA19T81WCMB"] : v.id === V2 ? ["FBA19T84285M"] : [] }));
    const db = fakeDb({ velocity: vel, rows: done, cached, cachedItems }); const d = deps();
    const r = await syncScShipments({ dryRun: true, deps: d, db });
    expect(d.itemCalls.sort()).toEqual(["FBA19T7TWVK4", "FBA19T7XBNZC", "FBA19T7Y1DV1", "FBA19T7ZQ9JQ", "FBA19T81WCMB", "FBA19T84285M"]); // IN_TRANSIT refetched; CLOSED / CANCELLED served from cache
    expect(r.counts).toMatchObject({ scShipmentsItemsFetched: 6, rowsFbaIdsUpdated: 0, rowsReceivedUpdated: 0, rowsUnchanged: 5, posTouched: 0 });
  });

  it("fallback: no group within the window → same UTC day + best SKU overlap; an exact tie → ambiguous (D4)", async () => {
    // Velocity shipped at 12:00, STA names at 09:00 (two groups, same day): pick by overlap; identical overlap → ambiguous.
    const v = [{ id: V1, shipped_at: "2026-10-15", shipped_at_ts: new Date("2026-10-15T12:00:00Z"), status: "shipped", raw: { detail: { orders: lines } }, sc_shipment_ids: [], sc_match: "none" }];
    const two = [scShipment("FBA1AAAAAAAA", "FBA STA (10/15/2026 09:00)-AAA1"), scShipment("FBA1BBBBBBBB", "FBA STA (10/15/2026 09:30)-BBB1")];
    const items: Record<string, any[]> = { FBA1AAAAAAAA: [{ SellerSKU: "EQL-NUL-CLW-OPE-001", QuantityShipped: 10, QuantityReceived: 0 }, { SellerSKU: "ATO-BOO-937-TDC-001", QuantityShipped: 1, QuantityReceived: 0 }], FBA1BBBBBBBB: [{ SellerSKU: "GOL-PET-47B-SPW-002", QuantityShipped: 1, QuantityReceived: 0 }] };
    const d = deps({ listShipments: async () => two, listItems: async (id) => items[id] ?? [] });
    const r = await syncScShipments({ dryRun: true, deps: d, db: fakeDb({ velocity: v, rows: rows.filter((x) => x.velocity_shipment_id === V1) }) });
    expect(r.counts).toMatchObject({ matched: 1, matchedByOverlap: 1, ambiguous: 0 });
    expect(r.samples[0]).toMatch(/→ 1 SC shipment\(s\) FBA1AAAAAAAA by overlap$/);
    items.FBA1BBBBBBBB = [{ SellerSKU: "EQL-NUL-CLW-OPE-001", QuantityShipped: 10, QuantityReceived: 0 }, { SellerSKU: "ATO-BOO-937-TDC-001", QuantityShipped: 1, QuantityReceived: 0 }];
    const r2 = await syncScShipments({ dryRun: true, deps: d, db: fakeDb({ velocity: v, rows: rows.filter((x) => x.velocity_shipment_id === V1) }) });
    expect(r2.counts).toMatchObject({ matched: 0, ambiguous: 1 });
    expect(r2.ambiguous[0]).toEqual({ shipment: V1, shippedAt: "2026-10-15", groups: [["FBA1AAAAAAAA"], ["FBA1BBBBBBBB"]] });
    expect(r2.counts.rowsReceivedUpdated).toBe(0); // rows stay NULL / none → ambiguous flag only
    expect(r2.counts.rowsFbaIdsUpdated).toBe(4);
  });

  it("no Velocity shipments stored → nothing read from SC, nothing written", async () => {
    const d = deps(); const db = fakeDb({ velocity: [] });
    const r = await syncScShipments({ dryRun: false, deps: d, db });
    expect(r.counts.velocityShipments).toBe(0); expect(d.since).toEqual([]); expect(db.writes).toEqual([]);
  });

  it("fail-closed: an SP-API read error propagates before anything is written", async () => {
    const db = fakeDb();
    await expect(syncScShipments({ dryRun: false, deps: deps({ listItems: async () => { throw new Error("HTTP 429"); } }), db })).rejects.toThrow("HTTP 429");
    expect(db.writes).toEqual([]);
  });
});
