import { z } from "zod";

export const settingsSchema = z.object({
  inboundShippingCost: z.number().min(0).default(0.5),
  prepCost: z.number().min(0).default(0),
  storageFee: z.number().min(0).default(0),
  minRoiThreshold: z.number().min(0).default(15),
  minMarginThreshold: z.number().min(0).default(10),
});

export type Settings = z.infer<typeof settingsSchema>;

export interface AsinInput {
  asin: string;
  cogs: number;
}

export interface PricingData {
  lowestFbaPrice: number | null;
  buyBoxPrice: number | null;
  buyBoxFulfillment: "FBA" | "FBM" | null;
  lowestPrice: number | null;
  avg30DayPrice: number | null;
  avg90DayPrice: number | null;
  numberOfSellers: number | null;
}

export interface FeesData {
  fbaFulfillmentFee: number | null;
  referralFee: number | null;
  feesEstimatePrice: number | null;
}

export interface CatalogData {
  weightLbs: number | null;
  title: string | null;
}

export interface AsinResult {
  asin: string;
  cogs: number;
  pricingData: PricingData;
  feesData: FeesData;
  catalogData: CatalogData;
  error: string | null;
}

export type PriceSource = "lowestFba" | "buyBox";

export interface AnalyzeRequest {
  asins: AsinInput[];
}

export interface AnalyzeResponse {
  results: AsinResult[];
  totalProcessed: number;
  totalErrors: number;
}

export interface ProgressUpdate {
  current: number;
  total: number;
  asin: string;
}

export function getSelectedPrice(
  result: AsinResult,
  priceSource: PriceSource
): { price: number | null; label: string } {
  const { pricingData } = result;

  if (priceSource === "lowestFba") {
    if (pricingData.lowestFbaPrice != null) {
      return { price: pricingData.lowestFbaPrice, label: "Lowest FBA" };
    }
  } else if (priceSource === "buyBox") {
    if (pricingData.buyBoxPrice != null) {
      const fulfillment = pricingData.buyBoxFulfillment ?? "FBA";
      return {
        price: pricingData.buyBoxPrice,
        label: `BB (${fulfillment})`,
      };
    }
  }

  if (pricingData.lowestPrice != null) {
    return { price: pricingData.lowestPrice, label: "Lowest" };
  }
  if (pricingData.avg30DayPrice != null) {
    return { price: pricingData.avg30DayPrice, label: "30d Avg" };
  }
  if (pricingData.avg90DayPrice != null) {
    return { price: pricingData.avg90DayPrice, label: "90d Avg" };
  }
  return { price: null, label: "Not Available" };
}

export function calculateProfit(
  salePrice: number,
  cogs: number,
  fbaFee: number,
  referralFee: number,
  feesEstimatePrice: number | null,
  weightLbs: number,
  settings: Settings
): {
  profit: number;
  roi: number;
  margin: number;
  inboundShipping: number;
  adjustedReferralFee: number;
} {
  let adjustedReferralFee = referralFee;
  if (feesEstimatePrice && feesEstimatePrice > 0 && salePrice !== feesEstimatePrice) {
    const referralPct = referralFee / feesEstimatePrice;
    adjustedReferralFee = parseFloat((referralPct * salePrice).toFixed(2));
  }

  const inboundShipping = weightLbs * settings.inboundShippingCost;
  const profit =
    salePrice -
    cogs -
    fbaFee -
    adjustedReferralFee -
    inboundShipping -
    settings.prepCost -
    settings.storageFee;

  const roi = cogs > 0 ? (profit / cogs) * 100 : 0;
  const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;

  return { profit, roi, margin, inboundShipping, adjustedReferralFee };
}

export const users = undefined;
export type InsertUser = any;
export type User = any;
