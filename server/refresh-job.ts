// One Refresh job (SPEC §11 "Refresh job & price refresh v2", 2026-09-06).
//
// Folds Sync Inventory + Sync Sales + Sync Prices + Scan Listings into one
// NDJSON job of named stages. Stages run concurrently where their rate
// buckets differ; `listings` waits for `inventory` (it needs the SKUs
// inventory just recorded); `prices` and `sales` start immediately. A failed
// stage does NOT abort the others — it is reported failed with its error.
// Every stage persists a refresh_runs row (migration 032): counts, per-item
// outcomes, rate-limit stats — "which failed" is a row, not scrollback.
import { query } from "./db";
import { log } from "./index";
import { refreshPrices, type PriceRefreshResult } from "./price-sync";
import { syncInventory } from "./inventory-sync";
import { syncSalesData } from "./sales-sync";
import { runFullScopePass, type FullScopeReport } from "./full-scope-pass";
import { rateLimitStats, rateLimitStatsSince } from "./spapi-rate-limit";
import { fetchFeesBatch } from "./product-info-batch";
import { getFeePriceForAsin } from "@shared/schema";

export type RefreshTrigger = "manual" | "refresh" | "cron";
export type RefreshStage = "inventory" | "sales" | "prices" | "fees" | "listings";

export interface StageSummary {
  stage: RefreshStage;
  status: "done" | "failed";
  durationMs: number;
  counts: Record<string, number>;
  /** Non-success items: {asin: outcome[/message]} — persisted + dialog list. */
  outcomes: Record<string, string>;
  error?: string;
}

export interface RefreshJobResult {
  stages: Record<string, StageSummary>;
  rateLimits: ReturnType<typeof rateLimitStats>;
}

export type RefreshEmit = (event: Record<string, any>) => void;

async function recordRun(
  trigger: RefreshTrigger,
  scope: "full" | "subset",
  requested: number,
  startedAt: Date,
  s: StageSummary,
  rateStats: Record<string, unknown>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO refresh_runs (started_at, finished_at, trigger, stage, scope, requested, counts, outcomes, rate_limit_stats, error)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
      [startedAt, trigger, s.stage, scope, requested, JSON.stringify(s.counts),
       JSON.stringify(s.outcomes), JSON.stringify(rateStats), s.error ?? null],
    );
  } catch (err: any) {
    // Ledger write failure must never fail the job (coverage log semantics).
    log(`refresh_runs write failed for stage ${s.stage}: ${err?.message ?? err}`, "refresh");
  }
}

// Fees stage (SPEC §11 Part D, 2026-09-07): batch feesEstimate on the
// just-written prices via the same getFeePriceForAsin rule Product Info
// uses. ASINs whose price outcome was non-updated skip as skipped_no_price
// — NEVER a fallback-price estimate. Writes the fee triple with
// fee_source 'spapi'. Shared with nothing else here; Product Info's fees
// use the same fetchFeesBatch primitive.
export async function runFeesStage(opts: {
  filter?: ReadonlySet<string>;
  dryRun: boolean;
  emit: RefreshEmit;
  /** ASINs whose price outcome was no_offers/invalid_asin/error/etc. */
  skipAsins: ReadonlySet<string>;
}): Promise<{ counts: Record<string, number>; outcomes: Record<string, string> }> {
  const filtered = opts.filter && opts.filter.size > 0;
  const rows = (await query(
    filtered
      ? `SELECT a.asin, e.lowest_fba_price, e.buy_box_price, e.lowest_price, e.bsr_category
           FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin
          WHERE a.asin = ANY($1::text[]) ORDER BY a.asin`
      : `SELECT a.asin, e.lowest_fba_price, e.buy_box_price, e.lowest_price, e.bsr_category
           FROM asins a LEFT JOIN asin_estimates e ON e.asin = a.asin
          WHERE a.status IN ('active', 'parked') ORDER BY a.asin`, // cron scope: decision 5, 2026-09-07
    filtered ? [Array.from(opts.filter!)] : undefined,
  )).rows;

  const counts = { updated: 0, skipped_no_price: 0, error: 0 };
  const outcomes: Record<string, string> = {};
  const items: Array<{ asin: string; price: number; category?: string | null }> = [];
  for (const r of rows) {
    const asin: string = r.asin;
    const { price, isFallback } = getFeePriceForAsin({
      lowestFbaPrice: r.lowest_fba_price != null ? parseFloat(r.lowest_fba_price) : null,
      buyBoxPrice: r.buy_box_price != null ? parseFloat(r.buy_box_price) : null,
      lowestPrice: r.lowest_price != null ? parseFloat(r.lowest_price) : null,
    });
    if (isFallback || opts.skipAsins.has(asin)) {
      counts.skipped_no_price++;
      outcomes[asin] = "skipped_no_price";
      continue;
    }
    items.push({ asin, price, category: r.bsr_category ?? null });
  }

  const pass = await runFeesPass(
    items,
    opts.dryRun ? null : async (asin, fees) => {
      await query(
        `UPDATE asin_estimates SET fba_fee = $2, referral_fee = $3, fees_estimate_price = $4, fee_source = 'spapi' WHERE asin = $1`,
        [asin, fees.fbaFulfillmentFee, fees.referralFee, fees.feesEstimatePrice],
      );
    },
    (current, total) => opts.emit({ type: "stage", stage: "fees", status: "running", current, total }),
    opts.dryRun,
  );
  counts.updated = pass.counts.updated;
  counts.error = pass.counts.error;
  Object.assign(outcomes, pass.outcomes);
  return { counts, outcomes };
}

