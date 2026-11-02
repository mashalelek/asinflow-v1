// Yield review list (Maria 2026-11-02). READ-ONLY: writes nothing to the database.
// For every PO ASIN row and its product lines, two shapes are flagged:
//   A  "yield 1 on a multi-pack": a sheet-imported PO (cost_formula_version IS NULL)
//      whose ASIN row is multi-pack with units_per_pack > 1 but the line's yield is 1 —
//      the PO 6433257 / B07J9QQDSS shape (100 retailer units counted as 100 ASIN units).
//   B  "lines ≠ Ordered": Σ(line qty × yield) (a bundle: the scarcest component's sets)
//      differs from the ASIN row's stored Ordered by more than a cent, any PO.
// A mismatch names its shape: "line qty missing" (a line with no quantity), "yield 0",
// "Ordered 0, lines present" (the stored Ordered is 0 although lines carry units) or the
// plain "lines ≠ Ordered". Nothing here decides what is right — Maria does.
// One CSV row per flagged line: PO #, supplier, ASIN, yield, units/pack, product qty,
// Ordered, status, On Order contribution (the ASINs-page fold for that row alone), the
// reason(s), plus the expected Ordered and a ready-made fix command (shape A: yield =
// 1 / units_per_pack) for script/fix-po-yield.ts.
//   tsx script/yield-review.ts [--prod] [--out docs/yield-review-<date>.csv]
import "./env";
import fs from "fs";
import { Pool } from "pg";
import { asinQtyFromLines } from "../server/po-edit";
import { trueYield } from "../server/po-af-source";
import { computePipeline, envReconStart } from "../server/asin-po-pipeline";
import { csv } from "../server/po-model-backfill";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const out = arg("--out") ?? `docs/yield-review-${new Date().toISOString().slice(0, 10)}.csv`;

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const rows = (await pool.query(
    `SELECT p.order_id, p.supplier, p.order_date::text AS order_date, (p.closed_at IS NOT NULL) AS closed, p.cost_formula_version,
            (p.order_date >= COALESCE((SELECT MIN(shipped_at) FROM velocity_shipments), $1::date, DATE '9999-12-31')) AS reconciled,
            pa.id AS pa_id, pa.asin, pa.qty, pa.sold_as, pa.units_per_pack, pa.unique_products, pa.qty_shipped_fba, pa.qty_lost_damaged_us, pa.qty_at_prep, pa.qty_received_amazon,
            l.id AS line_id, l.position, l.product_name, l.qty_ordered, l.asin_qty_per_product, l.qty_canceled, l.qty_returned
       FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
       LEFT JOIN po_line_items l ON l.po_asin_id = pa.id
      ORDER BY p.order_date, p.order_id, pa.asin, l.position`,
    [envReconStart()],
  )).rows as any[];
  await pool.end();

  const byRow = new Map<string, any[]>();
  for (const r of rows) { const k = String(r.pa_id); if (!byRow.has(k)) byRow.set(k, []); byRow.get(k)!.push(r); }
  const outRows: unknown[][] = [["po_number", "supplier", "asin", "yield", "units_per_pack", "product_qty", "ordered", "status", "on_order_contribution", "reason", "expected_ordered", "line_canceled", "sold_as", "imported", "order_date", "product", "fix_command"]];
  let rowsA = 0, rowsB = 0, flaggedRows = 0, rowsScanned = 0, linesScanned = 0;
  const byWhy = new Map<string, number>();
  for (const lines of Array.from(byRow.values())) {
    const h = lines[0];
    rowsScanned++;
    const real = lines.filter((l) => l.line_id != null);
    linesScanned += real.length;
    if (real.length === 0) continue;
    const soldAs = String(h.sold_as ?? "individual");
    const imported = h.cost_formula_version == null;
    const upp = Number(h.units_per_pack ?? 1);
    const expected = asinQtyFromLines(real, soldAs).qty;
    const mismatch = Math.abs(expected - Number(h.qty ?? 0)) > 0.01;
    // The ASINs-page fold for this row alone (server/asin-po-pipeline.ts): NULL canceled / returned when any line is untracked.
    const divisor = soldAs === "bundle" && Number(h.unique_products ?? 0) > 1 ? Number(h.unique_products) : 1;
    const sumOf = (f: "qty_canceled" | "qty_returned") => (real.some((l) => l[f] == null) ? null : real.reduce((t, l) => t + Number(l[f]) * Number(l.asin_qty_per_product ?? 1), 0) / divisor);
    const contribution = computePipeline([{ asin: h.asin, closed: h.closed, reconciled: h.reconciled, qty: h.qty, qty_canceled_asin: sumOf("qty_canceled"), qty_returned_asin: sumOf("qty_returned"), qty_lost_damaged_us: h.qty_lost_damaged_us, qty_at_prep: h.qty_at_prep, qty_shipped_fba: h.qty_shipped_fba, qty_received_amazon: h.qty_received_amazon }]).get(String(h.asin).toUpperCase())?.on_order ?? 0;
    let flagged = false;
    for (const l of real) {
      const y = trueYield(Number(l.asin_qty_per_product ?? 1) || 1);
      const shapeA = imported && soldAs === "multi-pack" && upp > 1 && y === 1;
      if (!shapeA && !mismatch) continue;
      flagged = true;
      const why = !mismatch ? "" : real.some((x) => x.qty_ordered == null) ? "line qty missing" : y === 0 ? "yield 0" : Number(h.qty ?? 0) === 0 && expected > 0 ? "Ordered 0, lines present" : "lines ≠ Ordered";
      if (shapeA) rowsA++;
      if (mismatch) { rowsB++; byWhy.set(why, (byWhy.get(why) ?? 0) + 1); }
      const reason = [shapeA ? "yield 1 on multi-pack" : "", why].filter(Boolean).join(" + ");
      const fix = shapeA ? `tsx script/fix-po-yield.ts --order ${h.order_id} --asin ${h.asin} --yield ${Math.round((1 / upp) * 10000) / 10000} --prod --live` : "";
      outRows.push([h.order_id, h.supplier, h.asin, l.asin_qty_per_product, upp, l.qty_ordered, h.qty, h.closed ? "closed" : "open", contribution, reason, expected, l.qty_canceled, soldAs, imported ? "yes" : "no", h.order_date, l.product_name, fix]);
    }
    if (flagged) flaggedRows++;
  }
  fs.writeFileSync(out, csv(outRows));
  console.log(`scanned ${rowsScanned} ASIN rows / ${linesScanned} lines; flagged ${outRows.length - 1} line(s) on ${flaggedRows} ASIN row(s): ${rowsA} yield-1-on-multi-pack, ${rowsB} mismatching (${Array.from(byWhy.entries()).map(([k, v]) => `${k}: ${v}`).join(", ")}); → ${out}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
