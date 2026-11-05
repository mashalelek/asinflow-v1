// Supplier defects (SPEC §22 "Supplier defects", migration 094, Maria
// 2026-11-05). Pure: the default $ owed, what is still owed / uncovered, and
// when linked refunds resolve a defect. The server (server/po-defects.ts)
// stores the result; the Payments tab shows the same numbers.
//
//   $ owed (default) = qty × the line's cost per retailer unit
//     cost per retailer unit = the stored adjusted product cost (col X; v3:
//       price with discounts, tax and shipping allocated) — never recomputed
//     without one: price × (subtotal − discount + tax + shipping) ÷ subtotal,
//       plain price when the PO has no subtotal; no price → no default (null)
//   owed       = amount − Σ linked refunds RECEIVED  (what the supplier still owes)
//   uncovered  = amount − Σ linked refunds of ANY status — the part no refund row
//                carries yet; this is what an open defect adds to Refunds due, so a
//                linked due row is never counted twice
//   resolved by refund when Σ received ≥ amount (1¢ tolerance); a partial refund
//   leaves the rest open.

export const DEFECT_KINDS = ["missing", "damaged", "wrong_item"] as const;
export type DefectKind = (typeof DEFECT_KINDS)[number];
export const DEFECT_KIND_LABELS: Readonly<Record<DefectKind, string>> = { missing: "missing", damaged: "damaged", wrong_item: "wrong item" };
export const DEFECT_RESOLUTIONS = ["refund", "replacement", "write_off"] as const;
export type DefectResolution = (typeof DEFECT_RESOLUTIONS)[number];
/** The action item an open defect derives (the same label the manual badge has always used). */
export const DEFECT_ACTION_ITEM = "Missing / damaged from supplier";

const n = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (v: number) => Math.round(v * 100) / 100;

export interface DefectAmountInput {
  qty: number;
  adjustedProductCost?: number | string | null;
  price?: number | string | null;
  subtotal?: number | string | null;
  discount?: number | string | null;
  tax?: number | string | null;
  shipping?: number | string | null;
}

/** The line's cost per retailer unit (see the header); null when nothing is known. */
export function costPerRetailerUnit(i: Omit<DefectAmountInput, "qty">): number | null {
  const adj = n(i.adjustedProductCost);
  if (adj != null) return adj;
  const price = n(i.price);
  if (price == null) return null;
  const subtotal = n(i.subtotal) ?? 0;
  if (!(subtotal > 0)) return price;
  return price * (subtotal - (n(i.discount) ?? 0) + (n(i.tax) ?? 0) + (n(i.shipping) ?? 0)) / subtotal;
}

export function defectAmount(i: DefectAmountInput): number | null {
  const unit = costPerRetailerUnit(i);
  const qty = Number(i.qty) || 0;
  return unit == null || qty <= 0 ? null : round2(qty * unit);
}

export interface LinkedRefund { amount: number | string | null; status: "due" | "received" | string }

export function defectMoney(amount: number | string | null | undefined, linked: readonly LinkedRefund[]): { owed: number | null; uncovered: number | null; received: number; fullyRefunded: boolean } {
  const a = n(amount);
  const received = round2(linked.filter((r) => r.status === "received").reduce((t, r) => t + (n(r.amount) ?? 0), 0));
  const any = round2(linked.reduce((t, r) => t + (n(r.amount) ?? 0), 0));
  if (a == null) return { owed: null, uncovered: null, received, fullyRefunded: false };
  return { owed: Math.max(0, round2(a - received)), uncovered: Math.max(0, round2(a - any)), received, fullyRefunded: linked.some((r) => r.status === "received") && received >= a - 0.005 };
}

/** "1 missing · $5.97 owed" — the chip / list summary of a set of open defects. */
export function defectSummary(rows: ReadonlyArray<{ qty: number | string; kind: string; owed: number | null }>): string {
  if (rows.length === 0) return "";
  const byKind = new Map<string, number>();
  for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + Number(r.qty));
  const parts = Array.from(byKind.entries()).map(([k, q]) => `${Number(q.toFixed(2))} ${DEFECT_KIND_LABELS[k as DefectKind] ?? k}`);
  const owedRows = rows.filter((r) => r.owed != null);
  const owed = owedRows.length ? round2(owedRows.reduce((t, r) => t + (r.owed ?? 0), 0)) : null;
  return `${parts.join(", ")}${owed != null ? ` · $${owed.toFixed(2)} owed` : ""}`;
}
