// One-time sweep (Maria 2026-11-12): (1) converted badge claims (migration 101 — open, no quantity, enter_quantity open)
// whose PO line — or whose PO, through a whole-PO suggestion — already carries a finder's suggestion are dismissed
// "superseded by found claim" (a History row and a dismissed event each); converted claims with no suggestion stay. Going
// forward the finder does this itself (suggestClaim → supersedeConvertedOnLine). (2) Stray open contact_supplier tasks on
// claims already reported (a canceled claim, a typed report date, a confirmation, an earlier tick) are deleted — the
// derivation ignores them already (effectiveTasks); timeout-created ones ("N business days: …") stay.
//
//   npm run claims:supersede-converted -- [--prod] [--live]
//
// Dry run by default: lists every claim it would dismiss and the suggestion that supersedes it.
import "./env";
import pool from "../server/db";
import { sweepSupersededConverted, deleteStrayContactTasks } from "../server/claim-suggestions";

async function main() {
  const live = process.argv.includes("--live");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q = (sql: string, params?: any[]) => client.query(sql, params) as any;
    const r = await sweepSupersededConverted(q, { dryRun: !live });
    for (const x of r.rows) console.log(`claim #${x.claim_id} ${x.kind} · ${x.supplier} ${x.order_id} · ${(x.product_name ?? x.po_line_item_id).slice(0, 60)} ← suggestion #${x.suggestion_id} ${x.suggestion_kind} (${x.suggestion_status})`);
    const byStatus = r.rows.reduce<Record<string, number>>((m, x) => { m[x.suggestion_status] = (m[x.suggestion_status] ?? 0) + 1; return m; }, {});
    console.log(`${live ? "LIVE" : "DRY RUN"} — converted badge claims superseded by a suggestion on the same line: ${r.rows.length} (by suggestion status ${JSON.stringify(byStatus)}); dismissed ${live ? r.dismissed : 0}`);
    const stray = await deleteStrayContactTasks(q, { dryRun: !live });
    for (const t of stray) console.log(`stray contact_supplier task #${t.task_id} on claim #${t.claim_id} (${t.kind}, ${t.found_by})`);
    console.log(`${live ? "LIVE" : "DRY RUN"} — stray report prompts on reported claims: ${stray.length} ${live ? "deleted" : "would be deleted"}`);
    if (live) await client.query("COMMIT"); else await client.query("ROLLBACK");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
