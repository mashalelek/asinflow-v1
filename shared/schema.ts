import { z } from "zod";

export const settingsSchema = z.object({
  inboundShippingCost: z.number().min(0).default(0.5),
  prepCost: z.number().min(0).default(0),
  storageFee: z.number().min(0).default(0),
  lowInventorySurcharge: z.number().min(0).default(0.26),
  hazmatShipSurcharge: z.number().min(0).default(0),
  hazmatPrepSurcharge: z.number().min(0).default(0),
  minRoiThreshold: z.number().min(0).default(15),
  minMarginThreshold: z.number().min(0).default(10),
  maxCogsMinMarginPct: z.number().min(0).default(12),
  maxCogsMinRoiPct: z.number().min(0).default(20),
  maxCogsMinProfitUnit: z.number().min(0).default(3),
});

export type Settings = z.infer<typeof settingsSchema>;

export interface AsinInput {
  asin: string;
  cogs: number;
  buyLink?: string | null;
  prepOverride?: number | null;
  storageOverride?: number | null;
  tags?: string[] | null;
  notes?: string | null;
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
  isMeltable?: boolean;
  isHazmat?: boolean;
}

export interface EligibilityData {
  status: "yes" | "no" | "check";
}

export interface StockData {
  available_fba: number;
  reserved: number;
  inbound: number;
  ordered: number;
  total: number;
}

export interface ActualsData {
  units_sold: number;
  revenue: number;
  units_refunded: number;
  refund_amount: number;
  days_with_sales: number;
  days_in_stock: number;
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
  stock?: StockData | null;
  actuals?: ActualsData | null;
  sku?: string | null;
  skus?: string[];
  inCatalog?: boolean;
  tags?: { name: string; color: string }[];
  notes?: string | null;
  isArchived?: boolean;
  isMeltable?: boolean;
  isHazmat?: boolean;
  isSearchSuppressed?: boolean;
  suppressionReasons?: string[];
  cogsSource?: "po_sheet" | "csv" | "manual" | null;
  pricesFetchedAt?: string | null;
  lastReviewedAt?: string | null;
  addedAt?: string | null;
  category?: string | null;
  sellersDelta?: {
    fba_7d: number | null;
    fba_30d: number | null;
    fbm_7d: number | null;
    fbm_30d: number | null;
  } | null;
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
  tags: string | null;
  notes: string | null;
}

export function getSelectedPrice(
  result: AsinResult,
  priceSource: PriceSource
): { price: number | null; label: string; isFallback: boolean } {
  const { pricingData } = result;

  if (priceSource === "lowestFba") {
    // Strict priority: FBA price first
    if (pricingData.lowestFbaPrice != null) {
      return { price: pricingData.lowestFbaPrice, label: "Lowest FBA", isFallback: false };
    }
    // Fallback: Buy Box (warn user it's not FBA)
    if (pricingData.buyBoxPrice != null) {
      return { price: pricingData.buyBoxPrice, label: "BB (no FBA)", isFallback: true };
    }
    // Fallback: any lowest offer
    if (pricingData.lowestPrice != null) {
      return { price: pricingData.lowestPrice, label: "Lowest (no FBA)", isFallback: true };
    }
  } else if (priceSource === "buyBox") {
    if (pricingData.buyBoxPrice != null) {
      const fulfillment = pricingData.buyBoxFulfillment ?? "FBA";
      return { price: pricingData.buyBoxPrice, label: `BB (${fulfillment})`, isFallback: false };
    }
    // Fallback
    if (pricingData.lowestFbaPrice != null) {
      return { price: pricingData.lowestFbaPrice, label: "Lowest FBA", isFallback: true };
    }
    if (pricingData.lowestPrice != null) {
      return { price: pricingData.lowestPrice, label: "Lowest", isFallback: true };
    }
  }

  return { price: null, label: "Not Available", isFallback: false };
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
  settings: Settings,
  includeInboundShipping = true,
  isHazmat = false
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

  const hazmatShipExtra = isHazmat ? (settings.hazmatShipSurcharge ?? 0) : 0;
  const hazmatPrepExtra = isHazmat ? (settings.hazmatPrepSurcharge ?? 0) : 0;

  const weightMissing = weightLbs == null || weightLbs <= 0;
  const inboundShipping = weightMissing ? null : weightLbs * settings.inboundShippingCost + hazmatShipExtra;
  const totalFbaFee = fbaFee + settings.lowInventorySurcharge;
  const effectivePrep = prepCost + hazmatPrepExtra;
  const inboundCost = includeInboundShipping ? (inboundShipping ?? 0) : 0;
  const profit =
    salePrice -
    cogs -
    totalFbaFee -
    adjustedReferralFee -
    inboundCost -
    effectivePrep -
    storageFee;

  const roi = cogs > 0 ? (profit / cogs) * 100 : 0;
  const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;

  return { profit, roi, margin, inboundShipping, weightMissing, adjustedReferralFee, totalFbaFee };
}

