import { describe, it, expect } from "vitest";

// §18 in-batch (brand, NNN) same-product resolution (2026-09-04): claiming
// one NNN from multiple new-product rows is the documented same-product case
// (AS3 auto-disambiguates), surfaced as a per-group resolution — not a hard
// error. Live pair: B0D97XHDXR + B091ZGHPDR, both LEM STD 003, AS3 DXR/PDR.
// Single registration on the shared path is pinned server-side in
// offer-add-registry.test.ts ("reuse_ok … no reservation, no row added").
import { validateRow, planDifferentProducts } from "./offer-add-preview-dialog";

const lemRow = (asin: string) => ({
  asin,
  outcome: {
    kind: "preview" as const, asin, reused: false,
    sku: `LEM-HOM-${asin.slice(-3)}-STD-001`,
    brandCode: "LEM", registry: [], proposedNnn: 1, proposedTtl: "STD",
  } as any,
});

const A = "B0D97XHDXR", B = "B091ZGHPDR", C = "B000THIRD1";

function run(asin: string, rows: any[], edits: Record<string, { nnnInput: string; ttlForNew: string }>, same: Record<string, boolean> = {}) {
  const row = rows.find((r) => r.asin === asin)!;
  return validateRow(edits[asin], row.outcome.sku.split("-"), row.outcome, rows, edits, same);
}

describe("same-product (brand, NNN) resolution", () => {
  const rows = [lemRow(A), lemRow(B)];
  const shared = { [A]: { nnnInput: "003", ttlForNew: "STD" }, [B]: { nnnInput: "003", ttlForNew: "STD" } };

  it("unresolved: both rows get the resolution prompt (count 2), no error", () => {
    for (const asin of [A, B]) {
      const v = run(asin, rows, shared);
      expect(v.error).toBeUndefined();
      expect(v.resolution).toEqual({ groupKey: "LEM\u0000" + 3, count: 2 });
    }
  });

  it("SAME PRODUCT: both rows validate clean, share NNN 003, final SKUs distinct via AS3", () => {
    const same = { ["LEM\u00003"]: true };
    const va = run(A, rows, shared, same);
    const vb = run(B, rows, shared, same);
    expect(va.error).toBeUndefined();
    expect(va.resolution).toBeUndefined();
    expect(vb.error).toBeUndefined();
    expect(va.finalSku).toBe("LEM-HOM-DXR-STD-003");
    expect(vb.finalSku).toBe("LEM-HOM-PDR-STD-003");
  });

  it("SAME PRODUCT with diverging TTLs → correctable inline error (same product = one TTL)", () => {
    const edits = { [A]: { nnnInput: "003", ttlForNew: "STD" }, [B]: { nnnInput: "003", ttlForNew: "XYZ" } };
    const v = run(A, rows, edits, { ["LEM\u00003"]: true });
    expect(v.error).toMatch(/share one TTL/);
  });

  it("groups of 3+ resolve as ONE group (count 3, one shared groupKey)", () => {
    const rows3 = [lemRow(A), lemRow(B), lemRow(C)];
    const edits = Object.fromEntries([A, B, C].map((x) => [x, { nnnInput: "003", ttlForNew: "STD" }]));
    for (const asin of [A, B, C]) {
      const v = run(asin, rows3, edits);
      expect(v.resolution).toEqual({ groupKey: "LEM\u00003", count: 3 });
    }
    const same = { ["LEM\u00003"]: true };
    for (const asin of [A, B, C]) expect(run(asin, rows3, edits, same).error).toBeUndefined();
  });

  it("byte-identical final SKU (same AS3 too) stays a HARD error even when marked same-product", () => {
    const twin = { ...lemRow("B0XXXXXHDXR"), asin: "B0XXXXXHDXR" }; // same last-3 "DXR"
    twin.outcome = { ...twin.outcome, asin: "B0XXXXXHDXR", sku: "LEM-HOM-DXR-STD-001" };
    const rows2 = [lemRow(A), twin];
    const edits = { [A]: { nnnInput: "003", ttlForNew: "STD" }, ["B0XXXXXHDXR"]: { nnnInput: "003", ttlForNew: "STD" } };
    const sameVariants: Record<string, boolean>[] = [{}, { ["LEM\u00003"]: true }];
    for (const same of sameVariants) {
      const v = run(A, rows2, edits, same);
      expect(v.error).toMatch(/byte-identical/);
    }
  });

  it("different brands never group", () => {
    const other = lemRow(B);
    other.outcome = { ...other.outcome, brandCode: "ZZZ", sku: `ZZZ-HOM-PDR-STD-001` };
    const v = run(A, [lemRow(A), other], shared);
    expect(v.resolution).toBeUndefined();
    expect(v.error).toBeUndefined();
  });
});

describe("DIFFERENT PRODUCTS bump (planDifferentProducts)", () => {
  it("keeps the first member; later members get successive free NNNs", () => {
    expect(planDifferentProducts([A, B], new Set([3, 1]))).toEqual({ [B]: 2 });
    expect(planDifferentProducts([A, B, C], new Set([1, 2, 3]))).toEqual({ [B]: 4, [C]: 5 });
  });

  it("skips NNNs claimed by the registry or other batch rows", () => {
    expect(planDifferentProducts([A, B], new Set([1, 2, 3, 4, 6]))).toEqual({ [B]: 5 });
  });
});
