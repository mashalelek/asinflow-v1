import { describe, it, expect, vi } from "vitest";

// SPEC §11 Bundles (2026-08-31): derivation from Col N/L/T (AY/AZ are
// cross-check-only), fail-closed gates, and the child-derived match key that
// makes the manually-entered bundle (parent order_number null) classify
// matched instead of unmatched/CREATE.
import { matchKeysForOrder } from "./velocity-api";

// ── buildVelocityRecords harness: mocked sheet + db ─────────────────────────
vi.mock("./index", () => ({ log: () => {} }));

let sheetRows: any[] = [];
vi.mock("./google-sheets", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, fetchSheetRows: async () => sheetRows };
});

import { buildVelocityRecords } from "./velocity-export";

const q = async (sql: string) => {
  if (/FROM asins/.test(sql)) {
    return { rows: [
      { asin: "B0GNHTYGPF", primary_sku: "DRT-BPC-GPF-GGL-001" },
      { asin: "B0YIELD5AA", primary_sku: "YLD-BPC-5AA-TST-001" },
    ], rowCount: 2 };
  }
  return { rows: [], rowCount: 0 };
};

// A bundle component sheet row. Defaults mirror the B0GNHTYGPF ground truth.
function bRow(over: Partial<Record<string, any>> = {}) {
  return {
    sheetRow: 18, status: "Ordered", asin: "B0GNHTYGPF", cogs: null, prepCost: 2,
    qty: null, qtyRaw: "", supplier: "walmart.com",
    orderNumber: "200015210238647", orderDate: "8/30/2026", retailer: "walmart.com",
    itemName: "Dr Teal's Gardenia Grace Limited Edition Bath Set",
    productName: "Component A", qtyOrderedL: "7", setsN: "7", uniqueS: "2", yieldT: "1.00",
    soldAs: "bundle", unitsPerPack: null, quantity: null,
    ...over,
  };
}

const RANGE: [Date, Date] = [new Date(2026, 7, 30), new Date(2026, 7, 30)];
process.env.GOOGLE_SHEET_ID = "test-sheet";
process.env.VELOCITY_MIN_ORDER_DATE = "1/1/2026";

