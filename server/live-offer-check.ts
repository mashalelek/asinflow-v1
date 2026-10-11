// Shared "does this ASIN have ANY live offer?" check — used by BOTH the daily
// staleness pass (live-offer-sync.ts) and the one-off backfill
// (script/backfill-has-live-offer.ts) so the multi-SKU logic lives in one place.
//
// Truth comes ONLY from the Listings API via checkSkuListingStatus
// (getListingsItem: 404 = absent; 200 with a NON-EMPTY summaries array =
// present — §18 A1, 2026-10-09; 200 with summaries: [] is a SKU shell and
// counts as absent). Never inferred from asin_skus presence or inventory
// summaries.
//
// Fail-closed: only a definitive 200 yields "live"; "no_offer" requires EVERY
// SKU to definitively 404. Any non-definitive response (429 / 5xx / timeout) or
// an ASIN with no SKUs yields "skip" — the caller writes nothing.
import { checkSkuListingStatus, type ListingIssueLite } from "./sku-listing-fetch";
import { spApiGet as realSpApiGet } from "./spapi-auth";
import { query as defaultQuery } from "./db";
import type { HttpGetFn } from "./sku-catalog-fetch";

const MARKETPLACE = "ATVPDKIKX0DER";

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
  // §18 all-404 → discovery (2026-08-28): set when the discovery step ran.
  // "live" with discovered = the offer exists only under SC-created SKU(s) AF
  // didn't know; "no_offer" with discovered = [] = discovery came back empty.
  discovered?: string[];
}

// Checks the ASIN's primary SKU first, then its other asin_skus rows, short-
// circuiting on the first live hit. Returns the fail-closed verdict above.
export async function checkAsinLiveOffer(
  asin: string,
  sellerId: string,
  deps: { query?: QueryLike; httpGet?: HttpGetFn; applyDiscoveries?: boolean } = {},
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
  if (sawTransient) {
    return { verdict: "skip", skipReason: "transient", skusChecked: checked, sawTransient };
  }

  // §18 all-known-SKUs-404 → ASIN discovery before FALSE (2026-08-28): every
  // known SKU definitively 404ing proves only "no offer on the SKUs AF knows".
  // An SC-created listing under a new SKU (B0CT61H23P / CQ-OMI0-SSZ7) is
  // invisible behind dead asin_skus rows, and phase b never fires for an ASIN
  // that HAS rows. Probe by ASIN before asserting no_offer.
  const disc = await discoverAsinListings(asin, sellerId, deps.httpGet);
  if (!disc.ok) {
    // Discovery transient — cannot assert no_offer; write nothing, retry later.
    return { verdict: "skip", skipReason: "transient", skusChecked: checked, sawTransient: true };
  }
  if (disc.found.length === 0) {
    return { verdict: "no_offer", issues: [], skusChecked: checked, sawTransient, discovered: [] };
  }
  // Discovery hit. Record + 8c re-point unless the caller is in a dry-run
  // (applyDiscoveries false) — the verdict is still "live" either way.
  let newPrimary: string | null = null;
  if (deps.applyDiscoveries !== false) {
    newPrimary = (await recordDiscoveredSkus(asin, disc.found, q)).newPrimary;
  } else {
    newPrimary = pick8cPrimary(disc.found);
  }
  const lead = disc.found.find((f) => f.sku === newPrimary) ?? newestFirst(disc.found)[0];
  return {
    verdict: "live", liveSku: lead.sku, statuses: lead.statuses, issues: lead.issues,
    skusChecked: checked, sawTransient, discovered: disc.found.map((f) => f.sku),
  };
}

// §23 SC-Active (2026-09-15): "BUYABLE" in summaries[].status is Amazon's own
// word for "this listing carries a purchasable offer" — the ONE signal that
// separates an active listing from a Closed / out-of-stock / pricing-issue
// one. has_live_offer deliberately cannot answer this (it means "a listing
// record exists", Inactive included — §18). Case-insensitive; an ASIN is
// buyable when ANY of its SKUs is.
export const BUYABLE_STATUS = "BUYABLE";
export function anyBuyable(statusesPerSku: Array<string[] | null | undefined>): boolean {
  return statusesPerSku.some((arr) =>
    (arr ?? []).some((s) => String(s).toUpperCase() === BUYABLE_STATUS));
}

