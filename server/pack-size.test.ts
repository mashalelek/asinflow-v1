import { describe, it, expect } from "vitest";
import { parsePoSheet, PO_SHEET_HEADER_EXPECT } from "./po-sheet-sync";
import { COL } from "./po-import-classify";
import { syncVelocityShipments, velocityPack, type AfAsinRow, type VelocitySyncDeps } from "./shipment-sync-velocity";
import { ASIN_ACTION_ITEMS_SQL, PO_ACTION_ITEMS_SQL, asinWriteThrough } from "./po-action-items";
import { PACK_SIZE_MISMATCH, PACK_SIZE_MISSING, normalizeActionItems } from "./po-status-map";
import { resetDefaultedPackSize } from "./po-edit";

// Pack-size reconciliation (2026-10-29). PO 126768935's Anchor Hocking 2-pack
// was blank in Col AX, imported as individual ×1, and shipment sync A divided
// Velocity's 46 component units by 1 — 46 "shipped" against 24 ordered, on
// 33 lines across 25 POs. Blank is now "not filled in"; the divisor stays
// AF's, but a disagreement is flagged, never silent.

// ── intake ────────────────────────────────────────────────────────────────────
const HEADER: string[] = Array(52).fill("");
for (const [idx, caption] of PO_SHEET_HEADER_EXPECT) HEADER[idx] = caption;
function row(o: { orderId: string; date: string; asin: string; soldAs?: string; upp?: string }): string[] {
  const c: string[] = Array(52).fill("");
  c[COL.orderId] = o.orderId; c[COL.orderDate] = o.date; c[COL.status] = "Ordered"; c[COL.supplier] = "webstaurantstore.com";
  c[COL.productName] = "Bowl"; c[COL.asin] = o.asin; c[COL.qtyOrdered] = "2"; c[COL.asinQtyTotal] = "24"; c[COL.uniqueProductsPerAsin] = "1";
  c[COL.asinQtyPerProduct] = "12"; c[COL.adjCogs] = "$2.33"; c[COL.adjProductCost] = "$27.99"; c[COL.price] = "$27.99";
  c[COL.subtotal] = "$55.98"; c[COL.orderTotal] = "$55.98"; c[COL.soldAs] = o.soldAs ?? ""; c[COL.unitsPerPack] = o.upp ?? "";
  return c;
}
const asinOf = (cells: string[][]) => parsePoSheet(HEADER, cells).pos[0].poAsins[0];

describe("sheet intake: a blank Col AX is not filled in, never individual", () => {
  it("2026 row, blank sold_as → sold_as and units_per_pack NULL", () => {
    expect(asinOf([row({ orderId: "126768935", date: "6/9/2026", asin: "B00XWY0UEM" })])).toMatchObject({ soldAs: null, unitsPerPack: null });
  });
  it("2026 row, filled → verbatim (multi-pack ×2; individual ×1)", () => {
    expect(asinOf([row({ orderId: "1", date: "6/9/2026", asin: "B00XWY0UEM", soldAs: "multi-pack", upp: "2" })])).toMatchObject({ soldAs: "multi-pack", unitsPerPack: 2 });
    expect(asinOf([row({ orderId: "2", date: "6/9/2026", asin: "B00XWY0UEM", soldAs: "individual" })])).toMatchObject({ soldAs: "individual", unitsPerPack: 1 });
  });
  it("pre-2026 row, blank → the history reading is unchanged (individual)", () => {
    expect(asinOf([row({ orderId: "3", date: "6/9/2025", asin: "B00XWY0UEM" })])).toMatchObject({ soldAs: "individual", unitsPerPack: 1 });
  });
});

// ── shipment sync A ───────────────────────────────────────────────────────────
const SID = "42462946-5947-4918-b1f0-10463d5c391a";
const vline = (o: { order_id: string; order_number: string; asin: string; sold_as: string; upp?: number | null; shipped: number }): any => ({
  order_id: o.order_id, order_number: o.order_number, retailer: "webstaurantstore.com", asin: o.asin, sold_as: o.sold_as, units_per_pack: o.upp ?? null,
  quantity: o.shipped, quantity_received: o.shipped, quantity_shipped: o.shipped, quantity_remaining: 0, status: "outbound",
});
const afRow = (o: Partial<AfAsinRow> & { id: string; asin: string; order_id: string }): AfAsinRow =>
  ({ po_id: `p-${o.id}`, units_per_pack: 1, qty_at_prep: null, supplier: "webstaurantstore.com", order_date: "2026-06-09", sold_as: "individual", velocity_units_per_pack: null, ...o });

