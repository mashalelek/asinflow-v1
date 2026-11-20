// Finances API v2024-06-19 → finances_transactions / finances_lines
// (docs/claude_spec-patch-finances-api.md §2, §3, §8; migration 123).
//
// The ONLY module that calls /finances/. One GET per page (500 transactions,
// nextToken resent with the window and marketplaceId), 0.5 rps through the
// rate limiter. A window is read in full before anything is written
// (fail-closed, §7): every transaction of the window is upserted by
// transactionId and its lines replaced; a DEFERRED_RELEASED row is never
// stored — it (and a RELEASED row's DEFERRED_TRANSACTION_ID) marks the stored
// DEFERRED row superseded, so the aggregate reads the released state alone
// (§3: nothing is added twice, transactionId is never the key).
import pool, { query as defaultQuery } from "./db";
import { spApiGet } from "./spapi-auth";
import { log } from "./log";
import { pacificDay } from "./sales-sync";
import { classifyLeaf, type FinancesLine } from "@shared/finances";

export const MARKETPLACE_ID = "ATVPDKIKX0DER";
export const FINANCES_PATH = "/finances/2024-06-19/transactions";
/** Amazon keeps 730 days; the earliest postedAfter it accepts moves a day per day (2024-11-19 on 2026-11-18). */
export const FINANCES_RETENTION_DAYS = 730;
/** One listTransactions window is at most 180 days; the ingest uses 7-day windows (a week ≈ 500–600 transactions, 1–2 pages). */
export const FINANCES_WINDOW_DAYS = 7;

type QueryFn = (sql: string, params?: any[]) => Promise<any>;

/** Test seam: the HTTP GET and the transaction the replace runs in. */
export const financesDeps = {
  get: (params: Record<string, any>) => spApiGet(FINANCES_PATH, params) as Promise<any>,
  async transaction<T>(fn: (q: QueryFn) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const out = await fn((sql, params) => client.query(sql, params)); await client.query("COMMIT"); return out; }
    catch (err) { await client.query("ROLLBACK").catch(() => {}); throw err; }
    finally { client.release(); }
  },
  now: () => new Date(),
};

// ── Parsing (pure, exported for tests) ─────────────────────────────────────

export interface ParsedTx {
  transaction_id: string; transaction_type: string; transaction_status: "RELEASED" | "DEFERRED";
  posted_at: string; posted_day: string; description: string | null; total_amount: number;
  order_id: string | null; shipment_id: string | null; refund_id: string | null; settlement_id: string | null; event_group_id: string | null;
  deferred_transaction_id: string | null; raw: any;
  lines: ParsedLine[];
}
export interface ParsedLine {
  item_index: number; sku: string | null; asin: string | null; quantity: number | null;
  leaf_path: string; line: FinancesLine; amount: number;
}
/** A DEFERRED_RELEASED row: not stored; its id (the original deferred transaction's) is marked superseded. */
export interface ParsedRelease { transaction_id: string; release_transaction_id: string | null }

const r2 = (n: number) => Math.round(n * 100) / 100;
function idOf(tx: any, name: string): string | null {
  const r = (tx.relatedIdentifiers ?? []).find((x: any) => x.relatedIdentifierName === name);
  return r?.relatedIdentifierValue ?? null;
}
function leaves(bds: any[] | undefined, prefix = "", out: [string, number][] = []): [string, number][] {
  for (const b of bds ?? []) {
    const k = prefix ? `${prefix} > ${b.breakdownType}` : String(b.breakdownType ?? "");
    if (b.breakdowns?.length) leaves(b.breakdowns, k, out);
    else out.push([k, Number(b.breakdownAmount?.currencyAmount ?? 0)]);
  }
  return out;
}

