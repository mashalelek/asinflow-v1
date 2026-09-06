import axios from "axios";
import { parseOffersPayload } from "./offers-parse";
import { log } from "./index";
import { isDangerousGoodFromAttributes } from "./hazmat-classify";

// Auth + thin HTTP wrappers live in spapi-auth.ts so SKU-gen modules can
// import them without dragging in server/index.ts. Re-exported here for
// backwards compatibility with existing call sites in this file.
export { getAccessToken, spApiGet, spApiPost, spApiPut } from "./spapi-auth";
import { spApiGet, spApiPost } from "./spapi-auth";

export interface AsinPricingResult {
  lowestFbaPrice: number | null;
  buyBoxPrice: number | null;
  buyBoxFulfillment: "FBA" | "FBM" | null;
  lowestPrice: number | null;
  avg30DayPrice: number | null;
  avg90DayPrice: number | null;
  numberOfSellers: number | null;
  sellersFba: number | null;
  sellersFbm: number | null;
}

export interface AsinFeesResult {
  fbaFulfillmentFee: number | null;
  referralFee: number | null;
  feesEstimatePrice: number | null;
  // Which writer produced the fee triple (migration 026): 'spapi' = real
  // getMyFeesEstimateForASIN response; 'fallback' = estimateFeeFallback
  // (weight-based). Null on the all-null error shapes (nothing to attribute).
  feeSource?: "spapi" | "fallback" | null;
  // Informational breakout for the §21 bulk page. Still INCLUDED in
  // fbaFulfillmentFee (which sums every non-referral fee) — do not add the
  // two together.
  variableClosingFee?: number | null;
}

export interface AsinCatalogResult {
  weightLbs: number | null;
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  bsrRank: number | null;
  bsrCategory: string | null;
  isMeltable?: boolean;
  // DA-2: catalog-deleted signal piggybacked on this call (no extra API cost).
  //   true  → 404 NOT_FOUND (product gone from Amazon's catalog)
  //   false → 2xx (alive)
  //   null  → inconclusive (transient/throttle/network error) — caller should
  //           preserve the prior stored value, NEVER overwrite to false.
  isCatalogDeleted?: boolean | null;
  // Dangerous-goods (transport) classification, piggybacked on this catalog
  // call (attributes.hazmat present/non-empty — see hazmat-classify.ts). Zero
  // extra API cost.
  //   true  → attributes.hazmat present
  //   false → 2xx catalog response without a hazmat array
  //   null  → inconclusive (transient/throttle/network error) — caller MUST
  //           preserve the prior stored value, NEVER overwrite to false.
  isDangerousGood?: boolean | null;
  // Hazmat (FBA storage/handling program) is NOT derived here. It comes from
  // getItemEligibilityPreview program=INBOUND, code FBA_INB_0015 — see
  // server/inbound-hazmat.ts. null = inconclusive; callers must NOT clobber
  // the stored value when null.
  isHazmat?: boolean | null;
  // Package dimensions (inches), for the §21 bulk snapshot. Derived from the
  // same packageDims already computed for dimensional weight; null when the
  // catalog response carries no usable dimensions. Main path ignores these
  // (its dims come from the Chrome extension only).
  lengthIn?: number | null;
  widthIn?: number | null;
  heightIn?: number | null;
}

