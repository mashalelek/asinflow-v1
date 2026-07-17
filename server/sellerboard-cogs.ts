// SellerBoard COGS export (interim bandage until the Actuals audit). Pushes YTD
// PO landed costs into SellerBoard as per-PO cost periods. Read-only: no DB, no
// SC. Inputs = the Orders Google Sheet (via fetchSheetRows) + an uploaded SB
// products template xlsx (sheet "TDSheet", columns ASIN/SKU). See SPEC §11.
import * as XLSX from "xlsx";
import { fetchSheetRows } from "./google-sheets";
import { parseMDY } from "./velocity-export";

// Full SB template header set, in template order. We populate ONLY ASIN, SKU,
// CostPeriodStartDate, Cost, and BatchQuantity; every other cell is emitted as an
// empty string so a blank does not overwrite SB-side state on import.
export const SB_HEADERS = [
  "ASIN", "SKU", "Title", "Labels", "CostPeriodStartDate", "Cost",
  "DomesticShippingCost", "RestofworldShippingCost", "ShippingProfile",
  "Value_of_unsellable_returns", "VAT", "VAT_CATEGORY", "Hide",
  "Marketplace", "BatchQuantity",
] as const;

// Only the populated columns are typed; serializeSbCsv fills the rest with "".
export type SbRow = {
  ASIN: string;
  SKU: string;
  CostPeriodStartDate: string;
  Cost: string;
  BatchQuantity: string;
};

export interface SbSummary {
  rowsEmitted: number;
  distinctAsins: number;      // ASINs that produced >= 1 emitted row
  distinctPeriods: number;    // distinct (ASIN, date) periods emitted
  templateRowsLoaded: number; // (ASIN, SKU) entries loaded from the template
  templateAsins: number;      // distinct ASINs in the template
  skips: {
    badOrZeroCost: number;    // Col Y empty / unparseable / <= 0 (2026, non-closed/canceled rows)
    badOrMissingDate: number; // Col C missing / unparseable (non-closed/canceled rows)
    badQty: number;           // Col U empty / unparseable / not a positive integer (otherwise-valid row)
    sameDateMerged: number;   // (ASIN, date) periods where 2+ rows were qty-weighted-merged
    notInSb: number;          // distinct PO ASINs with YTD periods but absent from the template
  };
}

// Informational: a (ASIN, date) period that combined 2+ same-day orders.
export interface SbMerge { asin: string; date: string; count: number; qty: number; cost: number; }
export interface SbBuildResult {
  rows: SbRow[];
  summary: SbSummary;
  // Detail for review/logging — not part of the CSV.
  details: { notInSbAsins: string[]; merges: SbMerge[] };
}

// M/D/YYYY, no leading zeros, from a parsed local Date.
function formatMDYNoPad(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// Step 1: ASIN -> [SKU,...] from the SB template (sheet "TDSheet").
export function parseTemplate(buffer: Buffer): { map: Map<string, string[]>; entriesLoaded: number } {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets["TDSheet"];
  if (!ws) throw new Error(`Template has no "TDSheet" sheet (found: ${wb.SheetNames.join(", ") || "none"})`);
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: "" });
  const map = new Map<string, string[]>();
  let entriesLoaded = 0;
  for (const r of rows) {
    const asin = String(r["ASIN"] ?? "").trim();
    const sku = String(r["SKU"] ?? "").trim();
    if (!asin || !sku) continue; // ignore rows missing ASIN or SKU
    const arr = map.get(asin) ?? [];
    if (!arr.includes(sku)) { arr.push(sku); entriesLoaded++; } // one entry per (ASIN, SKU)
    map.set(asin, arr);
  }
  return { map, entriesLoaded };
}

// Accumulator for a (ASIN, date) period. weightedCents = Σ(costCents · qty);
// the period cost is the qty-weighted average, cents-integer to avoid float drift.
interface PeriodAcc { weightedCents: number; qty: number; count: number; }
const avgCents = (a: PeriodAcc): number => Math.round(a.weightedCents / a.qty);

