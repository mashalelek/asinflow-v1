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
import { log } from "./log";

const MARKETPLACE = "ATVPDKIKX0DER";
const BATCH_URI = "/batches/products/pricing/v0/itemOffers";
const PER_CALL = 20;

export type PriceOutcome =
  | "updated"
  | "no_offers"
  | "restricted"
  | "not_found"
  // Amazon's "invalid ASIN for marketplace" per-item error (2026-09-07):
  // conclusive, not transient — excluded from the trailing pass and from
  // Retry failed (a 96-ASIN retry reproduced 96-for-96), and it auto-marks
  // the ASIN dead (status 'dead', reason 'invalid_asin' — SPEC §14).
  | "invalid_asin"
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
  /** Parsed offers per conclusive ASIN (scheduler riders 11/12 read these). */
  parsed: Map<string, ParsedOffers>;
  // Back-compat fields for the cron wrapper's log line.
  updated: number;
  failed: number;
}

// Conclusive write — NO COALESCE (SPEC §11 2026-09-06): Amazon answered, so
// what it said replaces what we had, including NULLs on no_offers. Also
// clears asin_estimates.error (2026-09-09): a conclusive price answer
// supersedes any stale per-row error string — the old synthesized
// "Price unavailable" strings survived price writes and poisoned the UI.
async function writePrice(asin: string, p: ParsedOffers): Promise<void> {
  await query(
    `UPDATE asin_estimates SET
       lowest_fba_price = $2,
       buy_box_price = $3,
       buy_box_fulfillment = $4,
       lowest_price = $5,
       sellers_fba = $6,
       sellers_fbm = $7,
       competitive_price_threshold = $8,
       fetched_at = NOW(),
       error = NULL
     WHERE asin = $1`,
    [asin, p.lowestFbaPrice, p.buyBoxPrice, p.buyBoxFulfillment, p.lowestPrice, p.sellersFba, p.sellersFbm, p.competitivePriceThreshold],
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
      else if (/invalid ASIN/i.test(String(msg))) out.set(asin, { outcome: "invalid_asin", message: String(msg) });
      else out.set(asin, { outcome: "error", message: String(msg) });
    }
  }
  // Defensive: any ASIN the response didn't cover is an error, never silent.
  for (const asin of asins) {
    if (!out.has(asin)) out.set(asin, { outcome: "error", message: "missing from batch response" });
  }
  return out;
}

// ── Pure price pass (2026-09-09): shared fetch/parse/outcome loop with a
// PLUGGABLE writer — the "one implementation" for the ASINs page and the
// Bulk Calc pipeline. Performs NO DB access of its own (pinned by test):
// the caller owns scope selection and the writer owns persistence. The
// writer is called once per conclusive outcome (updated / no_offers) with
// the parsed offers; dry-run callers pass write: null.
export interface PricePassResult {
  counts: Record<PriceOutcome, number>;
  outcomes: Record<string, string>;
  /** Conclusive parses by ASIN — what the writer saw (or would have). */
  parsed: Map<string, ParsedOffers>;
}

export async function runPricePass(
  asins: string[],
  write: ((asin: string, p: ParsedOffers) => Promise<void>) | null,
  onProgress?: (p: PriceRefreshProgress) => void | Promise<void>,
): Promise<PricePassResult> {
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
    log(`Price pass: trailing pass over ${retryable.length} throttled/error ASIN(s)`, "price-sync");
    processed = asins.length - retryable.length;
    await runPass(retryable);
  }

  const counts: Record<PriceOutcome, number> = { updated: 0, no_offers: 0, restricted: 0, not_found: 0, invalid_asin: 0, throttled: 0, error: 0 };
  const outcomes: Record<string, string> = {};
  const parsed = new Map<string, ParsedOffers>();
  for (const asin of asins) {
    const r = results.get(asin) ?? { outcome: "error" as const, message: "never processed" };
    counts[r.outcome]++;
    if ((r.outcome === "updated" || r.outcome === "no_offers") && r.parsed) {
      parsed.set(asin, r.parsed);
      if (write) await write(asin, r.parsed);
    }
    if (r.outcome !== "updated") {
      outcomes[asin] = r.message ? `${r.outcome}: ${r.message}` : r.outcome;
    }
  }
  return { counts, outcomes, parsed };
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
      // Cron scope = active + parked (decision 5, 2026-09-07): parked is the
      // "may come back" population, so the daily job keeps its prices
      // current. Dead is never synced automatically.
      : `SELECT asin FROM asins WHERE status IN ('active', 'parked') ORDER BY asin`,
    filtered ? [Array.from(asinFilter!)] : undefined,
  );
  const asins: string[] = result.rows.map((r: any) => r.asin);
  log(`Price refresh v2${opts.dryRun ? " [DRY-RUN]" : ""}: ${asins.length} ASINs, ${Math.ceil(asins.length / PER_CALL)} batch calls`, "price-sync");

  const { counts, outcomes, parsed } = await runPricePass(asins, opts.dryRun ? null : writePrice, onProgress);

  // Auto-dead (SPEC §14, 2026-09-07): invalid_asin is Amazon saying the ASIN
  // does not exist in the marketplace — retire it so the daily job stops
  // paying for it. Revivable via the status actions; visible in the dialog
  // ("→ marked dead (N)").
  let markedDead = 0;
  const invalids = asins.filter((a) => outcomes[a]?.startsWith("invalid_asin"));
  if (!opts.dryRun && invalids.length > 0) {
    const r = await query(
      `UPDATE asins SET status = 'dead', status_reason = 'invalid_asin', status_changed_at = NOW()
        WHERE asin = ANY($1::text[]) AND status <> 'dead'`,
      [invalids],
    );
    markedDead = r.rowCount ?? 0;
    log(`Price refresh v2: marked ${markedDead} invalid ASIN(s) dead (reason invalid_asin)`, "price-sync");
  }

  log(
    `Price refresh v2 complete${opts.dryRun ? " [DRY-RUN — nothing written]" : ""}: ` +
    `${counts.updated} updated, ${counts.no_offers} no-offers, ${counts.restricted} restricted, ` +
    `${counts.not_found} not-found, ${counts.invalid_asin} invalid-asin (${markedDead} marked dead), ` +
    `${counts.throttled} throttled, ${counts.error} error`,
    "price-sync",
  );

  return {
    requested: asins.length,
    counts: { ...counts, marked_dead: markedDead } as any,
    outcomes,
    parsed,
    updated: counts.updated,
    failed: counts.throttled + counts.error,
  };
}
