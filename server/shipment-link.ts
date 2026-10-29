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
import type { QueryLike } from "./scheduler/types";
import { evaluateAutoClose } from "./po-close";
import { loadPoAsinRows } from "./po-queries";

export type LinkOutcome =
  | { status: 200; body: { row: any; close: Awaited<ReturnType<typeof evaluateAutoClose>>; qty: number } }
  | { status: 400 | 404 | 409; body: { message: string } };

export async function linkUnmatchedLine(query: QueryLike, unmatchedId: string, poAsinId: string): Promise<LinkOutcome> {
  if (!/^[0-9a-f-]{36}$/i.test(poAsinId)) return { status: 400, body: { message: "po_asin_id is required" } };
  const u = (await query(
    `SELECT u.*, v.shipped_at, v.sc_shipment_ids, v.sc_match
       FROM shipment_unmatched u JOIN velocity_shipments v ON v.id = u.velocity_shipment_id WHERE u.id = $1`, [unmatchedId],
  )).rows[0];
  if (!u) return { status: 404, body: { message: "unmatched line not found" } };
  if (u.resolved_at) return { status: 409, body: { message: "already resolved" } };
  const pa = (await query(`SELECT id, po_id, units_per_pack FROM po_asins WHERE id = $1`, [poAsinId])).rows[0];
  if (!pa) return { status: 404, body: { message: "ASIN row not found" } };
  const units = Number(u.line?.quantity_shipped ?? 0) || 0;
  const qty = Math.round((units / (Number(pa.units_per_pack) || 1)) * 100) / 100;
  const matched = u.sc_match === "matched";
  await query(
    `INSERT INTO po_asin_shipments (po_asin_id, velocity_shipment_id, fba_shipment_ids, sc_match, qty_shipped, shipped_at, source)
     VALUES ($1, $2, $3::text[], $4, $5, $6, 'velocity')
     ON CONFLICT (po_asin_id, velocity_shipment_id) DO UPDATE SET qty_shipped = po_asin_shipments.qty_shipped + EXCLUDED.qty_shipped, updated_at = now()`,
    [pa.id, u.velocity_shipment_id, matched ? (u.sc_shipment_ids ?? []) : [], u.sc_match ?? "none", qty, u.shipped_at],
  );
  await query(`UPDATE shipment_unmatched SET resolved_at = now(), resolved_po_asin_id = $2, match_reason = 'picker' WHERE id = $1`, [unmatchedId, pa.id]);
  const close = await evaluateAutoClose(String(pa.po_id), query);
  const [row] = (await loadPoAsinRows(query, [String(pa.po_id)])).filter((x: any) => String(x.id) === String(pa.id));
  return { status: 200, body: { row, close, qty } };
}
