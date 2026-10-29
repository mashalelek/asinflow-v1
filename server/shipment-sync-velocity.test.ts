import { describe, it, expect } from "vitest";
import { syncVelocityShipments, resolveLine, buildAfIndex, etDate, round2, type AfAsinRow, type VelocitySyncDeps } from "./shipment-sync-velocity";

// Component A (patch docs/claude_spec-patch-shipment-reconciliation.md §3),
// driven by the probed Velocity shipment 73917fcd… (2026-10-15 18:03 GMT,
// five FCs) — the Equal Exchange 6-pack (60 units → 10), the two Twilight
// POs (1 + 9), Golden Rewards on two POs — plus the failure lines the
// fixture adds: an unknown Order #, a bundle parent with no child order.

const SID = "73917fcd-bc7b-4790-9513-b44dd5fe16f7";
const line = (o: Partial<any>): any => ({ order_id: o.order_id, order_number: o.order_number ?? "", retailer: o.retailer ?? "walmart.com", asin: o.asin, amazon_sku: o.sku ?? null,
  sold_as: o.sold_as ?? "individual", units_per_pack: o.upp ?? null, quantity: o.quantity ?? o.shipped, quantity_received: o.received ?? o.quantity ?? o.shipped,
  quantity_shipped: o.shipped, quantity_remaining: o.remaining ?? 0, status: o.status ?? "outbound", bundle_children: o.bundle_children });

const SHIPMENT_LINES = [
  line({ order_id: "90ae8ba3", order_number: "SHOP533384", retailer: "shop.equalexchange.coop", asin: "B004WZ4CLW", sku: "EQL-NUL-CLW-OPE-001", sold_as: "multi-pack", upp: 6, shipped: 60 }),
  line({ order_id: "2802c0c7", order_number: "102003843107733", retailer: "target.com", asin: "0349125937", sku: "ATO-BOO-937-TDC-001", quantity: 3, received: 3, shipped: 1, remaining: 2, status: "inventory" }),
  line({ order_id: "73b5d8a5", order_number: "102003840691113", retailer: "target.com", asin: "0349125937", sku: "ATO-BOO-937-TDC-001", shipped: 9 }),
  line({ order_id: "0af1d30d", order_number: "200015279183885", retailer: "walmart.com", asin: "B076YKY47B", sku: "GOL-PET-47B-SPW-002", quantity: 12, received: 3, shipped: 1, remaining: 2, status: "inbound" }),
  line({ order_id: "4108b424", order_number: "200015295664067", retailer: "Walmart.com", asin: "B076YKY47B", sku: "GOL-PET-47B-SPW-002", quantity: 9, received: 9, shipped: 4, remaining: 0 }), // retailer case drift → exact key (case-insensitive)
  line({ order_id: "deadbeef", order_number: "999999", retailer: "nowhere.com", asin: "B0NOPE0001", shipped: 5 }),             // po_not_found
  line({ order_id: "bundle01", order_number: "", asin: "B0GNHTYGPF", sold_as: "bundle", shipped: 2 }),                          // no_order (no children anywhere)
  line({ order_id: "retail00", order_number: "6461301", retailer: "open-tip.com", asin: "B011SESMB0", shipped: 10 }),            // order_only (retailer spelling differs)
];
const AF: AfAsinRow[] = [
  { id: "a-eql", po_id: "p-eql", asin: "B004WZ4CLW", units_per_pack: 6, qty_at_prep: null, order_id: "SHOP533384", supplier: "shop.equalexchange.coop", order_date: "2026-10-10" },
  { id: "a-tw1", po_id: "p-tw1", asin: "0349125937", units_per_pack: 1, qty_at_prep: null, order_id: "102003843107733", supplier: "target.com", order_date: "2026-10-10" },
  { id: "a-tw2", po_id: "p-tw2", asin: "0349125937", units_per_pack: 1, qty_at_prep: null, order_id: "102003840691113", supplier: "target.com", order_date: "2026-10-09" },
  { id: "a-gr1", po_id: "p-gr1", asin: "B076YKY47B", units_per_pack: 1, qty_at_prep: "5.00", order_id: "200015279183885", supplier: "walmart.com", order_date: "2026-10-09" },
  { id: "a-gr2", po_id: "p-gr2", asin: "B076YKY47B", units_per_pack: 1, qty_at_prep: null, order_id: "200015295664067", supplier: "walmart.com", order_date: "2026-10-04" },
  { id: "a-ot1", po_id: "p-ot1", asin: "B011SESMB0", units_per_pack: 1, qty_at_prep: null, order_id: "6461301", supplier: "opentip.com", order_date: "2026-10-04" },
  { id: "a-old", po_id: "p-old", asin: "B0OLDASIN1", units_per_pack: 1, qty_at_prep: "3.00", order_id: "OLD1", supplier: "x.com", order_date: "2026-06-01" }, // no Velocity line any more → NULL
];

