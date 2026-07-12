import cron from "node-cron";
import { syncLiveOffers } from "./live-offer-sync";
import { log } from "./index";

export function startLiveOfferCron() {
  // node-cron with NO timezone option fires in HOST-LOCAL time (see the note in
  // aura-sync-cron.ts — the other crons' "EST/UTC" comments are misleading). 7:00
  // local: after the 6:00 inventory sync (which refreshes in_catalog), before the
  // 8:00 price sync. ~1.5k getListingsItem calls at 5 req/s ≈ well under 15 min.
  cron.schedule("0 7 * * *", async () => {
    log("Live-offer staleness sync started", "cron");
    try {
      await syncLiveOffers();
    } catch (err: any) {
      log(`Live-offer sync failed: ${err.message}`, "cron");
    }
  });
  log("Live-offer sync cron scheduled: daily at 07:00 host-local time", "cron");
}
