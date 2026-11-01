// One-time bootstrap: create the FIRST admin account (SPEC §25, decision 3).
//
//   tsx script/create-admin.ts --email you@example.com --name "Your Name" --password '…'
//
// Any flag left out is prompted for (the password prompt does not echo).
// Refuses to run when any user already exists — further accounts are created
// in Settings → Users, never by script. No default password anywhere.
//
// Runs against DATABASE_URL from the environment / .env, locally first; on
// Render via the service's Shell tab only if the restored database somehow
// lacks the local admin row (the pg_dump/pg_restore in SPEC §24 carries it).
import "./env";
import readline from "readline";
import pool from "../server/db";
import { createFirstAdmin } from "../server/auth";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      // Mute the echo while the password is typed.
      const out = rl as any;
      out._writeToOutput = (s: string) => { if (s.includes("\n")) process.stdout.write("\n"); };
      process.stdout.write(question);
    }
    rl.question(hidden ? "" : question, (answer) => { rl.close(); resolve(answer); });
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const email = flag("email") ?? (await ask("Email: "));
  const displayName = flag("name") ?? (await ask("Display name: "));
  const password = flag("password") ?? (await ask("Password (not echoed): ", true));

  try {
    const user = await createFirstAdmin({ email, displayName, password });
    console.log(`Admin created: ${user.email} (${user.displayName}, id=${user.id})`);
  } catch (err: any) {
    console.error(`create-admin: ${err?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
