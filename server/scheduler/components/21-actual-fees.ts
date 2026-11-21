// 21. Actual fees and every other Finances line (Finances API patch commit 6,
// SPEC §7): rebuilds finances_daily for the days the pass can have changed —
// hourly the trailing REBUILD_HOURLY_DAYS (the fee of an order posts up to
// ~6 weeks after its purchase day), the 00:00 pass REBUILD_DAILY_DAYS after
// pulling the three reports (customer returns and removals for the trailing
// REPORT_DAYS, the storage fee report for the last two billed months), a
// backfill the whole params.finances_window.
import { ingestRemovals, ingestReturns, ingestStorageMonth, storageMonthFor } from "../../finances-reports";
import { rebuildFinancesDaily } from "../../finances-aggregate";
import { pacificDay } from "../../sales-sync";
import { financesWindowFor } from "./20-refunds";
import { ComponentError, type ComponentDef, type ComponentContext, type ComponentResult } from "../types";

export const REBUILD_HOURLY_DAYS = 60;
export const REBUILD_DAILY_DAYS = 120;
export const REPORT_DAYS = 60;

/** Test seam. */
export const actualFeesDeps = { ingestReturns, ingestRemovals, ingestStorageMonth, rebuildFinancesDaily, now: () => new Date() };

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** The Pacific-day range to rebuild and whether the reports are pulled, for a job. */
export function rebuildPlanFor(params: Record<string, any> | null | undefined, includeDaily: boolean, now: Date = actualFeesDeps.now()): { from: string; to: string; reports: boolean; source: string } {
  const today = pacificDay(now.toISOString());
  const w = financesWindowFor(params, includeDaily, now);
  if (w.source === "params") {
    const requested = String(params?.finances_window?.from);
    const clamped = pacificDay(w.from.toISOString());
    return { from: requested > clamped ? requested : clamped, to: today, reports: params?.finances_reports !== false, source: "params" };
  }
  if (includeDaily) return { from: addDays(today, -REBUILD_DAILY_DAYS), to: today, reports: true, source: "daily" };
  return { from: addDays(today, -REBUILD_HOURLY_DAYS), to: today, reports: false, source: "hourly" };
}

export const actualFees: ComponentDef = {
  n: 21, key: "21_actual_fees", name: "Actual fees charged", tier: "hourly", kind: "account",
  call: "rides 20's Finances pull; 00:00: customer returns, storage fee and removal order reports; rebuilds finances_daily",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const plan = rebuildPlanFor(ctx.job.params, ctx.job.include_daily);
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
      await step("returns", async () => chunked("returns", await actualFeesDeps.ingestReturns(from, today, { jobId: ctx.job.id, log: ctx.log })));
      await step("removals", async () => chunked("removals", await actualFeesDeps.ingestRemovals(from, today, { jobId: ctx.job.id, log: ctx.log })));
      await step("storage", async () => {
        // Every month whose storage row can have posted in the range: the month before each posting month, from `from` to today.
        const months = new Set<string>();
        for (let d = from; d <= today; d = addDays(d, 28)) months.add(storageMonthFor(d));
        months.add(storageMonthFor(today));
        let rows = 0, total = 0;
        for (const m of Array.from(months).sort()) { const r = await actualFeesDeps.ingestStorageMonth(m, { jobId: ctx.job.id, log: ctx.log }); rows += r.rows; total += r.total; counts[`storage_${m}`] = Math.round(r.total * 100) / 100; }
        return { months: months.size, rows };
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
