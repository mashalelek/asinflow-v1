// Inventory Ledger (listing hygiene, SPEC §11 component 23 / §14).
// Owner of `sku_ledger_state` and of the `hygiene_ledger_coverage` setting.
//
// GET_LEDGER_SUMMARY_VIEW_DATA, aggregatedByTimePeriod = DAILY,
// aggregateByLocation = COUNTRY. Spike 2026-10-18: one row per
// Date × MSKU × Disposition (FNSKU 1:1 with MSKU, Location always "US"); a SKU
// appears only on days it held or moved units, so absence = zero. 31 and 92
// days were accepted (~20 s each); a 548-day request was refused with
// QuotaExceeded — this report type's createReport quota is tighter than the
// general bucket — so the backfill runs in 92-day chunks, spaced, and on
// QuotaExceeded waits and retries THE SAME chunk; a chunk is never skipped.
//
// Fields are double-quoted and Amazon does NOT escape quotes inside titles
// (`"…Beige (3x32.81')""` then a tab) — split-on-tab and strict RFC 4180 both
// misread it. parseQuotedTsv closes a quoted field only at a quote followed by
// a tab, a line end or EOF; a row whose field count still differs from the
// header fails the chunk (never silently dropped).
//
// Fail-closed tripwire (selling-partner-api-models #2526, DAILY summaries
// sometimes come back empty): a report with zero rows while component 15 saw
// fulfillable stock inside its window is INCONCLUSIVE — nothing is written,
// and that night's component 24 skips everything as ledger_unavailable.
import zlib from "zlib";
import axios from "axios";
import { spApiGet as realGet, spApiPost as realPost } from "./spapi-auth";
import { isThrottleError } from "./spapi-rate-limit";
import type { QueryLike } from "./scheduler/types";

const MARKETPLACE = "ATVPDKIKX0DER";
export const LEDGER_REPORT_TYPE = "GET_LEDGER_SUMMARY_VIEW_DATA";
export const LEDGER_CHUNK_DAYS = 92;
export const LEDGER_NIGHTLY_DAYS = 7;
/** Between backfill chunk requests (the report type's quota is tight). */
export const LEDGER_CHUNK_SPACING_MS = 5 * 60_000;
/** QuotaExceeded after the limiter's own retries: wait, then retry the same chunk. */
export const LEDGER_QUOTA_WAIT_MS = 5 * 60_000;
export const LEDGER_QUOTA_MAX_WAITS = 12;
const POLL_MS = 15_000;
const POLL_TIMEOUT_MS = 20 * 60_000;
export const COVERAGE_SETTING = "hygiene_ledger_coverage";

