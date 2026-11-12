// Auto-found claims — the dry run and the backfill (SPEC §22 "Supplier claims", claims patch §3.1 / D8, commit 5).
// Lists every suggestion the three finders would make — missing (D8), never_received, canceled from cancellation
// emails since --from — with PO, line, kind, figures, reason and source email; counts by kind and by rule. Nothing
// is written without --live (and a dry run never calls the AI: it counts the emails it would ask about).
//
//   npm run claims:suggest -- [--prod] [--from 2026-07-29] [--live] [--no-emails] [--no-sweep]
//
// Report: docs/claim-suggestions-{dry-run|live}-<date>.csv
import "./env";
import { writeFileSync } from "node:fs";
import pool from "../server/db";
import { sweepSuggestions } from "../server/claim-suggestions";
import { ingestCancellations } from "../server/cancellation-emails";
import { gmailClient } from "../server/gmail-client";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
async function main() {
  const live = process.argv.includes("--live");
  const from = arg("--from") ?? "2026-07-29";
  const query = (sql: string, params?: any[]) => pool.query(sql, params) as any;
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv: string[] = ["finder,kind,rule,supplier,order_id,line_id,qty_individual,amount,outcome,reason,source_email,email_date,sender,subject,match,matched_language"];
  const byKind: Record<string, number> = {}, byRule: Record<string, number> = {};
  const count = (k: string, r: string) => { byKind[k] = (byKind[k] ?? 0) + 1; byRule[r] = (byRule[r] ?? 0) + 1; };
  const now = new Date();
  if (!process.argv.includes("--no-sweep")) {
    const s = await sweepSuggestions(query, now, { dryRun: !live });
    for (const x of s.suggestions) {
      if (x.outcome === "created" || x.outcome === "dry_run") count(x.kind, x.rule);
      csv.push(["tracking/velocity", x.kind, x.rule, x.supplier, x.order_id, x.po_line_item_id ?? "", x.qty ?? "", x.amount ?? "", x.outcome, x.reason, "", "", "", "", "", ""].map(q).join(","));
    }
    console.log(`${live ? "LIVE" : "DRY RUN"} — missing / never_received: ${s.suggestions.length} evaluated, ${live ? s.created : s.suggestions.filter((x) => x.outcome === "dry_run").length} would be suggested; by rule ${JSON.stringify(s.by_rule)}`);
  }
  if (!process.argv.includes("--no-emails")) {
    const c = await ingestCancellations({ query, deps: { gmail: gmailClient() }, now, since: new Date(`${from}T00:00:00Z`), dryRun: !live, log: (m) => console.log("  " + m) });
    for (const row of c.rows) {
      if (!row.suggestions.length) csv.push(["email", "canceled", `email:${row.retailer}:${row.scope ?? "unknown"}`, "", row.order_id ?? "", "", "", row.refund ?? "", "no claim", `${row.match}; items: ${row.items}`, row.gmail_message_id, row.date, row.sender, row.subject, row.match, row.matched].map(q).join(","));
      for (const x of row.suggestions) {
        if (x.outcome === "created" || x.outcome === "dry_run") count(x.kind, x.rule);
        csv.push(["email", x.kind, x.rule, x.supplier, x.order_id, x.po_line_item_id ?? "", x.qty ?? "", x.amount ?? "", x.outcome, x.reason, row.gmail_message_id, row.date, row.sender, row.subject, row.match, row.matched].map(q).join(","));
      }
    }
    const matched = c.rows.filter((r) => r.po).length;
    console.log(`${live ? "LIVE" : "DRY RUN"} — cancellation emails since ${from}: scanned ${c.scanned}, candidates ${c.candidates}, matched ${matched}, unmatched ${c.rows.length - matched} (${JSON.stringify(Object.fromEntries(Object.entries(c.rows.filter((r) => !r.po).reduce<Record<string, number>>((m, r) => { m[r.match] = (m[r.match] ?? 0) + 1; return m; }, {}))))}), AI ${live ? `${c.ai_calls} calls ≈ $${c.cost.toFixed(2)}` : `${c.ai_skipped} would be asked`}; not candidates ${JSON.stringify(c.not_candidates)}`);
  }
  console.log(`by kind ${JSON.stringify(byKind)}\nby rule ${JSON.stringify(byRule)}`);
  const file = `docs/claim-suggestions-${live ? "live" : "dry-run"}-${new Date().toISOString().slice(0, 10)}.csv`;
  writeFileSync(file, csv.join("\n") + "\n");
  console.log(`report: ${file}`);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
