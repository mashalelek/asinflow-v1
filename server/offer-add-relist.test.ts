// §18 Relist (2026-10-29): re-create a deleted listing under its ORIGINAL SKU
// name — exact-SKU reuse, format-agnostic (legacy / Amazon-random SKUs
// included) — optionally coming up OPEN (openOnCreate → the §19 ladder skips
// close-after-create for that submission row).
//
// Fakes mirror sku-resurrection.test.ts / offer-add.test.ts routing patterns.
import { describe, it, expect, vi } from "vitest";
import { resurrectOrGenerateSku } from "./sku-resurrection";
import { offerAddForAsin, type OfferAddDeps } from "./offer-add";
import { recordSubmission } from "./listing-submissions-repo";
import { clearProductTypeDefinitionCache } from "./listings-definitions";
import { submitOfferAddBatch, type SubmitAsinRow } from "./offer-add-submit";

const SELLER = "A1SELLERID";
const ASIN = "B0FKRQPWD1";
// A real relist shape: an Amazon-random SKU that does NOT match the canonical
// BRD-DEP-AS3-TTL-NNN format — the whole point of the override.
const LEGACY_SKU = "QM-UL2V-D9HN";

function makeRoutedHttpGet(routes: {
  catalog?: any;
  listings?: any | { error: number; body?: any };
  listingsSearch?: any | { error: number; body?: any };
  definitions?: any;
}) {
  return async (endpoint: string, _params?: any) => {
    if (endpoint.startsWith("/catalog/")) {
      if (routes.catalog?.error) {
        const err: any = new Error("simulated");
        err.response = { status: routes.catalog.error, data: routes.catalog.body };
        throw err;
      }
      return routes.catalog;
    }
    if (endpoint.startsWith("/listings/")) {
      const tail = endpoint.replace(/^\/listings\/2021-08-01\/items\//, "");
      const isSearch = !tail.includes("/");
      if (isSearch) {
        const s = routes.listingsSearch ?? { numberOfResults: 0, items: [] };
        if (s?.error) {
          const err: any = new Error("simulated");
          err.response = { status: s.error, data: s.body };
          throw err;
        }
        return s;
      }
      if (routes.listings?.error) {
        const err: any = new Error("simulated");
        err.response = { status: routes.listings.error, data: routes.listings.body };
        throw err;
      }
      return routes.listings;
    }
    if (endpoint.startsWith("/definitions/")) return routes.definitions ?? { name: "PRODUCT" };
    throw new Error(`unrouted endpoint: ${endpoint}`);
  };
}

function makeRoutedQueryFn(routes: {
  eligibility?: string | null;
  candidates?: Array<{ sku: string; created_at: Date }>;
}, capture?: { inserts: Array<{ sql: string; params: any[] }> }) {
  return async (sql: string, params?: any[]) => {
    if (sql.includes("INSERT INTO listing_submissions")) {
      capture?.inserts.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM asin_estimates")) {
      return routes.eligibility !== undefined
        ? { rows: [{ eligibility_status: routes.eligibility }] }
        : { rows: [] };
    }
    if (sql.includes("FROM asin_skus")) {
      return { rows: routes.candidates ?? [] };
    }
    return { rows: [] };
  };
}

const CREATED = new Date("2026-08-15T00:00:00Z");
// Catalog for the reuse path's fetchDgHzLive probe (hazmat pass-through).
const HAZMAT_CATALOG = {
  summaries: [{ brand: "SomeBrand", itemName: "Flammable Thing" }],
  attributes: { supplier_declared_dg_hz_regulation: [{ value: "ghs", marketplace_id: "ATVPDKIKX0DER" }] },
  classifications: [],
  images: [],
};

// ============================================================================
// Resurrection — relist mode
// ============================================================================
describe("resurrectOrGenerateSku — relist mode (exact-SKU, format-agnostic)", () => {
  const deps = (over: any = {}) => ({
    queryFn: makeRoutedQueryFn({ eligibility: "yes", candidates: [{ sku: LEGACY_SKU, created_at: CREATED }], ...over.query }),
    httpGet: makeRoutedHttpGet({ listings: { error: 404 }, ...over.http }),
    sellerId: SELLER,
    ...over.deps,
  });

  it("reuses the exact non-conforming SKU when it is AF history and 404s live", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, deps(), undefined, LEGACY_SKU);
    expect(r).toMatchObject({ kind: "reuse", sku: LEGACY_SKU });
  });

  it("relist_sku_unknown when the SKU is not in asin_skus for the ASIN (never an arbitrary string)", async () => {
    const r = await resurrectOrGenerateSku(
      ASIN, 1,
      { queryFn: makeRoutedQueryFn({ eligibility: "yes", candidates: [{ sku: "OTHER-SKU", created_at: CREATED }] }), httpGet: makeRoutedHttpGet({}), sellerId: SELLER },
      undefined, LEGACY_SKU,
    );
    expect(r).toMatchObject({ kind: "error", reason: "relist_sku_unknown" });
  });

  it("duplicate_warning when the relist SKU still exists live (raced delete)", async () => {
    const r = await resurrectOrGenerateSku(
      ASIN, 1,
      deps({ http: { listings: { summaries: [{ status: ["DISCOVERABLE"] }] } } }),
      undefined, LEGACY_SKU,
    );
    expect(r).toMatchObject({ kind: "duplicate_warning", existingSku: LEGACY_SKU });
  });

  it("already_in_catalog still gates relist (SC-presence check is not bypassed)", async () => {
    const r = await resurrectOrGenerateSku(
      ASIN, 1,
      deps({ http: { listingsSearch: { numberOfResults: 1, items: [{ sku: "ANY-OTHER-SKU", summaries: [{ status: ["BUYABLE"] }] }] } } }),
      undefined, LEGACY_SKU,
    );
    expect(r.kind).toBe("already_in_catalog");
  });

  it("gated still gates relist", async () => {
    const r = await resurrectOrGenerateSku(
      ASIN, 1,
      { queryFn: makeRoutedQueryFn({ eligibility: "no" }), httpGet: makeRoutedHttpGet({}), sellerId: SELLER },
      undefined, LEGACY_SKU,
    );
    expect(r.kind).toBe("gated");
  });

  it("a transient live-status failure errors out — never falls through to generate", async () => {
    const r = await resurrectOrGenerateSku(
      ASIN, 1,
      deps({ http: { listings: { error: 503 } } }),
      undefined, LEGACY_SKU,
    );
    expect(r).toMatchObject({ kind: "error", reason: "transient_error" });
  });
});

