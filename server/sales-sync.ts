// Sales units / revenue from the orders flat-file report
// (GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL). Component 19 of the
// Refresh job (SPEC §11) and the one-off history backfill both call
// syncSalesData; the Finances API patch replaces the report, not the callers.
//
// Scope (2026-10-16): EVERY ASIN in `asins`, all statuses — active, parked,
// dead. The report is account-wide; the old active+parked filter was dropping
// rows. An ASIN the report names that AF does not have at all is ONBOARDED
// through the injected `onboard` callback (the standard insert path, tag
// "Sales import") BEFORE the chunk's upsert, so its rows land in the same
// chunk; the caller enqueues the Refresh job for them once at the end.
//
// A chunk that fails FAILS the sync (SalesSyncError carries the per-chunk
// results so far); it is never skipped silently. The UTC day boundary of the
// report request and of `purchase-date` is deliberately unchanged — noted
// for the Finances patch.
import axios from "axios";
import { spApiGet, spApiPost } from "./spapi";
import { query } from "./db";
import { log } from "./index";

const MARKETPLACE_ID = "ATVPDKIKX0DER";
/** Test seam: polling / pacing delays. */
export const salesTiming = { pollMs: 10_000, pollTimeoutMs: 5 * 60_000, chunkDelayMs: 2_000 };
/** 30-day chunks — the limit the code has always asserted for this report type (the "Date range exceeded" response is the check). */
export const MAX_RANGE_DAYS = 30;
/** A well-formed ASIN. The report carries placeholders like "UNKNOW" on some lines; those are never onboarded (2026-10-16). */
export const ASIN_RE = /^[A-Z0-9]{10}$/;

export interface SalesChunkResult {
  start: string;
  end: string;
  status: "ok" | "empty" | "failed";
  orders: number;
  days: number;
  asins: number;
  /** ASINs the report named that AF lacked and that were inserted before this chunk's upsert. */
  onboarded: string[];
  /** Distinct malformed ASIN strings the report carried (e.g. "UNKNOW"); their lines are skipped, never onboarded. */
  invalidAsins: string[];
  /** Earliest / latest `purchase-date` the report actually returned for this chunk (null when empty). */
  minDate: string | null;
  maxDate: string | null;
  error?: string;
}

export interface SalesSyncResult {
  daysProcessed: number;
  asinsUpdated: number;
  totalOrders: number;
  onboarded: string[];
  invalidAsins: string[];
  chunks: SalesChunkResult[];
  minDate: string | null;
  maxDate: string | null;
}

export class SalesSyncError extends Error {
  constructor(message: string, public readonly partial: SalesSyncResult) { super(message); }
}

export interface SalesSyncOptions {
  /**
   * Insert ASINs the report names that AF lacks, through the standard
   * onboarding insert path. Called once per chunk with the distinct unknown
   * ASINs, BEFORE the chunk's upsert. Absent = unknown ASINs are skipped
   * (the legacy route's behaviour).
   */
  onboard?: (asins: string[]) => Promise<void>;
  /** Called after each chunk, success or failure, for progress logging. */
  onChunk?: (chunk: SalesChunkResult, index: number, total: number) => void | Promise<void>;
}

