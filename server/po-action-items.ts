// Row-level action items (patch docs/claude_spec-patch-row-level-status.md
// §2.1, 2026-10-17). Action items live on the PRODUCT (po_line_items). The
// ASIN row shows the union of its lines; the PO the union of all its lines.
// Setting an item on an ASIN writes it to ALL its lines; removing it removes
// it from all its lines; a product edit touches that line only. Pure.
import { AUTO_ACTION_ITEMS, DISPLAY_ACTION_ITEMS, EXTRA_UNITS_SHIPPED, PACK_SIZE_MISMATCH, PACK_SIZE_MISSING, RECEIVING_MISMATCH, REVIEW_VELOCITY } from "./po-status-map";

/** Display-ordered union of several action-item arrays. */
export function unionActionItems(lists: ReadonlyArray<readonly string[] | null | undefined>): string[] {
  const set = new Set<string>();
  for (const l of lists) for (const x of l ?? []) set.add(x);
  return DISPLAY_ACTION_ITEMS.filter((a) => set.has(a));
}

/**
 * The ASIN editor sends the desired union. Items added vs the current union
 * go onto every line; items removed come off every line; items left alone
 * stay exactly where they were (a product-level item is not spread to its
 * siblings just because the ASIN was edited for something else).
 * Returns only the lines whose array changes.
 */
export function asinWriteThrough(lines: Array<{ id: string; action_items: readonly string[] | null }>, desired: readonly string[]): Map<string, string[]> {
  const current = new Set(unionActionItems(lines.map((l) => l.action_items)));
  // Auto items are derived, never written to lines.
  const want = new Set(desired.filter((x) => !(AUTO_ACTION_ITEMS as readonly string[]).includes(x)));
  const added = Array.from(want).filter((x) => !current.has(x));
  const removed = new Set(Array.from(current).filter((x) => !want.has(x)));
  const out = new Map<string, string[]>();
  for (const l of lines) {
    const before = unionActionItems([l.action_items]);
    const after = unionActionItems([before.filter((x) => !removed.has(x)), added]);
    if (after.length !== before.length || after.some((x, i) => x !== before[i])) out.set(l.id, after);
  }
  return out;
}

/**
 * Pack-size conditions on an ASIN row, alias `a` (see PACK_SIZE_MISSING / PACK_SIZE_MISMATCH).
 * Missing fires only while the row has a live line — ordered > 0, not fully
 * canceled, final qty not 0 (2026-10-29): a 0-qty or canceled line needs no pack size —
 * and only on an Open PO: a closed PO keeps its NULL silently (Maria 2026-10-29).
 */
const packMissing = (a: string) => `(${a}.sold_as IS NULL AND EXISTS (SELECT 1 FROM po_line_items lx WHERE lx.po_asin_id = ${a}.id
  AND COALESCE(lx.qty_ordered, 0) > 0 AND COALESCE(lx.qty_canceled, 0) < lx.qty_ordered AND (lx.final_qty IS NULL OR lx.final_qty > 0))
  AND EXISTS (SELECT 1 FROM purchase_orders px WHERE px.id = ${a}.po_id AND px.closed_at IS NULL))`;
/** Received known and different from shipped (NULL received = SC has reported nothing yet: no flag). */
const receivingMismatch = (a: string) => `(${a}.qty_received_amazon IS NOT NULL AND ${a}.qty_received_amazon <> COALESCE(${a}.qty_shipped_fba, 0))`;
export const RECEIVING_MISMATCH_EXISTS_SQL = `EXISTS (SELECT 1 FROM po_asins pk WHERE pk.po_id = p.id AND ${receivingMismatch("pk")})`;
const packMismatch = (a: string) => `(${a}.sold_as IS NOT NULL AND ${a}.sold_as <> 'bundle' AND ${a}.velocity_units_per_pack IS NOT NULL AND ${a}.velocity_units_per_pack <> COALESCE(${a}.units_per_pack, 1))`;
/** Shipped FBA over Ordered, not cleared by hand at (or above) the current shipped. */
export const extraUnits = (a: string) => `(COALESCE(${a}.qty_shipped_fba, 0) > ${a}.qty AND (${a}.extra_units_cleared_shipped IS NULL OR ${a}.qty_shipped_fba > ${a}.extra_units_cleared_shipped))`;
export const EXTRA_UNITS_EXISTS_SQL = `EXISTS (SELECT 1 FROM po_asins pk WHERE pk.po_id = p.id AND ${extraUnits("pk")})`;
export const PACK_SIZE_MISSING_EXISTS_SQL = `EXISTS (SELECT 1 FROM po_asins pk WHERE pk.po_id = p.id AND ${packMissing("pk")})`;
export const PACK_SIZE_MISMATCH_EXISTS_SQL = `EXISTS (SELECT 1 FROM po_asins pk WHERE pk.po_id = p.id AND ${packMismatch("pk")})`;

