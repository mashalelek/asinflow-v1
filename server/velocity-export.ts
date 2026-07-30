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

export type VelocitySkipReason =
  | "no_live_sku"
  | "missing_quantity"
  | "unparseable_date"
  | "bundle_unsupported"   // sold_as=bundle — we don't do bundles; flat CSV can't carry bundle_items
  | "invalid_pack_math";   // multi-pack with bad units_per_pack or qty not divisible by it
export interface VelocitySkip {
  reason: VelocitySkipReason;
  orderNumber: string | null;
  asin: string;
  itemName: string | null;
  // Verbatim sheet fields for the skipped row — lets the Upload-to-Velocity
  // dialog promote a fixed row (e.g. after Create SKU & include) into NEW
  // ORDERS without re-fetching the whole set (SPEC §11).
  row?: {
    date: string | null;
    retailer: string | null;
    quantity: string | null;
    soldAs: string | null;
    unitsPerPack: string | null;
  };
}

export interface VelocityBuildResult {
  records: VelocityRecord[];
  selfPrepExcluded: number; // Col AS <= 0 / empty — intentional, not a skip
  skips: VelocitySkip[];
  // Order-date floor (SPEC §11): creation clamp applied inside the builder so
  // every delivery path (CSV export, API upload) inherits it.
  requestedFrom: Date;
  effectiveFrom: Date;      // max(requestedFrom, floor)
  clamped: boolean;         // effectiveFrom > requestedFrom
  rangeBeforeFloor: boolean; // entire [from, to] before floor → zero records
}

// Order-date floor: orders dated before VELOCITY_MIN_ORDER_DATE must never be
// CREATED in Velocity via any path (pre-floor history was uploaded manually;
// recreating it would duplicate orders Velocity already has or intentionally
// closed). Fail-fast: a missing/unparseable floor is a config error, never
// "no floor". Gates CREATION only — reconciliation audits matched existing
// orders regardless of floor (SPEC §11).
export function getVelocityMinOrderDate(): Date {
  const raw = process.env.VELOCITY_MIN_ORDER_DATE;
  if (!raw) {
    throw new Error("VELOCITY_MIN_ORDER_DATE not set (M/D/YYYY) — refusing to build Velocity records without a creation floor");
  }
  const d = parseMDY(raw);
  if (!d) {
    throw new Error(`VELOCITY_MIN_ORDER_DATE unparseable: ${JSON.stringify(raw)} (expected M/D/YYYY)`);
  }
  return d;
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

  // Creation floor clamp (before any sheet fetch — cheap early exit).
  const floor = getVelocityMinOrderDate();
  const requestedFrom = from;
  const effectiveFrom = from.getTime() < floor.getTime() ? floor : from;
  const clamped = effectiveFrom.getTime() > requestedFrom.getTime();
  const rangeBeforeFloor = to.getTime() < floor.getTime();
  if (rangeBeforeFloor) {
    return { records: [], selfPrepExcluded: 0, skips: [], requestedFrom, effectiveFrom, clamped, rangeBeforeFloor };
  }

  const rows = await fetchSheetRows(sheetId);
  const skips: VelocitySkip[] = [];
  let selfPrepExcluded = 0;

  // Selection: date-range (floor-clamped) -> not-canceled -> prep > 0.
  const selected = [];
  const fromMs = effectiveFrom.getTime(), toMs = to.getTime();
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
      skips.push({ reason: "no_live_sku", orderNumber: row.orderNumber, asin: row.asin, itemName: row.itemName, row: { date: row.orderDate ?? null, retailer: row.retailer ?? null, quantity: row.quantity ?? null, soldAs: row.soldAs ?? null, unitsPerPack: row.unitsPerPack ?? null } });
      continue;
    }
    if (row.quantity == null || row.quantity === "") {
      skips.push({ reason: "missing_quantity", orderNumber: row.orderNumber, asin: row.asin, itemName: row.itemName, row: { date: row.orderDate ?? null, retailer: row.retailer ?? null, quantity: row.quantity ?? null, soldAs: row.soldAs ?? null, unitsPerPack: row.unitsPerPack ?? null } });
      continue;
    }
    // Fail-closed guards ahead of Velocity's own validation (SPEC §11 taxonomy).
    const soldAs = (row.soldAs ?? "").toString().trim().toLowerCase();
    if (soldAs === "bundle") {
      skips.push({ reason: "bundle_unsupported", orderNumber: row.orderNumber, asin: row.asin, itemName: row.itemName, row: { date: row.orderDate ?? null, retailer: row.retailer ?? null, quantity: row.quantity ?? null, soldAs: row.soldAs ?? null, unitsPerPack: row.unitsPerPack ?? null } });
      continue;
    }
    if (soldAs === "multi-pack") {
      const upp = Number((row.unitsPerPack ?? "").toString().trim());
      const qty = Number((row.quantity ?? "").toString().trim());
      // Velocity enforces qty % units_per_pack === 0 — catch VA typos before they do.
      if (!Number.isInteger(upp) || upp <= 0 || !Number.isInteger(qty) || qty % upp !== 0) {
        skips.push({ reason: "invalid_pack_math", orderNumber: row.orderNumber, asin: row.asin, itemName: row.itemName, row: { date: row.orderDate ?? null, retailer: row.retailer ?? null, quantity: row.quantity ?? null, soldAs: row.soldAs ?? null, unitsPerPack: row.unitsPerPack ?? null } });
        continue;
      }
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

  return { records, selfPrepExcluded, skips, requestedFrom, effectiveFrom, clamped, rangeBeforeFloor };
}
