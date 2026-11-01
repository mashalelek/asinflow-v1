// PO Action Items + the Orders-sheet Status mapping (patch
// docs/claude_spec-patch-po-expand-by-asin.md §6; pre-flight decisions
// 2–3, 2026-10-16). Pure — shared by the routes, the importer and the
// one-time value migration (script/migrate-po-status.ts).
//
// The sheet's free-text Status was a comma-joined bag of unrelated facts:
// action items (kept, as `action_items`), the PO-level Closed flag (kept,
// as closed_at / closed_by = 'sheet'), and state words that are now
// per-ASIN quantities or nothing at all.

/**
 * §6.1 allowed values, display order — sentence case (Maria 2026-10-29). Mirrors
 * the CHECK on po_line_action_items.item (migration 074), which also allows
 * the auto "Review Velocity".
 */
export const ACTION_ITEMS = [
  "Need to return",
  "Missing / damaged from supplier",
  "Confirm refund / replacement",
  "ATTN: Velocity",
  "See comments",
  "SHIP",            // only meaningful when the PO ships from the house (manual)
  "Received - FBM",  // only when the PO ships from the house (manual)
  // Capture PO patch (2026-10-31): set by the system, cleared by hand (or by the system when resolved).
  "Confirm order details", // §6.7: the order-confirmation email differs from the PO (order #, total, line count)
  "Subscription renews",   // §27: a subscription's next order is within 7 days
  "Review renewal PO",     // §27: a renewal PO created from a confirmation email
  "Subscription may be active", // §27: a renewal PO created for a CANCELED subscription (Maria 2026-11-01; migration 076)
] as const;
export const CONFIRM_ORDER_DETAILS = "Confirm order details";
export const SUBSCRIPTION_RENEWS = "Subscription renews";
export const REVIEW_RENEWAL_PO = "Review renewal PO";
export const SUBSCRIPTION_MAY_BE_ACTIVE = "Subscription may be active";
/** Pre-2026-10-29 spellings (migrations 056 / 058) → today's label. */
export const LEGACY_ACTION_ITEMS: Readonly<Record<string, ActionItem>> = {
  "Need to Return": "Need to return",
  "Missing / Damaged from Supplier": "Missing / damaged from supplier",
  "Confirm Refund / Replacement": "Confirm refund / replacement",
  "See Comments": "See comments",
};
export type ActionItem = (typeof ACTION_ITEMS)[number];

/**
 * "Review Velocity" (PO tracking, SPEC §26): stored on every product line of
 * the PO in po_line_action_items (source 'auto', PO table v2 2026-10-29),
 * mirrored from po_tracking by reconcileReviewVelocity — open while any of
 * the PO's tracking rows has a review reason and has not been cleared by
 * hand. Never set from an editor. Shown after the manual items.
 */
export const REVIEW_VELOCITY = "Review Velocity";
/**
 * Pack size (2026-10-29), derived from po_asins like Review Velocity is from
 * po_tracking: "Pack size missing" while sold_as is NULL (not filled in on the
 * sheet, and Velocity could not fill it); "Pack size mismatch" while AF's
 * units_per_pack disagrees with Velocity's (po_asins.velocity_units_per_pack,
 * written by shipment sync A). Both clear as soon as the row is fixed.
 */
export const PACK_SIZE_MISSING = "Pack size missing";
export const PACK_SIZE_MISMATCH = "Pack size mismatch";
/**
 * Receiving (2026-10-29): Received by Amazon is information, never a source
 * of truth — Shipped FBA is the number of record. "Receiving mismatch" shows
 * on a row whose received (once SC reports any) differs from shipped, over or
 * under, so it can be addressed. Display only: it does NOT block auto-close
 * (PO_CLOSE_ACTION_ITEMS_SQL leaves it out) and nothing derives from it.
 */
export const RECEIVING_MISMATCH = "Receiving mismatch";
/**
 * Extra units shipped (Maria 2026-10-29): Shipped FBA over Ordered on a PO
 * ASIN row — from Sync Shipments or a confirmed manual link. Red chip. Clears
 * by itself when the row reconciles (shipped ≤ ordered), or by hand with a
 * required note (po_asins.extra_units_*, migration 073); after a hand clear
 * it comes back only if shipped goes past the value it was cleared at.
 * Blocks auto-close.
 */
