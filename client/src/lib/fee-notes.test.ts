import { describe, it, expect } from "vitest";
import { feeNotes } from "./fee-notes";

const base = { feeSource: "spapi" as const, fbaFeePromotion: null, feeFetchedAt: "2026-11-06T14:00:00Z", feeError: null, feeErrorAt: null, feesData: { fbaFulfillmentFee: 4.11, referralFee: 1.65, feesEstimatePrice: 10.99 }, pricingData: { lowestFbaPrice: 10.99, buyBoxPrice: 10.99, lowestPrice: 10.99 } } as any;

describe("feeNotes (Maria 2026-11-06)", () => {
  it("a real fee has no notes", () => expect(feeNotes(base)).toEqual({ lines: [], warn: false, kind: null }));
  it("a promotion that covers the fee: \"FBA fee waived by promotion ($X)\", not a warning; a partial one is \"reduced\"", () => {
    expect(feeNotes({ ...base, fbaFeePromotion: 4.11 })).toEqual({ lines: ["FBA fee waived by promotion ($4.11) — the fee shown is before it"], warn: false, kind: "promotion" });
    expect(feeNotes({ ...base, fbaFeePromotion: 1 }).lines[0]).toMatch(/^FBA fee reduced by promotion \(\$1\.00\)/);
  });
  it("a failed fetch after the last good fee: stale with both dates; a later success clears it", () => {
    const n = feeNotes({ ...base, feeError: "There is an internal service failure.", feeErrorAt: "2026-11-07T15:00:00Z" });
    expect(n).toMatchObject({ warn: true, kind: "stale" });
    expect(n.lines[0]).toBe("Stale — last good fee from 11/6/2026; the fetch on 11/7/2026 failed: There is an internal service failure.");
    expect(feeNotes({ ...base, feeFetchedAt: null, feeError: "x", feeErrorAt: "2026-11-07T15:00:00Z" }).lines[0]).toMatch(/from before 11\/6\/2026/);
    expect(feeNotes({ ...base, feeError: "x", feeErrorAt: "2026-11-05T15:00:00Z" }).lines).toEqual([]);
  });
  it("a fallback fee with the catalog-dimensions error says so by name", () => {
    const n = feeNotes({ ...base, feeSource: "fallback", feeFetchedAt: null, feeError: "no FBA estimate: catalog lacks package dimensions/weight", feeErrorAt: "2026-11-07T15:00:00Z" });
    expect(n).toEqual({ lines: ["Estimated from weight — no FBA estimate from Amazon: the catalog lacks package dimensions/weight"], warn: true, kind: "fallback" });
  });
});
