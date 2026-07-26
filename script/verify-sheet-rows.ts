// Verify the widened PO-sheet reader (server/google-sheets.ts).
//  - dumps the first 10 fetchSheetRows() objects: old (COGS-sync) fields vs new
//    (Velocity) fields side by side.
//  - counts rows where each new field is empty, and rows where ALL new fields
//    are empty.
//  - re-runs fetchSheetData() to show the COGS-sync output is intact.
// Run: npx tsx script/verify-sheet-rows.ts
import "dotenv/config";
import { fetchSheetRows, fetchSheetData } from "../server/google-sheets";

const SHEET = process.env.GOOGLE_SHEET_ID!;
const NEW = ["orderNumber", "orderDate", "retailer", "itemName", "soldAs", "unitsPerPack", "quantity"] as const;

async function main() {
  if (!SHEET) throw new Error("GOOGLE_SHEET_ID not set");

  const rows = await fetchSheetRows(SHEET);
  console.log(`fetchSheetRows: ${rows.length} rows (ASIN-bearing)\n`);

  console.log("=== first 10 rows — OLD (COGS-sync) fields ===");
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${r.asin.padEnd(11)} status=${JSON.stringify(r.status)} cogs=${r.cogs} prep=${r.prepCost} qty=${r.qty} supplier=${JSON.stringify(r.supplier)}`);
  }
  console.log("\n=== first 10 rows — NEW (Velocity) fields ===");
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${r.asin.padEnd(11)} order#=${JSON.stringify(r.orderNumber)} date=${JSON.stringify(r.orderDate)} retailer=${JSON.stringify(r.retailer)} item=${JSON.stringify((r.itemName ?? "").slice(0, 24))} sold_as=${JSON.stringify(r.soldAs)} upp=${JSON.stringify(r.unitsPerPack)} qty=${JSON.stringify(r.quantity)}`);
  }

  console.log("\n=== empties among new fields (of " + rows.length + " rows) ===");
  for (const f of NEW) {
    const n = rows.filter((r) => r[f] == null).length;
    console.log(`  ${f.padEnd(13)}: ${n} empty`);
  }
  const allEmpty = rows.filter((r) => NEW.every((f) => r[f] == null)).length;
  console.log(`  ALL 7 empty  : ${allEmpty} rows`);

  // COGS-sync output intact
  const byAsin = await fetchSheetData(SHEET);
  console.log(`\n=== fetchSheetData (COGS sync) still works: ${byAsin.size} unique ASINs ===`);
  const sample = Array.from(byAsin.entries()).slice(0, 3);
  for (const [asin, d] of sample) {
    console.log(`  ${asin.padEnd(11)} cogs=${d.cogs} prepCost=${d.prepCost} orderedQty=${d.orderedQty} supplier=${JSON.stringify(d.supplier)}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
