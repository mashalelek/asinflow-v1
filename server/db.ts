import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

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

export default pool;
