// One-off diagnostic: verify duplicate-detection for B00CA6Z37C.
// Maria has a live offer on this ASIN in SC, but the preview shows "Generating SKU".
// Suspected cause: resurrection's candidate filter rejects both existing SKUs
// (PFL_* prep-center, AMG-BP-... legacy format) so no live status check runs.
//
// This script:
//   1. Lists ALL asin_skus rows for the ASIN
//   2. Runs matchesCurrentSkuFormat against each
//   3. Hits checkSkuListingStatus against each (live SP-API)
//   4. Reports whether SC actually has each SKU
//
// Read-only. No DB writes. No PUT calls.

import "dotenv/config";
import { query } from "../server/db";
import { checkSkuListingStatus } from "../server/sku-listing-fetch";
import { matchesCurrentSkuFormat } from "../shared/sku-classifier";

const SELLER_ID = process.env.SP_API_SELLER_ID;
const ASIN = "B00CA6Z37C";
if (!SELLER_ID) { console.error("SP_API_SELLER_ID not set"); process.exit(1); }

async function main() {
  console.log(`\n=== Diagnostic for ${ASIN} ===\n`);

  const skus = await query(
    `SELECT s.sku, s.is_primary, s.created_at
       FROM asin_skus s JOIN asins a ON a.id = s.asin_id
      WHERE a.asin = $1
      ORDER BY s.created_at DESC`,
    [ASIN],
  );

  if (skus.rowCount === 0) {
    console.log("No asin_skus rows found.");
    return;
  }

  for (const r of skus.rows) {
    const matches = matchesCurrentSkuFormat(r.sku);
    console.log(`SKU: ${r.sku}`);
    console.log(`  is_primary: ${r.is_primary}`);
    console.log(`  created_at: ${r.created_at}`);
    console.log(`  matchesCurrentSkuFormat: ${matches} ${matches ? "← candidate" : "← REJECTED by resurrection filter"}`);

    // Hit live SC regardless of filter — we want to know if it's THERE.
    process.stdout.write(`  Live status (getListingsItem): `);
    const status = await checkSkuListingStatus(SELLER_ID!, r.sku);
    if (status.ok && status.present) {
      console.log(`PRESENT in SC, statuses=${JSON.stringify(status.statuses)}`);
    } else if (status.ok && !status.present) {
      console.log("404 — NOT present in SC");
    } else {
      console.log(`ERROR — ${status.message} (status ${(status as any).status})`);
    }
    console.log();
  }

  // Run resurrection's actual candidate-selection logic on these rows
  const candidate = skus.rows.find((r: any) => matchesCurrentSkuFormat(r.sku));
  console.log("─".repeat(60));
  console.log(`Resurrection candidate-selection result: ${candidate ? `picks "${candidate.sku}"` : "NO CANDIDATE → falls through to generate-new path"}`);
  console.log("─".repeat(60));

  // For comparison: ask SC directly "what SKUs do you have for this ASIN?"
  // searchListingsItems lets us cross-check from the other direction.
  console.log("\n=== Cross-check via searchListingsItems (what does SC actually have?) ===");
  try {
    const { spApiGet } = await import("../server/spapi-auth");
    const data: any = await spApiGet(
      `/listings/2021-08-01/items/${SELLER_ID}`,
      {
        marketplaceIds: "ATVPDKIKX0DER",
        identifiers: ASIN,
        identifiersType: "ASIN",
        includedData: "summaries",
      },
    );
    const items = data?.items ?? [];
    if (items.length === 0) {
      console.log(`No SC listings found for ASIN ${ASIN} via searchListingsItems.`);
    } else {
      for (const item of items) {
        const sku = item?.sku ?? "?";
        const statuses = item?.summaries?.[0]?.status ?? [];
        console.log(`  SC has SKU: ${sku}  statuses=${JSON.stringify(statuses)}`);
      }
    }
  } catch (err: any) {
    console.log(`  searchListingsItems error: ${err?.response?.status ?? "?"} ${err?.message}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
