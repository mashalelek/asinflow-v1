// The Finances model (docs/claude_spec-patch-finances-api.md §1, §2): the
// SellerBoard lines AF stores and shows, line for line, in the fixture's names,
// order and groups (docs/claude_finances-sb-fixture.md). Shared by the ingest's
// classifier (server/finances.ts), the aggregate (server/finances-aggregate.ts),
// the API and the breakdown panel.

/** The fixed line keys; a fee type or reimbursement reason AF has not seen before becomes `svc:<Type>` / `reimb:<REASON>` / `other:<Type>` and is shown under its Amazon name (§2). */
export type FinancesLine =
  | "sales" | "units" | "orders" | "refunds" | "promo" | "advertising"
  | "refund_amount" | "refund_commission" | "refund_customer_return_fee" | "restocking" | "refund_vcf" | "refunded_referral" | "returned_value"
  | "fba_fee" | "referral_fee" | "vcf"
  | "cogs" | "prep" | "disposal_value" | "lost_damaged"
  | "shipping" | "tax"
  | "returns_units" | "returns_sellable"
  | `svc:${string}` | `reimb:${string}` | `fee:${string}` | `refund_fee:${string}` | `other:${string}`;

export type FinancesGroup = "top" | "refund_cost" | "amazon_fees" | "cost_of_goods" | "hidden";

/** SB's names for the keys with a fixed name; `svc:` / `reimb:` keys fall back to REASON_LABELS / SERVICE_FEE_LABELS, then the Amazon name. */
export const LINE_LABELS: Record<string, string> = {
  sales: "Sales", units: "Units", orders: "Orders", refunds: "Refunds", promo: "Promo", advertising: "Advertising cost",
  refund_amount: "Refunded amount", refund_commission: "Refund commission", refund_customer_return_fee: "FBA customer return per unit fee",
  restocking: "RestockingDeductionPrincipal", refund_vcf: "Variable Closing Fee", refunded_referral: "Refunded referral fee", returned_value: "Value of returned items",
  fba_fee: "FBA per unit fulfilment fee", referral_fee: "Referral fee", vcf: "Variable Closing Fee",
  cogs: "COGS", prep: "Prep", disposal_value: "Disposal of sellable products", lost_damaged: "Lost/damaged by Amazon",
};

/** ServiceFee `description` → SB's line name. */
export const SERVICE_FEE_LABELS: Record<string, string> = {
  FBACustomerReturn: "FBA customer return per unit fee",
  FBAPostInboundTransportation: "Inbound transportation",
  FBAInboundTransportation: "Inbound transportation",
  FBAInboundConvenience: "FBA inbound convenience fee",
  FBAStorageBilling: "FBA storage fee",
  FBALongTermStorageBilling: "FBA long-term storage fee",
  FBARemoval: "FBA removal fee",
  FBADisposal: "FBA disposal fee",
  Subscription: "Subscription",
};

/** FBAInventoryReimbursement reasons → SB's line name (the cash lines inside Amazon fees). */
export const REASON_LABELS: Record<string, string> = {
  WAREHOUSE_LOST: "Warehouse lost",
  WAREHOUSE_DAMAGE: "Warehouse damage",
  MISSING_FROM_INBOUND: "Missing from inbound",
  REMOVAL_ORDER_LOST: "Removal order lost",
  CRETURN_WRONG_ITEM: "Creturn wrong item",
  FREE_REPLACEMENT_REFUND_ITEMS: "Free replacement refund items",
  REVERSAL_REIMBURSEMENT: "Reversal reimbursement",
  COMPENSATED_CLAWBACK: "Compensated clawback",
  MISSING_FROM_INBOUND_CLAWBACK: "Missing from inbound clawback",
};

/** Lost/damaged by Amazon (§2): the reasons valued at −(COGS + Prep) per unit and the clawbacks valued at +(COGS + Prep). Other reasons: cash only. */
export const LOST_REASONS: readonly string[] = ["WAREHOUSE_LOST", "WAREHOUSE_DAMAGE", "MISSING_FROM_INBOUND"];
export const FOUND_REASONS: readonly string[] = ["COMPENSATED_CLAWBACK", "MISSING_FROM_INBOUND_CLAWBACK"];

