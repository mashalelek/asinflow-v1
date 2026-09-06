// Price refresh v2 (SPEC §11 "Refresh job & price refresh v2", 2026-09-06).
//
// Replaces the three-pass getItemOffers design (5-wide every 1.5 s into a
// 1 rps bucket; blind 2s/4s/8s per-ASIN retries; gap-fill + targeted passes;
// projected hours on the full catalog — the 2026-09-04 incident). Data path
// is now getItemOffersBatch: 20 ASINs per call at 0.1 rps through the shared
// rate limiter = 2 ASINs/s → 2,208 ASINs ≈ 18 min. No blind retries: 429s
// are the limiter's job; here there is ONE main pass + ONE trailing pass
// over items whose outcome was throttled/error.
//
// Every ASIN in scope ends with exactly ONE outcome (the answer to "which
// ones failed?" — persisted by the caller into refresh_runs):
//   updated    — ≥1 price parsed → prices + seller counts + fetched_at
//   no_offers  — 200, zero New offers → prices NULLed (conclusive: nothing
//                is for sale), sellers 0, fetched_at (decision 6)
//   restricted — 403/restricted → nothing written
//   not_found  — 404 → nothing written
//   throttled  — 429 survived limiter + trailing pass → nothing written
//   error      — timeout/5xx/parse → nothing written (message kept)
//
// fetched_at stamps ONLY the two conclusive outcomes — the honest price age.
// writePrice drops its COALESCE guards: a conclusive answer overwrites,
// including to NULL.
import { spApiPost } from "./spapi-auth";
import { parseOffersPayload, type ParsedOffers } from "./offers-parse";
import { query } from "./db";
import { log } from "./index";

const MARKETPLACE = "ATVPDKIKX0DER";
const BATCH_URI = "/batches/products/pricing/v0/itemOffers";
const PER_CALL = 20;

export type PriceOutcome =
  | "updated"
  | "no_offers"
  | "restricted"
  | "not_found"
  | "throttled"
  | "error";

export interface PriceRefreshProgress {
  current: number;
  total: number;
  asin: string;
}

export interface PriceRefreshResult {
  requested: number;
  counts: Record<PriceOutcome, number>;
  /** Every non-`updated` ASIN → outcome (plus `: message` for errors). */
  outcomes: Record<string, string>;
  // Back-compat fields for the cron wrapper's log line.
  updated: number;
  failed: number;
}

// Conclusive write — NO COALESCE (SPEC §11 2026-09-06): Amazon answered, so
// what it said replaces what we had, including NULLs on no_offers.
async function writePrice(asin: string, p: ParsedOffers): Promise<void> {
  await query(
    `UPDATE asin_estimates SET
       lowest_fba_price = $2,
       buy_box_price = $3,
       buy_box_fulfillment = $4,
       lowest_price = $5,
       sellers_fba = $6,
       sellers_fbm = $7,
       fetched_at = NOW()
     WHERE asin = $1`,
    [asin, p.lowestFbaPrice, p.buyBoxPrice, p.buyBoxFulfillment, p.lowestPrice, p.sellersFba, p.sellersFbm],
  );
}

interface ItemResult {
  outcome: PriceOutcome;
  message?: string;
  parsed?: ParsedOffers;
}

// One getItemOffersBatch call for ≤20 ASINs. Batch-level 429s are handled by
// the limiter (spApiPost) and never seen here; per-item statuses map to
// outcomes. A thrown call (post-limiter 429, timeout, 5xx) marks every item.
async function fetchBatch(asins: string[]): Promise<Map<string, ItemResult>> {
  const out = new Map<string, ItemResult>();
  let body: any;
  try {
    body = await spApiPost(BATCH_URI, {
      requests: asins.map((asin) => ({
        uri: `/products/pricing/v0/items/${asin}/offers`,
        method: "GET",
        MarketplaceId: MARKETPLACE,
        ItemCondition: "New",
      })),
    });
  } catch (err: any) {
    const status = err?.response?.status;
    const outcome: PriceOutcome = status === 429 ? "throttled" : "error";
    const message = `${status ?? "?"}: ${err?.response?.data?.errors?.[0]?.message ?? err?.message ?? "unknown"}`;
    for (const asin of asins) out.set(asin, { outcome, message });
    return out;
  }

  const responses: any[] = body?.responses ?? [];
  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    const r = responses[i];
    const code = Number(r?.status?.statusCode ?? 0);
    if (code === 200 && r?.body?.payload) {
      try {
        const parsed = parseOffersPayload(r.body.payload);
        out.set(asin, { outcome: parsed.noOffers ? "no_offers" : "updated", parsed });
      } catch (e: any) {
        out.set(asin, { outcome: "error", message: `parse: ${e?.message ?? "unknown"}` });
      }
    } else if (code === 403) {
      out.set(asin, { outcome: "restricted" });
    } else if (code === 404) {
      out.set(asin, { outcome: "not_found" });
    } else if (code === 429) {
      out.set(asin, { outcome: "throttled" });
    } else {
      const msg = r?.body?.errors?.[0]?.message ?? r?.status?.reasonPhrase ?? `status ${code}`;
      if (/restricted|unauthorized/i.test(String(msg))) out.set(asin, { outcome: "restricted" });
      else out.set(asin, { outcome: "error", message: String(msg) });
    }
  }
  // Defensive: any ASIN the response didn't cover is an error, never silent.
  for (const asin of asins) {
    if (!out.has(asin)) out.set(asin, { outcome: "error", message: "missing from batch response" });
  }
  return out;
}

