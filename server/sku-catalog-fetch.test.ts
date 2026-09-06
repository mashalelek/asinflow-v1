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

  // Throttle retries were REMOVED from this module (SPEC §11, 2026-09-06):
  // the shared rate limiter paces + retries 429s once, at the wire. An
  // escaped throttle surfaces here as an immediate transient_error.
  it("429 → transient_error immediately, no module-level retry (limiter owns 429s)", async () => {
    let calls = 0;
    const get = async () => {
      calls++;
      const err: any = new Error("throttled");
      err.response = { status: 429 };
      throw err;
    };
    const r = await fetchCatalogForSku("B0XXXXXXXX", get as any, FAST_RETRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transient_error");
    expect(calls).toBe(1);
  });

  it("404 fails IMMEDIATELY as dead_asin (never retried)", async () => {
    let calls = 0;
    const get = async () => {
      calls++;
      const err: any = new Error("not found");
      err.response = { status: 404 };
      throw err;
    };
    const r = await fetchCatalogForSku("B0XXXXXXXX", get as any, FAST_RETRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dead_asin");
    expect(calls).toBe(1);
  });

  it("500 fails immediately as transient_error", async () => {
    let calls = 0;
    const get = async () => {
      calls++;
      const err: any = new Error("server error");
      err.response = { status: 500, data: { errors: [{ message: "boom" }] } };
      throw err;
    };
    const r = await fetchCatalogForSku("B0XXXXXXXX", get as any, FAST_RETRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transient_error");
    expect(calls).toBe(1);
  });

  it("QuotaExceeded body code (no HTTP 429) is likewise immediate transient", async () => {
    let calls = 0;
    const get = async () => {
      calls++;
      const err: any = new Error("throttled");
      err.response = { status: 403, data: { errors: [{ code: "QuotaExceeded", message: "Rate exceeded" }] } };
      throw err;
    };
    const r = await fetchCatalogForSku("B0XXXXXXXX", get as any, FAST_RETRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transient_error");
    expect(calls).toBe(1);
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
