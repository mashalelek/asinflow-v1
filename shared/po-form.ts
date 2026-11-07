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
//   - live totals: subtotal = Σ line totals (a typed subtotal that differs is
//     a warning, not an error). A line's total is the captured line_total
//     when it agrees with price × qty to the cent of the price (79.70 ÷ 30
//     shows 2.66), else price × qty; the price takes up to 6 decimals.
// Costs per ASIN row come from shared/po-cost.ts (formula v3, patch
// po-ai-prefill §7.1 as corrected 2026-11-04): Sourcing cost (col AR), COGS
// (col Y, + the per-ASIN adjustment) and Paid cost; COGS can be overridden
// per ASIN. Promos (several per PO, §7.2) decide what counts: a promo with
// counts_toward_cogs = false (rewards, by default) is added back.

import { adjustedProductCost, allocateAsinCosts, allocationBaseOf, reflectedPromos, promoCostHeader, COST_FORMULA_VERSION, REFLECTED_TOLERANCE, type CostHeader } from "./po-cost";
import { asinUnitsFromLines, fracToNumber, lineRatio, lineUnitsExact, ratioForUnits, ratioYield, type YieldRatio, retailerUnitsAtPack } from "./yield";
/** Stamped on purchase_orders.cost_formula_version by every form save; NULL = imported, never recomputed. */
export const COST_FORMULA_VERSION_SAVED = COST_FORMULA_VERSION;

/** Shown (not blocking) on an ASIN whose Ordered is not a whole number. */
export const WHOLE_PACKS_WARNING = "Upload to Velocity will skip this line — Velocity only accepts whole packs";

export const SOLD_AS_OPTIONS = ["individual", "multi-pack", "bundle"] as const;
export type SoldAs = (typeof SOLD_AS_OPTIONS)[number];
/**
 * A form row's pack (2026-11-06): one of SOLD_AS_OPTIONS, or "" — not known (po_asins.sold_as NULL, "Pack size
 * missing"). "" shows as "— choose —" in amber and is saved as NULL; it is never shown or saved as individual.
 */
export type FormSoldAs = SoldAs | "";
export const PACK_SIZE_MISSING_NOTE = "pack size missing — choose individual or multi-pack";
export const PROMO_TYPES = ["sale", "coupon", "rewards"] as const;
export type PromoType = (typeof PROMO_TYPES)[number];
/** §7.2 default: sale and coupon count toward COGS, rewards does not. A promo already reflected in the line prices (Maria 2026-11-01) defaults off whatever its type. */
export const promoCountsByDefault = (type: string, discountReflected = false): boolean => !discountReflected && type !== "rewards";
/** The note beside a promo's COGS toggle when the line prices already carry the discount. */
/** A typed promo amount replaced in the costs (2026-11-07): the line prices carry the sale, so it is subtotal − Σ line totals. */
export const PROMO_FROM_LINES_NOTE = "subtotal − line totals: the line prices already carry this sale";
export const PROMO_REFLECTED_NOTE = "already reflected in line prices";
/** The ambiguity question (Maria 2026-11-06): it blocks Create PO / Save until answered — on Edit PO too, even when the stored PO already had it. */
export const PROMO_IN_PRICES_QUESTION = "Which promos are already in the prices?";

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

/** The three payment lists from settings: canonical names (ordered), aliases → canonical, canonical → last 4. */
export interface PaymentLists { methods: readonly string[]; aliases: Record<string, string> | null | undefined; last4: Record<string, string> | null | undefined }
/**
 * Resolve a typed / captured card to a canonical method (Maria 2026-11-02 —
 * two Amex cards end in 1005): by NICKNAME first (an alias or a canonical
 * name, case and punctuation ignored), by LAST 4 second (the one method with
 * that last 4; a nickname that narrows a shared last 4 — "Gold" → Amex Gold —
 * still counts), and never by last 4 alone when two methods share it: then
 * the nickname comes back blank and `ambiguous` lists the candidates for the
 * amber warning. Anything unknown passes through trimmed. Pure.
 */
export function resolvePaymentNickname(nickname: string, last4: string, lists: PaymentLists): { nickname: string; ambiguous: string[] } {
  const norm = (x: string) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const methods = Array.isArray(lists.methods) ? lists.methods.map((m) => String(m)) : [];
  const canonical = canonicalPaymentName(nickname, lists.aliases);
  const exact = canonical ? methods.find((m) => norm(m) === norm(canonical)) : undefined;
  if (exact) return { nickname: exact, ambiguous: [] };
  const l4 = String(last4 ?? "").trim();
  const map = lists.last4 && typeof lists.last4 === "object" ? lists.last4 : {};
  const byLast4 = /^\d{4}$/.test(l4) ? methods.filter((m) => String(map[m] ?? "") === l4) : [];
  if (byLast4.length === 1) return { nickname: byLast4[0], ambiguous: [] };
  if (byLast4.length > 1) {
    const narrowed = norm(canonical) ? byLast4.filter((m) => norm(m).includes(norm(canonical))) : byLast4;
    if (narrowed.length === 1) return { nickname: narrowed[0], ambiguous: [] };
    return { nickname: "", ambiguous: byLast4 };
  }
  return { nickname: canonical, ambiguous: [] };
}
/** The warning / hint for a card two methods could be. */
export function ambiguousPaymentHint(last4: string, candidates: readonly string[]): string {
  return `Two cards end in ${last4} — pick ${candidates.join(" or ")}`;
}

