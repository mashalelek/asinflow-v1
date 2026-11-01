// Mark a PO as self-prep: ships_to = 'home' and prep cost $0 on every ASIN row,
// one History row per change (Maria 2026-10-29: 482270182 and havalon
// no_poid_at_checkout — the sheet said $0, AF had $1). Prep lives on
// po_asins only (po_line_items / purchase_orders have no prep column).
//
//   npx tsx script/set-po-home.ts --po <order_id> --supplier <supplier>          # dry run (default)
//   npx tsx script/set-po-home.ts --po <order_id> --supplier <supplier> --live   # writes, one transaction
//
// Needs DATABASE_URL. Refuses when the order # + supplier match no PO.
import "./env";
import pg from "pg";
import { logEdits } from "../server/po-edit";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const LIVE = process.argv.includes("--live");

(async () => {
  const orderId = arg("--po"), supplier = arg("--supplier");
  if (!orderId || !supplier) throw new Error("usage: --po <order_id> --supplier <supplier> [--live]");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const c = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query("BEGIN");
    const p = (await c.query(`SELECT id, ships_to FROM purchase_orders WHERE order_id = $1 AND supplier = $2 FOR UPDATE`, [orderId, supplier])).rows;
    if (p.length !== 1) throw new Error(`${supplier} ${orderId}: ${p.length} POs match — nothing written`);
    const po = p[0];
    const rows = (await c.query(`SELECT id, asin, prep_cost FROM po_asins WHERE po_id = $1 ORDER BY asin FOR UPDATE`, [po.id])).rows;
    const q = (sql: string, params?: any[]) => c.query(sql, params);
    console.log(`${supplier} ${orderId}: ships_to ${po.ships_to} → home${po.ships_to === "home" ? " (no change)" : ""}`);
    for (const r of rows) {
      const zero = r.prep_cost != null && Number(r.prep_cost) === 0;
      console.log(`  ${r.asin}: prep ${r.prep_cost ?? "NULL"} → 0${zero ? " (no change)" : ""}`);
      if (zero) continue;
      await c.query(`UPDATE po_asins SET prep_cost = 0 WHERE id = $1`, [r.id]);
      await logEdits(q, po.id, null, "asin", String(r.id), [{ field: "prep_cost", old: r.prep_cost == null ? null : String(r.prep_cost), new: "0" }]);
    }
    if (po.ships_to !== "home") {
      await c.query(`UPDATE purchase_orders SET ships_to = 'home', updated_at = NOW() WHERE id = $1`, [po.id]);
      await logEdits(q, po.id, null, "po", po.id, [{ field: "ships_to", old: po.ships_to, new: "home" }]);
    }
    await c.query(LIVE ? "COMMIT" : "ROLLBACK");
    console.log(LIVE ? "written" : "dry run — rolled back, nothing written (add --live)");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
