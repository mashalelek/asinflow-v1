// Script environment. Every script that can touch a database imports THIS
// first (before ../server/db, whose pool reads DATABASE_URL at import time):
//
//   import "./env";
//
// Without --prod: .env (dotenv.config()), exactly as `import "dotenv/config"` did. With --prod:
// .env.production.local is read as well and its DATABASE_URL_PROD becomes
// DATABASE_URL (every other key in it, e.g. ANTHROPIC_API_KEY, is applied
// too, overriding .env). The file is gitignored (.env*.local) and the dev
// server never reads it — server/env-prod.test.ts enforces that nothing
// under server/ names DATABASE_URL_PROD or the file (Maria, 2026-11-01:
// "the URL lives in .env.production.local, never in prompts").
//
// Render's external URL carries sslmode=require; pg verifies the server
// certificate against the system CAs. The URL's value is never printed.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

// .env first, by an explicit call (what `import "dotenv/config"` did in every
// script before 2026-11-01).
dotenv.config({ quiet: true });

export const PROD_FILE = ".env.production.local";
export const PROD = process.argv.includes("--prod");

if (PROD) {
  const file = path.resolve(process.cwd(), PROD_FILE);
  if (!fs.existsSync(file)) {
    console.error(`--prod: ${PROD_FILE} not found in ${process.cwd()}`);
    process.exit(1);
  }
  const parsed = dotenv.parse(fs.readFileSync(file));
  if (!parsed.DATABASE_URL_PROD) {
    console.error(`--prod: DATABASE_URL_PROD is not set in ${PROD_FILE}`);
    process.exit(1);
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (k === "DATABASE_URL_PROD" || k === "DATABASE_URL") continue;
    process.env[k] = v;
  }
  process.env.DATABASE_URL = parsed.DATABASE_URL_PROD;
  console.error(`[env] --prod: DATABASE_URL = DATABASE_URL_PROD from ${PROD_FILE} (PRODUCTION)`);
}

// For scripts that print where they ran: "production" / "local", never the URL.
export const DB_TARGET = PROD ? "production" : "local";
