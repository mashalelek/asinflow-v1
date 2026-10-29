import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseColP } from "./po-sheet-sync";
import { resolveByColP, syncVelocityShipments, type AfAsinRow, type ColPCandidate, type Resolution, type VelocitySyncDeps } from "./shipment-sync-velocity";
import { ASIN_ACTION_ITEMS_SQL, PO_ACTION_ITEMS_SQL, PO_CLOSE_ACTION_ITEMS_SQL } from "./po-action-items";
import { RECEIVING_MISMATCH, PACK_SIZE_MISSING } from "./po-status-map";

// 2026-10-29, PO 126768935: the Heath 3-pack (B00EV882Q6) went out in six FBA
// shipments, 4 each, from a Velocity order with no Order # — unmatched
// (no_order). The Orders sheet's Col P names those six shipments on the
// Heath row; it is now a matching signal. And Received by Amazon is
// information only: "Receiving mismatch" shows, and drives nothing.

describe("parseColP", () => {
  it("the Heath cell: six ids, 4 each", () => {
    const e = parseColP("FBA19H4BCJP4 (4), FBA19H4BK2W6 (4), FBA19H4DQ297 (4), FBA19H49PNSL (4), FBA19H49VBT2 (4), FBA19H9RS9TJ (4)");
    expect(e.map((x) => x.fbaShipmentId)).toEqual(["FBA19H4BCJP4", "FBA19H4BK2W6", "FBA19H4DQ297", "FBA19H49PNSL", "FBA19H49VBT2", "FBA19H9RS9TJ"]);
    expect(e.every((x) => x.qty === 4)).toBe(true);
  });
  it("[ ] notes are stripped — including shipment ids written inside them; ';' separates too", () => {
    expect(parseColP("FBA19PH94XNG (3) [B07B7GL8J6] ; FBA19Q6CBPTJ (8)")).toEqual([
      { fbaShipmentId: "FBA19PH94XNG", qty: 3, qtyRaw: "3" }, { fbaShipmentId: "FBA19Q6CBPTJ", qty: 8, qtyRaw: "8" }]);
    expect(parseColP("FBA19NP4BVF7 (1), [FBA19N00D6L5 (1), FBA19N000Q6F (1)] - might've shipped the wrong product").map((x) => x.fbaShipmentId)).toEqual(["FBA19NP4BVF7"]);
  });
  it("tight / bare / fractional / odd quantities; free text yields nothing", () => {
    expect(parseColP("FBA19H4BCJP4(4)")).toEqual([{ fbaShipmentId: "FBA19H4BCJP4", qty: 4, qtyRaw: "4" }]);
    expect(parseColP("FBA19H4BCJP4")).toEqual([{ fbaShipmentId: "FBA19H4BCJP4", qty: null, qtyRaw: null }]);
    expect(parseColP("FBA19H4BCJP4 (3/5)")).toEqual([{ fbaShipmentId: "FBA19H4BCJP4", qty: null, qtyRaw: "3/5" }]);
    expect(parseColP("FBA19H4BCJP4 (2.5)")[0].qty).toBe(2.5);
    for (const t of ["FBM", "Canceled by walmart", "NA", "", undefined]) expect(parseColP(t as any)).toEqual([]);
  });
});

const af = (o: Partial<AfAsinRow> & { id: string; asin: string; order_id: string }): AfAsinRow =>
  ({ po_id: `p-${o.id}`, units_per_pack: 3, qty_at_prep: null, supplier: "webstaurantstore.com", order_date: "2026-06-09", sold_as: "multi-pack", velocity_units_per_pack: 3, ...o });
const noOrder: Resolution = { ok: false, reason: "no_order", orderNumber: "", retailer: "Webstraunt Store" };
const heathLine: any = { order_id: "a5b575ab", order_number: null, retailer: "Webstraunt Store", asin: "B00EV882Q6", sold_as: "multi-pack", units_per_pack: 3, quantity: 72, quantity_shipped: 60, quantity_remaining: 0 };