export interface LedgerDeps {
  get: (endpoint: string, params?: Record<string, any>) => Promise<any>;
  post: (endpoint: string, body: any) => Promise<any>;
  download: (url: string) => Promise<Buffer>;
  sleep: (ms: number) => Promise<void>;
}
export const realLedgerDeps: LedgerDeps = {
  get: realGet,
  post: realPost,
  download: async (url) => Buffer.from((await axios.get(url, { responseType: "arraybuffer", timeout: 120_000 })).data),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// ── Parsing ───────────────────────────────────────────────────────────────

/** Pure: quoted TSV → rows of fields. See the header for the quote rule. */
export function parseQuotedTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  const atDelim = (j: number) => j >= n || text[j] === "\t" || text[j] === "\n" || (text[j] === "\r" && (j + 1 >= n || text[j + 1] === "\n"));
  while (i < n) {
    let field = "";
    if (text[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) break;
        if (text[i] === '"') {
          if (atDelim(i + 1)) { i++; break; }          // the closing quote
          if (text[i + 1] === '"' && !atDelim(i + 2)) { field += '"'; i += 2; continue; } // an escaped quote
          field += '"'; i++; continue;                  // an unescaped inner quote (Amazon titles)
        }
        field += text[i++];
      }
    } else {
      while (i < n && !atDelim(i)) field += text[i++];
    }
    row.push(field);
    if (i >= n) { rows.push(row); break; }
    if (text[i] === "\t") { i++; if (i >= n) { row.push(""); rows.push(row); } continue; }
    if (text[i] === "\r") i++;
    if (text[i] === "\n") i++;
    rows.push(row);
    row = [];
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export interface LedgerRow { date: string; msku: string; disposition: string; ending: number }

/** MM/DD/YYYY → YYYY-MM-DD. */
function isoDate(mdy: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mdy.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

/** Pure: report text → rows. Throws on a malformed row (wrong field count, bad date, missing columns). */
export function parseLedgerReport(text: string): LedgerRow[] {
  const all = parseQuotedTsv(text);
  if (all.length === 0) return [];
  const header = all[0].map((h) => h.trim());
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iDate = col("Date"), iMsku = col("MSKU"), iDisp = col("Disposition"), iEnd = col("Ending Warehouse Balance");
  if (iDate < 0 || iMsku < 0 || iDisp < 0 || iEnd < 0) {
    throw new Error(`ledger report header missing a column (have: ${header.join(", ")})`);
  }
  const out: LedgerRow[] = [];
  for (let r = 1; r < all.length; r++) {
    const f = all[r];
    if (f.length !== header.length) throw new Error(`ledger report row ${r + 1}: ${f.length} fields, header has ${header.length}`);
    const date = isoDate(f[iDate]);
    if (!date) throw new Error(`ledger report row ${r + 1}: unreadable Date ${JSON.stringify(f[iDate])}`);
    const ending = Number(f[iEnd]);
    if (!Number.isFinite(ending)) throw new Error(`ledger report row ${r + 1}: unreadable Ending Warehouse Balance ${JSON.stringify(f[iEnd])}`);
    out.push({ date, msku: f[iMsku].trim(), disposition: f[iDisp].trim(), ending });
  }
  return out;
}

/** Pure: per MSKU, the latest date whose Σ ending balance (all dispositions) > 0; null when never > 0 in the report. */
export function foldLastStocked(rows: LedgerRow[]): Map<string, string | null> {
  const sums = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.msku) continue;
    const byDate = sums.get(r.msku) ?? new Map<string, number>();
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.ending);
    sums.set(r.msku, byDate);
  }
  const out = new Map<string, string | null>();
  sums.forEach((byDate, msku) => {
    let last: string | null = null;
    byDate.forEach((sum, date) => { if (sum > 0 && (last == null || date > last)) last = date; });
    out.set(msku, last);
  });
  return out;
}

// ── Windows ───────────────────────────────────────────────────────────────

const addDays = (ymd: string, d: number): string => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
/** Today in America/New_York, YYYY-MM-DD. */
export function todayEt(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Pure: [from, to] split into chunks of at most `days` days, oldest first. */
export function ledgerChunks(from: string, to: string, days = LEDGER_CHUNK_DAYS): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let a = from;
  while (a <= to) {
    const b0 = addDays(a, days - 1);
    const b = b0 < to ? b0 : to;
    out.push({ from: a, to: b });
    a = addDays(b, 1);
  }
  return out;
}

/** The nightly window: the last LEDGER_NIGHTLY_DAYS complete days (yesterday back), overlapping on purpose. */
export function nightlyWindow(now: Date = new Date()): { from: string; to: string } {
  const to = addDays(todayEt(now), -1);
  return { from: addDays(to, -(LEDGER_NIGHTLY_DAYS - 1)), to };
}

/** Pure: union a newly covered window into the stored coverage. A disjoint newer window replaces it; a disjoint older one is ignored. */
export function mergeCoverage(cur: { from: string; to: string } | null, w: { from: string; to: string }): { from: string; to: string } {
  if (!cur) return { ...w };
  const touches = w.from <= addDays(cur.to, 1) && w.to >= addDays(cur.from, -1);
  if (touches) return { from: w.from < cur.from ? w.from : cur.from, to: w.to > cur.to ? w.to : cur.to };
  return w.to > cur.to ? { ...w } : cur;
}

// ── One chunk ─────────────────────────────────────────────────────────────

export class LedgerChunkError extends Error {}