export interface PoFormPromo {
  /** po_promos.id of a stored promo (Edit PO, shared/po-edit-form.ts); absent = new. Form-only. */
  id?: number;
  type: PromoType | "";
  description: string;
  amount: string;   // $ off the order, when stated
  percent: string;  // % off, when stated
  counts_toward_cogs: boolean;
  /** po_promos.position of a stored promo (Edit PO): the sequence it applies in (2026-11-06). The form's order is the sequence. */
  position?: number;
  /** po_promos.in_line_prices (2026-11-06): Maria's answer to "already in the prices?" — null / absent = AF decides from the amounts. */
  in_line_prices?: boolean | null;
}
export interface PoFormAdjustment { amount: string; reason: string }
export const PAYMENT_METHODS = ["card", "gift_card", "store_credit", "paypal", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export interface PoFormPayment {
  /** po_payments.id of a stored payment (Edit PO); absent = new. Form-only. */
  id?: number;
  method: PaymentMethod | "";
  nickname: string;
  last4: string;
  amount: string;
  gift_card_discount_pct: string; // gift cards only
  /** A card's reward % (Maria 2026-11-04): its canonical method's default (Walmart card 5), editable per PO; cards only. */
  reward_pct?: string;
}
export const emptyPayment = (method: PaymentMethod = "card"): PoFormPayment => ({ method, nickname: "", last4: "", amount: "", gift_card_discount_pct: "", reward_pct: "" });

/** The label of purchase_orders.weighted_gc_discount_pct since 2026-11-04 (was "Weighted GC %"). */
export const WEIGHTED_PAYMENT_LABEL = "Weighted payment discount %";
/** A canonical method's default reward % (settings.po_payment_method_reward_pct); null when it has none. Pure. */
export function defaultRewardPct(canonicalName: string, rewards: Record<string, number | string> | null | undefined): number | null {
  if (!rewards || !canonicalName) return null;
  const norm = (x: string) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const [k, v] of Object.entries(rewards)) if (norm(k) === norm(canonicalName) && Number(v) > 0) return Number(v);
  return null;
}
/**
 * The weighted payment discount % (Maria 2026-11-04; the weighted gift-card % since 2026-11-01) = Σ(gift-card amount × its GC %
 * + card amount × its reward %) ÷ order total, rounded to 2 dp; null when no payment carries both an amount and its %. Cashback
 * portals never count (they are not payments). Pure.
 */
export function weightedPaymentPct(payments: ReadonlyArray<{ method: string | null; amount: string | number | null; gift_card_discount_pct?: string | number | null; reward_pct?: string | number | null }>, orderTotal: number): number | null {
  const x = weightedPaymentPctExact(payments, orderTotal);
  return x == null ? null : Math.round(x * 100) / 100;
}
/** weightedPaymentPct unrounded (Maria 2026-11-05: 12.795 %, not 12.80 %, goes into the cost math; the 2 dp is for display and storage). */
export function weightedPaymentPctExact(payments: Parameters<typeof weightedPaymentPct>[0], orderTotal: number): number | null {
  let w = 0, any = false;
  for (const p of payments) {
    const amt = p.amount == null || String(p.amount).trim() === "" ? NaN : Number(String(p.amount).replace(/[$,]/g, ""));
    const raw = p.method === "gift_card" ? p.gift_card_discount_pct : p.method === "card" ? p.reward_pct : null;
    const pc = raw == null || String(raw).trim() === "" ? NaN : Number(String(raw).replace("%", ""));
    if (!Number.isFinite(amt) || !Number.isFinite(pc)) continue;
    w += amt * pc; any = true;
  }
  return any && orderTotal > 0 ? w / orderTotal : null;
}
export const CASHBACK_STATUSES = ["pending", "received", "denied"] as const;
/** Where a prefilled value came from (§6.1 markers): "model" = amber, "af" = stone; absent = typed. */
export type PrefillSource = "model" | "af";
export interface PoFormPrefill {
  /** The server-side cache key of the capture (po_prefill_log.po_id is set from it on save). */
  id?: string;
  supplier?: string | null;
  pages?: number;
  captured_at?: string | null;
  /** Only what Maria must act on: an unknown ASIN, totals that still do not reconcile, an ambiguous card, an uncertain promo type. */
  warnings?: string[];
  /** The model's explanations and other information (a new supplier) — the collapsed "Notes from capture" line. */
  notes?: string[];
  /** Field path → source. Header: "supplier"; product: "products.0.price"; ASIN rows: "asin.B0…"; promo: "promos.0". */
  sources: Record<string, PrefillSource>;
  /** Field path → a tooltip on an amber field explaining a server-side correction (2026-11-01: "qty inferred from subtotal"). Cleared with the marker. */
  hints?: Record<string, string>;
  /** The raw-text fallback (schema failure): the captured text for the side drawer. */
  raw_text?: string | null;
  /** Product index → the top ASIN suggestions (AF database, else Amazon search) the picker shows first (2026-11-06). */
  asin_candidates?: Record<string, PrefillAsinCandidate[]>;
}
/** One ASIN suggestion as the prefill hands it to the picker (server/asin-suggest.ts AsinSuggestion). */
export interface PrefillAsinCandidate {
  asin: string; title: string | null; primary_sku: string | null; image_url: string | null; brand: string | null;
  sold_as: string | null; units_per_pack: number | null; in_af: boolean;
  via: "part_number" | "history_sku" | "history_exact" | "history_tokens" | "title" | "search" | "amazon" | "model";
  matched_name?: string | null; last_ordered?: string | null; sold_before?: boolean; name_all?: boolean; mismatch?: string | null; size?: string | null; pack?: number | null;
}
export const emptyPromo = (type: PromoType = "sale"): PoFormPromo => ({ type, description: "", amount: "", percent: "", counts_toward_cogs: promoCountsByDefault(type) });

