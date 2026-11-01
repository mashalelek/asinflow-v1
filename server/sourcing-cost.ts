// Amazon Sourcing Cost export. Fills the "Seller New Cost" column of Amazon's
// own Manage Your Sourcing Cost bulk-update workbook — it never generates rows.
// Amazon owns the row set (one row per ASIN+FNSKU) and seven of the eight
// columns; we own exactly one. Every other cell round-trips untouched so a
// blank never overwrites Amazon-side state (same discipline as the SB COGS
// export, §11, but fill-in-place rather than row-emitting).
//
// There is NO SP-API for sourcing cost — verified against the SP-API model list
// and the Feeds API feed-type list (Aug 2026). Download the workbook from the
// "Bulk Update" button on the Manage Your Sourcing Cost page, run it through
// here, upload the result. That round-trip is the whole integration.
//
// Cost source (po-ai-prefill §7.1, Maria 2026-10-31, scoped 2026-11-01):
// where the ASIN's newest non-canceled PO was created by the Capture PO
// patch — cost formula v2 (the form), or source 'extension' /
// 'email_renewal' — the submitted cost is that row's **Sourcing cost**
// (COGS before the gift-card discount, promos applied; the gift-card
// discount is financing, not product cost). Every other ASIN — newest PO
// imported from the Orders sheet, or saved by the pre-patch form — keeps
// sending what it sent before: actual_cogs (col Y). Both are counted
// (sourcingFromAr / sourcingFallback). ONLY where asin_estimates.cogs_source
// = 'po_sheet'. Sourcing cost sets Amazon's reimbursement valuation
// for lost/damaged units and is gated on invoice review, so only a cost with
// a PO behind it is defensible. estimated_cogs and manual/csv-sourced
// actuals are never submitted — an ASIN without a PO cost is skipped and
// named in the summary, never guessed.
import * as XLSX from "xlsx";
import type { SheetRow } from "./google-sheets";
import { loadAfPoRows } from "./po-af-source";
import { parseMDY, formatYMD } from "./velocity-export";
import { query as defaultQuery } from "./db";
import { NEWEST_PO_ORDER } from "./po-entry-seq";

// Amazon's header row, verbatim. Columns are located BY HEADER TEXT, never by
// index — Amazon has reordered download templates before and a silent index
// drift would write costs into the wrong column.
export const SC_HEADERS = [
  "Asin", "Fnsku", "Amazon Estimated Cost", "Latest Approved Cost",
  "Source of Latest Approved Cost", "Currency", "Date of Last Updated Cost",
  "Seller New Cost",
] as const;

const H_ASIN = "asin";
const H_APPROVED = "latest approved cost";
const H_SOURCE = "source of latest approved cost";
const H_NEW = "seller new cost";

// Large catalogs come back split across Part_1..Part_N sheets. Anything else in
// the book is left alone.
const PART_SHEET = /^part_\d+$/i;

// Row accounting is closed: every PO sheet row read lands in exactly one bucket —
//   rawRowsRead = blankAsinRows + excludedByStatus + badOrMissingDate
//               + excludedOutOfRange + includedRows
export interface ScSummary {
  // ── PO sheet (scope selection) ──
  rawRowsRead: number;          // rows the sheet API returned (truncation tripwire)
  blankAsinRows: number;        // dropped upstream for a blank Col H
  includedRows: number;         // in-range purchase rows
  purchasedAsins: number;       // distinct ASINs from includedRows
  // ── DB (cost resolution) ──
  asinsWithPoCogs: number;      // purchased ASINs carrying a usable po_sheet cost
  sourcingFromAr: number;       // of those, cost = the newest PO row's sourcing_cost (newest PO is patch-forward)
  sourcingFallback: number;     // of those, cost = actual_cogs (newest PO imported / pre-patch, or no sourcing_cost yet)
  // ── Workbook (write) ──
  sheetsScanned: number;
  workbookRowsRead: number;     // data rows across all Part_N sheets
  workbookAsins: number;        // distinct ASINs Amazon listed
  asinsWritten: number;         // distinct ASINs that got >= 1 cost written
  rowsWritten: number;          // ASIN+FNSKU cells written (fan-out: >= asinsWritten)
  skips: {
    excludedByStatus: number;   // status contains "canceled"
    badOrMissingDate: number;   // Col C missing / unparseable (non-canceled)
    excludedOutOfRange: number; // Col C parsed but outside [from, to]
    noCogsRow: number;          // purchased ASIN with no asin_estimates row at all
    notPoSourced: number;       // actual_cogs present but cogs_source != 'po_sheet'
    badCost: number;            // po_sheet-sourced but null / non-finite / <= 0
    notInWorkbook: number;      // has a PO cost, but Amazon doesn't list the ASIN
    alreadyApproved: number;    // rows skipped: Amazon already approved this exact cost
    wouldLowerApproved: number; // rows skipped: our cost is BELOW the current approval
  };
}

