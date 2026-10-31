// ASIN picker suggestions for the New PO form (patch po-ai-prefill §6.4).
// Order before typing: (1) ASINs on past PO lines from the same supplier
// whose product name matches this line's — exact (normalized) first, then a
// token match; history wins; (2) AF title-word matches; (3) the model's
// guess is appended by the client (amber). Typed text searches ASIN, title,
// SKU and brand. Every suggestion carries AF's title / SKU / pack fields so
// the form can mark them "from AF" (stone).
import type { QueryLike } from "./scheduler/types";

export interface AsinSuggestion {
  asin: string;
  title: string | null;
  primary_sku: string | null;
  image_url: string | null;
  brand: string | null;
  sold_as: string | null;
  units_per_pack: number | null;
  /** The ASIN exists in AF's catalog (asins). */
  in_af: boolean;
  via: "history_exact" | "history_tokens" | "title" | "search";
  /** Supplier product name the history match came from. */
  matched_name?: string | null;
  /** Newest PO date the history match came from (YYYY-MM-DD). */
  last_ordered?: string | null;
  score: number;
}

const STOP = new Set(["the", "and", "for", "with", "of", "a", "an", "in", "to", "by", "pack", "pk", "ct", "count", "oz", "fl", "set", "color", "size"]);
/** Normalized tokens of a product name: lower-case, ®™ and punctuation dropped, stop words and 1-char tokens out. */
export function nameTokens(s: string | null | undefined): string[] {
  return Array.from(new Set(String(s ?? "").toLowerCase().normalize("NFKD").replace(/[®™©]/g, " ").split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t))));
}
export const normName = (s: string | null | undefined): string => nameTokens(s).join(" ");
/** Jaccard overlap of two token sets. */
export function tokenOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const B = new Set(b); let inter = 0;
  for (const t of a) if (B.has(t)) inter++;
  return inter / (new Set([...a, ...b]).size);
}

export interface HistoryLine { asin: string; product_name: string | null; last_ordered: string | null }
/** Pure: rank past supplier lines against this line's product name. */
export function rankHistory(product: string, rows: readonly HistoryLine[], minOverlap = 0.5): Array<{ asin: string; via: "history_exact" | "history_tokens"; score: number; matched_name: string | null; last_ordered: string | null }> {
  const target = nameTokens(product), targetNorm = target.join(" ");
  if (target.length === 0) return [];
  const best = new Map<string, { via: "history_exact" | "history_tokens"; score: number; matched_name: string | null; last_ordered: string | null }>();
  for (const r of rows) {
    const toks = nameTokens(r.product_name);
    const exact = toks.join(" ") === targetNorm;
    const score = exact ? 2 : tokenOverlap(target, toks);
    if (!exact && score < minOverlap) continue;
    const cur = best.get(r.asin);
    if (!cur || score > cur.score || (score === cur.score && String(r.last_ordered ?? "") > String(cur.last_ordered ?? ""))) {
      best.set(r.asin, { via: exact ? "history_exact" : "history_tokens", score, matched_name: r.product_name, last_ordered: r.last_ordered });
    }
  }
  return Array.from(best.entries()).map(([asin, v]) => ({ asin, ...v }))
    .sort((a, b) => b.score - a.score || String(b.last_ordered ?? "").localeCompare(String(a.last_ordered ?? "")) || a.asin.localeCompare(b.asin));
}

const catalogCols = `a.asin, a.title, a.primary_sku, a.image_url, a.brand, a.sold_as, a.units_per_pack`;
type CatalogRow = { asin: string; title: string | null; primary_sku: string | null; image_url: string | null; brand: string | null; sold_as: string | null; units_per_pack: number | null };

