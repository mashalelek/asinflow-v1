// Suppressions (FYP report) — scheduler component 18 (SPEC §11).
//
// Stage-then-swap (patch "Runner", 2026-10-15): the report's ASIN set is
// loaded into a temp table and ONE statement sets every row's flag from
// it, inside one transaction. The old clear-all-then-re-set left a window
// in which the catalog showed no suppressions and, on a crash between the
// two steps, stayed that way until the next run. Now there is no window
// and a crash leaves the previous state intact.
//
// Split in two so the swap is unit-testable without the Reports API:
//   fetchFypSuppressions()        — CALL-10, returns asin -> reasons
//   applySuppressions(map, pool)  — the transactional swap, returns flips
import axios from "axios";
import type pg from "pg";
import { spApiGet, spApiPost } from "./spapi";
import pool from "./db";
import { log } from "./log";

const MARKETPLACE_ID = "ATVPDKIKX0DER";
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

export interface SuppressionFlip { asin: string; from: boolean; to: boolean }
export interface SuppressionResult {
  inReport: number;
  suppressed: number;      // rows flagged after the swap (in scope of the whole table)
  newlySuppressed: number; // FALSE/NULL -> TRUE this run
  cleared: number;         // TRUE -> FALSE this run
  flips: SuppressionFlip[];
}

export async function fetchFypSuppressions(): Promise<Map<string, string[]>> {
  log("Requesting FYP suppression report", "suppression-sync");

  let createRes: any;
  try {
    createRes = await spApiPost("/reports/2021-06-30/reports", {
      reportType: "GET_MERCHANTS_LISTINGS_FYP_REPORT",
      marketplaceIds: [MARKETPLACE_ID],
    });
  } catch (err: any) {
    const status = err?.response?.status;
    const body = err?.response?.data;
    log(`FYP report creation failed — HTTP ${status}: ${JSON.stringify(body)}`, "suppression-sync");
    throw new Error(`FYP report creation failed (${status}): ${JSON.stringify(body)}`);
  }
  const reportId: string = createRes.reportId;
  log(`FYP report created: ${reportId}`, "suppression-sync");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let reportDocumentId: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await spApiGet(`/reports/2021-06-30/reports/${reportId}`);
    const status: string = statusRes.processingStatus;
    if (status === "DONE") { reportDocumentId = statusRes.reportDocumentId; break; }
    if (status === "FATAL" || status === "CANCELLED") throw new Error(`FYP report ${reportId} failed: ${status}`);
  }
  if (!reportDocumentId) throw new Error(`FYP report ${reportId} timed out`);

  const docRes = await spApiGet(`/reports/2021-06-30/documents/${reportDocumentId}`);
  // 120 s hard timeout (SPEC §11 decision 9): the S3 document fetch is
  // outside the rate-limited wrappers and can be several MB.
  const downloadRes = await axios.get(docRes.url, { responseType: "text", timeout: 120_000 });
  const rawData = typeof downloadRes.data === "string" ? downloadRes.data : String(downloadRes.data);
  return parseFypReport(rawData);
}

/** Pure: TSV text → asin → distinct reasons. An empty report is an empty map. */
export function parseFypReport(rawData: string): Map<string, string[]> {
  const lines = rawData.split("\n").filter((l) => l.trim());
  const out = new Map<string, string[]>();
  if (lines.length < 2) return out;
  const headers = lines[0].replace(/\r$/, "").split("\t");
  const col = (name: string) => headers.findIndex((h) => h.toLowerCase().includes(name.toLowerCase()));
  const iAsin = col("asin");
  const iReason = col("reason");
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].replace(/\r$/, "").split("\t");
    const asin = iAsin >= 0 ? cols[iAsin]?.trim() : null;
    const reason = iReason >= 0 ? cols[iReason]?.trim() : null;
    if (!asin) continue;
    const existing = out.get(asin);
    if (existing) { if (reason && !existing.includes(reason)) existing.push(reason); }
    else out.set(asin, reason ? [reason] : []);
  }
  return out;
}

type ClientLike = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };
type PoolLike = { connect: () => Promise<ClientLike> };

/**
 * The swap. One transaction: stage the report set in a temp table, read
 * which rows will change (the flips), then ONE update that sets every
 * row's flag and reasons from the staged set. Rows not in the report are
 * cleared by the same statement — there is no separate clear step.
 */
export async function applySuppressions(report: Map<string, string[]>, p: PoolLike = pool as any): Promise<SuppressionResult> {
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    await c.query(`CREATE TEMP TABLE fyp_stage (asin TEXT PRIMARY KEY, reasons JSONB NOT NULL) ON COMMIT DROP`);
    const entries = Array.from(report.entries());
    for (let i = 0; i < entries.length; i += 500) {
      const part = entries.slice(i, i + 500);
      await c.query(
        `INSERT INTO fyp_stage (asin, reasons)
         SELECT a, r::jsonb FROM unnest($1::text[], $2::text[]) AS t(a, r) ON CONFLICT (asin) DO NOTHING`,
        [part.map(([a]) => a), part.map(([, r]) => JSON.stringify(r))],
      );
    }
    const flipRows = await c.query(
      `SELECT a.asin, COALESCE(a.is_search_suppressed, FALSE) AS was, (s.asin IS NOT NULL) AS now
         FROM asins a LEFT JOIN fyp_stage s ON s.asin = a.asin
        WHERE COALESCE(a.is_search_suppressed, FALSE) IS DISTINCT FROM (s.asin IS NOT NULL)`,
    );
    const flips: SuppressionFlip[] = flipRows.rows.map((r: any) => ({ asin: String(r.asin), from: r.was === true, to: r.now === true }));
    await c.query(
      `UPDATE asins a
          SET is_search_suppressed = (s.asin IS NOT NULL),
              suppression_reasons = s.reasons
         FROM asins a2 LEFT JOIN fyp_stage s ON s.asin = a2.asin
        WHERE a.asin = a2.asin
          AND (COALESCE(a.is_search_suppressed, FALSE) IS DISTINCT FROM (s.asin IS NOT NULL)
               OR a.suppression_reasons IS DISTINCT FROM s.reasons)`,
    );
    const total = await c.query(`SELECT count(*)::int AS n FROM asins WHERE is_search_suppressed = TRUE`);
    await c.query("COMMIT");
    const newlySuppressed = flips.filter((f) => f.to).length;
    const cleared = flips.filter((f) => !f.to).length;
    return { inReport: report.size, suppressed: Number(total.rows[0]?.n ?? 0), newlySuppressed, cleared, flips };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export async function syncSuppressionData(): Promise<SuppressionResult> {
  const report = await fetchFypSuppressions();
  const r = await applySuppressions(report, pool as any);
  log(`Suppression sync complete: ${r.inReport} in report, ${r.suppressed} suppressed, ${r.newlySuppressed} newly suppressed, ${r.cleared} cleared`, "suppression-sync");
  return r;
}
