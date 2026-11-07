import { describe, it, expect, vi } from "vitest";

// Velocity order → PO ASIN row (migration 099, Maria 2026-11-07): the stored
// link answers first in every Velocity matcher but a hand pin; Received by
// Velocity / At Prep count a linked order whether it is inbound, in inventory
// or shipped, summed; the Upload plan sums every order on a row (PO 71160468:
// 90 + 30 = 120, nothing to update or create); a never-shipped order placed
// nowhere is listed; an order # match to a Home PO is matched and raises
// Review Velocity (the havalon PO as it stood after 10/29).

vi.mock("./log", () => ({ log: () => {} }));
let poRows: any[] = [];
let velocity: any[] = [];
vi.mock("./po-af-source", async (orig) => ({
  ...(await orig<typeof import("./po-af-source")>()),
  loadAfPoRows: async () => ({ rows: poRows, rawRowsRead: poRows.length, blankAsinRows: 0 }),
}));
vi.mock("./velocity-api", async (orig) => ({ ...(await orig<typeof import("./velocity-api")>()), fetchAllKnownOrders: async () => velocity }));
vi.mock("./velocity-bundle-identity", async (orig) => ({ ...(await orig<typeof import("./velocity-bundle-identity")>()), recordableBundles: () => [], hydrateChildlessBundles: async () => ({ hydrated: 0, unplaced: [] }) }));
import { syncVelocityShipments, type AfAsinRow, type VelocitySyncDeps } from "./shipment-sync-velocity";
import { buildVelocityPlan } from "./velocity-reconcile";
import { unionKnownOrders } from "./velocity-api";
import { pushTracking, type VelocityDeps } from "./tracking-push";
import { linkedPairs, velocityOrderLabel } from "./velocity-order-links";

const SID = "ship-0001";
const START = "2026-04-07";
const af = (o: Partial<AfAsinRow> & { id: string; asin: string; order_id: string; supplier: string; order_date: string }): AfAsinRow =>
  ({ po_id: `p-${o.id}`, units_per_pack: 1, qty_at_prep: null, received_velocity: null, sold_as: "individual", velocity_units_per_pack: null, qty: 10, ships_to: "velocity", ...o });
const vo = (o: Record<string, unknown>) => ({ order_id: "vo-1", order_number: null, retailer: null, asin: "B1", sold_as: "individual", units_per_pack: null, date: "05/15/2026", status: "inbound", quantity: 5, quantity_received: 0, quantity_remaining: 0, ...o });

function harness(rows: AfAsinRow[], legs: { shipped?: any[]; inbound?: any[]; inventory?: any[] }, extra: { links?: Array<{ velocity_order_id: string; po_asin_id: string }>; unmatched?: any[]; pins?: any[]; home?: any[] } = {}) {
  const writes: Array<{ sql: string; params?: any[] }> = [];
  const reconciled: string[][] = [];
  const query = async (sql: string, params?: any[]) => {
    const s = sql.trim();
    if (s.startsWith("SELECT pa.id, pa.po_id, pa.asin")) return { rows, rowCount: rows.length };
    if (s.startsWith("SELECT value FROM settings")) return { rows: [{ value: START }], rowCount: 1 };
    if (s.startsWith("SELECT id, velocity_shipment_id, velocity_order_id, reason")) return { rows: extra.unmatched ?? [], rowCount: 0 };
    if (s.startsWith("SELECT s.id, s.velocity_shipment_id, s.velocity_order_number")) return { rows: extra.pins ?? [], rowCount: 0 };
    if (s.startsWith("SELECT l.velocity_order_id, l.po_asin_id")) {
      const r = (extra.links ?? []).map((l) => { const a = rows.find((x) => x.id === l.po_asin_id)!; return { ...l, po_id: a.po_id, order_id: a.order_id, supplier: a.supplier, asin: a.asin }; });
      return { rows: r, rowCount: r.length };
    }
    if (s.startsWith("SELECT id, velocity_home_orders FROM purchase_orders")) return { rows: extra.home ?? [], rowCount: 0 };
    if (s.startsWith("SELECT p.id,") && s.includes("FROM purchase_orders p WHERE p.id = ANY")) { reconciled.push(params![0]); return { rows: [], rowCount: 0 }; }
    if (s.startsWith("SELECT")) return { rows: [], rowCount: 0 };
    writes.push({ sql: s, params }); return { rows: [], rowCount: 1 };
  };
  const shipped = legs.shipped ?? [];
  const deps: VelocitySyncDeps = {
    listShipments: async () => (shipped.length ? [{ shipment_id: SID, status: "shipped", shipped_at: "Tue, 26 May 2026 15:00:00 GMT" } as any] : []),
    getShipment: async () => ({ orders: shipped }),
    listInbound: async () => legs.inbound ?? [], listInventory: async () => legs.inventory ?? [], now: () => new Date("2026-11-07T20:00:00Z"),
  };
  const run = (dryRun = false) => syncVelocityShipments({ dryRun, deps, db: { query, connect: async () => ({ query, release: () => {} }) } as any });
  const write = (prefix: string) => writes.filter((w) => w.sql.startsWith(prefix));
  return { run, writes, write, reconciled };
}

