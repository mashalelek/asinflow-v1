// Add a refund-due row to one PO product line, with a History row — the way the Payments tab does it
// (addMoneyRow, status 'due'). Maria 2026-11-05: Walmart 200015557295492 line 1 (Caress B006T0U4R4)
// was delivered 1 single short; the stopgap until the supplier defect record exists.
//   tsx script/add-refund-due.ts --order 200015557295492 --asin B006T0U4R4 [--line 1] --qty 1 --amount 5.97 --note "…" [--prod] [--live]
// Dry run by default: prints the line and the row it would add. `--prod` reads .env.production.local (script/env.ts).
import "./env";
import { Pool } from "pg";
import { addMoneyRow } from "../server/po-money-edit";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), asin = arg("--asin"), lineNo = Number(arg("--line") ?? "1"), qty = arg("--qty"), amount = arg("--amount"), note = arg("--note") ?? null;
const live = process.argv.includes("--live");
if (!order || !asin || !qty || !amount || !/^\d+(\.\d{1,2})?$/.test(amount) || !(lineNo >= 1)) {
  console.error("usage: --order <order id> --asin <asin> [--line <n>] --qty <n> --amount <$> [--note <text>] [--prod] [--live]"); process.exit(2);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const pos = (await query(`SELECT id, supplier, order_id FROM purchase_orders WHERE order_id = $1`, [order])).rows;
    if (pos.length !== 1) throw new Error(`${pos.length} POs match order ${order}`);
    const po = pos[0];
    const lines = (await query(
      `SELECT li.id, li.qty_ordered, li.adjusted_product_cost FROM po_line_items li JOIN po_asins pa ON pa.id = li.po_asin_id
        WHERE li.po_id = $1 AND pa.asin = $2 ORDER BY li.position, li.id`, [po.id, asin])).rows;
    const line = lines[lineNo - 1];
    if (!line) throw new Error(`${asin} has ${lines.length} line(s) on ${order}; no line ${lineNo}`);
    const existing = (await query(`SELECT qty, amount, status, note FROM po_line_refunds WHERE po_line_item_id = $1`, [line.id])).rows;
    console.log(`${po.supplier} ${po.order_id}, ${asin} line ${lineNo}: qty ordered ${line.qty_ordered}, cost ${line.adjusted_product_cost}`);
    console.log(`  refund rows on the line now: ${existing.length ? JSON.stringify(existing) : "none"}`);
    console.log(`  add: refund due, qty ${qty}, $${Number(amount).toFixed(2)}, note ${JSON.stringify(note)}`);
    if (existing.some((r: any) => r.status === "due" && Number(r.amount) === Number(amount) && r.note === note)) { console.log("already there — nothing to add"); return; }
    if (!live) { console.log("dry run — add --live to write"); return; }
    await query("BEGIN");
    await addMoneyRow(query, "po_line_refunds", String(po.id), { po_line_item_id: String(line.id), qty, amount: Number(amount).toFixed(2), status: "due", note }, null);
    await query("COMMIT");
    const after = (await query(`SELECT qty, amount, status, source, note FROM po_line_refunds WHERE po_line_item_id = $1`, [line.id])).rows;
    const log = (await query(`SELECT field, new_value FROM po_edit_log WHERE po_id = $1 AND field = 'refund added' ORDER BY at DESC LIMIT 1`, [po.id])).rows;
    console.log(`written; refund rows on the line: ${JSON.stringify(after)}; History: ${JSON.stringify(log)}`);
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
