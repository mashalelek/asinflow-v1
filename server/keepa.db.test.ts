// Keepa storage on the REAL local schema (migration 121), every test in a transaction that is ROLLED BACK: the
// INTEGER[] with NULL elements, the two upserts, the series-kept-when-missing rule, dueAsins and the
// keepa_incomplete count all run against Postgres, because a mocked query never parses SQL. Skipped when no local
// Postgres answers. Nothing calls Keepa: the product is the recorded fixture.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { storeKeepaProduct, dueAsins, KEEPA_SERIES, type KeepaProduct } from "./keepa";

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM keepa_series LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
const ASIN = "B0ZZKEEPA1"; // synthetic (CLAUDE.md "Gate tests must not leave ROWS behind"); rolled back anyway
const product: KeepaProduct = { ...JSON.parse(readFileSync(join(__dirname, "__fixtures__", "keepa", "B08G6J2PY5.json"), "utf8")).products[0], asin: ASIN };
const NOW = new Date("2026-11-18T21:00:00Z");

async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
}

describe("keepa_series / keepa_fetch on the real schema (rolled back)", () => {
  it("stores every series as one integer per day with NULL gaps, and reads back the same values", async () => {
    if (!client) return;
    await inTx(async (q) => {
      const r = await storeKeepaProduct(q, product, 4, NOW);
      expect(r.series.sort()).toEqual([...KEEPA_SERIES].sort());
      expect(r.missing).toEqual([]);
      const rows = (await q(`SELECT series, first_day::text AS first_day, array_length(vals, 1) AS n, vals[array_length(vals, 1)] AS last FROM keepa_series WHERE asin = $1 ORDER BY series`, [ASIN])).rows;
      const by = Object.fromEntries(rows.map((x: any) => [x.series, x]));
      expect(by.new_price.first_day).toBe("2020-09-07");
      expect(Number(by.sales_rank.last)).toBe(175887);
      expect(Number(by.offers_new_fba.last)).toBe(3);
      expect(by.monthly_sold.last).toBeNull();
      // a NULL gap inside the array survives the round trip (Monthly Sold's December gap)
      const ms = (await q(`SELECT vals FROM keepa_series WHERE asin = $1 AND series = 'monthly_sold'`, [ASIN])).rows[0].vals as Array<number | null>;
      const first = (await q(`SELECT first_day::text AS d FROM keepa_series WHERE asin = $1 AND series = 'monthly_sold'`, [ASIN])).rows[0].d;
      const at = (day: string) => ms[Math.round((Date.parse(day) - Date.parse(first)) / 86_400_000)];
      expect(at("2025-11-15")).toBe(50);
      expect(at("2025-12-08")).toBeNull();
      expect(at("2025-12-20")).toBe(50);
      const f = (await q(`SELECT status, tokens, keepa_last_update, error FROM keepa_fetch WHERE asin = $1`, [ASIN])).rows[0];
      expect(f.status).toBe("fetched");
      expect(f.tokens).toBe(4);
      expect(new Date(f.keepa_last_update).toISOString()).toBe("2026-11-18T19:35:00.000Z");
    });
  });

  it("a second pull REPLACES each series; a series the response lacks is kept and reported missing", async () => {
    if (!client) return;
    await inTx(async (q) => {
      await storeKeepaProduct(q, product, 4, NOW);
      const before = (await q(`SELECT vals FROM keepa_series WHERE asin = $1 AND series = 'monthly_sold'`, [ASIN])).rows[0].vals;
      const r = await storeKeepaProduct(q, { ...product, monthlySoldHistory: null, lastUpdate: product.lastUpdate! + 60 }, 4, new Date(NOW.getTime() + 3_600_000));
      expect(r.missing).toEqual(["monthly_sold"]);
      expect((await q(`SELECT vals FROM keepa_series WHERE asin = $1 AND series = 'monthly_sold'`, [ASIN])).rows[0].vals).toEqual(before);
      expect(Number((await q(`SELECT count(*) FROM keepa_series WHERE asin = $1`, [ASIN])).rows[0].count)).toBe(KEEPA_SERIES.length);
      expect((await q(`SELECT array_length(vals, 1) AS n FROM keepa_series WHERE asin = $1 AND series = 'new_price'`, [ASIN])).rows[0].n).toBe(2264); // same end day → same length, replaced in place
    });
  });

  it("dueAsins and the daily job's keepa_incomplete count read keepa_fetch as the job does", async () => {
    if (!client) return;
    await inTx(async (q) => {
      await q(`INSERT INTO keepa_fetch (asin, fetched_at, status) VALUES ('B0ZZKEEPA2', '2026-11-18T12:00:00Z', 'fetched'), ('B0ZZKEEPA3', '2026-11-16T12:00:00Z', 'fetched'), ('B0ZZKEEPA4', '2026-11-18T12:00:00Z', 'error')`);
      const threshold = new Date("2026-11-18T05:00:00Z");
      const r = await dueAsins(q, ["B0ZZKEEPA1", "B0ZZKEEPA2", "B0ZZKEEPA3", "B0ZZKEEPA4"], threshold);
      expect(r.due).toEqual(["B0ZZKEEPA1", "B0ZZKEEPA3"]);
      expect(r.notDue).toEqual(["B0ZZKEEPA2", "B0ZZKEEPA4"]); // an error row today is not re-fetched today either
      const n = (await q(
        `SELECT count(*)::int AS n FROM unnest($1::text[]) a(asin) LEFT JOIN keepa_fetch f ON f.asin = a.asin
          WHERE f.asin IS NULL OR f.fetched_at < $2 OR f.status <> 'fetched'`,
        [["B0ZZKEEPA1", "B0ZZKEEPA2", "B0ZZKEEPA3", "B0ZZKEEPA4"], threshold],
      )).rows[0].n;
      expect(n).toBe(3); // never fetched, stale, and today's error
    });
  });

  it("jobs.kind accepts 'keepa' (migration 121) and the row is claimed by lane K's filter", async () => {
    if (!client) return;
    await inTx(async (q) => {
      const id = (await q(`INSERT INTO jobs (kind, trigger, include_daily) VALUES ('keepa', 'scheduled', false) RETURNING id`)).rows[0].id;
      const k = (await q(`SELECT id FROM jobs WHERE status IN ('running','queued') AND trigger = ANY($1::text[]) AND kind = $2 AND id = $3`, [["scheduled", "onboarding"], "keepa", id])).rows;
      expect(k).toHaveLength(1);
      const s = (await q(`SELECT id FROM jobs WHERE status IN ('running','queued') AND trigger = ANY($1::text[]) AND kind = $2 AND id = $3`, [["scheduled"], "refresh", id])).rows;
      expect(s).toHaveLength(0);
      await expect(q(`INSERT INTO jobs (kind, trigger, include_daily) VALUES ('other', 'scheduled', false)`)).rejects.toThrow(/jobs_kind_check/);
    });
  });
});