export interface PoFormProduct {
  product_name: string;
  supplier_sku: string;
  price: string;
  qty_ordered: string;
  /** The line's total as captured (2026-11-04: 79.70 for 30 × "2.66" — total ÷ qty is not whole cents); absent / "" = price × qty. Cleared when price or qty is typed. */
  line_total?: string;
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
  /** po_line_items.id of a stored line (Edit PO, shared/po-edit-form.ts); absent = a new line. Never copied to a split's new row. */
  line_item_id?: string;
  sold_as: FormSoldAs;
  units_per_pack: string;
  /**
   * Edit PO: the stored row's pack was not known, so choosing one keeps the line's stored yield (the ASIN units
   * ordered are the known fact) and derives the retailer units from it — 2/1 with a 2-pack chosen → 4/2. Form-only.
   */
  pack_keep_yield?: boolean;
  prep_cost: string;
  /** Unit price before a multi-buy deal (BOGO, B2G2, "free"; migration 097) — the line's allocation weight is then this × qty. "" / absent = none. */
  regular_price?: string;
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
  /** Other order #s the retailer uses for this order (comma-separated; migration 086) — every email matcher reads them. */
  alt_order_ids?: string;
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

export const emptyProduct = (): PoFormProduct => ({ product_name: "", supplier_sku: "", price: "", qty_ordered: "", retailer_units_per_pack: "1", asin: "", asin_qty_per_product: "1", sold_as: "", units_per_pack: "", prep_cost: "1", notes: "" }); // pack not known until the ASIN's or Maria's (2026-11-06)
/** §6.5 pack math: yield = retailer units per pack ÷ ASIN units per pack (so ASIN qty = qty × retailer ÷ ASIN). */
export function yieldFromPacks(retailerUnitsPerPack: string | undefined, asinUnitsPerPack: string | undefined, soldAs: string): string {
  const r = Number(String(retailerUnitsPerPack ?? "1").trim()) || 1;
  const u = soldAs === "individual" ? 1 : Number(String(asinUnitsPerPack ?? "1").trim()) || 1;
  const y = Math.round((r / u) * 10000) / 10000;
  return String(y > 0 ? y : 1);
}
/**
 * A product row's exact yield: the pack math (retailer units / pack ÷ the
 * ASIN's units / pack, 1 for individual) unless the yield was typed by hand —
 * then the typed ASIN units (qty × yield, read through trueYield) as a
 * fraction of the qty (shared/yield.ts ratioForUnits). Two integers, never a
 * decimal, reach the server.
 */
export function productRatio(p: PoFormProduct): YieldRatio {
  const qty = Number(String(p.qty_ordered ?? "").trim()) || 0;
  const r = Math.round(Number(String(p.retailer_units_per_pack ?? "1").trim())) || 1;
  const a = p.sold_as === "individual" ? 1 : Math.round(Number(String(p.units_per_pack ?? "1").trim())) || 1;
  const pack: YieldRatio = { retailer: Math.max(1, r), asinUnits: Math.max(1, a) };
  const typed = String(p.asin_qty_per_product ?? "").trim();
  const manual = p.yield_manual === true || (typed !== "" && Math.abs(Number(typed) - Number(yieldFromPacks(p.retailer_units_per_pack, p.units_per_pack, p.sold_as))) > 1e-9);
  if (!manual || !(qty > 0) || !(Number(typed) > 0)) return pack;
  const units = Math.round(qty * trueYield(Number(typed)) * 100) / 100;
  return ratioForUnits(units, qty, pack.asinUnits) ?? pack;
}
export const emptyPoForm = (today: string): PoFormState => ({
  supplier: "", order_id: "", order_date: today, subtotal: "", tax: "", sh_donations: "", discount: "", refund_amount: "", order_total: "",
  payment_method: "", weighted_gc_discount_pct: "", cashback_site: "", cashback_pct: "", purchased_by: "", notes: "",
  products: [emptyProduct()], cost_overrides: {}, promos: [], cogs_adjustments: {}, payments: [], email_used: "", purchased_by_user_id: "", cashback_status: "",
  subscription: { present: false, frequency_weeks: "" }, pack_updates: {},
});

const t = (s: unknown) => (typeof s === "string" ? s.trim() : s == null ? "" : String(s).trim());
const moneyNum = (s: string): number | null => { const v = t(s).replace(/[$,\s]/g, ""); return v === "" ? null : /^-?\d+(\.\d{1,2})?$/.test(v) ? Number(v) : NaN; };
/** A unit price: up to 6 decimals (2026-11-04 — a price typed or derived from a line total that is not whole cents). */
const priceNum = (s: string): number | null => { const v = t(s).replace(/[$,\s]/g, ""); return v === "" ? null : /^-?\d+(\.\d{1,6})?$/.test(v) ? Number(v) : NaN; };
/** Full-precision text of a unit price (≤ 6 dp, no trailing zeros past the cents). */
export const priceText = (x: number): string => { const s = (Math.round(x * 1e6) / 1e6).toFixed(6).replace(/0+$/, ""); const [i, d = ""] = s.split("."); return `${i}.${d.padEnd(2, "0")}`; };
/**
 * A product row's money: the captured line total when it agrees with the price (round(total ÷ qty) to the
 * cent = the price, to the cent), else price × qty. `unit` = the full-precision unit price the costs use.
 */
export function productLineMoney(p: Pick<PoFormProduct, "price" | "qty_ordered" | "line_total">): { total: number; unit: number; lineTotal: number | null } | null {
  const price = priceNum(p.price ?? ""), qty = Number(t(p.qty_ordered ?? ""));
  if (price == null || Number.isNaN(price) || !(qty > 0)) return null;
  const lt = moneyNum(p.line_total ?? "");
  if (lt != null && !Number.isNaN(lt) && lt >= 0 && Math.abs(lt / qty - price) <= 0.005 + 1e-9) return { total: lt, unit: lt / qty, lineTotal: lt };
  return { total: price * qty, unit: price, lineTotal: null };
}
const r2 = (x: number) => Math.round(x * 100) / 100;
/** A 2-dp yield back to the small fraction it stands for (0.33 → 1/3). Same rule as server/po-af-source.ts trueYield. */
export function trueYield(y: number): number {
  for (let d = 1; d <= 12; d++) { const n = Math.round(y * d); if (n > 0 && Math.abs(y - n / d) < 0.006) return n / d; }
  return y;
}
const isDate = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return false; const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]); };

