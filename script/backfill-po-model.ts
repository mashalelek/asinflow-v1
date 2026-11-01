// Migration-075 data backfills (patch docs/claude_spec-patch-po-ai-prefill.md
// §8–§9 as amended 2026-10-31; SPEC §22 "Capture PO data model"). Dry run by
// default: prints the plan, writes the review CSVs, changes nothing. --live
// applies everything in ONE transaction. Idempotent: a PO that already has
// rows in the target table, an ASIN whose pack fields are set, a cost already
// stored — each is skipped, never rewritten.
//
//   npm run backfill:po-model                       # dry run (all stages)
//   npm run backfill:po-model -- --live
//   npm run backfill:po-model -- --prod [--live]   # production (script/env.ts); a dry run works before 075 is applied there             # apply
//   npm run backfill:po-model -- --stage pack,sourcing   # a subset
//   --out <dir>   where the CSVs go (default docs/)
//
// Stages:
//   purchased_by  purchase_orders.purchased_by (text) → purchased_by_user_id by users.display_name / email local part
//   payments      purchase_orders.payment_method → po_payments (server/po-payments-parse.ts)
//   refunds       purchase_orders.refund_amount (+ po_line_items.qty_returned) → po_line_refunds (source 'sheet')
//   subscriptions purchase_orders.subscription → subscriptions, one per (supplier, ASIN), newest PO (created_from 'sheet')
//   pack          asins.sold_as / units_per_pack from the 2026 PO ASIN rows (agree → set; else docs/pack-size-gaps-<date>.csv)
//   sourcing      po_asins.sourcing_cost ← the Orders sheet's col AR, verbatim, by (supplier, order #, ASIN);
//                 po_asins.paid_cost ← cost_per_unit (= COGS for imported rows, §7.1). Never touches cost_per_unit.
// Needs DATABASE_URL; the sourcing stage also needs GOOGLE_SHEET_ID / GOOGLE_CREDENTIALS_PATH.
import "./env";
import { DB_TARGET } from "./env";
import fs from "fs";
import path from "path";
import pg from "pg";
import { parsePaymentMethod } from "../server/po-payments-parse";
import { frequencyWeeksFromText, subscriptionStatusFromText, addWeeks, planAsinPack, planRefund, csv, type PackSource } from "../server/po-model-backfill";
import { readPoSheet, moneyVerbatim } from "../server/po-sheet-sync";
import { COL, t } from "../server/po-import-classify";
import { NEWEST_PO_ORDER } from "../server/po-entry-seq";

