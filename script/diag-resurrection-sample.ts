// LIVE SP-API + LIVE DB verification of resurrection's 5 user-spec outcomes
// (gated, dead_asin, generate, legend_pending, reuse) plus a side-demo for
// duplicate_warning since we have no real current-format SKUs in SC yet
// (none ever created — that's 2D-4's first job).
//
// Real data is mostly used as-is. The "reuse" case requires a current-format
// SKU in asin_skus pointing to a non-existent SC listing — done by inserting
// a row inside BEGIN/ROLLBACK so the DB isn't mutated.
//
// No selfHealWrite passed → resurrection won't write back catalog data.

import "dotenv/config";
import pool, { query } from "../server/db";
import {
  resurrectOrGenerateSku,
  type ResurrectionOutcome,
} from "../server/sku-resurrection";
import { checkSkuListingStatus } from "../server/sku-listing-fetch";

const SELLER_ID = process.env.SP_API_SELLER_ID;
if (!SELLER_ID) {
  console.error("SP_API_SELLER_ID not set");
  process.exit(1);
}

function summarize(o: ResurrectionOutcome): string {
  switch (o.kind) {
    case "reuse":
      return `REUSE  sku=${o.sku}  lastCreatedAt=${o.lastCreatedAt.toISOString()}`;
    case "generate":
      return `GENERATE  sku=${o.sku}  brand=${o.trail.brand}→${o.trail.brd}  dept=${o.trail.category}→${o.trail.dep}  ttl=${o.trail.ttl}`;
    case "duplicate_warning":
      return `DUPLICATE_WARNING  existingSku=${o.existingSku}  statuses=${o.statuses.join(",")}`;
    case "dead_asin":
      return `DEAD_ASIN  ${o.details}`;
    case "legend_pending":
      return `LEGEND_PENDING  ${o.details}\n     brand=${JSON.stringify(o.pending.brand)}\n     dept=${JSON.stringify(o.pending.dept)}`;
    case "gated":
      return `GATED  eligibility=${o.eligibilityStatus}`;
    case "error":
      return `ERROR  reason=${o.reason}  ${o.details}`;
  }
}

async function runOne(label: string, asin: string, productNumber = 999) {
  console.log(`\n=== ${label} ===`);
  console.log(`ASIN: ${asin}`);
  const o = await resurrectOrGenerateSku(asin, productNumber, {
    queryFn: (sql, params) => query(sql, params),
    sellerId: SELLER_ID!,
  });
  console.log(`  → ${summarize(o)}`);
  return o;
}

(async () => {
  // 1. GATED — eligibility_status='no'
  await runOne("(1) gated — eligibility='no'", "B0CL3LLP7C");

  // 2. DEAD_ASIN — catalog 404
  // Natural-data caveat: the 79 catalog-dead ASINs in this DB are all
  // eligibility!='yes' (a dead product usually fails Amazon's eligibility
  // check too), so the gated branch shadows the dead_asin branch on real
  // data. Stage eligibility='yes' for a known dead ASIN to exercise the
  // dead_asin branch specifically. Wrapped in BEGIN/ROLLBACK — no DB mutation.
  {
    console.log(`\n=== (2) dead_asin — catalog 404 (staged eligibility='yes' + ROLLBACK) ===`);
    const client2 = await pool.connect();
    try {
      await client2.query("BEGIN");
      // Ensure asin_estimates row exists with eligibility='yes' for B07KRKVSML
      await client2.query(
        `INSERT INTO asin_estimates (asin, eligibility_status, fetched_at)
         VALUES ($1, 'yes', NOW())
         ON CONFLICT (asin) DO UPDATE SET eligibility_status = 'yes'`,
        ["B07KRKVSML"],
      );
      console.log(`ASIN: B07KRKVSML  (staged eligibility='yes' so we reach the catalog fetch)`);
      const o = await resurrectOrGenerateSku("B07KRKVSML", 1, {
        queryFn: (sql, params) => client2.query(sql, params),
        sellerId: SELLER_ID!,
      });
      console.log(`  → ${summarize(o)}`);
    } finally {
      await client2.query("ROLLBACK").catch(() => {});
      client2.release();
    }
  }

  // 3. GENERATE — AminoGenesis ASIN, both brand+dept in legend
  await runOne("(3) generate — AminoGenesis (brand+dept in legend)", "B00CA6Z37C", 1);

  // 4. LEGEND_PENDING — brand not in legend yet
  await runOne("(4) legend_pending — Arlington brand (not in legend)", "B01K2VB5RI", 1);

  // 5. REUSE — stage a current-format SKU for an ASIN; the SKU doesn't
  //     exist in SC so the listing check 404s → reuse outcome.
  console.log(`\n=== (5) reuse — current-format SKU absent from SC (staged + ROLLBACK) ===`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const asinRow = await client.query(`SELECT id FROM asins WHERE asin = $1`, ["B00CA6Z37C"]);
    const asinId = asinRow.rows[0]?.id;
    if (!asinId) throw new Error("B00CA6Z37C not found in asins");
    const stagedSku = "AMG-BPC-Z7C-RRC-001"; // matches current-format regex; never created in SC
    await client.query(
      `INSERT INTO asin_skus (asin_id, sku, is_primary) VALUES ($1, $2, false)`,
      [asinId, stagedSku],
    );
    console.log(`ASIN: B00CA6Z37C   staged sku: ${stagedSku} (will not exist in SC → expect 404)`);
    const o = await resurrectOrGenerateSku("B00CA6Z37C", 1, {
      queryFn: (sql, params) => client.query(sql, params), // route via the same txn'd client
      sellerId: SELLER_ID!,
    });
    console.log(`  → ${summarize(o)}`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }

  // 6. DUPLICATE_WARNING — side-demo
  // No current-format SKUs exist in SC today (none ever created), so the
  // resurrection module's full path can't be exercised on real data. Show
  // checkSkuListingStatus directly against a real alive legacy AMG SKU to
  // prove the present-branch returns the expected shape. Once 2D-4 creates
  // the first real current-format listing, the next resurrection on that
  // ASIN will naturally route here.
  console.log(`\n=== (6) duplicate_warning — side-demo via checkSkuListingStatus ===`);
  const aliveAmgSku = "AMG-BP-NCK-NEK-006"; // legacy format, alive in SC per earlier scan
  console.log(`Real alive SC SKU (legacy format, won't pass matchesCurrentSkuFormat): ${aliveAmgSku}`);
  const liveCheck = await checkSkuListingStatus(SELLER_ID!, aliveAmgSku);
  console.log(`  checkSkuListingStatus → ${JSON.stringify(liveCheck)}`);
  if (liveCheck.ok && liveCheck.present) {
    console.log(
      `  Interpretation: if a current-format SKU returned this shape, resurrection routes →`,
      `\n     { kind: "duplicate_warning", existingSku: "${aliveAmgSku}", statuses: ${JSON.stringify(liveCheck.statuses)} }`,
    );
  }
  console.log(`  NOTE: full duplicate_warning path will be naturally exercisable after 2D-4`);
  console.log(`        creates the first real current-format SKU in SC.`);

  await pool.end();
  process.exit(0);
})().catch(async (err) => {
  console.error("Diag failed:", err.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
