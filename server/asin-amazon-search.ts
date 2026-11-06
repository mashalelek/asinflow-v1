// Amazon catalog search for the New PO form's ASIN suggestions (Maria 2026-11-06, yankeecandle.com HFUS09823034326).
// When AF's own database (past PO lines from the supplier, part numbers) has no match, AF searches Amazon:
// SP-API Catalog Items searchCatalogItems with brand + product name keywords (never the UPC — unreliable on Amazon),
// ranked by the distinctive-word check against each title (shared/name-match.ts), size / pack and "sold before".
// Read-only; results cached 15 minutes per keyword string. The model never supplies an ASIN on its own: its guess is
// looked up here (catalogItem) and counts only when the title passes the check.
import type { QueryLike } from "./scheduler/types";
import { spApiGet } from "./spapi-auth";
import { log } from "./log";
import { nameMatch, sizeWords, words, type NameMatch } from "@shared/name-match";

const MARKETPLACE = "ATVPDKIKX0DER";
export const AMAZON_SEARCH_TTL_MS = 15 * 60 * 1000;

export interface CatalogHit {
  asin: string;
  title: string | null;
  brand: string | null;
  image_url: string | null;
  /** The catalog's size text ("22oz", "Classic Large Jar"). */
  size: string | null;
  /** Item package quantity (a 4-pack is 4). */
  pack: number | null;
}

/** Pure: one catalog item (summaries, images, attributes) → a hit. */
export function parseCatalogHit(it: any): CatalogHit | null {
  const asin = String(it?.asin ?? "").toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null;
  const s = (it?.summaries ?? []).find((x: any) => x?.marketplaceId === MARKETPLACE) ?? it?.summaries?.[0] ?? {};
  const a = it?.attributes ?? {};
  const imgs = (it?.images ?? []).find((x: any) => x?.marketplaceId === MARKETPLACE)?.images ?? it?.images?.[0]?.images ?? [];
  const main = imgs.find((x: any) => x?.variant === "MAIN") ?? imgs[0];
  const pq = Number(a.item_package_quantity?.[0]?.value ?? s.packageQuantity ?? NaN);
  return {
    asin,
    title: s.itemName ?? a.item_name?.[0]?.value ?? null,
    brand: s.brand ?? s.brandName ?? a.brand?.[0]?.value ?? null,
    image_url: main?.link ?? null,
    size: s.size ?? a.size?.[0]?.value ?? null,
    pack: Number.isFinite(pq) && pq >= 1 ? pq : null,
  };
}

/** Pure: brand + product name as search keywords, the brand left out when the name already starts with it. */
export function amazonKeywords(product: string, brand: string | null | undefined): string {
  const name = String(product ?? "").replace(/[®™©]/g, " ").replace(/\s+/g, " ").trim();
  const b = String(brand ?? "").trim();
  if (!b) return name;
  const bw = words(b), nw = words(name);
  return bw.every((w) => nw.includes(w)) ? name : `${b} ${name}`;
}

export interface RankedHit extends CatalogHit { match: NameMatch; score: number }
/**
 * Pure: hits ranked by the distinctive-word share (scent / color / flavor / model), all of them found, then the size words
 * and the retailer's own kind words ("large jar" vs "tumbler") found in the title, the pack matching, and sold before.
 */
export function rankCatalogHits(product: string, brand: string | null, hits: readonly CatalogHit[], opts: { pack?: number | null; soldBefore?: ReadonlySet<string> } = {}): RankedHit[] {
  const sizes = sizeWords(product);
  const kind = words(product).filter((w) => ["large", "small", "medium", "mini", "jar", "tumbler", "votive", "wick", "original", "classic"].includes(w));
  return hits.map((h) => {
    const match = nameMatch(product, h.title, brand);
    const t = `${h.title ?? ""} ${h.size ?? ""}`;
    const tw = new Set(words(t)), ts = new Set(sizeWords(t));
    let score = match.ratio * 10 + (match.all && match.words.length > 0 ? 2 : 0);
    if (sizes.length) score += sizes.filter((s) => ts.has(s)).length / sizes.length;
    if (kind.length) score += 0.5 * (kind.filter((w) => tw.has(w)).length / kind.length);
    const pack = opts.pack ?? 1;
    if (h.pack != null) score += h.pack === pack ? 0.5 : -1;
    if (opts.soldBefore?.has(h.asin)) score += 0.75;
    return { ...h, match, score };
  }).sort((a, b) => b.score - a.score || a.asin.localeCompare(b.asin));
}