export async function syncSalesData(
  startDate: string,
  endDate: string,
  asinFilter?: ReadonlySet<string>,
  opts: SalesSyncOptions = {},
): Promise<SalesSyncResult> {
  const chunks = buildDateChunks(startDate, endDate, MAX_RANGE_DAYS);
  log(`Sales sync: ${startDate} to ${endDate} → ${chunks.length} chunk(s)${asinFilter ? ` (filtered to ${asinFilter.size} ASINs)` : " (every ASIN, all statuses)"}`, "sales-sync");

  // ASIN → asins.id, built once. The report is account-wide; an explicit
  // selection narrows what is written, otherwise EVERY row in asins counts
  // (no status filter — 2026-10-16). Unknown ASINs are onboarded per chunk
  // and added to this map as they are inserted.
  const filtered = asinFilter != null && asinFilter.size > 0;
  const asinRows = await query(
    filtered ? `SELECT id, asin FROM asins WHERE asin = ANY($1::text[])` : `SELECT id, asin FROM asins`,
    filtered ? [Array.from(asinFilter!)] : undefined,
  );
  const asinIdMap = new Map<string, string>();
  for (const row of asinRows.rows) asinIdMap.set(String(row.asin), String(row.id));

  const result: SalesSyncResult = { daysProcessed: 0, asinsUpdated: 0, totalOrders: 0, onboarded: [], invalidAsins: [], chunks: [], minDate: null, maxDate: null };
  const allDates = new Set<string>();
  const allAsins = new Set<string>();
  const onboardedAll = new Set<string>();
  const invalidAll = new Set<string>();
  const finish = () => {
    result.daysProcessed = allDates.size;
    result.asinsUpdated = allAsins.size;
    result.onboarded = Array.from(onboardedAll).sort();
    result.invalidAsins = Array.from(invalidAll).sort();
    result.minDate = minOf(result.chunks.map((c) => c.minDate));
    result.maxDate = maxOf(result.chunks.map((c) => c.maxDate));
  };

  for (let ci = 0; ci < chunks.length; ci++) {
    const [chunkStart, chunkEnd] = chunks[ci];
    log(`Chunk ${ci + 1}/${chunks.length}: ${chunkStart} to ${chunkEnd}`, "sales-sync");
    let chunk: SalesChunkResult;
    try {
      const r = await fetchChunk(chunkStart, chunkEnd, asinIdMap, filtered ? undefined : opts.onboard);
      r.dates.forEach((d) => allDates.add(d));
      r.asins.forEach((a) => allAsins.add(a));
      chunk = r.chunk;
    } catch (err: any) {
      chunk = { start: chunkStart, end: chunkEnd, status: "failed", orders: 0, days: 0, asins: 0, onboarded: [], invalidAsins: [], minDate: null, maxDate: null, error: err?.message ?? String(err) };
      result.chunks.push(chunk);
      await opts.onChunk?.(chunk, ci, chunks.length);
      finish();
      log(`Chunk ${ci + 1}/${chunks.length} FAILED: ${chunk.error} — sync stopped`, "sales-sync");
      throw new SalesSyncError(`chunk ${ci + 1}/${chunks.length} (${chunkStart}..${chunkEnd}) failed: ${chunk.error}`, result);
    }
    result.chunks.push(chunk);
    result.totalOrders += chunk.orders;
    for (const a of chunk.onboarded) onboardedAll.add(a);
    for (const a of chunk.invalidAsins) invalidAll.add(a);
    await opts.onChunk?.(chunk, ci, chunks.length);
    // Small delay between chunks to avoid rate limits
    if (ci < chunks.length - 1) await new Promise((r) => setTimeout(r, salesTiming.chunkDelayMs));
  }

  finish();
  log(`Sales sync complete: ${result.daysProcessed} days, ${result.asinsUpdated} ASINs, ${result.totalOrders} orders, ${result.onboarded.length} onboarded, returned ${result.minDate ?? "-"}..${result.maxDate ?? "-"}`, "sales-sync");
  return result;
}

function minOf(xs: (string | null)[]): string | null { const v = xs.filter((x): x is string => !!x); return v.length ? v.reduce((a, b) => (a < b ? a : b)) : null; }
function maxOf(xs: (string | null)[]): string | null { const v = xs.filter((x): x is string => !!x); return v.length ? v.reduce((a, b) => (a > b ? a : b)) : null; }

