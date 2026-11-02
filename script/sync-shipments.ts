// Sync Shipments from the shell — the same steps as POST
// /api/pos/sync-shipments: component A (Velocity) then component B (Seller
// Central), then the auto-close rule for every touched PO.
//
//   tsx script/sync-shipments.ts                         # dry run
//   tsx script/sync-shipments.ts --live
//   tsx script/sync-shipments.ts --live --show 126768935  # also print that PO's ASIN rows after
//   tsx script/sync-shipments.ts --prod --received-csv "Claude outputs/received-velocity-dry-run.csv"
//       # Received by Velocity (2026-11-02): per-PO counts of received_velocity changes on stdout, every row change to the CSV
//
// Needs DATABASE_URL, the Velocity key and the SP-API credentials.
import "./env";
import pool from "../server/db";
import { syncVelocityShipments } from "../server/shipment-sync-velocity";
import { syncScShipments } from "../server/shipment-sync-sc";
import { evaluateAutoClose } from "../server/po-close";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = !process.argv.includes("--live");
  const q = (sql: string, params?: any[]) => pool.query(sql, params);

  const a = await syncVelocityShipments({ dryRun });
  console.log(`A (Velocity) ${dryRun ? "DRY RUN" : "live"}: ${JSON.stringify(a.counts)}`);
  for (const s of a.packSamples) console.log(`  pack: ${s}`);
  // Received by Velocity backfill report: per-PO counts (set / cleared), closed POs marked.
  if (a.receivedVelocityOps.length > 0) {
    const poIds = Array.from(new Set(a.receivedVelocityOps.map((o) => o.poId)));
    const closed = new Map<string, boolean>((await q(`SELECT id, closed_at IS NOT NULL AS closed FROM purchase_orders WHERE id = ANY($1::uuid[])`, [poIds])).rows.map((r: any) => [String(r.id), !!r.closed]));
    const perPo = new Map<string, { orderId: string; supplier: string; closed: boolean; set: number; cleared: number }>();
    for (const o of a.receivedVelocityOps) {
      const e = perPo.get(o.poId) ?? { orderId: o.orderId, supplier: o.supplier, closed: closed.get(o.poId) ?? false, set: 0, cleared: 0 };
      if (o.to == null) e.cleared++; else e.set++;
      perPo.set(o.poId, e);
    }
    const rows = Array.from(perPo.values()).sort((x, y) => x.supplier.localeCompare(y.supplier) || x.orderId.localeCompare(y.orderId));
    const openPos = rows.filter((r) => !r.closed).length;
    console.log(`received_velocity ${dryRun ? "would change" : "changed"} on ${a.receivedVelocityOps.length} ASIN rows across ${rows.length} POs (${openPos} open, ${rows.length - openPos} closed): set ${a.counts.receivedVelocitySet}, cleared ${a.counts.receivedVelocityCleared}`);
    for (const r of rows) console.log(`  ${r.closed ? "closed" : "open  "} ${r.supplier} ${r.orderId}: set ${r.set}${r.cleared ? ` cleared ${r.cleared}` : ""}`);
    const csv = arg("received-csv");
    if (csv) {
      const { writeFileSync } = await import("fs");
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = ["po_status,supplier,order_id,asin,from,to", ...a.receivedVelocityOps.map((o) => [closed.get(o.poId) ? "closed" : "open", o.supplier, o.orderId, o.asin, o.from ?? "", o.to ?? ""].map(esc).join(","))];
      writeFileSync(csv, lines.join("\n") + "\n");
      console.log(`  wrote ${csv}`);
    }
  } else console.log("received_velocity: no changes");
  const b = await syncScShipments({ dryRun });
  console.log(`B (SC) ${dryRun ? "DRY RUN" : "live"}: ${JSON.stringify(b.counts)}`);

  if (!dryRun) {
    const touched = new Set<string>([...a.touchedPoIds, ...b.touchedPoIds]);
    const out = { evaluated: 0, closed: 0, reopened: 0 };
    for (const poId of Array.from(touched)) {
      const r = await evaluateAutoClose(poId, q as any);
      out.evaluated++; if (r.changed === "closed") out.closed++; else if (r.changed === "reopened") out.reopened++;
    }
    console.log(`auto-close: ${JSON.stringify(out)}`);
  }

  const show = arg("show");
  if (show) {
    const rows = (await q(
      `SELECT pa.asin, pa.sold_as, pa.units_per_pack, pa.velocity_units_per_pack, pa.qty, pa.qty_shipped_fba, pa.qty_received_amazon
         FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id WHERE p.order_id = $1 ORDER BY pa.asin`, [show],
    )).rows;
    console.table(rows);
  }
}

main()
  .catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; })
  .finally(() => pool.end());
