// What counts as an ASIN (Maria 2026-11-14): 10 characters — "B0" followed by 8 of [A-Z0-9], or an ISBN-10 (9 digits
// then a digit or X). A PO row whose `asin` is anything else is "no ASIN yet": the row came in without one (the two
// sheet-era rows "NA" and "KOOKABURRA" were the 2026-11-14 case — component 9 failed every hourly pass on "NA: no
// asin_estimates row"). The cost sync and every other per-ASIN reader of the PO tables skip such a row without an
// error (VALID_ASIN_SQL_RE in their WHERE), the PO page shows it as missing its ASIN (Confirm order details, derived),
// and entry (New PO, Edit PO, Capture PO) turns placeholder text — NA, N/A, none, tbd, … — into an empty field.
// Shared by the server, the client and the scripts; no imports.

/** The JS test for an ASIN. The input must already be trimmed and upper-cased (cleanAsinInput does both). */
export const VALID_ASIN_RE = /^(?:B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$/;
/** The same rule for Postgres (`col ~ VALID_ASIN_SQL_RE`), as a string literal to inline — no parameter needed. */
export const VALID_ASIN_SQL_RE = "^(B0[A-Z0-9]{8}|[0-9]{9}[0-9X])$";
/** SQL: the column holds an ASIN. */
export const IS_ASIN_SQL = (col: string) => `${col} ~ '${VALID_ASIN_SQL_RE}'`;
/** SQL: the column does NOT hold an ASIN ("no ASIN yet"). */
export const NO_ASIN_SQL = (col: string) => `${col} !~ '${VALID_ASIN_SQL_RE}'`;

export function isValidAsin(s: unknown): s is string {
  return typeof s === "string" && VALID_ASIN_RE.test(s);
}

/** Words people type into an ASIN field to mean "none yet". Compared upper-cased and trimmed. */
export const ASIN_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "NA", "N/A", "N.A.", "N.A", "NONE", "NULL", "NIL", "TBD", "TBA", "TBC", "UNKNOWN", "PENDING", "LATER", "NO ASIN", "NOASIN", "NO", "MISSING", "?", "??", "???",
]);

/** True for placeholder text (NA, N/A, none, tbd, "-", "?", "x", …); false for the empty string and for anything that could be an ASIN. */
export function isAsinPlaceholder(s: unknown): boolean {
  const t = String(s ?? "").trim().toUpperCase();
  if (t === "") return false;
  return ASIN_PLACEHOLDERS.has(t) || /^[-–—_.?x0]+$/i.test(t);
}

/** An ASIN field's text as the form keeps it: trimmed and upper-cased; placeholder text becomes "" (empty, not an ASIN). */
export function cleanAsinInput(s: unknown): string {
  const t = String(s ?? "").trim().toUpperCase();
  return isAsinPlaceholder(t) ? "" : t;
}

/** The message for a field that holds something other than an ASIN. */
export const ASIN_SHAPE_MESSAGE = "an ASIN is 10 characters: B0… or an ISBN-10";
export const asinPlaceholderMessage = (typed: string) => `"${String(typed).trim()}" is not an ASIN — leave the ASIN empty until you have one`;
