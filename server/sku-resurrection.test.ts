import { describe, it, expect } from "vitest";
import { resurrectOrGenerateSku, type ResurrectionDeps } from "./sku-resurrection";

const SELLER = "A1SELLERID";
const ASIN = "B0FCM6CX8M"; // ends in X8M → AS3 derives to "X8M"

// Routing fakes — pattern-match on URL/SQL to return the right shape.
// listingsSearch: /listings/2021-08-01/items/{seller} (NO sku suffix) — searchListingsItemsByAsin
// listings:       /listings/2021-08-01/items/{seller}/{sku} — checkSkuListingStatus
// Default for listingsSearch when absent: 0 items (the resurrection presence
// check then proceeds to the existing reuse/generate logic just like before).
function makeRoutedHttpGet(routes: {
  catalog?: any;
  listings?: any | { error: number; body?: any };
  listingsSearch?: any | { error: number; body?: any };
}) {
  return async (endpoint: string, _params?: any) => {
    if (endpoint.startsWith("/catalog/")) {
      if (routes.catalog === undefined) throw new Error(`unexpected catalog call: ${endpoint}`);
      if (routes.catalog?.error) {
        const err: any = new Error("simulated");
        err.response = { status: routes.catalog.error, data: routes.catalog.body };
        throw err;
      }
      return routes.catalog;
    }
    if (endpoint.startsWith("/listings/")) {
      // Distinguish search (no sku suffix) from per-SKU lookup by URL structure.
      // search: /listings/2021-08-01/items/{seller}
      // per-sku: /listings/2021-08-01/items/{seller}/{sku}
      const tail = endpoint.replace(/^\/listings\/2021-08-01\/items\//, "");
      const isSearch = !tail.includes("/"); // no extra slash → no sku suffix
      if (isSearch) {
        const search = routes.listingsSearch ?? { numberOfResults: 0, items: [] };
        if (search?.error) {
          const err: any = new Error("simulated");
          err.response = { status: search.error, data: search.body };
          throw err;
        }
        return search;
      }
      if (routes.listings === undefined) throw new Error(`unexpected listings call: ${endpoint}`);
      if (routes.listings?.error) {
        const err: any = new Error("simulated");
        err.response = { status: routes.listings.error, data: routes.listings.body };
        throw err;
      }
      return routes.listings;
    }
    throw new Error(`unrouted endpoint: ${endpoint}`);
  };
}

function makeRoutedQueryFn(routes: {
  eligibility?: string | null;                              // gated check
  candidates?: Array<{ sku: string; created_at: Date }>;    // resurrection lookup
  legend?: Record<string, { code: string; status: string } | null>;  // legend lookup by "type:rawValue"
}) {
  return async (sql: string, params?: any[]) => {
    if (sql.includes("FROM asin_estimates")) {
      return routes.eligibility !== undefined
        ? { rows: [{ eligibility_status: routes.eligibility }] }
        : { rows: [] };
    }
    if (sql.includes("FROM asin_skus")) {
      return { rows: routes.candidates ?? [] };
    }
    if (sql.includes("FROM sku_legend_alias")) {
      const [type, rawValue] = params ?? [];
      const key = `${type}:${String(rawValue ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;
      const row = routes.legend?.[key];
      return { rows: row ? [{ legend_id: "uuid-test", code: row.code, status: row.status }] : [] };
    }
    return { rows: [] };
  };
}

const HAPPY_CATALOG = {
  summaries: [{ brand: "AminoGenesis", itemName: "Triple Firming Renewal" }],
  classifications: [{
    classifications: [{
      displayName: "Moisturizers",
      parent: { displayName: "Skin Care", parent: { displayName: "Beauty & Personal Care" } },
    }],
  }],
  images: [],
};
const HAPPY_LEGEND = {
  "brand:aminogenesis": { code: "AMG", status: "approved" },
  "dept:beauty & personal care": { code: "BPC", status: "approved" },
};

describe("resurrectOrGenerateSku — decision tree", () => {
  it("gated: eligibility_status === 'no'", async () => {
    const deps: ResurrectionDeps = {
      queryFn: makeRoutedQueryFn({ eligibility: "no" }),
      sellerId: SELLER,
    };
    const r = await resurrectOrGenerateSku(ASIN, 1, deps);
    expect(r.kind).toBe("gated");
    if (r.kind === "gated") expect(r.eligibilityStatus).toBe("no");
  });

  it("gated: eligibility_status === 'check' (inconclusive)", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({ eligibility: "check" }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("gated");
  });

  it("gated: eligibility_status === NULL → 'not_checked'", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({ eligibility: null }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("gated");
    if (r.kind === "gated") expect(r.eligibilityStatus).toBe("not_checked");
  });

  it("gated: no asin_estimates row at all → 'not_checked'", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({}), // eligibility undefined → empty row
      sellerId: SELLER,
    });
    expect(r.kind).toBe("gated");
    if (r.kind === "gated") expect(r.eligibilityStatus).toBe("not_checked");
  });

  it("reuse: current-format candidate is absent from SC (404)", async () => {
    const created = new Date("2026-01-15T10:00:00Z");
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({
        eligibility: "yes",
        candidates: [{ sku: "AMG-BPC-X8M-RRC-001", created_at: created }],
      }),
      httpGet: makeRoutedHttpGet({ listings: { error: 404 } }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("reuse");
    if (r.kind === "reuse") {
      expect(r.sku).toBe("AMG-BPC-X8M-RRC-001");
      expect(r.lastCreatedAt).toEqual(created);
    }
  });

  it("duplicate_warning: candidate is present in SC (BUYABLE,DISCOVERABLE)", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({
        eligibility: "yes",
        candidates: [{ sku: "AMG-BPC-X8M-RRC-001", created_at: new Date() }],
      }),
      httpGet: makeRoutedHttpGet({
        listings: { summaries: [{ status: ["BUYABLE", "DISCOVERABLE"] }] },
      }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("duplicate_warning");
    if (r.kind === "duplicate_warning") {
      expect(r.existingSku).toBe("AMG-BPC-X8M-RRC-001");
      expect(r.statuses).toEqual(["BUYABLE", "DISCOVERABLE"]);
    }
  });

  it("error transient: listing status check fails non-404", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({
        eligibility: "yes",
        candidates: [{ sku: "AMG-BPC-X8M-RRC-001", created_at: new Date() }],
      }),
      httpGet: makeRoutedHttpGet({ listings: { error: 429 } }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toBe("transient_error");
  });

  it("ignores non-current-format candidates (legacy AMG passes through to generate)", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({
        eligibility: "yes",
        // Legacy AMG format (BRD-DD-SUB-TTL-NNN) — fails matchesCurrentSkuFormat
        candidates: [{ sku: "AMG-BP-CLN-RRC-002", created_at: new Date() }],
        legend: HAPPY_LEGEND,
      }),
      httpGet: makeRoutedHttpGet({ catalog: HAPPY_CATALOG }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("generate");
    if (r.kind === "generate") expect(r.sku).toBe("AMG-BPC-X8M-TFR-001");
  });

  it("generate: no candidate, fresh resolve succeeds", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 4, {
      queryFn: makeRoutedQueryFn({
        eligibility: "yes",
        candidates: [],
        legend: HAPPY_LEGEND,
      }),
      httpGet: makeRoutedHttpGet({ catalog: HAPPY_CATALOG }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("generate");
    if (r.kind === "generate") {
      expect(r.sku).toBe("AMG-BPC-X8M-TFR-004");
      expect(r.trail.brd).toBe("AMG");
      expect(r.trail.dep).toBe("BPC");
    }
  });

  it("dead_asin: no candidate, catalog 404", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({ eligibility: "yes", candidates: [] }),
      httpGet: makeRoutedHttpGet({ catalog: { error: 404 } }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("dead_asin");
  });

  it("legend_pending: no candidate, catalog ok, brand not in legend", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({
        eligibility: "yes",
        candidates: [],
        legend: { "dept:beauty & personal care": { code: "BPC", status: "approved" } }, // brand missing
      }),
      httpGet: makeRoutedHttpGet({ catalog: HAPPY_CATALOG }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("legend_pending");
    if (r.kind === "legend_pending") {
      expect(r.pending.brand?.rawValue).toBe("AminoGenesis");
      expect(r.pending.brand?.status).toBe("not_in_legend");
    }
  });

  it("blank brand → legend_pending 'missing' (§18 2026-08-29 reclassification), not error", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({ eligibility: "yes", candidates: [] }),
      httpGet: makeRoutedHttpGet({
        catalog: { summaries: [{ brand: "" }], classifications: HAPPY_CATALOG.classifications },
      }),
      sellerId: SELLER,
    });
    expect(r.kind).toBe("legend_pending");
    if (r.kind === "legend_pending") expect(r.pending.brand?.status).toBe("missing");
  });

  // ────────────────────────────────────────────────────────────────────────
  // already_in_catalog — Maria's 2026-06-28 fix for the B00CA6Z37C bug.
  // Format-agnostic SC presence check via searchListingsItems, BEFORE the
  // format-aware candidate lookup. Catches legacy SKUs (AMG-BP-...), PFL_*,
  // Amazon-random — any pre-existing listing under our seller for this ASIN.
  // ────────────────────────────────────────────────────────────────────────

  it("already_in_catalog: searchListingsItems returns ≥1 item (legacy SKU) → skip", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({ eligibility: "yes" }),
      sellerId: SELLER,
      httpGet: makeRoutedHttpGet({
        listingsSearch: {
          numberOfResults: 1,
          items: [{ sku: "AMG-BP-CLN-RRC-002-C", summaries: [{ status: ["DISCOVERABLE"] }] }],
        },
      }),
    });
    expect(r.kind).toBe("already_in_catalog");
    if (r.kind === "already_in_catalog") {
      expect(r.items).toHaveLength(1);
      expect(r.items[0].sku).toBe("AMG-BP-CLN-RRC-002-C");
      expect(r.items[0].statuses).toEqual(["DISCOVERABLE"]);
    }
  });

  it("already_in_catalog: catches PFL_ prep-center SKUs too (format-agnostic)", async () => {
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({ eligibility: "yes" }),
      sellerId: SELLER,
      httpGet: makeRoutedHttpGet({
        listingsSearch: {
          numberOfResults: 1,
          items: [{ sku: "PFL_AMINO_XYZ123", summaries: [{ status: ["BUYABLE", "DISCOVERABLE"] }] }],
        },
      }),
    });
    expect(r.kind).toBe("already_in_catalog");
    if (r.kind === "already_in_catalog") expect(r.items[0].sku).toBe("PFL_AMINO_XYZ123");
  });

  it("already_in_catalog skip happens BEFORE catalog fetch (no catalog call made)", async () => {
    let catalogCalled = false;
    const httpGet = async (endpoint: string) => {
      if (endpoint.startsWith("/catalog/")) {
        catalogCalled = true;
        throw new Error("should not have called catalog");
      }
      // search returns present
      if (endpoint.startsWith("/listings/")) {
        return { numberOfResults: 1, items: [{ sku: "X", summaries: [{ status: ["DISCOVERABLE"] }] }] };
      }
      throw new Error(`unrouted: ${endpoint}`);
    };
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({ eligibility: "yes" }),
      sellerId: SELLER,
      httpGet,
    });
    expect(r.kind).toBe("already_in_catalog");
    expect(catalogCalled).toBe(false); // gates BEFORE catalog fetch (dead_asin) and BEFORE generate
  });

  // 20s timeout: with searchListingsItemsByAsin's 5-attempt retry budget +
  // 1s initial backoff doubling (1+2+4+8 = 15s max), this test waits for the
  // full exhaustion path before asserting the fail-closed outcome.
  it("listings_search_failed: presence check 429s out → error (does NOT silently route to generate)", { timeout: 20000 }, async () => {
    // CRITICAL: a throttled search must NOT degrade to "absent" → generate-new.
    // That would create duplicate offers on rate-limit storms.
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({ eligibility: "yes" }),
      sellerId: SELLER,
      httpGet: makeRoutedHttpGet({
        listingsSearch: { error: 429, body: { errors: [{ code: "QuotaExceeded", message: "Too many" }] } },
      }),
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toBe("listings_search_failed");
  });

  it("absent in SC → proceeds to existing reuse/generate path (no regression)", async () => {
    // Verifies the new check defaults to "absent" cleanly when SC has nothing —
    // the entire existing decision tree below it still runs unchanged.
    const r = await resurrectOrGenerateSku(ASIN, 1, {
      queryFn: makeRoutedQueryFn({
        eligibility: "yes",
        candidates: [],
        legend: HAPPY_LEGEND,
      }),
      sellerId: SELLER,
      httpGet: makeRoutedHttpGet({
        listingsSearch: { numberOfResults: 0, items: [] }, // SC genuinely empty
        catalog: HAPPY_CATALOG,
      }),
    });
    expect(r.kind).toBe("generate");
  });

  it("variantSuffix bypasses resurrection — skips candidate lookup, generates new SKU with suffix", async () => {
    let candidateQueried = false;
    const queryFn = async (sql: string, params?: any[]) => {
      if (sql.includes("FROM asin_estimates")) return { rows: [{ eligibility_status: "yes" }] };
      if (sql.includes("FROM asin_skus")) {
        candidateQueried = true;
        return { rows: [] };
      }
      if (sql.includes("FROM sku_legend_alias")) {
        const [type, rawValue] = params ?? [];
        const key = `${type}:${String(rawValue ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;
        const row = (HAPPY_LEGEND as any)[key];
        return { rows: row ? [{ legend_id: "uuid-test", code: row.code, status: row.status }] : [] };
      }
      return { rows: [] };
    };

    const r = await resurrectOrGenerateSku(
      ASIN, 4,
      { queryFn, httpGet: makeRoutedHttpGet({ catalog: HAPPY_CATALOG }), sellerId: SELLER },
      "B",
    );
    expect(r.kind).toBe("generate");
    if (r.kind === "generate") expect(r.sku).toBe("AMG-BPC-X8M-TFR-004-B");
    expect(candidateQueried).toBe(false); // bypass confirmed
  });
});
