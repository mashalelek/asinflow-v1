import bcrypt from "bcrypt";
import pool, { ensureUsersTable } from "./db";

async function createUser() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error("Usage: npx tsx server/create-user.ts <email> <password>");
    process.exit(1);
  }

  await ensureUsersTable();

  const hash = await bcrypt.hash(password, 10);

  const normalized = email.trim().toLowerCase();

  const result = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, email, (xmax = 0) AS inserted`,
    [normalized, hash]
  );

  const row = result.rows[0];
  if (row.inserted) {
    console.log(`User created: ${row.email} (id=${row.id})`);
  } else {
    console.log(`Password updated for existing user: ${row.email} (id=${row.id})`);
  }

  await pool.end();
}

createUser().catch((err) => {
  console.error("Failed to create user:", err.message);
  process.exit(1);
});
