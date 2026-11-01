// Set a PO's ASIN-row prep cost with a History row (po_edit_log) — the way the PO editor does it
// (editAsinRow). Maria 2026-11-01: PO 200015336732726 (Velocity) was saved with prep $0.00; it is $1.00.
//   tsx script/fix-po-prep.ts --order 200015336732726 --prep 1.00 [--prod] [--live]
// Dry run by default: prints the rows it would change. `--prod` reads .env.production.local (script/env.ts).
import "./env";
import { Pool } from "pg";
import { editAsinRow } from "../server/po-edit";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), prep = arg("--prep"), live = process.argv.includes("--live");
if (!order || !prep || !/^\d+(\.\d{1,2})?$/.test(prep)) { console.error("usage: --order <order id> --prep <amount> [--prod] [--live]"); process.exit(2); }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const pos = (await query(`SELECT id, supplier, order_id, ships_to FROM purchase_orders WHERE order_id = $1`, [order])).rows;
    if (pos.length !== 1) throw new Error(`${pos.length} POs match order ${order}`);
    const po = pos[0];
    const rows = (await query(`SELECT id, asin, prep_cost FROM po_asins WHERE po_id = $1 ORDER BY asin`, [po.id])).rows;
    console.log(`${po.supplier} ${po.order_id} (${po.ships_to}): ${rows.length} ASIN row(s)`);
    for (const r of rows) console.log(`  ${r.asin}: prep ${r.prep_cost} → ${Number(prep).toFixed(2)}${Number(r.prep_cost) === Number(prep) ? " (unchanged)" : ""}`);
    if (!live) { console.log("dry run — add --live to write"); return; }
    await query("BEGIN");
    let changed = 0;
    for (const r of rows) { const res = await editAsinRow(query, String(r.id), { prep_cost: Number(prep).toFixed(2) }, null); changed += res.changes.length; }
    await query("COMMIT");
    const after = (await query(`SELECT asin, prep_cost FROM po_asins WHERE po_id = $1 ORDER BY asin`, [po.id])).rows;
    const log = (await query(`SELECT field, old_value, new_value, at FROM po_edit_log WHERE po_id = $1 AND field = 'prep_cost' ORDER BY at DESC LIMIT 5`, [po.id])).rows;
    console.log(`written: ${changed} change(s); now ${after.map((a: any) => `${a.asin} ${a.prep_cost}`).join(", ")}; History: ${JSON.stringify(log)}`);
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
