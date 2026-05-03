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
  cogs: number; // deprecated — use estimatedCogs / actualCogs
  estimatedCogs: number | null;
  estimatedCogsSource?: "manual" | "po_sheet" | null;
  actualCogs: number | null;
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
  cogsSource?: "po_sheet" | "manual" | null;
  pricesFetchedAt?: string | null;
  lastReviewedAt?: string | null;
  addedAt?: string | null;
  category?: string | null;
  isWholesale?: boolean;
  isOa?: boolean;
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

/**
 * Estimated prep cost — always uses the settings default.
 * PO-sourced prep cost (prepOverride) is only used for Actual Prep Cost
 * (read directly via result.prepOverride), not for Estimated calculations.
 * Rationale: prep cost is operationally-determined (current prep arrangement),
 * not historical. Old POs may have $0 from self-prepping.
 */
export function getEffectivePrep(_result: AsinResult, settings: Settings): { value: number; isOverride: boolean } {
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
  // Group 1 — Description
  "product", "category", "brand", "supplier",
  // Group 2 — Stock
  "stock", "availableFba", "ordered", "reserved", "sentToFba", "daysLeft",
  // Group 3 — Actuals
  "cogs", "actPrepCost", "actUnitsSold", "actRefunds", "actRefundPct",
  "actAvgSalePrice", "actRevenue", "actProfit", "actProfitPerUnit", "actRoi", "actMargin",
  // Group 4 — Estimates
  "estCogs", "prep", "salePrice", "profit", "margin", "roi",
  "fbaFee", "referralFee", "inboundShipping", "storage", "maxCogs",
  // Group 5 — Sellers
  "sellersFba", "sellers", "sellers7d", "sellers30d", "fba7d", "fba30d",
  // Group 6 — Additional info
  "tags", "notes", "sourcing", "meltable", "hazmat", "suppressed", "dateAdded",
] as const;

export type ColumnId = (typeof DEFAULT_COLUMNS)[number];

export type ColumnGroup = "description" | "stock" | "actuals" | "estimates" | "sellers" | "additional";

export interface ColumnDef {
  id: ColumnId;
  label: string;
  qualifier?: "Actual" | "Estimated";
  defaultVisible: boolean;
  align: "left" | "right";
  group: ColumnGroup;
}

export const COLUMN_GROUPS: { key: ColumnGroup; label: string }[] = [
  { key: "description", label: "Description" },
  { key: "stock", label: "Stock" },
  { key: "actuals", label: "Actuals" },
  { key: "estimates", label: "Estimates" },
  { key: "sellers", label: "Sellers" },
  { key: "additional", label: "Additional Info" },
];

