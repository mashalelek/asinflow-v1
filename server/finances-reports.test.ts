// Reports behind the Finances lines (patch commit 4) on recorded TSVs under
// __fixtures__/finances — never a live report.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fetchReport, parseRemovals, parseReturns, parseStorage, parseTsv, reportChunks, splitByWeight, storageMonthFor, storeRemovals, storeReturns, storeStorage, type ReportDeps } from "./finances-reports";

const fx = (n: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", "finances", n), "utf8");

describe("parsers", () => {
  it("returns: return-date → Pacific day, SELLABLE disposition, quantity, LPN; comments are not stored", () => {
    const rows = parseReturns(fx("returns-aug.tsv"));
    expect(rows.length).toBe(8);
    for (const r of rows) { expect(r.return_day).toMatch(/^2026-08-\d\d$/); expect(r.quantity).toBeGreaterThan(0); expect(r.order_id).toMatch(/^\d{3}-\d{7}-\d{7}$/); }
    expect(rows.some((r) => r.disposition === "SELLABLE")).toBe(true);
    expect(rows.every((r) => typeof r.lpn === "string")).toBe(true);
  });
  it("removals: the August disposal of B001TLKXNS is a Disposal row, 1 unit disposed, completed 2026-08-28; the liquidation of the same SKU is not", () => {
    const rows = parseRemovals(fx("removals-aug.tsv"), (sku) => (sku === "61-6ERA-X148" ? "B001TLKXNS" : null));
    const d = rows.find((r) => r.order_id === "2608211DBH")!;
    expect(d).toMatchObject({ order_type: "Disposal", disposition: "Sellable", disposed_qty: 1, asin: "B001TLKXNS", completed_day: "2026-08-28", removal_fee: 0.84 });
    const liq = rows.find((r) => r.order_id === "2608081AZJ")!;
    expect(liq.order_type).toBe("Liquidations"); expect(liq.disposed_qty).toBe(0); expect(liq.shipped_qty).toBe(1);
  });
  it("storage: month, fnsku, FC without the quotes, the fee; B0756KB8N1's October rows sum to 23.30 (commit 0 (c))", () => {
    const rows = parseStorage(fx("storage-2026-10.tsv"));
    expect(rows.every((r) => r.month === "2026-10")).toBe(true);
    expect(rows[0].fc).toMatch(/^[A-Z0-9]+$/);
    const mine = rows.filter((r) => r.asin === "B0756KB8N1");
    expect(mine.length).toBe(3); // the fixture keeps 3 of the 23 October rows (the full report sums to 23.30)
    expect(Math.round(mine.reduce((s, r) => s + r.fee, 0) * 10000) / 10000).toBe(2.8965);
  });
  it("parseTsv trims and keys by header; reportChunks are ≤ 60 inclusive days", () => {
    expect(parseTsv("a\tb\n1\t2\n")).toEqual([{ a: "1", b: "2" }]);
    expect(reportChunks("2026-08-01", "2026-11-19")).toEqual([["2026-08-01", "2026-09-29"], ["2026-09-30", "2026-11-19"]]);
    expect(reportChunks("2026-08-01", "2026-08-31")).toEqual([["2026-08-01", "2026-08-31"]]);
  });
  it("storageMonthFor: a storage row posted on Nov 7 is October's report", () => {
    expect(storageMonthFor("2026-11-07")).toBe("2026-10"); expect(storageMonthFor("2026-01-07")).toBe("2025-12");
  });
});

describe("splitByWeight (§4, commit 0 (d): weight = qty × weight_lb)", () => {
  it("splits by weight, exact to the cent in total", () => {
    const m = splitByWeight(-65.1, [{ asin: "B0756KB8N1", qty: 2, weight_lb: 12.1497 }, { asin: "OTHER", qty: 87, weight_lb: 1.1931 }]);
    const total = Array.from(m.values()).reduce((s, v) => s + v, 0);
    expect(Math.round(total * 100) / 100).toBe(-65.1);
    expect(m.get("B0756KB8N1")!).toBeCloseTo(-12.35, 1);
  });
  it("falls back to units when no item has a weight; an item without an ASIN goes to the account-only part", () => {
    const m = splitByWeight(-10, [{ asin: "A", qty: 3, weight_lb: null }, { asin: null, qty: 1, weight_lb: null }]);
    expect(m.get("A")).toBeCloseTo(-7.5); expect(m.get("")).toBeCloseTo(-2.5);
    expect(splitByWeight(-4, []).get("")).toBe(-4);
  });
});

describe("fetchReport", () => {
  it("creates, polls to DONE, downloads and gunzips", async () => {
    const calls: string[] = [];
    const deps: ReportDeps = {
      post: async (e, body) => { calls.push(`POST ${e} ${body.reportType}`); return { reportId: "R1" }; },
      get: async (e) => { calls.push(`GET ${e}`); return e.endsWith("/R1") ? { processingStatus: "DONE", reportDocumentId: "D1" } : { url: "https://s3/x", compressionAlgorithm: "GZIP" }; },
      download: async () => require("node:zlib").gzipSync(Buffer.from("a\tb\n1\t2\n")),
      sleep: async () => {},
    };
    expect(await fetchReport("GET_X", "2026-08-01T00:00:00Z", "2026-08-31T23:59:59Z", deps)).toBe("a\tb\n1\t2\n");
    expect(calls).toEqual(["POST /reports/2021-06-30/reports GET_X", "GET /reports/2021-06-30/reports/R1", "GET /reports/2021-06-30/documents/D1"]);
  });
});

describe("store* write the rows as received (SQL recorded)", () => {
  const rec = () => { const sql: { text: string; params: any[] }[] = []; return { sql, q: async (text: string, params?: any[]) => { sql.push({ text, params: params ?? [] }); return { rows: [], rowCount: 1 }; } }; };
  it("returns upsert by (return_at, order_id, sku, lpn); storage deletes the month then inserts; removals upsert by (order, sku, disposition)", async () => {
    const a = rec(); await storeReturns(parseReturns(fx("returns-aug.tsv")), a.q);
    expect(a.sql.length).toBe(8); expect(a.sql[0].text).toMatch(/ON CONFLICT \(return_at, order_id, sku, lpn\)/);
    const b = rec(); await storeStorage("2026-10", parseStorage(fx("storage-2026-10.tsv")), b.q);
    expect(b.sql[0].text).toMatch(/DELETE FROM fba_storage_fees WHERE month = \$1/); expect(b.sql.length).toBe(9);
    const c = rec(); await storeRemovals(parseRemovals(fx("removals-aug.tsv")), c.q);
    expect(c.sql[0].text).toMatch(/ON CONFLICT \(order_id, sku, disposition\)/);
  });
});
