// Supplier claims (SPEC §22 "Supplier claims", docs/claude_spec-patch-supplier-claims.md; migration 101,
// commit 1). Pure: the vocabulary (kinds, outcomes, statuses, the thirteen task kinds), the $ owed per
// Individual unit, what is still owed / covered, the counting rule for Expected, and the chip text.
// Replaces shared/po-defect.ts (migration 094): a defect was a claim of kind missing / damaged / wrong_item.
//
//   qty            — INDIVIDUAL units (D16 / D17); Product and ASIN equivalents are display only
//   $ owed (auto)  — qty × the line's sourcing cost per Individual unit: the stored adjusted product cost (col X /
//                    formula v3, never recomputed on an imported PO), else price × (subtotal − discount + tax +
//                    shipping) ÷ subtotal, else the plain price — ÷ the line's Product pack. Manual once typed.
//   remaining      — owed − Σ refunds received and applied to the claim (supplier_claim_refunds.amount_applied,
//                    the whole row when NULL); never below 0
//   counts         — the claim's units leave Expected (§3.6): closed with any outcome but replacement, or open and
//                    either canceled or promised a refund / credit / write-off; suggested / dismissed never count

export const CLAIM_KINDS = ["missing", "damaged", "wrong_item", "expired", "never_received", "cant_sell", "canceled", "returned"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const CLAIM_KIND_LABELS: Readonly<Record<ClaimKind, string>> = {
  missing: "missing", damaged: "damaged", wrong_item: "wrong item", expired: "expired", never_received: "never received",
  cant_sell: "can't sell", canceled: "canceled", returned: "returned",
};
export const CLAIM_OUTCOMES = ["refund_card", "gift_card", "store_credit", "replacement", "write_off"] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];
export const CLAIM_OUTCOME_LABELS: Readonly<Record<ClaimOutcome, string>> = { refund_card: "refund to card", gift_card: "gift card", store_credit: "store credit", replacement: "replacement", write_off: "write-off" };
/** Outcomes that count as the supplier paying money back (Refunds due counts a claim whose outcome is unset or one of these). */
export const REFUND_OUTCOMES: readonly ClaimOutcome[] = ["refund_card", "gift_card", "store_credit"];
export const CLAIM_STATUSES = ["suggested", "open", "closed", "dismissed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_TASK_KINDS = ["review_suggestion", "confirm_outcome", "enter_quantity", "contact_supplier", "follow_up_supplier", "confirm_reship_order",
  "send_label", "tell_velocity_replacement", "dispose_units", "update_velocity_order", "refund_received", "replacement_arrived", "upload_return_label", "check_on_it",
  // supplier emails (claims commit 6, §3.11): a reply to read (row 3), an email AF is not sure about (rows 2 / 7), an email on a closed claim (row 8)
  "read_reply", "review_email_match", "closed_claim_email",
  // returns (claims commit 7, §3.12 row 2): a home PO's return — Maria drops it off
  "drop_off_return"] as const;
export type ClaimTaskKind = (typeof CLAIM_TASK_KINDS)[number];
export const CLAIM_TASK_GROUP: Readonly<Record<ClaimTaskKind, "decide" | "supplier" | "velocity" | "money" | "timed_out">> = {
  review_suggestion: "decide", confirm_outcome: "decide", enter_quantity: "decide", contact_supplier: "supplier", follow_up_supplier: "supplier", confirm_reship_order: "supplier",
  send_label: "velocity", tell_velocity_replacement: "velocity", dispose_units: "velocity", update_velocity_order: "velocity",
  refund_received: "money", replacement_arrived: "money", upload_return_label: "money", check_on_it: "timed_out",
  read_reply: "supplier", review_email_match: "decide", closed_claim_email: "decide",
  drop_off_return: "money",
};
export const CLAIM_TASK_LABELS: Readonly<Record<ClaimTaskKind, string>> = {
  review_suggestion: "Review suggestion", confirm_outcome: "Confirm outcome", enter_quantity: "Enter quantity", contact_supplier: "Contact supplier", follow_up_supplier: "Follow up with supplier",
  confirm_reship_order: "Confirm reship order #", send_label: "Send return label to Velocity", tell_velocity_replacement: "Tell Velocity a replacement is coming",
  dispose_units: "Ask Velocity to dispose / return", update_velocity_order: "Update the Velocity order", refund_received: "Refund received",
  replacement_arrived: "Replacement arrived", upload_return_label: "Upload return label", check_on_it: "Check on it",
  read_reply: "Read the reply", review_email_match: "Review email match", closed_claim_email: "Email on a closed claim",
  drop_off_return: "Drop off the return",
};
/** Email-made tasks (commit 6): the row shows the task's sentence with an "open email" link. */
export const EMAIL_TASK_KINDS: ReadonlySet<string> = new Set(["read_reply", "review_email_match", "closed_claim_email"]);

const n = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (v: number) => Math.round(v * 100) / 100;

export interface ClaimAmountInput {
  /** Individual units. */
  qty: number;
  /** The line's Product pack (Individual units per Product unit); NULL / 1 = a single. */
  productPack?: number | string | null;
  adjustedProductCost?: number | string | null;
  price?: number | string | null;
  subtotal?: number | string | null;
  discount?: number | string | null;
  tax?: number | string | null;
  shipping?: number | string | null;
}