/** Open stored items (po_line_action_items, migration 074) of the lines matching `where` (alias l). */
export const openLineItemsSql = (where: string) =>
  `SELECT ai.item FROM po_line_action_items ai JOIN po_line_items l ON l.id = ai.po_line_item_id WHERE ai.cleared_at IS NULL AND ${where}`;
/** SQL: the union of line action items for an ASIN row (alias pa) / a PO (alias p), plus the derived ones. Unordered; order with unionActionItems. */
export const ASIN_ACTION_ITEMS_SQL = `ARRAY(${openLineItemsSql("l.po_asin_id = pa.id")}
  UNION SELECT '${EXTRA_UNITS_SHIPPED}' WHERE ${extraUnits("pa")}
  UNION SELECT '${PACK_SIZE_MISSING}' WHERE ${packMissing("pa")}
  UNION SELECT '${PACK_SIZE_MISMATCH}' WHERE ${packMismatch("pa")}
  UNION SELECT '${RECEIVING_MISMATCH}' WHERE ${receivingMismatch("pa")})`;
/**
 * "Review Velocity" (SPEC §26) condition: a tracking row of the PO has a
 * review reason and was not cleared by hand. Since PO table v2 the item itself
 * is stored on every line (reconcileReviewVelocity mirrors this condition).
 */
export const REVIEW_VELOCITY_EXISTS_SQL = `EXISTS (SELECT 1 FROM po_tracking t WHERE t.po_id = p.id AND t.review_reason IS NOT NULL AND t.suppressed_at IS NULL)`;
/** The PO's items that block auto-close: everything except Receiving mismatch (received never drives anything). */
export const PO_CLOSE_ACTION_ITEMS_SQL = `ARRAY(${openLineItemsSql("l.po_id = p.id")}
  UNION SELECT '${EXTRA_UNITS_SHIPPED}' WHERE ${EXTRA_UNITS_EXISTS_SQL}
  UNION SELECT '${PACK_SIZE_MISSING}' WHERE ${PACK_SIZE_MISSING_EXISTS_SQL}
  UNION SELECT '${PACK_SIZE_MISMATCH}' WHERE ${PACK_SIZE_MISMATCH_EXISTS_SQL})`;
/** The PO's displayed items: the close set plus Receiving mismatch. */
export const PO_ACTION_ITEMS_SQL = `ARRAY(${openLineItemsSql("l.po_id = p.id")}
  UNION SELECT '${EXTRA_UNITS_SHIPPED}' WHERE ${EXTRA_UNITS_EXISTS_SQL}
  UNION SELECT '${PACK_SIZE_MISSING}' WHERE ${PACK_SIZE_MISSING_EXISTS_SQL}
  UNION SELECT '${PACK_SIZE_MISMATCH}' WHERE ${PACK_SIZE_MISMATCH_EXISTS_SQL}
  UNION SELECT '${RECEIVING_MISMATCH}' WHERE ${RECEIVING_MISMATCH_EXISTS_SQL})`;
/** The open review reasons of a PO (alias p), for the Action Items tooltip. */
export const REVIEW_VELOCITY_REASONS_SQL = `ARRAY(SELECT DISTINCT r FROM po_tracking t, unnest(string_to_array(t.review_reason, '; ')) r
  WHERE t.po_id = p.id AND t.review_reason IS NOT NULL AND t.suppressed_at IS NULL)`;