// ── Pure fees pass (2026-09-09): shared batch-feesEstimate loop with a
// PLUGGABLE writer — same contract as runPricePass (no DB access of its
// own; pinned by test). The caller builds the priced items list (its own
// skip rule) and owns persistence via the writer.
export async function runFeesPass(
  items: Array<{ asin: string; price: number; category?: string | null }>,
  write: ((asin: string, fees: { fbaFulfillmentFee: number | null; referralFee: number | null; feesEstimatePrice: number | null }) => Promise<void>) | null,
  onProgress?: (current: number, total: number) => void,
  dryRun = false,
): Promise<{ counts: { updated: number; error: number }; outcomes: Record<string, string> }> {
  const counts = { updated: 0, error: 0 };
  const outcomes: Record<string, string> = {};
  let done = 0;
  for (let i = 0; i < items.length; i += 20) {
    const chunk = items.slice(i, i + 20);
    const batch = await fetchFeesBatch(chunk);
    for (const it of chunk) {
      const entry = batch.get(it.asin);
      if (entry?.kind === "parsed" && entry.fees.fbaFulfillmentFee != null) {
        counts.updated++;
        if (write) await write(it.asin, entry.fees);
        if (dryRun) outcomes[it.asin] = `would-write fba=${entry.fees.fbaFulfillmentFee} referral=${entry.fees.referralFee} @ $${it.price}`;
      } else {
        counts.error++;
        outcomes[it.asin] = `error: ${entry?.kind === "error" ? entry.message : "no fee in response"}`;
      }
    }
    done += chunk.length;
    onProgress?.(done, items.length);
  }
  return { counts, outcomes };
}

