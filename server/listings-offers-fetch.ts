// getItemOffers wrapper — returns competing offer prices for an ASIN with
// OUR seller's offer filtered out. Used by the DA-4 price resolver.
//
// Endpoint: GET /products/pricing/v0/items/{Asin}/offers
// Required query params:
//   MarketplaceId, ItemCondition
//
// Response shape (relevant fields):
//   payload.Offers[]: array of offers, each with:
//     - SellerId         (string — used to filter out our own offer)
//     - ListingPrice     ({ Amount, CurrencyCode })
//     - ShippingPrice    ({ Amount, CurrencyCode })  [add to ListingPrice for landed]
//     - IsFulfilledByAmazon (boolean)
//
// We use landed price (ListingPrice + ShippingPrice) since that's what a
// shopper actually pays.

import { spApiGet as realSpApiGet } from "./spapi-auth";
import type { HttpGetFn } from "./sku-catalog-fetch";

const MARKETPLACE = "ATVPDKIKX0DER";

export interface CompetingOffer {
  sellerId: string;
  price: number;            // landed price (listing + shipping)
  isFba: boolean;
}

export type OffersFetchOutcome =
  | { ok: true; competingOffers: number[]; ourOffer: number | null; allOffers: CompetingOffer[] }
  | { ok: false; reason: "not_found" | "transient_error"; status?: number; message: string };

// Retry config (defaults to production values). Exposed for tests to override —
// otherwise a 429-exhaustion test would wait ~15s on real backoff.
export interface OffersRetryConfig {
  maxAttempts: number;
  initialBackoffMs: number;
}
const DEFAULT_RETRY: OffersRetryConfig = {
  maxAttempts: 3,        // initial attempt + 2 retries
  initialBackoffMs: 2200, // matches getItemOffers' confirmed 0.5 rps limit (2000ms minimum + margin)
};

/**
 * Fetch competing offer prices for an ASIN with our seller filtered out.
 * Returns just the prices (sorted desc, what the resolver needs) plus the
 * full per-offer list for diagnostic visibility.
 *
 * NOTE: includes ALL non-our offers — both FBA and FBM. The resolver's
 * "highest competing offer + 30%" rule treats both equally; if you ever
 * want FBA-only competition, filter on `allOffers[].isFba` in the caller.
 *
 * Retry pattern mirrors getCommingleHazmat (spapi.ts:826) — same loop shape,
 * backoff doubling, max retries — keeping ONE retry pattern in the codebase
 * rather than two divergent ones. Triggered on HTTP 429 OR error code
 * "QuotaExceeded" (SP-API surfaces throttling both ways). 404 / other errors
 * bail immediately without retry.
 */
export async function fetchCompetingOffers(
  asin: string,
  ourSellerId: string,
  httpGet: HttpGetFn = realSpApiGet,
  retryConfig: OffersRetryConfig = DEFAULT_RETRY,
): Promise<OffersFetchOutcome> {
  let data: any;
  let backoff = retryConfig.initialBackoffMs;
  let attempt = 0;
  while (true) {
    try {
      data = await httpGet(`/products/pricing/v0/items/${asin}/offers`, {
        MarketplaceId: MARKETPLACE,
        ItemCondition: "New",
      });
      break; // success — exit retry loop
    } catch (err: any) {
      const status = err?.response?.status;
      const code =
        err?.response?.data?.Errors?.[0]?.Code ??
        err?.response?.data?.errors?.[0]?.code;
      const isThrottle = status === 429 || code === "QuotaExceeded";

      // Retry only on throttle, and only while we have attempts left.
      if (isThrottle && attempt < retryConfig.maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff *= 2;
        attempt++;
        continue;
      }

      // 404 → not_found (don't retry; ASIN genuinely missing)
      if (status === 404) {
        return { ok: false, reason: "not_found", status: 404, message: "ASIN not found in pricing API" };
      }
      // Everything else (incl. throttle after exhausting retries) → transient
      return {
        ok: false,
        reason: "transient_error",
        status,
        message: err?.response?.data?.Errors?.[0]?.Message ?? err?.message ?? "unknown",
      };
    }
  }

  const offers: any[] = data?.payload?.Offers ?? [];
  const allOffers: CompetingOffer[] = offers
    .map((o) => {
      const listing = parseFloat(o?.ListingPrice?.Amount ?? "0");
      const shipping = parseFloat(o?.ShippingPrice?.Amount ?? "0");
      const landed = listing + (isNaN(shipping) ? 0 : shipping);
      return {
        sellerId: String(o?.SellerId ?? ""),
        price: landed,
        isFba: o?.IsFulfilledByAmazon === true,
      };
    })
    .filter((o) => o.price > 0 && o.sellerId.length > 0);

  const ourOffers = allOffers.filter((o) => o.sellerId === ourSellerId);
  const competing = allOffers.filter((o) => o.sellerId !== ourSellerId);

  return {
    ok: true,
    competingOffers: competing.map((o) => o.price).sort((a, b) => b - a),
    ourOffer: ourOffers.length > 0 ? ourOffers[0].price : null,
    allOffers,
  };
}
