// Set one PO product line's captured line total (migration 087) and recompute
// the PO's costs under the current rule, with History rows — as the PO editor
// would (editLine + recomputePoCosts). Maria 2026-11-04: acmetools.com
// 42838131 was saved with the line price 2.87 × 30; the line total is 79.70
// (already net of code DHDNYC), so COGS = (79.70 + 6.49 shipping) ÷ 10 = 8.62.
// The unit price becomes line total ÷ qty at full precision (6 dp).
//   tsx script/fix-po-line-total.ts --order 42838131 --sku 20350GOLD5C --line-total 79.70 [--prod] [--live]
// `--sku` picks the line by supplier SKU (normalized: dashes / spaces / case
// ignored); a PO with one line needs no --sku. A sheet-imported PO is refused
// (its costs are never recomputed). Dry run by default (rolled back).
import "./env";
import { Pool } from "pg";
import { editLine } from "../server/po-edit";
import { recomputePoCosts } from "../server/po-costs";
import { normPart } from "../server/asin-suggest";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), sku = arg("--sku"), lt = arg("--line-total"), live = process.argv.includes("--live");
if (!order || !lt || !/^\d+(\.\d{1,2})?$/.test(lt)) { console.error("usage: --order <order id> --line-total <amount> [--sku <supplier sku>] [--prod] [--live]"); process.exit(2); }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  const costs = async (poId: string) => (await query(`SELECT asin, qty, cost_per_unit, sourcing_cost, paid_cost, cogs_adjustment FROM po_asins WHERE po_id = $1 ORDER BY asin`, [poId])).rows
    .map((r: any) => `${r.asin} qty ${r.qty}: COGS ${r.cost_per_unit}, sourcing ${r.sourcing_cost}, paid ${r.paid_cost}, adjustment ${r.cogs_adjustment ?? "none"}`).join("; ");
  try {
    const pos = (await query(`SELECT id, supplier, order_id, cost_formula_version, subtotal, discount, tax, sh_donations, order_total FROM purchase_orders WHERE order_id = $1`, [order])).rows;
    if (pos.length !== 1) throw new Error(`${pos.length} POs match order ${order}`);
    const po = pos[0];
    if (po.cost_formula_version == null) throw new Error(`${po.supplier} ${po.order_id} is sheet-imported — its costs are never recomputed`);
    const lines = (await query(`SELECT id, product_name, supplier_sku, price, qty_ordered, line_total FROM po_line_items WHERE po_id = $1 ORDER BY position, id`, [po.id])).rows;
    const pick = sku ? lines.filter((l: any) => normPart(l.supplier_sku) === normPart(sku) || normPart(l.product_name).includes(normPart(sku))) : lines;
    if (pick.length !== 1) throw new Error(`${pick.length} lines match${sku ? ` SKU ${sku}` : ""} on ${po.supplier} ${po.order_id}`);
    const line = pick[0];
    const qty = Number(line.qty_ordered);
    const price = (Math.round((Number(lt) / qty) * 1e6) / 1e6).toFixed(6);
    console.log(`${po.supplier} ${po.order_id} (formula v${po.cost_formula_version}): subtotal ${po.subtotal}, discount ${po.discount}, tax ${po.tax}, shipping ${po.sh_donations}, total ${po.order_total}`);
    console.log(`line "${line.product_name}" ${line.supplier_sku ?? ""}: price ${line.price} × ${line.qty_ordered}, line total ${line.line_total ?? "none"} → price ${price}, line total ${Number(lt).toFixed(2)}`);
    console.log(`before: ${await costs(po.id)}`);
    await query("BEGIN");
    const e = await editLine(query, String(line.id), { line_total: Number(lt).toFixed(2), price }, null);
    const rc = await recomputePoCosts(query, String(po.id), null);
    console.log(`line changes: ${e.changes.map((c) => `${c.field} ${c.old ?? "∅"} → ${c.new ?? "∅"}`).join("; ") || "none"}; recompute: ${rc.changed} change(s)`);
    console.log(`${live ? "after" : "after (dry run, rolled back)"}: ${await costs(po.id)}`);
    const log = (await query(`SELECT entity, field, old_value, new_value FROM po_edit_log WHERE po_id = $1 AND at > NOW() - interval '1 minute' ORDER BY id`, [po.id])).rows;
    console.log(`History: ${log.map((r: any) => `${r.entity}.${r.field} ${r.old_value ?? "∅"} → ${r.new_value ?? "∅"}`).join("; ")}`);
    if (!live) { await query("ROLLBACK"); console.log("dry run — rolled back; add --live to write"); return; }
    await query("COMMIT");
    console.log("committed");
  } catch (err) { await query("ROLLBACK").catch(() => {}); throw err; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
