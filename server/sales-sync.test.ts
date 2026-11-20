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
/** Test seam: make an INSERT fail (the fail-closed transaction test). */
let failInsertFor: string | null = null;
let financesRows: any[] = [];
let lastUnitPrices: any[] = [];
const mockQuery = vi.fn(async (text: string, params?: any[]) => {
  sql.push({ text, params });
  const t = text.replace(/\s+/g, " ").trim();
  if (t === "BEGIN" || t === "COMMIT" || t === "ROLLBACK") return { rows: [], rowCount: 0 };
  if (t === "SELECT id, asin FROM asins") return { rows: asinsTable, rowCount: asinsTable.length };
  if (t.startsWith("SELECT id, asin FROM asins WHERE asin = ANY")) return { rows: asinsTable.filter((r) => params![0].includes(r.asin)), rowCount: 0 };
  if (t.startsWith("DELETE FROM sales_daily") || t.startsWith("DELETE FROM sales_orders")) return { rows: [], rowCount: 0 };
  if (t.startsWith("INSERT INTO sales_daily")) { if (failInsertFor && params![0] === failInsertFor) throw new Error("boom: disk full"); return { rows: [], rowCount: 1 }; }
  if (t.startsWith("INSERT INTO sales_orders")) return { rows: [], rowCount: 1 };
  // Finances patch (commit 3): the per-order store and the live Finances rows per (order, SKU).
  if (t.startsWith("DELETE FROM finances_order_lines") || t.startsWith("INSERT INTO finances_order_lines")) return { rows: [], rowCount: 1 };
  if (t.startsWith("WITH live AS")) return { rows: financesRows.filter((r) => params![0].includes(r.order_id)), rowCount: 0 };
  if (t.startsWith("SELECT DISTINCT ON (l.asin) l.asin")) return { rows: lastUnitPrices, rowCount: 0 };
  throw new Error(`unexpected sql ${t.slice(0, 60)}`);
});
vi.mock("./db", () => ({
  query: (text: string, params?: any[]) => mockQuery(text, params),
  // The delete + reload runs on a pool client inside BEGIN … COMMIT; the same log sees it.
  default: { connect: async () => ({ query: (text: string, params?: any[]) => mockQuery(text, params), release: () => {} }) },
}));

import { syncSalesData, parseOrdersReport, parseOrdersReportAll, mergeOrderLines, buildDateChunks, salesTiming, salesDb, SalesSyncError, MAX_RANGE_DAYS, pacificDay, pacificToUtc, reportWindowUtc, tzOffsetMinutes } from "./sales-sync";

const HEADER = "amazon-order-id\tpurchase-date\torder-status\tasin\tquantity\titem-price";
// 15:00 UTC = 08:00 Pacific (PDT) / 07:00 (PST): the Pacific day equals the date given.
const row = (date: string, asin: string, qty: number, price: number, status = "Shipped", orderId = `o-${date}-${asin}`) => `${orderId}\t${date}T15:00:00+00:00\t${status}\t${asin}\t${qty}\t${price}`;
const rowAt = (iso: string, asin: string, qty: number, price: number, orderId: string) => `${orderId}\t${iso}\tShipped\t${asin}\t${qty}\t${price}`;
const report = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

beforeEach(() => {
  scripts = []; created = 0; posts.length = 0; sql.length = 0;
  asinsTable = [{ id: "id-A", asin: "A000000001" }, { id: "id-D", asin: "D00000DEAD" }];
  salesTiming.pollMs = 0; salesTiming.chunkDelayMs = 0; salesTiming.pollTimeoutMs = 5_000;
  failInsertFor = null; financesRows = []; lastUnitPrices = []; salesDb.now = () => new Date("2026-11-03T12:00:00Z");
});

