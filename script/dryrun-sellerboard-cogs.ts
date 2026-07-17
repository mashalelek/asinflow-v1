// Dry-run for the SellerBoard COGS export — no HTTP layer.
// Prints the summary + first 10 CSV rows for a local template xlsx.
// Run: PORT=<free> npx tsx script/dryrun-sellerboard-cogs.ts <template.xlsx>
import "dotenv/config";
import * as fs from "fs";
import { buildSellerboardCogs, serializeSbCsv, SB_HEADERS } from "../server/sellerboard-cogs";

const templatePath = process.argv[2];

async function main() {
  if (!templatePath) {
    console.error("usage: npx tsx script/dryrun-sellerboard-cogs.ts <template.xlsx>");
    process.exit(1);
  }
  const buf = fs.readFileSync(templatePath);
  const { rows, summary, details } = await buildSellerboardCogs(buf);

  console.log(`\n===== SELLERBOARD COGS DRY-RUN — ${templatePath.split("/").pop()} =====`);
  console.log(`rows emitted        : ${summary.rowsEmitted}`);
  console.log(`distinct ASINs       : ${summary.distinctAsins}`);
  console.log(`distinct periods     : ${summary.distinctPeriods}`);
  console.log(`template rows loaded : ${summary.templateRowsLoaded}  (across ${summary.templateAsins} template ASINs)`);
  console.log(`skips:`);
  console.log(`  bad/zero cost      : ${summary.skips.badOrZeroCost}`);
  console.log(`  bad/missing date   : ${summary.skips.badOrMissingDate}`);
  console.log(`  same-date conflict : ${summary.skips.sameDateConflict}`);
  console.log(`  not in SB (ASINs)  : ${summary.skips.notInSb}`);

  if (details.conflicts.length) {
    console.log(`\n===== same-date conflicts (first kept) =====`);
    for (const c of details.conflicts) console.log(`  ${c.asin} ${c.date}: kept ${c.kept.toFixed(2)}, ignored ${c.other.toFixed(2)}`);
  }
  if (details.notInSbAsins.length) {
    console.log(`\n===== not in SB (${details.notInSbAsins.length} PO ASINs with YTD periods, absent from template) =====`);
    console.log("  " + details.notInSbAsins.join(", "));
  }

  console.log(`\n===== first 10 CSV rows =====`);
  console.log(SB_HEADERS.join(","));
  for (const r of rows.slice(0, 10)) console.log(SB_HEADERS.map((h) => r[h]).join(","));

  // write full CSV for eyeballing
  const outPath = "/tmp/sb-cogs-dryrun.csv";
  fs.writeFileSync(outPath, serializeSbCsv(rows));
  console.log(`\nfull CSV written to ${outPath} (${rows.length} rows)`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
