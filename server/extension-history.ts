// Purchase history for the two Chrome extensions (Maria 2026-11-05; SPEC §11 "Purchase history"):
// GET /api/extension/history ?asin=… (Analyzer, an Amazon product page) or ?supplier=<host>&name=…&sku=…[&pack=][&asin=]
// (Capture PO, a retailer product / cart page). AF's PO tables only, no AI.
//
// A retailer listing matches past PO lines from the SAME supplier (the host through supplierForHost — exact, alias,
// registrable domain): the normalized SKU first (dashes, spaces, dots and case stripped; AF stores the retailer's SKU
// / UPC in po_line_items.supplier_sku), then the product name with its pack-size tokens stripped — the listing's pack
// size parsed as its own number. One confident match → its history; otherwise the top 3 for Maria to pick (the
// extension remembers the pick per listing URL and sends it back as &asin=).
//
// Per ASIN: the last COGS (po_asins.cost_per_unit, per ASIN unit) with its date and PO #, the 365-day average weighted
// by ASIN units, POs and ASIN units in 365 days, how the recent purchases were bought ("6-pack × 2"), and for a
// retailer listing the conversion to ASIN units when both pack sizes are known. A fully canceled ASIN row is no
// purchase (po-af-source.ts's rule). Stored values are read, never recomputed.
import { z } from "zod/v4";
import type { QueryLike } from "./scheduler/types";
import { supplierForHost, shipsToForStreet } from "./po-prefill";
import { loadAliases } from "./supplier-aliases";
import { NEWEST_PO_ORDER } from "./po-entry-seq";
import { settingsFromRows } from "./profit-settings";
import { allocateAsinCosts, discountReflectedInLines, effectiveCostHeader, lineMoney, type CostLine } from "@shared/po-cost";
import { weightedPaymentPct, defaultRewardPct, resolvePaymentNickname, type PaymentLists } from "@shared/po-form";
import { calculateProfit, getSelectedPrice, appliesDgHazmatSurcharge, type AsinResult } from "@shared/schema";

export const HistoryQuerySchema = z.object({
  asin: z.string().trim().regex(/^[A-Za-z0-9]{10}$/).transform((s) => s.toUpperCase()).optional(),
  supplier: z.string().trim().max(253).optional(),
  name: z.string().trim().max(500).optional(),
  sku: z.string().trim().max(100).optional(),
  pack: z.coerce.number().int().min(1).max(10000).optional(),
  /** Capture PO (2026-11-05): the capture's lines / totals / payment / ship-to as JSON, for "This PO" (CapturePoSchema). */
  po: z.string().max(12000).optional(),
  /** Which of the capture's lines this listing is (0-based). */
  line: z.coerce.number().int().min(0).max(19).optional(),
  /** A what-if sale price typed in the panel — never saved. */
  sale: z.coerce.number().positive().max(100000).optional(),
}).refine((q) => q.asin || q.supplier, { message: "asin or supplier is required" });
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

/** Pure: SKU / UPC as compared — dashes, spaces, dots stripped, case folded. */
export const normSku = (s: string | null | undefined): string => String(s ?? "").replace(/[-\s.]/g, "").toLowerCase();

// The pack-size tokens a listing name carries: shared/pack-parse.ts (moved 2026-11-06).
export { parsePack } from "@shared/pack-parse";
import { parsePack } from "@shared/pack-parse";

/** Pure: two base names' similarity, 0–1 — 1 when equal; otherwise the Dice coefficient of their word sets. */
export function nameScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  let both = 0; A.forEach((w) => { if (B.has(w)) both++; });
  return Math.round(((2 * both) / (A.size + B.size)) * 1000) / 1000;
}

