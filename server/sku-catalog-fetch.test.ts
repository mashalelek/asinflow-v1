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

  // RETIRED 2026-10-04: an empty classifications block used to be the
  // no_category hard fail. It is now `category: null` -> DEP = NUL (§18),
  // the same treatment an absent brand gets. Kept here, inverted, so the
  // behaviour change is visible at the old assertion's site.
  it("empty classifications block is NOT a failure — category null (was no_category)", async () => {
    const r = await fetchCatalogForSku("B0X", fakeGet({
      summaries: [{ brand: "Some Brand" }],
      classifications: [],
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.category).toBeNull();
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
          marketplaceId: "ATVPDKIKX0DER",
          classifications: [{ displayName: "Books" }], // no parent
        },
      ],
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.category).toBe("Books");
  });
});

// ============================================================================
// §18 absent category → DEP = NUL (2026-10-04)
// ============================================================================
// An absent category on a SUCCESSFUL response is no longer a failure: it is
// carried as `category: null` and becomes the reserved code NUL downstream,
// exactly as an absent brand does. The no_category outcome is gone.
//
// Origin: B008DG32FI ("Infusion V-fitting") — a 200 whose classifications
// entry for ATVPDKIKX0DER is an EMPTY array, verified live, stable across
// four fetches, with no variation parent to inherit from.
describe("absent category on a 200 → category null, never a failure", () => {
  const withClassifications = (classifications: any) => ({
    summaries: [{ brand: "Infusion Pool Products", itemName: "Infusion V-fitting" }],
    classifications,
    attributes: {},
  });

  // The four shapes "no category for us" can take.
  const EMPTY_SHAPES: Array<[string, any]> = [
    ["key absent entirely", undefined],
    ["empty top-level array", []],
    ["our entry with an empty chain (the real B008DG32FI)", [{ marketplaceId: "ATVPDKIKX0DER", classifications: [] }]],
    ["no entry for OUR marketplace", [{ marketplaceId: "A1F83G8C2ARO7P", classifications: [{ displayName: "DIY & Tools" }] }]],
  ];

  for (const [label, classifications] of EMPTY_SHAPES) {
    it(`${label} → ok with category null`, async () => {
      const r = await fetchCatalogForSku("B008DG32FI", fakeGet(withClassifications(classifications)));
      expect(r.ok).toBe(true);           // NOT a failure
      if (!r.ok) return;
      expect(r.data.category).toBeNull();
      expect(r.data.brand).toBe("Infusion Pool Products"); // brand is independent
    });
  }

  it("reads OUR marketplace's chain when it is not first in the array", async () => {
    const r = await fetchCatalogForSku("B000TEST01", fakeGet(withClassifications([
      { marketplaceId: "A1F83G8C2ARO7P", classifications: [{ displayName: "WRONG — UK" }] },
      { marketplaceId: "A1AM78C64UM0Y8", classifications: [{ displayName: "WRONG — MX" }] },
      { marketplaceId: "ATVPDKIKX0DER", classifications: [{ displayName: "Patio, Lawn & Garden" }] },
    ])));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.category).toBe("Patio, Lawn & Garden"); // ours, not [0]
  });

  it("a 404 is STILL a hard fail — NUL never masks a dead ASIN", async () => {
    const r = await fetchCatalogForSku("B000DEAD01", async () => {
      const e: any = new Error("not found"); e.response = { status: 404 }; throw e;
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("dead_asin");
  });

  it("a transport/throttle failure is STILL a hard fail — NUL only comes from a 200", async () => {
    for (const status of [429, 500, 503]) {
      const r = await fetchCatalogForSku("B000FAIL01", async () => {
        const e: any = new Error("boom"); e.response = { status }; throw e;
      });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe("transient_error");
    }
  });
});
