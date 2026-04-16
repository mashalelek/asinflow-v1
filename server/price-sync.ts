import { getPricing } from "./spapi";
import { query } from "./db";
import { log } from "./index";

export interface PriceRefreshProgress {
  current: number;
  total: number;
  asin: string;
}

export interface PriceRefreshResult {
  updated: number;
  failed: number;
  errors: string[];
}

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1000;

/**
 * Lightweight price-only refresh.
 *
 * For each active ASIN: calls SP-API pricing (getPricing) and updates
 * price columns + fetched_at in asin_estimates. Does NOT re-fetch catalog,
 * fees, or meltable/hazmat data. The client-side calculations (profit,
 * margin, ROI) will naturally reflect the refreshed price because they
 * are computed on the fly from the raw price/COGS/fees values.
 *
 * Processes in batches of 5 ASINs in parallel, with a 1s delay between
 * batches to avoid rate limiting.
 */
export async function refreshPrices(
  onProgress?: (p: PriceRefreshProgress) => void | Promise<void>,
): Promise<PriceRefreshResult> {
  const result = await query(
    `SELECT asin FROM asins WHERE is_active = TRUE ORDER BY asin`,
  );
  const asins: string[] = result.rows.map((r: any) => r.asin);

  log(`Price refresh starting for ${asins.length} active ASINs`, "price-sync");

  let updated = 0;
  let failed = 0;
  const errors: string[] = [];
  let processed = 0;

  for (let i = 0; i < asins.length; i += BATCH_SIZE) {
    const batch = asins.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (asin) => {
        processed++;
        const currentIndex = processed;
        if (onProgress) {
          try {
            await onProgress({ current: currentIndex, total: asins.length, asin });
          } catch {}
        }
        try {
          const pricingData = await getPricing(asin);
          await query(
            `UPDATE asin_estimates SET
               lowest_fba_price = $2,
               buy_box_price = $3,
               buy_box_fulfillment = $4,
               lowest_price = $5,
               sellers_fba = COALESCE($6, sellers_fba),
               sellers_fbm = COALESCE($7, sellers_fbm),
               fetched_at = NOW()
             WHERE asin = $1`,
            [
              asin,
              pricingData.lowestFbaPrice,
              pricingData.buyBoxPrice,
              pricingData.buyBoxFulfillment,
              pricingData.lowestPrice,
              pricingData.sellersFba,
              pricingData.sellersFbm,
            ],
          );
          updated++;
        } catch (err: any) {
          failed++;
          errors.push(`${asin}: ${err.message}`);
          log(`Price refresh failed for ${asin}: ${err.message}`, "price-sync");
        }
      }),
    );

    if (i + BATCH_SIZE < asins.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  log(
    `Price refresh complete: updated ${updated} ASINs, failed ${failed}`,
    "price-sync",
  );
  return { updated, failed, errors };
}
