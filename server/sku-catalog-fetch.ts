// Live catalog fetch for SKU generation. Reads brand + top-level category
// from getCatalogItem at SKU-creation time so we don't depend on whether the
// ASIN has been analyzed.
//
// Category source: classifications-chain top-level (NOT salesRanks).
// Reason: the sku_legend dept seeds were captured from the same classifications-
// chain walk used by the full-catalog scan. Reading category from a different
// source (e.g. salesRanks) would produce different strings sometimes (e.g.
// "Coffee" vs "Grocery & Gourmet Food") → spurious legend misses on ASINs
// that should resolve. The generator MUST read from the same source the
// legend was seeded against. This deliberately diverges from the analyze
// path's bsrCategory derivation — analyze never had to legend-match.
//
// SUB removed entirely (Option 3) — no classifications-leaf parsing.
//
// httpGet is injected (default = real spApiGet) so tests can stub without
// network access.

import { spApiGet as realSpApiGet } from "./spapi-auth";
import { isDangerousGoodFromAttributes, dgHzRegulationFromAttributes } from "./hazmat-classify";

const MARKETPLACE = "ATVPDKIKX0DER";

export interface CatalogFetchResult {
  asin: string;
  category: string | null;     // classifications-chain top-level
  brand: string | null;
  itemName: string | null;
  imageUrl: string | null;
  // DG classification LIVE-derived from this same fetch (attributes.hazmat
  // present). Offer-add reads THIS, never the stored is_dangerous_good column,
  // so the DG attribute is immune to stale/NULL backfill state.
  isDangerousGood: boolean;
  // Catalog's own supplier_declared_dg_hz_regulation value (US marketplace), or
  // null if absent. The offer payload passes this through verbatim when enum-
  // valid — see resolveDgHzRegulation.
  dgHzRegulation: string | null;
}

export type CatalogFetchOutcome =
  | { ok: true; data: CatalogFetchResult }
  | { ok: false; reason: "dead_asin"; status: 404 }
  | { ok: false; reason: "no_brand" | "no_category" }
  | { ok: false; reason: "transient_error"; status?: number; message: string; retryable: true };

export type HttpGetFn = (endpoint: string, params?: Record<string, any>) => Promise<any>;

// Retry config mirrors searchListingsItemsByAsin exactly (5 attempts, 1000ms
// initial backoff doubling = 15s max under extreme throttle). Both APIs share
// the same Listings/Catalog rate-limit family (5 rps / 5 burst), so they
// share the same retry budget.
//
// CRITICAL: only HTTP 429 / QuotaExceeded retries. A genuine 404 (dead ASIN)
// must FAIL FAST — not waste 15 seconds retrying something Amazon will never
// resolve. Any non-throttle error also short-circuits.
export interface CatalogFetchRetryConfig {
  maxAttempts: number;
  initialBackoffMs: number;
}
const DEFAULT_RETRY: CatalogFetchRetryConfig = {
  maxAttempts: 5,
  initialBackoffMs: 1000,
};

// Walks the classifications chain to the top-level (rightmost ancestor with
// a displayName). Returns null if classifications block is missing/empty.
//
// Multi-path handling: if Amazon returns multiple classification paths for
// the same ASIN, prefer the first. The full-catalog scan showed 5.7% of ASINs
// are multi-path; the first path's top is generally the same canonical
// department (e.g. "Tools & Home Improvement") in the cases that matter.
function extractTopCategory(data: any): string | null {
  const paths = data?.classifications?.[0]?.classifications;
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const leaf = paths[0];
  if (!leaf) return null;
  let cur: any = leaf;
  let top: string | null = leaf.displayName ?? null;
  while (cur?.parent) {
    cur = cur.parent;
    if (cur.displayName) top = cur.displayName;
  }
  return top;
}

export async function fetchCatalogForSku(
  asin: string,
  httpGet: HttpGetFn = realSpApiGet,
  retryConfig: CatalogFetchRetryConfig = DEFAULT_RETRY,
): Promise<CatalogFetchOutcome> {
  let data: any;
  let backoff = retryConfig.initialBackoffMs;
  let attempt = 0;
  while (true) {
    try {
      data = await httpGet(`/catalog/2022-04-01/items/${asin}`, {
        marketplaceIds: MARKETPLACE,
        // `attributes` piggybacks the DG signal onto this existing fetch (zero
        // extra call on the generate path).
        includedData: "summaries,classifications,images,attributes",
      });
      break; // success — exit retry loop
    } catch (err: any) {
      const status = err?.response?.status;
      const code =
        err?.response?.data?.errors?.[0]?.code ??
        err?.response?.data?.Errors?.[0]?.Code;
      const isThrottle = status === 429 || code === "QuotaExceeded";

      // Retry ONLY on throttle, and only while we have attempts left.
      // CRITICAL: 404 (dead ASIN) is NOT a throttle — falls through to the
      // fail-fast return below. Same for any other non-throttle error.
      if (isThrottle && attempt < retryConfig.maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff *= 2;
        attempt++;
        continue;
      }

      // 404 → dead_asin (fast-fail, never retried — checked AFTER the
      // throttle branch above so we never spend retry budget on a 404)
      if (status === 404) return { ok: false, reason: "dead_asin", status: 404 };

      // Everything else (incl. throttle after exhausting retries) → transient.
      // Fail-closed: caller surfaces this as resurrection_error, ASIN
      // excluded from Ready. Never degrades to a default catalog.
      return {
        ok: false,
        reason: "transient_error",
        status,
        message:
          err?.response?.data?.errors?.[0]?.message ?? err?.message ?? "unknown",
        retryable: true,
      };
    }
  }

  const summary = data?.summaries?.[0] ?? {};
  const brand: string | null = (summary.brand ?? "").toString().trim() || null;
  if (!brand) return { ok: false, reason: "no_brand" };

  const category = extractTopCategory(data);
  if (!category) return { ok: false, reason: "no_category" };

  const itemName = (summary.itemName ?? "").toString().trim() || null;
  const imageUrl = data?.images?.[0]?.images?.[0]?.link ?? null;
  const isDangerousGood = isDangerousGoodFromAttributes(data?.attributes);
  const dgHzRegulation = dgHzRegulationFromAttributes(data?.attributes);

  return {
    ok: true,
    data: { asin, category, brand, itemName, imageUrl, isDangerousGood, dgHzRegulation },
  };
}

// Reuse-path DG probe. The reuse path (offer added to an already-listed SKU)
// skips fetchCatalogForSku, so it has no fresh attributes — this dedicated call
// keeps DG LIVE there too (still never touches the stored column). One fetch,
// both signals:
//   { isDangerousGood, dgHzRegulation } — attributes read (dgHzRegulation may be
//                                          null if the catalog omits the attr)
//   null                                — fetch failed (404/transient); caller
//                                          decides the safe default
export async function fetchDgHzLive(
  asin: string,
  httpGet: HttpGetFn = realSpApiGet,
): Promise<{ isDangerousGood: boolean; dgHzRegulation: string | null } | null> {
  try {
    const data = await httpGet(`/catalog/2022-04-01/items/${asin}`, {
      marketplaceIds: MARKETPLACE,
      includedData: "attributes",
    });
    return {
      isDangerousGood: isDangerousGoodFromAttributes(data?.attributes),
      dgHzRegulation: dgHzRegulationFromAttributes(data?.attributes),
    };
  } catch {
    return null;
  }
}
