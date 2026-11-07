// Cost allocation for a PO's ASIN rows — the ONE place the formula lives
// (New PO form via shared/po-form.ts, the PO editor's recompute via
// server/po-costs.ts). Patch docs/claude_spec-patch-po-ai-prefill.md §7.1 as
// corrected by Maria 2026-11-04 (formula v3; "my 10/31 instruction was
// wrong"). Applies to NEW and EDITED POs only: historical rows keep the
// sheet's values verbatim and are never recomputed
// (purchase_orders.cost_formula_version IS NULL).
//
// COGS INCLUDES the supplier's tax and shipping / handling, MINUS coupons,
// sales and the gift-card discount %. Rewards are Maria's call per PO (the
// promo's COGS toggle, default off — a non-counting promo is ADDED BACK).
// Cashback never counts. Everything is allocated pro rata over the LINE
// TOTALS (a line's total as captured; price × qty when none was stored), so
// a line whose total ÷ qty is not whole cents (79.70 ÷ 30) costs exactly.
//
//   L                = Σ line totals of the PO (the allocation base)
//   countingDiscount = discount − Σ amount(promos that do not count)
//   base_counting    = L − countingDiscount + tax + shipping
//   base_paid        = L − discount + tax + shipping                (every discount)
//   Sourcing cost (col AR) = Σ(line total_i) × base_counting ÷ L ÷ ASIN qty  → Update COGS in SC
//   COGS (col Y)           = Sourcing × (1 − gift-card %) + adjustment       → actual_cogs, Aura, repricing
//   Paid cost              = Σ(line total_i) × base_paid ÷ L ÷ ASIN qty × (1 − gift-card %)
//   Adjusted product cost (col X) = unit price × base_counting ÷ L × (1 − gift-card %)  (stored per line)
// Rounded to the cent once at the end of each figure. When the line totals
// already carry the discount (discountReflectedInLines), the discount and
// promos count for nothing — not subtracted again, nothing added back.
//
// v1 (2026-10-18) was price × (order total ÷ subtotal) × (1 − GC %); v2
// (2026-10-31) left tax and shipping out — wrong, per Maria 2026-11-04.
// Neither is a reproduction of the sheet (the probe doc records why no single
// rule can be: the sheet's X formula varies per order).

export const COST_FORMULA_VERSION = 3;

