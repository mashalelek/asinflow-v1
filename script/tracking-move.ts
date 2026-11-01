// Move a tracking row to another PO — the Move to PO… route's write, from a
// script (SPEC §26 §10; the Macy's swap, Maria 2026-10-22).
//   npm run tracking:move -- --tracking <number> --to-order <order_id> --supplier <supplier>          # report only
//   npm run tracking:move -- --tracking <number> --to-order <order_id> --supplier <supplier> --live   # write
// Sets reassigned_from_po_id / reassigned_at, source = 'manual' (the sync never
// moves it back), status = matched. Does NOT push — the push runs separately.
// Talks to DATABASE_URL directly.
import "./env";
import pool from "../server/db";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<number> {
  const tn = arg("tracking")?.trim().toUpperCase(), order = arg("to-order")?.trim(), supplier = arg("supplier")?.trim();
  if (!tn || !order || !supplier) { console.error("--tracking, --to-order and --supplier are required"); return 1; }
  const rows = (await pool.query(`SELECT t.id, t.carrier, t.status, t.source, p.order_id AS on_po FROM po_tracking t LEFT JOIN purchase_orders p ON p.id = t.po_id WHERE t.tracking_number = $1`, [tn])).rows;
  if (rows.length !== 1) { console.error(`expected one row for ${tn}, found ${rows.length}`); return 2; }
  const pos = (await pool.query(`SELECT id FROM purchase_orders WHERE supplier = $1 AND order_id = $2`, [supplier, order])).rows;
  if (pos.length !== 1) { console.error(`expected one PO ${supplier} ${order}, found ${pos.length}`); return 2; }
  const r = rows[0];
  console.log(`${r.carrier} ${tn}: on PO ${r.on_po ?? "—"} (${r.status}, ${r.source}) → ${supplier} ${order}`);
  if (!process.argv.includes("--live")) { console.log("no --live: nothing written"); return 0; }
  await pool.query(
    `UPDATE po_tracking SET reassigned_from_po_id = COALESCE(po_id, reassigned_from_po_id), reassigned_at = NOW(), source = 'manual',
            po_id = $2, supplier_guess = $3, status = 'matched', match_reason = NULL, review_reason = NULL, push_error = NULL,
            suppressed_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [r.id, pos[0].id, supplier],
  );
  console.log("moved");
  return 0;
}
main().then(async (c) => { await pool.end(); process.exit(c); }).catch(async (e) => { console.error(e?.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
