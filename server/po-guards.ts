// Delete / cancel guards and Reassign shipment (patch
// docs/claude_spec-patch-po-af-owned.md §5, 2026-10-18).
//
// 5.1 A PO, ASIN row or product line with any po_asin_shipments row (units
//     shipped to FBA) can be neither deleted nor canceled. The message is
//     "N units shipped to FBA in <FBA ids>. Reassign the shipment to another
//     PO first."
// 5.2 Reassign moves a shipment row (all of it or some units) onto another
//     PO's ASIN row with the same ASIN. Both rows become assigned_by =
//     'manual' with the Velocity line identity (velocity_shipment_id +
//     velocity_order_number + ASIN), so Sync Shipments keeps them where they
//     are and only refreshes quantities (shipment-sync-velocity.ts). Logged on
//     both POs; auto-close re-runs on both.
// 5.3 Delete (no FBA shipment): PO, lines and ASIN rows go; a deleted_pos
//     tombstone keeps Sync POs from re-importing it. Units still At Prep at
//     Velocity do not block — the confirm dialog names them.
// 5.4 Cancel PO = every line qty_canceled = qty_ordered.
import type { QueryLike } from "./scheduler/types";
import { evaluateAutoClose, type AutoCloseOutcome } from "./po-close";
import { fbaShipmentsOf, shipmentBlockMessage, logEdits, asLogText, EditError } from "./po-edit";

export interface PoGuards {
  poId: string;
  supplier: string;
  orderId: string;
  lineCount: number;
  asinCount: number;
  fba: { units: number; fbaIds: string[]; rows: number };
  /** Σ qty_at_prep (ASIN units) — still at Velocity. */
  atPrepUnits: number;
  /** null = allowed; otherwise the §5.1 message. */
  blocked: string | null;
}

export async function loadPoGuards(query: QueryLike, poId: string): Promise<PoGuards> {
  const po = (await query(
    `SELECT p.id, p.supplier, p.order_id,
            (SELECT COUNT(*)::int FROM po_line_items l WHERE l.po_id = p.id) AS lines,
            (SELECT COUNT(*)::int FROM po_asins a WHERE a.po_id = p.id) AS asins,
            (SELECT COALESCE(SUM(a.qty_at_prep), 0) FROM po_asins a WHERE a.po_id = p.id) AS at_prep
       FROM purchase_orders p WHERE p.id = $1`, [poId],
  )).rows[0];
  if (!po) throw new EditError(404, "PO not found");
  const fba = await fbaShipmentsOf(query, { poId });
  return {
    poId, supplier: String(po.supplier), orderId: String(po.order_id), lineCount: Number(po.lines), asinCount: Number(po.asins),
    fba, atPrepUnits: Math.round(Number(po.at_prep) * 100) / 100, blocked: fba.rows > 0 ? shipmentBlockMessage(fba) : null,
  };
}

/** §5.3 Delete: refused while any FBA shipment exists; writes the tombstone; logs (po_edit_log has no FK — the row outlives the PO). */
export async function deletePo(query: QueryLike, poId: string, userId: number | null): Promise<{ deleted: true; supplier: string; orderId: string; lines: number; asins: number; atPrepUnits: number }> {
  const g = await loadPoGuards(query, poId);
  if (g.blocked) throw new EditError(409, g.blocked);
  await query(
    `INSERT INTO deleted_pos (supplier, order_id, deleted_by) VALUES ($1, $2, $3)
     ON CONFLICT (supplier, order_id) DO UPDATE SET deleted_by = EXCLUDED.deleted_by, deleted_at = now()`,
    [g.supplier, g.orderId, userId],
  );
  await logEdits(query, poId, userId, "po", poId, [{ field: "PO deleted", old: `${g.supplier} ${g.orderId} — ${g.asinCount} ASIN(s), ${g.lineCount} product(s)${g.atPrepUnits > 0 ? `, ${asLogText(g.atPrepUnits)} still at Velocity` : ""}`, new: null }]);
  await query(`DELETE FROM po_line_items WHERE po_id = $1`, [poId]);
  await query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]); // po_asins cascade
  return { deleted: true, supplier: g.supplier, orderId: g.orderId, lines: g.lineCount, asins: g.asinCount, atPrepUnits: g.atPrepUnits };
}

