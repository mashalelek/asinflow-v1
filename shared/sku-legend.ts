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
// Tokens that do not START with a letter are dropped whole, so "3M Company"
// → "COM" (not "3MC"). The comment here read "MCO" until 2026-10-07; that was
// never what the filter did — `/^[a-z]/` rejects "3m" outright rather than
// stripping its digit.
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

// ── Collision walk (§18, 2026-10-07) ────────────────────────────────────────
//
// proposeCode() above is tier 1 only: it derives a code and hands it up even
// when that code is already in the legend. The operator then hit an inline
// collision error on approval and had to invent a free code by hand.
//
// proposeBrandCode walks past collisions itself and can only ever return a
// FREE code. Brand and department codes are ONE namespace — a code is taken
// if any sku_legend row holds it, of either type, approved or proposed — and
// NUL is reserved, so it is always taken.
//
// Deterministic: same name + same taken set always yields the same code.
// Uniqueness is the ONLY requirement here; mnemonic quality is not. A tier-5
// answer like "AM7" is correct, not a degradation.
export function proposeBrandCode(
  name: string,
  takenCodes: readonly string[] | ReadonlySet<string>,
): string {
  const given = Array.isArray(takenCodes)
    ? (takenCodes as readonly string[])
    : Array.from(takenCodes as ReadonlySet<string>);
  const taken = new Set<string>();
  for (const c of given) taken.add(String(c ?? "").trim().toUpperCase());
  for (const r of Array.from(RESERVED_LEGEND_CODES)) taken.add(r);

  // Codes already offered by an earlier tier are not re-offered. The tiers
  // deliberately overlap (tier 4a re-walks tier 2's shape), so this is what
  // makes "each subsequent letter NOT YET TRIED" true rather than aspirational.
  const tried = new Set<string>();
  const take = (candidate: string): string | null => {
    const c = candidate.toUpperCase();
    if (!/^[A-Z0-9]{3}$/.test(c)) return null;
    if (tried.has(c)) return null;
    tried.add(c);
    return taken.has(c) ? null : c;
  };

  let hit: string | null;

  // Tier 1 — today's derivation, unchanged.
  hit = take(proposeCode(name));
  if (hit) return hit;

  // "Letters" per §18: the name's alphanumerics, uppercased.
  const L = (name ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const first2 = (L + "XX").slice(0, 2);
  const at = (i: number): string => L[i] ?? "X";

  // Tier 2 — first 2 letters + the 4th, then the 5th, … to the end.
  for (let i = 3; i < L.length; i++) {
    hit = take(first2 + L[i]);
    if (hit) return hit;
  }

  // Tier 3 — initials of the first three words, when there are 3+ words.
  const words = (name ?? "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length >= 3) {
    hit = take(words.slice(0, 3).map((w) => w[0]).join(""));
    if (hit) return hit;
  }

  // Tier 4 — first + 2nd + each subsequent letter not yet tried (this adds
  // the 3rd letter, which tier 2 skipped), then every remaining ordered
  // positional triple of the name's letters.
  for (let i = 2; i < L.length; i++) {
    hit = take(at(0) + at(1) + L[i]);
    if (hit) return hit;
  }
  for (let i = 0; i < L.length; i++) {
    for (let j = i + 1; j < L.length; j++) {
      for (let k = j + 1; k < L.length; k++) {
        hit = take(L[i] + L[j] + L[k]);
        if (hit) return hit;
      }
    }
  }

  // Tier 5 — exhausted the name's own letters. Digit tails.
  for (let d = 2; d <= 9; d++) {
    hit = take(first2 + String(d));
    if (hit) return hit;
  }
  for (let a = 0; a <= 9; a++) {
    for (let b = 0; b <= 9; b++) {
      hit = take(at(0) + String(a) + String(b));
      if (hit) return hit;
    }
  }

  // ~108 digit-tail codes for one leading letter are all taken on top of
  // every positional combination. Throwing is the only honest answer: the
  // contract is that this function NEVER returns a taken code.
  throw new Error(
    `proposeBrandCode exhausted every tier for "${name}" — all candidate codes are already in the legend`,
  );
}

// All codes currently spoken for, across BOTH legend types and both
// statuses — the one namespace the walk must avoid.
const TAKEN_CODES_SQL = `SELECT code FROM sku_legend WHERE code IS NOT NULL`;

async function takenCodes(queryFn: QueryFn): Promise<string[]> {
  const r = await queryFn(TAKEN_CODES_SQL);
  return r.rows.map((row: any) => String(row.code ?? ""));
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
      derivedProposal: proposeBrandCode(rawValue ?? "", await takenCodes(queryFn)),
    };
  }
  const res = await queryFn(LOOKUP_SQL, [type, rawValue]);
  const row = res.rows[0];
  if (!row) {
    // The walk, not bare proposeCode (§18, 2026-10-07): a proposal that
    // collides with an existing code is not a proposal, it is an error the
    // operator has to clear by hand. Applies to BOTH types — one namespace.
    return {
      type,
      rawValue,
      status: "not_in_legend",
      code: null,
      derivedProposal: proposeBrandCode(rawValue, await takenCodes(queryFn)),
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

// ============================================================================
// Reserved codes — never assignable to a real brand or department
// ============================================================================

// NUL = "the catalog has no value here" — the ONE reserved code for absent,
// in EITHER position of the SKU:
//
//   BRD = NUL  summaries[].brand absent/null/""/whitespace   (§18, 2026-09-24)
//   DEP = NUL  no classifications chain for our marketplace  (§18, 2026-10-04)
//
// A brandless, categoryless ASIN is therefore NUL-NUL-… and that is correct,
// not a bug. Both are decided at the catalog-fetch boundary and only ever on
// a SUCCESSFUL 200 — a 404 or transport failure is still a hard fail, so NUL
// can never mask a fetch that did not work.
//
// NUL is NOT a legend entry: no sku_legend row, no raw value keys to it, and
// the approval writer rejects it for every action and BOTH types. Reserving
// it is what keeps a real brand or department from colliding with an
// absent-valued SKU.
//
// Origin (brand): B08WX3XDLQ ("Winter Garden Paperback") — a book, so the
// catalog serializes contributors/manufacturer and omits `brand` entirely.
// The retired missing-brand flow surfaced an approval row with an EMPTY raw
// value, and approving it wrote a sku_legend row keyed on "" that then
// swallowed every later brandless ASIN into one code.
// Origin (category): B008DG32FI ("Infusion V-fitting") — a 200 whose
// classifications entry for ATVPDKIKX0DER is an EMPTY array, with no
// variation parent to inherit from.
export const NO_VALUE_CODE = "NUL";

export const RESERVED_LEGEND_CODES: ReadonlySet<string> = new Set([NO_VALUE_CODE]);

export function isReservedLegendCode(code: string): boolean {
  return RESERVED_LEGEND_CODES.has((code ?? "").trim().toUpperCase());
}

// A raw value that is absent/null/empty/whitespace-only is not a value at all.
// The legend must never store a row keyed on one, and nothing may resolve
// through one.
export function isBlankRawValue(raw: string | null | undefined): boolean {
  return (raw ?? "").trim().length === 0;
}
