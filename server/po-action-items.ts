// Row-level action items (patch docs/claude_spec-patch-row-level-status.md
// §2.1, 2026-10-17). Action items live on the PRODUCT (po_line_items). The
// ASIN row shows the union of its lines; the PO the union of all its lines.
// Setting an item on an ASIN writes it to ALL its lines; removing it removes
// it from all its lines; a product edit touches that line only. Pure.
import { ACTION_ITEMS } from "./po-status-map";

/** Display-ordered union of several action-item arrays. */
export function unionActionItems(lists: ReadonlyArray<readonly string[] | null | undefined>): string[] {
  const set = new Set<string>();
  for (const l of lists) for (const x of l ?? []) set.add(x);
  return (ACTION_ITEMS as readonly string[]).filter((a) => set.has(a));
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
  const want = new Set(desired);
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

/** SQL: the union of line action items for an ASIN row (alias pa) / a PO (alias p). Unordered; order with unionActionItems. */
export const ASIN_ACTION_ITEMS_SQL = `ARRAY(SELECT DISTINCT x FROM po_line_items l, unnest(l.action_items) x WHERE l.po_asin_id = pa.id)`;
export const PO_ACTION_ITEMS_SQL = `ARRAY(SELECT DISTINCT x FROM po_line_items l, unnest(l.action_items) x WHERE l.po_id = p.id)`;
