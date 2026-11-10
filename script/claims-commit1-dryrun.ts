// Claims commit 1 — the dry run (SPEC patch docs/claude_spec-patch-supplier-claims.md §9 commit 1; Maria 2026-11-09:
// "Build, one migration (101), but STOP after the dry run — nothing runs live until Maria reviews").
//
// In ONE transaction that is always ROLLED BACK: read the three net-quantity readers the OLD way on the database as it
// is (the frozen pre-migration readers, server/__fixtures__/claims-before-readers.ts), snapshot every quantity value,
// apply database/migrations/101_supplier_claims.sql — the very file the runner will apply at deploy — then read the
// NEW readers (the live modules) and compare. Nothing is written; the migration's effects live only inside the
// transaction. Read-only against production with --prod (script/env.ts; the URL is never printed).
//
//   npm run claims:dryrun -- [--prod] [--date 2026-11-09] [--from 1/1/2026] [--to M/D/YYYY] [--no-velocity]
//
// Output (docs/, date-stamped):
//   claims-d17-conversion-<date>.csv     every po_asins / po_line_items / shipment / refund / claim quantity before → after, with the pack and the outcome
//   claims-d17-bundle-rows-<date>.csv    the bundle ASIN rows and their component lines, separately (the bundle rule, never × N)
//   claims-d17-unconverted-<date>.csv    every row / line left in its old basis (pack not known, or a value that does not convert) with the reason
//   claims-proof-<date>.csv              On Order per ASIN, the auto-close verdict per PO and the Velocity plan key (create / update / skip) before and after — differences only
//   claims-conversions-<date>.csv        every claim the migration creates (PO, line, kind, qty in all three units, $ owed, status, outcome, task), grouped by source, "kind unclear" flagged
//   claims-needs-attention-<date>.csv    the open claims with an open task — what lands in Needs attention on day one
//   claims-commit1-dryrun-<date>.md      the report: counts, the proof's summary, what the live run will do
import "./env";
import { readFileSync, writeFileSync } from "fs";
import { Pool } from "pg";
import { csv } from "../server/po-model-backfill";
import { oldLoadAsinPipeline, oldAutoCloseVerdicts, oldLoadAfPoRows } from "../server/__fixtures__/claims-before-readers";
import { envReconStart, loadAsinPipeline } from "../server/asin-po-pipeline";
import { autoCloseVerdict, type PoCloseRow } from "../server/po-close";
import { PO_CLOSE_ACTION_ITEMS_SQL } from "../server/po-action-items";
import { OPEN_CLAIM_COUNT_PO_SQL } from "../server/supplier-claim-sql";
import { loadAfPoRows } from "../server/po-af-source";
import { comparePipelines, compareVerdicts, comparePlans, compareRows, planByKey, type Diff, type PlanLike } from "../server/claims-proof";
import { parseMDY, todayLocal } from "../server/velocity-export";
import type { SheetRow } from "../server/google-sheets";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const date = arg("--date") ?? new Date().toISOString().slice(0, 10);
const useVelocity = !process.argv.includes("--no-velocity") && !!process.env.VELOCITY_API_KEY && !!process.env.VELOCITY_WAREHOUSE_ID;
const out = (name: string) => `docs/claims-${name}-${date}`;
const r2 = (v: unknown) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const fmt = (v: unknown) => (v == null ? "" : typeof v === "number" ? String(r2(v)) : String(v));

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined, max: 1 });
  const client = await pool.connect();
  const q = (sql: string, params?: any[]) => client.query(sql, params);
  const report: string[] = [`# Claims commit 1 — dry run ${date}${/render\.com/.test(process.env.DATABASE_URL ?? "") ? " (production)" : " (local)"}`, ""];
  const log = (s: string) => { console.log(s); report.push(s); };
  await q("BEGIN");
  try {
    const applied = (await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'po_asins' AND column_name = 'qty_basis'`)).rowCount! > 0;
    if (applied) { console.error("migration 101 is already applied on this database — the dry run needs the pre-migration schema"); process.exit(3); }
    const sql = readFileSync("database/migrations/101_supplier_claims.sql", "utf8");

    // ── BEFORE ─────────────────────────────────────────────────────────────
    const start = envReconStart();
    const asinsBefore = (await q(`SELECT pa.*, p.order_id, p.supplier, p.closed_at IS NOT NULL AS closed FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id`)).rows as any[];
    const linesBefore = (await q(`SELECT l.*, p.order_id FROM po_line_items l JOIN purchase_orders p ON p.id = l.po_id`)).rows as any[];
    const shipsBefore = (await q(`SELECT s.id, s.po_asin_id, s.qty_shipped, s.qty_received, s.source FROM po_asin_shipments s`)).rows as any[];
    const refundsBefore = (await q(`SELECT r.id, r.po_id, r.po_line_item_id, r.qty, r.amount, r.status FROM po_line_refunds r`)).rows as any[];
    const defectsBefore = (await q(`SELECT d.* FROM po_line_defects d`)).rows as any[];
    const itemsBefore = (await q(`SELECT ai.item, (p.closed_at IS NOT NULL) AS po_closed, COUNT(*)::int AS n FROM po_line_action_items ai JOIN po_line_items l ON l.id = ai.po_line_item_id JOIN purchase_orders p ON p.id = l.po_id WHERE ai.cleared_at IS NULL AND ai.item IN ('Confirm refund / replacement', 'Missing / damaged from supplier') GROUP BY 1, 2`)).rows as any[];
    const lossBefore = (await q(`SELECT COUNT(*)::int AS rows, COALESCE(SUM(unreimbursed_loss_amount), 0)::float8 AS amt FROM po_asins WHERE COALESCE(unreimbursed_loss_qty, 0) > 0 OR COALESCE(unreimbursed_loss_amount, 0) > 0`)).rows[0];
    log(`Before: ${asinsBefore.length} ASIN rows, ${linesBefore.length} lines, ${shipsBefore.length} shipment rows, ${refundsBefore.length} refund rows (${refundsBefore.filter((r) => r.status === "due").length} due), ${defectsBefore.length} defect(s); open items: ${itemsBefore.map((i) => `${i.item} ${i.po_closed ? "closed" : "open"} PO ×${i.n}`).join(", ") || "none"}; sheet losses ${lossBefore.rows} rows $${r2(lossBefore.amt)}`);
    const oldPipe = await oldLoadAsinPipeline(q as any, start);
    const oldClose = await oldAutoCloseVerdicts(q as any);
    const oldRows = await oldLoadAfPoRows(q as any);
    const from = parseMDY(arg("--from") ?? "1/1/2026")!, to = arg("--to") ? parseMDY(arg("--to")!)! : todayLocal();
    let oldPlan: PlanLike | null = null, newPlan: PlanLike | null = null;
    const { buildVelocityPlan } = await import("../server/velocity-reconcile");
    if (useVelocity) { log(`Velocity plan ${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}: fetching Velocity (read-only) for the BEFORE plan…`); oldPlan = (await buildVelocityPlan(from, to, { query: q as any, loadRows: async () => oldRows })) as any; }
    else log("Velocity plan: skipped (no VELOCITY_API_KEY / --no-velocity) — the plan's input rows are compared instead");

    // ── APPLY (inside the transaction) ─────────────────────────────────────
    const t0 = Date.now();
    await q(sql);
    log(`Migration 101 applied inside the transaction in ${Date.now() - t0} ms (rolled back at the end).`);

    // ── AFTER ──────────────────────────────────────────────────────────────
    const asinsAfter = new Map<string, any>(((await q(`SELECT pa.*, e.ordered_asin, e.ordered_individual, e.expected_asin, e.expected_individual, e.canceled_asin, e.returned_asin, e.open_claims FROM po_asins pa JOIN po_asin_expected e ON e.id = pa.id`)).rows as any[]).map((r) => [String(r.id), r]));
    const linesAfter = new Map<string, any>(((await q(`SELECT l.*, le.ordered_product, le.ordered_individual, le.ordered_asin, le.canceled_individual, le.returned_individual, le.expected_individual, le.expected_product FROM po_line_items l JOIN po_line_expected le ON le.line_id = l.id`)).rows as any[]).map((r) => [String(r.id), r]));
    const shipsAfter = new Map<string, any>(((await q(`SELECT id, qty_shipped, qty_received FROM po_asin_shipments`)).rows as any[]).map((r) => [String(r.id), r]));
    const refundsAfter = new Map<string, any>(((await q(`SELECT id, qty, amount FROM po_line_refunds`)).rows as any[]).map((r) => [String(r.id), r]));
    const newPipe = await loadAsinPipeline(q as any);
    const closeRows = (await q(`SELECT pa.po_id, e.expected_asin AS qty_expected_asin, e.lost_damaged_us_asin AS qty_lost_damaged_us, e.shipped_fba_asin AS qty_shipped_fba FROM po_asins pa JOIN po_asin_expected e ON e.id = pa.id`)).rows as Array<PoCloseRow & { po_id: string }>;
    const byPo = new Map<string, PoCloseRow[]>(); for (const r of closeRows) { const k = String(r.po_id); if (!byPo.has(k)) byPo.set(k, []); byPo.get(k)!.push(r); }
    const closeItems = (await q(`SELECT p.id, ${PO_CLOSE_ACTION_ITEMS_SQL} AS items, ${OPEN_CLAIM_COUNT_PO_SQL("p")} AS open_claims FROM purchase_orders p`)).rows as any[];
    const newClose = new Map(closeItems.map((p) => [String(p.id), { verdict: autoCloseVerdict(byPo.get(String(p.id)) ?? [], p.items ?? [], Number(p.open_claims ?? 0)), items: p.items ?? [], open_claims: Number(p.open_claims ?? 0) }]));
    const newRows = (await loadAfPoRows(q as any)).rows;
    if (useVelocity) { log("Fetching Velocity again for the AFTER plan…"); newPlan = (await buildVelocityPlan(from, to, { query: q as any, loadRows: async () => newRows })) as any; }
    const claims = (await q(
      `SELECT c.*, k.source, k.flags, k.old_value, p.order_id, p.supplier, p.closed_at IS NOT NULL AS po_closed, pa.asin, l.product_name, l.position, l.qty_basis AS line_basis,
              l.retailer_units_per_product AS product_pack, COALESCE(pa.units_per_pack, l.asin_units_per_pack) AS asin_pack, pa.sold_as,
              (SELECT string_agg(t.kind, ', ' ORDER BY t.id) FROM supplier_claim_tasks t WHERE t.claim_id = c.id AND t.done_at IS NULL) AS open_tasks,
              (SELECT COALESCE(SUM(COALESCE(x.amount_applied, r.amount)), 0) FROM supplier_claim_refunds x JOIN po_line_refunds r ON r.id = x.po_line_refund_id WHERE x.claim_id = c.id)::float8 AS applied
         FROM supplier_claims c LEFT JOIN supplier_claim_conversions k ON k.claim_id = c.id AND k.source <> 'defect' OR (k.claim_id = c.id AND k.source = 'defect' AND NOT EXISTS (SELECT 1 FROM supplier_claim_conversions k2 WHERE k2.claim_id = c.id AND k2.source <> 'defect'))
         JOIN purchase_orders p ON p.id = c.po_id LEFT JOIN po_line_items l ON l.id = c.po_line_item_id LEFT JOIN po_asins pa ON pa.id = l.po_asin_id
        ORDER BY k.source, p.order_date DESC, c.id`)).rows as any[];
    const basisCounts = (await q(`SELECT 'asin rows' AS t, qty_basis, COUNT(*)::int AS n FROM po_asins GROUP BY 1, 2 UNION ALL SELECT 'lines', qty_basis, COUNT(*)::int FROM po_line_items GROUP BY 1, 2 ORDER BY 1, 2`)).rows as any[];

    // ── D17 CSVs ───────────────────────────────────────────────────────────
    const rowCols = ["qty", "qty_shipped_supplier", "qty_at_prep", "qty_at_warehouse", "qty_lost_damaged_us", "qty_shipped_fba", "qty_received_amazon", "received_velocity", "unreimbursed_loss_qty", "extra_units_cleared_shipped"];
    const conv: unknown[][] = [["table", "order_id", "supplier", "asin", "line_position", "product", "sold_as", "pack", "bundle", "column", "before", "after", "basis_after", "outcome", "note"]];
    const bundleRows: unknown[][] = [["order_id", "supplier", "asin", "bundle_N", "kind", "line_position", "product", "product_pack", "units_per_bundle", "column", "before", "after", "view_asin_units", "view_individual"]];
    const unconverted: unknown[][] = [["table", "order_id", "supplier", "asin", "line_position", "product", "column", "value", "reason"]];
    let convRows = 0, legacyRows = 0, convLines = 0, legacyLines = 0, nonIntRows = 0, nonIntLines = 0;
    for (const b of asinsBefore) {
      const a = asinsAfter.get(String(b.id)); const legacy = a.qty_basis !== "individual"; const bundle = b.sold_as === "bundle";
      if (legacy) legacyRows++; else convRows++;
      const packKnown = b.sold_as != null && b.units_per_pack != null;
      if (legacy && packKnown) nonIntRows++;
      for (const c of rowCols) {
        if (b[c] == null) continue;
        const outcome = legacy ? (packKnown ? "left as stored (a value does not convert)" : "left as stored (pack not known)") : "× pack";
        conv.push(["po_asins", b.order_id, b.supplier, b.asin, "", "", b.sold_as ?? "", b.units_per_pack ?? "", bundle ? "yes" : "", c, fmt(b[c]), fmt(a[c]), a.qty_basis, outcome, bundle && !legacy ? `bundle: ASIN units × N (${b.units_per_pack})` : ""]);
        if (bundle) bundleRows.push([b.order_id, b.supplier, b.asin, b.units_per_pack, "bundle row", "", "", "", "", c, fmt(b[c]), fmt(a[c]), fmt(a.ordered_asin), fmt(a.ordered_individual)]);
        if (legacy) unconverted.push(["po_asins", b.order_id, b.supplier, b.asin, "", "", c, fmt(b[c]), packKnown ? `× ${b.units_per_pack} is not a whole number (within 0.05)` : "pack size not known (sold_as NULL)"]);
      }
      // the row's shipments
      for (const s of shipsBefore.filter((s) => String(s.po_asin_id) === String(b.id))) {
        const sa = shipsAfter.get(String(s.id));
        for (const c of ["qty_shipped", "qty_received"]) { if (s[c] == null) continue; conv.push(["po_asin_shipments", b.order_id, b.supplier, b.asin, "", s.source, b.sold_as ?? "", b.units_per_pack ?? "", bundle ? "yes" : "", c, fmt(s[c]), fmt(sa?.[c]), a.qty_basis, legacy ? "left as stored" : "× pack", ""]); }
      }
    }
    const asinOf = new Map(asinsBefore.map((r) => [String(r.id), r]));
    for (const b of linesBefore) {
      const a = linesAfter.get(String(b.id)); const pa = asinOf.get(String(b.po_asin_id)); const legacy = a.qty_basis !== "individual"; const bundle = pa?.sold_as === "bundle";
      if (legacy) legacyLines++; else convLines++;
      if (legacy && b.retailer_units_per_product != null) nonIntLines++;
      for (const c of ["qty_ordered", "qty_received", "qty_canceled", "qty_returned"]) {
        if (b[c] == null) continue;
        const after = c === "qty_canceled" ? a.canceled_individual : c === "qty_returned" ? a.returned_individual : a[c];
        const outcome = c === "qty_canceled" || c === "qty_returned" ? (legacy ? "→ closed claim (Product units, pack not known)" : "→ closed claim × pack") : legacy ? (b.retailer_units_per_product != null ? "left as stored (a value does not convert)" : "left as stored (pack not known)") : "× pack";
        conv.push(["po_line_items", b.order_id, pa?.supplier ?? "", pa?.asin ?? "", b.position, String(b.product_name ?? "").slice(0, 60), pa?.sold_as ?? "", b.retailer_units_per_product ?? "", bundle ? "component" : "", c, fmt(b[c]), fmt(after), a.qty_basis, outcome, bundle && !legacy ? `component: × its own pack ${b.retailer_units_per_product}, units per bundle ${b.units_per_bundle ?? "proposed"} — never × N` : ""]);
        if (bundle) bundleRows.push([b.order_id, pa?.supplier ?? "", pa?.asin ?? "", pa?.units_per_pack ?? "", "component line", b.position, String(b.product_name ?? "").slice(0, 60), b.retailer_units_per_product ?? "", b.units_per_bundle ?? "proposed", c, fmt(b[c]), fmt(after), fmt(a.ordered_asin), fmt(a.ordered_individual)]);
        if (legacy) unconverted.push(["po_line_items", b.order_id, pa?.supplier ?? "", pa?.asin ?? "", b.position, String(b.product_name ?? "").slice(0, 60), c, fmt(b[c]), b.retailer_units_per_product != null ? `× ${b.retailer_units_per_product} is not a whole number (within 0.05)` : "Product pack not known (retailer_units_per_product NULL)"]);
      }
    }
    for (const r of refundsBefore) {
      if (r.qty == null && r.status !== "due") continue;
      const ra = refundsAfter.get(String(r.id)); const l = r.po_line_item_id ? linesBefore.find((x) => String(x.id) === String(r.po_line_item_id)) : null; const pa = l ? asinOf.get(String(l.po_asin_id)) : null;
      conv.push(["po_line_refunds", pa?.order_id ?? "", pa?.supplier ?? "", pa?.asin ?? "", l?.position ?? "", String(l?.product_name ?? "").slice(0, 60), pa?.sold_as ?? "", l?.retailer_units_per_product ?? "", "", r.status === "due" ? "status due" : "qty", r.status === "due" ? `$${fmt(r.amount)}` : fmt(r.qty), r.status === "due" ? (ra ? "kept?" : "removed → claim amount_owed") : fmt(ra?.qty), linesAfter.get(String(r.po_line_item_id))?.qty_basis ?? "", r.status === "due" ? "due row → the claim's $ owed" : "× the line's pack", ""]);
    }
    for (const d of defectsBefore) {
      const l = linesBefore.find((x) => String(x.id) === String(d.po_line_item_id)); const pa = l ? asinOf.get(String(l.po_asin_id)) : null; const c = claims.find((x) => String(x.id) === String(d.id));
      conv.push(["po_line_defects → supplier_claims", pa?.order_id ?? "", pa?.supplier ?? "", pa?.asin ?? "", l?.position ?? "", String(l?.product_name ?? "").slice(0, 60), pa?.sold_as ?? "", l?.retailer_units_per_product ?? "", "", "qty", fmt(d.qty), fmt(c?.qty), linesAfter.get(String(d.po_line_item_id))?.qty_basis ?? "", "× the line's pack", `amount ${fmt(d.amount)} → ${fmt(c?.amount_owed)}`]);
    }
    writeFileSync(out("d17-conversion") + ".csv", csv(conv));
    writeFileSync(out("d17-bundle-rows") + ".csv", csv(bundleRows));
    writeFileSync(out("d17-unconverted") + ".csv", csv(unconverted));
    log(`D17: ASIN rows ${convRows} converted / ${legacyRows} left in ASIN units (${nonIntRows} with a known pack but a value that does not convert); lines ${convLines} converted / ${legacyLines} left in Product units (${nonIntLines} with a known pack); basis after: ${basisCounts.map((b) => `${b.t} ${b.qty_basis} ${b.n}`).join(", ")}; ${bundleRows.length - 1} bundle values listed separately.`);

    // ── proof ──────────────────────────────────────────────────────────────
    const pipeDiffs = comparePipelines(oldPipe as any, newPipe as any);
    const verdictDiffs = compareVerdicts(oldClose, newClose);
    const rowDiffs = compareRows(oldRows as any, newRows as any);
    const planDiffs = oldPlan && newPlan ? comparePlans(oldPlan, newPlan) : [];
    const proof: unknown[][] = [["reader", "key", "field", "before", "after", "context"]];
    const ctxPo = (id: string) => { const b = oldClose.get(id), a = newClose.get(id); const row = asinsBefore.find((r) => String(r.po_id) === id); return `${row?.supplier ?? ""} ${row?.order_id ?? id}: items before [${b?.items.join(", ") ?? ""}] after [${a?.items.join(", ") ?? ""}] open claims ${a?.open_claims ?? 0}`; };
    for (const d of pipeDiffs) proof.push(["on_order", d.key, d.field, d.before, d.after, ""]);
    for (const d of verdictDiffs) proof.push(["auto_close", d.key, d.field, d.before, d.after, ctxPo(d.key)]);
    for (const d of rowDiffs) proof.push(["velocity_rows", d.key, d.field, d.before, d.after, ""]);
    for (const d of planDiffs) proof.push(["velocity_plan", d.key, d.field, d.before, d.after, ""]);
    writeFileSync(out("proof") + ".csv", csv(proof));
    const openBefore = [...oldClose.values()].filter((v) => v.verdict).length, openAfter = [...newClose.values()].filter((v) => v.verdict).length;
    log(`Proof: On Order per ASIN — ${oldPipe.size} ASINs, ${pipeDiffs.length} difference(s); auto-close verdict per PO — ${oldClose.size} POs (${openBefore} would be closed before, ${openAfter} after), ${verdictDiffs.length} difference(s); the plan's input rows — ${oldRows.length} before / ${newRows.length} after, ${rowDiffs.length} difference(s)${oldPlan && newPlan ? `; Velocity plan — before: ${oldPlan.creates.length} create, ${oldPlan.bundleCreates.length} bundle create, ${oldPlan.updates.length} update, ${oldPlan.unchanged} unchanged, ${oldPlan.closedInVelocity} closed, ${oldPlan.skips.length} skip, ${oldPlan.homeCreates.length} home; after: ${newPlan.creates.length} / ${newPlan.bundleCreates.length} / ${newPlan.updates.length} / ${newPlan.unchanged} / ${newPlan.closedInVelocity} / ${newPlan.skips.length} / ${newPlan.homeCreates.length}; ${planDiffs.length} difference(s) over ${planByKey(oldPlan).size} keys` : ""}.`);
    for (const d of [...pipeDiffs, ...verdictDiffs, ...rowDiffs, ...planDiffs].slice(0, 40)) log(`  Δ ${d.key} ${d.field}: ${d.before} → ${d.after}`);

    // ── conversions ────────────────────────────────────────────────────────
    const units = (c: any) => {
      const legacy = c.line_basis === "product_legacy"; const ind = legacy ? null : Number(c.qty); const prod = legacy ? Number(c.qty) : c.product_pack ? Number(c.qty) / Number(c.product_pack) : null; const asin = legacy ? null : c.asin_pack ? Number(c.qty) / Number(c.asin_pack) : null;
      return [fmt(ind), fmt(prod), fmt(asin)];
    };
    const convCsv: unknown[][] = [["source", "order_id", "supplier", "po_closed", "asin", "line_position", "product", "kind", "kind_unclear", "qty_individual", "qty_product", "qty_asin", "amount_owed", "amount_source", "refund_applied", "status", "outcome", "open_tasks", "found_at", "flags", "note"]];
    for (const c of claims) {
      const [ind, prod, asin] = units(c);
      convCsv.push([c.source ?? "(existing)", c.order_id, c.supplier, c.po_closed ? "closed" : "open", c.asin ?? "(whole PO)", c.position ?? "", String(c.product_name ?? "").slice(0, 60), c.kind, (c.flags ?? []).includes("kind_unclear") ? "yes" : "", ind, prod, asin, fmt(c.amount_owed), c.amount_owed_source, fmt(c.applied), c.status, c.outcome ?? "", c.open_tasks ?? "", String(c.found_at).slice(0, 10), (c.flags ?? []).join(" "), String(c.note ?? "").slice(0, 160)]);
    }
    writeFileSync(out("conversions") + ".csv", csv(convCsv));
    const bySource = new Map<string, { n: number; open: number; owed: number }>();
    for (const c of claims) { const k = c.source ?? "(existing)"; const v = bySource.get(k) ?? { n: 0, open: 0, owed: 0 }; v.n++; if (c.status === "open") v.open++; v.owed += Number(c.amount_owed ?? 0); bySource.set(k, v); }
    log(`Conversions: ${claims.length} claim(s) — ${[...bySource.entries()].map(([k, v]) => `${k}: ${v.n} (${v.open} open, $${r2(v.owed)} owed)`).join("; ")}; kind unclear on ${claims.filter((c) => (c.flags ?? []).includes("kind_unclear")).length}, qty assumed = ordered on ${claims.filter((c) => (c.flags ?? []).includes("qty_assumed_ordered")).length}, legacy units on ${claims.filter((c) => (c.flags ?? []).includes("legacy_units")).length}.`);
    const attention = claims.filter((c) => c.status === "open" && c.open_tasks);
    const attCsv: unknown[][] = [["order_id", "supplier", "asin", "line_position", "product", "kind", "qty_individual", "amount_owed", "outcome", "open_tasks", "source", "flags", "note"]];
    for (const c of attention) attCsv.push([c.order_id, c.supplier, c.asin ?? "(whole PO)", c.position ?? "", String(c.product_name ?? "").slice(0, 60), c.kind, units(c)[0], fmt(c.amount_owed), c.outcome ?? "", c.open_tasks, c.source ?? "", (c.flags ?? []).join(" "), String(c.note ?? "").slice(0, 160)]);
    writeFileSync(out("needs-attention") + ".csv", csv(attCsv));
    log(`Needs attention on day one: ${attention.length} open claim(s) with an open task (${attention.filter((c) => c.open_tasks?.includes("refund_received")).length} refund_received, ${attention.filter((c) => c.open_tasks?.includes("contact_supplier")).length} contact_supplier).`);
    const dropped = (await q(`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'po_line_items' AND column_name IN ('qty_canceled', 'qty_returned', 'final_qty')`)).rows[0].n;
    const refundStatus = (await q(`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'po_line_refunds' AND column_name = 'status'`)).rows[0].n;
    log(`After the migration: po_line_items.qty_canceled / qty_returned / final_qty present: ${dropped}; po_line_refunds.status present: ${refundStatus}; tables: ${(await q(`SELECT string_agg(table_name, ', ' ORDER BY table_name) AS t FROM information_schema.tables WHERE table_name IN ('supplier_claims', 'supplier_claim_tasks', 'supplier_claim_events', 'supplier_claim_refunds', 'supplier_claim_conversions', 'po_warning_dismissals')`)).rows[0].t}.`);
    report.push("", "Files: " + ["d17-conversion", "d17-bundle-rows", "d17-unconverted", "proof", "conversions", "needs-attention"].map((n) => out(n) + ".csv").join(", "), "", "ROLLED BACK — nothing written. The live run is the deploy of migration 101 (the runner applies this same file).");
    writeFileSync(out("commit1-dryrun") + ".md", report.join("\n") + "\n");
    console.log(`report: ${out("commit1-dryrun")}.md`);
  } finally {
    await q("ROLLBACK").catch(() => {});
    console.log("ROLLBACK — nothing written.");
    client.release(); await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
