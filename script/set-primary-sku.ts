// Make one of an ASIN's existing SKUs its primary — the same single statement
// the Add to SC path uses on a created listing (offer-add.ts), so
// asin_skus.is_primary and asins.primary_sku can never disagree.
// (Maria 2026-10-22: B078MYRN9V back to FRA-GRO-N9V-MCM-006 after the
// KZ-K3SV-T350 restore was reversed.)
//   npx tsx script/set-primary-sku.ts --asin B078MYRN9V --sku FRA-GRO-N9V-MCM-006          # report only
//   npx tsx script/set-primary-sku.ts --asin B078MYRN9V --sku FRA-GRO-N9V-MCM-006 --live   # write
import "dotenv/config";
import pool from "../server/db";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1]?.trim().toUpperCase() : undefined; };

async function main(): Promise<number> {
  const asin = arg("asin"), sku = arg("sku");
  if (!asin || !sku) { console.error("--asin and --sku are required"); return 1; }
  const rows = (await pool.query(`SELECT s.sku, s.is_primary, a.primary_sku FROM asin_skus s JOIN asins a ON a.id = s.asin_id WHERE a.asin = $1 ORDER BY s.sku`, [asin])).rows;
  console.log(`${asin} now: primary_sku ${rows[0]?.primary_sku ?? "—"}; ${rows.map((r: any) => `${r.sku}${r.is_primary ? " (primary)" : ""}`).join(", ")}`);
  if (!rows.some((r: any) => r.sku === sku)) { console.error(`${sku} is not an asin_skus row of ${asin} — refusing`); return 2; }
  if (!process.argv.includes("--live")) { console.log("no --live: nothing written"); return 0; }
  await pool.query(
    `WITH tgt AS (SELECT id FROM asins WHERE asin = $1),
     promote AS (UPDATE asin_skus SET is_primary = true WHERE asin_id = (SELECT id FROM tgt) AND sku = $2),
     demote AS (UPDATE asin_skus SET is_primary = false WHERE asin_id = (SELECT id FROM tgt) AND sku <> $2)
     UPDATE asins SET primary_sku = $2 WHERE asin = $1`,
    [asin, sku],
  );
  const after = (await pool.query(`SELECT s.sku, s.is_primary, a.primary_sku FROM asin_skus s JOIN asins a ON a.id = s.asin_id WHERE a.asin = $1 ORDER BY s.sku`, [asin])).rows;
  console.log(`LIVE — ${asin}: primary_sku ${after[0]?.primary_sku}; ${after.map((r: any) => `${r.sku}${r.is_primary ? " (primary)" : ""}`).join(", ")}`);
  return 0;
}
main().then(async (c) => { await pool.end(); process.exit(c); }).catch(async (e) => { console.error(e?.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
