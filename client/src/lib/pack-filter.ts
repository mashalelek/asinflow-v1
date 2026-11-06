// The ASINs page's "Pack size" filter (Maria 2026-11-06): missing / needs review / confirmed. "Needs review" shows
// what matters now — ASINs on an open PO, on the Buy List or on hold; "needs review (all)" shows every one, the
// ASINs she bought or plans to buy (any PO, Buy List, on hold) first, each group in the table's own order. Pure.
import { packStatus, type AsinPack } from "@shared/schema";

export type PackFilter = "" | "missing" | "needs_review" | "needs_review_all" | "confirmed";
export const PACK_FILTER_LABEL: Record<Exclude<PackFilter, "">, string> = {
  needs_review: "needs review (open PO / Buy List)", needs_review_all: "needs review (all)", missing: "missing", confirmed: "confirmed",
};

type Row = { asin: string; pack?: AsinPack };
type Sets = { buySet: ReadonlySet<string>; onHoldSet: ReadonlySet<string> };
const planned = (r: Row, s: Sets) => s.buySet.has(r.asin) || s.onHoldSet.has(r.asin);

export function packFilterMatch(r: Row, f: PackFilter, s: Sets = { buySet: new Set(), onHoldSet: new Set() }): boolean {
  if (!f) return true;
  const st = packStatus(r.pack);
  if (f === "needs_review") return st === "needs_review" && (!!r.pack?.hasOpenPo || planned(r, s));
  if (f === "needs_review_all") return st === "needs_review";
  return st === f;
}

/** Pure: each option's count over the loaded rows (shown in the select). */
export function packFilterCounts(rows: readonly Row[], s: Sets): Record<Exclude<PackFilter, "">, number> {
  const out = { needs_review: 0, needs_review_all: 0, missing: 0, confirmed: 0 };
  for (const r of rows) for (const k of Object.keys(out) as Array<keyof typeof out>) if (packFilterMatch(r, k, s)) out[k]++;
  return out;
}

/** Pure: stable re-order putting the bought / planned ASINs first (under the needs-review and missing filters). */
export function packReviewOrder<T extends Row>(rows: readonly T[], f: PackFilter, buySet: ReadonlySet<string>, onHoldSet: ReadonlySet<string>): T[] {
  if (f !== "needs_review" && f !== "needs_review_all" && f !== "missing") return rows as T[];
  const first = (r: T) => !!r.pack?.hasOpenPo || !!r.pack?.hasPo || buySet.has(r.asin) || onHoldSet.has(r.asin);
  return [...rows.filter(first), ...rows.filter((r) => !first(r))];
}

/** Pure: of the selected ASINs, those with a suggestion to confirm. */
export function confirmableAsins(rows: ReadonlyArray<Row>, selected: ReadonlySet<string>): string[] {
  return rows.filter((r) => selected.has(r.asin) && packStatus(r.pack) === "needs_review" && !!r.pack?.suggestedSoldAs).map((r) => r.asin);
}
