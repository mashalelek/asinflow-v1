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
//   - pack math divisible: an ASIN's Ordered = Σ qty × yield must be a whole
//     number of ASIN units; a bundle's components must give the same whole
//     number of sets.
//   - live totals: subtotal = Σ price × qty (a typed subtotal that differs is
//     a warning, not an error).
// Cost / unit per ASIN is prefilled by shared/po-cost.ts (the one formula,
// measured against the imported 2026 cost / unit — v1 matches 74%) and can
// be overridden per ASIN.

import { adjustedProductCost, costPerUnitPrefill, type CostHeader } from "./po-cost";

export const SOLD_AS_OPTIONS = ["individual", "multi-pack", "bundle"] as const;
export type SoldAs = (typeof SOLD_AS_OPTIONS)[number];

export interface PoFormProduct {
  product_name: string;
  supplier_sku: string;
  price: string;
  qty_ordered: string;
  asin: string;
  asin_qty_per_product: string; // yield
  sold_as: SoldAs;
  units_per_pack: string;
  prep_cost: string;
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
  products: PoFormProduct[];
  /** ASIN → cost / unit typed by hand; absent = the computed value. */
  cost_overrides: Record<string, string>;
}

export const emptyProduct = (): PoFormProduct => ({ product_name: "", supplier_sku: "", price: "", qty_ordered: "", asin: "", asin_qty_per_product: "1", sold_as: "individual", units_per_pack: "1", prep_cost: "1" });
export const emptyPoForm = (today: string): PoFormState => ({
  supplier: "", order_id: "", order_date: today, subtotal: "", tax: "", sh_donations: "", discount: "", refund_amount: "", order_total: "",
  payment_method: "", weighted_gc_discount_pct: "", cashback_site: "", cashback_pct: "", purchased_by: "", notes: "",
  products: [emptyProduct()], cost_overrides: {},
});

const t = (s: unknown) => (typeof s === "string" ? s.trim() : s == null ? "" : String(s).trim());
const moneyNum = (s: string): number | null => { const v = t(s).replace(/[$,\s]/g, ""); return v === "" ? null : /^-?\d+(\.\d{1,2})?$/.test(v) ? Number(v) : NaN; };
const r2 = (x: number) => Math.round(x * 100) / 100;
/** A 2-dp yield back to the small fraction it stands for (0.33 → 1/3). Same rule as server/po-af-source.ts trueYield. */
function trueYield(y: number): number {
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
  cost_per_unit: string | null;
  computed_cost_per_unit: string | null;
  lines: Array<{ index: number; product_name: string | null; supplier_sku: string | null; price: string | null; qty_ordered: number; asin_qty_per_product: string; adjusted_product_cost: string | null; position: number }>;
}

export interface PoFormCheck {
  ok: boolean;
  errors: string[];                       // blocking
  warnings: string[];                     // shown, not blocking
  productErrors: Record<number, string[]>; // by product index
  computedSubtotal: number;
  effectiveOrderTotal: number;
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

