// Exact line yield (Maria 2026-11-02). A product line carries two integers —
// retailer_units_per_product (the retailer's pack: 1 for a single, 9 for a
// 9-pack) and asin_units_per_pack (the ASIN row's pack size at the time) —
// and the ASIN units it yields are qty × retailer ÷ asin, summed in exact
// rational arithmetic and rounded ONCE (2 dp) for display and for the stored
// Ordered (po_asins.qty, numeric(10,2)). The yield column
// (po_line_items.asin_qty_per_product) is derived = retailer ÷ asin and kept
// for history only — a stored 2-dp yield (0.07 for 1/15) made 30 × 0.07 =
// 2.1 where the sheet said 2. A line without the two integers (a
// sheet-imported line the backfill could not resolve — docs/yield-ratio-
// gaps-2026-11-02.csv) still reads its stored yield as before (trueYield).
export interface YieldRatio { retailer: number; asinUnits: number }

const isPosInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;
const toInt = (v: unknown): number => (v == null || v === "" ? NaN : Number(v));

export function gcd(a: number, b: number): number { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a || 1; }
export function reduceRatio(retailer: number, asinUnits: number): YieldRatio { const g = gcd(retailer, asinUnits); return { retailer: retailer / g, asinUnits: asinUnits / g }; }

/** The ratio a stored line carries (both integers ≥ 1), else null. */
export function lineRatio(l: { retailer_units_per_product?: number | string | null; asin_units_per_pack?: number | string | null }): YieldRatio | null {
  const r = toInt(l.retailer_units_per_product), a = toInt(l.asin_units_per_pack);
  return isPosInt(r) && isPosInt(a) ? { retailer: r, asinUnits: a } : null;
}
/** The derived yield the history column stores: retailer ÷ asin, 4 dp ("0.0667"). */
export function ratioYield(r: YieldRatio): string { return String(Math.round((r.retailer / r.asinUnits) * 10000) / 10000); }
/** The line's effective yield as a number: the ratio when it has one, else its stored yield (read as the fraction it stands for), else 1. */
export function effectiveYield(l: { retailer_units_per_product?: number | string | null; asin_units_per_pack?: number | string | null; asin_qty_per_product?: number | string | null }, legacy: (y: number) => number = (y) => y): number {
  const r = lineRatio(l);
  if (r) return r.retailer / r.asinUnits;
  const y = Number(l.asin_qty_per_product ?? 1) || 1;
  return legacy(y);
}

/**
 * A typed ASIN-unit count for a line (units = qty × yield): retailer =
 * units × asinUnits ÷ qty when that is a whole number (the pack size keeps
 * its meaning), else the reduced fraction units ÷ qty (exact, both to 2 dp).
 */
export function ratioForUnits(units: number, qty: number, asinUnitsPerPack: number | null | undefined): YieldRatio | null {
  if (!(units > 0) || !(qty > 0)) return null;
  const a = isPosInt(asinUnitsPerPack) ? asinUnitsPerPack : 1;
  const k = (units * a) / qty;
  if (Math.abs(k - Math.round(k)) < 1e-6 && Math.round(k) >= 1) return { retailer: Math.round(k), asinUnits: a };
  const u100 = Math.round(units * 100), q100 = Math.round(qty * 100);
  return u100 >= 1 && q100 >= 1 ? reduceRatio(u100, q100) : null;
}
/**
 * The backfill rule (Maria 2026-11-02): a stored yield × the ASIN row's pack
 * size within 0.02 of a whole number ≥ 1 → that ratio (1/15 × 15 = 1 →
 * 1 / 15); else null (a gap). The tolerance is widened to the error a 2-dp
 * stored yield can carry, 0.005 × pack size, because 1/15 is stored as 0.07
 * and 0.07 × 15 = 1.05 — the example itself would miss a flat 0.02. `fit`
 * says which bound matched ("0.02" or "2dp") so the report can show it.
 * Second rule (Maria 2026-11-02, after the first run left 3084 lines on
 * rows with no pack size): no units_per_pack on the ASIN row and a stored
 * whole-number yield → retailer = the yield, asin = 1 (lossless; fit
 * "whole"). A fractional yield on such a row stays a gap.
 */
