// Edit one PO header field with a History row (po_edit_log) — the way the PO
// editor does it (editPoHeader, HEADER_FIELDS in server/po-edit.ts: the same
// parser, the same normalization). Maria 2026-11-04: Adventure Challenge
// ships PO 18936582013059 as #3029684 — store it as an alternate order #
// (migration 086) so every email matcher finds the PO.
//   tsx script/edit-po-header.ts --order 18936582013059 [--supplier <s>] --field alt_order_ids --value "3029684" [--prod] [--live]
// A cost-relevant field on a form-saved PO recomputes its costs, as the
// route does. Dry run by default (rolled back).
import "./env";
import { Pool } from "pg";
import { editPoHeader, COST_RELEVANT_FIELDS } from "../server/po-edit";
import { recomputePoCosts } from "../server/po-costs";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), supplier = arg("--supplier"), field = arg("--field"), value = arg("--value"), live = process.argv.includes("--live");
if (!order || !field || value == null) { console.error("usage: --order <order id> [--supplier <s>] --field <header field> --value <v> [--prod] [--live]"); process.exit(2); }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const pos = (await query(`SELECT id, supplier, order_id FROM purchase_orders WHERE order_id = $1${supplier ? " AND supplier = $2" : ""}`, supplier ? [order, supplier] : [order])).rows;
    if (pos.length !== 1) throw new Error(`${pos.length} POs match order ${order}${supplier ? ` (${supplier})` : ""}`);
    const po = pos[0];
    await query("BEGIN");
    const r = await editPoHeader(query, String(po.id), { [field]: value }, null);
    const rc = r.changes.some((c) => COST_RELEVANT_FIELDS.has(c.field)) ? await recomputePoCosts(query, String(po.id), null) : null;
    console.log(`${live ? "LIVE" : "DRY RUN"} — ${po.supplier} ${po.order_id}: ${r.changes.map((c) => `${c.field} ${c.old ?? "∅"} → ${c.new ?? "∅"}`).join("; ") || "no change"}${r.warning ? ` (${r.warning})` : ""}${rc ? `; costs: ${rc.skipped ?? `${rc.changed} change(s)`}` : ""}`);
    if (!live) { await query("ROLLBACK"); console.log("dry run — rolled back; add --live to write"); return; }
    await query("COMMIT");
    console.log("committed");
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
