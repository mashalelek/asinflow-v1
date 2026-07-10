import { describe, it, expect } from "vitest";
import { deriveTtl, buildSku, generateSku } from "./sku-generator";

describe("deriveTtl", () => {
  it("returns first-letters of first 3 significant words", () => {
    expect(deriveTtl("Triple Firming Renewal", "AminoGenesis")).toBe("TFR");
    expect(deriveTtl("Reishi Restorative Cleanser", "AminoGenesis")).toBe("RRC");
  });
  it("strips brand words (case-insensitive, whole-word)", () => {
    expect(deriveTtl("AminoGenesis Triple Firming Renewal", "AminoGenesis")).toBe("TFR");
    expect(deriveTtl("aminogenesis triple firming renewal", "AminoGenesis")).toBe("TFR");
  });
  it("strips multi-word brands", () => {
    // "Pure Encapsulations Magnesium Glycinate 120 Capsules"
    // → brand removed, "120" is pure-digit (dropped)
    // → words [magnesium, glycinate, capsules] → "M" + "G" + "C" = "MGC".
    // ("capsules" is not in stopwords — keeping the list small per spec.
    // TTL collisions are allowed; NNN disambiguates within (brand, dept).)
    expect(
      deriveTtl("Pure Encapsulations Magnesium Glycinate 120 Capsules", "Pure Encapsulations"),
    ).toBe("MGC");
  });
  it("two-word fallback: first letter + first 2 letters of word 2", () => {
    expect(deriveTtl("Eye Cream", "AminoGenesis")).toBe("ECR");
  });
  it("one-word fallback: first 3 letters", () => {
    expect(deriveTtl("Moisturizer", "AminoGenesis")).toBe("MOI");
  });
  it("zero significant words → XXX", () => {
    expect(deriveTtl("the and of", "AminoGenesis")).toBe("XXX");
    expect(deriveTtl("", "AminoGenesis")).toBe("XXX");
  });
  it("is deterministic — same input → same output", () => {
    const a = deriveTtl("Patagonia Terravia Mini Hip Pack", "Patagonia");
    const b = deriveTtl("Patagonia Terravia Mini Hip Pack", "Patagonia");
    expect(a).toBe(b);
  });
  it("strips punctuation", () => {
    expect(deriveTtl("Reishi, Restorative & Cleanser!", "AminoGenesis")).toBe("RRC");
  });
  it("drops tokens that don't start with a letter (model-number noise)", () => {
    // "Aqua King 790PSC10 Filter, 25Micron Rating, 3 GPM, 9-3/4 Length"
    // → strip brand "Aqua King" → tokens that survive: [790psc10, filter,
    //   25micron, rating, 3, gpm, 9, 3, 4, length]
    // → letter-start filter drops 790psc10, 25micron, 3, 9, 3, 4
    // → [filter, rating, gpm, length] → first 3 letters "FRG"
    expect(
      deriveTtl("Aqua King 790PSC10 Filter, 25Micron Rating, 3 GPM, 9-3/4 Length", "Aqua King"),
    ).toBe("FRG");
  });
  it("drops digit-prefixed alphanumeric tokens", () => {
    // "Spring Valley Vitamin C 500 Milligram with Rose Hips, 250 Tablets"
    // → strip brand → "vitamin c 500 milligram with rose hips 250 tablets"
    // → drop "c" (length 1), "500", "250" (digit-start), "with" (stopword)
    // → [vitamin, milligram, rose, hips, tablets] → "VMR"
    expect(
      deriveTtl("Spring Valley Vitamin C 500 Milligram with Rose Hips, 250 Tablets", "Spring Valley"),
    ).toBe("VMR");
  });
});

describe("buildSku (5-segment format BRD-DEP-AS3-TTL-NNN[-X])", () => {
  it("assembles canonical BRD-DEP-AS3-TTL-NNN", () => {
    expect(
      buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1 }),
    ).toBe("AMG-BPC-X8M-RRC-001");
  });
  it("produces exactly 5 segments without variant, 6 with variant", () => {
    const base = buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1 });
    const variant = buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1, variantSuffix: "A" });
    expect(base.split("-")).toHaveLength(5);
    expect(variant.split("-")).toHaveLength(6);
  });
  it("AS3 is always present at index 2 (last 3 chars of ASIN)", () => {
    const sku = buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1 });
    expect(sku.split("-")[2]).toBe("X8M");
  });
  it("zero-pads NNN to 3 digits", () => {
    expect(
      buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 7 }),
    ).toContain("-007");
    expect(
      buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 42 }),
    ).toContain("-042");
  });
  it("appends variant suffix only when provided", () => {
    expect(
      buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1, variantSuffix: "A" }),
    ).toBe("AMG-BPC-X8M-RRC-001-A");
    expect(
      buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1 }),
    ).toBe("AMG-BPC-X8M-RRC-001");
  });
  it("rejects non-3-alpha segments", () => {
    expect(() => buildSku({ brd: "AM", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1 })).toThrow();
    expect(() => buildSku({ brd: "AMG", dep: "BP", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1 })).toThrow();
  });
  it("rejects malformed ASIN", () => {
    expect(() => buildSku({ brd: "AMG", dep: "BPC", asin: "short", ttl: "RRC", nnn: 1 })).toThrow();
  });
  it("rejects NNN out of range", () => {
    expect(() => buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 0 })).toThrow();
    expect(() => buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1000 })).toThrow();
  });
  it("rejects bad variant suffix", () => {
    expect(() => buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1, variantSuffix: "AA" })).toThrow();
    expect(() => buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 1, variantSuffix: "1" })).toThrow();
  });
  it("output stays under 40 chars even with variant", () => {
    const sku = buildSku({ brd: "AMG", dep: "BPC", asin: "B0FCM6CX8M", ttl: "RRC", nnn: 999, variantSuffix: "Z" });
    expect(sku.length).toBeLessThan(40);
  });
});

describe("generateSku (end-to-end, 5-segment)", () => {
  it("wires deriveTtl into buildSku", () => {
    expect(
      generateSku({
        asin: "B0FCM6CX8M",
        brand: "AminoGenesis",
        title: "AminoGenesis Triple Firming Renewal",
        brandCode: "AMG",
        departmentCode: "BPC",
        productNumber: 4,
      }),
    ).toBe("AMG-BPC-X8M-TFR-004");
  });
  it("supports variant suffix for duplicate offer on same ASIN", () => {
    const base = generateSku({
      asin: "B0FCM6CX8M", brand: "AminoGenesis", title: "Triple Firming Renewal",
      brandCode: "AMG", departmentCode: "BPC", productNumber: 4,
    });
    const dup = generateSku({
      asin: "B0FCM6CX8M", brand: "AminoGenesis", title: "Triple Firming Renewal",
      brandCode: "AMG", departmentCode: "BPC", productNumber: 4, variantSuffix: "B",
    });
    expect(base).toBe("AMG-BPC-X8M-TFR-004");
    expect(dup).toBe("AMG-BPC-X8M-TFR-004-B");
  });
});
