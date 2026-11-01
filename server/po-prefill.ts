// /api/pos/prefill — Capture PO (patch docs/claude_spec-patch-po-ai-prefill.md
// §4.5, §5). The extension posts the scrubbed page captures; ONE Claude call
// (Haiku-class, server/config/ai.ts) turns the merged page text into the
// strict JSON below; the server then enriches it with no AI (supplier from
// the hostname, ships_to / prep from the ship-to street, ASIN candidates per
// line from AF's history, totals cross-checks → warnings) and hands back a
// PoFormState partial plus the §6.1 markers. The payload can exceed URL
// limits, so it is parked under a 10-minute in-memory key (not a table —
// this is not a draft) and the form opens /pos/new?prefill=<key>.
// A schema failure returns the raw-text fallback: the form opens empty with
// the captured text in a side drawer. Every call is logged in po_prefill_log
// (no page text), and the PO id is attached on save.
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { QueryLike } from "./scheduler/types";
import { AI, anthropicClient, estimateCost } from "./config/ai";
import { PROMO_RULES } from "./promo-classify";
import { suggestAsins } from "./asin-suggest";
import { normalizeStreet } from "./tracking-parse";
import { loadAliases, aliasKey } from "./supplier-aliases";
import { promoCountsByDefault, yieldFromPacks, type PoFormState, type PoFormProduct, type PoFormPrefill, type PrefillSource } from "@shared/po-form";

// ── Input (from the extension, already scrubbed) ─────────────────────────────
export const CapturePageSchema = z.object({
  step: z.enum(["cart", "shipping", "payment", "review", "other"]).default("other"),
  url: z.string().max(2048),
  title: z.string().max(500).default(""),
  text: z.string().max(200_000),
  fields: z.array(z.object({ label: z.string().max(200), value: z.string().max(2000) })).max(500).default([]),
});
export const CaptureSchema = z.object({
  retailerHost: z.string().max(253),
  capturedAt: z.string().optional(),
  pages: z.array(CapturePageSchema).min(1).max(12),
});
export type Capture = z.infer<typeof CaptureSchema>;

// ── Output (the model's strict JSON) ─────────────────────────────────────────
const money = z.number().nullable();
export const PrefillSchema = z.object({
  retailer: z.string().nullable(),
  orderId: z.string().nullable(),
  orderDate: z.string().nullable().describe("YYYY-MM-DD"),
  lines: z.array(z.object({
    productName: z.string(),
    retailerSku: z.string().nullable(),
    qty: z.number().nullable().describe("the ordered quantity of this line: the cart quantity stepper / 'Qty' / the multiplier in '12 × $7.97' — NEVER a 'Multipack Quantity' or pack count"),
    unitsPerPack: z.number().int().nullable().describe("the retailer's pack, e.g. 12 for a 12-count; 1 when sold singly"),
    unitPrice: money.describe("the price actually paid per item after item-level discounts"),
    lineTotal: money,
    asinGuess: z.string().nullable().describe("10-character Amazon ASIN only when the page shows one"),
  })),
  subtotal: money, discount: money, tax: money, shipping: money.describe("shipping + handling + donations"), total: money,
  promos: z.array(z.object({ type: z.enum(["sale", "coupon", "rewards"]), description: z.string(), amount: money, percent: money, confidence: z.enum(["high", "low"]) })),
  payments: z.array(z.object({ method: z.enum(["card", "gift_card", "store_credit", "paypal", "other"]), nickname: z.string().nullable(), last4: z.string().nullable(), amount: money })),
  shipToStreet: z.string().nullable().describe("street number and name of the delivery address"),
  subscription: z.object({ present: z.boolean(), frequencyWeeks: z.number().int().nullable() }),
  purchasedEmail: z.string().nullable(),
  notes: z.array(z.string()).describe("confidence notes: anything unclear or inconsistent on the pages"),
});
export type PrefillExtraction = z.infer<typeof PrefillSchema>;

