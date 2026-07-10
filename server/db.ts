import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Convenience query helper used by sync modules (inventory-sync, sales-sync,
// suppression-sync, google-sheets sync, etc.)
export function query(text: string, params?: any[]) {
  return pool.query(text, params);
}

// Used by routes.ts to skip DB operations when the database isn't available.
// Always returns true here because we no longer support the DB-less mode.
export function isDbAvailable(): boolean {
  return !!process.env.DATABASE_URL;
}

/**
 * Run `fn` inside a single pooled client + BEGIN/COMMIT, rolling back on any
 * thrown error. Needed for multi-statement mutations (e.g. PO create → line
 * items → po_asins → po_gift_cards) where the default `query()` would grab a
 * fresh client per call and break transactional guarantees.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function ensureUsersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

export async function ensureSettingsTable() {
  await pool.query(`
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
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
}

// Note: the `asins` and `asin_estimates` tables are managed by the main
// AsinFlow database migrations (see database/asinflow_schema_v1.1.sql) and
// already exist in production. We intentionally do NOT create them here,
// because their production schemas differ from any naive recreation
// (e.g. `asins.weight_lb` not `weight_oz`, `asin_estimates` uses `asin`
// varchar as FK, `buy_box_price`/`lowest_fba_price` instead of `sale_price`,
// cogs_source CHECK constraint, etc.). The extension only needs the
// `settings` table, which is created above.

export async function ensureExtensionTables() {
  await ensureSettingsTable();
}

export default pool;
