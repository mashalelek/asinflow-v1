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
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const dist = (a: string, b: string) =>
    Math.sqrt(rgb(a).reduce((acc, x, i) => acc + (x - rgb(b)[i]) ** 2, 0));

  it("one per source, all distinct", () => {
    const cols = LEAD_SOURCES.map((s) => LEAD_SOURCE_COLORS[s]);
    expect(cols.filter(Boolean)).toHaveLength(LEAD_SOURCES.length);
    expect(new Set(cols).size).toBe(LEAD_SOURCES.length);
  });

  it("every value is a #RRGGBB literal", () => {
    for (const s of LEAD_SOURCES) expect(LEAD_SOURCE_COLORS[s], s).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("does not collide with the §20 tag swatch palette", () => {
    // A lead chip and a tag chip sit on the SAME row. The 17 live tag
    // colours are DB state and cannot be asserted here, but TAG_COLORS —
    // the swatch/fallback palette a new tag draws from — is in code.
    const palette = ["#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6",
                     "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16"];
    for (const s of LEAD_SOURCES) {
      expect(palette.map((c) => c.toUpperCase()), s)
        .not.toContain(LEAD_SOURCE_COLORS[s].toUpperCase());
    }
  });

  it("the OA family is a burgundy ramp, dark -> light in even steps", () => {
    const [dark, mid, light] = [
      LEAD_SOURCE_COLORS["OAL 24/7"], LEAD_SOURCE_COLORS["Spark"], LEAD_SOURCE_COLORS["OA Hunt"],
    ];
    const lum = (h: string) => rgb(h).reduce((a, b) => a + b, 0);
    expect(lum(dark)).toBeLessThan(lum(mid));
    expect(lum(mid)).toBeLessThan(lum(light));
    // "even steps": the two gaps within 25% of each other.
    const [g1, g2] = [dist(dark, mid), dist(mid, light)];
    expect(Math.abs(g1 - g2) / Math.max(g1, g2)).toBeLessThan(0.25);
  });
});
