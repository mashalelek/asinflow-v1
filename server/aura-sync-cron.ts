import cron from "node-cron";
import { runAuraSyncChain } from "./aura-sync-chain";
import { log } from "./index";

export function startAuraSyncCron() {
  // node-cron with NO timezone option fires in HOST-LOCAL time (not UTC). On
  // this machine that is 1:00 PM local, one hour after the 12:00 (noon local)
  // price sync. This is the honest description — unlike the other crons'
  // "EST/UTC" comments, which are misleading: none of them pass a timezone
  // option, so they all fire at host-local time, not the UTC hour they name.
  cron.schedule("0 13 * * *", async () => {
    log("Aura sync chain (PO → Aura) started", "cron");
    try {
      await runAuraSyncChain();
    } catch (err: any) {
      log(`Aura sync chain failed: ${err.message}`, "cron");
    }
  });
  log("Aura sync cron scheduled: daily at 13:00 host-local time", "cron");
}