// ============================================================================
// offerAddForAsin — relist end-to-end (live PUT) + open_on_create recording
// ============================================================================
describe("offerAddForAsin — relistSku + openOnCreate", () => {
  it("creates under the exact legacy SKU, hazmat DG passed through, no registry touch, ledger row open_on_create=true", async () => {
    clearProductTypeDefinitionCache();
    const capture = { inserts: [] as Array<{ sql: string; params: any[] }> };
    const registry = { getByKey: vi.fn(), reserve: vi.fn(), rollback: vi.fn(), listForBrand: vi.fn() };
    let putBody: any = null;
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 24.99, cogs: 12.5, relistSku: LEGACY_SKU, openOnCreate: true },
      {
        queryFn: makeRoutedQueryFn({ eligibility: "yes", candidates: [{ sku: LEGACY_SKU, created_at: CREATED }] }, capture),
        httpGet: makeRoutedHttpGet({ catalog: HAZMAT_CATALOG, listings: { error: 404 }, definitions: { name: "PRODUCT" } }),
        httpPut: async (_endpoint: any, body: any) => {
          putBody = body;
          return { sku: LEGACY_SKU, status: "ACCEPTED", submissionId: "sub-relist-1", issues: [] };
        },
        sellerId: SELLER,
        productRegistry: registry as any,
      } as OfferAddDeps,
      false,
    );
    expect(r.kind).toBe("created");
    if (r.kind === "created") expect(r.sku).toBe(LEGACY_SKU);
    // DG pass-through: the catalog's own enum-valid value, verbatim.
    expect(putBody.attributes.supplier_declared_dg_hz_regulation[0].value).toBe("ghs");
    // No end_at at create (close-after-create era) — openness is a §19 skip,
    // not a payload difference.
    expect(JSON.stringify(putBody)).not.toMatch(/end_at/);
    // Relist is exact reuse: the registry is never consulted or reserved.
    expect(registry.getByKey).not.toHaveBeenCalled();
    expect(registry.reserve).not.toHaveBeenCalled();
    // The ledger row carries open_on_create = true (last param).
    expect(capture.inserts).toHaveLength(1);
    expect(capture.inserts[0].sql).toContain("open_on_create");
    expect(capture.inserts[0].params[capture.inserts[0].params.length - 1]).toBe(true);
  });

  it("openOnCreate omitted → ledger row open_on_create=false (normal Add to SC unchanged)", async () => {
    clearProductTypeDefinitionCache();
    const capture = { inserts: [] as Array<{ sql: string; params: any[] }> };
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 24.99, cogs: 12.5, relistSku: LEGACY_SKU },
      {
        queryFn: makeRoutedQueryFn({ eligibility: "yes", candidates: [{ sku: LEGACY_SKU, created_at: CREATED }] }, capture),
        httpGet: makeRoutedHttpGet({ catalog: HAZMAT_CATALOG, listings: { error: 404 }, definitions: { name: "PRODUCT" } }),
        httpPut: async () => ({ sku: LEGACY_SKU, status: "ACCEPTED", submissionId: "sub-relist-2", issues: [] }),
        sellerId: SELLER,
      },
      false,
    );
    expect(r.kind).toBe("created");
    expect(capture.inserts[0].params[capture.inserts[0].params.length - 1]).toBe(false);
  });
});

