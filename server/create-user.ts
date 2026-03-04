import bcrypt from "bcrypt";
import pool, { ensureUsersTable } from "./db";

async function createUser() {
  const email = "erodriguez@coastalqualitygoods.com";
  const password = "Hj459$@Lsp98";

  await ensureUsersTable();

  const hash = await bcrypt.hash(password, 10);

  const result = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email`,
    [email, hash]
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
