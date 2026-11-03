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
// results so far); it is never skipped silently.
//
// Day basis (Dashboard patch D7, 2026-11-03; SPEC §11 / §28): Amazon's sales
// day is US Pacific. `sale_date` is the America/Los_Angeles calendar day of
// `purchase-date`, and each chunk's report is requested with Pacific day
// boundaries converted to UTC. Before a chunk's rows are written, the window's
// `sales_daily` and `sales_orders` rows are DELETED and reloaded inside one
// transaction — and only after the report was fully read and parsed
// (fail-closed, §14 manual-trigger completeness), so a failed report leaves
// the old rows untouched and the pre-patch UTC-keyed rows disappear as the
// backfill passes over them. `sales_orders` (migration 082) gets one row per
// (order id, ASIN) so the Dashboard can count distinct orders per range (C2).
import axios from "axios";
import { spApiGet, spApiPost } from "./spapi";
import pool, { query } from "./db";
import { log } from "./log";

const MARKETPLACE_ID = "ATVPDKIKX0DER";
/** Amazon's sales-day basis (D7). */
export const SALES_TZ = "America/Los_Angeles";
/** Test seam: polling / pacing delays. */
export const salesTiming = { pollMs: 10_000, pollTimeoutMs: 5 * 60_000, chunkDelayMs: 2_000 };
/** 30-day chunks — the limit the code has always asserted for this report type (the "Date range exceeded" response is the check). */
export const MAX_RANGE_DAYS = 30;
/** A well-formed ASIN. The report carries placeholders like "UNKNOW" on some lines; those are never onboarded (2026-10-16). */
export const ASIN_RE = /^[A-Z0-9]{10}$/;

type QueryFn = (sql: string, params?: any[]) => Promise<any>;
/** Test seam: the clock (dataEndTime is clamped to it) and the transaction the delete + reload runs in. */
export const salesDb = {
  now: () => new Date(),
  async transaction<T>(fn: (q: QueryFn) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn((sql, params) => client.query(sql, params));
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally { client.release(); }
  },
};

export interface SalesChunkResult {
  start: string;
  end: string;
  status: "ok" | "empty" | "failed";
  /** Non-cancelled order LINES written (the historical meaning of this field). */
  orders: number;
  /** Distinct Amazon order ids written to sales_orders. */
  distinctOrders: number;
  days: number;
  asins: number;
  /** ASINs the report named that AF lacked and that were inserted before this chunk's upsert. */
  onboarded: string[];
  /** Distinct malformed ASIN strings the report carried (e.g. "UNKNOW"); their lines are skipped, never onboarded. */
  invalidAsins: string[];
  /** Earliest / latest Pacific `sale_date` the report actually returned for this chunk (null when empty). */
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

// ── Pacific day helpers (pure, exported for tests and the Dashboard) ──────────

/** Minutes east of UTC that `tz` is at the instant `at` (America/Los_Angeles: −420 PDT, −480 PST). */
export function tzOffsetMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((wall - at.getTime()) / 60_000);
}

