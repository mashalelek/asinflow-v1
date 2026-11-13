import { describe, it, expect, vi } from "vitest";
import { syncVelocityAfterOrderIdRename, renamePutBody } from "./po-rename-velocity";
import type { KnownVelocityOrder } from "./velocity-api";

// Order # renamed after Upload to Velocity (Maria 2026-11-13, yarnspirations X7W12GQQ5 → SPIN-1744653): the Velocity
// order under the old number is renamed (inbound), linked (shipped, or PUT failed), the old number kept as an
// alternate; a shared old number renames and links nothing. Velocity is a fake here — never a live call.

vi.mock("./log", () => ({ log: () => {} }));

const PO = "po-1";
const order = (o: Partial<KnownVelocityOrder> & { id?: number }): KnownVelocityOrder => ({
  order_id: "v-1", order_number: "X7W12GQQ5", asin: "B092LFJCMX", date: "11/07/2026", sold_as: "multi-pack", status: "inbound",
  item_name: "Yarn 2-pack", quantity: 22, retailer: "yarnspirations.com", amazon_sku: "RED-ART", units_per_pack: 2,
  trackings: [{ carrier: "FedEx", tracking_number: "384673105692", tracking_status: null }], lifecycleSource: "inbound", id: 9986, ...o,
} as any);

/** A scripted query: the PO's rows, the sharing check, the alt ids; every write is captured. */
function fakeQuery(state: { rows?: Array<{ id: string; asin: string }>; sharing?: any[]; alt?: string | null; linkRow?: any } = {}) {
  const writes: Array<{ sql: string; params?: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id, asin FROM po_asins WHERE po_id")) return { rows: state.rows ?? [{ id: "00000000-0000-4000-8000-000000000001", asin: "B092LFJCMX" }], rowCount: 1 };
    if (s.startsWith("SELECT id, supplier, order_id FROM purchase_orders WHERE id <> $1")) return { rows: state.sharing ?? [], rowCount: 0 };
    if (s.startsWith("SELECT alt_order_ids FROM purchase_orders")) return { rows: [{ alt_order_ids: state.alt ?? null }], rowCount: 1 };
    // linkVelocityOrder's reads
    if (s.startsWith("SELECT pa.id, pa.po_id, pa.asin, p.order_id, p.supplier FROM po_asins pa")) return { rows: [{ id: params?.[0], po_id: PO, asin: "B092LFJCMX", order_id: "SPIN-1744653", supplier: "yarnspirations.com" }], rowCount: 1 };
    if (s.startsWith("SELECT l.po_asin_id, pa.po_id, p.order_id, p.supplier FROM velocity_order_links")) return { rows: state.linkRow ? [state.linkRow] : [], rowCount: 0 };
    if (s.startsWith("SELECT")) return { rows: [], rowCount: 0 };
    writes.push({ sql: s, params }); return { rows: [], rowCount: 1 };
  };
  return { query, writes };
}
const rename = (q: any, deps: any, old = "X7W12GQQ5", next = "SPIN-1744653") =>
  syncVelocityAfterOrderIdRename(q, { poId: PO, oldOrderId: old, newOrderId: next }, 1, deps);

