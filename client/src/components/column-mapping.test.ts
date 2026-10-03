import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { MAPPING_FIELDS, NOT_IN_FILE, buildColumnMapping } from "./column-mapping";
import { autoMatch } from "./column-mapping-modal";

// §21 mapping-modal serialization (2026-09-08). The 42f0f42 regression:
// promos/dateAdded were in MAPPING_FIELDS (auto-match + green check worked)
// but handleContinue's hand-typed literal dropped both — optional in the
// ColumnMapping type, so tsc stayed silent, and every uploaded row silently
// got NOW() as its Date Added. These tests pin the two invariants that bug
// violated: the builder forwards EVERY field key, and the main path keeps
// ignoring the two bulk-only fields (the deliberate §21 asymmetry).

describe("buildColumnMapping — completeness", () => {
  it("emits every MAPPING_FIELDS key (a field can never be silently dropped again)", () => {
    const mappings = Object.fromEntries(MAPPING_FIELDS.map((f) => [f.key, `col-${f.key}`]));
    const out = buildColumnMapping(mappings) as unknown as Record<string, string | null>;
    for (const f of MAPPING_FIELDS) {
      expect(out[f.key], `mapping key ${String(f.key)} dropped by the builder`).toBe(`col-${String(f.key)}`);
    }
    // And specifically the two keys the 42f0f42 literal dropped:
    expect(out.dateAdded).toBe("col-dateAdded");
    expect(out.promos).toBe("col-promos");
  });

  it("unmapped / not-in-file optionals serialize as null; required keep their '' sentinel", () => {
    const out = buildColumnMapping({ asin: "ASIN", cogs: "", dateAdded: NOT_IN_FILE }) as unknown as Record<string, string | null>;
    expect(out.asin).toBe("ASIN");
    expect(out.cogs).toBe("");
    expect(out.dateAdded).toBeNull();
    expect(out.promos).toBeNull();
  });
});

describe("main-path asymmetry (§21) — dateAdded dropped, promos WRITTEN", () => {
  // Narrowed 2026-09-27. promos used to be nulled here alongside dateAdded;
  // that was reversed (CSV promos now land on the new-ASIN INSERT, like
  // notes). dateAdded stays dropped because `asins` has no backdatable
  // added_at column to write it to.
  const handler = () => {
    const src = readFileSync(join(__dirname, "../../../server/routes.ts"), "utf8");
    const analyzeIdx = src.indexOf('app.post("/api/analyze"');
    expect(analyzeIdx).toBeGreaterThan(-1);
    return src.slice(analyzeIdx, analyzeIdx + 2000);
  };

  it("/api/analyze still strips addedAtRaw — no column to write it to", () => {
    expect(handler()).toMatch(/addedAtRaw:\s*null/);
  });

  it("/api/analyze does NOT strip promoNotes — reinstating the null would re-drop CSV promos", () => {
    expect(handler()).not.toMatch(/promoNotes:\s*null/);
  });

  it("promos reach the INSERT branch, insert-only like notes", () => {
    const src = readFileSync(join(__dirname, "../../../server/routes.ts"), "utf8");
    const sink = src.slice(src.indexOf("export const mainCatalogSink"), src.indexOf("async function writeResult"));
    expect(sink).toMatch(/promoNotesForInsert\s*=\s*fromCsvUpload\s*\?\s*inputPromoNotes/);
    // Existing ASINs keep their prior value — there is no non-insert write.
    expect(sink).toMatch(/promo_notes: intentionally NO existing-ASIN write/);
  });
});


// §6 Buy Link (2026-10-03): the ASINs-page export emits header "Buy Link"
// whenever the column is visible, and that export is an upload source — so
// the header has to be a mapper alias on BOTH matchers. It already was;
// these pin it so a future alias cleanup can't silently break the round-trip.
describe("\"Buy Link\" round-trips from the ASINs export into the upload mapper", () => {
  it("the modal's matchPatterns claim it for buyLink", () => {
    const f = MAPPING_FIELDS.find((x) => x.key === "buyLink")!;
    expect(f.matchPatterns.some((re) => re.test("Buy Link"))).toBe(true);
  });

  it("the server's COLUMN_NAME_ALIASES lists it verbatim", () => {
    const src = readFileSync(join(__dirname, "../../../server/routes.ts"), "utf8");
    const i = src.indexOf("const COLUMN_NAME_ALIASES");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf("};", i));
    const line = block.split("\n").find((l) => l.trim().startsWith("buyLink:")) ?? "";
    expect(line).toContain('"buy link"');
  });
});

