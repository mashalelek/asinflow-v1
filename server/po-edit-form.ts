// Edit PO as a page (Maria 2026-11-04; SPEC §22 "Edit PO"): GET
// /api/pos/:id/form loads the stored PO as the New PO form's state; PUT
// saves the edited form. The save rebuilds the stored form here (never
// trusting the browser's copy), plans the difference (shared/po-edit-form.ts)
// and runs it through the existing editors — editPoHeader, editLine, addLine,
// removeLine, editAsinRow, the payments / promos writers, the pack update —
// inside the caller's transaction, so each changed field writes its own
// po_edit_log row exactly as the old PO editor did, and a refused step (an
// FBA-shipped line removed, a duplicate order #) rolls the whole save back.
// A v2 PO's costs are recomputed once at the end when a cost-relevant field
// changed (recomputePoCosts leaves an imported PO alone).
import type { QueryLike } from "./scheduler/types";
import { editPoHeader, editLine, addLine, removeLine, editAsinRow, EditError, COST_RELEVANT_FIELDS, ORDER_ID_WARNING } from "./po-edit";
import { addMoneyRow, editMoneyRow, removeMoneyRow } from "./po-money-edit";
import { recomputePoCosts } from "./po-costs";
import { applyAsinPackUpdate, parsePack } from "./asin-pack";
import { asinInfo } from "./asin-suggest";
import { evaluateAutoClose } from "./po-close";
import { poToForm, planPoEdit, storedAsinCosts, isImportedPo, type StoredPo, type PoEditPlan } from "@shared/po-edit-form";
import type { PoFormState } from "@shared/po-form";

/** The PO as stored: header, ASIN rows (by ASIN, as the Products tab) with their lines (by position), promos, payments. */
export async function loadStoredPo(query: QueryLike, poId: string): Promise<StoredPo | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(poId)) return null; // not a PO id → 404, never a uuid-cast 500
  const po = (await query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) return null;
  const asins = (await query(`SELECT * FROM po_asins WHERE po_id = $1 ORDER BY asin`, [poId])).rows;
  const lines = (await query(`SELECT * FROM po_line_items WHERE po_id = $1 ORDER BY position, id`, [poId])).rows;
  const payments = (await query(`SELECT * FROM po_payments WHERE po_id = $1 ORDER BY position, id`, [poId])).rows;
  const promos = (await query(`SELECT * FROM po_promos WHERE po_id = $1 ORDER BY position, id`, [poId])).rows;
  return { po, asins: asins.map((a: any) => ({ ...a, lines: lines.filter((l: any) => String(l.po_asin_id) === String(a.id)) })), payments, promos };
}

export interface PoFormLoad {
  form: PoFormState;
  imported: boolean;
  stored_costs: ReturnType<typeof storedAsinCosts>;
  po: { id: string; supplier: string; order_id: string; closed_at: string | null };
  /** The newest History row: when and by whom ("Last edited" on the page). */
  last_edit: { at: string; user_name: string | null; field: string } | null;
  /** AF's facts for the PO's ASINs, so the picker never re-picks (and resets the pack of) an ASIN on load. */
  known: Array<NonNullable<Awaited<ReturnType<typeof asinInfo>>>>;
}

export async function loadPoForm(query: QueryLike, poId: string): Promise<PoFormLoad | null> {
  const d = await loadStoredPo(query, poId);
  if (!d) return null;
  const last = (await query(
    `SELECT e.at, e.field, u.display_name AS user_name FROM po_edit_log e LEFT JOIN users u ON u.id = e.user_id WHERE e.po_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT 1`, [poId],
  )).rows[0];
  const known = [];
  for (const a of d.asins) { const info = await asinInfo(query, String(a.asin)); if (info) known.push(info); }
  return {
    form: poToForm(d), imported: isImportedPo(d.po), stored_costs: storedAsinCosts(d),
    po: { id: String(d.po.id), supplier: String(d.po.supplier), order_id: String(d.po.order_id), closed_at: d.po.closed_at == null ? null : new Date(d.po.closed_at).toISOString() },
    last_edit: last ? { at: new Date(last.at).toISOString(), user_name: last.user_name ?? null, field: String(last.field) } : null,
    known,
  };
}

