// Shared "does this ASIN have ANY live offer?" check — used by BOTH the daily
// staleness pass (live-offer-sync.ts) and the one-off backfill
// (script/backfill-has-live-offer.ts) so the multi-SKU logic lives in one place.
//
// Truth comes ONLY from the Listings API via checkSkuListingStatus
// (getListingsItem: 404 = absent, 200 = present with Active/Inactive statuses).
// Never inferred from asin_skus presence or inventory summaries.
//
// Fail-closed: only a definitive 200 yields "live"; "no_offer" requires EVERY
// SKU to definitively 404. Any non-definitive response (429 / 5xx / timeout) or
// an ASIN with no SKUs yields "skip" — the caller writes nothing.
import { checkSkuListingStatus } from "./sku-listing-fetch";
import { query as defaultQuery } from "./db";
import type { HttpGetFn } from "./sku-catalog-fetch";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export type LiveOfferVerdict = "live" | "no_offer" | "skip";
// Why a "skip" was returned — callers report/retry these differently:
//   no_sku    — ASIN has zero asin_skus rows; nothing to probe. NO API call was
//               made. Retrying is permanently wasted; excluded from the daily
//               pass (picked up once inventory-sync observes a SKU).
//   transient — a real Listings API call came back non-definitive (429/5xx/
//               timeout). Worth retrying.
export type SkipReason = "no_sku" | "transient";

export interface LiveOfferResult {
  verdict: LiveOfferVerdict;
  skipReason?: SkipReason; // set only when verdict === "skip"
  liveSku?: string;       // the SKU that returned present=true (verdict "live")
  statuses?: string[];    // its SC statuses, e.g. ["ACTIVE"] / ["INACTIVE"]
  // §6 item 7 snapshot: the live SKU's listing issues (same getListingsItem
  // response). Defined ONLY on definitive verdicts: live → that SKU's issues,
  // no_offer → [] (no listing, no listing issues). Absent on skip.
  issues?: { code: string; severity: string; message: string }[];
  skusChecked: number;
  sawTransient: boolean;  // true if any SKU returned a non-definitive response
}

// Checks the ASIN's primary SKU first, then its other asin_skus rows, short-
// circuiting on the first live hit. Returns the fail-closed verdict above.
export async function checkAsinLiveOffer(
  asin: string,
  sellerId: string,
  deps: { query?: QueryLike; httpGet?: HttpGetFn } = {},
): Promise<LiveOfferResult> {
  const q = deps.query ?? (defaultQuery as any as QueryLike);

  // primary_sku first (it now carries the live offer after an Add-Offer promote),
  // then the rest — so the common case short-circuits on the first call.
  const rows = (await q(
    `SELECT s.sku
       FROM asin_skus s JOIN asins a ON a.id = s.asin_id
      WHERE a.asin = $1
      ORDER BY (s.sku = a.primary_sku) DESC, s.sku`,
    [asin],
  )).rows as { sku: string }[];
  const skus = rows.map((r) => r.sku);

  if (skus.length === 0) {
    // Nothing to check against the Listings API — no API call made. Fail closed:
    // skip with reason no_sku (not worth retrying; excluded from the daily pass).
    return { verdict: "skip", skipReason: "no_sku", skusChecked: 0, sawTransient: false };
  }

  let sawTransient = false;
  let checked = 0;
  for (const sku of skus) {
    const out = await checkSkuListingStatus(sellerId, sku, deps.httpGet);
    checked++;
    if (out.ok && out.present) {
      return { verdict: "live", liveSku: sku, statuses: out.statuses, issues: out.issues, skusChecked: checked, sawTransient };
    }
    if (!out.ok) sawTransient = true; // transient — this SKU is indeterminate
    // out.ok && !out.present → definitive 404; keep checking the rest
  }

  // No live SKU found. If any check was indeterminate we cannot assert no_offer.
  return sawTransient
    ? { verdict: "skip", skipReason: "transient", skusChecked: checked, sawTransient }
    : { verdict: "no_offer", issues: [], skusChecked: checked, sawTransient };
}
