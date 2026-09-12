import { describe, it, expect } from "vitest";
import { matchesFilters, IN_DB_SENTINEL } from "./column-filter";

// §21 in-database filter (2026-09-12): tri-state on the Product column,
// self-describing operator, answered via the sentinel key — no main-DB
// access beyond the existing in_database flag.
const inDb = new Set(["B0INDB0001", "B0INDB0003"]);
const rows = [
  { asin: "B0INDB0001", tags: "spark lead" },
  { asin: "B0INDB0002", tags: "spark lead" },
  { asin: "B0INDB0003", tags: "other" },
  { asin: "B0INDB0004", tags: "" },
];
const valueFn = (r: any) => (colId: any) =>
  (colId as string) === IN_DB_SENTINEL ? (inDb.has(r.asin) ? "yes" : "no")
  : colId === "tags" ? r.tags : null;
const f = (value: "yes" | "no") => ({ product: { colId: "product", operator: "indb", value } }) as any;

describe("in-database tri-state", () => {
  it("'Not in database' keeps only rows without an asins row (any status counts as in)", () => {
    const visible = rows.filter((r) => matchesFilters(r, f("no"), valueFn(r)));
    expect(visible.map((r) => r.asin)).toEqual(["B0INDB0002", "B0INDB0004"]);
  });
  it("'In database' keeps only icon rows", () => {
    const visible = rows.filter((r) => matchesFilters(r, f("yes"), valueFn(r)));
    expect(visible.map((r) => r.asin)).toEqual(["B0INDB0001", "B0INDB0003"]);
  });
  it("composes with a tag filter (AND semantics, like every other bulk filter)", () => {
    const filters = { ...f("no"), tags: { colId: "tags", operator: "anyOf", value: JSON.stringify(["spark lead"]) } } as any;
    const visible = rows.filter((r) => matchesFilters(r, filters, valueFn(r)));
    expect(visible.map((r) => r.asin)).toEqual(["B0INDB0002"]);
    // Export follows sortedResults (the filtered set) — same array, so a
    // matching row count here IS the export row count under the standing
    // selection-else-filtered rule.
  });
});
