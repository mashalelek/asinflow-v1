import { describe, it, expect } from "vitest";
import { checkSkuListingStatus } from "./sku-listing-fetch";

function fakeGet(payload: any) {
  return async () => payload;
}
function failingGet(status: number, body?: any) {
  return async () => {
    const err: any = new Error("simulated");
    err.response = { status, data: body };
    throw err;
  };
}

describe("checkSkuListingStatus", () => {
  it("present=true with statuses when listing exists (200)", async () => {
    const r = await checkSkuListingStatus(
      "A1SELLERID",
      "AMG-BPC-X8M-RRC-001",
      fakeGet({ summaries: [{ status: ["BUYABLE", "DISCOVERABLE"] }] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.present) {
      expect(r.statuses).toEqual(["BUYABLE", "DISCOVERABLE"]);
    }
  });

  it("present=true with empty array when summaries lacks status field", async () => {
    const r = await checkSkuListingStatus(
      "A1SELLERID",
      "AMG-BPC-X8M-RRC-001",
      fakeGet({ summaries: [{}] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.present) expect(r.statuses).toEqual([]);
  });

  it("present=false on 404 (deleted SKU — resurrection signal)", async () => {
    const r = await checkSkuListingStatus(
      "A1SELLERID",
      "AMG-BPC-X8M-RRC-001",
      failingGet(404, {
        errors: [{ code: "NOT_FOUND", message: "Listing not found" }],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.present).toBe(false);
  });

  it("transient_error on 429 (rate limit) with retryable flag", async () => {
    const r = await checkSkuListingStatus(
      "A1SELLERID",
      "AMG-BPC-X8M-RRC-001",
      failingGet(429, { errors: [{ message: "QuotaExceeded" }] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("transient_error");
      expect(r.status).toBe(429);
      expect(r.retryable).toBe(true);
      expect(r.message).toContain("QuotaExceeded");
    }
  });

  it("transient_error on 500", async () => {
    const r = await checkSkuListingStatus(
      "A1SELLERID",
      "AMG-BPC-X8M-RRC-001",
      failingGet(500),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("transient_error");
      expect(r.status).toBe(500);
    }
  });
});
