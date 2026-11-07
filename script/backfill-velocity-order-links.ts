// Backfill velocity_order_links (migration 099, Maria 2026-11-07): every
// picker link already in shipment_unmatched (match_reason 'picker') becomes an
// order link, and each --add pairs a Velocity order (found by Velocity's own #
// on GET /inbound or /inventory — read-only) with a PO ASIN row. Links made by
// Col P, the base order # or the candidate rule stay automatic. Each link is
// written through linkVelocityOrder (source 'backfill', a History row). An
// order with picker links to several rows is reported and skipped.
//   tsx script/backfill-velocity-order-links.ts [--add <velocity #>=<po_asin_id>]... [--prod] [--live]
//   e.g. --add 8785=ed92e708-163d-4d6c-9db7-6eaa7ea24eee (havalon no_poid_at_checkout, B00D79EODK)
// Dry run by default (one transaction, rolled back). Nothing is written to Velocity.
import "./env";
import { Pool } from "pg";
import { linkVelocityOrder, velocityOrderLabel } from "../server/velocity-order-links";
import { fetchAllInboundOrders, fetchAllInventoryOrders } from "../server/velocity-api";

const live = process.argv.includes("--live");
const adds: Array<{ number: string; poAsinId: string }> = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== "--add") continue;
  const m = /^(\d+)=([0-9a-f-]{36})$/i.exec(process.argv[i + 1] ?? "");
  if (!m) { console.error("usage: --add <velocity #>=<po_asin_id>"); process.exit(2); }
  adds.push({ number: m[1], poAsinId: m[2] });
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const picker = (await query(
      `SELECT u.velocity_order_id, u.resolved_po_asin_id, u.line, u.resolved_at, p.supplier, p.order_id, pa.asin
         FROM shipment_unmatched u JOIN po_asins pa ON pa.id = u.resolved_po_asin_id JOIN purchase_orders p ON p.id = pa.po_id
        WHERE u.match_reason = 'picker' AND u.resolved_po_asin_id IS NOT NULL ORDER BY u.resolved_at, u.id`,
    )).rows as any[];
    const plan: Array<{ velocityOrderId: string; poAsinId: string; line: any; target: string; from: string }> = [];
    const skipped: string[] = [];
    const byOrder = new Map<string, any[]>();
    for (const r of picker) { const k = String(r.velocity_order_id); if (!byOrder.has(k)) byOrder.set(k, []); byOrder.get(k)!.push(r); }
    for (const [oid, rows] of Array.from(byOrder.entries())) {
      const targets = Array.from(new Set(rows.map((r) => String(r.resolved_po_asin_id))));
      if (targets.length > 1) { skipped.push(`${velocityOrderLabel(rows[0].line)} (${oid.slice(0, 8)}): picker links to ${targets.length} rows — ${rows.map((r) => `${r.supplier} ${r.order_id}`).join(", ")}`); continue; }
      const r = rows[rows.length - 1];
      plan.push({ velocityOrderId: oid, poAsinId: targets[0], line: { ...r.line, quantity: r.line?.quantity ?? r.line?.quantity_shipped }, target: `${r.supplier} ${r.order_id} ${r.asin}`, from: `picker ${String(r.resolved_at?.toISOString?.() ?? r.resolved_at).slice(0, 10)}` });
    }
    if (adds.length > 0) {
      const velocity = [...(await fetchAllInboundOrders()), ...(await fetchAllInventoryOrders())] as any[];
      for (const a of adds) {
        const hits = velocity.filter((o) => String(o.id ?? "") === a.number);
        const row = (await query(`SELECT p.supplier, p.order_id, pa.asin FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE pa.id = $1`, [a.poAsinId])).rows[0];
        if (hits.length !== 1 || !row) { skipped.push(`--add ${a.number}: ${hits.length} Velocity orders with that #${row ? "" : "; PO ASIN row not found"}`); continue; }
        plan.push({ velocityOrderId: String(hits[0].order_id), poAsinId: a.poAsinId, line: hits[0], target: `${row.supplier} ${row.order_id} ${row.asin}`, from: "--add" });
      }
    }
    // Before migration 099 is on this database (production until the deploy): the plan only, read-only.
    if (!(await query(`SELECT to_regclass('velocity_order_links') AS t`)).rows[0].t) {
      if (live) throw new Error("velocity_order_links does not exist on this database yet (migration 099) — deploy first");
      for (const p of plan) console.log(`WOULD LINK       ${velocityOrderLabel(p.line)} (${p.velocityOrderId.slice(0, 8)}) → ${p.target}  [${p.from}]`);
      for (const s of skipped) console.log(`SKIPPED          ${s}`);
      console.log(`PLAN ONLY (migration 099 not applied here) — ${plan.length} planned, ${skipped.length} skipped`);
      return;
    }
    await query("BEGIN");
    let written = 0;
    for (const p of plan) {
      const r = await linkVelocityOrder(query, { velocityOrderId: p.velocityOrderId, poAsinId: p.poAsinId, line: p.line, source: "backfill" }, null);
      const what = r.status !== 200 ? `REFUSED (${(r.body as any).message})` : (r.body as any).linked ? ((r.body as any).previous ? `moved from ${(r.body as any).previous}` : "linked") : "already linked";
      if (r.status === 200 && (r.body as any).linked) written++;
      console.log(`${what.padEnd(16)} ${velocityOrderLabel(p.line)} (${p.velocityOrderId.slice(0, 8)}) → ${p.target}  [${p.from}]`);
    }
    for (const s of skipped) console.log(`SKIPPED          ${s}`);
    console.log(`${live ? "LIVE" : "DRY RUN"} — ${plan.length} planned, ${written} written, ${skipped.length} skipped`);
    if (!live) { await query("ROLLBACK"); console.log("dry run — rolled back; add --live to write"); return; }
    await query("COMMIT");
    console.log("committed");
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
