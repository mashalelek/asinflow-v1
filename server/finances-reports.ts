// The three reports behind the Finances lines Amazon's transactions do not
// carry (patch commit 4, SPEC §2 / §4 / §8): customer returns (Value of
// returned items, Sellable returns), the monthly storage fee report (per-ASIN
// storage) and removal order detail (Disposal of sellable products, the ASIN
// behind a removal / disposal fee). Rows are stored as received; the
// valuation happens in the aggregate (server/finances-aggregate.ts). Also the
// weight split of a shipment-level fee over its contents (§4, commit 0 (d))
// and the live read of a shipment the fee names that sc_inbound_shipments
// does not have yet.
import zlib from "node:zlib";
import axios from "axios";
import pool, { query as defaultQuery } from "./db";
import { spApiGet as realGet, spApiPost as realPost } from "./spapi-auth";
import { isThrottleError } from "./spapi-rate-limit";
import { log } from "./log";
import { pacificDay } from "./sales-sync";

export const MARKETPLACE = "ATVPDKIKX0DER";
export const RETURNS_REPORT = "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA";
export const STORAGE_REPORT = "GET_FBA_STORAGE_FEE_CHARGES_DATA";
export const REMOVALS_REPORT = "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA";
/** The returns and removal reports take at most 60 days per request. */
export const REPORT_CHUNK_DAYS = 60;
const POLL_MS = 15_000;
const POLL_TIMEOUT_MS = 20 * 60_000;
const QUOTA_WAIT_MS = 5 * 60_000;
const QUOTA_MAX_WAITS = 6;

type QueryFn = (sql: string, params?: any[]) => Promise<any>;
export interface ReportDeps {
  get: (endpoint: string, params?: Record<string, any>) => Promise<any>;
  post: (endpoint: string, body: any) => Promise<any>;
  download: (url: string) => Promise<Buffer>;
  sleep: (ms: number) => Promise<void>;
}
/** Test seam: the SP-API calls and the transaction the writes run in. */
export const reportDeps: ReportDeps & { transaction: <T>(fn: (q: QueryFn) => Promise<T>) => Promise<T> } = {
  get: realGet,
  post: realPost,
  download: async (url) => Buffer.from((await axios.get(url, { responseType: "arraybuffer", timeout: 120_000 })).data),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async transaction(fn) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const out = await fn((sql, params) => client.query(sql, params)); await client.query("COMMIT"); return out; }
    catch (err) { await client.query("ROLLBACK").catch(() => {}); throw err; }
    finally { client.release(); }
  },
};

/** Request, poll and download one report as text. QuotaExceeded waits and retries the same request. */
export async function fetchReport(reportType: string, dataStartTime: string, dataEndTime: string, deps: ReportDeps = reportDeps, L: (m: string) => void = () => {}): Promise<string> {
  const body = { reportType, marketplaceIds: [MARKETPLACE], dataStartTime, dataEndTime };
  let created: any;
  for (let waits = 0; ; waits++) {
    try { created = await deps.post("/reports/2021-06-30/reports", body); break; }
    catch (err: any) {
      if (!isThrottleError(err) || waits >= QUOTA_MAX_WAITS) throw new Error(`createReport ${reportType} ${dataStartTime.slice(0, 10)}..${dataEndTime.slice(0, 10)} failed: HTTP ${err?.response?.status ?? "?"} ${JSON.stringify(err?.response?.data ?? err?.message).slice(0, 200)}`);
      L(`createReport ${reportType}: QuotaExceeded — waiting ${QUOTA_WAIT_MS / 60_000} min (${waits + 1}/${QUOTA_MAX_WAITS})`);
      await deps.sleep(QUOTA_WAIT_MS);
    }
  }
  const reportId = String(created?.reportId ?? "");
  if (!reportId) throw new Error(`createReport ${reportType}: no reportId`);
  let docId: string | null = null;
  for (let waited = 0; waited < POLL_TIMEOUT_MS; waited += POLL_MS) {
    await deps.sleep(POLL_MS);
    const st = await deps.get(`/reports/2021-06-30/reports/${reportId}`);
    if (st?.processingStatus === "DONE") { docId = String(st.reportDocumentId); break; }
    if (st?.processingStatus === "FATAL" || st?.processingStatus === "CANCELLED") throw new Error(`${reportType} report ${reportId} ended ${st.processingStatus}`);
  }
  if (!docId) throw new Error(`${reportType} report ${reportId} timed out`);
  const doc = await deps.get(`/reports/2021-06-30/documents/${docId}`);
  let buf = await deps.download(String(doc.url));
  if (doc?.compressionAlgorithm === "GZIP") buf = zlib.gunzipSync(buf);
  return buf.toString("utf8");
}

