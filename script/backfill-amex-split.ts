// Amex split backfill (Maria 2026-11-02): two Amex cards end in 1005 — "Amex
// Gold" and "Amex Plus" — and AF had one method, "Amex (1005)" (migration 081
// renames it to Amex Gold and adds Amex Plus). Existing po_payments rows with
// last 4 = 1005: the row's source text (raw_text, else the PO's payment_method
// text) decides — "Amex Plus …" → Amex Plus; "… Gold …" → Amex Gold; a bare
// "Amex (1005)" with neither hint → Amex Gold AND a line in the ambiguous CSV
// for Maria. Rows already named Amex Gold / Amex Plus are left alone. Every
// change gets a History row (po_edit_log, like the PO Details payment editor).
//   npm run backfill:amex-split -- [--prod] [--live] [--out docs/amex-ambiguous-2026-11-02.csv]
// Dry run by default. `--prod` reads .env.production.local (script/env.ts).
import "./env";
import { Pool } from "pg";
import { writeFileSync } from "fs";
import { logEdits } from "../server/po-edit";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const live = process.argv.includes("--live");
const outPath = arg("--out") ?? "docs/amex-ambiguous-2026-11-02.csv";
const csv = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** The part of a multi-payment text that names the 1005 card ("Gift cards: $45, Amex Plus (1005): $30" → "Amex Plus (1005): $30"). */
function segmentFor1005(text: string): string {
  const parts = text.split(/,\s*(?=[A-Za-z?])/);
  return parts.find((p) => /1005/.test(p)) ?? text;
}
export function decideAmex(nickname: string | null, text: string): { nickname: "Amex Gold" | "Amex Plus"; ambiguous: boolean } | null {
  const seg = segmentFor1005(text);
  if (/amex\s*plus/i.test(seg) || /^amex plus$/i.test(String(nickname ?? "").trim())) return { nickname: "Amex Plus", ambiguous: false };
  if (/gold/i.test(seg) || /^amex gold$/i.test(String(nickname ?? "").trim())) return { nickname: "Amex Gold", ambiguous: false };
  if (/amex/i.test(seg) || /amex/i.test(String(nickname ?? ""))) return { nickname: "Amex Gold", ambiguous: true };
  return null;
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    const rows = (await query(
      `SELECT pp.id, pp.po_id, pp.nickname, pp.last4, pp.raw_text, pp.amount, pp.method, p.order_id, p.supplier, p.order_date::text AS order_date, p.payment_method
         FROM po_payments pp JOIN purchase_orders p ON p.id = pp.po_id
        WHERE pp.last4 = '1005' AND pp.method = 'card'
        ORDER BY p.order_date, p.order_id, pp.position`,
    )).rows as any[];
    const c = { rows: rows.length, alreadyGold: 0, alreadyPlus: 0, toPlus: 0, toGold: 0, ambiguous: 0, skipped: 0 };
    const out: string[] = ["po_number,supplier,order_date,payment_text,amount,nickname_before,nickname_set"];
    const updates: Array<{ id: number; po_id: string; from: string | null; to: string }> = [];
    for (const r of rows) {
      const text = String(r.raw_text ?? r.payment_method ?? r.nickname ?? "");
      const d = decideAmex(r.nickname, text);
      if (!d) { c.skipped++; continue; }
      if (r.nickname === d.nickname) { if (d.nickname === "Amex Gold") c.alreadyGold++; else c.alreadyPlus++; if (!d.ambiguous) continue; }
      else { if (d.nickname === "Amex Plus") c.toPlus++; else c.toGold++; updates.push({ id: Number(r.id), po_id: String(r.po_id), from: r.nickname, to: d.nickname }); }
      if (d.ambiguous) { c.ambiguous++; out.push([r.order_id, r.supplier, String(r.order_date).slice(0, 10), text, r.amount ?? "", r.nickname ?? "", d.nickname].map(csv).join(",")); }
    }
    writeFileSync(outPath, out.join("\n") + "\n");
    console.log(JSON.stringify({ mode: live ? "LIVE" : "dry run", ...c, updates: updates.length, ambiguous_csv: outPath }, null, 1));
    if (!live) { console.log("dry run — nothing written; add --live to write"); return; }
    await query("BEGIN");
    for (const u of updates) {
      await query(`UPDATE po_payments SET nickname = $2 WHERE id = $1`, [u.id, u.to]);
      await logEdits(query, u.po_id, null, "po", u.po_id, [{ field: "payment nickname (Amex split backfill)", old: u.from, new: u.to }]);
    }
    await query("COMMIT");
    const left = (await query(`SELECT nickname, COUNT(*)::int AS n FROM po_payments WHERE last4 = '1005' GROUP BY 1 ORDER BY 2 DESC`)).rows;
    console.log(`committed: ${updates.length} rows renamed; last 4 = 1005 now: ${JSON.stringify(left)}`);
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
