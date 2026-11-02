// Set one PO ASIN row's cost / unit with a History row (po_edit_log) — the way the PO
// editor does it (editAsinRow). Maria 2026-11-02: PO 6433257 (opentip.com) B07J9QQDSS
// was imported with the single-unit price (2.61); the ASIN is a 2-pack, so its COGS is
// 5.22 like the two earlier opentip POs. The ASINs page's COGS follows at the next
// pass (component 9, runSheetsSync: newest non-canceled PO row per ASIN).
//   tsx script/fix-po-cost.ts --order 6433257 --asin B07J9QQDSS --cost 5.22 [--prod] [--live]
// Dry run by default. `--prod` reads .env.production.local (script/env.ts).
import "./env";
import { Pool } from "pg";
import { editAsinRow } from "../server/po-edit";
import { loadAfAsinCostMap } from "../server/po-af-source";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), asin = (arg("--asin") ?? "").toUpperCase(), cost = arg("--cost"), live = process.argv.includes("--live");
if (!order || !/^B0[A-Z0-9]{8}$/.test(asin) || !cost || !/^\d+(\.\d{1,2})?$/.test(cost)) { console.error("usage: --order <order id> --asin <ASIN> --cost <amount> [--prod] [--live]"); process.exit(2); }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  const state = async (paId: string) => {
    const r = (await query(`SELECT cost_per_unit, sourcing_cost, paid_cost, prep_cost FROM po_asins WHERE id = $1`, [paId])).rows[0];
    const est = (await query(`SELECT cogs, actual_cogs, cogs_source, estimated_cogs, estimated_cogs_source FROM asin_estimates WHERE asin = $1`, [asin])).rows[0];
    const newest = (await loadAfAsinCostMap(query, [asin])).data.get(asin);
    return `cost/unit ${r.cost_per_unit}, sourcing ${r.sourcing_cost}, paid ${r.paid_cost}, prep ${r.prep_cost}; ASINs page COGS ${est?.cogs ?? "∅"} (${est?.cogs_source ?? "∅"}), est. ${est?.estimated_cogs ?? "∅"} (${est?.estimated_cogs_source ?? "∅"}); newest-PO cost the pass would write: ${newest?.cogs ?? "∅"}`;
  };
  try {
    const pos = (await query(`SELECT id, supplier, order_id, ships_to, cost_formula_version FROM purchase_orders WHERE order_id = $1`, [order])).rows;
    if (pos.length !== 1) throw new Error(`${pos.length} POs match order ${order}`);
    const po = pos[0];
    const pa = (await query(`SELECT id FROM po_asins WHERE po_id = $1 AND asin = $2`, [po.id, asin])).rows[0];
    if (!pa) throw new Error(`${po.supplier} ${po.order_id} has no ASIN row for ${asin}`);
    const paId = String(pa.id);
    console.log(`${po.supplier} ${po.order_id} (${po.ships_to}, ${po.cost_formula_version == null ? "sheet-imported" : "formula v" + po.cost_formula_version}), ASIN row ${paId}`);
    console.log(`before: ${await state(paId)}`);
    await query("BEGIN");
    const res = await editAsinRow(query, paId, { cost_per_unit: Number(cost).toFixed(2) }, null);
    console.log(`changes: ${res.changes.length === 0 ? "none" : res.changes.map((c) => `${c.field} ${c.old ?? "∅"} → ${c.new ?? "∅"}`).join("; ")}; auto-close: ${res.close.changed ?? (res.close.closed ? "stays closed" : "stays open")}`);
    console.log(`${live ? "after" : "after (dry run, rolled back)"}: ${await state(paId)}`);
    const log = (await query(`SELECT field, old_value, new_value, at FROM po_edit_log WHERE po_id = $1 AND entity_id = $2 AND field = 'cost_per_unit' ORDER BY at DESC LIMIT 3`, [po.id, paId])).rows;
    console.log(`History: ${JSON.stringify(log)}`);
    if (!live) { await query("ROLLBACK"); console.log("dry run — rolled back; add --live to write"); return; }
    await query("COMMIT");
    console.log("committed");
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
