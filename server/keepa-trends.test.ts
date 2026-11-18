// Keepa trend endpoints (docs/claude_spec-patch-keepa-trends.md "Tests": bucketing, the half-coverage rule, gaps,
// scales unchanged by the toggles, the larger rank higher; commit 4). The store is a fake over the recorded product.
import { describe, it, expect, vi } from "vitest";
import express from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";

vi.mock("./db", () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), poolForLane: () => { throw new Error("no pool in tests"); }, default: {} }));
import { bucketize, windowOf, scalesOf, rangeOf, parseAsins, parseRange, loadTrends, loadHistory, createKeepaRouter, MAX_TRENDS_ASINS } from "./keepa-trends";
import { productToSeries, dayIndex } from "./keepa";
import { KEEPA_SERIES, TREND_BUCKETS, TREND_YEAR_DAYS, KEEPA_CELLS, KEEPA_LINE, keepaValueText } from "@shared/keepa";
import type { QueryLike } from "./scheduler/types";

const product = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "keepa", "B08G6J2PY5.json"), "utf8")).products[0];
const NOW = new Date("2026-11-18T21:00:00Z"); // today ET = 2026-11-18

/** A fake keepa_series store for the two SQL shapes loadStoredSeries uses (the slice is applied here as Postgres would). */
function fakeStore(rows: Array<{ asin: string; series: string; first_day: string; vals: Array<number | null> }>): QueryLike {
  return async (sql, params = []) => {
    const asins = params[0] as string[];
    const mine = rows.filter((r) => asins.includes(r.asin));
    if (/vals\[\(\(\$2::date - first_day\) \+ 1\):cardinality\(vals\)\]/.test(sql)) {
      const from = params[1] as string;
      return {
        rows: mine.map((r) => {
          const lo = dayIndex(from) - dayIndex(r.first_day) + 1; // 1-based
          const vals = lo <= 1 ? r.vals : r.vals.slice(lo - 1);
          return { asin: r.asin, series: r.series, first_day: r.first_day > from ? r.first_day : from, vals };
        }), rowCount: mine.length,
      };
    }
    if (/SELECT asin, series, first_day::text AS first_day, vals FROM keepa_series/.test(sql)) return { rows: mine.map((r) => ({ ...r })), rowCount: mine.length };
    throw new Error(`unhandled SQL: ${sql.slice(0, 80)}`);
  };
}
const storedFixture = () => Array.from(productToSeries(product, NOW).entries()).map(([series, d]) => ({ asin: "B08G6J2PY5", series, first_day: d.first_day, vals: d.vals }));

describe("bucketing (14 equal time buckets, mean of daily values)", () => {
  it("365 days → 14 buckets; a constant series is constant; a flat ramp averages per bucket", () => {
    const flat = bucketize(new Array(365).fill(7));
    expect(flat).toHaveLength(TREND_BUCKETS);
    expect(flat.every((v) => v === 7)).toBe(true);
    const ramp = bucketize(Array.from({ length: 14 }, (_, i) => i * 10)); // one day per bucket
    expect(ramp).toEqual(Array.from({ length: 14 }, (_, i) => i * 10));
  });
  it("the half-coverage rule at the boundary: data on exactly half the days is a value; one fewer is a gap; an empty bucket is a gap", () => {
    const days = 28; // 2 days per bucket
    const half = Array.from({ length: days }, (_, i) => (i % 2 === 0 ? 10 : null));  // 1 of 2 → kept
    expect(bucketize(half).every((v) => v === 10)).toBe(true);
    const four = 56; // 4 days per bucket
    const oneOfFour = Array.from({ length: four }, (_, i) => (i % 4 === 0 ? 10 : null)); // 1 of 4 → gap
    expect(bucketize(oneOfFour).every((v) => v === null)).toBe(true);
    const twoOfFour = Array.from({ length: four }, (_, i) => (i % 4 < 2 ? 10 : null)); // 2 of 4 → kept
    expect(bucketize(twoOfFour).every((v) => v === 10)).toBe(true);
    expect(bucketize(new Array(14).fill(null)).every((v) => v === null)).toBe(true);
  });
  it("a gap splits the series for EVERY series the same way: nulls in the middle stay null, nothing is interpolated or zeroed", () => {
    const daily = Array.from({ length: 140 }, (_, i) => (i >= 50 && i < 80 ? null : 100)); // a month-long stretch of no data
    const b = bucketize(daily);
    expect(b).toEqual([100, 100, 100, 100, 100, null, null, null, 100, 100, 100, 100, 100, 100]);
  });
  it("windowOf: NULL before a series begins and after its last stored day", () => {
    const w = windowOf({ first_day: "2026-11-10", vals: [1, 2, 3] }, "2026-11-08", 7);
    expect(w).toEqual([null, null, 1, 2, 3, null, null]);
  });
});

