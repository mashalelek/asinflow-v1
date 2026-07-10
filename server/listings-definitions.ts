// getDefinitionsProductType — the spec-required first step before assembling
// a putListingsItem payload. Returns Amazon's schema for the product type.
//
// We don't currently use the schema to dynamically shape the payload (that's
// a deeper rabbit hole — schemas have ~50 attributes with nested types).
// Instead, the call serves three purposes today:
//   1. Validates the productType exists for this seller (catches typos like
//      productType='PRODUCT_X' before we waste a putListingsItem call).
//   2. Provides an integration smoke check that auth + marketplace are correct.
//   3. Future schema-driven validation can layer in here without changing
//      callers (the result is returned for inspection).
//
// Cached per (productType, sellerId) for 24h — schemas are stable; per-call
// fetch is wasteful when the offer-add UI submits a batch of N ASINs.

import { spApiGet as realSpApiGet } from "./spapi-auth";
import type { HttpGetFn } from "./sku-catalog-fetch";

const MARKETPLACE = "ATVPDKIKX0DER";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h — schemas change rarely

interface CacheEntry {
  schema: any;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function fetchProductTypeDefinition(
  productType: string,
  sellerId: string,
  httpGet: HttpGetFn = realSpApiGet,
): Promise<any> {
  const key = `${productType}:${sellerId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.schema;
  }
  const data = await httpGet(
    `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`,
    { marketplaceIds: MARKETPLACE, sellerId },
  );
  cache.set(key, { schema: data, fetchedAt: Date.now() });
  return data;
}

// Exposed for tests.
export function clearProductTypeDefinitionCache() {
  cache.clear();
}