export const PREFILL_SYSTEM = `You read captured text from a retailer's checkout pages (cart, shipping, payment, review, order confirmation) and extract the purchase order exactly as the retailer shows it. Rules:
- Use only what the pages say. Unknown → null. Never invent an order id, price or ASIN.
- Card and gift-card numbers were masked before you see them ("•••• 1234"): report only the nickname (Visa, Amex, Chase…) and the last 4 digits.
- unitPrice is the price actually paid per item after any item-level sale or coupon; qty is the ORDERED quantity of the line — the cart's quantity stepper / "Qty" / the multiplier in "12 × $7.97 = $95.64" (12) — never a "Multipack Quantity", pack count or units per pack; unitsPerPack is the retailer's pack (a "12 ct" is 12), 1 when sold singly. qty × unitPrice must equal lineTotal.
- subtotal / discount / tax / shipping / total are the order-level figures; discount is the order-level discount (positive).
- Payments: one entry per method shown with its amount. Gift cards are method "gift_card"; store credit, rewards balance and similar are "store_credit".
- subscription.present is true only when the pages show a subscription / autoship for this order; frequencyWeeks in weeks (monthly = 4).
- Promos: ${PROMO_RULES}`;

export function mergedPagesText(c: Capture): string {
  const order = ["cart", "shipping", "payment", "review", "other"];
  const pages = [...c.pages].sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
  return pages.map((p, i) => {
    const fields = p.fields.length ? `\nFORM FIELDS:\n${p.fields.map((f) => `${f.label}: ${f.value}`).join("\n")}` : "";
    return `=== PAGE ${i + 1} (${p.step}) ${p.title} — ${p.url} ===\n${p.text}${fields}`;
  }).join("\n\n");
}

export interface ExtractDeps { call?: (system: string, user: string) => Promise<{ parsed: unknown; input_tokens: number; output_tokens: number }> }
async function defaultCall(system: string, user: string) {
  const res = await anthropicClient().messages.parse({
    model: AI.model, max_tokens: AI.maxTokens, output_config: { effort: AI.effort, format: zodOutputFormat(PrefillSchema) },
    system, messages: [{ role: "user", content: user }],
  });
  return { parsed: res.parsed_output ?? null, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
}
export interface ExtractResult { extraction: PrefillExtraction | null; usage: { input_chars: number; input_tokens: number; output_tokens: number; cost_estimate: number; duration_ms: number; schema_ok: boolean; error: string | null } }
/** The one model call. A schema failure or an API error returns extraction null (the raw-text fallback), never a throw. */
export async function extractPrefill(capture: Capture, deps: ExtractDeps = {}): Promise<ExtractResult> {
  const user = `Retailer host: ${capture.retailerHost}\n\n${mergedPagesText(capture)}`;
  const t0 = Date.now();
  try {
    const r = await (deps.call ?? defaultCall)(PREFILL_SYSTEM, user);
    const parsed = PrefillSchema.safeParse(r.parsed);
    return { extraction: parsed.success ? parsed.data : null, usage: { input_chars: PREFILL_SYSTEM.length + user.length, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_estimate: estimateCost(r.input_tokens, r.output_tokens), duration_ms: Date.now() - t0, schema_ok: parsed.success, error: parsed.success ? null : "schema: " + parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } };
  } catch (e: any) {
    return { extraction: null, usage: { input_chars: PREFILL_SYSTEM.length + user.length, input_tokens: 0, output_tokens: 0, cost_estimate: 0, duration_ms: Date.now() - t0, schema_ok: false, error: String(e?.message ?? e).slice(0, 500) } };
  }
}

// ── Enrichment, no AI ────────────────────────────────────────────────────────
export const hostname = (h: string): string => h.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
const registrable = (d: string) => d.split(".").slice(-2).join(".");
/** Pure: hostname → AF supplier. Exact (AF's supplier is the domain), then an alias, then the same registrable domain; else the hostname itself, flagged new. */
export function supplierForHost(host: string, suppliers: readonly string[], aliases: ReadonlyMap<string, string>): { supplier: string; known: boolean } {
  const h = hostname(host);
  const exact = suppliers.find((s) => s.toLowerCase() === h);
  if (exact) return { supplier: exact, known: true };
  const a = aliases.get(aliasKey(h));
  if (a) return { supplier: a, known: true };
  const same = suppliers.filter((s) => registrable(s.toLowerCase()) === registrable(h));
  if (same.length === 1) return { supplier: same[0], known: true };
  return { supplier: h, known: false };
}
/** Pure: §4.4 ship-to street → ships_to / prep (the same settings the tracking router uses). */
export function shipsToForStreet(street: string | null, s: { velocityStreet: string; homeStreets: readonly string[]; prepCost: number }): { ships_to: "velocity" | "home" | ""; prep: string } {
  const n = street ? normalizeStreet(street) : null;
  if (n && n === normalizeStreet(s.velocityStreet)) return { ships_to: "velocity", prep: s.prepCost.toFixed(2) };
  if (n && s.homeStreets.some((h) => normalizeStreet(h) === n)) return { ships_to: "home", prep: "0" };
  return { ships_to: "", prep: "" };
}
const m2 = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? "" : (Math.round(v * 100) / 100).toFixed(2));
const r2 = (x: number) => Math.round(x * 100) / 100;