describe("Sync Shipments — the link answers first", () => {
  const A = af({ id: "a", asin: "B1", order_id: "ORD-A", supplier: "x.com", order_date: "2026-05-14" });
  const B = af({ id: "b", asin: "B1", order_id: "ORD-B", supplier: "x.com", order_date: "2026-05-14" });
  const line = vo({ order_id: "vo-1", order_number: "ORD-A", retailer: "x.com", status: "shipped", quantity_shipped: 4, quantity_received: 4 });

  it("a linked order's shipped line goes to the linked row, past its own exact order #", async () => {
    const h = harness([A, B], { shipped: [line] }, { links: [{ velocity_order_id: "vo-1", po_asin_id: "b" }] });
    const r = await h.run();
    expect(r.counts).toMatchObject({ linesMatched: 1, linesLinked: 1 });
    expect(h.write("INSERT INTO po_asin_shipments").map((w) => w.params?.slice(0, 3))).toEqual([["b", SID, 4]]);
  });
  it("a hand pin still wins over the link", async () => {
    const pins = [{ id: "pin1", velocity_shipment_id: SID, velocity_order_number: "ORD-A", qty_shipped: 4, shipped_at: "2026-05-26", asin: "B1", po_asin_id: "a" }];
    const r = await harness([A, B], { shipped: [line] }, { links: [{ velocity_order_id: "vo-1", po_asin_id: "b" }], pins }).run(true);
    expect(r.counts).toMatchObject({ linesPinned: 1, linesLinked: 0 });
  });
  it("the link wins over a picker link recorded for the line", async () => {
    const unmatched = [{ id: "u1", velocity_shipment_id: SID, velocity_order_id: "vo-1", reason: "no_order", resolved_at: "2026-11-01", resolved_po_asin_id: "a", match_reason: "picker" }];
    const h = harness([A, B], { shipped: [line] }, { links: [{ velocity_order_id: "vo-1", po_asin_id: "b" }], unmatched });
    await h.run();
    expect(h.write("INSERT INTO po_asin_shipments").map((w) => w.params?.[0])).toEqual(["b"]);
  });
});