export interface PoFormSave { poId: string; changes: number; warning?: string; plan: Omit<PoEditPlan, "errors"> }

const COST_RELEVANT_ASIN = new Set(["cogs_adjustment"]);
const costRelevant = (plan: PoEditPlan): boolean =>
  Object.keys(plan.header).some((k) => COST_RELEVANT_FIELDS.has(k))
  || plan.lineEdits.some((e) => Object.keys(e.body).some((k) => COST_RELEVANT_FIELDS.has(k) || k === "asin"))
  || plan.lineAdds.length > 0 || plan.lineRemoves.length > 0
  || plan.asinEdits.some((e) => e.isNew || Object.keys(e.body).some((k) => COST_RELEVANT_ASIN.has(k) || k === "sold_as"));

/** Save the edited form. `query` must be a transaction (the route's withPoTx): a refused step throws and nothing is kept. */
export async function savePoForm(query: QueryLike, poId: string, next: PoFormState, userId: number | null): Promise<PoFormSave> {
  if (next == null || typeof next !== "object" || !Array.isArray((next as PoFormState).products)) throw new EditError(400, "body must be the PO form");
  const d = await loadStoredPo(query, poId);
  if (!d) throw new EditError(404, "PO not found");
  const imported = isImportedPo(d.po);
  const plan = planPoEdit(poToForm(d), next, { imported });
  if (plan.errors.length) throw new EditError(400, plan.errors.join(" · "));
  const before = Number((await query(`SELECT COUNT(*)::int AS n FROM po_edit_log WHERE po_id = $1`, [poId])).rows[0]?.n ?? 0);
  let warning: string | undefined;
  if (Object.keys(plan.header).length) {
    const r = await editPoHeader(query, poId, plan.header, userId);
    if (r.changes.some((c) => c.field === "order_id")) warning = ORDER_ID_WARNING;
  }
  // Lines: edits (a re-map creates / drops ASIN rows), then adds, then removals — an ASIN keeps its row when a removed line is replaced.
  for (const e of plan.lineEdits) {
    const line = (await query(`SELECT po_id FROM po_line_items WHERE id = $1`, [e.id])).rows[0];
    if (!line || String(line.po_id) !== poId) throw new EditError(409, "a product line changed since the page was opened — reload and try again");
    await editLine(query, e.id, e.body, userId);
  }
  for (const b of plan.lineAdds) await addLine(query, poId, b, userId);
  for (const id of plan.lineRemoves) await removeLine(query, id, userId);
  for (const e of plan.asinEdits) {
    const row = (await query(`SELECT id FROM po_asins WHERE po_id = $1 AND asin = $2`, [poId, e.asin])).rows[0];
    if (row) await editAsinRow(query, String(row.id), e.body, userId);
  }
  for (const b of plan.promoAdds) await addMoneyRow(query, "po_promos", poId, b, userId);
  for (const e of plan.promoEdits) await editMoneyRow(query, "po_promos", e.id, e.body, userId);
  for (const id of plan.promoRemoves) await removeMoneyRow(query, "po_promos", id, userId);
  for (const b of plan.paymentAdds) await addMoneyRow(query, "po_payments", poId, b, userId);
  for (const e of plan.paymentEdits) await editMoneyRow(query, "po_payments", e.id, e.body, userId);
  for (const id of plan.paymentRemoves) await removeMoneyRow(query, "po_payments", id, userId);
  if (costRelevant(plan)) await recomputePoCosts(query, poId, userId);
  // "Update ASIN in AF" (§6.5): the ASIN's pack fields follow this PO (History row; open POs brought along).
  for (const u of plan.packUpdates) await applyAsinPackUpdate(query, u.asin, parsePack({ sold_as: u.sold_as, units_per_pack: u.units_per_pack }), userId, "po_form");
  await evaluateAutoClose(poId, query);
  const after = Number((await query(`SELECT COUNT(*)::int AS n FROM po_edit_log WHERE po_id = $1`, [poId])).rows[0]?.n ?? 0);
  const { errors: _e, ...rest } = plan;
  return { poId, changes: after - before, warning, plan: rest };
}
