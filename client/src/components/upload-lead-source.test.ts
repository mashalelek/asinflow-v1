import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { autoMatch } from "./column-mapping-modal";
import { MAPPING_FIELDS, buildColumnMapping, NOT_IN_FILE } from "./column-mapping";
import { normalizeLeadSource } from "@shared/schema";

// §6 upload lead source (2026-10-13). Two inputs, one precedence rule:
// the dialog supplies ONE value for the whole upload; a lead_source column
// in the file overrides it per row, because the file is more specific than
// the dropdown.

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]+\/\/.*$/gm, "");
const code = (p: string) => stripComments(readFileSync(join(__dirname, p), "utf8"));
const server = (p: string) => stripComments(readFileSync(join(__dirname, "..", "..", "..", "server", p), "utf8"));

describe("the per-row CSV column", () => {
  it("is a real mapping field, so buildColumnMapping cannot drop it", () => {
    // The 42f0f42 bug: a hand-typed literal in handleContinue silently
    // dropped promos/dateAdded. buildColumnMapping derives from
    // MAPPING_FIELDS precisely so that cannot recur.
    expect(MAPPING_FIELDS.some((f) => f.key === "leadSource")).toBe(true);
    const built = buildColumnMapping({ asin: "ASIN", leadSource: "Lead Source" });
    expect(built.leadSource).toBe("Lead Source");
  });

  it("is optional — an upload with no such column still maps", () => {
    expect(MAPPING_FIELDS.find((f) => f.key === "leadSource")!.required).toBe(false);
    expect(buildColumnMapping({ asin: "ASIN" }).leadSource).toBeNull();
  });

  it("NOT_IN_FILE resolves to null, not the literal sentinel", () => {
    expect(buildColumnMapping({ asin: "ASIN", leadSource: NOT_IN_FILE }).leadSource).toBeNull();
  });

  it("auto-matches the ASINs-export header and bare variants", () => {
    for (const h of ["Lead Source", "lead source", "lead_source", "Description: Lead Source"]) {
      expect(autoMatch(["ASIN", h]).leadSource, h).toBe(h);
    }
  });

  it("does not steal an unrelated header", () => {
    const m = autoMatch(["ASIN", "Supplier", "Source URL", "Buy Link"]);
    expect(m.leadSource).toBeUndefined();
  });
});

