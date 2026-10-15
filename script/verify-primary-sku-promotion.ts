// Verification for the primary-SKU promotion fix (offer-add.ts + inventory-sync.ts).
//
// A. Simulate the fixed Add-Offer success path: run the atomic promotion CTE
//    for B07RCWCX43 / GOL-PET-X43-JRD-001 (verbatim from offer-add.ts).
// B. Simulate an inventory-sync pass over the same ASIN, executing the IDENTICAL
//    guarded SQL from inventory-sync.ts — with the OLD SKU handed fulfillable=50
//    and the NEW SKU fulfillable=0, so the old fulfillable-count heuristic WOULD
//    revert primary to Q0-9U0J-HDNP. Proves the hasPrimary guard prevents it.
//
// Run: npx tsx script/verify-primary-sku-promotion.ts
import "dotenv/config";
import { query } from "../server/db";

const ASIN = "B07RCWCX43";
const NEW_SKU = "GOL-PET-X43-JRD-001";
const OLD_SKU = "Q0-9U0J-HDNP";

async function dump(label: string) {
  const a = await query(`SELECT primary_sku FROM asins WHERE asin = $1`, [ASIN]);
  const s = await query(
    `SELECT s.sku, s.is_primary, s.created_at FROM asin_skus s
     JOIN asins a ON a.id = s.asin_id WHERE a.asin = $1
     ORDER BY s.is_primary DESC, s.created_at`,
    [ASIN],
  );
  console.log(`\n=== ${label} ===`);
  console.log(`asins.primary_sku = ${a.rows[0]?.primary_sku}`);
  for (const r of s.rows) {
    console.log(`  ${r.sku.padEnd(22)} is_primary=${r.is_primary}  created_at=${r.created_at.toISOString?.() ?? r.created_at}`);
  }
}

async function main() {
  await dump("BEFORE (pre-fix state)");

  // ---- A. Fixed Add-Offer promotion (atomic CTE, verbatim from offer-add.ts) ----
  await query(
    `WITH tgt AS (
       SELECT id FROM asins WHERE asin = $1
     ),
     promote AS (
       INSERT INTO asin_skus (asin_id, sku, is_primary)
       SELECT id, $2, true FROM tgt
       ON CONFLICT (asin_id, sku) DO UPDATE SET is_primary = true
     ),
     demote AS (
       UPDATE asin_skus SET is_primary = false
       WHERE asin_id = (SELECT id FROM tgt) AND sku <> $2
     )
     UPDATE asins SET primary_sku = $2 WHERE asin = $1`,
    [ASIN, NEW_SKU],
  );
  await dump("AFTER PROMOTION (simulated Add-to-SC with the fix)");

  // ---- B. Simulated inventory-sync pass (identical guarded SQL) ----
  // Synthetic agg: old SKU wins the heuristic (fulfillable 50 vs 0).
  const idRow = await query(`SELECT id FROM asins WHERE asin = $1`, [ASIN]);
  const asinId = idRow.rows[0].id;
  const skuData = [
    { sku: OLD_SKU, fulfillable: 50, seenOrder: 0 },
    { sku: NEW_SKU, fulfillable: 0, seenOrder: 1 },
  ];
  const isAmznGr = (sku: string) => sku.toLowerCase().startsWith("amzn.gr.");
  const realSkus = skuData.filter((s) => !isAmznGr(s.sku));
  const sorted = (realSkus.length > 0 ? realSkus : skuData)
    .sort((a, b) => b.fulfillable - a.fulfillable || b.seenOrder - a.seenOrder);
  const primarySku = sorted[0]?.sku ?? null;
  console.log(`\n=== INVENTORY-SYNC PASS ===`);
  console.log(`fulfillable-count heuristic would pick: ${primarySku} (old behavior => REVERT to ${OLD_SKU})`);

  const primaryCheck = await query(
    `SELECT (a.primary_sku IS NOT NULL
             OR EXISTS (SELECT 1 FROM asin_skus s WHERE s.asin_id = a.id AND s.is_primary = TRUE)) AS has_primary
     FROM asins a WHERE a.id = $1`,
    [asinId],
  );
  const hasPrimary = primaryCheck.rows[0]?.has_primary === true;
  console.log(`hasPrimary = ${hasPrimary}  => path taken: ${hasPrimary ? "hasPrimary=TRUE (bootstrap SKIPPED, no recompute/demote)" : "BOOTSTRAP (heuristic sets primary)"}`);

  // Mirrors inventory-sync.ts after migration 052 (in_catalog retired):
  // primary_sku only on bootstrap, nothing else written to asins here.
  if (!hasPrimary && primarySku) {
    await query(`UPDATE asins SET primary_sku = $2 WHERE id = $1`, [asinId, primarySku]);
  }
  for (const sd of skuData) {
    if (hasPrimary) {
      await query(
        `INSERT INTO asin_skus (asin_id, sku, is_primary) VALUES ($1, $2, FALSE)
         ON CONFLICT (asin_id, sku) DO NOTHING`,
        [asinId, sd.sku],
      );
    } else {
      const isPrimary = sd.sku === primarySku && !isAmznGr(sd.sku);
      await query(
        `INSERT INTO asin_skus (asin_id, sku, is_primary) VALUES ($1, $2, $3)
         ON CONFLICT (asin_id, sku) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
        [asinId, sd.sku, isPrimary],
      );
    }
  }

  await dump("AFTER INVENTORY-SYNC PASS (must still be GOL-PET-X43-JRD-001)");

  // ---- Assertions ----
  const final = await query(
    `SELECT a.primary_sku,
            (SELECT sku FROM asin_skus s WHERE s.asin_id = a.id AND s.is_primary = TRUE) AS primary_flag_sku,
            (SELECT COUNT(*) FROM asin_skus s WHERE s.asin_id = a.id AND s.is_primary = TRUE) AS primary_count
     FROM asins a WHERE a.asin = $1`,
    [ASIN],
  );
  const { primary_sku, primary_flag_sku, primary_count } = final.rows[0];
  const pass =
    primary_sku === NEW_SKU &&
    primary_flag_sku === NEW_SKU &&
    Number(primary_count) === 1;
  console.log(`\n=== RESULT ===`);
  console.log(`primary_sku=${primary_sku}  is_primary flag on=${primary_flag_sku}  primary_count=${primary_count}`);
  console.log(pass ? "PASS: fields agree, GOL is primary, no revert." : "FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
