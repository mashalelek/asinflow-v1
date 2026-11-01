// One-time value migration: purchase_orders.status → action_items /
// closed_at / qty_canceled (patch docs/claude_spec-patch-po-expand-by-asin.md
// §6.4; pre-flight decisions 2–3, 2026-10-16).
//
//   npm run migrate:po-status            # DRY RUN: per-token counts + 10 samples, no writes
//   npm run migrate:po-status -- --live  # write (idempotent: only rows still unmapped change)
//
// Mapping (server/po-status-map.ts):
//   action-item strings  → action_items (display order)
//   Closed               → closed_at = COALESCE(closed_at, updated_at), closed_by = 'sheet'  (only where closed_at IS NULL)
//   Canceled             → po_line_items.qty_canceled = qty_ordered where qty_canceled IS NULL (PO-wide cancel)
//   Returned             → nothing (the sheet carries no quantity) — counted
//   Received / Received Partial → nothing (D6 / decision 2) — counted
//   Ordered              → nothing
//   anything else        → STOP, nothing written
// The old `status` column is left as is (D5); nothing reads it after this.
import "./env";
import pool from "../server/db";
import { mapSheetStatus } from "../server/po-status-map";

const LIVE = process.argv.includes("--live");

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
  const pos = (await pool.query(`SELECT id, order_id, supplier, status, action_items, closed_at, closed_by, updated_at FROM purchase_orders ORDER BY order_date, order_id`)).rows;
  const tokenCounts = new Map<string, number>();
  const unmapped = new Map<string, string[]>();
  let willSetActionItems = 0, willClose = 0, alreadyClosed = 0, canceledPos = 0, returnedPos = 0, receivedPos = 0, orderedOnly = 0, blank = 0;
  const samples: string[] = [];
  const plans: Array<{ id: string; actionItems: string[]; closed: boolean; canceled: boolean }> = [];

  for (const po of pos) {
    const m = mapSheetStatus(po.status);
    for (const t of m.tokens) tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    if (m.tokens.length === 0) blank++;
    for (const u of m.unmapped) unmapped.set(u, [...(unmapped.get(u) ?? []), `${po.supplier} ${po.order_id}`]);
    if (m.actionItems.length > 0) willSetActionItems++;
    if (m.closed) { if (po.closed_at) alreadyClosed++; else willClose++; }
    if (m.canceled) canceledPos++;
    if (m.returned) returnedPos++;
    if (m.received) receivedPos++;
    if (m.ordered && m.tokens.length === 1) orderedOnly++;
    plans.push({ id: po.id, actionItems: m.actionItems, closed: m.closed, canceled: m.canceled });
    if (samples.length < 10 && m.tokens.length > 0 && (m.actionItems.length > 0 || m.canceled || m.returned || m.received)) {
      samples.push(`${po.supplier} ${po.order_id}: "${po.status}" → action_items=${JSON.stringify(m.actionItems)} closed=${m.closed} canceled→qty_canceled=${m.canceled} returned(nothing)=${m.returned} received(nothing)=${m.received}`);
    }
  }

  // Line-level effect of "Canceled"
  const canceledIds = plans.filter((p) => p.canceled).map((p) => p.id);
  const lines = canceledIds.length === 0 ? { lines: 0, untracked: 0 } : (await pool.query(
    `SELECT COUNT(*)::int AS lines, COUNT(*) FILTER (WHERE qty_canceled IS NULL)::int AS untracked FROM po_line_items WHERE po_id = ANY($1::uuid[])`, [canceledIds],
  )).rows[0];

  console.log(`\n=== PO STATUS → ACTION ITEMS ${LIVE ? "LIVE" : "DRY RUN (no writes)"} — ${pos.length} POs ===\n`);
  console.log("Per-token counts (POs carrying the token):");
  for (const [t, n] of Array.from(tokenCounts.entries()).sort((a, b) => b[1] - a[1])) {
    const m = mapSheetStatus(t);
    const dest = m.actionItems.length ? `action_items` : m.closed ? "closed_at/closed_by='sheet'" : m.canceled ? "po_line_items.qty_canceled = qty_ordered" : m.returned ? "nothing (no qty in sheet)" : m.received ? "nothing (D6)" : m.ordered ? "nothing" : "UNMAPPED";
    console.log(`  ${String(n).padStart(4)}  ${t.padEnd(34)} → ${dest}`);
  }
  console.log(`\nPOs: blank status ${blank} · will set action_items ${willSetActionItems} · will close (sheet) ${willClose} · already closed ${alreadyClosed} · canceled ${canceledPos} (lines ${lines.lines}, of which untracked→set ${lines.untracked}) · returned left NULL ${returnedPos} · received/partial left NULL ${receivedPos} · ordered-only ${orderedOnly}`);
  console.log(`\nSamples (10):`); for (const s of samples) console.log(`  ${s}`);

  if (unmapped.size > 0) {
    console.log(`\nUNMAPPED VALUES — STOP, nothing written:`);
    for (const [u, where] of unmapped) console.log(`  "${u}" on ${where.length} PO(s): ${where.slice(0, 5).join(", ")}`);
    await pool.end(); process.exit(2);
  }
  if (!LIVE) { console.log(`\nDry run only. Re-run with --live to write.`); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let ai = 0, cl = 0, ln = 0;
    for (const p of plans) {
      if (p.actionItems.length > 0) {
        const r = await client.query(`UPDATE purchase_orders SET action_items = $2::text[], updated_at = NOW() WHERE id = $1 AND action_items IS DISTINCT FROM $2::text[]`, [p.id, p.actionItems]);
        ai += r.rowCount ?? 0;
      }
      if (p.closed) {
        const r = await client.query(`UPDATE purchase_orders SET closed_at = COALESCE(closed_at, updated_at, NOW()), closed_by = 'sheet' WHERE id = $1 AND closed_at IS NULL`, [p.id]);
        cl += r.rowCount ?? 0;
      }
    }
    if (canceledIds.length > 0) {
      const r = await client.query(`UPDATE po_line_items SET qty_canceled = qty_ordered WHERE po_id = ANY($1::uuid[]) AND qty_canceled IS NULL AND qty_ordered IS NOT NULL`, [canceledIds]);
      ln = r.rowCount ?? 0;
    }
    await client.query("COMMIT");
    console.log(`\nLIVE: action_items set on ${ai} PO(s); closed (sheet) ${cl} PO(s); qty_canceled set on ${ln} line(s).`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