/** §5.4 Cancel PO: every line canceled for its full ordered quantity. Refused while any FBA shipment exists. */
export async function cancelPo(query: QueryLike, poId: string, userId: number | null): Promise<{ linesCanceled: number; close: AutoCloseOutcome }> {
  const g = await loadPoGuards(query, poId);
  if (g.blocked) throw new EditError(409, g.blocked);
  const r = await query(`UPDATE po_line_items SET qty_canceled = qty_ordered WHERE po_id = $1 AND qty_ordered IS NOT NULL AND qty_canceled IS DISTINCT FROM qty_ordered RETURNING id, qty_ordered`, [poId]);
  for (const l of r.rows) await logEdits(query, poId, userId, "line", String(l.id), [{ field: "qty_canceled", old: null, new: asLogText(l.qty_ordered) }]);
  if ((r.rowCount ?? 0) > 0) await logEdits(query, poId, userId, "po", poId, [{ field: "PO canceled", old: null, new: `${r.rowCount} product(s)` }]);
  return { linesCanceled: r.rowCount ?? 0, close: await evaluateAutoClose(poId, query) };
}

/** §5.1 guard for Cancel ASIN / a line cancel: the ASIN row must carry no FBA shipment. */
export async function assertAsinRowCancelable(query: QueryLike, poAsinId: string): Promise<void> {
  const s = await fbaShipmentsOf(query, { poAsinId });
  if (s.rows > 0) {
    const asin = (await query(`SELECT asin FROM po_asins WHERE id = $1`, [poAsinId])).rows[0]?.asin ?? "";
    throw new EditError(409, `${asin}: ${shipmentBlockMessage(s)}`);
  }
}

/**
 * The Velocity Order # of the line a velocity shipment row came from: the
 * row's own velocity_order_number when set; otherwise the shipment detail's
 * line with this ASIN (raw.detail.orders) — the one whose order # is the
 * source PO's when several lines carry the ASIN.
 */