  let computedSubtotal = 0;
  products.forEach((p, i) => {
    const qty = t(p.qty_ordered);
    if (!/^\d+$/.test(qty) || Number(qty) < 1) perr(i, "qty must be a whole number ≥ 1");
    const price = moneyNum(p.price);
    if (price == null || Number.isNaN(price) || price < 0) perr(i, "price must be an amount ≥ 0");
    if (!/^[A-Z0-9]{10}$/.test(t(p.asin).toUpperCase())) perr(i, "map it to an ASIN (10 characters)");
    const y = t(p.asin_qty_per_product);
    if (!/^\d+(\.\d{1,4})?$/.test(y) || Number(y) <= 0) perr(i, "yield must be a number > 0");
    if (!(SOLD_AS_OPTIONS as readonly string[]).includes(p.sold_as)) perr(i, "sold as must be individual, multi-pack or bundle");
    const upp = t(p.units_per_pack);
    if (p.sold_as !== "individual" && (!/^\d+$/.test(upp) || Number(upp) < 2)) perr(i, `units per pack must be a whole number ≥ 2 for a ${p.sold_as}`);
    const prep = moneyNum(p.prep_cost); if (prep != null && (Number.isNaN(prep) || prep < 0)) perr(i, "prep must be an amount ≥ 0");
    if (price != null && !Number.isNaN(price) && /^\d+$/.test(qty)) computedSubtotal += price * Number(qty);
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
  const gcRaw = t(f.weighted_gc_discount_pct).replace("%", "");
  const cbRaw = t(f.cashback_pct).replace("%", "");
  // Cost / unit prefill: the one formula in shared/po-cost.ts (measured against the imported 2026 costs).
  const costHeader: CostHeader = {
    subtotal, orderTotal: effectiveOrderTotal, gcPct: /^\d+(\.\d+)?$/.test(gcRaw) ? Number(gcRaw) : null,
    tax: n("tax"), shDonations: n("sh_donations"), discount: n("discount"), cashbackPct: /^\d+(\.\d+)?$/.test(cbRaw) ? Number(cbRaw) : null,
  };

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
    if (first.sold_as === "bundle") {
      if (idx.length < 2) errors.push(`${asin}: a bundle needs at least two products`);
      const sets = per.map((x) => Math.round(x * 1e6) / 1e6);
      if (sets.some((x) => Math.abs(x - Math.round(x)) > 1e-6) || new Set(sets.map((x) => Math.round(x))).size > 1) {
        errors.push(`${asin}: pack math — every bundle component must give the same whole number of sets (qty × yield = ${sets.map((x) => +x.toFixed(4)).join(", ")})`);
      }
      qty = Math.round(Math.min(...sets));
    } else {
      const sum = per.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - Math.round(sum)) > 1e-6) errors.push(`${asin}: pack math — qty × yield = ${+sum.toFixed(4)} is not a whole number of ASIN units`);
      qty = Math.round(sum);
    }
    if (qty < 1 && !idx.some((i) => productErrors[i])) errors.push(`${asin}: Ordered works out to 0 ASIN units`);
    const lines = idx.map((i, pos) => {
      const p = products[i]; const price = moneyNum(p.price);
      const adj = price == null || Number.isNaN(price) ? null : adjustedProductCost(price, costHeader);
      return { index: i, product_name: t(p.product_name) || null, supplier_sku: t(p.supplier_sku) || null, price: price == null || Number.isNaN(price) ? null : price.toFixed(2), qty_ordered: Number(t(p.qty_ordered)) || 0, asin_qty_per_product: t(p.asin_qty_per_product) || "1", adjusted_product_cost: adj == null ? null : adj.toFixed(2), position: pos };
    });
    const prefill = costPerUnitPrefill(costHeader, lines.map((l) => ({ price: l.price == null ? null : Number(l.price), qty: l.qty_ordered })), qty);
    const computed = prefill == null ? null : prefill.toFixed(2);
    const ovRaw = t(f.cost_overrides?.[asin] ?? "");
    const ov = ovRaw === "" ? null : moneyNum(ovRaw);
    if (ov != null && (Number.isNaN(ov) || ov < 0)) errors.push(`${asin}: cost / unit must be an amount ≥ 0`);
    asins.push({
      asin, sold_as: first.sold_as, units_per_pack: first.sold_as === "individual" ? 1 : Number(t(first.units_per_pack)) || 1,
      prep_cost: r2(moneyNum(first.prep_cost) ?? 0).toFixed(2), qty, unique_products: first.sold_as === "bundle" ? idx.length : null,
      cost_per_unit: ov != null && !Number.isNaN(ov) ? ov.toFixed(2) : computed, computed_cost_per_unit: computed, lines,
    });
  }
  const ok = errors.length === 0 && Object.keys(productErrors).length === 0;
  return { ok, errors, warnings, productErrors, computedSubtotal, effectiveOrderTotal: r2(effectiveOrderTotal), asins };
}
