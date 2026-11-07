// Add action items to one PO ASIN row with a History row (po_edit_log) — the
// way the ASIN editor does it (PATCH /api/pos/asin-rows/:id/action-items →
// writeLineItems: every product line of the row, the same vocabulary check).
// Items already open stay; nothing is removed. Maria 2026-11-07: the havalon
// PO's B00D79EODK line gets "Confirm refund / replacement".
//   tsx script/add-line-action-items.ts --order no_poid_at_checkout --supplier havalon.com --asin B00D79EODK --items "Confirm refund / replacement" [--prod] [--live]
// Adding an item never closes a PO, so the auto-close rule is not re-run.
// Dry run by default (rolled back).
import "./env";
import { Pool } from "pg";
import { loadOpenManualItems, writeLineItems } from "../server/line-action-items";
import { normalizeActionItems } from "../server/po-status-map";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), supplier = arg("--supplier"), asin = arg("--asin"), items = arg("--items"), live = process.argv.includes("--live");
if (!order || !asin || !items) { console.error('usage: --order <order id> [--supplier <s>] --asin <ASIN> --items "<item>[, <item>]" [--prod] [--live]'); process.exit(2); }

(async () => {
  const v = normalizeActionItems(items.split(",").map((s) => s.trim()).filter(Boolean));
  if (!v.ok) throw new Error(v.error);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const rows = (await query(
      `SELECT a.id, a.po_id, p.supplier, p.order_id FROM po_asins a JOIN purchase_orders p ON p.id = a.po_id
        WHERE p.order_id = $1 AND a.asin = $2${supplier ? " AND p.supplier = $3" : ""}`,
      supplier ? [order, asin, supplier] : [order, asin],
    )).rows;
    if (rows.length !== 1) throw new Error(`${rows.length} ASIN rows match ${asin} on order ${order}${supplier ? ` (${supplier})` : ""}`);
    const row = rows[0];
    const lines = (await query(`SELECT id FROM po_line_items WHERE po_asin_id = $1`, [row.id])).rows.map((l: any) => String(l.id));
    if (lines.length === 0) throw new Error("this ASIN row has no product lines to carry action items");
    await query("BEGIN");
    const current = await loadOpenManualItems(query, lines);
    const union = Array.from(new Set(Array.from(current.values()).flat().concat(v.value)));
    const changed = await writeLineItems(query, String(row.po_id), lines, union, null);
    console.log(`${live ? "LIVE" : "DRY RUN"} — ${row.supplier} ${row.order_id} ${asin}: ${changed.length} of ${lines.length} line(s) changed → ${union.join(", ")}`);
    if (!live) { await query("ROLLBACK"); console.log("dry run — rolled back; add --live to write"); return; }
    await query("COMMIT");
    console.log("committed");
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
