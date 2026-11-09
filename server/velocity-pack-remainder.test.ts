import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Send to Velocity — a multi-pack row whose stored ASIN units leave a remainder (Maria 2026-11-05). Walmart PO
// 200015663718988, Caress B006T0U4R4: 11 singles ordered, 1 retailer unit → ½ of a 2-pack, ASIN units 5.5 stored
// (the editor derives them); 10 belong to this PO as 5 two-packs, 1 single is a replacement for 200015557295492.
// It used to be skipped as "quantity not divisible by units/pack". Now: sent as the whole packs (5 two-packs = 10
// units), unticked in the dialog with "5 packs sent · 1 single left over"; skipped only when units/pack is not a
// whole number, not even one pack fits, or the ASIN units are missing and the retailer qty does not divide.

vi.mock("./log", () => ({ log: () => {} }));
let poRows: any[] = [];
let velocity: any[] = [];
vi.mock("./po-af-source", async (orig) => ({
  ...(await orig<typeof import("./po-af-source")>()),
  loadAfPoRows: async () => ({ rows: poRows, rawRowsRead: poRows.length, blankAsinRows: 0 }),
}));
vi.mock("./velocity-api", async (orig) => ({ ...(await orig<typeof import("./velocity-api")>()), fetchAllKnownOrders: async () => velocity }));
vi.mock("./velocity-bundle-identity", () => ({ recordableBundles: () => [], hydrateChildlessBundles: async () => ({ hydrated: 0, unplaced: [] }) }));
import { buildVelocityRecords, wholePacks } from "./velocity-export";
import { buildVelocityPlan } from "./velocity-reconcile";

process.env.VELOCITY_MIN_ORDER_DATE = "1/1/2026";
const q = async (sql: string) => /FROM asins/.test(sql) ? { rows: [{ asin: "B006T0U4R4", primary_sku: "MX-IVNI-GLKD" }], rowCount: 1 } : { rows: [], rowCount: 0 };
const RANGE: [Date, Date] = [new Date(2026, 10, 5), new Date(2026, 10, 5)];
/** The production line as loadAfPoRows maps it (po_asins.qty 5.50 × units/pack 2 = AZ 11). */
const caress = (over: Record<string, any> = {}) => ({
  sheetRow: 2, status: "Ordered", asin: "B006T0U4R4", cogs: null, prepCost: 1, qty: 5.5, qtyRaw: "5.5", supplier: "walmart.com",
  orderNumber: "200015663718988", orderDate: "11/5/2026", retailer: "walmart.com", itemName: "Caress Evenly Gorgeous Exfoliating Body Wash 18 fl oz (Pack of 2)",
  productName: "Caress Shea Butter & Brown Sugar Body Wash", qtyOrderedL: "11", setsN: "5.5", uniqueS: "1", yieldT: "0.5",
  soldAs: "multi-pack", unitsPerPack: "2", quantity: "11", shipsTo: "velocity", asinUnitsMissing: false, lineNumber: 1, ...over,
});

describe("wholePacks", () => {
  it("11 units in 2-packs → 5 packs, 10 units, 1 left over; whole quantities have none", () => {
    expect(wholePacks(11, 2)).toEqual({ packs: 5, units: 10, leftover: 1 });
    expect(wholePacks(12, 2)).toEqual({ packs: 6, units: 12, leftover: 0 });
    expect(wholePacks(1, 2)).toEqual({ packs: 0, units: 0, leftover: 1 });
  });
});

describe("buildVelocityRecords — multi-pack remainders", () => {
  it("this exact line (11 ordered, 2/pack, ASIN units 5.5 stored) → a create of 5 two-packs (10 units) and its remainder", async () => {
    poRows = [caress()];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.skips).toEqual([]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ order_number: "200015663718988", asin: "B006T0U4R4", quantity: "10", units_per_pack: "2", sold_as: "multi-pack", amazon_sku: "MX-IVNI-GLKD" });
    expect(r.packRemainders).toEqual([{ order_number: "200015663718988", asin: "B006T0U4R4", packs: 5, units_per_pack: 2, leftover: 1 }]);
  });
  it("a whole quantity is sent as before, with no remainder", async () => {
    poRows = [caress({ quantity: "10", qty: 5 })];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.records[0].quantity).toBe("10");
    expect(r.packRemainders).toEqual([]);
  });
  it("no stored ASIN units and an uneven retailer qty → still skipped, with the exact reason and the PO line", async () => {
    poRows = [caress({ asinUnitsMissing: true })];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.records).toEqual([]);
    expect(r.skips).toHaveLength(1);
    expect(r.skips[0]).toMatchObject({ reason: "invalid_pack_math", orderNumber: "200015663718988", detail: "PO 200015663718988 line 1: ASIN units missing, and 11 Product units ordered ÷ 2 Individual units per ASIN unit is not a whole number of packs" });
  });
  it("less than one pack, or units/pack not a whole number → skipped, saying which", async () => {
    poRows = [caress({ quantity: "1" }), caress({ orderNumber: "X-2", unitsPerPack: "2.5" })];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.records).toEqual([]);
    expect(r.skips.map((s) => s.detail)).toEqual(["PO 200015663718988 line 1: 1 Individual unit — less than one 2-pack", 'PO X-2 line 1: Individual units per ASIN unit "2.5" is not a whole number']);
  });
});

describe("buildVelocityPlan", () => {
  it("the line is a create with its remainder listed (the dialog leaves it unticked)", async () => {
    poRows = [caress()]; velocity = [];
    const p = await buildVelocityPlan(...RANGE, { query: q });
    expect(p.creates.map((c) => [c.order_number, c.quantity])).toEqual([["200015663718988", "10"]]);
    expect(p.packRemainders).toEqual([{ order_number: "200015663718988", asin: "B006T0U4R4", packs: 5, units_per_pack: 2, leftover: 1 }]);
    expect(p.skips).toEqual([]);
  });
  it("once Velocity holds the 10 units, the audit sees no quantity mismatch (it compares the whole packs, not 11)", async () => {
    poRows = [caress()];
    velocity = [{ order_id: "v-1", order_number: "200015663718988", asin: "B006T0U4R4", quantity: 10, units_per_pack: 2, sold_as: "multi-pack", status: "inbound", unit_status: "inbound", lifecycleSource: "inbound", date: "11/05/2026" }];
    const p = await buildVelocityPlan(...RANGE, { query: q });
    expect(p.creates).toEqual([]);
    expect(p.packRemainders).toEqual([]);
    expect(p.updates).toEqual([]);
  });
});

describe("the dialog", () => {
  const src = readFileSync(join(__dirname, "../client/src/components/upload-to-velocity-dialog.tsx"), "utf8");
  it("pre-ticks every create except a remainder row, and labels it in amber", async () => {
    expect(src).toMatch(/map\(recKey\)\.filter\(\(k\) => !remainderKeys\.has\(k\)\)/);
    expect(src).toMatch(/text-amber-700 dark:text-amber-400/);
    const { remainderLabel } = await import("../client/src/components/upload-to-velocity-dialog");
    expect(remainderLabel({ order_number: "x", asin: "y", packs: 5, units_per_pack: 2, leftover: 1 })).toBe("5 packs sent · 1 Individual unit left over");
    expect(remainderLabel({ order_number: "x", asin: "y", packs: 1, units_per_pack: 4, leftover: 3 })).toBe("1 pack sent · 3 Individual units left over");
  });
  it("shows a skip's exact reason under its label", () => expect(src).toMatch(/\{s\.detail && <div className="text-xs">\{s\.detail\}<\/div>\}/));
});
