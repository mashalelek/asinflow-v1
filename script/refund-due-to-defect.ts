// Turn a refund-due row into a supplier defect linked to it (SPEC §22 "Supplier defects", migration 094).
// Maria 2026-11-05: the stopgap on Walmart 200015557295492 line 1 (Caress B006T0U4R4) — 1 single missing,
// $5.97 due — becomes the first defect record: missing, qty 1, $5.97, linked to that due row.
//   tsx script/refund-due-to-defect.ts --order 200015557295492 --asin B006T0U4R4 [--line 1] --kind missing [--prod] [--live]
// The refund row is the one due row on that line; the defect takes its qty, amount and note. Dry run by default.
// Nothing else changes: the manual "Missing / damaged from supplier" badge stays until Maria says otherwise.
import "./env";
import { Pool } from "pg";
import { addDefect, loadDefects } from "../server/po-defects";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), asin = arg("--asin"), lineNo = Number(arg("--line") ?? "1"), kind = arg("--kind") ?? "missing";
const live = process.argv.includes("--live");
if (!order || !asin || !(lineNo >= 1)) { console.error("usage: --order <order id> --asin <asin> [--line <n>] [--kind missing|damaged|wrong_item] [--prod] [--live]"); process.exit(2); }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const pos = (await query(`SELECT id, supplier, order_id FROM purchase_orders WHERE order_id = $1`, [order])).rows;
    if (pos.length !== 1) throw new Error(`${pos.length} POs match order ${order}`);
    const po = pos[0];
    const lines = (await query(
      `SELECT li.id FROM po_line_items li JOIN po_asins pa ON pa.id = li.po_asin_id WHERE li.po_id = $1 AND pa.asin = $2 ORDER BY li.position, li.id`, [po.id, asin])).rows;
    const line = lines[lineNo - 1];
    if (!line) throw new Error(`${asin} has ${lines.length} line(s) on ${order}; no line ${lineNo}`);
    const dues = (await query(`SELECT id, qty, amount, note FROM po_line_refunds WHERE po_line_item_id = $1 AND status = 'due' ORDER BY id`, [line.id])).rows;
    if (dues.length !== 1) throw new Error(`${dues.length} refund-due rows on ${asin} line ${lineNo} — expected exactly one`);
    const due = dues[0];
    const existing = await loadDefects(query, { poId: String(po.id) });
    console.log(`${po.supplier} ${po.order_id}, ${asin} line ${lineNo}: refund due qty ${due.qty}, $${due.amount}, note ${JSON.stringify(due.note)}`);
    console.log(`  supplier defects on the PO now: ${existing.length}`);
    if (existing.some((d) => d.refunds.some((r) => r.id === Number(due.id)))) { console.log("already a defect linked to that row — nothing to do"); return; }
    if (due.qty == null) throw new Error("the due row has no qty — give the defect one by hand");
    console.log(`  add: supplier defect ${kind}, qty ${Number(due.qty)}, $${Number(due.amount).toFixed(2)}, linked to that refund-due row`);
    if (!live) { console.log("dry run — add --live to write"); return; }
    await query("BEGIN");
    await addDefect(query, String(po.id), { po_line_item_id: String(line.id), kind, qty: Number(due.qty), amount: due.amount, note: due.note, refund_ids: [Number(due.id)] }, null);
    await query("COMMIT");
    const [d] = (await loadDefects(query, { poId: String(po.id) })).filter((x) => x.refunds.some((r) => r.id === Number(due.id)));
    const log = (await query(`SELECT field, new_value FROM po_edit_log WHERE po_id = $1 AND field LIKE 'supplier defect%' ORDER BY id`, [po.id])).rows;
    console.log(`written: ${d.kind} qty ${d.qty}, $${d.amount}, ${d.status}, owed $${d.owed}, uncovered $${d.uncovered}, refunds ${JSON.stringify(d.refunds.map((r) => `${r.amount} ${r.status}`))}`);
    console.log(`History: ${JSON.stringify(log)}`);
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