export interface Candidate { asin: string; title: string | null; productName: string; score: number; by: "sku" | "name" }
export const CONFIDENT = 0.85, SHOWN = 0.35, GAP = 0.2;
/**
 * Pure: the supplier's past lines → one confident ASIN or the top 3. A SKU hit naming one ASIN is confident; several
 * ASINs on one SKU are choices. By name: an exact base name naming one ASIN, or a best score ≥ 0.85 that leads the
 * next ASIN by ≥ 0.2, is confident; otherwise up to 3 ASINs scoring ≥ 0.35 (best line per ASIN).
 */
export function matchListing(lines: ReadonlyArray<{ asin: string; title: string | null; product_name: string | null; supplier_sku: string | null }>, listing: { name?: string; sku?: string }): { confident: Candidate | null; choices: Candidate[] } {
  const sku = normSku(listing.sku);
  if (sku.length >= 3) {
    const hits = new Map<string, Candidate>();
    for (const l of lines) if (normSku(l.supplier_sku) === sku && !hits.has(l.asin)) hits.set(l.asin, { asin: l.asin, title: l.title, productName: l.product_name ?? "", score: 1, by: "sku" });
    const h = Array.from(hits.values());
    if (h.length === 1) return { confident: h[0], choices: [] };
    if (h.length > 1) return { confident: null, choices: h.slice(0, 3) };
  }
  const base = parsePack(listing.name).base;
  if (!base) return { confident: null, choices: [] };
  const best = new Map<string, Candidate>();
  for (const l of lines) {
    const score = nameScore(base, parsePack(l.product_name).base);
    const cur = best.get(l.asin);
    if (!cur || score > cur.score) best.set(l.asin, { asin: l.asin, title: l.title, productName: l.product_name ?? "", score, by: "name" });
  }
  const ranked = Array.from(best.values()).filter((c) => c.score >= SHOWN).sort((a, b) => b.score - a.score || a.asin.localeCompare(b.asin));
  const [top, next] = ranked;
  if (top && ((top.score === 1 && (!next || next.score < 1)) || (top.score >= CONFIDENT && (!next || top.score - next.score >= GAP)))) return { confident: top, choices: [] };
  return { confident: null, choices: ranked.slice(0, 3) };
}

/** Pure: "6-pack × 2", "× 12" (each), from the line's retailer units per product (else its name's pack token) and qty. */
export function howBought(retailerUnits: number | null, productName: string | null, qty: number | null): string {
  const pack = retailerUnits ?? parsePack(productName).pack;
  const q = qty == null ? "?" : String(Math.round(qty * 100) / 100);
  return pack && pack > 1 ? `${pack}-pack × ${q}` : `× ${q}`;
}
/** Pure: "this listing: 12-pack → 4 ASIN units (ASIN is a 3-pack)"; null unless both pack sizes are known. */
export function conversionLine(listingPack: number | null, asinPack: number | null): string | null {
  if (!listingPack || !asinPack) return null;
  const units = Math.round((listingPack / asinPack) * 100) / 100;
  const lp = listingPack === 1 ? "single" : `${listingPack}-pack`, ap = asinPack === 1 ? "a single" : `a ${asinPack}-pack`;
  return `this listing: ${lp} → ${units} ASIN unit${units === 1 ? "" : "s"} (ASIN is ${ap})`;
}

