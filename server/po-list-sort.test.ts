import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Sheet-imported POs inserted in one transaction share created_at (2,370 POs
// in 430 tie groups on prod, 2026-10-29), so a date-only sort pages them
// non-deterministically. Every PO list ends on a unique key.
const routes = readFileSync(join(__dirname, "routes.ts"), "utf8");

describe("PO lists sort deterministically", () => {
  it("/api/pos (paginated) ends on p.id", () => {
    expect(routes).toMatch(/ORDER BY p\.order_date DESC, p\.created_at DESC, p\.id DESC\s+LIMIT \$\{PAGE_SIZE\} OFFSET/);
  });
  it("the Unmatched panel and the link picker end on a unique key", () => {
    expect(routes).toContain("ORDER BY v.shipped_at DESC NULLS LAST, u.created_at, u.id`");
    expect(routes).toContain("p.order_date DESC, p.order_id, pa.asin, pa.id LIMIT 20`, [`%${q}%`, start]");
  });
});
