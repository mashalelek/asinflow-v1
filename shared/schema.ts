import { z } from "zod";

export const settingsSchema = z.object({
  inboundShippingCost: z.number().min(0).default(0.5),
  prepCost: z.number().min(0).default(0),
  storageFee: z.number().min(0).default(0),
  lowInventorySurcharge: z.number().min(0).default(0.26),
  minRoiThreshold: z.number().min(0).default(15),
  minMarginThreshold: z.number().min(0).default(10),
});

export type Settings = z.infer<typeof settingsSchema>;

export interface AsinInput {
  asin: string;
  cogs: number;
  buyLink?: string | null;
  prepOverride?: number | null;
  storageOverride?: number | null;
}

export interface PricingData {
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

export interface FeesData {
  fbaFulfillmentFee: number | null;
  referralFee: number | null;
  feesEstimatePrice: number | null;
}

export interface CatalogData {
  weightLbs: number | null;
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  bsrRank: number | null;
  bsrCategory: string | null;
}

export interface EligibilityData {
  status: "yes" | "no" | "check";
}

export interface AsinResult {
  asin: string;
  cogs: number;
  buyLink: string | null;
  prepOverride: number | null;
  storageOverride: number | null;
  pricingData: PricingData;
  feesData: FeesData;
  catalogData: CatalogData;
  eligibilityData: EligibilityData;
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

export interface ColumnMapping {
  asin: string;
  cogs: string;
  buyLink: string | null;
  prepCost: string | null;
  additionalFees: string | null;
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

  if (pricingData.lowestFbaPrice != null) {
    return { price: pricingData.lowestFbaPrice, label: "Lowest FBA" };
  }
  if (pricingData.buyBoxPrice != null) {
    return { price: pricingData.buyBoxPrice, label: "Buy Box" };
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

export function getEffectivePrep(result: AsinResult, settings: Settings): { value: number; isOverride: boolean } {
  if (result.prepOverride != null) {
    return { value: result.prepOverride, isOverride: true };
  }
  return { value: settings.prepCost, isOverride: false };
}

export function getEffectiveStorage(result: AsinResult, settings: Settings): { value: number; isOverride: boolean } {
  if (result.storageOverride != null) {
    return { value: result.storageOverride, isOverride: true };
  }
  return { value: settings.storageFee, isOverride: false };
}

export function calculateProfit(
  salePrice: number,
  cogs: number,
  fbaFee: number,
  referralFee: number,
  feesEstimatePrice: number | null,
  weightLbs: number | null,
  prepCost: number,
  storageFee: number,
  settings: Settings
): {
  profit: number;
  roi: number;
  margin: number;
  inboundShipping: number | null;
  weightMissing: boolean;
  adjustedReferralFee: number;
  totalFbaFee: number;
} {
  let adjustedReferralFee = referralFee;
  if (feesEstimatePrice && feesEstimatePrice > 0 && salePrice !== feesEstimatePrice) {
    const referralPct = referralFee / feesEstimatePrice;
    adjustedReferralFee = parseFloat((referralPct * salePrice).toFixed(2));
  }

  const weightMissing = weightLbs == null || weightLbs <= 0;
  const inboundShipping = weightMissing ? null : weightLbs * settings.inboundShippingCost;
  const totalFbaFee = fbaFee + settings.lowInventorySurcharge;
  const profit =
    salePrice -
    cogs -
    totalFbaFee -
    adjustedReferralFee -
    (inboundShipping ?? 0) -
    prepCost -
    storageFee;

  const roi = cogs > 0 ? (profit / cogs) * 100 : 0;
  const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;

  return { profit, roi, margin, inboundShipping, weightMissing, adjustedReferralFee, totalFbaFee };
}

export function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export const DEFAULT_COLUMNS = [
  "asin", "image", "name", "brand", "eligible", "supplier", "cogs", "salePrice", "profit", "margin", "roi",
  "fbaFee", "referralFee", "inboundShipping", "prep", "storage", "bsr",
  "sellersFba", "sellersFbm",
] as const;

export type ColumnId = (typeof DEFAULT_COLUMNS)[number];

export interface ColumnDef {
  id: ColumnId;
  label: string;
  defaultVisible: boolean;
  align: "left" | "right";
}

export const ALL_COLUMNS: ColumnDef[] = [
  { id: "asin", label: "ASIN", defaultVisible: true, align: "left" },
  { id: "image", label: "Image", defaultVisible: true, align: "left" },
  { id: "name", label: "Product Name", defaultVisible: true, align: "left" },
  { id: "brand", label: "Brand", defaultVisible: true, align: "left" },
  { id: "eligible", label: "Eligible", defaultVisible: true, align: "left" },
  { id: "supplier", label: "Supplier", defaultVisible: true, align: "left" },
  { id: "cogs", label: "COGS", defaultVisible: true, align: "right" },
  { id: "salePrice", label: "Sale Price", defaultVisible: true, align: "right" },
  { id: "profit", label: "Profit/Unit", defaultVisible: true, align: "right" },
  { id: "margin", label: "Margin", defaultVisible: true, align: "right" },
  { id: "roi", label: "ROI", defaultVisible: true, align: "right" },
  { id: "fbaFee", label: "FBA Fee", defaultVisible: true, align: "right" },
  { id: "referralFee", label: "Referral Fee", defaultVisible: true, align: "right" },
  { id: "inboundShipping", label: "Inbound Ship.", defaultVisible: true, align: "right" },
  { id: "prep", label: "Prep Cost", defaultVisible: false, align: "right" },
  { id: "storage", label: "Additional Fees", defaultVisible: false, align: "right" },
  { id: "bsr", label: "BSR", defaultVisible: true, align: "right" },
  { id: "sellersFba", label: "Sellers (FBA)", defaultVisible: true, align: "right" },
  { id: "sellersFbm", label: "Sellers (FBM)", defaultVisible: true, align: "right" },
];

export const users = undefined;
export type InsertUser = any;
export type User = any;
