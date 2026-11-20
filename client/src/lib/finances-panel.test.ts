import { describe, it, expect } from "vitest";
import { estimateTitle, fmtMoney, panelRows } from "./finances-panel";
import type { FinancesBreakdown } from "@shared/finances";

const B: FinancesBreakdown = {
  from: "2026-08-01", to: "2026-08-31", asin: null, dataFrom: null,
  lines: [
    { line: "sales", label: "Sales", group: "top", amount: 33775.91 },
    { line: "refund_amount", label: "Refunded amount", group: "refund_cost", amount: -962.5 },
    { line: "returned_value", label: "Value of returned items", group: "refund_cost", amount: 260.63 },
    { line: "restocking", label: "RestockingDeductionPrincipal", group: "refund_cost", amount: 0 },
    { line: "fba_fee", label: "FBA per unit fulfilment fee", group: "amazon_fees", amount: -6241.3, estAmount: -5.77, estUnits: 1 },
    { line: "referral_fee", label: "Referral fee", group: "amazon_fees", amount: -4886.96 },
    { line: "svc:Subscription", label: "Subscription", group: "amazon_fees", amount: -39.99 },
    { line: "cogs", label: "COGS", group: "cost_of_goods", amount: -16198.54 },
    { line: "prep", label: "Prep", group: "cost_of_goods", amount: 0 },
    { line: "lost_damaged", label: "Lost/damaged by Amazon", group: "cost_of_goods", amount: -189.18 },
  ],
  totals: { sales: 33775.91, units: 1232, orders: 1067, refunds: 33, refundCost: -701.87, refundCostCash: -962.5, amazonFees: -11168.25, costOfGoods: -16387.72, grossProfit: 5518.07, netProfit: 5518.07, estPayout: 21645.16, margin: 16.34, roi: 33.67, refundRate: 2.68, sellableReturns: 68.75 },
};

describe("panelRows (mockup finances-breakdown-2026-11-19)", () => {
  it("SB's order: the five top lines, three groups with their lines ($0.00 lines hidden except COGS / Prep), the bottom block and the four ratios", () => {
    const rows = panelRows(B);
    const labels = rows.map((r) => (r.kind === "hr" ? "—" : r.label));
    expect(labels).toEqual(["Sales", "Units", "Refunds", "Promo", "Advertising cost",
      "Refund cost", "Refunded amount", "Value of returned items",
      "Amazon fees", "FBA per unit fulfilment fee", "Referral fee", "Subscription",
      "Cost of goods", "COGS", "Prep", "Lost/damaged by Amazon",
      "—", "Gross profit", "Indirect expenses", "Net profit", "Estimated payout", "—", "Refund rate", "Sellable returns", "Margin", "ROI"]);
    expect(rows[0]).toMatchObject({ value: "$33,775.91" }); expect(rows[1]).toMatchObject({ value: "1,232" });
    expect(rows.find((r) => r.kind === "line" && r.label === "Promo")).toMatchObject({ zero: true, value: "$0.00" });
    expect(rows.find((r) => r.kind === "group" && r.group === "amazon_fees")).toMatchObject({ value: "-$11,168.25" });
    expect(rows.find((r) => r.kind === "line" && r.label === "Net profit")).toMatchObject({ cls: "tot" });
    expect(rows.find((r) => r.kind === "line" && r.label === "Margin")).toMatchObject({ value: "16.34%" });
  });
  it("a collapsed group keeps its header and drops its lines; the estimate shows on hover only", () => {
    const rows = panelRows(B, new Set(["amazon_fees"]));
    expect(rows.some((r) => r.kind === "line" && r.label === "Referral fee")).toBe(false);
    expect(rows.some((r) => r.kind === "group" && r.group === "amazon_fees")).toBe(true);
    const fba = panelRows(B).find((r) => r.kind === "line" && r.line === "fba_fee") as any;
    expect(fba.title).toBe("includes $5.77 estimated for 1 pending unit");
    expect(estimateTitle({ line: "x", label: "x", group: "amazon_fees", amount: -1 })).toBeUndefined();
    expect(fmtMoney(-602.37)).toBe("-$602.37"); expect(fmtMoney(0)).toBe("$0.00");
  });
});