describe("resolveByColP", () => {
  const rows = [af({ id: "heath", asin: "B00EV882Q6", order_id: "126768935" }), af({ id: "heath2", asin: "B00EV882Q6", order_id: "999" })];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const c = (id: string, order: string): ColPCandidate => ({ po_asin_id: id, order_id: order, supplier: "webstaurantstore.com", asin: "B00EV882Q6" });
  it("one PO ASIN row named → placed (col_p)", () => {
    const colP = new Map([["FBA19H4BCJP4", [c("heath", "126768935")]], ["FBA19H4BK2W6", [c("heath", "126768935")]]]);
    expect(resolveByColP(noOrder, heathLine, ["FBA19H4BCJP4", "FBA19H4BK2W6"], colP, byId)).toMatchObject({ ok: true, how: "col_p", row: { id: "heath" } });
  });
  it("several → stays no_order, with the candidates", () => {
    const colP = new Map([["FBA19H4BCJP4", [c("heath", "126768935"), c("heath2", "999")]]]);
    const r = resolveByColP(noOrder, heathLine, ["FBA19H4BCJP4"], colP, byId);
    expect(r).toMatchObject({ ok: false, reason: "no_order", note: "Col P names 2 PO ASIN rows", candidates: [{ source: "col_p" }, { source: "col_p" }] });
    expect((r as any).candidates.map((x: any) => x.po_asin_id)).toEqual(["heath", "heath2"]);
  });
  it("any line the keys could not place uses it (po_not_found too — 2026-10-29 amendment); other ASINs and unknown FBA ids are ignored", () => {
    const colP = new Map([["FBA19H4BCJP4", [{ ...c("heath", "126768935"), asin: "B0OTHER001" }]]]);
    expect(resolveByColP(noOrder, heathLine, ["FBA19H4BCJP4"], colP, byId)).toBe(noOrder);
    expect(resolveByColP(noOrder, heathLine, ["FBA0UNKNOWN1"], colP, byId)).toBe(noOrder);
    const notFound: Resolution = { ok: false, reason: "po_not_found", orderNumber: "X", retailer: "y" };
    expect(resolveByColP(notFound, heathLine, ["FBA19H4BCJP4"], new Map([["FBA19H4BCJP4", [c("heath", "126768935")]]]), byId)).toMatchObject({ ok: true, how: "col_p", row: { id: "heath" } });
  });
});

describe("shipment sync A places the Heath line through Col P", () => {
  const SID = "7a440336-df6a-4df2-aa2c-795719087322";
  it("no Order #, shipment FBA ids in Col P for one row → a velocity row at 60 ÷ 3 = 20, counted col_p", async () => {
    const writes: Array<{ sql: string; params?: any[] }> = [];
    const query = async (sql: string, params?: any[]) => {
      const s = sql.trim();
      if (s.startsWith("SELECT pa.id, pa.po_id, pa.asin")) return { rows: [af({ id: "heath", asin: "B00EV882Q6", order_id: "126768935" })], rowCount: 1 };
      if (s.startsWith("SELECT DISTINCT c.fba_shipment_id")) return { rows: ["FBA19H49PNSL", "FBA19H4BCJP4"].map((f) => ({ fba_shipment_id: f, po_asin_id: "heath", order_id: "126768935", supplier: "webstaurantstore.com", asin: "B00EV882Q6" })), rowCount: 2 };
      if (s.startsWith("SELECT id, sc_shipment_ids FROM velocity_shipments")) return { rows: [{ id: SID, sc_shipment_ids: ["FBA19H49PNSL", "FBA19H49VBT2", "FBA19H4BCJP4", "FBA19H4BK2W6", "FBA19H4DQ297"] }], rowCount: 1 };
      if (s.startsWith("SELECT")) return { rows: [], rowCount: 0 };
      writes.push({ sql: s, params }); return { rows: [], rowCount: 1 };
    };
    const deps: VelocitySyncDeps = {
      listShipments: async () => [{ shipment_id: SID, status: "shipped", shipped_at: "Mon, 29 Jun 2026 19:39:00 GMT" } as any],
      getShipment: async () => ({ orders: [heathLine] }), listInbound: async () => [], listInventory: async () => [], now: () => new Date("2026-10-29T20:00:00Z"),
    };
    const r = await syncVelocityShipments({ dryRun: false, deps, db: { query, connect: async () => ({ query, release: () => {} }) } as any });
    expect(r.counts).toMatchObject({ linesMatched: 1, linesMatchedColP: 1, linesNoOrder: 0, linesColPAmbiguous: 0 });
    const ins = writes.find((w) => w.sql.startsWith("INSERT INTO po_asin_shipments"));
    expect(ins?.params?.slice(0, 3)).toEqual(["heath", SID, 20]);
    expect(writes.some((w) => w.sql.startsWith("INSERT INTO shipment_unmatched"))).toBe(false);
  });
});