export interface AsinHistory {
  asin: string; title: string | null; asinPack: number | null;
  last: { cogs: number; orderDate: string; orderId: string; supplier: string } | null;
  avg365: number | null; pos365: number; units365: number;
  recent: Array<{ orderDate: string; orderId: string; supplier: string; how: string; asinUnits: number | null; cogs: number | null; promos: PromoShown[] }>;
  conversion: string | null;
}
/** A line fully canceled by its claims (po_line_expected, migration 101). */
const lineCanceled = `COALESCE((SELECT le.fully_canceled FROM po_line_expected le WHERE le.line_id = l.id), false)`;
const notCanceled = `NOT COALESCE((SELECT bool_and(${lineCanceled}) FROM po_line_items l WHERE l.po_asin_id = pa.id), false)`;
const n = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export async function asinHistory(query: QueryLike, asin: string, listingPack: number | null = null, today?: string): Promise<AsinHistory> {
  const meta = (await query(`SELECT title, units_per_pack FROM asins WHERE asin = $1`, [asin])).rows[0] as any;
  const rows = (await query(
    `SELECT p.id AS po_id, p.order_id, p.order_date::text AS order_date, p.supplier, (SELECT e.ordered_asin FROM po_asin_expected e WHERE e.id = pa.id) AS qty, pa.cost_per_unit, pa.asin_name, pa.units_per_pack,
            (p.order_date >= COALESCE($2::date, (now() AT TIME ZONE 'America/New_York')::date) - 365) AS in365,
            (SELECT json_agg(json_build_object('ru', l.retailer_units_per_product, 'name', l.product_name, 'qty', (SELECT le.ordered_product FROM po_line_expected le WHERE le.line_id = l.id)) ORDER BY l.position) FROM po_line_items l WHERE l.po_asin_id = pa.id AND NOT ${lineCanceled}) AS lines
       FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
      WHERE pa.asin = $1 AND ${notCanceled}
      ORDER BY ${NEWEST_PO_ORDER}`,
    [asin, today ?? null],
  )).rows as any[];
  const lastRow = rows.find((r) => n(r.cost_per_unit) != null);
  let wSum = 0, wUnits = 0, units365 = 0; const pos = new Set<string>();
  for (const r of rows) {
    if (!r.in365) continue;
    const q = n(r.qty) ?? 0, c = n(r.cost_per_unit);
    pos.add(`${r.supplier}\u0000${r.order_id}`); units365 += q;
    if (c != null && q > 0) { wSum += c * q; wUnits += q; }
  }
  const recentRows = rows.slice(0, 5);
  const promosByPo = new Map<string, PromoShown[]>();
  if (recentRows.length) {
    const pr = (await query(`SELECT po_id::text AS po_id, type, description, amount, percent FROM po_promos WHERE po_id = ANY($1::uuid[]) ORDER BY po_id, position, id`, [recentRows.map((r) => String(r.po_id))])).rows as any[];
    for (const x of pr) { const k = String(x.po_id); (promosByPo.get(k) ?? promosByPo.set(k, []).get(k)!).push(promoShown(x)); }
  }
  // The ASIN's pack size: the catalog's, else the newest PO row's units per pack.
  const asinPack = n(meta?.units_per_pack) ?? n(rows[0]?.units_per_pack);
  return {
    asin, title: meta?.title ?? rows[0]?.asin_name ?? null, asinPack,
    last: lastRow ? { cogs: Number(lastRow.cost_per_unit), orderDate: lastRow.order_date, orderId: lastRow.order_id, supplier: lastRow.supplier } : null,
    avg365: wUnits > 0 ? Math.round((wSum / wUnits) * 100) / 100 : null, pos365: pos.size, units365: Math.round(units365 * 100) / 100,
    recent: recentRows.map((r) => ({
      orderDate: r.order_date, orderId: r.order_id, supplier: r.supplier, asinUnits: n(r.qty), cogs: n(r.cost_per_unit), promos: promosByPo.get(String(r.po_id)) ?? [],
      how: ((r.lines as any[] | null) ?? []).map((l) => howBought(n(l.ru), l.name, n(l.qty))).join(" + ") || "—",
    })),
    conversion: conversionLine(listingPack, asinPack),
  };
}

export interface HistoryResult {
  supplier: { host: string; supplier: string; known: boolean; lastEmail: { email: string; orderDate: string; orderId: string } | null; codes: CodeUsed[] } | null;
  listing: { pack: number | null; base: string } | null;
  match: { kind: "asin" | "confident" | "picked" | "choices" | "none"; by: "sku" | "name" | null; choices: Candidate[] };
  history: AsinHistory | null;
  /** Capture PO: this capture's line costed and priced (only with &po= and a history). */
  thisPo?: ThisPo | null;
}