function fakeDb(state: { shipments?: any[]; rows?: any[]; unmatched?: any[]; identity?: any[]; pins?: any[]; colP?: any[]; fbaIds?: any[] }) {
  const writes: Array<{ sql: string; params?: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    const s = sql.trim();
    if (s.startsWith("SELECT id, status, shipped_at_ts, raw FROM velocity_shipments")) return { rows: state.shipments ?? [], rowCount: 0 };
    if (s.startsWith("SELECT pa.id, pa.po_id, pa.asin")) return { rows: AF, rowCount: AF.length };
    if (s.startsWith("SELECT id, po_asin_id, velocity_shipment_id, qty_shipped")) return { rows: state.rows ?? [], rowCount: 0 };
    if (s.startsWith("SELECT id, velocity_shipment_id, velocity_order_id, reason")) return { rows: state.unmatched ?? [], rowCount: 0 };
    if (s.startsWith("SELECT velocity_order_id, child_order_numbers FROM velocity_bundle_identity")) return { rows: state.identity ?? [], rowCount: 0 };
    if (s.startsWith("SELECT s.id, s.velocity_shipment_id, s.velocity_order_number, s.qty_shipped")) return { rows: state.pins ?? [], rowCount: 0 };
    if (s.startsWith("SELECT DISTINCT c.fba_shipment_id")) return { rows: state.colP ?? [], rowCount: 0 };
    if (s.startsWith("SELECT id, sc_shipment_ids FROM velocity_shipments")) return { rows: state.fbaIds ?? [], rowCount: 0 };
    writes.push({ sql: s, params }); return { rows: [], rowCount: 1 };
  };
  return { query, connect: async () => ({ query, release: () => { writes.push({ sql: "RELEASE" }); } }), writes };
}
const deps = (over: Partial<VelocitySyncDeps> = {}): VelocitySyncDeps => ({
  listShipments: async () => [{ shipment_id: SID, status: "shipped", shipped_at: "Thu, 15 Oct 2026 18:03:37 GMT", destinations: [{ fc: "RMN3" }], total_quantity_shipped: 340 }],
  getShipment: async () => ({ orders: SHIPMENT_LINES, boxes: [] }),
  listInbound: async () => [line({ order_id: "0af1d30d", order_number: "200015279183885", retailer: "walmart.com", asin: "B076YKY47B", quantity: 12, received: 3, remaining: 2, status: "inbound" })],
  listInventory: async () => [line({ order_id: "2802c0c7", order_number: "102003843107733", retailer: "target.com", asin: "0349125937", quantity: 3, received: 3, remaining: 2, status: "inventory" })],
  now: () => new Date("2026-10-17T12:00:00Z"),
  ...over,
});