// ============================================================================
// recordSubmission — open_on_create column
// ============================================================================
describe("recordSubmission — open_on_create", () => {
  it("writes open_on_create from the flag; defaults false", async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const q = async (sql: string, params?: any[]) => { calls.push({ sql, params: params ?? [] }); return { rows: [], rowCount: 1 }; };
    await recordSubmission({ asin: ASIN, sku: LEGACY_SKU, submissionId: "s1", submittedPrice: 9.99, openOnCreate: true }, q as any);
    await recordSubmission({ asin: ASIN, sku: LEGACY_SKU, submissionId: "s2", submittedPrice: 9.99 }, q as any);
    expect(calls[0].sql).toContain("open_on_create");
    expect(calls[0].params[calls[0].params.length - 1]).toBe(true);
    expect(calls[1].params[calls[1].params.length - 1]).toBe(false);
  });
});

// ============================================================================
// verifyPending — the §19 ladder skips close-after-create for open rows
// ============================================================================
describe("verifyPending — open_on_create skips close-after-create", () => {
  async function sweepWith(openOnCreate: boolean) {
    vi.resetModules();
    vi.doMock("./submission-verify", () => ({
      probeListingState: async () => ({ throttled: false, classification: { status: "processing", reviewFlags: [], terminalConflict: false }, input: { found: true, listed: true, status: [], hasOffer: true, issues: [] } }),
      extractConflictAsin: () => null,
    }));
    vi.doMock("./live-offer-write", () => ({ writeLiveOfferVerdict: async () => {}, reprobeAsinLiveOffer: async () => {} }));
    const { verifyPending } = await import("./listing-submissions-repo");
    const query = async (sql: string) => sql.includes("FROM listing_submissions")
      ? { rows: [{ id: "s1", asin: ASIN, sku: LEGACY_SKU, submitted_at: "2026-10-29T18:00:00Z", age_hours: 0.1, open_on_create: openOnCreate }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
    const hook = vi.fn(async () => null);
    await verifyPending(SELLER, { query: query as any, delayMs: 0, closeAfterCreate: hook });
    vi.doUnmock("./submission-verify"); vi.doUnmock("./live-offer-write"); vi.resetModules();
    return hook;
  }

  it("open_on_create=true → hook NOT called (the offer comes up open)", async () => {
    expect(await sweepWith(true)).not.toHaveBeenCalled();
  });

  it("open_on_create=false → hook called (normal close-after-create)", async () => {
    expect(await sweepWith(false)).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// submitOfferAddBatch — relist threading (phase 1 and phase 4)
// ============================================================================
describe("submitOfferAddBatch — relist threading", () => {
  const row: SubmitAsinRow = {
    asin: ASIN, is_catalog_deleted: false, eligibility_status: "yes", is_hazmat: false,
    cogs: 10, fbaFee: 3, referralFee: 2, feesEstimatePrice: 20, weightLbs: 1, category: null,
    prepCost: 0, storageCost: 0,
  };

  it("threads relistSku into phase 1 and relistSku+openOnCreate into phase 4", async () => {
    const seen: Array<{ dryRun: boolean; relistSku?: string; openOnCreate?: boolean }> = [];
    const result = await submitOfferAddBatch([row], {
      queryFn: async () => ({ rows: [], rowCount: 0 }),
      sellerId: SELLER,
      settings: {} as any,
      includeInboundShipping: false,
      allExistingSkus: [LEGACY_SKU],
      relist: { [ASIN]: { sku: LEGACY_SKU, openOnCreate: true } },
      pacingMs: 0, phase1PacingMs: 0,
      offerAddFn: async (input, _deps, dryRun) => {
        seen.push({ dryRun, relistSku: input.relistSku, openOnCreate: input.openOnCreate });
        return dryRun
          ? { kind: "preview", asin: input.asin, sku: LEGACY_SKU, reused: true, payload: { productType: "PRODUCT", requirements: "LISTING_OFFER_ONLY", attributes: {} } }
          : { kind: "created", asin: input.asin, sku: LEGACY_SKU, submissionId: "sub-1", warnings: [] };
      },
      fetchOffersFn: async () => ({ ok: true, allOffers: [], competitivePriceThreshold: null, buyBoxPrice: null } as any),
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ dryRun: true, relistSku: LEGACY_SKU });
    expect(seen[1]).toMatchObject({ dryRun: false, relistSku: LEGACY_SKU, openOnCreate: true });
    const outcome = result.perAsin[0].outcome;
    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") expect(outcome.sku).toBe(LEGACY_SKU);
  });
});
