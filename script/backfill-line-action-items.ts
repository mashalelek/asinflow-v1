// PO table v2 backfill — dry run and post-deploy check (read-only; migration
// 074 does the writing, docs/claude_spec-patch-po-table-v2.md §3 amended).
//
//   npm run backfill:line-action-items        # before 074: what the migration will insert, per item
//                                             # after 074:  the same, side by side with what the table holds
//
// "Before" = today's storage: po_line_items.action_items (old labels), the
// deprecated purchase_orders.action_items for reference, and the derived
// Review Velocity condition. "After" = rows in po_line_action_items (open),
// per sentence-case item. Nothing is written.
import "dotenv/config";
import pool from "../server/db";
import { LEGACY_ACTION_ITEMS, ACTION_ITEMS, REVIEW_VELOCITY } from "../server/po-status-map";

type Count = { lines: number; pos: number };

async function main() {
  const q = (sql: string, params?: any[]) => pool.query(sql, params);
  const lineArrays = (await q(`SELECT x AS item, count(*)::int AS lines, count(DISTINCT l.po_id)::int AS pos FROM po_line_items l, unnest(l.action_items) x GROUP BY x`)).rows;
  const poColumn = new Map<string, number>((await q(`SELECT x AS item, count(*)::int AS n FROM purchase_orders p, unnest(p.action_items) x GROUP BY x`)).rows.map((r: any) => [r.item, r.n]));
  const rv = (await q(
    `SELECT count(*)::int AS lines, count(DISTINCT l.po_id)::int AS pos FROM po_line_items l
      WHERE EXISTS (SELECT 1 FROM po_tracking t WHERE t.po_id = l.po_id AND t.review_reason IS NOT NULL AND t.suppressed_at IS NULL)`,
  )).rows[0];
  const before = new Map<string, Count & { old: string; poColumn: number }>();
  for (const r of lineArrays) {
    const item = LEGACY_ACTION_ITEMS[r.item] ?? r.item;
    before.set(item, { lines: r.lines, pos: r.pos, old: r.item, poColumn: poColumn.get(r.item) ?? 0 });
  }
  before.set(REVIEW_VELOCITY, { lines: rv.lines, pos: rv.pos, old: "(derived from po_tracking)", poColumn: 0 });

  const hasTable = (await q(`SELECT to_regclass('public.po_line_action_items') IS NOT NULL AS ok`)).rows[0].ok;
  const after = new Map<string, Count>();
  if (hasTable) {
    for (const r of (await q(
      `SELECT ai.item, count(*)::int AS lines, count(DISTINCT l.po_id)::int AS pos FROM po_line_action_items ai JOIN po_line_items l ON l.id = ai.po_line_item_id
        WHERE ai.cleared_at IS NULL GROUP BY ai.item`,
    )).rows) after.set(r.item, { lines: r.lines, pos: r.pos });
  }

  console.log(hasTable ? "\npo_line_action_items present — check: before (today's storage) vs after (open rows)" : "\nDRY RUN — po_line_action_items not created yet; 'after' = what migration 074 will insert");
  console.log(`  ${"item".padEnd(34)} ${"stored as today".padEnd(34)} ${"PO col".padStart(6)}  ${"before lines/POs".padStart(16)}  ${"after lines/POs".padStart(15)}`);
  let tb = 0, ta = 0;
  for (const item of [...ACTION_ITEMS, REVIEW_VELOCITY] as string[]) {
    const b = before.get(item) ?? { lines: 0, pos: 0, old: "—", poColumn: 0 };
    const a = hasTable ? (after.get(item) ?? { lines: 0, pos: 0 }) : { lines: b.lines, pos: b.pos };
    tb += b.lines; ta += a.lines;
    const flag = a.lines !== b.lines || a.pos !== b.pos ? "  ← differs" : "";
    console.log(`  ${item.padEnd(34)} ${b.old.padEnd(34)} ${String(b.poColumn).padStart(6)}  ${`${b.lines} / ${b.pos}`.padStart(16)}  ${`${a.lines} / ${a.pos}`.padStart(15)}${flag}`);
  }
  console.log(`  ${"total line items".padEnd(34)} ${"".padEnd(34)} ${"".padStart(6)}  ${String(tb).padStart(16)}  ${String(ta).padStart(15)}`);
  const lost = (await q(
    `SELECT count(*)::int AS n FROM purchase_orders p, unnest(p.action_items) x
      WHERE NOT EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id AND x = ANY(l.action_items))`,
  )).rows[0].n;
  console.log(`\nPO-column items found on no line of their PO (would be dropped): ${lost}`);
  const unknown = lineArrays.filter((r: any) => !(ACTION_ITEMS as readonly string[]).includes(LEGACY_ACTION_ITEMS[r.item] ?? r.item));
  console.log(`Line items with a label outside the vocabulary: ${unknown.length ? unknown.map((r: any) => r.item).join(", ") : "none"}`);
}

main()
  .catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; })
  .finally(() => pool.end());
