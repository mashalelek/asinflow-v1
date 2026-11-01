// New PO form model (patch docs/claude_spec-patch-po-af-owned.md §4,
// 2026-10-18). The form's state is this plain JSON shape — every value a
// string as typed — so the AI-prefill patch can fill it without touching the
// UI. The same validator runs live in the browser and again on the server
// before anything is written; the server is the authority.
//
// Rules:
//   - supplier, order #, order date required; (supplier, order #) unique (server).
//   - at least one product; each: whole qty ≥ 1, price ≥ 0, a 10-character
//     ASIN, yield > 0.
//   - products of one ASIN agree on sold as / units per pack / prep.
//   - pack math: an ASIN's Ordered = Σ qty × yield (2 decimals); a non-whole
//     number of ASIN units is allowed with a warning (Upload to Velocity
//     skips it — Velocity only accepts whole packs); a bundle's components
//     must give the same number of sets.
//   - live totals: subtotal = Σ price × qty (a typed subtotal that differs is
//     a warning, not an error).
// Costs per ASIN row come from shared/po-cost.ts (formula v2, patch
// po-ai-prefill §7.1 as corrected 2026-10-31): Sourcing cost (col AR), COGS
// (col Y, + the per-ASIN adjustment) and Paid cost; COGS can be overridden
// per ASIN. Promos (several per PO, §7.2) decide what counts: a promo with
// counts_toward_cogs = false (rewards, by default) is added back.

import { adjustedProductCost, allocateAsinCosts, discountReflectedInLines, effectiveCostHeader, COST_FORMULA_VERSION, type CostHeader } from "./po-cost";
/** Stamped on purchase_orders.cost_formula_version by every form save; NULL = imported, never recomputed. */
export const COST_FORMULA_VERSION_SAVED = COST_FORMULA_VERSION;

/** Shown (not blocking) on an ASIN whose Ordered is not a whole number. */
export const WHOLE_PACKS_WARNING = "Upload to Velocity will skip this line — Velocity only accepts whole packs";

export const SOLD_AS_OPTIONS = ["individual", "multi-pack", "bundle"] as const;
export type SoldAs = (typeof SOLD_AS_OPTIONS)[number];
export const PROMO_TYPES = ["sale", "coupon", "rewards"] as const;
export type PromoType = (typeof PROMO_TYPES)[number];
/** §7.2 default: sale and coupon count toward COGS, rewards does not. A promo already reflected in the line prices (Maria 2026-11-01) defaults off whatever its type. */
export const promoCountsByDefault = (type: string, discountReflected = false): boolean => !discountReflected && type !== "rewards";
/** The note beside a promo's COGS toggle when the line prices already carry the discount. */
export const PROMO_REFLECTED_NOTE = "already reflected in line prices";

/**
 * Payment-method aliases (settings.po_payment_method_aliases, Maria 2026-11-01): "OnePay Cash" = "Walmart card" —
 * one instrument, two names — so history matches. The canonical name wins when the typed / captured nickname is the
 * alias or starts with it (case and punctuation ignored); anything else is returned trimmed. Pure.
 */
export function canonicalPaymentName(nickname: string, aliases: Record<string, string> | null | undefined): string {
  const norm = (x: string) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const n = norm(nickname);
  if (!n || !aliases) return String(nickname ?? "").trim();
  for (const [alias, canonical] of Object.entries(aliases)) {
    const a = norm(alias);
    if (a && (n === a || n.startsWith(a))) return String(canonical).trim();
  }
  return String(nickname ?? "").trim();
}

