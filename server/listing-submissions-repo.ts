// Ledger operations for listing_submissions. Kept out of routes/offer-add so
// the submit path, the Verify sweep, and the backfill script share one writer.

import { query as defaultQuery } from "./db";
import { probeListingState, extractConflictAsin } from "./submission-verify";
import type { HttpGetFn } from "./sku-catalog-fetch";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

const STALE_HOURS_DEFAULT = 48; // processing beyond this → stale (needs a manual verdict)

// Record one putListingsItem fire. Best-effort: caller must not let a ledger
// failure block the submit (mirrors the asin_skus optimistic-write contract).
export async function recordSubmission(
  args: { asin: string; sku: string; submissionId: string | null; submittedPrice: number | null },
  query: QueryLike = defaultQuery as any,
): Promise<void> {
  await query(
    `INSERT INTO listing_submissions (asin, sku, submission_id, submitted_price, verify_status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [args.asin, args.sku, args.submissionId, args.submittedPrice],
  );
}

export interface VerifySweepSummary {
  checked: number;
  live: number;
  failed: number;
  processing: number;
  stale: number;
  throttled: number; // left unchanged (fail-closed) — re-run to converge
}

// Sweep all non-terminal rows (pending/processing/stale) through SC. Paced +
// fail-closed: a throttled probe leaves the row untouched. Idempotent.
export async function verifyPending(
  sellerId: string,
  opts: { httpGet?: HttpGetFn; query?: QueryLike; delayMs?: number; staleHours?: number } = {},
): Promise<VerifySweepSummary> {
  const query = opts.query ?? (defaultQuery as any);
  const delayMs = opts.delayMs ?? 1100;
  const staleHours = opts.staleHours ?? STALE_HOURS_DEFAULT;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const rows = (await query(
    `SELECT id, asin, sku, submitted_at,
            EXTRACT(EPOCH FROM (now() - submitted_at))/3600 AS age_hours
       FROM listing_submissions
      WHERE verify_status IN ('pending','processing','stale')
      ORDER BY submitted_at`,
  )).rows;

  const s: VerifySweepSummary = { checked: 0, live: 0, failed: 0, processing: 0, stale: 0, throttled: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const probe = await probeListingState(sellerId, row.asin, row.sku, opts.httpGet);
    s.checked++;

    if (probe.throttled) { s.throttled++; if (i < rows.length - 1) await sleep(delayMs); continue; }

    // processing + aged past the window → stale (manual verdict needed).
    let status: string = probe.classification.status;
    if (status === "processing" && Number(row.age_hours) > staleHours) status = "stale";

    const issuesJson = JSON.stringify(probe.input.issues ?? []);
    const conflict = extractConflictAsin(probe.input.issues ?? []);
    // Attach the conflict ASIN to a failed row's review flags so it surfaces.
    const reviewFlags = [
      ...probe.classification.reviewFlags,
      ...(status === "failed" && conflict ? [`conflict ASIN → ${conflict}`] : []),
    ];

    await query(
      `UPDATE listing_submissions
          SET verify_status = $2, verified_at = now(), verdict_source = 'api',
              issues = $3::jsonb, review_flags = $4::text[], terminal_conflict = $5
        WHERE id = $1`,
      [row.id, status, issuesJson, reviewFlags, probe.classification.terminalConflict],
    );

    if (status === "live") s.live++;
    else if (status === "failed") s.failed++;
    else if (status === "stale") s.stale++;
    else s.processing++;

    if (i < rows.length - 1) await sleep(delayMs);
  }
  return s;
}

export type ManualVerdict = "live" | "failed" | "deleted";

// Human resolution of a stale/ambiguous row. A deleted listing is API-
// indistinguishable from a silent ghost, so this path lets the VA state it.
export async function resolveSubmissionManual(
  id: string,
  verdict: ManualVerdict,
  query: QueryLike = defaultQuery as any,
): Promise<void> {
  const rows = (await query(`SELECT asin, sku, verify_status FROM listing_submissions WHERE id = $1`, [id])).rows;
  if (rows.length === 0) throw new Error(`listing_submissions ${id} not found`);
  const { asin, sku, verify_status } = rows[0];

  // Manual verdicts are allowed on ANY non-terminal row — pending / processing /
  // stale — NOT stale-only. Stale is merely when we PROMPT for a verdict; a
  // human can supply one earlier (e.g. "I already deleted this in SC"). Already-
  // resolved rows (live/failed/deleted) are terminal and not re-resolved here.
  const NON_TERMINAL = new Set(["pending", "processing", "stale"]);
  if (!NON_TERMINAL.has(verify_status)) {
    throw new Error(`submission ${id} is already resolved (${verify_status}); manual verdict not allowed`);
  }

  await query(
    `UPDATE listing_submissions SET verify_status = $2, verdict_source = 'manual', verified_at = now() WHERE id = $1`,
    [id, verdict],
  );

  // DELETED: the SKU is gone from SC. Demote ONLY this SKU's is_primary and keep
  // the asin_skus row — resurrection reuses a 404'ing SKU (candidate →
  // checkSkuListingStatus 404 → reuse), which is what we want for a re-list.
  //
  // We deliberately do NOT touch asins.in_catalog / asins.primary_sku: those are
  // owned by the analyze path (§14), and deleting ONE SKU doesn't mean the ASIN
  // has no live offer (multi-offer ASINs). Any stale in_catalog display self-
  // corrects on the next analyze of this ASIN (trigger one post-resolve if we
  // want it sooner) — never by writing the field here.
  if (verdict === "deleted") {
    await query(
      `UPDATE asin_skus s SET is_primary = FALSE
         FROM asins a WHERE s.asin_id = a.id AND a.asin = $1 AND s.sku = $2`,
      [asin, sku],
    );
  }
}

// Surfacing helpers.
export async function getUnverifiedCount(query: QueryLike = defaultQuery as any): Promise<number> {
  const r = await query(
    `SELECT count(*)::int AS n FROM listing_submissions WHERE verify_status IN ('pending','processing','stale')`,
  );
  return r.rows[0]?.n ?? 0;
}

export async function listNeedsAttention(query: QueryLike = defaultQuery as any): Promise<any[]> {
  // Failed rows, stale rows, and LIVE rows carrying review flags / conflicts.
  return (await query(
    `SELECT id, asin, sku, verify_status, verdict_source, submitted_at, verified_at,
            issues, review_flags, terminal_conflict
       FROM listing_submissions
      WHERE verify_status IN ('failed','stale')
         OR (verify_status = 'live' AND (array_length(review_flags,1) > 0 OR terminal_conflict))
      ORDER BY submitted_at DESC`,
  )).rows;
}
