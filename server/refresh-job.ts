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
import { rateLimitStats } from "./spapi-rate-limit";

export type RefreshTrigger = "manual" | "refresh" | "cron";
export type RefreshStage = "inventory" | "sales" | "prices" | "listings";

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
): Promise<void> {
  try {
    await query(
      `INSERT INTO refresh_runs (started_at, finished_at, trigger, stage, scope, requested, counts, outcomes, rate_limit_stats, error)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
      [startedAt, trigger, s.stage, scope, requested, JSON.stringify(s.counts),
       JSON.stringify(s.outcomes), JSON.stringify(rateLimitStats()), s.error ?? null],
    );
  } catch (err: any) {
    // Ledger write failure must never fail the job (coverage log semantics).
    log(`refresh_runs write failed for stage ${s.stage}: ${err?.message ?? err}`, "refresh");
  }
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
      log(`Refresh stage ${stage} FAILED (others continue): ${summary.error}`, "refresh");
    }
    stages[stage] = summary;
    if (!dryRun) await recordRun(opts.trigger, scope, requested, startedAt, summary);
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

  const pricesPromise = runStage("prices", async () => {
    const r: PriceRefreshResult = await refreshPrices(
      (p) => emit({ type: "stage", stage: "prices", status: "running", current: p.current, total: p.total }),
      filter,
      { dryRun },
    );
    return { counts: r.counts as any, outcomes: r.outcomes };
  });

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

  await Promise.all([inventoryThenListings, pricesPromise, salesPromise]);

  const result: RefreshJobResult = { stages, rateLimits: rateLimitStats() };
  const line = Object.values(stages)
    .map((s) => `${s.stage}=${s.status}${s.error ? `(${s.error.slice(0, 60)})` : ""}`)
    .join(" ");
  log(`Refresh${dryRun ? " [DRY-RUN]" : ""} complete: ${line}`, "refresh");
  return result;
}
