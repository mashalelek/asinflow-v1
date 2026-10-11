// "Does any SKU listing exist under (sellerId, ASIN) in our Seller Central
// right now?" — the per-ASIN presence check that drives the resurrection
// pre-gate (already_in_catalog → skip the entire offer-add flow).
//
// Endpoint: GET /listings/2021-08-01/items/{sellerId}
//   query: marketplaceIds, identifiers={asin}, identifiersType=ASIN, includedData=summaries
//
// Response shape:
//   { numberOfResults: N, items: [{ sku, summaries:[{ status:[...] }] }, ...] }
//
// Format-agnostic by design: this is "ANY listing exists" — DISCOVERABLE,
// BUYABLE, closed-but-still-attached, any SKU format (canonical, legacy,
// PFL_*, Amazon-random), any status. The conforming-vs-legacy SKU distinction
// is irrelevant to duplicate detection.
//
// Retry pattern mirrors fetchCompetingOffers (listings-offers-fetch.ts) —
// same loop shape with Listings API rate limit (5 rps / 10 burst); initial
// backoff 1000ms (vs offers' 2200ms for 0.5 rps). Triggered on HTTP 429 OR
// error code "QuotaExceeded".

import { spApiGet as realSpApiGet } from "./spapi-auth";
import type { HttpGetFn } from "./sku-catalog-fetch";

const MARKETPLACE = "ATVPDKIKX0DER";

export interface PresentListing {
  sku: string;
  statuses: string[]; // empty array if summary lacks status field
}

export type ListingsByAsinOutcome =
  | { ok: true; present: true; items: PresentListing[] }
  | { ok: true; present: false }
  | { ok: false; reason: "transient_error"; status?: number; message: string };

export interface SearchListingsRetryConfig {
  maxAttempts: number;
  initialBackoffMs: number;
}
const DEFAULT_RETRY: SearchListingsRetryConfig = {
  // 5 attempts at 1000ms initial doubling backoff (1+2+4+8 = 15s max under
  // extreme throttle). Sized to absorb sustained-burst classification runs
  // for batches of 100+ ASINs without surfacing transient throttling as
  // listings_search_failed.
  maxAttempts: 5,
  initialBackoffMs: 1000,
};

/**
 * Return all listings under this seller for this ASIN (any SKU, any status).
 * Returns present=true with the item list if numberOfResults > 0.
 * Returns present=false (NOT an error) if SC has no listing under our seller
 * for this ASIN — that's the "eligible for new offer" signal.
 *
 * The shape mirrors fetchCompetingOffers' return discriminator: callers MUST
 * distinguish "ok+present" from "ok+absent" from "fetch_failed". A 429 storm
 * must NEVER silently degrade to "absent" — that would route an already-listed
 * ASIN to generate-new and create a duplicate offer.
 */
export async function searchListingsItemsByAsin(
  sellerId: string,
  asin: string,
  httpGet: HttpGetFn = realSpApiGet,
  retryConfig: SearchListingsRetryConfig = DEFAULT_RETRY,
): Promise<ListingsByAsinOutcome> {
  let data: any;
  let backoff = retryConfig.initialBackoffMs;
  let attempt = 0;
  while (true) {
    try {
      data = await httpGet(`/listings/2021-08-01/items/${sellerId}`, {
        marketplaceIds: MARKETPLACE,
        identifiers: asin,
        identifiersType: "ASIN",
        includedData: "summaries",
      });
      break;
    } catch (err: any) {
      const status = err?.response?.status;
      const code =
        err?.response?.data?.errors?.[0]?.code ??
        err?.response?.data?.Errors?.[0]?.Code;
      const isThrottle = status === 429 || code === "QuotaExceeded";

      if (isThrottle && attempt < retryConfig.maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff *= 2;
        attempt++;
        continue;
      }
      // No 404 special-case: searchListingsItems returns 200 with
      // numberOfResults=0 for "no listing exists", not 404. Any other status
      // is a real failure.
      return {
        ok: false,
        reason: "transient_error",
        status,
        message:
          err?.response?.data?.errors?.[0]?.message ?? err?.message ?? "unknown",
      };
    }
  }

  // §18 A1 (2026-10-09): a row with no summary is a SKU shell, not a listing.
  // Shells are filtered out BEFORE the present/absent decision, so a shell
  // cannot make an ASIN permanently un-addable through the already_in_catalog
  // pre-gate. No duplicate risk: resurrection reuses the shell's OWN SKU
  // string, so the re-add is a PUT to that same SKU.
  //
  // Observed scope: the unfiltered account walk (2026-10-09) returned zero
  // empty-summary rows across all 805 SKUs, so shells are a per-SKU
  // getListingsItem artifact. This filter is belt-and-braces for the by-ASIN
  // path, and it is also what keeps A1 a single rule rather than two.
  const raw: any[] = data?.items ?? [];
  const items = raw.filter(
    (it) => Array.isArray(it?.summaries) && it.summaries.length > 0,
  );
  if (items.length === 0) {
    return { ok: true, present: false };
  }
  return {
    ok: true,
    present: true,
    items: items.map((it) => ({
      sku: String(it?.sku ?? ""),
      statuses: it?.summaries?.[0]?.status ?? [],
    })),
  };
}
