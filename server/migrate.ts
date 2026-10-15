// Migration runner (SPEC §24 "Migrations"; patch
// docs/claude_spec-patch-migration-runner.md, 2026-10-15).
//
// RULE: on startup, before anything else touches the database, apply every
// unapplied file in database/migrations/ in numeric order, each in its own
// transaction, and record it. Nothing is ever applied twice. Nothing serves
// until the ledger matches the files on disk.
//
// Ledger: schema_migrations(version, filename, applied_at, checksum). Created
// here if absent — the runner must exist before any ledger does.
//
// First run on a database that pre-dates the runner (the ledger is empty and
// `asins` exists): record the baseline as version 0 and every file numbered
// <= LAST_MANUAL_MIGRATION as applied, without executing any of them. They
// were applied by hand; the baseline file captures their result.
//
// First run on an EMPTY database (no `asins`): execute the baseline file,
// record it as version 0, record files <= LAST_MANUAL_MIGRATION as applied
// (the baseline already contains them), then apply the rest normally. This
// is Jason's one-command setup. Decision B (2026-10-15): the old
// asinflow_schema_v1.1.sql + 001..050 did NOT rebuild the live schema, so a
// true baseline was cut instead — see the baseline file's header.
//
// Fail closed: any failure throws MigrationError after ROLLBACK; the caller
// (index.ts) logs it and exits before the server listens.
//
// NEVER import ./index here: script/migrate.ts loads this module and must not
// boot the server. The logger is injected (same pattern as auth.ts).
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type pg from "pg";

/** Last migration applied by hand before the runner existed (2026-10-15). */
export const LAST_MANUAL_MIGRATION = 50;
/** Ledger version recorded for the baseline file. */
export const BASELINE_VERSION = 0;
export const BASELINE_FILE = "schema_baseline_2026-10-15.sql";
export const ADVISORY_LOCK_KEY = 7342001;
export const MIGRATIONS_DIR = path.resolve(process.cwd(), "database", "migrations");
export const BASELINE_PATH = path.resolve(process.cwd(), "database", BASELINE_FILE);

type Logger = (message: string, source?: string) => void;
let migrateLog: Logger = (message, source = "migrate") => console.log(`[${source}] ${message}`);
export function setMigrateLogger(fn: Logger): void { migrateLog = fn; }
const log = (m: string) => migrateLog(m, "migrate");

export interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
  checksum: string;
  /** First-line opt-out `-- migrate: no-transaction` (e.g. CREATE INDEX CONCURRENTLY). */
  noTransaction: boolean;
  /** The file contains its own BEGIN/COMMIT/START TRANSACTION. */
  managesTransaction: boolean;
}

export class MigrationError extends Error {
  constructor(public filename: string, message: string, public cause?: unknown) {
    super(`migration ${filename} failed: ${message}`);
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const FILE_RE = /^(\d{3})_.*\.sql$/;
const OWN_TX_RE = /^\s*(BEGIN|COMMIT|START TRANSACTION)\s*;/im;

export function parseMigrationFile(filename: string, sql: string): MigrationFile {
  const m = FILE_RE.exec(filename);
  if (!m) throw new Error(`not a migration file name: ${filename}`);
  const firstLine = sql.split("\n", 1)[0] ?? "";
  return {
    version: Number(m[1]),
    filename,
    sql,
    checksum: sha256(sql),
    noTransaction: /^--\s*migrate:\s*no-transaction\b/i.test(firstLine.trim()),
    managesTransaction: OWN_TX_RE.test(sql),
  };
}

/** Files matching NNN_*.sql, sorted by prefix. Duplicate prefixes refuse. */
export function discoverMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort();
  const files = names.map((n) => parseMigrationFile(n, fs.readFileSync(path.join(dir, n), "utf8")));
  files.sort((a, b) => a.version - b.version || a.filename.localeCompare(b.filename));
  const seen = new Map<number, string>();
  for (const f of files) {
    const prev = seen.get(f.version);
    if (prev) throw new Error(`duplicate migration prefix ${String(f.version).padStart(3, "0")}: ${prev} and ${f.filename}`);
    seen.set(f.version, f.filename);
  }
  return files;
}

type ClientLike = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };
type PoolLike = { connect: () => Promise<ClientLike> };

export interface LedgerRow { version: number; filename: string; applied_at: string | Date; checksum: string }

