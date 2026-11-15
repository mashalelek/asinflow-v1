// Dismiss a warning with a note (claims commit 8, §3.13 rows 10–13; §3.8; po_warning_dismissals, migration 114; Maria 2026-11-14).
// Extra units shipped, Pack size mismatch and FBA receiving mismatch dismiss on an ASIN row, Review Velocity on the PO; the row
// keeps the numbers the warning stood on (po-action-items.ts DISMISSAL_QUANTITIES_SQL) — the chip leaves the PO and the POs list,
// comes back when those numbers change (the old line stays as history, PO Details › Notes "Dismissed warnings"), and never
// blocks auto-close. Undo brings it back at once. No invoice saved and Pack size missing are not dismissable.
import type { QueryLike } from "./scheduler/types";
import { EditError, logEdits } from "./po-edit";
import { evaluateAutoClose, type AutoCloseOutcome } from "./po-close";
import { DISMISSAL_QUANTITIES_SQL, REVIEW_VELOCITY_QUANTITIES_SQL, extraUnits, EXTRA_UNITS_EXISTS_SQL, PACK_SIZE_MISMATCH_EXISTS_SQL, RECEIVING_MISMATCH_EXISTS_SQL, REVIEW_VELOCITY_EXISTS_SQL } from "./po-action-items";
import { DISMISSABLE_WARNINGS, EXTRA_UNITS_SHIPPED, PACK_SIZE_MISMATCH, RECEIVING_MISMATCH, REVIEW_VELOCITY } from "./po-status-map";
import { reconcileReviewVelocity } from "./line-action-items";

export interface Dismissal { id: number; po_id: string; po_asin_id: string | null; asin: string | null; warning_type: string; quantities: Record<string, unknown>; summary: string; note: string; dismissed_by: number | null; dismissed_by_name: string | null; dismissed_at: string; undone_at: string | null }

/** "shipped 15 of 12" / "received 10 ≠ shipped 12" / "Velocity pack 6 vs 1" / "reasons: …" — the numbers a dismissal stood on, in words. */
export function dismissalSummary(type: string, q: Record<string, any>): string {
  const n = (v: unknown) => (v == null ? "—" : String(Number(v)));
  switch (type) {
    case EXTRA_UNITS_SHIPPED: return `shipped ${n(q.shipped)} of ${n(q.ordered)}`;
    case RECEIVING_MISMATCH: return `received ${n(q.received)} ≠ shipped ${n(q.shipped)}`;
    case PACK_SIZE_MISMATCH: return `Velocity pack ${n(q.velocity_pack)} vs ${n(q.units_per_pack)} (${q.sold_as ?? "?"})${Number(q.yield_lines) > 0 ? ` · ${q.yield_lines} line yield` : ""}`;
    case REVIEW_VELOCITY: return `reasons: ${Array.isArray(q.reasons) && q.reasons.length ? q.reasons.join("; ") : "—"}`;
    default: return JSON.stringify(q);
  }
}
const rowOf = (r: any): Dismissal => ({ id: Number(r.id), po_id: String(r.po_id), po_asin_id: r.po_asin_id == null ? null : String(r.po_asin_id), asin: r.asin ?? null, warning_type: String(r.warning_type), quantities: r.quantities_json ?? {}, summary: dismissalSummary(String(r.warning_type), r.quantities_json ?? {}), note: String(r.note), dismissed_by: r.dismissed_by == null ? null : Number(r.dismissed_by), dismissed_by_name: r.dismissed_by_name ?? null, dismissed_at: r.dismissed_at instanceof Date ? r.dismissed_at.toISOString() : String(r.dismissed_at), undone_at: r.undone_at == null ? null : r.undone_at instanceof Date ? r.undone_at.toISOString() : String(r.undone_at) });

export async function listDismissals(query: QueryLike, poId: string): Promise<Dismissal[]> {
  return (await query(`SELECT d.*, a.asin, u.display_name AS dismissed_by_name FROM po_warning_dismissals d LEFT JOIN po_asins a ON a.id = d.po_asin_id LEFT JOIN users u ON u.id = d.dismissed_by WHERE d.po_id = $1 ORDER BY d.dismissed_at DESC, d.id DESC`, [poId])).rows.map(rowOf);
}

