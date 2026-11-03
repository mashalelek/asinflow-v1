import { describe, it, expect } from "vitest";
import { proposeRefund, REFUND_STATUSES } from "./po-refund";

// Dashboard patch §2.3 C1: the due-refund proposal for a canceled qty.
describe("proposeRefund", () => {
  it("qty × price × (1 − discount ÷ subtotal) + tax × line value ÷ subtotal", () => {
    // PO: subtotal 200, discount 20 (10 %), tax 16 (8 %); cancel 2 × $25
    expect(proposeRefund({ qty: 2, price: 25, subtotal: 200, discount: 20, tax: 16 })).toEqual({ amount: 49, lineValue: 50, discountRatio: 0.1, taxShare: 4, allocated: true }); // 50 × 0.9 + 4
    expect(proposeRefund({ qty: 1, price: "7.97", subtotal: "7.97", discount: "0", tax: "0.56" }).amount).toBe(8.53);
  });
  it("no subtotal → plain qty × price (nothing to allocate); no price → no proposal; a discount larger than the subtotal is clamped", () => {
    expect(proposeRefund({ qty: 3, price: 10 })).toEqual({ amount: 30, lineValue: 30, discountRatio: 0, taxShare: 0, allocated: false });
    expect(proposeRefund({ qty: 3, price: 10, subtotal: 0, discount: 5, tax: 1 }).allocated).toBe(false);
    expect(proposeRefund({ qty: 3, price: null, subtotal: 100 }).amount).toBeNull();
    expect(proposeRefund({ qty: 0, price: 10, subtotal: 100 }).amount).toBeNull();
    expect(proposeRefund({ qty: 1, price: 10, subtotal: 10, discount: 50, tax: 0 }).amount).toBe(0);
  });
  it("the two statuses", () => { expect(REFUND_STATUSES).toEqual(["due", "received"]); });
});
