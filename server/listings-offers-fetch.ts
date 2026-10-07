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
  // §18 v2 qualified offer set (2026-10-07). Both needed to qualify an offer;
  // the resolver does the qualifying, this module only reports what Amazon
  // said.
  //
  // feedbackCount: SellerFeedbackRating.FeedbackCount. NULL when Amazon omits
  // the block entirely — the resolver treats null as 0, i.e. disqualified,
  // because "no track record" is exactly the case the >= 15 rule exists for.
  feedbackCount: number | null;
  isAmazon: boolean;
}

// Amazon's own retail seller ID in the US marketplace. Amazon is technically
// FBA but we never compete with it (§18 v2 / §23), so it is excluded from
// every qualified offer set.
//
// STILL NOT CONFIRMED LIVE as of 2026-10-07. Checked against every
// getItemOffers response in the v2 reprice preview — 49 ASINs, every offer
// inspected: ZERO offers with this seller ID, and ZERO offers missing
// SellerFeedbackRating. So this account's catalog simply has no
// Amazon-sold competition to test against, and the secondary signal
// (Amazon carries no feedback rating) is equally untested here.
//
// The value is the documented US retail merchant token, which is the same
// string as the marketplace ID — a known SP-API quirk, not a typo. Next time
// an Amazon-sold offer DOES appear, verify both: that the ID matches, and
// whether Amazon's offer carries a feedback count. Until then treat the
// constant as unverified.
//
// Safety net if it is ever wrong: Amazon retail offers carry no
// SellerFeedbackRating, so feedbackCount is null → 0 → disqualified by the
// >= 15 rule anyway. A wrong constant here mislabels the REASON
// (under_15_feedback instead of amazon_offer); it does not let an Amazon
// offer into the qualified set.
export const AMAZON_US_SELLER_ID = "ATVPDKIKX0DER";

export type OffersFetchOutcome =
  | {
      ok: true;
      competingOffers: number[];
      ourOffer: number | null;
      allOffers: CompetingOffer[];
      // 18555-cap reference data from payload.Summary of the SAME response —
      // zero extra API calls (SPEC §18 "Suppression cap"). Frequently absent:
      // null when the field isn't in the Summary.
      competitivePriceThreshold: number | null;
      buyBoxPrice: number | null; // New-condition landed buy box price
    }
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
 * NOTE: includes ALL non-our offers — both FBA and FBM, Amazon and
 * third-party, any feedback count. This module does NOT qualify offers; it
 * reports what Amazon returned. §18 v2's qualified set (Amazon excluded,
 * feedback >= 15) is applied in shared/price-resolver.ts, which needs the
 * full list to report disqualified counts and reasons.
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
  // 429 handling moved to the shared rate limiter (SPEC §11, 2026-09-06):
  // requests are paced at the wire and throttles are retried THERE, once —
  // this module's 2200ms-doubling loop was removed, not layered.
  let data: any;
  {
    try {
      data = await httpGet(`/products/pricing/v0/items/${asin}/offers`, {
        MarketplaceId: MARKETPLACE,
        ItemCondition: "New",
      });
    } catch (err: any) {
      const status = err?.response?.status;

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
      const fbRaw = o?.SellerFeedbackRating?.FeedbackCount;
      const fbNum = fbRaw != null ? Number(fbRaw) : NaN;
      const sellerId = String(o?.SellerId ?? "");
      return {
        sellerId,
        price: landed,
        isFba: o?.IsFulfilledByAmazon === true,
        feedbackCount: Number.isFinite(fbNum) ? fbNum : null,
        isAmazon: sellerId === AMAZON_US_SELLER_ID,
      };
    })
    .filter((o) => o.price > 0 && o.sellerId.length > 0);

  const ourOffers = allOffers.filter((o) => o.sellerId === ourSellerId);
  const competing = allOffers.filter((o) => o.sellerId !== ourSellerId);

  // 18555-cap reference data (payload.Summary — same response, free).
  const summary = data?.payload?.Summary ?? {};
  const cptRaw = summary?.CompetitivePriceThreshold?.Amount;
  const cptNum = cptRaw != null ? parseFloat(cptRaw) : NaN;
  const competitivePriceThreshold = !isNaN(cptNum) && cptNum > 0 ? cptNum : null;
  const bbEntry = (summary?.BuyBoxPrices ?? []).find(
    (b: any) => String(b?.condition ?? "").toLowerCase() === "new",
  ) ?? (summary?.BuyBoxPrices ?? [])[0];
  const bbRaw = bbEntry?.LandedPrice?.Amount ?? bbEntry?.ListingPrice?.Amount;
  const bbNum = bbRaw != null ? parseFloat(bbRaw) : NaN;
  const buyBoxPrice = !isNaN(bbNum) && bbNum > 0 ? bbNum : null;

  return {
    ok: true,
    competingOffers: competing.map((o) => o.price).sort((a, b) => b - a),
    ourOffer: ourOffers.length > 0 ? ourOffers[0].price : null,
    allOffers,
    competitivePriceThreshold,
    buyBoxPrice,
  };
}
