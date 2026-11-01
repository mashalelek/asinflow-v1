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
//   pack          po_asins.sold_as / units_per_pack ← the sheet's literal AX/AY (blank → NULL, never individual; Maria 2026-11-01), then
//                 asins.sold_as / units_per_pack from the rows that have a value, newest first (agree → set; disagree →
//                 docs/pack-size-mismatch-<date>.csv; none → docs/pack-size-gaps-<date>.csv)
//   sourcing      po_asins.sourcing_cost ← the Orders sheet's col AR, verbatim, by (supplier, order #, ASIN);
//                 po_asins.paid_cost ← cost_per_unit (= COGS for imported rows, §7.1). Never touches cost_per_unit.
// Needs DATABASE_URL; the sourcing stage also needs GOOGLE_SHEET_ID / GOOGLE_CREDENTIALS_PATH.
import "./env";
import { DB_TARGET } from "./env";
import fs from "fs";
import path from "path";
import pg from "pg";
import { parsePaymentMethod } from "../server/po-payments-parse";
import { frequencyWeeksFromText, subscriptionStatusFromText, addWeeks, planAsinPack, packFromSheetCells, packKey, planRefund, csv, type PackRow } from "../server/po-model-backfill";
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
  // The Orders sheet, read once for the payments / pack / sourcing stages:
  // rows by (supplier, order #) and by (supplier, order #, ASIN).
  let sheetCache: { dataCells: string[][]; byPo: Map<string, string[][]>; byRow: Map<string, string[][]> } | null = null;
  const sheetIndex = async () => {
    if (sheetCache) return sheetCache;
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set (payments / pack / sourcing stages read the Orders sheet)");
    const { dataCells } = await readPoSheet(sheetId);
    const byPo = new Map<string, string[][]>(), byRow = new Map<string, string[][]>();
    const push = (m: Map<string, string[][]>, k: string, v: string[]) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    for (const cells of dataCells) {
      let supplier = t(cells[COL.supplier]); if (supplier === "shop.tetleyusa.com / WorldPantry.com") supplier = "shop.tetleyusa.com";
      const orderId = t(cells[COL.orderId]); if (!orderId) continue;
      push(byPo, `${supplier}\u0000${orderId}`, cells);
      push(byRow, `${supplier}\u0000${orderId}\u0000${t(cells[COL.asin]).toUpperCase()}`, cells);
    }
    sheetCache = { dataCells, byPo, byRow };
    return sheetCache;
  };

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
    const pos = (await q(`SELECT p.id, p.supplier, p.order_id, p.payment_method FROM purchase_orders p
      WHERE COALESCE(trim(p.payment_method), '') <> '' ${has075 ? "AND NOT EXISTS (SELECT 1 FROM po_payments x WHERE x.po_id = p.id)" : ""} ORDER BY p.order_date DESC`)).rows;
    const plan: Array<{ po_id: string; position: number; d: ReturnType<typeof parsePaymentMethod>[number]; raw: string }> = [];
    const byMethod: Record<string, number> = {}; let review = 0, posWithRows = 0;
    // Maria 2026-11-01 (review answer 2): a text the parser cannot read is
    // re-read from the Orders sheet (col AI) — she corrects it there. A
    // differing sheet text replaces purchase_orders.payment_method (an
    // intake-only exception, like col AS) and is parsed instead.
    const reread: Array<{ po_id: string; from: string; to: string }> = [];
    let sheetRows: Map<string, string[][]> | null = null;
    for (const p of pos) {
      let text: string = p.payment_method;
      if (parsePaymentMethod(text).some((d) => d.needs_review)) {
        sheetRows ??= (await sheetIndex()).byPo;
        const cells = sheetRows.get(`${p.supplier}\u0000${p.order_id}`)?.[0];
        const sheetText = cells ? t(cells[COL.paymentMethod]) : "";
        if (sheetText && sheetText !== String(text).trim()) { reread.push({ po_id: p.id, from: text, to: sheetText }); text = sheetText; }
      }
      const ds = parsePaymentMethod(text);
      if (ds.length === 0) continue;
      posWithRows++;
      ds.forEach((d, i) => { plan.push({ po_id: p.id, position: i, d, raw: text }); byMethod[d.method] = (byMethod[d.method] ?? 0) + 1; if (d.needs_review) review++; });
    }
    if (reread.length) report.push(`  payment text re-read from the sheet on ${reread.length} PO(s): ${reread.map((x) => `${x.po_id.slice(0, 8)}… "${x.from}" → "${x.to}"`).join("; ")}`);
    report.push(`payments: ${pos.length} PO(s) with a payment_method and no po_payments rows → ${plan.length} row(s) on ${posWithRows} PO(s); by method ${JSON.stringify(byMethod)}; needs_review ${review}`);
    const rv = plan.filter((x) => x.d.needs_review);
    if (rv.length) { const f = path.join(outDir, `payment-review-${today}.csv`); fs.writeFileSync(f, csv([["po_id", "raw_text", "method", "nickname", "last4", "amount"], ...rv.map((x) => [x.po_id, x.raw, x.d.method, x.d.nickname, x.d.last4, x.d.amount])])); report.push(`  review list → ${f}`); }
    writes.push(async () => {
      for (const x of reread) await q(`UPDATE purchase_orders SET payment_method = $2 WHERE id = $1`, [x.po_id, x.to]);
      if (reread.length) console.log(`  purchase_orders.payment_method re-read from the sheet on ${reread.length} PO(s)`);
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
      // Maria 2026-11-01: every sheet-flagged subscription is backfilled as CANCELED (the notes cannot say which still
      // run); a confirmation email for one creates the PO with "Subscription may be active" and Maria flips it.
      const freq = frequencyWeeksFromText(text); const status = "canceled" as const; const textStatus = subscriptionStatusFromText(r.notes);
      const od = ymd(r.order_date);
      return { ...r, order_date: od, freq, status, textStatus, next: null as string | null };
    });
    report.push(`subscriptions: ${plan.length} (supplier, ASIN) pair(s) from ${new Set(plan.map((x) => x.po_id)).size} flagged PO(s) — all backfilled as canceled (Maria 2026-11-01; the notes read active on ${plan.filter((x) => x.textStatus === "active").length}, canceled on ${plan.filter((x) => x.textStatus === "canceled").length}); frequency unknown ${plan.filter((x) => x.freq == null).length}`);
    for (const x of plan.slice(0, 60)) report.push(`  ${x.supplier} ${x.asin} (${x.order_date}) canceled · every ${x.freq ?? "?"} wk · "${String(x.notes ?? "").replace(/\s+/g, " ").slice(0, 50)}"`);
    writes.push(async () => {
      for (const x of plan) await q(`INSERT INTO subscriptions (supplier, po_asin_id, asin, product_name, frequency_weeks, next_order_date, status, last_po_id, created_from, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sheet',$9)`,
        [x.supplier, x.po_asin_id, x.asin, x.asin_name, x.freq, x.next, x.status, x.po_id, x.notes]);
      console.log(`  subscriptions: ${plan.length} row(s) inserted`);
    });
  }

  // ── pack ──────────────────────────────────────────────────────────────────
  if (stages.has("pack")) {
    // Maria 2026-11-01 (review answer 3): blank Col AX/AY = no information,
    // never "individual". Before 2026-10-29 the intake defaulted a blank AX to
    // individual × 1 (and derived n-packs from the yield on pre-2026 rows);
    // those stored values are not data. Per sheet-imported ASIN row the
    // sheet's literal AX/AY wins: blank → NULL on the po_asins row (open and
    // closed), a value → that value. Then asins.sold_as / units_per_pack from
    // the rows that HAVE a value, newest first: all agree → set; disagree →
    // the "possible mismatch" list; no row with a value → the gaps list.
    const { byRow } = await sheetIndex();
    const rows = (await q(`SELECT pa.id, pa.asin, a.title, pa.sold_as, pa.units_per_pack, p.supplier, p.order_id, p.order_date, p.source
        FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id LEFT JOIN asins a ON a.asin = pa.asin
       WHERE p.source = 'sheet_import' ORDER BY ${NEWEST_PO_ORDER}`)).rows;
    const fixes: Array<{ id: string; sold_as: string | null; upp: number | null; kind: string }> = [];
    const packRows: PackRow[] = [];
    let noSheetRow = 0, same = 0;
    for (const r of rows) {
      const cells = byRow.get(`${r.supplier}\u0000${r.order_id}\u0000${String(r.asin).toUpperCase()}`)?.[0];
      const label = `${r.supplier} ${r.order_id} (${ymd(r.order_date)})`;
      if (!cells) { noSheetRow++; continue; }
      const pack = packFromSheetCells(cells[COL.soldAs], cells[COL.unitsPerPack]);
      packRows.push({ asin: String(r.asin).toUpperCase(), title: r.title ?? null, po: label, pack });
      const afUpp = r.units_per_pack == null ? null : Number(r.units_per_pack);
      if (!pack) {
        if (r.sold_as != null || afUpp != null) fixes.push({ id: r.id, sold_as: null, upp: null, kind: r.sold_as === "individual" && afUpp === 1 ? "default individual×1 → NULL" : `${r.sold_as}×${afUpp ?? "?"} (not from AX/AY) → NULL` });
        else same++;
      } else if (r.sold_as !== pack.sold_as || afUpp !== pack.units_per_pack) fixes.push({ id: r.id, sold_as: pack.sold_as, upp: pack.units_per_pack, kind: `${r.sold_as ?? "NULL"}×${afUpp ?? "?"} → sheet ${packKey(pack)}` });
      else same++;
    }
    const byKind: Record<string, number> = {}; for (const f of fixes) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    report.push(`pack rows: ${rows.length} sheet-imported ASIN row(s); ${same} already match the sheet's AX/AY, ${fixes.length} to fix (${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join("; ")}), ${noSheetRow} not found in the sheet (untouched)`);
    const plan = planAsinPack(packRows);
    const asinsNow = new Map((await q(`SELECT asin, ${has075 ? "sold_as, units_per_pack" : "NULL::text AS sold_as, NULL::int AS units_per_pack"} FROM asins`)).rows.map((x) => [String(x.asin), x]));
    const toSet = plan.set.filter((s) => asinsNow.has(s.asin) && asinsNow.get(s.asin)!.sold_as == null);
    const alreadySet = plan.set.filter((s) => asinsNow.has(s.asin) && asinsNow.get(s.asin)!.sold_as != null);
    const differs = alreadySet.filter((s) => { const c = asinsNow.get(s.asin)!; return c.sold_as !== s.sold_as || (c.units_per_pack == null ? null : Number(c.units_per_pack)) !== s.units_per_pack; });
    report.push(`pack asins: ${plan.set.length} ASIN(s) whose sheet rows agree (${toSet.length} to set, ${alreadySet.length} already set${differs.length ? ` — ${differs.length} set to a DIFFERENT value, left as they are` : ""}, ${plan.set.length - toSet.length - alreadySet.length} not in asins); ${plan.mismatches.length} possible mismatch(es); ${plan.noInfo.length} with no AX/AY on any row (${plan.noInfo.filter((g) => !asinsNow.has(g.asin)).length} not in asins)`);
    const f = path.join(outDir, `pack-size-gaps-${today}.csv`);
    fs.writeFileSync(f, csv([["asin", "title", "in_af_catalog", "po_rows_seen (all blank AX/AY)", "sold_as (fill in)", "units_per_pack (fill in)"], ...plan.noInfo.map((g) => [g.asin, g.title, asinsNow.has(g.asin) ? "yes" : "no", g.rows, "", ""])]));
    const f2 = path.join(outDir, `pack-size-mismatch-${today}.csv`);
    fs.writeFileSync(f2, csv([["asin", "title", "in_af_catalog", "sold_as×units", "po_rows (supplier order# (date), newest first)", "correct value (fill in)"],
      ...plan.mismatches.flatMap((g) => g.values.map((v) => [g.asin, g.title, asinsNow.has(g.asin) ? "yes" : "no", v.key, v.pos.join("; "), ""]))]));
    report.push(`  gaps → ${f} · possible mismatches → ${f2}`);
    writes.push(async () => {
      for (const x of fixes) await q(`UPDATE po_asins SET sold_as = $2, units_per_pack = $3 WHERE id = $1`, [x.id, x.sold_as, x.upp]);
      console.log(`  po_asins pack fields fixed on ${fixes.length} row(s) (sheet AX/AY literal; blank → NULL)`);
      for (const s of toSet) {
        await q(`UPDATE asins SET sold_as = $2, units_per_pack = $3 WHERE asin = $1 AND sold_as IS NULL`, [s.asin, s.sold_as, s.units_per_pack]);
        await q(`INSERT INTO asin_field_log (asin, field, old_value, new_value, source) VALUES ($1,'sold_as',NULL,$2,'backfill'), ($1,'units_per_pack',NULL,$3,'backfill')`, [s.asin, s.sold_as, s.units_per_pack == null ? null : String(s.units_per_pack)]);
      }
      console.log(`  asins pack fields set on ${toSet.length} ASIN(s)`);
    });
  }

  // ── sourcing ──────────────────────────────────────────────────────────────
  if (stages.has("sourcing")) {
    const { dataCells } = await sheetIndex();
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
  // Before / after counts of everything a live run writes (Maria 2026-11-01).
  const counts = async () => {
    const one = async (sql: string) => Number((await q(sql)).rows[0].n);
    return {
      purchased_by_user_id: await one(`SELECT COUNT(*)::int AS n FROM purchase_orders WHERE purchased_by_user_id IS NOT NULL`),
      po_payments: await one(`SELECT COUNT(*)::int AS n FROM po_payments`),
      po_line_refunds: await one(`SELECT COUNT(*)::int AS n FROM po_line_refunds`),
      subscriptions: await one(`SELECT COUNT(*)::int AS n FROM subscriptions`),
      po_asins_with_pack: await one(`SELECT COUNT(*)::int AS n FROM po_asins WHERE sold_as IS NOT NULL`),
      asins_with_pack: await one(`SELECT COUNT(*)::int AS n FROM asins WHERE sold_as IS NOT NULL`),
      po_asins_sourcing_cost: await one(`SELECT COUNT(*)::int AS n FROM po_asins WHERE sourcing_cost IS NOT NULL`),
      po_asins_paid_cost: await one(`SELECT COUNT(*)::int AS n FROM po_asins WHERE paid_cost IS NOT NULL`),
    };
  };
  const fmt = (c: Record<string, number>) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(" · ");
  if (LIVE) console.log(`\nBEFORE: ${fmt(await counts())}`);
  if (!LIVE) { console.log(`\nDry run — nothing written. Re-run with --live to apply.`); await c.end(); return; }
  await q("BEGIN");
  try { for (const w of writes) await w(); await q("COMMIT"); console.log("\nCOMMIT"); console.log(`AFTER:  ${fmt(await counts())}`); }
  catch (e) { await q("ROLLBACK").catch(() => {}); throw e; }
  finally { await c.end(); }
}
async function await_ok(p: Promise<pg.QueryResult>): Promise<boolean> { return ((await p).rowCount ?? 0) > 0; }

// An error after connect must still close the client, or the open socket
// keeps the process alive forever (the first --prod dry run, 2026-11-01).
let client: pg.Client | undefined;
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => client?.end().catch(() => {}));
