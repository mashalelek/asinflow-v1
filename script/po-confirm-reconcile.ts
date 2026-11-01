// Confirmation-email reconcile (po-ai-prefill §6.7, SPEC §26): dry run by
// default — lists every confirmation email matched to a PO that differs from
// it (order #, total, line count); --live raises "Confirm order details" and
// moves the watermark. --since YYYY-MM-DD scans from that date instead of the
// watermark (the first run / a backfill). --prod = production (script/env.ts);
// writes docs/po-confirmations-review-<date>.csv (differing + unmatched).
// Needs DATABASE_URL and the Gmail
// delegation (GOOGLE_CREDENTIALS_PATH).
import "./env";
import pool from "../server/db";
import { gmailClient } from "../server/gmail-client";
import { reconcileConfirmations } from "../server/po-confirm-reconcile";
import { csv } from "../server/po-model-backfill";
import fs from "fs";
import path from "path";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
async function main() {
  const live = process.argv.includes("--live");
  const since = arg("--since");
  const r = await reconcileConfirmations({ query: (sql, params) => pool.query(sql, params), deps: { gmail: gmailClient() }, dryRun: !live, since: since ? new Date(`${since}T00:00:00`) : undefined, log: (m) => console.log(m) });
  console.log(`${live ? "LIVE" : "DRY RUN"} · window ${r.since ?? "start"} … ${r.until}`);
  console.log(`  scanned ${r.scanned} · confirmations ${r.confirmations} · matched ${r.matched} (agreed ${r.agreed}, differed ${r.differed}${live ? `, raised ${r.raised}` : ""}) · unmatched ${r.unmatched} · ambiguous ${r.ambiguous}`);
  for (const d of r.diffs) console.log(`    ${d.supplier} ${d.order_id}: ${d.differences.join("; ")}`);
  // Review list (Maria 2026-11-01, answer 6): the differing confirmations with their diffs, and every unmatched one with order #, supplier and date.
  const today = r.until.slice(0, 10);
  const f = path.join(arg("--out") ?? "docs", `po-confirmations-review-${today}.csv`);
  fs.writeFileSync(f, csv([["kind", "supplier", "order_id(s)", "email_date", "email_total", "sender_domain", "subject", "diff / note", "Maria: note"],
    ...r.diffs.map((d) => ["differs", d.supplier, d.order_id, "", "", "", "", d.differences.join("; "), ""]),
    ...r.unmatchedList.map((u) => ["unmatched", u.supplier ?? "", u.order_ids.join(" / "), u.date ?? "", u.total ?? "", u.sender_domain ?? "", u.subject, "no PO with this order # in AF", ""])]));
  console.log(`  review list → ${f} (${r.diffs.length} differing, ${r.unmatchedList.length} unmatched)`);
  if (!live) console.log("\nDry run — nothing raised, watermark untouched.");
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