export async function suggestAsins(query: QueryLike, opts: { supplier?: string | null; product?: string | null; q?: string | null; limit?: number }): Promise<AsinSuggestion[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 25));
  const out: AsinSuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: AsinSuggestion) => { if (!seen.has(s.asin)) { seen.add(s.asin); out.push(s); } };
  const catalog = async (asins: string[]): Promise<Map<string, CatalogRow>> => {
    if (asins.length === 0) return new Map();
    const rows = (await query(`SELECT ${catalogCols} FROM asins a WHERE a.asin = ANY($1::text[])`, [asins])).rows as CatalogRow[];
    return new Map(rows.map((r) => [r.asin, r]));
  };
  const fromCatalog = (asin: string, c: CatalogRow | undefined, via: AsinSuggestion["via"], score: number, extra: Partial<AsinSuggestion> = {}): AsinSuggestion =>
    ({ asin, title: c?.title ?? null, primary_sku: c?.primary_sku ?? null, image_url: c?.image_url ?? null, brand: c?.brand ?? null, sold_as: c?.sold_as ?? null, units_per_pack: c?.units_per_pack ?? null, in_af: !!c, via, score, ...extra });

  const product = String(opts.product ?? "").trim();
  const supplier = String(opts.supplier ?? "").trim();
  // 1. History from the same supplier.
  if (product && supplier) {
    const rows = (await query(
      `SELECT pa.asin, l.product_name, MAX(p.order_date)::text AS last_ordered
         FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
        WHERE p.supplier = $1 AND l.product_name IS NOT NULL
        GROUP BY pa.asin, l.product_name`, [supplier],
    )).rows as HistoryLine[];
    const ranked = rankHistory(product, rows).slice(0, limit);
    const cat = await catalog(ranked.map((r) => r.asin));
    for (const r of ranked) push(fromCatalog(r.asin, cat.get(r.asin), r.via, r.score, { matched_name: r.matched_name, last_ordered: r.last_ordered }));
  }
  // 2. Title-word matches in AF's catalog.
  if (product && out.length < limit) {
    const toks = nameTokens(product).sort((a, b) => b.length - a.length).slice(0, 3);
    if (toks.length > 0) {
      const rows = (await query(
        `SELECT ${catalogCols} FROM asins a WHERE ${toks.map((_, i) => `a.title ILIKE $${i + 1}`).join(" AND ")} LIMIT 50`,
        toks.map((t) => `%${t}%`),
      )).rows as CatalogRow[];
      const target = nameTokens(product);
      rows.map((r) => ({ r, score: tokenOverlap(target, nameTokens(r.title)) })).sort((a, b) => b.score - a.score)
        .slice(0, limit - out.length).forEach(({ r, score }) => push(fromCatalog(r.asin, r, "title", score)));
    }
  }
  // 3. Typed search: ASIN prefix, title, SKU, brand.
  const q = String(opts.q ?? "").trim();
  if (q.length >= 2) {
    const rows = (await query(
      `SELECT ${catalogCols} FROM asins a
        WHERE a.asin ILIKE $1 OR a.title ILIKE $2 OR a.primary_sku ILIKE $2 OR a.brand ILIKE $2
           OR EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id AND s.sku ILIKE $2)
        ORDER BY (a.asin ILIKE $1) DESC, a.asin LIMIT $3`, [`${q.toUpperCase()}%`, `%${q}%`, limit],
    )).rows as CatalogRow[];
    for (const r of rows) push(fromCatalog(r.asin, r, "search", 0));
  }
  return out.slice(0, limit);
}

/** One ASIN's AF facts for the form (title, SKU, pack fields). */
export async function asinInfo(query: QueryLike, asin: string): Promise<AsinSuggestion | null> {
  const r = ((await query(`SELECT ${catalogCols} FROM asins a WHERE a.asin = $1`, [asin.toUpperCase()])).rows as CatalogRow[])[0];
  if (!r) return null;
  return { asin: r.asin, title: r.title, primary_sku: r.primary_sku, image_url: r.image_url, brand: r.brand, sold_as: r.sold_as, units_per_pack: r.units_per_pack, in_af: true, via: "search", score: 0 };
}