export async function getPricing(asin: string): Promise<AsinPricingResult> {
  let lowestFbaPrice: number | null = null;
  let buyBoxPrice: number | null = null;
  let buyBoxFulfillment: "FBA" | "FBM" | null = null;
  let lowestPrice: number | null = null;
  let numberOfSellers: number | null = null;
  let sellersFba: number | null = null;
  let sellersFbm: number | null = null;

  try {
    const offersData = await spApiGet(
      `/products/pricing/v0/items/${asin}/offers`,
      {
        MarketplaceId: "ATVPDKIKX0DER",
        ItemCondition: "New",
      },
    );

    // Shared parser (SPEC §11, 2026-09-06): identical semantics to the old
    // inline parse; also used by the getItemOffersBatch path in price-refresh.
    const summary = offersData?.payload?.Summary;
    log(`Raw NumberOfOffers for ${asin}: ${JSON.stringify(summary?.NumberOfOffers)}`, "sellers-raw");
    log(`Raw BuyBoxEligibleOffers for ${asin}: ${JSON.stringify(summary?.BuyBoxEligibleOffers)}`, "sellers-raw");
    const parsed = parseOffersPayload(offersData?.payload);
    lowestFbaPrice = parsed.lowestFbaPrice;
    buyBoxPrice = parsed.buyBoxPrice;
    buyBoxFulfillment = parsed.buyBoxFulfillment;
    lowestPrice = parsed.lowestPrice;
    numberOfSellers = parsed.numberOfSellers;
    sellersFba = parsed.sellersFba;
    sellersFbm = parsed.sellersFbm;

    log(
      `Pricing for ${asin}: lowestFba=${lowestFbaPrice}, buyBox=${buyBoxPrice} (${buyBoxFulfillment}), lowest=${lowestPrice}, sellers=${numberOfSellers} (FBA:${sellersFba}, FBM:${sellersFbm})`,
      "sp-api",
    );
    return {
      lowestFbaPrice,
      buyBoxPrice,
      buyBoxFulfillment,
      lowestPrice,
      avg30DayPrice: null,
      avg90DayPrice: null,
      numberOfSellers,
      sellersFba,
      sellersFbm,
    };
  } catch (err: any) {
    const statusCode = err.response?.status;
    const apiError =
      err.response?.data?.errors?.[0]?.code ||
      err.response?.data?.errors?.[0]?.message ||
      "";
    log(
      `Offers API error for ${asin} (status=${statusCode}): ${err.message} | apiError=${apiError}`,
      "sp-api",
    );

    if (
      statusCode === 403 ||
      apiError.toLowerCase().includes("restricted") ||
      apiError.toLowerCase().includes("unauthorized")
    ) {
      return {
        lowestFbaPrice: null,
        buyBoxPrice: null,
        buyBoxFulfillment: null,
        lowestPrice: null,
        avg30DayPrice: null,
        avg90DayPrice: null,
        numberOfSellers: null,
        sellersFba: null,
        sellersFbm: null,
        _restricted: true,
      } as AsinPricingResult & { _restricted?: boolean };
    }

    try {
      const data = await spApiGet("/products/pricing/v0/competitivePrice", {
        MarketplaceId: "ATVPDKIKX0DER",
        Asins: asin,
        ItemType: "Asin",
      });

      const product = data?.payload?.[0]?.Product;
      if (product) {
        const competitivePrices =
          product.CompetitivePricing?.CompetitivePrices || [];
        for (const cp of competitivePrices) {
          const amount =
            cp.Price?.LandedPrice?.Amount ?? cp.Price?.ListingPrice?.Amount;
          if (amount != null) {
            const price = parseFloat(amount);
            if (cp.CompetitivePriceId === "1") {
              buyBoxPrice = price;
              buyBoxFulfillment = null;
            }
            if (lowestPrice === null || price < lowestPrice) {
              lowestPrice = price;
            }
          }
        }

        const offerListings =
          product.CompetitivePricing?.NumberOfOfferListings || [];
        log(
          `Competitive pricing NumberOfOfferListings for ${asin}: ${JSON.stringify(offerListings)}`,
          "sellers-raw",
        );
        let newTotal = 0;
        let cpFba = 0;
        let cpFbm = 0;
        let hasNewCondition = false;
        for (const oc of offerListings) {
          const cond = (oc.condition || oc.Condition || "").toLowerCase();
          const channel = oc.fulfillmentChannel || oc.FulfillmentChannel || "";
          const count =
            parseInt(oc.Value ?? oc.OfferListingCount ?? oc.Count ?? "0") || 0;
          if (cond === "new") {
            hasNewCondition = true;
            newTotal += count;
            if (channel === "Amazon") cpFba += count;
            else if (channel === "Merchant") cpFbm += count;
          }
        }
        if (!hasNewCondition) {
          for (const oc of offerListings) {
            const cond = (oc.condition || oc.Condition || "").toLowerCase();
            const channel =
              oc.fulfillmentChannel || oc.FulfillmentChannel || "";
            const count =
              parseInt(oc.Value ?? oc.OfferListingCount ?? oc.Count ?? "0") ||
              0;
            if (cond === "any" || cond === "") {
              newTotal += count;
              if (channel === "Amazon") cpFba += count;
              else if (channel === "Merchant") cpFbm += count;
            }
          }
        }
        if (newTotal > 0) {
          numberOfSellers = newTotal;
          if (cpFba > 0 || cpFbm > 0) {
            sellersFba = cpFba;
            sellersFbm = cpFbm;
          } else {
            numberOfSellers = newTotal;
            sellersFba = null;
            sellersFbm = null;
          }
        }
      }

      return {
        lowestFbaPrice,
        buyBoxPrice,
        buyBoxFulfillment,
        lowestPrice,
        avg30DayPrice: null,
        avg90DayPrice: null,
        numberOfSellers,
        sellersFba,
        sellersFbm,
      };
    } catch (innerErr: any) {
      const innerStatus = innerErr.response?.status;
      const innerApiError =
        innerErr.response?.data?.errors?.[0]?.code ||
        innerErr.response?.data?.errors?.[0]?.message ||
        "";
      log(
        `Competitive Pricing fallback also failed for ${asin} (status=${innerStatus}): ${innerErr.message} | apiError=${innerApiError}`,
        "sp-api",
      );
      const isRestricted =
        innerStatus === 403 ||
        innerApiError.toLowerCase().includes("restricted");
      return {
        lowestFbaPrice: null,
        buyBoxPrice: null,
        buyBoxFulfillment: null,
        lowestPrice: null,
        avg30DayPrice: null,
        avg90DayPrice: null,
        numberOfSellers: null,
        sellersFba: null,
        sellersFbm: null,
        _restricted: isRestricted || undefined,
      } as AsinPricingResult & { _restricted?: boolean };
    }
  }
}

