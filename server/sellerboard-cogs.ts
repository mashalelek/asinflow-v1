// SellerBoard COGS export (interim bandage until the Actuals audit). Pushes YTD
// PO landed costs into SellerBoard as per-PO cost periods. Read-only: no DB, no
// SC. Inputs = the Orders Google Sheet (via fetchSheetRows) + an uploaded SB
// products template xlsx (sheet "TDSheet", columns ASIN/SKU). See SPEC §11.
import * as XLSX from "xlsx";
import { fetchSheetRowsWithMeta } from "./google-sheets";
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

// Row accounting is closed: every Orders row read is either included in a
// period or lands in exactly one exclusion counter —
//   rawRowsRead = blankAsinRows + excludedByStatus + badOrMissingDate
//               + excludedNonYtd + badOrZeroCost + badQty + includedRows
// (sameDateMerged is informational — merged rows stay included; notInSb /
// inSbNoUsableSku are ASIN-level drops at the join, after row accounting.)
export interface SbSummary {
  rowsEmitted: number;
  distinctAsins: number;        // ASINs that produced >= 1 emitted row
  distinctPeriods: number;      // distinct (ASIN, date) periods emitted
  rawRowsRead: number;          // total Orders rows the sheet read returned (truncation tripwire)
  blankAsinRows: number;        // Orders rows dropped upstream for a blank Col H ASIN
  includedRows: number;         // Orders rows accumulated into cost periods
  templateRowsLoaded: number;   // (ASIN, SKU) entries loaded from the template
  templateAsins: number;        // distinct ASINs in the template (with a usable SKU)
  templateRowsRead: number;     // total TDSheet rows read
  templateRowsDropped: number;  // template rows ignored: blank ASIN and/or blank SKU stubs
  templateDupeRows: number;     // template rows repeating an already-loaded (ASIN, SKU)
  skips: {
    excludedByStatus: number;   // status contains "canceled" — ONLY canceled; closed IS included
    badOrMissingDate: number;   // Col C missing / unparseable (non-canceled rows)
    excludedNonYtd: number;     // Col C parsed but the year is not 2026
    badOrZeroCost: number;      // Col Y empty / unparseable / <= 0 (2026, non-canceled rows)
    badQty: number;             // Col U empty / unparseable / not a positive integer (otherwise-valid row)
    sameDateMerged: number;     // (ASIN, date) periods where 2+ rows were qty-weighted-merged
    notInSb: number;            // distinct PO ASINs with YTD periods, absent from the template entirely
    inSbNoUsableSku: number;    // distinct PO ASINs present in the template ONLY on blank-SKU rows
  };
}

// Informational: a (ASIN, date) period that combined 2+ same-day orders.
export interface SbMerge { asin: string; date: string; count: number; qty: number; cost: number; }

// A row dropped by the badQty gate, itemized by failure mode.
export type BadQtyMode = "empty" | "non_numeric" | "non_positive" | "non_integer";
export interface BadQtyRow {
  sheetRow: number; // 1-based sheet row
  asin: string;
  date: string;     // Col C verbatim
  rawQty: string;   // Col U verbatim (untrimmed)
  mode: BadQtyMode;
  cost: number;     // parsed cost (cogs + prep) the row would have carried
}

export interface SbBuildResult {
  rows: SbRow[];
  summary: SbSummary;
  // Detail for review/logging — not part of the CSV.
  details: { notInSbAsins: string[]; inSbNoUsableSkuAsins: string[]; merges: SbMerge[]; badQtyRows: BadQtyRow[] };
}

