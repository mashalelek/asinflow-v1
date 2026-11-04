// POs page search (GET /api/pos ?search=) — notes too (Maria 2026-11-04).
import { describe, it, expect } from "vitest";
describe("POs search covers notes (2026-11-04)", () => {
  it("the PO's, its ASIN rows' and its product lines' notes — a replacement order # noted on the original finds it", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
    const q = src.slice(src.indexOf('app.get("/api/pos", async'), src.indexOf("// Action Items filter: any-of"));
    expect(q).toMatch(/p\.notes ILIKE/);
    expect(q).toMatch(/a\.notes ILIKE/);
    expect(q).toMatch(/l\.notes ILIKE/);
  });
});
