// Re-date the sheet-era write-offs to their PO's order date (claims commit 9, §3.14 "Dating"; Maria 2026-11-15).
// Migration 101 converted the sheet's col V / W losses into closed write_off claims dated by the PO's LAST EDIT
// (found_at and closed_at), so on the Dashboard they all read as October / November 2026 write-offs. A write-off
// counts on its write-off date, and for a sheet-era loss the closest fact AF has is the PO's order date.
//   npm run claims:redate-writeoffs -- [--prod] [--live] [--out <csv>]
// Dry run by default: writes the CSV (every row, old and new dates, which Dashboard tile each reads today) and stops.
// `--live` sets closed_at and found_at to noon Eastern on the order date and writes ONE History row per claim
// (po_edit_log, entity claim). Idempotent: a claim already on its order date is skipped. Refuses to write while any
// of the claims' POs has no order date.
import "./env";
import { writeFileSync } from "fs";
import { Pool } from "pg";
import { logEdits } from "../server/po-edit";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const live = process.argv.includes("--live"), prod = process.argv.includes("--prod");
const out = arg("--out") ?? `docs/claims-writeoffs-redate-${new Date().toISOString().slice(0, 10)}${prod ? "" : "-local"}.csv`;

export const SHEET_WRITEOFFS_SQL = `
  SELECT c.id, c.kind, c.amount_owed, c.outcome_amount, p.supplier, p.order_id, p.order_date::text AS order_date,
         (c.closed_at AT TIME ZONE 'America/New_York')::date::text AS closed_on, c.found_at::text AS found_on,
         k.source
    FROM supplier_claims c JOIN purchase_orders p ON p.id = c.po_id
    JOIN supplier_claim_conversions k ON k.claim_id = c.id AND k.source IN ('sheet_loss', 'sheet_loss_added')
   WHERE c.status = 'closed' AND c.outcome = 'write_off'
   ORDER BY p.order_date, c.id`;

const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ymdEastern = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
/** The set-1 tile a date reads in today (Today / This week / MTD / 30 days), "" for none. */
function tileOf(ymd: string, today: string): string {
  const d = new Date(`${ymd}T12:00:00Z`), t = new Date(`${today}T12:00:00Z`);
  const days = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (days < 0) return "";
  const tiles: string[] = [];
  if (days === 0) tiles.push("Today");
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  if (days <= dow) tiles.push("This week");
  if (ymd.slice(0, 7) === today.slice(0, 7)) tiles.push("MTD");
  if (days <= 29) tiles.push("30 days");
  return tiles.join(" + ");
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const today = ymdEastern(new Date());
    const rows = (await query(SHEET_WRITEOFFS_SQL)).rows as Array<{ id: number; kind: string; amount_owed: string; outcome_amount: string; supplier: string; order_id: string; order_date: string | null; closed_on: string; found_on: string; source: string }>;
    const noDate = rows.filter((r) => !r.order_date);
    const todo = rows.filter((r) => r.order_date && (r.closed_on !== r.order_date || r.found_on !== r.order_date));
    const lines = [["claim_id", "supplier", "order_id", "kind", "amount", "closed_on_now", "found_on_now", "order_date", "tile_now", "tile_after", "source", "action"].join(",")];
    for (const r of rows) {
      const action = !r.order_date ? "NO ORDER DATE" : todo.includes(r) ? "re-date" : "already on order date";
      lines.push([r.id, r.supplier, r.order_id, r.kind, Number(r.outcome_amount ?? r.amount_owed).toFixed(2), r.closed_on, r.found_on, r.order_date ?? "", tileOf(r.closed_on, today), r.order_date ? tileOf(r.order_date, today) : "", r.source, action].map(csvCell).join(","));
    }
    writeFileSync(out, lines.join("\n") + "\n");
    const total = rows.reduce((t, r) => t + Number(r.outcome_amount ?? r.amount_owed ?? 0), 0);
    const inTiles = rows.filter((r) => tileOf(r.closed_on, today)).length, inTilesAfter = rows.filter((r) => r.order_date && tileOf(r.order_date, today)).length;
    console.log(`${rows.length} sheet-era write-offs ($${total.toFixed(2)}): ${todo.length} to re-date, ${rows.length - todo.length - noDate.length} already on the order date, ${noDate.length} with no order date`);
    console.log(`in a set-1 tile today: ${inTiles} now → ${inTilesAfter} after; CSV ${out}`);
    if (noDate.length) { console.error(`STOP: ${noDate.length} claim(s) whose PO has no order date — ${noDate.map((r) => `#${r.id} ${r.supplier} ${r.order_id}`).join(", ")}`); process.exit(3); }
    if (!live) { console.log("dry run — add --live to write"); return; }
    await query("BEGIN");
    for (const r of todo) {
      await query(`UPDATE supplier_claims SET closed_at = ($2::text || ' 12:00')::timestamp AT TIME ZONE 'America/New_York', found_at = ($2::text || ' 12:00')::timestamp AT TIME ZONE 'America/New_York', updated_at = now() WHERE id = $1`, [r.id, r.order_date]);
      const poId = (await query(`SELECT po_id FROM supplier_claims WHERE id = $1`, [r.id])).rows[0].po_id;
      await logEdits(query, String(poId), null, "claim", String(r.id), [{ field: "write-off date (re-dated to the PO's order date, claims commit 9)", old: `closed ${r.closed_on} · found ${r.found_on}`, new: r.order_date! }]);
    }
    await query("COMMIT");
    const after = (await query(SHEET_WRITEOFFS_SQL)).rows as typeof rows;
    const left = after.filter((r) => r.closed_on !== r.order_date || r.found_on !== r.order_date).length;
    const log = (await query(`SELECT COUNT(*)::int AS n FROM po_edit_log WHERE entity = 'claim' AND field LIKE 'write-off date (re-dated%'`)).rows[0].n;
    console.log(`written: ${todo.length} claim(s) re-dated; ${left} still off their order date; History rows with that field: ${log}`);
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
