// Action items on the product line — po_line_action_items (PO table v2,
// docs/claude_spec-patch-po-table-v2.md §3, migration 074). Open = cleared_at
// IS NULL. Editors send the desired union for a scope (PO, ASIN row, one
// line): items added go onto every line in scope, items removed are cleared on
// every line in scope (asinWriteThrough decides per line). "Review Velocity"
// is the one stored auto item, mirrored from po_tracking. The derived items
// (Extra units shipped, pack size, receiving mismatch) are never stored.
import type { QueryLike } from "./scheduler/types";
import { ACTION_ITEMS, REVIEW_VELOCITY } from "./po-status-map";
import { asinWriteThrough, REVIEW_VELOCITY_EXISTS_SQL } from "./po-action-items";
import { logEdits } from "./po-edit";

const MANUAL = ACTION_ITEMS as readonly string[];

/** Open manual-vocabulary items per line (Review Velocity left out — editors never touch it). */
export async function loadOpenManualItems(query: QueryLike, lineIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(lineIds.map((id) => [String(id), []]));
  if (lineIds.length === 0) return out;
  const rows = (await query(
    `SELECT po_line_item_id, item FROM po_line_action_items WHERE po_line_item_id = ANY($1::uuid[]) AND cleared_at IS NULL AND item = ANY($2::text[])`,
    [lineIds, MANUAL],
  )).rows as Array<{ po_line_item_id: string; item: string }>;
  for (const r of rows) out.get(String(r.po_line_item_id))?.push(r.item);
  return out;
}

/** Insert open items on one line (intake: sheet / New PO). An item already open is left alone. */
export async function insertLineItems(query: QueryLike, lineId: string, items: readonly string[], source: "manual" | "sheet" | "auto", reason: string | null = null): Promise<void> {
  if (items.length === 0) return;
  await query(
    `INSERT INTO po_line_action_items (po_line_item_id, item, source, reason)
     SELECT $1, x, $3, $4 FROM unnest($2::text[]) x
     ON CONFLICT (po_line_item_id, item) WHERE cleared_at IS NULL DO NOTHING`,
    [lineId, items, source, reason],
  );
}

/**
 * Set the desired union on the lines in scope (by hand). Returns the lines
 * whose items changed. One po_edit_log row per changed line, as before.
 */
export async function writeLineItems(query: QueryLike, poId: string, lineIds: readonly string[], desired: readonly string[], userId: number | null): Promise<string[]> {
  const current = await loadOpenManualItems(query, lineIds);
  const plan = asinWriteThrough(Array.from(current.entries()).map(([id, items]) => ({ id, action_items: items })), desired);
  for (const [lineId, after] of Array.from(plan.entries())) {
    const before = current.get(lineId) ?? [];
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    await insertLineItems(query, lineId, added, "manual");
    if (removed.length > 0) {
      await query(`UPDATE po_line_action_items SET cleared_at = now(), cleared_by = 'manual' WHERE po_line_item_id = $1 AND cleared_at IS NULL AND item = ANY($2::text[])`, [lineId, removed]);
    }
    await logEdits(query, poId, userId, "line", lineId, [{ field: "action_items", old: before.join(", ") || null, new: after.join(", ") || null }]);
  }
  return Array.from(plan.keys());
}

/**
 * Review Velocity (SPEC §26) mirrored from po_tracking onto every line of each
 * PO: open with the current reasons while the condition holds (a new line, or
 * changed reasons, are brought in line); cleared when it does not — 'manual'
 * when the PO's review rows were cleared by hand (suppressed_at), else 'auto'.
 */
