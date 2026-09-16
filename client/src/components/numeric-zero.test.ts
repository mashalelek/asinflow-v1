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
  it("is Stock − Ordered, from the SAME values those cells render", () => {
    const r = row({ stock: { available_fba: 4, reserved: 1, inbound: 2, ordered: 3, total: 10, hasSnapshot: true } as any });
    expect(getRowValue(r, "stock", "lowestFba", S)).toBe(10);
    expect(getRowValue(r, "ordered", "lowestFba", S)).toBe(3);
    expect(getRowValue(r, "fbaStock", "lowestFba", S)).toBe(7); // identity holds
  });

  it("a no-snapshot row (Stock = 0 + ordered) yields 0, never a negative", () => {
    // §6 no-snapshot rule: Stock renders available 0 + ordered, so the
    // derived column must not read as -ordered.
    const r = row({ stock: { available_fba: 0, reserved: 0, inbound: 0, ordered: 5, total: 5, hasSnapshot: false } as any });
    expect(getRowValue(r, "fbaStock", "lowestFba", S)).toBe(0);
  });

  it("is registered as a numeric, filterable column in the shared defs", () => {
    const def = ALL_COLUMNS.find((c) => c.id === "fbaStock")!;
    expect(def.label).toBe("FBA Stock");
    expect(def.group).toBe("stock");
    expect(def.defaultVisible).toBe(false); // matches Ordered, its input
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
});