describe("scales (per cell, per ASIN, from the bucket values)", () => {
  it("price: Buy Box and New share min..max over both, padded 10%; a toggle never changes it (both lines are always in)", () => {
    const s = scalesOf({ buy_box: [2000, 2200, null], new_price: [1900, 2100, 2050] });
    expect(s.price).toEqual([1900 - 30, 2200 + 30]);
    // hiding New in the client does not re-scale: the server never knows about the toggle
    expect(scalesOf({ buy_box: [2000, 2200, null], new_price: [1900, 2100, 2050] }).price).toEqual(s.price);
  });
  it("sold: 0..max × 1.2; rank: min..max (the client draws the larger rank higher); offers: 0..max(New) × 1.1 shared with New, FBA; rating: min − 30% of span..max", () => {
    const s = scalesOf({ monthly_sold: [50, 100, null], sales_rank: [150000, 90000, 175887], offers_new: [7, 9, 8], offers_new_fba: [3, 20, 2], rating_count: [200, 222] });
    expect(s.sold).toEqual([0, 120]);
    expect(s.rank).toEqual([90000, 175887]);
    expect(s.offers![0]).toBe(0); expect(s.offers![1]).toBeCloseTo(9.9); // max(New), not max(New, FBA)
    expect(s.rating).toEqual([200 - 22 * 0.3, 222]);
  });
  it("a cell with no data has no scale; a flat price gets a 1-cent pad", () => {
    expect(scalesOf({})).toEqual({});
    expect(scalesOf({ buy_box: [2500, 2500] }).price).toEqual([2499, 2501]);
    expect(scalesOf({ offers_new_fba: [3, 3] }).offers![1]).toBeCloseTo(3.3); // New absent → New, FBA alone sets it
  });
});

describe("ranges and parsing", () => {
  it("1y = the 365 days ending today; all = the ASIN's earliest stored day to today (today when nothing is stored)", () => {
    expect(rangeOf("1y", "2026-11-18", ["2020-09-07"])).toEqual({ start: "2025-11-19", end: "2026-11-18", days: TREND_YEAR_DAYS });
    expect(rangeOf("all", "2026-11-18", ["2024-01-09", "2020-09-07", "2026-02-10"])).toEqual({ start: "2020-09-07", end: "2026-11-18", days: 2264 });
    expect(rangeOf("all", "2026-11-18", [])).toEqual({ start: "2026-11-18", end: "2026-11-18", days: 1 });
  });
  it("parseAsins: upper-cased, deduped, 1–250, ASIN-shaped; parseRange: 1y default, all, else null", () => {
    expect(parseAsins("b08g6j2py5, B000000001,B08G6J2PY5")).toEqual(["B08G6J2PY5", "B000000001"]);
    expect(parseAsins("")).toBeNull();
    expect(parseAsins("not-an-asin")).toBeNull();
    expect(parseAsins(Array.from({ length: MAX_TRENDS_ASINS + 1 }, (_, i) => `B0${String(i).padStart(8, "0")}`).join(","))).toBeNull();
    expect(parseRange(undefined)).toBe("1y"); expect(parseRange("all")).toBe("all"); expect(parseRange("2y")).toBeNull();
  });
});

