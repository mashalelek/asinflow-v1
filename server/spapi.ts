import axios from "axios";
import { log } from "./index";

interface SpApiTokens {
  accessToken: string;
  expiresAt: number;
}

let cachedTokens: SpApiTokens | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedTokens && Date.now() < cachedTokens.expiresAt - 60000) {
    return cachedTokens.accessToken;
  }

  const clientId = process.env.SP_API_CLIENT_ID;
  const clientSecret = process.env.SP_API_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "SP-API credentials not configured. Add SP_API_CLIENT_ID, SP_API_CLIENT_SECRET, and SP_API_REFRESH_TOKEN to your Replit Secrets."
    );
  }

  const res = await axios.post("https://api.amazon.com/auth/o2/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  cachedTokens = {
    accessToken: res.data.access_token,
    expiresAt: Date.now() + res.data.expires_in * 1000,
  };

  return cachedTokens.accessToken;
}

async function spApiGet(endpoint: string, params?: Record<string, any>) {
  const token = await getAccessToken();
  const res = await axios.get(`https://sellingpartnerapi-na.amazon.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
    params,
  });
  return res.data;
}

async function spApiPost(endpoint: string, body: any) {
  const token = await getAccessToken();
  const res = await axios.post(`https://sellingpartnerapi-na.amazon.com${endpoint}`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
  });
  return res.data;
}

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
}

export interface AsinCatalogResult {
  weightLbs: number | null;
  title: string | null;
  imageUrl: string | null;
  bsrRank: number | null;
  bsrCategory: string | null;
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
    const offersData = await spApiGet(`/products/pricing/v0/items/${asin}/offers`, {
      MarketplaceId: "ATVPDKIKX0DER",
      ItemCondition: "New",
    });

    const summary = offersData?.payload?.Summary;
    if (summary) {
      if (summary.LowestPrices) {
        for (const lp of summary.LowestPrices) {
          const amt = parseFloat(lp.LandedPrice?.Amount);
          if (!isNaN(amt)) {
            const channel = lp.fulfillmentChannel || lp.FulfillmentChannel || "";
            if (channel === "Amazon") {
              if (lowestFbaPrice === null || amt < lowestFbaPrice) {
                lowestFbaPrice = amt;
              }
            }
            if (lowestPrice === null || amt < lowestPrice) {
              lowestPrice = amt;
            }
          }
        }
      }

      if (summary.TotalOfferCount != null) {
        numberOfSellers = summary.TotalOfferCount;
      }

      if (summary.NumberOfOffers) {
        for (const entry of summary.NumberOfOffers) {
          const cond = entry.condition || entry.Condition || "";
          const channel = entry.fulfillmentChannel || entry.FulfillmentChannel || "";
          const count = parseInt(entry.OfferCount ?? entry.Value ?? "0") || 0;
          if (cond === "New" || cond === "new" || cond === "") {
            if (channel === "Amazon") {
              sellersFba = (sellersFba ?? 0) + count;
            } else if (channel === "Merchant") {
              sellersFbm = (sellersFbm ?? 0) + count;
            }
          }
        }
        if (numberOfSellers === null && (sellersFba || sellersFbm)) {
          numberOfSellers = (sellersFba ?? 0) + (sellersFbm ?? 0);
        }
      }
    }

    const offers = offersData?.payload?.Offers;
    if (offers && Array.isArray(offers)) {
      if (numberOfSellers === null) {
        numberOfSellers = offers.length;
      }

      let fbaCount = 0;
      let fbmCount = 0;

      for (const offer of offers) {
        const amt = parseFloat(offer.ListingPrice?.Amount);
        if (isNaN(amt)) continue;
        const shipping = parseFloat(offer.Shipping?.Amount) || 0;
        const landed = amt + shipping;

        const isFba =
          offer.IsFulfilledByAmazon === true ||
          offer.FulfillmentChannel === "Amazon";

        if (isFba) {
          fbaCount++;
          if (lowestFbaPrice === null || landed < lowestFbaPrice) {
            lowestFbaPrice = landed;
          }
        } else {
          fbmCount++;
        }

        if (lowestPrice === null || landed < lowestPrice) {
          lowestPrice = landed;
        }

        if (offer.IsBuyBoxWinner === true) {
          buyBoxPrice = landed;
          buyBoxFulfillment = isFba ? "FBA" : "FBM";
        }
      }

      if (sellersFba === null && fbaCount > 0) sellersFba = fbaCount;
      if (sellersFbm === null && fbmCount > 0) sellersFbm = fbmCount;
    }

    if (buyBoxPrice === null && summary?.BuyBoxPrices) {
      for (const bp of summary.BuyBoxPrices) {
        const cond = bp.condition || bp.Condition || "";
        if (cond === "New" || cond === "new") {
          const amt = parseFloat(bp.LandedPrice?.Amount);
          if (!isNaN(amt)) {
            buyBoxPrice = amt;
            buyBoxFulfillment = null;
          }
        }
      }
    }

    log(`Pricing for ${asin}: lowestFba=${lowestFbaPrice}, buyBox=${buyBoxPrice} (${buyBoxFulfillment}), lowest=${lowestPrice}, sellers=${numberOfSellers} (FBA:${sellersFba}, FBM:${sellersFbm})`, "sp-api");

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
    log(`Offers API error for ${asin}: ${err.message}`, "sp-api");

