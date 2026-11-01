// Sales history backfill (SPEC §11 "Refresh job", 2026-10-16).
//
//   npm run backfill:sales                       # 2024-05-01 → today
//   npm run backfill:sales -- --from 2026-06-01 --to 2026-10-16
//
// Enqueues ONE manual job running component 19 (sales) alone over
// params.sales_window, exactly what POST /api/jobs/backfill-sales does for
// an admin session; this script talks to the database directly (DATABASE_URL
// from .env) because there is no API token for scripts. The running server's
// job runner executes it, serialized behind the hourly passes; follow it in
// the jobs dialog or `SELECT … FROM jobs WHERE id = N`.
import "./env";
import pool from "../server/db";
import { enqueueJob, listActive } from "../server/scheduler/jobs-repo";
import { parseBackfillWindow } from "../server/scheduler/routes";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const w = parseBackfillWindow({ from: arg("from") ?? "2024-05-01", to: arg("to") ?? today }, today);
  if ("error" in w) { console.error(w.error); process.exit(1); }
  const query = (sql: string, params?: any[]) => pool.query(sql, params);
  const job = await enqueueJob({ trigger: "manual", includeDaily: false, components: [19], scopeAsins: null, params: { sales_window: { from: w.from, to: w.to } } }, query as any);
  const active = await listActive(query as any);
  const ahead = active.filter((j) => j.id !== job.id && (j.status === "running" || j.queued_at < job.queued_at)).length;
  console.log(`backfill job #${job.id} queued: sales ${w.from}..${w.to}, ${ahead} job(s) ahead. Needs a running server (its runner executes the queue).`);
  await pool.end();
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
