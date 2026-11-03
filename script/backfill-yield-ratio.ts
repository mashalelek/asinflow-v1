// Backfill the exact line yield (migration 080, Maria 2026-11-02): every
// po_line_items row without retailer_units_per_product / asin_units_per_pack
// gets them where the ASIN row has units_per_pack and the stored 2-dp yield ×
// units_per_pack is within 0.02 of a whole number ≥ 1 (widened to the error a
// 2-dp yield can carry, 0.005 × pack — 1/15 is stored as 0.07 and 0.07 × 15 =
// 1.05; shared/yield.ts ratioFromStoredYield says which bound matched). Every
// other line goes to the gaps CSV and is left alone. Ordered (po_asins.qty) is
// rewritten only where the row agreed with its lines before (Σ qty × 2-dp
// yield = the stored Ordered) and the exact sum differs — a precision change,
// with a History row; a row that already disagreed with its lines (the yield
// review's shape B) is left for Maria. The stored yield column is not touched
// (history).
//   npm run backfill:yield-ratio -- [--prod] [--live] [--gaps <csv>] [--report <csv>]
// Dry run by default (counts + both CSVs, nothing written). `--prod` reads
// .env.production.local (script/env.ts).
import "./env";
import { Pool } from "pg";
import { writeFileSync } from "fs";
import { asinUnitsFromLines, lineRatio, ratioFromStoredYield, type YieldRatio } from "../shared/yield";
import { trueYield } from "../shared/po-form";
import { logEdits } from "../server/po-edit";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const live = process.argv.includes("--live");
const gapsPath = arg("--gaps") ?? "docs/yield-ratio-gaps-2026-11-02.csv";
const reportPath = arg("--report") ?? "docs/yield-ratio-ordered-before-after-2026-11-02.csv";
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const n2 = (v: unknown) => (v == null || v === "" ? null : Number(v));