export async function extensionHistory(query: QueryLike, q: HistoryQuery, today?: string): Promise<HistoryResult> {
  if (!q.supplier) return { supplier: null, listing: null, match: { kind: "asin", by: null, choices: [] }, history: await asinHistory(query, q.asin!, null, today) };
  const suppliers = (await query(`SELECT DISTINCT supplier FROM purchase_orders`)).rows.map((r: any) => String(r.supplier));
  const sup = supplierForHost(q.supplier, suppliers, await loadAliases(query));
  const em = sup.known ? (await query(
    `SELECT p.email_used, p.order_date::text AS order_date, p.order_id FROM purchase_orders p WHERE p.supplier = $1 AND NULLIF(trim(p.email_used), '') IS NOT NULL ORDER BY ${NEWEST_PO_ORDER} LIMIT 1`, [sup.supplier])).rows[0] as any : null;
  const codes = sup.known && !q.name && !q.sku && !q.asin ? await codesUsed(query, sup.supplier) : [];
  const supplier = { host: q.supplier, supplier: sup.supplier, known: sup.known, lastEmail: em ? { email: String(em.email_used), orderDate: em.order_date, orderId: em.order_id } : null, codes };
  const parsed = q.name ? parsePack(q.name) : null;
  const listing = q.name || q.pack ? { pack: q.pack ?? parsed?.pack ?? null, base: parsed?.base ?? "" } : null;
  const pack = listing?.pack ?? null;
  const withThisPo = async (r: HistoryResult): Promise<HistoryResult> => (r.history && q.po ? { ...r, thisPo: await thisPoFor(query, sup.supplier, r.history, pack, q) } : r);
  if (q.asin) return withThisPo({ supplier, listing, match: { kind: "picked", by: null, choices: [] }, history: await asinHistory(query, q.asin, pack, today) });
  if (!sup.known || (!q.name && !q.sku)) return { supplier, listing, match: { kind: "none", by: null, choices: [] }, history: null };
  const lines = (await query(
    `SELECT DISTINCT pa.asin, COALESCE(a.title, pa.asin_name) AS title, l.product_name, l.supplier_sku
       FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id LEFT JOIN asins a ON a.asin = pa.asin
      WHERE p.supplier = $1 AND NOT ${lineCanceled}`, [sup.supplier])).rows as any[];
  const m = matchListing(lines, { name: q.name, sku: q.sku });
  if (m.confident) return withThisPo({ supplier, listing, match: { kind: "confident", by: m.confident.by, choices: [m.confident] }, history: await asinHistory(query, m.confident.asin, pack, today) });
  return { supplier, listing, match: { kind: m.choices.length ? "choices" : "none", by: m.choices[0]?.by ?? null, choices: m.choices }, history: null };
}

// ── Past promos (Maria 2026-11-05) ────────────────────────────────────────────
// Each recent purchase shows its PO's promos ("FAIRTHANKS20 · 20% · −$39.60", "Sale −$12.00"); the supplier line lists
// the coupon codes used on its POs. A code is the token after "with" / "code" in the promo's description, else a
// capitalized token holding a letter and a digit (SAVE10); B1G1 / BOGO are deals, not codes.
export interface PromoShown { type: string | null; code: string | null; label: string; percent: number | null; amount: number | null }
export interface CodeUsed { code: string; type: string | null; percent: number | null; amount: number | null; lastDate: string; pos: number }

