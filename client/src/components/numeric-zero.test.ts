import { describe, it, expect } from "vitest";
import { getRowValue } from "./results-table";
import { matchesFilters, NUMERIC_COLS } from "./column-filter";
import { defaultSettings } from "@/lib/settings";
import { ALL_COLUMNS, type AsinResult } from "@shared/schema";

// §6 (2026-09-17): FBA Stock, and null-sorts-and-filters-as-zero.
const S = defaultSettings;

function row(over: Partial<AsinResult> = {}): AsinResult {
  return {
    asin: "B0NUM00001", cogs: 0, estimatedCogs: null, actualCogs: null,
    buyLink: null, prepOverride: null, storageOverride: null,
    pricingData: { lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null, lowestPrice: null,
      avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: null, sellersFba: null, sellersFbm: null },
    feesData: { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null },
    catalogData: { weightLbs: null, title: "t", brand: null, imageUrl: null, bsrRank: null, bsrCategory: null },
    eligibilityData: { status: "check" }, error: null, ...over,
  } as AsinResult;
}

describe("FBA Stock column", () => {
  // It is a REAL field on the row model, computed server-side where rows are
  // built — not derived at read time. These pin the contract the 2026-09-17
  // filter bug violated: one number, of type number, for every consumer.
  it("reads the row-model field, typed number, for sort/filter/CSV alike", () => {
    const r = row({ stock: { available_fba: 4, reserved: 1, inbound: 2, ordered: 3, total: 10, hasSnapshot: true } as any, fbaStock: 7 });
    const v = getRowValue(r, "fbaStock", "lowestFba", S);
    expect(typeof v).toBe("number"); // a string silently breaks "greater than"
    expect(v).toBe(7);
    expect(getRowValue(r, "stock", "lowestFba", S)).toBe(10);
    expect(getRowValue(r, "ordered", "lowestFba", S)).toBe(3);
  });

  it("'FBA Stock > 0' matches exactly the rows whose value is > 0", () => {
    const rows = [row({ fbaStock: 59 }), row({ fbaStock: 0 }), row({ fbaStock: 5 })];
    const gt0 = { fbaStock: { colId: "fbaStock", operator: "gt", value: "0" } } as any;
    const hits = rows.filter((r) => matchesFilters(r, gt0, (c) => getRowValue(r, c, "lowestFba", S)));
    expect(hits.map((r) => r.fbaStock)).toEqual([59, 5]);
    const eq0 = { fbaStock: { colId: "fbaStock", operator: "eq", value: "0" } } as any;
    const zeros = rows.filter((r) => matchesFilters(r, eq0, (c) => getRowValue(r, c, "lowestFba", S)));
    expect(zeros.map((r) => r.fbaStock)).toEqual([0]);
  });

  it("an absent field reads 0 (no-snapshot rows), never a negative", () => {
    const r = row({ stock: { available_fba: 0, reserved: 0, inbound: 0, ordered: 5, total: 5, hasSnapshot: false } as any });
    expect(getRowValue(r, "fbaStock", "lowestFba", S)).toBe(0);
  });

  it("is registered as a numeric, filterable column in the shared defs", () => {
    const def = ALL_COLUMNS.find((c) => c.id === "fbaStock")!;
    expect(def.label).toBe("FBA Stock");
    expect(def.group).toBe("stock");
    expect(def.defaultVisible).toBe(true); // visible wherever Stock/Ordered are
    expect(NUMERIC_COLS.has("fbaStock")).toBe(true);
  });
});

describe("null sorts and filters as zero", () => {
  it("every NUMERIC column reports 0 rather than null on an empty row", () => {
    const r = row();
    const nulls = Array.from(NUMERIC_COLS).filter((c) => getRowValue(r, c, "lowestFba", S) == null);
    expect(nulls, `these numeric columns still report null: ${nulls.join(", ")}`).toEqual([]);
  });

  it("'ROI <= 0' now MATCHES a row that used to render a dash (the whole point)", () => {
    const r = row(); // no price, no cogs → ROI was "-"
    const filters = { roi: { colId: "roi", operator: "lte", value: "0" } } as any;
    expect(matchesFilters(r, filters, (c) => getRowValue(r, c, "lowestFba", S))).toBe(true);
  });

  it("null-backed zeros and true zeros are indistinguishable to sort", () => {
    const nullRow = row();
    const zeroRow = row({ actuals: { units_sold: 0, revenue: 0, units_refunded: 0 } as any });
    expect(getRowValue(nullRow, "actRevenue", "lowestFba", S))
      .toBe(getRowValue(zeroRow, "actRevenue", "lowestFba", S));
  });

  it("non-numeric columns keep their dashes (hazmat tri-state unchanged)", () => {
    expect(getRowValue(row({ isHazmat: null } as any), "hazmat", "lowestFba", S)).toBe("—");
  });

  it("'Actual Units Sold = 0' and 'Actual Revenue <= 0' match a no-orders row", () => {
    const r = row(); // no actuals at all — absence of orders IS zero
    const eq0 = { actUnitsSold: { colId: "actUnitsSold", operator: "eq", value: "0" } } as any;
    const lte0 = { actRevenue: { colId: "actRevenue", operator: "lte", value: "0" } } as any;
    expect(matchesFilters(r, eq0, (c) => getRowValue(r, c, "lowestFba", S))).toBe(true);
    expect(matchesFilters(r, lte0, (c) => getRowValue(r, c, "lowestFba", S))).toBe(true);
  });

  it("Actual COGS with no PO row is a first-class 0 for filters", () => {
    const r = row({ actualCogs: null });
    const eq0 = { cogs: { colId: "cogs", operator: "eq", value: "0" } } as any;
    expect(matchesFilters(r, eq0, (c) => getRowValue(r, c, "lowestFba", S))).toBe(true);
  });
});

describe("one accessor — the main page must not re-derive filter values", () => {
  it("home.tsx filters through getRowValue, not a local switch", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(__dirname, "..", "pages", "home.tsx"), "utf8");
    const call = src.slice(src.indexOf("matchesFilters(r as any"), src.indexOf("matchesFilters(r as any") + 200);
    expect(call).toContain("getRowValue");
    // The old duplicate switch is gone — its tell-tale cases must not return.
    expect(src).not.toMatch(/case "actRefundPct":\s*\n\s*return r\.actuals/);
  });
});
