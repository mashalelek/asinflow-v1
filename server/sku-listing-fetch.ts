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

// Normalized listing issue — §6 current-issues snapshot shape.
export interface ListingIssueLite {
  code: string;
  severity: string;
  message: string;
}

export type ListingStatusOutcome =
  | { ok: true; present: true; statuses: string[]; issues: ListingIssueLite[] }
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
      // issues ride the same call — §6 item 7 snapshot, zero extra volume.
      { marketplaceIds: MARKETPLACE, includedData: "summaries,issues" },
    );
    const statuses: string[] = data?.summaries?.[0]?.status ?? [];
    const issues: ListingIssueLite[] = (data?.issues ?? []).map((i: any) => ({
      code: String(i?.code ?? ""),
      severity: String(i?.severity ?? ""),
      message: String(i?.message ?? ""),
    }));
    return { ok: true, present: true, statuses, issues };
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