export interface PoFormPromo {
  type: PromoType | "";
  description: string;
  amount: string;   // $ off the order, when stated
  percent: string;  // % off, when stated
  counts_toward_cogs: boolean;
}
export interface PoFormAdjustment { amount: string; reason: string }
export const PAYMENT_METHODS = ["card", "gift_card", "store_credit", "paypal", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export interface PoFormPayment {
  method: PaymentMethod | "";
  nickname: string;
  last4: string;
  amount: string;
  gift_card_discount_pct: string; // gift cards only
}
export const emptyPayment = (method: PaymentMethod = "card"): PoFormPayment => ({ method, nickname: "", last4: "", amount: "", gift_card_discount_pct: "" });
export const CASHBACK_STATUSES = ["pending", "received", "denied"] as const;
/** Where a prefilled value came from (§6.1 markers): "model" = amber, "af" = stone; absent = typed. */
export type PrefillSource = "model" | "af";
export interface PoFormPrefill {
  /** The server-side cache key of the capture (po_prefill_log.po_id is set from it on save). */
  id?: string;
  supplier?: string | null;
  pages?: number;
  captured_at?: string | null;
  warnings?: string[];
  /** Field path → source. Header: "supplier"; product: "products.0.price"; ASIN rows: "asin.B0…"; promo: "promos.0". */
  sources: Record<string, PrefillSource>;
  /** Field path → a tooltip on an amber field explaining a server-side correction (2026-11-01: "qty inferred from subtotal"). Cleared with the marker. */
  hints?: Record<string, string>;
  /** The raw-text fallback (schema failure): the captured text for the side drawer. */
  raw_text?: string | null;
}
export const emptyPromo = (type: PromoType = "sale"): PoFormPromo => ({ type, description: "", amount: "", percent: "", counts_toward_cogs: promoCountsByDefault(type) });

export interface PoFormProduct {
  product_name: string;
  supplier_sku: string;
  price: string;
  qty_ordered: string;
  /** The retailer's pack (e.g. a 12-count) — drives the yield: qty × retailer units ÷ ASIN units per pack (§6.5). Form-only. */
  retailer_units_per_pack?: string;
  asin: string;
  asin_qty_per_product: string; // yield
  /** The yield / ASIN qty was typed by hand (the pack math no longer overwrites it). Form-only. */
  yield_manual?: boolean;
  /** The retailer line this product row belongs to — a split's copies share it (shared/po-lines.ts). Form-only; the server ignores it. */
  line_id?: string;
  /** The bundle box this line sits in (several products → one ASIN). Form-only; the server ignores it. */
  bundle_id?: string;
  sold_as: SoldAs;
  units_per_pack: string;
  prep_cost: string;
  notes?: string;
}

export interface PoFormState {
  supplier: string;
  order_id: string;
  order_date: string; // YYYY-MM-DD
  subtotal: string;
  tax: string;
  sh_donations: string;
  discount: string;
  refund_amount: string;
  order_total: string;
  payment_method: string;
  weighted_gc_discount_pct: string;
  cashback_site: string;
  cashback_pct: string;
  purchased_by: string;
  notes: string;
  /** Where the PO ships (SPEC §26): "velocity" (default) | "home". Optional for forms saved before it existed. */
  ships_to?: string;
  products: PoFormProduct[];
  /** ASIN → cost / unit typed by hand; absent = the computed value. */
  cost_overrides: Record<string, string>;
  /** §7.2: the order's promos; absent on forms saved before they existed. */
  promos?: PoFormPromo[];
  /** §6.5: ASIN → COGS adjustment (amount + reason, e.g. "prep materials $3"). */
  cogs_adjustments?: Record<string, PoFormAdjustment>;
  /** §8.2: the order's payments; Σ amount should equal the order total (a warning). */
  payments?: PoFormPayment[];
  email_used?: string;
  /** users.id of the purchaser (defaults to the logged-in user); purchased_by keeps the display name. */
  purchased_by_user_id?: string;
  cashback_status?: string;
  /** §9: the checkout showed a subscription. */
  subscription?: { present: boolean; frequency_weeks: string };
  /** §6.5 pack override: ASIN → true = "Update ASIN in AF" (false / absent = this PO only). */
  pack_updates?: Record<string, boolean>;
  /** §6.1: where the prefilled values came from; absent on a hand-typed form. */
  prefill?: PoFormPrefill;
}

/**
 * Ships to from prep cost (SPEC §26, Maria 2026-10-22): any product line with
 * prep > 0 (Maria enters $1 for Velocity) → "velocity"; otherwise "home".
 * The New PO form's default — editable; the same rule as the backfill.
 */
export function shipsToFromForm(form: Pick<PoFormState, "products">): "velocity" | "home" {
  return form.products.some((p) => { const v = Number(String(p.prep_cost ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(v) && v > 0; }) ? "velocity" : "home";
}

export const emptyProduct = (): PoFormProduct => ({ product_name: "", supplier_sku: "", price: "", qty_ordered: "", retailer_units_per_pack: "1", asin: "", asin_qty_per_product: "1", sold_as: "individual", units_per_pack: "1", prep_cost: "1", notes: "" });
/** §6.5 pack math: yield = retailer units per pack ÷ ASIN units per pack (so ASIN qty = qty × retailer ÷ ASIN). */
export function yieldFromPacks(retailerUnitsPerPack: string | undefined, asinUnitsPerPack: string | undefined, soldAs: string): string {
  const r = Number(String(retailerUnitsPerPack ?? "1").trim()) || 1;
  const u = soldAs === "individual" ? 1 : Number(String(asinUnitsPerPack ?? "1").trim()) || 1;
  const y = Math.round((r / u) * 10000) / 10000;
  return String(y > 0 ? y : 1);
}
export const emptyPoForm = (today: string): PoFormState => ({
  supplier: "", order_id: "", order_date: today, subtotal: "", tax: "", sh_donations: "", discount: "", refund_amount: "", order_total: "",
  payment_method: "", weighted_gc_discount_pct: "", cashback_site: "", cashback_pct: "", purchased_by: "", notes: "",
  products: [emptyProduct()], cost_overrides: {}, promos: [], cogs_adjustments: {}, payments: [], email_used: "", purchased_by_user_id: "", cashback_status: "",
  subscription: { present: false, frequency_weeks: "" }, pack_updates: {},
});

const t = (s: unknown) => (typeof s === "string" ? s.trim() : s == null ? "" : String(s).trim());
const moneyNum = (s: string): number | null => { const v = t(s).replace(/[$,\s]/g, ""); return v === "" ? null : /^-?\d+(\.\d{1,2})?$/.test(v) ? Number(v) : NaN; };
const r2 = (x: number) => Math.round(x * 100) / 100;
/** A 2-dp yield back to the small fraction it stands for (0.33 → 1/3). Same rule as server/po-af-source.ts trueYield. */
export function trueYield(y: number): number {
  for (let d = 1; d <= 12; d++) { const n = Math.round(y * d); if (n > 0 && Math.abs(y - n / d) < 0.006) return n / d; }
  return y;
}
const isDate = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return false; const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]); };