describe("Received by Velocity / At Prep by Velocity order id", () => {
  // PO 71160468: Velocity order 71160468 (90) and the blank-number order 94cdd620 (30), linked.
  const X = af({ id: "x", asin: "B001AXZ7Q8", order_id: "71160468", supplier: "ulta.com", order_date: "2026-10-01", qty: 120 });
  it("inbound, inventory and shipped all count, summed across the linked orders", async () => {
    const h = harness([X], {
      shipped: [vo({ order_id: "vo-90", order_number: "71160468", retailer: "ulta.com", asin: "B001AXZ7Q8", status: "shipped", quantity: 90, quantity_shipped: 90, quantity_received: 90, quantity_remaining: 0 })],
      inventory: [vo({ order_id: "94cdd620", order_number: "", retailer: "ulta.com", asin: "B001AXZ7Q8", status: "inventory", quantity: 30, quantity_received: 30, quantity_remaining: 10 })],
      inbound: [vo({ order_id: "vo-new", order_number: "", retailer: "ulta.com", asin: "B001AXZ7Q8", status: "inbound", quantity: 5, quantity_received: 2, quantity_remaining: 2 })],
    }, { links: [{ velocity_order_id: "94cdd620", po_asin_id: "x" }, { velocity_order_id: "vo-new", po_asin_id: "x" }] });
    const r = await h.run();
    expect(r.receivedVelocityOps).toEqual([expect.objectContaining({ id: "x", from: null, to: 122 })]);
    expect(h.write("UPDATE po_asins SET qty_at_prep").map((w) => w.params)).toEqual([["x", 12]]);
    expect(r.counts.unplacedOrders).toBe(0);
  });
  it("without the link the blank-number orders count nowhere and are listed as Velocity orders with no PO", async () => {
    const r = await harness([X], {
      inventory: [vo({ order_id: "94cdd620", order_number: "", retailer: "ulta.com", asin: "B001AXZ7Q8", status: "inventory", quantity: 30, quantity_received: 30, quantity_remaining: 10, date: "10/02/2026" })],
    }).run(true);
    expect(r.receivedVelocityOps).toEqual([]);
    expect(r.unplacedOrders).toEqual([expect.objectContaining({ orderId: "94cdd620", reason: "no_order", candidates: [expect.objectContaining({ po_asin_id: "x", order_id: "71160468" })] })]);
  });
  it("a partly shipped order keeps its shipment id, so a picker link on its shipped line still counts its units at Velocity", async () => {
    const unmatched = [{ id: "u1", velocity_shipment_id: SID, velocity_order_id: "vo-p", reason: "no_order", resolved_at: "2026-11-01", resolved_po_asin_id: "x", match_reason: "picker" }];
    const r = await harness([X], {
      shipped: [vo({ order_id: "vo-p", order_number: "", asin: "B001AXZ7Q8", status: "shipped", quantity_shipped: 5, quantity_received: 12, quantity_remaining: 7 })],
      inbound: [vo({ order_id: "vo-p", order_number: "", asin: "B001AXZ7Q8", status: "inbound", quantity: 12, quantity_received: 12, quantity_remaining: 7 })],
    }, { unmatched }).run(true);
    expect(r.receivedVelocityOps).toEqual([expect.objectContaining({ id: "x", to: 12 })]);
  });
});

describe("Velocity orders with no PO", () => {
  it("a never-shipped order no rule places is written with its ranked candidates; the list is rewritten each run", async () => {
    const P = af({ id: "p", asin: "B1", order_id: "P1", supplier: "x.com", order_date: "2026-05-14", qty: 5 });
    const h = harness([P], { inbound: [vo({ order_id: "vo-u", order_number: "" })] });
    const r = await h.run();
    expect(r.counts.unplacedOrders).toBe(1);
    expect(h.write("DELETE FROM velocity_orders_unplaced").map((w) => w.params)).toEqual([[["vo-u"]]]);
    const ins = h.write("INSERT INTO velocity_orders_unplaced")[0];
    expect(ins.params?.[0]).toBe("vo-u");
    expect(JSON.parse(ins.params?.[3])).toEqual([expect.objectContaining({ po_asin_id: "p", source: "candidate", days: -1, remaining_units: 5 })]);
  });
});

describe("Home PO: matched, never skipped, Review Velocity raised (Maria 2026-11-07)", () => {
  // havalon.com no_poid_at_checkout as it stood after the 10/29 ships_to correction:
  // ships_to home, prep $0; Velocity #8785 inbound, 3 units, nothing received.
  const havalon = (shipsTo: "home" | "velocity") => af({ id: "ed92e708", po_id: "fbd0528f", asin: "B00D79EODK", order_id: "no_poid_at_checkout", supplier: "havalon.com", order_date: "2026-10-23", qty: 3, ships_to: shipsTo });
  const o8785 = vo({ id: 8785, order_id: "vo-8785", order_number: "no_poid_at_checkout", retailer: "havalon.com", asin: "B00D79EODK", date: "10/23/2026", quantity: 3, quantity_received: 0, quantity_remaining: 0 });

  it("the order matches the Home PO by order #, is not listed as unplaced, and the PO is flagged with the Velocity #", async () => {
    const h = harness([havalon("home")], { inbound: [o8785] });
    const r = await h.run();
    expect(r.homeOrders).toEqual([{ poId: "fbd0528f", orders: ["#8785"] }]);
    expect(r.unplacedOrders).toEqual([]);
    expect(r.receivedVelocityOps).toEqual([expect.objectContaining({ id: "ed92e708", from: null, to: 0 })]);
    expect(h.write("UPDATE purchase_orders SET velocity_home_orders").map((w) => w.params)).toEqual([["fbd0528f", "#8785", true]]);
    expect(h.reconciled).toEqual([["fbd0528f"]]);
  });
  it("ships_to corrected to velocity → the flag clears on the next run and Review Velocity is reconciled", async () => {
    const h = harness([havalon("velocity")], { inbound: [o8785] }, { home: [{ id: "fbd0528f", velocity_home_orders: "#8785" }] });
    const r = await h.run();
    expect(r.homeOrders).toEqual([]);
    expect(h.write("UPDATE purchase_orders SET velocity_home_orders").map((w) => w.params)).toEqual([["fbd0528f", null, false]]);
    expect(h.reconciled).toEqual([["fbd0528f"]]);
  });
  it("the base order # and the candidate rule still skip a Home PO", async () => {
    const r = await harness([havalon("home")], { inbound: [vo({ order_id: "vo-x", order_number: "no_poid_at_checkout_1", retailer: "havalon.com", asin: "B00D79EODK", date: "10/23/2026", quantity: 3 })] }).run(true);
    expect(r.homeOrders).toEqual([]);
    expect(r.unplacedOrders[0]).toMatchObject({ orderId: "vo-x", candidates: undefined });
  });
});

