// §18 born-closed: reopen a soft-closed listing.
//
// Reopen = patchListingsItem `op: "merge"` on /attributes/purchasable_offer
// setting `end_at: null` (the documented optional-sub-attribute delete;
// verified working 2026-07). Two hard rails from SPEC §18:
//   - NEVER `op: "replace"` — it swaps the entire purchasable_offer array and
//     wipes the price.
//   - NEVER include price fields in this patch — a high-price error (18555)
//     makes Amazon silently ignore the end_at carried in the same patch.
//
// PATCH returning ACCEPTED is synchronous validation only (same as PUT) —
// Amazon applies it asynchronously; SC can lag up to ~an hour. Caller surfaces
// that to the operator rather than polling.
import { spApiPatch as realSpApiPatch } from "./spapi-auth";

const MARKETPLACE = "ATVPDKIKX0DER";

export type HttpPatchFn = (
  endpoint: string,
  body: any,
  params?: Record<string, any>,
) => Promise<any>;

export type ReopenOutcome =
  | { ok: true; submissionId: string | null }
  | { ok: false; status?: number; code?: string; message: string };

export function buildReopenPatchBody(): any {
  return {
    productType: "PRODUCT",
    patches: [
      {
        op: "merge",
        path: "/attributes/purchasable_offer",
        value: [
          {
            currency: "USD",
            audience: "ALL",
            marketplace_id: MARKETPLACE,
            end_at: null,
            // NO price fields here — see the 18555 silent-ignore rail above.
          },
        ],
      },
    ],
  };
}

export async function reopenListing(
  sellerId: string,
  sku: string,
  httpPatch: HttpPatchFn = realSpApiPatch,
): Promise<ReopenOutcome> {
  const endpoint = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;
  try {
    const data = await httpPatch(endpoint, buildReopenPatchBody(), {
      marketplaceIds: MARKETPLACE,
    });
    if (data?.status === "ACCEPTED") {
      return { ok: true, submissionId: data?.submissionId ?? null };
    }
    return {
      ok: false,
      code: data?.status,
      message:
        data?.issues?.[0]?.message ?? `patchListingsItem returned ${data?.status ?? "unknown status"}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: err?.response?.status,
      code: err?.response?.data?.errors?.[0]?.code,
      message: err?.response?.data?.errors?.[0]?.message ?? err?.message ?? "unknown error",
    };
  }
}
