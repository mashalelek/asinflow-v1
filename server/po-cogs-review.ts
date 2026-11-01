// COGS review (Maria 2026-11-01, review answer 4): per sheet-imported PO ASIN
// row, AF's stored cost / unit (col Y as imported) vs the sheet's PO-level
// Adjusted COGS computed the way AF computes it — the ASIN's product rows'
// Adjusted Product Cost (col X) × units ordered (col L), summed, ÷ the ASIN
// qty (col N), bundle-aware: an S=1 group of several rows merges additively
// (Σ N), a bundle (S ≥ 2) or a single row takes the first row's N. The
// sheet's own col Y is carried alongside (AF's import copies it: verbatim,
// or the N-weighted average over an S=1 merge). Pure; the driver is
// script/po-cogs-review.ts. Nothing here changes a stored value.

export interface SheetProductRow {
  productName: string;
  status: string;
  price: number | null;
  qtyOrdered: number | null;
  asinQty: number | null;          // col N
  uniqueProducts: number | null;   // col S
  yieldPerProduct: number | null;  // col T
  adjProductCost: number | null;   // col X
  adjCogs: number | null;          // col Y
  soldAs: string;                  // col AX
  unitsPerPack: string;            // col AY
}

export interface SheetCogs {
  mode: "single" | "s1-merge" | "bundle" | "mixed";
  asinQty: number | null;
  /** Σ(X × L) ÷ ASIN qty — "the way AF computes it". */
  computed: number | null;
  /** The sheet's col Y as AF's import would store it. */
  sheetY: number | null;
  productSum: number | null;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function sheetCogsForAsin(rows: readonly SheetProductRow[]): SheetCogs {
  if (rows.length === 0) return { mode: "single", asinQty: null, computed: null, sheetY: null, productSum: null };
  const s = rows.map((r) => r.uniqueProducts ?? 1);
  const bundle = s.every((v) => v >= 2), s1 = s.every((v) => v <= 1);
  if (rows.length > 1 && !bundle && !s1) return { mode: "mixed", asinQty: null, computed: null, sheetY: null, productSum: null };
  const mode: SheetCogs["mode"] = rows.length > 1 ? (s1 ? "s1-merge" : "bundle") : "single";
  const asinQty = mode === "s1-merge" ? r2(rows.reduce((a, r) => a + (r.asinQty ?? 0), 0)) : rows[0].asinQty;
  const usable = rows.filter((r) => r.adjProductCost != null && r.qtyOrdered != null);
  const productSum = usable.length === rows.length ? r2(rows.reduce((a, r) => a + r.adjProductCost! * r.qtyOrdered!, 0)) : null;
  const computed = productSum != null && asinQty != null && asinQty > 0 ? r2(productSum / asinQty) : null;
  let sheetY: number | null;
  if (mode === "s1-merge") {
    const ys = Array.from(new Set(rows.map((r) => (r.adjCogs == null ? "NULL" : r.adjCogs.toFixed(2)))));
    if (ys.length === 1) sheetY = rows[0].adjCogs;
    else {
      const u = rows.filter((r) => r.adjCogs != null && (r.asinQty ?? 0) > 0);
      const tot = u.reduce((a, r) => a + r.asinQty!, 0);
      sheetY = tot > 0 ? r2(u.reduce((a, r) => a + Math.round(r.adjCogs! * 100) * r.asinQty!, 0) / tot / 100) : null;
    }
  } else sheetY = rows[0].adjCogs;
  return { mode, asinQty, computed, sheetY, productSum };
}

/** |a − b| > tolerance, null-safe (a missing side never "matches"). */
export function differs(a: number | null, b: number | null, tolerance = 0.02): boolean {
  if (a == null || b == null) return true;
  return Math.abs(a - b) > tolerance + 1e-9;
}

/** Rows Maria has already answered (review answer 4): by order # or ASIN. */
export const ANSWERED_ORDERS = new Set(["71160468", "200015550741831", "200012284456368", "4802299447"]);
export const ANSWERED_ASINS = new Set(["B07K889YZ7", "B0G6R55GNQ", "B07N13K4SS", "B006T0U4R4"]);
export function isAnswered(orderId: string, asin: string): boolean {
  const o = orderId.replace(/[^0-9A-Za-z]/g, "");
  return ANSWERED_ORDERS.has(o) || Array.from(ANSWERED_ORDERS).some((x) => o.startsWith(x)) || ANSWERED_ASINS.has(asin.toUpperCase());
}
