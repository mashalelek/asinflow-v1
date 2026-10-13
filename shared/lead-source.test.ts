import { describe, it, expect } from "vitest";
import { normalizeLeadSource, LEAD_SOURCES, LEAD_SOURCE_COLORS } from "./schema";

// §6 lead source normalisation. The alias and multi-value rules come from
// what Master ASINs col G actually contains, found by the 2026-10-13 backfill
// dry run: 7 unrecognised strings, 5 of them two values in one cell.

describe("exact and case/space tolerant", () => {
  it("matches every enum value verbatim", () => {
    for (const s of LEAD_SOURCES) expect(normalizeLeadSource(s)).toBe(s);
  });
  it("folds case and collapses whitespace", () => {
    expect(normalizeLeadSource("  oa   hunt ")).toBe("OA Hunt");
    expect(normalizeLeadSource("oal 24/7")).toBe("OAL 24/7");
    expect(normalizeLeadSource("er")).toBe("ER");
  });
  it("blank and nullish are null, not a default", () => {
    for (const v of ["", "   ", null, undefined]) expect(normalizeLeadSource(v as any)).toBeNull();
  });
});

describe("aliases seen in col G", () => {
  it("FBA Spark -> Spark, OAH -> OA Hunt", () => {
    expect(normalizeLeadSource("FBA Spark")).toBe("Spark");
    expect(normalizeLeadSource("  fba  spark ")).toBe("Spark");
    expect(normalizeLeadSource("OAH")).toBe("OA Hunt");
  });
  it("aliases are EXACT, not prefixes", () => {
    // "OA Hunt PT" was a real tag name once; it must not silently become
    // OA Hunt here.
    expect(normalizeLeadSource("OA Hunt PT")).toBeNull();
    expect(normalizeLeadSource("Sparkle")).toBeNull();
  });
});

describe("multi-value cells: ER > MP > RA", () => {
  it("resolves every pair the sheet actually contains", () => {
    expect(normalizeLeadSource("ER, MP")).toBe("ER");
    expect(normalizeLeadSource("MP, ER")).toBe("ER");
    expect(normalizeLeadSource("ER, RA")).toBe("ER");
    expect(normalizeLeadSource("RA, ER")).toBe("ER");
    expect(normalizeLeadSource("MP, RA")).toBe("MP");
  });
  it("order within the cell does not matter — priority does", () => {
    expect(normalizeLeadSource("RA, MP")).toBe("MP");
    expect(normalizeLeadSource("RA,MP,ER")).toBe("ER");
  });
  it("accepts other separators", () => {
    for (const sep of ["/", "|", "&", "+"]) expect(normalizeLeadSource(`MP${sep}ER`), sep).toBe("ER");
  });
  it("a pair outside the priority list takes the first that resolved", () => {
    expect(normalizeLeadSource("Spark, OA Hunt")).toBe("Spark");
  });

  it("TOKENISES — it does not substring-match", () => {
    // The trap: "Supplier" contains "er". A naive includes() test would call
    // it ER and mislabel the row.
    expect(normalizeLeadSource("Supplier")).toBeNull();
    expect(normalizeLeadSource("Reseller")).toBeNull();
    expect(normalizeLeadSource("Amp")).toBeNull();     // contains "mp"
  });
  it("an unrecognised cell stays null — the CALLER decides the fallback", () => {
    expect(normalizeLeadSource("wholesale pallet")).toBeNull();
  });
});

describe("chip colours", () => {
  it("one per source, all distinct", () => {
    const cols = LEAD_SOURCES.map((s) => LEAD_SOURCE_COLORS[s]);
    expect(cols.filter(Boolean)).toHaveLength(LEAD_SOURCES.length);
    expect(new Set(cols).size).toBe(LEAD_SOURCES.length);
  });
});
