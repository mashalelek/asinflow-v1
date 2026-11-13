// The PO's status word (Maria 2026-11-13): Open while closed_at is NULL; Closed once closed; **Canceled** when it is
// closed and every ASIN row is fully canceled (its PO canceled, or canceled claims covering every line — the view's
// fully_canceled). One derivation for the POs list, the PO page and the tests; nothing is stored (closed_by stays
// 'auto' / 'sheet' / 'import' / a user).
export type PoStatusLabel = "Open" | "Closed" | "Canceled";

export function poStatusLabel(po: { closed_at: string | Date | null | undefined }, asins: ReadonlyArray<{ fully_canceled?: boolean | null }> = []): PoStatusLabel {
  if (po.closed_at == null) return "Open";
  return asins.length > 0 && asins.every((a) => a.fully_canceled === true) ? "Canceled" : "Closed";
}
