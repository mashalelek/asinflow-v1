import bcrypt from "bcrypt";
import pool from "./db";

const SALT_ROUNDS = 10;

export interface AuthUser {
  id: number;
  email: string;
  created_at: Date;
}

export async function registerUser(
  email: string,
  password: string
): Promise<AuthUser> {
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await pool.query(
    "SELECT id FROM users WHERE email = $1",
    [normalizedEmail]
  );
  if (existing.rows.length > 0) {
    throw new Error("An account with this email already exists");
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
    [normalizedEmail, passwordHash]
  );

  return result.rows[0];
}

export async function validateUser(
  email: string,
  password: string
): Promise<AuthUser | null> {
  const normalizedEmail = email.toLowerCase().trim();

  const result = await pool.query(
    "SELECT id, email, password_hash, created_at FROM users WHERE email = $1",
    [normalizedEmail]
  );

  if (result.rows.length === 0) return null;

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;

  return { id: user.id, email: user.email, created_at: user.created_at };
}