// ── §18 all-404 discovery primitives (2026-08-28) ───────────────────────────
export interface DiscoveredListing {
  sku: string;
  statuses: string[];
  createdDate: string; // summaries[].createdDate — drives the 8c newest-live pick
  issues: ListingIssueLite[];
}
export type DiscoveryOutcome = { ok: true; found: DiscoveredListing[] } | { ok: false };

// searchListingsItems by ASIN — the same fallback endpoint as full-scope
// phase b. Fail-closed: any error is transient (ok: false), the caller writes
// nothing. A no-listing ASIN is a 200 with zero items, not an error.
export async function discoverAsinListings(
  asin: string,
  sellerId: string,
  httpGet: HttpGetFn = realSpApiGet,
): Promise<DiscoveryOutcome> {
  let data: any;
  try {
    data = await httpGet(`/listings/2021-08-01/items/${sellerId}`, {
      marketplaceIds: MARKETPLACE,
      identifiers: asin,
      identifiersType: "ASIN",
      includedData: "summaries,issues",
    });
  } catch {
    return { ok: false };
  }
  const items: any[] = data?.items ?? [];
  const found: DiscoveredListing[] = items
    // §18 A1 (2026-10-09): a row with no summary is a SKU shell, not a
    // listing. Discovering a shell and writing it into asin_skus would
    // manufacture the very evidence the all-404 path exists to look for, and
    // would turn a correct FALSE into a wrong TRUE.
    .filter((it) => Array.isArray(it?.summaries) && it.summaries.length > 0)
    .map((it) => ({
      sku: String(it?.sku ?? ""),
      statuses: it?.summaries?.[0]?.status ?? [],
      createdDate: String(it?.summaries?.[0]?.createdDate ?? ""),
      issues: (it?.issues ?? []).map((x: any) => ({
        code: String(x?.code ?? ""), severity: String(x?.severity ?? ""), message: String(x?.message ?? ""),
      })),
    }))
    .filter((f) => f.sku);
  return { ok: true, found };
}

const isAmznGr = (sku: string) => sku.toLowerCase().startsWith("amzn.gr.");
const newestFirst = (arr: DiscoveredListing[]) =>
  [...arr].sort((a, b) => (a.createdDate < b.createdDate ? 1 : -1));

// 8c latest-live-wins among the discovered listings, amzn.gr.* never primary.
// Null when every discovered SKU is amzn.gr.* (primary stays unchanged).
export function pick8cPrimary(found: DiscoveredListing[]): string | null {
  const real = newestFirst(found.filter((f) => !isAmznGr(f.sku)));
  return real.length > 0 ? real[0].sku : null;
}

// Insert discovered SKUs into asin_skus and apply the 8c primary re-point.
// The re-point is safe by construction: this runs ONLY on the all-known-404
// path, so every previously-known SKU — including the current primary — has
// just definitively died; the newest discovered live SKU is 8c's pick.
export async function recordDiscoveredSkus(
  asin: string,
  found: DiscoveredListing[],
  query: QueryLike = defaultQuery as any,
): Promise<{ inserted: string[]; newPrimary: string | null }> {
  const newPrimary = pick8cPrimary(found);
  for (const f of found) {
    await query(
      `INSERT INTO asin_skus (asin_id, sku, is_primary)
       SELECT a.id, $2, FALSE FROM asins a WHERE a.asin = $1
       ON CONFLICT (asin_id, sku) DO NOTHING`,
      [asin, f.sku],
    );
  }
  if (newPrimary != null) {
    await query(`UPDATE asins SET primary_sku = $2 WHERE asin = $1`, [asin, newPrimary]);
    await query(
      `UPDATE asin_skus s SET is_primary = (s.sku = $2)
         FROM asins a WHERE s.asin_id = a.id AND a.asin = $1`,
      [asin, newPrimary],
    );
  }
  return { inserted: found.map((f) => f.sku), newPrimary };
}