export interface CostHeader {
  /** Σ line totals the costs are allocated over (the typed subtotal when the lines are pre-discount and it is known). */
  subtotal: number;
  discount: number;          // the order-level discount as shown at checkout (0 when none)
  gcPct: number | null;      // weighted gift-card discount, percent (2.15 = 2.15 %)
  /** Σ amount of the promos that do NOT count toward COGS (rewards) — added back. */
  nonCountingPromoAmount?: number;
  /** The supplier's tax — in COGS since v3. */
  tax?: number;
  /** The supplier's shipping / handling (purchase_orders.sh_donations) — in COGS since v3. */
  shDonations?: number;
  /**
   * Free-item deals (2026-11-06, migration 097): Σ allocation weights over the whole PO — each line's regular price × qty,
   * else its money. Absent = `subtotal` (allocation by line totals, as before).
   */
  allocationBase?: number;
  /** Kept for callers that still pass them; never used. */
  orderTotal?: number;
  cashbackPct?: number | null;
}
/** One product line: its unit price (full precision) and qty; lineTotal = the line's money as captured (else price × qty). */
export interface CostLine { price: number | null; qty: number; lineTotal?: number | null; /** Unit price before a multi-buy deal (migration 097); the line then weighs regularPrice × qty. */ regularPrice?: number | null }
export interface AsinCosts {
  /** Col AR: before the gift-card discount, counting promos applied. */
  sourcing: number;
  /** Col Y: sourcing × (1 − GC %) + adjustment. */
  cogs: number;
  /** Every discount counted, × (1 − GC %). */
  paid: number;
  /** cogs without the adjustment. */
  cogsBeforeAdjustment: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const fin = (x: number | undefined | null) => (x != null && Number.isFinite(x) ? x : 0);
const gcFactor = (h: CostHeader) => 1 - (h.gcPct != null && Number.isFinite(h.gcPct) ? h.gcPct / 100 : 0);
/** base ÷ W: what one unit of allocation weight costs once discounts, tax and shipping are allocated (W = L without a deal). */
const ratio = (h: CostHeader, discount: number) => {
  const w = h.allocationBase != null && h.allocationBase > 0 ? h.allocationBase : h.subtotal;
  return w > 0 ? (h.subtotal - discount + fin(h.tax) + fin(h.shDonations)) / w : 1;
};
// Never below 0: a non-counting promo larger than the header discount cannot raise the cost above the price paid.
const countingDiscount = (h: CostHeader) => Math.max(0, (h.discount || 0) - (h.nonCountingPromoAmount || 0));

/** A line's money: its stored / captured total, else price × qty; null when neither is known. */
export function lineMoney(l: CostLine): number | null {
  if (l.lineTotal != null && Number.isFinite(l.lineTotal)) return l.lineTotal;
  if (l.price == null || !Number.isFinite(l.price)) return null;
  return l.price * l.qty;
}

/** A line's allocation weight: regular price × qty under a free-item deal (migration 097), else its money. */
export function lineWeight(l: CostLine): number | null {
  if (l.regularPrice != null && Number.isFinite(l.regularPrice) && l.regularPrice > 0) return l.regularPrice * l.qty;
  return lineMoney(l);
}
/** Σ weights when any line carries a regular price — the header's allocationBase; undefined otherwise. */
export function allocationBaseOf(lines: readonly CostLine[]): number | undefined {
  if (!lines.some((l) => l.regularPrice != null && Number.isFinite(l.regularPrice) && l.regularPrice > 0)) return undefined;
  let w = 0;
  for (const l of lines) { const x = lineWeight(l); if (x == null) return undefined; w += x; }
  return w > 0 ? w : undefined;
}

/** Tolerance of the reflected check: 1¢ (Maria 2026-11-04 — line totals vs the pre- / post-discount subtotal). */
export const REFLECTED_TOLERANCE = 0.01;

/**
 * Maria 2026-11-01 (the first real PO, Walmart): the line price $7.97 was already the sale price and the
 * "sale $36.12" promo was subtracted again → COGS 29.76 instead of 47.82. A discount / promo reduces a cost
 * ONLY when the line totals are pre-discount. When Σ line totals equals the post-discount subtotal (order
 * total − tax − shipping) within 1¢, the discount and the promos are informational: nothing reduces COGS or
 * Paid, the COGS toggle defaults off, nothing is "added back". Pure.
 */
export function discountReflectedInLines(a: { linesSum: number; discount: number; promoAmounts?: number; postDiscountSubtotal: number | null }): boolean {
  const d = (a.discount || 0) + (a.promoAmounts || 0);
  if (!(d > 0) || !(a.linesSum > 0) || a.postDiscountSubtotal == null || !Number.isFinite(a.postDiscountSubtotal)) return false;
  // The typed subtotal is not consulted: a retailer that shows the subtotal after a sale (Walmart) has lines = subtotal = post-discount.
  return Math.abs(a.linesSum - a.postDiscountSubtotal) <= REFLECTED_TOLERANCE + 1e-9;
}
/** The cost header with the reflected rule applied: a reflected discount / promo set counts for nothing. */
export function effectiveCostHeader(h: CostHeader, reflected: boolean): CostHeader {
  return reflected ? { ...h, discount: 0, nonCountingPromoAmount: 0 } : h;
}

/**
 * The double-discount rule per promo (Maria 2026-11-05, Michaels 4300109060826629: the paint line was already $4.19 after
 * MEGA30DEAL −$18.00, and the combined $28 was subtracted again → 6.37 / 3.11 instead of 7.04 / 3.44). Which promos are
 * already in the line totals:
 *   - all of them when Σ line totals = the post-discount subtotal within 1¢ (discountReflectedInLines, unchanged);
 *   - else the ONE subset of promos whose amounts close the gap subtotal − Σ line totals within 1¢ — those reduce nothing,
 *     the rest are applied as usual. Several subsets fit → `ambiguous`: every promo in any of them is NOT subtracted
 *     (COGS errs high, never low — Maria 2026-11-06) and needs her answer (`needsAnswer`; the form blocks Create PO / Save).
 *   - `answers[i]` (po_promos.in_line_prices) is that answer and always wins: true = in the prices, false = subtract it.
 * A promo without an amount, when it is the only one and the header discount exceeds the others, is taken at the
 * difference (`implied`). Pure.
 */
export interface PromoReflection {
  /** Every promo and the discount are already in the line totals. */
  all: boolean;
  /** Per promo (input order): already in the line totals. */
  reflected: boolean[];
  /** Σ amount of the reflected promos (the header discount when `all`). */
  reflectedAmount: number;
  /** Per promo: the amount used — the stored one, else the implied one, else null. */
  amounts: Array<number | null>;
  /** More than one subset of promos fits the gap: which promos are already in the prices is Maria's call. */
  ambiguous: boolean;
  /** The subsets that fit, as promo indexes (for the ambiguity flag). */
  fits: number[][];
  /** Promos Maria must answer "already in the prices?" for before the PO saves (ambiguous, no answer yet). */
  needsAnswer: number[];
}
const MAX_SUBSET_PROMOS = 12;
/**
 * Pure: each promo's $ in its sequence (Maria 2026-11-06). A $ promo takes its amount at its position; a % promo takes
 * its % of the running total — so $10 then 20% on $100 = 10 + 18 (pays $72), 20% then $10 = 20 + 10 (pays $70), and %
 * after % multiplies (Yankee: $699.80 × 0.5 × 0.85 = $297.41, never 65% off). Null where a promo has neither.
 */
export function sequencedPromoAmounts(base: number, promos: ReadonlyArray<{ amount: number | null; percent: number | null }>): Array<number | null> {
  let running = Number.isFinite(base) ? base : 0;
  return promos.map((p) => {
    const d = p.amount != null && Number.isFinite(p.amount) ? p.amount : p.percent != null && Number.isFinite(p.percent) && p.percent > 0 ? r2(running * p.percent / 100) : null;
    if (d != null) running = r2(running - d);
    return d;
  });
}
export function reflectedPromos(a: { linesSum: number; subtotal: number | null; discount: number; promoAmounts: ReadonlyArray<number | null>; postDiscountSubtotal: number | null; answers?: ReadonlyArray<boolean | null | undefined>;
  /** Per promo its type (sale / coupon / rewards): a rewards voucher is applied at the total, never in a line price. */
  kinds?: ReadonlyArray<string | null | undefined>;
  /** Per promo its %, and the total the first one applies to (Σ regular price × qty when the lines carry one, else the subtotal): a % promo without a $ amount takes its sequenced amount. */
  percents?: ReadonlyArray<number | null>; sequenceBase?: number | null }): PromoReflection {
  const auto = autoReflected(a);
  const ans = a.answers ?? [];
  if (!ans.some((x) => x != null)) return auto;
  if (auto.all && ans.every((x) => x == null || x === true)) return auto;
  const reflected = auto.reflected.map((r, i) => (ans[i] != null ? !!ans[i] : r));
  return { ...auto, all: false, reflected, reflectedAmount: r2(reflected.reduce((t, x, i) => t + (x ? auto.amounts[i] ?? 0 : 0), 0)), needsAnswer: auto.needsAnswer.filter((i) => ans[i] == null) };
}
function autoReflected(a: { linesSum: number; subtotal: number | null; discount: number; promoAmounts: ReadonlyArray<number | null>; postDiscountSubtotal: number | null; kinds?: ReadonlyArray<string | null | undefined>; percents?: ReadonlyArray<number | null>; sequenceBase?: number | null }): PromoReflection {
  const n = a.promoAmounts.length, discount = a.discount || 0;
  const amounts = a.promoAmounts.map((x) => (x != null && Number.isFinite(x) ? x : null));
  const missing = amounts.map((x, i) => (x == null ? i : -1)).filter((i) => i >= 0);
  const known = amounts.reduce<number>((t, x) => t + (x ?? 0), 0);
  // The page's own $ first: the one amount-less promo takes the discount − the others; else a % promo its sequenced amount.
  if (missing.length === 1 && discount - known > REFLECTED_TOLERANCE) amounts[missing[0]] = r2(discount - known);
  else if (a.percents && missing.length > 0) {
    const base = a.sequenceBase != null && a.sequenceBase > 0 ? a.sequenceBase : a.subtotal ?? a.linesSum;
    const seq = sequencedPromoAmounts(base, amounts.map((x, i) => ({ amount: x, percent: a.percents![i] ?? null })));
    for (const i of missing) amounts[i] = seq[i];
  }
  const none: PromoReflection = { all: false, reflected: amounts.map(() => false), reflectedAmount: 0, amounts, ambiguous: false, fits: [], needsAnswer: [] };
  const gap = a.subtotal != null && Number.isFinite(a.subtotal) ? a.subtotal - a.linesSum : 0;
  // Sale / coupon vs rewards (Maria 2026-11-07, Michaels 4600111212062213): the lines can carry only the sale / coupon promos, so
  // they are compared with subtotal − those promos — Σ line totals = the post-discount subtotal + the rewards (80.30 = 60.30 + 20).
  // When the subtotal is the regular-price total, the one sale / coupon promo is subtotal − Σ line totals (34.50), whatever was typed.
  const isRewards = (i: number) => a.kinds?.[i] === "rewards";
  const others = amounts.map((_, i) => i).filter((i) => !isRewards(i));
  const pinOne = () => { if (a.kinds && others.length === 1 && gap > REFLECTED_TOLERANCE) amounts[others[0]] = r2(gap); };
  const rewards = a.kinds ? amounts.reduce<number>((t, x, i) => t + (isRewards(i) ? x ?? NaN : 0), 0) : 0;
  if (discountReflectedInLines({ linesSum: a.linesSum, discount, promoAmounts: discount > 0 ? 0 : known, postDiscountSubtotal: a.postDiscountSubtotal })) {
    if (!(rewards > 0)) pinOne();
    return { ...none, all: true, reflected: amounts.map(() => true), reflectedAmount: discount > 0 ? discount : known };
  }
  if (rewards > 0 && others.length > 0 && a.postDiscountSubtotal != null && Math.abs(a.linesSum - (a.postDiscountSubtotal + rewards)) <= REFLECTED_TOLERANCE + 1e-9) {
    pinOne();
    const inLines = gap > REFLECTED_TOLERANCE ? gap : discount - rewards > REFLECTED_TOLERANCE ? discount - rewards : others.reduce((t, i) => t + (amounts[i] ?? 0), 0);
    return { ...none, reflected: amounts.map((_, i) => !isRewards(i)), reflectedAmount: r2(inLines), fits: [others] };
  }
  if (!(gap > REFLECTED_TOLERANCE) || n === 0 || n > MAX_SUBSET_PROMOS) return none;
  const fits: number[][] = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0, ok = true;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { const x = amounts[i]; if (!(x != null && x > 0)) { ok = false; break; } sum += x; idx.push(i); }
    if (ok && Math.abs(sum - gap) <= REFLECTED_TOLERANCE + 1e-9) fits.push(idx);
  }
  if (fits.length === 0) return none;
  if (fits.length > 1) {
    // Ambiguous: none of the candidates is subtracted (COGS errs high) until Maria answers.
    const cand = Array.from(new Set(fits.flat())).sort((x, y) => x - y);
    const reflected = amounts.map((_, i) => cand.includes(i));
    return { ...none, reflected, reflectedAmount: r2(cand.reduce((t, i) => t + (amounts[i] ?? 0), 0)), ambiguous: true, fits, needsAnswer: cand };
  }
  const reflected = amounts.map((_, i) => fits[0].includes(i));
  return { ...none, reflected, reflectedAmount: r2(fits[0].reduce((t, i) => t + (amounts[i] ?? 0), 0)), fits };
}
/**
 * The cost header with the per-promo rule applied: reflected promos leave the discount and are never added back; the
 * allocation base is Σ line totals once any promo is in them. `promos[i].counts` is the COGS toggle (rewards default off).
 */