export async function runRefreshJob(opts: {
  asins?: string[];           // explicit working set (button); omitted = cron full scope
  startDate: string;          // sales stage chunk range
  endDate: string;
  trigger: RefreshTrigger;
  dryRun: boolean;
  emit: RefreshEmit;
}): Promise<RefreshJobResult> {
  const { emit, dryRun } = opts;
  // Per-run rate-limit view (2026-09-07): snapshot at start, report deltas.
  const rateBaseline = rateLimitStats();
  const filter = opts.asins && opts.asins.length > 0 ? new Set(opts.asins) : undefined;
  const scope: "full" | "subset" = filter ? "subset" : "full";
  const requested = filter ? filter.size : 0;
  const stages: Record<string, StageSummary> = {};

  async function runStage(
    stage: RefreshStage,
    fn: () => Promise<{ counts: Record<string, number>; outcomes: Record<string, string> }>,
  ): Promise<void> {
    const startedAt = new Date();
    const t0 = Date.now();
    emit({ type: "stage", stage, status: "running" });
    let summary: StageSummary;
    try {
      const r = await fn();
      summary = { stage, status: "done", durationMs: Date.now() - t0, counts: r.counts, outcomes: r.outcomes };
    } catch (err: any) {
      summary = {
        stage, status: "failed", durationMs: Date.now() - t0,
        counts: {}, outcomes: {}, error: err?.message ?? String(err),
      };
      log(`Prices & Stock stage ${stage} FAILED (others continue): ${summary.error}`, "refresh");
    }
    stages[stage] = summary;
    if (!dryRun) await recordRun(opts.trigger, scope, requested, startedAt, summary, rateLimitStatsSince(rateBaseline));
    emit({ type: "stage", stage, status: summary.status, durationMs: summary.durationMs, counts: summary.counts, error: summary.error });
  }

  // inventory → listings (needs the SKUs inventory records); ∥ prices; ∥ sales.
  // The inventory + sales stages are DB-write syncs with no dry-run mode —
  // in a dry-run they are SKIPPED (reported as such), matching the Velocity
  // pattern where dry-run means zero writes of any kind.
  const inventoryThenListings = (async () => {
    if (!dryRun) {
      await runStage("inventory", async () => {
        const r = await syncInventory(filter);
        return { counts: { synced: r.synced, skipped: r.skipped }, outcomes: {} };
      });
    } else {
      stages["inventory"] = { stage: "inventory", status: "done", durationMs: 0, counts: { skipped_dry_run: 1 }, outcomes: {} };
      emit({ type: "stage", stage: "inventory", status: "done", skipped: "dry-run" });
    }
    await runStage("listings", async () => {
      const report: FullScopeReport = await runFullScopePass({
        dryRun,
        asinFilter: filter,
        emit: (ev) => emit({ ...ev, stage: "listings" }),
      });
      const a = report.phaseA, b = report.phaseB;
      const outcomes: Record<string, string> = {};
      for (const f of a.flips) outcomes[f.asin] = `flip: ${String(f.from)} -> ${String(f.to)}`;
      for (const d of [...a.discoveries, ...b.discovered]) outcomes[d.asin] = `discovered: ${d.skus.join(", ")}`;
      return {
        counts: {
          probed: a.asins, live: a.live, no_offer: a.noOffer, transient: a.transientSkipped,
          flips: a.flips.length, repoints: a.repoints.length,
          discoveries: a.discoveries.length + b.discovered.length, no_listing: b.noListing,
        },
        outcomes,
      };
    });
  })();

  // prices → fees (SPEC §11 Part D, 2026-09-07): the fees stage needs the
  // just-written prices — Low-Price FBA rates apply under $10, so a price
  // crossing that line changes the fulfillment fee.
  const pricesThenFees = (async () => {
    let priceResult: PriceRefreshResult | null = null;
    await runStage("prices", async () => {
      const r: PriceRefreshResult = await refreshPrices(
        (p) => emit({ type: "stage", stage: "prices", status: "running", current: p.current, total: p.total }),
        filter,
        { dryRun },
      );
      priceResult = r;
      return { counts: r.counts as any, outcomes: r.outcomes };
    });
    await runStage("fees", async () => {
      const skipOutcomes = new Set(Object.keys(priceResult?.outcomes ?? {}));
      return runFeesStage({ filter, dryRun, emit, skipAsins: skipOutcomes });
    });
  })();

  const salesPromise = (async () => {
    if (!dryRun) {
      await runStage("sales", async () => {
        const r = await syncSalesData(opts.startDate, opts.endDate, filter);
        return { counts: { days: r.daysProcessed, asins: r.asinsUpdated, orders: r.totalOrders }, outcomes: {} };
      });
    } else {
      stages["sales"] = { stage: "sales", status: "done", durationMs: 0, counts: { skipped_dry_run: 1 }, outcomes: {} };
      emit({ type: "stage", stage: "sales", status: "done", skipped: "dry-run" });
    }
  })();

  await Promise.all([inventoryThenListings, pricesThenFees, salesPromise]);

  const result: RefreshJobResult = { stages, rateLimits: rateLimitStatsSince(rateBaseline) };
  const line = Object.values(stages)
    .map((s) => `${s.stage}=${s.status}${s.error ? `(${s.error.slice(0, 60)})` : ""}`)
    .join(" ");
  log(`Prices & Stock${dryRun ? " [DRY-RUN]" : ""} complete: ${line}`, "refresh");
  return result;
}
