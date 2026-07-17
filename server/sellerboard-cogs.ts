// SellerBoard COGS export (interim bandage until the Actuals audit). Pushes YTD
// PO landed costs into SellerBoard as per-PO cost periods. Read-only: no DB, no
// SC. Inputs = the Orders Google Sheet (via fetchSheetRows) + an uploaded SB
// products template xlsx (sheet "TDSheet", columns ASIN/SKU). See SPEC §11.
import * as XLSX from "xlsx";
import { fetchSheetRows } from "./google-sheets";
import { parseMDY } from "./velocity-export";

export const SB_HEADERS = ["ASIN", "SKU", "CostPeriodStartDate", "Cost"] as const;
export type SbRow = Record<(typeof SB_HEADERS)[number], string>;

export interface SbSummary {
  rowsEmitted: number;
  distinctAsins: number;      // ASINs that produced >= 1 emitted row
  distinctPeriods: number;    // distinct (ASIN, date) periods emitted
  templateRowsLoaded: number; // (ASIN, SKU) entries loaded from the template
  templateAsins: number;      // distinct ASINs in the template
  skips: {
    badOrZeroCost: number;    // Col Y empty / unparseable / <= 0 (2026, non-closed/canceled rows)
    badOrMissingDate: number; // Col C missing / unparseable (non-closed/canceled rows)
    sameDateConflict: number; // same (ASIN, date) seen again with a DIFFERENT cost (first kept)
    notInSb: number;          // distinct PO ASINs with YTD periods but absent from the template
  };
}

export interface SbConflict { asin: string; date: string; kept: number; other: number; }
export interface SbBuildResult {
  rows: SbRow[];
  summary: SbSummary;
  // Detail for review/logging — not part of the CSV.
  details: { notInSbAsins: string[]; conflicts: SbConflict[] };
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

export async function buildSellerboardCogs(
  templateBuffer: Buffer,
  deps: { sheetId?: string } = {},
): Promise<SbBuildResult> {
  const sheetId = deps.sheetId ?? process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not configured");

  const { map: skuMap, entriesLoaded } = parseTemplate(templateBuffer);
  const rows = await fetchSheetRows(sheetId);

  const skips = { badOrZeroCost: 0, badOrMissingDate: 0, sameDateConflict: 0, notInSb: 0 };
  const conflicts: SbConflict[] = [];

  // Step 2: PO cost periods, keyed by ASIN -> (dateStr -> cost). First row wins
  // per (ASIN, date); a later same-(ASIN,date) row with a different cost is a
  // same-date conflict (counted, first kept). Funnel: status -> date -> cost.
  const periods = new Map<string, Map<string, number>>();
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

    const dateStr = formatMDYNoPad(dt);
    let byDate = periods.get(row.asin);
    if (!byDate) { byDate = new Map(); periods.set(row.asin, byDate); }
    if (byDate.has(dateStr)) {
      const kept = byDate.get(dateStr)!;
      if (Math.abs(kept - cost) > 0.005) { // differ → conflict, keep first
        skips.sameDateConflict++;
        conflicts.push({ asin: row.asin, date: dateStr, kept, other: cost });
      }
    } else {
      byDate.set(dateStr, cost);
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
    for (const [dateStr, cost] of Array.from(byDate)) {
      distinctPeriods++;
      emittedAsins.add(asin);
      for (const sku of skus) {
        out.push({ ASIN: asin, SKU: sku, CostPeriodStartDate: dateStr, Cost: cost.toFixed(2) });
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
    details: { notInSbAsins: Array.from(notInSbAsins), conflicts },
  };
}

export function serializeSbCsv(rows: SbRow[]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const lines = [SB_HEADERS.join(",")];
  for (const r of rows) lines.push(SB_HEADERS.map((h) => esc(r[h] ?? "")).join(","));
  return lines.join("\r\n") + "\r\n";
}
