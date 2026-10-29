// Pack-size backfill (2026-10-29): every 2026 ASIN row whose Orders-sheet
// Col AX is blank was imported individual ×1. Reset each untouched one to
// NULL (not filled in) through the edit path (resetDefaultedPackSize:
// po_edit_log, user NULL); shipment sync A then fills it from Velocity, or it
// shows the derived "Pack size missing". A row already edited by hand, or
// not individual ×1, is left alone.
//
//   tsx script/backfill-pack-size.ts           # dry run: counts and the first rows
//   tsx script/backfill-pack-size.ts --live    # apply
//
// Needs GOOGLE_SHEET_ID / GOOGLE_CREDENTIALS_PATH (the Orders sheet) and
// DATABASE_URL. Then run script/sync-shipments.ts.
import "dotenv/config";
import pool from "../server/db";
import { readPoSheet, parsePoSheet } from "../server/po-sheet-sync";
import { resetDefaultedPackSize } from "../server/po-edit";

async function main() {
  const live = process.argv.includes("--live");
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set");
  const q = (sql: string, params?: any[]) => pool.query(sql, params);
  const { header, dataCells } = await readPoSheet(sheetId);
  const parsed = parsePoSheet(header, dataCells);

  const blank = parsed.pos.filter((po) => !po.historical).flatMap((po) => po.poAsins.filter((a) => a.soldAs === null).map((a) => ({ po, asin: a.asin })));
  const af = (await q(
    `SELECT pa.id, p.supplier, p.order_id, pa.asin, pa.sold_as, pa.units_per_pack,
            EXISTS (SELECT 1 FROM po_edit_log e WHERE e.entity = 'asin' AND e.entity_id = pa.id::text AND e.field IN ('sold_as', 'units_per_pack')) AS edited
       FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id`,
  )).rows;
  const afByKey = new Map<string, any>(af.map((r: any) => [`${r.supplier}\u0000${r.order_id}\u0000${r.asin}`, r]));

  const counts = { sheetBlank: blank.length, notInAf: 0, alreadyNull: 0, edited: 0, notDefault: 0, reset: 0 };
  const targets: any[] = [];
  for (const b of blank) {
    const r = afByKey.get(`${b.po.supplier}\u0000${b.po.orderId}\u0000${b.asin}`);
    if (!r) { counts.notInAf++; continue; }
    if (r.sold_as === null) { counts.alreadyNull++; continue; }
    if (r.edited) { counts.edited++; continue; }
    if (r.sold_as !== "individual" || Number(r.units_per_pack ?? 1) !== 1) { counts.notDefault++; continue; }
    targets.push(r);
  }
  console.log(`2026 sheet ASIN groups with a blank Col AX: ${counts.sheetBlank}`);
  console.log(`  not in AF ${counts.notInAf} · already NULL ${counts.alreadyNull} · edited by hand (kept) ${counts.edited} · not individual ×1 (kept) ${counts.notDefault}`);
  console.log(`  → reset to NULL: ${targets.length}`);
  for (const r of targets.slice(0, 10)) console.log(`    ${r.supplier} ${r.order_id} ${r.asin}`);
  if (!live) { console.log(`\nDry run — nothing written.`); return; }

  for (const r of targets) if ((await resetDefaultedPackSize(q as any, String(r.id), null)).reset) counts.reset++;
  console.log(`\n${counts.reset} row(s) reset. Next: tsx script/sync-shipments.ts`);
}

main()
  .catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; })
  .finally(() => pool.end());
