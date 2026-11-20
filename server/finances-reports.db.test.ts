// The report stores on the REAL schema (migration 124), rolled back; skipped without a local Postgres.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { parseRemovals, parseReturns, parseStorage, storeRemovals, storeReturns, storeStorage } from "./finances-reports";

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => { const c = new pg.Client({ connectionString: url }); try { await c.connect(); await c.query("SELECT 1 FROM fba_removals LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); } });
afterAll(async () => { await client?.end(); });
const fx = (n: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", "finances", n), "utf8");

describe("report rows on the real schema (rolled back)", () => {
  it("idempotent upserts; the storage month replaced in full", async () => {
    if (!client) return;
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    await q("BEGIN");
    try {
      const ret = parseReturns(fx("returns-aug.tsv"));
      await storeReturns(ret, q); await storeReturns(ret, q);
      expect((await q(`SELECT count(*)::int AS n FROM fba_customer_returns WHERE return_day BETWEEN '2026-08-01' AND '2026-08-31'`)).rows[0].n).toBeGreaterThanOrEqual(8);
      const st = parseStorage(fx("storage-2026-10.tsv"));
      await storeStorage("2026-10", st, q); await storeStorage("2026-10", st, q);
      expect((await q(`SELECT count(*)::int AS n, ROUND(SUM(fee), 2)::float8 AS fee FROM fba_storage_fees WHERE month = '2026-10' AND asin = 'B0756KB8N1'`)).rows[0]).toMatchObject({ n: 3, fee: 2.9 });
      const rm = parseRemovals(fx("removals-aug.tsv"), (sku) => (sku === "61-6ERA-X148" ? "B001TLKXNS" : null));
      await storeRemovals(rm, q); await storeRemovals(rm, q);
      expect((await q(`SELECT disposed_qty, asin, completed_day::text FROM fba_removals WHERE order_id = '2608211DBH'`)).rows[0]).toEqual({ disposed_qty: 1, asin: "B001TLKXNS", completed_day: "2026-08-28" });
    } finally { await q("ROLLBACK"); }
  });
});