interface Line { id: string; po_asin_id: string; position: number; product_name: string | null; qty_ordered: string | null; asin_qty_per_product: string | null; retailer_units_per_product: number | null; asin_units_per_pack: number | null; qty_canceled: string | null }
interface Row { pa_id: string; po_id: string; asin: string; sold_as: string | null; units_per_pack: number | null; qty: string; order_id: string; supplier: string; order_date: string; closed: boolean; imported: boolean; lines: Line[] }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const col = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'po_line_items' AND column_name = 'retailer_units_per_product'`)).rows.length;
    if (!col) throw new Error("migration 080 is not applied here (po_line_items.retailer_units_per_product is missing)");
    const rs = (await query(
      `SELECT pa.id AS pa_id, pa.po_id, pa.asin, pa.sold_as, pa.units_per_pack, pa.qty, p.order_id, p.supplier, p.order_date::text AS order_date, (p.closed_at IS NOT NULL) AS closed, (p.cost_formula_version IS NULL) AS imported,
              l.id AS line_id, l.position, l.product_name, l.qty_ordered, l.asin_qty_per_product, l.retailer_units_per_product, l.asin_units_per_pack, l.qty_canceled
         FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id LEFT JOIN po_line_items l ON l.po_asin_id = pa.id
        ORDER BY p.order_date, p.order_id, pa.asin, l.position, l.id`,
    )).rows as any[];
    const rows = new Map<string, Row>();
    for (const r of rs) {
      let row = rows.get(String(r.pa_id));
      if (!row) { row = { pa_id: String(r.pa_id), po_id: String(r.po_id), asin: r.asin, sold_as: r.sold_as, units_per_pack: r.units_per_pack == null ? null : Number(r.units_per_pack), qty: r.qty, order_id: r.order_id, supplier: r.supplier, order_date: String(r.order_date).slice(0, 10), closed: r.closed, imported: r.imported, lines: [] }; rows.set(row.pa_id, row); }
      if (r.line_id != null) row.lines.push({ id: String(r.line_id), po_asin_id: row.pa_id, position: r.position, product_name: r.product_name, qty_ordered: r.qty_ordered, asin_qty_per_product: r.asin_qty_per_product, retailer_units_per_product: r.retailer_units_per_product == null ? null : Number(r.retailer_units_per_product), asin_units_per_pack: r.asin_units_per_pack == null ? null : Number(r.asin_units_per_pack), qty_canceled: r.qty_canceled });
    }
    const c = { lines: 0, already: 0, set: 0, setBy2dp: 0, gaps: 0, rows: rows.size, rowsConsistent: 0, rowsPrecision: 0, rowsLeftMismatch: 0, rowsLeftGap: 0, rowsNoLines: 0, unitsBefore: 0, unitsAfter: 0 };
    const gapRows: string[] = ["po_number,supplier,asin,order_date,status,sold_as,units_per_pack,line_position,product,qty_ordered,yield,reason,k"];
    const report: string[] = ["po_number,supplier,asin,order_date,status,imported,sold_as,units_per_pack,lines,lines_with_ratio,lines_set_now,gaps,ordered_before,ordered_after,delta,lines_before_2dp,action"];
    const lineUpdates: Array<{ id: string; r: YieldRatio }> = [];
    const qtyUpdates: Array<{ row: Row; before: number; after: number }> = [];
    for (const row of Array.from(rows.values())) {
      const soldAs = row.sold_as ?? "individual";
      const before = Number(row.qty) || 0;
      c.unitsBefore += before;
      if (row.lines.length === 0) { c.rowsNoLines++; c.unitsAfter += before; report.push([row.order_id, row.supplier, row.asin, row.order_date, row.closed ? "closed" : "open", row.imported ? "yes" : "no", soldAs, row.units_per_pack ?? "", 0, 0, 0, 0, before, before, 0, "", "no lines"].map(csv).join(",")); continue; }
      let setNow = 0, gaps = 0, withRatio = 0;
      const nextLines = row.lines.map((l) => {
        c.lines++;
        if (lineRatio(l)) { c.already++; withRatio++; return l; }
        const r = ratioFromStoredYield(l.asin_qty_per_product, row.units_per_pack);
        if (r) { c.set++; if (r.fit === "2dp") c.setBy2dp++; setNow++; withRatio++; lineUpdates.push({ id: l.id, r }); return { ...l, retailer_units_per_product: r.retailer, asin_units_per_pack: r.asinUnits }; }
        c.gaps++; gaps++;
        const y = n2(l.asin_qty_per_product), k = y != null && row.units_per_pack != null ? Math.round(y * row.units_per_pack * 1000) / 1000 : null;
        const reason = row.units_per_pack == null ? "no units_per_pack on the ASIN row" : y == null ? "yield NULL" : !(y > 0) ? "yield 0" : k != null && Math.round(k) < 1 ? "yield × pack rounds to 0" : "yield × pack not within 0.02 (or the 2-dp bound) of a whole number";
        gapRows.push([row.order_id, row.supplier, row.asin, row.order_date, row.closed ? "closed" : "open", soldAs, row.units_per_pack ?? "", l.position, l.product_name ?? "", l.qty_ordered ?? "", l.asin_qty_per_product ?? "", reason, k ?? ""].map(csv).join(","));
        return l;
      });
      // What the lines said before (every line through its 2-dp yield) and what they say now (ratios where set).
      const legacy = asinUnitsFromLines(row.lines.map((l) => ({ qty_ordered: l.qty_ordered, asin_qty_per_product: l.asin_qty_per_product })), soldAs, trueYield).qty;
      const after = asinUnitsFromLines(nextLines, soldAs, trueYield).qty;
      const consistent = Math.abs(legacy - before) <= 0.005;
      let action: string, stored = before;
      if (consistent) {
        c.rowsConsistent++;
        if (Math.abs(after - before) > 0.005) { c.rowsPrecision++; stored = after; qtyUpdates.push({ row, before, after }); action = "precision: Ordered rewritten"; }
        else action = gaps ? "unchanged (gap lines keep their yield)" : "unchanged";
      } else { action = `left: lines ≠ Ordered before (lines said ${legacy})`; if (gaps) { c.rowsLeftGap++; action += ", gaps"; } else c.rowsLeftMismatch++; }
      c.unitsAfter += stored;
      report.push([row.order_id, row.supplier, row.asin, row.order_date, row.closed ? "closed" : "open", row.imported ? "yes" : "no", soldAs, row.units_per_pack ?? "", row.lines.length, withRatio, setNow, gaps, before, stored, Math.round((stored - before) * 100) / 100, legacy, action].map(csv).join(","));
    }
    writeFileSync(gapsPath, gapRows.join("\n") + "\n");
    writeFileSync(reportPath, report.join("\n") + "\n");
    console.log(JSON.stringify({ mode: live ? "LIVE" : "dry run", ...c, unitsBefore: Math.round(c.unitsBefore * 100) / 100, unitsAfter: Math.round(c.unitsAfter * 100) / 100, line_updates: lineUpdates.length, qty_updates: qtyUpdates.length, gaps_csv: gapsPath, report_csv: reportPath }, null, 1));
    for (const q of qtyUpdates) console.log(`  precision: ${q.row.supplier} ${q.row.order_id} ${q.row.asin} Ordered ${q.before} → ${q.after}`);
    if (!live) { console.log("dry run — nothing written; add --live to write"); return; }
    await query("BEGIN");
    for (const u of lineUpdates) await query(`UPDATE po_line_items SET retailer_units_per_product = $2, asin_units_per_pack = $3 WHERE id = $1 AND retailer_units_per_product IS NULL AND asin_units_per_pack IS NULL`, [u.id, u.r.retailer, u.r.asinUnits]);
    for (const q of qtyUpdates) {
      await query(`UPDATE po_asins SET qty = $2 WHERE id = $1`, [q.row.pa_id, q.after]);
      await logEdits(query, q.row.po_id, null, "asin", q.row.pa_id, [{ field: "qty (yield ratio backfill)", old: String(q.before), new: String(q.after) }]);
    }
    await query("COMMIT");
    const left = (await query(`SELECT COUNT(*)::int AS n FROM po_line_items WHERE retailer_units_per_product IS NULL`)).rows[0].n;
    console.log(`committed: ${lineUpdates.length} lines set, ${qtyUpdates.length} Ordered rewritten; lines still without a ratio: ${left}`);
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
