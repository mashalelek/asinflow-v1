// Inventory Ledger backfill (listing hygiene, SPEC §11 component 23, 2026-10-19).
//
//   npm run backfill:ledger                         # 18 months back → yesterday
//   npm run backfill:ledger -- --from 2025-04-19 --to 2026-10-18
//
// Enqueues ONE manual job running component 23 alone over
// params.ledger_window, exactly what POST /api/jobs/backfill-ledger does for
// an admin session; talks to the database directly (DATABASE_URL from .env).
// The running server's runner executes it in 92-day chunks spaced for the
// report quota (~6 chunks, ~30 min); follow it in the jobs dialog.
import "dotenv/config";
import pool from "../server/db";
import { enqueueJob, listActive } from "../server/scheduler/jobs-repo";
import { parseBackfillWindow, defaultLedgerBackfillWindow } from "../server/scheduler/routes";
import { todayEt } from "../server/ledger-sync";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
  const def = defaultLedgerBackfillWindow();
  const w = parseBackfillWindow({ from: arg("from") ?? def.from, to: arg("to") ?? def.to }, todayEt());
  if ("error" in w) { console.error(w.error); process.exit(1); }
  const query = (sql: string, params?: any[]) => pool.query(sql, params);
  const job = await enqueueJob({ trigger: "manual", includeDaily: false, components: [23], scopeAsins: null, params: { ledger_window: { from: w.from, to: w.to } } }, query as any);
  const active = await listActive(query as any);
  const ahead = active.filter((j) => j.id !== job.id && (j.status === "running" || j.queued_at < job.queued_at)).length;
  console.log(`ledger backfill job #${job.id} queued: ${w.from}..${w.to}, ${ahead} job(s) ahead. Needs a running server (its runner executes the queue).`);
  await pool.end();
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