export const ALL_COLUMNS: ColumnDef[] = [
  // Group 1 — Description
  { id: "product", label: "Product", defaultVisible: true, align: "left", group: "description" },
  { id: "category", label: "Category", defaultVisible: false, align: "left", group: "description" },
  { id: "brand", label: "Brand", defaultVisible: true, align: "left", group: "description" },
  { id: "supplier", label: "Supplier", defaultVisible: true, align: "left", group: "description" },
  // Group 2 — Stock
  { id: "stock", label: "Stock", defaultVisible: true, align: "right", group: "stock" },
  { id: "availableFba", label: "Available (FBA)", defaultVisible: false, align: "right", group: "stock" },
  { id: "ordered", label: "Ordered", defaultVisible: false, align: "right", group: "stock" },
  { id: "reserved", label: "Reserved", defaultVisible: false, align: "right", group: "stock" },
  { id: "sentToFba", label: "Sent to FBA", defaultVisible: false, align: "right", group: "stock" },
  { id: "daysLeft", label: "Days Left", defaultVisible: true, align: "right", group: "stock" },
  // Group 3 — Actuals
  { id: "cogs", label: "COGS", qualifier: "Actual", defaultVisible: false, align: "right", group: "actuals" },
  { id: "actPrepCost", label: "Prep Cost", qualifier: "Actual", defaultVisible: false, align: "right", group: "actuals" },
  { id: "actUnitsSold", label: "Units Sold", qualifier: "Actual", defaultVisible: true, align: "right", group: "actuals" },
  { id: "actRefunds", label: "Refunds", qualifier: "Actual", defaultVisible: true, align: "right", group: "actuals" },
  { id: "actRefundPct", label: "Refund %", qualifier: "Actual", defaultVisible: false, align: "right", group: "actuals" },
  { id: "actAvgSalePrice", label: "Avg. Sale Price", qualifier: "Actual", defaultVisible: false, align: "right", group: "actuals" },
  { id: "actRevenue", label: "Revenue", qualifier: "Actual", defaultVisible: true, align: "right", group: "actuals" },
  { id: "actProfit", label: "Total Profit", qualifier: "Actual", defaultVisible: true, align: "right", group: "actuals" },
  { id: "actProfitPerUnit", label: "Profit/Unit", qualifier: "Actual", defaultVisible: true, align: "right", group: "actuals" },
  { id: "actRoi", label: "ROI", qualifier: "Actual", defaultVisible: true, align: "right", group: "actuals" },
  { id: "actMargin", label: "Margin", qualifier: "Actual", defaultVisible: true, align: "right", group: "actuals" },
  // Group 4 — Estimates
  { id: "estCogs", label: "COGS", qualifier: "Estimated", defaultVisible: false, align: "right", group: "estimates" },
  { id: "prep", label: "Prep Cost", qualifier: "Estimated", defaultVisible: false, align: "right", group: "estimates" },
  { id: "salePrice", label: "Sale Price", qualifier: "Estimated", defaultVisible: true, align: "right", group: "estimates" },
  { id: "profit", label: "Profit/Unit", qualifier: "Estimated", defaultVisible: true, align: "right", group: "estimates" },
  { id: "roi", label: "ROI", qualifier: "Estimated", defaultVisible: true, align: "right", group: "estimates" },
  { id: "margin", label: "Margin", qualifier: "Estimated", defaultVisible: true, align: "right", group: "estimates" },
  { id: "fbaFee", label: "FBA Fee", qualifier: "Estimated", defaultVisible: false, align: "right", group: "estimates" },
  { id: "referralFee", label: "Referral Fee", qualifier: "Estimated", defaultVisible: false, align: "right", group: "estimates" },
  { id: "inboundShipping", label: "Inbound Ship.", qualifier: "Estimated", defaultVisible: false, align: "right", group: "estimates" },
  { id: "storage", label: "Additional Fees", qualifier: "Estimated", defaultVisible: false, align: "right", group: "estimates" },
  { id: "maxCogs", label: "Max COGS", defaultVisible: false, align: "right", group: "estimates" },
  // Group 5 — Sellers
  { id: "sellersFba", label: "FBA Sellers", defaultVisible: true, align: "right", group: "sellers" },
  { id: "sellers", label: "Sellers", defaultVisible: false, align: "right", group: "sellers" },
  { id: "sellers7d", label: "Sellers 7d \u0394", defaultVisible: false, align: "right", group: "sellers" },
  { id: "sellers30d", label: "Sellers 30d \u0394", defaultVisible: false, align: "right", group: "sellers" },
  { id: "fba7d", label: "FBA 7d \u0394", defaultVisible: true, align: "right", group: "sellers" },
  { id: "fba30d", label: "FBA 30d \u0394", defaultVisible: false, align: "right", group: "sellers" },
  // Group 6 — Additional info
  { id: "tags", label: "Tags", defaultVisible: true, align: "left", group: "additional" },
  { id: "notes", label: "Notes", defaultVisible: true, align: "left", group: "additional" },
  { id: "sourcing", label: "Sourcing", defaultVisible: false, align: "left", group: "additional" },
  { id: "meltable", label: "Meltable", defaultVisible: false, align: "left", group: "additional" },
  { id: "hazmat", label: "Hazmat", defaultVisible: false, align: "left", group: "additional" },
  { id: "suppressed", label: "Suppressed", defaultVisible: false, align: "left", group: "additional" },
  { id: "dateAdded", label: "Date Added", defaultVisible: false, align: "left", group: "additional" },
];

export const users = undefined;
export type InsertUser = any;
export type User = any;
