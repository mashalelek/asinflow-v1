// DRY-RUN ONLY. Calls the Aura cost-sync module and prints the diff table +
// summary footer. No POSTs to Aura, no AF DB writes.
import "dotenv/config";
import { buildAuraDryRun, fmtCost, type DryRunRow } from "../server/aura-cost-sync";

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

function printRow(r: DryRunRow) {
  console.log(
    [
      pad(r.sku, 16),
      pad(r.asin ?? "—", 22),
      pad(r.auraStatus, 9),
      pad(r.repricing ? "yes" : "no", 5),
      pad(fmtCost(r.currentAuraCost), 9),
      pad(fmtCost(r.computedCost), 9),
      r.verdict + (r.noPoPrep ? "  [no PO prep]" : ""),
    ].join(" | "),
  );
}

function header() {
  console.log(
    [pad("sku", 16), pad("asin", 22), pad("aura stat", 9), pad("repr", 5), pad("cur cost", 9), pad("new cost", 9), "verdict"].join(" | "),
  );
  console.log("-".repeat(96));
}

(async () => {
  const { rows, summary } = await buildAuraDryRun();

  console.log(`\n=== AURA COST SYNC — DRY RUN (${summary.totalListings} amazon listings) ===\n`);
  header();
  rows.forEach(printRow);

  console.log(`\n=== SUMMARY ===`);
  console.log("verdicts:");
  for (const [k, v] of Object.entries(summary.perVerdict)) console.log(`  ${pad(k, 20)} ${v}`);
  console.log("aura status:");
  for (const [k, v] of Object.entries(summary.perStatus)) console.log(`  ${pad(k, 20)} ${v}`);
  console.log(`"no PO prep" flags: ${summary.noPoPrepCount}`);
  process.exit(0);
})().catch((e) => { console.error("DRY RUN FAILED:", e?.message ?? e); process.exit(1); });
