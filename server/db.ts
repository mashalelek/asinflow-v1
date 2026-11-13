import pg from "pg";
import { currentDbLane, type DbLane } from "./db-lane";

// Three pools over the one DATABASE_URL (2026-11-13, SPEC §24 "Database pools" — the 502s of 11/12–11/13):
//   web    — every request handler. statement_timeout 15 s: a slow query fails ITS request (57014 "canceling statement
//            due to statement timeout") instead of holding a connection until the pool is empty, /health hangs and
//            Render restarts the instance — what the per-line view queries did (migration 107).
//   job    — the scheduler's lanes: the runner wraps runJob in runInDbLane("job"), so a pass keeps its own, longer
//            limit (a sales-report load, a backfill chunk) and never competes with the web pool for a connection.
//   health — ONE connection of its own with a 2 s connect / statement / read limit: /health answers 503 within 2 s
//            when the database is down or the web pool is stuck behind slow queries; it never waits on either.
// `query` and the default export route by lane (server/db-lane.ts): the job pool inside the job lane, the web pool
// everywhere else. Migrations use createMigrationPool() — one connection, no statement limit, ended after boot.
export const WEB_STATEMENT_TIMEOUT_MS = 15_000;
export const JOB_STATEMENT_TIMEOUT_MS = 10 * 60_000;
export const HEALTH_TIMEOUT_MS = 2_000;
/** The job pool's size: the two lanes plus a component's own transaction or parallel reads. */
export const JOB_POOL_MAX = 6;

const connectionString = process.env.DATABASE_URL;

const webPool = new pg.Pool({ connectionString, statement_timeout: WEB_STATEMENT_TIMEOUT_MS, application_name: "asinflow-web" });
const jobPool = new pg.Pool({ connectionString, max: JOB_POOL_MAX, statement_timeout: JOB_STATEMENT_TIMEOUT_MS, application_name: "asinflow-jobs" });
const healthPool = new pg.Pool({
  connectionString, max: 1, application_name: "asinflow-health",
  connectionTimeoutMillis: HEALTH_TIMEOUT_MS, statement_timeout: HEALTH_TIMEOUT_MS, query_timeout: HEALTH_TIMEOUT_MS,
});
// An idle client's error (the server dropped it: restart, "service temporarily unavailable") is an 'error' event on the
// pool; with no listener node throws it and the process dies. Log it; the pool discards the client.
for (const [name, p] of [["web", webPool], ["jobs", jobPool], ["health", healthPool]] as const) {
  p.on("error", (err) => console.error(`[db] ${name} pool: idle client error: ${err?.message ?? err}`));
}

/** What the app passes around as "the pool": query and connect, routed by lane. */
export interface DbPool {
  query: (text: string, params?: any[]) => Promise<pg.QueryResult<any>>;
  connect: () => Promise<pg.PoolClient>;
  /** Scripts: close every pool so the process can exit. */
  end: () => Promise<void>;
}

/** The pg.Pool behind a lane (the current lane by default). */
export function poolForLane(lane: DbLane = currentDbLane()): pg.Pool {
  return lane === "job" ? jobPool : webPool;
}

// Convenience query helper used by sync modules (inventory-sync, sales-sync,
// suppression-sync, google-sheets sync, etc.) — the current lane's pool.
export function query(text: string, params?: any[]) {
  return poolForLane().query(text, params);
}

/** /health's read: its own single connection, ≤ 2 s to connect, run and read; throws otherwise. */
export async function healthCheck(): Promise<void> {
  await healthPool.query("SELECT 1");
}

/** The migration runner's pool: one connection, no statement limit (a migration runs to its end). `end()` it after boot. */
export function createMigrationPool(): pg.Pool {
  return new pg.Pool({ connectionString, max: 1, application_name: "asinflow-migrate" });
}

// Used by routes.ts to skip DB operations when the database isn't available.
// Always returns true here because we no longer support the DB-less mode.
export function isDbAvailable(): boolean {
  return !!process.env.DATABASE_URL;
}

export async function ensureUsersTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

export async function ensureSettingsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const defaults: Record<string, string> = {
    inbound_shipping_per_lb: "0.50",
    prep_cost: "1.00",
    additional_fees: "0",
    low_inventory_surcharge: "0.26",
    hazmat_shipping: "0",
    hazmat_prep: "0",
    min_roi: "15",
    min_margin: "10",
  };

  for (const [key, value] of Object.entries(defaults)) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
}

// Note: the `asins` and `asin_estimates` tables are managed by the migration
// runner (server/migrate.ts: database/schema_baseline_2026-10-15.sql plus
// database/migrations/) and already exist in production. We intentionally do
// NOT create them here,
// because their production schemas differ from any naive recreation
// (e.g. `asins.weight_lb` not `weight_oz`, `asin_estimates` uses `asin`
// varchar as FK, `buy_box_price`/`lowest_fba_price` instead of `sale_price`,
// cogs_source CHECK constraint, etc.). The extension only needs the
// `settings` table, which is created above.

export async function ensureExtensionTables() {
  await ensureSettingsTable();
}

/** The lane-routed pool: `connect()` for a transaction, `query()` for one statement — the job pool inside a job. */
const pool: DbPool = {
  query: (text, params) => poolForLane().query(text, params),
  connect: () => poolForLane().connect(),
  end: async () => { await Promise.all([webPool.end(), jobPool.end(), healthPool.end()]); },
};
export default pool;
