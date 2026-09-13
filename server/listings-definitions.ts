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
import { DG_HZ_REGULATION_ENUM } from "./hazmat-classify";

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
  // UNPACED (flagged 2026-09-13, deliberately not fixed): this path has NO
  // entry in spapi-rate-limit's OPERATION_TABLE, so the limiter logs "sending
  // unpaced" and lets it through at wire speed. Safe ONLY because the 24h
  // cache above means at most one call per product type per day. If you ever
  // call this in a loop, per ASIN, or with the cache disabled, add a rate
  // table entry FIRST.
  const data = await httpGet(
    `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`,
    { marketplaceIds: MARKETPLACE, sellerId },
  );
  cache.set(key, { schema: data, fetchedAt: Date.now() });
  return data;
}

// Exposed for tests. Clears BOTH the definitions cache and the derived
// dg-hz-regulation enum cache (the enum is derived from the definitions, so
// invalidating one must invalidate the other).
export function clearProductTypeDefinitionCache() {
  cache.clear();
  enumCache.clear();
}

// Resolve the supplier_declared_dg_hz_regulation enum from the fetched product-
// type schema. getDefinitionsProductType returns a schema LINK (S3 URL); we
// fetch + parse it, extract the attribute's allowed values, and cache them 24h.
// Falls back to the verified product-type-invariant constant if the schema
// can't be resolved/parsed — so a flaky S3 fetch never blocks a submission while
// still validating against the correct set. The getDefinitionsProductType call
// also stays as the §18-required "product type exists" tripwire.
const DG_ATTR = "supplier_declared_dg_hz_regulation";
const enumCache = new Map<string, { values: string[]; fetchedAt: number }>();

export async function fetchDgHzRegulationEnum(
  productType: string,
  sellerId: string,
  httpGet: HttpGetFn = realSpApiGet,
  fallback: readonly string[] = DG_HZ_REGULATION_ENUM,
): Promise<string[]> {
  const key = `${productType}:${sellerId}`;
  const cached = enumCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.values;

  // Tripwire + schema link (throws on definitions failure → caller aborts ASIN).
  const def = await fetchProductTypeDefinition(productType, sellerId, httpGet);
  let values: string[] = [...fallback];
  try {
    const url = def?.schema?.link?.resource;
    if (url) {
      const schema = await (await fetch(url)).json();
      const en = schema?.properties?.[DG_ATTR]?.items?.properties?.value?.enum;
      if (Array.isArray(en) && en.length > 0) values = en;
    }
  } catch (err: any) {
    // Transient S3 schema fetch/parse error → do NOT fail the row. The enum is
    // verified product-type-invariant, so the constant fallback is authoritative.
    // Log loudly and continue.
    // eslint-disable-next-line no-console
    console.warn(`[listings-definitions] dg-hz enum schema fetch failed for ${productType}; using verified constant fallback: ${err?.message ?? err}`);
  }
  enumCache.set(key, { values, fetchedAt: Date.now() });
  return values;
}

export function clearDgHzRegulationEnumCache() {
  enumCache.clear();
}
