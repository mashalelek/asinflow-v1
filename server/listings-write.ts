// putListingsItem wrapper — produces a PutListingsCallResult for the mapper.
//
// Captures BOTH failure modes:
//   - HTTP non-2xx (axios rejects with err.response) → { kind: 'http_error' }
//   - HTTP 2xx with body.status='INVALID' (axios resolves; body inspected by
//     mapper, not here) → { kind: 'ok', body }
//   - No response at all (network reject) → { kind: 'network_error' }
//
// This file only does the call + envelope conversion. It NEVER inspects body
// content for failure detection — that's the mapper's job. Separation of
// concerns: transport here, semantic interpretation in listings-error-map.

import { spApiPut as realSpApiPut } from "./spapi-auth";
import type {
  PutListingsCallResult,
  ListingsItemResponse,
} from "./listings-error-map";

const MARKETPLACE = "ATVPDKIKX0DER";

export type HttpPutFn = (
  endpoint: string,
  body: any,
  params?: Record<string, any>,
) => Promise<any>;

export type PutListingsRequirements =
  | "LISTING"               // full product creation
  | "LISTING_OFFER_ONLY"    // offer-only matching (the DA-4 case)
  | "LISTING_PRODUCT_ONLY"; // product-only (no offer)

export interface PutListingsItemArgs {
  sellerId: string;
  sku: string;
  productType: string;                  // "PRODUCT" for offer-only matching
  attributes: Record<string, any>;
  requirements?: PutListingsRequirements;
}

export async function putListingsItem(
  args: PutListingsItemArgs,
  httpPut: HttpPutFn = realSpApiPut,
): Promise<PutListingsCallResult> {
  const endpoint = `/listings/2021-08-01/items/${args.sellerId}/${encodeURIComponent(args.sku)}`;
  const body = {
    productType: args.productType,
    requirements: args.requirements ?? "LISTING_OFFER_ONLY",
    attributes: args.attributes,
  };
  const params = { marketplaceIds: MARKETPLACE };

  try {
    const data: ListingsItemResponse = await httpPut(endpoint, body, params);
    return { kind: "ok", body: data };
  } catch (err: any) {
    if (err?.response?.status) {
      return {
        kind: "http_error",
        status: err.response.status,
        body: err.response.data,
      };
    }
    return {
      kind: "network_error",
      message: err?.message ?? "unknown network error",
    };
  }
}