export interface PoFormAsin {
  asin: string;
  sold_as: FormSoldAs;
  /** null while the pack is not known. */
  units_per_pack: number | null;
  prep_cost: string;
  qty: number;                 // Ordered, ASIN units
  unique_products: number | null;
  cost_per_unit: string | null;          // COGS as saved: the override, else computed (adjustment included)
  computed_cost_per_unit: string | null; // COGS computed (adjustment included)
  sourcing_cost: string | null;          // col AR
  paid_cost: string | null;
  cogs_adjustment: string | null;
  cogs_adjustment_reason: string | null;
  /** Exact yield (2026-11-02): the two integers the line stores; asin_qty_per_product is the derived yield (history). */
  lines: Array<{ index: number; regular_price: string | null; product_name: string | null; supplier_sku: string | null; price: string | null; line_total: string | null; qty_ordered: number; asin_qty_per_product: string; retailer_units_per_product: number; asin_units_per_pack: number; adjusted_product_cost: string | null; position: number; notes: string | null }>;
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
  /** Maria 2026-11-01: Σ line totals already equals the post-discount subtotal (within 1¢) — the discount / promos are informational, nothing reduces a cost. */
  discountReflected: boolean;
  /** Per promo (2026-11-05): its amount is already in the line totals (reflectedPromos) — it reduces no cost, its toggle is moot. */
  promoReflected: boolean[];
  /** Per promo (2026-11-06): the $ used — typed, else implied by the discount, else its % of the running total in sequence. */
  promoAmountsUsed: Array<number | null>;
  /** Promos waiting for "already in the prices?" (2026-11-06) — the form shows the question on each; the PO does not save until answered. */
  promoNeedsAnswer: number[];
  /** Weighted payment discount % (weightedPaymentPct) from the Payments block; null when no gift-card / card payment carries an amount and its %. */
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
  for (const [k, label] of [["subtotal", "Subtotal"], ["tax", "Tax"], ["sh_donations", "Shipping"], ["discount", "Discount"], ["refund_amount", "Refund amount"], ["order_total", "Order total"]] as const) {
    const v = moneyNum(f[k]); if (v != null && (Number.isNaN(v) || v < 0)) errors.push(`${label} must be an amount with at most 2 decimals`);
  }
  for (const [k, label] of [["weighted_gc_discount_pct", WEIGHTED_PAYMENT_LABEL], ["cashback_pct", "Cashback %"]] as const) {
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
  // The weighted payment discount % (gift cards 2026-11-01, card rewards 2026-11-04: weightedPaymentPct) — live from this block, read-only on the form.
  let paymentsSum = 0, paymentsWithAmount = 0;
  (Array.isArray(f.payments) ? f.payments : []).forEach((p, i) => {
    const label = `Payment ${i + 1}${t(p.nickname) ? ` (${t(p.nickname)})` : ""}`;
    if (!(PAYMENT_METHODS as readonly string[]).includes(String(p.method))) errors.push(`${label}: method must be card, gift card, store credit, PayPal or other`);
    if (t(p.last4) !== "" && !/^\d{4}$/.test(t(p.last4))) errors.push(`${label}: last 4 must be four digits`);
    const amt = moneyNum(p.amount ?? "");
    if (amt != null && (Number.isNaN(amt) || amt < 0)) errors.push(`${label}: amount must be an amount with at most 2 decimals`);
    else if (amt != null) { paymentsSum += amt; paymentsWithAmount++; }
    const gc = t(p.gift_card_discount_pct ?? "").replace("%", "");
    if (gc !== "" && (!/^\d+(\.\d{1,4})?$/.test(gc) || Number(gc) > 100)) errors.push(`${label}: gift-card discount must be a percentage between 0 and 100`);
    const rw = t(p.reward_pct ?? "").replace("%", "");
    if (rw !== "" && (!/^\d+(\.\d{1,4})?$/.test(rw) || Number(rw) > 100)) errors.push(`${label}: reward must be a percentage between 0 and 100`);
  });
  if (t(f.email_used ?? "") !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t(f.email_used ?? ""))) errors.push("Email used must be an email address");
  if (t(f.cashback_status ?? "") !== "" && !(CASHBACK_STATUSES as readonly string[]).includes(t(f.cashback_status ?? ""))) errors.push("Cashback status must be pending, received or denied");
  if (f.subscription?.present && t(f.subscription.frequency_weeks) !== "" && !(/^\d+$/.test(t(f.subscription.frequency_weeks)) && Number(f.subscription.frequency_weeks) > 0)) errors.push("Subscription frequency must be a whole number of weeks");
  if (t(f.purchased_by_user_id ?? "") !== "" && !/^\d+$/.test(t(f.purchased_by_user_id ?? ""))) errors.push("Purchased by must be a user");