/** Request, poll and download one report. QuotaExceeded waits and retries the same window. */
export async function fetchLedgerReport(w: { from: string; to: string }, deps: LedgerDeps, log: (m: string) => void = () => {}): Promise<string> {
  const body = {
    reportType: LEDGER_REPORT_TYPE,
    marketplaceIds: [MARKETPLACE],
    dataStartTime: `${w.from}T00:00:00Z`,
    dataEndTime: `${w.to}T23:59:59Z`,
    reportOptions: { aggregateByLocation: "COUNTRY", aggregatedByTimePeriod: "DAILY" },
  };
  let created: any;
  for (let waits = 0; ; waits++) {
    try { created = await deps.post("/reports/2021-06-30/reports", body); break; }
    catch (err: any) {
      if (!isThrottleError(err)) throw new LedgerChunkError(`createReport ${w.from}..${w.to} failed: HTTP ${err?.response?.status ?? "?"} ${JSON.stringify(err?.response?.data ?? err?.message)}`);
      if (waits >= LEDGER_QUOTA_MAX_WAITS) throw new LedgerChunkError(`createReport ${w.from}..${w.to}: QuotaExceeded after ${waits} waits of ${LEDGER_QUOTA_WAIT_MS / 60_000} min — chunk not skipped; re-run the backfill`);
      log(`createReport ${w.from}..${w.to}: QuotaExceeded — waiting ${LEDGER_QUOTA_WAIT_MS / 60_000} min, then the same chunk again (${waits + 1}/${LEDGER_QUOTA_MAX_WAITS})`);
      await deps.sleep(LEDGER_QUOTA_WAIT_MS);
    }
  }
  const reportId = String(created?.reportId ?? "");
  if (!reportId) throw new LedgerChunkError(`createReport ${w.from}..${w.to}: no reportId`);
  let docId: string | null = null;
  for (let waited = 0; waited < POLL_TIMEOUT_MS; waited += POLL_MS) {
    await deps.sleep(POLL_MS);
    const st = await deps.get(`/reports/2021-06-30/reports/${reportId}`);
    if (st?.processingStatus === "DONE") { docId = String(st.reportDocumentId); break; }
    if (st?.processingStatus === "FATAL" || st?.processingStatus === "CANCELLED") {
      throw new LedgerChunkError(`ledger report ${reportId} (${w.from}..${w.to}) ended ${st.processingStatus}`);
    }
  }
  if (!docId) throw new LedgerChunkError(`ledger report ${reportId} (${w.from}..${w.to}) timed out`);
  const doc = await deps.get(`/reports/2021-06-30/documents/${docId}`);
  let buf = await deps.download(String(doc.url));
  if (doc?.compressionAlgorithm === "GZIP") buf = zlib.gunzipSync(buf);
  return buf.toString("utf8");
}

/** Did component 15 see fulfillable stock inside [from, to]? (the tripwire) */
export async function stockedInWindow(w: { from: string; to: string }, query: QueryLike): Promise<boolean> {
  const r = await query(
    `SELECT (EXISTS (SELECT 1 FROM inventory_snapshots
                      WHERE available_fba > 0 AND snapshot_at >= $1::date AND snapshot_at < $2::date + 1)
          OR EXISTS (SELECT 1 FROM sku_fba_inventory
                      WHERE fulfillable > 0 AND observed_at >= $1::date AND observed_at < $2::date + 1)) AS stocked`,
    [w.from, w.to],
  );
  return r.rows[0]?.stocked === true;
}

export type ChunkOutcome =
  | { status: "written"; rows: number; skus: number; stocked: number }
  | { status: "inconclusive"; reason: string };

/** Write one parsed chunk (or refuse it on the tripwire). */
export async function applyLedgerChunk(w: { from: string; to: string }, rows: LedgerRow[], query: QueryLike): Promise<ChunkOutcome> {
  if (rows.length === 0 && (await stockedInWindow(w, query))) {
    return { status: "inconclusive", reason: `report ${w.from}..${w.to} returned 0 rows while component 15 saw fulfillable stock in that window` };
  }
  const folded = foldLastStocked(rows);
  const skus = Array.from(folded.keys());
  const last = skus.map((s) => folded.get(s) ?? null);
  for (let i = 0; i < skus.length; i += 1000) {
    await query(
      `INSERT INTO sku_ledger_state AS t (sku, last_stocked_date, ledger_window_start, checked_at)
       SELECT u.sku, u.last, $3::date, NOW() FROM unnest($1::text[], $2::date[]) AS u(sku, last)
       ON CONFLICT (sku) DO UPDATE SET
         last_stocked_date = GREATEST(t.last_stocked_date, EXCLUDED.last_stocked_date),
         ledger_window_start = LEAST(t.ledger_window_start, EXCLUDED.ledger_window_start),
         checked_at = EXCLUDED.checked_at`,
      [skus.slice(i, i + 1000), last.slice(i, i + 1000), w.from],
    );
  }
  const cur = (await query(`SELECT value FROM settings WHERE key = $1`, [COVERAGE_SETTING])).rows[0]?.value ?? null;
  const merged = mergeCoverage(cur && cur.from && cur.to ? { from: String(cur.from), to: String(cur.to) } : null, w);
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [COVERAGE_SETTING, JSON.stringify(merged)],
  );
  return { status: "written", rows: rows.length, skus: skus.length, stocked: last.filter((x) => x != null).length };
}
