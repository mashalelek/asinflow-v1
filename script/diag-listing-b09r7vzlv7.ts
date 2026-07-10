// DIAGNOSTIC ONLY — read-only. Probes the SC state for B09R7VZLV7 / its SKU.
import "dotenv/config";
import { spApiGet } from "../server/spapi-auth";

const MKT = "ATVPDKIKX0DER";
const SKU = "SPR-HEA-LV7-FFB-003";
const ASIN = "B09R7VZLV7";
const sellerId = process.env.SP_API_SELLER_ID!;

async function main() {
  console.log(`sellerId=${sellerId ? "set" : "MISSING"}\n`);

  // 1. getListingsItem for the SKU — does it exist? status? ISSUES?
  console.log(`===== 1. getListingsItem  ${SKU}  (summaries,issues,attributes,offers,fulfillmentAvailability) =====`);
  try {
    const d = await spApiGet(`/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(SKU)}`, {
      marketplaceIds: MKT,
      includedData: "summaries,issues,attributes,offers,fulfillmentAvailability",
    });
    console.log("summaries:", JSON.stringify(d?.summaries, null, 2));
    console.log("ISSUES:", JSON.stringify(d?.issues, null, 2));
    console.log("offers:", JSON.stringify(d?.offers, null, 2));
    console.log("fulfillmentAvailability:", JSON.stringify(d?.fulfillmentAvailability, null, 2));
    console.log("attributes keys:", d?.attributes ? Object.keys(d.attributes).join(", ") : "(none)");
  } catch (e: any) {
    console.log("HTTP", e?.response?.status, "->", JSON.stringify(e?.response?.data ?? e?.message));
  }

  // 2. searchListingsItemsByAsin — the RAW presence-check response
  console.log(`\n===== 2. GET /listings/2021-08-01/items/${sellerId}?identifiers=${ASIN}&identifiersType=ASIN (summaries) =====`);
  try {
    const d = await spApiGet(`/listings/2021-08-01/items/${sellerId}`, {
      marketplaceIds: MKT, identifiers: ASIN, identifiersType: "ASIN", includedData: "summaries",
    });
    console.log("numberOfResults:", d?.numberOfResults);
    console.log("RAW items:", JSON.stringify(d?.items, null, 2));
    // Replay the presence-check mapping exactly (sku-listing-search.ts)
    const items: any[] = d?.items ?? [];
    console.log("\n-- presence-check mapping replay --");
    console.log("present:", items.length > 0);
    for (const it of items) {
      console.log(`  sku field raw = ${JSON.stringify(it?.sku)}  → mapped String(sku ?? '') = ${JSON.stringify(String(it?.sku ?? ""))}`);
      console.log(`  summaries[0].status = ${JSON.stringify(it?.summaries?.[0]?.status ?? [])}`);
    }
  } catch (e: any) {
    console.log("HTTP", e?.response?.status, "->", JSON.stringify(e?.response?.data ?? e?.message));
  }
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
