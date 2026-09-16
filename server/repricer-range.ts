// §23 zero-sales window (2026-09-16) — pure range resolution.
//
// Only the SALES condition is range-scoped; stock and SC-Active are always
// as-of-now. The coverage guard is a CLAMP, not a warning: sales_daily starts
// at a finite earliest order date, and a range reaching before it would let
// MISSING data masquerade as "no sales" — the one failure mode that silently
// overstates this view's core claim. Clamping guarantees every returned row
// was evaluated over a period we actually cover; the caller always displays
// the effective range, so the clamp is never silent.
export interface RepricerRange {
  requested: { from: string; to: string };
  effective: { from: string; to: string };
  coverageStart: string | null;
  clamped: boolean;
  /** Range lies entirely outside coverage (or there is no data at all): the
   *  caller must return NO rows rather than claim every ASIN had zero sales. */
  noCoverage: boolean;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function resolveRepricerRange(
  coverageStart: string | null,
  fromRaw?: string,
  toRaw?: string,
  now: Date = new Date(),
): RepricerRange {
  // Default = trailing 7 days INCLUSIVE of today, byte-identical to the
  // fixed window this replaced. Deliberately NOT the shared "last_7_days"
  // preset, which is [today-7, yesterday].
  const defFrom = new Date(now);
  defFrom.setDate(defFrom.getDate() - 6);
  let from = ISO_RE.test(String(fromRaw)) ? String(fromRaw) : isoOf(defFrom);
  let to = ISO_RE.test(String(toRaw)) ? String(toRaw) : isoOf(now);
  if (from > to) { const s = from; from = to; to = s; } // tolerate inverted input
  const requested = { from, to };

  let clamped = false;
  let noCoverage = false;
  if (coverageStart == null) {
    noCoverage = true; // no sales data at all — refuse, don't return everything
  } else if (from < coverageStart) {
    from = coverageStart;
    clamped = true;
    if (to < coverageStart) noCoverage = true;
  }
  return { requested, effective: { from, to }, coverageStart, clamped, noCoverage };
}
