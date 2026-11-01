// Repair pass over fee_source='fallback' rows: re-attempt the REAL fee fetch
// (the analyze path's getFees — degraded-response guard and category-referral
// fallback included) at the current sale price, and overwrite the fallback
// triple on success (fee_source → 'spapi'). Failures leave the row untouched
// ('fallback' stays visible; the analyze self-heal retries later). Paced for
// the fees API. Reports before/after per row.
//
// Pass --dry-run to fetch + report without writing.
import "./env";
// server/spapi transitively imports server/index (its log()), whose module
// side effect boots Express. PORT=0 → ephemeral port, no conflict with the
// dev server; the explicit process.exit() below ends the process despite the
// live listener. Inlining was rejected: reusing the REAL fee path with zero
// drift is the point (backfill-catalog-deleted.ts inlines for the same boot
// reason, but it only needs 404-detection — we need parseFeeResult intact).
process.env.PORT = "0";
import pg from "pg";

const DRY = process.argv.includes("--dry-run");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { getFees } = await import("../server/spapi");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const rows = (await pool.query(`
    SELECT e.asin, e.fba_fee, e.referral_fee, e.fees_estimate_price,
           COALESCE(e.lowest_fba_price, e.buy_box_price, e.lowest_price, e.fees_estimate_price) AS price,
           a.category, a.is_active
      FROM asin_estimates e JOIN asins a ON a.asin = e.asin
     WHERE e.fee_source = 'fallback'
     ORDER BY a.is_active DESC, e.asin`)).rows;

  console.log(`${rows.length} fallback-marked rows${DRY ? " (DRY RUN — no writes)" : ""}`);
  console.log("asin | active | old_fba | old_ref @ old_price | new_fba | new_ref @ new_price | outcome");

  let healed = 0, failed = 0, skippedNoPrice = 0;
  for (const r of rows) {
    const price = r.price != null ? parseFloat(r.price) : null;
    const oldStr = `$${parseFloat(r.fba_fee).toFixed(2)} | $${parseFloat(r.referral_fee ?? 0).toFixed(2)} @ $${parseFloat(r.fees_estimate_price ?? 0).toFixed(2)}`;
    if (price == null || price <= 0) {
      skippedNoPrice++;
      console.log(`${r.asin} | ${r.is_active ? "y" : "n"} | ${oldStr} | - | - | SKIP no price`);
      continue;
    }
    try {
      const fees = await getFees(r.asin, price, r.category);
      if (fees.fbaFulfillmentFee == null || fees.feeSource !== "spapi") {
        failed++;
        console.log(`${r.asin} | ${r.is_active ? "y" : "n"} | ${oldStr} | - | - | REAL FETCH FAILED (stays fallback)`);
      } else {
        if (!DRY) {
          await pool.query(
            `UPDATE asin_estimates
                SET fba_fee = $2, referral_fee = $3, fees_estimate_price = $4, fee_source = 'spapi'
              WHERE asin = $1 AND fee_source = 'fallback'`,
            [r.asin, fees.fbaFulfillmentFee, fees.referralFee, fees.feesEstimatePrice],
          );
        }
        healed++;
        const delta = fees.fbaFulfillmentFee - parseFloat(r.fba_fee);
        console.log(`${r.asin} | ${r.is_active ? "y" : "n"} | ${oldStr} | $${fees.fbaFulfillmentFee.toFixed(2)} | $${(fees.referralFee ?? 0).toFixed(2)} @ $${price.toFixed(2)} | HEALED (fba ${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`);
      }
    } catch (err: any) {
      failed++;
      console.log(`${r.asin} | ${r.is_active ? "y" : "n"} | ${oldStr} | - | - | ERROR ${String(err.message).slice(0, 50)}`);
    }
    await sleep(700);
  }
  console.log(`\nSummary: ${healed} healed${DRY ? " (dry)" : ""}, ${failed} real-fetch failures (stay 'fallback'), ${skippedNoPrice} skipped (no price)`);
  await pool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
