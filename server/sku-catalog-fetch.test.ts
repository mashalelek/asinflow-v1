import { describe, it, expect } from "vitest";
import { fetchCatalogForSku, type HttpGetFn, type CatalogFetchRetryConfig } from "./sku-catalog-fetch";

// Fast retry config for tests that exercise the retry loop — production
// uses 1000ms initial × 5 attempts (15s max) which would balloon test runtime.
const FAST_RETRY: CatalogFetchRetryConfig = { maxAttempts: 5, initialBackoffMs: 1 };

function fakeGet(payload: any): HttpGetFn {
  return async () => payload;
}
function failingGet(status: number, body?: any): HttpGetFn {
  return async () => {
    const err: any = new Error("simulated");
    err.response = { status, data: body };
    throw err;
  };
}

const FULL_CHAIN_PAYLOAD = {
  summaries: [{ brand: "Cafe Bustelo", itemName: "Café Bustelo Coffee 48 K Cup Packs" }],
  classifications: [
    {
      marketplaceId: "ATVPDKIKX0DER",
      classifications: [
        {
          displayName: "Single-Serve Capsules & Pods",
          parent: {
            displayName: "Coffee",
            parent: {
              displayName: "Beverages",
              parent: { displayName: "Grocery & Gourmet Food" },
            },
          },
        },
      ],
    },
  ],
  images: [{ images: [{ link: "https://example.com/image.jpg" }] }],
};

