// "Link to PO ASIN" (Unmatched shipments panel, SPEC §26 component A UI): the
// unmatched Velocity line becomes a Velocity-sourced shipment row on the
// chosen ASIN row (ASIN qty = units ÷ that row's units_per_pack); the
// unmatched record is stamped resolved and remembered (resolved_po_asin_id,
// match_reason 'picker'), so later syncs keep the mapping. The FBA ids come
// from the Velocity shipment's SC match (velocity_shipments.sc_shipment_ids)
// when it is matched; received fills on the next Sync Shipments.
//
// Pulled out of routes.ts (2026-10-29) so it runs against a real schema in
// a test: the route selected v.fba_shipment_ids, a column velocity_shipments
// never had, and every link failed in production.
//
// Overshoot guard (Maria 2026-10-29): a link that would take the row's
// Shipped FBA past Ordered is refused with code 'overshoot' until the caller
// confirms it with a note; the note is stored on the row (extra_units_note,
// the "Extra units shipped" hover) and logged in PO History.
import type { QueryLike } from "./scheduler/types";
import { evaluateAutoClose } from "./po-close";
import { loadPoAsinRows } from "./po-queries";
import { logEdits } from "./po-edit";

export type LinkOutcome =
  | { status: 200; body: { row: any; close: Awaited<ReturnType<typeof evaluateAutoClose>>; qty: number } }
  | { status: 400 | 404 | 409; body: { message: string } }
  | { status: 409; body: { message: string; code: "overshoot"; ordered: number; shipped_before: number; shipped_after: number } };

export interface LinkOptions { confirmOvershoot?: boolean; note?: string | null; userId?: number | null }

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function linkUnmatchedLine(query: QueryLike, unmatchedId: string, poAsinId: string, opts: LinkOptions = {}): Promise<LinkOutcome> {
  if (!/^[0-9a-f-]{36}$/i.test(poAsinId)) return { status: 400, body: { message: "po_asin_id is required" } };
  const u = (await query(
    `SELECT u.*, v.shipped_at, v.sc_shipment_ids, v.sc_match
       FROM shipment_unmatched u JOIN velocity_shipments v ON v.id = u.velocity_shipment_id WHERE u.id = $1`, [unmatchedId],
  )).rows[0];
  if (!u) return { status: 404, body: { message: "unmatched line not found" } };
  if (u.resolved_at) return { status: 409, body: { message: "already resolved" } };
  const pa = (await query(`SELECT id, po_id, units_per_pack, qty, qty_shipped_fba, extra_units_note FROM po_asins WHERE id = $1`, [poAsinId])).rows[0];
  if (!pa) return { status: 404, body: { message: "ASIN row not found" } };
  const units = Number(u.line?.quantity_shipped ?? 0) || 0;
  const qty = r2(units / (Number(pa.units_per_pack) || 1));
  const ordered = Number(pa.qty) || 0;
  const before = Number(pa.qty_shipped_fba) || 0;
  const after = r2(before + qty);
  const note = String(opts.note ?? "").trim();
  if (after > ordered + 1e-9) {
    if (!opts.confirmOvershoot) {
      return { status: 409, body: { code: "overshoot", ordered, shipped_before: before, shipped_after: after,
        message: `Linking puts Shipped FBA at ${after} of ${ordered} ordered — confirm and add a note` } };
    }
    if (!note) return { status: 400, body: { message: "a note is required to link past Ordered" } };
  }
  const matched = u.sc_match === "matched";
  await query(
    `INSERT INTO po_asin_shipments (po_asin_id, velocity_shipment_id, fba_shipment_ids, sc_match, qty_shipped, shipped_at, source)
     VALUES ($1, $2, $3::text[], $4, $5, $6, 'velocity')
     ON CONFLICT (po_asin_id, velocity_shipment_id) DO UPDATE SET qty_shipped = po_asin_shipments.qty_shipped + EXCLUDED.qty_shipped, updated_at = now()`,
    [pa.id, u.velocity_shipment_id, matched ? (u.sc_shipment_ids ?? []) : [], u.sc_match ?? "none", qty, u.shipped_at],
  );
  await query(`UPDATE shipment_unmatched SET resolved_at = now(), resolved_po_asin_id = $2, match_reason = 'picker' WHERE id = $1`, [unmatchedId, pa.id]);
  if (after > ordered + 1e-9) {
    await query(`UPDATE po_asins SET extra_units_note = $2 WHERE id = $1`, [pa.id, note]);
    await logEdits(query, String(pa.po_id), opts.userId ?? null, "asin", String(pa.id), [
      { field: "extra_units_shipped", old: String(before), new: `${after} of ${ordered} ordered (linked ${u.line?.order_number || "a Velocity line"}): ${note}` },
    ]);
  }
  const close = await evaluateAutoClose(String(pa.po_id), query);
  const [row] = (await loadPoAsinRows(query, [String(pa.po_id)])).filter((x: any) => String(x.id) === String(pa.id));
  return { status: 200, body: { row, close, qty } };
}
