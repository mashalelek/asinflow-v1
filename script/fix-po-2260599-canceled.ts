// One-off (Maria 2026-11-12): detailedimage.com 2260599 carried two canceled claims — #3342, the never_received suggestion
// she opened and re-kinded, and #3370 from Cancel PO. One canceled claim stays: #3370, 7 Individual units, $85.53
// (the order total; the auto figure was $85.54), confirmed by the supplier 2026-10-19; #3342 is dismissed "superseded by
// cancel". Dry run by default.
//
//   tsx script/fix-po-2260599-canceled.ts [--prod] [--live]
import "./env";
import pool from "../server/db";
import { confirmSupplier, dismissClaim, editClaim } from "../server/supplier-claims";

async function main() {
  const live = process.argv.includes("--live");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q = (sql: string, params?: any[]) => client.query(sql, params) as any;
    const po = (await q(`SELECT id FROM purchase_orders WHERE order_id = '2260599' AND supplier = 'detailedimage.com'`)).rows[0];
    if (!po) throw new Error("PO 2260599 not found");
    const show = async () => (await q(`SELECT c.id, c.po_line_item_id IS NOT NULL AS on_line, c.kind, c.status, c.qty, c.amount_owed, c.amount_owed_source, c.outcome, c.supplier_confirmed_at::text AS confirmed,
        (SELECT string_agg(t.kind || CASE WHEN t.done_at IS NULL THEN '(open)' ELSE '(done)' END, ', ' ORDER BY t.id) FROM supplier_claim_tasks t WHERE t.claim_id = c.id) AS tasks
        FROM supplier_claims c WHERE c.po_id = $1 ORDER BY c.id`, [po.id])).rows;
    console.log("before:"); for (const r of await show()) console.log("  " + JSON.stringify(r));
    const keep = (await q(`SELECT id FROM supplier_claims WHERE po_id = $1 AND kind = 'canceled' AND po_line_item_id IS NOT NULL AND status = 'open' ORDER BY id`, [po.id])).rows;
    const drop = (await q(`SELECT id FROM supplier_claims WHERE po_id = $1 AND po_line_item_id IS NULL AND status IN ('open', 'suggested') AND suggestion_key IS NOT NULL ORDER BY id`, [po.id])).rows;
    if (keep.length !== 1) throw new Error(`expected one open line-level canceled claim, found ${keep.length}`);
    const id = Number(keep[0].id);
    for (const d of drop) await dismissClaim(q, Number(d.id), null, "superseded by cancel");
    await editClaim(q, id, { qty: 7, amount_owed: "85.53" }, null);
    await confirmSupplier(q, id, { at: "2026-10-19", outcome: "refund_card" }, null);
    console.log("after:"); for (const r of await show()) console.log("  " + JSON.stringify(r));
    console.log(`${live ? "LIVE" : "DRY RUN"} — kept #${id}, dismissed ${drop.map((d: any) => `#${d.id}`).join(", ") || "none"}`);
    if (live) await client.query("COMMIT"); else await client.query("ROLLBACK");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