export function buildDateChunks(start: string, end: string, maxDays: number): [string, string][] {
  const chunks: [string, string][] = [];
  let cursor = new Date(start + "T12:00:00Z");
  const endDate = new Date(end + "T12:00:00Z");

  while (cursor <= endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());

    chunks.push([fmtDate(cursor), fmtDate(chunkEnd)]);

    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** Parsed, non-cancelled order line. */
interface OrderLine { asin: string; date: string; qty: number; price: number }

async function fetchChunk(
  startDate: string,
  endDate: string,
  asinIdMap: Map<string, string>,
  onboard?: (asins: string[]) => Promise<void>,
): Promise<{ chunk: SalesChunkResult; dates: Set<string>; asins: Set<string> }> {
  // 1. Create report
  const createRes = await spApiPost("/reports/2021-06-30/reports", {
    reportType: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL",
    marketplaceIds: [MARKETPLACE_ID],
    dataStartTime: `${startDate}T00:00:00Z`,
    dataEndTime: `${endDate}T23:59:59Z`,
  });

  const reportId: string = createRes.reportId;
  log(`Report created: ${reportId}`, "sales-sync");

  // 2. Poll until DONE
  const deadline = Date.now() + salesTiming.pollTimeoutMs;
  let reportDocumentId: string | undefined;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, salesTiming.pollMs));
    const statusRes = await spApiGet(`/reports/2021-06-30/reports/${reportId}`);
    const status: string = statusRes.processingStatus;

    if (status === "DONE") {
      reportDocumentId = statusRes.reportDocumentId;
      break;
    }
    if (status === "FATAL" || status === "CANCELLED") {
      throw new Error(`Report ${reportId} failed: ${status}`);
    }
  }

  if (!reportDocumentId) {
    throw new Error(`Report ${reportId} timed out`);
  }

  // 3. Download
  const docRes = await spApiGet(`/reports/2021-06-30/documents/${reportDocumentId}`);
  // 120 s hard timeout (SPEC §11 decision 9, applied 2026-09-07): the S3
  // report-document fetch is outside the rate-limited SP-API wrappers and
  // can be several MB — a dead connection must end as an error, not hang.
  const downloadRes = await axios.get(docRes.url, { responseType: "text", timeout: 120_000 });
  const rawData = typeof downloadRes.data === "string" ? downloadRes.data : String(downloadRes.data);
  const lines: string[] = rawData.split("\n").filter((l: string) => l.trim());

  // A range Amazon refuses is a FAILURE of this chunk, not "no data".
  if (rawData.includes("Date range exceeded")) {
    throw new Error(`Amazon refused the range ${startDate}..${endDate}: ${rawData.substring(0, 120).trim()}`);
  }
  const empty = { chunk: { start: startDate, end: endDate, status: "empty" as const, orders: 0, days: 0, asins: 0, onboarded: [], invalidAsins: [], minDate: null, maxDate: null }, dates: new Set<string>(), asins: new Set<string>() };
  if (lines.length < 2) {
    log(`Chunk ${startDate}-${endDate}: no data (${rawData.substring(0, 100)})`, "sales-sync");
    return empty;
  }

  // 4. Parse TSV
  const parsed = parseOrdersReport(lines);
  if (parsed.length === 0) return empty;

  // 4b. Onboard ASINs AF does not have at all, BEFORE the upsert (2026-10-16),
  // so their rows land in this chunk. The insert path adds the rows; the
  // caller enqueues their Refresh job once at the end.
  const onboarded: string[] = [];
  // Malformed ASIN strings (the report writes placeholders such as "UNKNOW")
  // are skipped and listed — never onboarded, never written.
  const invalidAsins = Array.from(new Set(parsed.map((l) => l.asin).filter((a) => !ASIN_RE.test(a)))).sort();
  if (invalidAsins.length > 0) log(`Chunk ${startDate}-${endDate}: ${invalidAsins.length} malformed ASIN string(s) skipped: ${invalidAsins.slice(0, 10).join(", ")}`, "sales-sync");
  if (onboard) {
    const unknown = Array.from(new Set(parsed.map((l) => l.asin).filter((a) => ASIN_RE.test(a) && !asinIdMap.has(a)))).sort();
    if (unknown.length > 0) {
      await onboard(unknown);
      const added = await query(`SELECT id, asin FROM asins WHERE asin = ANY($1::text[])`, [unknown]);
      for (const row of added.rows) { asinIdMap.set(String(row.asin), String(row.id)); onboarded.push(String(row.asin)); }
      const missing = unknown.filter((a) => !asinIdMap.has(a));
      if (missing.length > 0) log(`Chunk ${startDate}-${endDate}: ${missing.length} ASIN(s) could not be onboarded, skipped: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`, "sales-sync");
    }
  }

  // Aggregate per ASIN + date
  const dailyMap = new Map<string, { asinId: string; asin: string; date: string; units: number; revenue: number }>();
  let totalOrders = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (const l of parsed) {
    if (!minDate || l.date < minDate) minDate = l.date;
    if (!maxDate || l.date > maxDate) maxDate = l.date;
    if (!ASIN_RE.test(l.asin)) continue;
    const asinId = asinIdMap.get(l.asin);
    if (!asinId) continue;
    const key = `${l.asin}|${l.date}`;
    const existing = dailyMap.get(key);
    if (existing) {
      existing.units += l.qty;
      existing.revenue += l.price;
    } else {
      dailyMap.set(key, { asinId, asin: l.asin, date: l.date, units: l.qty, revenue: l.price });
    }
    totalOrders++;
  }

  // 5. Upsert — units and revenue only; the refund / fee columns keep their
  // first-insert 0 default and are never touched here (components 20/21).
  const dateSet = new Set<string>();
  const asinSet = new Set<string>();

  for (const entry of Array.from(dailyMap.values())) {
    await query(
      `INSERT INTO sales_daily (asin_id, sale_date, units_sold, revenue, units_refunded, refund_amount)
       VALUES ($1, $2, $3, $4, 0, 0)
       ON CONFLICT (asin_id, sale_date) DO UPDATE SET
         units_sold = EXCLUDED.units_sold,
         revenue = EXCLUDED.revenue`,
      [entry.asinId, entry.date, entry.units, entry.revenue]
    );
    dateSet.add(entry.date);
    asinSet.add(entry.asin);
  }

  // (in_catalog retired 2026-10-15, migration 052: the "had an order" latch
  // this used to set was read by nothing.)

  log(`Chunk ${startDate}-${endDate}: ${totalOrders} orders, ${dateSet.size} days, ${asinSet.size} ASINs, ${onboarded.length} onboarded, returned ${minDate ?? "-"}..${maxDate ?? "-"}`, "sales-sync");
  return {
    chunk: { start: startDate, end: endDate, status: "ok", orders: totalOrders, days: dateSet.size, asins: asinSet.size, onboarded, invalidAsins, minDate, maxDate },
    dates: dateSet, asins: asinSet,
  };
}

/** Pure: TSV lines (header first) → non-cancelled order lines. Exported for tests. */
export function parseOrdersReport(lines: string[]): OrderLine[] {
  const headers = lines[0].replace(/\r$/, "").split("\t");
  const col = (name: string) => headers.indexOf(name);
  const iAsin = col("asin");
  const iDate = col("purchase-date");
  const iStatus = col("order-status");
  const iQty = col("quantity");
  const iPrice = col("item-price");
  if (iAsin < 0 || iDate < 0 || iQty < 0) {
    throw new Error(`Missing columns. Got: ${headers.join(", ")}`);
  }
  const out: OrderLine[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].replace(/\r$/, "").split("\t");
    const orderStatus = iStatus >= 0 ? cols[iStatus] : "";
    if (orderStatus === "Cancelled") continue;
    const asin = cols[iAsin];
    if (!asin) continue;
    out.push({
      asin,
      date: cols[iDate].substring(0, 10),
      qty: parseInt(cols[iQty]) || 0,
      price: iPrice >= 0 ? parseFloat(cols[iPrice]) || 0 : 0,
    });
  }
  return out;
}
