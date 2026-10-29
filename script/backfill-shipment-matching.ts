// One-time PO-matching backfill (patch docs/claude_spec-patch-po-matching.md
// §5, amended 2026-10-29).
//
//   npm run backfill:shipment-matching                       # dry run: alias seeds + every link it would make
//   npm run backfill:shipment-matching -- --live             # write the seeds, then Sync Shipments live
//   ... --skip-alias "Monin" --alias "Webstraunt Store=webstaurantstore.com"   # adjust the seeds Maria reviewed
//
// Dry run: proposes supplier_aliases seeds for every Velocity retailer string
// that is not an AF supplier, runs shipment sync A as a dry run WITH those
// seeds in memory, and reports every line a rule past the legacy keys would
// place (rule, PO, date delta, units) and every line left in the panel with
// its candidates or nearest miss. CSV in "Claude outputs/".
//
// --live: inserts the seeds (source 'seed'), then runs component A, B, A again
// (so pack size and At Prep see the new links), and auto-close for the POs
// touched. Needs DATABASE_URL, the Velocity key and the SP-API credentials.
import "dotenv/config";
import { writeFileSync } from "fs";
import { join } from "path";
import pool from "../server/db";
import { syncVelocityShipments, type VelocitySyncResult } from "../server/shipment-sync-velocity";
import { syncScShipments } from "../server/shipment-sync-sc";
import { evaluateAutoClose } from "../server/po-close";
import { loadAliases, proposeAlias, resolveRetailer, setAlias, aliasKey, type AliasProposal } from "../server/supplier-aliases";

const argsOf = (name: string): string[] => process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []));

