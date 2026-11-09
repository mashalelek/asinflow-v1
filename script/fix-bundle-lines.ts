// The bundle rule applied to stored POs (Maria 2026-11-09, walmart 200015415094735 B0GWG5S64Q;
// migration 100, shared/bundle.ts). Two jobs, each dry run by default (the whole edit runs in a
// transaction and rolls back; `--live` commits); `--prod` reads .env.production.local (script/env.ts).
//
//   --convert-packs
//       Bundle component lines written by the yield backfill in the migration-080 encoding — the
//       line's Individual units per Product unit holds the real pack × the bundle's N (a single balm
//       stored as "2" on a ×2 bundle, a 5-pack shampoo as "10") — become the real pack (÷ N). Only a
//       line with asin_units_per_pack = N, retailer_units_per_product a multiple of N (and ≠ 1) and NO
//       hand edit of that field in po_edit_log is converted; the stored Ordered is recomputed by the
//       rule and must come out unchanged (the script says so per row, and refuses --live otherwise).
//       --review-csv <path> writes one row per converted line for Maria's review (2026-11-09): PO,
//       supplier, order date, bundle ASIN and its ×N, the component's name, the stored pack integer, the
//       proposed real pack, the proposed units per bundle (stored, or the even split AF would show in
//       amber) and what the product title suggests (shared/pack-parse titlePackSuggestion) — she
//       confirms or corrects each row before the live run.
//   --order <id> --asin <ASIN> --split 1,1 [--cost-per-rule]
//       The named bundle row's component lines get their units per bundle (position order; the counts
//       must sum to the row's ×N), Ordered is recomputed by the rule and, with --cost-per-rule, the
//       row's Cost/Unit is set to the rule's figure — Σ component per-Individual cost × count, then the
//       PO's share: (subtotal − discount + tax + shipping) ÷ Σ the PO's line money, the gift-card
//       factor — as a hand-entered cost with a History row (a sheet-imported PO's costs are otherwise
//       never recomputed; this is Maria's explicit say-so for the row named). Auto-close re-runs.
//
//   tsx script/fix-bundle-lines.ts --convert-packs [--prod] [--live] [--review-csv docs/bundle-pack-review-<date>.csv]
//   tsx script/fix-bundle-lines.ts --order 200015415094735 --asin B0GWG5S64Q --split 1,1 --cost-per-rule [--prod] [--live]
import "./env";
import { Pool } from "pg";
import { editLine, editAsinRow, type EditResult } from "../server/po-edit";
import { bundleFromLines } from "../shared/bundle";
import { bundleAsinCosts } from "../shared/po-cost";
import { bundleCostLines } from "../server/po-costs";
import { csv } from "../server/po-model-backfill";
import { titlePackSuggestion } from "../shared/pack-parse";
import { writeFileSync } from "fs";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const live = process.argv.includes("--live"), convert = process.argv.includes("--convert-packs"), costPerRule = process.argv.includes("--cost-per-rule");
const reviewCsv = arg("--review-csv");
const order = arg("--order"), asin = (arg("--asin") ?? "").toUpperCase(), split = (arg("--split") ?? "").split(",").map((x) => x.trim()).filter(Boolean).map(Number);
if (!convert && !(order && /^B0[A-Z0-9]{8}$/.test(asin) && split.length >= 2 && split.every((n) => Number.isInteger(n) && n >= 1))) {
  console.error("usage: --convert-packs | --order <order id> --asin <ASIN> --split n,n[,n] [--cost-per-rule]   [--prod] [--live]");
  process.exit(2);
}
const r2 = (x: number) => Math.round(x * 100) / 100;

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  let refuse = false;
  await query("BEGIN");
  try {
    const hasUpb = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'po_line_items' AND column_name = 'units_per_bundle'`)).rowCount! > 0;
    if (!hasUpb) { console.error("po_line_items.units_per_bundle is missing — migration 100 has not run on this database"); process.exit(3); }
    const rowOf = async (paId: string) => (await query(`SELECT pa.id, pa.asin, pa.qty, pa.sold_as, pa.units_per_pack, pa.cost_per_unit, pa.qty_shipped_fba, p.id AS po_id, p.order_id, p.closed_at, p.closed_by, p.cost_formula_version FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE pa.id = $1`, [paId])).rows[0];
    const linesOf = async (paId: string) => (await query(`SELECT id, position, product_name, qty_ordered, price, line_total, retailer_units_per_product, asin_units_per_pack, units_per_bundle FROM po_line_items WHERE po_asin_id = $1 ORDER BY position, id`, [paId])).rows;
    const show = (label: string, row: any, lines: any[]) => {
      console.log(`${label}: ${row.order_id} ${row.asin} — ${row.sold_as} ×${row.units_per_pack}, Ordered ${row.qty}, Shipped FBA ${row.qty_shipped_fba ?? "—"}, cost/unit ${row.cost_per_unit ?? "—"}, PO ${row.closed_at ? `closed (${row.closed_by})` : "open"}, ${row.cost_formula_version == null ? "sheet-imported" : "formula v" + row.cost_formula_version}`);
      for (const l of lines) console.log(`   line ${l.position}: ${String(l.product_name).slice(0, 44)} — ${l.qty_ordered} × ${l.retailer_units_per_product ?? "∅"} @${l.price ?? "∅"}, per bundle ${l.units_per_bundle ?? "∅ (proposed)"}`);
    };

    if (convert) {
      const cands = (await query(
        `SELECT l.id, l.po_asin_id, l.position, l.product_name, l.retailer_units_per_product AS r, l.asin_units_per_pack AS a, pa.units_per_pack AS n, pa.asin, p.order_id, p.supplier, p.order_date
           FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
          WHERE pa.sold_as = 'bundle' AND l.retailer_units_per_product IS NOT NULL AND l.asin_units_per_pack = pa.units_per_pack
            AND l.retailer_units_per_product <> 1 AND l.retailer_units_per_product % pa.units_per_pack = 0
            AND NOT EXISTS (SELECT 1 FROM po_edit_log e WHERE e.entity = 'line' AND e.entity_id = l.id::text AND e.field = 'retailer_units_per_product' AND e.user_id IS NOT NULL)
          ORDER BY p.order_date DESC, pa.asin, l.position`,
      )).rows;
      console.log(`${cands.length} bundle component line(s) in the migration-080 encoding (real pack × N):`);
      const byRow = new Map<string, any[]>();
      const review: unknown[][] = [["order_id", "supplier", "order_date", "bundle_asin", "bundle_n", "line_position", "component_product", "stored_pack_integer", "proposed_real_pack", "proposed_units_per_bundle", "per_bundle_source", "title_suggests", "title_vs_proposed", "ordered_before", "ordered_after"]];
      for (const c of cands) { if (!byRow.has(c.po_asin_id)) byRow.set(c.po_asin_id, []); byRow.get(c.po_asin_id)!.push(c); }
      for (const [paId, ls] of byRow) {
        const before = await rowOf(paId);
        for (const c of ls) {
          const real = Number(c.r) / Number(c.n);
          console.log(`  ${c.order_id} ${c.asin} line ${c.position} ${String(c.product_name).slice(0, 40)}: ${c.r} → ${real}`);
          await editLine(query, String(c.id), { retailer_units_per_product: real }, null);
        }
        const after = await rowOf(paId);
        const same = Number(after.qty) === Number(before.qty);
        const lines = await linesOf(paId), b = bundleFromLines(lines, after.units_per_pack);
        for (const c of ls) {
          const k = lines.findIndex((l: any) => String(l.id) === String(c.id)), comp = b.components[k];
          const real = Number(c.r) / Number(c.n), t = titlePackSuggestion(c.product_name);
          const suggests = t ? `${t.units_per_pack === 1 ? "single" : `${t.units_per_pack}-pack`} ("${t.text}")` : "no pack in the title";
          const vs = t ? (t.units_per_pack === real ? "agrees" : `differs: title ${t.units_per_pack}, proposed ${real}`) : "—";
          review.push([c.order_id, c.supplier, String(c.order_date ?? "").slice(0, 10), c.asin, c.n, c.position, c.product_name, c.r, real, comp?.perBundle ?? "", comp ? (comp.proposed ? "even split (proposed)" : "stored") : "", suggests, vs, before.qty, after.qty]);
        }
        console.log(`  ${before.order_id} ${before.asin}: Ordered ${before.qty} → ${after.qty}${same ? "" : "  ← CHANGED — not expected, refusing --live"}; PO ${before.closed_at ? "closed" : "open"} → ${after.closed_at ? "closed" : "open"}`);
        if (!same) refuse = true;
      }
      if (reviewCsv) { writeFileSync(reviewCsv, csv(review)); console.log(`review CSV: ${reviewCsv} (${review.length - 1} line(s))`); }
    }

    if (order) {
      const pa = (await query(`SELECT pa.id FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE p.order_id = $1 AND pa.asin = $2`, [order, asin])).rows[0];
      if (!pa) { console.error(`no ASIN row ${asin} on PO ${order}`); process.exit(4); }
      const paId = String(pa.id);
      const before = await rowOf(paId), beforeLines = await linesOf(paId);
      show("BEFORE", before, beforeLines);
      if (before.sold_as !== "bundle") { console.error("not a bundle row"); process.exit(4); }
      if (beforeLines.length !== split.length) { console.error(`--split names ${split.length} counts, the row has ${beforeLines.length} lines`); process.exit(4); }
      const sum = split.reduce((t, n) => t + n, 0);
      if (sum !== Number(before.units_per_pack)) { console.error(`the counts sum to ${sum}, the bundle is ×${before.units_per_pack}`); process.exit(4); }
      let last: EditResult | null = null;
      for (let k = 0; k < beforeLines.length; k++) last = await editLine(query, String(beforeLines[k].id), { units_per_bundle: split[k] }, null);
      if (costPerRule) {
        const po = (await query(`SELECT subtotal, discount, tax, sh_donations, weighted_gc_discount_pct, (SELECT COALESCE(SUM(COALESCE(x.line_total, x.price * x.qty_ordered)), 0) FROM po_line_items x WHERE x.po_id = purchase_orders.id) AS lines_sum FROM purchase_orders WHERE id = $1`, [before.po_id])).rows[0];
        const linesSum = Number(po.lines_sum), subtotal = Number(po.subtotal) > 0 ? Number(po.subtotal) : linesSum;
        const h = { subtotal, discount: Number(po.discount) || 0, tax: Number(po.tax) || 0, shDonations: Number(po.sh_donations) || 0, gcPct: po.weighted_gc_discount_pct == null ? null : Number(po.weighted_gc_discount_pct), allocationBase: linesSum > 0 ? linesSum : undefined };
        const lines = await linesOf(paId);
        const b = bundleFromLines(lines.map((l: any) => ({ ...l, unit_money: l.price == null ? null : Number(l.price) })), before.units_per_pack);
        const costs = bundleAsinCosts(h, bundleCostLines(lines, before.units_per_pack));
        if (!costs) { console.error("the rule's cost needs every line's price"); process.exit(4); }
        console.log(`rule: ${b.components.map((c) => `${c.individual} indiv ÷ ${c.perBundle}`).join(", ")} → ${b.asinUnits} bundles; cost pre-share ${b.costPreShare}, share (${subtotal} − ${h.discount} + ${h.tax} + ${h.shDonations}) ÷ ${r2(linesSum)} = ${r2(((subtotal - h.discount + h.tax + h.shDonations) / linesSum) * 10000) / 10000} → sourcing ${costs.sourcing}, COGS ${costs.cogs}, paid ${costs.paid}`);
        last = await editAsinRow(query, paId, { cost_per_unit: costs.cogs.toFixed(2), sourcing_cost: costs.sourcing.toFixed(2), paid_cost: costs.paid.toFixed(2) }, null);
      }
      const after = await rowOf(paId), afterLines = await linesOf(paId);
      show("AFTER ", after, afterLines);
      if (last) console.log(`auto-close: ${JSON.stringify(last.close)}`);
    }

    if (live && !refuse) { await query("COMMIT"); console.log("LIVE: committed."); }
    else { await query("ROLLBACK"); console.log(refuse ? "REFUSED: an Ordered changed under --convert-packs; nothing written." : "DRY RUN: rolled back; nothing written. Add --live to apply."); }
  } catch (e) {
    await query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release(); await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
