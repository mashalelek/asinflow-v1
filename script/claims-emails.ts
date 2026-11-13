// Supplier emails → claims (claims commit 6, §3.11 row 10): the backfill. Dry run by default — every email of the window,
// its §3.11 row, the claim it would attach to, what it would set, counts per row; --live applies them (and sets the
// watermark). --prod reads / writes production. --days N (default 90). --out <csv> (default docs/claims-emails-<dry|live>-<date>.csv).
// A dry run never calls the AI; a live run reads free text from known suppliers with Haiku (≤ 25 calls per run).
import "./env";
import fs from "fs";
import pool from "../server/db";
import { gmailClient } from "../server/gmail-client";
import { driveClient } from "../server/drive-client";
import { ingestClaimEmails } from "../server/claim-emails";

const LIVE = process.argv.includes("--live");
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const DAYS = Number(arg("--days") ?? 90);
const OUT = arg("--out") ?? `docs/claims-emails-${LIVE ? "live" : "dryrun"}-${new Date().toISOString().slice(0, 10)}.csv`;
const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""').replace(/\s+/g, " ")}"`;

async function main() {
  const q = (sql: string, p?: any[]) => pool.query(sql, p);
  let drive: ReturnType<typeof driveClient> | null = null;
  try { drive = driveClient(); } catch (e: any) { console.log(`Drive not available (${e?.message ?? e}): a return label would be linked, not saved`); }
  const since = new Date(Date.now() - DAYS * 86400e3);
  console.log(`=== claims:emails ${LIVE ? "LIVE" : "DRY RUN"} · last ${DAYS} days · ${process.env.DATABASE_URL?.includes("render") || process.argv.includes("--prod") ? "PRODUCTION" : "local"} ===`);
  const r = await ingestClaimEmails({ query: q as any, deps: { gmailFor: (mb) => gmailClient(mb), drive }, since, dryRun: !LIVE, log: (m) => console.log("  " + m) });
  const rows = ["date,mailbox,direction,from,to,subject,family,template,row,label,po,claim_id,claim_status,amount,sets,why,needs_ai,applied,gmail_message_id",
    ...r.rows.map((x) => [x.date, x.mailbox, x.direction, x.sender, x.to, x.subject, x.family, x.template, x.row, x.label, x.po ?? "", x.claim_id ?? "", x.claim_status ?? "", x.amount ?? "", x.sets, x.why, x.needs_ai ? "yes" : "", x.applied ?? "", x.gmail_message_id].map(esc).join(","))];
  fs.writeFileSync(OUT, rows.join("\n") + "\n");
  const byRow = Object.entries(r.counts).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  console.log(`scanned ${r.scanned}; rows: ${byRow.map(([k, v]) => `${k}=${v}`).join("  ")}; noise ${r.rows.filter((x) => x.row === "noise").length}`);
  console.log(`AI calls ${r.ai_calls} (skipped ${r.ai_skipped}) $${r.cost.toFixed(2)}; applied ${r.applied}`);
  console.log(`wrote ${OUT} (${r.rows.length} rows)`);
  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
