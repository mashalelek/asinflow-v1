// Full SC state for B00CA6Z37C. Pull every includedData field so we can see
// summaries.status AND issues AND offers AND fulfillmentAvailability —
// reconcile DISCOVERABLE vs CLOSED ambiguity.

import "dotenv/config";
import { spApiGet } from "../server/spapi-auth";

const SELLER_ID = process.env.SP_API_SELLER_ID!;
const ASIN = "B00CA6Z37C";
const KNOWN_SKU = "AMG-BP-CLN-RRC-002-C";

async function main() {
  console.log(`\n=== Full getListingsItem for ${KNOWN_SKU} (ASIN ${ASIN}) ===\n`);
  const data: any = await spApiGet(
    `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(KNOWN_SKU)}`,
    {
      marketplaceIds: "ATVPDKIKX0DER",
      // ALL availabe includedData fields
      includedData: "summaries,attributes,issues,offers,fulfillmentAvailability,procurement,relationships",
    },
  );
  console.log(JSON.stringify(data, null, 2));

  console.log(`\n=== searchListingsItems by ASIN ${ASIN} (any SKU for this seller+ASIN) ===\n`);
  const search: any = await spApiGet(
    `/listings/2021-08-01/items/${SELLER_ID}`,
    {
      marketplaceIds: "ATVPDKIKX0DER",
      identifiers: ASIN,
      identifiersType: "ASIN",
      includedData: "summaries,offers,fulfillmentAvailability",
    },
  );
  console.log(JSON.stringify(search, null, 2));

  console.log(`\n=== FBA inventory for SKU ${KNOWN_SKU} (separate API) ===\n`);
  try {
    const inv: any = await spApiGet(
      `/fba/inventory/v1/summaries`,
      {
        granularityType: "Marketplace",
        granularityId: "ATVPDKIKX0DER",
        marketplaceIds: "ATVPDKIKX0DER",
        sellerSkus: KNOWN_SKU,
        details: "true",
      },
    );
    console.log(JSON.stringify(inv, null, 2));
  } catch (err: any) {
    console.log(`inventory error: ${err?.response?.status ?? "?"} ${err?.message}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
