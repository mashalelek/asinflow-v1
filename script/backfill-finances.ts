// Finances history backfill (Finances API patch commit 6, SPEC §7): ONE manual
// job running components 19 (orders report, 30-day chunks), 20 (Finances
// transactions, weekly windows) and 21 (the three reports, then the
// finances_daily rebuild) over a window. Default: from the earliest day
// Amazon still answers for (730 days; 2024-11-19 at drafting) to today.
// Idempotent: every window replaces what it holds. Needs a running server
// (its runner executes the queue; on production Render's server does).
//
//   npm run backfill:finances [-- --from YYYY-MM-DD --to YYYY-MM-DD --prod]
import "./env";
import pool from "../server/db";
import { enqueueJob, listActive } from "../server/scheduler/jobs-repo";
import { parseBackfillWindow } from "../server/scheduler/routes";
import { retentionStart } from "../server/finances";

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const earliest = retentionStart(now).toISOString().slice(0, 10);
  const w = parseBackfillWindow({ from: arg("from") ?? earliest, to: arg("to") ?? today }, today);
  if ("error" in w) { console.error(w.error); process.exit(1); }
  if (w.from < earliest) console.log(`note: Amazon keeps 730 days — ${w.from} is clamped to ${earliest} for the Finances pull`);
  const query = (sql: string, params?: any[]) => pool.query(sql, params);
  const job = await enqueueJob({
    trigger: "manual", includeDaily: false, components: [19, 20, 21], scopeAsins: null,
    params: { sales_window: { from: w.from, to: w.to }, finances_window: { from: w.from, to: w.to }, finances_reports: true },
  }, query as any);
  const active = await listActive(query as any);
  const ahead = active.filter((j) => j.id !== job.id && (j.status === "running" || j.queued_at < job.queued_at)).length;
  console.log(`backfill job #${job.id} queued: orders report + Finances + reports ${w.from}..${w.to}, ${ahead} job(s) ahead. Watch the jobs dialog; the ledger rows are refresh_runs WHERE job_id = ${job.id}.`);
  await pool.end();
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
