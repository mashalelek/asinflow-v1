import { getPricing, type AsinPricingResult } from "./spapi";
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
  skipped: number;
  errors: string[];
}

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

function hasAnyPrice(data: AsinPricingResult): boolean {
  return (
    data.lowestFbaPrice != null ||
    data.buyBoxPrice != null ||
    data.lowestPrice != null
  );
}

/**
 * Attempt to fetch pricing for a single ASIN with exponential backoff
 * on 429 / transient errors. Returns null if all retries are exhausted.
 */
async function fetchPricingWithRetry(
  asin: string,
): Promise<AsinPricingResult | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await getPricing(asin);
      // getPricing never throws on API errors — it catches internally and
      // returns all-null fields. Treat "all prices null" as a soft failure
      // so we can retry.
      if (hasAnyPrice(data)) return data;

      // If the response was explicitly marked restricted, don't retry.
      if ((data as any)._restricted) {
        log(`Price refresh: ${asin} is restricted — skipping`, "price-sync");
        return null;
      }

      // All nulls but not restricted — might be a transient issue.
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        log(
          `Price refresh: no prices for ${asin} on attempt ${attempt + 1}, retrying in ${delay}ms`,
          "price-sync",
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (err: any) {
      // getPricing already catches internally, but guard against unexpected throws.
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        log(
          `Price refresh error for ${asin} (attempt ${attempt + 1}): ${err.message} — retrying in ${delay}ms`,
          "price-sync",
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        log(
          `Price refresh: exhausted retries for ${asin}: ${err.message}`,
          "price-sync",
        );
        return null;
      }
    }
  }
  return null;
}

/**
 * Lightweight price-only refresh.
 *
 * For each active ASIN: calls SP-API getItemOffers (via getPricing) and
 * updates price columns + fetched_at in asin_estimates. Does NOT re-fetch
 * catalog, fees, or meltable/hazmat data. Client-side profit calculations
 * will automatically reflect the refreshed prices.
 *
 * Key safeguards:
 *  - Uses COALESCE so a NULL API response never overwrites an existing price.
 *  - Skips the DB write entirely if the API returned no usable prices.
 *  - Retries with exponential backoff (2s → 4s → 8s) on empty responses.
 *  - After the main pass, does a gap-fill pass for any ASINs that failed.
 *  - Processes in batches of 5 with 1.5s delay to stay within SP-API rate limits.
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
  let skipped = 0;
  const failedAsins: string[] = [];
  const errors: string[] = [];
  let processed = 0;

  async function processAsin(asin: string): Promise<boolean> {
    const pricingData = await fetchPricingWithRetry(asin);

    if (!pricingData || !hasAnyPrice(pricingData)) {
      return false;
    }

    // COALESCE on every field: never overwrite a good value with NULL.
    await query(
      `UPDATE asin_estimates SET
         lowest_fba_price = COALESCE($2, lowest_fba_price),
         buy_box_price = COALESCE($3, buy_box_price),
         buy_box_fulfillment = COALESCE($4, buy_box_fulfillment),
         lowest_price = COALESCE($5, lowest_price),
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
    return true;
  }

  // ── Main pass ──────────────────────────────────────────────────────
  for (let i = 0; i < asins.length; i += BATCH_SIZE) {
    const batch = asins.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (asin) => {
        processed++;
        if (onProgress) {
          try {
            await onProgress({
              current: processed,
              total: asins.length,
              asin,
            });
          } catch {}
        }
        try {
          const ok = await processAsin(asin);
          if (ok) {
            updated++;
          } else {
            failedAsins.push(asin);
          }
        } catch (err: any) {
          failedAsins.push(asin);
          errors.push(`${asin}: ${err.message}`);
          log(`Price refresh error for ${asin}: ${err.message}`, "price-sync");
        }
      }),
    );

    if (i + BATCH_SIZE < asins.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // ── Gap-fill pass ──────────────────────────────────────────────────
  if (failedAsins.length > 0) {
    log(
      `Price refresh gap-fill: retrying ${failedAsins.length} failed ASINs`,
      "price-sync",
    );
    // Wait a bit before the gap-fill to let rate limits cool down.
    await new Promise((r) => setTimeout(r, 5000));

    const stillFailed: string[] = [];
    for (let i = 0; i < failedAsins.length; i += BATCH_SIZE) {
      const batch = failedAsins.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (asin) => {
          if (onProgress) {
            try {
              await onProgress({
                current: asins.length,
                total: asins.length,
                asin: `Gap-fill: ${asin}`,
              });
            } catch {}
          }
          try {
            const ok = await processAsin(asin);
            if (ok) {
              updated++;
            } else {
              stillFailed.push(asin);
            }
          } catch (err: any) {
            stillFailed.push(asin);
          }
        }),
      );
      if (i + BATCH_SIZE < failedAsins.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    skipped = stillFailed.length;
    if (stillFailed.length > 0) {
      log(
        `Price refresh: ${stillFailed.length} ASINs still without pricing after gap-fill: ${stillFailed.slice(0, 20).join(", ")}${stillFailed.length > 20 ? "..." : ""}`,
        "price-sync",
      );
    }
  }

  log(
    `Price refresh complete: ${updated} updated, ${failedAsins.length - skipped} recovered in gap-fill, ${skipped} still missing`,
    "price-sync",
  );
  return { updated, failed: skipped, skipped, errors };
}
