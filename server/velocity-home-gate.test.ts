import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Upload to Velocity — the ships_to gate (SPEC §11, 2026-10-29): a Home PO
// is never pre-ticked. Its rows are built through the same guards but kept
// apart (homeRecords / homeBundles → the plan's homeCreates /
// homeBundleCreates), listed as "Self-prep — not uploaded" in the dialog.

vi.mock("./log", () => ({ log: () => {} }));
let sheetRows: any[] = [];
vi.mock("./po-af-source", () => ({
  loadAfPoRows: async () => ({ rows: sheetRows, rawRowsRead: sheetRows.length, blankAsinRows: 0 }),
  loadAfAsinCostMap: async () => ({ data: new Map(), rowsRead: 0 }),
}));
import { buildVelocityRecords } from "./velocity-export";

const q = async (sql: string) =>
  /FROM asins/.test(sql)
    ? { rows: [{ asin: "B001JJWHRK", primary_sku: "HOM-SKU-001" }, { asin: "B0VELOCITY", primary_sku: "VEL-SKU-001" }, { asin: "B0GNHTYGPF", primary_sku: "DRT-BPC-GPF-GGL-001" }], rowCount: 3 }
    : { rows: [], rowCount: 0 };

function row(over: Record<string, any> = {}) {
  return {
    sheetRow: 2, status: "Ordered", asin: "B0VELOCITY", cogs: null, prepCost: 1, qty: 30, qtyRaw: "30", supplier: "walmart.com",
    orderNumber: "V-1", orderDate: "10/23/2026", retailer: "walmart.com", itemName: "Item", productName: "Item",
    qtyOrderedL: "30", setsN: "30", uniqueS: "1", yieldT: "1", soldAs: "individual", unitsPerPack: "1", quantity: "30",
    shipsTo: "velocity", ...over,
  };
}
const RANGE: [Date, Date] = [new Date(2026, 9, 23), new Date(2026, 9, 23)];
process.env.VELOCITY_MIN_ORDER_DATE = "1/1/2026";

describe("buildVelocityRecords — Home POs kept apart", () => {
  it("a Home PO with prep > 0 (482270182's shape) is NOT a create; it is a home record", async () => {
    sheetRows = [
      row(),
      row({ asin: "B001JJWHRK", orderNumber: "482270182", supplier: "bedbathandbeyond.com", retailer: "bedbathandbeyond.com", soldAs: "multi-pack", unitsPerPack: "4", quantity: "120", shipsTo: "home" }),
    ];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.records.map((x) => x.order_number)).toEqual(["V-1"]);
    expect(r.homeRecords.map((x) => x.order_number)).toEqual(["482270182"]);
    expect(r.homeRecords[0].amazon_sku).toBe("HOM-SKU-001");
  });
  it("a Home PO with prep $0 is listed too (tickable by hand); a $0 row on a Velocity PO stays silently excluded", async () => {
    sheetRows = [
      row({ asin: "B001JJWHRK", orderNumber: "H-0", prepCost: 0, shipsTo: "home" }),
      row({ orderNumber: "V-0", prepCost: 0 }),
    ];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.records).toEqual([]);
    expect(r.homeRecords.map((x) => x.order_number)).toEqual(["H-0"]);
    expect(r.selfPrepExcluded).toBe(1);
  });
  it("a Home PO's skips are counted, not listed among the upload's skips", async () => {
    sheetRows = [row({ asin: "B0NOSKU000", orderNumber: "H-1", shipsTo: "home" }), row({ asin: "B0NOSKU001", orderNumber: "V-2" })];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.skips.map((s) => s.orderNumber)).toEqual(["V-2"]);
    expect(r.homeSkipped).toBe(1);
  });
  it("a bundle on a Home PO goes to homeBundles, with its AY/AZ flags", async () => {
    const b = { asin: "B0GNHTYGPF", orderNumber: "H-B", supplier: "walmart.com", retailer: "walmart.com", soldAs: "bundle", uniqueS: "2", setsN: "7", qtyOrderedL: "7", yieldT: "1.00", unitsPerPack: "9", quantity: null, shipsTo: "home" };
    sheetRows = [row({ ...b, productName: "A" }), row({ ...b, sheetRow: 3, productName: "B" })];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.bundles).toEqual([]);
    expect(r.homeBundles.map((x) => x.orderNumbers[0])).toEqual(["H-B"]);
    expect(r.bundleFlags).toEqual([]);
  });
});

describe("wiring", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  it("AF rows carry the PO's ships_to", () => {
    expect(read("server/po-af-source.ts")).toMatch(/shipsTo: r\.ships_to === "home" \? "home" : "velocity"/);
  });
  it("the plan filters home creates against Velocity like creates", () => {
    const rec = read("server/velocity-reconcile.ts");
    expect(rec).toMatch(/homeCreates: build\.homeRecords\.filter\(\(r\) => !matchedVelocityByKey\.has\(normKey\(r\.order_number, r\.asin\)\)\)/);
  });
  it("the dialog pre-ticks creates and bundles only — never the Home group — and sends a Home row only when ticked", () => {
    const d = read("client/src/components/upload-to-velocity-dialog.tsx");
    const preTick = d.slice(d.indexOf("setSelCreates(new Set(["), d.indexOf("setSelUpdates(new Set());"));
    expect(preTick).toMatch(/body\.creates/);
    expect(preTick).not.toMatch(/home/i);
    expect(d).toMatch(/Self-prep — not uploaded/);
    expect(d).toMatch(/const creates = \[\.\.\.allCreates, \.\.\.homeCreates\]\.filter\(\(r\) => selCreates\.has\(recKey\(r\)\)\)/);
  });
});
