// One-off: put the Orders sheet's exact fractional quantities on the 2026 PO
// rows the integer columns rounded (migration 062, 2026-10-18).
//
// For every 2026 sheet PO already in AF, compares each quantity the importer
// stored — po_asins.qty (Col N), unreimbursed_loss_qty (Col V), and per line
// qty_ordered (L), qty_received (M), qty_returned (R), qty_canceled (= L on a
// canceled row) — with the sheet's exact value. A field is corrected ONLY
// when the sheet value is fractional AND AF still holds exactly the integer
// it was rounded to (Math.round, as the old importer did): AF owns POs, so a
// value edited in AF since import is never overwritten — it is reported.
// Every correction is logged in po_edit_log (user NULL, "re-import").
// Pre-2026 POs are only counted (out of scope).
//
//   tsx script/reimport-po-fractional-qty.ts           # dry run (default)
//   tsx script/reimport-po-fractional-qty.ts --live    # write, one transaction
// Idempotent: a second run finds nothing to change.
import "dotenv/config";
import pool from "../server/db";
import { readPoSheet, parsePoSheet, poKey } from "../server/po-sheet-sync";

const live = process.argv.includes("--live");
const frac = (x: number | null | undefined) => x != null && Math.abs(x - Math.round(x)) > 1e-9;
const same = (a: unknown, b: number) => a != null && Math.abs(Number(a) - b) < 1e-9;

async function main() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set");
  const { header, dataCells } = await readPoSheet(sheetId);
  const parsed = parsePoSheet(header, dataCells);
  const c = await pool.connect();
  const q = (s: string, p?: any[]) => c.query(s, p);
  type Fix = { table: "po_asins" | "po_line_items"; id: string; poId: string; entity: "asin" | "line"; field: string; from: number; to: number; label: string };
  const fixes: Fix[] = [];
  const editedInAf: string[] = [];
  let historyRows = 0;
  try {
    const pos = (await q(`SELECT id, supplier, order_id FROM purchase_orders`)).rows;
    const poByKey = new Map<string, string>(pos.map((r: any) => [poKey(r.supplier, r.order_id), String(r.id)]));
    for (const sp of parsed.pos) {
      const poId = poByKey.get(sp.key);
      if (!poId) continue;
      const anyFrac = sp.poAsins.some((a) => frac(a.qty) || frac(a.lossQty) || a.lines.some((l) => frac(l.qtyOrdered) || frac(l.qtyReceived) || frac(l.qtyReturned)));
      if (!anyFrac) continue;
      if (sp.historical) { historyRows++; continue; }
      const asinRows = (await q(`SELECT id, asin, qty, unreimbursed_loss_qty FROM po_asins WHERE po_id = $1`, [poId])).rows;
      for (const a of sp.poAsins) {
        const ar = asinRows.find((r: any) => String(r.asin) === a.asin);
        if (!ar) continue;
        const label = `${sp.supplier} ${sp.orderId} ${a.asin}`;
        const check = (table: Fix["table"], id: string, entity: Fix["entity"], field: string, stored: unknown, exact: number | null | undefined, l: string) => {
          if (!frac(exact)) return;
          const x = exact as number;
          if (same(stored, x)) return;                                         // already exact
          if (same(stored, Math.round(x))) fixes.push({ table, id, poId, entity, field, from: Number(stored), to: x, label: l });
          else editedInAf.push(`${l} ${field}: AF ${stored}, sheet ${x} — changed in AF since import, left alone`);
        };
        check("po_asins", String(ar.id), "asin", "qty", ar.qty, a.qty, label);
        check("po_asins", String(ar.id), "asin", "unreimbursed_loss_qty", ar.unreimbursed_loss_qty, a.lossQty, label);
        const lines = (await q(`SELECT id, position, qty_ordered, qty_received, qty_returned, qty_canceled FROM po_line_items WHERE po_asin_id = $1`, [ar.id])).rows;
        for (const sl of a.lines) {
          const lr = lines.find((r: any) => Number(r.position) === sl.position);
          if (!lr) continue;
          const ll = `${label} line ${sl.position}`;
          check("po_line_items", String(lr.id), "line", "qty_ordered", lr.qty_ordered, sl.qtyOrdered, ll);
          check("po_line_items", String(lr.id), "line", "qty_received", lr.qty_received, sl.qtyReceived, ll);
          if (!sl.qtyReturnedBlank) check("po_line_items", String(lr.id), "line", "qty_returned", lr.qty_returned, sl.qtyReturned, ll);
          if (sl.canceled) check("po_line_items", String(lr.id), "line", "qty_canceled", lr.qty_canceled, sl.qtyOrdered, ll);
        }
      }
    }
    console.log(`${live ? "LIVE" : "DRY RUN"}: ${fixes.length} field(s) to correct on ${new Set(fixes.map((f) => f.poId)).size} PO(s); ${editedInAf.length} left alone (edited in AF); pre-2026 POs with fractional sheet quantities (not touched): ${historyRows}`);
    for (const f of fixes) console.log(`  ${f.label} ${f.field}: ${f.from} → ${f.to}`);
    for (const e of editedInAf) console.log(`  SKIP ${e}`);
    if (!live || fixes.length === 0) return;
    await q("BEGIN");
    for (const f of fixes) {
      await q(`UPDATE ${f.table} SET ${f.field} = $2 WHERE id = $1`, [f.id, f.to]);
      await q(`INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value) VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [f.poId, f.entity, f.id, f.field, String(f.from), `${f.to} (re-import: exact sheet value, migration 062)`]);
    }
    await q("COMMIT");
    console.log(`wrote ${fixes.length} field(s)`);
  } catch (e) {
    if (live) await q("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