export async function reconcileReviewVelocity(query: QueryLike, poIds: readonly string[]): Promise<{ set: number; cleared: number }> {
  const ids = Array.from(new Set(poIds.filter(Boolean).map(String)));
  if (ids.length === 0) return { set: 0, cleared: 0 };
  const cond = (await query(
    `SELECT p.id,
            ${REVIEW_VELOCITY_EXISTS_SQL} AS open,
            (SELECT string_agg(DISTINCT t.review_reason, '; ' ORDER BY t.review_reason) FROM po_tracking t
              WHERE t.po_id = p.id AND t.review_reason IS NOT NULL AND t.suppressed_at IS NULL) AS reasons,
            EXISTS (SELECT 1 FROM po_tracking t WHERE t.po_id = p.id AND t.review_reason IS NOT NULL AND t.suppressed_at IS NOT NULL) AS suppressed
       FROM purchase_orders p WHERE p.id = ANY($1::uuid[])`, [ids],
  )).rows as Array<{ id: string; open: boolean; reasons: string | null; suppressed: boolean }>;
  let set = 0, cleared = 0;
  for (const c of cond) {
    if (c.open) {
      // reasons changed → close the stale rows, then open on every line lacking one
      await query(
        `UPDATE po_line_action_items a SET cleared_at = now(), cleared_by = 'auto'
           FROM po_line_items l WHERE l.id = a.po_line_item_id AND l.po_id = $1 AND a.item = $2 AND a.cleared_at IS NULL AND a.reason IS DISTINCT FROM $3`,
        [c.id, REVIEW_VELOCITY, c.reasons],
      );
      const r = await query(
        `INSERT INTO po_line_action_items (po_line_item_id, item, source, reason)
         SELECT l.id, $2, 'auto', $3 FROM po_line_items l WHERE l.po_id = $1
         ON CONFLICT (po_line_item_id, item) WHERE cleared_at IS NULL DO NOTHING`,
        [c.id, REVIEW_VELOCITY, c.reasons],
      );
      set += r.rowCount ?? 0;
    } else {
      const r = await query(
        `UPDATE po_line_action_items a SET cleared_at = now(), cleared_by = $3
           FROM po_line_items l WHERE l.id = a.po_line_item_id AND l.po_id = $1 AND a.item = $2 AND a.cleared_at IS NULL`,
        [c.id, REVIEW_VELOCITY, c.suppressed ? "manual" : "auto"],
      );
      cleared += r.rowCount ?? 0;
    }
  }
  return { set, cleared };
}

export interface ActionItemLines { lines: number; of: number; asins: string[]; reasons: string[] }
/**
 * Per PO, per stored open item: lines carrying it of all the PO's lines, the
 * ASINs they belong to, and the auto reasons — for the PO row chip's count
 * badge ("·2" when not every line has it) and hover.
 */
export async function loadActionItemLines(query: QueryLike, poIds: readonly string[]): Promise<Map<string, Record<string, ActionItemLines>>> {
  const out = new Map<string, Record<string, ActionItemLines>>();
  if (poIds.length === 0) return out;
  const rows = (await query(
    `SELECT l.po_id, ai.item, count(DISTINCT l.id)::int AS lines,
            (SELECT count(*)::int FROM po_line_items x WHERE x.po_id = l.po_id) AS of,
            array_agg(DISTINCT pa.asin ORDER BY pa.asin) AS asins,
            COALESCE(array_agg(DISTINCT ai.reason) FILTER (WHERE ai.reason IS NOT NULL), '{}') AS reasons
       FROM po_line_action_items ai JOIN po_line_items l ON l.id = ai.po_line_item_id
       LEFT JOIN po_asins pa ON pa.id = l.po_asin_id
      WHERE ai.cleared_at IS NULL AND l.po_id = ANY($1::uuid[])
      GROUP BY l.po_id, ai.item`, [poIds],
  )).rows as Array<{ po_id: string; item: string } & ActionItemLines>;
  for (const r of rows) {
    const k = String(r.po_id);
    if (!out.has(k)) out.set(k, {});
    out.get(k)![r.item] = { lines: r.lines, of: r.of, asins: (r.asins ?? []).filter(Boolean), reasons: r.reasons ?? [] };
  }
  return out;
}
