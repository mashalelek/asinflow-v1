import { describe, it, expect } from "vitest";
import { resolveColumns, rangeFor, mondayOf, lastMonthOf, addDays, todayIn, parseCustom, parseSet, last12MonthsRange, SET_COLUMNS, EASTERN, PACIFIC } from "./dashboard-range";
import { parseGridQuery, parseSeriesQuery } from "./dashboard";

// Dashboard range resolver (SPEC §28 §2.2): every column of every set, "N
// days" INCLUDES today (unlike the shared last_30_days preset), weeks start
// Monday (D2), MTD on the 1st, Last month across a year boundary, and the
// Eastern vs Pacific "today" around midnight.
const T = "2026-06-17"; // a Wednesday

describe("rangeFor — one column, one today", () => {
  it("N days includes today: 7 / 14 / 30 days end today and start N−1 days back", () => {
    expect(rangeFor("d7", T)).toEqual({ from: "2026-06-11", to: T });
    expect(rangeFor("d14", T)).toEqual({ from: "2026-06-04", to: T });
    expect(rangeFor("d30", T)).toEqual({ from: "2026-05-19", to: T });
  });
  it("today / yesterday / MTD / this week (Monday) / last month", () => {
    expect(rangeFor("today", T)).toEqual({ from: T, to: T });
    expect(rangeFor("yesterday", T)).toEqual({ from: "2026-06-16", to: "2026-06-16" });
    expect(rangeFor("mtd", T)).toEqual({ from: "2026-06-01", to: T });
    expect(rangeFor("this_week", T)).toEqual({ from: "2026-06-15", to: T });
    expect(rangeFor("last_month", T)).toEqual({ from: "2026-05-01", to: "2026-05-31" });
  });
  it("MTD on the 1st is one day; this week on a Monday is one day, on a Sunday it is seven", () => {
    expect(rangeFor("mtd", "2026-07-01")).toEqual({ from: "2026-07-01", to: "2026-07-01" });
    expect(rangeFor("this_week", "2026-06-15")).toEqual({ from: "2026-06-15", to: "2026-06-15" });
    expect(rangeFor("this_week", "2026-06-21")).toEqual({ from: "2026-06-15", to: "2026-06-21" });
    expect(mondayOf("2026-06-21")).toBe("2026-06-15");
    expect(mondayOf("2026-06-15")).toBe("2026-06-15");
  });
  it("Last month across a year boundary; 30 days across a year boundary; leap day", () => {
    expect(lastMonthOf("2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(rangeFor("last_month", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(rangeFor("d30", "2026-01-10")).toEqual({ from: "2025-12-12", to: "2026-01-10" });
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("custom is literal and requires a range", () => {
    expect(rangeFor("custom", T, { from: "2026-01-01", to: "2026-01-31" })).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(() => rangeFor("custom", T)).toThrow(/custom range/);
  });
});

describe("resolveColumns — every column of every set, in both zones", () => {
  const now = new Date("2026-06-17T18:00:00Z"); // 14:00 EDT, 11:00 PDT — same day in both zones
  it("set 1: Today · This week · MTD · 30 days", () => {
    expect(resolveColumns(1, now).map((c) => [c.key, c.label, c.eastern.from, c.eastern.to])).toEqual([
      ["today", "Today", T, T], ["this_week", "This week", "2026-06-15", T], ["mtd", "MTD", "2026-06-01", T], ["d30", "30 days", "2026-05-19", T],
    ]);
  });
  it("set 2: Today · Yesterday · MTD · Last month", () => {
    expect(resolveColumns(2, now).map((c) => [c.key, c.eastern.from, c.eastern.to])).toEqual([
      ["today", T, T], ["yesterday", "2026-06-16", "2026-06-16"], ["mtd", "2026-06-01", T], ["last_month", "2026-05-01", "2026-05-31"],
    ]);
  });
  it("set 3: Today · Yesterday · 7 · 14 · 30 days", () => {
    expect(resolveColumns(3, now).map((c) => [c.key, c.eastern.from])).toEqual([["today", T], ["yesterday", "2026-06-16"], ["d7", "2026-06-11"], ["d14", "2026-06-04"], ["d30", "2026-05-19"]]);
  });
  it("set 4: one Custom column, the same literal range in both zones", () => {
    const [c] = resolveColumns(4, now, { from: "2026-02-01", to: "2026-02-28" });
    expect(c).toMatchObject({ key: "custom", label: "Custom", eastern: { from: "2026-02-01", to: "2026-02-28" }, pacific: { from: "2026-02-01", to: "2026-02-28" } });
    expect(Object.keys(SET_COLUMNS)).toEqual(["1", "2", "3", "4"]);
  });
  it("Eastern vs Pacific today around midnight: 01:30 EDT is 22:30 PDT the day before — Spend and Sales columns differ by a day", () => {
    const late = new Date("2026-06-18T05:30:00Z");
    expect(todayIn(EASTERN, late)).toBe("2026-06-18");
    expect(todayIn(PACIFIC, late)).toBe("2026-06-17");
    const [today, , mtd] = resolveColumns(1, late);
    expect(today.eastern).toEqual({ from: "2026-06-18", to: "2026-06-18" });
    expect(today.pacific).toEqual({ from: "2026-06-17", to: "2026-06-17" });
    expect(mtd.eastern.to).toBe("2026-06-18");
    expect(mtd.pacific.to).toBe("2026-06-17");
    // 03:30 EDT = 00:30 PDT: the same day again
    const after = new Date("2026-06-18T07:30:00Z");
    expect(resolveColumns(1, after)[0].pacific.from).toBe("2026-06-18");
  });
  it("the charts' default is 12 calendar months ending with the current one (Eastern), to date", () => {
    expect(last12MonthsRange(now)).toEqual({ from: "2025-07-01", to: T });
    expect(last12MonthsRange(new Date("2026-01-02T03:00:00Z"))).toEqual({ from: "2025-02-01", to: "2026-01-01" }); // 22:00 EST on Jan 1
  });
});

describe("query parsing", () => {
  it("set 1–4, custom needs from ≤ to as real dates", () => {
    expect(parseSet("3")).toBe(3); expect(parseSet("5")).toBeNull(); expect(parseSet(undefined)).toBeNull();
    expect(parseCustom("2026-02-30", "2026-03-01")).toEqual({ error: "from and to must be YYYY-MM-DD" });
    expect(parseCustom("2026-03-02", "2026-03-01")).toEqual({ error: "from must not be after to" });
    expect(parseGridQuery({})).toEqual({ set: 1 });
    expect(parseGridQuery({ set: "4" })).toEqual({ error: "from and to must be YYYY-MM-DD" });
    expect(parseGridQuery({ set: "4", from: "2026-01-01", to: "2026-01-31" })).toEqual({ set: 4, custom: { from: "2026-01-01", to: "2026-01-31" } });
    expect(parseGridQuery({ set: "2", from: "garbage" })).toEqual({ set: 2 }); // from/to only matter for set 4
  });
  it("series: kind running30 | monthly | weekly; no range = last 12 months; a half range is an error", () => {
    expect(parseSeriesQuery({})).toEqual({ kind: "running30" });
    expect(parseSeriesQuery({ kind: "weekly" })).toEqual({ kind: "weekly" });
    expect(parseSeriesQuery({ kind: "daily" })).toEqual({ error: "kind must be running30, monthly or weekly" });
    expect(parseSeriesQuery({ kind: "monthly", from: "2026-01-01" })).toEqual({ error: "from and to must be YYYY-MM-DD" });
    expect(parseSeriesQuery({ kind: "monthly", from: "2026-01-01", to: "2026-06-30" })).toEqual({ kind: "monthly", range: { from: "2026-01-01", to: "2026-06-30" } });
  });
});
