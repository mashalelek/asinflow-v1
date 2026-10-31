// ASIN-level pack fields (patch po-ai-prefill §6.5, amendment 3,
// 2026-10-31): asins.sold_as / units_per_pack are what the New PO form reads
// ("AF knows the ASIN"). "Update ASIN in AF" writes them with a History row
// (asin_field_log), then brings every OPEN PO's row for the ASIN to the new
// size: sold_as / units_per_pack, each line's yield scaled so the units it
// stands for stay the same (yield × old ÷ new), Ordered recomputed, costs
// recomputed for a v2 PO. "Pack size mismatch" then shows by itself on any
// open PO whose Velocity order was created with the old size
// (velocity_units_per_pack ≠ units_per_pack). Closed POs are untouched.
import type { QueryLike } from "./scheduler/types";
import { logEdits, changedFields, recomputeAsinQty, EditError } from "./po-edit";
import { recomputePoCosts } from "./po-costs";

export interface PackValue { sold_as: "individual" | "multi-pack" | "bundle"; units_per_pack: number }
export interface PackUpdateResult { asin: string; changed: boolean; openRows: number; rowsUpdated: number; posRecosted: number }

export function parsePack(v: { sold_as?: unknown; units_per_pack?: unknown }): PackValue {
  const soldAs = String(v.sold_as ?? "");
  if (!["individual", "multi-pack", "bundle"].includes(soldAs)) throw new EditError(400, "sold_as must be individual, multi-pack or bundle");
  const upp = soldAs === "individual" ? 1 : Number(v.units_per_pack);
  if (!Number.isInteger(upp) || upp < 1 || (soldAs !== "individual" && upp < 2)) throw new EditError(400, `units_per_pack must be a whole number ≥ 2 for a ${soldAs}`);
  return { sold_as: soldAs as PackValue["sold_as"], units_per_pack: upp };
}

export async function applyAsinPackUpdate(query: QueryLike, asin: string, next: PackValue, userId: number | null, source: "po_form" | "manual" = "manual"): Promise<PackUpdateResult> {
  const a = asin.toUpperCase();
  const cur = (await query(`SELECT asin, sold_as, units_per_pack FROM asins WHERE asin = $1`, [a])).rows[0];
  if (!cur) throw new EditError(404, `${a} is not in AF's catalog`);
  const changes = changedFields({ sold_as: cur.sold_as, units_per_pack: cur.units_per_pack }, { sold_as: next.sold_as, units_per_pack: next.units_per_pack });
  const result: PackUpdateResult = { asin: a, changed: changes.length > 0, openRows: 0, rowsUpdated: 0, posRecosted: 0 };
  if (changes.length === 0) return result;
  await query(`UPDATE asins SET sold_as = $2, units_per_pack = $3 WHERE asin = $1`, [a, next.sold_as, next.units_per_pack]);
  for (const c of changes) await query(`INSERT INTO asin_field_log (asin, user_id, field, old_value, new_value, source) VALUES ($1, $2, $3, $4, $5, $6)`, [a, userId, c.field, c.old, c.new, source]);
  // Open POs follow.
  const rows = (await query(
    `SELECT pa.id, pa.po_id, pa.sold_as, pa.units_per_pack FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE pa.asin = $1 AND p.closed_at IS NULL`, [a],
  )).rows;
  result.openRows = rows.length;
  const recost = new Set<string>();
  for (const r of rows) {
    const rc = changedFields({ sold_as: r.sold_as, units_per_pack: r.units_per_pack }, { sold_as: next.sold_as, units_per_pack: next.units_per_pack });
    if (rc.length === 0) continue;
    const oldUpp = Number(r.units_per_pack) || 1, newUpp = next.units_per_pack;
    await query(`UPDATE po_asins SET sold_as = $2, units_per_pack = $3 WHERE id = $1`, [r.id, next.sold_as, next.units_per_pack]);
    await logEdits(query, String(r.po_id), userId, "asin", String(r.id), rc.map((c) => ({ ...c, field: `${c.field} (ASIN pack update)` })));
    if (oldUpp !== newUpp && r.sold_as !== "bundle" && next.sold_as !== "bundle") {
      // The units a line stands for are unchanged: its yield scales by old ÷ new.
      const lines = (await query(`SELECT id, asin_qty_per_product FROM po_line_items WHERE po_asin_id = $1`, [r.id])).rows;
      for (const l of lines) {
        const y = Number(l.asin_qty_per_product ?? 1) || 1;
        const ny = Math.round((y * oldUpp / newUpp) * 10000) / 10000;
        if (ny !== y) {
          await query(`UPDATE po_line_items SET asin_qty_per_product = $2 WHERE id = $1`, [l.id, String(ny)]);
          await logEdits(query, String(r.po_id), userId, "line", String(l.id), [{ field: "asin_qty_per_product (ASIN pack update)", old: String(y), new: String(ny) }]);
        }
      }
    }
    await recomputeAsinQty(query, String(r.id), userId);
    result.rowsUpdated++;
    recost.add(String(r.po_id));
  }
  for (const poId of Array.from(recost)) { const rr = await recomputePoCosts(query, poId, userId); if (!rr.skipped) result.posRecosted++; }
  return result;
}
