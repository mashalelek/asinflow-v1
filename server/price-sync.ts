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
  retried: number;
  recovered: number;
  errors: string[];
}

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

// Targeted retry pass: slower, smaller batches
const TARGETED_BATCH_SIZE = 3;
const TARGETED_BATCH_DELAY_MS = 3000;

function hasAnyPrice(data: AsinPricingResult): boolean {
  return (
    data.lowestFbaPrice != null ||
    data.buyBoxPrice != null ||
    data.lowestPrice != null
  );
}

/**
 * Attempt to fetch pricing for a single ASIN with exponential backoff.
 * Always returns the best response we got (even if prices are null) so
 * the caller can inspect `numberOfSellers` to distinguish "API returned
 * offers but parsing failed" from "API call failed entirely".
 */
async function fetchPricingWithRetry(
  asin: string,
): Promise<{ data: AsinPricingResult; offersReported: boolean } | null> {
  let bestResponse: AsinPricingResult | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await getPricing(asin);
      // Keep track of the best response (prefer one with prices, else with offer counts)
      if (!bestResponse || hasAnyPrice(data) || (data.numberOfSellers ?? 0) > (bestResponse.numberOfSellers ?? 0)) {
        bestResponse = data;
      }

      if (hasAnyPrice(data)) {
        return { data, offersReported: (data.numberOfSellers ?? 0) > 0 };
      }

      if ((data as any)._restricted) {
        log(`Price refresh: ${asin} is restricted — skipping`, "price-sync");
        return bestResponse
          ? { data: bestResponse, offersReported: false }
          : null;
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        log(
          `Price refresh: no prices for ${asin} on attempt ${attempt + 1} (offers=${data.numberOfSellers ?? "?"}), retrying in ${delay}ms`,
          "price-sync",
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (err: any) {
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
      }
    }
  }

  if (bestResponse) {
    const offersReported = (bestResponse.numberOfSellers ?? 0) > 0;
    return { data: bestResponse, offersReported };
  }
  return null;
}

async function writePrice(asin: string, data: AsinPricingResult): Promise<void> {
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
      data.lowestFbaPrice,
      data.buyBoxPrice,
      data.buyBoxFulfillment,
      data.lowestPrice,
      data.sellersFba,
      data.sellersFbm,
    ],
  );
}

