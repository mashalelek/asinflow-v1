// "Does this SKU exist in our Seller Central right now?" — drives the
// resurrection branch (404 → reuse the SKU string; 200 → duplicate warning).
//
// GET /listings/2021-08-01/items/{sellerId}/{sku}
//   404 → present=false (we already verified in the diag: a deleted SKU
//         reliably returns 404 with body code NOT_FOUND. No fuzzy signal.)
//   200 → present=true, statuses array from summaries[0].status
//   anything else → transient, surface to caller for retry/backoff

import { spApiGet as realSpApiGet } from "./spapi-auth";
import type { HttpGetFn } from "./sku-catalog-fetch";

const MARKETPLACE = "ATVPDKIKX0DER";

export type ListingStatusOutcome =
  | { ok: true; present: true; statuses: string[] }
  | { ok: true; present: false }
  | { ok: false; reason: "transient_error"; status?: number; message: string; retryable: true };

export async function checkSkuListingStatus(
  sellerId: string,
  sku: string,
  httpGet: HttpGetFn = realSpApiGet,
): Promise<ListingStatusOutcome> {
  try {
    const data = await httpGet(
      `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`,
      { marketplaceIds: MARKETPLACE, includedData: "summaries" },
    );
    const statuses: string[] = data?.summaries?.[0]?.status ?? [];
    return { ok: true, present: true, statuses };
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404) return { ok: true, present: false };
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