/**
 * Calculate the maximum COGS at which all three profitability criteria are
 * simultaneously met: margin >= M%, ROI >= R%, profit/unit >= $P.
 *
 * Returns null if any required input (price, fees) is missing.
 */
export function calculateMaxCogs(
  salePrice: number | null,
  fbaFee: number | null,
  referralFee: number | null,
  feesEstimatePrice: number | null,
  weightLbs: number | null,
  prepCost: number,
  storageFee: number,
  settings: Settings,
  includeInboundShipping: boolean,
  isHazmat: boolean,
): number | null {
  if (salePrice == null || salePrice <= 0) return null;
  if (fbaFee == null || referralFee == null) return null;

  // Adjust referral fee proportionally if the fee estimate was based on a different price
  let adjReferralFee = referralFee;
  if (feesEstimatePrice && feesEstimatePrice > 0 && salePrice !== feesEstimatePrice) {
    adjReferralFee = parseFloat(((referralFee / feesEstimatePrice) * salePrice).toFixed(2));
  }

  const hazmatShipExtra = isHazmat ? (settings.hazmatShipSurcharge ?? 0) : 0;
  const hazmatPrepExtra = isHazmat ? (settings.hazmatPrepSurcharge ?? 0) : 0;
  const totalFbaFee = fbaFee + settings.lowInventorySurcharge;
  const effectivePrep = prepCost + hazmatPrepExtra;
  const inboundCost = includeInboundShipping
    ? ((weightLbs != null && weightLbs > 0) ? weightLbs * settings.inboundShippingCost + hazmatShipExtra : hazmatShipExtra)
    : 0;

  const totalFees = totalFbaFee + adjReferralFee + inboundCost + effectivePrep + storageFee;

  const M = settings.maxCogsMinMarginPct / 100;
  const R = settings.maxCogsMinRoiPct / 100;
  const P = settings.maxCogsMinProfitUnit;

  // Constraint A — margin: cogs <= salePrice * (1 - M) - totalFees
  const maxA = salePrice * (1 - M) - totalFees;
  // Constraint B — ROI: cogs <= (salePrice - totalFees) / (1 + R)
  const maxB = (salePrice - totalFees) / (1 + R);
  // Constraint C — profit/unit: cogs <= salePrice - totalFees - P
  const maxC = salePrice - totalFees - P;

  return parseFloat(Math.min(maxA, maxB, maxC).toFixed(2));
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
  "product",
  "brand", "supplier",
  "stock", "daysLeft",
  "salePrice", "cogs", "profit", "margin", "roi",
  "fbaFee", "referralFee", "inboundShipping", "prep", "storage", "bsr",
  "sellersFba", "sellersFbm",
  "fba7d", "fba30d", "fbm7d", "fbm30d",
  "actUnitsSold", "actRevenue", "actRefunds", "actRefundPct",
  "actProfit", "actProfitPerUnit", "actMargin", "actRoi",
  "tags", "notes",
  "meltable", "hazmat", "suppressed",
  "lastReviewed",
  "dateAdded",
  "category",
  "maxCogs",
] as const;

