// One-off backfill of asins.has_live_offer for every in_catalog=TRUE ASIN
// (including the ~63 in_catalog=TRUE + is_catalog_deleted=TRUE rows — we never
// infer FALSE from product-deletion; they get real getListingsItem checks).
//
// Shares the multi-SKU logic with the daily pass via checkAsinLiveOffer.
//
//   Dry-run (default): probes and tallies verdicts, writes NOTHING.
//   --apply:           writes has_live_offer + offer_checked_at for definitive
//                      live / no_offer verdicts; skips (writes nothing) on any
//                      transient/indeterminate result.
//   --limit=N:         cap the number of ASINs (for a fast sample dry-run).
//
// Run: npx tsx script/backfill-has-live-offer.ts            (dry-run, all)
//      npx tsx script/backfill-has-live-offer.ts --limit=120
//      npx tsx script/backfill-has-live-offer.ts --apply
import "dotenv/config";
import { query } from "../server/db";
import { checkAsinLiveOffer } from "../server/live-offer-check";

const SELLER_ID = process.env.SP_API_SELLER_ID!;
const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const PACING_MS = 260; // between ASINs — getListingsItem limit is 5 req/s
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!SELLER_ID) throw new Error("SP_API_SELLER_ID not set");

  const rows = (await query(
    `SELECT a.asin
       FROM asins a
      WHERE a.in_catalog = TRUE
      ORDER BY a.added_at ASC
      ${LIMIT ? "LIMIT " + LIMIT : ""}`,
  )).rows as { asin: string }[];

  console.log(
    `${APPLY ? "APPLY" : "DRY-RUN"} — ${rows.length} in_catalog=TRUE ASINs` +
    `${LIMIT ? ` (sample, --limit=${LIMIT})` : " (full population)"}\n`,
  );

  const tally = { live: 0, no_offer: 0, skip_transient: 0, skip_no_sku: 0 };
  const preview: string[] = [];
  const transientSkips: string[] = []; // retried after the main pass (--apply)
  let i = 0;
  for (const { asin } of rows) {
    const res = await checkAsinLiveOffer(asin, SELLER_ID, { applyDiscoveries: APPLY });
    if (res.verdict === "skip") {
      if (res.skipReason === "no_sku") tally.skip_no_sku++;
      else { tally.skip_transient++; transientSkips.push(asin); }
    } else {
      tally[res.verdict]++;
    }
    i++;

    if (preview.length < 10) {
      const detail =
        res.verdict === "live" ? `live  (sku=${res.liveSku} [${(res.statuses ?? []).join(",")}])`
        : res.verdict === "no_offer" ? `no_offer (all ${res.skusChecked} SKUs 404)`
        : res.skipReason === "no_sku" ? `skip  (no SKUs — not probed)`
        : `skip  (transient)`;
      preview.push(`  ${asin.padEnd(12)} ${detail}`);
    }

    if (APPLY && res.verdict !== "skip") {
      await query(
        `UPDATE asins SET has_live_offer = $2, offer_checked_at = now() WHERE asin = $1`,
        [asin, res.verdict === "live"],
      );
    }

    if (i % 100 === 0) console.log(`  …${i}/${rows.length} (live=${tally.live} no_offer=${tally.no_offer} skip_t=${tally.skip_transient} skip_nosku=${tally.skip_no_sku})`);
    await sleep(PACING_MS);
  }

  // Retry pass: ONLY transient skips (no-SKU ASINs have nothing to probe).
  let retryResolved = 0;
  if (APPLY && transientSkips.length > 0) {
    console.log(`\n=== retry pass: ${transientSkips.length} transient skips ===`);
    for (const asin of transientSkips) {
      const res = await checkAsinLiveOffer(asin, SELLER_ID, { applyDiscoveries: APPLY });
      if (res.verdict !== "skip") {
        await query(
          `UPDATE asins SET has_live_offer = $2, offer_checked_at = now() WHERE asin = $1`,
          [asin, res.verdict === "live"],
        );
        retryResolved++;
        if (res.verdict === "live") tally.live++; else tally.no_offer++;
        tally.skip_transient--;
      }
      await sleep(PACING_MS);
    }
    console.log(`  retry resolved ${retryResolved}/${transientSkips.length}; ${tally.skip_transient} still transient`);
  }

  console.log(`\n=== first ${preview.length} rows ===`);
  preview.forEach((l) => console.log(l));

  console.log(`\n=== VERDICT TOTALS (${APPLY ? "written" : "dry-run, nothing written"}) ===`);
  console.log(`  TRUE  (live)         : ${tally.live}`);
  console.log(`  FALSE (no_offer)     : ${tally.no_offer}`);
  console.log(`  SKIP transient       : ${tally.skip_transient}  (429/5xx/timeout — retryable)`);
  console.log(`  SKIP no-SKU          : ${tally.skip_no_sku}  (zero asin_skus rows — not probed)`);
  console.log(`  total probed         : ${rows.length}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
