// 21. Actual fees and every other Finances line (Finances API patch commit 6,
// SPEC §7): rebuilds finances_daily for the days the pass can have changed —
// hourly the trailing REBUILD_HOURLY_DAYS (the fee of an order posts up to
// ~6 weeks after its purchase day), the 00:00 pass REBUILD_DAILY_DAYS after
// pulling the three reports (customer returns and removals for the trailing
// REPORT_DAYS, the storage fee report for the last two billed months), a
// backfill the whole params.finances_window.
import { ingestRemovals, ingestReturns, ingestStorageMonth, missingRemovalWindows, storageMonthFor, REPORT_CHUNK_DAYS } from "../../finances-reports";
import { retentionStart } from "../../finances";
import { rebuildFinancesDaily } from "../../finances-aggregate";
import { pacificDay } from "../../sales-sync";
import { financesWindowFor } from "./20-refunds";
import { ComponentError, type ComponentDef, type ComponentContext, type ComponentResult } from "../types";

export const REBUILD_HOURLY_DAYS = 60;
export const REBUILD_DAILY_DAYS = 120;
export const REPORT_DAYS = 60;
/** Older storage months filled per pass beyond the newest two (the report type's quota; 25 at once failed on 2026-11-21). */
export const STORAGE_MONTHS_PER_PASS = 3;

/** Test seam. */
export const actualFeesDeps = { ingestReturns, ingestRemovals, ingestStorageMonth, rebuildFinancesDaily, missingRemovalWindows, now: () => new Date() };

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** The Pacific-day range to rebuild and whether the reports are pulled, for a job. */
/**
 * `nightly` = the scheduled 00:00 pass (trigger 'scheduled' with the daily block). A Bulk Calc refresh or an onboarding job
 * also carries include_daily, and must never pull the reports (job 786, 2026-11-21: a Bulk Calc refresh spent two hours in the
 * storage report's quota waits and held lane M); they rebuild the hourly range only.
 */
/** `reports`: false = none; true = all three; "removals" = the removal order report alone (the `--removals-only` backfill). */
export function rebuildPlanFor(params: Record<string, any> | null | undefined, nightly: boolean, now: Date = actualFeesDeps.now()): { from: string; to: string; reports: boolean | "removals"; source: string } {
  const today = pacificDay(now.toISOString());
  const w = financesWindowFor(params, nightly, now);
  if (w.source === "params") {
    const requested = String(params?.finances_window?.from);
    const clamped = pacificDay(w.from.toISOString());
    const reports = params?.finances_reports === "removals" ? "removals" as const : params?.finances_reports !== false;
    return { from: requested > clamped ? requested : clamped, to: today, reports, source: "params" };
  }
  if (nightly) return { from: addDays(today, -REBUILD_DAILY_DAYS), to: today, reports: true, source: "daily" };
  return { from: addDays(today, -REBUILD_HOURLY_DAYS), to: today, reports: false, source: "hourly" };
}
/** The 00:00 scheduled pass, and nothing else (a bulk / onboarding / manual Refresh job with the daily block is not it). */
export const isNightlyPass = (job: { trigger: string; include_daily: boolean }) => job.trigger === "scheduled" && job.include_daily;

