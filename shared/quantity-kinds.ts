/**
 * Quantity vocabulary (SPEC §22 "Quantity vocabulary", patch
 * docs/claude_spec-patch-quantity-names.md, Maria 2026-11-09).
 *
 * AF has three quantity kinds and one name each:
 *   Individual units — physical items; what Velocity counts and uploads
 *   Product units    — items as sold on the supplier's site (a case, a 2-pack, a single)
 *   ASIN units       — sellable units of the Amazon listing
 * and two ratios: Individual units per Product unit, Individual units per
 * ASIN unit ("pack size"). Never "retailer units", "component units",
 * "quantity", "qty" alone or "units" alone. Every quantity label names its
 * kind — as a small muted line ABOVE the header text (the Actual /
 * Estimated pattern), never in parentheses.
 */
export const QTY_KIND = {
  asin: "ASIN units",
  product: "Product units",
  individual: "Individual units",
} as const;
export type QtyKind = (typeof QTY_KIND)[keyof typeof QTY_KIND];

/** The two ratios' names. */
export const PER_ASIN_UNIT = "Individual units per ASIN unit";
export const PER_PRODUCT_UNIT = "Individual units per Product unit";

/** The short form under a main number ("45 indiv."). */
export const INDIV_SHORT = "indiv.";

/**
 * Pure: the Individual-units equivalent of a stored quantity at a pack size
 * (today's storage: individual = stored × pack size). Null when either is
 * unknown — the display shows "—" in grey, never 0.
 */
export function individualFrom(v: string | number | null | undefined, perUnit: string | number | null | undefined): number | null {
  if (v == null || v === "" || perUnit == null || perUnit === "") return null;
  const n = Number(v), p = Number(perUnit);
  if (!Number.isFinite(n) || !Number.isFinite(p) || p <= 0) return null;
  return Math.round(n * p * 100) / 100;
}

/** Pure: "N <kind>" with the noun always plural-safe ("1 ASIN unit", "2 ASIN units"). */
export function kindCount(n: number, kind: QtyKind): string {
  const noun = kind.replace(/ units$/, "");
  return `${n} ${noun} unit${n === 1 ? "" : "s"}`;
}
