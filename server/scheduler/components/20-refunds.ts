// 20. Refunds — the Finances pull (Finances API patch commit 6, SPEC §7). ONE
// listTransactions read per pass serves 20 and 21: this component ingests the
// posted window into finances_transactions / finances_lines (refund rows
// included, fail-closed per weekly window) and leaves the days touched in the
// job cache; 21 rebuilds the aggregate from them.
//
// Window: `job.params.finances_window = {from, to}` (YYYY-MM-DD, the backfill)
// → every weekly window from `from` 00:00Z to `to` + 1 day; else the trailing
// FINANCES_HOURLY_DAYS; the 00:00 pass (include_daily) the trailing
// FINANCES_DAILY_DAYS, far enough back for late postings and releases.
import { ingestRange, retentionStart, type IngestResult } from "../../finances";
import { ComponentError, type ComponentDef, type ComponentContext, type ComponentResult } from "../types";

export const FINANCES_HOURLY_DAYS = 3;
export const FINANCES_DAILY_DAYS = 60;
export const FINANCES_WINDOW_KEY = "financesWindow";
export const FINANCES_POSTED_BEFORE_LAG_MS = 5 * 60_000;

/** Test seam. */
export const refundsDeps = { ingestRange, now: () => new Date() };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** The posted window for a job: params.finances_window when valid (clamped to Amazon's retention), else trailing days by pass. */
export function financesWindowFor(params: Record<string, any> | null | undefined, includeDaily: boolean, now: Date = refundsDeps.now()): { from: Date; to: Date; source: "params" | "hourly" | "daily" } {
  const w = params?.finances_window;
  // postedBefore must sit a few minutes behind now (Amazon answers 400 otherwise — the 23:56 UTC hourly pass on 2026-11-20 with now − 60 s); 5 minutes.
  const to = new Date(now.getTime() - FINANCES_POSTED_BEFORE_LAG_MS);
  if (w && typeof w === "object" && YMD.test(String(w.from)) && YMD.test(String(w.to)) && String(w.from) <= String(w.to)) {
    const from = new Date(Math.max(Date.parse(`${w.from}T00:00:00Z`), retentionStart(now).getTime()));
    const end = new Date(Math.min(Date.parse(`${w.to}T00:00:00Z`) + 86400_000, to.getTime()));
    return { from, to: end, source: "params" };
  }
  const days = includeDaily ? FINANCES_DAILY_DAYS : FINANCES_HOURLY_DAYS;
  return { from: new Date(to.getTime() - days * 86400_000), to, source: includeDaily ? "daily" : "hourly" };
}

export const refunds: ComponentDef = {
  n: 20, key: "20_refunds", name: "Refunds", tier: "hourly", kind: "account",
  call: "Finances listTransactions (posted window; one pull for 20 and 21)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const w = financesWindowFor(ctx.job.params, ctx.job.include_daily);
    ctx.log(`finances window ${w.from.toISOString()}..${w.to.toISOString()} (${w.source})`);
    const results: IngestResult[] = [];
    const chunked = w.source === "params";
    try {
      await refundsDeps.ingestRange(w.from, w.to, {
        jobId: ctx.job.id, log: ctx.log,
        onWindow: async (r, i, n) => { results.push(r); if (chunked) await ctx.setProgress(i + 1, n, "week"); },
      });
    } catch (err: any) {
      const partial = toResult(results, w);
      partial.outcomes._error = `error: ${err?.message ?? err}`;
      ctx.cache.set(FINANCES_WINDOW_KEY, w);
      throw new ComponentError(`finances window after ${results.length} week(s): ${err?.message ?? err}`, partial);
    }
    ctx.cache.set(FINANCES_WINDOW_KEY, w);
    return toResult(results, w);
  },
};

function toResult(results: IngestResult[], w: { from: Date; to: Date; source: string }): ComponentResult {
  const counts: Record<string, number> = {
    weeks: results.length, calls: results.reduce((s, r) => s + r.calls, 0), transactions_read: results.reduce((s, r) => s + r.read, 0),
    transactions_stored: results.reduce((s, r) => s + r.stored, 0), deferred_superseded: results.reduce((s, r) => s + r.superseded, 0),
  };
  const outcomes: Record<string, string> = { _window: `${w.from.toISOString().slice(0, 10)}..${w.to.toISOString().slice(0, 10)} (${w.source})` };
  if (results.length > 1) results.forEach((r, i) => { outcomes[`_week_${String(i + 1).padStart(3, "0")} ${r.window.from.slice(0, 10)}`] = `${r.read} read · ${r.stored} stored · ${r.released} released · ${r.calls} call(s)`; });
  return { counts, outcomes };
}