describe("order # renamed after upload → the Velocity order follows", () => {
  it("an inbound order under the old number is PUT with the new number (current fields echoed) and logged; the old number is kept as an alternate", async () => {
    const h = fakeQuery();
    const puts: any[] = [];
    const r = await rename(h.query, { fetchKnown: async () => [order({})], update: async (id: string, body: any) => { puts.push([id, body]); } });
    expect(r.outcome).toBe("done");
    expect(puts).toEqual([["v-1", renamePutBody(order({}), "SPIN-1744653")]]);
    expect(puts[0][1]).toMatchObject({ orderNumber: "SPIN-1744653", date: "11/07/2026", asin: "B092LFJCMX", amazonSKU: "RED-ART", sold_as: "multi-pack", units_per_pack: 2, quantity: 22, trackingNumbers: [{ tracking_number: "384673105692", carrier: "FedEx", tracking_status: null }] });
    expect(r.renamed).toEqual([{ id: "#9986", orderId: "v-1", asin: "B092LFJCMX" }]);
    expect(r.warning).toBe("Velocity order #9986 renamed to SPIN-1744653 · X7W12GQQ5 kept as an alternate order #");
    expect(h.writes.map((w) => w.sql.replace(/ \(.*$/, ""))).toEqual([
      "INSERT INTO po_edit_log", // velocity_order_number
      "UPDATE purchase_orders SET alt_order_ids = $2, updated_at = NOW() WHERE id = $1",
      "INSERT INTO po_edit_log", // alt_order_ids
    ]);
    expect(h.writes[0].params).toEqual([PO, 1, "shipment", "00000000-0000-4000-8000-000000000001", "velocity_order_number", "#9986 X7W12GQQ5", "#9986 SPIN-1744653"]);
    expect(h.writes[1].params).toEqual([PO, "X7W12GQQ5"]);
  });

  it("a shipped order is linked, never PUT; the warning says so", async () => {
    const h = fakeQuery();
    const update = vi.fn();
    const r = await rename(h.query, { fetchKnown: async () => [order({ status: "shipped", lifecycleSource: "shipment" })], update });
    expect(update).not.toHaveBeenCalled();
    expect(r.linked).toEqual([{ id: "#9986", orderId: "v-1", asin: "B092LFJCMX", status: "shipped" }]);
    expect(r.warning).toBe("linked to Velocity order #9986 (already shipped) · X7W12GQQ5 kept as an alternate order #");
    const link = h.writes.find((w) => w.sql.startsWith("INSERT INTO velocity_order_links"));
    expect(link?.params?.slice(0, 2)).toEqual(["v-1", "00000000-0000-4000-8000-000000000001"]);
    expect(link?.params?.[7]).toBe("manual");
  });

  it("a failed PUT falls back to a link; the rename never throws", async () => {
    const h = fakeQuery();
    const r = await rename(h.query, { fetchKnown: async () => [order({})], update: async () => { throw new Error("502 from Velocity"); } });
    expect(r.failed).toEqual([{ id: "#9986", orderId: "v-1", asin: "B092LFJCMX", error: "502 from Velocity" }]);
    expect(r.linked).toHaveLength(1);
    expect(r.warning).toBe("linked to Velocity order #9986 (rename failed) · X7W12GQQ5 kept as an alternate order #");
  });

  it("the guard: another AF PO carries the old number (now or as an alternate) → nothing renamed, linked or kept", async () => {
    const h = fakeQuery({ sharing: [{ id: "po-2", supplier: "havalon.com", order_id: "no_poid_at_checkout" }] });
    const update = vi.fn();
    const r = await rename(h.query, { fetchKnown: async () => [order({ order_number: "no_poid_at_checkout" })], update }, "no_poid_at_checkout", "1372131");
    expect(r.outcome).toBe("shared");
    expect(update).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(r.warning).toBe("Velocity not updated: old order # is shared by 2 orders, link by hand");
  });

  it("the guard: two Velocity orders of the same ASIN under the old number → nothing renamed or linked", async () => {
    const h = fakeQuery();
    const update = vi.fn();
    const r = await rename(h.query, { fetchKnown: async () => [order({}), order({ order_id: "v-2", id: 9987 })], update });
    expect(r.outcome).toBe("shared");
    expect(update).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(r.warning).toBe("Velocity not updated: old order # is shared by 2 orders, link by hand");
  });

  it("no Velocity order under the old number: nothing to do, the warning says so; a placeholder old number is never kept as an alternate", async () => {
    const h = fakeQuery();
    const r = await rename(h.query, { fetchKnown: async () => [order({ order_number: "OTHER-1" })], update: vi.fn() }, "no_poid_at_checkout", "1372131");
    expect(r.outcome).toBe("none");
    expect(h.writes).toEqual([]);
    expect(r.warning).toBe("Velocity: no order under no_poid_at_checkout — shipments re-match on the next Sync Shipments");
  });

  it("an order under the old number for an ASIN not on this PO is left alone", async () => {
    const h = fakeQuery();
    const update = vi.fn();
    const r = await rename(h.query, { fetchKnown: async () => [order({ asin: "B0OTHER001" })], update });
    expect([r.outcome, update.mock.calls.length, h.writes.length]).toEqual(["none", 0, 0]);
  });

  it("Velocity unreachable: the rename stands, the warning says link by hand", async () => {
    const h = fakeQuery();
    const r = await rename(h.query, { fetchKnown: async () => { throw new Error("timeout"); }, update: vi.fn() });
    expect(r.outcome).toBe("unavailable");
    expect(r.warning).toBe("Velocity not updated: could not read Velocity (timeout); link by hand or run Sync Shipments later");
    expect(h.writes).toEqual([]);
  });
});
