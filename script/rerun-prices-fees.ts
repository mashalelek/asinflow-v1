// One-off: re-run ONLY the prices and fees stages of Prices & Stock.
//
// Why this exists (2026-10-13): a Prices & Stock run started 06:24:37 and was
// killed at 06:29:41 by a dev-server restart during the SC-mirror patch work.
// Its inventory (53s) and sales (61s) stages had already COMPLETED; prices
// died ~5 min into an ~18-21 min stage having committed essentially nothing,
// and fees never started because it waits on prices. Re-running the whole job
// would redo two stages that finished cleanly an hour earlier, so this runs
// the two that didn't.
//
// It is NOT a new feature and not a replacement for the Refresh button —
// there is no prices+fees-only endpoint, and adding one was out of scope.
// Delete it once it has served its purpose.
//
// Sequencing is copied from refresh-job.ts's pricesPromise, deliberately:
// fees runs AFTER prices with skipAsins = the price stage's outcome keys, so
// an ASIN the price stage reported on (no offers, throttled, restricted…)
// does not then get a fee computed against a price that was not written.
//
// Scope: filter = undefined, which is the cron scope the stages apply
// themselves (status IN ('active','parked')) — the same scope the killed run
// used.
//
// PORT: price-sync.ts and refresh-job.ts both `import { log } from "./index"`,
// which boots Express. Run with PORT=3999 so it does not collide with the dev
// server on 3000:
//
//   PORT=3999 npx tsx script/rerun-prices-fees.ts
//
// Writes one refresh_runs row per stage, trigger 'refresh', scope 'full', so
// the run is visible in history exactly like a button run.

import "dotenv/config";
import { refreshPrices, type PriceRefreshResult } from "../server/price-sync";
import { runFeesStage } from "../server/refresh-job";
import { query } from "../server/db";

const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);

async function ledger(
  stage: string,
  startedAt: Date,
  requested: number,
  counts: unknown,
  outcomes: unknown,
) {
  await query(
    `INSERT INTO refresh_runs (started_at, finished_at, trigger, stage, scope, requested, counts, outcomes)
     VALUES ($1, NOW(), 'refresh', $2, 'full', $3, $4::jsonb, $5::jsonb)`,
    [startedAt, stage, requested, JSON.stringify(counts ?? {}), JSON.stringify(outcomes ?? {})],
  );
}

(async () => {
  const scope = (await query(
    `SELECT count(*)::int AS n FROM asins WHERE status IN ('active','parked')`,
  )).rows[0]?.n ?? 0;
  console.log(`scope: ${scope} active+parked ASINs (cron scope, same as the killed run)`);

  // ── prices ────────────────────────────────────────────────────────────
  const pStart = new Date();
  console.log(`[${secs()}s] prices: starting…`);
  let last = 0;
  const priceRes: PriceRefreshResult = await refreshPrices(
    (p: any) => {
      if (p.current - last >= 250 || p.current === p.total) {
        last = p.current;
        console.log(`[${secs()}s] prices: ${p.current}/${p.total}`);
      }
    },
    undefined,
    { dryRun: false },
  );
  console.log(`[${secs()}s] prices DONE: ${JSON.stringify(priceRes.counts)}`);
  await ledger("prices", pStart, scope, priceRes.counts, priceRes.outcomes);

  // ── fees ──────────────────────────────────────────────────────────────
  // skipAsins = the price stage's outcome keys, exactly as refresh-job does.
  const fStart = new Date();
  const skipAsins = new Set(Object.keys(priceRes.outcomes ?? {}));
  console.log(`[${secs()}s] fees: starting (skipping ${skipAsins.size} ASINs the price stage reported on)…`);
  const feesRes = await runFeesStage({
    filter: undefined,
    dryRun: false,
    emit: () => {},
    skipAsins,
  });
  console.log(`[${secs()}s] fees DONE: ${JSON.stringify(feesRes.counts)}`);
  await ledger("fees", fStart, scope, feesRes.counts, feesRes.outcomes);

  console.log(`\nCOMPLETE in ${secs()}s — both refresh_runs rows written.`);
  process.exit(0);
})().catch((err: any) => {
  console.error(`FAILED after ${secs()}s:`, err?.message ?? err);
  process.exit(1);
});
