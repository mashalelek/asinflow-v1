// DIAGNOSTIC ONLY — read-only. Part B of the dedup-blind-spot investigation:
// GET /inbound (unfiltered) returned 51 orders, all status "inbound", and
// neither target order. Docs say the lifecycle continues into /inventory
// (checked-in stock, carries order_number + order_id + asin) and /shipments
// (outbound). Probe both for the two escaped orders + collect the full
// status vocabulary; also probe /inbound for an undocumented statuses param.
import "dotenv/config";

const BASE_URL = "https://api.velocityprepservices.com/api/v1";
const key = process.env.VELOCITY_API_KEY!;
const warehouseId = process.env.VELOCITY_WAREHOUSE_ID!;
const TARGETS = ["129059664", "100878"];

async function vget(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `ApiKey ${key}`, "X-Warehouse-Id": warehouseId },
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { http: res.status, body };
}

function vocab(rows: any[], field = "status"): string {
  const m = new Map<string, number>();
  for (const r of rows) m.set(String(r?.[field] ?? "(null)"), (m.get(String(r?.[field] ?? "(null)")) ?? 0) + 1);
  return [...m.entries()].map(([s, n]) => `${s}:${n}`).join("  ") || "(none)";
}

async function main() {
  // ── /inventory ────────────────────────────────────────────────────────────
  const inv = await vget("/inventory?limit=-1");
  const invOrders: any[] = inv.body?.data?.orders ?? inv.body?.data ?? [];
  console.log(`\nGET /inventory?limit=-1 → HTTP ${inv.http}, status=${inv.body?.status}, rows=${invOrders.length}`);
  console.log(`  status vocabulary: ${vocab(invOrders)}`);
  const invRaw = JSON.stringify(inv.body);
  for (const t of TARGETS) {
    console.log(`  raw contains "${t}": ${invRaw.includes(t)}`);
    const hits = invOrders.filter((o) => String(o.order_number ?? "").trim() === t);
    for (const h of hits) console.log(`   → order_number=${h.order_number} order_id=${h.order_id} asin=${h.asin} status=${h.status ?? "(no status field)"} qty=${h.quantity}`);
  }

  // ── /shipments (list, all statuses) ──────────────────────────────────────
  const shp = await vget("/shipments?limit=-1");
  const shpRows: any[] = shp.body?.data?.shipments ?? shp.body?.data?.orders ?? shp.body?.data ?? [];
  console.log(`\nGET /shipments?limit=-1 → HTTP ${shp.http}, status=${shp.body?.status}, rows=${shpRows.length}`);
  console.log(`  status vocabulary: ${vocab(shpRows)}`);
  const shpRaw = JSON.stringify(shp.body);
  for (const t of TARGETS) console.log(`  raw contains "${t}": ${shpRaw.includes(t)}`);

  // Detail-probe each shipment for order-level rows (docs: detail carries orders[])
  for (const s of shpRows) {
    const sid = s.shipment_id ?? s.id;
    if (!sid) continue;
    const det = await vget(`/shipments/${encodeURIComponent(sid)}`);
    const orders: any[] = det.body?.data?.orders ?? [];
    const raw = JSON.stringify(det.body);
    const hits = TARGETS.filter((t) => raw.includes(t));
    console.log(`  shipment ${sid} [${s.status}] orders=${orders.length}${hits.length ? `  *** contains ${hits.join(", ")}` : ""}`);
    if (hits.length) {
      for (const o of orders) {
        if (TARGETS.includes(String(o.order_number ?? "").trim()) || ["B01AWK114G", "B0001Y7K68"].includes(String(o.asin ?? "").toUpperCase())) {
          console.log(`     → order_number=${o.order_number ?? "(absent)"} order_id=${o.order_id} asin=${o.asin} qty_shipped=${o.quantity_shipped}`);
        }
      }
    }
  }

  // ── /inbound undocumented status params (read-only probes) ───────────────
  for (const probe of [
    "/inbound?limit=5&statuses[]=fully_received",
    "/inbound?limit=5&status=fully_received",
    "/inbound?limit=5&statuses[]=inbound&statuses[]=fully_received&statuses[]=outbound&statuses[]=inventory&statuses[]=partially_received",
  ]) {
    const r = await vget(probe);
    const rows: any[] = r.body?.data?.orders ?? [];
    console.log(`\nGET ${probe}\n  → HTTP ${r.http}, status=${r.body?.status}, rows=${rows.length}, total=${r.body?.data?.results?.total_results}, vocab: ${vocab(rows)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