const CATEGORY_REFERRAL_PERCENTAGES: Record<string, number> = {
  "Amazon Device Accessories": 0.45,
  "Arts, Crafts & Sewing": 0.15,
  Automotive: 0.12,
  "Automotive & Powersports": 0.12,
  "Baby Products": 0.08,
  Beauty: 0.08,
  "Beauty & Personal Care": 0.08,
  Books: 0.15,
  "Camera & Photo": 0.08,
  "Cell Phones & Accessories": 0.08,
  Clothing: 0.17,
  "Clothing & Accessories": 0.17,
  "Consumer Electronics": 0.08,
  Electronics: 0.08,
  "Grocery & Gourmet Food": 0.08,
  "Health & Household": 0.08,
  "Health & Personal Care": 0.08,
  "Home & Garden": 0.15,
  "Home & Kitchen": 0.15,
  "Home Improvement": 0.15,
  "Industrial & Scientific": 0.12,
  Jewelry: 0.2,
  Kitchen: 0.15,
  "Luggage & Travel Accessories": 0.15,
  "Musical Instruments": 0.15,
  "Office Products": 0.15,
  Outdoors: 0.15,
  "Pet Supplies": 0.15,
  Shoes: 0.15,
  "Software & Computer Games": 0.15,
  Sports: 0.15,
  "Sports & Outdoors": 0.15,
  "Tools & Home Improvement": 0.15,
  "Toys & Games": 0.15,
  "Video Games": 0.15,
  Watches: 0.16,
};

const DEFAULT_REFERRAL_PCT = 0.15;

function getCategoryReferralPercentage(category?: string | null): number {
  if (category) {
    for (const [key, pct] of Object.entries(CATEGORY_REFERRAL_PERCENTAGES)) {
      if (
        category.toLowerCase().includes(key.toLowerCase()) ||
        key.toLowerCase().includes(category.toLowerCase())
      ) {
        return pct;
      }
    }
  }
  return DEFAULT_REFERRAL_PCT;
}

function parseFeeResult(
  asin: string,
  feesEstimateResult: any,
  price: number,
  category?: string | null,
): AsinFeesResult {
  const feesEstimate = feesEstimateResult?.FeesEstimate;
  const feeDetails = feesEstimate?.FeeDetailList || [];
  const totalFeesEstimate = feesEstimate?.TotalFeesEstimate;
  const status = feesEstimateResult?.Status;

  if (status === "ClientError" || status === "ServerError") {
    const errMsg = feesEstimateResult?.Error?.Message || status;
    log(`Fee estimate error for ${asin}: ${errMsg}`, "fees");
    return {
      fbaFulfillmentFee: null,
      referralFee: null,
      feesEstimatePrice: null,
    };
  }

  let referralFee: number | null = null;
  let totalFbaFee: number = 0;
  let variableClosingFee: number | null = null;

  log(`Fee breakdown for ${asin} (price=$${price}):`, "fees");

  for (const fee of feeDetails) {
    const feeType = fee.FeeType || "Unknown";
    const feeAmount = parseFloat(fee.FeeAmount?.Amount) || 0;
    const promoAmount = parseFloat(fee.FeePromotion?.Amount) || 0;
    const finalFee = parseFloat(fee.FinalFee?.Amount) ?? feeAmount;

    let subFeeInfo = "";
    if (fee.IncludedFeeDetailList && Array.isArray(fee.IncludedFeeDetailList)) {
      const subParts = fee.IncludedFeeDetailList.map((sf: any) => {
        const sfType = sf.FeeType || "Unknown";
        const sfAmount = parseFloat(sf.FeeAmount?.Amount) || 0;
        const sfFinal = parseFloat(sf.FinalFee?.Amount) ?? sfAmount;
        return `${sfType}=$${sfFinal.toFixed(2)}`;
      });
      subFeeInfo = ` [includes: ${subParts.join(", ")}]`;
    }

    log(
      `  ${feeType}: amount=$${feeAmount.toFixed(2)}, final=$${finalFee.toFixed(2)}${promoAmount ? `, promo=$${promoAmount.toFixed(2)}` : ""}${subFeeInfo}`,
      "fees",
    );

    if (feeType === "ReferralFee") {
      referralFee = finalFee;
    } else {
      // VariableClosingFee is captured separately for the §21 bulk snapshot
      // but stays inside totalFbaFee — main-path fee semantics unchanged.
      if (feeType === "VariableClosingFee" && finalFee > 0) {
        variableClosingFee = finalFee;
      }
      totalFbaFee += finalFee;
    }
  }

  if (totalFeesEstimate) {
    log(
      `  TotalFeesEstimate: $${parseFloat(totalFeesEstimate.Amount).toFixed(2)} ${totalFeesEstimate.CurrencyCode}`,
      "fees",
    );
  }

  const totalFromApi = totalFeesEstimate
    ? parseFloat(totalFeesEstimate.Amount)
    : null;
  if (totalFromApi != null && referralFee != null) {
    const expectedFba = totalFromApi - referralFee;
    if (Math.abs(expectedFba - totalFbaFee) > 0.01) {
      log(
        `  WARNING: FBA fee mismatch! Sum of non-referral=$${totalFbaFee.toFixed(2)} vs (total-referral)=$${expectedFba.toFixed(2)}. Using total-based value.`,
        "fees",
      );
      totalFbaFee = expectedFba;
    }
  }

  if ((referralFee === null || referralFee <= 0) && price > 0) {
    const categoryReferralPct = getCategoryReferralPercentage(category);
    const manualReferralFee = parseFloat(
      (price * categoryReferralPct).toFixed(2),
    );
    log(
      `WARNING: SP-API returned ${referralFee === null ? "null" : "$0"} referral fee for ${asin} at price $${price}. Category=${category ?? "unknown"}. Using category-based fallback: ${(categoryReferralPct * 100).toFixed(0)}% = $${manualReferralFee}`,
      "fees",
    );
    referralFee = manualReferralFee;
  }

  // Sanity guard: catch degraded SP-API responses where TotalFeesEstimate
  // and the line items both agree on a near-zero FBA fee (reconciliation
  // passes because the bad numbers are internally consistent). An FBA-
  // eligible item priced > $10 cannot economically have a sub-$1 FBA
  // fulfillment fee. Returning the all-null fee shape triggers the same
  // retry → estimateFeeFallback path that legitimate fee failures use
  // (see server/routes.ts:1495–1503).
  if (price > 10 && totalFbaFee < 1) {
    log(
      `Degraded fee response for ${asin}: price=$${price.toFixed(2)}, ` +
      `totalFbaFee=$${totalFbaFee.toFixed(2)}. Returning all-null to trigger fallback.`,
      "fees",
    );
    return {
      fbaFulfillmentFee: null,
      referralFee: null,
      feesEstimatePrice: null,
    };
  }

  log(
    `  Final captured: FBA=$${totalFbaFee.toFixed(2)}, Referral=$${(referralFee ?? 0).toFixed(2)}`,
    "fees",
  );

  return {
    fbaFulfillmentFee: totalFbaFee > 0 ? totalFbaFee : null,
    referralFee,
    feesEstimatePrice: price,
    variableClosingFee,
    feeSource: "spapi",
  };
}

