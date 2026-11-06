// POs page search (GET /api/pos ?search=) — notes too (Maria 2026-11-04).
import { describe, it, expect } from "vitest";
describe("POs search covers notes (2026-11-04)", () => {
  it("the PO's, its ASIN rows' and its product lines' notes — a replacement order # noted on the original finds it", async () => {
    const { readFileSync } = await import("fs");
    // The list's filters moved to po-list-filters.ts (2026-11-06).
    const src = readFileSync(new URL("./po-list-filters.ts", import.meta.url), "utf8");
    const q = src.slice(src.indexOf('if (omit !== "search" && f.search)'), src.indexOf("// Both multi-selects"));
    expect(q).toMatch(/p\.notes ILIKE/);
    expect(q).toMatch(/a\.notes ILIKE/);
    expect(q).toMatch(/l\.notes ILIKE/);
  });
});

describe("POs search covers every order # and the supplier (Maria 2026-11-04)", () => {
  it("the order #, the alternate order #s, the Supplier field and the supplier's alias names", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./po-list-filters.ts", import.meta.url), "utf8");
    const q = src.slice(src.indexOf('if (omit !== "search" && f.search)'), src.indexOf("// Both multi-selects"));
    expect(q).toMatch(/p\.order_id ILIKE/);
    expect(q).toMatch(/p\.alt_order_ids ILIKE/);
    expect(q).toMatch(/p\.supplier ILIKE/);
    expect(q).toMatch(/FROM supplier_aliases sa WHERE sa\.supplier = p\.supplier AND sa\.alias ILIKE/);
  });
});