/** One Finances transaction → the stored row + lines, or the release marker, or null (unknown status). */
export function parseTransaction(tx: any, skuToAsin?: (sku: string) => string | null): ParsedTx | ParsedRelease | null {
  const status = String(tx.transactionStatus ?? "");
  if (status === "DEFERRED_RELEASED") return { transaction_id: String(tx.transactionId), release_transaction_id: idOf(tx, "RELEASE_TRANSACTION_ID") };
  if (status !== "RELEASED" && status !== "DEFERRED") return null;
  const type = String(tx.transactionType ?? "");
  const posted_at = String(tx.postedDate);
  const base = {
    transaction_id: String(tx.transactionId), transaction_type: type, transaction_status: status as "RELEASED" | "DEFERRED",
    posted_at, posted_day: pacificDay(posted_at), description: tx.description ?? null, total_amount: r2(Number(tx.totalAmount?.currencyAmount ?? 0)),
    order_id: idOf(tx, "ORDER_ID"), shipment_id: idOf(tx, "SHIPMENT_ID"), refund_id: idOf(tx, "REFUND_ID"), settlement_id: idOf(tx, "SETTLEMENT_ID"),
    event_group_id: idOf(tx, "FINANCIAL_EVENT_GROUP_ID"), deferred_transaction_id: idOf(tx, "DEFERRED_TRANSACTION_ID"), raw: tx,
  };
  const lines: ParsedLine[] = [];
  const ctxOf = (it: any) => { const c = (it.contexts ?? []).find((x: any) => x.contextType === "ProductContext") ?? it.contexts?.[0] ?? {}; const sku = c.sku ?? null; const asin = c.asin ?? (sku && skuToAsin ? skuToAsin(sku) : null) ?? null; return { sku, asin, quantity: c.quantityShipped == null ? null : Number(c.quantityShipped) }; };
  if (type === "Shipment" || type === "Refund") {
    (tx.items ?? []).forEach((it: any, i: number) => {
      const c = ctxOf(it);
      for (const [leaf, amt] of leaves(it.breakdowns)) {
        if (amt === 0) continue;
        lines.push({ item_index: i, ...c, leaf_path: leaf, line: classifyLeaf(type, leaf), amount: r2(amt) });
      }
    });
  } else if (type === "FBAInventoryReimbursement") {
    const reason = String(tx.description ?? "UNKNOWN");
    (tx.items ?? []).forEach((it: any, i: number) => {
      const c = ctxOf(it);
      lines.push({ item_index: i, ...c, leaf_path: reason, line: `reimb:${reason}`, amount: r2(Number(it.totalAmount?.currencyAmount ?? 0)) });
    });
  } else if (type === "ServiceFee") {
    const kind = String(tx.description ?? "ServiceFee");
    // Fee rows have no money per item (the item carries the fee's name, sometimes an ASIN): one line per transaction, the first item's context.
    const c = ctxOf(tx.items?.[0] ?? {});
    lines.push({ item_index: 0, ...c, leaf_path: kind, line: `svc:${kind}`, amount: base.total_amount });
  } else if (type === "Transfer") {
    // Disbursements: stored on the transaction only (§2 "shown nowhere in this patch").
  } else {
    lines.push({ item_index: 0, sku: null, asin: null, quantity: null, leaf_path: type, line: `other:${type}`, amount: base.total_amount });
  }
  return { ...base, lines };
}

// ── Fetch ──────────────────────────────────────────────────────────────────

export interface FetchResult { transactions: any[]; calls: number }

/** Every transaction posted in [postedAfter, postedBefore): all pages, in memory. Throws on any failed page (the window is then not written). */
export async function fetchTransactions(postedAfter: string, postedBefore: string): Promise<FetchResult> {
  const transactions: any[] = [];
  let next: string | undefined; let calls = 0;
  do {
    const params: Record<string, any> = { postedAfter, postedBefore, marketplaceId: MARKETPLACE_ID };
    if (next) params.nextToken = next;
    const data = await financesDeps.get(params);
    calls++;
    const payload = data?.payload ?? data ?? {};
    for (const tx of payload.transactions ?? []) transactions.push(tx);
    next = payload.nextToken || undefined;
    if (calls > 2000) throw new Error(`finances: ${postedAfter}..${postedBefore} did not end after ${calls} pages`);
  } while (next);
  return { transactions, calls };
}

// ── Ingest ─────────────────────────────────────────────────────────────────

export interface IngestResult { window: { from: string; to: string }; read: number; stored: number; released: number; superseded: number; calls: number; days: { from: string | null; to: string | null } }

/** SKU → ASIN for the item contexts that carry only a SKU (asin_skus; asins.primary_sku as the fallback). */
export async function loadSkuMap(q: QueryFn = defaultQuery as any): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const r = await q(`SELECT s.sku, a.asin FROM asin_skus s JOIN asins a ON a.id = s.asin_id`);
  for (const row of r.rows) m.set(String(row.sku), String(row.asin));
  return m;
}

