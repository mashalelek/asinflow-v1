// "Does this SKU exist in our Seller Central right now?" — drives the
// resurrection branch (404 → reuse the SKU string; 200 → duplicate warning).
//
// GET /listings/2021-08-01/items/{sellerId}/{sku}
//   404 → present=false (we already verified in the diag: a deleted SKU
//         reliably returns 404 with body code NOT_FOUND. No fuzzy signal.)
//   200 with a NON-EMPTY summaries array → present=true, statuses from
//         summaries[0].status
//   200 with summaries: [] → present=false, shell=true (§18 A1, 2026-10-09)
//   anything else → transient, surface to caller for retry/backoff
//
// A1 — PRESENT REQUIRES A LISTING, NOT A SKU STRING. The header above has
// claimed "200 = present with Active/Inactive statuses" since this module was
// written, but the code accepted ANY 200. Amazon leaves a SKU **shell**
// behind a failed submission: the SKU exists in the seller namespace and
// getListingsItem answers 200 with summaries: [], no status, no offer, no
// fulfillmentAvailability. B07J2WWWD4 / CAI-TOO-WD4-UMC-001 (2026-10-09) is
// the case — never listed, submission failed on 13013+5886, and the shell
// still read as "live" all the way into has_live_offer.
//
// The predicate is `summaries.length > 0`, NOT `status.length > 0`. A real
// listing can carry an EMPTY status array while it materialises, and §19's
// classifier depends on that ("200-with-empty-status is listed, not live
// yet"). Verified against the full 805-SKU account list 2026-10-09: one row
// (ALF-BOO-V8U-RCM-001 / B01JO20V8U) is exactly that shape. Keying A1 on
// status would call that genuine listing absent.
//
// The asin_skus row for a shell SKU STAYS — it is history, and resurrection
// may reuse the shell's own SKU string (Amazon accepts a PUT to an existing
// SKU, so the re-add carries no duplicate risk).

import { spApiGet as realSpApiGet } from "./spapi-auth";
import type { HttpGetFn } from "./sku-catalog-fetch";

const MARKETPLACE = "ATVPDKIKX0DER";

// Normalized listing issue — §6 current-issues snapshot shape.
export interface ListingIssueLite {
  code: string;
  severity: string;
  message: string;
}

// Listing state per SKU (listing hygiene, SPEC §11 component 16, 2026-10-19):
// read only when the caller asks for `attributes` — the same call, a larger
// payload. end_at.value is a close timestamp when Amazon applied a close
// (an SC close), the literal 2000-01-01 when it stored the value AF sent
// (applied after AF's close PATCH, NOT when sent at create), or null (open).
// Which of those means "closed" is listing-closed.ts's isOfferClosed — never
// read end_at directly (probe 2026-10-23).
export interface ListingState {
  /** summaries[].createdDate, or null. */
  createdAt: string | null;
  /** The US offer's end_at.value, or null (open, or no offer entry). */
  offerEndAt: string | null;
  /** True when the listing carries a US purchasable_offer entry at all. */
  hasOffer: boolean;
  productType: string | null;
  /** summaries[].status includes BUYABLE — always open (the closed test, listing-closed.ts). */
  buyable: boolean;
}

/** Pure: a getListingsItem body (summaries + attributes) → the listing state. */
export function parseListingState(data: any): ListingState {
  const summary = Array.isArray(data?.summaries) ? data.summaries.find((x: any) => x?.marketplaceId === MARKETPLACE) ?? data.summaries[0] : null;
  const offers: any[] = Array.isArray(data?.attributes?.purchasable_offer) ? data.attributes.purchasable_offer : [];
  const us = offers.filter((o) => (o?.marketplace_id ?? MARKETPLACE) === MARKETPLACE);
  // The consumer offer: audience ALL when several exist (B2B rides its own entry).
  const offer = us.find((o) => (o?.audience ?? "ALL") === "ALL") ?? us[0] ?? null;
  const raw = offer?.end_at?.value ?? null;
  return {
    createdAt: summary?.createdDate ? String(summary.createdDate) : null,
    offerEndAt: raw == null || raw === "" ? null : String(raw),
    hasOffer: offer != null,
    productType: summary?.productType ? String(summary.productType) : null,
    buyable: Array.isArray(summary?.status) && summary.status.includes("BUYABLE"),
  };
}

export type ListingStatusOutcome =
  // `shell: true` distinguishes "200, but no listing behind the SKU" from a
  // plain 404. Both are present=false and both are treated identically for
  // the flag (§18 A1); the discriminator exists so reports can count shells
  // and so a future reader does not have to rediscover that they happen.
  | { ok: true; present: true; statuses: string[]; issues: ListingIssueLite[]; listing?: ListingState }
  | { ok: true; present: false; shell?: true }
  | { ok: false; reason: "transient_error"; status?: number; message: string; retryable: true };

export async function checkSkuListingStatus(
  sellerId: string,
  sku: string,
  httpGet: HttpGetFn = realSpApiGet,
  opts: { attributes?: boolean } = {},
): Promise<ListingStatusOutcome> {
  try {
    const data = await httpGet(
      `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`,
      // issues ride the same call — §6 item 7 snapshot, zero extra volume.
      // attributes only for component 16's listing state (purchasable_offer).
      { marketplaceIds: MARKETPLACE, includedData: opts.attributes ? "summaries,issues,attributes" : "summaries,issues" },
    );
    // §18 A1: a 200 with no summary is a SKU shell, not a listing. Treated
    // exactly like a 404 — present=false — so it contributes nothing to the
    // flag and all-shell still routes through ASIN discovery before FALSE.
    const summaries: any[] = Array.isArray(data?.summaries) ? data.summaries : [];
    if (summaries.length === 0) {
      return { ok: true, present: false, shell: true };
    }
    const statuses: string[] = summaries[0]?.status ?? [];
    const issues: ListingIssueLite[] = (data?.issues ?? []).map((i: any) => ({
      code: String(i?.code ?? ""),
      severity: String(i?.severity ?? ""),
      message: String(i?.message ?? ""),
    }));
    return opts.attributes
      ? { ok: true, present: true, statuses, issues, listing: parseListingState(data) }
      : { ok: true, present: true, statuses, issues };
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
