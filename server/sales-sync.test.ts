import { describe, it, expect, vi, beforeEach } from "vitest";

// Sales history backfill + component 19 scope change (2026-10-16):
//   - EVERY ASIN in asins counts (no status filter);
//   - ASINs the report names that AF lacks are ONBOARDED before the chunk's
//     upsert (so their rows land in the same chunk);
//   - a failed chunk FAILS the sync with the per-chunk results so far;
//   - "Date range exceeded" is a failure, not "no data";
//   - refund / fee columns are never touched beyond the first-insert 0.

vi.mock("./log", () => ({ log: () => {} }));

// ── SP-API + download fakes ──────────────────────────────────────────────────
type Script = { report?: string; status?: "DONE" | "FATAL" };
let scripts: Script[] = [];
let created = 0;
const posts: any[] = [];
vi.mock("./spapi", () => ({
  spApiPost: vi.fn(async (_path: string, body: any) => { posts.push(body); return { reportId: `R${++created}` }; }),
  spApiGet: vi.fn(async (path: string) => {
    if (path.startsWith("/reports/2021-06-30/reports/")) {
      const n = Number(path.split("/R")[1]);
      const sc = scripts[n - 1] ?? {};
      return { processingStatus: sc.status ?? "DONE", reportDocumentId: `D${n}` };
    }
    if (path.startsWith("/reports/2021-06-30/documents/")) return { url: `https://s3.example/${path.split("/D")[1]}` };
    throw new Error(`unexpected GET ${path}`);
  }),
}));
vi.mock("axios", () => ({ default: { get: vi.fn(async (url: string) => ({ data: scripts[Number(url.split("/").pop()) - 1]?.report ?? "" })) } }));

