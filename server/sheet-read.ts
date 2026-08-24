// Shared raw Google Sheets read: auth + values.get for one range. Extracted
// from google-sheets.ts (2026-08-24) so the PO importer can use the exact
// same read path as the PO sync WITHOUT importing google-sheets.ts — that
// module imports ./index (log), and ./index boots Express at module load,
// which a standalone script must never trigger.
import { google } from "googleapis";

export async function getSheetValues(sheetId: string, range: string): Promise<any[][]> {
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!credPath) throw new Error("GOOGLE_CREDENTIALS_PATH not configured");

  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });
  return response.data.values || [];
}