export async function getFees(
  asin: string,
  price: number,
  category?: string | null,
): Promise<AsinFeesResult> {
  try {
    const body = {
      FeesEstimateRequest: {
        MarketplaceId: "ATVPDKIKX0DER",
        IsAmazonFulfilled: true,
        PriceToEstimateFees: {
          ListingPrice: {
            CurrencyCode: "USD",
            Amount: price,
          },
        },
        Identifier: asin,
      },
    };

    const data = await spApiPost(
      `/products/fees/v0/items/${asin}/feesEstimate`,
      body,
    );

    log(
      `Raw fee response for ${asin}: ${JSON.stringify(data?.payload?.FeesEstimateResult, null, 2)}`,
      "fees-raw",
    );

    return parseFeeResult(
      asin,
      data?.payload?.FeesEstimateResult,
      price,
      category,
    );
  } catch (err: any) {
    const statusCode = err.response?.status;
    const apiError =
      err.response?.data?.errors?.[0]?.code ||
      err.response?.data?.errors?.[0]?.message ||
      "";
    log(
      `Fees API error for ${asin} (status=${statusCode}): ${err.message} | apiError=${apiError}`,
      "sp-api",
    );
    return {
      fbaFulfillmentFee: null,
      referralFee: null,
      feesEstimatePrice: null,
    };
  }
}

export function estimateFeeFallback(
  asin: string,
  price: number,
  weightLbs: number | null,
  category?: string | null,
  packageDims?: { l: number; w: number; h: number } | null,
): AsinFeesResult {
  const weight = weightLbs ?? 1;
  const weightOz = weight * 16;

  let isLargeStandard = false;
  if (packageDims) {
    const sorted = [packageDims.l, packageDims.w, packageDims.h].sort(
      (a, b) => b - a,
    );
    isLargeStandard =
      sorted[0] > 15 || sorted[1] > 12 || sorted[2] > 0.75 || weight > 1;
  } else {
    isLargeStandard = weight > 1;
  }

  let fbaFee: number;
  if (!isLargeStandard) {
    if (weightOz <= 2) fbaFee = 3.06;
    else if (weightOz <= 4) fbaFee = 3.15;
    else if (weightOz <= 6) fbaFee = 3.24;
    else if (weightOz <= 8) fbaFee = 3.33;
    else if (weightOz <= 10) fbaFee = 3.43;
    else if (weightOz <= 12) fbaFee = 3.53;
    else if (weightOz <= 14) fbaFee = 3.6;
    else fbaFee = 3.65;
  } else {
    if (weightOz <= 4) fbaFee = 3.68;
    else if (weightOz <= 8) fbaFee = 3.86;
    else if (weightOz <= 12) fbaFee = 4.08;
    else if (weight <= 1) fbaFee = 4.46;
    else if (weight <= 1.25) fbaFee = 4.95;
    else if (weight <= 1.5) fbaFee = 5.19;
    else if (weight <= 2) fbaFee = 5.28;
    else if (weight <= 2.5) fbaFee = 5.42;
    else if (weight <= 3) fbaFee = 5.77;
    else {
      const extraHalfLbs = Math.ceil((weight - 3) * 2);
      fbaFee = 5.77 + extraHalfLbs * 0.16;
    }

    if (packageDims) {
      const sorted = [packageDims.l, packageDims.w, packageDims.h].sort(
        (a, b) => b - a,
      );
      if (sorted[0] > 18 || sorted[1] > 14 || sorted[2] > 8 || weight > 20) {
        fbaFee = 9.73 + Math.max(0, weight - 1) * 0.42;
      }
    }
  }

  fbaFee = parseFloat(fbaFee.toFixed(2));

  const referralPct = getCategoryReferralPercentage(category);
  const referralFee = parseFloat((price * referralPct).toFixed(2));

  log(
    `FEE FALLBACK for ${asin}: price=$${price}, weight=${weight.toFixed(2)}lbs, ` +
      `isLarge=${isLargeStandard}, FBA=$${fbaFee}, referral=$${referralFee} (${(referralPct * 100).toFixed(0)}% for ${category ?? "unknown"})`,
    "fees",
  );

  return { fbaFulfillmentFee: fbaFee, referralFee, feesEstimatePrice: price, feeSource: "fallback" };
}