export interface RunSummary {
  /** Ledger rows after the run (baseline row included). */
  applied: number;
  pending: number;
  /** Rows inserted by seeding (existing database) or baseline bookkeeping (fresh). */
  seeded: number;
  /** Files executed by this run, in order. */
  appliedNow: string[];
  freshDatabase: boolean;
  checksumMismatches: string[];
}

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    filename    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT NOT NULL
  )`;

async function readLedger(c: ClientLike): Promise<LedgerRow[]> {
  return (await c.query(`SELECT version, filename, applied_at, checksum FROM schema_migrations ORDER BY version`)).rows;
}

export async function runMigrations(
  pool: PoolLike,
  opts: { dir?: string; baselinePath?: string; now?: () => number } = {},
): Promise<RunSummary> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const baselinePath = opts.baselinePath ?? BASELINE_PATH;
  const now = opts.now ?? Date.now;
  const files = discoverMigrations(dir); // throws on duplicates before touching the DB

  const c = await pool.connect();
  try {
    // Two instances starting at once (zero-downtime deploys overlap) must
    // not race: the lock is session-scoped, so it lives on this client.
    await c.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY]);
    try {
      await c.query(CREATE_LEDGER);
      let ledger = await readLedger(c);
      let seeded = 0;
      let freshDatabase = false;

      if (ledger.length === 0) {
        const hasAsins = (await c.query(`SELECT to_regclass('public.asins') IS NOT NULL AS present`)).rows[0]?.present === true;
        const baselineSql = fs.readFileSync(baselinePath, "utf8");
        const seedRows: Array<{ version: number; filename: string; checksum: string }> = [
          { version: BASELINE_VERSION, filename: path.basename(baselinePath), checksum: sha256(baselineSql) },
          ...files.filter((f) => f.version <= LAST_MANUAL_MIGRATION).map((f) => ({ version: f.version, filename: f.filename, checksum: f.checksum })),
        ];
        if (hasAsins) {
          log(`ledger empty on an existing database: seeding ${seedRows.length} rows (baseline + files <= ${String(LAST_MANUAL_MIGRATION).padStart(3, "0")}, applied by hand before the runner)`);
          await c.query("BEGIN");
          try {
            for (const r of seedRows) {
              await c.query(`INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)`, [r.version, r.filename, r.checksum]);
            }
            await c.query("COMMIT");
          } catch (err) { await c.query("ROLLBACK"); throw err; }
        } else {
          freshDatabase = true;
          log(`ledger empty on an EMPTY database: applying baseline ${path.basename(baselinePath)}`);
          const t0 = now();
          await c.query("BEGIN");
          try {
            await c.query(baselineSql);
            for (const r of seedRows) {
              await c.query(`INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)`, [r.version, r.filename, r.checksum]);
            }
            await c.query("COMMIT");
          } catch (err: any) {
            await c.query("ROLLBACK");
            throw new MigrationError(path.basename(baselinePath), err?.message ?? String(err), err);
          }
          log(`baseline applied in ${now() - t0} ms; ${seedRows.length - 1} files <= ${String(LAST_MANUAL_MIGRATION).padStart(3, "0")} recorded as contained in it`);
        }
        seeded = seedRows.length;
        ledger = await readLedger(c);
      }

      // Checksum drift is informational: files get comment edits.
      const byVersion = new Map(ledger.map((r) => [Number(r.version), r]));
      const checksumMismatches: string[] = [];
      for (const f of files) {
        const row = byVersion.get(f.version);
        if (row && row.checksum !== f.checksum) {
          checksumMismatches.push(f.filename);
          log(`WARNING: ${f.filename} changed on disk since it was applied (checksum mismatch; not re-run)`);
        }
      }

      const pending = files.filter((f) => !byVersion.has(f.version));
      log(`ledger: ${ledger.length} applied, ${pending.length} pending`);
      const appliedNow: string[] = [];
      for (const f of pending) {
        if (f.managesTransaction && !f.noTransaction) {
          throw new MigrationError(f.filename, "contains its own BEGIN/COMMIT; the runner wraps each file in a transaction — remove them, or opt out with a first line `-- migrate: no-transaction`");
        }
        const t0 = now();
        const record = () => c.query(`INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)`, [f.version, f.filename, f.checksum]);
        if (f.noTransaction) {
          try {
            await c.query(f.sql);
            await record();
          } catch (err: any) {
            throw new MigrationError(f.filename, err?.message ?? String(err), err);
          }
        } else {
          await c.query("BEGIN");
          try {
            await c.query(f.sql);
            await record();
            await c.query("COMMIT");
          } catch (err: any) {
            await c.query("ROLLBACK");
            throw new MigrationError(f.filename, err?.message ?? String(err), err);
          }
        }
        appliedNow.push(f.filename);
        log(`${f.filename} applied in ${now() - t0} ms`);
      }
      if (pending.length === 0) log("schema current");

      return {
        applied: ledger.length + appliedNow.length,
        pending: 0,
        seeded,
        appliedNow,
        freshDatabase,
        checksumMismatches,
      };
    } finally {
      await c.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]).catch(() => {});
      // The baseline (a pg_dump) and any migration may SET session
      // parameters; this client goes back to the pool, so clear them.
      await c.query(`RESET ALL`).catch(() => {});
    }
  } finally {
    c.release();
  }
}

export interface StatusReport {
  ledgerExists: boolean;
  applied: Array<{ version: number; filename: string; appliedAt: string; onDisk: boolean }>;
  pending: string[];
  checksumMismatches: string[];
}

/** Read-only: ledger vs disk. Never creates the ledger, never locks. */
export async function migrationStatus(
  pool: PoolLike,
  opts: { dir?: string; baselinePath?: string } = {},
): Promise<StatusReport> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const files = discoverMigrations(dir);
  const c = await pool.connect();
  try {
    const exists = (await c.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`)).rows[0]?.present === true;
    if (!exists) {
      return { ledgerExists: false, applied: [], pending: files.map((f) => f.filename), checksumMismatches: [] };
    }
    const ledger = await readLedger(c);
    const byVersion = new Map(files.map((f) => [f.version, f]));
    const applied = ledger.map((r) => ({
      version: Number(r.version),
      filename: r.filename,
      appliedAt: new Date(r.applied_at).toISOString(),
      onDisk: Number(r.version) === BASELINE_VERSION ? fs.existsSync(opts.baselinePath ?? BASELINE_PATH) : byVersion.has(Number(r.version)),
    }));
    const appliedVersions = new Set(applied.map((a) => a.version));
    const pending = files.filter((f) => !appliedVersions.has(f.version)).map((f) => f.filename);
    const checksumMismatches = ledger
      .filter((r) => { const f = byVersion.get(Number(r.version)); return f != null && f.checksum !== r.checksum; })
      .map((r) => r.filename);
    return { ledgerExists: true, applied, pending, checksumMismatches };
  } finally {
    c.release();
  }
}