export interface PoFormAsin {
  asin: string;
  sold_as: SoldAs;
  units_per_pack: number;
  prep_cost: string;
  qty: number;                 // Ordered, ASIN units
  unique_products: number | null;
  cost_per_unit: string | null;          // COGS as saved: the override, else computed (adjustment included)
  computed_cost_per_unit: string | null; // COGS computed (adjustment included)
  sourcing_cost: string | null;          // col AR
  paid_cost: string | null;
  cogs_adjustment: string | null;
  cogs_adjustment_reason: string | null;
  lines: Array<{ index: number; product_name: string | null; supplier_sku: string | null; price: string | null; qty_ordered: number; asin_qty_per_product: string; adjusted_product_cost: string | null; position: number; notes: string | null }>;
}

export interface PoFormCheck {
  ok: boolean;
  errors: string[];                       // blocking
  warnings: string[];                     // shown, not blocking
  productErrors: Record<number, string[]>; // by product index
  computedSubtotal: number;
  effectiveOrderTotal: number;
  /** Σ amount of the promos that do not count toward COGS (added back); 0 when the discount is already in the line prices. */
  nonCountingPromoAmount: number;
  /** Maria 2026-11-01: Σ price × qty already equals the post-discount subtotal — the discount / promos are informational, nothing reduces a cost. */
  discountReflected: boolean;
  /** Weighted gift-card % = Σ(gift-card amount × its GC %) ÷ order total, from the Payments block; null when no gift-card payment carries both. */
  weightedGcPct: number | null;
  asins: PoFormAsin[];
}

