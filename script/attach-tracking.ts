// Attach one queued tracking row to a PO by hand — the Unmatched queue's
// Attach (POST /api/tracking/:id/attach: source manual, so the sync never
// moves it), optionally with a line appended to the PO's notes and its
// History row (2026-11-04: rows whose order # is the same order under
// another number — a shipment / receipt # — or that print none).
//
//   tsx script/attach-tracking.ts --row <po_tracking id> --order <AF order #> [--supplier <s>] [--note "<line>"] [--prod] [--live]
//   tsx script/attach-tracking.ts --row <id> --dismiss [--prod] [--live]   the queue's Dismiss (a row that is not a shipment
//                                                                          of ours, e.g. a reference # misread as tracking)
//
// Dry run by default: prints the row, the PO and the note.
import "./env";
import pool from "../server/db";
import { appendPoNote } from "../server/tracking-replacement";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
async function main() {
  const live = process.argv.includes("--live");
  const rowId = Number(arg("--row")), order = arg("--order"), supplier = arg("--supplier"), note = arg("--note");
  const dismiss = process.argv.includes("--dismiss");
  if (!Number.isInteger(rowId) || (!order && !dismiss)) throw new Error("--row <id> and --order <#> or --dismiss required");
  const query = (sql: string, params?: any[]) => pool.query(sql, params) as any;
  const row = (await query(`SELECT id, carrier, tracking_number, status, match_reason, email_subject FROM po_tracking WHERE id = $1`, [rowId])).rows[0];
  if (!row) throw new Error(`row ${rowId} not found`);
  if (dismiss) {
    console.log(`${live ? "LIVE" : "DRY RUN"} — dismiss #${row.id} ${row.carrier} ${row.tracking_number} (${row.status}/${row.match_reason ?? "—"}, "${String(row.email_subject ?? "").slice(0, 60)}")`);
    if (live) console.log((await query(`UPDATE po_tracking SET match_reason = 'dismissed', updated_at = NOW() WHERE id = $1 AND status = 'unmatched' RETURNING id`, [rowId])).rows.length ? "  dismissed" : "  NOT dismissed (no longer unmatched)");
    return;
  }
  if (!order) return;
  if (String(row.tracking_number).startsWith("email:")) throw new Error(`row ${rowId} is a placeholder`);
  const pos = (await query(`SELECT id, supplier, order_id, order_date::text AS d FROM purchase_orders WHERE order_id = $1${supplier ? " AND supplier = $2" : ""}`, supplier ? [order, supplier] : [order])).rows;
  if (pos.length !== 1) throw new Error(`--order ${order}: ${pos.length} POs`);
  const po = pos[0];
  console.log(`${live ? "LIVE" : "DRY RUN"} — #${row.id} ${row.carrier} ${row.tracking_number} (${row.status}/${row.match_reason ?? "—"}, "${String(row.email_subject ?? "").slice(0, 60)}") → ${po.supplier} ${po.order_id} (${po.d})${note ? `\n  note: ${note}` : ""}`);
  if (!live) return;
  const r = await query(
    `UPDATE po_tracking SET po_id = $2, supplier_guess = $3, status = 'matched', match_reason = NULL, source = 'manual', updated_at = NOW()
      WHERE id = $1 AND status = 'unmatched' RETURNING id`, [rowId, po.id, po.supplier]);
  console.log(r.rows.length ? "  attached" : "  NOT attached (no longer unmatched)");
  if (r.rows.length && note) console.log(await appendPoNote(query, String(po.id), note) ? "  note added (History row)" : "  note already there");
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