describe("Upload to Velocity plan — links and sums", () => {
  process.env.VELOCITY_MIN_ORDER_DATE = "1/1/2026";
  const RANGE: [Date, Date] = [new Date(2026, 9, 1), new Date(2026, 9, 1)];
  const sheet = (over: Record<string, any> = {}) => ({
    sheetRow: 2, status: "Ordered", asin: "B001AXZ7Q8", cogs: 5, prepCost: 1, qty: 120, qtyRaw: "120", supplier: "ulta.com", orderNumber: "71160468", orderDate: "10/1/2026",
    retailer: "ulta.com", itemName: "Item", productName: "Item", qtyOrderedL: "120", setsN: "120", uniqueS: "1", yieldT: "1", soldAs: "individual", unitsPerPack: "1",
    quantity: "120", shipsTo: "velocity", asinUnitsMissing: false, lineNumber: 1, poAsinId: "pa-x", ...over,
  });
  const order = (o: Record<string, any>) => ({ order_id: "v-90", order_number: "71160468", asin: "B001AXZ7Q8", sold_as: "individual", status: "inbound", quantity: 90, lifecycleSource: "inbound", ...o });
  const q = (links: any[]) => async (sql: string) =>
    /FROM velocity_order_links/.test(sql) ? { rows: links, rowCount: links.length }
      : /FROM asins/.test(sql) ? { rows: [{ asin: "B001AXZ7Q8", primary_sku: "SKU-1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
  const LINK = { velocity_order_id: "94cdd620", po_asin_id: "pa-x", po_id: "po-x", order_id: "71160468", supplier: "ulta.com", asin: "B001AXZ7Q8" };

  it("PO 71160468: 90 + the linked blank-number 30 = 120 → nothing to update, nothing to create", async () => {
    poRows = [sheet()];
    velocity = [order({}), order({ order_id: "94cdd620", order_number: "", quantity: 30 })];
    const p = await buildVelocityPlan(...RANGE, { query: q([LINK]) as any });
    expect(p.updates).toEqual([]);
    expect(p.creates).toEqual([]);
    expect(p.unchanged).toBe(2);
  });
  it("without the link the plan would push 71160468 from 90 to 120 (Velocity would then hold 150)", async () => {
    poRows = [sheet()];
    velocity = [order({}), order({ order_id: "94cdd620", order_number: "", quantity: 30 })];
    const p = await buildVelocityPlan(...RANGE, { query: q([]) as any });
    expect(p.updates).toEqual([expect.objectContaining({ order_id: "v-90", actionable: true, diffs: [{ field: "quantity", sheet_value: 120, velocity_value: 90 }] })]);
  });
  it("a linked order alone marks the row present: no create for it", async () => {
    poRows = [sheet()];
    velocity = [order({ order_id: "94cdd620", order_number: "", quantity: 120 })];
    const p = await buildVelocityPlan(...RANGE, { query: q([LINK]) as any });
    expect(p.creates).toEqual([]);
    expect(p.updates).toEqual([]);
  });
  it("a sum that differs: the one inbound order takes the difference; two inbound orders → flag only", async () => {
    poRows = [sheet({ quantity: "130", qty: 130 })];
    velocity = [order({}), order({ order_id: "94cdd620", order_number: "", quantity: 30, status: "inventory", lifecycleSource: "inventory" })];
    let p = await buildVelocityPlan(...RANGE, { query: q([LINK]) as any });
    expect(p.updates).toEqual([expect.objectContaining({ order_id: "v-90", actionable: true, diffs: [{ field: "quantity", sheet_value: 100, velocity_value: 90 }], summed: { order_ids: ["v-90", "94cdd620"], velocity_total: 120 } })]);
    velocity = [order({}), order({ order_id: "94cdd620", order_number: "", quantity: 30 })];
    p = await buildVelocityPlan(...RANGE, { query: q([LINK]) as any });
    expect(p.updates).toEqual([expect.objectContaining({ actionable: false, diffs: [{ field: "quantity", sheet_value: 130, velocity_value: 120 }] })]);
  });
  it("a row with two product lines (one create each) is compared as the row's sum, not its first line", async () => {
    poRows = [sheet({ quantity: "60", qty: 60, lineNumber: 1 }), sheet({ quantity: "60", qty: 60, lineNumber: 2, sheetRow: 3 })];
    velocity = [order({ quantity: 60 }), order({ order_id: "v-60b", quantity: 60 })];
    const p = await buildVelocityPlan(...RANGE, { query: q([]) as any });
    expect(p.updates).toEqual([]);
    expect(p.creates).toEqual([]);
  });
});

describe("the merged order list and the link helpers", () => {
  it("two blank-number orders of one ASIN both survive the union (they used to collapse into one)", () => {
    const u = unionKnownOrders([vo({ order_id: "o1", order_number: "" }) as any, vo({ order_id: "o2", order_number: "" }) as any], [], []);
    expect(u.map((o) => o.order_id)).toEqual(["o1", "o2"]);
  });
  it("linkedPairs: a link covers its PO row only while the order is live at Velocity", () => {
    const links = [{ velocity_order_id: "94cdd620", po_asin_id: "pa", po_id: "po", order_id: "71160468", supplier: "ulta.com", asin: "b001axz7q8" }];
    expect(linkedPairs(links, [{ order_id: "94cdd620" }])).toEqual([{ orderNumber: "71160468", asin: "B001AXZ7Q8", velocityOrderId: "94cdd620" }]);
    expect(linkedPairs(links, [{ order_id: "other" }])).toEqual([]);
  });
  it("History names the order as typed at Velocity", () => {
    expect(velocityOrderLabel({ id: 8785, order_number: "no_poid_at_checkout", retailer: "havalon.com", asin: "b00d79eodk", quantity: 3 })).toBe("Velocity #8785 no_poid_at_checkout · havalon.com · B00D79EODK · 3u");
    expect(velocityOrderLabel({ order_number: "", asin: "B1" })).toBe("Velocity (no Order #) · — · B1");
  });
});

describe("tracking push — linked orders are targets", () => {
  it("a blank-number inbound order linked to the PO gets the PO's tracking, and counts as in Velocity", async () => {
    const puts: string[] = [];
    const query = async (sql: string) => {
      if (sql.includes("FROM settings WHERE key = ANY")) return { rows: [{ key: "tracking.velocity_street", value: "805 grandy" }, { key: "tracking.home_streets", value: ["65 rivercrest"] }], rowCount: 2 };
      if (sql.includes("FROM po_tracking t JOIN purchase_orders p")) return { rows: [{ id: 1, po_id: "po-x", carrier: "UPS", tracking_number: "1Z999", ship_to_street: "805 grandy", status: "matched", pushed_velocity_ids: null, order_id: "71160468", ships_to: "velocity", canceled_or_returned: false }], rowCount: 1 };
      if (sql.includes("FROM velocity_order_links l")) return { rows: [{ velocity_order_id: "94cdd620", po_asin_id: "pa-x", po_id: "po-x", order_id: "71160468", supplier: "ulta.com", asin: "B001AXZ7Q8" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const blank = { order_id: "94cdd620", order_number: "", asin: "B001AXZ7Q8", status: "inbound", unit_status: "pending", trackings: [] };
    const deps: VelocityDeps = { list: async () => [blank as any], known: async () => [blank as any], append: async (ids) => { puts.push(...ids); return []; } };
    const r = await pushTracking({ query: query as any, deps });
    expect(puts).toEqual(["94cdd620"]);
    expect(r.pushed).toBe(1);
  });
});