export async function refreshPrices(
  onProgress?: (p: PriceRefreshProgress) => void | Promise<void>,
  asinFilter?: ReadonlySet<string>,
  opts: { dryRun?: boolean } = {},
): Promise<PriceRefreshResult> {
  const filtered = asinFilter && asinFilter.size > 0;
  const result = await query(
    filtered
      // Explicit selection syncs EXACTLY those ASINs — archived included
      // (SPEC 14 "Archived != excluded from sync"). Active-only applies only
      // to the unfiltered cron/full-catalog scope.
      ? `SELECT asin FROM asins WHERE asin = ANY($1::text[]) ORDER BY asin`
      : `SELECT asin FROM asins WHERE is_active = TRUE ORDER BY asin`,
    filtered ? [Array.from(asinFilter!)] : undefined,
  );
  const asins: string[] = result.rows.map((r: any) => r.asin);
  log(`Price refresh v2${opts.dryRun ? " [DRY-RUN]" : ""}: ${asins.length} ASINs, ${Math.ceil(asins.length / PER_CALL)} batch calls`, "price-sync");

  const results = new Map<string, ItemResult>();
  let processed = 0;
  const runPass = async (scope: string[]) => {
    for (let i = 0; i < scope.length; i += PER_CALL) {
      const chunk = scope.slice(i, i + PER_CALL);
      const batch = await fetchBatch(chunk);
      for (const [asin, r] of Array.from(batch.entries())) results.set(asin, r);
      processed = Math.min(processed + chunk.length, asins.length);
      if (onProgress) await onProgress({ current: processed, total: asins.length, asin: chunk[chunk.length - 1] });
    }
  };

  await runPass(asins);

  // ONE trailing pass over transient outcomes — that's it (SPEC §11).
  const retryable = asins.filter((a) => {
    const o = results.get(a)?.outcome;
    return o === "throttled" || o === "error";
  });
  if (retryable.length > 0) {
    log(`Price refresh v2: trailing pass over ${retryable.length} throttled/error ASIN(s)`, "price-sync");
    processed = asins.length - retryable.length;
    await runPass(retryable);
  }

  const counts: Record<PriceOutcome, number> = { updated: 0, no_offers: 0, restricted: 0, not_found: 0, throttled: 0, error: 0 };
  const outcomes: Record<string, string> = {};
  for (const asin of asins) {
    const r = results.get(asin) ?? { outcome: "error" as const, message: "never processed" };
    counts[r.outcome]++;
    if (!opts.dryRun && (r.outcome === "updated" || r.outcome === "no_offers") && r.parsed) {
      await writePrice(asin, r.parsed);
    }
    if (r.outcome !== "updated") {
      outcomes[asin] = r.message ? `${r.outcome}: ${r.message}` : r.outcome;
    }
  }

  log(
    `Price refresh v2 complete${opts.dryRun ? " [DRY-RUN — nothing written]" : ""}: ` +
    `${counts.updated} updated, ${counts.no_offers} no-offers, ${counts.restricted} restricted, ` +
    `${counts.not_found} not-found, ${counts.throttled} throttled, ${counts.error} error`,
    "price-sync",
  );

  return {
    requested: asins.length,
    counts,
    outcomes,
    updated: counts.updated,
    failed: counts.throttled + counts.error,
  };
}