export interface ScDetails {
  noCogsRowAsins: string[];
  notPoSourcedAsins: Array<{ asin: string; source: string | null }>;
  badCostAsins: Array<{ asin: string; cogs: string }>;
  notInWorkbookAsins: string[];
  alreadyApprovedAsins: string[];
  // Rows the reduction guard held back, with both numbers so the gap is visible.
  wouldLowerAsins: Array<{ asin: string; approved: number; cost: number; source: string | null }>;
  // Every cost actually written, for the server log and the summary modal.
  written: Array<{ asin: string; fnskus: string[]; cost: number; wasApproved: number | null; source: string | null; basis?: "sourcing_cost" | "actual_cogs" }>;
}

export interface ScResult {
  buffer: Buffer;
  summary: ScSummary;
  details: ScDetails;
}

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

// A PO "created by the Capture PO patch forward" (Maria 2026-11-01): saved by
// the v2 form (cost_formula_version set — the pre-patch form left it NULL),
// captured by the extension, or a renewal PO from a confirmation email. The
// dry run (script/sourcing-cost-switch-dryrun.ts) applies the same test.
// `p` is the purchase_orders alias.
export const PATCH_FORWARD_PO_SQL = "(p.cost_formula_version IS NOT NULL OR p.source IN ('extension', 'email_renewal'))";

// Money to cents, half-up, so 4.955 -> 4.96 rather than float noise.
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Normalized header -> 0-based column offset within the sheet range.
function headerMap(ws: XLSX.WorkSheet, range: XLSX.Range): Map<string, number> {
  const m = new Map<string, number>();
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: range.s.r, c })];
    const raw = cell?.v;
    if (raw == null) continue;
    m.set(String(raw).trim().toLowerCase(), c);
  }
  return m;
}

function cellStr(ws: XLSX.WorkSheet, r: number, c: number): string {
  const v = ws[XLSX.utils.encode_cell({ r, c })]?.v;
  return v == null ? "" : String(v).trim();
}

