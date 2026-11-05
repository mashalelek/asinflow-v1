// Card reward % into COGS for AF-created POs (Maria 2026-11-04, migration
// 090): every card payment on a form-saved PO (cost_formula_version set)
// whose canonical method has a default reward % (settings
// po_payment_method_reward_pct — Walmart card 5 %) and no reward % of its
// own gets the default, then the PO's weighted payment discount % follows
// its payments and its costs recompute — each change with a History row, as
// the Payments tab would (editMoneyRow → syncWeightedPaymentPct →
// recomputePoCosts). A sheet-imported PO is never touched. Prints before /
// after COGS per PO. Dry run by default (one transaction, rolled back).
//   tsx script/apply-card-rewards.ts [--prod] [--live]
import "./env";
import { Pool } from "pg";
import { editMoneyRow } from "../server/po-money-edit";
import { canonicalPaymentName, defaultRewardPct } from "../shared/po-form";
const live = process.argv.includes("--live");
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  const cogs = async (poId: string) => (await query(`SELECT asin, qty, cost_per_unit FROM po_asins WHERE po_id = $1 ORDER BY asin`, [poId])).rows;
  const total = (rows: any[]) => rows.reduce((t, r) => t + Number(r.qty || 0) * Number(r.cost_per_unit || 0), 0);
  try {
    await query("BEGIN");
    const s = (await query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [["po_payment_method_aliases", "po_payment_method_reward_pct"]])).rows;
    const v = (k: string) => s.find((r: any) => r.key === k)?.value ?? null;
    if (!v("po_payment_method_reward_pct")) throw new Error("settings.po_payment_method_reward_pct is missing — is migration 090 applied?");
    const pays = (await query(
      `SELECT pp.id, pp.po_id, pp.nickname, pp.amount, p.supplier, p.order_id, p.order_date::date AS d, p.weighted_gc_discount_pct AS w, p.order_total
         FROM po_payments pp JOIN purchase_orders p ON p.id = pp.po_id
        WHERE pp.method = 'card' AND pp.reward_pct IS NULL AND p.cost_formula_version IS NOT NULL
        ORDER BY p.order_date, p.order_id, pp.position, pp.id`,
    )).rows.filter((r: any) => defaultRewardPct(canonicalPaymentName(String(r.nickname ?? ""), v("po_payment_method_aliases")), v("po_payment_method_reward_pct")) != null);
    const byPo = new Map<string, any[]>();
    for (const r of pays) byPo.set(String(r.po_id), [...(byPo.get(String(r.po_id)) ?? []), r]);
    console.log(`${live ? "LIVE" : "DRY RUN"} — ${pays.length} card payment(s) on ${byPo.size} AF-created PO(s)`);
    let sumBefore = 0, sumAfter = 0;
    for (const [poId, rows] of Array.from(byPo)) {
      const before = await cogs(poId);
      const r0 = rows[0];
      for (const r of rows) {
        const d = defaultRewardPct(canonicalPaymentName(String(r.nickname ?? ""), v("po_payment_method_aliases")), v("po_payment_method_reward_pct"))!;
        await editMoneyRow(query as any, "po_payments", Number(r.id), { reward_pct: d.toFixed(2) }, null);
      }
      const after = await cogs(poId);
      const w = (await query(`SELECT weighted_gc_discount_pct FROM purchase_orders WHERE id = $1`, [poId])).rows[0]?.weighted_gc_discount_pct;
      sumBefore += total(before); sumAfter += total(after);
      console.log(`${r0.supplier} ${r0.order_id} (${String(r0.d?.toISOString?.() ?? r0.d).slice(0, 10)}, total ${r0.order_total}): ${rows.map((r) => `${r.nickname} $${r.amount ?? "?"}`).join(", ")} → weighted ${r0.w ?? "∅"} → ${w ?? "∅"} %`);
      for (const b of before) {
        const a = after.find((x: any) => x.asin === b.asin);
        console.log(`   ${b.asin} qty ${b.qty}: COGS ${b.cost_per_unit} → ${a?.cost_per_unit}`);
      }
      console.log(`   PO COGS ${total(before).toFixed(2)} → ${total(after).toFixed(2)}`);
    }
    console.log(`all: COGS ${sumBefore.toFixed(2)} → ${sumAfter.toFixed(2)} (${(sumAfter - sumBefore).toFixed(2)})`);
    if (!live) { await query("ROLLBACK"); console.log("dry run — rolled back; add --live to write"); return; }
    await query("COMMIT"); console.log("committed");
  } catch (err) { await query("ROLLBACK").catch(() => {}); throw err; }
  finally { client.release(); await pool.end(); }
})();
