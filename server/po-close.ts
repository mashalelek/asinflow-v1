// PO-level Status: Open / Closed (patch docs/claude_spec-patch-po-expand-by-asin.md §5).
//
// NULL closed_at = Open. closed_by ∈ 'auto' | 'sheet' (the one-time §6.4
// backfill of the sheet's "Closed") | a users.id as text (manual).
//
// Auto-close rule (D2; D15 since migration 101): close when ALL hold —
//   (a) every po_asins row has Shipped FBA >= Expected − Lost/damaged by us
//       (Expected = Ordered − Σ claims that count, po_asin_expected; NULLs
//       read as 0) AND every unit is accounted for: at least one row has
//       Shipped FBA > 0, OR (2026-11-13, Maria: bathandbodyworks 00474317701906)
//       units were ordered and nothing is due any more — every ordered unit
//       is covered by a claim that counts (canceled, returned, written off…)
//       or lost by us, so a fully canceled PO with nothing shipped closes
//       too (it then reads Canceled, shared/po-status.ts); compared in ASIN
//       units from the view,
//   (b) no line of the PO carries an action item (row-level Status
//       2026-10-17; purchase_orders.action_items is no longer read), and
//   (c) the PO has no OPEN supplier claim (D15, Maria 2026-11-09).
// Evaluated whenever a qty column is edited, a shipment row changes,
// action_items changes, a claim changes, or a refund row is added / edited /
// removed (a refund can close the claim that kept the PO open, 2026-11-13). Auto never reopens a PO closed by hand or by the
// sheet backfill; a PO auto-closed is reopened automatically when (a) or (b)
// stops holding. Manually unchecking Closed makes it Open and it stays Open
// until the rule next becomes true after a change.
import type { QueryLike } from "./scheduler/types";
import { poAsinRowsSql } from "./po-queries";
import { PO_CLOSE_ACTION_ITEMS_SQL } from "./po-action-items";
import { OPEN_CLAIM_COUNT_PO_SQL } from "./supplier-claim-sql";

/** ASIN units, from po_asin_expected (poAsinRowsSql overlays them). */
export interface PoCloseRow {
  qty_expected_asin: number | string | null;
  qty_lost_damaged_us: number | string | null;
  qty_shipped_fba: number | string | null;
  /** Ordered ASIN units (the API row's `qty`); a row that ordered nothing accounts for nothing. */
  qty?: number | string | null;
}

const num = (v: number | string | null | undefined): number => (v == null ? 0 : typeof v === "number" ? v : parseFloat(v) || 0);

/** (a) alone: every unit accounted for — shipped, or (nothing due at all) covered by claims that count / lost by us. */
export function allUnitsAccounted(rows: PoCloseRow[]): boolean {
  if (rows.length === 0) return false;
  let anyShipped = false, anyOrdered = false, totalDue = 0;
  for (const r of rows) {
    const shipped = num(r.qty_shipped_fba);
    const due = num(r.qty_expected_asin) - num(r.qty_lost_damaged_us);
    if (shipped < due) return false;
    if (shipped > 0) anyShipped = true;
    if (num(r.qty) > 0) anyOrdered = true;
    totalDue += due;
  }
  return anyShipped || (anyOrdered && totalDue <= 0);
}

/** (a) AND (b) AND (c). */
export function autoCloseVerdict(rows: PoCloseRow[], actionItems: readonly string[], openClaims = 0): boolean {
  return actionItems.length === 0 && openClaims === 0 && allUnitsAccounted(rows);
}

export type AutoCloseOutcome = { closed: boolean; closedBy: string | null; changed: "closed" | "reopened" | null };

/** Re-evaluate one PO after a change and apply the rule. Returns the resulting state. */
export async function evaluateAutoClose(poId: string, query: QueryLike): Promise<AutoCloseOutcome> {
  // FBA receiving mismatch is display-only: the close set leaves it out (received never drives auto-close).
  const po = (await query(`SELECT p.closed_at, p.closed_by, ${PO_CLOSE_ACTION_ITEMS_SQL} AS action_items, ${OPEN_CLAIM_COUNT_PO_SQL("p")} AS open_claims FROM purchase_orders p WHERE p.id = $1`, [poId])).rows[0];
  if (!po) throw new Error(`PO ${poId} not found`);
  const rows = (await query(poAsinRowsSql(`pa.po_id = $1`), [poId])).rows as PoCloseRow[];
  const shouldClose = autoCloseVerdict(rows, Array.isArray(po.action_items) ? po.action_items : [], Number(po.open_claims ?? 0));
  const isClosed = po.closed_at != null;
  const closedBy: string | null = po.closed_by ?? null;

  if (shouldClose && !isClosed) {
    await query(`UPDATE purchase_orders SET closed_at = NOW(), closed_by = 'auto', updated_at = NOW() WHERE id = $1 AND closed_at IS NULL`, [poId]);
    return { closed: true, closedBy: "auto", changed: "closed" };
  }
  if (!shouldClose && isClosed && closedBy === "auto") {
    await query(`UPDATE purchase_orders SET closed_at = NULL, closed_by = NULL, updated_at = NOW() WHERE id = $1 AND closed_by = 'auto'`, [poId]);
    return { closed: false, closedBy: null, changed: "reopened" };
  }
  return { closed: isClosed, closedBy, changed: null };
}

/** Manual toggle from the POs table / PO Details: closed_by = the user; reopening clears both. */
export async function setPoClosedManually(poId: string, closed: boolean, userId: number | null, query: QueryLike): Promise<void> {
  if (closed) {
    await query(`UPDATE purchase_orders SET closed_at = NOW(), closed_by = $2, updated_at = NOW() WHERE id = $1`, [poId, userId == null ? "user" : String(userId)]);
  } else {
    await query(`UPDATE purchase_orders SET closed_at = NULL, closed_by = NULL, updated_at = NOW() WHERE id = $1`, [poId]);
  }
}

/** Parse a quantity edit (Individual units since migration 101, D16): null/"" = not tracked; otherwise a non-negative number with at most 2 decimals. */
export function parseQtyInput(v: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (v == null || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "quantity must be a non-negative number" };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

/** The columns a person may edit by hand (§4: At CQG Warehouse, Lost/damaged by us; Shipped by Supplier until email parsing exists). */
export const MANUAL_QTY_COLUMNS = ["qty_at_warehouse", "qty_lost_damaged_us", "qty_shipped_supplier"] as const;
export type ManualQtyColumn = (typeof MANUAL_QTY_COLUMNS)[number];
