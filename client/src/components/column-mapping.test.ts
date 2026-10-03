import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { MAPPING_FIELDS, NOT_IN_FILE, buildColumnMapping } from "./column-mapping";

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