function harness(af: AfAsinRow[], lines: any[], inventory: any[] = []) {
  const writes: Array<{ sql: string; params?: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    const s = sql.trim();
    if (s.startsWith("SELECT pa.id, pa.po_id, pa.asin")) return { rows: af.map((r) => ({ ...r })), rowCount: af.length };
    if (s.startsWith("SELECT")) return { rows: [], rowCount: 0 };
    writes.push({ sql: s, params }); return { rows: [], rowCount: 1 };
  };
  const deps: VelocitySyncDeps = {
    listShipments: async () => [{ shipment_id: SID, status: "shipped", shipped_at: "Thu, 18 Jun 2026 20:45:00 GMT" } as any],
    getShipment: async () => ({ orders: lines }),
    listInbound: async () => [],
    listInventory: async () => inventory,
    now: () => new Date("2026-10-29T18:00:00Z"),
  };
  return { db: { query, connect: async () => ({ query, release: () => {} }) }, deps, writes };
}
const shipInsert = (writes: any[], id: string) => writes.find((w) => w.sql.startsWith("INSERT INTO po_asin_shipments") && w.params?.[0] === id)?.params?.[2];

describe("shipment sync A: pack size", () => {
  it("velocityPack: individual → 1, multi-pack → its units_per_pack, bundle / unknown → not compared", () => {
    expect(velocityPack({ sold_as: "individual", units_per_pack: null })).toEqual({ soldAs: "individual", upp: 1 });
    expect(velocityPack({ sold_as: "multi-pack", units_per_pack: 2 })).toEqual({ soldAs: "multi-pack", upp: 2 });
    expect(velocityPack({ sold_as: "multi-pack", units_per_pack: null })).toBeNull();
    expect(velocityPack({ sold_as: "bundle", units_per_pack: 3 })).toBeNull();
  });

  it("AF individual ×1 vs Velocity ×2 (the Anchor Hocking line): still ÷ AF's, never capped, flagged and recorded", async () => {
    const h = harness([afRow({ id: "anchor", asin: "B00XWY0UEM", order_id: "126768935" })],
      [vline({ order_id: "c54ae2b5", order_number: "126768935", asin: "B00XWY0UEM", sold_as: "multi-pack", upp: 2, shipped: 40 })]);
    const r = await syncVelocityShipments({ dryRun: false, deps: h.deps, db: h.db as any });
    expect(r.counts).toMatchObject({ packMismatch: 1, packFilled: 0, packMissing: 0, packVelocitySet: 1 });
    expect(r.packSamples[0]).toBe("mismatch webstaurantstore.com 126768935 B00XWY0UEM: AF individual ×1, Velocity ×2");
    expect(shipInsert(h.writes, "anchor")).toBe(40);
    expect(h.writes.find((w) => w.sql.startsWith("UPDATE po_asins SET velocity_units_per_pack"))?.params).toEqual(["anchor", 2]);
    expect(h.writes.some((w) => w.sql.startsWith("UPDATE po_asins SET sold_as"))).toBe(false);
  });

  it("AF multi-pack ×2 agreeing with Velocity: ÷ 2, no flag", async () => {
    const h = harness([afRow({ id: "anchor", asin: "B00XWY0UEM", order_id: "126768935", sold_as: "multi-pack", units_per_pack: 2, velocity_units_per_pack: 2 })],
      [vline({ order_id: "c54ae2b5", order_number: "126768935", asin: "B00XWY0UEM", sold_as: "multi-pack", upp: 2, shipped: 40 })]);
    const r = await syncVelocityShipments({ dryRun: false, deps: h.deps, db: h.db as any });
    expect(r.counts).toMatchObject({ packMismatch: 0, packVelocitySet: 0 });
    expect(shipInsert(h.writes, "anchor")).toBe(20);
  });

  it("sold_as NULL: filled from Velocity (edit-logged, user NULL) and the ÷ uses the filled value", async () => {
    const h = harness([afRow({ id: "anchor", asin: "B00XWY0UEM", order_id: "126768935", sold_as: null, units_per_pack: null })],
      [vline({ order_id: "c54ae2b5", order_number: "126768935", asin: "B00XWY0UEM", sold_as: "multi-pack", upp: 2, shipped: 40 })]);
    const r = await syncVelocityShipments({ dryRun: false, deps: h.deps, db: h.db as any });
    expect(r.counts).toMatchObject({ packFilled: 1, packMissing: 0, packMismatch: 0 });
    expect(shipInsert(h.writes, "anchor")).toBe(20);
    const fill = h.writes.find((w) => w.sql.startsWith("UPDATE po_asins SET sold_as"))!;
    expect(fill.sql).toMatch(/WHERE id = \$1 AND sold_as IS NULL/);
    expect(fill.params).toEqual(["anchor", "multi-pack", 2]);
    const log = h.writes.filter((w) => w.sql.startsWith("INSERT INTO po_edit_log")).map((w) => w.params?.slice(1));
    expect(log).toEqual([[null, "asin", "anchor", "sold_as", null, "multi-pack"], [null, "asin", "anchor", "units_per_pack", null, "2"]]);
  });

  it("sold_as NULL with Velocity lines that disagree, or none: left NULL (Pack size missing), nothing filled", async () => {
    const h = harness([
      afRow({ id: "split", asin: "B00XWY0UEM", order_id: "126768935", sold_as: null, units_per_pack: null }),
      afRow({ id: "none", asin: "B0091CZ7WO", order_id: "126768935", sold_as: null, units_per_pack: null }),
    ], [
      vline({ order_id: "o1", order_number: "126768935", asin: "B00XWY0UEM", sold_as: "multi-pack", upp: 2, shipped: 40 }),
      vline({ order_id: "o2", order_number: "126768935", asin: "B00XWY0UEM", sold_as: "individual", shipped: 6 }),
    ]);
    const r = await syncVelocityShipments({ dryRun: true, deps: h.deps, db: h.db as any });
    expect(r.counts).toMatchObject({ packFilled: 0, packMissing: 2, packConflicting: 1 });
  });

  it("the inventory leg counts too: a line not yet shipped still fills / flags", async () => {
    const h = harness([afRow({ id: "heath", asin: "B00EV882Q6", order_id: "126768935", sold_as: null, units_per_pack: null })], [],
      [vline({ order_id: "a5b575ab", order_number: "126768935", asin: "B00EV882Q6", sold_as: "multi-pack", upp: 3, shipped: 0 })]);
    const r = await syncVelocityShipments({ dryRun: true, deps: h.deps, db: h.db as any });
    expect(r.counts).toMatchObject({ packFilled: 1, packMissing: 0 });
  });
});