  let computedSubtotal = 0;
  products.forEach((p, i) => {
    const qty = t(p.qty_ordered);
    if (!/^\d+(\.\d{1,2})?$/.test(qty) || Number(qty) <= 0) perr(i, "qty must be more than 0 (at most 2 decimals)");
    const price = priceNum(p.price);
    if (price == null || Number.isNaN(price) || price < 0) perr(i, "price must be an amount ≥ 0 (at most 6 decimals)");
    if (!/^[A-Z0-9]{10}$/.test(t(p.asin).toUpperCase())) perr(i, "map it to an ASIN (10 characters)");
    const y = t(p.asin_qty_per_product);
    if (!/^\d+(\.\d{1,4})?$/.test(y) || Number(y) <= 0) perr(i, "yield must be a number > 0");
    // "" = not known: allowed (saved as NULL → "Pack size missing"), warned per ASIN below.
    if (p.sold_as !== "" && !(SOLD_AS_OPTIONS as readonly string[]).includes(p.sold_as)) perr(i, "sold as must be individual, multi-pack or bundle");
    const upp = t(p.units_per_pack);
    if ((p.sold_as === "multi-pack" || p.sold_as === "bundle") && (!/^\d+$/.test(upp) || Number(upp) < 2)) perr(i, `units per pack must be a whole number ≥ 2 for a ${p.sold_as}`);
    const rupp = t(p.retailer_units_per_pack ?? "1");
    if (rupp !== "" && (!/^\d+$/.test(rupp) || Number(rupp) < 1)) perr(i, "retailer units / pack must be a whole number ≥ 1");
    const prep = moneyNum(p.prep_cost); if (prep != null && (Number.isNaN(prep) || prep < 0)) perr(i, "prep must be an amount ≥ 0");
    const lm = /^\d+(\.\d{1,2})?$/.test(qty) ? productLineMoney(p) : null;
    if (lm) computedSubtotal += lm.total;
    const ltTyped = moneyNum(p.line_total ?? "");
    if (ltTyped != null && lm && lm.lineTotal == null) warnings.push(`Product ${i + 1}: line total ${Number.isNaN(ltTyped) ? t(p.line_total ?? "") : ltTyped.toFixed(2)} does not match price × qty — price × qty is used`);
  });
  computedSubtotal = r2(computedSubtotal);
  // Free-item deals (2026-11-06): a line's regular price, when given, is its allocation weight (regular × qty).
  const regularOf = (p: PoFormProduct): number | null => { const v = priceNum(p.regular_price ?? ""); return v == null || Number.isNaN(v) || !(v > 0) ? null : v; };
  products.forEach((p, i) => { const v = priceNum(p.regular_price ?? ""); if (v != null && (Number.isNaN(v) || v < 0)) perr(i, "regular price must be an amount ≥ 0"); });
  const costLines = products.map((p) => { const lm = /^\d+(\.\d{1,2})?$/.test(t(p.qty_ordered)) ? productLineMoney(p) : null; return { price: lm?.unit ?? null, qty: Number(t(p.qty_ordered)) || 0, lineTotal: lm?.total ?? null, regularPrice: regularOf(p) }; });
  const allocationBase = allocationBaseOf(costLines);

