// DIAGNOSTIC ONLY — read-only. Step 1a of the 2026-10-29 relist task:
// getListingsItem state for the 7 SKUs deleted by listing hygiene that Maria
// wants relisted under their original SKU names. Records 404 / exists-open /
// exists-closed per SKU. No writes anywhere.
import "dotenv/config";
import { spApiGet } from "../server/spapi-auth";

const MKT = "ATVPDKIKX0DER";
const sellerId = process.env.SP_API_SELLER_ID!;

const TARGETS: { asin: string; sku: string; note: string }[] = [
  { asin: "B0FKRQPWD1", sku: "QM-UL2V-D9HN",        note: "hazmat; Velocity: Fully Shipped" },
  { asin: "B000C1VZHO", sku: "LI-AEF5-3HYO",        note: "hazmat; Velocity: 4/5 received" },
  { asin: "B08WX3XDLQ", sku: "NUL-BOO-DLQ-WGP-001", note: "Velocity: Fully Shipped" },
  { asin: "B0FNT869TZ", sku: "HB-BHNQ-3CI5",        note: "hazmat; Velocity: Fully Shipped" },
  { asin: "B0FKRY6GMB", sku: "AX-DB16-LN8Z",        note: "hazmat; Velocity: Fully Shipped" },
  { asin: "B003D7KI72", sku: "5A-2XO0-XKKC",        note: "Velocity: Fully Shipped" },
  { asin: "B01MYDX2DI", sku: "21-ZOZI-Q1QC",        note: "multi-pack 2u; Velocity: 6/30 received" },
];

async function main() {
  for (const { asin, sku, note } of TARGETS) {
    console.log(`\n===== ${asin}  ${sku}  (${note}) =====`);
    try {
      const d = await spApiGet(`/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`, {
        marketplaceIds: MKT, includedData: "summaries,attributes,fulfillmentAvailability",
      });
      const summaries = d?.summaries ?? [];
      const status = summaries[0]?.status ?? [];
      const fnSku = summaries[0]?.fnSku ?? null;
      const createdDate = summaries[0]?.createdDate ?? null;
      const po = (d?.attributes?.purchasable_offer ?? []).find((o: any) => o.marketplace_id === MKT) ?? d?.attributes?.purchasable_offer?.[0];
      const endAt = po?.end_at?.value ?? po?.end_at ?? null;
      const fa = d?.fulfillmentAvailability ?? [];
      if (summaries.length === 0) {
        console.log(`  verdict: SKU SHELL (200, summaries: []) — not a listing (A1)`);
      } else {
        const buyable = status.includes("BUYABLE");
        console.log(`  verdict: EXISTS — status ${JSON.stringify(status)} ${buyable ? "(open/buyable)" : ""}`);
      }
      console.log(`  fnSku: ${fnSku} | createdDate: ${createdDate}`);
      console.log(`  purchasable_offer.end_at: ${JSON.stringify(endAt)}`);
      console.log(`  fulfillmentAvailability: ${JSON.stringify(fa)}`);
    } catch (e: any) {
      const st = e?.response?.status ?? e?.status;
      if (st === 404) console.log(`  verdict: 404 — deleted/absent (relistable)`);
      else console.log(`  verdict: HTTP ${st ?? "?"} — ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