export async function velocityOrderNumberFor(query: QueryLike, row: { velocity_shipment_id: string; velocity_order_number: string | null; asin: string; order_id: string }): Promise<string> {
  if (row.velocity_order_number) return row.velocity_order_number;
  const raw = (await query(`SELECT raw FROM velocity_shipments WHERE id = $1`, [row.velocity_shipment_id])).rows[0]?.raw;
  const lines: any[] = Array.isArray(raw?.detail?.orders) ? raw.detail.orders : [];
  const same = lines.filter((l) => String(l?.asin ?? "").trim().toUpperCase() === row.asin.toUpperCase());
  const nums = Array.from(new Set(same.map((l) => String(l?.order_number ?? "").trim()).filter(Boolean)));
  if (nums.length === 1) return nums[0];
  const exact = nums.find((n) => n === row.order_id);
  if (exact) return exact;
  throw new EditError(409, nums.length === 0
    ? `cannot identify the Velocity line for ${row.asin} in shipment ${row.velocity_shipment_id.slice(0, 8)} (no stored shipment detail) — run Sync Shipments first`
    : `shipment ${row.velocity_shipment_id.slice(0, 8)} has ${nums.length} Velocity lines for ${row.asin} (${nums.join(", ")}) — cannot tell which one to pin`);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** §5.2 Reassign `units` (ASIN units, ≤ shipped; default all) of a shipment row onto another PO's ASIN row with the same ASIN. */
export async function reassignShipment(query: QueryLike, shipmentRowId: string, targetPoAsinId: string, unitsIn: unknown, userId: number | null): Promise<{ moved: number; from: { poId: string; orderId: string }; to: { poId: string; orderId: string }; close: { from: AutoCloseOutcome; to: AutoCloseOutcome } }> {
  const src = (await query(
    `SELECT s.*, pa.asin, pa.po_id, p.order_id, p.supplier FROM po_asin_shipments s JOIN po_asins pa ON pa.id = s.po_asin_id JOIN purchase_orders p ON p.id = pa.po_id WHERE s.id = $1`,
    [shipmentRowId],
  )).rows[0];
  if (!src) throw new EditError(404, "shipment not found");
  const tgt = (await query(`SELECT pa.id, pa.asin, pa.po_id, p.order_id, p.supplier FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE pa.id = $1`, [targetPoAsinId])).rows[0];
  if (!tgt) throw new EditError(404, "target ASIN row not found");
  if (String(tgt.asin).toUpperCase() !== String(src.asin).toUpperCase()) throw new EditError(400, `the target row is ${tgt.asin}; a shipment of ${src.asin} can only move to a ${src.asin} row`);
  if (String(tgt.id) === String(src.po_asin_id)) throw new EditError(400, "the shipment is already on that row");
  const shipped = Number(src.qty_shipped);
  const units = unitsIn == null || unitsIn === "" ? shipped : Number(unitsIn);
  if (!Number.isFinite(units) || units <= 0 || units > shipped + 1e-9 || Math.abs(units * 100 - Math.round(units * 100)) > 1e-6) {
    throw new EditError(400, `units must be more than 0 and at most ${asLogText(shipped)} (2 decimals)`);
  }
  const isVelocity = src.source === "velocity";
  const vOrder = isVelocity ? await velocityOrderNumberFor(query, src) : null;
  const all = Math.abs(units - shipped) < 1e-9;
  const recv = src.qty_received == null ? null : Number(src.qty_received);
  const recvMoved = recv == null ? null : all ? recv : r2(recv * units / shipped);

  // Target: merge into an existing row for the same shipment, else a new row.
  const existing = (await query(`SELECT id, qty_shipped, qty_received FROM po_asin_shipments WHERE po_asin_id = $1 AND velocity_shipment_id = $2`, [tgt.id, src.velocity_shipment_id])).rows[0];
  if (existing) {
    await query(
      `UPDATE po_asin_shipments SET qty_shipped = qty_shipped + $2, qty_received = CASE WHEN $3::numeric IS NULL THEN qty_received ELSE COALESCE(qty_received, 0) + $3 END,
              assigned_by = 'manual', velocity_order_number = COALESCE($4, velocity_order_number), updated_at = now() WHERE id = $1`,
      [existing.id, units, recvMoved, vOrder],
    );
  } else if (all) {
    await query(`UPDATE po_asin_shipments SET po_asin_id = $2, assigned_by = 'manual', velocity_order_number = $3, updated_at = now() WHERE id = $1`, [shipmentRowId, tgt.id, vOrder]);
  } else {
    await query(
      `INSERT INTO po_asin_shipments (po_asin_id, velocity_shipment_id, fba_shipment_ids, sc_match, qty_shipped, qty_received, shipped_at, source, assigned_by, velocity_order_number)
       VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8, 'manual', $9)`,
      [tgt.id, src.velocity_shipment_id, src.fba_shipment_ids ?? [], src.sc_match, units, recvMoved, src.shipped_at, src.source, vOrder],
    );
  }
  // Source: gone when everything moved (unless it was moved in place), else reduced and pinned.
  if (all && existing) await query(`DELETE FROM po_asin_shipments WHERE id = $1`, [shipmentRowId]);
  else if (!all) {
    await query(
      `UPDATE po_asin_shipments SET qty_shipped = qty_shipped - $2, qty_received = CASE WHEN qty_received IS NULL THEN NULL ELSE qty_received - $3 END,
              assigned_by = 'manual', velocity_order_number = COALESCE($4, velocity_order_number), updated_at = now() WHERE id = $1`,
      [shipmentRowId, units, recvMoved ?? 0, vOrder],
    );
  }
  const what = `${asLogText(units)} of ${src.asin} (${(src.fba_shipment_ids ?? []).join(", ") || (isVelocity ? `Velocity ${String(src.velocity_shipment_id).slice(0, 8)}` : "manual shipment")})`;
  await logEdits(query, String(src.po_id), userId, "shipment", String(src.po_asin_id), [{ field: "shipment reassigned out", old: what, new: `${tgt.supplier} ${tgt.order_id}` }]);
  await logEdits(query, String(tgt.po_id), userId, "shipment", String(tgt.id), [{ field: "shipment reassigned in", old: `${src.supplier} ${src.order_id}`, new: what }]);
  const from = await evaluateAutoClose(String(src.po_id), query);
  const to = await evaluateAutoClose(String(tgt.po_id), query);
  return { moved: units, from: { poId: String(src.po_id), orderId: String(src.order_id) }, to: { poId: String(tgt.po_id), orderId: String(tgt.order_id) }, close: { from, to } };
}