/** Store one fully-read window of transactions (pure DB; the test feeds recorded pages). */
export async function storeTransactions(transactions: any[], skuMap: Map<string, string>, jobId: number | null = null, window?: { from: string; to: string }, calls = 0): Promise<IngestResult> {
  const parsed: ParsedTx[] = []; const releases: ParsedRelease[] = [];
  const skuToAsin = (sku: string) => skuMap.get(sku) ?? null;
  for (const tx of transactions) {
    const p = parseTransaction(tx, skuToAsin);
    if (!p) continue;
    if ("lines" in p) parsed.push(p); else releases.push(p);
  }
  let superseded = 0; let minDay: string | null = null; let maxDay: string | null = null;
  await financesDeps.transaction(async (q) => {
    for (const t of parsed) {
      if (!minDay || t.posted_day < minDay) minDay = t.posted_day;
      if (!maxDay || t.posted_day > maxDay) maxDay = t.posted_day;
      await q(
        `INSERT INTO finances_transactions (transaction_id, transaction_type, transaction_status, posted_at, posted_day, description, total_amount, order_id, shipment_id, refund_id, settlement_id, event_group_id, deferred_transaction_id, raw, ingested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb, now())
         ON CONFLICT (transaction_id) DO UPDATE SET transaction_type = EXCLUDED.transaction_type, transaction_status = EXCLUDED.transaction_status, posted_at = EXCLUDED.posted_at, posted_day = EXCLUDED.posted_day,
           description = EXCLUDED.description, total_amount = EXCLUDED.total_amount, order_id = EXCLUDED.order_id, shipment_id = EXCLUDED.shipment_id, refund_id = EXCLUDED.refund_id, settlement_id = EXCLUDED.settlement_id,
           event_group_id = EXCLUDED.event_group_id, deferred_transaction_id = EXCLUDED.deferred_transaction_id, raw = EXCLUDED.raw, ingested_at = now()`,
        [t.transaction_id, t.transaction_type, t.transaction_status, t.posted_at, t.posted_day, t.description, t.total_amount, t.order_id, t.shipment_id, t.refund_id, t.settlement_id, t.event_group_id, t.deferred_transaction_id, JSON.stringify(t.raw)],
      );
      await q(`DELETE FROM finances_lines WHERE transaction_id = $1`, [t.transaction_id]);
      for (const l of t.lines) {
        await q(
          `INSERT INTO finances_lines (transaction_id, transaction_type, transaction_status, posted_at, posted_day, order_id, shipment_id, refund_id, item_index, sku, asin, quantity, leaf_path, line, amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [t.transaction_id, t.transaction_type, t.transaction_status, t.posted_at, t.posted_day, t.order_id, t.shipment_id, t.refund_id, l.item_index, l.sku, l.asin, l.quantity, l.leaf_path, l.line, l.amount],
        );
      }
      // A RELEASED row names the DEFERRED row it replaces.
      if (t.transaction_status === "RELEASED" && t.deferred_transaction_id) {
        const r = await q(`UPDATE finances_transactions SET superseded_at = COALESCE(superseded_at, now()) WHERE transaction_id = $1 AND transaction_status = 'DEFERRED' AND transaction_id <> $2`, [t.deferred_transaction_id, t.transaction_id]);
        superseded += r.rowCount ?? 0;
      }
    }
    // A DEFERRED_RELEASED row keeps the deferred transaction's own id.
    for (const rel of releases) {
      const r = await q(`UPDATE finances_transactions SET superseded_at = COALESCE(superseded_at, now()) WHERE transaction_id = $1 AND transaction_status = 'DEFERRED'`, [rel.transaction_id]);
      superseded += r.rowCount ?? 0;
    }
    if (window) await q(`INSERT INTO finances_ingest_log (source, window_from, window_to, rows_read, rows_written, calls, job_id) VALUES ('transactions', $1, $2, $3, $4, $5, $6)`, [window.from, window.to, transactions.length, parsed.length, calls, jobId]);
  });
  return { window: window ?? { from: "", to: "" }, read: transactions.length, stored: parsed.length, released: releases.length, superseded, calls, days: { from: minDay, to: maxDay } };
}

/** Read one posted window in full, then store it (fail-closed). */
export async function ingestWindow(postedAfter: string, postedBefore: string, opts: { jobId?: number | null; skuMap?: Map<string, string>; log?: (m: string) => void } = {}): Promise<IngestResult> {
  const L = opts.log ?? ((m: string) => log(m, "finances"));
  const { transactions, calls } = await fetchTransactions(postedAfter, postedBefore);
  const skuMap = opts.skuMap ?? (await loadSkuMap());
  const r = await storeTransactions(transactions, skuMap, opts.jobId ?? null, { from: postedAfter, to: postedBefore }, calls);
  L(`window ${postedAfter.slice(0, 10)}..${postedBefore.slice(0, 10)}: ${r.read} read in ${calls} call(s), ${r.stored} stored, ${r.released} released, ${r.superseded} deferred rows superseded`);
  return r;
}

/** The weekly windows covering [from, to) as ISO instants. */
export function weeklyWindows(from: Date, to: Date, days = FINANCES_WINDOW_DAYS): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += days * 86400_000) out.push({ from: new Date(t).toISOString(), to: new Date(Math.min(t + days * 86400_000, to.getTime())).toISOString() });
  return out;
}

/** Ingest every weekly window of [from, to); each window stands alone (a failed window throws after the ones before it are stored). */
export async function ingestRange(from: Date, to: Date, opts: { jobId?: number | null; log?: (m: string) => void; onWindow?: (r: IngestResult, i: number, n: number) => Promise<void> | void } = {}): Promise<IngestResult[]> {
  const skuMap = await loadSkuMap();
  const windows = weeklyWindows(from, to);
  const out: IngestResult[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const r = await ingestWindow(w.from, w.to, { jobId: opts.jobId, skuMap, log: opts.log });
    out.push(r);
    await opts.onWindow?.(r, i, windows.length);
  }
  return out;
}

/** The earliest instant Amazon still answers for (retention), as of `now`. */
export function retentionStart(now: Date = financesDeps.now()): Date {
  return new Date(now.getTime() - (FINANCES_RETENTION_DAYS - 1) * 86400_000);
}