describe("helpers", () => {
  it("etDate converts an RFC-1123 GMT instant to the Eastern calendar date; round2 keeps fractions", () => {
    expect(etDate("Thu, 15 Oct 2026 18:03:37 GMT")).toBe("2026-10-15");
    expect(etDate("Fri, 16 Oct 2026 02:30:00 GMT")).toBe("2026-10-15"); // 22:30 ET the day before
    expect(etDate("garbage")).toBeNull();
    expect(round2(7 / 6)).toBe(1.17);
  });
  it("resolveLine: exact key, case-insensitive retailer, order-only fallback when unique, bundle via children, failures", () => {
    const idx = buildAfIndex(AF);
    expect(resolveLine(SHIPMENT_LINES[0], idx, new Map())).toMatchObject({ ok: true, how: "exact", row: { id: "a-eql" } });
    expect(resolveLine(SHIPMENT_LINES[4], idx, new Map())).toMatchObject({ ok: true, how: "exact", row: { id: "a-gr2" } });
    expect(resolveLine(SHIPMENT_LINES[7], idx, new Map())).toMatchObject({ ok: true, how: "order_only", row: { id: "a-ot1" } });
    expect(resolveLine(SHIPMENT_LINES[5], idx, new Map())).toMatchObject({ ok: false, reason: "po_not_found" });
    expect(resolveLine(SHIPMENT_LINES[6], idx, new Map())).toMatchObject({ ok: false, reason: "no_order" });
    const kids = new Map([["bundle01", [{ order_number: "SHOP533384", retailer: "shop.equalexchange.coop" }]]]);
    expect(resolveLine({ ...SHIPMENT_LINES[6], asin: "B004WZ4CLW" }, idx, kids)).toMatchObject({ ok: true, how: "exact", row: { id: "a-eql" } });
    const kids2 = new Map([["bundle01", [{ order_number: "A", retailer: "x" }, { order_number: "B", retailer: "x" }]]]);
    expect(resolveLine(SHIPMENT_LINES[6], idx, kids2)).toMatchObject({ ok: false, reason: "no_order", note: "bundle spans 2 orders" });
  });
});