// ── Qty cross-check (Maria 2026-11-01: a Walmart "12 × $7.97 = $95.64" line came through as qty 1) ──
/** Pure: the numbers the captured pages show as a quantity — a form field labelled qty / quantity or holding a bare integer (the cart stepper), "Qty 12", "12 × $7.97", "$7.97 × 12", or an integer on a line of its own. */
export function visibleQtys(c: Pick<Capture, "pages">): Set<number> {
  const out = new Set<number>();
  const add = (s: string | undefined) => { const n = Number(s); if (Number.isInteger(n) && n >= 1 && n <= 9999) out.add(n); };
  for (const p of c.pages) {
    for (const f of p.fields) { const v = f.value.trim(); if (/qty|quantity/i.test(f.label) || /^\d{1,4}$/.test(v)) add(/^\d{1,4}/.exec(v)?.[0]); }
    for (const re of [/\b(?:qty|quantity)\s*[:.]?\s*(\d{1,4})\b/gi, /\b(\d{1,4})\s*[×x]\s*\$/gi, /\$\s*[\d,]+(?:\.\d+)?\s*[×x]\s*(\d{1,4})\b/gi, /^\s*(\d{1,4})\s*$/gm]) {
      for (const m of Array.from(p.text.matchAll(re))) add(m[1]);
    }
  }
  return out;
}
export const QTY_INFERRED_HINT = "qty inferred from subtotal";
/** Pure: when the line's qty does not explain its total (the subtotal, for a single-line order) but total ÷ price is a whole number the page shows as a quantity, that number is the qty. Null = keep the model's. */
export function inferLineQty(l: { qty: number | null; unitPrice: number | null; lineTotal: number | null }, subtotal: number | null, singleLine: boolean, visible: ReadonlySet<number>): number | null {
  if (l.unitPrice == null || !(l.unitPrice > 0)) return null;
  const total = l.lineTotal ?? (singleLine ? subtotal : null);
  if (total == null) return null;
  const fits = (q: number) => Math.abs(q * l.unitPrice! - total) <= 0.005 * q + 0.01;
  if (l.qty != null && fits(l.qty)) return null;
  const whole = Math.round(total / l.unitPrice);
  if (whole < 1 || whole === l.qty || !fits(whole)) return null;
  return visible.has(whole) ? whole : null;
}

export interface PrefillPayload { form: Partial<PoFormState>; prefill: PoFormPrefill }

