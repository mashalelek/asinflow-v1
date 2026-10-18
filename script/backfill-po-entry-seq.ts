// One-time backfill of purchase_orders.entry_seq for sheet-imported POs
// (migration 061; patch docs/claude_spec-patch-po-af-owned.md, decision
// 2026-10-18). Dry run by default; --live writes. Idempotent: only rows
// whose value differs change.
//
//   npx tsx script/backfill-po-entry-seq.ts          # dry run: counts + 10 samples
//   npx tsx script/backfill-po-entry-seq.ts --live
//
// entry_seq = total sheet data rows − the PO's FIRST sheet row index (the
// sheet runs newest-first, so a higher row is newer and gets a larger
// value). Keyed on (supplier, order_id) exactly as Sync POs groups rows.
import "dotenv/config";
import pool from "../server/db";
import { readPoSheet, poKey } from "../server/po-sheet-sync";
import { sheetEntrySeqByKey } from "../server/po-entry-seq";

const LIVE = process.argv.includes("--live");

async function main() {
  if (!process.env.GOOGLE_SHEET_ID) throw new Error("GOOGLE_SHEET_ID not set");
  const { dataCells } = await readPoSheet(process.env.GOOGLE_SHEET_ID);
  const seq = sheetEntrySeqByKey(dataCells);
  const pos = (await pool.query(`SELECT id, supplier, order_id, order_date::text AS d, entry_seq FROM purchase_orders`)).rows;
  const plan: Array<{ id: string; label: string; from: any; to: number }> = [];
  let notInSheet = 0;
  for (const p of pos) {
    const v = seq.get(poKey(p.supplier, p.order_id));
    if (v == null) { notInSheet++; continue; }
    if (p.entry_seq == null || Number(p.entry_seq) !== v) plan.push({ id: p.id, label: `${p.supplier} ${p.order_id} (${p.d})`, from: p.entry_seq, to: v });
  }
  console.log(`${LIVE ? "LIVE" : "DRY RUN"}: ${pos.length} POs; ${plan.length} to set; ${notInSheet} not in the sheet (left NULL)`);
  for (const x of plan.slice(0, 10)) console.log(`  ${x.label}: ${x.from ?? "NULL"} → ${x.to}`);
  if (LIVE && plan.length > 0) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const x of plan) await c.query(`UPDATE purchase_orders SET entry_seq = $2 WHERE id = $1`, [x.id, x.to]);
      await c.query("COMMIT");
      console.log(`wrote ${plan.length}`);
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }
  await pool.end();
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