const LIVE = process.argv.includes("--live");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const ALL = ["purchased_by", "payments", "refunds", "subscriptions", "pack", "sourcing"] as const;
const stages = new Set((arg("--stage") ?? ALL.join(",")).split(",").map((s) => s.trim()).filter(Boolean));
for (const s of Array.from(stages)) if (!(ALL as readonly string[]).includes(s)) throw new Error(`unknown stage ${s}; stages: ${ALL.join(", ")}`);
const outDir = arg("--out") ?? "docs";
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const ymd = (v: any): string => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : String(v).slice(0, 10));
const lineCanceled = `(l.qty_canceled IS NOT NULL AND l.qty_canceled >= COALESCE(l.qty_ordered, 0))`;
const asinCanceled = `COALESCE((SELECT bool_and(${lineCanceled}) FROM po_line_items l WHERE l.po_asin_id = pa.id), false)`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const c = (client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } }));
  await c.connect();
  const q = (sql: string, params?: any[]) => c.query(sql, params);
  console.log(`${LIVE ? "LIVE" : "DRY RUN"} against ${DB_TARGET} · stages: ${Array.from(stages).join(", ")}`);
  const col = (name: string) => (await_ok(q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'purchase_orders' AND column_name = $1`, [name])));
  // Pre-075 database (production before the deploy that applies 075): a DRY
  // RUN plans against the empty post-075 state — every new column reads NULL,
  // every new table is empty — so the plan is exactly what --live will do
  // once 075 is applied. --live itself needs 075 (Maria 2026-11-01: dry-run on
  // production before the migration lands).
  const has075 = await col("purchased_by_user_id");
  if (!has075 && LIVE) throw new Error("migration 075 is not applied on this database — apply it first (npm run migrate), then rerun");
  if (!has075) console.log("  migration 075 is not applied here — the dry run plans against the empty post-075 state (nothing backfilled yet)");
  const writes: Array<() => Promise<void>> = [];
  const report: string[] = [];

  // ── purchased_by ──────────────────────────────────────────────────────────
  if (stages.has("purchased_by")) {
    const rows = (await q(`
      SELECT p.purchased_by AS name, u.id AS user_id, COUNT(*)::int AS n
        FROM purchase_orders p LEFT JOIN users u ON lower(u.display_name) = lower(trim(p.purchased_by)) OR lower(split_part(u.email, '@', 1)) = lower(trim(p.purchased_by))
       WHERE ${has075 ? "p.purchased_by_user_id IS NULL AND " : ""}COALESCE(trim(p.purchased_by), '') <> ''
       GROUP BY 1, 2 ORDER BY 3 DESC`)).rows;
    for (const r of rows) report.push(`purchased_by "${r.name}" × ${r.n} → ${r.user_id == null ? "no users row (text kept, id NULL)" : `user ${r.user_id}`}`);
    writes.push(async () => {
      const r = await q(`UPDATE purchase_orders p SET purchased_by_user_id = u.id FROM users u
        WHERE p.purchased_by_user_id IS NULL AND (lower(u.display_name) = lower(trim(p.purchased_by)) OR lower(split_part(u.email, '@', 1)) = lower(trim(p.purchased_by)))`);
      console.log(`  purchased_by_user_id set on ${r.rowCount} PO(s)`);
    });
  }

  // ── payments ──────────────────────────────────────────────────────────────
  if (stages.has("payments")) {
    const pos = (await q(`SELECT p.id, p.payment_method FROM purchase_orders p
      WHERE COALESCE(trim(p.payment_method), '') <> '' ${has075 ? "AND NOT EXISTS (SELECT 1 FROM po_payments x WHERE x.po_id = p.id)" : ""} ORDER BY p.order_date DESC`)).rows;
    const plan: Array<{ po_id: string; position: number; d: ReturnType<typeof parsePaymentMethod>[number]; raw: string }> = [];
    const byMethod: Record<string, number> = {}; let review = 0, posWithRows = 0;
    for (const p of pos) {
      const ds = parsePaymentMethod(p.payment_method);
      if (ds.length === 0) continue;
      posWithRows++;
      ds.forEach((d, i) => { plan.push({ po_id: p.id, position: i, d, raw: p.payment_method }); byMethod[d.method] = (byMethod[d.method] ?? 0) + 1; if (d.needs_review) review++; });
    }
    report.push(`payments: ${pos.length} PO(s) with a payment_method and no po_payments rows → ${plan.length} row(s) on ${posWithRows} PO(s); by method ${JSON.stringify(byMethod)}; needs_review ${review}`);
    const rv = plan.filter((x) => x.d.needs_review);
    if (rv.length) { const f = path.join(outDir, `payment-review-${today}.csv`); fs.writeFileSync(f, csv([["po_id", "raw_text", "method", "nickname", "last4", "amount"], ...rv.map((x) => [x.po_id, x.raw, x.d.method, x.d.nickname, x.d.last4, x.d.amount])])); report.push(`  review list → ${f}`); }
    writes.push(async () => {
      for (const x of plan) await q(`INSERT INTO po_payments (po_id, position, method, nickname, last4, amount, raw_text, needs_review) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [x.po_id, x.position, x.d.method, x.d.nickname, x.d.last4, x.d.amount, x.raw, x.d.needs_review]);
      console.log(`  po_payments: ${plan.length} row(s) inserted`);
    });
  }

  // ── refunds ───────────────────────────────────────────────────────────────
  if (stages.has("refunds")) {
    const pos = (await q(`SELECT p.id, p.refund_amount::text AS refund_amount,
        COALESCE((SELECT json_agg(json_build_object('id', l.id, 'qty_returned', l.qty_returned::float) ORDER BY l.position) FROM po_line_items l WHERE l.po_id = p.id), '[]') AS lines
      FROM purchase_orders p WHERE p.refund_amount > 0 ${has075 ? "AND NOT EXISTS (SELECT 1 FROM po_line_refunds r WHERE r.po_id = p.id)" : ""}`)).rows;
    const plans = pos.map((p) => planRefund({ po_id: p.id, refund_amount: p.refund_amount, lines: p.lines })).filter((x): x is NonNullable<typeof x> => x != null);
    report.push(`refunds: ${pos.length} PO(s) with refund_amount > 0 and no po_line_refunds → ${plans.filter((x) => !x.needs_split).length} attached to a line, ${plans.filter((x) => x.needs_split).length} PO-level needs_split`);
    writes.push(async () => {
      for (const x of plans) await q(`INSERT INTO po_line_refunds (po_id, po_line_item_id, qty, amount, source, needs_split, note) VALUES ($1,$2,$3,$4,'sheet',$5,$6)`, [x.po_id, x.po_line_item_id, x.qty, x.amount, x.needs_split, x.needs_split ? "PO-level refund from the Orders sheet (col AF); split it across the lines" : "from the Orders sheet (col AF / col R)"]);
      console.log(`  po_line_refunds: ${plans.length} row(s) inserted`);
    });
  }

  // ── subscriptions ─────────────────────────────────────────────────────────
  if (stages.has("subscriptions")) {
    const rows = (await q(`SELECT DISTINCT ON (p.supplier, pa.asin) p.id AS po_id, p.supplier, p.order_date, p.notes, p.promo, pa.id AS po_asin_id, pa.asin, pa.asin_name
        FROM purchase_orders p JOIN po_asins pa ON pa.po_id = p.id
       WHERE p.subscription = true ${has075 ? "AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.supplier = p.supplier AND s.asin = pa.asin)" : ""}
       ORDER BY p.supplier, pa.asin, ${NEWEST_PO_ORDER}`)).rows;
    const plan = rows.map((r) => {
      const text = [r.notes, r.promo].filter(Boolean).join(" · ");
      const freq = frequencyWeeksFromText(text); const status = subscriptionStatusFromText(r.notes);
      const od = ymd(r.order_date);
      return { ...r, order_date: od, freq, status, next: status === "active" && freq ? addWeeks(od, freq) : null };
    });
    report.push(`subscriptions: ${plan.length} (supplier, ASIN) pair(s) from ${new Set(plan.map((x) => x.po_id)).size} flagged PO(s); active ${plan.filter((x) => x.status === "active").length}, canceled ${plan.filter((x) => x.status === "canceled").length}; frequency unknown ${plan.filter((x) => x.freq == null).length}`);
    for (const x of plan.slice(0, 60)) report.push(`  ${x.supplier} ${x.asin} (${x.order_date}) ${x.status} every ${x.freq ?? "?"} wk → next ${x.next ?? "—"} · "${String(x.notes ?? "").slice(0, 50)}"`);
    writes.push(async () => {
      for (const x of plan) await q(`INSERT INTO subscriptions (supplier, po_asin_id, asin, product_name, frequency_weeks, next_order_date, status, last_po_id, created_from, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sheet',$9)`,
        [x.supplier, x.po_asin_id, x.asin, x.asin_name, x.freq, x.next, x.status, x.po_id, x.notes]);
      console.log(`  subscriptions: ${plan.length} row(s) inserted`);
    });
  }

  // ── pack ──────────────────────────────────────────────────────────────────
  if (stages.has("pack")) {
    const rows = (await q(`SELECT pa.asin, a.title, pa.sold_as, pa.units_per_pack, COUNT(*)::int AS pos
        FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id LEFT JOIN asins a ON a.asin = pa.asin
       WHERE p.order_date >= '2026-01-01' AND pa.sold_as IS NOT NULL AND NOT ${asinCanceled}
       GROUP BY pa.asin, a.title, pa.sold_as, pa.units_per_pack`)).rows as PackSource[];
    const none = (await q(`SELECT DISTINCT pa.asin, a.title FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id LEFT JOIN asins a ON a.asin = pa.asin
       WHERE p.order_date >= '2026-01-01' AND NOT EXISTS (SELECT 1 FROM po_asins x JOIN purchase_orders px ON px.id = x.po_id WHERE x.asin = pa.asin AND px.order_date >= '2026-01-01' AND x.sold_as IS NOT NULL)`)).rows;
    const plan = planAsinPack(rows, none);
    const inAsins = new Set((await q(`SELECT asin FROM asins${has075 ? " WHERE sold_as IS NULL" : ""}`)).rows.map((r) => String(r.asin)));
    const known = (await q(`SELECT asin FROM asins`)).rows.map((r) => String(r.asin));
    const knownSet = new Set(known);
    const toSet = plan.set.filter((s) => inAsins.has(s.asin));
    report.push(`pack: ${plan.set.length} ASIN(s) agree (${toSet.length} to set — ${plan.set.length - toSet.length} already set or not in asins), ${plan.gaps.length} gap(s) (${plan.gaps.filter((g) => g.values.length > 0).length} disagree, ${plan.gaps.filter((g) => g.values.length === 0).length} blank on every row; ${plan.gaps.filter((g) => !knownSet.has(g.asin)).length} not in asins)`);
    const f = path.join(outDir, `pack-size-gaps-${today}.csv`);
    fs.writeFileSync(f, csv([["asin", "title", "in_af_catalog", "distinct_values_seen (sold_as×units_per_pack: PO rows)", "sold_as (fill in)", "units_per_pack (fill in)"],
      ...plan.gaps.map((g) => [g.asin, g.title, knownSet.has(g.asin) ? "yes" : "no", g.values.length === 0 ? "blank on every 2026 row" : g.values.map((v) => `${v.sold_as}×${v.units_per_pack}: ${v.pos}`).join("; "), "", ""])]));
    report.push(`  gaps → ${f}`);
    writes.push(async () => {
      for (const s of toSet) {
        await q(`UPDATE asins SET sold_as = $2, units_per_pack = $3 WHERE asin = $1 AND sold_as IS NULL`, [s.asin, s.sold_as, s.units_per_pack]);
        await q(`INSERT INTO asin_field_log (asin, field, old_value, new_value, source) VALUES ($1,'sold_as',NULL,$2,'backfill'), ($1,'units_per_pack',NULL,$3,'backfill')`, [s.asin, s.sold_as, String(s.units_per_pack)]);
      }
      console.log(`  asins pack fields set on ${toSet.length} ASIN(s)`);
    });
  }

  // ── sourcing ──────────────────────────────────────────────────────────────
  if (stages.has("sourcing")) {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set (sourcing stage)");
    const { dataCells } = await readPoSheet(sheetId);
    const AR = 43, AJ = 35;
    const ar = new Map<string, { value: string | null; divzero: boolean; aj: string }>();
    for (const cells of dataCells) {
      let supplier = t(cells[COL.supplier]); if (supplier === "shop.tetleyusa.com / WorldPantry.com") supplier = "shop.tetleyusa.com";
      const key = `${supplier}\u0000${t(cells[COL.orderId])}\u0000${t(cells[COL.asin]).toUpperCase()}`;
      if (!t(cells[COL.orderId]) || ar.has(key)) continue;
      let v: { value: string | null; divzero: boolean };
      try { v = moneyVerbatim(cells[AR] ?? ""); } catch { v = { value: null, divzero: false }; }
      ar.set(key, { ...v, aj: t(cells[AJ]) });
    }
    const rows = (await q(`SELECT pa.id, p.supplier, p.order_id, pa.asin, pa.cost_per_unit::text AS y, ${has075 ? "pa.sourcing_cost, pa.paid_cost" : "NULL::numeric AS sourcing_cost, NULL::numeric AS paid_cost"}, p.weighted_gc_discount_pct::float AS gc
        FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id ${has075 ? "WHERE pa.sourcing_cost IS NULL OR pa.paid_cost IS NULL" : ""}`)).rows;
    const upd: Array<{ id: string; sourcing: string | null; paid: string | null }> = [];
    let matched = 0, unmatched = 0, divzero = 0, arNull = 0, consistent = 0, inconsistent = 0;
    for (const r of rows) {
      const hit = ar.get(`${r.supplier}\u0000${r.order_id}\u0000${String(r.asin).toUpperCase()}`);
      let sourcing: string | null = null;
      if (!hit) unmatched++;
      else { matched++; if (hit.divzero) divzero++; else if (hit.value == null) arNull++; else { sourcing = Number(hit.value).toFixed(2);
        // sanity: AR = Y ÷ (1 − AJ) on the sheet; counted, never used to change anything
        if (r.y != null) { const gc = (Number(r.gc) || 0) / 100; if (Math.abs(Number(r.y) / (1 - gc) - Number(hit.value)) < 0.015) consistent++; else inconsistent++; } } }
      upd.push({ id: r.id, sourcing: r.sourcing_cost == null ? sourcing : null, paid: r.paid_cost == null && r.y != null ? Number(r.y).toFixed(2) : null });
    }
    report.push(`sourcing: ${rows.length} ASIN row(s) missing sourcing/paid cost; sheet rows matched ${matched} (AR value ${matched - divzero - arNull}, #DIV/0! ${divzero}, blank ${arNull}), not in the sheet ${unmatched}; AR = Y/(1−GC) holds on ${consistent}, differs on ${inconsistent} (recorded, not changed)`);
    writes.push(async () => {
      let s = 0, pcount = 0;
      for (const u of upd) {
        if (u.sourcing != null) { await q(`UPDATE po_asins SET sourcing_cost = $2 WHERE id = $1 AND sourcing_cost IS NULL`, [u.id, u.sourcing]); s++; }
        if (u.paid != null) { await q(`UPDATE po_asins SET paid_cost = $2 WHERE id = $1 AND paid_cost IS NULL`, [u.id, u.paid]); pcount++; }
      }
      console.log(`  po_asins: sourcing_cost set on ${s}, paid_cost set on ${pcount}`);
    });
  }

  console.log(report.map((l) => (l.startsWith("  ") ? l : `\n${l}`)).join("\n"));
  if (!LIVE) { console.log(`\nDry run — nothing written. Re-run with --live to apply.`); await c.end(); return; }
  await q("BEGIN");
  try { for (const w of writes) await w(); await q("COMMIT"); console.log("\nCOMMIT"); }
  catch (e) { await q("ROLLBACK").catch(() => {}); throw e; }
  finally { await c.end(); }
}
async function await_ok(p: Promise<pg.QueryResult>): Promise<boolean> { return ((await p).rowCount ?? 0) > 0; }

// An error after connect must still close the client, or the open socket
// keeps the process alive forever (the first --prod dry run, 2026-11-01).
let client: pg.Client | undefined;
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => client?.end().catch(() => {}));
