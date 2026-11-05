import { describe, it, expect } from "vitest";
import { pushTracking, type VelocityDeps } from "./tracking-push";
import { REPLACEMENT_TRACKING_PAIRS, replacementTrackingItemsSql } from "./tracking-replacement-pair";
import { PO_ACTION_ITEMS_SQL, PO_CLOSE_ACTION_ITEMS_SQL, ASIN_ACTION_ITEMS_SQL } from "./po-action-items";
import { REPLACEMENT_TRACKING_ITEM, AUTO_ACTION_ITEMS, normalizeActionItems } from "./po-status-map";

// The one-off replacement pair (Maria 2026-11-05): 200015663718988's tracking also goes to 200015557295492's
// Velocity order (1 replacement single checks in there), in the same pass, logged in both POs' History.
const ord = (o: any) => ({ status: "inbound", unit_status: "pending", sold_as: "multi-pack", units_per_pack: 2, quantity: 10, date: "11/05/2026", retailer: "walmart.com", item_name: "Caress", asin: "B006T0U4R4", amazon_sku: "MX-IVNI-GLKD", fulfillment_type: "fba", trackings: [], ...o });
const NEW = ord({ order_id: "v-new", order_number: "200015663718988" });
const OLD = ord({ order_id: "12f9f690", order_number: "200015557295492", quantity: 12, unit_status: "partially_received", trackings: [{ carrier: "FedEx", tracking_number: "543155864970", tracking_status: null }] });
const row = (p: any = {}) => ({ id: 7, po_id: "po-new", carrier: "FEDEX", tracking_number: "888000111222", ship_to_street: "805 grandy", status: "matched", pushed_velocity_ids: null, order_id: "200015663718988", ships_to: "velocity", canceled_or_returned: false, ...p });

