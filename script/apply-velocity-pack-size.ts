// Pack-size fix (2026-10-29): AF ASIN rows that were imported individual ×1
// from a blank Col AX while their Velocity orders say multi-pack. Takes
// Velocity's sold_as / units_per_pack from the shipment lines already stored
// in velocity_shipments.raw and sets them through the PO edit path
// (editAsinRow: po_edit_log, Ordered recompute, auto-close), user NULL.
//
//   tsx script/apply-velocity-pack-size.ts           # dry run: the candidates and the checks
//   tsx script/apply-velocity-pack-size.ts --live    # apply
//
// Candidates: a po_asin_shipments row linked to a Velocity line (same Order #
// and ASIN) whose pack size differs from AF's, on a row sold_as individual
// with no sold_as / units_per_pack edit in the log. Refuses (exit 2) when a
// candidate's Velocity lines disagree with each other or carry no pack size.
// Then run script/sync-shipments.ts so the shipment rows re-derive.
import "dotenv/config";
import pool from "../server/db";
import { editAsinRow } from "../server/po-edit";
import { velocityPack } from "../server/shipment-sync-velocity";

async function main() {
  const live = process.argv.includes("--live");
  const q = (sql: string, params?: any[]) => pool.query(sql, params);
  const rows = (await q(
    `SELECT pa.id, p.order_id, p.supplier, pa.asin, pa.sold_as, pa.units_per_pack, pa.qty,
            o->>'sold_as' AS v_sold, o->>'units_per_pack' AS v_upp, (o->>'quantity')::numeric AS v_qty, o->>'order_id' AS v_order
       FROM po_asin_shipments s
       JOIN po_asins pa ON pa.id = s.po_asin_id
       JOIN purchase_orders p ON p.id = pa.po_id
       JOIN velocity_shipments v ON v.id::text = s.velocity_shipment_id::text,
            jsonb_array_elements(v.raw->'detail'->'orders') o
      WHERE o->>'order_number' = p.order_id AND o->>'asin' = pa.asin
        AND pa.sold_as = 'individual'
        AND NOT EXISTS (SELECT 1 FROM po_edit_log e WHERE e.entity = 'asin' AND e.entity_id = pa.id::text AND e.field IN ('sold_as', 'units_per_pack'))`,
  )).rows;

  type Cand = { id: string; label: string; qty: number; packs: Map<string, { soldAs: string; upp: number }>; orders: Map<string, number>; missing: boolean };
  const byRow = new Map<string, Cand>();
  for (const r of rows) {
    const c = byRow.get(r.id) ?? { id: r.id, label: `${r.supplier} ${r.order_id} ${r.asin}`, qty: Number(r.qty), packs: new Map(), orders: new Map(), missing: false };
    const vp = velocityPack({ sold_as: r.v_sold, units_per_pack: r.v_upp });
    if (!vp) c.missing = true; else c.packs.set(`${vp.soldAs}:${vp.upp}`, vp);
    c.orders.set(String(r.v_order), Number(r.v_qty));
    byRow.set(r.id, c);
  }
  const cands = Array.from(byRow.values()).filter((c) => c.missing || c.packs.size !== 1 || Array.from(c.packs.values())[0].upp !== 1);

  let refuse = 0;
  console.log(`${cands.length} row(s) where Velocity's pack size differs from AF's individual ×1:\n`);
  for (const c of cands) {
    const vp = Array.from(c.packs.values())[0];
    if (c.missing || c.packs.size !== 1) { refuse++; console.log(`  REFUSE ${c.label}: Velocity pack size ${c.missing ? "missing" : `conflicting (${Array.from(c.packs.keys()).join(", ")})`}`); continue; }
    // Check: AF Ordered (ASIN units) × Velocity's pack size vs Velocity's order quantity (component units).
    const vUnits = Array.from(c.orders.values()).reduce((t, x) => t + x, 0);
    const check = Math.abs(c.qty * vp.upp - vUnits) < 1e-6 ? "ok" : `DIFFERS (AF ${c.qty} × ${vp.upp} = ${c.qty * vp.upp}; Velocity ordered ${vUnits} units)`;
    console.log(`  ${c.label}: individual ×1 → ${vp.soldAs} ×${vp.upp}  [Ordered ${c.qty}; units check ${check}]`);
  }
  if (refuse > 0) { console.log(`\n${refuse} refused — nothing written.`); process.exitCode = 2; return; }
  if (!live) { console.log(`\nDry run — nothing written.`); return; }

  for (const c of cands) {
    const vp = Array.from(c.packs.values())[0];
    const r = await editAsinRow(q as any, c.id, { sold_as: vp.soldAs, units_per_pack: vp.upp }, null);
    console.log(`  applied ${c.label}: ${r.changes.map((x) => `${x.field} ${x.old} → ${x.new}`).join(", ")}`);
  }
  console.log(`\n${cands.length} row(s) applied. Next: tsx script/sync-shipments.ts`);
}

main()
  .catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; })
  .finally(() => pool.end());
