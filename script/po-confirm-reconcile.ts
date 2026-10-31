// Confirmation-email reconcile (po-ai-prefill §6.7, SPEC §26): dry run by
// default — lists every confirmation email matched to a PO that differs from
// it (order #, total, line count); --live raises "Confirm order details" and
// moves the watermark. --since YYYY-MM-DD scans from that date instead of the
// watermark (the first run / a backfill). Needs DATABASE_URL and the Gmail
// delegation (GOOGLE_CREDENTIALS_PATH).
import "dotenv/config";
import pool from "../server/db";
import { gmailClient } from "../server/gmail-client";
import { reconcileConfirmations } from "../server/po-confirm-reconcile";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
async function main() {
  const live = process.argv.includes("--live");
  const since = arg("--since");
  const r = await reconcileConfirmations({ query: (sql, params) => pool.query(sql, params), deps: { gmail: gmailClient() }, dryRun: !live, since: since ? new Date(`${since}T00:00:00`) : undefined, log: (m) => console.log(m) });
  console.log(`${live ? "LIVE" : "DRY RUN"} · window ${r.since ?? "start"} … ${r.until}`);
  console.log(`  scanned ${r.scanned} · confirmations ${r.confirmations} · matched ${r.matched} (agreed ${r.agreed}, differed ${r.differed}${live ? `, raised ${r.raised}` : ""}) · unmatched ${r.unmatched} · ambiguous ${r.ambiguous}`);
  for (const d of r.diffs) console.log(`    ${d.supplier} ${d.order_id}: ${d.differences.join("; ")}`);
  if (!live) console.log("\nDry run — nothing raised, watermark untouched.");
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