export function promoCostHeader(h: CostHeader, linesSum: number, promos: ReadonlyArray<{ counts: boolean }>, r: PromoReflection): CostHeader {
  if (r.all) return { ...h, subtotal: linesSum, discount: 0, nonCountingPromoAmount: 0 };
  const nonCounting = r2(promos.reduce((t, p, i) => t + (!r.reflected[i] && p.counts === false ? (r.amounts[i] ?? 0) : 0), 0));
  if (!(r.reflectedAmount > 0)) return { ...h, nonCountingPromoAmount: nonCounting };
  // A reflected promo leaves the header discount only as far as the discount holds it (2026-11-06, Yankee Candle: the B2G2
  // $349.90 is in the line prices but was never part of the $52.49 order discount — the coupon still counts).
  const others = r2(promos.reduce((t, _p, i) => t + (!r.reflected[i] ? r.amounts[i] ?? 0 : 0), 0));
  const inDiscount = Math.min(r.reflectedAmount, Math.max(0, (h.discount || 0) - others));
  return { ...h, subtotal: linesSum, discount: Math.max(0, r2((h.discount || 0) - inDiscount)), nonCountingPromoAmount: nonCounting };
}

/** One product's adjusted cost (the sheet's Col X role): unit price × base_counting ÷ L × (1 − GC %), rounded to the cent. */
export function adjustedProductCost(price: number | null, h: CostHeader): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  return r2(price * ratio(h, countingDiscount(h)) * gcFactor(h));
}

/** The three costs of an ASIN row. Null when any product lacks money or the ASIN qty is 0. */
export function allocateAsinCosts(h: CostHeader, lines: readonly CostLine[], asinQty: number, adjustment = 0): AsinCosts | null {
  if (!(asinQty > 0)) return null;
  let money = 0;
  for (const l of lines) { const m = h.allocationBase != null ? lineWeight(l) : lineMoney(l); if (m == null) return null; money += m; }
  const counting = money * ratio(h, countingDiscount(h)), all = money * ratio(h, h.discount || 0);
  const sourcing = r2(counting / asinQty);
  const cogsBeforeAdjustment = r2((counting / asinQty) * gcFactor(h));
  const adj = Number.isFinite(adjustment) ? adjustment : 0;
  return { sourcing, cogsBeforeAdjustment, cogs: r2(cogsBeforeAdjustment + adj), paid: r2((all / asinQty) * gcFactor(h)) };
}

/** COGS per ASIN unit before any adjustment (the sheet's Col Y role). Kept for the fixture measurement and older callers. */
export function costPerUnitPrefill(h: CostHeader, lines: readonly CostLine[], asinQty: number): number | null {
  return allocateAsinCosts(h, lines, asinQty)?.cogsBeforeAdjustment ?? null;
}
