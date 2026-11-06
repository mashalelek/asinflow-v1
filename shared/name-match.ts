// Distinctive-word check between a retailer's product name and an ASIN title (Maria 2026-11-06, yankeecandle.com
// HFUS09823034326: "Christmas Eve … Large Jar" was matched to B00184W5LY "Midnight Jasmine … Large Jar" because the generic
// words — original, large, jar, candle — made up half the name). The distinctive words are what tells two products of one
// line apart: scent, color, flavor, model, size. Pure; used by the ASIN suggestions, the prefill and the New PO form.

/** Words that name the KIND of product, its packaging or a marketing claim — never what tells two products apart. */
const GENERIC = new Set([
  "the", "and", "for", "with", "of", "a", "an", "in", "to", "by", "on", "at", "from", "or", "new", "item", "each",
  "pack", "pk", "packs", "ct", "count", "set", "pcs", "piece", "pieces", "size", "color", "colour", "style", "assorted",
  "original", "classic", "large", "small", "medium", "mini", "jumbo", "regular", "standard", "premium", "deluxe", "value", "family",
  "jar", "jars", "candle", "candles", "tumbler", "votive", "wick", "single", "double", "scented", "scent", "fragrance", "burn", "time", "hours", "hour", "over", "up",
  "bottle", "bottles", "box", "bag", "bags", "can", "cans", "tube", "container", "refill", "gift", "holiday", "edition",
  "oz", "fl", "ml", "lb", "lbs", "g", "kg", "inch", "in", "ft", "cm", "mm",
]);
/** Lower-case words, plural "s" folded (candles = candle), ®™© and punctuation dropped. */
export function words(s: string | null | undefined): string[] {
  return String(s ?? "").toLowerCase().normalize("NFKD").replace(/[®™©]/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length > 0)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}
const isSize = (w: string) => /^\d+(?:oz|ml|lb|g|ct|pk|in|ft|cm|mm|pc|pack|count)?$/.test(w);
/**
 * The product name's distinctive words, in order: not generic, not the brand, not a bare size / count. Sizes count only as a
 * ranking signal (sizeWords), never as a mismatch on their own.
 */
export function distinctiveWords(name: string | null | undefined, brand?: string | null): string[] {
  const b = new Set(words(brand));
  const out: string[] = [];
  for (const w of words(name)) if (!GENERIC.has(w) && !b.has(w) && !isSize(w) && w.length > 1 && !out.includes(w)) out.push(w);
  return out;
}
/** Size / count words ("22oz", "22 oz" → "22oz", "4pk") for ranking only. */
export function sizeWords(name: string | null | undefined): string[] {
  const s = String(name ?? "").toLowerCase().replace(/(\d+(?:\.\d+)?)\s*(oz|ounce|ml|lb|g|ct|count|pk|pack)\b/g, (_m, n, u) => `${n}${u === "ounce" ? "oz" : u === "count" ? "ct" : u === "pack" ? "pk" : u}`);
  return Array.from(new Set(s.split(/[^a-z0-9.]+/).filter((w) => /^\d+(?:\.\d+)?(?:oz|ml|lb|g|ct|pk)$/.test(w))));
}

export interface NameMatch {
  /** The product's distinctive words. */
  words: string[];
  found: string[];
  missing: string[];
  /** Every distinctive word is in the title (true when the name has none — nothing to contradict). */
  all: boolean;
  /** found ÷ words (1 when none). */
  ratio: number;
}
export function nameMatch(product: string | null | undefined, title: string | null | undefined, brand?: string | null): NameMatch {
  const ws = distinctiveWords(product, brand);
  const t = new Set(words(title));
  const found = ws.filter((w) => t.has(w)), missing = ws.filter((w) => !t.has(w));
  return { words: ws, found, missing, all: missing.length === 0, ratio: ws.length ? found.length / ws.length : 1 };
}
/**
 * The amber note on an ASIN row whose title contradicts the product: none of the product's distinctive words is in the title
 * ("title says Midnight Jasmine, product is Christmas Eve"). Null when they agree, when the name has no distinctive words, or
 * when the title is unknown. Half or more found = the same product named differently (no note).
 */
export function nameMismatchNote(product: string | null | undefined, title: string | null | undefined, brand?: string | null): string | null {
  if (!title || !String(title).trim()) return null;
  const m = nameMatch(product, title, brand);
  if (m.words.length === 0 || m.ratio >= 0.5) return null;
  const titleOwn = distinctiveWords(title, brand).filter((w) => !m.words.includes(w)).slice(0, 3);
  // Shown as written: the stem back to the source word ("christma" → "Christmas"), capitalized.
  const asWritten = (src: string, stems: string[]) => {
    const raw = String(src).normalize("NFKD").replace(/[®™©]/g, " ").split(/[^A-Za-z0-9]+/).filter(Boolean);
    return stems.map((st) => raw.find((r) => words(r)[0] === st) ?? st).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  };
  return titleOwn.length ? `title says ${asWritten(title, titleOwn)}, product is ${asWritten(String(product), m.words.slice(0, 3))}` : `title does not mention ${asWritten(String(product), m.missing.slice(0, 3))}`;
}