describe("the list-wide dialog select", () => {
  const modal = code("column-mapping-modal.tsx");

  it("offers every enum value plus None", () => {
    expect(modal).toMatch(/LEAD_SOURCES\.map\(\(ls\) =>/);
    expect(modal).toMatch(/<SelectItem value=\{NONE_LEAD_SOURCE\}>None<\/SelectItem>/);
  });

  it("None uses a sentinel — Radix Select cannot hold an empty string", () => {
    expect(modal).toMatch(/const NONE_LEAD_SOURCE = "__none__"/);
    expect(modal).toMatch(/v === NONE_LEAD_SOURCE \? "" : v/);
  });

  it("is passed to onContinue as null when None", () => {
    expect(modal).toMatch(/onContinue\(buildColumnMapping\(mappings\), leadSource \|\| null\)/);
  });

  it("FileUpload omits the field entirely when None, rather than sending ''", () => {
    // An empty string would reach normalizeLeadSource as "" -> null anyway,
    // but omitting keeps the request honest about what the user chose.
    expect(code("file-upload.tsx")).toMatch(/if \(leadSource\) formData\.append\("leadSource", leadSource\)/);
  });

  it("ONE select serves BOTH dialogs — they share FileUpload", () => {
    const home = readFileSync(join(__dirname, "..", "pages", "home.tsx"), "utf8");
    const bulk = readFileSync(join(__dirname, "..", "pages", "bulk-calc.tsx"), "utf8");
    expect(home).toMatch(/<FileUpload/);
    expect(bulk).toMatch(/<FileUpload/);
  });
});

describe("precedence: per-row overrides the list-wide pick", () => {
  const routes = server("routes.ts");

  it("mapRowsToAsins takes a defaultLeadSource and the row wins", () => {
    expect(routes).toMatch(/defaultLeadSource: LeadSource \| null = null/);
    expect(routes).toMatch(/leadSource: rowLead \?\? defaultLeadSource/);
  });

  it("an unrecognised cell falls back to the list-wide pick, not to null", () => {
    // One bad cell in a labelled upload must not silently lose the label.
    // normalizeLeadSource returns null for junk, and `??` then takes the
    // default — that is the behaviour this pins.
    expect(normalizeLeadSource("nonsense")).toBeNull();
    expect(routes).toMatch(/const rowLead = mapping\.leadSource && row\[mapping\.leadSource\] !== undefined/);
  });

  it("/api/parse-mapped normalises the dialog value before using it", () => {
    expect(routes).toMatch(/const defaultLeadSource = normalizeLeadSource\(req\.body\?\.leadSource\)/);
    expect(routes).toMatch(/mapRowsToAsins\(rows, mapping, allowMissingCogs, defaultLeadSource\)/);
  });
});

// ── §6 filter ordering (2026-10-13) ─────────────────────────────────────────
// Ordered by count descending so the filter answers "where do most of these
// leads come from". Counts come from the CURRENT filtered set, so the order
// re-sorts as the view narrows — which is why this is computed, not a fixed
// enum order.
describe("lead source filter options are ordered by count", () => {
  // Mirrors the useMemo in results-table's leadSourceOptions.
  const LS = ["ER", "Spark", "OA Hunt", "OAL 24/7", "MP", "RA"] as const;
  const build = (rows: Array<{ leadSource?: string | null }>) => {
    const counts = new Map<string, number>();
    let none = 0;
    for (const r of rows) {
      if (!r.leadSource) { none++; continue; }
      counts.set(r.leadSource, (counts.get(r.leadSource) ?? 0) + 1);
    }
    const sorted = LS.map((s) => ({ value: s.toLowerCase(), label: s, count: counts.get(s) ?? 0 }))
      .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
    return [{ value: "__none__", label: "No lead source", count: none }, ...sorted];
  };
  const rows = (spec: Record<string, number>) =>
    Object.entries(spec).flatMap(([k, n]) => Array.from({ length: n }, () => ({ leadSource: k === "none" ? null : k })));

  it("descending by count — the live distribution", () => {
    const o = build(rows({ ER: 1587, MP: 592, RA: 224, "OAL 24/7": 115, Spark: 44, "OA Hunt": 17 }));
    expect(o.map((x) => x.label)).toEqual([
      "No lead source", "ER", "MP", "RA", "OAL 24/7", "Spark", "OA Hunt",
    ]);
  });

  it("ties break by name", () => {
    const o = build(rows({ RA: 5, ER: 5, MP: 5 })).slice(1);
    expect(o.slice(0, 3).map((x) => x.label)).toEqual(["ER", "MP", "RA"]);
  });

  it("zero-count sources stay listed, sorted last by name", () => {
    const o = build(rows({ ER: 2 }));
    expect(o.map((x) => x.label)).toEqual([
      "No lead source", "ER", "MP", "OA Hunt", "OAL 24/7", "RA", "Spark",
    ]);
    // the five non-ER sources; "No lead source" is also 0 here and is not
    // one of them
    expect(o.filter((x) => x.count === 0 && x.value !== "__none__")).toHaveLength(5);
  });

  it("'No lead source' is PINNED first even when it is the largest bucket", () => {
    const o = build(rows({ none: 900, ER: 3 }));
    expect(o[0].label).toBe("No lead source");
    expect(o[0].count).toBe(900);
    expect(o[1].label).toBe("ER");
  });

  it("the order follows the view — re-sorts when the set narrows", () => {
    const wide = build(rows({ ER: 100, MP: 10 })).slice(1, 3).map((x) => x.label);
    const narrow = build(rows({ ER: 1, MP: 50 })).slice(1, 3).map((x) => x.label);
    expect(wide).toEqual(["ER", "MP"]);
    expect(narrow).toEqual(["MP", "ER"]);
  });
});
