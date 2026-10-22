// purchase_orders.ships_to backfill (SPEC §26; Maria 2026-10-22) — prep cost only.
//   npm run backfill:ships-to            # dry run
//   npm run backfill:ships-to -- --live  # write ships_to (+ a po_edit_log row per change)
// Rule and sanity check: server/ships-to-backfill.ts. Cutoff for the sanity
// check = VELOCITY_MIN_ORDER_DATE (--cutoff overrides). Talks to DATABASE_URL directly.
import "dotenv/config";
import pool from "../server/db";
import { shipsToFromPrep, isPreVelocityDataError, loadShipsToFacts } from "../server/ships-to-backfill";
import { envReconStart } from "../server/asin-po-pipeline";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const live = process.argv.includes("--live");

async function main() {
  const cutoff = arg("cutoff") ?? envReconStart();
  if (!cutoff) throw new Error("no cutoff: pass --cutoff YYYY-MM-DD or set VELOCITY_MIN_ORDER_DATE");
  const facts = await loadShipsToFacts((s, p) => pool.query(s, p) as any);
  const d = facts.map((f) => ({ f, shipsTo: shipsToFromPrep(f.max_prep) }));
  const pre = d.filter((x) => x.f.order_date < cutoff), post = d.filter((x) => x.f.order_date >= cutoff);
  const c = (l: typeof d, v: string) => l.filter((x) => x.shipsTo === v).length;
  console.log(`sanity cutoff (VELOCITY_MIN_ORDER_DATE) ${cutoff} · POs ${facts.length}`);
  console.log(`  pre-cutoff:  home ${c(pre, "home")} · velocity ${c(pre, "velocity")}`);
  console.log(`  post-cutoff: home ${c(post, "home")} · velocity ${c(post, "velocity")}`);
  const errors = d.filter((x) => isPreVelocityDataError(x.f.order_date, cutoff, x.shipsTo));
  console.log(`DATA ERRORS (dated before ${cutoff}, prep > 0 → velocity; left as computed): ${errors.length}`);
  for (const x of errors) console.log(`  ${x.f.order_date}  ${x.f.supplier.padEnd(28)} ${x.f.order_id.padEnd(22)} max prep ${x.f.max_prep}`);
  const changes = d.filter((x) => x.f.ships_to !== x.shipsTo);
  console.log(`would change ${changes.length} PO(s) (current value → computed)`);
  if (!live) { console.log("dry run — nothing written"); await pool.end(); return; }
  for (const x of changes) {
    await pool.query(`UPDATE purchase_orders SET ships_to = $2 WHERE id = $1`, [x.f.id, x.shipsTo]);
    await pool.query(`INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value) VALUES ($1, NULL, 'po', $1, 'ships_to', $2, $3)`, [x.f.id, x.f.ships_to, `${x.shipsTo} (backfill: prep ${x.f.max_prep ?? "none"})`]);
  }
  console.log(`LIVE — ships_to changed on ${changes.length} PO(s)`);
  await pool.end();
}
main().catch(async (e) => { console.error(e?.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
