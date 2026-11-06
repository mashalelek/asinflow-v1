// Sheet-imported lines whose stored 2-dp yield is a rounding of their pack sizes' exact ratio (Maria 2026-11-06):
// michaels.com 9800109062072825 B07N6V47HC — 60 ordered, multi-pack ×3, yield 0.33 → 19.8 instead of 20.
// A line with no pack integers on an ASIN row whose pack is known (individual / multi-pack) takes
// retailer = round(yield × pack), asin = pack when |yield − retailer ÷ pack| ≤ 0.005 (retailerUnitsAtPack) —
// the same value, written exactly, with a History row; the row's Ordered is then the exact Σ, logged when it moves.
// A row is changed only when every such line fits and its stored Ordered is either already the exact value or the
// 2-dp product Σ qty × stored yield (the rounding itself); anything else goes on the list untouched. Stored costs
// (COGS / Sourcing / Paid) are never written — the report says what a per-unit cost would become at the new Ordered.
//   tsx script/fix-yield-exact.ts [--prod] [--live] [--out <dir>]
import "./env";
import { Pool } from "pg";
import { writeFileSync } from "fs";
import { join } from "path";
import { retailerUnitsAtPack } from "../shared/yield";
import { logEdits, asinQtyFromLines } from "../server/po-edit";

