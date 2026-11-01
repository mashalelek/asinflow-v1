// Return pickup / return label rows ingested before the parser knew them
// (SPEC §26; Maria 2026-10-22). Every row whose email subject is a return
// (isReturnEmail) leaves its PO: status unmatched, po_id NULL, match_reason
// 'return' — the unmatched queue's marker, consumed by the cancellations
// patch — or 'dismissed' for the numbers named in --dismiss.
//   npm run tracking:flag-returns                                  # report only
//   npm run tracking:flag-returns -- --dismiss 798190555249 --live # write
//   --return <n,…>  also re-flag these DISMISSED return rows as 'return'
//                   (798190555249, Maria 2026-10-22: same marker as the others)
// A row already PUSHED to Velocity is reported and left alone (its number
// is in Velocity; removing it is a hand step). Talks to DATABASE_URL directly.
import "./env";
import pool from "../server/db";
import { isReturnEmail } from "../server/tracking-parse";
import { RETURN_REASON } from "../server/tracking-ingest";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<number> {
  const reflag = new Set((arg("return") ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
  const dismiss = new Set((arg("dismiss") ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
  const rows = (await pool.query(
    `SELECT t.id, t.carrier, t.tracking_number, t.status, t.match_reason, t.email_subject, p.order_id AS on_po
       FROM po_tracking t LEFT JOIN purchase_orders p ON p.id = t.po_id
      WHERE COALESCE(t.match_reason, '') <> 'return'
        AND (COALESCE(t.match_reason, '') <> 'dismissed' OR UPPER(t.tracking_number) = ANY($1::text[])) ORDER BY t.id`,
    [Array.from(reflag)],
  )).rows.filter((r: any) => isReturnEmail(String(r.email_subject ?? "")));
  const live = process.argv.includes("--live");
  let written = 0;
  for (const r of rows) {
    const to = dismiss.has(String(r.tracking_number).toUpperCase()) ? "dismissed" : RETURN_REASON;
    const pushed = r.status === "pushed";
    console.log(`${r.carrier} ${r.tracking_number}  PO ${r.on_po ?? "—"} (${r.status})  "${r.email_subject}"  → ${pushed ? "LEFT: already pushed to Velocity" : to}`);
    if (!live || pushed) continue;
    await pool.query(
      `UPDATE po_tracking SET status = 'unmatched', po_id = NULL, match_reason = $2, review_reason = NULL, push_error = NULL, updated_at = NOW() WHERE id = $1`,
      [r.id, to],
    );
    written++;
  }
  const missing = Array.from(dismiss).filter((d) => !rows.some((r: any) => String(r.tracking_number).toUpperCase() === d));
  if (missing.length) console.log(`--dismiss not among the return rows: ${missing.join(", ")}`);
  console.log(live ? `LIVE — ${written} row(s) written` : `${rows.length} return row(s); no --live: nothing written`);
  return 0;
}
main().then(async (c) => { await pool.end(); process.exit(c); }).catch(async (e) => { console.error(e?.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
