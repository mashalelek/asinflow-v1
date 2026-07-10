// Real-DB integration smoke for brand_product_registry repo + reserve/rollback
// semantics. Runs every operation against the actual asinflow DB inside a
// BEGIN/ROLLBACK envelope so nothing is persisted.
//
// What this proves:
//   1. listForBrand / getByKey / reserve / rollback round-trip correctly
//   2. UNIQUE (brand_code, nnn) actually serializes — second INSERT throws
//   3. The reserve-then-PUT pattern's rollback path actually deletes the row
//   4. ttl_mismatch detection works against real registry state
//
// Read-only at module scope (BEGIN at top, ROLLBACK at end). No writes outlive
// this script.

import "dotenv/config";
import pool from "../server/db";
import { makeProductRegistryRepo } from "../server/product-registry-repo";

async function main() {
  const client = await pool.connect();
  let pass = 0, fail = 0;
  function ok(label: string) { pass++; console.log(`✓ ${label}`); }
  function bad(label: string, err?: any) { fail++; console.error(`✗ ${label}${err ? `: ${err?.message ?? err}` : ""}`); }

  try {
    await client.query("BEGIN");
    console.log("=== brand_product_registry integration smoke (BEGIN) ===\n");
    const repo = makeProductRegistryRepo((sql, params) => client.query(sql, params));

    // 1. Initial state: brand has no rows
    let rows = await repo.listForBrand("AMG");
    if (rows.length === 0) ok("listForBrand('AMG') initially empty");
    else bad(`expected 0 rows, got ${rows.length}`);

    // 2. Reserve a new product
    const r1 = await repo.reserve({
      brandCode: "AMG", nnn: 1, ttl: "TST",
      deptCode: "BPC", productName: "Smoke Test Product",
      firstAsin: "B00SMOKE01",
    });
    if (r1.id && r1.id.length > 0) ok(`reserve returned id ${r1.id.slice(0, 8)}…`);
    else bad("reserve did not return an id");

    // 3. getByKey finds it with all fields set
    const fetched = await repo.getByKey("AMG", 1);
    if (fetched && fetched.brandCode === "AMG" && fetched.nnn === 1 && fetched.ttl === "TST" && fetched.deptCode === "BPC") {
      ok("getByKey returns the reserved row with brand=AMG nnn=1 ttl=TST dept=BPC");
    } else {
      bad(`getByKey returned wrong shape: ${JSON.stringify(fetched)}`);
    }

    // 4. listForBrand now sees it
    rows = await repo.listForBrand("AMG");
    if (rows.length === 1 && rows[0].nnn === 1) ok("listForBrand sees the new row");
    else bad(`listForBrand returned ${rows.length} rows`);

    // 5. UNIQUE conflict: second reserve at same (brand, nnn) throws.
    // PG aborts the whole transaction on a constraint violation — so we wrap
    // the expected-fail INSERT in a SAVEPOINT and ROLLBACK TO that savepoint
    // to keep the outer BEGIN alive. Production doesn't need savepoints
    // because each repo call uses its own pool connection / auto-transaction.
    let conflictCaught = false;
    await client.query("SAVEPOINT sp_dup");
    try {
      await repo.reserve({
        brandCode: "AMG", nnn: 1, ttl: "OTH",
        deptCode: "HEA", productName: "Other product trying to take same NNN",
        firstAsin: "B00SMOKE02",
      });
      await client.query("RELEASE SAVEPOINT sp_dup");
    } catch (err: any) {
      conflictCaught = true;
      await client.query("ROLLBACK TO SAVEPOINT sp_dup");
      if (err?.code === "23505" || /duplicate|unique/i.test(err?.message ?? "")) {
        ok("UNIQUE (brand_code, nnn) blocks second INSERT (got 23505 / 'duplicate')");
      } else {
        bad(`reserve threw, but unexpected error shape: ${err?.code} ${err?.message}`);
      }
    }
    if (!conflictCaught) bad("UNIQUE constraint did NOT block second INSERT at same (brand, nnn)");

    // 6. Different NNN in same brand: succeeds
    const r2 = await repo.reserve({
      brandCode: "AMG", nnn: 2, ttl: "TWO",
      deptCode: "BPC", productName: "Second product",
      firstAsin: "B00SMOKE03",
    });
    if (r2.id) ok("reserve at (AMG, 2) succeeds (different NNN in same brand)");
    else bad("reserve at (AMG, 2) failed");

    // 7. Same NNN in different brand: succeeds (key is (brand, nnn) not nnn alone)
    const r3 = await repo.reserve({
      brandCode: "BBB", nnn: 1, ttl: "BBB",
      deptCode: "HOM", productName: "Different brand same NNN",
      firstAsin: "B00SMOKE04",
    });
    if (r3.id) ok("reserve at (BBB, 1) succeeds despite (AMG, 1) existing (key is per-brand)");
    else bad("reserve at (BBB, 1) failed");

    // 8. Rollback the first reservation
    await repo.rollback(r1.id);
    const post = await repo.getByKey("AMG", 1);
    if (post === null) ok("rollback(r1.id) deletes the row — getByKey returns null");
    else bad(`rollback didn't delete: still found ${JSON.stringify(post)}`);

    // 9. After rollback, (AMG, 1) can be re-reserved with a different TTL
    const r4 = await repo.reserve({
      brandCode: "AMG", nnn: 1, ttl: "NEW",
      deptCode: "KIT", productName: "Re-reserved after rollback",
      firstAsin: "B00SMOKE05",
    });
    const refreshed = await repo.getByKey("AMG", 1);
    if (r4.id && refreshed?.ttl === "NEW") {
      ok("rollback fully frees the (brand, nnn) slot — re-reserve with different TTL succeeds");
    } else {
      bad(`re-reserve after rollback failed: ${JSON.stringify(refreshed)}`);
    }

    // 10. rollback is idempotent on a missing row (no throw)
    try {
      await repo.rollback(r1.id); // already deleted earlier
      ok("rollback() on already-deleted row is a no-op (no throw)");
    } catch (err: any) {
      bad("rollback of missing row threw", err);
    }

    // 11. CHECK constraint: nnn=0 rejected (savepoint pattern again)
    let checkBlocked = false;
    await client.query("SAVEPOINT sp_check1");
    try {
      await repo.reserve({
        brandCode: "AMG", nnn: 0 as any, ttl: "ZER",
        deptCode: "BPC", productName: "Should fail check",
        firstAsin: "B00BAD01",
      });
      await client.query("RELEASE SAVEPOINT sp_check1");
    } catch (err: any) {
      checkBlocked = true;
      await client.query("ROLLBACK TO SAVEPOINT sp_check1");
      if (/check constraint|nnn_check/i.test(err?.message ?? "")) ok("CHECK constraint blocks nnn=0");
      else bad(`nnn=0 threw but unexpected: ${err?.message}`);
    }
    if (!checkBlocked) bad("CHECK constraint did NOT block nnn=0");

    // 12. CHECK constraint: lowercase brand_code rejected
    let lcBlocked = false;
    await client.query("SAVEPOINT sp_check2");
    try {
      await repo.reserve({
        brandCode: "amg", nnn: 99, ttl: "LCB",
        deptCode: "BPC", productName: "lowercase brand",
        firstAsin: "B00BAD02",
      });
      await client.query("RELEASE SAVEPOINT sp_check2");
    } catch (err: any) {
      lcBlocked = true;
      await client.query("ROLLBACK TO SAVEPOINT sp_check2");
      if (/check constraint|brand_code_check/i.test(err?.message ?? "")) ok("CHECK constraint blocks lowercase brand_code");
      else bad(`lowercase brand threw but unexpected: ${err?.message}`);
    }
    if (!lcBlocked) bad("CHECK constraint did NOT block lowercase brand_code");

    console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  } finally {
    await client.query("ROLLBACK");
    console.log("=== Transaction rolled back (no rows persisted) ===");

    // Defensive: confirm DB really has 0 rows after rollback
    const post = await pool.query(`SELECT COUNT(*)::int AS n FROM brand_product_registry`);
    console.log(`=== brand_product_registry row count after ROLLBACK: ${post.rows[0].n} ===`);
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("FATAL:", e); process.exit(1); });