    try {
      const data = await spApiGet("/products/pricing/v0/competitivePrice", {
        MarketplaceId: "ATVPDKIKX0DER",
        Asins: asin,
        ItemType: "Asin",
      });

      const product = data?.payload?.[0]?.Product;
      if (product) {
        const competitivePrices = product.CompetitivePricing?.CompetitivePrices || [];
        for (const cp of competitivePrices) {
          const amount = cp.Price?.LandedPrice?.Amount ?? cp.Price?.ListingPrice?.Amount;
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

        const offerListings = product.CompetitivePricing?.NumberOfOfferListings || [];
        let total = 0;
        for (const oc of offerListings) {
          const cond = oc.condition || oc.Condition || "";
          if (cond === "New" || cond === "new" || cond === "Any" || cond === "any" || cond === "") {
            total += parseInt(oc.Value ?? oc.OfferListingCount ?? "0") || 0;
          }
        }
        if (total > 0) numberOfSellers = total;
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
      log(`Competitive Pricing fallback also failed for ${asin}: ${innerErr.message}`, "sp-api");
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
      };
    }
  }
}

export async function getFees(asin: string, price: number): Promise<AsinFeesResult> {
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
      body
    );

    let fbaFulfillmentFee: number | null = null;
    let referralFee: number | null = null;

    const feeDetails = data?.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList || [];
    for (const fee of feeDetails) {
      if (fee.FeeType === "FBAFees") {
        fbaFulfillmentFee = parseFloat(fee.FeeAmount?.Amount) || null;
      }
      if (fee.FeeType === "ReferralFee") {
        referralFee = parseFloat(fee.FeeAmount?.Amount) || null;
      }
    }

    return { fbaFulfillmentFee, referralFee, feesEstimatePrice: price };
  } catch (err: any) {
    log(`Fees API error for ${asin}: ${err.message}`, "sp-api");
    return { fbaFulfillmentFee: null, referralFee: null, feesEstimatePrice: null };
  }
}

export async function getCatalogData(asin: string): Promise<AsinCatalogResult> {
  try {
    const data = await spApiGet(`/catalog/2022-04-01/items/${asin}`, {
      marketplaceIds: "ATVPDKIKX0DER",
      includedData: "attributes,dimensions,images,salesRanks",
    });

    let weightLbs: number | null = null;
    let title: string | null = null;
    let imageUrl: string | null = null;
    let bsrRank: number | null = null;
    let bsrCategory: string | null = null;

    if (data?.title) {
      title = data.title;
    }
    if (data?.attributes?.item_name?.[0]?.value) {
      title = data.attributes.item_name[0].value;
    }

    if (data?.images) {
      for (const imageSet of Object.values(data.images) as any[]) {
        if (Array.isArray(imageSet)) {
          for (const img of imageSet) {
            if (img.variant === "MAIN" || img.variant === "main") {
              imageUrl = img.link || img.url || null;
              break;
            }
          }
          if (!imageUrl && imageSet.length > 0) {
            imageUrl = imageSet[0].link || imageSet[0].url || null;
          }
        }
      }
    }

    if (data?.salesRanks) {
      for (const rankSet of Object.values(data.salesRanks) as any[]) {
        if (Array.isArray(rankSet)) {
          for (const rank of rankSet) {
            if (rank.rank != null) {
              const r = parseInt(rank.rank);
              if (!isNaN(r) && (bsrRank === null || r < bsrRank)) {
                bsrRank = r;
                bsrCategory = rank.title || rank.productCategoryId || null;
              }
            }
          }
        }
      }
    }

    const dims = data?.dimensions;
    if (dims) {
      for (const dimSet of Object.values(dims) as any[]) {
        if (dimSet?.weight) {
          const w = parseFloat(dimSet.weight.value);
          const unit = dimSet.weight.unit?.toLowerCase() || "";
          if (!isNaN(w)) {
            if (unit.includes("pound") || unit === "lb" || unit === "lbs") {
              weightLbs = w;
            } else if (unit.includes("ounce") || unit === "oz") {
              weightLbs = w / 16;
            } else if (unit.includes("gram") || unit === "g") {
              weightLbs = w / 453.592;
            } else if (unit.includes("kilogram") || unit === "kg") {
              weightLbs = w * 2.20462;
            } else {
              weightLbs = w;
            }
            break;
          }
        }
      }
    }

    if (weightLbs === null && data?.attributes?.item_weight) {
      const iw = data.attributes.item_weight[0];
      if (iw) {
        const w = parseFloat(iw.value);
        const unit = (iw.unit || "").toLowerCase();
        if (!isNaN(w)) {
          if (unit.includes("pound") || unit === "lb" || unit === "lbs") {
            weightLbs = w;
          } else if (unit.includes("ounce") || unit === "oz") {
            weightLbs = w / 16;
          } else if (unit.includes("gram") || unit === "g") {
            weightLbs = w / 453.592;
          } else if (unit.includes("kilogram") || unit === "kg") {
            weightLbs = w * 2.20462;
          } else {
            weightLbs = w;
          }
        }
      }
    }

    return { weightLbs: weightLbs ?? 1, title, imageUrl, bsrRank, bsrCategory };
  } catch (err: any) {
    log(`Catalog API error for ${asin}: ${err.message}`, "sp-api");
    return { weightLbs: 1, title: null, imageUrl: null, bsrRank: null, bsrCategory: null };
  }
}
