// The ingest on the REAL local schema (migration 123), rolled back: the deferred →
// released replacement leaves exactly one live fee state per (order, shipment, SKU),
// so nothing is counted twice (SPEC §3). Skipped when no local Postgres answers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { financesDeps, storeTransactions } from "./finances";

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM finances_lines LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });
const page = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "__fixtures__", "finances", n), "utf8")).payload.transactions as any[];
const DEFERRED_ID = "M-SKJhuzVkKNt0UMhnnYppjglVO84ge2BDrk6kQ5hqo";

describe("finances ingest on the real schema (rolled back)", () => {
  it("window 1 then window 2: the DEFERRED row is superseded, the RELEASED row is live, Σ fee over live rows = the released fee once", async () => {
    if (!client) return;
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    financesDeps.transaction = async (fn) => fn(q as any);
    await q("BEGIN");
    try {
      const before = (await q(`SELECT count(*)::int AS n FROM finances_transactions`)).rows[0].n;
      const r1 = await storeTransactions([...page("window-1-page-1.json"), ...page("window-1-page-2.json")], new Map(), null, { from: "2026-07-29T00:00:00Z", to: "2026-08-05T00:00:00Z" }, 2);
      expect(r1.stored).toBe(6);
      const d = (await q(`SELECT transaction_status, superseded_at FROM finances_transactions WHERE transaction_id = $1`, [DEFERRED_ID])).rows[0];
      expect(d.transaction_status).toBe("DEFERRED"); expect(d.superseded_at).toBeNull();
      const live = async () => (await q(`SELECT COALESCE(SUM(l.amount), 0)::float8 AS fba FROM finances_lines l JOIN finances_transactions t ON t.transaction_id = l.transaction_id WHERE l.order_id = '113-2046126-7989841' AND l.line = 'fba_fee' AND t.superseded_at IS NULL`)).rows[0].fba;
      expect(await live()).toBe(-4.35);
      const r2 = await storeTransactions(page("window-2-page-1.json"), new Map(), null, { from: "2026-08-05T00:00:00Z", to: "2026-08-12T00:00:00Z" }, 1);
      expect(r2.stored).toBe(4); expect(r2.superseded).toBeGreaterThanOrEqual(1);
      const d2 = (await q(`SELECT superseded_at FROM finances_transactions WHERE transaction_id = $1`, [DEFERRED_ID])).rows[0];
      expect(d2.superseded_at).not.toBeNull();
      expect(await live()).toBe(-4.35); // the released row alone; both rows would give −8.70
      expect((await q(`SELECT count(*)::int AS n FROM finances_transactions WHERE transaction_status = 'RELEASED' AND deferred_transaction_id = $1`, [DEFERRED_ID])).rows[0].n).toBe(1);
      // idempotent: the same window again changes nothing
      await storeTransactions(page("window-2-page-1.json"), new Map(), null, { from: "2026-08-05T00:00:00Z", to: "2026-08-12T00:00:00Z" }, 1);
      expect(await live()).toBe(-4.35);
      expect((await q(`SELECT count(*)::int AS n FROM finances_ingest_log WHERE source = 'transactions'`)).rows[0].n).toBeGreaterThanOrEqual(3);
      expect((await q(`SELECT count(*)::int AS n FROM finances_transactions`)).rows[0].n).toBe(before + 10);
    } finally { await q("ROLLBACK"); }
  });
});
