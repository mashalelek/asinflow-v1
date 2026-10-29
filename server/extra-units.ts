// "Extra units shipped" — the manual clear (Maria 2026-10-29). The item is
// derived (po-action-items.ts: Shipped FBA > Ordered); it clears by itself
// when the row reconciles. Clearing it by hand needs a note: stored on the
// row (extra_units_note, shown on hover), logged in PO History, and the
// shipped value at that moment is kept so the item comes back only if more
// units ship past it.
import type { QueryLike } from "./scheduler/types";
import { evaluateAutoClose } from "./po-close";
import { loadPoAsinRows } from "./po-queries";
import { logEdits } from "./po-edit";

export type ClearOutcome =
  | { status: 200; body: { row: any; close: Awaited<ReturnType<typeof evaluateAutoClose>> } }
  | { status: 400 | 404 | 409; body: { message: string } };

export async function clearExtraUnits(query: QueryLike, poAsinId: string, noteIn: unknown, userId: number | null): Promise<ClearOutcome> {
  const note = String(noteIn ?? "").trim();
  if (!note) return { status: 400, body: { message: "a note is required to clear Extra units shipped" } };
  const pa = (await query(`SELECT id, po_id, qty, qty_shipped_fba, extra_units_note FROM po_asins WHERE id = $1`, [poAsinId])).rows[0];
  if (!pa) return { status: 404, body: { message: "ASIN row not found" } };
  const shipped = Number(pa.qty_shipped_fba) || 0, ordered = Number(pa.qty) || 0;
  if (!(shipped > ordered)) return { status: 409, body: { message: "Shipped FBA is not over Ordered — nothing to clear" } };
  await query(
    `UPDATE po_asins SET extra_units_note = $2, extra_units_cleared_shipped = qty_shipped_fba, extra_units_cleared_at = now(), extra_units_cleared_by = $3 WHERE id = $1`,
    [pa.id, note, userId],
  );
  await logEdits(query, String(pa.po_id), userId, "asin", String(pa.id), [
    { field: "extra_units_cleared", old: `${shipped} of ${ordered} ordered`, new: note },
  ]);
  const close = await evaluateAutoClose(String(pa.po_id), query);
  const [row] = (await loadPoAsinRows(query, [String(pa.po_id)])).filter((x: any) => String(x.id) === String(pa.id));
  return { status: 200, body: { row, close } };
}
