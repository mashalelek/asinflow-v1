// DIAGNOSTIC ONLY — read-only (spreadsheets.readonly). No writes anywhere.
// Reuses the PO sync's exact input: env GOOGLE_SHEET_ID + GOOGLE_CREDENTIALS_PATH,
// tab/range "Sheet1!..." (note: google-sheets.ts reads "Sheet1", not a tab named
// "Orders"). Prints header letters for H/Y/AS/status, then raw rows for 5 ASINs
// that appear on multiple rows.
import "dotenv/config";
import { google } from "googleapis";

const COL_STATUS = 3;   // D
const COL_ASIN = 7;     // H
const COL_COGS = 24;    // Y
const COL_PREP = 44;    // AS

// 0-based column index → spreadsheet column letter.
function colLetter(i: number): string {
  let s = "", n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
const cell = (row: any[], i: number) => (row[i] === undefined || row[i] === null) ? "" : String(row[i]);

async function main() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!sheetId || !credPath) throw new Error("GOOGLE_SHEET_ID / GOOGLE_CREDENTIALS_PATH not set");

  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // (a) Header row 1
  const hdr = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Sheet1!A1:AS1" })).data.values?.[0] ?? [];
  console.log("=== HEADER (row 1), tab 'Sheet1' ===");
  for (const [label, idx] of [["ASIN match", COL_ASIN], ["status", COL_STATUS], ["COGS", COL_COGS], ["prep", COL_PREP]] as [string, number][]) {
    console.log(`  Col ${colLetter(idx).padEnd(2)} (idx ${idx})  ${label.padEnd(11)} = ${JSON.stringify(cell(hdr, idx))}`);
  }

  // Data rows (A2:AS) — row numbers are +2 (A2 is sheet row 2).
  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Sheet1!A2:AS" })).data.values ?? [];
  const byAsin = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const asin = cell(r, COL_ASIN).trim();
    if (!asin) return;
    (byAsin.get(asin) ?? byAsin.set(asin, []).get(asin)!).push(i);
  });

  const multi = [...byAsin.entries()].filter(([, idxs]) => idxs.length > 1).slice(0, 5);
  console.log(`\n=== 5 ASINs on multiple rows (of ${[...byAsin.values()].filter(a => a.length > 1).length} multi-row ASINs) ===`);
  for (const [asin, idxs] of multi) {
    console.log(`\nASIN ${asin} — ${idxs.length} rows:`);
    console.log(`  ${"row".padStart(5)} | ${"Col H".padEnd(12)} | ${"Col D status".padEnd(22)} | ${"Col Y COGS".padEnd(12)} | Col AS prep`);
    for (const i of idxs) {
      const r = rows[i];
      console.log(`  ${String(i + 2).padStart(5)} | ${cell(r, COL_ASIN).padEnd(12)} | ${JSON.stringify(cell(r, COL_STATUS)).padEnd(22)} | ${JSON.stringify(cell(r, COL_COGS)).padEnd(12)} | ${JSON.stringify(cell(r, COL_PREP))}`);
    }
  }
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exit(1); });
