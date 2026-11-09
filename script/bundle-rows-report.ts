// Bundle rows review (Maria 2026-11-09, walmart 200015415094735 B0GWG5S64Q). READ-ONLY:
// writes nothing to the database. For every ASIN row sold as a bundle: what AF derives
// today (shared/yield.ts: min over components of qty × retailer ÷ N — the bundle's ×N
// as every component's yield denominator; cost = Σ component line money ÷ ASIN units)
// against the bundle rule (shared/bundle.ts: ×N = Individual units in one bundle, a
// per-bundle count per component — an even split proposed when none is stored — ASIN
// units = the scarcest component's builds, leftovers shown, Cost/Unit = Σ per-Individual
// cost × count, then the PO's tax / shipping / discount share). Nothing here decides
// what is right — Maria does (historical COGS rule: a sheet-imported PO's stored cost
// is never recomputed without her say-so).
//   tsx script/bundle-rows-report.ts [--prod] [--out docs/bundle-rows-<date>.csv]
import "./env";
import fs from "fs";
import { Pool } from "pg";
import { asinQtyFromLines } from "../server/po-edit";
import { bundleFromLines } from "../shared/bundle";
import { csv } from "../server/po-model-backfill";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const out = arg("--out") ?? `docs/bundle-rows-${new Date().toISOString().slice(0, 10)}.csv`;
const r2 = (x: number) => Math.round(x * 100) / 100;
const n = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const hasUpb = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'po_line_items' AND column_name = 'units_per_bundle'`)).rowCount! > 0;
  const rows = (await pool.query(
    `SELECT p.order_id, p.supplier, p.order_date::text AS order_date, p.source, p.cost_formula_version, (p.closed_at IS NOT NULL) AS closed,
            p.subtotal, p.tax, p.sh_donations, p.discount, p.order_total,
            pa.id AS po_asin_id, pa.asin, pa.qty, pa.units_per_pack, pa.unique_products, pa.cost_per_unit, pa.qty_shipped_fba, pa.qty_at_prep, pa.received_velocity,
            (SELECT COALESCE(SUM(COALESCE(x.line_total, x.price * x.qty_ordered)), 0) FROM po_line_items x WHERE x.po_id = p.id) AS po_lines_sum,
            (SELECT COUNT(*) FROM po_asins y WHERE y.po_id = p.id) AS po_asin_rows,
            (SELECT json_agg(json_build_object('product_name', l.product_name, 'qty_ordered', l.qty_ordered, 'price', l.price, 'line_total', l.line_total,
                    'retailer_units_per_product', l.retailer_units_per_product, 'asin_units_per_pack', l.asin_units_per_pack, 'asin_qty_per_product', l.asin_qty_per_product,
                    'ratio_log', (SELECT string_agg(e.field || ' ' || COALESCE(e.old_value, '∅') || '→' || COALESCE(e.new_value, '∅') || ' by ' || COALESCE(u.display_name, 'script') || ' ' || to_char(e.at, 'YYYY-MM-DD'), '; ' ORDER BY e.at)
                                    FROM po_edit_log e LEFT JOIN users u ON u.id = e.user_id WHERE e.entity = 'line' AND e.entity_id = l.id::text AND e.field LIKE 'retailer_units_per_product%'),
                    'ratio_by_hand', EXISTS (SELECT 1 FROM po_edit_log e WHERE e.entity = 'line' AND e.entity_id = l.id::text AND e.field = 'retailer_units_per_product')
                    ${hasUpb ? ", 'units_per_bundle', l.units_per_bundle" : ""}) ORDER BY l.position) FROM po_line_items l WHERE l.po_asin_id = pa.id) AS lines
       FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
      WHERE pa.sold_as = 'bundle'
      ORDER BY p.order_date DESC, p.order_id, pa.asin`,
  )).rows as any[];
  const header = ["order_id", "supplier", "order_date", "po_source", "closed", "asin", "N_units_per_pack", "unique_products", "lines (qty × stored Individual per Product unit @ unit price)", "pack provenance (po_edit_log)",
    "stored_asin_units", "today_rule_asin_units", "stored_cost_per_unit", "today_rule_cost_per_unit",
    "split", "rule_asin_units", "rule_individual", "leftover_individual_per_component", "rule_cost_pre_share", "share_ratio (header ÷ PO lines)", "rule_cost_with_share", "po_asin_rows",
    "asin_units_differ", "cost_differs", "shipped_fba", "received_velocity", "note"];
  const outRows: unknown[][] = [header];
  let differQty = 0, differCost = 0;
  for (const r of rows) {
    const lines: any[] = Array.isArray(r.lines) ? r.lines : [];
    const N = n(r.units_per_pack);
    const today = asinQtyFromLines(lines, "bundle").qty;
    const money = lines.map((l) => (l.line_total != null ? Number(l.line_total) : l.price != null ? Number(l.price) * (Number(l.qty_ordered) || 0) : null));
    const linesSum = money.some((m) => m == null) ? null : r2(money.reduce((t, m) => t + (m ?? 0), 0));
    const todayCost = linesSum != null && Number(r.qty) > 0 ? r2(linesSum / Number(r.qty)) : null;
    // The stored Individual units per Product unit on a bundle component line written by the yield backfill (migration 080 model,
    // "(exact yield)" log rows, no user) carries the bundle's N as a factor: real pack × N over N (yield 1 for a single). A line Maria
    // typed since, or fix:bundle-lines --convert-packs converted (a po_edit_log row with the exact field name — the backfill's rows
    // say "(exact yield)"), is already the real pack: 2026-11-09 the converted godiva line (18 over ×3) must not be read as 18 ÷ 3 again.
    // The rule is applied to the REAL pack.
    const realPack = (l: any): { pack: number | null; converted: boolean } => {
      const r = n(l.retailer_units_per_product), a = n(l.asin_units_per_pack);
      if (r == null) return { pack: null, converted: false };
      if (!l.ratio_by_hand && N != null && a === N && r % N === 0 && r / N >= 1 && Number(r) !== 1) return { pack: r / N, converted: true };
      return { pack: r, converted: false };
    };
    const packs = lines.map(realPack);
    const rule = bundleFromLines(lines.map((l, i) => ({
      qty_ordered: l.qty_ordered, retailer_units_per_product: packs[i].pack, units_per_bundle: l.units_per_bundle ?? null,
      unit_money: money[i] == null || !(Number(l.qty_ordered) > 0) ? null : money[i]! / Number(l.qty_ordered),
    })), N);
    // The PO's share: (subtotal − discount + tax + shipping) ÷ Σ line money over the WHOLE PO — shared/po-cost.ts's ratio with the stored header (the subtotal when it is known, else Σ lines).
    const poLines = n(r.po_lines_sum), sub = n(r.subtotal), base = sub != null && sub > 0 ? sub : poLines;
    const shareRatio = poLines != null && poLines > 0 && base != null ? Number(((base - (n(r.discount) ?? 0) + (n(r.tax) ?? 0) + (n(r.sh_donations) ?? 0)) / poLines).toFixed(4)) : null;
    const withShare = rule.costPreShare != null && shareRatio != null ? r2(rule.costPreShare * shareRatio) : null;
    const split = rule.splitKnown ? rule.components.map((c) => c.perBundle).join(" + ") + " (stored)" : rule.splitProposable ? rule.components.map((c) => c.perBundle).join(" + ") + " (proposed even split)" : "unknown — N does not divide evenly";
    const notes: string[] = [];
    if (r.cost_formula_version == null) notes.push("sheet-imported: stored cost is the sheet's, never recomputed");
    if (lines.some((l) => l.retailer_units_per_product == null)) notes.push("a line has no Individual units per Product unit (read as 1)");
    if (packs.some((p) => p.converted)) notes.push(`stored pack ÷ ×${N} read as the real pack on ${packs.filter((p) => p.converted).length} line(s) (yield-backfill encoding)`);
    if (lines.some((l) => l.ratio_by_hand)) notes.push("a line's pack was typed by hand (real pack as stored)");
    if (!rule.sumMatches) notes.push(`per-bundle counts sum to ${rule.sumPerBundle}, not ×${N ?? "?"}`);
    if (rule.hasLeftover) notes.push("leftover Individual units");
    if (lines.length < 2) notes.push("fewer than two component lines");
    const qtyDiffers = Math.abs(rule.asinUnits - Number(r.qty)) > 0.005;
    const costDiffers = withShare != null && r.cost_per_unit != null && Math.abs(withShare - Number(r.cost_per_unit)) > 0.005;
    if (qtyDiffers) differQty++;
    if (costDiffers) differCost++;
    outRows.push([
      r.order_id, r.supplier, r.order_date, r.cost_formula_version == null ? `${r.source} (sheet values)` : `${r.source} v${r.cost_formula_version}`, r.closed ? "closed" : "open", r.asin, N, r.unique_products,
      lines.map((l, i) => `${l.qty_ordered} × ${l.retailer_units_per_product ?? "∅"}${packs[i].converted ? ` (real ${packs[i].pack})` : ""} @${l.price == null ? "∅" : Number(l.price).toFixed(2)} ${String(l.product_name ?? "").slice(0, 40)}`).join(" | "),
      lines.map((l) => l.ratio_log ?? "no log row").join(" | "),
      r.qty, today, r.cost_per_unit, todayCost,
      split, rule.asinUnits, rule.individual, rule.components.map((c) => c.leftover).join(" | "), rule.costPreShare, shareRatio, withShare, r.po_asin_rows,
      qtyDiffers ? "yes" : "", costDiffers ? "yes" : "", r.qty_shipped_fba, r.received_velocity, notes.join("; "),
    ]);
  }
  fs.writeFileSync(out, csv(outRows));
  console.log(`${rows.length} bundle ASIN row(s) on ${new Set(rows.map((r) => r.order_id)).size} PO(s); ASIN units differ on ${differQty}, cost differs on ${differCost}; ${hasUpb ? "units_per_bundle column present" : "no units_per_bundle column yet (every split proposed)"} → ${out}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
