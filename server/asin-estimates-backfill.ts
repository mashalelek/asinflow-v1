// Pure rules for `npm run backfill:asin-estimates` (Maria 2026-11-09): the ASINs that have an `asins` row and no
// `asin_estimates` row (the $16 regression, 2026-11-06 → 11-09), how each got into AF, the COGS the sourcing sheet
// row that brought it in carries (the same first-non-empty rule as Sync Sourcing: ER col M for an ER lead, the Master
// sheet's cost for the rest; NULL when no row carries one), and the blank onboarding result the fixed insert path writes.
import type { AsinResult, LeadSource } from "@shared/schema";

export interface MissingRow {
  asin: string;
  status: string;
  lead_source: LeadSource | null;
  added_at: string | Date | null;
  title: string | null;
  tags: string[];
}

export type HowItGotIn = "Sync Sourcing (ER sheet)" | "Sync Sourcing (Master sheet) / Upload File with a lead source" | "Sales import (component 19)" | "SC discovery (component 1)" | "Upload File / extension (no lead source)";

/** How the row entered AF, from what the insert left on it: the lead source (sheets), the provenance tag (sales / SC), else an upload or the extension. */
export function howItGotIn(r: Pick<MissingRow, "lead_source" | "tags">): HowItGotIn {
  if (r.lead_source === "ER") return "Sync Sourcing (ER sheet)";
  if (r.lead_source) return "Sync Sourcing (Master sheet) / Upload File with a lead source";
  if (r.tags.includes("Sales import")) return "Sales import (component 19)";
  if (r.tags.includes("SC import")) return "SC discovery (component 1)";
  return "Upload File / extension (no lead source)";
}

export interface SheetCostRows { er: ReadonlyArray<{ asin: string; cogs: number | null }>; master: ReadonlyArray<{ asin: string; cogs: number | null }> }

/** The sheet's COGS for the ASIN: first non-empty cost top-down on the sheet that brought it in (ER for an ER lead, else Master); null when none. */
export function sheetCostFor(asin: string, leadSource: LeadSource | null, sheets: SheetCostRows): { cogs: number | null; from: "er" | "master" | null } {
  const a = asin.toUpperCase();
  const pick = (rows: ReadonlyArray<{ asin: string; cogs: number | null }>) => rows.find((r) => r.asin.toUpperCase() === a && r.cogs != null)?.cogs ?? null;
  if (leadSource === "ER") { const c = pick(sheets.er); return { cogs: c, from: c != null ? "er" : null }; }
  const m = pick(sheets.master);
  if (m != null) return { cogs: m, from: "master" };
  const e = pick(sheets.er);
  return { cogs: e, from: e != null ? "er" : null };
}

/** The onboarding placeholder exactly as insertNewAsinRows builds it (no Amazon data), with the sheet's COGS (null stays null — never a synthetic 0). */
export function blankOnboardingResult(asin: string, cogs: number | null): AsinResult {
  return {
    asin, cogs: cogs as any, estimatedCogs: null, actualCogs: null, buyLink: null, prepOverride: null, storageOverride: null, supplierSku: null, uploadPack: null,
    pricingData: { lowestFbaPrice: null, buyBoxPrice: null, buyBoxFulfillment: null, lowestPrice: null, avg30DayPrice: null, avg90DayPrice: null, numberOfSellers: null, sellersFba: null, sellersFbm: null },
    catalogData: { weightLbs: null, title: null, brand: null, imageUrl: null, bsrRank: null, bsrCategory: null, isDangerousGood: null, isCatalogDeleted: null } as AsinResult["catalogData"],
    feesData: { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null },
    eligibilityData: { status: "check" } as AsinResult["eligibilityData"],
    error: null,
  };
}

export const MISSING_ROWS_SQL = `
  SELECT a.asin, a.status, a.lead_source, a.added_at, a.title,
         COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM asin_tags at JOIN tags t ON t.id = at.tag_id WHERE at.asin_id = a.id), '{}') AS tags
    FROM asins a
   WHERE NOT EXISTS (SELECT 1 FROM asin_estimates e WHERE e.asin = a.asin)
   ORDER BY a.added_at, a.id`;