/** A line's group (§1). */
export function groupOf(line: string): FinancesGroup {
  switch (line) {
    case "sales": case "units": case "orders": case "refunds": case "promo": case "advertising": return "top";
    case "refund_amount": case "refund_commission": case "refund_customer_return_fee": case "restocking": case "refund_vcf": case "refunded_referral": case "returned_value": return "refund_cost";
    case "fba_fee": case "referral_fee": case "vcf": return "amazon_fees";
    case "cogs": case "prep": case "disposal_value": case "lost_damaged": return "cost_of_goods";
    case "shipping": case "tax": case "returns_units": case "returns_sellable": return "hidden";
  }
  if (line.startsWith("refund_fee:")) return "refund_cost";
  if (line === "svc:FBACustomerReturn") return "refund_cost";
  if (line.startsWith("svc:") || line.startsWith("reimb:") || line.startsWith("fee:") || line.startsWith("other:")) return "amazon_fees";
  return "amazon_fees";
}

/** The name shown for a line: SB's where it has one, else the Amazon type / reason as is. */
export function labelOf(line: string): string {
  if (LINE_LABELS[line]) return LINE_LABELS[line];
  const [kind, rest] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)];
  if (kind === "svc") return SERVICE_FEE_LABELS[rest] ?? rest;
  if (kind === "reimb") return REASON_LABELS[rest] ?? rest;
  if (kind === "refund_fee" || kind === "fee" || kind === "other") return rest;
  return line;
}

/**
 * Classify one breakdown leaf of a Shipment or Refund item (§2). `leafPath` is
 * the breakdown types joined by " > ". Tax never shows; shipping charged,
 * shipping discount and shipping chargeback net to zero and stay out of Sales.
 */
export function classifyLeaf(txType: "Shipment" | "Refund", leafPath: string): FinancesLine {
  const [top, second] = leafPath.split(" > ");
  if (top === "Tax") return "tax";
  if (txType === "Shipment") {
    if (top === "ProductCharges") return "sales";
    if (top === "Shipping") return "shipping";
    if (top === "PromoRebates") return second === "ShippingDiscount" ? "shipping" : "promo";
    if (top === "AmazonFees") {
      if (second === "Commission") return "referral_fee";
      if (second === "FBAPerUnitFulfillmentFee") return "fba_fee";
      if (second === "VariableClosingFee") return "vcf";
      if (second === "ShippingChargeback" || second === "GiftwrapChargeback") return "shipping";
      return `fee:${second ?? top}`;
    }
    return `other:${top}`;
  }
  // Refund
  if (top === "ProductCharges" || top === "Shipping" || top === "PromoRebates") return "refund_amount";
  if (top === "Other") return second === "RestockingDeductionPrincipal" ? "restocking" : "refund_amount";
  if (top === "AmazonFees") {
    if (second === "RefundCommission") return "refund_commission";
    if (second === "Commission") return "refunded_referral";
    if (second === "VariableClosingFee") return "refund_vcf";
    if (second === "ShippingChargeback" || second === "GiftwrapChargeback") return "refund_amount";
    return `refund_fee:${second ?? top}`;
  }
  return "refund_amount";
}

/** Display order inside each group, SB's: the fixed lines first in SB's order, then the Amazon-named ones by amount (most negative first) — the panel sorts the rest. */
export const GROUP_ORDER: Record<Exclude<FinancesGroup, "hidden">, readonly string[]> = {
  top: ["sales", "units", "refunds", "promo", "advertising"],
  refund_cost: ["refund_amount", "refund_commission", "refund_customer_return_fee", "restocking", "refund_vcf", "refunded_referral", "returned_value"],
  amazon_fees: ["fba_fee", "referral_fee"],
  cost_of_goods: ["cogs", "prep", "disposal_value", "lost_damaged"],
};

/** A per-range breakdown as the API returns it (§6). Amounts are signed as SB shows them (fees negative). */
export interface FinancesBreakdownLine {
  line: string;
  label: string;
  group: FinancesGroup;
  amount: number;
  /** Units / counts for the count lines (units, refunds, orders). */
  quantity?: number;
  /** The estimated part of a fee line ("includes $X estimated for N pending units"). */
  estAmount?: number;
  estUnits?: number;
}
export interface FinancesBreakdown {
  from: string;
  to: string;
  asin: string | null;
  lines: FinancesBreakdownLine[];
  totals: {
    sales: number; units: number; orders: number | null; refunds: number;
    refundCost: number; refundCostCash: number; amazonFees: number; costOfGoods: number;
    grossProfit: number; netProfit: number; estPayout: number;
    margin: number | null; roi: number | null; refundRate: number | null; sellableReturns: number | null;
  };
  /** The range starts before the first stored day: data from this day (§6 "History"). */
  dataFrom: string | null;
}