describe("parseOrdersReport / buildDateChunks", () => {
  it("drops cancelled lines, cuts the date to the day, parses qty and price", () => {
    const lines = report(row("2026-06-01", "A000000001", 2, 19.98), row("2026-06-01", "A000000001", 1, 9.99, "Cancelled"), row("2026-06-02", "B000000002", 1, 5)).split("\n").filter(Boolean);
    expect(parseOrdersReport(lines).map(({ orderId, asin, date, qty, price }) => ({ orderId, asin, date, qty, price }))).toEqual([
      { orderId: "o-2026-06-01-A000000001", asin: "A000000001", date: "2026-06-01", qty: 2, price: 19.98 },
      { orderId: "o-2026-06-02-B000000002", asin: "B000000002", date: "2026-06-02", qty: 1, price: 5 },
    ]);
  });
  it("the sale day is the US Pacific day of purchase-date (D7), around midnight UTC and midnight Pacific, PDT and PST", () => {
    expect(pacificDay("2026-06-02T03:00:00+00:00")).toBe("2026-06-01"); // 20:00 PDT the day before
    expect(pacificDay("2026-06-02T06:59:59Z")).toBe("2026-06-01");
    expect(pacificDay("2026-06-02T07:00:00Z")).toBe("2026-06-02"); // Pacific midnight (PDT = UTC−7)
    expect(pacificDay("2026-01-15T07:59:59Z")).toBe("2026-01-14"); // PST = UTC−8
    expect(pacificDay("2026-01-15T08:00:00Z")).toBe("2026-01-15");
    expect(pacificDay("2026-06-01T15:00:00-07:00")).toBe("2026-06-01");
    expect(pacificDay("garbage-date-xx")).toBe("garbage-da");
    expect(tzOffsetMinutes(new Date("2026-06-01T12:00:00Z"), "America/Los_Angeles")).toBe(-420);
    expect(tzOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "America/Los_Angeles")).toBe(-480);
    const lines = report(rowAt("2026-06-02T03:00:00+00:00", "A000000001", 1, 5, "o1"), rowAt("2026-06-02T07:00:00+00:00", "A000000001", 1, 5, "o2")).split("\n").filter(Boolean);
    expect(parseOrdersReport(lines).map((l) => l.date)).toEqual(["2026-06-01", "2026-06-02"]);
  });
  it("report windows are Pacific day boundaries in UTC — DST-correct, the end clamped to now", () => {
    expect(pacificToUtc("2026-06-01", "00:00:00")).toBe("2026-06-01T07:00:00Z");
    expect(pacificToUtc("2026-06-30", "23:59:59")).toBe("2026-07-01T06:59:59Z");
    expect(pacificToUtc("2026-01-15", "00:00:00")).toBe("2026-01-15T08:00:00Z");
    expect(pacificToUtc("2026-01-15", "23:59:59")).toBe("2026-01-16T07:59:59Z");
    // fall-back day 2026-11-01: midnight is still PDT, 23:59:59 is PST
    expect(pacificToUtc("2026-11-01", "00:00:00")).toBe("2026-11-01T07:00:00Z");
    expect(pacificToUtc("2026-11-01", "23:59:59")).toBe("2026-11-02T07:59:59Z");
    expect(reportWindowUtc("2026-06-01", "2026-06-30", new Date("2026-11-03T12:00:00Z"))).toEqual({ dataStartTime: "2026-06-01T07:00:00Z", dataEndTime: "2026-07-01T06:59:59Z" });
    expect(reportWindowUtc("2026-11-02", "2026-11-03", new Date("2026-11-03T12:00:00.400Z"))).toEqual({ dataStartTime: "2026-11-02T08:00:00Z", dataEndTime: "2026-11-03T12:00:00Z" });
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
    expect(posts[0]).toMatchObject({ dataStartTime: "2024-05-01T07:00:00Z", dataEndTime: "2024-05-31T06:59:59Z" }); // Pacific day bounds, as UTC (D7)
  });
});