// ── derived action items ──────────────────────────────────────────────────────
describe("Pack size missing / mismatch are derived action items", () => {
  it("the ASIN and PO unions carry both, from po_asins", () => {
    expect(ASIN_ACTION_ITEMS_SQL).toContain(`SELECT '${PACK_SIZE_MISSING}' WHERE (pa.sold_as IS NULL AND EXISTS (SELECT 1 FROM po_line_items lx WHERE lx.po_asin_id = pa.id`);
    expect(ASIN_ACTION_ITEMS_SQL).toMatch(/'Pack size mismatch' WHERE \(pa\.sold_as IS NOT NULL AND pa\.sold_as <> 'bundle' AND pa\.velocity_units_per_pack IS NOT NULL AND pa\.velocity_units_per_pack <> COALESCE\(pa\.units_per_pack, 1\)\)/);
    expect(PO_ACTION_ITEMS_SQL).toContain(`'${PACK_SIZE_MISSING}' WHERE EXISTS (SELECT 1 FROM po_asins pk WHERE pk.po_id = p.id AND (pk.sold_as IS NULL AND EXISTS`);
    expect(PO_ACTION_ITEMS_SQL).toContain(`'${PACK_SIZE_MISMATCH}' WHERE EXISTS (SELECT 1 FROM po_asins pk WHERE pk.po_id = p.id AND (pk.sold_as IS NOT NULL`);
  });
  it("never stored: the editor's echo is dropped, not refused, and never written to lines", () => {
    expect(normalizeActionItems(["See comments", PACK_SIZE_MISSING, PACK_SIZE_MISMATCH])).toEqual({ ok: true, value: ["See comments"] });
    const out = asinWriteThrough([{ id: "l1", action_items: [] }], [PACK_SIZE_MISMATCH, "See comments"]);
    expect(out.get("l1")).toEqual(["See comments"]);
  });
});

// ── backfill through the edit path ────────────────────────────────────────────
describe("resetDefaultedPackSize", () => {
  const db = (row: any, edited: boolean) => {
    const writes: Array<{ sql: string; params?: any[] }> = [];
    const query = async (sql: string, params?: any[]) => {
      const s = sql.trim();
      if (s.startsWith("SELECT id, po_id, sold_as")) return { rows: [row], rowCount: 1 };
      if (s.startsWith("SELECT 1 FROM po_edit_log")) return { rows: edited ? [{}] : [], rowCount: 0 };
      writes.push({ sql: s, params }); return { rows: [], rowCount: 1 };
    };
    return { query, writes };
  };
  it("an untouched individual ×1 default → NULL, logged", async () => {
    const d = db({ id: "a", po_id: "p", sold_as: "individual", units_per_pack: 1 }, false);
    expect(await resetDefaultedPackSize(d.query as any, "a", null)).toEqual({ poId: "p", reset: true });
    expect(d.writes[0].sql).toBe("UPDATE po_asins SET sold_as = NULL, units_per_pack = NULL WHERE id = $1");
    expect(d.writes.slice(1).map((w) => [w.params?.[4], w.params?.[5], w.params?.[6]])).toEqual([["sold_as", "individual", null], ["units_per_pack", "1", null]]);
  });
  it("a hand-edited row, or anything not individual ×1, is left alone", async () => {
    for (const [row, edited] of [[{ id: "a", po_id: "p", sold_as: "individual", units_per_pack: 1 }, true], [{ id: "a", po_id: "p", sold_as: "multi-pack", units_per_pack: 3 }, false]] as const) {
      const d = db(row, edited);
      expect((await resetDefaultedPackSize(d.query as any, "a", null)).reset).toBe(false);
      expect(d.writes).toEqual([]);
    }
  });
});
