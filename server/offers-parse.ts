// Pure Summary/Offers payload parser (SPEC §11 "Refresh job & price refresh
// v2", 2026-09-06). Extracted from spapi.ts#getPricing so the single-ASIN
// analyze path and the getItemOffersBatch path share ONE implementation —
// each batch response's body.payload is identical in shape to the
// single-call payload. Pure: no HTTP, no logging, no DB.

export interface ParsedOffers {
  lowestFbaPrice: number | null;
  buyBoxPrice: number | null;
  buyBoxFulfillment: "FBA" | "FBM" | null;
  lowestPrice: number | null;
  numberOfSellers: number | null;
  sellersFba: number;
  sellersFbm: number;
  /** 200 with zero New offers — the conclusive "nothing is for sale". */
  noOffers: boolean;
}

export function parseOffersPayload(payload: any): ParsedOffers {
  let lowestFbaPrice: number | null = null;
  let buyBoxPrice: number | null = null;
  let buyBoxFulfillment: "FBA" | "FBM" | null = null;
  let lowestPrice: number | null = null;
  let numberOfSellers: number | null = null;
  let sellersFba: number | null = null;
  let sellersFbm: number | null = null;

  const summary = payload?.Summary;
  if (summary) {
    if (summary.LowestPrices) {
      for (const lp of summary.LowestPrices) {
        const cond = (lp.condition || "").toLowerCase();
        if (cond !== "new") continue; // skip used/refurbished prices
        const amt = parseFloat(lp.LandedPrice?.Amount);
        if (!isNaN(amt)) {
          const channel = lp.fulfillmentChannel || lp.FulfillmentChannel || "";
          if (channel === "Amazon") {
            if (lowestFbaPrice === null || amt < lowestFbaPrice) lowestFbaPrice = amt;
          }
          if (lowestPrice === null || amt < lowestPrice) lowestPrice = amt;
        }
      }
    }

    if (summary.TotalOfferCount != null) numberOfSellers = summary.TotalOfferCount;

    if (summary.NumberOfOffers) {
      for (const entry of summary.NumberOfOffers) {
        const cond = (entry.condition || entry.Condition || "").toLowerCase();
        const channel = entry.fulfillmentChannel || entry.FulfillmentChannel || "";
        const count = parseInt(entry.OfferCount ?? entry.Value ?? "0") || 0;
        if (cond === "new") {
          if (channel === "Amazon" || channel === "AFN") {
            sellersFba = (sellersFba ?? 0) + count;
          } else if (channel === "Merchant" || channel === "MFN") {
            sellersFbm = (sellersFbm ?? 0) + count;
          }
        }
      }
      if (numberOfSellers === null && (sellersFba || sellersFbm)) {
        numberOfSellers = (sellersFba ?? 0) + (sellersFbm ?? 0);
      }
    }
  }

  const offers = payload?.Offers;
  if (offers && Array.isArray(offers)) {
    let fbaCount = 0;
    let fbmCount = 0;
    for (const offer of offers) {
      // IsFulfilledByAmazon is the authoritative FBA indicator in the Offers
      // array; FulfillmentChannel only appears in the Summary section.
      const isFba = offer.IsFulfilledByAmazon === true;
      if (isFba) fbaCount++; else fbmCount++;

      const amt = parseFloat(offer.ListingPrice?.Amount);
      if (!isNaN(amt)) {
        const shipping = parseFloat(offer.Shipping?.Amount) || 0;
        const landed = amt + shipping;
        if (isFba) {
          if (lowestFbaPrice === null || landed < lowestFbaPrice) lowestFbaPrice = landed;
        }
        if (lowestPrice === null || landed < lowestPrice) lowestPrice = landed;
        if (offer.IsBuyBoxWinner === true) {
          buyBoxPrice = landed;
          buyBoxFulfillment = isFba ? "FBA" : "FBM";
        }
      }
    }
    if (sellersFba === null) sellersFba = fbaCount;
    if (sellersFbm === null) sellersFbm = fbmCount;
    if (numberOfSellers === null) numberOfSellers = (sellersFba ?? 0) + (sellersFbm ?? 0);
  }

  if (sellersFba === null) sellersFba = 0;
  if (sellersFbm === null) sellersFbm = 0;

  if (buyBoxPrice === null && summary?.BuyBoxPrices) {
    for (const bp of summary.BuyBoxPrices) {
      const cond = bp.condition || bp.Condition || "";
      if (cond === "New" || cond === "new") {
        const amt = parseFloat(bp.LandedPrice?.Amount);
        if (!isNaN(amt)) {
          buyBoxPrice = amt;
          buyBoxFulfillment = null;
        }
      }
    }
  }

  return {
    lowestFbaPrice,
    buyBoxPrice,
    buyBoxFulfillment,
    lowestPrice,
    numberOfSellers,
    sellersFba,
    sellersFbm,
    noOffers:
      lowestPrice === null && buyBoxPrice === null && sellersFba === 0 && sellersFbm === 0,
  };
}