  const typedSubtotal = moneyNum(f.subtotal);
  const hasTypedSubtotal = typedSubtotal != null && !Number.isNaN(typedSubtotal);
  const subtotal = hasTypedSubtotal ? typedSubtotal! : computedSubtotal;
  const n = (k: "tax" | "sh_donations" | "discount") => { const v = moneyNum(f[k]); return v == null || Number.isNaN(v) ? 0 : v; };
  const typedTotal = moneyNum(f.order_total);
  const effectiveOrderTotal = typedTotal != null && !Number.isNaN(typedTotal) ? typedTotal : r2(subtotal + n("tax") + n("sh_donations") - n("discount"));
  if (paymentsWithAmount > 0 && Math.abs(r2(paymentsSum) - r2(effectiveOrderTotal)) > 0.005) warnings.push(`Payments add up to ${r2(paymentsSum).toFixed(2)}, the order total is ${r2(effectiveOrderTotal).toFixed(2)}`);
  const weightedGcPct = weightedPaymentPct(Array.isArray(f.payments) ? f.payments : [], effectiveOrderTotal);
  // The reflected rule (Maria 2026-11-01; 1¢, 2026-11-04): Σ line totals already equals the post-discount subtotal → the discount / promos count for nothing.
  const postDiscountSubtotal = r2(effectiveOrderTotal - n("tax") - n("sh_donations"));
  // Per promo (2026-11-05): the promos whose amounts close the gap subtotal − Σ line totals are already in the prices.
  const promoAmt = promoList.map((p) => { const a = moneyNum(p.amount ?? ""); return a == null || Number.isNaN(a) ? null : a; });
  const refl = reflectedPromos({ linesSum: computedSubtotal, subtotal: hasTypedSubtotal ? typedSubtotal! : null, discount: n("discount"), promoAmounts: promoAmt, postDiscountSubtotal, answers: promoList.map((p) => p.in_line_prices ?? null), kinds: promoList.map((p) => String(p.type ?? "")),
    // Sequence (2026-11-06): a %-only promo takes its % of the running total, starting from Σ regular price × qty when the lines carry one.
    percents: promoList.map((p) => { const v = Number(String(p.percent ?? "").replace(/[%\s]/g, "")); return String(p.percent ?? "").trim() !== "" && Number.isFinite(v) ? v : null; }), sequenceBase: allocationBase ?? subtotal });
  const discountReflected = refl.all;
  // Ambiguous (2026-11-06): the candidates are not subtracted (COGS errs high) and the PO does not save until Maria answers.
  if (refl.needsAnswer.length) errors.push(`${PROMO_IN_PRICES_QUESTION} Line totals ${computedSubtotal.toFixed(2)} are ${r2(subtotal - computedSubtotal).toFixed(2)} under the subtotal, and ${refl.fits.map((f) => f.map((i) => `promo ${i + 1}`).join(" + ")).join(" or ")} each fit — answer "In prices?" on ${refl.needsAnswer.map((i) => `promo ${i + 1}`).join(", ")}`);
  if (hasTypedSubtotal && !discountReflected && !(refl.reflectedAmount > 0) && Math.abs(typedSubtotal! - computedSubtotal) > REFLECTED_TOLERANCE + 1e-9) {
    const d = n("discount") + promoAmounts;
    warnings.push(d > 0
      ? `Line totals ${computedSubtotal.toFixed(2)} match neither the subtotal ${typedSubtotal!.toFixed(2)} nor the subtotal after discount ${postDiscountSubtotal.toFixed(2)}`
      : `Subtotal ${typedSubtotal!.toFixed(2)} differs from the line totals ${computedSubtotal.toFixed(2)}`);
  }
  // Never silently (Maria 2026-11-07): a typed amount the costs do not use — a sale in the line prices is subtotal − Σ line totals.
  promoList.forEach((p, i) => {
    const typed = promoAmt[i], used = refl.amounts[i];
    if (typed != null && used != null && Math.abs(typed - used) > 0.005) warnings.push(`Promo ${i + 1}${t(p.description) ? ` (${t(p.description)})` : ""}: ${used.toFixed(2)} is used, not the ${typed.toFixed(2)} typed — ${PROMO_FROM_LINES_NOTE}`);
  });
  // The promos against the Discount field (Maria 2026-11-07, Michaels: a prefilled sale of 42.75 beside a 54.50 discount and a $20 voucher).
  // A promo marked "in prices" that was never part of the discount (a free-item deal) may stand outside it, so either sum fitting is fine.
  if (promoList.length > 0 && promoAmt.every((x) => x != null) && n("discount") > 0) {
    const all = r2(promoAmt.reduce<number>((t, x) => t + (x ?? 0), 0));
    const outside = r2(promoAmt.reduce<number>((t, x, i) => t + (promoList[i].in_line_prices === true ? 0 : x ?? 0), 0));
    if (Math.abs(all - n("discount")) > REFLECTED_TOLERANCE + 1e-9 && Math.abs(outside - n("discount")) > REFLECTED_TOLERANCE + 1e-9) warnings.push(`Promos add up to ${all.toFixed(2)}, the discount is ${n("discount").toFixed(2)}`);
  }
  // §7.2 counting pass: a non-counting promo without an amount cannot be added back (moot when that promo is reflected).
  let nonCountingPromoAmount = 0;
  if (!discountReflected) promoList.forEach((p, i) => {
    if (p.counts_toward_cogs !== false || refl.reflected[i]) return;
    const label = `Promo ${i + 1}${t(p.description) ? ` (${t(p.description)})` : ""}`;
    const amt = refl.amounts[i];
    if (amt != null) nonCountingPromoAmount += amt;
    else warnings.push(`${label} does not count toward COGS but has no amount, so it cannot be added back — it counts until an amount is entered`);
  });
  nonCountingPromoAmount = r2(nonCountingPromoAmount);
  const gcRaw = t(f.weighted_gc_discount_pct).replace("%", "");
  const cbRaw = t(f.cashback_pct).replace("%", "");
  // Costs: the one formula in shared/po-cost.ts (v3 — tax and shipping in, discount pro rata, rewards added back), allocated over the
  // line totals (the typed subtotal when the lines are pre-discount); the computed GC % beats a typed one.
  // The GC % in the math is unrounded (2026-11-05); weightedGcPct (2 dp) is what the form shows and stores.
  const exactGcPct = weightedPaymentPctExact(Array.isArray(f.payments) ? f.payments : [], effectiveOrderTotal);
  const costHeader: CostHeader = promoCostHeader({
    subtotal, discount: n("discount"), gcPct: exactGcPct ?? (/^\d+(\.\d+)?$/.test(gcRaw) ? Number(gcRaw) : null),
    orderTotal: effectiveOrderTotal, tax: n("tax"), shDonations: n("sh_donations"), cashbackPct: /^\d+(\.\d+)?$/.test(cbRaw) ? Number(cbRaw) : null, allocationBase,
  }, computedSubtotal, promoList.map((p) => ({ counts: p.counts_toward_cogs !== false })), refl);

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
    if (first.sold_as === "") warnings.push(`${asin}: ${PACK_SIZE_MISSING_NOTE}`);
    // Exact yield (2026-11-02): each row's ratio (retailer units / product ÷ ASIN units / pack, or a typed unit count as a fraction), summed exactly, rounded once.
    const ratios = idx.map((i) => productRatio(products[i]));
    const yLines = idx.map((i, k) => ({ qty_ordered: Number(t(products[i].qty_ordered)) || 0, retailer_units_per_product: ratios[k].retailer, asin_units_per_pack: ratios[k].asinUnits }));
    const per = yLines.map((l) => fracToNumber(lineUnitsExact(l.qty_ordered, lineRatio(l)!)));
    let qty: number;
    if (first.sold_as === "bundle") {
      if (idx.length < 2) errors.push(`${asin}: a bundle needs at least two products`);
      if (new Set(per).size > 1) {
        errors.push(`${asin}: pack math — every bundle component must give the same number of sets (qty × yield = ${per.join(", ")})`);
      }
      qty = asinUnitsFromLines(yLines, "bundle").qty;
    } else {
      qty = asinUnitsFromLines(yLines, first.sold_as).qty;
    }
    // A non-whole number of ASIN units is allowed (2026-10-18, Maria) — Velocity is the only consumer that refuses it.
    if (qty > 0 && Math.abs(qty - Math.round(qty)) > 1e-9) warnings.push(`${asin}: ${qty} ASIN units — ${WHOLE_PACKS_WARNING}`);
    if (!(qty > 0) && !idx.some((i) => productErrors[i])) errors.push(`${asin}: Ordered works out to 0 ASIN units`);
    const lines = idx.map((i, pos) => {
      const p = products[i]; const lm = productLineMoney(p); const reg = allocationBase != null ? regularOf(p) : null;
      const adj = lm == null ? null : adjustedProductCost(reg ?? lm.unit, costHeader);
      return { index: i, regular_price: reg == null ? null : priceText(reg), product_name: t(p.product_name) || null, supplier_sku: t(p.supplier_sku) || null, price: lm == null ? null : priceText(lm.unit), line_total: lm?.lineTotal == null ? null : lm.lineTotal.toFixed(2), qty_ordered: Number(t(p.qty_ordered)) || 0, asin_qty_per_product: ratioYield(ratios[pos]), retailer_units_per_product: ratios[pos].retailer, asin_units_per_pack: ratios[pos].asinUnits, adjusted_product_cost: adj == null ? null : adj.toFixed(2), position: pos, notes: t(p.notes ?? "") || null };
    });
    const adjRaw = f.cogs_adjustments?.[asin];
    const adjAmt = adjRaw == null || t(adjRaw.amount) === "" ? null : moneyNum(adjRaw.amount);
    if (adjAmt != null && Number.isNaN(adjAmt)) errors.push(`${asin}: COGS adjustment must be an amount with at most 2 decimals`);
    if (adjAmt != null && !Number.isNaN(adjAmt) && adjAmt !== 0 && !t(adjRaw?.reason)) errors.push(`${asin}: a COGS adjustment needs a reason`);
    const adjustment = adjAmt != null && !Number.isNaN(adjAmt) ? adjAmt : 0;
    const costs = allocateAsinCosts(costHeader, lines.map((l) => ({ price: l.price == null ? null : Number(l.price), qty: l.qty_ordered, lineTotal: l.line_total == null ? null : Number(l.line_total), regularPrice: l.regular_price == null ? null : Number(l.regular_price) })), qty, adjustment);
    const computed = costs == null ? null : costs.cogs.toFixed(2);
    const ovRaw = t(f.cost_overrides?.[asin] ?? "");
    const ov = ovRaw === "" ? null : moneyNum(ovRaw);
    if (ov != null && (Number.isNaN(ov) || ov < 0)) errors.push(`${asin}: cost / unit must be an amount ≥ 0`);
    asins.push({
      asin, sold_as: first.sold_as, units_per_pack: first.sold_as === "" ? null : first.sold_as === "individual" ? 1 : Number(t(first.units_per_pack)) || 1,
      prep_cost: r2(moneyNum(first.prep_cost) ?? 0).toFixed(2), qty, unique_products: first.sold_as === "bundle" ? idx.length : null,
      cost_per_unit: ov != null && !Number.isNaN(ov) ? ov.toFixed(2) : computed, computed_cost_per_unit: computed,
      sourcing_cost: costs == null ? null : costs.sourcing.toFixed(2), paid_cost: costs == null ? null : costs.paid.toFixed(2),
      cogs_adjustment: adjustment !== 0 ? adjustment.toFixed(2) : null, cogs_adjustment_reason: adjustment !== 0 ? t(adjRaw?.reason) || null : null,
      lines,
    });
  }
  const ok = errors.length === 0 && Object.keys(productErrors).length === 0;
  return { ok, errors, warnings, productErrors, computedSubtotal, effectiveOrderTotal: r2(effectiveOrderTotal), nonCountingPromoAmount, discountReflected, promoReflected: refl.reflected, promoAmountsUsed: refl.amounts, promoNeedsAnswer: refl.needsAnswer, weightedGcPct, asins };
}

