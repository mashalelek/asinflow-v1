import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { matchesFilters } from "./column-filter";
import { DATE_VALUE_COLS } from "./results-table";
import { ALL_COLUMNS } from "@shared/schema";

// §21 bulk-local Last Reviewed (2026-09-10): same filter semantics, same
// export header, date-aware sort, and the pipeline never touches it.
const read = (rel: string) => readFileSync(join(__dirname, "..", "..", "..", rel), "utf8");

const rowVal = (ts: string | null) => (colId: any) => (colId === "lastReviewed" ? ts : null);
const NOW = Date.now();
const days = (n: number) => new Date(NOW - n * 86400000).toISOString();

describe("Last Reviewed filter — never / older than / within", () => {
  const filters = (operator: string, value: string) => ({ lastReviewed: { colId: "lastReviewed", operator, value } }) as any;
  it("never: only null rows match", () => {
    expect(matchesFilters({}, filters("never", "never"), rowVal(null))).toBe(true);
    expect(matchesFilters({}, filters("never", "never"), rowVal(days(2)))).toBe(false);
  });
  it("olderThan / newerThan split three distinct dates correctly", () => {
    const [old, mid, fresh] = [days(40), days(10), days(1)];
    for (const [ts, olderThan20, newerThan5] of [[old, true, false], [mid, false, false], [fresh, false, true]] as const) {
      expect(matchesFilters({}, filters("olderThan", "20"), rowVal(ts))).toBe(olderThan20);
      expect(matchesFilters({}, filters("newerThan", "5"), rowVal(ts))).toBe(newerThan5);
    }
  });
});

describe("Last Reviewed — shared column identity on the bulk page", () => {
  it("export header matches main ('Last Reviewed'); sort is date-aware; bulk page includes the column", () => {
    expect(ALL_COLUMNS.find((c) => c.id === "lastReviewed")!.label).toBe("Last Reviewed");
    expect(DATE_VALUE_COLS.has("lastReviewed")).toBe(true);
    expect(read("client/src/pages/bulk-calc.tsx")).toMatch(/"lastReviewed",/);
    expect(read("client/src/pages/bulk-calc.tsx")).toMatch(/reviewedSaveUrl/);
  });
  it("the bulk pipeline never writes last_reviewed_at (survives Refresh by construction)", () => {
    expect(read("server/scheduler/bulk.ts")).not.toContain("last_reviewed_at");
  });
});
