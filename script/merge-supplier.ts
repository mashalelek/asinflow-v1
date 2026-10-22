// Merge one AF supplier name into another (Maria 2026-10-22: rhode.com → rhodeskin.com).
//   npm run supplier:merge -- --from rhode.com --into rhodeskin.com          # report only
//   npm run supplier:merge -- --from rhode.com --into rhodeskin.com --live   # write, then re-match tracking
// purchase_orders.supplier (a po_edit_log row per PO), asins.supplier,
// tracking.supplier_domain_map values, po_tracking.supplier_guess. Talks to DATABASE_URL directly.
import "dotenv/config";
import pool from "../server/db";
import { matchTrackingRows, DOMAIN_MAP_KEY } from "../server/tracking-match";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]?.trim() : undefined; };

async function main(): Promise<number> {
  const from = arg("from"), into = arg("into");
  if (!from || !into || from === into) { console.error("--from and --into are required and must differ"); return 1; }
  const pos = (await pool.query(`SELECT id, order_id FROM purchase_orders WHERE supplier = $1 ORDER BY order_date`, [from])).rows;
  const asins = (await pool.query(`SELECT count(*)::int n FROM asins WHERE supplier = $1`, [from])).rows[0].n;
  const map: Record<string, string> = (await pool.query(`SELECT value FROM settings WHERE key = $1`, [DOMAIN_MAP_KEY])).rows[0]?.value ?? {};
  const mapKeys = Object.keys(map).filter((k) => map[k] === from);
  const guesses = (await pool.query(`SELECT count(*)::int n FROM po_tracking WHERE supplier_guess = $1`, [from])).rows[0].n;
  console.log(`${from} → ${into}: POs ${pos.length} (${pos.map((p: any) => p.order_id).join(", ") || "—"}), asins ${asins}, domain-map entries ${mapKeys.length} (${mapKeys.join(", ") || "—"}), tracking guesses ${guesses}`);
  if (!process.argv.includes("--live")) { console.log("no --live: nothing written"); return 0; }
  for (const p of pos) {
    await pool.query(`UPDATE purchase_orders SET supplier = $2 WHERE id = $1`, [p.id, into]);
    await pool.query(`INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value) VALUES ($1::uuid, NULL, 'po', $1::text, 'supplier', $2, $3)`, [p.id, from, `${into} (supplier merge)`]);
  }
  await pool.query(`UPDATE asins SET supplier = $2 WHERE supplier = $1`, [from, into]);
  for (const k of mapKeys) await pool.query(`UPDATE settings SET value = jsonb_set(value, ARRAY[$2::text], to_jsonb($3::text)), updated_at = NOW() WHERE key = $1`, [DOMAIN_MAP_KEY, k, into]);
  await pool.query(`UPDATE po_tracking SET supplier_guess = $2, updated_at = NOW() WHERE supplier_guess = $1`, [from, into]);
  console.log(`LIVE — merged; re-match ${JSON.stringify(await matchTrackingRows((s, p) => pool.query(s, p) as any))}`);
  return 0;
}
main().then(async (c) => { await pool.end(); process.exit(c); }).catch(async (e) => { console.error(e?.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
