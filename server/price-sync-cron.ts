import cron from "node-cron";
import { refreshPrices } from "./price-sync";
import { log } from "./index";

export function startPriceSyncCron() {
  // Run daily at 8:00 AM EST (12:00 UTC, one hour after the 6 AM EST
  // inventory sync). Does a lightweight price-only refresh for all active
  // ASINs — no catalog/fees/suppression re-fetch.
  cron.schedule("0 12 * * *", async () => {
    log("Daily price refresh started", "cron");
    try {
      const result = await refreshPrices();
      log(
        `Daily price refresh complete: updated ${result.updated} ASINs, ${result.failed} failed`,
        "cron",
      );
    } catch (err: any) {
      log(`Daily price refresh failed: ${err.message}`, "cron");
    }
  });
  log("Price sync cron scheduled: daily at 8:00 AM EST (12:00 UTC)", "cron");
}
