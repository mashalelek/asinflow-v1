// The other numbers of a PO (claims commit 8, §3.13 "How a reship is linked"; migration 114; Maria 2026-11-14). The PO's own
// order # never changes and stays the Order ID. Every other number kept on the PO carries a LABEL saying why it is there —
// never a bare "alternate":
//   replacement_order  a reship's own order # (with its claim)        — "It's the reship" writes it
//   previous_number    what the PO was called before a rename, dated  — the rename writes it
//   invoice / confirmation  another number for the very same order    — Maria adds it by hand
//   other              with a short note                              — Maria adds it by hand; the pre-114 numbers, unlabeled
// purchase_orders.alt_order_ids stays the derived text every matcher reads (order-number.ts, tracking-match.ts, the
// Upload plan, the emails): every write here re-derives it. Every change is a History row the PO's History tab shows
// verbatim ("Other number added: R… · replacement order · claim #3344").
import type { QueryLike } from "./scheduler/types";
import { EditError, logEdits } from "./po-edit";

export const OTHER_NUMBER_KINDS = ["replacement_order", "previous_number", "invoice", "confirmation", "other"] as const;
export type OtherNumberKind = (typeof OTHER_NUMBER_KINDS)[number];
export const OTHER_NUMBER_LABELS: Readonly<Record<OtherNumberKind, string>> = { replacement_order: "replacement order", previous_number: "previous number", invoice: "invoice #", confirmation: "confirmation #", other: "other" };
export interface OtherNumber { id: number; po_id: string; number: string; kind: OtherNumberKind; note: string | null; claim_id: number | null; created_at: string }

/** "R4600111200931 · replacement order · claim #3344" — the one wording every place uses (the History row, the Order card, the Tracking tab). */
export function otherNumberText(n: Pick<OtherNumber, "number" | "kind" | "note" | "claim_id">): string {
  return `${n.number} · ${OTHER_NUMBER_LABELS[n.kind] ?? n.kind}${n.claim_id != null ? ` · claim #${n.claim_id}` : ""}${n.note ? ` · ${n.note}` : ""}`;
}
export const isOtherNumberKind = (v: unknown): v is OtherNumberKind => (OTHER_NUMBER_KINDS as readonly string[]).includes(String(v));
const rowOf = (r: any): OtherNumber => ({ id: Number(r.id), po_id: String(r.po_id), number: String(r.number), kind: r.kind, note: r.note ?? null, claim_id: r.claim_id == null ? null : Number(r.claim_id), created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at) });

export async function listOtherNumbers(query: QueryLike, poId: string): Promise<OtherNumber[]> {
  return (await query(`SELECT * FROM po_other_numbers WHERE po_id = $1 ORDER BY id`, [poId])).rows.map(rowOf);
}
export async function loadOtherNumbersFor(query: QueryLike, poIds: readonly string[]): Promise<Map<string, OtherNumber[]>> {
  const out = new Map<string, OtherNumber[]>();
  if (!poIds.length) return out;
  for (const r of (await query(`SELECT * FROM po_other_numbers WHERE po_id = ANY($1::uuid[]) ORDER BY id`, [poIds])).rows.map(rowOf)) { if (!out.has(r.po_id)) out.set(r.po_id, []); out.get(r.po_id)!.push(r); }
  return out;
}
/** alt_order_ids = the numbers, comma-separated, in the order they came — what every matcher reads. */
export async function syncAltOrderIds(query: QueryLike, poId: string): Promise<void> {
  await query(`UPDATE purchase_orders SET alt_order_ids = NULLIF((SELECT string_agg(n.number, ', ' ORDER BY n.id) FROM po_other_numbers n WHERE n.po_id = $1), ''), updated_at = NOW() WHERE id = $1`, [poId]);
}
const clean = (v: unknown) => String(v ?? "").trim();

/**
 * Add (or relabel) a number on the PO. The PO's own order # is refused. A number already there takes the new label / note /
 * claim when given. History: "Other number added: <number> · <label>[ · claim #N][ · note]".
 */
