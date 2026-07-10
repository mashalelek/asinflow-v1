import cron from "node-cron";
import { syncSourcingSheet } from "./sourcing-sync";
import { getRunAnalyzeCore } from "./routes";
import { log } from "./index";

export function startSourcingSyncCron() {
  // Run daily at 5:00 AM EST (9:00 UTC) — one hour before the inventory sync
  // so new ASINs from the sourcing sheet are picked up by today's 6 AM
  // inventory + 8 AM price-refresh passes.
  cron.schedule("0 9 * * *", async () => {
    log("Daily sourcing-sheet sync started", "cron");
    try {
      const runCore = getRunAnalyzeCore();
      const result = await syncSourcingSheet(async (newInputs) => {
        await runCore(newInputs, () => {}, () => null, true);
      });
      log(
        `Daily sourcing-sheet sync complete: inserted ${result.inserted}, archivedNew ${result.archivedNew}, skippedExisting ${result.skippedExisting}, errors ${result.errors.length}`,
        "cron",
      );
    } catch (err: any) {
      log(`Daily sourcing-sheet sync failed: ${err.message}`, "cron");
    }
  });
  log("Sourcing-sheet cron scheduled: daily at 5:00 AM EST (9:00 UTC)", "cron");
}
