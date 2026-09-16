import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveRepricerRange, isoOf } from "./repricer-range";

// §23 selectable zero-sales window (2026-09-16).
const NOW = new Date(2026, 8, 16); // 2026-09-16, local
const COVERAGE = "2025-01-01";

describe("resolveRepricerRange — default window", () => {
  it("defaults to the trailing 7 days INCLUSIVE of today (the shipped fixed window)", () => {
    const r = resolveRepricerRange(COVERAGE, undefined, undefined, NOW);
    expect(r.effective).toEqual({ from: "2026-09-10", to: "2026-09-16" });
    expect(r.clamped).toBe(false);
  });

  it("is NOT the shared last_7_days preset ([today-7, yesterday])", () => {
    const r = resolveRepricerRange(COVERAGE, undefined, undefined, NOW);
    expect(r.effective.from).not.toBe("2026-09-09");
    expect(r.effective.to).not.toBe("2026-09-15");
  });

  it("ignores malformed input and falls back to the default", () => {
    const r = resolveRepricerRange(COVERAGE, "not-a-date", "", NOW);
    expect(r.effective).toEqual({ from: "2026-09-10", to: "2026-09-16" });
  });

  it("tolerates an inverted range by swapping", () => {
    const r = resolveRepricerRange(COVERAGE, "2026-09-16", "2026-09-10", NOW);
    expect(r.effective).toEqual({ from: "2026-09-10", to: "2026-09-16" });
  });
});

describe("resolveRepricerRange — coverage guard (CLAMP, never silent)", () => {
  it("clamps a range starting before coverage and reports both ranges", () => {
    const r = resolveRepricerRange(COVERAGE, "2019-01-01", "2026-09-16", NOW);
    expect(r.requested.from).toBe("2019-01-01");   // what was asked
    expect(r.effective.from).toBe(COVERAGE);        // what was used
    expect(r.clamped).toBe(true);
    expect(r.noCoverage).toBe(false);
    // The caller shows effective + the clamp notice; missing data can never
    // read as "no sales".
  });

  it("a range ENTIRELY before coverage returns noCoverage (caller shows zero rows)", () => {
    const r = resolveRepricerRange(COVERAGE, "2019-01-01", "2019-06-01", NOW);
    expect(r.noCoverage).toBe(true);
  });

  it("no sales data at all → noCoverage, never 'everything had zero sales'", () => {
    const r = resolveRepricerRange(null, "2026-09-01", "2026-09-16", NOW);
    expect(r.noCoverage).toBe(true);
  });

  it("a range fully inside coverage is untouched", () => {
    const r = resolveRepricerRange(COVERAGE, "2026-09-02", "2026-09-09", NOW);
    expect(r).toMatchObject({ effective: { from: "2026-09-02", to: "2026-09-09" }, clamped: false, noCoverage: false });
  });
});

describe("§23 page-local range isolation", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  it("the Repricer page never touches the global date range or its storage key", () => {
    const page = read("client/src/pages/repricer.tsx");
    expect(page).not.toMatch(/useDateRange|date-range-context/);
    expect(page).not.toContain("asinflow-date-range");
  });
  it("DateRangePicker is fully controlled — no context, no storage of its own", () => {
    const picker = read("client/src/components/date-range-picker.tsx");
    expect(picker).not.toMatch(/useDateRange|date-range-context|localStorage/);
  });
  it("Repricer stays OUT of the shared date-picker route list (§8)", () => {
    const nav = read("client/src/components/layout/top-nav.tsx");
    const line = nav.split("\n").find((l) => l.includes("DATE_PICKER_ROUTES"))!;
    expect(line).not.toContain("/repricer");
  });
});

describe("isoOf", () => {
  it("formats local dates without UTC drift", () => {
    expect(isoOf(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
