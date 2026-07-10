// STEP 3 acceptance test — DRY RUN ONLY (dryRun=true → no putListingsItem, no
// DB writes). Runs the real offer-add preview for the 3 grocery ASINs that
// originally failed with invalid_attribute (blanket consumer_commodity from the
// wrong is_hazmat=true). Post-fix they must classify Ready (preview) with the
// DG attribute LIVE-derived to not_applicable.
import "dotenv/config";
import { offerAddForAsin } from "../server/offer-add";
import { query } from "../server/db";

const ASINS = [
  { asin: "B07YX5971R", label: "Morton Salt Substitute" },
  { asin: "B0756KB8N1", label: "Keystone Canned Chicken" },
  { asin: "B0FTKHZ8H8", label: "Kinder's BBQ Sauce" },
];

(async () => {
  const sellerId = process.env.SP_API_SELLER_ID!;
  console.log(`Offer-add PREVIEW (dry run) — sellerId=${sellerId ? "set" : "MISSING"}\n`);

  for (const { asin, label } of ASINS) {
    console.log(`===== ${asin}  ${label} =====`);
    try {
      const result = await offerAddForAsin(
        { asin, productNumber: 1, price: 19.99 },
        { queryFn: query, sellerId },
        true, // dryRun — preview only, never submits
      );
      const ready = result.kind === "preview";
      console.log(`  classification: ${result.kind}${ready ? "  → READY" : "  (not ready)"}`);
      if (result.kind === "preview") {
        const dg = result.payload?.attributes?.supplier_declared_dg_hz_regulation?.[0]?.value;
        console.log(`  sku:                                    ${result.sku}`);
        console.log(`  payload.supplier_declared_dg_hz_regulation = ${JSON.stringify(dg)}`);
        console.log(`  → DG attribute: ${dg === "not_applicable" ? "not_applicable ✓ (expected)" : `*** ${dg} — UNEXPECTED ***`}`);
      } else {
        console.log(`  details: ${JSON.stringify((result as any).details ?? (result as any).reason ?? result)}`);
      }
    } catch (err: any) {
      console.log(`  ERROR: ${err?.message ?? err}`);
    }
    console.log();
  }
  process.exit(0);
})().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
