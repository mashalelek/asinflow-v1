// PO documents (patch po-documents §8 commit 2; SPEC §22 "PO documents"):
// dry run by default — counts only, nothing written to Drive or the
// database. --link: link existing PDFs under the Invoices root (D1, Maria's
// rules 2026-11-04) and write the review list (several candidates) to
// docs/invoice-link-review-<date>.csv. --ingest: render matched order emails
// (confirmation / shipped / delivered) and save them (D2, D4); --since
// YYYY-MM-DD scans from that date instead of the watermark; --order <#>
// saves one PO's emails only (2026-11-04); --ai-max N caps the AI fallback
// calls (default 40). The AI types a subject no rule names, only when the
// email names exactly one PO; a dry run never calls it (it counts the
// emails it would ask about). Neither flag = both. --live writes. --prod =
// production (script/env.ts). Needs GOOGLE_CREDENTIALS_PATH (Gmail + Drive
// delegation).
import "./env";
import fs from "fs";
import path from "path";
import pool from "../server/db";
import { gmailClient } from "../server/gmail-client";
import { driveClient } from "../server/drive-client";
import { linkExistingDocuments, ingestDocuments, reviewCsv } from "../server/po-documents";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (k: string) => process.argv.includes(k);

async function main() {
  const live = has("--live");
  const doLink = has("--link") || !has("--ingest"), doIngest = has("--ingest") || !has("--link");
  const query = (sql: string, params?: any[]) => pool.query(sql, params);
  const drive = driveClient();
  console.log(live ? "LIVE" : "DRY RUN (counts only — nothing written)");
  if (doLink) {
    const r = await linkExistingDocuments({ query, drive, dryRun: !live });
    console.log(`\nLink existing PDFs: ${r.files} files under the root (${r.pdfs} PDF), ${r.pos} POs, ${r.already_linked} files already linked`);
    console.log(`  ${live ? "linked" : "would link"} ${r.linked.name + r.linked.loose} files (name ${r.linked.name}, loose ${r.linked.loose}) on ${r.pos_linked} POs · review ${r.review.length}`);
    console.log("  by order month (POs / POs linked):");
    for (const [m, v] of Object.entries(r.by_month).sort()) console.log(`    ${m}  ${String(v.pos).padStart(4)}  ${String(v.linked).padStart(4)}`);
    const f = path.join(arg("--out") ?? "docs", `invoice-link-review-${new Date().toISOString().slice(0, 10)}.csv`);
    fs.writeFileSync(f, reviewCsv(r.review));
    console.log(`  review list → ${f} (${r.review.length})`);
  }
  if (doIngest) {
    const since = arg("--since"), order = arg("--order"), aiMax = arg("--ai-max");
    let onlyPoId: string | undefined;
    if (order) {
      const p = (await query(`SELECT id FROM purchase_orders WHERE order_id = $1`, [order])).rows;
      if (p.length !== 1) throw new Error(`--order ${order}: ${p.length} POs`);
      onlyPoId = String(p[0].id);
    }
    const r = await ingestDocuments({ query, deps: { gmail: gmailClient(), drive }, dryRun: !live, since: since ? new Date(`${since}T00:00:00`) : undefined, onlyPoId, aiMaxCalls: aiMax ? Number(aiMax) : undefined });
    console.log(`\nOrder emails: window ${r.since ?? "start"} … ${r.until}`);
    console.log(`  scanned ${r.scanned} (excluded by subject ${r.excluded}) · documents ${r.documents} · matched ${r.matched} (unmatched ${r.unmatched}, ambiguous ${r.ambiguous}) · already saved ${r.already} · sheet-era backfill skipped ${r.sheet_era_skipped}`);
    console.log(`  ${live ? "saved" : "would save"} ${r.items.length}: ${Object.entries(r.by_type).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}${r.failed ? ` · failed ${r.failed}` : ""}`);
    console.log(`  by rule: ${Object.entries(r.by_rule).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} · AI ${r.ai.off ? "off" : `${r.ai.calls} calls (typed ${r.ai.typed}, none ${r.ai.none}, failed ${r.ai.failed}, over cap ${r.ai.skipped_cap}, would ask in a live run ${r.ai.dry_run}) ≈ $${r.ai.cost}`} · untyped ${r.untyped}`);
    if (r.folders_created.length) console.log(`  folders ${live ? "created" : "to create"}: ${r.folders_created.join(", ")}`);
    for (const i of r.items) console.log(`    ${i.source.padEnd(13)} ${i.supplier} ${i.order_id} ${i.type} [${i.rule}] "${i.subject.slice(0, 70)}"${i.file_name ? ` → ${i.file_name}` : ""}`);
    for (const x of r.failures) console.log(`    FAILED ${x.message_id}: ${x.error}`);
  }
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
