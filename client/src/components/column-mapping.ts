// Pure mapping-builder module (2026-09-08) — extracted from the mapping
// modal so the serialization leg is unit-testable. THE regression this
// guards: 42f0f42 added promos/dateAdded to MAPPING_FIELDS (auto-match +
// green check worked) but the modal's handleContinue rebuilt the outgoing
// ColumnMapping from a hand-typed 8-field literal, silently dropping both;
// optional in the type, so tsc never flagged it, and every row got NOW().
// buildColumnMapping derives from MAPPING_FIELDS — a future field can't be
// dropped the same way.
import type { ColumnMapping } from "@shared/schema";

export interface MappingField {
  key: keyof ColumnMapping;
  label: string;
  required: boolean;
  matchPatterns: RegExp[];
  // Headers that must NEVER auto-match this field, even when matchPatterns
  // hit. Needed once the ASINs export started emitting group-qualified
  // headers (§6, 2026-10-03): /\bcogs\b/i matches "Actual COGS" as readily
  // as "Estimated COGS", and autoMatch takes the FIRST matching header in
  // FILE order — where Actuals precede Estimates. Without this, Est. COGS
  // would bind to the Actual column and the real Estimated column would go
  // unmapped. Actual COGS is PO/SellerBoard-sourced (§2), never uploaded.
  excludePatterns?: RegExp[];
}

export const MAPPING_FIELDS: MappingField[] = [
  {
    key: "asin",
    label: "ASIN",
    required: true,
    matchPatterns: [/^asin$/i, /\basin\b/i],
  },
  {
    key: "cogs",
    label: "Est. COGS",
    required: true,
    matchPatterns: [/^cogs$/i, /cost\s*of\s*goods/i, /\bcogs\b/i, /\bunit\s*cost\b/i, /\bpurchase\s*price\b/i, /\bprice\s*paid\b/i, /\bbuy\s*cost\b/i, /\bcost\b/i, /est.*cogs/i],
    excludePatterns: [/^actual\b/i],
  },
  {
    key: "buyLink",
    label: "Buy Link",
    required: false,
    matchPatterns: [/buy\s*link/i, /\blink\b/i, /\burl\b/i, /\bsource\b/i, /supplier\s*link/i],
    // §6 (2026-10-13): /\bsource\b/ matches "Lead Source" as readily as
    // "Source URL", and buyLink is earlier in this list, so it claimed the
    // header and leadSource auto-matched nothing. Caught by a test, not by
    // a user — the mapping modal would have shown Lead Source bound to Buy
    // Link, which is wrong in a way that is easy to click past.
    excludePatterns: [/\blead[\s_-]*source\b/i],
  },
  {
    key: "prepCost",
    label: "Prep Cost",
    required: false,
    matchPatterns: [/prep\s*cost/i, /\bprep\b/i],
    excludePatterns: [/^actual\b/i],
  },
  {
    key: "additionalFees",
    label: "Additional Fees",
    required: false,
    matchPatterns: [/additional\s*fees/i, /storage/i, /\bfees\b/i, /\bmisc\b/i, /\bother\s*fees\b/i, /\bextra\b/i],
  },
  {
    key: "tags",
    label: "Tags",
    required: false,
    matchPatterns: [/^tags?$/i, /\btags?\b/i],
  },
  {
    key: "notes",
    label: "Notes",
    required: false,
    matchPatterns: [/^notes?$/i, /\bnotes?\b/i, /\bcomments?\b/i],
  },
  {
    key: "supplierSku",
    label: "SKU / UPC",
    required: false,
    matchPatterns: [/supplier\s*_?\s*sku/i, /^sku$/i, /vendor\s*(sku|item)/i, /item\s*(number|no\.?|#)/i, /catalog\s*number/i, /part\s*number/i, /\bmpn\b/i],
  },
  // §21 bulk fields (2026-09-04): parsed on both paths, consumed only by the
  // bulk list creation (the main path ignores both — SPEC §21 asymmetry note).
  {
    key: "promos",
    label: "Promos",
    required: false,
    matchPatterns: [/^promos?$/i, /promo\s*notes?/i],
  },
  {
    key: "dateAdded",
    label: "Date Added",
    required: false,
    matchPatterns: [/date\s*added/i, /^added$/i, /^date$/i],
  },
  {
    key: "leadSource",
    label: "Lead Source",
    required: false,
    // §6 (2026-10-13). Matches the ASINs-export header "Description: Lead
    // Source" as well as a bare "lead source" / "lead_source".
    matchPatterns: [/\blead[\s_-]*source\b/i],
  },
];

export const NOT_IN_FILE = "__not_in_file__";

export function buildColumnMapping(mappings: Record<string, string>): ColumnMapping {
  const val = (key: string) => (!mappings[key] || mappings[key] === NOT_IN_FILE ? null : mappings[key]);
  const mapping = {} as Record<string, string | null>;
  for (const field of MAPPING_FIELDS) {
    // Required fields keep their "" sentinel (the modal disables Continue
    // until they're set); optional ones serialize as null when unmapped.
    mapping[field.key] = field.required ? mappings[field.key] || "" : val(field.key);
  }
  return mapping as unknown as ColumnMapping;
}