// ============================================================================
// §6 Export CSV headers round-trip (2026-10-03)
// ============================================================================
// The ASINs-page export is an upload source, so its headers must be mapper
// aliases. Group-qualifying the duplicate COGS / Prep Cost headers is what
// made "Actual COGS" a real, matchable header for the first time.
describe("group-qualified export headers map back on re-import", () => {
  const field = (k: string) => MAPPING_FIELDS.find((f) => f.key === k)!;
  const matches = (k: string, header: string) => {
    const f = field(k);
    if (f.excludePatterns?.some((re) => re.test(header))) return false;
    return f.matchPatterns.some((re) => re.test(header));
  };

  it('"Buy Link" maps to buyLink — the ASINs export -> Bulk Calc upload path', () => {
    expect(matches("buyLink", "Buy Link")).toBe(true);
  });

  it('"Estimated COGS" and "Estimated Prep Cost" still map after qualifying', () => {
    expect(matches("cogs", "Estimated COGS")).toBe(true);
    expect(matches("prepCost", "Estimated Prep Cost")).toBe(true);
  });

  it('"Actual COGS" / "Actual Prep Cost" are NEVER claimed — actuals are not CSV-sourced', () => {
    expect(matches("cogs", "Actual COGS")).toBe(false);
    expect(matches("prepCost", "Actual Prep Cost")).toBe(false);
  });

  it("unqualified legacy headers keep working", () => {
    expect(matches("cogs", "COGS")).toBe(true);
    expect(matches("prepCost", "Prep Cost")).toBe(true);
  });
});

// The server's COLUMN_NAME_ALIASES is the OTHER matcher (exact match on the
// normalized header, used by the upload parse path) and is private to
// routes.ts — pinned here as source text, the same way the §21 asymmetry
// test above reads that file.
describe("server-side COLUMN_NAME_ALIASES carries the qualified headers", () => {
  const aliasLine = (field: string) => {
    const src = readFileSync(join(__dirname, "../../../server/routes.ts"), "utf8");
    const i = src.indexOf("const COLUMN_NAME_ALIASES");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf("};", i));
    return block.split("\n").find((l) => l.trim().startsWith(`${field}:`)) ?? "";
  };

  it("cogs accepts the qualified Estimated header but never the Actual one", () => {
    const line = aliasLine("cogs");
    expect(line).toContain('"estimated cogs"');
    expect(line).not.toContain('"actual cogs"');
  });

  it("prepCost accepts the qualified Estimated header but never the Actual one", () => {
    const line = aliasLine("prepCost");
    expect(line).toContain('"estimated prep cost"');
    expect(line).not.toContain('"actual prep cost"');
  });
});

// ============================================================================
// Export -> re-import BINDING (2026-10-03)
// ============================================================================
// Drives the real autoMatch over a realistic ASINs-page export header row.
// Column order matters and is the whole point: DEFAULT_COLUMNS puts the
// Actuals group BEFORE Estimates, and autoMatch takes the first matching
// header in FILE order — so without the excludePatterns guard the Actual
// column wins and the Estimated one is left unmapped.
describe("re-importing an export with BOTH Actual and Estimated columns", () => {
  // Actuals first, exactly as the export emits them.
  const EXPORT_HEADERS = [
    "ASIN", "SKU", "Title", "Brand", "Supplier", "Buy Link", "Supplier SKU",
    "Actual COGS", "Actual Prep Cost",
    "Estimated COGS", "Estimated Prep Cost", "Estimated Sale Price",
    "Tags", "Notes",
  ];

  it("binds cogs to the ESTIMATED column, never the Actual one", () => {
    expect(autoMatch(EXPORT_HEADERS).cogs).toBe("Estimated COGS");
  });

  it("binds prepCost to the ESTIMATED column, never the Actual one", () => {
    expect(autoMatch(EXPORT_HEADERS).prepCost).toBe("Estimated Prep Cost");
  });

  it("binds buyLink to the full-URL Buy Link column, not Supplier", () => {
    expect(autoMatch(EXPORT_HEADERS).buyLink).toBe("Buy Link");
  });

  it("still binds correctly when only the unqualified legacy headers exist", () => {
    const legacy = ["ASIN", "COGS", "Prep Cost", "Buy Link"];
    const m = autoMatch(legacy);
    expect(m.cogs).toBe("COGS");
    expect(m.prepCost).toBe("Prep Cost");
  });

  it("leaves cogs UNMAPPED rather than grabbing an Actual-only export", () => {
    // No Estimated column present: better unmapped (the modal blocks
    // Continue on a required field) than silently importing actuals.
    const actualsOnly = ["ASIN", "Actual COGS", "Actual Prep Cost"];
    const m = autoMatch(actualsOnly);
    expect(m.cogs).toBeUndefined();
    expect(m.prepCost).toBeUndefined();
  });
});
