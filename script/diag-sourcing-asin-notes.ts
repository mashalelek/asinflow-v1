// Read-only throwaway. Diagnoses why notes aren't populating for B0CP7CFNK4.
// Inlines fetchSourcingSheet's logic (server/sourcing-sheet.ts imports log
// from server/index.ts, which would bootstrap Express). Also inlines
// buildNotes (private in server/sourcing-sync.ts). Logic mirrored verbatim
// from those modules — kept in sync manually for this one-off.

import "dotenv/config";
import { google } from "googleapis";
import { parseMoney } from "../shared/parse-money";

const COL_STATUS = 4;     // E
const COL_ASIN = 8;       // I
const COL_BUY_LINK = 13;  // N
const COL_COGS = 18;      // S
const COL_VA_NOTES = 41;  // AP
const COL_MY_NOTES = 44;  // AS

// Mirrored from server/sourcing-sync.ts:25-30 (private there).
function buildNotes(myNotes: string | null, vaNotes: string | null): string | null {
  const lines: string[] = [];
  if (myNotes) lines.push(`My notes: ${myNotes}`);
  if (vaNotes) lines.push(`VA notes: ${vaNotes}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

const TARGET = "B0CP7CFNK4";

(async () => {
  const sheetId = process.env.SOURCING_SHEET_ID;
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!sheetId) { console.error("SOURCING_SHEET_ID not set"); process.exit(1); }
  if (!credPath) { console.error("GOOGLE_CREDENTIALS_PATH not set"); process.exit(1); }

  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "ASINs!A2:AS",
  });

  const rows = response.data.values || [];
  const matching = rows.filter((row) => ((row[COL_ASIN] ?? "").toString().trim()) === TARGET);

  console.log(`\nTotal sheet rows: ${rows.length}`);
  console.log(`Rows matching ASIN ${TARGET}: ${matching.length}\n`);

  if (matching.length === 0) {
    console.log(`No rows for ${TARGET} in the sheet.`);
    process.exit(0);
  }

  matching.forEach((row, i) => {
    console.log(`=== Row ${i + 1} ===`);
    console.log(`Raw Col AP (index ${COL_VA_NOTES}):  ${JSON.stringify(row[COL_VA_NOTES])}`);
    console.log(`Raw Col AS (index ${COL_MY_NOTES}):  ${JSON.stringify(row[COL_MY_NOTES])}`);
    console.log(`Row length: ${row.length}  (sheet returned ${row.length} cells for this row)`);

    // Replicate fetchSourcingSheet's row → object mapping verbatim
    const asin = (row[COL_ASIN] ?? "").toString().trim();
    const status = (row[COL_STATUS] ?? "").toString();
    const buyLinkRaw = (row[COL_BUY_LINK] ?? "").toString().trim();
    const vaNotesRaw = (row[COL_VA_NOTES] ?? "").toString().trim();
    const myNotesRaw = (row[COL_MY_NOTES] ?? "").toString().trim();
    const parsed = {
      asin,
      status,
      buyLink: buyLinkRaw || null,
      cogs: parseMoney(row[COL_COGS]),
      vaNotes: vaNotesRaw || null,
      myNotes: myNotesRaw || null,
    };
    console.log(`\nParsed row object (what fetchSourcingSheet returns):`);
    console.log(JSON.stringify(parsed, null, 2));

    const notes = buildNotes(parsed.myNotes, parsed.vaNotes);
    console.log(`\nbuildNotes(myNotes, vaNotes) → ${JSON.stringify(notes)}`);
    console.log();
  });

  process.exit(0);
})().catch((err) => {
  console.error("Diag failed:", err.message);
  process.exit(1);
});
