// Set a PO ASIN row's pack (sold as + units / pack) with History — the way the PO editor does it (editAsinRow):
// the row's lines keep their yield, and an ASIN with no pack on record takes it, its other PO rows with no pack
// following (setUnknownAsinPack). Maria 2026-11-06: walmart.com 200014473088890 B0BRT7R75H is individual ×1.
//   tsx script/fix-po-pack.ts --order 200014473088890 --asin B0BRT7R75H --sold-as individual [--units 1] [--prod] [--live]
// Dry run by default: runs the same edit inside a transaction and rolls it back, printing what it would write.
import "./env";
import { Pool } from "pg";
import { editAsinRow } from "../server/po-edit";
import { PACK_SIZE_MISSING_EXISTS_SQL } from "../server/po-action-items";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), asin = arg("--asin")?.toUpperCase(), soldAs = arg("--sold-as"), units = arg("--units"), live = process.argv.includes("--live");
if (!order || !asin || !soldAs || !["individual", "multi-pack"].includes(soldAs) || (soldAs === "multi-pack" && !/^\d+$/.test(units ?? ""))) {
  console.error("usage: --order <order id> --asin <ASIN> --sold-as individual|multi-pack [--units <n>] [--prod] [--live]"); process.exit(2);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  const state = async (poId: string) => {
    const row = (await query(`SELECT pa.sold_as, pa.units_per_pack, pa.qty FROM po_asins pa WHERE pa.po_id = $1 AND pa.asin = $2`, [poId, asin])).rows[0];
    const lines = (await query(`SELECT l.qty_ordered, l.retailer_units_per_product, l.asin_units_per_pack, l.asin_qty_per_product FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id WHERE pa.po_id = $1 AND pa.asin = $2`, [poId, asin])).rows;
    const missing = (await query(`SELECT ${PACK_SIZE_MISSING_EXISTS_SQL} AS m FROM purchase_orders p WHERE p.id = $1`, [poId])).rows[0].m;
    const rec = (await query(`SELECT sold_as, units_per_pack FROM asins WHERE asin = $1`, [asin])).rows[0];
    return `row ${row.sold_as ?? "—"} ×${row.units_per_pack ?? "?"}, Ordered ${row.qty}; lines ${lines.map((l: any) => `${l.qty_ordered} × ${l.retailer_units_per_product ?? "-"}/${l.asin_units_per_pack ?? "-"} (yield ${l.asin_qty_per_product})`).join("; ")}; "Pack size missing" ${missing ? "open" : "clear"}; ASIN record ${rec ? `${rec.sold_as ?? "—"} ×${rec.units_per_pack ?? "?"}` : "not in AF"}`;
  };
  try {
    const pos = (await query(`SELECT id, supplier, order_id FROM purchase_orders WHERE order_id = $1`, [order])).rows;
    if (pos.length !== 1) throw new Error(`${pos.length} POs match order ${order}`);
    const po = pos[0];
    const row = (await query(`SELECT id FROM po_asins WHERE po_id = $1 AND asin = $2`, [po.id, asin])).rows[0];
    if (!row) throw new Error(`${asin} is not on ${order}`);
    console.log(`${po.supplier} ${po.order_id} ${asin}`);
    console.log(`  before: ${await state(po.id)}`);
    await query("BEGIN");
    const res = await editAsinRow(query, String(row.id), soldAs === "individual" ? { sold_as: soldAs, units_per_pack: 1 } : { sold_as: soldAs, units_per_pack: Number(units) }, null);
    console.log(`  after:  ${await state(po.id)}`);
    console.log(`  History: ${res.changes.map((c) => `${c.field} ${c.old ?? "—"} → ${c.new ?? "—"}`).join(", ") || "no change"}`);
    if (res.asinPackSet) console.log(`  ASIN record set: ${JSON.stringify(res.asinPackSet)}`);
    if (!live) { await query("ROLLBACK"); console.log("dry run — rolled back; add --live to write"); return; }
    await query("COMMIT");
    console.log("written");
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
