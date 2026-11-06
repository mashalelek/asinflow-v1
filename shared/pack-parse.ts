// Pack-size tokens in a listing or ASIN title (moved from server/extension-history.ts, 2026-11-06, so the PO form and
// the ASINs tab can suggest a pack from the title): "(2-pack)", "12-pack", "12 pk", "Set of 4", "Pack of 6",
// "× 12" / "x 12" (a trailing multiplier), "N ct", "N count".
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

export interface PackSuggestion { sold_as: "individual" | "multi-pack"; units_per_pack: number; /** The words in the title it came from, e.g. "Pack of 2". */ text: string }

/**
 * Pure: the pack an ASIN title states, as a suggestion for a row whose pack size is unknown (Maria 2026-11-06) —
 * shown in amber, saved only once Maria confirms it. "Pack of 1" / "1 Count" → individual; N ≥ 2 → multi-pack × N.
 */
export function titlePackSuggestion(title: string | null | undefined): PackSuggestion | null {
  const t = String(title ?? "");
  for (const re of PACK_TOKENS) {
    re.lastIndex = 0;
    const m = new RegExp(re.source, "i").exec(t);
    if (!m) continue;
    const n = Number(m[1]);
    if (!(n >= 1) || n > 500) continue;
    return { sold_as: n === 1 ? "individual" : "multi-pack", units_per_pack: n, text: m[0].trim().replace(/^\(|\)$/g, "") };
  }
  return null;
}
