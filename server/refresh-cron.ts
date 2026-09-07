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
  // 10:00 — AFTER the 09:00 sourcing-sheet sync, so leads added that
  // morning are included in the day's Refresh (post-implementation review,
  // 2026-09-07).
  cron.schedule("0 10 * * *", async () => {
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
  log("Refresh cron scheduled: daily at 10:00 host-local time, after the 09:00 sourcing sync (replaces inventory/price/live-offer crons)", "cron");
}
