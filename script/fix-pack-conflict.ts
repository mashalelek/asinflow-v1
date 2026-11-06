// Resolve a pack conflict Maria decided (2026-11-06, sheet Col T confirms): the ASIN record takes the pack (her
// confirmation, History), and every PO row for the ASIN takes it too — each line's integers become the retailer units
// per product and the ASIN pack, so its ASIN qty = qty ordered × retailer ÷ pack (= sheet Col T × qty). Stored per-unit
// COGS / Sourcing / Paid are never written. A line whose ASIN qty would change, or a row whose Ordered would, stops
// the live run — the dry run lists them for Maria first.
//   tsx script/fix-pack-conflict.ts --asin B07ZGF5N8Q --units 2 --retailer-units 4 [--prod] [--live]
import "./env";
import { Pool } from "pg";
import { changedFields, logEdits } from "../server/po-edit";
import { setAsinPack } from "../server/asin-pack-review";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const asin = arg("--asin")?.toUpperCase(), units = Number(arg("--units")), retailer = Number(arg("--retailer-units")), live = process.argv.includes("--live");
if (!asin || !Number.isInteger(units) || units < 2 || !Number.isInteger(retailer) || retailer < 1) {
  console.error("usage: --asin <ASIN> --units <ASIN pack ≥ 2> --retailer-units <retailer units per product> [--prod] [--live]"); process.exit(2);
}
const yld = retailer / units;
const r2 = (n: number) => Math.round(n * 100) / 100;

(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await db.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const maria = (await query(`SELECT id FROM users WHERE email = 'maria@coastalqualitygoods.com'`)).rows[0]?.id ?? null;
    await query("BEGIN");
    const rows = (await query(`SELECT pa.id, pa.po_id, p.order_id, pa.sold_as, pa.units_per_pack, pa.qty FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE pa.asin = $1 ORDER BY p.order_date`, [asin])).rows;
    console.log(`${asin} → multi-pack ×${units}, ${retailer} retailer units per product (ASIN qty per product ${r2(yld)})`);
    let qtyChanges = 0;
    for (const r of rows) {
      const lines = (await query(`SELECT id, position, qty_ordered, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product FROM po_line_items WHERE po_asin_id = $1 ORDER BY position, id`, [r.id])).rows;
      const rowChanges = changedFields({ sold_as: r.sold_as, units_per_pack: r.units_per_pack == null ? null : Number(r.units_per_pack) }, { sold_as: "multi-pack", units_per_pack: units });
      if (rowChanges.length) { await query(`UPDATE po_asins SET sold_as = 'multi-pack', units_per_pack = $2 WHERE id = $1`, [r.id, units]); await logEdits(query, String(r.po_id), maria, "asin", String(r.id), rowChanges); }
      let ordered = 0;
      const out: string[] = [];
      for (const l of lines) {
        const before = r2(Number(l.qty_ordered) * (l.retailer_units_per_product != null && l.asin_units_per_pack != null ? Number(l.retailer_units_per_product) / Number(l.asin_units_per_pack) : Number(l.asin_qty_per_product)));
        const after = r2(Number(l.qty_ordered) * yld);
        ordered += Number(l.qty_ordered) * yld;
        if (Math.abs(before - after) > 0.005) qtyChanges++;
        const lc = changedFields({ retailer_units_per_product: l.retailer_units_per_product == null ? null : Number(l.retailer_units_per_product), asin_units_per_pack: l.asin_units_per_pack == null ? null : Number(l.asin_units_per_pack) }, { retailer_units_per_product: retailer, asin_units_per_pack: units });
        if (lc.length) { await query(`UPDATE po_line_items SET retailer_units_per_product = $2, asin_units_per_pack = $3 WHERE id = $1`, [l.id, retailer, units]); await logEdits(query, String(r.po_id), maria, "line", String(l.id), lc); }
        out.push(`line ${l.position ?? "?"}: ${Number(l.qty_ordered)} × ${l.retailer_units_per_product ?? "-"}/${l.asin_units_per_pack ?? "-"} → ${retailer}/${units}, ASIN qty ${before} → ${after}${Math.abs(before - after) > 0.005 ? "  ← CHANGES" : ""}`);
      }
      const orderedMoves = Math.abs(r2(ordered) - Number(r.qty)) > 0.005;
      if (orderedMoves) qtyChanges++;
      console.log(`  ${r.order_id}: row ${r.sold_as ?? "—"} ×${r.units_per_pack ?? "—"} → multi-pack ×${units}; Ordered ${Number(r.qty)} → ${r2(ordered)}${orderedMoves ? "  ← CHANGES" : ""}\n    ${out.join("\n    ")}`);
    }
    const rec = await setAsinPack(query, asin, { sold_as: "multi-pack", units }, maria, "manual");
    console.log(`  ASIN record: ${rec.changed ? "set" : "already so, confirmed"} multi-pack ×${units} (History, source manual)`);
    if (qtyChanges) { await query("ROLLBACK"); console.log(`${qtyChanges} ASIN qty / Ordered value(s) would change — rolled back; nothing written`); process.exitCode = 3; return; }
    if (!live) { await query("ROLLBACK"); console.log("no ASIN qty changes; dry run — rolled back; add --live to write"); return; }
    await query("COMMIT");
    console.log("written");
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await db.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
