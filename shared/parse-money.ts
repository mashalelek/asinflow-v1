// Parse a money-like cell value. Spreadsheet exports commonly format COGS as
// "$10.92" or "1,234.56"; bare parseFloat sees the leading "$" and returns NaN,
// silently dropping the row. Strip currency symbols, thousands separators, and
// whitespace first.
//
// Returns null on null/undefined/unparseable input (rather than NaN) so callers
// can use `value == null` instead of `isNaN(value)`.
export function parseMoney(raw: unknown): number | null {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : n;
}
