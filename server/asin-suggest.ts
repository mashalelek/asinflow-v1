// ASIN picker suggestions for the New PO form (patch po-ai-prefill §6.4;
// ranking 2026-11-04; Amazon search 2026-11-06). Order before typing: (1) a
// normalized part-number hit (the line's SKU / UPC or a model # in its name,
// inside an ASIN's title or SKUs); (2) ASINs on past PO lines from the same
// supplier — the same supplier SKU, the same (normalized) product name, then
// a token match whose distinctive words (scent / color / flavor / model) agree;
// (3) brand + title-word overlap; (4) with no AF-database match (1–2), an
// Amazon catalog search (server/asin-amazon-search.ts) merged with (3), and
// the model's guess only once the catalog confirms it and its title passes the
// distinctive-word check. Typed text searches ASIN, title, SKU and brand.
// Every suggestion carries its title, its distinctive-word match and
// "sold before", so the form can show where it came from and flag a mismatch.
import type { QueryLike } from "./scheduler/types";
import { nameMatch, nameMismatchNote } from "@shared/name-match";
import { amazonKeywords, catalogItem, rankCatalogHits, searchCatalogKeywords, soldBefore, supplierBrand, type AmazonSearchDeps, type CatalogHit } from "./asin-amazon-search";

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
  via: "part_number" | "history_sku" | "history_exact" | "history_tokens" | "title" | "search" | "amazon" | "model";
  /** Supplier product name the history match came from. */
  matched_name?: string | null;
  /** Newest PO date the history match came from (YYYY-MM-DD). */
  last_ordered?: string | null;
  score: number;
  /** AF has sold this ASIN (sales_daily units). */
  sold_before?: boolean;
  /** Every distinctive word of the product is in the title (name-match.ts). */
  name_all?: boolean;
  /** "title says Midnight Jasmine, product is Christmas Eve" — the amber note, null when they agree. */
  mismatch?: string | null;
  /** Amazon's size text / package quantity (Amazon search hits). */
  size?: string | null;
  pack?: number | null;
}
/** The AF-database matches (Maria 2026-11-06: AF first): a part number, or a past PO line from this supplier. */
export const AF_MATCH_VIAS: ReadonlySet<AsinSuggestion["via"]> = new Set<AsinSuggestion["via"]>(["part_number", "history_sku", "history_exact", "history_tokens"]);

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
    // Generic words alone are no match (2026-11-06: "Christmas Eve Original Large Jar Candle" ≠ "Midnight Jasmine Original Large Jar Candle").
    if (!exact && nameMatch(product, r.product_name).ratio < 0.5) continue;
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

/**
 * Pure: the part numbers in a line's SKU / UPC and product name, normalized (dashes, spaces, dots and case
 * dropped: "20350-GOLD5C" = "20350gold5c"). A name word counts when, normalized, it is ≥ 5 characters with
 * ≥ 3 digits (a model #, a UPC) — "5-pack", "3/4in", "12oz" do not; the SKU counts whole when ≥ 4.
 */
export const normPart = (s: string | null | undefined): string => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
export function partNumbers(sku: string | null | undefined, product: string | null | undefined): string[] {
  const out = new Set<string>();
  const sk = normPart(sku);
  if (sk.length >= 4) out.add(sk);
  for (const w of String(product ?? "").split(/[\s,;()[\]/|]+/)) {
    const n = normPart(w);
    if (n.length >= 5 && (n.match(/\d/g) ?? []).length >= 3) out.add(n);
  }
  return Array.from(out);
}
/** Pure: brand + title-word score of a catalog row for a product name (0 = nothing in common). */
export function titleScore(product: string, title: string | null, brand: string | null): number {
  const target = nameTokens(product);
  const overlap = tokenOverlap(target, nameTokens(title));
  if (overlap === 0) return 0;
  const b = nameTokens(brand);
  return overlap + (b.length > 0 && b.every((t) => target.includes(t)) ? 0.25 : 0);
}

const NORM_SQL = (col: string) => `regexp_replace(lower(COALESCE(${col}, '')), '[^a-z0-9]', '', 'g')`;

/**
 * Ranked (Maria 2026-11-04, acmetools 42838131 — Lenox 20350GOLD5C → B07VH2L2QF): (1) a normalized part-number
 * hit in an ASIN's title or SKUs, (2) past PO lines from this supplier, (3) brand + title-word overlap; the
 * model's guess is appended by the client / prefill. Anything that scores is shown (the picker asks for 3).
 */
