// PO documents (patch po-documents §8 commit 2; SPEC §22 "PO documents"):
// dry run by default — counts only, nothing written to Drive or the
// database. --link: link existing PDFs under the Invoices root (D1, Maria's
// rules 2026-11-04) and write the review list (several candidates) to
// docs/invoice-link-review-<date>.csv; --list prints each file it links;
// a linked file whose stored type disagrees with its name's suffix is
// retyped (2026-11-05: `_invoice` was linked as a confirmation). --ingest: render matched order emails
// (confirmation / shipped / delivered) and save them (D2, D4); --since
// YYYY-MM-DD scans from that date instead of the watermark; --order <#>
// saves one PO's emails only (2026-11-04); --ai-max N caps the AI fallback
// calls (default 40). --missing (2026-11-06): every AF-created PO with no
// document — its order # (and alternates) searched in orders@, the emails
// found read for that PO only (no window, no watermark); a PO still missing
// one is listed with what was found. The AI types a subject no rule names, only when the
// email names exactly one PO; a dry run never calls it (it counts the
// emails it would ask about). Neither flag = both. --live writes. --prod =
// production (script/env.ts). Needs GOOGLE_CREDENTIALS_PATH (Gmail + Drive
// delegation).
import "./env";
import fs from "fs";
import path from "path";
import pool from "../server/db";
import { gmailClient, listMessageIds } from "../server/gmail-client";
import { driveClient } from "../server/drive-client";
import { linkExistingDocuments, ingestDocuments, reviewCsv, AF_CREATED_SOURCES } from "../server/po-documents";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (k: string) => process.argv.includes(k);

async function main() {
  const live = has("--live");
  const missing = has("--missing");
  const doLink = !missing && (has("--link") || !has("--ingest")), doIngest = !missing && (has("--ingest") || !has("--link"));
  const query = (sql: string, params?: any[]) => pool.query(sql, params);
  const drive = driveClient();
  console.log(live ? "LIVE" : "DRY RUN (counts only — nothing written)");
  if (doLink) {
    const r = await linkExistingDocuments({ query, drive, dryRun: !live });
    console.log(`\nLink existing PDFs: ${r.files} files under the root (${r.pdfs} PDF), ${r.pos} POs, ${r.already_linked} files already linked`);
    console.log(`  ${live ? "linked" : "would link"} ${r.linked.name + r.linked.loose} files (name ${r.linked.name}, loose ${r.linked.loose}) on ${r.pos_linked} POs · review ${r.review.length} · ${live ? "retyped" : "would retype"} ${r.retyped} (type from the name's suffix)`);
    if (has("--list")) for (const l of r.links) console.log(`    ${l.rule.padEnd(5)} ${l.type.padEnd(18)} ${l.file.name}`);
    console.log("  by order month (POs / POs linked):");
    for (const [m, v] of Object.entries(r.by_month).sort()) console.log(`    ${m}  ${String(v.pos).padStart(4)}  ${String(v.linked).padStart(4)}`);
    const f = path.join(arg("--out") ?? "docs", `invoice-link-review-${new Date().toISOString().slice(0, 10)}.csv`);
    fs.writeFileSync(f, reviewCsv(r.review));
    console.log(`  review list → ${f} (${r.review.length})`);
  }
  if (missing) {
    const gmail = gmailClient();
    const pos = (await query(
      `SELECT p.id, p.supplier, p.order_id, p.alt_order_ids, p.order_date, p.source FROM purchase_orders p
        WHERE p.source = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM po_documents d WHERE d.po_id = p.id)
        ORDER BY p.order_date, p.order_id`, [AF_CREATED_SOURCES],
    )).rows;
    console.log(`\nAF-created POs with no document: ${pos.length}`);
    let found = 0, saved = 0, still = 0;
    for (const p of pos) {
      const keys = [p.order_id, ...((p.alt_order_ids ?? []) as string[])].filter((k: string) => k && k.trim().length >= 5);
      const ids = Array.from(new Set((await Promise.all(keys.map((k: string) => listMessageIds(gmail, `"${k.trim()}"`, 50)))).flat()));
      if (ids.length) found++;
      const r = ids.length ? await ingestDocuments({ query, deps: { gmail, drive }, dryRun: !live, ids, onlyPoId: String(p.id) }) : null;
      const n = r?.items.length ?? 0;
      saved += n > 0 ? 1 : 0;
      if (n === 0) still++;
      const what = r ? `${ids.length} email(s): matched ${r.matched}, unmatched ${r.unmatched}, excluded ${r.excluded}, already ${r.already}, untyped ${r.untyped}${r.failed ? `, FAILED ${r.failed}` : ""}` : "no email names its order #";
      console.log(`  ${n ? (live ? "saved" : "would save") : "missing   "} ${String(p.source).padEnd(9)} ${p.supplier} ${p.order_id} — ${what}${n ? ` → ${r!.items.map((i) => `${i.type}${i.file_name ? ` ${i.file_name}` : ""}`).join(", ")}` : ""}`);
      for (const x of r?.failures ?? []) console.log(`      FAILED ${x.message_id}: ${x.error}`);
    }
    console.log(`\n  POs with an email naming the order #: ${found} · ${live ? "got a document" : "would get a document"}: ${saved} · still none: ${still}`);
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
