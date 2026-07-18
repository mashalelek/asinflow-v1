import cron from "node-cron";
import { syncInventory } from "./inventory-sync";
import { log } from "./index";

export function startInventoryCron() {
  // Run daily at 6:00 AM EST (10:00 UTC)
  cron.schedule("0 10 * * *", async () => {
    log("Daily inventory sync started", "cron");
    try {
      const result = await syncInventory();
      log(`Daily inventory sync complete: ${result.synced} synced, ${result.skipped} skipped; live-offer ${result.liveOffer.checked} checked (${result.liveOffer.live} live, ${result.liveOffer.no_offer} no_offer, ${result.liveOffer.throttled} throttled)`, "cron");
    } catch (err: any) {
      log(`Daily inventory sync failed: ${err.message}`, "cron");
    }
  });
  log("Inventory cron scheduled: daily at 6:00 AM EST (10:00 UTC)", "cron");
}
