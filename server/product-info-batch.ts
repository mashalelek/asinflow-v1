// Batch endpoints for Product Info + the Prices & Stock fees stage
// (SPEC §11, 2026-09-07). Catalog: searchCatalogItems by ASIN identifiers
// (20/call at 2/s → 40 ASINs/s). Fees: POST /products/fees/v0/feesEstimate
// (20/call at 0.5/s → 10 ASINs/s). Both paced by the shared rate limiter.
//
// DA-2 semantics for the batch catalog: an ASIN absent from a COMPLETE 2xx
// response is catalog-deleted (the batch analogue of a 404); a THROWN call
// is inconclusive for every ASIN in it — fail-closed, no catalog_deleted.
import { spApiGet, spApiPost } from "./spapi-auth";
import { parseCatalogItem, parseFeeResult, type AsinCatalogResult, type AsinFeesResult } from "./spapi";
import { log } from "./log";

const MARKETPLACE = "ATVPDKIKX0DER";
const PER_CALL = 20;

export type CatalogBatchEntry =
  | { kind: "parsed"; data: AsinCatalogResult }
  | { kind: "absent" }        // complete response, ASIN missing → catalog-deleted signal
  | { kind: "inconclusive"; message: string }; // call failed → preserve stored values

export async function fetchCatalogBatch(asins: string[]): Promise<Map<string, CatalogBatchEntry>> {
  const out = new Map<string, CatalogBatchEntry>();
  for (let i = 0; i < asins.length; i += PER_CALL) {
    const chunk = asins.slice(i, i + PER_CALL);
    let body: any;
    try {
      body = await spApiGet(`/catalog/2022-04-01/items`, {
        marketplaceIds: MARKETPLACE,
        identifiers: chunk.join(","),
        identifiersType: "ASIN",
        includedData: "attributes,dimensions,images,salesRanks,summaries",
        pageSize: PER_CALL,
      });
    } catch (err: any) {
      const msg = `${err?.response?.status ?? "?"}: ${err?.message ?? "unknown"}`;
      for (const asin of chunk) out.set(asin, { kind: "inconclusive", message: msg });
      continue;
    }
    const items: any[] = body?.items ?? [];
    const byAsin = new Map<string, any>(items.map((it) => [String(it?.asin ?? "").toUpperCase(), it]));
    for (const asin of chunk) {
      const item = byAsin.get(asin.toUpperCase());
      if (item) out.set(asin, { kind: "parsed", data: parseCatalogItem(asin, item) });
      else out.set(asin, { kind: "absent" });
    }
  }
  return out;
}

export type FeesBatchEntry =
  | { kind: "parsed"; fees: AsinFeesResult }
  | { kind: "error"; message: string };

// Batch feesEstimate: responses come back keyed by IdValue (the ASIN we set
// as each request's identifier); order is not guaranteed, so match by id.
export async function fetchFeesBatch(
  items: Array<{ asin: string; price: number; category?: string | null }>,
): Promise<Map<string, FeesBatchEntry>> {
  const out = new Map<string, FeesBatchEntry>();
  for (let i = 0; i < items.length; i += PER_CALL) {
    const chunk = items.slice(i, i + PER_CALL);
    let body: any;
    try {
      body = await spApiPost(`/products/fees/v0/feesEstimate`, chunk.map((it) => ({
        FeesEstimateRequest: {
          MarketplaceId: MARKETPLACE,
          IsAmazonFulfilled: true,
          PriceToEstimateFees: { ListingPrice: { CurrencyCode: "USD", Amount: it.price } },
          Identifier: it.asin,
        },
        IdType: "ASIN",
        IdValue: it.asin,
      })));
    } catch (err: any) {
      const msg = `${err?.response?.status ?? "?"}: ${err?.message ?? "unknown"}`;
      for (const it of chunk) out.set(it.asin, { kind: "error", message: msg });
      continue;
    }
    // The batch response body IS the array of FeesEstimateResult-shaped
    // objects (verified live 2026-09-07) — no payload wrapper.
    const results: any[] = Array.isArray(body) ? body : Array.isArray(body?.payload) ? body.payload : body?.payload?.FeesEstimateResultList ?? [];
    const byId = new Map<string, any>();
    for (const r of results) {
      const id = String(r?.FeesEstimateIdentifier?.IdValue ?? r?.FeesEstimateIdentifier?.SellerInputIdentifier ?? "").toUpperCase();
      if (id) byId.set(id, r);
    }
    for (let j = 0; j < chunk.length; j++) {
      const it = chunk[j];
      const r = byId.get(it.asin.toUpperCase()) ?? results[j];
      if (!r) { out.set(it.asin, { kind: "error", message: "missing from batch response" }); continue; }
      const status = String(r?.Status ?? "Success");
      if (!/success/i.test(status)) {
        const msg = r?.Error?.Message ?? r?.ErrorDetail?.[0]?.Message ?? status;
        out.set(it.asin, { kind: "error", message: String(msg) });
        continue;
      }
      try {
        out.set(it.asin, { kind: "parsed", fees: parseFeeResult(it.asin, r?.FeesEstimateResult ?? r, it.price, it.category) });
      } catch (e: any) {
        out.set(it.asin, { kind: "error", message: `parse: ${e?.message ?? "unknown"}` });
      }
    }
  }
  return out;
}
