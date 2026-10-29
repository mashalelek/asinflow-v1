// Sync Shipments from the shell — the same steps as POST
// /api/pos/sync-shipments: component A (Velocity) then component B (Seller
// Central), then the auto-close rule for every touched PO.
//
//   tsx script/sync-shipments.ts                         # dry run
//   tsx script/sync-shipments.ts --live
//   tsx script/sync-shipments.ts --live --show 126768935  # also print that PO's ASIN rows after
//
// Needs DATABASE_URL, the Velocity key and the SP-API credentials.
import "dotenv/config";
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
