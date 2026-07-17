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
  console.log(`  bad qty            : ${summary.skips.badQty}`);
  console.log(`  same-date merged   : ${summary.skips.sameDateMerged}`);
  console.log(`  not in SB (ASINs)  : ${summary.skips.notInSb}`);

  if (details.merges.length) {
    console.log(`\n===== same-date merges (qty-weighted) =====`);
    for (const m of details.merges) console.log(`  ${m.asin} ${m.date}: ${m.count} rows → qty ${m.qty} @ ${m.cost.toFixed(2)}`);
  }
  if (details.badQtyRows.length) {
    console.log(`\n===== badQty rows (${details.badQtyRows.length}), grouped by mode =====`);
    for (const mode of ["empty", "non_numeric", "non_positive", "non_integer"] as const) {
      const g = details.badQtyRows.filter((r) => r.mode === mode);
      if (!g.length) continue;
      console.log(`  ── ${mode} (${g.length}) ──`);
      for (const r of g) console.log(`    row ${r.sheetRow}  ${r.asin}  ${r.date}  Col U="${r.rawQty}"  cost ${r.cost.toFixed(2)}`);
    }
  }
  if (details.notInSbAsins.length) {
    console.log(`\n===== not in SB (${details.notInSbAsins.length} PO ASINs with YTD periods, absent from template) =====`);
    console.log("  " + details.notInSbAsins.join(", "));
  }

  console.log(`\n===== first 10 CSV rows (full ${SB_HEADERS.length}-column layout) =====`);
  // Serialize just the first 10 so the printed rows match the file byte-for-byte
  // (all 15 columns, empties as blanks).
  process.stdout.write(serializeSbCsv(rows.slice(0, 10)).replace(/\r\n/g, "\n"));

  // write full CSV for eyeballing
  const outPath = "/tmp/sb-cogs-dryrun.csv";
  fs.writeFileSync(outPath, serializeSbCsv(rows));
  console.log(`\nfull CSV written to ${outPath} (${rows.length} rows)`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