describe("syncVelocityShipments", () => {
  it("dry run: the probed shipment places 6 of 8 lines, converts units to packs, computes qty_at_prep per D6, writes nothing", async () => {
    const db = fakeDb({});
    const r = await syncVelocityShipments({ dryRun: true, deps: deps(), db });
    expect(r.wrote).toBe(false);
    expect(db.writes).toEqual([]);
    expect(r.counts).toMatchObject({ shipments: 1, shipmentsFetched: 1, lines: 8, linesMatched: 6, linesMatchedOrderOnly: 1, linesNoOrder: 1, linesPoNotFound: 1, rowsInserted: 6, rowsUpdated: 0, rowsUnchanged: 0, unmatchedNew: 2 });
    expect(r.samples[0]).toBe("73917fcd 2026-10-15 · shop.equalexchange.coop SHOP533384 B004WZ4CLW: 60 units ÷ 6 → 10");
    expect(r.samples[1]).toBe("73917fcd 2026-10-15 · target.com 102003843107733 0349125937: 1 units ÷ 1 → 1");
    expect(r.samples[2]).toBe("73917fcd 2026-10-15 · target.com 102003840691113 0349125937: 9 units ÷ 1 → 9");
    expect(r.samples[5]).toMatch(/opentip\.com 6461301 B011SESMB0: 10 units ÷ 1 → 10 \(order_only\)/);
    expect(r.unmatched.map((u) => u.reason)).toEqual(["po_not_found", "no_order"]);
    // qty_at_prep: inbound/inventory lines win (a-gr1 5 → 2); a shipped-out order reads 0; an ASIN row with no Velocity line goes NULL.
    expect(r.counts).toMatchObject({ atPrepSet: 6, atPrepCleared: 1, atPrepUnchanged: 0 });
    expect(r.touchedPoIds.sort()).toEqual(["p-eql", "p-gr1", "p-gr2", "p-old", "p-ot1", "p-tw1", "p-tw2"]);
  });

  it("live run: one transaction — velocity_shipments upsert, rows in ASIN qty, unmatched rows, resolved stamps, qty_at_prep; never fba ids / received / sc_match", async () => {
    const db = fakeDb({ unmatched: [{ id: "u-old", velocity_shipment_id: SID, velocity_order_id: "73b5d8a5", reason: "po_not_found", resolved_at: null, resolved_po_asin_id: null }] });
    const r = await syncVelocityShipments({ dryRun: false, deps: deps(), db });
    expect(r.wrote).toBe(true);
    expect(r.counts.unmatchedResolved).toBe(1);
    const sql = db.writes.map((w) => w.sql);
    expect(sql[0]).toBe("BEGIN"); expect(sql[sql.length - 2]).toBe("COMMIT"); expect(sql[sql.length - 1]).toBe("RELEASE");
    const vs = db.writes.find((w) => w.sql.startsWith("INSERT INTO velocity_shipments"))!;
    expect(vs.params?.slice(0, 4)).toEqual([SID, "2026-10-15", new Date("2026-10-15T18:03:37Z"), "shipped"]);
    const ins = db.writes.filter((w) => w.sql.startsWith("INSERT INTO po_asin_shipments"));
    expect(ins.map((w) => [w.params?.[0], w.params?.[2]])).toEqual([["a-eql", 10], ["a-tw1", 1], ["a-tw2", 9], ["a-gr1", 1], ["a-gr2", 4], ["a-ot1", 10]]);
    expect(ins.every((w) => w.params?.[1] === SID && w.params?.[3] === "2026-10-15")).toBe(true);
    const un = db.writes.filter((w) => w.sql.startsWith("INSERT INTO shipment_unmatched"));
    expect(un.map((w) => [w.params?.[1], w.params?.[3]])).toEqual([["deadbeef", "po_not_found"], ["bundle01", "no_order"]]);
    expect(db.writes.find((w) => w.sql.startsWith("UPDATE shipment_unmatched SET resolved_at"))?.params?.[0]).toEqual(["u-old"]);
    const prep = db.writes.filter((w) => w.sql.startsWith("UPDATE po_asins SET qty_at_prep"));
    expect(Object.fromEntries(prep.map((w) => [w.params?.[0], w.params?.[1]]))).toEqual({ "a-eql": 0, "a-tw1": 2, "a-tw2": 0, "a-gr1": 2, "a-gr2": 0, "a-ot1": 0, "a-old": null });
    for (const w of db.writes) expect(w.sql).not.toMatch(/fba_shipment_ids|sc_match|qty_received|qty_at_warehouse|qty_lost_damaged_us|qty_shipped_supplier/);
  });

  it("re-run with everything already stored: no detail fetch, rows unchanged, nothing touched", async () => {
    let fetched = 0;
    const d = deps({ getShipment: async () => { fetched++; return { orders: SHIPMENT_LINES }; } });
    const list = await d.listShipments();
    const db = fakeDb({
      shipments: [{ id: SID, status: "shipped", shipped_at_ts: new Date("2026-10-15T18:03:37Z"), raw: { list: list[0], detail: { orders: SHIPMENT_LINES } } }],
      rows: [["a-eql", 10], ["a-tw1", 1], ["a-tw2", 9], ["a-gr1", 1], ["a-gr2", 4], ["a-ot1", 10]].map(([id, q], i) => ({ id: `r${i}`, po_asin_id: id, velocity_shipment_id: SID, qty_shipped: String(q), shipped_at: "2026-10-15" })),
      unmatched: [{ id: "u1", velocity_shipment_id: SID, velocity_order_id: "deadbeef", reason: "po_not_found", resolved_at: null, resolved_po_asin_id: null }, { id: "u2", velocity_shipment_id: SID, velocity_order_id: "bundle01", reason: "no_order", resolved_at: null, resolved_po_asin_id: null }],
    });
    const r = await syncVelocityShipments({ dryRun: true, deps: d, db });
    expect(fetched).toBe(0);
    expect(r.counts).toMatchObject({ shipmentsFetched: 0, rowsInserted: 0, rowsUpdated: 0, rowsUnchanged: 6, unmatchedNew: 0, unmatchedResolved: 0 });
  });

  it("a line resolved through the picker keeps its mapping on later runs", async () => {
    const db = fakeDb({ unmatched: [{ id: "u1", velocity_shipment_id: SID, velocity_order_id: "deadbeef", reason: "po_not_found", resolved_at: new Date(), resolved_po_asin_id: "a-old" }] });
    const r = await syncVelocityShipments({ dryRun: true, deps: deps(), db });
    expect(r.counts.linesMatched).toBe(7);
    expect(r.unmatched.map((u) => u.orderId)).toEqual(["bundle01"]);
    expect(r.samples.find((s) => s.includes("x.com OLD1 B0OLDASIN1"))).toMatch(/5 units ÷ 1 → 5 \(picker\)/);
  });

  it("a child-less bundle parent resolves through velocity_bundle_identity (child order numbers, no retailer → order-only)", async () => {
    const db = fakeDb({ identity: [{ velocity_order_id: "bundle01", child_order_numbers: ["SHOP533384"] }] });
    const d = deps({ getShipment: async () => ({ orders: [{ ...SHIPMENT_LINES[6], asin: "B004WZ4CLW", quantity_shipped: 12 }] }) });
    const r = await syncVelocityShipments({ dryRun: true, deps: d, db });
    expect(r.counts).toMatchObject({ lines: 1, linesMatched: 1, linesMatchedOrderOnly: 1, linesNoOrder: 0 });
    expect(r.samples[0]).toMatch(/SHOP533384 B004WZ4CLW: 12 units ÷ 6 → 2 \(order_only\)/);
  });

  it("a manually assigned line stays on its pinned row even when another PO now matches its Order # exactly (leadersrpmshop.com 10548557_10507736, 2026-10-18)", async () => {
    // AF after the 2025 history import: the 2026 PO is 10548557_10507736 (Velocity still says 10507736, pinned);
    // the 2025 PO is 10507736 — an exact (Order #, retailer, ASIN) match for the Velocity line.
    const AF2 = [
      { id: "a-2026", po_id: "p-2026", asin: "B07S5R68XZ", units_per_pack: 1, qty_at_prep: "0.00", order_id: "10548557_10507736", supplier: "leadersrpmshop.com", order_date: "2026-06-21" },
      { id: "a-2025", po_id: "p-2025", asin: "B07S5R68XZ", units_per_pack: 1, qty_at_prep: null, order_id: "10507736", supplier: "leadersrpmshop.com", order_date: "2025-10-19" },
    ];
    const vline = line({ order_id: "lr1", order_number: "10507736", retailer: "leadersrpmshop.com", asin: "B07S5R68XZ", shipped: 15 });
    const base = fakeDb({ pins: [{ id: "r1", velocity_shipment_id: SID, velocity_order_number: "10507736", qty_shipped: "15.00", shipped_at: "2026-10-15", asin: "B07S5R68XZ", po_asin_id: "a-2026" }], rows: [{ id: "r1", po_asin_id: "a-2026", velocity_shipment_id: SID, qty_shipped: "15.00", shipped_at: "2026-10-15" }] });
    const db = { ...base, query: async (sql: string, params?: any[]) => sql.trim().startsWith("SELECT pa.id, pa.po_id, pa.asin") ? { rows: AF2, rowCount: 2 } : base.query(sql, params) };
    const r = await syncVelocityShipments({ dryRun: true, deps: deps({ getShipment: async () => ({ orders: [vline] }), listInbound: async () => [], listInventory: async () => [] }), db });
    expect(r.counts).toMatchObject({ linesMatched: 1, linesPinned: 1, rowsInserted: 0, rowsUpdated: 0, rowsUnchanged: 1 });
    // without the pin the same line would land on the 2025 PO
    const db2 = { ...db, query: async (sql: string, params?: any[]) => sql.trim().startsWith("SELECT s.id, s.velocity_shipment_id") ? { rows: [], rowCount: 0 } : db.query(sql, params) };
    const r2 = await syncVelocityShipments({ dryRun: true, deps: deps({ getShipment: async () => ({ orders: [vline] }), listInbound: async () => [], listInventory: async () => [] }), db: db2 });
    expect(r2.counts).toMatchObject({ linesPinned: 0, rowsInserted: 1 });
    expect(r2.samples[0]).toMatch(/leadersrpmshop\.com 10507736 B07S5R68XZ/);
  });

  // Reassign shipment (af-owned §5.2): hand assignments are never moved, only their quantities refresh.
  it("reassigned (pinned) to another PO: one row → quantity refreshes from Velocity in place; the derived PO gets nothing", async () => {
    // Velocity line 102003840691113 × 0349125937 (9 units) was reassigned by hand to a-tw1; Velocity now says 9 → row holds 7 → refresh to 9.
    const db = fakeDb({
      pins: [{ id: "m1", velocity_shipment_id: SID, velocity_order_number: "102003840691113", qty_shipped: "7.00", shipped_at: "2026-10-15", asin: "0349125937", po_asin_id: "a-tw1" }],
      rows: [{ id: "m1", po_asin_id: "a-tw1", velocity_shipment_id: SID, qty_shipped: "7.00", shipped_at: "2026-10-15", assigned_by: "manual" }],
    });
    const r = await syncVelocityShipments({ dryRun: false, deps: deps({ getShipment: async () => ({ orders: [SHIPMENT_LINES[2]] }), listInbound: async () => [], listInventory: async () => [] }), db });
    expect(r.counts).toMatchObject({ linesMatched: 1, linesPinned: 1, rowsInserted: 0, rowsUpdated: 1 });
    const upd = db.writes.filter((w) => w.sql.startsWith("UPDATE po_asin_shipments SET qty_shipped"));
    expect(upd.map((w) => [w.params?.[0], w.params?.[1]])).toEqual([["m1", 9]]);
    expect(db.writes.some((w) => w.sql.startsWith("INSERT INTO po_asin_shipments"))).toBe(false); // never re-derived onto a-tw2
  });
  it("a line split by hand over two rows: units still add up → untouched; Velocity changed → reported as drift, nothing rewritten", async () => {
    const pins = [
      { id: "m1", velocity_shipment_id: SID, velocity_order_number: "102003840691113", qty_shipped: "6.00", shipped_at: "2026-10-15", asin: "0349125937", po_asin_id: "a-tw2" },
      { id: "m2", velocity_shipment_id: SID, velocity_order_number: "102003840691113", qty_shipped: "3.00", shipped_at: "2026-10-15", asin: "0349125937", po_asin_id: "a-tw1" },
    ];
    const rows = pins.map((p) => ({ id: p.id, po_asin_id: p.po_asin_id, velocity_shipment_id: SID, qty_shipped: p.qty_shipped, shipped_at: "2026-10-15", assigned_by: "manual" }));
    const only = (orders: any[]) => deps({ getShipment: async () => ({ orders }), listInbound: async () => [], listInventory: async () => [] });
    const ok = fakeDb({ pins, rows });
    const r = await syncVelocityShipments({ dryRun: false, deps: only([SHIPMENT_LINES[2]]), db: ok });
    expect(r.counts).toMatchObject({ linesPinned: 1, rowsUpdated: 0, rowsInserted: 0, rowsUnchanged: 2, manualSplitDrift: 0 });
    expect(ok.writes.some((w) => /po_asin_shipments/.test(w.sql))).toBe(false);
    const drift = fakeDb({ pins, rows });
    const r2 = await syncVelocityShipments({ dryRun: false, deps: only([{ ...SHIPMENT_LINES[2], quantity_shipped: 10 }]), db: drift });
    expect(r2.counts).toMatchObject({ manualSplitDrift: 1, rowsUpdated: 0, rowsInserted: 0 });
    expect(r2.samples.some((x) => /split by hand over 2 rows holding 9 units; Velocity now says 10 — not rewritten/.test(x))).toBe(true);
    expect(drift.writes.some((w) => /po_asin_shipments/.test(w.sql))).toBe(false);
  });
  it("an auto-derived plan that lands on a row assigned by hand leaves it alone", async () => {
    const db = fakeDb({ rows: [{ id: "m9", po_asin_id: "a-tw2", velocity_shipment_id: SID, qty_shipped: "4.00", shipped_at: "2026-10-15", assigned_by: "manual" }] });
    const r = await syncVelocityShipments({ dryRun: false, deps: deps({ getShipment: async () => ({ orders: [SHIPMENT_LINES[2]] }), listInbound: async () => [], listInventory: async () => [] }), db });
    expect(r.counts).toMatchObject({ manualRowsKept: 1, rowsUpdated: 0, rowsInserted: 0 });
    expect(db.writes.some((w) => /^(UPDATE|INSERT INTO) po_asin_shipments/.test(w.sql))).toBe(false);
  });

  it("fail-closed: a Velocity read error propagates before anything is written", async () => {
    const db = fakeDb({});
    await expect(syncVelocityShipments({ dryRun: false, deps: deps({ listInbound: async () => { throw new Error("Velocity /inbound coverage incomplete"); } }), db })).rejects.toThrow(/coverage incomplete/);
    expect(db.writes).toEqual([]);
  });
});
