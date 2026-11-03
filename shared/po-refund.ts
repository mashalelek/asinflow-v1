// Expected (due) refund proposal for a canceled quantity (SPEC §22 "Refunds:
// due and received", Dashboard patch §2.3 C1). Pure; the PO editor shows the
// result in an editable field before saving — the user's number wins.
//
//   amount = qty × line price × (1 − PO discount ratio) + the line's tax share
//   PO discount ratio = discount ÷ subtotal; tax share = tax × line value ÷ subtotal
//
// Without a subtotal (or a 0 one) nothing can be allocated: the proposal is
// the plain qty × price. Without a price there is no proposal (null).
export interface RefundProposalInput {
  qty: number;
  price: number | string | null | undefined;
  subtotal?: number | string | null;
  discount?: number | string | null;
  tax?: number | string | null;
}
export interface RefundProposal {
  amount: number | null;
  /** qty × price before allocation. */
  lineValue: number | null;
  discountRatio: number;
  taxShare: number;
  /** Discount / tax were allocated (a subtotal > 0 was known). */
  allocated: boolean;
}

const n = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (v: number) => Math.round(v * 100) / 100;

export function proposeRefund(i: RefundProposalInput): RefundProposal {
  const price = n(i.price);
  const qty = Number(i.qty) || 0;
  if (price == null || qty <= 0) return { amount: null, lineValue: null, discountRatio: 0, taxShare: 0, allocated: false };
  const lineValue = qty * price;
  const subtotal = n(i.subtotal) ?? 0;
  if (!(subtotal > 0)) return { amount: round2(lineValue), lineValue: round2(lineValue), discountRatio: 0, taxShare: 0, allocated: false };
  const discountRatio = Math.min(1, Math.max(0, (n(i.discount) ?? 0) / subtotal));
  const taxShare = Math.max(0, (n(i.tax) ?? 0) * lineValue / subtotal);
  return { amount: round2(lineValue * (1 - discountRatio) + taxShare), lineValue: round2(lineValue), discountRatio, taxShare: round2(taxShare), allocated: true };
}

export const REFUND_STATUSES = ["due", "received"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