function cellNum(ws: XLSX.WorkSheet, r: number, c: number): number | null {
  const v = ws[XLSX.utils.encode_cell({ r, c })]?.v;
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the filled workbook.
 *
 * @param templateBuffer Amazon's downloaded bulk-update xlsx
 * @param from           inclusive start of the purchase window (local midnight)
 * @param to             inclusive end of the purchase window (local midnight)
 */
export async function buildSourcingCost(
  templateBuffer: Buffer,
  from: Date,
  to: Date,
  q: QueryLike = defaultQuery as any,
  loadRows?: () => Promise<{ rows: SheetRow[]; rawRowsRead: number; blankAsinRows: number }>,
): Promise<ScResult> {

  const skips: ScSummary["skips"] = {
    excludedByStatus: 0, badOrMissingDate: 0, excludedOutOfRange: 0,
    noCogsRow: 0, notPoSourced: 0, badCost: 0, notInWorkbook: 0, alreadyApproved: 0,
    wouldLowerApproved: 0,
  };

  // ── 1. Scope: ASINs purchased inside the window, per the AF PO tables ────
  // (po-af-owned §2.4, 2026-10-18 — the Orders sheet is intake-only).
  const { rows, rawRowsRead, blankAsinRows } = loadRows ? await loadRows() : await loadAfPoRows(q as any);
  const lo = from.getTime(), hi = to.getTime();
  const purchased = new Set<string>();
  let includedRows = 0;

  for (const row of rows) {
    // Canceled orders never happened — same gate as the SB export. "closed" IS
    // a purchase and stays in.
    if ((row.status ?? "").toLowerCase().includes("canceled")) { skips.excludedByStatus++; continue; }
    const dt = parseMDY(row.orderDate);
    if (!dt) { skips.badOrMissingDate++; continue; }
    const t = dt.getTime();
    if (t < lo || t > hi) { skips.excludedOutOfRange++; continue; }
    includedRows++;
    purchased.add(row.asin.trim().toUpperCase());
  }

  // ── 2. Resolve cost: po_sheet-sourced only; the newest PO row's sourcing_cost when that PO is patch-forward, else actual_cogs ──
  const asinList = Array.from(purchased);
  const costByAsin = new Map<string, number>();
  const basisByAsin = new Map<string, "sourcing_cost" | "actual_cogs">();
  let sourcingFromAr = 0, sourcingFallback = 0;
  const details: ScDetails = {
    noCogsRowAsins: [], notPoSourcedAsins: [], badCostAsins: [],
    notInWorkbookAsins: [], alreadyApprovedAsins: [], wouldLowerAsins: [], written: [],
  };

  if (asinList.length > 0) {
    const { rows: costRows } = await q(
      `SELECT a.asin, e.actual_cogs, e.cogs_source,
              (SELECT CASE WHEN ${PATCH_FORWARD_PO_SQL} THEN pa.sourcing_cost END FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
                WHERE pa.asin = a.asin
                  AND NOT COALESCE((SELECT bool_and(l.qty_canceled IS NOT NULL AND l.qty_canceled >= COALESCE(l.qty_ordered, 0)) FROM po_line_items l WHERE l.po_asin_id = pa.id), false)
                ORDER BY ${NEWEST_PO_ORDER} LIMIT 1) AS sourcing_cost
         FROM asins a
         LEFT JOIN asin_estimates e ON e.asin = a.asin
        WHERE a.asin = ANY($1::text[])`,
      [asinList],
    );
    const seen = new Map<string, { cogs: any; source: string | null; sourcing: any }>();
    for (const r of costRows) seen.set(String(r.asin).toUpperCase(), { cogs: r.actual_cogs, source: r.cogs_source ?? null, sourcing: r.sourcing_cost ?? null });

    for (const asin of asinList) {
      const hit = seen.get(asin);
      if (!hit || (hit.cogs == null && hit.source == null)) {
        skips.noCogsRow++; details.noCogsRowAsins.push(asin); continue;
      }
      if (hit.source !== "po_sheet") {
        skips.notPoSourced++; details.notPoSourcedAsins.push({ asin, source: hit.source }); continue;
      }
      // Sourcing cost when the newest PO is patch-forward and carries one; else actual_cogs, as before the switch.
      const s = hit.sourcing == null ? NaN : Number(hit.sourcing);
      const useSourcing = Number.isFinite(s) && s > 0;
      const n = useSourcing ? s : hit.cogs == null ? NaN : Number(hit.cogs);
      if (!Number.isFinite(n) || n <= 0) {
        skips.badCost++; details.badCostAsins.push({ asin, cogs: String(hit.cogs) }); continue;
      }
      costByAsin.set(asin, round2(n));
      basisByAsin.set(asin, useSourcing ? "sourcing_cost" : "actual_cogs");
      if (useSourcing) sourcingFromAr++; else sourcingFallback++;
    }
  }

  // ── 3. Fill Amazon's workbook in place ────────────────────────────────────
  const wb = XLSX.read(templateBuffer, { type: "buffer", cellStyles: true, cellNF: true });
  const partSheets = wb.SheetNames.filter((n) => PART_SHEET.test(n));
  if (partSheets.length === 0) {
    throw new Error(
      `No Part_N sheet found in the uploaded workbook (sheets: ${wb.SheetNames.join(", ") || "none"}). ` +
      `Upload the file downloaded from "Bulk Update" on the Manage Your Sourcing Cost page.`,
    );
  }

  const matchedFnskus = new Map<string, string[]>(); // asin -> fnskus written
  const approvedByAsin = new Map<string, { was: number | null; source: string | null }>();
  const workbookAsins = new Set<string>();
  let workbookRowsRead = 0, rowsWritten = 0;

  for (const name of partSheets) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const hdr = headerMap(ws, range);
    const cAsin = hdr.get(H_ASIN), cNew = hdr.get(H_NEW);
    const cApproved = hdr.get(H_APPROVED), cSource = hdr.get(H_SOURCE);
    const cFnsku = hdr.get("fnsku");
    if (cAsin == null || cNew == null) {
      throw new Error(
        `Sheet "${name}" is missing a required column ` +
        `(need "Asin" and "Seller New Cost"; found: ${Array.from(hdr.keys()).join(", ")}). ` +
        `Amazon may have changed the template — do not upload the output until this is reconciled.`,
      );
    }

    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const asin = cellStr(ws, r, cAsin).toUpperCase();
      if (!asin) continue;
      workbookRowsRead++;
      workbookAsins.add(asin);

      const cost = costByAsin.get(asin);
      if (cost == null) continue;

      // Amazon already approved this exact cost from us — resubmitting spends an
      // attempt (sellers hit "Number of attempts exceeded") and re-opens an
      // approved row to document review for no gain. An AMAZON-sourced approval
      // at the same number is NOT skipped: we still want it seller-backed.
      const approved = cApproved == null ? null : cellNum(ws, r, cApproved);
      const src = cSource == null ? null : cellStr(ws, r, cSource).toUpperCase();
      if (src === "SELLER" && approved != null && round2(approved) === cost) {
        skips.alreadyApproved++;
        if (!details.alreadyApprovedAsins.includes(asin)) details.alreadyApprovedAsins.push(asin);
        continue;
      }

      // Reduction guard. NEVER submit a cost below the currently approved one.
      //
      // Measured on the first live upload (Aug 19, 2026, 985 rows): Amazon
      // accepted 73.5% of cost REDUCTIONS but only 17.2% of INCREASES. A run
      // that nets out mostly reductions therefore walks the reimbursement basis
      // DOWN even when the intent was up — that upload moved the per-unit
      // approved basis -1.9% against an intended +24.8%, giving up $367.83 to
      // gain $186.65. Reductions are near-irreversible in practice: undoing one
      // means re-submitting it as an increase, which is the 17% path.
      //
      // Standing instruction from Maria (Aug 20, 2026): where Amazon's approved
      // figure is above our PO cost, their number stands. Do not "fix" this.
      // Amazon's own definition already excludes freight, duties and prep, so
      // the approved value sits below true landed cost before we touch it; and
      // with entire boxes going missing in FBA, a volunteered reduction is a
      // direct cash loss. Higher number always wins.
      if (approved != null && cost < round2(approved)) {
        skips.wouldLowerApproved++;
        if (!details.wouldLowerAsins.some((x) => x.asin === asin)) {
          details.wouldLowerAsins.push({ asin, approved: round2(approved), cost, source: src });
        }
        continue;
      }

      // The one cell we own. Written as a number, not a formatted string.
      ws[XLSX.utils.encode_cell({ r, c: cNew })] = { t: "n", v: cost };
      rowsWritten++;
      const fnsku = cFnsku == null ? "" : cellStr(ws, r, cFnsku);
      const list = matchedFnskus.get(asin);
      if (list) list.push(fnsku); else matchedFnskus.set(asin, [fnsku]);
      if (!approvedByAsin.has(asin)) approvedByAsin.set(asin, { was: approved, source: src });
    }
  }

  // An ASIN with a PO cost that Amazon never listed has nothing to write into —
  // typically no FBA inventory, so no reimbursement exposure either.
  for (const asin of Array.from(costByAsin.keys())) {
    if (!workbookAsins.has(asin)) { skips.notInWorkbook++; details.notInWorkbookAsins.push(asin); }
  }

  for (const [asin, fnskus] of Array.from(matchedFnskus.entries())) {
    const a = approvedByAsin.get(asin);
    details.written.push({ asin, fnskus, cost: costByAsin.get(asin)!, wasApproved: a?.was ?? null, source: a?.source ?? null, basis: basisByAsin.get(asin) });
  }
  details.written.sort((x, y) => x.asin.localeCompare(y.asin));

  // bookSST is NOT cosmetic. Without it SheetJS emits text cells as t="str",
  // which in OOXML means "cached result of a formula" — on a cell with no <f>
  // element that is malformed, and a POI-based reader (which Amazon's bulk
  // upload almost certainly is) can hand back a null/typed-wrong value for
  // every string column. bookSST emits a real sharedStrings table with t="s".
  // Verified against the live 1,415-row workbook: with bookSST every column
  // reads back identically under an independent (openpyxl) parser, and the
  // 1,410 untouched "Seller New Cost" cells stay empty strings rather than
  // disappearing. Do not drop this flag.
  const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer", cellStyles: true, bookSST: true }) as Buffer;

  return {
    buffer,
    summary: {
      rawRowsRead, blankAsinRows, includedRows,
      purchasedAsins: purchased.size,
      asinsWithPoCogs: costByAsin.size,
      sourcingFromAr, sourcingFallback,
      sheetsScanned: partSheets.length,
      workbookRowsRead,
      workbookAsins: workbookAsins.size,
      asinsWritten: matchedFnskus.size,
      rowsWritten,
      skips,
    },
    details,
  };
}

// amzn-sourcing-cost-<from>_<to>.xlsx — the date range is IN the filename so the
// export history reads as a coverage log without a join.
export function sourcingCostFilename(from: Date, to: Date): string {
  return `amzn-sourcing-cost-${formatYMD(from)}_${formatYMD(to)}.xlsx`;
}

// "YYYY-MM-DD" -> local midnight. The global date-range context emits this
// format; parseMDY (M/D/YYYY, the PO sheet's format) cannot read it. Numeric
// constructor, never a string parse — `new Date("2026-08-19")` is UTC midnight
// and shifts a day behind in America/New_York.
export function parseYMDLocal(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}