export type DismissOutcome = { dismissal: Dismissal; close: AutoCloseOutcome };
/**
 * Dismiss `warning` on an ASIN row (Extra units shipped / Pack size mismatch / FBA receiving mismatch) or on the PO (Review
 * Velocity) with a required note. The warning must be live; the numbers at this moment are kept; History row on the PO.
 */
export async function dismissWarning(query: QueryLike, target: { poAsinId?: string | null; poId?: string | null }, warning: string, noteIn: unknown, userId: number | null): Promise<DismissOutcome> {
  const note = String(noteIn ?? "").trim();
  if (!note) throw new EditError(400, "a note is required: why this is OK");
  if (!DISMISSABLE_WARNINGS.includes(warning)) throw new EditError(400, `${warning} cannot be dismissed — it is something to fix, not to explain`);
  let poId: string, poAsinId: string | null = null, quantities: any;
  if (warning === REVIEW_VELOCITY) {
    poId = String(target.poId ?? "");
    const r = (await query(`SELECT p.id, ${REVIEW_VELOCITY_EXISTS_SQL} AS live, ${REVIEW_VELOCITY_QUANTITIES_SQL("p")} AS q FROM purchase_orders p WHERE p.id = $1`, [poId])).rows[0];
    if (!r) throw new EditError(404, "PO not found");
    if (!r.live) throw new EditError(409, "Review Velocity is not open on this PO — nothing to dismiss");
    quantities = r.q;
  } else {
    poAsinId = String(target.poAsinId ?? "");
    const live = warning === EXTRA_UNITS_SHIPPED ? extraUnits("a") : warning === PACK_SIZE_MISMATCH ? PACK_SIZE_MISMATCH_EXISTS_SQL.replace(/pk\.po_id = p\.id/, "pk.id = a.id") : RECEIVING_MISMATCH_EXISTS_SQL.replace(/pk\.po_id = p\.id/, "pk.id = a.id");
    const r = (await query(`SELECT a.id, a.po_id, ${live} AS live, ${DISMISSAL_QUANTITIES_SQL(warning, "a")} AS q FROM po_asins a WHERE a.id = $1`, [poAsinId])).rows[0];
    if (!r) throw new EditError(404, "ASIN row not found");
    if (!r.live) throw new EditError(409, `${warning} is not open on this row — nothing to dismiss`);
    poId = String(r.po_id); quantities = r.q;
  }
  const ins = (await query(`INSERT INTO po_warning_dismissals (po_id, po_asin_id, warning_type, quantities_json, note, dismissed_by, dismissed_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, now()) RETURNING id`, [poId, poAsinId, warning, JSON.stringify(quantities), note, userId])).rows[0];
  const d = (await listDismissals(query, poId)).find((x) => x.id === Number(ins.id))!;
  await logEdits(query, poId, userId, poAsinId ? "asin" : "po", poAsinId ?? poId, [{ field: "warning dismissed", old: `${warning} · ${d.summary}`, new: note }]);
  if (warning === REVIEW_VELOCITY) await reconcileReviewVelocity(query, [poId]);
  const close = await evaluateAutoClose(poId, query);
  return { dismissal: d, close };
}
/** Undo: the warning is back at once (its numbers unchanged); the line stays in the list as undone. */
export async function undoDismissal(query: QueryLike, id: number, userId: number | null): Promise<DismissOutcome> {
  const r = (await query(`UPDATE po_warning_dismissals SET undone_at = now(), undone_by = $2 WHERE id = $1 AND undone_at IS NULL RETURNING po_id, po_asin_id, warning_type`, [id, userId])).rows[0];
  if (!r) throw new EditError(404, "dismissal not found or already undone");
  const poId = String(r.po_id);
  const d = (await listDismissals(query, poId)).find((x) => x.id === id)!;
  await logEdits(query, poId, userId, r.po_asin_id ? "asin" : "po", r.po_asin_id ? String(r.po_asin_id) : poId, [{ field: "warning dismissal undone", old: `${r.warning_type} · ${d.summary} · ${d.note}`, new: null }]);
  if (r.warning_type === REVIEW_VELOCITY) await reconcileReviewVelocity(query, [poId]);
  const close = await evaluateAutoClose(poId, query);
  return { dismissal: d, close };
}
export { EXTRA_UNITS_EXISTS_SQL };