describe("delete + reload per chunk (fail-closed) and sales_orders", () => {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const kinds = () => sql.map((q) => norm(q.text)).filter((t) => /^(BEGIN|COMMIT|ROLLBACK|DELETE FROM sales_daily|DELETE FROM sales_orders|INSERT INTO sales_daily|INSERT INTO sales_orders)/.test(t)).map((t) => t.split(" ").slice(0, 3).join(" "));
  it("the window's sales_daily and sales_orders rows are deleted and the parsed rows inserted inside ONE transaction, the delete after the report was parsed", async () => {
    scripts = [{ report: report(row("2026-06-01", "A000000001", 2, 20, "Shipped", "111-1"), row("2026-06-01", "A000000001", 1, 10, "Shipped", "111-1"), row("2026-06-02", "A000000001", 1, 10, "Shipped", "222-2")) }];
    const r = await syncSalesData("2026-06-01", "2026-06-30");
    expect(kinds()).toEqual(["BEGIN", "DELETE FROM sales_daily", "DELETE FROM sales_orders", "INSERT INTO sales_daily", "INSERT INTO sales_daily", "INSERT INTO sales_orders", "INSERT INTO sales_orders", "COMMIT"]);
    const del = sql.find((q) => norm(q.text).startsWith("DELETE FROM sales_daily"))!;
    expect(norm(del.text)).toBe("DELETE FROM sales_daily WHERE sale_date >= $1::date AND sale_date <= $2::date"); // unfiltered: every ASIN's rows in the window
    expect(del.params).toEqual(["2026-06-01", "2026-06-30"]);
    // the two lines of order 111-1 on the same ASIN are ONE sales_orders row with units 3
    const orders = sql.filter((q) => norm(q.text).startsWith("INSERT INTO sales_orders")).map((q) => q.params);
    expect(orders).toEqual([["111-1", "id-A", "2026-06-01", 3], ["222-2", "id-A", "2026-06-02", 1]]);
    expect(r.chunks[0]).toMatchObject({ orders: 3, distinctOrders: 2, days: 2 });
  });
  it("an explicit selection deletes and reloads only the selected ASINs' rows", async () => {
    scripts = [{ report: report(row("2026-06-01", "A000000001", 1, 10), row("2026-06-01", "D00000DEAD", 1, 10)) }];
    await syncSalesData("2026-06-01", "2026-06-01", new Set(["A000000001"]));
    const del = sql.find((q) => norm(q.text).startsWith("DELETE FROM sales_daily"))!;
    expect(norm(del.text)).toContain("AND asin_id = ANY($3::uuid[])");
    expect(del.params).toEqual(["2026-06-01", "2026-06-01", ["id-A"]]);
  });
  it("a chunk whose report fails issues NO delete — the old rows stay (fail-closed)", async () => {
    scripts = [{ report: report(row("2024-05-03", "A000000001", 1, 10)) }, { status: "FATAL" }];
    await expect(syncSalesData("2024-05-01", "2024-06-15")).rejects.toBeInstanceOf(SalesSyncError);
    const dels = sql.filter((q) => norm(q.text).startsWith("DELETE FROM sales_daily"));
    expect(dels).toHaveLength(1); // chunk 1 only
    expect(dels[0].params).toEqual(["2024-05-01", "2024-05-30"]);
  });
  it("a write that fails mid-chunk rolls the whole chunk back and fails the sync", async () => {
    scripts = [{ report: report(row("2026-06-01", "A000000001", 1, 10), row("2026-06-01", "D00000DEAD", 1, 10)) }];
    failInsertFor = "id-D";
    await expect(syncSalesData("2026-06-01", "2026-06-01")).rejects.toThrow(/boom: disk full/);
    expect(kinds()).toEqual(["BEGIN", "DELETE FROM sales_daily", "DELETE FROM sales_orders", "INSERT INTO sales_daily", "INSERT INTO sales_daily", "ROLLBACK"]);
  });
  it("a report whose rows are all cancelled clears the window (a cancelled-only day loses its stale units), in the same transaction shape", async () => {
    scripts = [{ report: report(row("2026-06-01", "A000000001", 1, 10, "Cancelled")) }];
    const r = await syncSalesData("2026-06-01", "2026-06-01");
    expect(r.chunks[0].status).toBe("empty");
    expect(kinds()).toEqual(["BEGIN", "DELETE FROM sales_daily", "DELETE FROM sales_orders", "COMMIT"]);
  });
  it("a report with NO data rows (Amazon's retention horizon) leaves the window's stored rows untouched — no delete at all", async () => {
    scripts = [{ report: HEADER + "\n" }];
    const r = await syncSalesData("2024-09-01", "2024-09-30");
    expect(r.chunks[0]).toMatchObject({ status: "empty", orders: 0, minDate: null });
    expect(kinds()).toEqual([]);
  });
});

