// Set the yield (asin_qty_per_product) of one ASIN row's product lines, optionally
// its pack size, with History rows (po_edit_log) — the way the PO editor does it
// (editLine / editAsinRow → recomputeAsinQty → evaluateAutoClose, then the route's
// cost recompute, which leaves a sheet-imported PO alone).
// Maria 2026-11-02: PO 6433257 (opentip.com) B07J9QQDSS was imported with yield 1 →
// Ordered 100; the ASIN is a 2-pack, so 100 retailer units = 50 ASIN units (yield 0.5).
//   tsx script/fix-po-yield.ts --order 6433257 --asin B07J9QQDSS --yield 0.5 [--units-per-pack 2] [--prod] [--live]
// Dry run by default: runs the whole edit in a transaction, prints before / after and
// rolls back. `--prod` reads .env.production.local (script/env.ts).
import "./env";
import { Pool } from "pg";
import { editAsinRow, editLine, COST_RELEVANT_FIELDS, type EditResult } from "../server/po-edit";
import { recomputePoCosts } from "../server/po-costs";
import { loadAsinPipeline } from "../server/asin-po-pipeline";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), asin = (arg("--asin") ?? "").toUpperCase(), yld = arg("--yield"), upp = arg("--units-per-pack"), live = process.argv.includes("--live");
if (!order || !/^B0[A-Z0-9]{8}$/.test(asin) || !yld || !/^\d+(\.\d{1,4})?$/.test(yld) || Number(yld) <= 0 || (upp != null && !/^[1-9]\d*$/.test(upp))) {
  console.error("usage: --order <order id> --asin <ASIN> --yield <n> [--units-per-pack <n>] [--prod] [--live]");
  process.exit(2);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  const snapshot = async (poId: string, paId: string) => {
    const po = (await query(`SELECT closed_at, closed_by, cost_formula_version FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
    const row = (await query(`SELECT sold_as, units_per_pack, qty, qty_shipped_fba, qty_at_prep, received_velocity, cost_per_unit FROM po_asins WHERE id = $1`, [paId])).rows[0];
    const lines = (await query(`SELECT id, product_name, qty_ordered, asin_qty_per_product FROM po_line_items WHERE po_asin_id = $1 ORDER BY position`, [paId])).rows;
    const pipe = (await loadAsinPipeline(query, [asin])).get(asin);
    return { po, row, lines, onOrder: pipe?.on_order ?? 0, openPos: pipe?.open_po_count ?? 0 };
  };
  const show = (label: string, s: Awaited<ReturnType<typeof snapshot>>) => {
    console.log(`${label}: PO ${s.po.closed_at ? `closed (${s.po.closed_by}, ${new Date(s.po.closed_at).toISOString().slice(0, 10)})` : "open"}, ${s.po.cost_formula_version == null ? "sheet-imported" : "formula v" + s.po.cost_formula_version}`);
    console.log(`  ASIN row: sold_as ${s.row.sold_as} × ${s.row.units_per_pack}, Ordered ${s.row.qty}, Shipped FBA ${s.row.qty_shipped_fba}, At Prep ${s.row.qty_at_prep}, Received by Velocity ${s.row.received_velocity}, cost/unit ${s.row.cost_per_unit}`);
    for (const l of s.lines) console.log(`  line: ${l.product_name} — qty ${l.qty_ordered} × yield ${l.asin_qty_per_product}`);
    console.log(`  On Order for ${asin} (all POs): ${s.onOrder}; open POs ${s.openPos}`);
  };
  try {
    const pos = (await query(`SELECT id, supplier, order_id, ships_to FROM purchase_orders WHERE order_id = $1`, [order])).rows;
    if (pos.length !== 1) throw new Error(`${pos.length} POs match order ${order}`);
    const po = pos[0];
    const pa = (await query(`SELECT id FROM po_asins WHERE po_id = $1 AND asin = $2`, [po.id, asin])).rows[0];
    if (!pa) throw new Error(`${po.supplier} ${po.order_id} has no ASIN row for ${asin}`);
    const paId = String(pa.id);
    console.log(`${po.supplier} ${po.order_id} (${po.ships_to}), ASIN row ${paId}`);
    const before = await snapshot(String(po.id), paId);
    show("before", before);

    await query("BEGIN");
    const results: EditResult[] = [];
    if (upp != null) results.push(await editAsinRow(query, paId, { sold_as: Number(upp) === 1 ? "individual" : "multi-pack", units_per_pack: upp }, null));
    for (const l of before.lines) results.push(await editLine(query, String(l.id), { asin_qty_per_product: yld }, null));
    const changes = results.flatMap((r) => r.changes);
    const rc = changes.some((c) => COST_RELEVANT_FIELDS.has(c.field)) ? await recomputePoCosts(query, String(po.id), null) : null;
    const after = await snapshot(String(po.id), paId);
    const log = (await query(`SELECT entity, field, old_value, new_value FROM po_edit_log WHERE po_id = $1 AND entity_id IN ($2, ${before.lines.map((_: any, i: number) => `$${i + 3}`).join(", ")}) ORDER BY at DESC, id DESC LIMIT ${changes.length + 3}`, [po.id, paId, ...before.lines.map((l: any) => String(l.id))])).rows;
    show(live ? "after" : "after (dry run, rolled back)", after);
    console.log(`  changes: ${changes.length === 0 ? "none" : changes.map((c) => `${c.field} ${c.old ?? "∅"} → ${c.new ?? "∅"}`).join("; ")}`);
    console.log(`  auto-close: ${results.map((r) => r.close.changed ?? (r.close.closed ? "stays closed" : "stays open")).join(", ") || "n/a"}`);
    console.log(`  cost recompute: ${rc == null ? "not triggered" : rc.skipped ? `skipped (${rc.skipped} PO — stored COGS untouched)` : `${rc.changed} change(s)`}`);
    console.log(`  History rows: ${JSON.stringify(log)}`);
    if (!live) { await query("ROLLBACK"); console.log("dry run — rolled back; add --live to write"); return; }
    await query("COMMIT");
    console.log("committed");
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