/** Validate + derive the rows to write. Pure; used by the form (live) and the server (authoritative). */
export function checkPoForm(f: PoFormState): PoFormCheck {
  const errors: string[] = [], warnings: string[] = [];
  const productErrors: Record<number, string[]> = {};
  const perr = (i: number, m: string) => { (productErrors[i] ??= []).push(m); };
  if (!t(f.supplier)) errors.push("Supplier is required");
  if (!t(f.order_id)) errors.push("Order # is required");
  if (!isDate(t(f.order_date))) errors.push("Order date must be a real date (YYYY-MM-DD)");
  for (const [k, label] of [["subtotal", "Subtotal"], ["tax", "Tax"], ["sh_donations", "S&H + Donations"], ["discount", "Discount"], ["refund_amount", "Refund amount"], ["order_total", "Order total"]] as const) {
    const v = moneyNum(f[k]); if (v != null && (Number.isNaN(v) || v < 0)) errors.push(`${label} must be an amount with at most 2 decimals`);
  }
  for (const [k, label] of [["weighted_gc_discount_pct", "Weighted GC %"], ["cashback_pct", "Cashback %"]] as const) {
    const s = t(f[k]).replace("%", ""); if (s !== "" && (!/^\d+(\.\d{1,4})?$/.test(s) || Number(s) > 100)) errors.push(`${label} must be a percentage between 0 and 100`);
  }
  const products = Array.isArray(f.products) ? f.products : [];
  if (products.length === 0) errors.push("Add at least one product");
  // §7.2 promos: type, money / percent shape. The counting pass runs once the totals are known (the reflected rule needs them).
  const promoList = Array.isArray(f.promos) ? f.promos : [];
  let promoAmounts = 0;
  promoList.forEach((p, i) => {
    const label = `Promo ${i + 1}${t(p.description) ? ` (${t(p.description)})` : ""}`;
    if (!(PROMO_TYPES as readonly string[]).includes(String(p.type))) errors.push(`${label}: type must be sale, coupon or rewards`);
    const amt = moneyNum(p.amount ?? "");
    if (amt != null && (Number.isNaN(amt) || amt < 0)) errors.push(`${label}: amount must be an amount with at most 2 decimals`);
    else if (amt != null) promoAmounts += amt;
    const pc = t(p.percent ?? "").replace("%", "");
    if (pc !== "" && (!/^\d+(\.\d{1,4})?$/.test(pc) || Number(pc) > 100)) errors.push(`${label}: percent must be between 0 and 100`);
  });
  // §8.2 payments: method, last 4, amount; Σ amount vs the order total is checked after the total is known.
  // The weighted gift-card % (Maria 2026-11-01) = Σ(gift-card amount × its GC %) ÷ order total — live from this block, read-only on the form.
  let paymentsSum = 0, paymentsWithAmount = 0, gcWeighted = 0, gcAny = false;
  (Array.isArray(f.payments) ? f.payments : []).forEach((p, i) => {
    const label = `Payment ${i + 1}${t(p.nickname) ? ` (${t(p.nickname)})` : ""}`;
    if (!(PAYMENT_METHODS as readonly string[]).includes(String(p.method))) errors.push(`${label}: method must be card, gift card, store credit, PayPal or other`);
    if (t(p.last4) !== "" && !/^\d{4}$/.test(t(p.last4))) errors.push(`${label}: last 4 must be four digits`);
    const amt = moneyNum(p.amount ?? "");
    if (amt != null && (Number.isNaN(amt) || amt < 0)) errors.push(`${label}: amount must be an amount with at most 2 decimals`);
    else if (amt != null) { paymentsSum += amt; paymentsWithAmount++; }
    const gc = t(p.gift_card_discount_pct ?? "").replace("%", "");
    if (gc !== "" && (!/^\d+(\.\d{1,4})?$/.test(gc) || Number(gc) > 100)) errors.push(`${label}: gift-card discount must be a percentage between 0 and 100`);
    else if (p.method === "gift_card" && gc !== "" && amt != null && !Number.isNaN(amt)) { gcWeighted += amt * Number(gc); gcAny = true; }
  });
  if (t(f.email_used ?? "") !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t(f.email_used ?? ""))) errors.push("Email used must be an email address");
  if (t(f.cashback_status ?? "") !== "" && !(CASHBACK_STATUSES as readonly string[]).includes(t(f.cashback_status ?? ""))) errors.push("Cashback status must be pending, received or denied");
  if (f.subscription?.present && t(f.subscription.frequency_weeks) !== "" && !(/^\d+$/.test(t(f.subscription.frequency_weeks)) && Number(f.subscription.frequency_weeks) > 0)) errors.push("Subscription frequency must be a whole number of weeks");
  if (t(f.purchased_by_user_id ?? "") !== "" && !/^\d+$/.test(t(f.purchased_by_user_id ?? ""))) errors.push("Purchased by must be a user");

  let computedSubtotal = 0;
  products.forEach((p, i) => {
    const qty = t(p.qty_ordered);
    if (!/^\d+(\.\d{1,2})?$/.test(qty) || Number(qty) <= 0) perr(i, "qty must be more than 0 (at most 2 decimals)");
    const price = moneyNum(p.price);
    if (price == null || Number.isNaN(price) || price < 0) perr(i, "price must be an amount ≥ 0");
    if (!/^[A-Z0-9]{10}$/.test(t(p.asin).toUpperCase())) perr(i, "map it to an ASIN (10 characters)");
    const y = t(p.asin_qty_per_product);
    if (!/^\d+(\.\d{1,4})?$/.test(y) || Number(y) <= 0) perr(i, "yield must be a number > 0");
    if (!(SOLD_AS_OPTIONS as readonly string[]).includes(p.sold_as)) perr(i, "sold as must be individual, multi-pack or bundle");
    const upp = t(p.units_per_pack);
    if (p.sold_as !== "individual" && (!/^\d+$/.test(upp) || Number(upp) < 2)) perr(i, `units per pack must be a whole number ≥ 2 for a ${p.sold_as}`);
    const rupp = t(p.retailer_units_per_pack ?? "1");
    if (rupp !== "" && (!/^\d+$/.test(rupp) || Number(rupp) < 1)) perr(i, "retailer units / pack must be a whole number ≥ 1");
    const prep = moneyNum(p.prep_cost); if (prep != null && (Number.isNaN(prep) || prep < 0)) perr(i, "prep must be an amount ≥ 0");
    if (price != null && !Number.isNaN(price) && /^\d+(\.\d{1,2})?$/.test(qty)) computedSubtotal += price * Number(qty);
  });
  computedSubtotal = r2(computedSubtotal);

  const typedSubtotal = moneyNum(f.subtotal);
  const subtotal = typedSubtotal != null && !Number.isNaN(typedSubtotal) ? typedSubtotal : computedSubtotal;
  if (typedSubtotal != null && !Number.isNaN(typedSubtotal) && Math.abs(typedSubtotal - computedSubtotal) > 0.005) {
    warnings.push(`Subtotal ${typedSubtotal.toFixed(2)} differs from Σ price × qty = ${computedSubtotal.toFixed(2)}`);
  }
  const n = (k: "tax" | "sh_donations" | "discount") => { const v = moneyNum(f[k]); return v == null || Number.isNaN(v) ? 0 : v; };
  const typedTotal = moneyNum(f.order_total);
  const effectiveOrderTotal = typedTotal != null && !Number.isNaN(typedTotal) ? typedTotal : r2(subtotal + n("tax") + n("sh_donations") - n("discount"));
  if (paymentsWithAmount > 0 && Math.abs(r2(paymentsSum) - r2(effectiveOrderTotal)) > 0.005) warnings.push(`Payments add up to ${r2(paymentsSum).toFixed(2)}, the order total is ${r2(effectiveOrderTotal).toFixed(2)}`);
  const weightedGcPct = gcAny && effectiveOrderTotal > 0 ? Math.round((gcWeighted / effectiveOrderTotal) * 100) / 100 : null;
  // The reflected rule (Maria 2026-11-01): Σ price × qty already equals the post-discount subtotal → the discount / promos count for nothing.
  const discountReflected = discountReflectedInLines({ linesSum: computedSubtotal, discount: n("discount"), promoAmounts: r2(promoAmounts), postDiscountSubtotal: r2(effectiveOrderTotal - n("tax") - n("sh_donations")) });
  // §7.2 counting pass: a non-counting promo without an amount cannot be added back (moot when the discount is reflected).
  let nonCountingPromoAmount = 0;
  if (!discountReflected) promoList.forEach((p, i) => {
    if (p.counts_toward_cogs !== false) return;
    const label = `Promo ${i + 1}${t(p.description) ? ` (${t(p.description)})` : ""}`;
    const amt = moneyNum(p.amount ?? "");
    if (amt != null && !Number.isNaN(amt)) nonCountingPromoAmount += amt;
    else warnings.push(`${label} does not count toward COGS but has no amount, so it cannot be added back — it counts until an amount is entered`);
  });
  nonCountingPromoAmount = r2(nonCountingPromoAmount);
  const gcRaw = t(f.weighted_gc_discount_pct).replace("%", "");
  const cbRaw = t(f.cashback_pct).replace("%", "");
  // Costs: the one formula in shared/po-cost.ts (v2 — discount pro rata, rewards added back, no tax / shipping); the computed GC % beats a typed one.
  const costHeader: CostHeader = effectiveCostHeader({
    subtotal, discount: n("discount"), gcPct: weightedGcPct ?? (/^\d+(\.\d+)?$/.test(gcRaw) ? Number(gcRaw) : null), nonCountingPromoAmount,
    orderTotal: effectiveOrderTotal, tax: n("tax"), shDonations: n("sh_donations"), cashbackPct: /^\d+(\.\d+)?$/.test(cbRaw) ? Number(cbRaw) : null,
  }, discountReflected);

  // Group by ASIN (first appearance order).
  const groups = new Map<string, number[]>();
  products.forEach((p, i) => { const a = t(p.asin).toUpperCase(); if (/^[A-Z0-9]{10}$/.test(a)) { if (!groups.has(a)) groups.set(a, []); groups.get(a)!.push(i); } });
  const asins: PoFormAsin[] = [];
  for (const [asin, idx] of Array.from(groups.entries())) {
    const first = products[idx[0]];
    for (const i of idx.slice(1)) {
      const p = products[i];
      if (p.sold_as !== first.sold_as || (first.sold_as !== "individual" && t(p.units_per_pack) !== t(first.units_per_pack)) || r2(moneyNum(p.prep_cost) ?? 0) !== r2(moneyNum(first.prep_cost) ?? 0)) {
        errors.push(`${asin}: its products disagree on sold as / units per pack / prep`); break;
      }
    }
    const per = idx.map((i) => (Number(t(products[i].qty_ordered)) || 0) * trueYield(Number(t(products[i].asin_qty_per_product)) || 1));
    let qty: number;
    const c2 = (x: number) => Math.round(x * 100) / 100;
    if (first.sold_as === "bundle") {
      if (idx.length < 2) errors.push(`${asin}: a bundle needs at least two products`);
      const sets = per.map((x) => c2(x));
      if (new Set(sets).size > 1) {
        errors.push(`${asin}: pack math — every bundle component must give the same number of sets (qty × yield = ${sets.join(", ")})`);
      }
      qty = Math.min(...sets);
    } else {
      qty = c2(per.reduce((a, b) => a + b, 0));
    }
    // A non-whole number of ASIN units is allowed (2026-10-18, Maria) — Velocity is the only consumer that refuses it.
    if (qty > 0 && Math.abs(qty - Math.round(qty)) > 1e-9) warnings.push(`${asin}: ${qty} ASIN units — ${WHOLE_PACKS_WARNING}`);
    if (!(qty > 0) && !idx.some((i) => productErrors[i])) errors.push(`${asin}: Ordered works out to 0 ASIN units`);
    const lines = idx.map((i, pos) => {
      const p = products[i]; const price = moneyNum(p.price);
      const adj = price == null || Number.isNaN(price) ? null : adjustedProductCost(price, costHeader);
      return { index: i, product_name: t(p.product_name) || null, supplier_sku: t(p.supplier_sku) || null, price: price == null || Number.isNaN(price) ? null : price.toFixed(2), qty_ordered: Number(t(p.qty_ordered)) || 0, asin_qty_per_product: t(p.asin_qty_per_product) || "1", adjusted_product_cost: adj == null ? null : adj.toFixed(2), position: pos, notes: t(p.notes ?? "") || null };
    });
    const adjRaw = f.cogs_adjustments?.[asin];
    const adjAmt = adjRaw == null || t(adjRaw.amount) === "" ? null : moneyNum(adjRaw.amount);
    if (adjAmt != null && Number.isNaN(adjAmt)) errors.push(`${asin}: COGS adjustment must be an amount with at most 2 decimals`);
    if (adjAmt != null && !Number.isNaN(adjAmt) && adjAmt !== 0 && !t(adjRaw?.reason)) errors.push(`${asin}: a COGS adjustment needs a reason`);
    const adjustment = adjAmt != null && !Number.isNaN(adjAmt) ? adjAmt : 0;
    const costs = allocateAsinCosts(costHeader, lines.map((l) => ({ price: l.price == null ? null : Number(l.price), qty: l.qty_ordered })), qty, adjustment);
    const computed = costs == null ? null : costs.cogs.toFixed(2);
    const ovRaw = t(f.cost_overrides?.[asin] ?? "");
    const ov = ovRaw === "" ? null : moneyNum(ovRaw);
    if (ov != null && (Number.isNaN(ov) || ov < 0)) errors.push(`${asin}: cost / unit must be an amount ≥ 0`);
    asins.push({
      asin, sold_as: first.sold_as, units_per_pack: first.sold_as === "individual" ? 1 : Number(t(first.units_per_pack)) || 1,
      prep_cost: r2(moneyNum(first.prep_cost) ?? 0).toFixed(2), qty, unique_products: first.sold_as === "bundle" ? idx.length : null,
      cost_per_unit: ov != null && !Number.isNaN(ov) ? ov.toFixed(2) : computed, computed_cost_per_unit: computed,
      sourcing_cost: costs == null ? null : costs.sourcing.toFixed(2), paid_cost: costs == null ? null : costs.paid.toFixed(2),
      cogs_adjustment: adjustment !== 0 ? adjustment.toFixed(2) : null, cogs_adjustment_reason: adjustment !== 0 ? t(adjRaw?.reason) || null : null,
      lines,
    });
  }
  const ok = errors.length === 0 && Object.keys(productErrors).length === 0;
  return { ok, errors, warnings, productErrors, computedSubtotal, effectiveOrderTotal: r2(effectiveOrderTotal), nonCountingPromoAmount, discountReflected, weightedGcPct, asins };
}
