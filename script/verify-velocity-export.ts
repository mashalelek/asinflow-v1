// Verify the Velocity export for a given date range.
//   (a) full record list (the CSV), (b) skip summary w/ reasons + identity,
//   (c) self-prep excluded count, (d) reconciliation vs total in-range rows.
// Writes the CSV to /tmp for eyeballing.
// Run: npx tsx script/verify-velocity-export.ts <from M/D/YYYY> [to M/D/YYYY]
//   e.g. npx tsx script/verify-velocity-export.ts 7/12/2026
import "dotenv/config";
import * as fs from "fs";
import { buildVelocityRecords, serializeVelocityCsv, parseMDY } from "../server/velocity-export";
import { fetchSheetRows } from "../server/google-sheets";

const fromArg = process.argv[2];
const toArg = process.argv[3] ?? fromArg;
if (!fromArg) {
  console.error("Usage: npx tsx script/verify-velocity-export.ts <from M/D/YYYY> [to M/D/YYYY]");
  process.exit(1);
}
const FROM = parseMDY(fromArg);
const TO = parseMDY(toArg);
if (!FROM || !TO) {
  console.error(`Unparseable date(s): from=${JSON.stringify(fromArg)} to=${JSON.stringify(toArg)} (expected M/D/YYYY)`);
  process.exit(1);
}
const RANGE = fromArg === toArg ? fromArg : `${fromArg}–${toArg}`;
const CSV_PATH = `/tmp/velocity-upload-${FROM.toISOString().slice(0, 10)}_${TO.toISOString().slice(0, 10)}.csv`;

async function main() {
  const { records, selfPrepExcluded, skips } = await buildVelocityRecords(FROM!, TO!);

  const csv = serializeVelocityCsv(records);
  fs.writeFileSync(CSV_PATH, csv);

  console.log(`===== (a) RECORD LIST — ${records.length} records (CSV written to ${CSV_PATH}) =====`);
  process.stdout.write(csv.replace(/\r\n/g, "\n")); // print readable
  console.log(`--- (raw serialized bytes: ${Buffer.byteLength(csv)} , CRLF line endings) ---`);

  console.log(`\n===== (b) SKIP SUMMARY — ${skips.length} skips =====`);
  const byReason: Record<string, number> = {};
  for (const s of skips) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
  console.log(byReason);
  for (const s of skips.slice(0, 25)) {
    console.log(`  ${s.reason.padEnd(16)} order#=${s.orderNumber ?? "-"} asin=${s.asin} item=${JSON.stringify((s.itemName ?? "").slice(0, 30))}`);
  }
  if (skips.length > 25) console.log(`  … +${skips.length - 25} more`);

  console.log(`\n===== (c) SELF-PREP EXCLUDED (intentional, not a skip) = ${selfPrepExcluded} =====`);

  // (d) reconciliation vs total in-range rows on the sheet
  const rows = await fetchSheetRows(process.env.GOOGLE_SHEET_ID!);
  const inRange = (r: any) => {
    const d = parseMDY(r.orderDate);
    return !!d && d.getTime() >= FROM!.getTime() && d.getTime() <= TO!.getTime();
  };
  const rowsInRange = rows.filter(inRange);
  const canceledInRange = rowsInRange.filter((r) => (r.status ?? "").toLowerCase().includes("canceled")).length;
  const skipsInRange = skips.filter((s) => s.reason !== "unparseable_date").length; // these came from in-range selected rows
  const unparseable = skips.filter((s) => s.reason === "unparseable_date").length; // NOT in-range (can't date)

  console.log(`\n===== (d) RECONCILIATION vs total ${RANGE} rows =====`);
  console.log(`  total ${RANGE} ASIN-rows on sheet : ${rowsInRange.length}`);
  console.log(`    = records (${records.length}) + self-prep (${selfPrepExcluded}) + skips-in-range (${skipsInRange}) + canceled-in-range (${canceledInRange})`);
  const sum = records.length + selfPrepExcluded + skipsInRange + canceledInRange;
  console.log(`    = ${sum}  ${sum === rowsInRange.length ? "✓ RECONCILES" : "✗ MISMATCH"}`);
  console.log(`  (unparseable_date skips are sheet-wide, not in-range: ${unparseable})`);
  process.exit(sum === rowsInRange.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