describe("fetchCatalogForSku", () => {
  it("returns ok with category from classifications-chain top-level", async () => {
    const r = await fetchCatalogForSku("B00NE21JNI", fakeGet(FULL_CHAIN_PAYLOAD));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.category).toBe("Grocery & Gourmet Food");
      expect(r.data.brand).toBe("Cafe Bustelo");
      expect(r.data.itemName).toMatch(/Café Bustelo/);
      expect(r.data.imageUrl).toBe("https://example.com/image.jpg");
    }
  });

  // REGRESSION GUARD: salesRanks vs classifications divergence.
  // The legend dept seeds were captured from classifications-chain walks.
  // If the generator ever switches to reading from salesRanks, this test
  // fails — protecting against the "legend miss on legitimate ASIN" bug.
  it("uses classifications top, NOT salesRanks, when the two diverge", async () => {
    const divergentPayload = {
      summaries: [{ brand: "Cafe Bustelo", itemName: "..." }],
      // salesRanks would say "Coffee" — a sub-level — if naively used
      salesRanks: [
        {
          classificationRanks: [{ title: "Coffee", productCategoryId: "16318031" }],
          displayGroupRanks: [{ title: "Coffee" }],
        },
      ],
      classifications: [
        {
          marketplaceId: "ATVPDKIKX0DER",
          classifications: [
            {
              displayName: "Single-Serve Capsules & Pods",
              parent: {
                displayName: "Coffee",
                parent: {
                  displayName: "Beverages",
                  parent: { displayName: "Grocery & Gourmet Food" }, // top
                },
              },
            },
          ],
        },
      ],
    };
    const r = await fetchCatalogForSku("B00NE21JNI", fakeGet(divergentPayload));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.category).toBe("Grocery & Gourmet Food");
      expect(r.data.category).not.toBe("Coffee");
    }
  });

  it("dead_asin on 404", async () => {
    const r = await fetchCatalogForSku(
      "B0XXXXDEAD",
      failingGet(404, {
        errors: [{ code: "NOT_FOUND", message: "Requested item not found" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("dead_asin");
      if (r.reason === "dead_asin") expect(r.status).toBe(404);
    }
  });

  it("no_brand when summaries[].brand is missing/empty", async () => {
    const r = await fetchCatalogForSku("B0X", fakeGet({
      summaries: [{ brand: "" }],
      classifications: FULL_CHAIN_PAYLOAD.classifications,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_brand");
  });

  it("no_category when classifications block is missing/empty", async () => {
    const r = await fetchCatalogForSku("B0X", fakeGet({
      summaries: [{ brand: "Some Brand" }],
      classifications: [],
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_category");
  });

  it("429 retries 5× then surfaces transient_error (fail-closed under throttle storm)", async () => {
    let calls = 0;
    const throttled: HttpGetFn = async () => {
      calls++;
      const err: any = new Error("429");
      err.response = { status: 429, data: { errors: [{ code: "QuotaExceeded", message: "QuotaExceeded" }] } };
      throw err;
    };
    const r = await fetchCatalogForSku("B0X", throttled, FAST_RETRY);
    expect(calls).toBe(5); // 1 initial + 4 retries
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "transient_error") {
      expect(r.retryable).toBe(true);
      expect(r.status).toBe(429);
      expect(r.message).toContain("QuotaExceeded");
    }
  });

  it("429 then 200 — retries succeed (transient throttle recovers)", async () => {
    let calls = 0;
    const flakey: HttpGetFn = async () => {
      calls++;
      if (calls < 3) {
        const err: any = new Error("429");
        err.response = { status: 429, data: { errors: [{ code: "QuotaExceeded", message: "throttled" }] } };
        throw err;
      }
      return FULL_CHAIN_PAYLOAD;
    };
    const r = await fetchCatalogForSku("B0X", flakey, FAST_RETRY);
    expect(calls).toBe(3); // 2 throttles + 1 success
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.category).toBe("Grocery & Gourmet Food");
  });

  // REGRESSION GUARD: 404 must NEVER be retried — dead-ASIN is a permanent
  // signal, retrying 5× would waste 15s on every dead ASIN in a batch.
  it("404 fails IMMEDIATELY (not retried)", async () => {
    let calls = 0;
    const dead: HttpGetFn = async () => {
      calls++;
      const err: any = new Error("404");
      err.response = { status: 404, data: { errors: [{ code: "NOT_FOUND", message: "..." }] } };
      throw err;
    };
    const r = await fetchCatalogForSku("B0DEAD", dead, FAST_RETRY);
    expect(calls).toBe(1); // ONLY one call — no retries on 404
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dead_asin");
  });

  // REGRESSION GUARD: non-throttle errors (5xx, auth, etc) also bail fast —
  // retrying a 401 or 503 wastes time and doesn't help.
  it("500 fails immediately (only 429/QuotaExceeded retries)", async () => {
    let calls = 0;
    const broken: HttpGetFn = async () => {
      calls++;
      const err: any = new Error("500");
      err.response = { status: 500, data: { errors: [{ code: "InternalError" }] } };
      throw err;
    };
    const r = await fetchCatalogForSku("B0X", broken, FAST_RETRY);
    expect(calls).toBe(1); // no retry on non-throttle
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "transient_error") {
      expect(r.status).toBe(500);
    }
  });

  // QuotaExceeded body code (without HTTP 429) also triggers retry — SP-API
  // sometimes surfaces throttling as body code rather than HTTP status.
  it("body code 'QuotaExceeded' (no HTTP 429) also triggers retry", async () => {
    let calls = 0;
    const odd: HttpGetFn = async () => {
      calls++;
      const err: any = new Error("body-throttle");
      err.response = { status: 200, data: { errors: [{ code: "QuotaExceeded", message: "..." }] } };
      throw err;
    };
    const r = await fetchCatalogForSku("B0X", odd, FAST_RETRY);
    expect(calls).toBe(5); // retried, not failed-fast
    expect(r.ok).toBe(false);
  });

  it("category walks to top even when intermediate levels exist", async () => {
    // Single-level classification: leaf is also the top.
    const r = await fetchCatalogForSku("B0X", fakeGet({
      summaries: [{ brand: "Some Brand" }],
      classifications: [
        {
          classifications: [{ displayName: "Books" }], // no parent
        },
      ],
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.category).toBe("Books");
  });
});
