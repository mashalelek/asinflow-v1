// Seed listing_submissions from existing asin_skus rows submitted before the
// ledger existed. submission_id + submitted_price are NULL (never stored
// historically); submitted_at = asin_skus.created_at. Rows land 'pending' → run
// POST /api/submissions/verify (or the sweep) to resolve.
//
// DUAL PURPOSE — this is ALSO the repair path for any submission whose best-
// effort recordSubmission() write failed at submit time. It is idempotent by
// (asin, sku) via the NOT EXISTS guard, so re-running never duplicates and
// always fills gaps. Preserve that idempotency-by-ASIN/SKU across refactors.
//
// SELECTION PREDICATE (important): asin_skus also holds inventory-sync-OBSERVED
// SKUs (arbitrary/legacy formats), not just AF-PUT offers. We therefore restrict
// to the current canonical SKU format (BRD-DEP-AS3-TTL-NNN[-X]) so we only seed
// rows AF actually submitted — never inventory-observed noise.
//
// Run:  npx tsx script/backfill-listing-submissions.ts [--since=YYYY-MM-DD]        (dry run: prints candidates)
//       npx tsx script/backfill-listing-submissions.ts [--since=YYYY-MM-DD] --apply (insert)

import "dotenv/config";
import { query } from "../server/db";

// Mirrors matchesCurrentSkuFormat / SKU_FMT (offer-add.ts): 3-3-3-3-NNN[-X].
const CANONICAL_SKU_RE = `^[A-Z]{3}-[A-Z]{3}-[A-Z0-9]{3}-[A-Z]{3}-[0-9]{3}(-[A-Z])?$`;

(async () => {
  const sinceArg = process.argv.find((a) => a.startsWith("--since="));
  const untilArg = process.argv.find((a) => a.startsWith("--until="));
  const since = sinceArg ? sinceArg.split("=")[1] : "2026-07-04"; // default: yesterday's batch
  const until = untilArg ? untilArg.split("=")[1] : null;          // optional upper bound (inclusive, by date)
  const apply = process.argv.includes("--apply");

  const WHERE = `
      WHERE s.created_at::date >= $1::date
        AND ($2::date IS NULL OR s.created_at::date <= $2::date)  -- optional upper bound
        AND s.sku ~ '${CANONICAL_SKU_RE}'                     -- AF-submitted SKUs only
        AND NOT EXISTS (                                       -- idempotent by (asin, sku)
          SELECT 1 FROM listing_submissions ls WHERE ls.asin = a.asin AND ls.sku = s.sku
        )`;

  // Always show candidates first (confirmation).
  const cand = await query(
    `SELECT a.asin, s.sku, s.created_at
       FROM asin_skus s JOIN asins a ON a.id = s.asin_id ${WHERE}
      ORDER BY s.created_at`,
    [since, until],
  );
  console.log(`Candidate rows since ${since} (canonical SKU, not already in ledger): ${cand.rowCount}`);
  for (const r of cand.rows) console.log(`  ${r.asin}  ${r.sku}  ${r.created_at.toISOString?.() ?? r.created_at}`);

  if (!apply) {
    console.log(`\nDRY RUN — re-run with --apply to insert these ${cand.rowCount} row(s) as 'pending'.`);
    process.exit(0);
  }

  const ins = await query(
    `INSERT INTO listing_submissions (asin, sku, submission_id, submitted_price, submitted_at, verify_status)
     SELECT a.asin, s.sku, NULL, NULL, s.created_at, 'pending'
       FROM asin_skus s JOIN asins a ON a.id = s.asin_id ${WHERE}
     RETURNING asin, sku`,
    [since, until],
  );
  console.log(`\nInserted ${ins.rowCount} submission row(s) as 'pending'.`);
  console.log(`Next: POST /api/submissions/verify to resolve them against SC.`);
  process.exit(0);
})().catch((e) => { console.error("Backfill failed:", e?.message ?? e); process.exit(1); });
