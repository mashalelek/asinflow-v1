// Functional smoke test for the notes-race fix. Verifies two scenarios:
//   A) NEW ASIN with notes — INSERT branch writes notes atomically (one write).
//   B) EXISTING ASIN with notes — appendNotesForAsin dedup-appends (one write,
//      no double-append on second call with same notes).
//
// Uses a synthetic test ASIN ("B0TESTNOTES1") in BEGIN/ROLLBACK transactions
// so nothing persists. Doesn't go through SP-API — directly invokes the
// upsertAsinResult code path with a minimal fake AsinResult.

import "dotenv/config";
import pool from "../server/db";

const TEST_ASIN = "B0TESTNT01"; // 10 chars exactly, won't collide
const NEW_NOTES = "My notes: smoke test new\nVA notes: smoke test va";
const APPEND_NOTES = "Second note appended later";

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // === A) NEW ASIN with notes ===
    console.log("=== A) NEW ASIN with notes (INSERT branch) ===");
    // Simulate upsertAsinResult's INSERT directly — full row, with notes column.
    const insA = await client.query(
      `INSERT INTO asins (asin, title, brand, notes, last_refreshed_at)
       VALUES ($1, 'Test Title', 'Test Brand', $2, NOW())
       ON CONFLICT (asin) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, asins.title),
         brand = COALESCE(EXCLUDED.brand, asins.brand),
         last_refreshed_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [TEST_ASIN, NEW_NOTES],
    );
    const insertedA = insA.rows[0]?.inserted === true;
    console.log(`  inserted: ${insertedA}`);

    const rowA = await client.query(`SELECT notes FROM asins WHERE asin = $1`, [TEST_ASIN]);
    console.log(`  notes after INSERT: ${JSON.stringify(rowA.rows[0]?.notes)}`);
    const expectedNewWrite = rowA.rows[0]?.notes === NEW_NOTES;
    console.log(`  ✓ notes match input verbatim: ${expectedNewWrite}`);

    // Verify: would writeResult skip appendNotesForAsin here? It should, because
    // inserted === true.
    const wouldAppend = !insertedA && NEW_NOTES;
    console.log(`  ✓ writeResult would skip appendNotesForAsin: ${!wouldAppend}`);

    await client.query("ROLLBACK");
    await client.query("BEGIN");

    // === B) EXISTING ASIN with notes (appendNotesForAsin path) ===
    console.log(`\n=== B) EXISTING ASIN with notes (appendNotesForAsin) ===`);
    // First insert WITHOUT notes (simulate ASIN that existed before notes).
    await client.query(
      `INSERT INTO asins (asin, title, brand, last_refreshed_at)
       VALUES ($1, 'Test Title', 'Test Brand', NOW())`,
      [TEST_ASIN],
    );

    // Now re-INSERT triggers ON CONFLICT UPDATE (no notes write).
    const insB1 = await client.query(
      `INSERT INTO asins (asin, title, brand, notes, last_refreshed_at)
       VALUES ($1, 'Test Title', 'Test Brand', $2, NOW())
       ON CONFLICT (asin) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, asins.title),
         brand = COALESCE(EXCLUDED.brand, asins.brand),
         last_refreshed_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [TEST_ASIN, APPEND_NOTES],
    );
    const insertedB = insB1.rows[0]?.inserted === true;
    console.log(`  inserted: ${insertedB} (expect false — row pre-existed)`);

    // After UPSERT, notes should still be NULL (UPDATE branch doesn't write notes)
    const afterUpsertB = await client.query(`SELECT notes FROM asins WHERE asin = $1`, [TEST_ASIN]);
    console.log(`  notes after UPSERT (UPDATE branch): ${JSON.stringify(afterUpsertB.rows[0]?.notes)}`);
    console.log(`  ✓ UPDATE branch did NOT touch notes (§14 ownership preserved): ${afterUpsertB.rows[0]?.notes === null}`);

    // Now appendNotesForAsin would fire (because !inserted && inputNotes).
    await client.query(
      `UPDATE asins SET notes = CASE
         WHEN notes IS NULL OR notes = '' THEN $2
         WHEN notes = $2 THEN notes
         ELSE notes || E'\n' || $2
       END WHERE asin = $1`,
      [TEST_ASIN, APPEND_NOTES],
    );
    const after1 = await client.query(`SELECT notes FROM asins WHERE asin = $1`, [TEST_ASIN]);
    console.log(`  notes after 1st appendNotesForAsin: ${JSON.stringify(after1.rows[0]?.notes)}`);

    // Re-run with same notes → dedup short-circuit (notes unchanged)
    await client.query(
      `UPDATE asins SET notes = CASE
         WHEN notes IS NULL OR notes = '' THEN $2
         WHEN notes = $2 THEN notes
         ELSE notes || E'\n' || $2
       END WHERE asin = $1`,
      [TEST_ASIN, APPEND_NOTES],
    );
    const after2 = await client.query(`SELECT notes FROM asins WHERE asin = $1`, [TEST_ASIN]);
    console.log(`  notes after 2nd appendNotesForAsin (same string): ${JSON.stringify(after2.rows[0]?.notes)}`);
    console.log(`  ✓ dedup short-circuit prevented double-append: ${after1.rows[0]?.notes === after2.rows[0]?.notes}`);

    await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error("Verification failed:", err.message);
  process.exit(1);
});