describe("Received by Amazon is information only", () => {
  it("Receiving mismatch shows on the ASIN row and the PO when received is known and ≠ shipped (over or under)", () => {
    const cond = "(pa.qty_received_amazon IS NOT NULL AND pa.qty_received_amazon <> COALESCE(pa.qty_shipped_fba, 0))";
    expect(ASIN_ACTION_ITEMS_SQL).toContain(`SELECT '${RECEIVING_MISMATCH}' WHERE ${cond}`);
    expect(PO_ACTION_ITEMS_SQL).toContain(`SELECT '${RECEIVING_MISMATCH}' WHERE EXISTS (SELECT 1 FROM po_asins pk WHERE pk.po_id = p.id AND (pk.qty_received_amazon IS NOT NULL`);
  });
  it("auto-close reads the close set, which leaves Receiving mismatch out (and keeps the others)", () => {
    expect(PO_CLOSE_ACTION_ITEMS_SQL).not.toContain(RECEIVING_MISMATCH);
    expect(PO_CLOSE_ACTION_ITEMS_SQL).toContain(PACK_SIZE_MISSING);
    const close = readFileSync(join(__dirname, "po-close.ts"), "utf8");
    expect(close).toMatch(/\$\{PO_CLOSE_ACTION_ITEMS_SQL\} AS action_items/);
    expect(close).not.toMatch(/\bPO_ACTION_ITEMS_SQL\b/);
    // The rule's arithmetic never reads received.
    expect(close.slice(close.indexOf("export function allUnitsAccounted"), close.indexOf("export function autoCloseVerdict"))).not.toMatch(/received/);
  });
  it("the On Order pipeline never reads received", () => {
    const p = readFileSync(join(__dirname, "asin-po-pipeline.ts"), "utf8");
    const fn = p.slice(p.indexOf("export function computePipeline"), p.indexOf("export function envReconStart"));
    expect(fn).not.toMatch(/received/);
  });
  it("Pack size missing fires on Open POs only; a closed PO keeps its NULL silently", () => {
    const openOnly = "AND EXISTS (SELECT 1 FROM purchase_orders px WHERE px.id = pa.po_id AND px.closed_at IS NULL))";
    expect(ASIN_ACTION_ITEMS_SQL).toContain(openOnly);
    expect(PO_ACTION_ITEMS_SQL).toContain("px.id = pk.po_id AND px.closed_at IS NULL");
    expect(PO_CLOSE_ACTION_ITEMS_SQL).toContain("px.id = pk.po_id AND px.closed_at IS NULL");
  });
  it("Pack size missing needs a live line: ordered > 0, not fully canceled, final qty not 0", () => {
    expect(ASIN_ACTION_ITEMS_SQL).toMatch(/COALESCE\(lx\.qty_ordered, 0\) > 0 AND COALESCE\(lx\.qty_canceled, 0\) < lx\.qty_ordered AND \(lx\.final_qty IS NULL OR lx\.final_qty > 0\)/);
  });
});
