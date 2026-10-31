// Update COGS in SC → Sourcing cost (col AR) switch: the production dry run
// Maria asked for before the switch is pushed (patch po-ai-prefill §7.1,
// amendment 4, 2026-10-31). Read-only. For every ASIN the export would
// submit for the window (purchased in range, cogs_source = po_sheet, a
// usable cost): the cost before the switch (actual_cogs = col Y) vs after
// (the newest non-canceled PO row's sourcing_cost = col AR), the count whose
// submitted cost changes, and the min / median / max delta. The per-ASIN
// list goes to docs/sourcing-cost-switch-<date>.csv.
//
//   npx tsx script/sourcing-cost-switch-dryrun.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out <dir>]
// Default window: Jan 1 of this year … today. Needs DATABASE_URL.
import "dotenv/config";
import fs from "fs";
import path from "path";
import pg from "pg";
import { loadAfPoRows } from "../server/po-af-source";
import { parseMDY } from "../server/velocity-export";
import { csv } from "../server/po-model-backfill";
import { NEWEST_PO_ORDER } from "../server/po-entry-seq";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const today = new Date();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromArg = arg("--from") ?? `${today.getFullYear()}-01-01`, toArg = arg("--to") ?? ymd(today);
const local = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

async function main() {
  const url = process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL not set");
  const c = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
  await c.connect();
  const q = (sql: string, params?: any[]) => c.query(sql, params);
  const host = (() => { try { return new URL(url).host || "local"; } catch { return "?"; } })();
  const lo = local(fromArg).getTime(), hi = local(toArg).getTime();
  const { rows } = await loadAfPoRows(q as any);
  const purchased = new Set<string>();
  for (const r of rows) {
    if ((r.status ?? "").toLowerCase().includes("canceled")) continue;
    const dt = parseMDY(r.orderDate); if (!dt) continue;
    const t = dt.getTime(); if (t < lo || t > hi) continue;
    purchased.add(r.asin.trim().toUpperCase());
  }
  const asins = Array.from(purchased);
  const cost = (await q(
    `SELECT a.asin, e.actual_cogs::float AS actual_cogs, e.cogs_source,
            (SELECT pa.sourcing_cost::float FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
              WHERE pa.asin = a.asin
                AND NOT COALESCE((SELECT bool_and(l.qty_canceled IS NOT NULL AND l.qty_canceled >= COALESCE(l.qty_ordered, 0)) FROM po_line_items l WHERE l.po_asin_id = pa.id), false)
              ORDER BY ${NEWEST_PO_ORDER} LIMIT 1) AS sourcing_cost,
            (SELECT p.supplier || ' ' || p.order_id FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE pa.asin = a.asin ORDER BY ${NEWEST_PO_ORDER} LIMIT 1) AS newest_po
       FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin WHERE a.asin = ANY($1::text[])`, [asins])).rows;
  const out: Array<{ asin: string; before: number; after: number; delta: number; basis: string; po: string }> = [];
  let notPoSourced = 0, badCost = 0, noSourcing = 0;
  for (const r of cost) {
    if (r.cogs_source !== "po_sheet") { notPoSourced++; continue; }
    const before = Number(r.actual_cogs);
    const after = r.sourcing_cost != null && r.sourcing_cost > 0 ? Number(r.sourcing_cost) : before;
    if (!(before > 0) && !(after > 0)) { badCost++; continue; }
    if (r.sourcing_cost == null) noSourcing++;
    out.push({ asin: r.asin, before: Math.round(before * 100) / 100, after: Math.round(after * 100) / 100, delta: Math.round((after - before) * 100) / 100, basis: r.sourcing_cost == null ? "actual_cogs (no AR)" : "sourcing_cost", po: r.newest_po ?? "" });
  }
  const changed = out.filter((x) => Math.abs(x.delta) >= 0.005).sort((a, b) => b.delta - a.delta);
  const deltas = changed.map((x) => x.delta).sort((a, b) => a - b);
  const median = deltas.length ? (deltas.length % 2 ? deltas[(deltas.length - 1) / 2] : (deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2) : 0;
  const pctOf = (x: typeof changed[number]) => (x.before > 0 ? Math.round((x.delta / x.before) * 1000) / 10 : null);
  console.log(`Update COGS in SC switch dry run against ${host} · window ${fromArg} … ${toArg}`);
  console.log(`  ASINs purchased in the window: ${asins.length}; po_sheet-sourced with a cost: ${out.length} (not po_sheet ${notPoSourced}, no usable cost ${badCost}, newest row has no AR yet → unchanged ${noSourcing})`);
  console.log(`  submitted cost CHANGES on ${changed.length} ASIN(s): delta min ${deltas[0] ?? 0} · median ${median} · max ${deltas[deltas.length - 1] ?? 0} (after − before, $ per unit); unchanged ${out.length - changed.length}`);
  for (const x of changed.slice(0, 15)) console.log(`    ${x.asin}  ${x.before} → ${x.after}  (+${x.delta}, ${pctOf(x)}%)  ${x.po}`);
  const outDir = arg("--out") ?? "docs";
  const f = path.join(outDir, `sourcing-cost-switch-${ymd(today)}.csv`);
  fs.writeFileSync(f, csv([["asin", "cost_before (actual_cogs, col Y)", "cost_after (sourcing_cost, col AR)", "delta", "delta_pct", "basis", "newest_po"],
    ...out.sort((a, b) => b.delta - a.delta).map((x) => [x.asin, x.before.toFixed(2), x.after.toFixed(2), x.delta.toFixed(2), pctOf(x) ?? "", x.basis, x.po])]));
  console.log(`  list → ${f}`);
  await c.end();
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; });