const DEAL = /^(?:B\d+G\d+|BOGO)$/i;
/** Pure: the coupon code a promo description names, or null. */
export function promoCode(description: string | null | undefined): string | null {
  const d = String(description ?? "");
  const tok = (re: RegExp) => { const m = re.exec(d); return m && !DEAL.test(m[1]) ? m[1] : null; };
  return tok(/\b(?:with|code|promo(?:\s+code)?)\s*:?\s+([A-Z0-9][A-Z0-9_-]{2,})(?![a-z])/)
    ?? (d.match(/\b[A-Z0-9][A-Z0-9_-]{3,}\b/g) ?? []).find((t) => /[A-Z]/.test(t) && /\d/.test(t) && !DEAL.test(t)) ?? null;
}
const money = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number) => `${Number.isInteger(v) ? v : Math.round(v * 100) / 100}%`;
const TYPE_LABEL: Record<string, string> = { sale: "Sale", coupon: "Coupon", rewards: "Rewards" };
/** Pure: one stored promo as the panel shows it. */
export function promoShown(r: { type: string | null; description: string | null; amount: unknown; percent: unknown }): PromoShown {
  const code = promoCode(r.description), amount = n(r.amount), percent = n(r.percent);
  const head = code ?? (r.type ? TYPE_LABEL[r.type] ?? r.type : String(r.description ?? "Promo").slice(0, 40));
  const label = [head, percent != null ? pct(percent) : null, amount != null ? `−${money(amount)}` : null].filter(Boolean).join(code || percent != null ? " · " : " ");
  return { type: r.type, code, label, percent, amount };
}

/** The supplier's coupon codes: distinct, most recent first, with type / value of the latest use, last date and PO count. */
export async function codesUsed(query: QueryLike, supplier: string): Promise<CodeUsed[]> {
  const rows = (await query(
    `SELECT p.id::text AS po_id, p.order_date::text AS order_date, pr.type, pr.description, pr.amount, pr.percent
       FROM po_promos pr JOIN purchase_orders p ON p.id = pr.po_id
      WHERE p.supplier = $1 AND pr.description IS NOT NULL
      ORDER BY p.order_date DESC NULLS LAST, pr.id DESC`, [supplier])).rows as any[];
  const by = new Map<string, CodeUsed & { poIds: Set<string> }>();
  for (const r of rows) {
    const code = promoCode(r.description);
    if (!code) continue;
    const k = code.toUpperCase();
    const cur = by.get(k);
    if (cur) { cur.poIds.add(r.po_id); continue; }
    by.set(k, { code, type: r.type ?? null, percent: n(r.percent), amount: n(r.amount), lastDate: r.order_date, pos: 0, poIds: new Set([r.po_id]) });
  }
  return Array.from(by.values()).map(({ poIds, ...c }) => ({ ...c, pos: poIds.size }));
}

// ── This PO (Maria 2026-11-05; docs/claude_cogs-rule.md) ─────────────────────
// The capture's line as a COGS per ASIN unit — the PO form's own allocation (shared/po-cost.ts allocateAsinCosts:
// line total + its share of tax and shipping − discounts, × (1 − the weighted gift-card / card-reward %), ÷ ASIN units)
// — and its profit through calculateProfit, the function AF's ASIN page uses (client/src/lib/profit.ts), with the same
// inputs: the stored price by the default price source (Lowest FBA, then Buy Box, then lowest), the stored fees, the
// prep cost the ship-to gives, storage, inbound shipping and the DG / hazmat surcharge. Nothing is guessed: no price or
// no fees → no profit, with what is missing. AF data only, no AI.
const PoMoney = z.union([z.string(), z.number()]).nullable().optional();
export const CapturePoSchema = z.object({
  lines: z.array(z.object({ qty: z.number().nullable().optional(), price: PoMoney, total: PoMoney })).max(20),
  totals: z.object({ subtotal: PoMoney, discount: PoMoney, tax: PoMoney, shipping: PoMoney, total: PoMoney }).partial().default({}),
  cards: z.array(z.object({ nickname: z.string().nullable().optional(), last4: z.string().nullable().optional(), amount: PoMoney })).max(10).default([]),
  giftCards: z.array(z.object({ last4: z.string().nullable().optional(), amount: PoMoney })).max(20).default([]),
  promos: z.array(z.string().max(300)).max(20).default([]),
  street: z.string().max(200).nullable().optional(),
});
export type CapturePo = z.infer<typeof CapturePoSchema>;

