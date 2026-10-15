// 19. Sales units / revenue (hourly, account). CALL-11 — today the orders
// flat-file report (GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL);
// the Finances patch swaps the implementation behind syncSales, not the
// schedule. Hourly window = last 48 hours, overlapping on purpose: the
// upsert is idempotent. Runs last (19–21) so Actual profit uses this
// hour's COGS.
import { syncSalesData } from "../../sales-sync";
import { ymdLocal } from "./shared";
import type { ComponentDef, ComponentContext, ComponentResult } from "../types";

export const SALES_WINDOW_HOURS = 48;

/** The one function the schedule calls; the Finances patch replaces its body. */
export async function syncSales(scope: ReadonlySet<string> | undefined, window: { start: string; end: string }) {
  return syncSalesData(window.start, window.end, scope);
}

export const sales: ComponentDef = {
  n: 19, key: "19_sales", name: "Sales units / revenue", tier: "hourly", kind: "account",
  call: "CALL-11 orders report (today); Finances listTransactions (later)",
  async run(ctx: ComponentContext): Promise<ComponentResult> {
    const end = new Date();
    const start = new Date(end.getTime() - SALES_WINDOW_HOURS * 3600 * 1000);
    // Account-wide regardless of selection (scope rules): no filter means the
    // active + parked row set receives rows, as before.
    const r = await syncSales(undefined, { start: ymdLocal(start), end: ymdLocal(end) });
    return { counts: { days: r.daysProcessed, asins: r.asinsUpdated, orders: r.totalOrders, window_hours: SALES_WINDOW_HOURS }, outcomes: {} };
  },
};
