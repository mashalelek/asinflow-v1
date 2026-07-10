// Authoritative brand/dept/sub → 3-char code resolver.
// Legend is authoritative. proposeCode() is a fallback for codes not yet in
// the legend — the result must be surfaced for approval before being used,
// never silently committed.
//
// queryFn is injected (not bound to the running server's db module) so this
// helper is unit-testable without a real DB.

// SUB removed from the SKU format (Option 3) — long-tail distribution
// (755 distinct subs, 390 for 80% coverage) doesn't justify a legend.
// DB CHECK constraint mirrors this (migration 010).
export type LegendType = "brand" | "dept";

export type LegendStatus = "approved" | "proposed" | "not_in_legend";

export interface LegendResolution {
  type: LegendType;
  rawValue: string;
  status: LegendStatus;
  code: string | null;            // null when status === "not_in_legend"
  legendId?: string | null;       // populated when a row matches (approved or proposed)
                                  // — used by 2D's "approve in place" or
                                  // "merge into existing" flows
  derivedProposal?: string;       // populated when status !== "approved"
}

export type QueryFn = (
  sql: string,
  params?: any[],
) => Promise<{ rows: any[] }>;

// First significant word's first 3 letters, uppercased + padded to 3.
// Stopwords stripped so "The North Face" → "NOR" (not "THE").
// Pure-digit tokens dropped so "3M Company" → "MCO" (not "3MC").
const PROPOSE_STOPWORDS = new Set(["the", "and", "of", "for", "with", "a", "an"]);

export function proposeCode(rawValue: string): string {
  const first = (rawValue ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .filter((w) => !PROPOSE_STOPWORDS.has(w))
    .filter((w) => /^[a-z]/.test(w))[0];
  return (first ?? "XXX").toUpperCase().padEnd(3, "X").slice(0, 3);
}

// Lookup via the alias table so spelling variants (e.g. "MarinePure" ↔
// "CerMedia MarinePure") resolve to the same canonical code. The canonical
// row's own raw_value is also discoverable because every canonical row has
// a self-alias (see migration 011 backfill).
//
// Normalization (must match the unique indexes — migration 012):
//   LOWER(TRIM(REGEXP_REPLACE(raw_value, '\s+', ' ', 'g')))
// Folds case, collapses internal whitespace, AND trims leading/trailing.
// Resolution keys off the folded raw_value only — the note column is
// informational and never participates in matching.
const LOOKUP_SQL = `
  SELECT l.id AS legend_id, l.code, l.status
  FROM sku_legend_alias a
  JOIN sku_legend l ON l.id = a.legend_id
  WHERE l.type = $1
    AND LOWER(TRIM(REGEXP_REPLACE(a.raw_value, '\\s+', ' ', 'g'))) =
        LOWER(TRIM(REGEXP_REPLACE($2, '\\s+', ' ', 'g')))
  LIMIT 1
`;

export async function resolveLegend(
  type: LegendType,
  rawValue: string,
  queryFn: QueryFn,
): Promise<LegendResolution> {
  if (!rawValue || rawValue.trim().length === 0) {
    return {
      type,
      rawValue,
      status: "not_in_legend",
      code: null,
      derivedProposal: proposeCode(rawValue ?? ""),
    };
  }
  const res = await queryFn(LOOKUP_SQL, [type, rawValue]);
  const row = res.rows[0];
  if (!row) {
    return {
      type,
      rawValue,
      status: "not_in_legend",
      code: null,
      derivedProposal: proposeCode(rawValue),
    };
  }
  if (row.status === "approved") {
    return { type, rawValue, status: "approved", code: row.code, legendId: row.legend_id };
  }
  // proposed
  return {
    type,
    rawValue,
    status: "proposed",
    code: row.code,
    legendId: row.legend_id,
    derivedProposal: row.code,
  };
}
