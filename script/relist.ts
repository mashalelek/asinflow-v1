// §18 Relist from the shell — the same pipeline as POST /api/listings/relist
// (server/relist.ts), for running against a database without a login session.
//
//   tsx script/relist.ts --items B0XXXXXXXX:SKU-1,B0YYYYYYYY:SKU-2 [--open]          # dry run (preview, no PUT)
//   tsx script/relist.ts --items B0XXXXXXXX:SKU-1,B0YYYYYYYY:SKU-2 [--open] --live   # submit + §19 ladder
//
// Dry run prints each outcome and the exact payload it would send, with the
// three things a relist payload must get right called out: no quantity key,
// no end_at, and the DG attribute when the catalog declares one.
//
// --live submits, then runs the §19 probe ladder in this process (T+1, 3, 10,
// 30, 60 min, scoped to this batch's ledger rows, stopping once all resolve)
// with close-after-create wired exactly as the route's ladder — rows recorded
// open_on_create skip it. Needs DATABASE_URL and the SP-API credentials.
import "dotenv/config";
import pool from "../server/db";
import { runRelist, type RelistItem } from "../server/relist";
import { verifyPending, findRecentPendingIds, countOpenAmong } from "../server/listing-submissions-repo";
import { closeAfterCreate } from "../server/listing-hygiene-run";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const LADDER_MIN = [1, 3, 10, 30, 60];

function findPaths(obj: any, pred: (k: string) => boolean, path = ""): string[] {
  if (obj == null || typeof obj !== "object") return [];
  return Object.entries(obj).flatMap(([k, v]) => [
    ...(pred(k) ? [`${path}${k}`] : []),
    ...findPaths(v, pred, `${path}${k}.`),
  ]);
}

async function main() {
  const sellerId = process.env.SP_API_SELLER_ID;
  if (!sellerId) throw new Error("SP_API_SELLER_ID not set");
  const raw = arg("items");
  if (!raw) throw new Error("--items ASIN:SKU[,ASIN:SKU...] required");
  const items: RelistItem[] = raw.split(",").map((pair) => {
    const i = pair.indexOf(":");
    if (i < 0) throw new Error(`bad item "${pair}" — expected ASIN:SKU`);
    return { asin: pair.slice(0, i).trim().toUpperCase(), sku: pair.slice(i + 1).trim() };
  });
  const live = has("live");
  const openOnCreate = has("open");

  const { result, createdPairs } = await runRelist(items, { sellerId, openOnCreate, dryRun: !live });

  for (const p of result.perAsin) {
    const o: any = p.outcome;
    console.log(`\n===== ${o.asin}  → ${o.sku ?? "-"}  ${o.kind}${o.reason ? ` (${o.reason})` : ""}`);
    if (o.details) console.log(`  details: ${typeof o.details === "string" ? o.details : JSON.stringify(o.details)}`);
    if (o.payload) {
      const qty = findPaths(o.payload, (k) => /quantity/i.test(k) && k !== "max_order_quantity");
      const endAt = findPaths(o.payload, (k) => k === "end_at");
      const dg = o.payload?.attributes?.supplier_declared_dg_hz_regulation ?? null;
      console.log(`  checks: quantity=${qty.length ? qty.join("|") : "none"}  endAt=${endAt.length ? endAt.join("|") : "none"}  dg=${dg ? JSON.stringify(dg) : "none"}`);
      if (o.priceDetail) console.log(`  price: ${JSON.stringify(o.priceDetail)}`);
      console.log(`  payload: ${JSON.stringify(o.payload)}`);
    }
    if (o.submissionId || o.issues) console.log(`  submissionId: ${o.submissionId ?? "-"}  issues: ${JSON.stringify(o.issues ?? [])}`);
  }
  console.log(`\nnotes: ${JSON.stringify(result.notes)}`);

  if (!live || createdPairs.length === 0) return;

  const ids = await findRecentPendingIds(createdPairs);
  console.log(`\nLadder: ${ids.length} ledger row(s) for ${createdPairs.length} created`);
  let elapsed = 0;
  for (const m of LADDER_MIN) {
    await new Promise((r) => setTimeout(r, (m - elapsed) * 60_000));
    elapsed = m;
    const s = await verifyPending(sellerId, { ids, closeAfterCreate: (r) => closeAfterCreate(pool as any, sellerId, r) });
    const open = await countOpenAmong(ids);
    console.log(`  T+${m}m: checked=${s.checked} live=${s.live} failed=${s.failed} processing=${s.processing} stale=${s.stale} throttled=${s.throttled} — ${open} still open`);
    if (open === 0) break;
  }
}

main()
  .catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; })
  .finally(() => pool.end());