/**
 * Lightweight price-only refresh with three-pass retry strategy.
 *
 * Pass 1 (main): batches of 5, 1.5s delay
 * Pass 2 (gap-fill): retry all failures, same cadence, 5s cooldown first
 * Pass 3 (targeted): retry only ASINs where the API confirmed offers exist
 *         but our parsing produced no prices — batches of 3, 3s delay
 *
 * COALESCE protects existing good values from being overwritten with NULL.
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
  const failedAsins: string[] = [];
  // ASINs where the API reported offers exist but we got no prices
  const offersButNoPrices = new Set<string>();
  const errors: string[] = [];
  let processed = 0;

  /**
   * Process a single ASIN. Returns true if prices were written.
   * Populates offersButNoPrices when the API says offers exist but
   * parsing returned no prices.
   */
  async function processAsin(asin: string): Promise<boolean> {
    const result = await fetchPricingWithRetry(asin);

    if (!result) return false;

    const { data, offersReported } = result;

    if (hasAnyPrice(data)) {
      await writePrice(asin, data);
      offersButNoPrices.delete(asin); // recovered
      return true;
    }

    // API returned offer counts but we got no parsed prices
    if (offersReported) {
      offersButNoPrices.add(asin);
      log(
        `${asin}: API returned ${data.numberOfSellers} offers but parsing produced no prices — flagged for retry`,
        "price-sync",
      );
    }

    return false;
  }

  // ── Pass 1: Main ──────────────────────────────────────────────────
  for (let i = 0; i < asins.length; i += BATCH_SIZE) {
    const batch = asins.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (asin) => {
        processed++;
        if (onProgress) {
          try {
            await onProgress({ current: processed, total: asins.length, asin });
          } catch {}
        }
        try {
          if (await processAsin(asin)) {
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

  // ── Pass 2: Gap-fill (all failures) ───────────────────────────────
  let gapFillRecovered = 0;
  if (failedAsins.length > 0) {
    log(
      `Price refresh gap-fill: retrying ${failedAsins.length} failed ASINs`,
      "price-sync",
    );
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
            if (await processAsin(asin)) {
              updated++;
              gapFillRecovered++;
            } else {
              stillFailed.push(asin);
            }
          } catch {
            stillFailed.push(asin);
          }
        }),
      );
      if (i + BATCH_SIZE < failedAsins.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    if (stillFailed.length > 0) {
      log(
        `Gap-fill: ${stillFailed.length} ASINs still failed, ${gapFillRecovered} recovered`,
        "price-sync",
      );
    }
  }

  // ── Pass 3: Targeted retry (offers exist but no prices) ───────────
  let targetedRetried = 0;
  let targetedRecovered = 0;

  if (offersButNoPrices.size > 0) {
    const targetList = Array.from(offersButNoPrices);
    targetedRetried = targetList.length;
    log(
      `Targeted retry: ${targetList.length} ASINs had offers but no prices — retrying with slower cadence`,
      "price-sync",
    );
    await new Promise((r) => setTimeout(r, 8000)); // longer cooldown

    const stillMissing: string[] = [];
    for (let i = 0; i < targetList.length; i += TARGETED_BATCH_SIZE) {
      const batch = targetList.slice(i, i + TARGETED_BATCH_SIZE);
      await Promise.all(
        batch.map(async (asin) => {
          if (onProgress) {
            try {
              await onProgress({
                current: asins.length,
                total: asins.length,
                asin: `Targeted retry: ${asin}`,
              });
            } catch {}
          }
          try {
            const result = await fetchPricingWithRetry(asin);
            if (result && hasAnyPrice(result.data)) {
              await writePrice(asin, result.data);
              updated++;
              targetedRecovered++;
            } else {
              stillMissing.push(asin);
              // Log raw data for investigation
              log(
                `STILL MISSING ${asin}: API returned numberOfSellers=${result?.data.numberOfSellers ?? "null"}, ` +
                `lowestFba=${result?.data.lowestFbaPrice}, buyBox=${result?.data.buyBoxPrice}, ` +
                `lowest=${result?.data.lowestPrice}, sellersFba=${result?.data.sellersFba}, ` +
                `sellersFbm=${result?.data.sellersFbm}`,
                "price-sync",
              );
            }
          } catch (err: any) {
            stillMissing.push(asin);
            log(`Targeted retry error for ${asin}: ${err.message}`, "price-sync");
          }
        }),
      );
      if (i + TARGETED_BATCH_SIZE < targetList.length) {
        await new Promise((r) => setTimeout(r, TARGETED_BATCH_DELAY_MS));
      }
    }

    log(
      `Targeted retry complete: ${targetedRetried} retried, ${targetedRecovered} recovered, ${stillMissing.length} still missing`,
      "price-sync",
    );
    if (stillMissing.length > 0) {
      log(
        `Still missing after all passes: ${stillMissing.join(", ")}`,
        "price-sync",
      );
    }
  }

  const totalMissing = offersButNoPrices.size - targetedRecovered;
  const skipped = Math.max(0, failedAsins.length - gapFillRecovered - targetedRetried + totalMissing);

  log(
    `Price refresh complete: ${updated} updated, ${gapFillRecovered} gap-fill recovered, ` +
    `${targetedRetried} targeted (${targetedRecovered} recovered), ${skipped} still missing`,
    "price-sync",
  );

  return {
    updated,
    failed: skipped,
    skipped,
    retried: targetedRetried,
    recovered: targetedRecovered,
    errors,
  };
}
