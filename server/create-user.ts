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

  const result = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email`,
    [email.trim().toLowerCase(), hash]
  );

  if (result.rows.length > 0) {
    console.log(`User created: ${result.rows[0].email} (id=${result.rows[0].id})`);
  } else {
    console.log(`User already exists: ${email}`);
  }

  await pool.end();
}

createUser().catch((err) => {
  console.error("Failed to create user:", err.message);
  process.exit(1);
});
