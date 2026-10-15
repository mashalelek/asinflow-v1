// Migration CLI (SPEC §24 "Migrations").
//
//   npm run migrate          apply every pending migration and exit
//   npm run migrate:status   ledger vs disk, read-only
//
// Runs against DATABASE_URL from the environment / .env. The server runs the
// same runner on every startup; this exists for Render's Shell tab and for a
// first local setup without starting the server.
import "dotenv/config";
import pool from "../server/db";
import { runMigrations, migrationStatus, MigrationError } from "../server/migrate";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const statusOnly = process.argv.includes("--status");
  try {
    if (statusOnly) {
      const s = await migrationStatus(pool);
      if (!s.ledgerExists) {
        console.log("ledger: schema_migrations does not exist yet (never run) — every file is pending");
      }
      console.log(`applied: ${s.applied.length}`);
      for (const a of s.applied) {
        console.log(`  ${String(a.version).padStart(3, "0")}  ${a.filename.padEnd(48)} ${a.appliedAt}${a.onDisk ? "" : "   (file missing on disk)"}`);
      }
      console.log(`pending: ${s.pending.length}`);
      for (const p of s.pending) console.log(`  ${p}`);
      if (s.checksumMismatches.length > 0) {
        console.log(`checksum mismatches (file changed after apply; informational): ${s.checksumMismatches.length}`);
        for (const m of s.checksumMismatches) console.log(`  ${m}`);
      }
      process.exitCode = s.pending.length === 0 ? 0 : 2;
    } else {
      const r = await runMigrations(pool);
      console.log(`done: ${r.applied} applied, ${r.pending} pending${r.freshDatabase ? " (fresh database: baseline applied)" : ""}${r.seeded ? `, ${r.seeded} seeded` : ""}${r.appliedNow.length ? `, applied now: ${r.appliedNow.join(", ")}` : ""}`);
    }
  } catch (err: any) {
    if (err instanceof MigrationError) console.error(err.message);
    else console.error(`migrate: ${err?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