/** The line's sourcing cost per PRODUCT unit (see the header); null when nothing is known. */
export function costPerProductUnit(i: Omit<ClaimAmountInput, "qty" | "productPack">): number | null {
  const adj = n(i.adjustedProductCost);
  if (adj != null) return adj;
  const price = n(i.price);
  if (price == null) return null;
  const subtotal = n(i.subtotal) ?? 0;
  if (!(subtotal > 0)) return price;
  return price * (subtotal - (n(i.discount) ?? 0) + (n(i.tax) ?? 0) + (n(i.shipping) ?? 0)) / subtotal;
}
/** The line's sourcing cost per INDIVIDUAL unit = per Product unit ÷ the Product pack. */
export function costPerIndividualUnit(i: Omit<ClaimAmountInput, "qty">): number | null {
  const per = costPerProductUnit(i);
  if (per == null) return null;
  const pack = n(i.productPack);
  return per / (pack != null && pack >= 1 ? pack : 1);
}
/** $ owed (auto) = Individual units × cost per Individual unit; null without a price or a qty. */
export function claimAmount(i: ClaimAmountInput): number | null {
  const unit = costPerIndividualUnit(i);
  const qty = Number(i.qty) || 0;
  return unit == null || qty <= 0 ? null : round2(qty * unit);
}

export interface AppliedRefund { amount: number | string | null; amount_applied?: number | string | null }

/** owed − Σ applied (a link with no amount_applied takes the whole refund row); fullyCovered at 1¢. */
export function claimMoney(amountOwed: number | string | null | undefined, linked: readonly AppliedRefund[]): { owed: number | null; received: number; remaining: number | null; fullyCovered: boolean } {
  const a = n(amountOwed);
  const received = round2(linked.reduce((t, r) => t + (n(r.amount_applied) ?? n(r.amount) ?? 0), 0));
  if (a == null) return { owed: null, received, remaining: null, fullyCovered: false };
  return { owed: a, received, remaining: Math.max(0, round2(a - received)), fullyCovered: linked.length > 0 && received >= a - 0.005 };
}

export interface CountingClaim { status: string; kind: string; outcome: string | null }
/** §3.6: do this claim's units leave Expected? */
export function claimCounts(c: CountingClaim): boolean {
  if (c.status === "closed") return c.outcome !== "replacement";
  if (c.status === "open") return c.kind === "canceled" || (c.outcome != null && (REFUND_OUTCOMES as readonly string[]).includes(c.outcome)) || c.outcome === "write_off";
  return false;
}
/** The same rule in SQL for a supplier_claims alias. */
export const CLAIM_COUNTS_SQL = (c: string) => `((${c}.status = 'closed' AND ${c}.outcome IS DISTINCT FROM 'replacement')
  OR (${c}.status = 'open' AND (${c}.kind = 'canceled' OR ${c}.outcome IN ('refund_card', 'gift_card', 'store_credit', 'write_off'))))`;

/** A claim whose quantity is not known yet (a converted badge, a sheet-zeroed line): counts toward nothing until it is typed. */
export const QTY_UNKNOWN_LABEL = "qty unknown";
export const SHEET_ZEROED_LABEL = "unknown (sheet zeroed the line)";
/** "1 missing · $5.97 owed" — the chip / list summary of a set of open claims (qty in Individual units; "? missing" while not known). */
export function claimSummary(rows: ReadonlyArray<{ qty: number | string | null; kind: string; remaining: number | null }>): string {
  if (rows.length === 0) return "";
  const byKind = new Map<string, { q: number; unknown: number }>();
  for (const r of rows) { const v = byKind.get(r.kind) ?? { q: 0, unknown: 0 }; if (r.qty == null) v.unknown++; else v.q += Number(r.qty); byKind.set(r.kind, v); }
  const parts = Array.from(byKind.entries()).map(([k, v]) => `${v.q > 0 ? Number(v.q.toFixed(2)) : ""}${v.q > 0 && v.unknown ? " + " : ""}${v.unknown ? "?" : ""} ${CLAIM_KIND_LABELS[k as ClaimKind] ?? k}`.trim());
  const owedRows = rows.filter((r) => r.remaining != null);
  const owed = owedRows.length ? round2(owedRows.reduce((t, r) => t + (r.remaining ?? 0), 0)) : null;
  return `${parts.join(", ")}${owed != null ? ` · $${owed.toFixed(2)} owed` : ""}`;
}

/** Individual units → the Product / ASIN equivalents AF shows beside a typed quantity (D16). null when the pack is not known. */
export function individualEquivalents(individual: number | null, productPack: number | string | null | undefined, asinPack: number | string | null | undefined): { product: number | null; asin: number | null } {
  if (individual == null || !Number.isFinite(individual)) return { product: null, asin: null };
  const pp = n(productPack), ap = n(asinPack);
  return { product: pp != null && pp >= 1 ? round2(individual / pp) : null, asin: ap != null && ap >= 1 ? round2(individual / ap) : null };
}