export type ColumnId = (typeof DEFAULT_COLUMNS)[number];

export interface ColumnDef {
  id: ColumnId;
  label: string;
  defaultVisible: boolean;
  align: "left" | "right";
}

export const ALL_COLUMNS: ColumnDef[] = [
  // No group
  { id: "product", label: "Product", defaultVisible: true, align: "left" },
  { id: "brand", label: "Brand", defaultVisible: true, align: "left" },
  { id: "supplier", label: "Supplier", defaultVisible: true, align: "left" },
  { id: "stock", label: "Stock", defaultVisible: true, align: "right" },
  { id: "daysLeft", label: "Days Left", defaultVisible: true, align: "right" },
  // Estimates group
  { id: "salePrice", label: "Sale Price", defaultVisible: true, align: "right" },
  { id: "cogs", label: "COGS", defaultVisible: false, align: "right" },
  { id: "profit", label: "Profit/Unit", defaultVisible: true, align: "right" },
  { id: "margin", label: "Margin", defaultVisible: true, align: "right" },
  { id: "roi", label: "ROI", defaultVisible: true, align: "right" },
  { id: "fbaFee", label: "FBA Fee", defaultVisible: false, align: "right" },
  { id: "referralFee", label: "Referral Fee", defaultVisible: false, align: "right" },
  { id: "inboundShipping", label: "Inbound Ship.", defaultVisible: false, align: "right" },
  { id: "prep", label: "Prep Cost", defaultVisible: false, align: "right" },
  { id: "storage", label: "Additional Fees", defaultVisible: false, align: "right" },
  { id: "bsr", label: "BSR", defaultVisible: false, align: "right" },
  { id: "sellersFba", label: "Sellers (FBA)", defaultVisible: true, align: "right" },
  { id: "sellersFbm", label: "Sellers (FBM)", defaultVisible: true, align: "right" },
  { id: "fba7d", label: "FBA 7d Δ", defaultVisible: true, align: "right" },
  { id: "fba30d", label: "FBA 30d Δ", defaultVisible: false, align: "right" },
  { id: "fbm7d", label: "FBM 7d Δ", defaultVisible: false, align: "right" },
  { id: "fbm30d", label: "FBM 30d Δ", defaultVisible: false, align: "right" },
  // Actuals group
  { id: "actUnitsSold", label: "Units Sold", defaultVisible: true, align: "right" },
  { id: "actRevenue", label: "Revenue", defaultVisible: true, align: "right" },
  { id: "actRefunds", label: "Refunds", defaultVisible: true, align: "right" },
  { id: "actRefundPct", label: "Refund %", defaultVisible: false, align: "right" },
  { id: "actProfit", label: "Total Profit", defaultVisible: true, align: "right" },
  { id: "actProfitPerUnit", label: "Profit/Unit", defaultVisible: true, align: "right" },
  { id: "actMargin", label: "Margin %", defaultVisible: true, align: "right" },
  { id: "actRoi", label: "ROI %", defaultVisible: true, align: "right" },
  // No group
  { id: "tags", label: "Tags", defaultVisible: true, align: "left" },
  { id: "notes", label: "Notes", defaultVisible: true, align: "left" },
  { id: "meltable", label: "Meltable", defaultVisible: false, align: "left" },
  { id: "hazmat", label: "Hazmat", defaultVisible: false, align: "left" },
  { id: "suppressed", label: "Suppressed", defaultVisible: false, align: "left" },
  { id: "lastReviewed", label: "Last Reviewed", defaultVisible: false, align: "left" },
  { id: "dateAdded", label: "Date Added", defaultVisible: false, align: "left" },
  { id: "category", label: "Category", defaultVisible: false, align: "left" },
  { id: "maxCogs", label: "Max COGS", defaultVisible: false, align: "right" },
];

export const users = undefined;
export type InsertUser = any;
export type User = any;