export async function suggestAsins(query: QueryLike, opts: {
  supplier?: string | null; product?: string | null; sku?: string | null; q?: string | null; limit?: number;
  /** Search Amazon when AF's database has no match (the picker before typing, the prefill). */
  amazon?: boolean;
  /** The model's ASIN guess: a candidate only once the catalog confirms it and its title passes the check. */
  guess?: string | null;
  /** The retailer's units per pack (a ranking signal for Amazon hits). */
  pack?: number | null;
  deps?: AmazonSearchDeps;
}): Promise<AsinSuggestion[]> {
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
  // 1. Part numbers (the line's SKU / UPC, model #s in its name) inside ASIN titles and SKUs, normalized.
  const parts = partNumbers(opts.sku, product);
  if (parts.length > 0) {
    const like = parts.map((x) => `%${x}%`);
    const rows = (await query(
      `SELECT ${catalogCols} FROM asins a
        WHERE ${NORM_SQL("a.title")} LIKE ANY($1::text[]) OR ${NORM_SQL("a.primary_sku")} LIKE ANY($1::text[])
           OR EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id AND ${NORM_SQL("s.sku")} LIKE ANY($1::text[]))
        LIMIT 50`, [like],
    )).rows as CatalogRow[];
    rows.map((r) => ({ r, score: 3 + titleScore(product, r.title, r.brand) })).sort((a, b) => b.score - a.score || a.r.asin.localeCompare(b.r.asin))
      .slice(0, limit).forEach(({ r, score }) => push(fromCatalog(r.asin, r, "part_number", score)));
  }
  // 2a. The same supplier SKU on a past line from this supplier (the remembered pick, 2026-11-06).
  const skuN = normPart(opts.sku);
  if (supplier && skuN.length >= 3 && out.length < limit) {
    const rows = (await query(
      `SELECT pa.asin, MAX(l.product_name) AS product_name, MAX(p.order_date)::text AS last_ordered
         FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
        WHERE p.supplier = $1 AND ${NORM_SQL("l.supplier_sku")} = $2
        GROUP BY pa.asin ORDER BY MAX(p.order_date) DESC NULLS LAST LIMIT 5`, [supplier, skuN],
    )).rows as HistoryLine[];
    const fresh = rows.filter((r) => !seen.has(r.asin));
    const cat = await catalog(fresh.map((r) => r.asin));
    for (const r of fresh) push(fromCatalog(r.asin, cat.get(r.asin), "history_sku", 2.5, { matched_name: r.product_name, last_ordered: r.last_ordered }));
  }
  // 2b. History from the same supplier: the same name, then a distinctive-word token match.
  if (product && supplier && out.length < limit) {
    const rows = (await query(
      `SELECT pa.asin, l.product_name, MAX(p.order_date)::text AS last_ordered
         FROM po_line_items l JOIN po_asins pa ON pa.id = l.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
        WHERE p.supplier = $1 AND l.product_name IS NOT NULL
        GROUP BY pa.asin, l.product_name`, [supplier],
    )).rows as HistoryLine[];
    const ranked = rankHistory(product, rows).filter((r) => !seen.has(r.asin)).slice(0, limit - out.length);
    const cat = await catalog(ranked.map((r) => r.asin));
    for (const r of ranked) push(fromCatalog(r.asin, cat.get(r.asin), r.via, r.score, { matched_name: r.matched_name, last_ordered: r.last_ordered }));
  }
  // 3. Brand + title-word overlap in AF's catalog: any of the name's longest words, ranked by overlap (brand named → a nudge).
  if (product && out.length < limit) {
    const toks = nameTokens(product).sort((a, b) => b.length - a.length).slice(0, 6);
    if (toks.length > 0) {
      const rows = (await query(
        `SELECT ${catalogCols} FROM asins a WHERE a.title ILIKE ANY($1::text[]) LIMIT 300`,
        [toks.map((t) => `%${t}%`)],
      )).rows as CatalogRow[];
      // The distinctive-word share ranks first (a title naming the product's scent beats one sharing only "large jar candle").
      rows.map((r) => ({ r, score: titleScore(product, r.title, r.brand), m: nameMatch(product, r.title, r.brand).ratio })).filter((x) => x.score > 0)
        .sort((a, b) => b.m - a.m || b.score - a.score || a.r.asin.localeCompare(b.r.asin))
        .slice(0, limit - out.length).forEach(({ r, score }) => push(fromCatalog(r.asin, r, "title", score)));
    }
  }
  // 4. Typed search: ASIN prefix, title, SKU, brand — and the typed text as a normalized part number.
  const q = String(opts.q ?? "").trim();
  if (q.length >= 2) {
    const nq = normPart(q);
    const rows = (await query(
      `SELECT ${catalogCols} FROM asins a
        WHERE a.asin ILIKE $1 OR a.title ILIKE $2 OR a.primary_sku ILIKE $2 OR a.brand ILIKE $2
           OR EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id AND s.sku ILIKE $2)
           OR ($4 <> '' AND (${NORM_SQL("a.title")} LIKE '%' || $4 || '%' OR EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id AND ${NORM_SQL("s.sku")} LIKE '%' || $4 || '%')))
        ORDER BY (a.asin ILIKE $1) DESC, a.asin LIMIT $3`, [`${q.toUpperCase()}%`, `%${q}%`, limit, nq.length >= 4 ? nq : ""],
    )).rows as CatalogRow[];
    for (const r of rows) push(fromCatalog(r.asin, r, "search", 0));
  }
  // 5. No AF-database match: Amazon's catalog, merged with AF's title matches and ranked together (2026-11-06).
  let ranked = out;
  if (product && !q && !out.some((s) => AF_MATCH_VIAS.has(s.via)) && (opts.amazon || opts.guess)) {
    const brand = await supplierBrand(query, supplier);
    const hits: CatalogHit[] = opts.amazon ? (await searchCatalogKeywords(amazonKeywords(product, brand), opts.deps)).hits : [];
    const guess = String(opts.guess ?? "").toUpperCase();
    const fromModel = /^[A-Z0-9]{10}$/.test(guess) && !hits.some((h) => h.asin === guess) && !seen.has(guess) ? await catalogItem(guess, opts.deps) : null;
    // The model never supplies an ASIN on its own: its guess counts only when the catalog has it and every distinctive word is in the title.
    const modelOk = fromModel && nameMatch(product, fromModel.title, brand).all && nameMatch(product, fromModel.title, brand).words.length > 0 ? fromModel : null;
    const afTitle = out.filter((s) => s.via === "title");
    const all: CatalogHit[] = [...afTitle.map((s) => ({ asin: s.asin, title: s.title, brand: s.brand, image_url: s.image_url, size: null, pack: s.units_per_pack })), ...hits, ...(modelOk ? [modelOk] : [])];
    const uniq = Array.from(new Map(all.map((h) => [h.asin, h])).values());
    const sold = await soldBefore(query, uniq.map((h) => h.asin));
    const cat = await catalog(uniq.map((h) => h.asin));
    const order = rankCatalogHits(product, brand, uniq, { pack: opts.pack, soldBefore: sold });
    ranked = order.map((h) => {
      const c = cat.get(h.asin), af = afTitle.find((s) => s.asin === h.asin);
      const via: AsinSuggestion["via"] = af ? "title" : modelOk?.asin === h.asin ? "model" : "amazon";
      return { ...fromCatalog(h.asin, c, via, h.score), title: c?.title ?? h.title, image_url: c?.image_url ?? h.image_url, brand: c?.brand ?? h.brand, size: h.size, pack: h.pack };
    });
    ranked.push(...out.filter((s) => s.via !== "title" && !ranked.some((r) => r.asin === s.asin)));
  }
  const res = ranked.slice(0, limit);
  const sold = await soldBefore(query, res.filter((s) => s.sold_before == null).map((s) => s.asin));
  return res.map((s) => {
    const m = product ? nameMatch(product, s.title, s.brand) : null;
    return { ...s, sold_before: s.sold_before ?? sold.has(s.asin), name_all: m ? m.all && m.words.length > 0 : undefined, mismatch: product ? nameMismatchNote(product, s.title, s.brand) : null };
  });
}

/** One ASIN's AF facts for the form (title, SKU, pack fields). */
export async function asinInfo(query: QueryLike, asin: string): Promise<AsinSuggestion | null> {
  const r = ((await query(`SELECT ${catalogCols} FROM asins a WHERE a.asin = $1`, [asin.toUpperCase()])).rows as CatalogRow[])[0];
  if (!r) return null;
  return { asin: r.asin, title: r.title, primary_sku: r.primary_sku, image_url: r.image_url, brand: r.brand, sold_as: r.sold_as, units_per_pack: r.units_per_pack, in_af: true, via: "search", score: 0 };
}
