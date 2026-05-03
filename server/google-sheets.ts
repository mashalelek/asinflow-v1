import { google } from "googleapis";
import { log } from "./index";

// Column indices (0-based from col A)
const COL_STATUS = 3;   // D
const COL_SUPPLIER = 4; // E
const COL_ASIN = 7;     // H
const COL_SHIPPED = 14; // O — ASIN Qty Shipped FBA
const COL_QTY = 20;     // U
const COL_COGS = 24;    // Y
const COL_PREP = 44;    // AS — Prep cost per unit

export interface SheetAsinData {
  cogs: number | null;
  prepCost: number | null;
  orderedQty: number;
  supplier: string | null;
}

export async function fetchSheetData(sheetId: string): Promise<Map<string, SheetAsinData>> {
  const credPath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!credPath) throw new Error("GOOGLE_CREDENTIALS_PATH not configured");

  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A2:AS",
  });

  const rows = response.data.values || [];
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
      const cogsRaw = (row[COL_COGS] ?? "").toString().replace(/[$,]/g, "").trim();
      const cogs = parseFloat(cogsRaw);
      const prepRaw = (row[COL_PREP] ?? "").toString().replace(/[$,]/g, "").trim();
      const prepCost = parseFloat(prepRaw);
      const supplier = (row[COL_SUPPLIER] ?? "").toString().trim() || null;

      if (!existing) {
        result.set(asin, { cogs: isNaN(cogs) ? null : cogs, prepCost: isNaN(prepCost) ? null : prepCost, orderedQty: 0, supplier });
      } else {
        result.set(asin, {
          ...existing,
          cogs: isNaN(cogs) ? null : cogs,
          prepCost: isNaN(prepCost) ? null : prepCost,
          supplier: supplier ?? existing.supplier,
        });
      }
    }

    // Ordered qty: sum (qty - shipped) for all non-closed, non-canceled rows
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
  return result;
}