export interface BatchFeeItem {
  asin: string;
  price: number;
  category?: string | null;
}

export async function getBatchFees(
  items: BatchFeeItem[],
): Promise<Map<string, AsinFeesResult>> {
  const results = new Map<string, AsinFeesResult>();
  if (items.length === 0) return results;

  const BATCH_SIZE = 20;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    const body = batch.map((item) => ({
      FeesEstimateRequest: {
        MarketplaceId: "ATVPDKIKX0DER",
        IsAmazonFulfilled: true,
        PriceToEstimateFees: {
          ListingPrice: {
            CurrencyCode: "USD",
            Amount: item.price,
          },
        },
        Identifier: item.asin,
      },
      IdType: "ASIN",
      IdValue: item.asin,
    }));

    try {
      log(
        `Batch fee request: ${batch.length} ASINs (${batch.map((b) => b.asin).join(", ")})`,
        "fees-batch",
      );

      const data = await spApiPost("/products/fees/v0/feesEstimate", body);
      const responseList = data || [];

      for (const resp of responseList) {
        const respAsin = resp?.IdValue || resp?.FeesEstimateIdentifier?.IdValue;
        const feesResult = resp?.FeesEstimateResult || resp;
        if (respAsin) {
          const item = batch.find((b) => b.asin === respAsin);
          const parsed = parseFeeResult(
            respAsin,
            feesResult,
            item?.price ?? 0,
            item?.category,
          );
          results.set(respAsin, parsed);
        }
      }

      for (const item of batch) {
        if (!results.has(item.asin)) {
          log(
            `No fee result returned for ${item.asin} in batch response`,
            "fees-batch",
          );
          results.set(item.asin, {
            fbaFulfillmentFee: null,
            referralFee: null,
            feesEstimatePrice: null,
          });
        }
      }

      log(`Batch fee response: ${results.size} results received`, "fees-batch");
    } catch (err: any) {
      const statusCode = err.response?.status;
      const apiError =
        err.response?.data?.errors?.[0]?.code ||
        err.response?.data?.errors?.[0]?.message ||
        "";
      log(
        `Batch Fees API error (status=${statusCode}): ${err.message} | apiError=${apiError}. Falling back to individual calls.`,
        "fees-batch",
      );

      for (const item of batch) {
        if (!results.has(item.asin)) {
          try {
            const singleResult = await getFees(
              item.asin,
              item.price,
              item.category,
            );
            results.set(item.asin, singleResult);
          } catch (singleErr: any) {
            log(
              `Individual fee fallback also failed for ${item.asin}: ${singleErr.message}`,
              "fees",
            );
            results.set(item.asin, {
              fbaFulfillmentFee: null,
              referralFee: null,
              feesEstimatePrice: null,
            });
          }
        }
      }
    }

    if (i + BATCH_SIZE < items.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return results;
}

export interface EligibilityResult {
  status: "yes" | "no" | "check";
}

export async function getEligibility(asin: string): Promise<EligibilityResult> {
  const sellerId = process.env.SP_API_SELLER_ID;
  if (!sellerId) {
    log(`SP_API_SELLER_ID not set, skipping eligibility for ${asin}`, "eligibility");
    return { status: "check" };
  }

  try {
    const data = await spApiGet("/listings/2021-08-01/restrictions", {
      asin,
      sellerId,
      marketplaceIds: "ATVPDKIKX0DER",
      conditionType: "new_new",
    });

    console.log(`[eligibility-raw] ${asin}:`, JSON.stringify(data));

    const restrictions: any[] = Array.isArray(data?.restrictions) ? data.restrictions : [];
    log(`Eligibility ${asin}: restrictions=${restrictions.length}`, "eligibility");

    if (restrictions.length === 0) {
      return { status: "yes" };
    }
    return { status: "no" };
  } catch (err: any) {
    log(`Eligibility error for ${asin}: status=${err.response?.status} body=${JSON.stringify(err.response?.data)}`, "eligibility");
    return { status: "check" };
  }
}

// Hazmat detection (getItemEligibilityPreview program=INBOUND, code
// FBA_INB_0015) moved to server/inbound-hazmat.ts — it lives outside this file
// so it can be imported without booting Express (this file imports ./index)
// and so it's unit-testable with an injected httpGet.

export async function getCatalogData(asin: string): Promise<AsinCatalogResult> {
  try {
    const data = await spApiGet(`/catalog/2022-04-01/items/${asin}`, {
      marketplaceIds: "ATVPDKIKX0DER",
      includedData: "attributes,dimensions,images,salesRanks,summaries",
    });

    let weightLbs: number | null = null;
    let title: string | null = null;
    let brand: string | null = null;
    let imageUrl: string | null = null;
    let bsrRank: number | null = null;
    let bsrCategory: string | null = null;

    if (data?.title) {
      title = data.title;
    }
    if (data?.attributes?.item_name?.[0]?.value) {
      title = data.attributes.item_name[0].value;
    }
    if (data?.attributes?.brand?.[0]?.value) {
      brand = data.attributes.brand[0].value;
    }
    if (!brand && data?.summaries) {
      const summaries = Array.isArray(data.summaries) ? data.summaries : Object.values(data.summaries);
      for (const summary of summaries as any[]) {
        if (summary?.brand) { brand = summary.brand; break; }
      }
    }

    log(
      `Raw images for ${asin}: ${JSON.stringify(data?.images)?.substring(0, 500)}`,
      "catalog-raw",
    );
    log(
      `Raw salesRanks for ${asin}: ${JSON.stringify(data?.salesRanks)?.substring(0, 500)}`,
      "catalog-raw",
    );
    log(
      `Raw summaries for ${asin}: ${JSON.stringify(data?.summaries)?.substring(0, 500)}`,
      "catalog-raw",
    );

    if (data?.images) {
      const imageEntries = Array.isArray(data.images)
        ? data.images
        : Object.values(data.images);
      for (const entry of imageEntries as any[]) {
        if (imageUrl) break;
        const imageList =
          entry?.images || (Array.isArray(entry) ? entry : null);
        if (imageList && Array.isArray(imageList)) {
          for (const img of imageList) {
            if (img.variant === "MAIN" || img.variant === "main") {
              imageUrl = img.link || img.url || null;
              break;
            }
          }
          if (!imageUrl && imageList.length > 0) {
            imageUrl = imageList[0].link || imageList[0].url || null;
          }
        }
        if (!imageUrl && entry?.link) {
          imageUrl = entry.link;
        }
      }
    }

    if (!imageUrl && data?.summaries) {
      const summaries = Array.isArray(data.summaries)
        ? data.summaries
        : Object.values(data.summaries);
      for (const summary of summaries as any[]) {
        if (summary?.mainImage?.link) {
          imageUrl = summary.mainImage.link;
          break;
        }
      }
    }

    if (data?.salesRanks) {
      const rankEntries = Array.isArray(data.salesRanks)
        ? data.salesRanks
        : Object.values(data.salesRanks);
      for (const entry of rankEntries as any[]) {
        const ranks =
          entry?.displayGroupRanks ||
          entry?.classificationRanks ||
          entry?.ranks ||
          (Array.isArray(entry) ? entry : null);
        if (ranks && Array.isArray(ranks)) {
          for (const rank of ranks) {
            const r = parseInt(rank.rank ?? rank.value);
            if (!isNaN(r) && r > 0 && (bsrRank === null || r < bsrRank)) {
              bsrRank = r;
              bsrCategory =
                rank.title ||
                rank.link?.split("/")?.pop() ||
                rank.productCategoryId ||
                null;
            }
          }
        }
        if (entry?.rank != null) {
          const r = parseInt(entry.rank);
          if (!isNaN(r) && r > 0 && (bsrRank === null || r < bsrRank)) {
            bsrRank = r;
            bsrCategory = entry.title || entry.productCategoryId || null;
          }
        }
      }
    }

    log(
      `Extracted for ${asin}: image=${imageUrl ? "yes" : "null"}, bsr=${bsrRank} in ${bsrCategory}`,
      "catalog",
    );

    function convertWeightToLbs(value: number, unit: string): number {
      const u = unit.toLowerCase();
      if (u.includes("pound") || u === "lb" || u === "lbs") return value;
      if (u.includes("ounce") || u === "oz") return value / 16;
      if (u.includes("gram") || u === "g") return value / 453.592;
      if (u.includes("kilogram") || u === "kg") return value * 2.20462;
      return value;
    }

    function convertDimToInches(value: number, unit: string): number {
      const u = unit.toLowerCase();
      if (u.includes("inch") || u === "in") return value;
      if (u.includes("centimeter") || u === "cm") return value / 2.54;
      if (u.includes("millimeter") || u === "mm") return value / 25.4;
      if (u.includes("meter") || u === "m") return value * 39.3701;
      return value;
    }

    function extractWeight(dimObj: any): number | null {
      if (!dimObj?.weight) return null;
      const w = parseFloat(dimObj.weight.value);
      const unit = dimObj.weight.unit || "";
      if (isNaN(w) || w <= 0) return null;
      return convertWeightToLbs(w, unit);
    }

    function extractDims(
      dimObj: any,
    ): { l: number; w: number; h: number } | null {
      if (!dimObj?.length || !dimObj?.width || !dimObj?.height) return null;
      const l = parseFloat(dimObj.length.value);
      const w = parseFloat(dimObj.width.value);
      const h = parseFloat(dimObj.height.value);
      if (isNaN(l) || isNaN(w) || isNaN(h) || l <= 0 || w <= 0 || h <= 0)
        return null;
      return {
        l: convertDimToInches(l, dimObj.length.unit || ""),
        w: convertDimToInches(w, dimObj.width.unit || ""),
        h: convertDimToInches(h, dimObj.height.unit || ""),
      };
    }

    let packageWeightLbs: number | null = null;
    let itemWeightLbs: number | null = null;
    let dimWeightLbs: number | null = null;
    let packageDims: { l: number; w: number; h: number } | null = null;

    log(
      `Raw dimensions for ${asin}: ${JSON.stringify(data?.dimensions)}`,
      "weight-raw",
    );

    const dims = data?.dimensions;
    if (dims) {
      const dimEntries = Array.isArray(dims) ? dims : Object.values(dims);
      for (const entry of dimEntries as any[]) {
        if (entry?.package) {
          const pw = extractWeight(entry.package);
          if (
            pw != null &&
            (packageWeightLbs === null || pw > packageWeightLbs)
          ) {
            packageWeightLbs = pw;
          }
          const pd = extractDims(entry.package);
          if (pd != null) packageDims = pd;
        }

        if (entry?.item) {
          const iw = extractWeight(entry.item);
          if (iw != null && (itemWeightLbs === null || iw > itemWeightLbs)) {
            itemWeightLbs = iw;
          }
          if (packageDims === null) {
            const id = extractDims(entry.item);
            if (id != null) packageDims = id;
          }
        }

        const topWeight = extractWeight(entry);
        if (topWeight != null) {
          if (itemWeightLbs === null) itemWeightLbs = topWeight;
        }
        if (packageDims === null) {
          const topDims = extractDims(entry);
          if (topDims != null) packageDims = topDims;
        }
      }
    }

    const attrs = data?.attributes || {};

    if (attrs.item_package_weight?.[0]) {
      const pw = attrs.item_package_weight[0];
      const w = parseFloat(pw.value);
      const unit = (pw.unit || "").toLowerCase();
      if (!isNaN(w) && w > 0) {
        const converted = convertWeightToLbs(w, unit);
        if (packageWeightLbs === null || converted > packageWeightLbs) {
          packageWeightLbs = converted;
          log(
            `Found item_package_weight attribute for ${asin}: ${converted.toFixed(3)} lbs`,
            "weight",
          );
        }
      }
    }

    if (attrs.item_package_dimensions?.[0]) {
      const pkgDims = attrs.item_package_dimensions[0];
      const l = parseFloat(pkgDims.length?.value);
      const w = parseFloat(pkgDims.width?.value);
      const h = parseFloat(pkgDims.height?.value);
      const wt = parseFloat(pkgDims.weight?.value);
      if (!isNaN(l) && !isNaN(w) && !isNaN(h) && l > 0 && w > 0 && h > 0) {
        const lUnit = pkgDims.length?.unit || "";
        const wUnit = pkgDims.width?.unit || "";
        const hUnit = pkgDims.height?.unit || "";
        if (packageDims === null) {
          packageDims = {
            l: convertDimToInches(l, lUnit),
            w: convertDimToInches(w, wUnit),
            h: convertDimToInches(h, hUnit),
          };
          log(
            `Found item_package_dimensions attribute for ${asin}: ${packageDims.l.toFixed(1)}x${packageDims.w.toFixed(1)}x${packageDims.h.toFixed(1)} in`,
            "weight",
          );
        }
      }
      if (!isNaN(wt) && wt > 0) {
        const wtUnit = pkgDims.weight?.unit || "";
        const converted = convertWeightToLbs(wt, wtUnit);
        if (packageWeightLbs === null || converted > packageWeightLbs) {
          packageWeightLbs = converted;
          log(
            `Found package weight from item_package_dimensions for ${asin}: ${converted.toFixed(3)} lbs`,
            "weight",
          );
        }
      }
    }

    if (attrs.item_weight?.[0]) {
      const iw = attrs.item_weight[0];
      const w = parseFloat(iw.value);
      const unit = (iw.unit || "").toLowerCase();
      if (!isNaN(w) && w > 0) {
        const converted = convertWeightToLbs(w, unit);
        if (itemWeightLbs === null || converted > itemWeightLbs) {
          itemWeightLbs = converted;
          log(
            `Found item_weight attribute for ${asin}: ${converted.toFixed(3)} lbs (raw: ${w} ${unit})`,
            "weight",
          );
        }
      }
    }

    if (attrs.unit_weight?.[0]) {
      const uw = attrs.unit_weight[0];
      const w = parseFloat(uw.value);
      const unit = (uw.unit || "").toLowerCase();
      if (!isNaN(w) && w > 0) {
        const converted = convertWeightToLbs(w, unit);
        log(
          `Found unit_weight attribute for ${asin}: ${converted.toFixed(3)} lbs (raw: ${w} ${unit})`,
          "weight",
        );
        if (itemWeightLbs === null || converted > itemWeightLbs) {
          itemWeightLbs = converted;
        }
      }
    }

    if (data?.summaries) {
      const summaries = Array.isArray(data.summaries)
        ? data.summaries
        : Object.values(data.summaries);
      for (const summary of summaries as any[]) {
        if (summary?.packageWeight) {
          const w = parseFloat(summary.packageWeight.value);
          const unit = (summary.packageWeight.unit || "").toLowerCase();
          if (!isNaN(w) && w > 0) {
            const converted = convertWeightToLbs(w, unit);
            if (packageWeightLbs === null || converted > packageWeightLbs) {
              packageWeightLbs = converted;
              log(
                `Found packageWeight from summaries for ${asin}: ${converted.toFixed(3)} lbs`,
                "weight",
              );
            }
          }
        }

        if (summary?.itemDimensions?.weight) {
          const idw = summary.itemDimensions.weight;
          const w = parseFloat(idw.value ?? idw);
          const unit = (idw.unit || "pounds").toLowerCase();
          if (!isNaN(w) && w > 0) {
            const converted = convertWeightToLbs(w, unit);
            log(
              `Found itemDimensions.weight from summaries for ${asin}: ${converted.toFixed(3)} lbs (raw: ${w} ${unit})`,
              "weight",
            );
            if (itemWeightLbs === null || converted > itemWeightLbs) {
              itemWeightLbs = converted;
            }
          }
        }

        if (summary?.itemDimensions && !packageDims) {
          const idims = summary.itemDimensions;
          const l = parseFloat(idims.length?.value ?? 0);
          const w = parseFloat(idims.width?.value ?? 0);
          const h = parseFloat(idims.height?.value ?? 0);
          if (l > 0 && w > 0 && h > 0) {
            const lUnit = idims.length?.unit || "inches";
            const wUnit = idims.width?.unit || "inches";
            const hUnit = idims.height?.unit || "inches";
            packageDims = {
              l: convertDimToInches(l, lUnit),
              w: convertDimToInches(w, wUnit),
              h: convertDimToInches(h, hUnit),
            };
            log(
              `Found itemDimensions from summaries for ${asin}: ${packageDims.l.toFixed(1)}x${packageDims.w.toFixed(1)}x${packageDims.h.toFixed(1)} in`,
              "weight",
            );
          }
        }
      }
    }

    log(
      `Available weight attributes for ${asin}: ${JSON.stringify({
        item_package_weight: attrs.item_package_weight,
        item_weight: attrs.item_weight,
        unit_weight: attrs.unit_weight,
        item_package_dimensions: attrs.item_package_dimensions
          ? "[present]"
          : undefined,
      })}`,
      "weight-attrs",
    );

    if (packageDims != null) {
      dimWeightLbs = (packageDims.l * packageDims.w * packageDims.h) / 139;
    }

    let weightSource = "default";
    if (packageWeightLbs != null) {
      weightLbs = packageWeightLbs;
      weightSource = "packageWeight";
    } else if (dimWeightLbs != null && itemWeightLbs != null) {
      weightLbs = Math.max(dimWeightLbs, itemWeightLbs);
      weightSource =
        dimWeightLbs > itemWeightLbs
          ? "dimWeight"
          : "itemWeight (dim fallback)";
    } else if (dimWeightLbs != null) {
      weightLbs = dimWeightLbs;
      weightSource = "dimWeight";
    } else if (itemWeightLbs != null) {
      weightLbs = itemWeightLbs;
      weightSource = "itemWeight (last resort)";
    }

    log(
      `Weight for ${asin}: Using ${weightSource}: ${weightLbs?.toFixed(3) ?? "N/A (no weight found)"} lbs | packageWeight=${packageWeightLbs?.toFixed(3) ?? "N/A"}, itemWeight=${itemWeightLbs?.toFixed(3) ?? "N/A"}, dimWeight=${dimWeightLbs?.toFixed(3) ?? "N/A"}${packageDims ? ` (${packageDims.l.toFixed(1)}x${packageDims.w.toFixed(1)}x${packageDims.h.toFixed(1)} in)` : ""}`,
      "weight",
    );

    // Meltable detection from product attributes. FBA-hazmat is NOT derived
    // here — it comes from getInboundHazmat (INBOUND code FBA_INB_0015).
    let isMeltable = false;
    if (attrs) {
      const tempRating = (attrs.temperature_rating?.[0]?.value ?? "").toLowerCase();
      if (tempRating.includes("chilled") || tempRating.includes("frozen") || tempRating.includes("refriger")) isMeltable = true;
      if (attrs.is_heat_sensitive?.[0]?.value === true || attrs.is_heat_sensitive?.[0]?.value === "true") isMeltable = true;
      if (attrs.meltable?.[0]?.value === true || attrs.meltable?.[0]?.value === "true") isMeltable = true;
    }

    // Dangerous-goods (transport) classification piggybacked on this call.
    // Presence-not-values: attributes.hazmat present/non-empty = DG (butane
    // ships class "0"/no-UN yet is DG). See hazmat-classify.ts. Distinct from
    // is_hazmat (FBA storage program).
    const isDangerousGood = isDangerousGoodFromAttributes(attrs);

    return {
      weightLbs: weightLbs ?? null,
      title,
      brand,
      imageUrl,
      bsrRank,
      bsrCategory,
      isMeltable,
      isDangerousGood,
      isCatalogDeleted: false, // 2xx → product exists in catalog
      lengthIn: packageDims?.l ?? null,
      widthIn: packageDims?.w ?? null,
      heightIn: packageDims?.h ?? null,
    };
  } catch (err: any) {
    const statusCode = err.response?.status;
    log(
      `Catalog API error for ${asin} (status=${statusCode}): ${err.message}`,
      "sp-api",
    );
    return {
      weightLbs: null,
      title: null,
      brand: null,
      imageUrl: null,
      bsrRank: null,
      bsrCategory: null,
      // Fail-closed: catalog fetch failed → DG is unknown, NOT false. null tells
      // the COALESCE UPSERT to preserve the prior stored value (never clobber on
      // throttle/transient). Applies to 404 too — a dead ASIN's DG stays as-was.
      isDangerousGood: null,
      // 404 = definitive "catalog gone". Other errors = inconclusive → null,
      // which the write helper treats as "preserve prior value, no update".
      isCatalogDeleted: statusCode === 404 ? true : null,
    };
  }
}
