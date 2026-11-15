// SQL fragments of the supplier claims (SPEC §22 "Supplier claims", migration 101). No imports beyond the
// shared rule, so the action-item unions and the list filters can use them without an import cycle.
// Replaces server/po-defect-sql.ts (094).
import { CLAIM_COUNTS_SQL } from "@shared/supplier-claim";

export { CLAIM_COUNTS_SQL };

/** Open claims of a PO (alias p) / an ASIN row (alias pa) / a line id expression — D15: an open claim keeps its PO open. */
export const OPEN_CLAIM_PO_SQL = (p: string) => `EXISTS (SELECT 1 FROM supplier_claims c WHERE c.po_id = ${p}.id AND c.status = 'open')`;
export const OPEN_CLAIM_ASIN_SQL = (pa: string) => `EXISTS (SELECT 1 FROM supplier_claims c JOIN po_line_items cl ON cl.id = c.po_line_item_id WHERE cl.po_asin_id = ${pa}.id AND c.status = 'open')`;
export const OPEN_CLAIM_LINE_SQL = (lineIdExpr: string) => `EXISTS (SELECT 1 FROM supplier_claims c WHERE c.po_line_item_id = ${lineIdExpr} AND c.status = 'open')`;
export const OPEN_CLAIM_COUNT_PO_SQL = (p: string) => `(SELECT COUNT(*)::int FROM supplier_claims c WHERE c.po_id = ${p}.id AND c.status = 'open')`;

/** Per claim: owed − Σ refunds applied to it (≥ 0). `c` = supplier_claims alias. */
export const CLAIM_REMAINING_SQL = (c: string) => `GREATEST(0, COALESCE(${c}.amount_owed, 0) - COALESCE((SELECT SUM(COALESCE(x.amount_applied, r.amount)) FROM supplier_claim_refunds x JOIN po_line_refunds r ON r.id = x.po_line_refund_id WHERE x.claim_id = ${c}.id), 0))`;
/** Refunds due (§3.7): Σ remaining on OPEN claims whose outcome is unset or a refund / credit — suggested, dismissed, replacement and write-off excluded. */
export const REFUNDS_DUE_CLAIM_COND = (c: string) => `(${c}.status = 'open' AND (${c}.outcome IS NULL OR ${c}.outcome IN ('refund_card', 'gift_card', 'store_credit')))`;
export const REFUNDS_DUE_PO_SQL = (p: string) => `(SELECT COALESCE(SUM(${CLAIM_REMAINING_SQL("c")}), 0) FROM supplier_claims c WHERE c.po_id = ${p}.id AND ${REFUNDS_DUE_CLAIM_COND("c")})`;
export const REFUNDS_DUE_EXISTS_SQL = (p: string) => `EXISTS (SELECT 1 FROM supplier_claims c WHERE c.po_id = ${p}.id AND ${REFUNDS_DUE_CLAIM_COND("c")} AND ${CLAIM_REMAINING_SQL("c")} > 0)`;

/** A closed claim with a write-off on it (§3.14 rows 1 / 4): Write off (outcome write_off) or Write off remainder (a refund outcome with a reason); reopening clears status, so the claim leaves. */
export const WRITTEN_OFF_CLAIM_COND = (c: string) => `(${c}.status = 'closed' AND ${c}.write_off_reason IS NOT NULL)`;
/** The write-off's day in Eastern (the Dashboard's Spend calendar), from closed_at. */
export const WRITTEN_OFF_ON_SQL = (c: string) => `(${c}.closed_at AT TIME ZONE 'America/New_York')::date`;
