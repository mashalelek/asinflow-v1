// Velocity retailer → AF supplier (patch docs/claude_spec-patch-po-matching.md
// §3.1). Velocity's `retailer` is typed by hand ("WALMART", "Carters",
// "Webstraunt Store"); AF's supplier is the store's domain. A retailer
// resolves through supplier_aliases first, then by case-insensitive equality
// with an AF supplier; a blank retailer matches any supplier.
//
// Seeds are PROPOSED here (proposeAlias) and written only by the backfill's
// --live run after Maria's review, or by hand from the Unmatched panel.
import type { QueryLike } from "./scheduler/types";

export type RetailerResolution =
  | { kind: "blank" }
  | { kind: "supplier"; supplier: string; via: "alias" | "equal" }
  | { kind: "unresolved"; retailer: string };

export const aliasKey = (s: string): string => s.trim().toLowerCase();

/** Pure. */
export function resolveRetailer(retailer: string | null | undefined, aliases: ReadonlyMap<string, string>, suppliers: readonly string[]): RetailerResolution {
  const r = String(retailer ?? "").trim();
  if (r === "") return { kind: "blank" };
  const a = aliases.get(aliasKey(r));
  if (a) return { kind: "supplier", supplier: a, via: "alias" };
  const eq = suppliers.find((s) => s.toLowerCase() === r.toLowerCase());
  if (eq) return { kind: "supplier", supplier: eq, via: "equal" };
  return { kind: "unresolved", retailer: r };
}

const alnum = (x: string): string => x.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
const LABEL_SKIP = new Set(["www", "shop", "store", "us", "usa", "en", "m"]);
/** A supplier domain's name part: "shop.tetleyusa.com" → "tetleyusa"; "webstaurantstore.com" → "webstaurantstore". */
export const supplierLabel = (supplier: string): string =>
  alnum(supplier.toLowerCase().split(".").slice(0, -1).filter((l) => !LABEL_SKIP.has(l)).join(""));

/** Optimal-string-alignment distance (adjacent transpositions count 1). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

export interface AliasProposal { retailer: string; supplier: string | null; rule: "first_label" | "listed_part" | "near_spelling" | null }

/**
 * Pure: the supplier a retailer string obviously names, or null.
 * first_label — alnum-equal to a supplier's name part ("WALMART" → walmart.com);
 * listed_part — an "a / b" value with a part that is a supplier;
 * near_spelling — one supplier within 2 edits (3 for a 12+ char name; "Webstraunt Store" →
 * webstaurantstore.com is 3) — a proposal only, Maria reviews every one.
 */
export function proposeAlias(retailer: string, suppliers: readonly string[]): AliasProposal {
  const r = retailer.trim();
  const lower = new Map(suppliers.map((s) => [s.toLowerCase(), s]));
  const key = alnum(r);
  const byLabel = suppliers.filter((s) => supplierLabel(s) === key && key.length >= 3);
  if (byLabel.length === 1) return { retailer: r, supplier: byLabel[0], rule: "first_label" };
  if (/[/,]/.test(r)) {
    const parts = r.split(/\s*[/,]\s*/).map((p) => lower.get(p.toLowerCase())).filter((x): x is string => !!x);
    if (parts.length >= 1 && new Set(parts).size === 1) return { retailer: r, supplier: parts[0], rule: "listed_part" };
  }
  if (key.length >= 6) {
    const max = key.length >= 12 ? 3 : 2;
    const near = suppliers.filter((s) => { const l = supplierLabel(s); return l.length >= 6 && editDistance(key, l) <= max; });
    if (near.length === 1) return { retailer: r, supplier: near[0], rule: "near_spelling" };
  }
  return { retailer: r, supplier: null, rule: null };
}

export async function loadAliases(query: QueryLike): Promise<Map<string, string>> {
  return new Map((await query(`SELECT alias, supplier FROM supplier_aliases`)).rows.map((r: any) => [String(r.alias), String(r.supplier)]));
}

export async function setAlias(query: QueryLike, alias: string, supplier: string, source: "seed" | "manual"): Promise<void> {
  await query(
    `INSERT INTO supplier_aliases (alias, supplier, source) VALUES ($1, $2, $3)
     ON CONFLICT (alias) DO UPDATE SET supplier = EXCLUDED.supplier, source = EXCLUDED.source`,
    [aliasKey(alias), supplier, source],
  );
}
