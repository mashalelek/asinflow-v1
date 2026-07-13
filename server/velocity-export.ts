// Velocity prep-service upload export (phase 1: CSV; phase 2 will add an API
// delivery client that consumes the same records). Delivery-agnostic:
// buildVelocityRecords() returns plain record objects; serialization lives in
// serializeVelocityCsv(). See SPEC §11 "Velocity upload export".
import { fetchSheetRows } from "./google-sheets";
import { query as defaultQuery } from "./db";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

// Exact header + column order Velocity expects. Serialized CRLF.
export const VELOCITY_HEADERS = [
  "fulfillment_type", "date", "retailer", "order_number", "item_name", "color",
  "brand_sku", "size", "quantity", "asin", "amazon_sku", "unit_cost",
  "list_price", "client_notes", "trackings", "sold_as", "units_per_pack",
] as const;

export type VelocityRecord = Record<(typeof VELOCITY_HEADERS)[number], string>;

export type VelocitySkipReason = "no_live_sku" | "missing_quantity" | "unparseable_date";
export interface VelocitySkip {
  reason: VelocitySkipReason;
  orderNumber: string | null;
  asin: string;
  itemName: string | null;
}

export interface VelocityBuildResult {
  records: VelocityRecord[];
  selfPrepExcluded: number; // Col AS <= 0 / empty — intentional, not a skip
  skips: VelocitySkip[];
}

// Parse M/D/YYYY into a LOCAL midnight Date. Never new Date(str) — split + numeric
// constructor so format and timezone are unambiguous. Returns null if it doesn't
// parse (caller surfaces it, never silently drops).
export function parseMDY(s: string | null | undefined): Date | null {
  if (!s) return null;
  const parts = s.trim().split("/");
  if (parts.length !== 3) return null;
  const m = Number(parts[0]), d = Number(parts[1]), y = Number(parts[2]);
  if (![m, d, y].every(Number.isInteger)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000) return null;
  const dt = new Date(y, m - 1, d);
  // reject rollovers (e.g. 2/30 -> Mar 2)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

export function formatYMD(dt: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

// Local midnight for today (numeric constructor — not a string parse).
export function todayLocal(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function serializeVelocityCsv(records: VelocityRecord[]): string {
  const lines = [VELOCITY_HEADERS.join(",")];
  for (const r of records) lines.push(VELOCITY_HEADERS.map((h) => csvField(r[h] ?? "")).join(","));
  return lines.join("\r\n") + "\r\n"; // CRLF, trailing newline
}

export async function buildVelocityRecords(
  from: Date,
  to: Date,
  deps: { query?: QueryLike } = {},
): Promise<VelocityBuildResult> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not configured");

  const rows = await fetchSheetRows(sheetId);
  const skips: VelocitySkip[] = [];
  let selfPrepExcluded = 0;

  // Selection: date-range -> not-canceled -> prep > 0.
  const selected = [];
  const fromMs = from.getTime(), toMs = to.getTime();
  for (const row of rows) {
    const dt = parseMDY(row.orderDate);
    if (dt === null) {
      skips.push({ reason: "unparseable_date", orderNumber: row.orderNumber, asin: row.asin, itemName: row.itemName });
      continue;
    }
    const ms = dt.getTime();
    if (ms < fromMs || ms > toMs) continue; // out of range — silent, expected
    const status = (row.status ?? "").toLowerCase();
    if (status.includes("canceled")) continue; // canceled — silent, matches COGS sync
    const prep = row.prepCost == null ? 0 : row.prepCost; // empty AS on a real row = 0 (§3)
    if (!(prep > 0)) { selfPrepExcluded++; continue; } // self-prep — intentional, not a skip
    selected.push(row);
  }

  // SKU join: primary_sku where has_live_offer = TRUE. Batched.
  const asins = Array.from(new Set(selected.map((r) => r.asin)));
  const skuMap = new Map<string, string>();
  if (asins.length) {
    const res = await query(
      `SELECT asin, primary_sku FROM asins
        WHERE has_live_offer = TRUE AND primary_sku IS NOT NULL AND asin = ANY($1)`,
      [asins],
    );
    for (const r of res.rows) skuMap.set(r.asin, r.primary_sku);
  }

  const records: VelocityRecord[] = [];
  for (const row of selected) {
    const sku = skuMap.get(row.asin);
    if (!sku) {
      skips.push({ reason: "no_live_sku", orderNumber: row.orderNumber, asin: row.asin, itemName: row.itemName });
      continue;
    }
    if (row.quantity == null || row.quantity === "") {
      skips.push({ reason: "missing_quantity", orderNumber: row.orderNumber, asin: row.asin, itemName: row.itemName });
      continue;
    }
    records.push({
      fulfillment_type: "fba",
      date: row.orderDate ?? "",       // Col C verbatim
      retailer: row.retailer ?? "",    // Col E
      order_number: row.orderNumber ?? "", // Col B
      item_name: row.itemName ?? "",   // Col I
      color: "",
      brand_sku: "",
      size: "",
      quantity: row.quantity,          // Col AZ verbatim
      asin: row.asin,                  // Col H
      amazon_sku: sku,                 // joined primary_sku
      unit_cost: "",
      list_price: "",
      client_notes: "",
      trackings: "",
      sold_as: row.soldAs ?? "",       // Col AX verbatim
      units_per_pack: row.unitsPerPack ?? "", // Col AY verbatim
    });
  }

  return { records, selfPrepExcluded, skips };
}
