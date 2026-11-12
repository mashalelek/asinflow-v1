// Read-only check (Maria 2026-11-12): the Claims list and the claim detail derive bucket, Step, Next action, the Do
// button and the timer from ONE function (rowOf in server/claim-buckets.ts). This loads every claim both ways and
// prints any field that differs. SELECTs only — no timer sweep, no writes.
//
//   npm run claims:list-detail-check -- [--prod]
import "./env";
import pool from "../server/db";
import { loadClaimsPage, claimDetail } from "../server/claim-buckets";

const KEYS = ["bucket", "bucket_since", "due_at", "timed_out", "days_in_bucket", "step", "sentence", "next_action", "group"] as const;
async function main() {
  const q = (sql: string, params?: any[]) => pool.query(sql, params) as any;
  const now = new Date();
  const rows = await loadClaimsPage(q, {}, now);
  let mismatches = 0;
  const byBucket: Record<string, number> = {};
  for (const r of rows) {
    byBucket[r.bucket] = (byBucket[r.bucket] ?? 0) + 1;
    const d = await claimDetail(q, r.id, now);
    if (!d) { console.log(`claim #${r.id}: no detail`); mismatches++; continue; }
    const diffs: string[] = [];
    for (const k of KEYS) if (JSON.stringify(d.claim[k]) !== JSON.stringify(r[k])) diffs.push(`${k}: list ${JSON.stringify(r[k])} · detail ${JSON.stringify(d.claim[k])}`);
    if (JSON.stringify(d.claim.action) !== JSON.stringify(r.action)) diffs.push(`action: list ${JSON.stringify(r.action)} · detail ${JSON.stringify(d.claim.action)}`);
    if (JSON.stringify(d.claim.steps) !== JSON.stringify(r.steps)) diffs.push("steps differ");
    if (diffs.length) { mismatches++; console.log(`claim #${r.id} ${r.supplier} ${r.order_id} ${r.kind}:\n  ${diffs.join("\n  ")}`); }
  }
  console.log(`claims ${rows.length}, by bucket ${JSON.stringify(byBucket)}, list ≠ detail on ${mismatches}`);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
