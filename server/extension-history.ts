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
import { supplierForHost } from "./po-prefill";
import { loadAliases } from "./supplier-aliases";
import { NEWEST_PO_ORDER } from "./po-entry-seq";

export const HistoryQuerySchema = z.object({
  asin: z.string().trim().regex(/^[A-Za-z0-9]{10}$/).transform((s) => s.toUpperCase()).optional(),
  supplier: z.string().trim().max(253).optional(),
  name: z.string().trim().max(500).optional(),
  sku: z.string().trim().max(100).optional(),
  pack: z.coerce.number().int().min(1).max(10000).optional(),
}).refine((q) => q.asin || q.supplier, { message: "asin or supplier is required" });
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

/** Pure: SKU / UPC as compared — dashes, spaces, dots stripped, case folded. */
export const normSku = (s: string | null | undefined): string => String(s ?? "").replace(/[-\s.]/g, "").toLowerCase();

// The pack-size tokens a listing name carries: "(2-pack)", "12-pack", "12 pk", "Set of 4", "Pack of 6", "× 12" / "x 12"
// (a trailing multiplier), "N ct", "N count". Each yields the number; the rest of the name is what is compared.
const PACK_TOKENS: RegExp[] = [
  /\(\s*(\d{1,4})\s*[- ]?\s*(?:pack|pk|ct|count)\s*\)/gi,
  /\b(\d{1,4})\s*[- ]?\s*(?:pack|pk)\b/gi,
  /\b(?:set|pack|case|box)\s+of\s+(\d{1,4})\b/gi,
  /\b(\d{1,4})\s*[- ]?\s*(?:ct|count)\b\.?/gi,
  /(?:^|\s)[×x]\s*(\d{1,4})\s*$/gi,
];
/** Pure: a listing / line name → its pack size (the first token's number; null when it names none) and the name without the tokens. */
export function parsePack(name: string | null | undefined): { pack: number | null; base: string } {
  let s = String(name ?? ""), pack: number | null = null;
  for (const re of PACK_TOKENS) {
    s = s.replace(re, (_m, n) => { if (pack == null && Number(n) >= 1) pack = Number(n); return " "; });
  }
  const base = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return { pack, base };
}

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
  recent: Array<{ orderDate: string; orderId: string; supplier: string; how: string; asinUnits: number | null; cogs: number | null }>;
  conversion: string | null;
}
const lineCanceled = `(l.qty_canceled IS NOT NULL AND l.qty_canceled >= COALESCE(l.qty_ordered, 0))`;
const notCanceled = `NOT COALESCE((SELECT bool_and(${lineCanceled}) FROM po_line_items l WHERE l.po_asin_id = pa.id), false)`;
const n = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export async function asinHistory(query: QueryLike, asin: string, listingPack: number | null = null, today?: string): Promise<AsinHistory> {
  const meta = (await query(`SELECT title, units_per_pack FROM asins WHERE asin = $1`, [asin])).rows[0] as any;
  const rows = (await query(
    `SELECT p.order_id, p.order_date::text AS order_date, p.supplier, pa.qty, pa.cost_per_unit, pa.asin_name, pa.units_per_pack,
            (p.order_date >= COALESCE($2::date, (now() AT TIME ZONE 'America/New_York')::date) - 365) AS in365,
            (SELECT json_agg(json_build_object('ru', l.retailer_units_per_product, 'name', l.product_name, 'qty', l.qty_ordered) ORDER BY l.position) FROM po_line_items l WHERE l.po_asin_id = pa.id AND NOT ${lineCanceled}) AS lines
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
  // The ASIN's pack size: the catalog's, else the newest PO row's units per pack.
  const asinPack = n(meta?.units_per_pack) ?? n(rows[0]?.units_per_pack);
  return {
    asin, title: meta?.title ?? rows[0]?.asin_name ?? null, asinPack,
    last: lastRow ? { cogs: Number(lastRow.cost_per_unit), orderDate: lastRow.order_date, orderId: lastRow.order_id, supplier: lastRow.supplier } : null,
    avg365: wUnits > 0 ? Math.round((wSum / wUnits) * 100) / 100 : null, pos365: pos.size, units365: Math.round(units365 * 100) / 100,
    recent: rows.slice(0, 5).map((r) => ({
      orderDate: r.order_date, orderId: r.order_id, supplier: r.supplier, asinUnits: n(r.qty), cogs: n(r.cost_per_unit),
      how: ((r.lines as any[] | null) ?? []).map((l) => howBought(n(l.ru), l.name, n(l.qty))).join(" + ") || "—",
    })),
    conversion: conversionLine(listingPack, asinPack),
  };
}

export interface HistoryResult {
  supplier: { host: string; supplier: string; known: boolean; lastEmail: { email: string; orderDate: string; orderId: string } | null } | null;
  listing: { pack: number | null; base: string } | null;
  match: { kind: "asin" | "confident" | "picked" | "choices" | "none"; by: "sku" | "name" | null; choices: Candidate[] };
  history: AsinHistory | null;
}

export async function extensionHistory(query: QueryLike, q: HistoryQuery, today?: string): Promise<HistoryResult> {
  if (!q.supplier) return { supplier: null, listing: null, match: { kind: "asin", by: null, choices: [] }, history: await asinHistory(query, q.asin!, null, today) };
  const suppliers = (await query(`SELECT DISTINCT supplier FROM purchase_orders`)).rows.map((r: any) => String(r.supplier));
  const sup = supplierForHost(q.supplier, suppliers, await loadAliases(query));
  const em = sup.known ? (await query(
    `SELECT p.email_used, p.order_date::text AS order_date, p.order_id FROM purchase_orders p WHERE p.supplier = $1 AND NULLIF(trim(p.email_used), '') IS NOT NULL ORDER BY ${NEWEST_PO_ORDER} LIMIT 1`, [sup.supplier])).rows[0] as any : null;
  const supplier = { host: q.supplier, supplier: sup.supplier, known: sup.known, lastEmail: em ? { email: String(em.email_used), orderDate: em.order_date, orderId: em.order_id } : null };
  const parsed = q.name ? parsePack(q.name) : null;
  const listing = q.name || q.pack ? { pack: q.pack ?? parsed?.pack ?? null, base: parsed?.base ?? "" } : null;
  const pack = listing?.pack ?? null;
  if (q.asin) return { supplier, listing, match: { kind: "picked", by: null, choices: [] }, history: await asinHistory(query, q.asin, pack, today) };
  if (!sup.known || (!q.name && !q.sku)) return { supplier, listing, match: { kind: "none", by: null, choices: [] }, history: null };
  const lines = (await query(
    `SELECT DISTINCT pa.asin, COALESCE(a.title, pa.asin_name) AS title, l.product_name, l.supplier_sku
       FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id LEFT JOIN asins a ON a.asin = pa.asin
      WHERE p.supplier = $1 AND NOT ${lineCanceled}`, [sup.supplier])).rows as any[];
  const m = matchListing(lines, { name: q.name, sku: q.sku });
  if (m.confident) return { supplier, listing, match: { kind: "confident", by: m.confident.by, choices: [m.confident] }, history: await asinHistory(query, m.confident.asin, pack, today) };
  return { supplier, listing, match: { kind: m.choices.length ? "choices" : "none", by: m.choices[0]?.by ?? null, choices: m.choices }, history: null };
}