/** §2 kind of a Velocity order #. */
export function kindOf(orderNumber: string): string {
  const n = orderNumber.trim();
  if (n === "") return "no order #";
  if (/^INSH-/i.test(n)) return "INSH";
  if (/[_-]\d{1,2}$/.test(n) && !/^INSH/i.test(n)) return "_N suffix";
  if (/[\s#:]/.test(n)) return "free text";
  return "order #";
}

const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
  const live = process.argv.includes("--live");
  const q = (sql: string, params?: any[]) => pool.query(sql, params);

  // ── alias seeds ──────────────────────────────────────────────────────────
  const suppliers = (await q(`SELECT DISTINCT supplier FROM purchase_orders`)).rows.map((r: any) => String(r.supplier));
  const existing = await loadAliases(q as any);
  const retailers = (await q(
    `SELECT DISTINCT btrim(r) AS r FROM (
        SELECT o->>'retailer' AS r FROM velocity_shipments v, jsonb_array_elements(v.raw->'detail'->'orders') o
        UNION ALL SELECT line->>'retailer' FROM shipment_unmatched) x
      WHERE btrim(COALESCE(r, '')) <> ''`,
  )).rows.map((r: any) => String(r.r));
  const skip = new Set(argsOf("skip-alias").map(aliasKey));
  const forced = new Map(argsOf("alias").map((a) => { const i = a.indexOf("="); return [aliasKey(a.slice(0, i)), a.slice(i + 1).trim()] as [string, string]; }));
  const proposals: Array<AliasProposal & { note?: string }> = [];
  for (const r of retailers.sort((a, b) => a.localeCompare(b))) {
    if (resolveRetailer(r, existing, suppliers).kind === "supplier") continue; // already an AF supplier, or already mapped
    const k = aliasKey(r);
    if (forced.has(k)) { proposals.push({ retailer: r, supplier: forced.get(k)!, rule: null, note: "given with --alias" }); continue; }
    const p = proposeAlias(r, suppliers);
    proposals.push(skip.has(k) ? { ...p, supplier: null, note: "skipped with --skip-alias" } : p);
  }
  for (const [k, sup] of Array.from(forced.entries())) if (!proposals.some((p) => aliasKey(p.retailer) === k)) proposals.push({ retailer: k, supplier: sup, rule: null, note: "given with --alias" });
  const seeds = new Map(proposals.filter((p) => p.supplier).map((p) => [aliasKey(p.retailer), p.supplier!]));

  console.log(`\n== Proposed supplier_aliases seeds (${seeds.size} of ${proposals.length} unmapped retailer strings) ==`);
  for (const p of proposals) console.log(`  ${JSON.stringify(p.retailer).padEnd(42)} → ${p.supplier ?? "(no proposal)"}${p.rule ? `  [${p.rule}]` : ""}${p.note ? `  [${p.note}]` : ""}`);

  const openBefore = (await q(`SELECT reason, count(*)::int AS n FROM shipment_unmatched WHERE resolved_at IS NULL GROUP BY reason ORDER BY reason`)).rows;
  console.log(`\nUnmatched shipments panel now: ${openBefore.map((r: any) => `${r.n} ${r.reason}`).join(", ") || "0"}`);

  if (!live) {
    const a = await syncVelocityShipments({ dryRun: true, extraAliases: seeds });
    report(a);
    console.log(`\nDry run — nothing written. Re-run with --live (plus any --skip-alias / --alias) after review.`);
    return;
  }

  // ── live ─────────────────────────────────────────────────────────────────
  for (const [alias, supplier] of Array.from(seeds.entries())) await setAlias(q as any, alias, supplier, "seed");
  console.log(`\n${seeds.size} alias seed(s) written.`);
  const a = await syncVelocityShipments({ dryRun: false });
  report(a);
  const b = await syncScShipments({ dryRun: false });
  console.log(`B (SC) live: ${JSON.stringify(b.counts)}`);
  const a2 = await syncVelocityShipments({ dryRun: false });
  console.log(`A again (pack size / At Prep for the new links): ${JSON.stringify({ rowsInserted: a2.counts.rowsInserted, rowsUpdated: a2.counts.rowsUpdated, atPrepSet: a2.counts.atPrepSet, packFilled: a2.counts.packFilled, unmatchedNew: a2.counts.unmatchedNew })}`);
  const touched = new Set<string>([...a.touchedPoIds, ...b.touchedPoIds, ...a2.touchedPoIds]);
  const out = { evaluated: 0, closed: 0, reopened: 0 };
  for (const poId of Array.from(touched)) { const r = await evaluateAutoClose(poId, q as any); out.evaluated++; if (r.changed === "closed") out.closed++; else if (r.changed === "reopened") out.reopened++; }
  console.log(`auto-close: ${JSON.stringify(out)}`);
  const openAfter = (await q(`SELECT reason, count(*)::int AS n FROM shipment_unmatched WHERE resolved_at IS NULL GROUP BY reason ORDER BY reason`)).rows;
  console.log(`Unmatched shipments panel after: ${openAfter.map((r: any) => `${r.n} ${r.reason}`).join(", ") || "0"}`);
}

function report(a: VelocitySyncResult) {
  const c = a.counts;
  console.log(`\nA (Velocity) ${a.dryRun ? "DRY RUN" : "live"}: ${JSON.stringify(c)}`);
  const links = a.ruleLinks;
  const byRule = new Map<string, number>(); for (const l of links) byRule.set(l.how, (byRule.get(l.how) ?? 0) + 1);
  const newLinks = links.filter((l) => l.wasUnmatched || l.how === "candidate" || l.how === "base_id");
  console.log(`\n== Auto-link list: ${links.length} line(s) placed by a rule past the legacy keys (${Array.from(byRule.entries()).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}); ${newLinks.length} of them leave the panel or are new links ==`);
  console.log(`  ${"rule".padEnd(10)} ${"Velocity order #".padEnd(30)} ${"retailer".padEnd(18)} ${"ASIN".padEnd(11)} ${"units".padStart(5)}  → ${"PO".padEnd(22)} ${"supplier".padEnd(24)} PO date     V date      Δd`);
  for (const l of [...links].sort((x, y) => x.how.localeCompare(y.how) || x.poOrderId.localeCompare(y.poOrderId))) {
    console.log(`  ${l.how.padEnd(10)} ${(l.orderNumber || "(none)").slice(0, 30).padEnd(30)} ${(l.retailer || "—").slice(0, 18).padEnd(18)} ${l.asin.padEnd(11)} ${String(l.units).padStart(5)}  → ${l.poOrderId.slice(0, 22).padEnd(22)} ${l.supplier.slice(0, 24).padEnd(24)} ${l.poDate}  ${l.vDate ?? "?".padEnd(10)}  ${l.days ?? "?"}`);
  }
  console.log(`\n== Left in the panel: ${a.unmatched.length} line(s) ==`);
  for (const u of a.unmatched) {
    const why = u.candidates?.length ? `${u.candidates.length} candidates: ${u.candidates.map((x) => `${x.order_id}${x.days != null ? ` (${x.days >= 0 ? "+" : ""}${x.days}d, ${x.remaining_units} left)` : " (Col P)"}`).join("; ")}` : u.miss ?? u.note ?? u.reason;
    console.log(`  ${(u.orderNumber || "(none)").slice(0, 30).padEnd(30)} ${(u.retailer || "—").slice(0, 18).padEnd(18)} ${u.asin.padEnd(11)} ${String(u.units).padStart(4)}u  ${why}`);
  }
  const rows: string[] = ["outcome,rule,kind,velocity_order_number,retailer,asin,units,velocity_date,po_order_id,supplier,po_date,days,candidates,nearest_miss,velocity_shipment,velocity_order_id"];
  for (const l of links) rows.push([l.wasUnmatched || l.how === "candidate" || l.how === "base_id" ? "linked (leaves panel)" : "linked", l.how, kindOf(l.orderNumber), l.orderNumber, l.retailer, l.asin, l.units, l.vDate, l.poOrderId, l.supplier, l.poDate, l.days, "", "", l.shipment, l.orderId].map(csvCell).join(","));
  for (const u of a.unmatched) rows.push(["panel", u.candidates?.length ? "ambiguous" : "no_po", kindOf(u.orderNumber), u.orderNumber, u.retailer, u.asin, u.units, u.vDate, "", "", "", "", (u.candidates ?? []).map((x) => `${x.order_id}${x.days != null ? `(${x.days}d)` : "(Col P)"}`).join(" | "), u.miss ?? "", u.shipment, u.orderId].map(csvCell).join(","));
  const file = join(process.cwd(), "Claude outputs", `shipment-matching-${a.dryRun ? "dry-run" : "live"}-${new Date().toISOString().slice(0, 10)}.csv`);
  writeFileSync(file, rows.join("\n") + "\n");
  console.log(`\nCSV: ${file}`);
}

main()
  .catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; })
  .finally(() => pool.end());