/** Pure: "$1,234.56" / "-$39.60" / 12 → a number, null when blank or unreadable. */
export function moneyOf(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(String(v).replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
  return String(v).trim() === "" || !Number.isFinite(x) ? null : x;
}

export interface PaymentPct { pct: number | null; parts: string[]; unknown: string[] }
/** Pure: the weighted payment % of the capture (weightedPaymentPct) — a card's reward % from settings, a gift card's from the supplier's last gift-card PO. */
export function capturePaymentPct(po: CapturePo, lists: PaymentLists, rewards: Record<string, number> | null, gcPct: number | null): PaymentPct {
  const total = moneyOf(po.totals.total);
  const all = po.cards.length + po.giftCards.length;
  // One payment without an amount pays the whole order.
  const amt = (a: unknown) => moneyOf(a) ?? (all === 1 ? total : null);
  const parts: string[] = [], unknown: string[] = [], pays: Parameters<typeof weightedPaymentPct>[0][number][] = [];
  for (const c of po.cards) {
    const r = resolvePaymentNickname(c.nickname ?? "", /^\d{4}$/.test(c.last4 ?? "") ? c.last4! : "", lists);
    const reward = r.nickname ? defaultRewardPct(r.nickname, rewards) : null;
    if (reward != null) parts.push(`${r.nickname} reward ${pct(reward)}`);
    pays.push({ method: "card", amount: amt(c.amount), reward_pct: reward ?? 0 });
  }
  for (const g of po.giftCards) {
    if (gcPct == null) unknown.push("gift-card %");
    pays.push({ method: "gift_card", amount: amt(g.amount), gift_card_discount_pct: gcPct ?? 0 });
  }
  if (po.giftCards.length && gcPct != null) parts.push(`gift card ${pct(gcPct)} (last gift-card PO)`);
  if (pays.some((p) => p.amount == null)) unknown.push("payment amounts");
  return { pct: total != null && total > 0 ? weightedPaymentPct(pays, total) : null, parts: Array.from(new Set(parts)), unknown: Array.from(new Set(unknown)) };
}

/** Pure: ASIN units of a capture line — qty × listing pack ÷ ASIN pack, with a note when a pack size is not known (counted as 1). */
export function captureAsinUnits(qty: number | null | undefined, listingPack: number | null, asinPack: number | null): { units: number | null; notes: string[] } {
  if (qty == null || !(qty > 0)) return { units: null, notes: ["qty not captured"] };
  const notes: string[] = [];
  if (!listingPack && asinPack && asinPack > 1) notes.push("listing pack size not in its name — counted as a single");
  if (!asinPack) notes.push("ASIN pack size not known — counted as a single");
  const units = Math.round(((qty * (listingPack ?? 1)) / (asinPack ?? 1)) * 1e6) / 1e6;
  return { units, notes };
}

export interface ThisPoCost { cogs: number | null; asinUnits: number | null; estimate: boolean; notes: string[]; paymentParts: string[] }
/**
 * Pure: the capture's line `idx` → COGS per ASIN unit. Every line is the allocation base (as the form allocates a PO),
 * the reflected-discount rule applies, and it is an estimate until Totals (the order total) and Payment are both
 * captured and nothing in them is unknown.
 */
export function thisPoCost(po: CapturePo, idx: number, units: { units: number | null; notes: string[] }, pay: PaymentPct): ThisPoCost {
  const notes = [...units.notes];
  const line = po.lines[idx];
  const toCost = (l: CapturePo["lines"][number]): CostLine => ({ price: moneyOf(l.price), qty: l.qty ?? 1, lineTotal: moneyOf(l.total) });
  const lines = po.lines.map(toCost);
  const t = po.totals;
  const discount = Math.abs(moneyOf(t.discount) ?? 0), tax = moneyOf(t.tax) ?? 0, shipping = moneyOf(t.shipping) ?? 0, total = moneyOf(t.total);
  const hasTotals = total != null, hasPayment = po.cards.length + po.giftCards.length > 0;
  if (!hasTotals) notes.push("Totals not captured — line total only");
  if (!hasPayment) notes.push("Payment not captured — no gift-card / reward %");
  for (const u of pay.unknown) notes.push(`${u} not known`);
  const est = !hasTotals || !hasPayment || pay.unknown.length > 0 || units.notes.length > 0;
  if (!line || units.units == null) return { cogs: null, asinUnits: units.units, estimate: true, notes: line ? notes : [...notes, "line not in the capture"], paymentParts: pay.parts };
  // A line with no money of its own costs nothing knowable; the others can still be allocated around it.
  const mine = lineMoney(toCost(line));
  if (mine == null) return { cogs: null, asinUnits: units.units, estimate: true, notes: [...notes, "line price not captured"], paymentParts: pay.parts };
  const known = lines.filter((l) => lineMoney(l) != null);
  const L = known.reduce((s, l) => s + (lineMoney(l) as number), 0);
  if (known.length < lines.length && hasTotals) notes.push("another line has no price — its share of tax / shipping / discount is spread over the rest");
  const reflected = discountReflectedInLines({ linesSum: Math.round(L * 100) / 100, discount, postDiscountSubtotal: total == null ? null : Math.round((total - tax - shipping) * 100) / 100 });
  const header = effectiveCostHeader({ subtotal: L, discount: hasTotals ? discount : 0, gcPct: pay.pct, tax: hasTotals ? tax : 0, shDonations: hasTotals ? shipping : 0 }, reflected);
  const c = allocateAsinCosts(header, [toCost(line)], units.units);
  return { cogs: c ? c.cogs : null, asinUnits: units.units, estimate: est, notes, paymentParts: pay.parts };
}

export interface ThisPo extends ThisPoCost {
  vsLast: number | null;
  sale: { price: number; label: string; typed: boolean; fetchedAt: string | null } | null;
  prep: { value: number; why: string };
  fees: { fba: number | null; referral: number | null };
  profit: number | null; roi: number | null; margin: number | null;
  /** Why profit / ROI / margin are "—". */
  missing: string[];
}

export async function thisPoFor(query: QueryLike, supplier: string, h: AsinHistory, listingPack: number | null, q: HistoryQuery): Promise<ThisPo | null> {
  let po: CapturePo;
  try { po = CapturePoSchema.parse(JSON.parse(q.po!)); } catch { return null; }
  const settingRows = (await query(`SELECT key, value FROM settings`)).rows as Array<{ key: string; value: unknown }>;
  const sv = (k: string) => settingRows.find((r) => r.key === k)?.value;
  const lists: PaymentLists = { methods: Array.isArray(sv("po_payment_methods")) ? (sv("po_payment_methods") as string[]) : [], aliases: (sv("po_payment_method_aliases") ?? {}) as Record<string, string>, last4: (sv("po_payment_method_last4") ?? {}) as Record<string, string> };
  // A gift card's % is not on the page: the supplier's newest PO paid by gift cards only carries it (weighted_gc_discount_pct).
  const gc = po.giftCards.length ? (await query(
    `SELECT p.weighted_gc_discount_pct FROM purchase_orders p WHERE p.supplier = $1 AND p.weighted_gc_discount_pct IS NOT NULL
        AND EXISTS (SELECT 1 FROM po_payments y WHERE y.po_id = p.id AND y.method = 'gift_card')
        AND NOT EXISTS (SELECT 1 FROM po_payments y WHERE y.po_id = p.id AND y.method <> 'gift_card')
      ORDER BY ${NEWEST_PO_ORDER} LIMIT 1`, [supplier])).rows[0] as any : null;
  const pay = capturePaymentPct(po, lists, (sv("po_payment_method_reward_pct") ?? null) as Record<string, number> | null, gc ? n(gc.weighted_gc_discount_pct) : null);
  const idx = q.line ?? 0;
  const cost = thisPoCost(po, idx, captureAsinUnits(po.lines[idx]?.qty, listingPack, h.asinPack), pay);
  const vsLast = cost.cogs != null && h.last && h.last.cogs > 0 ? Math.round(((cost.cogs - h.last.cogs) / h.last.cogs) * 1000) / 1000 : null;

  const settings = settingsFromRows(settingRows);
  const e = (await query(
    `SELECT a.weight_lb, a.category, a.is_hazmat, a.is_dangerous_good, e.lowest_fba_price, e.buy_box_price, e.buy_box_fulfillment, e.lowest_price,
            e.fba_fee, e.referral_fee, e.fees_estimate_price, e.storage_override, e.fetched_at
       FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin WHERE a.asin = $1`, [h.asin])).rows[0] as any;
  // Prep from the ship-to (the PO form's rule, server/po-prefill.ts shipsToForStreet): Velocity → the prep setting, Home → 0.
  const streets = { velocityStreet: String(sv("tracking.velocity_street") ?? "805 grandy"), homeStreets: (sv("tracking.home_streets") as string[]) ?? ["65 rivercrest"], prepCost: settings.prepCost };
  const st = shipsToForStreet(po.street ?? null, streets);
  const prep = st.ships_to === "home" ? { value: 0, why: "ships to Home" } : st.ships_to === "velocity" ? { value: settings.prepCost, why: "ships to Velocity" } : { value: settings.prepCost, why: "ship-to not captured — Velocity prep" };
  const fees = { fba: e ? n(e.fba_fee) : null, referral: e ? n(e.referral_fee) : null };
  const base: ThisPo = { ...cost, vsLast, sale: null, prep, fees, profit: null, roi: null, margin: null, missing: [] };
  if (!e) return { ...base, missing: ["ASIN not in AF"] };
  const stored = getSelectedPrice({ pricingData: { lowestFbaPrice: n(e.lowest_fba_price), buyBoxPrice: n(e.buy_box_price), buyBoxFulfillment: e.buy_box_fulfillment ?? null, lowestPrice: n(e.lowest_price) } } as unknown as AsinResult, "lowestFba");
  const fetchedAt = e.fetched_at ? new Date(e.fetched_at).toISOString() : null;
  const sale = q.sale != null ? { price: q.sale, label: "your price", typed: true, fetchedAt: null } : stored.price != null ? { price: stored.price, label: stored.label, typed: false, fetchedAt } : null;
  const missing: string[] = [];
  if (!sale) missing.push("no sale price in AF (no Lowest FBA, Buy Box or offer price)");
  if (fees.fba == null || fees.referral == null) missing.push(`no ${fees.fba == null && fees.referral == null ? "FBA or referral fee" : fees.fba == null ? "FBA fee" : "referral fee"} in AF yet`);
  if (cost.cogs == null) missing.push("no COGS for this line");
  if (missing.length || !sale || cost.cogs == null) return { ...base, sale, missing };
  const calc = calculateProfit(sale.price, cost.cogs, fees.fba!, fees.referral!, n(e.fees_estimate_price), n(e.weight_lb), prep.value,
    n(e.storage_override) ?? settings.storageFee, settings, String(sv("include_inbound_shipping") ?? "true") !== "false",
    appliesDgHazmatSurcharge({ isHazmat: e.is_hazmat, isDangerousGood: e.is_dangerous_good }), e.category ?? null);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  // ROI = profit ÷ COGS, margin = profit ÷ sale price (calculateProfit's own, in percent).
  return { ...base, sale, profit: r2(calc.profit), roi: r2(calc.roi), margin: r2(calc.margin), missing };
}
