// Correct an AF-created PO's costs under the per-promo rule (Maria 2026-11-05, michaels.com
// 4300109060826629: saved at 6.37 / 3.11 with MEGA30DEAL −$18.00 already in the paint's price).
//   tsx script/fix-po-promo-cogs.ts --order <id> [--promo-amount <n>=<amount>] [--prod] [--live]
// `--promo-amount 1=18.00` sets promo n's (1-based, form order) amount the way the PO editor does
// (editMoneyRow: a History row, then the recompute); without it the recompute alone runs. Every
// write goes through one transaction, rolled back unless --live; the plan and the ASIN rows before /
// after are printed either way. A sheet-imported PO is refused (its values are never recomputed).
//   tsx script/fix-po-promo-cogs.ts --sweep [--prod]
// Read-only: every AF-created PO whose recompute would change an ASIN row's COGS now.
import "./env";
import { Pool } from "pg";
import { editMoneyRow } from "../server/po-money-edit";
import { recomputePoCosts } from "../server/po-costs";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const order = arg("--order"), live = process.argv.includes("--live"), sweep = process.argv.includes("--sweep");
const pa = arg("--promo-amount");
const pm = pa == null ? null : /^(\d+)=(\d+(?:\.\d{1,2})?)$/.exec(pa);
if ((!order && !sweep) || (pa != null && !pm)) { console.error("usage: --order <order id> [--promo-amount <n>=<amount>] [--prod] [--live] | --sweep [--prod]"); process.exit(2); }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    if (sweep) {
      const pos = (await query(`SELECT id, supplier, order_id, order_date FROM purchase_orders WHERE cost_formula_version IS NOT NULL ORDER BY order_date, order_id`)).rows;
      let n = 0;
      for (const po of pos) {
        const r = await recomputePoCosts(query, po.id, null, { dryRun: true });
        const cogs = (r.plan ?? []).filter((c) => c.entity === "asin" && c.field === "cost_per_unit");
        if (cogs.length || r.ambiguousPromos) {
          n++;
          const asins = (await query(`SELECT id, asin FROM po_asins WHERE po_id = $1`, [po.id])).rows;
          const name = new Map(asins.map((a: any) => [String(a.id), a.asin]));
          console.log(`${po.supplier} ${po.order_id} (${String(po.order_date).slice(0, 10)})${r.ambiguousPromos ? " — ambiguous promos" : ""}: ${cogs.map((c) => `${name.get(c.id)} ${c.old} → ${c.new}`).join(", ") || "no COGS change"}`);
        }
      }
      console.log(`${pos.length} AF-created POs; ${n} would change`);
      return;
    }
    const pos = (await query(`SELECT id, supplier, order_id, cost_formula_version FROM purchase_orders WHERE order_id = $1`, [order])).rows;
    if (pos.length !== 1) throw new Error(`${pos.length} POs match order ${order}`);
    const po = pos[0];
    if (po.cost_formula_version == null) throw new Error(`${po.supplier} ${po.order_id} is sheet-imported: its costs are never recomputed`);
    const rows = async () => (await query(`SELECT asin, qty, cost_per_unit, sourcing_cost, paid_cost FROM po_asins WHERE po_id = $1 ORDER BY asin`, [po.id])).rows.map((r: any) => `${r.asin} × ${Number(r.qty)}: COGS ${r.cost_per_unit}, sourcing ${r.sourcing_cost}, paid ${r.paid_cost}`);
    console.log(`${po.supplier} ${po.order_id} (formula v${po.cost_formula_version}) — ${live ? "LIVE" : "dry run (rolled back)"}`);
    console.log("before:\n  " + (await rows()).join("\n  "));
    await query("BEGIN");
    if (pm) {
      const promos = (await query(`SELECT id, description, amount FROM po_promos WHERE po_id = $1 ORDER BY position, id`, [po.id])).rows;
      const p = promos[Number(pm[1]) - 1];
      if (!p) throw new Error(`no promo ${pm[1]} (${promos.length} on the PO)`);
      console.log(`promo ${pm[1]} "${p.description}": amount ${p.amount ?? "∅"} → ${Number(pm[2]).toFixed(2)}`);
      const r = await editMoneyRow(query, "po_promos", Number(p.id), { amount: Number(pm[2]).toFixed(2) }, null);
      console.log(`  recompute after the edit: ${r.recomputed ? `${r.recomputed.changed} field(s) changed` : "none (amount unchanged)"}`);
    }
    const r = await recomputePoCosts(query, po.id, null);
    console.log(`recompute: ${r.changed} more field(s) changed${r.ambiguousPromos ? " — AMBIGUOUS promos (which are already in the prices?)" : ""}`);
    console.log("after:\n  " + (await rows()).join("\n  "));
    await query(live ? "COMMIT" : "ROLLBACK");
    console.log(live ? "committed" : "rolled back — nothing written");
  } catch (e) {
    await query("ROLLBACK").catch(() => {});
    console.error(String((e as Error).message ?? e)); process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
})();
