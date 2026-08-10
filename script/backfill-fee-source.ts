// Backfill fee_source = 'fallback' for legacy rows whose stored fee triple
// exactly reproduces estimateFeeFallback at the stored estimate price /
// weight / category — the fingerprint from the 2026-08-09 diagnosis (~71
// active rows; B0F74MTVJP stored $3.53 vs Amazon's real $5.66). Only rows
// with fee_source IS NULL are touched; remaining NULLs are presumed real
// ('spapi'-derived). Idempotent — re-running matches nothing new.
//
// Marked rows become visible immediately (amber indicator) and self-heal on
// the next successful real fee fetch ('spapi' always wins the write gate).
import "dotenv/config";
// server/spapi transitively imports server/index (its log()), whose module
// side effect boots Express. PORT=0 → ephemeral port, no conflict with the
// dev server; the explicit process.exit() below ends the process despite the
// live listener. Inlining was rejected: reusing the REAL fee path with zero
// drift is the point (backfill-catalog-deleted.ts inlines for the same boot
// reason, but it only needs 404-detection — we need parseFeeResult intact).
process.env.PORT = "0";
import pg from "pg";

async function main() {
  const { estimateFeeFallback } = await import("../server/spapi");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const rows = (await pool.query(`
    SELECT e.asin, e.fba_fee, e.referral_fee, e.fees_estimate_price, a.weight_lb, a.category, a.is_active
      FROM asin_estimates e JOIN asins a ON a.asin = e.asin
     WHERE e.fee_source IS NULL AND e.fba_fee IS NOT NULL AND e.fees_estimate_price IS NOT NULL`)).rows;

  const matches: string[] = [];
  let activeCount = 0;
  for (const r of rows) {
    const fb = estimateFeeFallback(
      r.asin,
      parseFloat(r.fees_estimate_price),
      r.weight_lb != null ? parseFloat(r.weight_lb) : null,
      r.category,
    );
    if (fb.fbaFulfillmentFee != null && Math.abs(fb.fbaFulfillmentFee - parseFloat(r.fba_fee)) < 0.005) {
      matches.push(r.asin);
      if (r.is_active) activeCount++;
    }
  }

  console.log(`Fingerprint: ${matches.length} of ${rows.length} unmarked rows reproduce estimateFeeFallback (${activeCount} active)`);
  if (matches.length === 0) { await pool.end(); return; }

  const updated = await pool.query(
    `UPDATE asin_estimates SET fee_source = 'fallback' WHERE asin = ANY($1::text[]) AND fee_source IS NULL RETURNING asin`,
    [matches],
  );
  console.log(`Marked fee_source='fallback' on ${updated.rowCount} rows`);
  await pool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