// M/D/YYYY, no leading zeros, from a parsed local Date.
function formatMDYNoPad(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// Step 1: ASIN -> [SKU,...] from the SB template (sheet "TDSheet"). ASINs are
// normalized (trim + UPPERCASE) to match the Orders side of the join; SKUs are
// trimmed only (SKUs are case-sensitive in SB). blankSkuAsins collects ASINs
// seen on blank-SKU rows so the join can distinguish "not in SB at all" from
// "in SB but no usable SKU".
export function parseTemplate(buffer: Buffer): {
  map: Map<string, string[]>;
  entriesLoaded: number;
  rowsRead: number;
  rowsDropped: number;
  dupeRows: number;
  blankSkuAsins: Set<string>;
} {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets["TDSheet"];
  if (!ws) throw new Error(`Template has no "TDSheet" sheet (found: ${wb.SheetNames.join(", ") || "none"})`);
  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: "" });
  const map = new Map<string, string[]>();
  const blankSkuAsins = new Set<string>();
  let entriesLoaded = 0;
  let rowsDropped = 0;
  let dupeRows = 0;
  for (const r of rows) {
    const asin = String(r["ASIN"] ?? "").trim().toUpperCase();
    const sku = String(r["SKU"] ?? "").trim();
    if (!asin || !sku) {
      rowsDropped++; // blank-ASIN and/or blank-SKU stub — counted, never silent
      if (asin && !sku) blankSkuAsins.add(asin);
      continue;
    }
    const arr = map.get(asin) ?? [];
    if (!arr.includes(sku)) { arr.push(sku); entriesLoaded++; } // one entry per (ASIN, SKU)
    else dupeRows++; // repeat of an already-loaded (ASIN, SKU) — contributes nothing
    map.set(asin, arr);
  }
  return { map, entriesLoaded, rowsRead: rows.length, rowsDropped, dupeRows, blankSkuAsins };
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

  const template = parseTemplate(templateBuffer);
  const skuMap = template.map;
  const { rows, rawRowsRead, blankAsinRows } = await fetchSheetRowsWithMeta(sheetId);

  const skips = {
    excludedByStatus: 0, badOrMissingDate: 0, excludedNonYtd: 0,
    badOrZeroCost: 0, badQty: 0, sameDateMerged: 0, notInSb: 0, inSbNoUsableSku: 0,
  };
  let includedRows = 0;
  const badQtyRows: BadQtyRow[] = [];

  // Step 2: PO cost periods, keyed by ASIN -> (dateStr -> accumulator). Funnel:
  // status -> date -> cost -> qty. Same-ASIN same-date rows are genuine separate
  // same-day orders, not errors: MERGE them into one batch — BatchQuantity = sum
  // of qtys, Cost = qty-weighted average. (Same-cost rows are the trivial case.)
  const periods = new Map<string, Map<string, PeriodAcc>>();
  for (const row of rows) {
    const status = (row.status ?? "").toLowerCase();
    // Exclude ONLY canceled. Closed POs are completed purchases — exactly the
    // batch history SB needs — so "closed" IS included (matches the sheet
    // client's COGS canonical-row rule). NOTE: this DELIBERATELY differs from
    // the ordered-qty sync's status rule (google-sheets.ts fetchSheetData),
    // which excludes closed AND canceled because it counts qty still on order.
    if (status.includes("canceled")) { skips.excludedByStatus++; continue; }

    const dt = parseMDY(row.orderDate);
    if (dt === null) { skips.badOrMissingDate++; continue; } // never silently drop bad dates
    if (dt.getFullYear() !== 2026) { skips.excludedNonYtd++; continue; } // not YTD — excluded, intended (and counted)

    const cogs = row.cogs; // parseMoney(Col Y); null = empty/unparseable
    if (cogs == null || cogs <= 0) { skips.badOrZeroCost++; continue; }
    const prep = row.prepCost == null ? 0 : row.prepCost; // empty Col AS on a real row = 0 (§3)
    const cost = cogs + prep;

    // BatchQuantity = Col U (ordered qty) from THIS canonical row. Must be a
    // positive integer — a blank/zero/fractional/non-numeric qty is skipped as
    // badQty (before the merge, so it doesn't participate), never emitted: a
    // blank BatchQuantity flips the row to time-based-period semantics in SB.
    // Classify the failure mode from the verbatim cell; parseFloat matches the
    // sheet reader so the skip DECISION is unchanged, only now itemized.
    const rawQty = row.qtyRaw;
    const t = rawQty.trim();
    let qtyMode: BadQtyMode | null = null;
    let qty = 0;
    if (t === "") qtyMode = "empty";
    else {
      const n = parseFloat(t);
      if (Number.isNaN(n)) qtyMode = "non_numeric";
      else if (n <= 0) qtyMode = "non_positive";
      else if (!Number.isInteger(n)) qtyMode = "non_integer";
      else qty = n;
    }
    if (qtyMode) {
      skips.badQty++;
      badQtyRows.push({ sheetRow: row.sheetRow, asin: row.asin, date: row.orderDate ?? "", rawQty, mode: qtyMode, cost });
      continue;
    }

    includedRows++;
    const costCents = Math.round(cost * 100);
    const dateStr = formatMDYNoPad(dt);
    // Normalize the join key the same way as the template side (trim came from
    // fetchSheetRows; uppercase here) so ASIN case can never fake a not-in-SB.
    const asinKey = row.asin.toUpperCase();
    let byDate = periods.get(asinKey);
    if (!byDate) { byDate = new Map(); periods.set(asinKey, byDate); }
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
  const inSbNoUsableSkuAsins = new Set<string>();
  let distinctPeriods = 0;
  for (const [asin, byDate] of Array.from(periods)) {
    const skus = skuMap.get(asin);
    if (!skus || skus.length === 0) {
      // ASIN-level drop: split "SB has never heard of it" from "SB knows the
      // ASIN but only on blank-SKU template rows" — different remediations.
      if (template.blankSkuAsins.has(asin)) inSbNoUsableSkuAsins.add(asin);
      else notInSbAsins.add(asin);
      continue;
    }
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
  skips.inSbNoUsableSku = inSbNoUsableSkuAsins.size;

  return {
    rows: out,
    summary: {
      rowsEmitted: out.length,
      distinctAsins: emittedAsins.size,
      distinctPeriods,
      rawRowsRead,
      blankAsinRows,
      includedRows,
      templateRowsLoaded: template.entriesLoaded,
      templateAsins: skuMap.size,
      templateRowsRead: template.rowsRead,
      templateRowsDropped: template.rowsDropped,
      templateDupeRows: template.dupeRows,
      skips,
    },
    details: {
      notInSbAsins: Array.from(notInSbAsins),
      inSbNoUsableSkuAsins: Array.from(inSbNoUsableSkuAsins),
      merges,
      badQtyRows,
    },
  };
}

export function serializeSbCsv(rows: SbRow[]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const lines = [SB_HEADERS.join(",")];
  // Only populated columns exist on SbRow; every other header serializes to "".
  for (const r of rows) lines.push(SB_HEADERS.map((h) => esc((r as Record<string, string>)[h] ?? "")).join(","));
  return lines.join("\r\n") + "\r\n";
}