const cache = new Map<string, { at: number; hits: CatalogHit[] }>();
export const _clearAmazonSearchCache = () => cache.clear();

export interface AmazonSearchDeps { get?: (endpoint: string, params: Record<string, any>) => Promise<any>; now?: () => number }
/** searchCatalogItems by keywords (US marketplace, 10 results). A failure is logged and returns [] — the picker still works. */
export async function searchCatalogKeywords(keywords: string, deps: AmazonSearchDeps = {}): Promise<{ hits: CatalogHit[]; error: string | null }> {
  const kw = keywords.trim();
  if (kw.length < 3) return { hits: [], error: null };
  const now = (deps.now ?? Date.now)();
  const c = cache.get(kw.toLowerCase());
  if (c && now - c.at < AMAZON_SEARCH_TTL_MS) return { hits: c.hits, error: null };
  try {
    const body = await (deps.get ?? spApiGet)(`/catalog/2022-04-01/items`, { marketplaceIds: MARKETPLACE, keywords: kw, includedData: "summaries,images,attributes", pageSize: 10 });
    const hits = ((body?.items ?? []) as any[]).map(parseCatalogHit).filter((h): h is CatalogHit => h != null);
    cache.set(kw.toLowerCase(), { at: now, hits });
    return { hits, error: null };
  } catch (err: any) {
    const msg = `${err?.response?.status ?? "?"}: ${err?.message ?? "unknown"}`;
    log(`Amazon catalog search failed for "${kw}": ${msg}`, "asin-search");
    return { hits: [], error: msg };
  }
}

/** getCatalogItem for one ASIN (the model's guess, confirmed before it counts). Null when Amazon has no such item. */
export async function catalogItem(asin: string, deps: AmazonSearchDeps = {}): Promise<CatalogHit | null> {
  try {
    const body = await (deps.get ?? spApiGet)(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, { marketplaceIds: MARKETPLACE, includedData: "summaries,images,attributes" });
    return parseCatalogHit(body);
  } catch (err: any) {
    if (err?.response?.status !== 404) log(`Amazon catalog lookup failed for ${asin}: ${err?.response?.status ?? "?"}`, "asin-search");
    return null;
  }
}

/** The supplier's brand: the brand of at least half the ASINs on its POs (a one-brand store such as yankeecandle.com), else null. */
export async function supplierBrand(query: QueryLike, supplier: string): Promise<string | null> {
  if (!supplier) return null;
  const rows = (await query(
    `SELECT a.brand, COUNT(DISTINCT a.asin)::int AS n, SUM(COUNT(DISTINCT a.asin)) OVER ()::int AS total
       FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id JOIN asins a ON a.asin = pa.asin
      WHERE p.supplier = $1 AND a.brand IS NOT NULL AND a.brand <> ''
      GROUP BY a.brand ORDER BY n DESC LIMIT 1`, [supplier],
  )).rows as Array<{ brand: string; n: number; total: number }>;
  const r = rows[0];
  return r && r.total > 0 && r.n / r.total >= 0.5 ? r.brand : null;
}

/** The ASINs (of these) AF has sold: any sales_daily row with units. */
export async function soldBefore(query: QueryLike, asins: readonly string[]): Promise<Set<string>> {
  if (asins.length === 0) return new Set();
  const rows = (await query(
    `SELECT DISTINCT a.asin FROM asins a JOIN sales_daily s ON s.asin_id = a.id WHERE a.asin = ANY($1::text[]) AND s.units_sold > 0`, [asins],
  )).rows as Array<{ asin: string }>;
  return new Set(rows.map((r) => r.asin));
}
