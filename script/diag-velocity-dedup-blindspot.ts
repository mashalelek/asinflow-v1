// DIAGNOSTIC ONLY — read-only Velocity API probes. Near-miss 2026-08-07:
// two 8/2 orders already in Velocity (129059664 / B01AWK114G fully checked
// in; 100878 / B0001Y7K68 checked in + shipped FBA) classified as CREATE in
// the upload dialog. Hypothesis: GET /inbound stops returning orders whose
// status moved past "inbound", so the dedup match set silently excludes
// completed orders.
//
// Step 1: full unfiltered pagination — are the two order numbers in the raw
// response at all? Also collect the complete status vocabulary observed.
import "dotenv/config";
import { fetchAllInboundOrders } from "../server/velocity-api";

const TARGETS = ["129059664", "100878"];

async function main() {
  const all = await fetchAllInboundOrders();
  console.log(`fetchAllInboundOrders (no filters): ${all.length} orders`);

  // Raw-text grep across the full serialized payload (catches the numbers in
  // ANY field, not just order_number).
  const raw = JSON.stringify(all);
  for (const t of TARGETS) {
    console.log(`raw contains "${t}": ${raw.includes(t)}`);
  }

  // Exact order_number matches
  for (const t of TARGETS) {
    const hits = all.filter((o) => String(o.order_number ?? "").trim() === t);
    console.log(`order_number === "${t}": ${hits.length} hit(s)`);
    for (const h of hits) {
      console.log(`   → order_id=${h.order_id} asin=${h.asin} status=${h.status} date=${h.date} qty=${h.quantity}`);
    }
  }

  // Status vocabulary
  const statusCounts = new Map<string, number>();
  for (const o of all) {
    const s = String(o.status ?? "(null)");
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }
  console.log("status vocabulary (unfiltered GET /inbound):");
  for (const [s, n] of statusCounts) console.log(`   ${s}: ${n}`);

  // Also dump the target ASINs' rows if present under a different order number
  for (const asin of ["B01AWK114G", "B0001Y7K68"]) {
    const hits = all.filter((o) => String(o.asin ?? "").toUpperCase() === asin);
    console.log(`asin ${asin}: ${hits.length} row(s): ${hits.map((h) => `${h.order_number}/${h.status}`).join(", ") || "-"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