export async function addOtherNumber(query: QueryLike, poId: string, input: { number: unknown; kind: unknown; note?: unknown; claim_id?: number | null }, userId: number | null): Promise<OtherNumber> {
  const number = clean(input.number).replace(/\s+/g, "");
  if (!number) throw new EditError(400, "a number is required");
  if (!isOtherNumberKind(input.kind)) throw new EditError(400, `the label must be one of: ${OTHER_NUMBER_KINDS.map((k) => OTHER_NUMBER_LABELS[k]).join(", ")}`);
  const note = clean(input.note) || null;
  if (input.kind === "other" && !note) throw new EditError(400, "an \"other\" number needs a short note saying why it is there");
  const po = (await query(`SELECT id, order_id FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) throw new EditError(404, "PO not found");
  if (String(po.order_id).trim() === number) throw new EditError(400, "that is the PO's own order # — it never changes and is not an other number");
  const prev = (await query(`SELECT * FROM po_other_numbers WHERE po_id = $1 AND number = $2`, [poId, number])).rows[0];
  const r = rowOf((await query(
    `INSERT INTO po_other_numbers (po_id, number, kind, note, claim_id, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (po_id, number) DO UPDATE SET kind = EXCLUDED.kind, note = COALESCE(EXCLUDED.note, po_other_numbers.note), claim_id = COALESCE(EXCLUDED.claim_id, po_other_numbers.claim_id)
     RETURNING *`, [poId, number, input.kind, note, input.claim_id ?? null, userId])).rows[0]);
  await syncAltOrderIds(query, poId);
  await logEdits(query, poId, userId, "po", poId, [prev ? { field: "Other number labeled", old: otherNumberText(rowOf(prev)), new: otherNumberText(r) } : { field: "Other number added", old: null, new: otherNumberText(r) }]);
  return r;
}
/** Change a number's label / note (a number Maria is told to label, the pre-114 "other" ones). */
export async function labelOtherNumber(query: QueryLike, id: number, input: { kind: unknown; note?: unknown }, userId: number | null): Promise<OtherNumber> {
  const prev = (await query(`SELECT * FROM po_other_numbers WHERE id = $1`, [id])).rows[0];
  if (!prev) throw new EditError(404, "number not found");
  if (!isOtherNumberKind(input.kind)) throw new EditError(400, "unknown label");
  const note = input.note === undefined ? prev.note : clean(input.note) || null;
  if (input.kind === "other" && !note) throw new EditError(400, "an \"other\" number needs a short note saying why it is there");
  const r = rowOf((await query(`UPDATE po_other_numbers SET kind = $2, note = $3 WHERE id = $1 RETURNING *`, [id, input.kind, note])).rows[0]);
  await logEdits(query, r.po_id, userId, "po", r.po_id, [{ field: "Other number labeled", old: otherNumberText(rowOf(prev)), new: otherNumberText(r) }]);
  return r;
}
export async function removeOtherNumber(query: QueryLike, id: number, userId: number | null): Promise<{ po_id: string }> {
  const prev = (await query(`DELETE FROM po_other_numbers WHERE id = $1 RETURNING *`, [id])).rows[0];
  if (!prev) throw new EditError(404, "number not found");
  const r = rowOf(prev);
  await syncAltOrderIds(query, r.po_id);
  await logEdits(query, r.po_id, userId, "po", r.po_id, [{ field: "Other number removed", old: otherNumberText(r), new: null }]);
  return { po_id: r.po_id };
}
/**
 * The Edit PO page's text field (pre-114 "Alternate order #s"): numbers typed there are kept as 'other' with the note
 * "typed on the Edit PO form — label it on the PO page"; numbers removed from the text go.
 */
export async function syncOtherNumbersFromText(query: QueryLike, poId: string, text: string | null, userId: number | null): Promise<void> {
  const want = new Set(String(text ?? "").split(/[\s,;/]+/).map((x) => x.trim()).filter(Boolean));
  const have = await listOtherNumbers(query, poId);
  for (const n of have) if (!want.has(n.number)) await removeOtherNumber(query, n.id, userId);
  for (const num of Array.from(want)) if (!have.some((n) => n.number === num)) await addOtherNumber(query, poId, { number: num, kind: "other", note: "typed on the Edit PO form — label it on the PO page" }, userId);
  await syncAltOrderIds(query, poId);
}
/** The replacement order # of a claim (the reship kept on the PO with this claim's link), if any. */
export async function replacementNumberOf(query: QueryLike, claimId: number): Promise<OtherNumber | null> {
  const r = (await query(`SELECT * FROM po_other_numbers WHERE claim_id = $1 AND kind = 'replacement_order' ORDER BY id DESC LIMIT 1`, [claimId])).rows[0];
  return r ? rowOf(r) : null;
}
