// Confirm ASIN packs Maria decided (2026-11-06, the open-PO pack review): each record set as hers (History,
// pack_source manual), then the ASIN's PO rows with no pack filled STRICTLY — open and closed rows alike only where the
// pack reproduces the row's stored Ordered; every other row is listed for her and not written. Rows already carrying a
// different pack are listed too — or, with --rewrite-rows (Maria 2026-11-06, B07SDNN7RW is a 4-pack, not the individual
// she set earlier), rewritten with the same strict rule: the row takes the pack and each line its integers only when
// the pack reproduces the row's stored Ordered; the rest stay listed. Quantities and costs are never written. Then
// auto-close is evaluated on the open POs carrying these ASINs (nothing else); each one still open is reported with
// what keeps it open.
//   tsx script/confirm-asin-packs.ts --set "B09XFM32Z9=2,B08TW16D5G=1,…" [--rewrite-rows] [--prod] [--live]     (1 = individual)
import "./env";
import { Pool } from "pg";
import { setAsinPack } from "../server/asin-pack-review";
import { changedFields, linesAtPack, logEdits } from "../server/po-edit";
import { evaluateAutoClose } from "../server/po-close";
import { poAsinRowsSql } from "../server/po-queries";
import { PO_CLOSE_ACTION_ITEMS_SQL } from "../server/po-action-items";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const live = process.argv.includes("--live"), rewrite = process.argv.includes("--rewrite-rows");
const set = (arg("--set") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [a, u] = s.split("="); return { asin: a.toUpperCase(), units: Number(u) }; });
if (set.length === 0 || set.some((x) => !/^[A-Z0-9]{10}$/.test(x.asin) || !Number.isInteger(x.units) || x.units < 1)) { console.error('usage: --set "ASIN=units,…" (1 = individual) [--prod] [--live]'); process.exit(2); }
const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const label = (s: string | null, u: unknown) => (s == null ? "—" : s === "individual" ? "individual" : `${s} ×${u ?? "?"}`);