/** Pure: a plain TSV (header first) → rows keyed by header. */
export function parseTsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const H = lines[0].split("\t").map((h) => h.trim());
  return lines.slice(1).map((l) => { const c = l.split("\t"); const o: Record<string, string> = {}; H.forEach((h, i) => { o[h] = (c[i] ?? "").trim(); }); return o; });
}

const int = (v: string | undefined) => { const n = parseInt(String(v ?? ""), 10); return Number.isFinite(n) ? n : 0; };
const num = (v: string | undefined) => { const n = parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : null; };
/** The report's day windows: [from 00:00Z, to 23:59:59Z], the end clamped to now (a dataEndTime in the future ends the report FATAL — job 61, 2026-11-20). */
export function dayWindow(from: string, to: string, now: Date = new Date()): { dataStartTime: string; dataEndTime: string } {
  const end = Math.min(Date.parse(`${to}T23:59:59Z`), now.getTime() - 60_000);
  return { dataStartTime: `${from}T00:00:00Z`, dataEndTime: new Date(end).toISOString().replace(/\.\d{3}Z$/, "Z") };
}
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
/** ≤ 60-day inclusive chunks of [from, to]. */
export function reportChunks(from: string, to: string, days = REPORT_CHUNK_DAYS): [string, string][] {
  const out: [string, string][] = [];
  for (let a = from; a <= to; a = addDays(a, days)) { const b = addDays(a, days - 1); out.push([a, b < to ? b : to]); }
  return out;
}

// ── Customer returns ───────────────────────────────────────────────────────

export interface ReturnRow { return_at: string; return_day: string; order_id: string; sku: string; asin: string | null; fnsku: string | null; quantity: number; fc: string | null; disposition: string; reason: string | null; status: string | null; lpn: string; raw: Record<string, string> }
export function parseReturns(text: string): ReturnRow[] {
  return parseTsv(text).filter((r) => r["return-date"] && r["order-id"]).map((r) => ({
    return_at: r["return-date"], return_day: pacificDay(r["return-date"]), order_id: r["order-id"], sku: r.sku ?? "", asin: r.asin || null, fnsku: r.fnsku || null,
    quantity: int(r.quantity), fc: r["fulfillment-center-id"] || null, disposition: r["detailed-disposition"] || "UNKNOWN", reason: r.reason || null, status: r.status || null, lpn: r["license-plate-number"] ?? "", raw: r,
  }));
}
/** Store a fully-read returns report (rows upserted by their key; nothing deleted — a return never un-happens). */
export async function storeReturns(rows: ReturnRow[], q: QueryFn): Promise<number> {
  for (const r of rows) {
    await q(`INSERT INTO fba_customer_returns (return_at, return_day, order_id, sku, asin, fnsku, quantity, fc, disposition, reason, status, lpn, raw, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb, now())
             ON CONFLICT (return_at, order_id, sku, lpn) DO UPDATE SET asin = EXCLUDED.asin, fnsku = EXCLUDED.fnsku, quantity = EXCLUDED.quantity, fc = EXCLUDED.fc, disposition = EXCLUDED.disposition, reason = EXCLUDED.reason, status = EXCLUDED.status, raw = EXCLUDED.raw, synced_at = now()`,
      [r.return_at, r.return_day, r.order_id, r.sku, r.asin, r.fnsku, r.quantity, r.fc, r.disposition, r.reason, r.status, r.lpn, JSON.stringify(r.raw)]);
  }
  return rows.length;
}
export async function ingestReturns(from: string, to: string, opts: { jobId?: number | null; log?: (m: string) => void } = {}): Promise<{ chunks: number; rows: number }> {
  const L = opts.log ?? ((m: string) => log(m, "finances"));
  let rows = 0; const chunks = reportChunks(from, to);
  for (const [a, b] of chunks) {
    const w = dayWindow(a, b);
    const text = await fetchReport(RETURNS_REPORT, w.dataStartTime, w.dataEndTime, reportDeps, L);
    const parsed = parseReturns(text);
    await reportDeps.transaction(async (q) => {
      await storeReturns(parsed, q);
      await q(`INSERT INTO finances_ingest_log (source, window_from, window_to, rows_read, rows_written, calls, job_id) VALUES ('returns', $1, $2, $3, $3, 0, $4)`, [w.dataStartTime, w.dataEndTime, parsed.length, opts.jobId ?? null]);
    });
    rows += parsed.length; L(`returns ${a}..${b}: ${parsed.length} rows`);
  }
  return { chunks: chunks.length, rows };
}