describe("loadTrends / loadHistory on the recorded product", () => {
  it("1y: every series buckets to 14 values; Monthly Sold has values at the left only (Dec → Jan) and gaps after; New, FBA covers the year", async () => {
    const t = await loadTrends(fakeStore(storedFixture()), ["B08G6J2PY5", "B0NOTHING1"], "1y", NOW);
    expect(Object.keys(t.asins)).toEqual(["B08G6J2PY5"]); // an ASIN with nothing stored is absent → an empty cell
    const a = t.asins.B08G6J2PY5;
    expect([a.start, a.end, a.days]).toEqual(["2025-11-19", "2026-11-18", 365]);
    for (const s of KEEPA_SERIES) expect(a.buckets[s], s).toHaveLength(14);
    const ms = a.buckets.monthly_sold!;
    expect(ms[0]).toBe(50);                          // Nov 19 – Dec 14: 50 with the 6-day gap inside (half-coverage keeps it)
    expect(ms.slice(3).every((v) => v === null)).toBe(true); // nothing after late January
    expect(a.buckets.sales_rank!.every((v) => v != null)).toBe(true);
    expect(a.buckets.offers_new_fba!.filter((v) => v != null).length).toBeGreaterThanOrEqual(10); // csv[34] begins 2026-02-10: the first ~3 of 14 buckets are a gap
    expect(a.scales.price![0]).toBeLessThan(a.scales.price![1]);
    expect(a.scales.rank![1]).toBeGreaterThan(a.scales.rank![0]);
    expect(a.scales.sold).toEqual([0, 60]);
  });
  it("all: the range starts at the ASIN's earliest stored day (2020-09-07); New, FBA (2026) is a gap for most of it and present at the right", async () => {
    const t = await loadTrends(fakeStore(storedFixture()), ["B08G6J2PY5"], "all", NOW);
    const a = t.asins.B08G6J2PY5;
    expect(a.start).toBe("2020-09-07");
    expect(a.days).toBe(2264);
    const fba = a.buckets.offers_new_fba!;
    expect(fba.slice(0, 12).every((v) => v === null)).toBe(true);
    expect(fba[13]).not.toBeNull();
  });
  it("a series with no value in the range is left out of buckets (the Sales Velocity cell empties when both lines are out)", async () => {
    const t = await loadTrends(fakeStore([{ asin: "B0ONLYRATE", series: "rating_count", first_day: "2026-01-01", vals: new Array(300).fill(12) }, { asin: "B0ONLYRATE", series: "sales_rank", first_day: "2020-01-01", vals: [5] }]), ["B0ONLYRATE"], "1y", NOW);
    const a = t.asins.B0ONLYRATE;
    expect(Object.keys(a.buckets)).toEqual(["rating_count"]);
    expect(a.scales).toEqual({ rating: [12, 12] });
    expect(KEEPA_CELLS.salesVelocityTrend.lines.every((s) => !a.buckets[s])).toBe(true);
  });
  it("history: the daily values over the range, every series, hover text per the patch", async () => {
    const h = await loadHistory(fakeStore(storedFixture()), "B08G6J2PY5", "1y", NOW);
    expect([h.start, h.end, h.days]).toEqual(["2025-11-19", "2026-11-18", 365]);
    for (const s of KEEPA_SERIES) expect(h.series[s], s).toHaveLength(365);
    const last = (s: (typeof KEEPA_SERIES)[number]) => h.series[s]!.at(-1) ?? null;
    expect(keepaValueText("buy_box", last("buy_box"))).toBe("$25.30");
    expect(keepaValueText("new_price", last("new_price"))).toBe("$25.25");
    expect(keepaValueText("sales_rank", last("sales_rank"))).toBe("#175,887");
    expect(keepaValueText("offers_new", last("offers_new"))).toBe("7");
    expect(keepaValueText("offers_new_fba", last("offers_new_fba"))).toBe("3");
    expect(keepaValueText("rating_count", last("rating_count"))).toBe("222");
    expect(keepaValueText("monthly_sold", last("monthly_sold"))).toBe("—");
    const dec1 = h.series.monthly_sold![dayIndex("2025-12-01") - dayIndex(h.start)];
    expect(keepaValueText("monthly_sold", dec1)).toBe("50+");
  });
});

describe("the routes", () => {
  async function serve(q: QueryLike) {
    const app = express();
    app.use(createKeepaRouter({ query: q, now: () => NOW }));
    const srv = createServer(app);
    await new Promise<void>((r) => srv.listen(0, r));
    const port = (srv.address() as any).port;
    return { get: (p: string) => fetch(`http://127.0.0.1:${port}${p}`), close: () => new Promise<void>((r) => srv.close(() => r())) };
  }
  it("GET /api/keepa/trends and /history answer the shapes; bad input is 400; no response carries a key", async () => {
    process.env.KEEPA_API_KEY = "zz-secret-key-never-in-a-response";
    const s = await serve(fakeStore(storedFixture()));
    try {
      const t = await s.get("/api/keepa/trends?asins=B08G6J2PY5&range=1y");
      expect(t.status).toBe(200);
      const tb = await t.text();
      expect(tb).not.toContain("zz-secret-key");
      expect(JSON.parse(tb).asins.B08G6J2PY5.buckets.sales_rank).toHaveLength(14);
      const h = await s.get("/api/keepa/history/b08g6j2py5?range=all");
      expect(h.status).toBe(200);
      const hb = await h.text();
      expect(hb).not.toContain("zz-secret-key");
      expect(JSON.parse(hb).days).toBe(2264);
      expect((await s.get("/api/keepa/trends?asins=&range=1y")).status).toBe(400);
      expect((await s.get("/api/keepa/trends?asins=B08G6J2PY5&range=2y")).status).toBe(400);
      expect((await s.get("/api/keepa/history/nope")).status).toBe(400);
    } finally { await s.close(); delete process.env.KEEPA_API_KEY; }
  });
  it("index.ts mounts the router behind requireAuth; the line colors are the mockup's", () => {
    const idx = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(idx.indexOf("createKeepaRouter(")).toBeGreaterThan(idx.indexOf('app.use("/api", requireAuth)'));
    const mock = readFileSync(join(__dirname, "..", "docs", "mockups", "keepa-trends-2026-11-18.html"), "utf8");
    const root = mock.match(/:root\{([^}]+)\}/)![1];
    const vars = Object.fromEntries(root.split(";").filter(Boolean).map((kv) => kv.split(":").map((x) => x.trim())));
    expect(KEEPA_LINE.buy_box.color).toBe(vars["--bb"]); expect(KEEPA_LINE.new_price.color).toBe(vars["--new"]);
    expect(KEEPA_LINE.monthly_sold.color).toBe(vars["--sold"]); expect(KEEPA_LINE.sales_rank.color).toBe(vars["--rank"]);
    expect(KEEPA_LINE.offers_new.color).toBe(vars["--off"]); expect(KEEPA_LINE.offers_new_fba.color).toBe(vars["--fba"]);
    expect(KEEPA_LINE.rating_count.color).toBe(vars["--rate"]);
  });
});
