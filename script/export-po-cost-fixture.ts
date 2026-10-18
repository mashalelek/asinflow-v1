// Regenerates shared/__fixtures__/po-cost-2026.json — the imported 2026
// non-bundle ASIN rows with the inputs the cost / unit prefill sees and the
// cost the sheet held (Col Y). Read-only. Run: tsx script/export-po-cost-fixture.ts
import "dotenv/config";
import { writeFileSync } from "fs";
import pool from "../server/db";
async function main() {
  const rows = (await pool.query(`
    SELECT p.supplier, p.order_id, p.order_date::text AS order_date, pa.asin, pa.qty::float AS qty, pa.cost_per_unit::float AS cost,
           p.subtotal::float AS subtotal, p.order_total::float AS order_total, p.weighted_gc_discount_pct::float AS gc_pct,
           p.tax::float AS tax, p.sh_donations::float AS sh, p.discount::float AS discount, p.cashback_pct::float AS cashback_pct,
           json_agg(json_build_object('price', l.price::float, 'qty', l.qty_ordered::float) ORDER BY l.position) AS lines
      FROM purchase_orders p JOIN po_asins pa ON pa.po_id = p.id JOIN po_line_items l ON l.po_asin_id = pa.id
     WHERE p.order_date >= '2026-01-01' AND p.source = 'sheet_import' AND pa.sold_as <> 'bundle'
       AND pa.cost_per_unit IS NOT NULL AND pa.qty > 0
     GROUP BY p.id, pa.id
    HAVING bool_and(l.price IS NOT NULL AND l.qty_ordered > 0)
     ORDER BY p.order_date, p.supplier, p.order_id, pa.asin`)).rows;
  writeFileSync("shared/__fixtures__/po-cost-2026.json", JSON.stringify(rows) + "\n");
  console.log(`wrote ${rows.length} ASIN rows`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
