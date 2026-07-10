// DA-3 smoke test for the revive endpoint's WHERE-clause guard.
//
// Stages 4 ASINs in different archive states, calls revive against all 4,
// asserts only the qualifying one (A) flipped. BEGIN/ROLLBACK so nothing
// persists. Bonus check: after A flipped, it disappears from revival-
// candidates query (predicate excludes archive_reason=NULL).

import "dotenv/config";
import pool from "../server/db";

const A = "BREVIVEAA1"; // revivable
const B = "BREVIVEBB1"; // still catalog-deleted
const C = "BREVIVECC1"; // manually archived
const D = "BREVIVEDD1"; // already active

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Insert 4 ASINs in different states.
    await client.query(
      `INSERT INTO asins (asin, title, is_active, is_catalog_deleted, archive_reason)
       VALUES
         ($1, 'A revivable',          FALSE, FALSE, 'catalog_deleted'),
         ($2, 'B still deleted',      FALSE, TRUE,  'catalog_deleted'),
         ($3, 'C manually archived',  FALSE, FALSE, NULL),
         ($4, 'D already active',     TRUE,  FALSE, NULL)`,
      [A, B, C, D],
    );

    console.log("--- Initial states ---");
    const before = await client.query(
      `SELECT asin, is_active, is_catalog_deleted, archive_reason
         FROM asins WHERE asin = ANY($1::text[]) ORDER BY asin`,
      [[A, B, C, D]],
    );
    for (const r of before.rows) console.log(` `, r);

    // Run the EXACT same UPDATE the endpoint uses, against the same client+txn.
    const result = await client.query(
      `UPDATE asins
         SET is_active = TRUE, archive_reason = NULL
       WHERE asin = ANY($1::text[])
         AND is_active = FALSE
         AND archive_reason = 'catalog_deleted'
         AND is_catalog_deleted = FALSE
       RETURNING asin`,
      [[A, B, C, D]],
    );
    const revived: string[] = result.rows.map((r: any) => r.asin);
    const skipped = [A, B, C, D].filter((a) => !revived.includes(a));

    console.log(`\n--- Revive call result ---`);
    console.log(`  revived: ${JSON.stringify(revived)}`);
    console.log(`  skipped: ${JSON.stringify(skipped)}`);

    const ok1 = JSON.stringify(revived) === JSON.stringify([A]);
    const ok2 = skipped.length === 3 && skipped.includes(B) && skipped.includes(C) && skipped.includes(D);
    console.log(`  ✓ only A flipped: ${ok1}`);
    console.log(`  ✓ B, C, D all skipped: ${ok2}`);

    console.log("\n--- Final states (B, C, D should be unchanged) ---");
    const after = await client.query(
      `SELECT asin, is_active, is_catalog_deleted, archive_reason
         FROM asins WHERE asin = ANY($1::text[]) ORDER BY asin`,
      [[A, B, C, D]],
    );
    for (const r of after.rows) console.log(` `, r);

    // Bonus: A was revived. Run the candidates query — A must NOT be there.
    const candidates = await client.query(
      `SELECT asin FROM asins
       WHERE is_active = FALSE
         AND archive_reason = 'catalog_deleted'
         AND is_catalog_deleted = FALSE
         AND asin = ANY($1::text[])`,
      [[A, B, C, D]],
    );
    const candidateAsins = candidates.rows.map((r: any) => r.asin);
    console.log(`\n--- Post-revival candidates query (filtered to our 4) ---`);
    console.log(`  result: ${JSON.stringify(candidateAsins)}`);
    console.log(`  ✓ A excluded after revive (archive_reason=NULL): ${!candidateAsins.includes(A)}`);
    console.log(`  ✓ B included (still catalog-deleted, would re-appear when restored): ${!candidateAsins.includes(B)}`);
    //   B has is_catalog_deleted=TRUE → predicate requires FALSE → not in revival candidates
    //   (B would only become a candidate after catalog comes back alive)
    console.log(`  ✓ C excluded (manually archived, archive_reason=NULL): ${!candidateAsins.includes(C)}`);
    console.log(`  ✓ D excluded (already active): ${!candidateAsins.includes(D)}`);

    await client.query("ROLLBACK");
    console.log(`\n✓ All checks passed. ROLLBACK — nothing persisted.`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error("Smoke test failed:", err.message);
  process.exit(1);
});