(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await db.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const maria = (await query(`SELECT id FROM users WHERE email = 'maria@coastalqualitygoods.com'`)).rows[0]?.id ?? null;
    await query("BEGIN");
    const tot = { asins: 0, changed: 0, openRows: 0, closedRows: 0, lines: 0 };
    const skipped: string[] = [], differing: string[] = [], rewritten: string[] = [];
    const orderOf = async (poId: string) => (await query(`SELECT supplier, order_id FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
    for (const { asin, units } of set) {
      if (!(await query(`SELECT 1 FROM asins WHERE asin = $1`, [asin])).rows.length) { console.log(`${asin}: not in AF — skipped`); continue; }
      const pack = units === 1 ? { sold_as: "individual" as const, units: 1 } : { sold_as: "multi-pack" as const, units };
      for (const r of (await query(`SELECT pa.id, pa.po_id, pa.qty, p.supplier, p.order_id, p.closed_at IS NOT NULL closed, pa.sold_as, pa.units_per_pack FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
          WHERE pa.asin = $1 AND pa.sold_as IS NOT NULL AND (pa.sold_as <> $2 OR COALESCE(pa.units_per_pack, 1) <> $3)`, [asin, pack.sold_as, units])).rows) {
        const where = `${asin} ${r.supplier} ${r.order_id} (${r.closed ? "closed" : "open"})`;
        const lines = (await query(`SELECT id, qty_ordered, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product FROM po_line_items WHERE po_asin_id = $1`, [r.id])).rows;
        const desc = lines.map((l: any) => `${n(l.qty_ordered)} × ${l.retailer_units_per_product ?? "-"}/${l.asin_units_per_pack ?? "-"} (yield ${l.asin_qty_per_product})`).join("; ");
        const fit = r.sold_as === "bundle" || lines.length === 0 ? null : linesAtPack(lines, units);
        const fits = fit != null && Math.abs(fit.units - n(r.qty)) <= 0.01 + 1e-9;
        if (!rewrite || !fits) {
          differing.push(`${where}: row says ${label(r.sold_as, r.units_per_pack)}, you chose ${label(pack.sold_as, units)} — not touched${rewrite ? ` (your pack gives ${fit ? fit.units : "no whole number of retailer units"}, stored ASIN qty ${n(r.qty)}; lines ${desc})` : ""}`);
          continue;
        }
        await query(`UPDATE po_asins SET sold_as = $2, units_per_pack = $3 WHERE id = $1`, [r.id, pack.sold_as, units]);
        await logEdits(query, String(r.po_id), maria, "asin", String(r.id), changedFields({ sold_as: r.sold_as, units_per_pack: r.units_per_pack == null ? null : n(r.units_per_pack) }, { sold_as: pack.sold_as, units_per_pack: units }));
        for (const l of fit!.lines) {
          const lc = changedFields({ retailer_units_per_product: l.cur.retailer_units_per_product == null ? null : n(l.cur.retailer_units_per_product), asin_units_per_pack: l.cur.asin_units_per_pack == null ? null : n(l.cur.asin_units_per_pack) }, { retailer_units_per_product: l.retailer, asin_units_per_pack: units });
          if (lc.length) { await query(`UPDATE po_line_items SET retailer_units_per_product = $2, asin_units_per_pack = $3 WHERE id = $1`, [(l.cur as any).id, l.retailer, units]); await logEdits(query, String(r.po_id), maria, "line", String((l.cur as any).id), lc); }
        }
        rewritten.push(`${where}: ${label(r.sold_as, r.units_per_pack)} → ${label(pack.sold_as, units)}; lines ${desc} → ${fit!.lines.map((l) => `${l.retailer}/${units}`).join("; ")}; ASIN qty ${n(r.qty)} → ${fit!.units}`);
      }
      const res = await setAsinPack(query, asin, pack, maria, "manual", { strict: true });
      tot.asins++; if (res.changed) tot.changed++;
      tot.openRows += res.gaps.openRows; tot.closedRows += res.gaps.closedRows; tot.lines += res.gaps.lines;
      for (const s of res.gaps.skipped ?? []) {
        const po = await orderOf(s.po_id);
        const ls = (await query(`SELECT qty_ordered, retailer_units_per_product r, asin_units_per_pack a, asin_qty_per_product y FROM po_line_items WHERE po_asin_id = $1`, [s.po_asin_id])).rows;
        skipped.push(`${asin} ${po.supplier} ${po.order_id} (${s.closed ? "closed" : "open"}): stored ASIN qty ${s.qty}, ${label(pack.sold_as, units)} gives ${s.at_pack ?? "no whole number of retailer units"} — lines ${ls.map((l: any) => `${n(l.qty_ordered)} × ${l.r ?? "-"}/${l.a ?? "-"} (yield ${l.y})`).join("; ")}`);
      }
    }
    console.log(`${tot.asins} ASINs confirmed (${tot.changed} record values set, the rest confirmed as on record); PO rows filled: ${tot.openRows} open, ${tot.closedRows} closed; ${tot.lines} lines given integers`);
    console.log(`\nNot written — the pack does not reproduce the stored ASIN qty (${skipped.length}):${skipped.length ? "\n  " + skipped.join("\n  ") : " none"}`);
    if (rewrite) console.log(`\nRows rewritten to your pack (${rewritten.length}):${rewritten.length ? "\n  " + rewritten.join("\n  ") : " none"}`);
    console.log(`\nRows already carrying a different pack (${differing.length}):${differing.length ? "\n  " + differing.join("\n  ") : " none"}`);

    const pos = (await query(`SELECT DISTINCT p.id, p.supplier, p.order_id FROM purchase_orders p JOIN po_asins pa ON pa.po_id = p.id WHERE pa.asin = ANY($1::text[]) AND p.closed_at IS NULL ORDER BY p.supplier, p.order_id`, [set.map((x) => x.asin)])).rows;
    const closed: string[] = [], open: string[] = [];
    for (const po of pos) {
      const o = await evaluateAutoClose(String(po.id), query);
      if (o.changed === "closed") { closed.push(`${po.supplier} ${po.order_id}`); continue; }
      const items = (await query(`SELECT ${PO_CLOSE_ACTION_ITEMS_SQL} AS items FROM purchase_orders p WHERE p.id = $1`, [po.id])).rows[0].items as string[];
      const rows = (await query(poAsinRowsSql(`pa.po_id = $1`), [po.id])).rows;
      const short = rows.map((r: any) => ({ asin: r.asin, due: n(r.qty) - n(r.qty_canceled_asin) - n(r.qty_returned_asin) - n(r.qty_lost_damaged_us), shipped: n(r.qty_shipped_fba) }))
        .filter((r: any) => r.shipped < r.due - 1e-9).map((r: any) => `${r.asin} ${Math.round((r.due - r.shipped) * 100) / 100} of ${Math.round(r.due * 100) / 100} not shipped FBA`);
      const noShip = rows.every((r: any) => n(r.qty_shipped_fba) === 0);
      open.push(`${po.supplier} ${po.order_id}: ${[items.length ? `action items: ${items.join(", ")}` : "", short.length ? `units unaccounted: ${short.join("; ")}` : "", !short.length && noShip ? "no unit shipped FBA yet" : ""].filter(Boolean).join(" · ") || "?"}`);
    }
    console.log(`\nOpen POs carrying these ASINs: ${pos.length}; auto-closed ${closed.length}${closed.length ? ":\n  " + closed.join("\n  ") : ""}`);
    console.log(`Still open (${open.length}):${open.length ? "\n  " + open.join("\n  ") : ""}`);
    if (!live) { await query("ROLLBACK"); console.log("\ndry run — rolled back (auto-close above is what the live run would do); add --live to write"); return; }
    await query("COMMIT");
    console.log("\nwritten");
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await db.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
