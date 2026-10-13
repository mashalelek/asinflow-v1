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
