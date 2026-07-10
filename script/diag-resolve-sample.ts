// Read-only-ish diagnostic. Demonstrates end-to-end:
//   1. Pick 5 random NULL-category ASINs (mix of stale-alive + dead-404).
//   2. Show their stored row before.
//   3. Run resolveAndGenerateSku — which fetches catalog + self-heals + resolves
//      legend + generates SKU.
//   4. Show outcome and the row after.
//
// Self-heal WRITES to `asins` (category/brand/title/image_url) — that's the
// 2C contract. No other tables touched. SKUs are NOT persisted by this diag —
// the offer-add flow does that later in STEP 2D.

import "dotenv/config";
import { query } from "../server/db";
import { resolveAndGenerateSku } from "../server/sku-resolver";

(async () => {
  const sample = await query(
    `SELECT asin, category, brand, title, image_url
     FROM asins WHERE category IS NULL
     ORDER BY random() LIMIT 5`,
  );

  let prodN = 900;
  for (const before of sample.rows) {
    console.log(`\n=== ${before.asin} ===`);
    console.log(`  BEFORE: category=${JSON.stringify(before.category)} brand=${JSON.stringify(before.brand)} title=${JSON.stringify((before.title ?? "").slice(0, 60))}`);

    const outcome = await resolveAndGenerateSku(
      before.asin,
      ++prodN,
      {
        queryFn: (sql, params) => query(sql, params),
        selfHealWrite: async (cat) => {
          await query(
            `UPDATE asins SET
               category = COALESCE($2, category),
               brand = COALESCE($3, brand),
               title = COALESCE($4, title),
               image_url = COALESCE($5, image_url),
               last_refreshed_at = NOW()
             WHERE asin = $1`,
            [cat.asin, cat.category, cat.brand, cat.itemName, cat.imageUrl],
          );
        },
      },
    );

    if (outcome.ok) {
      console.log(`  OUTCOME: ok  sku=${outcome.sku}`);
      console.log(`  trail: BRD=${outcome.trail.brd}(${outcome.trail.brand}) DEP=${outcome.trail.dep}(${outcome.trail.category}) TTL=${outcome.trail.ttl}`);
    } else {
      console.log(`  OUTCOME: ${outcome.reason}  ${outcome.details}`);
      if (outcome.reason === "legend_pending" && outcome.pending) {
        if (outcome.pending.brand) {
          console.log(`    brand pending: "${outcome.pending.brand.rawValue}" → proposed=${outcome.pending.brand.proposedCode} (${outcome.pending.brand.status})`);
        }
        if (outcome.pending.dept) {
          console.log(`    dept pending:  "${outcome.pending.dept.rawValue}" → proposed=${outcome.pending.dept.proposedCode} (${outcome.pending.dept.status})`);
        }
      }
    }

    const after = await query(
      `SELECT category, brand, title FROM asins WHERE asin = $1`,
      [before.asin],
    );
    const a = after.rows[0];
    console.log(`  AFTER:  category=${JSON.stringify(a.category)} brand=${JSON.stringify(a.brand)} title=${JSON.stringify((a.title ?? "").slice(0, 60))}`);
  }

  process.exit(0);
})().catch((err) => {
  console.error("Diag failed:", err.message);
  process.exit(1);
});