/** Turn the extraction into the form's state with markers and warnings. */
export async function enrichPrefill(query: QueryLike, capture: Capture, x: PrefillExtraction | null, rawText: string | null, meta: { id: string; capturedAt: string | null }): Promise<PrefillPayload> {
  const sources: Record<string, PrefillSource> = {};
  const warnings: string[] = [];
  const suppliers = (await query(`SELECT DISTINCT supplier FROM purchase_orders`)).rows.map((r: any) => String(r.supplier));
  const sup = supplierForHost(capture.retailerHost, suppliers, await loadAliases(query));
  if (!sup.known) warnings.push(`New supplier: ${sup.supplier} has no PO in AF yet`);
  const settingsRows = (await query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [["tracking.velocity_street", "tracking.home_streets", "prep_cost"]])).rows;
  const sv = (k: string) => settingsRows.find((r: any) => r.key === k)?.value;
  const streets = { velocityStreet: String(sv("tracking.velocity_street") ?? "805 grandy"), homeStreets: (sv("tracking.home_streets") as string[]) ?? ["65 rivercrest"], prepCost: Number(sv("prep_cost") ?? 1) || 1 };
  const form: Partial<PoFormState> = { supplier: sup.supplier };
  sources.supplier = sup.known ? "af" : "model";
  const prefill: PoFormPrefill = { id: meta.id, supplier: sup.supplier, pages: capture.pages.length, captured_at: meta.capturedAt, warnings, sources, raw_text: rawText };
  if (!x) { warnings.unshift("The capture could not be read into the form — the captured text is in the drawer; fill the form from it"); return { form, prefill }; }

  const mark = (k: string, v: string | null | undefined, src: PrefillSource = "model") => { if (v != null && String(v) !== "") sources[k] = src; };
  form.order_id = x.orderId ?? ""; mark("order_id", form.order_id);
  if (x.orderDate && /^\d{4}-\d{2}-\d{2}$/.test(x.orderDate)) { form.order_date = x.orderDate; mark("order_date", form.order_date); }
  form.subtotal = m2(x.subtotal); mark("subtotal", form.subtotal);
  form.discount = m2(x.discount); mark("discount", form.discount);
  form.tax = m2(x.tax); mark("tax", form.tax);
  form.sh_donations = m2(x.shipping); mark("sh_donations", form.sh_donations);
  form.order_total = m2(x.total); mark("order_total", form.order_total);
  form.email_used = x.purchasedEmail ?? ""; mark("email_used", form.email_used);
  form.subscription = { present: x.subscription.present, frequency_weeks: x.subscription.frequencyWeeks == null ? "" : String(x.subscription.frequencyWeeks) };
  if (x.subscription.present) sources.subscription = "model";
  const st = shipsToForStreet(x.shipToStreet, streets);
  if (st.ships_to) { form.ships_to = st.ships_to; sources.ships_to = "af"; sources.prep_cost = "af"; }
  else warnings.push(x.shipToStreet ? `Ship-to "${x.shipToStreet}" is neither Velocity nor Home — choose Ships to` : "No ship-to address found — choose Ships to");

  // Lines → products with ASIN candidates (§6.4: history, then title, then the model's guess).
  const products: PoFormProduct[] = [];
  let linesSum = 0;
  // Qty cross-check: only when the model's lines do not add up to the subtotal.
  const modelSum = r2(x.lines.reduce((t, l) => t + (l.unitPrice != null && l.qty != null ? l.unitPrice * l.qty : 0), 0));
  const checkQty = x.subtotal != null && x.lines.length > 0 && Math.abs(modelSum - x.subtotal) > 0.01;
  const visible = checkQty ? visibleQtys(capture) : new Set<number>();
  const hints: Record<string, string> = {};
  for (let i = 0; i < x.lines.length; i++) {
    const l = x.lines[i];
    const rupp = l.unitsPerPack != null && l.unitsPerPack >= 1 ? String(l.unitsPerPack) : "1";
    const inferred = checkQty ? inferLineQty(l, x.subtotal, x.lines.length === 1, visible) : null;
    const qty = inferred ?? l.qty;
    const p: PoFormProduct = { product_name: l.productName, supplier_sku: l.retailerSku ?? "", price: m2(l.unitPrice), qty_ordered: qty == null ? "" : String(qty), retailer_units_per_pack: rupp, asin: "", asin_qty_per_product: "1", sold_as: "individual", units_per_pack: "1", prep_cost: st.prep, notes: "" };
    for (const k of ["product_name", "supplier_sku", "price", "qty_ordered"] as const) mark(`products.${i}.${k}`, p[k]);
    if (inferred != null) hints[`products.${i}.qty_ordered`] = QTY_INFERRED_HINT;
    if (l.unitsPerPack != null) mark(`products.${i}.retailer_units_per_pack`, rupp);
    if (l.unitPrice != null && qty != null) linesSum += l.unitPrice * qty;
    const guess = l.asinGuess && /^[A-Z0-9]{10}$/i.test(l.asinGuess) ? l.asinGuess.toUpperCase() : null;
    const cands = await suggestAsins(query, { supplier: sup.supplier, product: l.productName, limit: 3 });
    const top = cands.find((c) => c.via === "history_exact" || c.via === "history_tokens") ?? cands.find((c) => c.via === "title") ?? null;
    if (top) {
      p.asin = top.asin; sources[`products.${i}.asin`] = "af";
      if (top.in_af && top.sold_as) { p.sold_as = top.sold_as as PoFormProduct["sold_as"]; p.units_per_pack = String(top.units_per_pack ?? 1); sources[`asin.${top.asin}`] = "af"; }
    } else if (guess) { p.asin = guess; sources[`products.${i}.asin`] = "model"; }
    else warnings.push(`Line ${i + 1} "${l.productName.slice(0, 50)}": no ASIN found in AF — pick one`);
    p.asin_qty_per_product = yieldFromPacks(p.retailer_units_per_pack, p.units_per_pack, p.sold_as);
    products.push(p);
  }
  form.products = products;
  if (Object.keys(hints).length) prefill.hints = hints;
  if (x.subtotal != null && x.lines.length > 0 && Math.abs(r2(linesSum) - x.subtotal) > 0.01) warnings.push(`Lines add up to ${r2(linesSum).toFixed(2)}, the subtotal is ${x.subtotal.toFixed(2)}`);
  form.promos = x.promos.map((p, i) => { sources[`promos.${i}`] = "model"; return { type: p.confidence === "high" ? p.type : "", description: p.description, amount: m2(p.amount), percent: m2(p.percent), counts_toward_cogs: promoCountsByDefault(p.type) }; });
  if (x.promos.some((p) => p.confidence === "low")) warnings.push("A promo's type is uncertain — choose sale, coupon or rewards");
  form.payments = x.payments.map((p, i) => { sources[`payments.${i}`] = "model"; return { method: p.method, nickname: p.nickname ?? "", last4: p.last4 && /^\d{4}$/.test(p.last4) ? p.last4 : "", amount: m2(p.amount), gift_card_discount_pct: "" }; });
  const paySum = x.payments.reduce((t, p) => t + (p.amount ?? 0), 0);
  if (x.total != null && x.payments.some((p) => p.amount != null) && Math.abs(r2(paySum) - x.total) > 0.01) warnings.push(`Payments add up to ${r2(paySum).toFixed(2)}, the order total is ${x.total.toFixed(2)}`);
  for (const n of x.notes) warnings.push(n);
  return { form, prefill };
}

