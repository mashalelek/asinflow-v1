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

describe("main-path asymmetry (§21) — promos/dateAdded parsed but never written", () => {
  it("/api/analyze strips promoNotes and addedAtRaw before the stream", () => {
    // Source-level pin (repo-hygiene style): now that the modal forwards
    // both keys, the main upload entry must neutralize them explicitly —
    // a future "helpful" removal of this guard should fail here, not ship.
    const src = readFileSync(join(__dirname, "../../../server/routes.ts"), "utf8");
    const analyzeIdx = src.indexOf('app.post("/api/analyze"');
    expect(analyzeIdx).toBeGreaterThan(-1);
    const handler = src.slice(analyzeIdx, analyzeIdx + 2000);
    expect(handler).toMatch(/promoNotes:\s*null/);
    expect(handler).toMatch(/addedAtRaw:\s*null/);
  });
});
