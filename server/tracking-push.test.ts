// Tracking → Velocity push (SPEC §26, patch commit 5).
import { describe, it, expect, afterEach } from "vitest";
import { indexInbound, buildTrackingPutBody, pushTracking, trackingNumbersOf, setTrackingElementShape, type VelocityDeps } from "./tracking-push";

const ord = (o: any) => ({ status: "inbound", unit_status: "pending", sold_as: "multi-pack", units_per_pack: 4, quantity: 20, date: "10/09/2026", retailer: "macys.com", item_name: "Frango", asin: "B081S8MTJ5", amazon_sku: "BC-DO62-O14S", fulfillment_type: "fba", trackings: [], ...o });
afterEach(() => setTrackingElementShape("object"));

describe("indexInbound", () => {
  it("only inbound + pending / partially_received; trimmed order numbers; bundle parents through their children", () => {
    const m = indexInbound([
      ord({ order_id: "a", order_number: " 4798028553 " }),
      ord({ order_id: "b", order_number: "4798028553", unit_status: "fully_received" }),
      ord({ order_id: "c", order_number: "4798028553", status: "inventory" }),
      ord({ order_id: "d", order_number: null, sold_as: "bundle", bundle_children: [{ order_number: "111" }, { order_number: "222" }] }),
    ] as any);
    expect(m.get("4798028553")!.map((o) => o.order_id)).toEqual(["a"]);
    expect(m.get("111")!.map((o) => o.order_id)).toEqual(["d"]);
  });
});

describe("buildTrackingPutBody — echo-merge", () => {
  it("echoes every field incl. quantity (PUT is full-replace), appends only missing numbers, never removes", () => {
    const cur = ord({ order_id: "a", order_number: "4798028553", trackings: [{ carrier: "FedEx", tracking_number: "875279827111", tracking_status: null }] });
    const b = buildTrackingPutBody(cur as any, [{ carrier: "UPS", tracking_number: "1ZE3652C0344289436" }, { carrier: "FedEx", tracking_number: "875279827111" }]);
    expect(b).toMatchObject({ date: "10/09/2026", retailer: "macys.com", orderNumber: "4798028553", itemName: "Frango", asin: "B081S8MTJ5", amazonSKU: "BC-DO62-O14S", sold_as: "multi-pack", units_per_pack: 4, quantity: 20, fulfilledBy: "fba" });
    expect(b.trackingNumbers).toEqual([{ carrier: "FedEx", tracking_number: "875279827111" }, { carrier: "UPS", tracking_number: "1ZE3652C0344289436" }]);
    expect(JSON.stringify(b)).not.toMatch(/cogs|unit_cost|list_price|listPrice/);
  });
  it("string shape (if the probe says so) sends plain numbers, the existing ones too", () => {
    setTrackingElementShape("string");
    const b = buildTrackingPutBody(ord({ order_id: "a", trackings: [{ carrier: "FedEx", tracking_number: "875279827111" }] }) as any, [{ carrier: "UPS", tracking_number: "1Z1" }]);
    expect(b.trackingNumbers).toEqual(["875279827111", "1Z1"]);
  });
});