/** An ASIN with no pack on record set from a PO (Maria 2026-11-06), as the grey line / toast says it. */
export interface AsinPackSetNote { asin: string; sold_as: string; units_per_pack: number; openRows: number; closedRows: number; closedSkipped: number; lines: number }
export function asinPackSetLabel(soldAs: string, unitsPerPack: number | string): string { return `ASIN set to ${soldAs} ×${soldAs === "individual" ? 1 : unitsPerPack} in AF`; }
export function asinPackSetNote(r: AsinPackSetNote): string {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const filled = [`${n(r.openRows, "open PO row")}`, `${n(r.closedRows, "closed PO row")}`, `${n(r.lines, "line")} given pack integers`];
  return `${r.asin}: ${asinPackSetLabel(r.sold_as, r.units_per_pack)} · filled ${filled.join(", ")}${r.closedSkipped ? ` · ${n(r.closedSkipped, "closed row")} left (pack doesn't reproduce its stored ASIN qty)` : ""}`;
}

/**
 * A pack field set by hand on a product row (Maria 2026-11-06): the yield follows the pack sizes — a stored or typed
 * yield never silently wins over a pack just set. When the row carried a stored yield (or its pack was not known)
 * and that yield is a sheet rounding of a whole number of retailer units at the new pack, the retailer units become
 * that number, so the value is kept, exactly (0.33 → ×3 → 1 retailer unit, yield 1/3).
 */
export function followPacks(p: PoFormProduct, k: string): PoFormProduct {
  if (!["retailer_units_per_pack", "units_per_pack", "sold_as"].includes(k) || p.sold_as === "") return p;
  const next = { ...p };
  if (k !== "retailer_units_per_pack" && (p.yield_manual || p.pack_keep_yield) && (p.sold_as === "individual" || p.sold_as === "multi-pack")) {
    const pk = p.sold_as === "individual" ? 1 : Number(p.units_per_pack);
    const r = Number.isInteger(pk) && pk >= 1 ? retailerUnitsAtPack(p.asin_qty_per_product, pk) : null;
    if (r != null) next.retailer_units_per_pack = String(r);
  }
  next.yield_manual = false;
  next.asin_qty_per_product = yieldFromPacks(next.retailer_units_per_pack, next.units_per_pack, next.sold_as);
  return next;
}