export async function buildSellerboardCogs(
  templateBuffer: Buffer,
  deps: { sheetId?: string } = {},
): Promise<SbBuildResult> {
  const sheetId = deps.sheetId ?? process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not configured");

  const { map: skuMap, entriesLoaded } = parseTemplate(templateBuffer);
  const rows = await fetchSheetRows(sheetId);

  const skips = { badOrZeroCost: 0, badOrMissingDate: 0, badQty: 0, sameDateMerged: 0, notInSb: 0 };

  // Step 2: PO cost periods, keyed by ASIN -> (dateStr -> accumulator). Funnel:
  // status -> date -> cost -> qty. Same-ASIN same-date rows are genuine separate
  // same-day orders, not errors: MERGE them into one batch — BatchQuantity = sum
  // of qtys, Cost = qty-weighted average. (Same-cost rows are the trivial case.)
  const periods = new Map<string, Map<string, PeriodAcc>>();
  for (const row of rows) {
    const status = (row.status ?? "").toLowerCase();
    if (status.includes("closed") || status.includes("canceled")) continue; // excluded (silent)

    const dt = parseMDY(row.orderDate);
    if (dt === null) { skips.badOrMissingDate++; continue; } // never silently drop bad dates
    if (dt.getFullYear() !== 2026) continue; // not YTD — silently excluded, intended

    const cogs = row.cogs; // parseMoney(Col Y); null = empty/unparseable
    if (cogs == null || cogs <= 0) { skips.badOrZeroCost++; continue; }
    const prep = row.prepCost == null ? 0 : row.prepCost; // empty Col AS on a real row = 0 (§3)
    const cost = cogs + prep;

    // BatchQuantity = Col U (ordered qty) from THIS canonical row. Must be a
    // positive integer — a blank/zero/fractional qty is skipped as badQty (before
    // the merge, so it doesn't participate), never emitted: a blank BatchQuantity
    // flips the row to time-based-period semantics in SB. (row.qty = parseFloat of
    // Col U: "" -> null, unparseable -> 0.)
    const qty = row.qty;
    if (qty == null || !Number.isInteger(qty) || qty <= 0) { skips.badQty++; continue; }

    const costCents = Math.round(cost * 100);
    const dateStr = formatMDYNoPad(dt);
    let byDate = periods.get(row.asin);
    if (!byDate) { byDate = new Map(); periods.set(row.asin, byDate); }
    const acc = byDate.get(dateStr);
    if (acc) {
      acc.weightedCents += costCents * qty;
      acc.qty += qty;
      acc.count += 1;
    } else {
      byDate.set(dateStr, { weightedCents: costCents * qty, qty, count: 1 });
    }
  }

  // Record merges (2+ rows collapsed into one period) — informational, counted
  // for ALL periods (independent of whether the ASIN is later in the template).
  const merges: SbMerge[] = [];
  for (const [asin, byDate] of Array.from(periods)) {
    for (const [dateStr, acc] of Array.from(byDate)) {
      if (acc.count > 1) {
        skips.sameDateMerged++;
        merges.push({ asin, date: dateStr, count: acc.count, qty: acc.qty, cost: avgCents(acc) / 100 });
      }
    }
  }

  // Step 3: join to template SKUs and fan out one row per SKU per period.
  const out: SbRow[] = [];
  const emittedAsins = new Set<string>();
  const notInSbAsins = new Set<string>();
  let distinctPeriods = 0;
  for (const [asin, byDate] of Array.from(periods)) {
    const skus = skuMap.get(asin);
    if (!skus || skus.length === 0) { notInSbAsins.add(asin); continue; } // PO ASIN not in SB
    for (const [dateStr, acc] of Array.from(byDate)) {
      distinctPeriods++;
      emittedAsins.add(asin);
      const cost = (avgCents(acc) / 100).toFixed(2);
      const qtyStr = String(acc.qty);
      for (const sku of skus) {
        // Multi-SKU fan-out duplicates the FULL batch qty on every SKU row —
        // per-SKU batches deplete independently in SB, so we deliberately do NOT
        // split the quantity across SKUs.
        out.push({ ASIN: asin, SKU: sku, CostPeriodStartDate: dateStr, Cost: cost, BatchQuantity: qtyStr });
      }
    }
  }
  skips.notInSb = notInSbAsins.size;

  return {
    rows: out,
    summary: {
      rowsEmitted: out.length,
      distinctAsins: emittedAsins.size,
      distinctPeriods,
      templateRowsLoaded: entriesLoaded,
      templateAsins: skuMap.size,
      skips,
    },
    details: { notInSbAsins: Array.from(notInSbAsins), merges },
  };
}

export function serializeSbCsv(rows: SbRow[]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const lines = [SB_HEADERS.join(",")];
  // Only populated columns exist on SbRow; every other header serializes to "".
  for (const r of rows) lines.push(SB_HEADERS.map((h) => esc((r as Record<string, string>)[h] ?? "")).join(","));
  return lines.join("\r\n") + "\r\n";
}