export function ratioFromStoredYield(y: number | string | null | undefined, asinUnitsPerPack: number | string | null | undefined): (YieldRatio & { fit: "0.02" | "2dp" | "whole" }) | null {
  const a = toInt(asinUnitsPerPack), yn = Number(y);
  if (!isPosInt(a)) return Number.isNaN(a) && yn >= 1 && Math.abs(yn - Math.round(yn)) < 1e-9 ? { retailer: Math.round(yn), asinUnits: 1, fit: "whole" } : null;
  if (!(yn > 0)) return null;
  const k = yn * a, n = Math.round(k), off = Math.abs(k - n);
  if (n < 1) return null;
  if (off <= 0.02 + 1e-9) return { retailer: n, asinUnits: a, fit: "0.02" };
  if (off <= 0.005 * a + 1e-9) return { retailer: n, asinUnits: a, fit: "2dp" };
  return null;
}

/**
 * A stored 2-dp yield read at a known pack (Maria 2026-11-06): the whole retailer units r ≥ 1 whose exact ratio
 * r ÷ pack the stored yield is a sheet rounding of (|y − r ÷ pack| ≤ 0.005: 0.33 → 1/3, 0.67 → 2/3, 0.17 → 1/6),
 * else null. The same value, written exactly — not a cost recompute.
 */
export function retailerUnitsAtPack(y: number | string | null | undefined, pack: number): number | null {
  const yn = Number(y);
  if (!(yn > 0) || !(Number.isInteger(pack) && pack >= 1)) return null;
  const r = Math.round(yn * pack);
  return r >= 1 && Math.abs(yn - r / pack) <= 0.005 + 1e-9 ? r : null;
}

// ── exact arithmetic: fractions over BigInt ──
export interface Frac { num: bigint; den: bigint }
/** qty (≤ 2 dp) × retailer ÷ asin as a fraction. */
export function lineUnitsExact(qty: number, r: YieldRatio): Frac { return { num: BigInt(Math.round(qty * 100)) * BigInt(r.retailer), den: BigInt(100) * BigInt(r.asinUnits) }; }
export function addFrac(a: Frac, b: Frac): Frac { return { num: a.num * b.den + b.num * a.den, den: a.den * b.den }; }
export function cmpFrac(a: Frac, b: Frac): number { const l = a.num * b.den, rr = b.num * a.den; return l < rr ? -1 : l > rr ? 1 : 0; }
/** Half-up to `dp` decimals, once. */
export function fracToNumber(f: Frac, dp = 2): number {
  let scale = BigInt(1);
  for (let i = 0; i < dp; i++) scale *= BigInt(10);
  const two = BigInt(2);
  const q = (f.num * scale * two + f.den) / (two * f.den); // floor((x·scale) + ½)
  return Number(q) / Number(scale);
}

export interface YieldLine { qty_ordered: number | string | null; asin_qty_per_product?: number | string | null; retailer_units_per_product?: number | string | null; asin_units_per_pack?: number | string | null }
/**
 * An ASIN row's Ordered from its lines. Every line with a ratio is summed
 * exactly (a bundle: the scarcest component's sets); a line without one adds
 * qty × its stored yield (read through `legacy`, trueYield in the app). Rounded
 * once, 2 dp.
 */
export function asinUnitsFromLines(lines: ReadonlyArray<YieldLine>, soldAs: string, legacy: (y: number) => number = (y) => y): { qty: number; uniqueProducts: number | null } {
  const per = lines.map((l) => {
    const qty = Number(l.qty_ordered) || 0, r = lineRatio(l);
    return r ? lineUnitsExact(qty, r) : { num: BigInt(Math.round(qty * legacy(Number(l.asin_qty_per_product ?? 1) || 1) * 1e6)), den: BigInt(1000000) };
  });
  if (soldAs === "bundle") {
    if (per.length === 0) return { qty: 0, uniqueProducts: 1 };
    const min = per.reduce((m, x) => (cmpFrac(x, m) < 0 ? x : m));
    return { qty: fracToNumber(min), uniqueProducts: Math.max(lines.length, 1) };
  }
  return { qty: fracToNumber(per.reduce(addFrac, { num: BigInt(0), den: BigInt(1) })), uniqueProducts: null };
}