const live = process.argv.includes("--live");
const outDir = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : "Claude outputs"; })();
const csv = (rows: Array<Record<string, unknown>>) => rows.length === 0 ? "" : [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map((v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(","))].join("\n") + "\n";
const r2 = (n: number) => Math.round(n * 100) / 100;

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const lines = (await query(
      `SELECT l.id, l.po_asin_id, l.product_name, l.qty_ordered, l.asin_qty_per_product, l.retailer_units_per_product, l.asin_units_per_pack,
              pa.asin, pa.sold_as, pa.units_per_pack, pa.qty, pa.cost_per_unit, pa.sourcing_cost, pa.paid_cost,
              p.id AS po_id, p.supplier, p.order_id, p.cost_formula_version, p.closed_at IS NOT NULL AS closed
         FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
        WHERE l.retailer_units_per_product IS NULL OR l.asin_units_per_pack IS NULL
        ORDER BY p.order_date, p.order_id, pa.asin`,
    )).rows;
    const byRow = new Map<string, any[]>();
    for (const l of lines) { const a = byRow.get(l.po_asin_id) ?? []; a.push(l); byRow.set(l.po_asin_id, a); }
    const planned: Array<Record<string, unknown>> = [], listed: Array<Record<string, unknown>> = [];
    let unknownPackLines = 0, bundleLines = 0;
    const writes: Array<{ rowId: string; poId: string; lines: Array<{ id: string; r: number; pack: number }> }> = [];
    for (const [rowId, ls] of Array.from(byRow)) {
      const h = ls[0];
      if (h.sold_as == null) { unknownPackLines += ls.length; continue; }
      if (h.sold_as === "bundle") { bundleLines += ls.length; continue; }
      const pack = h.sold_as === "individual" ? 1 : Number(h.units_per_pack);
      const base = { supplier: h.supplier, order_id: h.order_id, closed: h.closed, sheet_import: h.cost_formula_version == null, asin: h.asin, pack: `${h.sold_as} ×${pack}` };
      const fits = ls.map((l: any) => ({ l, r: retailerUnitsAtPack(l.asin_qty_per_product, pack) }));
      const misfit = fits.filter((f) => f.r == null);
      if (misfit.length) { for (const f of misfit) listed.push({ ...base, product: f.l.product_name, qty_ordered: f.l.qty_ordered, stored_yield: f.l.asin_qty_per_product, reason: `stored yield is no rounding of a whole number ÷ ${pack}` }); continue; }
      // Ordered: all the row's lines (those with integers as they are), the fitting ones at r / pack.
      const all = (await query(`SELECT id, qty_ordered, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product FROM po_line_items WHERE po_asin_id = $1`, [rowId])).rows;
      const fitBy = new Map(fits.map((f) => [String(f.l.id), f.r!]));
      const after = all.map((l: any) => fitBy.has(String(l.id)) ? { ...l, retailer_units_per_product: fitBy.get(String(l.id)), asin_units_per_pack: pack } : l);
      const exactQty = asinQtyFromLines(after, h.sold_as).qty;
      const naiveQty = r2(all.reduce((t: number, l: any) => t + (Number(l.qty_ordered) || 0) * (l.retailer_units_per_product != null && l.asin_units_per_pack != null ? Number(l.retailer_units_per_product) / Number(l.asin_units_per_pack) : Number(l.asin_qty_per_product) || 0), 0));
      const stored = Number(h.qty);
      if (Math.abs(stored - exactQty) > 1e-9 && Math.abs(stored - naiveQty) > 1e-9) {
        for (const f of fits) listed.push({ ...base, product: f.l.product_name, qty_ordered: f.l.qty_ordered, stored_yield: f.l.asin_qty_per_product, reason: `fits ${f.r}/${pack}, but stored Ordered ${stored} is neither the exact ${exactQty} nor the 2-dp ${naiveQty}` });
        continue;
      }
      const moves = Math.abs(stored - exactQty) > 1e-9;
      const per = (v: unknown) => v == null || !moves || !(exactQty > 0) ? "" : `${Number(v).toFixed(2)} → ${(Number(v) * stored / exactQty).toFixed(2)}`;
      for (const f of fits) {
        planned.push({ ...base, product: f.l.product_name, qty_ordered: f.l.qty_ordered, stored_yield: f.l.asin_qty_per_product, exact: `${f.r}/${pack}`, rounded: Math.abs(Number(f.l.asin_qty_per_product) - f.r! / pack) > 1e-9,
          ordered_before: stored, ordered_after: exactQty, cogs_if_recomputed: per(h.cost_per_unit), sourcing_if_recomputed: per(h.sourcing_cost), paid_if_recomputed: per(h.paid_cost) });
      }
      writes.push({ rowId, poId: String(h.po_id), lines: fits.map((f) => ({ id: String(f.l.id), r: f.r!, pack })) });
    }
    const movedRows = new Set(planned.filter((p) => p.ordered_before !== p.ordered_after).map((p) => `${p.order_id}|${p.asin}`));
    const roundedLines = planned.filter((p) => p.rounded).length;
    console.log(`lines without pack integers: ${lines.length}`);
    console.log(`  to write exactly: ${planned.length} line(s) on ${writes.length} ASIN row(s) — ${roundedLines} rounded (e.g. 0.33 → 1/3), ${planned.length - roundedLines} already exact (0.50 → 1/2)`);
    console.log(`  Ordered moves on ${movedRows.size} row(s):`);
    for (const k of Array.from(movedRows)) { const p = planned.find((x) => `${x.order_id}|${x.asin}` === k)!; console.log(`    ${p.supplier} ${p.order_id} ${p.asin} ${p.pack}: ${p.ordered_before} → ${p.ordered_after}${p.cogs_if_recomputed ? ` · COGS / unit if recomputed ${p.cogs_if_recomputed}` : ""}`); }
    console.log(`  listed, untouched: ${listed.length} line(s); pack not known: ${unknownPackLines}; bundles: ${bundleLines}`);
    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(join(outDir, `yield-exact-${live ? "live" : "dry-run"}-${stamp}.csv`), csv(planned));
    writeFileSync(join(outDir, `yield-exact-not-matching-${stamp}.csv`), csv(listed));
    console.log(`wrote ${join(outDir, `yield-exact-${live ? "live" : "dry-run"}-${stamp}.csv`)} and ${join(outDir, `yield-exact-not-matching-${stamp}.csv`)}`);
    if (!live) { console.log("dry run — add --live to write"); return; }
    await query("BEGIN");
    let qtyLogged = 0;
    for (const w of writes) {
      for (const l of w.lines) {
        await query(`UPDATE po_line_items SET retailer_units_per_product = $2, asin_units_per_pack = $3 WHERE id = $1`, [l.id, l.r, l.pack]);
        await logEdits(query, w.poId, null, "line", l.id, [{ field: "retailer_units_per_product (exact yield)", old: null, new: String(l.r) }, { field: "asin_units_per_pack (exact yield)", old: null, new: String(l.pack) }]);
      }
      const pa = (await query(`SELECT qty, sold_as FROM po_asins WHERE id = $1`, [w.rowId])).rows[0];
      const all = (await query(`SELECT qty_ordered, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product FROM po_line_items WHERE po_asin_id = $1`, [w.rowId])).rows;
      const q = asinQtyFromLines(all, String(pa.sold_as)).qty;
      if (Math.abs(Number(pa.qty) - q) > 1e-9) {
        await query(`UPDATE po_asins SET qty = $2 WHERE id = $1`, [w.rowId, q]);
        await logEdits(query, w.poId, null, "asin", w.rowId, [{ field: "qty (exact yield)", old: String(pa.qty), new: String(q) }]);
        qtyLogged++;
      }
    }
    await query("COMMIT");
    console.log(`written: ${planned.length} line(s), Ordered moved on ${qtyLogged} row(s)`);
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
