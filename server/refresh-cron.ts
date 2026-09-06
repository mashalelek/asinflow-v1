// Daily Refresh cron (SPEC §11 "Refresh job", 2026-09-06). Replaces the
// separate inventory (10:00 UTC), price (12:00), and live-offer (07:00)
// crons with ONE daily run of the same Refresh job the toolbar button uses.
// Scope: every non-archived ASIN (asins omitted → is_active = TRUE, sourcing
// leads included — decision 7/10). Still gated behind ENABLE_CRONS (default
// off; manual is the operating model).
import cron from "node-cron";
import { runRefreshJob } from "./refresh-job";
import { log } from "./index";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startRefreshCron() {
  cron.schedule("0 7 * * *", async () => {
    log("Daily Refresh started (full non-archived scope)", "cron");
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 86400000);
      const result = await runRefreshJob({
        startDate: ymd(from),
        endDate: ymd(to),
        trigger: "cron",
        dryRun: false,
        emit: () => {},
      });
      const line = Object.values(result.stages).map((s) => `${s.stage}=${s.status}`).join(" ");
      log(`Daily Refresh complete: ${line}`, "cron");
    } catch (err: any) {
      log(`Daily Refresh failed: ${err.message}`, "cron");
    }
  });
  log("Refresh cron scheduled: daily at 07:00 host-local time (replaces inventory/price/live-offer crons)", "cron");
}