// ── DB fake ──────────────────────────────────────────────────────────────────
let asinsTable: { id: string; asin: string }[] = [];
const sql: { text: string; params?: any[] }[] = [];
vi.mock("./db", () => ({
  query: vi.fn(async (text: string, params?: any[]) => {
    sql.push({ text, params });
    const t = text.replace(/\s+/g, " ").trim();
    if (t === "SELECT id, asin FROM asins") return { rows: asinsTable, rowCount: asinsTable.length };
    if (t.startsWith("SELECT id, asin FROM asins WHERE asin = ANY")) return { rows: asinsTable.filter((r) => params![0].includes(r.asin)), rowCount: 0 };
    if (t.startsWith("INSERT INTO sales_daily")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected sql ${t.slice(0, 60)}`);
  }),
}));

import { syncSalesData, parseOrdersReport, buildDateChunks, salesTiming, SalesSyncError, MAX_RANGE_DAYS } from "./sales-sync";

const HEADER = "amazon-order-id\tpurchase-date\torder-status\tasin\tquantity\titem-price";
const row = (date: string, asin: string, qty: number, price: number, status = "Shipped") => `o\t${date}T15:00:00+00:00\t${status}\t${asin}\t${qty}\t${price}`;
const report = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

beforeEach(() => {
  scripts = []; created = 0; posts.length = 0; sql.length = 0;
  asinsTable = [{ id: "id-A", asin: "A000000001" }, { id: "id-D", asin: "D00000DEAD" }];
  salesTiming.pollMs = 0; salesTiming.chunkDelayMs = 0; salesTiming.pollTimeoutMs = 5_000;
});

describe("parseOrdersReport / buildDateChunks", () => {
  it("drops cancelled lines, cuts the date to the day, parses qty and price", () => {
    const lines = report(row("2026-06-01", "A000000001", 2, 19.98), row("2026-06-01", "A000000001", 1, 9.99, "Cancelled"), row("2026-06-02", "B000000002", 1, 5)).split("\n").filter(Boolean);
    expect(parseOrdersReport(lines)).toEqual([
      { asin: "A000000001", date: "2026-06-01", qty: 2, price: 19.98 },
      { asin: "B000000002", date: "2026-06-02", qty: 1, price: 5 },
    ]);
  });
  it("30-day inclusive chunks, the last one cut at `to`", () => {
    expect(MAX_RANGE_DAYS).toBe(30);
    expect(buildDateChunks("2024-05-01", "2024-06-15", 30)).toEqual([["2024-05-01", "2024-05-30"], ["2024-05-31", "2024-06-15"]]);
    expect(buildDateChunks("2026-10-14", "2026-10-16", 30)).toEqual([["2026-10-14", "2026-10-16"]]);
    expect(buildDateChunks("2024-05-01", "2026-10-16", 30)).toHaveLength(30);
  });
});

describe("syncSalesData scope and onboarding", () => {
  it("reads EVERY asins row — no status filter — when unfiltered", async () => {
    scripts = [{ report: report(row("2026-06-01", "D00000DEAD", 1, 5)) }];
    const r = await syncSalesData("2026-06-01", "2026-06-01");
    const mapQuery = sql.find((q) => q.text.replace(/\s+/g, " ").trim().startsWith("SELECT id, asin FROM asins"))!;
    expect(mapQuery.text.replace(/\s+/g, " ").trim()).toBe("SELECT id, asin FROM asins"); // no WHERE status
    // the dead ASIN's row is written
    const ins = sql.filter((q) => q.text.includes("INSERT INTO sales_daily"));
    expect(ins).toHaveLength(1);
    expect(ins[0].params![0]).toBe("id-D");
    expect(r.asinsUpdated).toBe(1);
  });

  it("onboards unknown ASINs BEFORE the chunk's upsert, then writes their rows in the same chunk", async () => {
    scripts = [{ report: report(row("2026-06-01", "A000000001", 1, 10), row("2026-06-01", "N00000NEW1", 2, 20), row("2026-06-02", "N00000NEW1", 1, 10), row("2026-06-02", "N00000NEW2", 1, 7)) }];
    const order: string[] = [];
    const onboard = vi.fn(async (asins: string[]) => {
      order.push(`onboard:${asins.join(",")}`);
      for (const a of asins) asinsTable.push({ id: `id-${a}`, asin: a }); // the insert path creates the rows
    });
    const origLen = sql.length;
    const r = await syncSalesData("2026-06-01", "2026-06-02", undefined, { onboard });
    expect(onboard).toHaveBeenCalledTimes(1);
    expect(onboard).toHaveBeenCalledWith(["N00000NEW1", "N00000NEW2"]); // distinct, sorted
    // ordering: the onboard call happened before the first sales_daily INSERT
    const firstInsert = sql.slice(origLen).findIndex((q) => q.text.includes("INSERT INTO sales_daily"));
    const reselect = sql.slice(origLen).findIndex((q) => q.text.includes("FROM asins WHERE asin = ANY"));
    expect(reselect).toBeGreaterThan(-1);
    expect(reselect).toBeLessThan(firstInsert);
    // their rows landed
    const written = sql.filter((q) => q.text.includes("INSERT INTO sales_daily")).map((q) => `${q.params![0]}|${q.params![1]}|${q.params![2]}`);
    expect(written).toEqual(expect.arrayContaining(["id-N00000NEW1|2026-06-01|2", "id-N00000NEW1|2026-06-02|1", "id-N00000NEW2|2026-06-02|1", "id-A|2026-06-01|1"]));
    expect(r.onboarded).toEqual(["N00000NEW1", "N00000NEW2"]);
    expect(r.chunks[0].onboarded).toEqual(["N00000NEW1", "N00000NEW2"]);
    expect(r.chunks[0]).toMatchObject({ status: "ok", orders: 4, days: 2, asins: 3, minDate: "2026-06-01", maxDate: "2026-06-02", invalidAsins: [] });
  });

  it("a malformed ASIN string in the report (e.g. UNKNOW) is skipped and listed — never onboarded, never written", async () => {
    scripts = [{ report: report(row("2026-06-01", "UNKNOW", 1, 0), row("2026-06-01", "unknown", 1, 0), row("2026-06-01", "N00000NEW1", 2, 20)) }];
    const onboard = vi.fn(async (asins: string[]) => { for (const a of asins) asinsTable.push({ id: `id-${a}`, asin: a }); });
    const r = await syncSalesData("2026-06-01", "2026-06-01", undefined, { onboard });
    expect(onboard).toHaveBeenCalledWith(["N00000NEW1"]);
    expect(r.invalidAsins).toEqual(["UNKNOW", "unknown"]);
    expect(r.chunks[0].invalidAsins).toEqual(["UNKNOW", "unknown"]);
    const written = sql.filter((q) => q.text.includes("INSERT INTO sales_daily")).map((q) => q.params![0]);
    expect(written).toEqual(["id-N00000NEW1"]);
  });

  it("without an onboard callback (legacy route), unknown ASINs are skipped and nothing is inserted for them", async () => {
    scripts = [{ report: report(row("2026-06-01", "N00000NEW1", 2, 20)) }];
    const r = await syncSalesData("2026-06-01", "2026-06-01");
    expect(sql.filter((q) => q.text.includes("INSERT INTO sales_daily"))).toHaveLength(0);
    expect(r.onboarded).toEqual([]);
  });

  it("an explicit selection keeps its filter and never onboards", async () => {
    scripts = [{ report: report(row("2026-06-01", "A000000001", 1, 10), row("2026-06-01", "N00000NEW1", 2, 20)) }];
    const onboard = vi.fn(async () => {});
    await syncSalesData("2026-06-01", "2026-06-01", new Set(["A000000001"]), { onboard });
    expect(onboard).not.toHaveBeenCalled();
    expect(sql.filter((q) => q.text.includes("INSERT INTO sales_daily"))).toHaveLength(1);
  });

  it("the upsert writes units and revenue only; refund/fee columns get the 0 default on insert and are never in the SET list", async () => {
    scripts = [{ report: report(row("2026-06-01", "A000000001", 1, 10)) }];
    await syncSalesData("2026-06-01", "2026-06-01");
    const ins = sql.find((q) => q.text.includes("INSERT INTO sales_daily"))!.text;
    expect(ins).toMatch(/units_refunded, refund_amount\)\s+VALUES \(\$1, \$2, \$3, \$4, 0, 0\)/);
    const set = ins.slice(ins.indexOf("DO UPDATE SET"));
    expect(set).toMatch(/units_sold = EXCLUDED\.units_sold/);
    expect(set).toMatch(/revenue = EXCLUDED\.revenue/);
    expect(set).not.toMatch(/refund|actual_/);
  });
});

describe("syncSalesData failure semantics", () => {
  it("a failed chunk FAILS the sync with the chunks so far recorded — never skipped", async () => {
    scripts = [
      { report: report(row("2024-05-03", "A000000001", 1, 10)) },
      { status: "FATAL" },
      { report: report(row("2024-07-01", "A000000001", 1, 10)) },
    ];
    const seen: string[] = [];
    const p = syncSalesData("2024-05-01", "2024-07-15", undefined, { onChunk: (c) => { seen.push(`${c.start}:${c.status}`); } });
    await expect(p).rejects.toBeInstanceOf(SalesSyncError);
    const err = await p.catch((e) => e) as SalesSyncError;
    expect(err.message).toMatch(/chunk 2\/3 \(2024-05-31\.\.2024-06-29\) failed: Report R2 failed: FATAL/);
    expect(err.partial.chunks.map((c) => c.status)).toEqual(["ok", "failed"]);
    expect(err.partial.chunks[1].error).toMatch(/FATAL/);
    expect(err.partial.minDate).toBe("2024-05-03");
    expect(err.partial.totalOrders).toBe(1);
    expect(seen).toEqual(["2024-05-01:ok", "2024-05-31:failed"]);
    expect(created).toBe(2); // the third chunk was never requested
  });

  it("'Date range exceeded' is a chunk failure, not an empty chunk", async () => {
    scripts = [{ report: "Date range exceeded. Please narrow the range.\n" }];
    await expect(syncSalesData("2026-06-01", "2026-06-30")).rejects.toThrow(/Amazon refused the range 2026-06-01\.\.2026-06-30/);
  });

  it("an empty report is an 'empty' chunk with null dates", async () => {
    scripts = [{ report: HEADER + "\n" }];
    const r = await syncSalesData("2026-06-01", "2026-06-01");
    expect(r.chunks[0]).toMatchObject({ status: "empty", orders: 0, minDate: null, maxDate: null });
    expect(r.minDate).toBeNull();
  });

  it("reports the earliest and latest sale date Amazon actually returned across chunks", async () => {
    scripts = [
      { report: report(row("2024-05-09", "A000000001", 1, 10), row("2024-05-20", "A000000001", 1, 10)) },
      { report: report(row("2024-06-02", "A000000001", 1, 10)) },
    ];
    const r = await syncSalesData("2024-05-01", "2024-06-15");
    expect(r.minDate).toBe("2024-05-09"); // not 2024-05-01 — the window asked, the report answered
    expect(r.maxDate).toBe("2024-06-02");
    expect(posts[0]).toMatchObject({ dataStartTime: "2024-05-01T00:00:00Z", dataEndTime: "2024-05-30T23:59:59Z" }); // UTC bounds, unchanged
  });
});
