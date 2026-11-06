// The ASINs page's "Pack size" filter (Maria 2026-11-06): missing / needs review / confirmed. Under needs review
// (and missing) the ASINs she bought or plans to buy — on any PO, on the Buy List, on hold — come first, the rest
// after, each group in the table's own order. Pure.
import { packStatus, type AsinPack, type PackStatus } from "@shared/schema";

export type PackFilter = "" | PackStatus;
export const PACK_FILTER_LABEL: Record<Exclude<PackFilter, "">, string> = { missing: "missing", needs_review: "needs review", confirmed: "confirmed" };

export function packFilterMatch(r: { pack?: AsinPack }, f: PackFilter): boolean {
  return !f || packStatus(r.pack) === f;
}

/** Pure: stable re-order putting the bought / planned ASINs first (only under missing / needs review). */
export function packReviewOrder<T extends { asin: string; pack?: AsinPack }>(rows: readonly T[], f: PackFilter, buySet: ReadonlySet<string>, onHoldSet: ReadonlySet<string>): T[] {
  if (f !== "needs_review" && f !== "missing") return rows as T[];
  const first = (r: T) => !!r.pack?.hasPo || buySet.has(r.asin) || onHoldSet.has(r.asin);
  return [...rows.filter(first), ...rows.filter((r) => !first(r))];
}

/** Pure: of the selected ASINs, those with a suggestion to confirm. */
export function confirmableAsins(rows: ReadonlyArray<{ asin: string; pack?: AsinPack }>, selected: ReadonlySet<string>): string[] {
  return rows.filter((r) => selected.has(r.asin) && packStatus(r.pack) === "needs_review" && !!r.pack?.suggestedSoldAs).map((r) => r.asin);
}