/** The America/Los_Angeles calendar day (YYYY-MM-DD) of an ISO timestamp; an unparseable value keeps its first 10 characters. */
export function pacificDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).substring(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: SALES_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** The UTC instant (ISO, seconds) of a Pacific wall-clock time `${ymd}T${hms}` — DST-correct. */
export function pacificToUtc(ymd: string, hms: string): string {
  const guess = new Date(`${ymd}T${hms}Z`);
  let utc = new Date(guess.getTime() - tzOffsetMinutes(guess, SALES_TZ) * 60_000);
  const second = tzOffsetMinutes(utc, SALES_TZ);
  utc = new Date(guess.getTime() - second * 60_000);
  return utc.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The report request window for a Pacific-day chunk [start, end]: Pacific midnight → Pacific 23:59:59, as UTC, the end clamped to now. */
export function reportWindowUtc(startDate: string, endDate: string, now: Date = salesDb.now()): { dataStartTime: string; dataEndTime: string } {
  const dataStartTime = pacificToUtc(startDate, "00:00:00");
  let end = pacificToUtc(endDate, "23:59:59");
  const nowIso = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (end > nowIso) end = nowIso;
  return { dataStartTime, dataEndTime: end };
}

export async function syncSalesData(
  startDate: string,
  endDate: string,
  asinFilter?: ReadonlySet<string>,
  opts: SalesSyncOptions = {},
): Promise<SalesSyncResult> {
  const chunks = buildDateChunks(startDate, endDate, MAX_RANGE_DAYS);
  log(`Sales sync: ${startDate} to ${endDate} (Pacific days) → ${chunks.length} chunk(s)${asinFilter ? ` (filtered to ${asinFilter.size} ASINs)` : " (every ASIN, all statuses)"}`, "sales-sync");

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
      const r = await fetchChunk(chunkStart, chunkEnd, asinIdMap, filtered ? undefined : opts.onboard, filtered ? Array.from(asinIdMap.values()) : null);
      r.dates.forEach((d) => allDates.add(d));
      r.asins.forEach((a) => allAsins.add(a));
      chunk = r.chunk;
    } catch (err: any) {
      chunk = { start: chunkStart, end: chunkEnd, status: "failed", orders: 0, distinctOrders: 0, days: 0, asins: 0, onboarded: [], invalidAsins: [], minDate: null, maxDate: null, error: err?.message ?? String(err) };
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
  log(`Sales sync complete: ${result.daysProcessed} days, ${result.asinsUpdated} ASINs, ${result.totalOrders} order lines, ${result.onboarded.length} onboarded, returned ${result.minDate ?? "-"}..${result.maxDate ?? "-"}`, "sales-sync");
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

/** Parsed, non-cancelled order line. `date` is the Pacific day of the purchase. */
interface OrderLine { orderId: string; asin: string; date: string; qty: number; price: number }

async function fetchChunk(
  startDate: string,
  endDate: string,
  asinIdMap: Map<string, string>,
  onboard: ((asins: string[]) => Promise<void>) | undefined,
  /** Non-null = an explicit ASIN selection: only these asin ids are deleted and reloaded. */
  scopeAsinIds: string[] | null,
): Promise<{ chunk: SalesChunkResult; dates: Set<string>; asins: Set<string> }> {
  // 1. Create report — Pacific day boundaries, as UTC (D7).
  const window = reportWindowUtc(startDate, endDate);
  const createRes = await spApiPost("/reports/2021-06-30/reports", {
    reportType: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL",
    marketplaceIds: [MARKETPLACE_ID],
    dataStartTime: window.dataStartTime,
    dataEndTime: window.dataEndTime,
  });

  const reportId: string = createRes.reportId;
  log(`Report created: ${reportId} (${window.dataStartTime} → ${window.dataEndTime})`, "sales-sync");

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
  // A report with NO data rows is not evidence of "no sales": Amazon's orders
  // report has a retention horizon (the 2026-11-03 local backfill got header-
  // only answers for every chunk before 2024-10-28 while AF held rows for
  // Sept–Oct 2024), so such a chunk leaves the window's rows exactly as they
  // are — nothing read, nothing replaced. A report that HAS rows is a complete
  // answer for the window even when every row is cancelled: the window is
  // cleared (a day whose only order was cancelled must not keep stale units).
  const emptyChunk = { start: startDate, end: endDate, status: "empty" as const, orders: 0, distinctOrders: 0, days: 0, asins: 0, onboarded: [], invalidAsins: [], minDate: null, maxDate: null };
  if (lines.length < 2) {
    log(`Chunk ${startDate}-${endDate}: no data rows — the window's stored rows are left untouched (${rawData.substring(0, 100)})`, "sales-sync");
    return { chunk: emptyChunk, dates: new Set<string>(), asins: new Set<string>() };
  }

  // 4. Parse TSV
  const parsed = parseOrdersReport(lines);
  if (parsed.length === 0) {
    await replaceWindow(startDate, endDate, scopeAsinIds, [], []);
    return { chunk: emptyChunk, dates: new Set<string>(), asins: new Set<string>() };
  }

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

  // Aggregate per ASIN + Pacific day, and per (order id, ASIN) for sales_orders.
  const dailyMap = new Map<string, { asinId: string; asin: string; date: string; units: number; revenue: number }>();
  const orderMap = new Map<string, { orderId: string; asinId: string; date: string; units: number }>();
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
    if (l.orderId) {
      const ok = `${l.orderId}|${asinId}`;
      const o = orderMap.get(ok);
      if (o) o.units += l.qty; else orderMap.set(ok, { orderId: l.orderId, asinId, date: l.date, units: l.qty });
    }
    totalOrders++;
  }

  // 5. Delete + reload the window (fail-closed: the report is fully parsed by
  // now; the delete and the inserts commit together or not at all). Units and
  // revenue only; the refund / fee columns keep their first-insert 0 default
  // and are never in the SET list (components 20/21).
  const dailyRows = Array.from(dailyMap.values());
  const orderRows = Array.from(orderMap.values());
  await replaceWindow(startDate, endDate, scopeAsinIds, dailyRows, orderRows);
  const dateSet = new Set<string>(dailyRows.map((e) => e.date));
  const asinSet = new Set<string>(dailyRows.map((e) => e.asin));
  const distinctOrders = new Set(orderRows.map((o) => o.orderId)).size;

  // (in_catalog retired 2026-10-15, migration 052: the "had an order" latch
  // this used to set was read by nothing.)

  log(`Chunk ${startDate}-${endDate}: ${totalOrders} order lines (${distinctOrders} orders), ${dateSet.size} days, ${asinSet.size} ASINs, ${onboarded.length} onboarded, returned ${minDate ?? "-"}..${maxDate ?? "-"}`, "sales-sync");
  return {
    chunk: { start: startDate, end: endDate, status: "ok", orders: totalOrders, distinctOrders, days: dateSet.size, asins: asinSet.size, onboarded, invalidAsins, minDate, maxDate },
    dates: dateSet, asins: asinSet,
  };
}

/** One transaction: the window's sales_daily + sales_orders rows out (scoped to the selection when there is one), the parsed rows in. */
async function replaceWindow(
  startDate: string,
  endDate: string,
  scopeAsinIds: string[] | null,
  dailyRows: ReadonlyArray<{ asinId: string; date: string; units: number; revenue: number }>,
  orderRows: ReadonlyArray<{ orderId: string; asinId: string; date: string; units: number }>,
): Promise<void> {
  await salesDb.transaction(async (q) => {
    const scope = scopeAsinIds ? ` AND asin_id = ANY($3::uuid[])` : "";
    const params = scopeAsinIds ? [startDate, endDate, scopeAsinIds] : [startDate, endDate];
    await q(`DELETE FROM sales_daily WHERE sale_date >= $1::date AND sale_date <= $2::date${scope}`, params);
    await q(`DELETE FROM sales_orders WHERE sale_date >= $1::date AND sale_date <= $2::date${scope}`, params);
    for (const entry of dailyRows) {
      await q(
        `INSERT INTO sales_daily (asin_id, sale_date, units_sold, revenue, units_refunded, refund_amount)
         VALUES ($1, $2, $3, $4, 0, 0)
         ON CONFLICT (asin_id, sale_date) DO UPDATE SET
           units_sold = EXCLUDED.units_sold,
           revenue = EXCLUDED.revenue`,
        [entry.asinId, entry.date, entry.units, entry.revenue],
      );
    }
    for (const o of orderRows) {
      await q(
        `INSERT INTO sales_orders (amazon_order_id, asin_id, sale_date, units)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (amazon_order_id, asin_id) DO UPDATE SET
           sale_date = EXCLUDED.sale_date,
           units = EXCLUDED.units,
           synced_at = now()`,
        [o.orderId, o.asinId, o.date, o.units],
      );
    }
  });
}

/** Pure: TSV lines (header first) → non-cancelled order lines, dated by the Pacific day. Exported for tests. */
export function parseOrdersReport(lines: string[]): OrderLine[] {
  const headers = lines[0].replace(/\r$/, "").split("\t");
  const col = (name: string) => headers.indexOf(name);
  const iOrder = col("amazon-order-id");
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
      orderId: iOrder >= 0 ? (cols[iOrder] ?? "").trim() : "",
      asin,
      date: pacificDay(cols[iDate]),
      qty: parseInt(cols[iQty]) || 0,
      price: iPrice >= 0 ? parseFloat(cols[iPrice]) || 0 : 0,
    });
  }
  return out;
}