export const actualFees: ComponentDef = {
  n: 21, key: "21_actual_fees", name: "Actual fees charged", tier: "hourly", kind: "account",
  call: "rides 20's Finances pull; 00:00: customer returns, storage fee and removal order reports; rebuilds finances_daily",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const plan = rebuildPlanFor(ctx.job.params, isNightlyPass(ctx.job));
    const counts: Record<string, number> = {}; const outcomes: Record<string, string> = { _rebuild: `${plan.from}..${plan.to} (${plan.source})` };
    let failures = 0;
    if (plan.reports) {
      const today = plan.to;
      const from = plan.source === "params" ? plan.from : addDays(today, -REPORT_DAYS);
      const step = async (name: string, fn: () => Promise<Record<string, number>>) => {
        try { const r = await fn(); for (const [k, v] of Object.entries(r)) counts[`${name}_${k}`] = v; outcomes[`_${name}`] = Object.entries(r).map(([k, v]) => `${k} ${v}`).join(" · "); }
        catch (err: any) { failures++; outcomes[`_${name}`] = `error: ${err?.message ?? err}`; ctx.log(`${name}: ${err?.message ?? err}`); }
      };
      const chunked = async (name: string, r: { chunks: number; rows: number; failed: { from: string; to: string; error: string }[] }) => {
        r.failed.forEach((f, i) => { outcomes[`_${name}_failed_${String(i + 1).padStart(2, "0")} ${f.from}..${f.to}`] = `error: ${f.error}`; });
        if (r.failed.length) { failures += r.failed.length; counts[`${name}_chunks_failed`] = r.failed.length; }
        return { chunks: r.chunks, rows: r.rows };
      };
      const removalsOnly = plan.reports === "removals";
      if (!removalsOnly) await step("returns", async () => chunked("returns", await actualFeesDeps.ingestReturns(from, today, { jobId: ctx.job.id, log: ctx.log })));
      await step("removals", async () => {
        // The removal order report: one request per 30 minutes (docs/finances-removal-report-2026-11-21.md). The nightly pass asks
        // the trailing window and, after it, ONE older window no successful ingest covers yet (back to Amazon's 730 days), so the
        // history fills itself; a `--removals-only` backfill asks every missing window of its range, spaced.
        const r = await actualFeesDeps.ingestRemovals(from, today, { jobId: ctx.job.id, log: ctx.log });
        const horizon = pacificDay(retentionStart(actualFeesDeps.now()).toISOString());
        const older = (await actualFeesDeps.missingRemovalWindows(horizon, addDays(from, -1), ctx.query as any)).filter(([a]) => a >= horizon);
        const ask = plan.source === "params" ? [] : older.slice(-1); // nightly: the newest missing older window; a backfill's own range is already asked above
        let extra = { chunks: 0, rows: 0, failed: [] as typeof r.failed };
        for (const [a, b] of ask) { const x = await actualFeesDeps.ingestRemovals(a, b, { jobId: ctx.job.id, log: ctx.log }); extra = { chunks: extra.chunks + x.chunks, rows: extra.rows + x.rows, failed: [...extra.failed, ...x.failed] }; }
        if (older.length) outcomes._removals_older_missing = `${older.length - ask.length} older window(s) wait for later passes (${REPORT_CHUNK_DAYS}-day): ${older.slice(0, 3).map(([a, b]) => `${a}..${b}`).join(", ")}${older.length > 3 ? "…" : ""}`;
        return chunked("removals", { chunks: r.chunks + extra.chunks, rows: r.rows + extra.rows, failed: [...r.failed, ...extra.failed] });
      });
      if (!removalsOnly) await step("storage", async () => {
        // The storage fee report's createReport quota is tight (job 784, 2026-11-21: 25 months asked at once → QuotaExceeded on the first).
        // Wanted: every month whose row can have posted in the range. Asked this pass: the newest two wanted months plus the oldest
        // STORAGE_MONTHS_PER_PASS months the table still lacks — the history fills over the nightly passes (self-healing); a month that
        // fails is recorded and the next pass asks again.
        const wanted = new Set<string>();
        for (let d = from; d <= today; d = addDays(d, 28)) wanted.add(storageMonthFor(d));
        wanted.add(storageMonthFor(today));
        const have = new Set<string>((await ctx.query(`SELECT DISTINCT month FROM fba_storage_fees`)).rows.map((r: any) => String(r.month)));
        const sorted = Array.from(wanted).sort();
        const ask = new Set<string>(sorted.slice(-2));
        for (const m of sorted) { if (ask.size >= 2 + STORAGE_MONTHS_PER_PASS) break; if (!have.has(m)) ask.add(m); }
        let rows = 0, done = 0; const failed: string[] = [];
        for (const m of Array.from(ask).sort()) {
          try { const r = await actualFeesDeps.ingestStorageMonth(m, { jobId: ctx.job.id, log: ctx.log }); rows += r.rows; done++; counts[`storage_${m}`] = Math.round(r.total * 100) / 100; }
          catch (err: any) { failed.push(m); outcomes[`_storage_failed_${m}`] = `error: ${err?.message ?? err}`; ctx.log(`storage ${m}: ${err?.message ?? err}`); }
        }
        const missing = sorted.filter((m) => !have.has(m) && !ask.has(m));
        if (missing.length) outcomes._storage_still_missing = `${missing.length} month(s) wait for later passes: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? "…" : ""}`;
        if (failed.length) { failures += failed.length; counts.storage_months_failed = failed.length; }
        return { months_asked: ask.size, months_done: done, months_missing: missing.length, rows };
      });
    }
    try {
      const r = await actualFeesDeps.rebuildFinancesDaily(plan.from, plan.to, { log: ctx.log });
      counts.daily_rows = r.rows;
    } catch (err: any) {
      outcomes._rebuild_error = `error: ${err?.message ?? err}`;
      throw new ComponentError(`finances_daily rebuild ${plan.from}..${plan.to}: ${err?.message ?? err}`, { counts, outcomes });
    }
    if (failures > 0) counts.report_failures = failures;
    return { counts, outcomes };
  },
};