// ── Finances patch, commit 3: per-order sales from Finances rows, cancellations kept in the per-order store ──
describe("sales from the order's Finances row (SPEC §2), the per-order store", () => {
  const H2 = "amazon-order-id\tpurchase-date\torder-status\titem-status\tfulfillment-channel\tsku\tasin\tquantity\titem-price\titem-promotion-discount";
  const r2 = (o: string, status: string, itemStatus: string, sku: string, asin: string, qty: number, price: string, promo = "0") => `${o}\t2026-06-01T15:00:00+00:00\t${status}\t${itemStatus}\tAFN\t${sku}\t${asin}\t${qty}\t${price}\t${promo}`;
  const rep = (...rows: string[]) => [H2, ...rows].join("\n") + "\n";
  const ins = () => sql.filter((q) => q.text.includes("INSERT INTO sales_daily")).map((q) => q.params!);
  const lines = () => sql.filter((q) => q.text.includes("INSERT INTO finances_order_lines")).map((q) => q.params!);
  it("a line with a live Finances row takes principal + promotion for the shipped units and the report price for the rest; one without takes price − promotion", async () => {
    financesRows = [{ order_id: "o1", sku: "SKU-A", principal: 20, promo: -1, fba_fee: -3, referral_fee: -2, vcf: 0, other_fee: 0, quantity: 1, any_deferred: false }];
    scripts = [{ report: rep(r2("o1", "Shipped", "Shipped", "SKU-A", "A000000001", 2, "50.00"), r2("o2", "Pending", "Pending", "SKU-A", "A000000001", 1, "30.00", "2.00")) }];
    await syncSalesData("2026-06-01", "2026-06-01");
    expect(ins()).toEqual([["id-A", "2026-06-01", 3, 19 + 25 + 28]]);
  });
  it("a Pending line with no price and no Finances row is priced at the ASIN's last Finances unit price (never a day average)", async () => {
    lastUnitPrices = [{ asin: "A000000001", unit: 25.96 }];
    scripts = [{ report: rep(r2("o3", "Pending", "Pending", "SKU-A", "A000000001", 1, "")) }];
    await syncSalesData("2026-06-01", "2026-06-01");
    expect(ins()).toEqual([["id-A", "2026-06-01", 1, 25.96]]);
  });
  it("cancelled lines leave sales_daily but are stored in finances_order_lines as Cancelled (order-status or item-status)", async () => {
    scripts = [{ report: rep(r2("o4", "Cancelled", "Cancelled", "SKU-A", "A000000001", 1, "10.00"), r2("o5", "Shipped", "Cancelled", "SKU-A", "A000000001", 1, "10.00"), r2("o6", "Shipped", "Shipped", "SKU-A", "A000000001", 1, "10.00")) }];
    await syncSalesData("2026-06-01", "2026-06-01");
    expect(ins()).toEqual([["id-A", "2026-06-01", 1, 10]]);
    expect(lines().map((p) => [p[0], p[5], p[6]])).toEqual([["o4", "Cancelled", 1], ["o5", "Cancelled", 1], ["o6", "Shipped", 1]]);
    expect(sql.some((q) => q.text.startsWith("DELETE FROM finances_order_lines"))).toBe(true);
  });
  it("two report lines of one order and SKU (one Shipped, one Pending) become ONE per-order line: units and price summed, status Shipped; two cancelled parts stay one Cancelled line", () => {
    const L = rep(r2("o7", "Pending", "Shipped", "SKU-A", "A000000001", 1, "25.96"), r2("o7", "Pending", "Pending", "SKU-A", "A000000001", 1, ""), r2("o8", "Cancelled", "Cancelled", "SKU-A", "A000000001", 1, "5"), r2("o8", "Cancelled", "Cancelled", "SKU-A", "A000000001", 2, "10")).split("\n").filter(Boolean);
    const m = mergeOrderLines(parseOrdersReportAll(L));
    expect(m.map((l) => [l.orderId, l.qty, l.price, l.cancelled, l.status])).toEqual([["o7", 2, 25.96, false, "Pending"], ["o8", 3, 5, true, "Cancelled"]]);
  });
  it("parseOrdersReportAll keeps every line and marks the cancelled ones; parseOrdersReport drops them", () => {
    const L = rep(r2("o4", "Cancelled", "Cancelled", "S", "A000000001", 1, "10"), r2("o6", "Shipped", "Shipped", "S", "A000000001", 1, "10")).split("\n").filter(Boolean);
    expect(parseOrdersReportAll(L).map((l) => l.cancelled)).toEqual([true, false]);
    expect(parseOrdersReport(L).length).toBe(1);
    expect(parseOrdersReportAll(L)[1]).toMatchObject({ sku: "S", status: "Shipped", channel: "AFN", promo: 0, purchaseAt: "2026-06-01T15:00:00+00:00" });
  });
});
