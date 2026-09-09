import cron from "node-cron";
import { syncSourcingSheet } from "./sourcing-sync";
import { getOnboardNewAsins, mainCatalogSink } from "./routes";
import { log } from "./index";

export function startSourcingSyncCron() {
  // Run daily at 5:00 AM EST (9:00 UTC) — one hour before the inventory sync
  // so new ASINs from the sourcing sheet are picked up by today's 6 AM
  // inventory + 8 AM price-refresh passes.
  cron.schedule("0 9 * * *", async () => {
    log("Daily sourcing-sheet sync started", "cron");
    try {
      // §11 onboarding (2026-09-09): NEVER runAnalyzeCore directly for new
      // ASINs — Product Info alone leaves them priceless.
      const onboard = getOnboardNewAsins();
      const result = await syncSourcingSheet(async (newInputs) => {
        await onboard(newInputs, () => {}, mainCatalogSink, "sourcing");
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
