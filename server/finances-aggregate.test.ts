// The breakdown math (patch commit 5, SPEC §1): pure, from aggregate rows + the Settings prep.
import { describe, it, expect } from "vitest";
import { breakdownFromRows, type AggRow } from "./finances-aggregate";

const row = (line: string, amount = 0, quantity = 0, extra: Partial<AggRow> = {}): AggRow => ({ line, amount, quantity, est_amount: 0, est_units: 0, prep_units: 0, prep_hazmat_units: 0, ...extra });
const S = { prepCost: 1.2, hazmatPrepSurcharge: 0, hazmatShipSurcharge: 1 }; // Maria's values 2026-11-20: a hazmat Velocity unit = 1.20 + 0 + 1.00

describe("breakdownFromRows", () => {
  it("SB's identities: gross = sales + refund cost + fees + cost of goods; payout leaves the returned-items value out; prep from the Settings values (hazmat = prep + both DG/Hazmat surcharges)", () => {
    const rows = [
      row("sales", 1000), row("units", 0, 40), row("orders", 0, 38), row("refunds", 0, 2),
      row("refund_amount", -50), row("refund_commission", -2), row("refunded_referral", 7.5), row("returned_value", 20, 2, { prep_units: 2 }),
      row("fba_fee", -160, 40, { est_amount: -4, est_units: 1 }), row("referral_fee", -150, 40), row("svc:FBAStorageBilling", -10), row("reimb:WAREHOUSE_LOST", 5, 1),
      row("cogs", -400, 40), row("prep", 0, 40, { prep_units: 30, prep_hazmat_units: 5 }), row("lost_damaged", -10, -1, { prep_units: -1 }),
      row("returns_units", 0, 4), row("returns_sellable", 0, 2),
    ];
    const b = breakdownFromRows(rows, S, { from: "2026-08-01", to: "2026-08-31", asin: null, dataFrom: null });
    const l = (k: string) => b.lines.find((x) => x.line === k)!;
    expect(l("prep").amount).toBe(-(30 * 1.2 + 5 * 2.2));            // −47.00
    expect(l("returned_value").amount).toBe(20 + 2 * 1.2);           // 22.40
    expect(l("lost_damaged").amount).toBe(-10 - 1.2);                // −11.20
    expect(l("fba_fee")).toMatchObject({ estAmount: -4, estUnits: 1 });
    expect(l("svc:FBAStorageBilling").label).toBe("FBA storage fee"); expect(l("reimb:WAREHOUSE_LOST").label).toBe("Warehouse lost");
    expect(b.totals.refundCost).toBe(-50 - 2 + 7.5 + 22.4);
    expect(b.totals.refundCostCash).toBe(-44.5);
    expect(b.totals.amazonFees).toBe(-160 - 150 - 10 + 5);
    expect(b.totals.costOfGoods).toBe(-400 - 47 - 11.2);
    expect(b.totals.grossProfit).toBe(Math.round((1000 + b.totals.refundCost + b.totals.amazonFees + b.totals.costOfGoods) * 100) / 100);
    expect(b.totals.netProfit).toBe(b.totals.grossProfit);
    expect(b.totals.estPayout).toBe(Math.round((1000 - 44.5 - 315) * 100) / 100);
    expect(b.totals.orders).toBe(38); expect(b.totals.refundRate).toBe(5); expect(b.totals.sellableReturns).toBe(50);
    expect(b.totals.margin).toBe(Math.round((b.totals.netProfit / 1000) * 10000) / 100);
    expect(b.totals.roi).toBe(Math.round((b.totals.netProfit / 458.2) * 10000) / 100);
  });
  it("orders are account-only (null on an ASIN); groups keep SB's order, Amazon-named fee lines most negative first; an empty range is all zeros", () => {
    const rows = [row("sales", 10), row("units", 0, 1), row("fba_fee", -2), row("referral_fee", -1), row("reimb:WAREHOUSE_DAMAGE", 3), row("svc:Subscription", -39.99), row("svc:FBARemoval", -0.84), row("cogs", -4, 1), row("prep", 0, 1, { prep_units: 1 })];
    const b = breakdownFromRows(rows, S, { from: "a", to: "b", asin: "B0X", dataFrom: "2024-11-19" });
    expect(b.totals.orders).toBeNull(); expect(b.dataFrom).toBe("2024-11-19");
    expect(b.lines.filter((x) => x.group === "amazon_fees").map((x) => x.line)).toEqual(["fba_fee", "referral_fee", "svc:Subscription", "svc:FBARemoval", "reimb:WAREHOUSE_DAMAGE"]);
    const e = breakdownFromRows([], S, { from: "a", to: "b", asin: null, dataFrom: null });
    expect(e.totals).toMatchObject({ sales: 0, units: 0, grossProfit: 0, estPayout: 0, margin: null, roi: null, refundRate: null, sellableReturns: null });
  });
});
