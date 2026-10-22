import { google } from "googleapis";
import { parseMoney } from "@shared/parse-money";

// ER leads sheet client (SPEC §11; patch er-leads-sheet-sync, 2026-10-22).
// "SAS Leads Sheet | ER" — ER_LEADS_SHEET_ID — tab **Leads** (gid 0). The tab
// name is hardcoded here, as in the other two sheet clients, so the clients
// never cross: on this tab col H is the buy link and col M the cost; on the
// Master `ASINs` tab those are N and S. Read-only. Row 1 is the header and
// must equal ER_HEADERS exactly (trimmed) — header drift throws with the diff,
// never a guessed column.
export const ER_TAB = "Leads";

/** Row 1, A–AM (39 cells), as of the 2026-10-22 pre-flight. F has no header (category). */
export const ER_HEADERS: readonly string[] = [
  "Approved", "Date", "ASIN", "Brand", "Product Name", "", "Amazon URL", "Buy Link", "Coupons/Gift Cards",
  "Profit", "R.O.I.", "Sales Rank (Current)", "Cost Price", "Reserved for Last Purchased COGS",
  "Buy Box (Current)", "Buy Box (Average Last 90 Days)", "Sale Price", "Sale Price (25% ROI)", "Breakeven",
  "Max Cost", "Profit Margin", "Estimated Sales", "Sales Rank (Current) Top %", "FBA Seller Count",
  "FBM Seller Count", "FBA Fee", "Referral Fee", "Referral Percent", "Inbound Shipping", "Total Fees",
  "Package Width (mm)", "Package Length (mm)", "Package Height (mm)", "Weight (grams)", "Cost with Shipping",
  "Emelie", "Buyable? (Emelie)", "Loom - Maria", "Maria",
];

const COL_APPROVED = 0; // A
const COL_DATE = 1;     // B — lead date; filter floor and added_at
const COL_ASIN = 2;     // C
const COL_BUY_LINK = 7; // H — buy_link; supplier via extractDomain
const COL_PROMO = 8;    // I — Coupons/Gift Cards → promo_notes
const COL_COGS = 12;    // M — Cost Price → estimated_cogs, per ASIN as-is
const COL_VA_NOTES = 35; // AJ — Emelie → "VA: " line
const COL_MY_NOTES = 38; // AM — Maria → bare line

export interface RawErRow {
  /** 1-based sheet row (row 2 = first data row) — for the report. */
  row: number;
  asin: string;
  approvedRaw: string;
  dateRaw: string;
  buyLink: string | null;
  promoNotes: string | null;
  cogs: number | null;
  vaNotes: string | null;
  myNotes: string | null;
}

export class ErHeaderDriftError extends Error {
  constructor(public diff: string[]) {
    super(`ER leads sheet header drift on tab ${ER_TAB} — ER leg aborted: ${diff.join("; ")}`);
  }
}

const colName = (i: number): string => { let s = ""; let n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/** Pure: differences between row 1 and ER_HEADERS (empty = matches). */
export function erHeaderDiff(row1: readonly unknown[]): string[] {
  const got = row1.map((v) => String(v ?? "").trim());
  const out: string[] = [];
  const n = Math.max(got.length, ER_HEADERS.length);
  for (let i = 0; i < n; i++) {
    const want = ER_HEADERS[i], have = got[i] ?? "";
    if (want === undefined) { if (have) out.push(`${colName(i)}: unexpected ${JSON.stringify(have)}`); continue; }
    if (have !== want) out.push(`${colName(i)}: expected ${JSON.stringify(want)}, found ${JSON.stringify(have)}`);
  }
  return out;
}

/** Pure: the values grid (row 1 = header) → rows with an ASIN. Throws ErHeaderDriftError on drift. */
export function parseErValues(values: readonly (readonly unknown[])[]): RawErRow[] {
  const diff = erHeaderDiff(values[0] ?? []);
  if (diff.length) throw new ErHeaderDriftError(diff);
  const cell = (r: readonly unknown[], i: number) => String(r[i] ?? "").trim();
  const out: RawErRow[] = [];
  for (let k = 1; k < values.length; k++) {
    const r = values[k] ?? [];
    const asin = cell(r, COL_ASIN).toUpperCase();
    if (!asin) continue;
    out.push({
      row: k + 1,
      asin,
      approvedRaw: cell(r, COL_APPROVED),
      dateRaw: cell(r, COL_DATE),
      buyLink: cell(r, COL_BUY_LINK) || null,
      promoNotes: cell(r, COL_PROMO) || null,
      cogs: parseMoney(r[COL_COGS] as any),
      vaNotes: cell(r, COL_VA_NOTES) || null,
      myNotes: cell(r, COL_MY_NOTES) || null,
    });
  }
  return out;
}

/** Read the Leads tab (header included). Returns the raw row count (data rows) and the parsed rows. */
export async function fetchErLeadsSheet(sheetId: string): Promise<{ rawRows: number; rows: RawErRow[] }> {
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!credPath) throw new Error("GOOGLE_CREDENTIALS_PATH not configured");
  const auth = new google.auth.GoogleAuth({ keyFile: credPath, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });
  let response;
  try {
    response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${ER_TAB}!A1:AM` });
  } catch (err: any) {
    if (err?.code === 403 || err?.response?.status === 403) {
      throw new Error(`ER leads sheet access denied (403). Share spreadsheet ${sheetId} with the service account configured at GOOGLE_CREDENTIALS_PATH.`);
    }
    throw err;
  }
  const values = (response.data.values ?? []) as unknown[][];
  return { rawRows: Math.max(0, values.length - 1), rows: parseErValues(values) };
}
