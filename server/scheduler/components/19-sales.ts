// 19. Sales units / revenue (hourly, account). CALL-11 — today the orders
// flat-file report (GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL);
// the Finances patch swaps the implementation behind syncSales, not the
// schedule. Runs last (19–21) so Actual profit uses this hour's COGS.
//
// Window: `job.params.sales_window = {from, to}` (YYYY-MM-DD) when the job
// carries one — the history backfill (POST /api/jobs/backfill-sales) — else
// the last 48 hours, overlapping on purpose: the upsert is idempotent.
//
// Scope (2026-10-16): every ASIN in `asins`, all statuses. ASINs the report
// names that AF lacks are inserted through the standard onboarding path
// (injected `onboardSalesAsins`, tag "Sales import") before each chunk's
// upsert, and ONE Refresh job scoped to all of them is enqueued at the end.
// Per-chunk results go in the outcomes under `_chunk …` keys; a failed chunk
// fails the component with the chunks so far recorded (ComponentError).
import { syncSalesData, SalesSyncError, type SalesSyncResult, type SalesSyncOptions } from "../../sales-sync";
import { enqueueJob } from "../jobs-repo";
import { ymdLocal } from "./shared";
import { ComponentError, type ComponentDef, type ComponentContext, type ComponentResult } from "../types";

export const SALES_WINDOW_HOURS = 48;
export const ONBOARD_SALES_ASINS = "onboardSalesAsins";

/** Test seam: the sync function the component calls. */
export const salesDeps = { sync: syncSalesData };

/** The one function the schedule calls; the Finances patch replaces its body. */
export async function syncSales(scope: ReadonlySet<string> | undefined, window: { start: string; end: string }, opts: SalesSyncOptions = {}): Promise<SalesSyncResult> {
  return salesDeps.sync(window.start, window.end, scope, opts);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The window for a job: its params.sales_window when valid, else the trailing 48 hours. */
export function salesWindowFor(params: Record<string, any> | null | undefined, now: Date = new Date()): { start: string; end: string; source: "params" | "default" } {
  const w = params?.sales_window;
  if (w && typeof w === "object" && YMD.test(String(w.from)) && YMD.test(String(w.to)) && String(w.from) <= String(w.to)) {
    return { start: String(w.from), end: String(w.to), source: "params" };
  }
  const start = new Date(now.getTime() - SALES_WINDOW_HOURS * 3600 * 1000);
  return { start: ymdLocal(start), end: ymdLocal(now), source: "default" };
}

/** The ledger shape for a (possibly partial) sync result. */
export function salesResultToComponent(r: SalesSyncResult, window: { start: string; end: string; source: string }): ComponentResult {
  const counts: Record<string, number> = {
    days: r.daysProcessed, asins: r.asinsUpdated, orders: r.totalOrders,
    chunks: r.chunks.length, chunks_failed: r.chunks.filter((c) => c.status === "failed").length,
    onboarded_from_sales: r.onboarded.length,
    invalid_asins_skipped: r.invalidAsins.length,
  };
  if (window.source === "default") counts.window_hours = SALES_WINDOW_HOURS;
  const outcomes: Record<string, string> = {
    _window: `${window.start}..${window.end} (${window.source})`,
    _earliest_sale_date_returned: r.minDate ?? "none",
    _latest_sale_date_returned: r.maxDate ?? "none",
  };
  r.chunks.forEach((c, i) => {
    const key = `_chunk_${String(i + 1).padStart(2, "0")} ${c.start}..${c.end}`;
    outcomes[key] = c.status === "failed"
      ? `error: ${c.error}`
      : `${c.status} · orders ${c.orders} · days ${c.days} · asins ${c.asins} · onboarded ${c.onboarded.length} · returned ${c.minDate ?? "-"}..${c.maxDate ?? "-"}`;
  });
  if (r.onboarded.length > 0) outcomes._onboarded_from_sales = r.onboarded.join(", ");
  if (r.invalidAsins.length > 0) outcomes._invalid_asins_skipped = r.invalidAsins.join(", ");
  return { counts, outcomes };
}

export const sales: ComponentDef = {
  n: 19, key: "19_sales", name: "Sales units / revenue", tier: "hourly", kind: "account",
  call: "CALL-11 orders report (today); Finances listTransactions (later)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const window = salesWindowFor(ctx.job.params);
    const onboard = ctx.cache.get(ONBOARD_SALES_ASINS) as ((asins: string[]) => Promise<void>) | undefined;
    if (!onboard) ctx.log("onboardSalesAsins is not injected — ASINs the report names that AF lacks will be skipped this run");
    ctx.log(`window ${window.start}..${window.end} (${window.source})`);

    let r: SalesSyncResult;
    try {
      // Account-wide regardless of selection (scope rules): no filter means
      // every row in asins receives rows.
      r = await syncSales(undefined, window, {
        onboard,
        onChunk: (c, i, n) => ctx.log(`chunk ${i + 1}/${n} ${c.start}..${c.end}: ${c.status}${c.status === "failed" ? ` — ${c.error}` : ` orders=${c.orders} days=${c.days} asins=${c.asins} onboarded=${c.onboarded.length} returned=${c.minDate ?? "-"}..${c.maxDate ?? "-"}`}`),
      });
    } catch (err: any) {
      if (err instanceof SalesSyncError) {
        await enqueueOnboarding(ctx, err.partial.onboarded);
        throw new ComponentError(err.message, salesResultToComponent(err.partial, window));
      }
      throw err;
    }
    await enqueueOnboarding(ctx, r.onboarded);
    return salesResultToComponent(r, window);
  },
};

/** One Refresh job (daily block included) for every ASIN this run inserted — the standard onboarding job. */
async function enqueueOnboarding(ctx: ComponentContext, asins: string[]): Promise<void> {
  if (asins.length === 0) return;
  try {
    const job = await enqueueJob({ trigger: "onboarding", includeDaily: true, scopeAsins: asins }, ctx.query);
    ctx.log(`${asins.length} ASIN(s) onboarded from sales; refresh job #${job.id} queued for them`);
  } catch (err: any) {
    ctx.log(`${asins.length} ASIN(s) onboarded from sales but their refresh job could not be queued — run Refresh for them: ${err?.message ?? err}`);
  }
}
