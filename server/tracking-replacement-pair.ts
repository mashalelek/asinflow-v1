// One-off replacement pair (Maria 2026-11-05; the general version is the Allocate-to-another-PO backlog item).
// Walmart PO 200015663718988 carries 11 Caress singles: 10 are its own (5 two-packs), 1 replaces the single
// missing from PO 200015557295492, and Velocity checks that unit in under the earlier PO. So when a tracking number
// matches 200015663718988 and goes to its Velocity order, the same pass also adds it to 200015557295492's Velocity
// order (the bulk tracking PUT — numbers appended, nothing else) and writes a History row on both POs. Until that
// History row exists, 200015663718988 shows the derived action item below; it resolves by itself once the tracking
// is added — or once the to-PO is fully checked in at Velocity (Maria 2026-11-05: the replacement then arrived and
// the tracking is moot; a fully checked-in order also leaves Velocity's inbound list, so the PUT could not run).
// Nothing here changes a quantity on either PO.
import type { QueryLike } from "./scheduler/types";

export interface ReplacementTrackingPair { fromOrderId: string; toOrderId: string; label: string; historyField: string; toHistoryField: string }
export const REPLACEMENT_TRACKING_PAIRS: readonly ReplacementTrackingPair[] = [{
  fromOrderId: "200015663718988",
  toOrderId: "200015557295492",
  label: "Tracking also goes to 200015557295492 (1 replacement single)",
  historyField: "tracking also added to 200015557295492",
  toHistoryField: "tracking added from 200015663718988 (1 replacement single)",
}];
export const REPLACEMENT_TRACKING_LABELS: readonly string[] = REPLACEMENT_TRACKING_PAIRS.map((p) => p.label);

/**
 * SQL: the to-PO is fully checked in at Velocity — it has ASIN rows, and every one with units ordered has Received
 * by Velocity (po_asins.received_velocity, ASIN units, written by shipment sync A) at or above them.
 */
export function toCheckedInSql(p: ReplacementTrackingPair): string {
  return `EXISTS (SELECT 1 FROM purchase_orders tp WHERE tp.order_id = '${p.toOrderId}'
       AND EXISTS (SELECT 1 FROM po_asins ta WHERE ta.po_id = tp.id AND ta.qty > 0)
       AND NOT EXISTS (SELECT 1 FROM po_asins ta WHERE ta.po_id = tp.id AND ta.qty > 0 AND COALESCE(ta.received_velocity, 0) < ta.qty))`;
}

/** SQL (alias `poAlias`): the pair's item while the from-PO has no "tracking also added" History row and the to-PO is not fully checked in. One UNION branch per pair. */
export function replacementTrackingItemsSql(poAlias: string): string {
  return REPLACEMENT_TRACKING_PAIRS.map((p) =>
    `UNION SELECT '${p.label}' WHERE EXISTS (SELECT 1 FROM purchase_orders rp WHERE rp.id = ${poAlias} AND rp.order_id = '${p.fromOrderId}')
       AND NOT EXISTS (SELECT 1 FROM po_edit_log re WHERE re.po_id = ${poAlias} AND re.field = '${p.historyField}')
       AND NOT ${toCheckedInSql(p)}`).join("\n  ");
}

/** Is the to-PO fully checked in at Velocity (the item resolved without a PUT)? */
export async function replacementCheckedIn(query: QueryLike, pair: ReplacementTrackingPair): Promise<boolean> {
  return (await query(`SELECT ${toCheckedInSql(pair)} AS done`)).rows[0]?.done === true;
}

export function pairFor(fromOrderId: string): ReplacementTrackingPair | undefined {
  return REPLACEMENT_TRACKING_PAIRS.find((p) => p.fromOrderId === String(fromOrderId).trim());
}

/** The History rows of one addition: on the from-PO (resolves its item) and on the to-PO. */
export async function logReplacementTracking(query: QueryLike, pair: ReplacementTrackingPair, fromPoId: string, numbers: readonly string[], velocityOrderId: string): Promise<void> {
  const to = (await query(`SELECT id FROM purchase_orders WHERE order_id = $1`, [pair.toOrderId])).rows[0];
  const value = `${numbers.join(", ")} → Velocity order ${velocityOrderId}`;
  await query(`INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived) VALUES ($1, NULL, 'po', $1, $2, NULL, $3, true)`, [fromPoId, pair.historyField, value]);
  if (to) await query(`INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value, derived) VALUES ($1, NULL, 'po', $1, $2, NULL, $3, true)`, [to.id, pair.toHistoryField, value]);
}

/** Has the from-PO's "tracking also added" History row been written (the item resolved)? */
export async function replacementLogged(query: QueryLike, pair: ReplacementTrackingPair, fromPoId: string): Promise<boolean> {
  return ((await query(`SELECT 1 FROM po_edit_log WHERE po_id = $1 AND field = $2 LIMIT 1`, [fromPoId, pair.historyField])).rows.length > 0);
}
