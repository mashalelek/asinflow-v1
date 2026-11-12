// EasyPost cost guard (SPEC §26 "Carrier status — EasyPost", claims patch §3.9, commit 4): how many trackers the
// registration pass would create on day one (every undelivered, unregistered row on an OPEN PO, any age — Maria
// 2026-11-12), and the monthly rate after that — so the bill is known before the production key goes in.
// Read-only; no EasyPost call.
//
//   npm run easypost:count [-- --prod]
import "./env";
import pool from "../server/db";
import { easypostCarrier, MAX_AGE_DAYS } from "../server/easypost";

async function main() {
  const q = (sql: string, params?: any[]) => pool.query(sql, params) as any;
  // Before migration 104 (production until commit 4 deploys) the carrier columns do not exist: every open row counts.
  const migrated = (await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'po_tracking' AND column_name = 'easypost_tracker_id'`)).rows.length > 0;
  console.log(migrated ? "migration 104 applied: rows already delivered or registered are left out" : "migration 104 not applied here: every open row counts");
  const open = (await q(`SELECT t.carrier, t.direction, count(DISTINCT upper(t.tracking_number))::int AS numbers, count(*)::int AS rows,
                                 min(COALESCE(t.shipped_at, t.created_at))::date::text AS oldest
                           FROM po_tracking t JOIN purchase_orders p ON p.id = t.po_id AND p.closed_at IS NULL
                          WHERE t.tracking_number NOT LIKE 'email:%' ${migrated ? "AND t.delivered_at IS NULL AND t.easypost_tracker_id IS NULL" : ""}
                          GROUP BY 1, 2 ORDER BY 2, 3 DESC`)).rows as Array<{ carrier: string; direction: string; numbers: number; rows: number; oldest: string }>;
  let dayOne = 0, skipped = 0;
  console.log(`Day one (rows on OPEN POs, any age, one tracker per distinct number; the sweep stops ${MAX_AGE_DAYS} days after registration):`);
  for (const r of open) {
    const ok = easypostCarrier(r.carrier) != null;
    if (ok) dayOne += r.numbers; else skipped += r.numbers;
    console.log(`  ${r.direction.padEnd(7)} ${r.carrier.padEnd(9)} ${String(r.numbers).padStart(4)} number(s) on ${String(r.rows).padStart(4)} row(s), oldest ${r.oldest}  ${ok ? `→ EasyPost ${easypostCarrier(r.carrier)}` : "→ skipped (not tracked by EasyPost; Velocity fallback)"}`);
  }
  console.log(`  trackers on day one: ${dayOne}   skipped: ${skipped}`);
  const months = (await q(`SELECT to_char(date_trunc('month', COALESCE(shipped_at, created_at)), 'YYYY-MM') AS m,
                                  count(DISTINCT upper(tracking_number)) FILTER (WHERE upper(carrier) IN ('UPS','USPS','FEDEX','DHL','AMAZON'))::int AS tracked,
                                  count(DISTINCT upper(tracking_number))::int AS numbers
                             FROM po_tracking WHERE tracking_number NOT LIKE 'email:%'
                            GROUP BY 1 ORDER BY 1 DESC LIMIT 6`)).rows as Array<{ m: string; tracked: number; numbers: number }>;
  console.log("Per month (distinct numbers shipped that month; 'tracked' = carriers EasyPost tracks):");
  for (const r of months) console.log(`  ${r.m}  ${String(r.tracked).padStart(4)} tracked of ${String(r.numbers).padStart(4)}`);
  const full = months.filter((r) => r.m < new Date().toISOString().slice(0, 7)).slice(0, 3);
  const avg = full.length ? Math.round(full.reduce((s, r) => s + r.tracked, 0) / full.length) : 0;
  console.log(`  expected monthly rate: ~${avg} new tracker(s) (mean of the last ${full.length} full month(s)); × EasyPost's per-tracker price = the monthly bill`);
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
