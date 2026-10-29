import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { poListOrderBy, PO_SORT_KEYS } from "./po-queries";

// Sheet-imported POs inserted in one transaction share created_at (2,370 POs
// in 430 tie groups on prod, 2026-10-29), so a date-only sort pages them
// non-deterministically. Every PO list ends on a unique key.
const routes = readFileSync(join(__dirname, "routes.ts"), "utf8");

describe("PO lists sort deterministically", () => {
  it("/api/pos (paginated) ends on p.id — default and every whitelisted sort (PO table v2 §4)", () => {
    expect(routes).toMatch(/ORDER BY \$\{poListOrderBy\(req\.query\.sort, req\.query\.dir\)\}\s+LIMIT \$\{PAGE_SIZE\} OFFSET/);
    expect(poListOrderBy(undefined, undefined)).toBe("p.order_date DESC, p.created_at DESC, p.id DESC");
    expect(poListOrderBy("supplier", "asc")).toBe("lower(p.supplier) ASC NULLS LAST, p.id ASC");
    expect(poListOrderBy("action_items", "desc")).toBe("action_item_count DESC NULLS LAST, p.id DESC");
    for (const k of Object.keys(PO_SORT_KEYS)) expect(poListOrderBy(k, "asc")).toMatch(/, p\.id ASC$/);
    // not whitelisted → default; never interpolated
    expect(poListOrderBy("p.id; DROP TABLE purchase_orders", "asc")).toBe("p.order_date DESC, p.created_at DESC, p.id DESC");
  });
  it("the Unmatched panel and the link picker end on a unique key", () => {
    expect(routes).toContain("ORDER BY v.shipped_at DESC NULLS LAST, u.created_at, u.id`");
    expect(routes).toContain("p.order_date DESC, p.order_id, pa.asin, pa.id LIMIT 20`, [likeContains(q), start, likeContains(stripShipmentSuffix(q))]");
  });
});
