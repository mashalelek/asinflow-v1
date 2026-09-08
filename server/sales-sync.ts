import axios from "axios";
import { spApiGet, spApiPost } from "./spapi";
import { query } from "./db";
import { log } from "./index";

const MARKETPLACE_ID = "ATVPDKIKX0DER";
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 5 * 60_000;
const MAX_RANGE_DAYS = 30;

export async function syncSalesData(
  startDate: string,
  endDate: string,
  asinFilter?: ReadonlySet<string>,
): Promise<{ daysProcessed: number; asinsUpdated: number; totalOrders: number }> {
  // Split into 30-day chunks (SP-API limit)
  const chunks = buildDateChunks(startDate, endDate, MAX_RANGE_DAYS);
  log(`Sales sync: ${startDate} to ${endDate} → ${chunks.length} chunk(s)${asinFilter ? ` (filtered to ${asinFilter.size} ASINs)` : ""}`, "sales-sync");

  // Build ASIN lookup once. The orders report itself is global; we filter by
  // populating asinIdMap with only the requested subset so chunk processing
  // skips orders whose ASIN isn't in the map.
  const sql = asinFilter && asinFilter.size > 0
    // Explicit selection: exactly those ASINs, archived included (SPEC 14).
    ? `SELECT id, asin FROM asins WHERE asin = ANY($1::text[])`
    : `SELECT id, asin FROM asins WHERE status IN ('active', 'parked')`; // cron scope: decision 5, 2026-09-07
  const params = asinFilter && asinFilter.size > 0 ? [Array.from(asinFilter)] : undefined;
  const asinRows = await query(sql, params);
  const asinIdMap = new Map<string, string>();
  for (const row of asinRows.rows) {
    asinIdMap.set(row.asin, row.id);
  }

  const allDates = new Set<string>();
  const allAsins = new Set<string>();
  let allOrders = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const [chunkStart, chunkEnd] = chunks[ci];
    log(`Chunk ${ci + 1}/${chunks.length}: ${chunkStart} to ${chunkEnd}`, "sales-sync");

    try {
      const chunkResult = await fetchAndProcessChunk(chunkStart, chunkEnd, asinIdMap);
      chunkResult.dates.forEach((d) => allDates.add(d));
      chunkResult.asins.forEach((a) => allAsins.add(a));
      allOrders += chunkResult.orders;
    } catch (err: any) {
      log(`Chunk ${ci + 1} failed: ${err.message}`, "sales-sync");
      // Continue with next chunk instead of failing entirely
    }

    // Small delay between chunks to avoid rate limits
    if (ci < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const result = { daysProcessed: allDates.size, asinsUpdated: allAsins.size, totalOrders: allOrders };
  log(`Sales sync complete: ${result.daysProcessed} days, ${result.asinsUpdated} ASINs, ${allOrders} orders`, "sales-sync");
  return result;
}

function buildDateChunks(start: string, end: string, maxDays: number): [string, string][] {
  const chunks: [string, string][] = [];
  let cursor = new Date(start + "T12:00:00Z");
  const endDate = new Date(end + "T12:00:00Z");

  while (cursor <= endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());

    chunks.push([fmtDate(cursor), fmtDate(chunkEnd)]);

    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return chunks;
}

function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

async function fetchAndProcessChunk(
  startDate: string,
  endDate: string,
  asinIdMap: Map<string, string>
): Promise<{ dates: Set<string>; asins: Set<string>; orders: number }> {
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
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let reportDocumentId: string | undefined;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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

  if (lines.length < 2 || rawData.includes("Date range exceeded")) {
    log(`Chunk ${startDate}-${endDate}: no data (${rawData.substring(0, 100)})`, "sales-sync");
    return { dates: new Set(), asins: new Set(), orders: 0 };
  }

  // 4. Parse TSV
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

  // Aggregate per ASIN + date
  const dailyMap = new Map<string, { asinId: string; asin: string; date: string; units: number; revenue: number }>();
  let totalOrders = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].replace(/\r$/, "").split("\t");
    const asin = cols[iAsin];
    const orderStatus = iStatus >= 0 ? cols[iStatus] : "";
    if (orderStatus === "Cancelled") continue;

    const asinId = asinIdMap.get(asin);
    if (!asinId) continue;

    const saleDate = cols[iDate].substring(0, 10);
    const qty = parseInt(cols[iQty]) || 0;
    const price = iPrice >= 0 ? parseFloat(cols[iPrice]) || 0 : 0;

    const key = `${asin}|${saleDate}`;
    const existing = dailyMap.get(key);
    if (existing) {
      existing.units += qty;
      existing.revenue += price;
    } else {
      dailyMap.set(key, { asinId, asin, date: saleDate, units: qty, revenue: price });
    }
    totalOrders++;
  }

  // 5. Upsert
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

  // Mark ASINs with orders as in_catalog (they had a listing to receive orders)
  if (asinSet.size > 0) {
    await query(`UPDATE asins SET in_catalog = TRUE WHERE asin = ANY($1::text[])`, [Array.from(asinSet)]);
  }

  log(`Chunk ${startDate}-${endDate}: ${totalOrders} orders, ${dateSet.size} days, ${asinSet.size} ASINs`, "sales-sync");
  return { dates: dateSet, asins: asinSet, orders: totalOrders };
}
