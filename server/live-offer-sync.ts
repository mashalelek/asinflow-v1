// Single owner of asins.has_live_offer (alongside the §19 verification 'live'
// transition). Walks in_catalog=TRUE ASINs that have >=1 asin_skus row and writes
// a definitive live-offer verdict from the Listings API (getListingsItem), via
// the shared checkAsinLiveOffer.
//
// ONE implementation, multiple entry points:
//   - 07:00 cron           → full scope (re-checks all, oldest offer_checked_at first)
//   - end of inventory-sync → { onlyUnchecked: true } (has_live_offer IS NULL only),
//                             scoped to the same asinFilter the inventory sync used
//
// No-SKU ASINs are EXCLUDED at the query level: there is nothing to probe, so
// re-checking them daily would be permanent wasted iteration. They stay NULL
// (render "+") and are picked up here naturally once inventory-sync records a
// SKU for them.
//
// Fail-closed: only a definitive 200 writes TRUE; only all-SKUs-404 writes
// FALSE. Transient responses (429/5xx/timeout) write nothing and are counted in
// the end-of-pass skip summary — the next run retries them. Writes has_live_offer
// / offer_checked_at ONLY (no in_catalog, no manual-verdict fields).
import { query as defaultQuery } from "./db";
import { checkAsinLiveOffer } from "./live-offer-check";
import { log } from "./index";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export interface LiveOfferSyncSummary {
  total: number;
  live: number;
  noOffer: number;
  transient: number; // non-definitive responses — written nothing, retried next run
}

export async function syncLiveOffers(
  opts: {
    query?: QueryLike;
    sellerId?: string;
    pacingMs?: number;
    onlyUnchecked?: boolean;                 // has_live_offer IS NULL only (inventory-sync entry point)
    asinFilter?: ReadonlySet<string>;        // restrict to these ASINs (mirrors inventory-sync's filter)
  } = {},
): Promise<LiveOfferSyncSummary> {
  const query = opts.query ?? (defaultQuery as any as QueryLike);
  const sellerId = opts.sellerId ?? process.env.SP_API_SELLER_ID;
  const pacingMs = opts.pacingMs ?? 260; // getListingsItem limit is 5 req/s
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (!sellerId) throw new Error("SP_API_SELLER_ID not set");

  // in_catalog=TRUE AND has >=1 SKU. No-SKU ASINs are excluded (see header).
  // Optional onlyUnchecked (NULL-scope) and asinFilter narrow it further.
  const conds = ["a.in_catalog = TRUE", "EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id)"];
  const params: any[] = [];
  if (opts.onlyUnchecked) conds.push("a.has_live_offer IS NULL");
  if (opts.asinFilter && opts.asinFilter.size > 0) {
    params.push(Array.from(opts.asinFilter));
    conds.push(`a.asin = ANY($${params.length}::text[])`);
  }
  const rows = (await query(
    `SELECT a.asin FROM asins a
      WHERE ${conds.join(" AND ")}
      ORDER BY a.offer_checked_at ASC NULLS FIRST`,
    params.length ? params : undefined,
  )).rows as { asin: string }[];

  const s: LiveOfferSyncSummary = { total: rows.length, live: 0, noOffer: 0, transient: 0 };
  for (const { asin } of rows) {
    const res = await checkAsinLiveOffer(asin, sellerId, { query });
    if (res.verdict === "live" || res.verdict === "no_offer") {
      await query(
        `UPDATE asins SET has_live_offer = $2, offer_checked_at = now() WHERE asin = $1`,
        [asin, res.verdict === "live"],
      );
      if (res.verdict === "live") s.live++; else s.noOffer++;
    } else {
      // skip — reason is transient here (no_sku is excluded by the query above)
      s.transient++;
    }
    await sleep(pacingMs);
  }

  const scope = `${opts.onlyUnchecked ? "unchecked-scope" : "full"}${opts.asinFilter?.size ? ", filtered" : ""}`;
  log(
    `Live-offer sync complete (${scope}): ${s.total} probed — ${s.live} live, ${s.noOffer} no_offer, ` +
    `${s.transient} transient-skipped (unwritten, retry next run)`,
    "live-offer-sync",
  );
  return s;
}
