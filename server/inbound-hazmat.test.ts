import { describe, it, expect } from "vitest";
import { getInboundHazmat, type InboundHazmatRetry } from "./inbound-hazmat";

// Fast retry so the throttle-exhaustion test doesn't burn real backoff time.
const FAST_RETRY: InboundHazmatRetry = { maxAttempts: 3, initialBackoffMs: 1 };

function fakeGet(payload: any) {
  return async () => ({ payload });
}
function failingGet(status: number, code?: string) {
  return async () => {
    const err: any = new Error("simulated");
    err.response = { status, data: code ? { errors: [{ code }] } : undefined };
    throw err;
  };
}
// Throttles the first N calls, then succeeds with `payload`.
function throttleThenSucceed(n: number, payload: any) {
  let calls = 0;
  return async () => {
    if (calls++ < n) {
      const err: any = new Error("throttled");
      err.response = { status: 429, data: { errors: [{ code: "QuotaExceeded" }] } };
      throw err;
    }
    return { payload };
  };
}

describe("getInboundHazmat", () => {
  it("0015 present → true", async () => {
    const r = await getInboundHazmat("B082DM585M", fakeGet({ ineligibilityReasonList: ["FBA_INB_0015", "FBA_INB_0050"] }), FAST_RETRY);
    expect(r).toEqual({ kind: "ok", isHazmat: true });
  });

  it("butane codes [0014,0004,0050] → false (never in-range)", async () => {
    const r = await getInboundHazmat("B08MWQ7ZNT", fakeGet({ ineligibilityReasonList: ["FBA_INB_0014", "FBA_INB_0004", "FBA_INB_0050"] }), FAST_RETRY);
    expect(r).toEqual({ kind: "ok", isHazmat: false });
  });

  it("eligible (no ineligibilityReasonList) → false", async () => {
    const r = await getInboundHazmat("B07YX5971R", fakeGet({ isEligibleForProgram: true }), FAST_RETRY);
    expect(r).toEqual({ kind: "ok", isHazmat: false });
  });

  it("codes as objects {code} (not strings) → parsed correctly", async () => {
    const r = await getInboundHazmat("B082DM585M", fakeGet({ ineligibilityReasonList: [{ code: "FBA_INB_0015" }] }), FAST_RETRY);
    expect(r).toEqual({ kind: "ok", isHazmat: true });
  });

  it("throttle exhausted → an error outcome, NEVER a value (fail-closed, no clobber)", async () => {
    const r = await getInboundHazmat("BTHROTTLE", failingGet(429, "QuotaExceeded"), FAST_RETRY);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toBeTruthy();
    // the old sentinel is gone: there is no value to mistake for an answer
    expect(r).not.toHaveProperty("isHazmat");
  });

  it("non-throttle error (500) → an error outcome, NEVER a value", async () => {
    const r = await getInboundHazmat("BERR", failingGet(500), FAST_RETRY);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toBeTruthy();
    // the old sentinel is gone: there is no value to mistake for an answer
    expect(r).not.toHaveProperty("isHazmat");
  });

  it("404 → an error outcome, NEVER a value", async () => {
    const r = await getInboundHazmat("B404", failingGet(404), FAST_RETRY);
    expect(r.kind).toBe("error");
  });

  it("retries QuotaExceeded then succeeds → true (backoff path works)", async () => {
    const r = await getInboundHazmat("BRETRY", throttleThenSucceed(2, { ineligibilityReasonList: ["FBA_INB_0015"] }), FAST_RETRY);
    expect(r).toEqual({ kind: "ok", isHazmat: true });
  });
});