describe("bundle derivation (SPEC §11 Bundles)", () => {
  it("B0GNHTYGPF ground truth: 7 sets × 2 = 14 units, components 7 + 7", async () => {
    sheetRows = [
      bRow({ productName: "Epsom Salt Soak" }),
      bRow({ sheetRow: 19, productName: "Foaming Bath" }),
    ];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.bundles).toHaveLength(1);
    const b = r.bundles[0];
    expect(b.quantity).toBe(14);
    expect(b.units_per_pack).toBe(2);
    expect(b.sold_as).toBe("bundle");
    expect(b.amazon_sku).toBe("DRT-BPC-GPF-GGL-001");
    expect(b.bundle_items.map((c) => c.quantity)).toEqual([7, 7]);
    expect(b.bundle_items[0].order_number).toBe("200015210238647");
    expect(b.bundle_items[0].retailer).toBe("walmart.com");
    expect(b.orderNumbers).toEqual(["200015210238647"]);
    expect(r.skips).toEqual([]);
    // costs never serialized anywhere in the bundle shape
    expect(JSON.stringify(b)).not.toMatch(/unit_cost|list_price/);
  });

  it("yield-5 case: a 5-pack supplier product ordered ×1 with T=5 contributes 5 UNITS", async () => {
    sheetRows = [
      bRow({ asin: "B0YIELD5AA", orderNumber: "130097", retailer: "yvesrocherusa.com", setsN: "5", productName: "Hair Shine Vinegar", qtyOrderedL: "5", yieldT: "1.00" }),
      bRow({ asin: "B0YIELD5AA", orderNumber: "130097", retailer: "yvesrocherusa.com", setsN: "5", sheetRow: 72, productName: "5-pack Shine Shampoo", qtyOrderedL: "1", yieldT: "5.00" }),
    ];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.bundles).toHaveLength(1);
    expect(r.bundles[0].quantity).toBe(10);          // 5 sets × 2
    expect(r.bundles[0].units_per_pack).toBe(2);
    expect(r.bundles[0].bundle_items.map((c) => c.quantity)).toEqual([5, 5]);
  });

  it("completeness gate: group rows ≠ Col S → bundle_incomplete (cross-order composition deferred)", async () => {
    sheetRows = [bRow({ uniqueS: "3" })]; // one row present, S says 3
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.bundles).toEqual([]);
    expect(r.skips.map((s) => s.reason)).toEqual(["bundle_incomplete"]);
  });

  it("yield gate: unparseable Col T → bundle_component_bad_yield", async () => {
    sheetRows = [bRow(), bRow({ sheetRow: 19, productName: "B", yieldT: "" })];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.bundles).toEqual([]);
    expect(r.skips.map((s) => s.reason)).toEqual(["bundle_component_bad_yield"]);
  });

  it("sets gate: Col N disagrees across the group → bundle_sets_disagree", async () => {
    sheetRows = [bRow(), bRow({ sheetRow: 19, productName: "B", setsN: "5" })];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.bundles).toEqual([]);
    expect(r.skips.map((s) => s.reason)).toEqual(["bundle_sets_disagree"]);
  });

  it("AY/AZ are cross-check-only: mismatches FLAG (build still succeeds with derived values)", async () => {
    sheetRows = [
      bRow({ unitsPerPack: "1", quantity: "7" }), // the observed-wrong AY/AZ
      bRow({ sheetRow: 19, productName: "B" }),
    ];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.bundles).toHaveLength(1);
    expect(r.bundles[0].units_per_pack).toBe(2); // derived wins
    expect(r.bundles[0].quantity).toBe(14);
    expect(r.bundleFlags.map((f) => f.field).sort()).toEqual(["AY_units_per_pack", "AZ_quantity"]);
    expect(r.bundleFlags.find((f) => f.field === "AY_units_per_pack")).toMatchObject({ sheet: "1", derived: 2 });
  });

  it("matching AY/AZ produce no flags", async () => {
    sheetRows = [
      bRow({ unitsPerPack: "2", quantity: "14" }),
      bRow({ sheetRow: 19, productName: "B" }),
    ];
    const r = await buildVelocityRecords(...RANGE, { query: q });
    expect(r.bundles).toHaveLength(1);
    expect(r.bundleFlags).toEqual([]);
  });
});

describe("child-derived match key (SPEC §11 Bundles)", () => {
  const manualBundle = {
    order_number: null as any, asin: "B0GNHTYGPF", sold_as: "bundle",
    bundle_children: [
      { order_number: "200015210238647" },
      { order_number: "200015210238647" },
    ],
  };

  it("bundle: one key per distinct child order_number × parent asin", () => {
    expect(matchKeysForOrder(manualBundle)).toEqual([
      { orderNumber: "200015210238647", asin: "B0GNHTYGPF" },
    ]);
  });

  it("the manual bundle classifies MATCHED once keyed (child key equals the sheet group key)", () => {
    const keys = matchKeysForOrder(manualBundle);
    const norm = (o: string, a: string) => `${o.trim()} ${a.trim().toUpperCase()}`;
    const sheetKey = norm("200015210238647", "B0GNHTYGPF"); // the bundle group's (order, asin)
    expect(keys.map((k) => norm(k.orderNumber, k.asin))).toContain(sheetKey);
    // vs the parent's own key, which is unmatched-void (order_number null)
    expect(norm(String(manualBundle.order_number ?? ""), manualBundle.asin)).not.toBe(sheetKey);
  });

  it("flat orders keep the (order_number, asin) key; bundle with no child numbers falls back", () => {
    expect(matchKeysForOrder({ order_number: "129152747", asin: "B0015RJHOC", sold_as: "individual" }))
      .toEqual([{ orderNumber: "129152747", asin: "B0015RJHOC" }]);
    expect(matchKeysForOrder({ order_number: null as any, asin: "B0X", sold_as: "bundle", bundle_children: [] }))
      .toEqual([{ orderNumber: "", asin: "B0X" }]);
  });
});