// ── Storage fees ───────────────────────────────────────────────────────────

export interface StorageRow { month: string; asin: string | null; fnsku: string | null; fc: string | null; fee: number; avg_qty: number | null; raw: Record<string, string> }
export function parseStorage(text: string): StorageRow[] {
  return parseTsv(text).filter((r) => r.month_of_charge).map((r) => ({ month: r.month_of_charge, asin: r.asin || null, fnsku: r.fnsku || null, fc: (r.fulfillment_center ?? "").replace(/^'|'$/g, "") || null, fee: num(r.estimated_monthly_storage_fee) ?? 0, avg_qty: num(r.average_quantity_on_hand), raw: r }));
}
/** Replace the month's rows with the report's (fail-closed: the report was read in full first). */
export async function storeStorage(month: string, rows: StorageRow[], q: QueryFn): Promise<number> {
  await q(`DELETE FROM fba_storage_fees WHERE month = $1`, [month]);
  for (const r of rows) await q(`INSERT INTO fba_storage_fees (month, asin, fnsku, fc, fee, avg_qty, raw) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [r.month, r.asin, r.fnsku, r.fc, r.fee, r.avg_qty, JSON.stringify(r.raw)]);
  return rows.length;
}
/** The storage fee report for one month (YYYY-MM): dataStartTime = the 1st, dataEndTime = the last day. */
export async function ingestStorageMonth(month: string, opts: { jobId?: number | null; log?: (m: string) => void } = {}): Promise<{ rows: number; total: number }> {
  const L = opts.log ?? ((m: string) => log(m, "finances"));
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const text = await fetchReport(STORAGE_REPORT, `${month}-01T00:00:00Z`, `${month}-${String(last).padStart(2, "0")}T00:00:00Z`, reportDeps, L);
  const rows = parseStorage(text).filter((r) => r.month === month);
  const total = Math.round(rows.reduce((s, r) => s + r.fee, 0) * 100) / 100;
  await reportDeps.transaction(async (q) => {
    await storeStorage(month, rows, q);
    await q(`INSERT INTO finances_ingest_log (source, window_from, window_to, rows_read, rows_written, calls, job_id) VALUES ('storage', $1, $2, $3, $3, 0, $4)`, [`${month}-01T00:00:00Z`, `${month}-${String(last).padStart(2, "0")}T00:00:00Z`, rows.length, opts.jobId ?? null]);
  });
  L(`storage ${month}: ${rows.length} rows, Σ ${total.toFixed(2)}`);
  return { rows: rows.length, total };
}
/** The report month behind a storage row posted on `postedDay` (the month before). */
export function storageMonthFor(postedDay: string): string {
  const [y, m] = postedDay.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ── Removal order detail ───────────────────────────────────────────────────

export interface RemovalRow { order_id: string; sku: string; disposition: string; asin: string | null; fnsku: string | null; request_at: string; updated_at: string | null; completed_day: string | null; order_type: string; order_status: string; requested_qty: number; cancelled_qty: number; disposed_qty: number; shipped_qty: number; in_process_qty: number; removal_fee: number | null; raw: Record<string, string> }
export function parseRemovals(text: string, skuToAsin?: (sku: string) => string | null): RemovalRow[] {
  return parseTsv(text).filter((r) => r["order-id"] && r["request-date"]).map((r) => ({
    order_id: r["order-id"], sku: r.sku ?? "", disposition: r.disposition ?? "", asin: skuToAsin?.(r.sku ?? "") ?? null, fnsku: r.fnsku || null,
    request_at: r["request-date"], updated_at: r["last-updated-date"] || null, completed_day: r["last-updated-date"] ? pacificDay(r["last-updated-date"]) : null,
    order_type: r["order-type"] ?? "", order_status: r["order-status"] ?? "", requested_qty: int(r["requested-quantity"]), cancelled_qty: int(r["cancelled-quantity"]), disposed_qty: int(r["disposed-quantity"]),
    shipped_qty: int(r["shipped-quantity"]), in_process_qty: int(r["in-process-quantity"]), removal_fee: num(r["removal-fee"]), raw: r,
  }));
}
export async function storeRemovals(rows: RemovalRow[], q: QueryFn): Promise<number> {
  for (const r of rows) {
    await q(`INSERT INTO fba_removals (order_id, sku, disposition, asin, fnsku, request_at, updated_at, completed_day, order_type, order_status, requested_qty, cancelled_qty, disposed_qty, shipped_qty, in_process_qty, removal_fee, raw, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb, now())
             ON CONFLICT (order_id, sku, disposition) DO UPDATE SET asin = COALESCE(EXCLUDED.asin, fba_removals.asin), fnsku = EXCLUDED.fnsku, updated_at = EXCLUDED.updated_at, completed_day = EXCLUDED.completed_day, order_type = EXCLUDED.order_type, order_status = EXCLUDED.order_status,
               requested_qty = EXCLUDED.requested_qty, cancelled_qty = EXCLUDED.cancelled_qty, disposed_qty = EXCLUDED.disposed_qty, shipped_qty = EXCLUDED.shipped_qty, in_process_qty = EXCLUDED.in_process_qty, removal_fee = EXCLUDED.removal_fee, raw = EXCLUDED.raw, synced_at = now()`,
      [r.order_id, r.sku, r.disposition, r.asin, r.fnsku, r.request_at, r.updated_at, r.completed_day, r.order_type, r.order_status, r.requested_qty, r.cancelled_qty, r.disposed_qty, r.shipped_qty, r.in_process_qty, r.removal_fee, JSON.stringify(r.raw)]);
  }
  return rows.length;
}
export async function ingestRemovals(from: string, to: string, opts: { jobId?: number | null; log?: (m: string) => void; skuMap?: Map<string, string> } = {}): Promise<{ chunks: number; rows: number }> {
  const L = opts.log ?? ((m: string) => log(m, "finances"));
  const skuMap = opts.skuMap ?? (await loadSkuMapForReports());
  let rows = 0; const chunks = reportChunks(from, to);
  for (const [a, b] of chunks) {
    const w = dayWindow(a, b);
    const text = await fetchReport(REMOVALS_REPORT, w.dataStartTime, w.dataEndTime, reportDeps, L);
    const parsed = parseRemovals(text, (sku) => skuMap.get(sku) ?? null);
    await reportDeps.transaction(async (q) => {
      await storeRemovals(parsed, q);
      await q(`INSERT INTO finances_ingest_log (source, window_from, window_to, rows_read, rows_written, calls, job_id) VALUES ('removals', $1, $2, $3, $3, 0, $4)`, [w.dataStartTime, w.dataEndTime, parsed.length, opts.jobId ?? null]);
    });
    rows += parsed.length; L(`removals ${a}..${b}: ${parsed.length} rows`);
  }
  return { chunks: chunks.length, rows };
}
async function loadSkuMapForReports(q: QueryFn = defaultQuery as any): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const row of (await q(`SELECT s.sku, a.asin FROM asin_skus s JOIN asins a ON a.id = s.asin_id`)).rows) m.set(String(row.sku), String(row.asin));
  return m;
}

// ── Shipment-level fees → the shipment's contents (§4) ─────────────────────

/**
 * Pure: split `amount` over a shipment's items by weight (qty × weight_lb; commit 0
 * (d) fixed the weighting at weight — units gave −13.88 against SB's −95.66,
 * weight −95.73). Items without a weight share by units among themselves only
 * when no item has one. Returns the share per ASIN; the unresolvable rest
 * (no ASIN) is returned under "" for the account-only part.
 */
export function splitByWeight(amount: number, items: ReadonlyArray<{ asin: string | null; qty: number; weight_lb: number | null }>): Map<string, number> {
  const out = new Map<string, number>();
  const anyWeight = items.some((i) => i.weight_lb != null && i.weight_lb > 0);
  const w = (i: { qty: number; weight_lb: number | null }) => (anyWeight ? i.qty * (i.weight_lb ?? 0) : i.qty);
  const total = items.reduce((s, i) => s + w(i), 0);
  if (!(total > 0)) { out.set("", amount); return out; }
  let allocated = 0;
  for (const i of items) {
    const share = Math.round((amount * w(i)) / total * 10000) / 10000;
    const key = i.asin ?? "";
    out.set(key, (out.get(key) ?? 0) + share);
    allocated += share;
  }
  const rest = Math.round((amount - allocated) * 10000) / 10000;
  if (rest !== 0) { const k = out.keys().next().value as string; out.set(k, (out.get(k) ?? 0) + rest); }
  return out;
}

/** The shipments among `ids` that sc_inbound_shipments lacks are read live (header + items) and stored, so a fee row can be split (§4). Never throws: a shipment Amazon no longer answers for stays unknown (account-only). */
export async function ensureShipmentsKnown(ids: readonly string[], opts: { log?: (m: string) => void; q?: QueryFn; get?: ReportDeps["get"] } = {}): Promise<string[]> {
  const q = opts.q ?? (defaultQuery as any); const get = opts.get ?? reportDeps.get; const L = opts.log ?? ((m: string) => log(m, "finances"));
  const want = Array.from(new Set(ids.filter((id) => /^FBA[A-Z0-9]+$/.test(id))));
  if (want.length === 0) return [];
  const have = new Set((await q(`SELECT shipment_id FROM sc_inbound_shipments WHERE shipment_id = ANY($1::text[])`, [want])).rows.map((r: any) => String(r.shipment_id)));
  const missing = want.filter((id) => !have.has(id));
  const added: string[] = [];
  const skuMap = await loadSkuMapForReports(q);
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    let headers: any[] = [];
    try { const d = await get("/fba/inbound/v0/shipments", { QueryType: "SHIPMENT", ShipmentIdList: batch.join(","), MarketplaceId: MARKETPLACE }); headers = d?.payload?.ShipmentData ?? []; }
    catch (err: any) { L(`shipments ${batch.join(",")}: header read failed — ${err?.message ?? err}`); }
    const byId = new Map(headers.map((h: any) => [String(h.ShipmentId), h]));
    for (const id of batch) {
      try {
        const d = await get(`/fba/inbound/v0/shipments/${encodeURIComponent(id)}/items`, { MarketplaceId: MARKETPLACE });
        const items: any[] = d?.payload?.ItemData ?? [];
        if (items.length === 0) continue;
        const h = byId.get(id);
        await q(`INSERT INTO sc_inbound_shipments (shipment_id, name, name_ts, status, ship_from, fc, raw, synced_at) VALUES ($1,$2,NULL,$3,$4,$5,$6::jsonb, now()) ON CONFLICT (shipment_id) DO NOTHING`,
          [id, h?.ShipmentName ?? null, h?.ShipmentStatus ?? "UNKNOWN", h?.ShipFromAddress?.Name ?? null, h?.DestinationFulfillmentCenterId ?? null, JSON.stringify(h ?? { ShipmentId: id, source: "finances fee row" })]);
        await q(`DELETE FROM sc_inbound_items WHERE shipment_id = $1`, [id]);
        for (const it of items) await q(`INSERT INTO sc_inbound_items (shipment_id, seller_sku, fnsku, asin, qty_shipped, qty_received) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [id, it.SellerSKU, it.FulfillmentNetworkSKU ?? null, skuMap.get(it.SellerSKU) ?? null, Number(it.QuantityShipped ?? 0), Number(it.QuantityReceived ?? 0)]);
        added.push(id);
      } catch (err: any) { L(`shipment ${id}: item read failed — ${err?.message ?? err}`); }
    }
  }
  if (added.length) L(`${added.length} shipment(s) named by fee rows read live: ${added.join(", ")}`);
  return added;
}