function world(o: { rows: any[]; inbound: any[]; putFails?: string[] }) {
  const updates: any[][] = [];
  const puts: Array<{ id: string; body: any }> = [];
  const gets: string[] = [];
  const query = async (sql: string, params?: any[]) => {
    if (sql.includes("FROM settings WHERE key = ANY")) return { rows: [{ key: "tracking.velocity_street", value: "805 grandy" }, { key: "tracking.home_streets", value: ["65 rivercrest"] }, { key: "tracking.carrier_map", value: { UPS: "UPS", FEDEX: "FedEx" } }], rowCount: 3 };
    if (sql.includes("FROM po_tracking t JOIN purchase_orders p")) return { rows: o.rows, rowCount: o.rows.length };
    if (sql.startsWith("UPDATE po_tracking")) { updates.push(params!); return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected ${sql.slice(0, 60)}`);
  };
  const deps: VelocityDeps = {
    list: async () => o.inbound,
    get: async (id) => { gets.push(id); return o.inbound.find((x) => x.order_id === id); },
    put: async (id, body) => { if (o.putFails?.includes(id)) throw new Error("Velocity PUT failed (HTTP 400) | message: bad"); puts.push({ id, body }); return {}; },
  };
  return { query, deps, updates, puts, gets };
}
const row = (p: any = {}) => ({ id: 1, po_id: "po-1", carrier: "UPS", tracking_number: "1ZE3652C0344289436", ship_to_street: "805 grandy", status: "matched", pushed_velocity_ids: null, order_id: "4798028553", ships_to: "velocity", canceled_or_returned: false, ...p });

describe("pushTracking", () => {
  it("pushes to EVERY target order of the PO, re-reading each right before its PUT; row → pushed with the order ids", async () => {
    const w = world({ rows: [row()], inbound: [ord({ order_id: "v1", order_number: "4798028553" }), ord({ order_id: "v2", order_number: "4798028553", asin: "B0OTHER" })] });
    const r = await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts.map((p) => p.id)).toEqual(["v1", "v2"]);
    expect(w.gets).toEqual(["v1", "v2"]);
    expect(w.puts[0].body.trackingNumbers).toEqual([{ carrier: "UPS", tracking_number: "1ZE3652C0344289436" }]);
    expect(r).toMatchObject({ pushed: 1, puts: 2 });
    expect(w.updates[0].slice(1, 5)).toEqual(["pushed", null, null, ["v1", "v2"]]);
  });
  it("idempotent: every target already has the number → pushed, no PUT; partial coverage → PUT only the missing order", async () => {
    const has = [{ carrier: "UPS", tracking_number: "1ZE3652C0344289436" }];
    let w = world({ rows: [row()], inbound: [ord({ order_id: "v1", order_number: "4798028553", trackings: has })] });
    let r = await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts).toHaveLength(0);
    expect(r.already_present).toBe(1);
    expect(w.updates[0][1]).toBe("pushed");
    w = world({ rows: [row()], inbound: [ord({ order_id: "v1", order_number: "4798028553", trackings: has }), ord({ order_id: "v2", order_number: "4798028553" })] });
    r = await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts.map((p) => p.id)).toEqual(["v2"]);
  });
  it("a PUT error → push_failed with the Velocity error as the review reason; the other orders still get their PUT", async () => {
    const w = world({ rows: [row()], inbound: [ord({ order_id: "v1", order_number: "4798028553" }), ord({ order_id: "v2", order_number: "4798028553" })], putFails: ["v1"] });
    const r = await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts.map((p) => p.id)).toEqual(["v2"]);
    expect(r.push_failed).toBe(1);
    expect(w.updates[0][1]).toBe("push_failed");
    expect(w.updates[0][2]).toMatch(/v1: Velocity PUT failed/);
  });
  it("not in Velocity → review, no PUT; home PO with a home street → held", async () => {
    let w = world({ rows: [row({ order_id: "999" })], inbound: [] });
    await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts).toHaveLength(0);
    expect(w.updates[0]).toEqual([1, "matched", "not in Velocity"]);
    w = world({ rows: [row({ order_id: "999", ships_to: "home", ship_to_street: "65 rivercrest" })], inbound: [] });
    await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.updates[0]).toEqual([1, "held", null]);
  });
  it("a bundle parent is never written — the row asks for a hand push", async () => {
    const w = world({ rows: [row({ order_id: "111" })], inbound: [ord({ order_id: "b1", order_number: null, sold_as: "bundle", bundle_children: [{ order_number: "111" }] })] });
    await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts).toHaveLength(0);
    expect(w.updates[0][2]).toMatch(/bundle order in Velocity \(b1\) — add tracking by hand/);
  });
  it("a dry run plans per PO and writes nothing — no PUT, no row update, no fresh GET", async () => {
    const w = world({ rows: [row()], inbound: [ord({ order_id: "v1", order_number: "4798028553" })] });
    const r = await pushTracking({ query: w.query as any, deps: w.deps, dryRun: true });
    expect(w.puts).toHaveLength(0);
    expect(w.updates).toHaveLength(0);
    expect(w.gets).toHaveLength(0);
    expect(r.plans[0].targets).toEqual([{ velocity_order_id: "v1", asin: "B081S8MTJ5", already: [], to_add: ["1ZE3652C0344289436"] }]);
  });
  it("tracking numbers on a GET order, objects or strings", () => {
    expect(trackingNumbersOf({ trackings: [{ tracking_number: "1za" }, "875" as any] })).toEqual(["1ZA", "875"]);
  });
});
