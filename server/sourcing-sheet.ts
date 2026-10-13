import { google } from "googleapis";
import { log } from "./index";
import { parseMoney } from "@shared/parse-money";

// Sourcing sheet column indices (0-based from col A) — tab "ASINs".
// NOTE: do NOT confuse with the PO sync's `Sheet1` tab in google-sheets.ts.
// On the PO tab, Col AS = Prep cost. On THIS sheet's `ASINs` tab,
// Col AS = "My notes". Keep the tab name explicit so the two never cross.
const COL_STATUS = 4;     // E  — drives archive on insert
const COL_LEAD_SOURCE = 6;// G  — §6 lead source, normalised to the enum
const COL_ASIN = 8;       // I  — match key
const COL_BUY_LINK = 13;  // N  — buy_link; supplier derived via extractDomain
const COL_PROMO = 14;     // O  — "Coupons/Gift Cards/Sales" → promo_notes
const COL_COGS = 18;      // S  — estimated_cogs, parsed via parseMoney
const COL_VA_NOTES = 41;  // AP — VA notes
const COL_MY_NOTES = 44;  // AS — My notes

export interface RawSourcingRow {
  asin: string;
  status: string;
  /** §6 col G, RAW — normalisation to the enum happens in the sync, which
      also reports the distinct unrecognised strings. */
  leadSourceRaw: string | null;
  buyLink: string | null;
  cogs: number | null;
  promoNotes: string | null;
  vaNotes: string | null;
  myNotes: string | null;
}

export async function fetchSourcingSheet(sheetId: string): Promise<RawSourcingRow[]> {
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!credPath) throw new Error("GOOGLE_CREDENTIALS_PATH not configured");

  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  let response;
  try {
    response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "ASINs!A2:AS",
    });
  } catch (err: any) {
    if (err?.code === 403 || err?.response?.status === 403) {
      throw new Error(
        `Sourcing sheet access denied (403). Share spreadsheet ${sheetId} with the service account configured at GOOGLE_CREDENTIALS_PATH.`,
      );
    }
    throw err;
  }

  const rows = response.data.values || [];
  const out: RawSourcingRow[] = [];

  for (const row of rows) {
    const asin = (row[COL_ASIN] ?? "").toString().trim();
    if (!asin) continue;

    const status = (row[COL_STATUS] ?? "").toString();
    const leadSourceRaw = (row[COL_LEAD_SOURCE] ?? "").toString().trim();
    const buyLinkRaw = (row[COL_BUY_LINK] ?? "").toString().trim();
    const promoRaw = (row[COL_PROMO] ?? "").toString().trim();
    const vaNotesRaw = (row[COL_VA_NOTES] ?? "").toString().trim();
    const myNotesRaw = (row[COL_MY_NOTES] ?? "").toString().trim();

    out.push({
      asin,
      status,
      leadSourceRaw: leadSourceRaw || null,
      buyLink: buyLinkRaw || null,
      cogs: parseMoney(row[COL_COGS]),
      promoNotes: promoRaw || null,
      vaNotes: vaNotesRaw || null,
      myNotes: myNotesRaw || null,
    });
  }

  log(`Sourcing sheet fetch: ${rows.length} rows, ${out.length} with ASIN`, "sheets");
  return out;
}
