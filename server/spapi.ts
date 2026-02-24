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
  lowestPrice: number | null;
  avg30DayPrice: number | null;
  avg90DayPrice: number | null;
  numberOfSellers: number | null;
}

export interface AsinFeesResult {
  fbaFulfillmentFee: number | null;
  referralFee: number | null;
}

export interface AsinCatalogResult {
  weightLbs: number | null;
  title: string | null;
}

export async function getPricing(asin: string): Promise<AsinPricingResult> {
  let lowestFbaPrice: number | null = null;
  let buyBoxPrice: number | null = null;
  let lowestPrice: number | null = null;
  let numberOfSellers: number | null = null;

  try {
    const offersData = await spApiGet(`/products/pricing/v0/items/${asin}/offers`, {
      MarketplaceId: "ATVPDKIKX0DER",
      ItemCondition: "New",
    });

    const summary = offersData?.payload?.Summary;
    if (summary) {
      if (summary.BuyBoxPrices) {
        for (const bp of summary.BuyBoxPrices) {
          if (bp.condition === "New") {
            const amt = parseFloat(bp.LandedPrice?.Amount);
            if (!isNaN(amt)) buyBoxPrice = amt;
          }
        }
      }

      if (summary.LowestPrices) {
        for (const lp of summary.LowestPrices) {
          const amt = parseFloat(lp.LandedPrice?.Amount);
          if (!isNaN(amt)) {
            if (lp.fulfillmentChannel === "Amazon") {
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
      } else if (summary.NumberOfOffers) {
        let total = 0;
        for (const entry of summary.NumberOfOffers) {
          if (entry.condition === "New" || entry.Condition === "New") {
            total += parseInt(entry.OfferCount ?? entry.Value ?? "0") || 0;
          }
        }
        if (total > 0) numberOfSellers = total;
      }
    }

    const offers = offersData?.payload?.Offers;
    if (offers && Array.isArray(offers)) {
      if (numberOfSellers === null) {
        numberOfSellers = offers.length;
      }

      for (const offer of offers) {
        const amt = parseFloat(offer.ListingPrice?.Amount);
        if (isNaN(amt)) continue;
        const shipping = parseFloat(offer.Shipping?.Amount) || 0;
        const landed = amt + shipping;

        if (offer.IsFulfilledByAmazon === true || offer.FulfillmentChannel === "Amazon") {
          if (lowestFbaPrice === null || landed < lowestFbaPrice) {
            lowestFbaPrice = landed;
          }
        }
        if (lowestPrice === null || landed < lowestPrice) {
          lowestPrice = landed;
        }
        if (offer.IsBuyBoxWinner === true && buyBoxPrice === null) {
          buyBoxPrice = landed;
        }
      }
    }

    return {
      lowestFbaPrice,
      buyBoxPrice,
      lowestPrice,
      avg30DayPrice: null,
      avg90DayPrice: null,
      numberOfSellers,
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
        lowestPrice,
        avg30DayPrice: null,
        avg90DayPrice: null,
        numberOfSellers,
      };
    } catch (innerErr: any) {
      log(`Competitive Pricing fallback also failed for ${asin}: ${innerErr.message}`, "sp-api");
      return {
        lowestFbaPrice: null,
        buyBoxPrice: null,
        lowestPrice: null,
        avg30DayPrice: null,
        avg90DayPrice: null,
        numberOfSellers: null,
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

    return { fbaFulfillmentFee, referralFee };
  } catch (err: any) {
    log(`Fees API error for ${asin}: ${err.message}`, "sp-api");
    return { fbaFulfillmentFee: null, referralFee: null };
  }
}

export async function getCatalogData(asin: string): Promise<AsinCatalogResult> {
  try {
    const data = await spApiGet(`/catalog/2022-04-01/items/${asin}`, {
      marketplaceIds: "ATVPDKIKX0DER",
      includedData: "attributes,dimensions",
    });

    let weightLbs: number | null = null;
    let title: string | null = null;

    if (data?.title) {
      title = data.title;
    }
    if (data?.attributes?.item_name?.[0]?.value) {
      title = data.attributes.item_name[0].value;
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

    return { weightLbs: weightLbs ?? 1, title };
  } catch (err: any) {
    log(`Catalog API error for ${asin}: ${err.message}`, "sp-api");
    return { weightLbs: 1, title: null };
  }
}
