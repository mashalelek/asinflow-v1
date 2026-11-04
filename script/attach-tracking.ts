// Attach one queued tracking row to one or more POs by hand — the Unmatched
// queue's Attach (POST /api/tracking/:id/attach: source manual, so the sync
// never moves it), optionally with a line appended to the first PO's notes
// and its History row (2026-11-04). Several --order flags put the one number
// on each PO (server/tracking-attach.ts, migration 086; the shipped qty the
// email states is split across them, first PO first).
//
//   tsx script/attach-tracking.ts --row <po_tracking id> --order <AF order #> [--order <#> …] [--supplier <s>] [--note "<line>"] [--prod] [--live]
//   tsx script/attach-tracking.ts --row <id> --dismiss [--reason "<why>"] [--prod] [--live]   the queue's Dismiss
//
// Dry run by default: prints the row, the POs (with any qty split) and the note.
import "./env";
import pool from "../server/db";
import { appendPoNote } from "../server/tracking-replacement";
import { attachTrackingToPos } from "../server/tracking-attach";
import { gmailClient, emailTextFor } from "../server/gmail-client";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const args = (k: string) => process.argv.flatMap((a, i) => (a === k && process.argv[i + 1] ? [process.argv[i + 1]] : []));
async function main() {
  const live = process.argv.includes("--live");
  const rowId = Number(arg("--row")), orders = args("--order"), supplier = arg("--supplier"), note = arg("--note");
  const dismiss = process.argv.includes("--dismiss");
  if (!Number.isInteger(rowId) || (orders.length === 0 && !dismiss)) throw new Error("--row <id> and --order <#> or --dismiss required");
  const query = (sql: string, params?: any[]) => pool.query(sql, params) as any;
  const row = (await query(`SELECT id, carrier, tracking_number, status, match_reason, email_subject, gmail_message_id, shipped_at, supplier_guess, sender_domain FROM po_tracking WHERE id = $1`, [rowId])).rows[0];
  if (!row) throw new Error(`row ${rowId} not found`);
  const label = `${row.supplier_guess ?? row.sender_domain ?? "?"} ${row.shipped_at ? new Date(row.shipped_at).toISOString().slice(0, 10) : "?"} "${String(row.email_subject ?? "").slice(0, 70)}" (${row.carrier} ${row.tracking_number}, ${row.status}/${row.match_reason ?? "—"})`;
  if (dismiss) {
    const reason = arg("--reason") ?? null;
    console.log(`${live ? "LIVE" : "DRY RUN"} — dismiss ${label}${reason ? ` · reason "${reason}"` : ""}`);
    if (live) console.log((await query(`UPDATE po_tracking SET match_reason = 'dismissed', dismiss_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'unmatched' RETURNING id`, [rowId, reason])).rows.length ? "  dismissed" : "  NOT dismissed (no longer unmatched)");
    return;
  }
  if (row.status !== "unmatched") throw new Error(`not unmatched (${row.status})`);
  const poIds: string[] = [];
  for (const order of orders) {
    const pos = (await query(`SELECT id FROM purchase_orders WHERE order_id = $1${supplier ? " AND supplier = $2" : ""}`, supplier ? [order, supplier] : [order])).rows;
    if (pos.length !== 1) throw new Error(`--order ${order}: ${pos.length} POs`);
    poIds.push(String(pos[0].id));
  }
  const email = orders.length > 1 ? await emailTextFor(gmailClient())(String(row.gmail_message_id)).catch(() => null) : null;
  const plan = await attachTrackingToPos(query, rowId, poIds, { dryRun: !live, emailText: email?.text });
  console.log(`${live ? "LIVE" : "DRY RUN"} — ${label}${plan.shipped_qty != null ? ` · shipped qty ${plan.shipped_qty}` : ""}`);
  for (const p of plan.pos) console.log(`  → ${p.order_id}${p.qty != null ? ` qty ${p.qty}` : ""}${p.split ? " (split row)" : ""}`);
  if (note) console.log(`  note: ${note}`);
  if (live && note) console.log(await appendPoNote(query, poIds[0], note) ? "  note added (History row)" : "  note already there");
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
