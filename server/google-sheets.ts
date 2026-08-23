import { google } from "googleapis";
import { log } from "./index";
import { parseMoney } from "@shared/parse-money";

// Column indices (0-based from col A)
const COL_STATUS = 3;   // D
const COL_SUPPLIER = 4; // E
const COL_ASIN = 7;     // H
const COL_SHIPPED = 14; // O — ASIN Qty Shipped FBA
const COL_QTY = 20;     // U
const COL_COGS = 24;    // Y
const COL_PREP = 44;    // AS — Prep cost per unit

// Velocity export fields (0-based). Additive — NOT read by the COGS sync path
// (fetchSheetData); consumed only by fetchSheetRows below.
const COL_ORDER_NUMBER = 1;    // B
const COL_ORDER_DATE = 2;      // C
const COL_RETAILER = 4;        // E — same column as supplier
const COL_ITEM_NAME = 8;       // I
const COL_SOLD_AS = 49;        // AX
const COL_UNITS_PER_PACK = 50; // AY
const COL_QUANTITY = 51;       // AZ

export interface SheetAsinData {
  cogs: number | null;
  prepCost: number | null;
  orderedQty: number;
  supplier: string | null;
}

// Shared read: auth + values.get. Extracted so fetchSheetData and fetchSheetRows
// use one range. Widened to A2:AZ for the Velocity fields — existing COGS-sync
// columns (all <= AS) read the same indices, and Google trims trailing empties,
// so the widened range is byte-identical for the COGS parsing below.
async function getSheetValues(sheetId: string, range: string): Promise<any[][]> {
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

// Meta-returning variant of the COGS-sync read. rawRowsRead is the raw row
// count the API returned for the range — the truncation tripwire the
// ordered_qty clearing pass fails closed on (SPEC §11): rawRowsRead = 0 means
// an empty/failed read, and clearing against it would zero the whole catalog.
export interface SheetDataResult {
  data: Map<string, SheetAsinData>;
  rawRowsRead: number;
}

export async function fetchSheetDataWithMeta(sheetId: string): Promise<SheetDataResult> {
  const rows = await getSheetValues(sheetId, "Sheet1!A2:AZ");
  const result = new Map<string, SheetAsinData>();

  for (const row of rows) {
    const asin = (row[COL_ASIN] ?? "").toString().trim();
    if (!asin) continue;

    const status = (row[COL_STATUS] ?? "").toString().trim().toLowerCase();
    const isCanceled = status.includes("canceled");
    const isClosed = status.includes("closed");

    const existing = result.get(asin);

    // COGS + prep cost + supplier: first non-canceled row per ASIN
    if (!isCanceled && existing?.cogs == null) {
      const cogs = parseMoney(row[COL_COGS]);
      const prepCost = parseMoney(row[COL_PREP]);
      // Empty prep cell on a real PO row = deliberate $0 (not "no data")
      const resolvedPrep = prepCost == null ? 0 : prepCost;
      const supplier = (row[COL_SUPPLIER] ?? "").toString().trim() || null;

      if (!existing) {
        result.set(asin, { cogs, prepCost: resolvedPrep, orderedQty: 0, supplier });
      } else {
        result.set(asin, {
          ...existing,
          cogs,
          prepCost: resolvedPrep,
          supplier: supplier ?? existing.supplier,
        });
      }
    }

    // Ordered qty: sum (qty - shipped) for all non-closed, non-canceled rows.
    // NOTE: this status rule DELIBERATELY differs from the SellerBoard COGS
    // export (sellerboard-cogs.ts), which excludes only canceled: here we want
    // qty still on order, so closed (fully received) POs must not count; there
    // we want completed purchase history, so closed POs must count.
    if (!isClosed && !isCanceled) {
      const qtyRaw = (row[COL_QTY] ?? "").toString().trim();
      const shippedRaw = (row[COL_SHIPPED] ?? "").toString().trim();
      const qty = parseFloat(qtyRaw) || 0;
      const shipped = parseFloat(shippedRaw) || 0;
      const net = Math.max(0, qty - shipped);
      if (net > 0) {
        const current = result.get(asin);
        if (current) {
          result.set(asin, { ...current, orderedQty: current.orderedQty + net });
        } else {
          result.set(asin, { cogs: null, prepCost: null, orderedQty: net, supplier: null });
        }
      }
    }
  }

  log(`Sheet fetch: ${rows.length} rows, ${result.size} unique ASINs`, "sheets");
  return { data: result, rawRowsRead: rows.length };
}

export async function fetchSheetData(sheetId: string): Promise<Map<string, SheetAsinData>> {
  return (await fetchSheetDataWithMeta(sheetId)).data;
}

// Per-row view of the PO sheet — the existing COGS columns (parsed identically
// to fetchSheetData) plus the Velocity export fields, WITHOUT the ASIN-collapse.
// Additive: the COGS sync does not use this. Feeds the upcoming Velocity upload.
export interface SheetRow {
  sheetRow: number;        // 1-based row number in the sheet (A2 = row 2)
  // existing columns (per-row)
  status: string | null;   // D
  asin: string;            // H
  cogs: number | null;     // Y  (parseMoney)
  prepCost: number | null; // AS (parseMoney)
  qty: number | null;      // U  (parseFloat)
  qtyRaw: string;          // U  verbatim (untrimmed cell), for skip diagnostics
  supplier: string | null; // E
  // Velocity export fields
  orderNumber: string | null;  // B
  orderDate: string | null;    // C
  retailer: string | null;     // E (alias of the supplier column)
  itemName: string | null;     // I
  soldAs: string | null;       // AX — verbatim
  unitsPerPack: string | null; // AY — verbatim
  quantity: string | null;     // AZ — verbatim
}

// Trim to string, empty → null. Velocity fields pass through verbatim otherwise.
function cellStr(v: any): string | null {
  if (v == null) return null;
  const s = v.toString();
  return s === "" ? null : s;
}

// Row-accounting metadata alongside the parsed rows, for callers that must
// prove nothing exited silently (SellerBoard COGS export). rawRowsRead is the
// total row count the API returned for the range — an upstream-truncation
// tripwire; blankAsinRows is how many of those were dropped for a blank Col H.
export interface SheetRowsResult {
  rows: SheetRow[];
  rawRowsRead: number;
  blankAsinRows: number;
}

export async function fetchSheetRowsWithMeta(sheetId: string): Promise<SheetRowsResult> {
  const rows = await getSheetValues(sheetId, "Sheet1!A2:AZ");
  const out: SheetRow[] = [];
  let blankAsinRows = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const asin = (row[COL_ASIN] ?? "").toString().trim();
    if (!asin) { blankAsinRows++; continue; } // spacer/blank rows — same domain as fetchSheetData, but counted
    const qtyRaw = row[COL_QTY] == null ? "" : String(row[COL_QTY]); // verbatim, untrimmed
    const qtyTrim = qtyRaw.trim();
    out.push({
      sheetRow: i + 2, // range starts at A2, so rows[0] is sheet row 2
      status: cellStr(row[COL_STATUS]),
      asin,
      cogs: parseMoney(row[COL_COGS]),
      prepCost: parseMoney(row[COL_PREP]),
      qty: qtyTrim === "" ? null : (parseFloat(qtyTrim) || 0),
      qtyRaw,
      supplier: (row[COL_SUPPLIER] ?? "").toString().trim() || null,
      orderNumber: cellStr(row[COL_ORDER_NUMBER]),
      orderDate: cellStr(row[COL_ORDER_DATE]),
      retailer: cellStr(row[COL_RETAILER]),
      itemName: cellStr(row[COL_ITEM_NAME]),
      soldAs: cellStr(row[COL_SOLD_AS]),
      unitsPerPack: cellStr(row[COL_UNITS_PER_PACK]),
      quantity: cellStr(row[COL_QUANTITY]),
    });
  }
  return { rows: out, rawRowsRead: rows.length, blankAsinRows };
}

export async function fetchSheetRows(sheetId: string): Promise<SheetRow[]> {
  return (await fetchSheetRowsWithMeta(sheetId)).rows;
}
