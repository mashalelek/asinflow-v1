// PO Action Items + the Orders-sheet Status mapping (patch
// docs/claude_spec-patch-po-expand-by-asin.md §6; pre-flight decisions
// 2–3, 2026-10-16). Pure — shared by the routes, the importer and the
// one-time value migration (script/migrate-po-status.ts).
//
// The sheet's free-text Status was a comma-joined bag of unrelated facts:
// action items (kept, as `action_items`), the PO-level Closed flag (kept,
// as closed_at / closed_by = 'sheet'), and state words that are now
// per-ASIN quantities or nothing at all.

/** §6.1 allowed values, display order. Mirrors the CHECK in migration 056. */
export const ACTION_ITEMS = [
  "Need to Return",
  "Missing / Damaged from Supplier",
  "Confirm Refund / Replacement",
  "ATTN: Velocity",
  "See Comments",
  "SHIP",            // only meaningful when the PO ships from the house (manual)
  "Received - FBM",  // only when the PO ships from the house (manual)
] as const;
export type ActionItem = (typeof ACTION_ITEMS)[number];

/**
 * Auto-managed action items (PO tracking, SPEC §26 / §22, 2026-10-21): never
 * stored on lines (not in the CHECK), derived from po_tracking — "Review
 * Velocity" while any of the PO's tracking rows has a review reason and has
 * not been cleared by hand. Shown after the manual items.
 */
export const REVIEW_VELOCITY = "Review Velocity";
export const AUTO_ACTION_ITEMS = [REVIEW_VELOCITY] as const;
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
    // Auto items (Review Velocity) are derived, never stored: an editor that
    // echoes the displayed union may send one — drop it, do not refuse.
    if ((AUTO_ACTION_ITEMS as readonly string[]).includes(s)) continue;
    if (!isActionItem(s)) return { ok: false, error: `unknown action item: ${s}` };
    set.add(s);
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
