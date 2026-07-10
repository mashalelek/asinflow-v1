import { describe, it, expect } from "vitest";
import { fetchCompetingOffers, type OffersRetryConfig } from "./listings-offers-fetch";

const OUR_SELLER = "A1OURSELLER";
// Fast retry for tests — production uses 2200ms × doubling; tests use 1ms
// so 429-exhaustion tests don't burn 15 seconds of wall-clock.
const FAST_RETRY: OffersRetryConfig = { maxAttempts: 3, initialBackoffMs: 1 };

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

describe("fetchCompetingOffers", () => {
  it("filters out our own offer by SellerId", async () => {
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, fakeGet({
      payload: {
        Offers: [
          { SellerId: "A1COMP1",      ListingPrice: { Amount: "10.00", CurrencyCode: "USD" }, ShippingPrice: { Amount: "0", CurrencyCode: "USD" }, IsFulfilledByAmazon: true },
          { SellerId: OUR_SELLER,     ListingPrice: { Amount: "12.50", CurrencyCode: "USD" }, ShippingPrice: { Amount: "0", CurrencyCode: "USD" }, IsFulfilledByAmazon: true },
          { SellerId: "A1COMP2",      ListingPrice: { Amount: "15.00", CurrencyCode: "USD" }, ShippingPrice: { Amount: "0", CurrencyCode: "USD" }, IsFulfilledByAmazon: false },
        ],
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.competingOffers).toEqual([15, 10]); // sorted desc, no 12.50 (ours)
      expect(r.ourOffer).toBe(12.50);
      expect(r.allOffers).toHaveLength(3);
    }
  });

  it("includes shipping in landed price", async () => {
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, fakeGet({
      payload: {
        Offers: [
          { SellerId: "A1COMP1", ListingPrice: { Amount: "10.00" }, ShippingPrice: { Amount: "4.99" }, IsFulfilledByAmazon: false },
        ],
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.competingOffers).toEqual([14.99]);
  });

  it("ourOffer is null when we're not listed on this ASIN", async () => {
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, fakeGet({
      payload: {
        Offers: [
          { SellerId: "A1COMP1", ListingPrice: { Amount: "20.00" }, IsFulfilledByAmazon: true },
        ],
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ourOffer).toBeNull();
  });

  it("empty offers array → empty competingOffers", async () => {
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, fakeGet({
      payload: { Offers: [] },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.competingOffers).toEqual([]);
  });

  it("missing payload → empty competingOffers", async () => {
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, fakeGet({}));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.competingOffers).toEqual([]);
  });

  it("404 → not_found (no retry — ASIN genuinely missing)", async () => {
    let calls = 0;
    const get = async () => { calls++; const err: any = new Error("simulated"); err.response = { status: 404 }; throw err; };
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, get, FAST_RETRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
    expect(calls).toBe(1); // no retry on 404
  });

  it("5xx → transient_error (no retry — only throttle triggers retry)", async () => {
    let calls = 0;
    const get = async () => { calls++; const err: any = new Error("simulated"); err.response = { status: 503 }; throw err; };
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, get, FAST_RETRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transient_error");
    expect(calls).toBe(1); // 503 is not a throttle; bail immediately
  });

  it("429 → retries with backoff, eventually transient_error after exhaustion", async () => {
    let calls = 0;
    const get = async () => {
      calls++;
      const err: any = new Error("simulated");
      err.response = { status: 429 };
      throw err;
    };
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, get, FAST_RETRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transient_error");
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("transient 429 then success on retry → returns success", async () => {
    let calls = 0;
    const get = async () => {
      calls++;
      if (calls <= 1) {
        const err: any = new Error("simulated"); err.response = { status: 429 }; throw err;
      }
      return { payload: { Offers: [{ SellerId: "A1OTHER", ListingPrice: { Amount: "10.00" }, IsFulfilledByAmazon: true }] } };
    };
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, get, FAST_RETRY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.competingOffers).toEqual([10]);
    expect(calls).toBe(2); // 1 throttle + 1 success
  });

  it("error code QuotaExceeded (not just HTTP 429) also triggers retry", async () => {
    // SP-API sometimes surfaces throttling as HTTP 4xx with code=QuotaExceeded
    // rather than HTTP 429. Both must trigger the retry path.
    let calls = 0;
    const get = async () => {
      calls++;
      const err: any = new Error("simulated");
      err.response = {
        status: 403,
        data: { Errors: [{ Code: "QuotaExceeded", Message: "Rate exceeded" }] },
      };
      throw err;
    };
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, get, FAST_RETRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transient_error");
    expect(calls).toBe(3); // retried like a 429
  });

  it("rejects offers with no price (defensive)", async () => {
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, fakeGet({
      payload: {
        Offers: [
          { SellerId: "A1COMP1", ListingPrice: { Amount: "0" } },
          { SellerId: "A1COMP2", ListingPrice: { Amount: "abc" } }, // unparseable
          { SellerId: "A1COMP3", ListingPrice: { Amount: "10.00" } },
        ],
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.competingOffers).toEqual([10]);
  });

  it("multiple our-seller offers (edge): all filtered out, ourOffer = first", async () => {
    // Shouldn't happen normally but defensive: if we somehow have 2 offers on
    // the same ASIN, both get excluded from competing.
    const r = await fetchCompetingOffers("B0XXX", OUR_SELLER, fakeGet({
      payload: {
        Offers: [
          { SellerId: OUR_SELLER, ListingPrice: { Amount: "20.00" }, IsFulfilledByAmazon: true },
          { SellerId: OUR_SELLER, ListingPrice: { Amount: "22.00" }, IsFulfilledByAmazon: false },
          { SellerId: "A1OTHER",  ListingPrice: { Amount: "18.00" }, IsFulfilledByAmazon: true },
        ],
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.competingOffers).toEqual([18]);
      expect(r.ourOffer).toBe(20.00);
    }
  });
});
