import { describe, it, expect } from "vitest";

// Pins the Last Reviewed column (2026-08-30): same field as the Product
// cell's corner date (asins.last_reviewed_at), reviewed-type filters
// (never / olderThan / newerThan — "never" = null = never reviewed), and
// nulls-last sorting in both directions (home.tsx's comparator returns
// null-checks before applying sort direction; replicated here verbatim).
import { matchesFilters, type FilterMap } from "./column-filter";

const DAY = 86400000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

function match(lastReviewedAt: string | null, operator: string, value: string): boolean {
  const filters: FilterMap = { lastReviewed: { colId: "lastReviewed", operator, value } };
  return matchesFilters({}, filters, (colId) => (colId === "lastReviewed" ? lastReviewedAt : null));
}

describe("Last Reviewed filter (reviewed type)", () => {
  it("'never' matches only null (never reviewed)", () => {
    expect(match(null, "never", "never")).toBe(true);
    expect(match(iso(3), "never", "never")).toBe(false);
  });

  it("'olderThan X days' matches stale reviews AND null (not reviewed in window)", () => {
    expect(match(iso(10), "olderThan", "7")).toBe(true);
    expect(match(iso(3), "olderThan", "7")).toBe(false);
    expect(match(null, "olderThan", "7")).toBe(true); // never reviewed = not reviewed in last X
  });

  it("'newerThan X days' matches recent reviews only, never null", () => {
    expect(match(iso(3), "newerThan", "7")).toBe(true);
    expect(match(iso(10), "newerThan", "7")).toBe(false);
    expect(match(null, "newerThan", "7")).toBe(false);
  });
});

describe("Last Reviewed sort — nulls last in both directions", () => {
  // home.tsx sortedFilteredResults comparator, verbatim null/string legs.
  const comparator = (sortDir: "asc" | "desc") => (va: string | null, vb: string | null) => {
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const sa = String(va).toLowerCase();
    const sb = String(vb).toLowerCase();
    return sortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
  };
  const d1 = iso(1), d7 = iso(7), d30 = iso(30);
  const rows = [d1, null, d30, null, d7];

  it("ascending: dates ordered oldest-first, nulls at the end", () => {
    const sorted = [...rows].sort(comparator("asc"));
    expect(sorted).toEqual([d30, d7, d1, null, null]);
  });

  it("descending: dates ordered newest-first, nulls STILL at the end", () => {
    const sorted = [...rows].sort(comparator("desc"));
    expect(sorted).toEqual([d1, d7, d30, null, null]);
  });
});
