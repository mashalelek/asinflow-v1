// "Pack size mismatch" on a line whose stored yield and its row's pack disagree (Maria 2026-11-06): a line with no
// pack integers (a sheet import) on an ASIN row whose pack is known, whose stored 2-dp yield is no rounding of a whole
// number of retailer units at that pack (retailerUnitsAtPack) — or a multi-pack row with no pack size. Derived, so it
// clears by itself once the pack or the yield is fixed so they agree. The SQL twin is yieldMismatchLine
// (server/po-action-items.ts).
import { retailerUnitsAtPack } from "./yield";

export interface YieldMismatchLine { retailer_units_per_product?: unknown; asin_units_per_pack?: unknown; asin_qty_per_product?: unknown }

/** Pure: the note when the line's stored yield and the row's pack disagree ("stored 0.50, ×1 gives 1.00"), else null. */
export function yieldMismatchNote(l: YieldMismatchLine, soldAs: string | null | undefined, unitsPerPack: unknown): string | null {
  if (l.retailer_units_per_product != null && l.asin_units_per_pack != null) return null;
  const y = Number(l.asin_qty_per_product);
  if (!(y > 0) || (soldAs !== "individual" && soldAs !== "multi-pack")) return null;
  const pack = soldAs === "individual" ? 1 : Number(unitsPerPack);
  if (!(Number.isInteger(pack) && pack >= 1)) return `stored ${y.toFixed(2)}, multi-pack has no pack size`;
  if (retailerUnitsAtPack(y, pack) != null) return null;
  const r = Math.max(1, Math.round(y * pack));
  return `stored ${y.toFixed(2)}, ×${pack} gives ${(r / pack).toFixed(2)}`;
}