// ── The 10-minute cache (not a draft) ────────────────────────────────────────
export const PREFILL_TTL_MS = 10 * 60_000;
interface Entry { payload: PrefillPayload; logId: number | null; expires: number }
const cache = new Map<string, Entry>();
const newId = () => Array.from({ length: 10 }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 31)]).join("");
export function storePrefill(payload: PrefillPayload, logId: number | null, now = Date.now()): string {
  for (const [k, e] of Array.from(cache.entries())) if (e.expires <= now) cache.delete(k);
  const id = newId();
  cache.set(id, { payload: { ...payload, prefill: { ...payload.prefill, id } }, logId, expires: now + PREFILL_TTL_MS });
  return id;
}
export function getPrefill(id: string, now = Date.now()): { payload: PrefillPayload; logId: number | null } | null {
  const e = cache.get(id);
  if (!e || e.expires <= now) { cache.delete(id); return null; }
  return { payload: e.payload, logId: e.logId };
}
export function _clearPrefillCache(): void { cache.clear(); }

/** po_prefill_log row (no page text). Returns the row id. */
export async function logPrefill(query: QueryLike, row: { user_id: number | null; kind: "capture" | "backfill" | "promo_classify"; retailer: string | null; input_chars: number; input_tokens: number; output_tokens: number; cost_estimate: number; duration_ms: number; schema_ok: boolean; error: string | null }): Promise<number | null> {
  const r = await query(
    `INSERT INTO po_prefill_log (user_id, kind, retailer, model, input_chars, input_tokens, output_tokens, cost_estimate, duration_ms, schema_ok, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [row.user_id, row.kind, row.retailer, AI.model, row.input_chars, row.input_tokens, row.output_tokens, row.cost_estimate, row.duration_ms, row.schema_ok, row.error],
  );
  return r.rows[0]?.id == null ? null : Number(r.rows[0].id);
}