function world(o: { rows: any[]; inbound: any[]; logged?: boolean; putFails?: string[] }) {
  const puts: Array<{ id: string; numbers: string[] }> = [];
  const history: any[][] = [];
  let logged = !!o.logged;
  const query = async (sql: string, params?: any[]) => {
    if (sql.includes("FROM settings WHERE key = ANY")) return { rows: [{ key: "tracking.velocity_street", value: "805 grandy" }, { key: "tracking.home_streets", value: ["65 rivercrest"] }, { key: "tracking.carrier_map", value: { FEDEX: "FedEx" } }], rowCount: 3 };
    if (sql.includes("FROM po_tracking t JOIN purchase_orders p")) return { rows: o.rows, rowCount: o.rows.length };
    if (sql.startsWith("UPDATE po_tracking")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM velocity_bundle_identity")) return { rows: [], rowCount: 0 };
    if (sql.trimStart().startsWith("SELECT p.id,") && sql.includes("FROM purchase_orders p WHERE p.id = ANY")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT 1 FROM po_edit_log")) return { rows: logged ? [{}] : [], rowCount: logged ? 1 : 0 };
    if (sql.startsWith("SELECT id FROM purchase_orders WHERE order_id")) return { rows: params![0] === "200015557295492" ? [{ id: "po-old" }] : [], rowCount: 1 };
    if (sql.startsWith("INSERT INTO po_edit_log")) { history.push(params!); logged = true; return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected ${sql.slice(0, 60)}`);
  };
  const deps: VelocityDeps = {
    list: async () => o.inbound, known: async () => o.inbound,
    append: async (ids, numbers) => { if (o.putFails?.includes(ids[0])) throw new Error("HTTP 400"); puts.push({ id: ids[0], numbers }); return []; },
  };
  return { query, deps, puts, history };
}

describe("pushTracking — the replacement pair", () => {
  it("a number matched to 200015663718988 goes to its own order AND 200015557295492's, with a History row on both POs", async () => {
    const w = world({ rows: [row()], inbound: [NEW, OLD] });
    const r = await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts).toEqual([{ id: "v-new", numbers: ["888000111222"] }, { id: "12f9f690", numbers: ["888000111222"] }]);
    expect(w.history.map((h) => [h[0], h[1]])).toEqual([["po-new", "tracking also added to 200015557295492"], ["po-old", "tracking added from 200015663718988 (1 replacement single)"]]);
    expect(w.history[0][2]).toBe("888000111222 → Velocity order 12f9f690");
    expect(r.plans[0].also).toEqual([{ to_order_id: "200015557295492", velocity_order_id: "12f9f690", already: [], to_add: ["888000111222"] }]);
  });
  it("dry run: planned, nothing sent, nothing logged", async () => {
    const w = world({ rows: [row()], inbound: [NEW, OLD] });
    const r = await pushTracking({ query: w.query as any, deps: w.deps, dryRun: true });
    expect(w.puts).toEqual([]); expect(w.history).toEqual([]);
    expect(r.plans[0].also?.[0].to_add).toEqual(["888000111222"]);
  });
  it("the next pass adds nothing and logs nothing again", async () => {
    const w = world({ rows: [row({ status: "pushed" })], inbound: [ord({ ...NEW, trackings: [{ tracking_number: "888000111222" }] }), ord({ ...OLD, trackings: [...OLD.trackings, { tracking_number: "888000111222" }] })], logged: true });
    await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts).toEqual([]); expect(w.history).toEqual([]);
  });
  it("a failed PUT to the old order logs nothing (the item stays open) and does not stop the PO's own push", async () => {
    const w = world({ rows: [row()], inbound: [NEW, OLD], putFails: ["12f9f690"] });
    const r = await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts).toEqual([{ id: "v-new", numbers: ["888000111222"] }]);
    expect(w.history).toEqual([]);
    expect(r.plans[0].also?.[0].error).toBe("HTTP 400");
    expect(r.pushed).toBe(1);
  });
  it("a held or review row (not going to Velocity) is not sent to the old order either", async () => {
    const w = world({ rows: [row({ ship_to_street: "65 rivercrest" })], inbound: [NEW, OLD] });
    await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts).toEqual([]); expect(w.history).toEqual([]);
  });
  it("any other PO is untouched by the pair", async () => {
    const w = world({ rows: [row({ order_id: "200015557295492", po_id: "po-old" })], inbound: [NEW, OLD] });
    const r = await pushTracking({ query: w.query as any, deps: w.deps });
    expect(w.puts.map((p) => p.id)).toEqual(["12f9f690"]);
    expect(r.plans[0].also).toBeUndefined();
  });
});

describe("the derived action item", () => {
  it("one pair, the label Maria gave; derived (never set by hand)", () => {
    expect(REPLACEMENT_TRACKING_PAIRS.map((p) => [p.fromOrderId, p.toOrderId])).toEqual([["200015663718988", "200015557295492"]]);
    expect(REPLACEMENT_TRACKING_ITEM).toBe("Tracking also goes to 200015557295492 (1 replacement single)");
    expect(REPLACEMENT_TRACKING_PAIRS[0].label).toBe(REPLACEMENT_TRACKING_ITEM);
    expect(AUTO_ACTION_ITEMS).toContain(REPLACEMENT_TRACKING_ITEM);
    expect(normalizeActionItems([REPLACEMENT_TRACKING_ITEM])).toEqual({ ok: true, value: [] });
  });
  it("shown on the from-PO only until its History row exists — in the PO, close and ASIN unions", () => {
    const sql = replacementTrackingItemsSql("p.id");
    expect(sql).toMatch(/rp\.order_id = '200015663718988'/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM po_edit_log re WHERE re\.po_id = p\.id AND re\.field = 'tracking also added to 200015557295492'\)/);
    for (const s of [PO_ACTION_ITEMS_SQL, PO_CLOSE_ACTION_ITEMS_SQL]) expect(s).toContain(sql);
    expect(ASIN_ACTION_ITEMS_SQL).toContain(replacementTrackingItemsSql("pa.po_id"));
  });
});