export const EXTRA_UNITS_SHIPPED = "Extra units shipped";
export const AUTO_ACTION_ITEMS = [EXTRA_UNITS_SHIPPED, REVIEW_VELOCITY, PACK_SIZE_MISSING, PACK_SIZE_MISMATCH, RECEIVING_MISMATCH] as const;
export const DISPLAY_ACTION_ITEMS: readonly string[] = [...ACTION_ITEMS, ...AUTO_ACTION_ITEMS];

export function isActionItem(s: string): s is ActionItem {
  return (ACTION_ITEMS as readonly string[]).includes(s);
}

/** Validate a client-supplied list: known values only, deduped, in display order. */
export function normalizeActionItems(input: unknown): { ok: true; value: ActionItem[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "action_items must be an array" };
  const set = new Set<string>();
  for (const x of input) {
    const s = String(x ?? "").trim();
    if (!s) continue;
    // Auto items (Review Velocity, the derived ones) are never set from an
    // editor: one that echoes the displayed union may send one — drop it.
    if ((AUTO_ACTION_ITEMS as readonly string[]).includes(s)) continue;
    const v = LEGACY_ACTION_ITEMS[s] ?? s;
    if (!isActionItem(v)) return { ok: false, error: `unknown action item: ${s}` };
    set.add(v);
  }
  return { ok: true, value: ACTION_ITEMS.filter((a) => set.has(a)) };
}

export interface SheetStatusMapping {
  actionItems: ActionItem[];
  /** "Closed" → closed_at = updated_at, closed_by = 'sheet' (decision 3). */
  closed: boolean;
  /** "Canceled" → qty_canceled = qty_ordered on every line of the PO still NULL (§6.4). */
  canceled: boolean;
  /** "Returned" → nothing: the sheet carries no quantity (reported). */
  returned: boolean;
  /** "Received" / "Received Partial" → nothing (D6, decision 2): reported, left NULL. */
  received: boolean;
  /** "Ordered" → nothing (implied by the open-order icon). */
  ordered: boolean;
  /** "Shipped FBA" → nothing (Maria 2026-10-16): a state word AF tracks as po_asins.qty_shipped_fba. */
  shippedFba: boolean;
  /** "Lost / Damaged by Us" (Maria 2026-10-18) → po_asins.qty_lost_damaged_us from Col V. */
  lostDamagedUs: boolean;
  /** Anything else — the caller must STOP and report. */
  unmapped: string[];
  tokens: string[];
}

const CANON: Record<string, ActionItem> = Object.fromEntries(ACTION_ITEMS.map((a) => [a.toLowerCase(), a]));

/** Split the sheet cell on commas / newlines, trim, map every token. */
export function mapSheetStatus(status: string | null | undefined): SheetStatusMapping {
  const tokens = String(status ?? "").split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
  const m: SheetStatusMapping = { actionItems: [], closed: false, canceled: false, returned: false, received: false, ordered: false, shippedFba: false, lostDamagedUs: false, unmapped: [], tokens };
  const seen = new Set<ActionItem>();
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (CANON[k]) { if (!seen.has(CANON[k])) { seen.add(CANON[k]); } continue; }
    if (k === "closed") { m.closed = true; continue; }
    if (k === "canceled" || k === "cancelled") { m.canceled = true; continue; }
    // "Partial Return" (Maria 2026-10-18) is treated as Returned: the qty comes from Col R where present.
    if (k === "returned" || k === "partial return") { m.returned = true; continue; }
    if (k === "lost / damaged by us" || k === "lost/damaged by us") { m.lostDamagedUs = true; continue; }
    if (k === "received" || k === "received partial") { m.received = true; continue; }
    if (k === "ordered") { m.ordered = true; continue; }
    if (k === "shipped fba") { m.shippedFba = true; continue; }
    m.unmapped.push(t);
  }
  m.actionItems = ACTION_ITEMS.filter((a) => seen.has(a));
  return m;
}
