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

// Sweep non-terminal rows (pending/processing/stale) through SC. Paced +
// fail-closed: a throttled probe leaves the row untouched. Idempotent.
// opts.ids scopes the sweep to specific ledger rows (the §19 auto verify
// after submit) — already-resolved ids fall out via the status filter, so a
// scoped re-run over the same ids only probes what's still open.
export async function verifyPending(
  sellerId: string,
  opts: { httpGet?: HttpGetFn; query?: QueryLike; delayMs?: number; staleHours?: number; ids?: string[] } = {},
): Promise<VerifySweepSummary> {
  const query = opts.query ?? (defaultQuery as any);
  const delayMs = opts.delayMs ?? 1100;
  const staleHours = opts.staleHours ?? STALE_HOURS_DEFAULT;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const scoped = opts.ids != null && opts.ids.length > 0;
  const rows = (await query(
    `SELECT id, asin, sku, submitted_at,
            EXTRACT(EPOCH FROM (now() - submitted_at))/3600 AS age_hours
       FROM listing_submissions
      WHERE verify_status IN ('pending','processing','stale')
      ${scoped ? "AND id = ANY($1::uuid[])" : ""}
      ORDER BY submitted_at`,
    scoped ? [opts.ids] : undefined,
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

    // §18 ONE definition (2026-09-06): has_live_offer means "a listing record
    // EXISTS at SC" — any 200 for the submitted SKU writes TRUE immediately,
    // independent of whether the ledger row materializes to 'live' or stays
    // 'processing' (a just-created SKU 200s with empty status for a while).
    // The ledger keeps its own classifier; only this flag write is decoupled.
    // Still NOT set at ACCEPTED — that is synchronous validation only (§19).
    if (probe.input.found) {
      await query(
        `UPDATE asins SET has_live_offer = TRUE, offer_checked_at = now() WHERE asin = $1`,
        [row.asin],
      );
    }
    if (status === "live") {
      s.live++;
    }
    else if (status === "failed") s.failed++;
    else if (status === "stale") s.stale++;
    else s.processing++;

    if (i < rows.length - 1) await sleep(delayMs);
  }
  return s;
}

// Resolve the freshly-written ledger ids for a batch's (asin, sku) pairs —
// newest pending row per pair (per-fire ledger: the row recordSubmission just
// wrote is the newest for its pair). Pairs whose best-effort ledger write
// failed simply resolve no id and drop out — the auto-sweep covers what the
// ledger knows, the pill + manual sweep remain the backstop (§19).
export async function findRecentPendingIds(
  pairs: Array<{ asin: string; sku: string }>,
  query: QueryLike = defaultQuery as any,
): Promise<string[]> {
  if (pairs.length === 0) return [];
  const r = await query(
    `SELECT DISTINCT ON (asin, sku) id
       FROM listing_submissions
      WHERE verify_status = 'pending'
        AND (asin, sku) IN (SELECT unnest($1::text[]), unnest($2::text[]))
      ORDER BY asin, sku, submitted_at DESC`,
    [pairs.map((p) => p.asin), pairs.map((p) => p.sku)],
  );
  return r.rows.map((row: any) => String(row.id));
}

// How many of a scoped id set are still open (pending/processing/stale) —
// used by the auto-sweep to decide whether the retry pass is needed.
export async function countOpenAmong(
  ids: string[],
  query: QueryLike = defaultQuery as any,
): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await query(
    `SELECT count(*)::int AS n FROM listing_submissions
      WHERE id = ANY($1::uuid[]) AND verify_status IN ('pending','processing','stale')`,
    [ids],
  );
  return r.rows[0]?.n ?? 0;
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

  // Manual 'live' writes the flag (§19, 2026-08-28): a manual verdict is a
  // definitive human determination — deferring the icon to a future pass
  // violated §14 manual-trigger completeness (crons are off in this
  // deployment, so "waits for the daily pass" meant "waits for a manual
  // scan"). 'failed'/'deleted' still write nothing to the flag: failing or
  // deleting ONE SKU does not mean the ASIN has no live offer.
  if (verdict === "live") {
    await query(
      `UPDATE asins SET has_live_offer = TRUE, offer_checked_at = now() WHERE asin = $1`,
      [asin],
    );
  }

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

// §19 bulk manual verdicts: the single-row semantics applied per id (same
// function — including the deleted → is_primary demote). Already-terminal rows
// are skipped and reported, never a batch failure (the single-row endpoint
// keeps its 409; the batch absorbs it as a skip note).
export interface BulkResolveResult {
  resolved: string[];
  skipped: Array<{ id: string; reason: string }>;
}
export async function resolveSubmissionsBulk(
  ids: string[],
  verdict: ManualVerdict,
  query: QueryLike = defaultQuery as any,
): Promise<BulkResolveResult> {
  const out: BulkResolveResult = { resolved: [], skipped: [] };
  for (const id of ids) {
    try {
      await resolveSubmissionManual(id, verdict, query);
      out.resolved.push(id);
    } catch (err: any) {
      out.skipped.push({ id, reason: err?.message ?? "unknown error" });
    }
  }
  return out;
}

// §19 dismiss (acknowledge): hide a TERMINAL needs-attention row from the
// panel. Guard in the WHERE clause — non-terminal rows (incl. stale, which
// needs a verdict, not an ack) simply don't match and are reported as skipped.
// Hides, never deletes: issues/review_flags/terminal_conflict are untouched.
export interface DismissFlagsResult {
  dismissed: string[];
  skipped: string[]; // non-terminal or unknown ids
}
export async function dismissFlags(
  ids: string[],
  query: QueryLike = defaultQuery as any,
): Promise<DismissFlagsResult> {
  if (ids.length === 0) return { dismissed: [], skipped: [] };
  const r = await query(
    `UPDATE listing_submissions
        SET flags_acknowledged_at = now()
      WHERE id = ANY($1::uuid[])
        AND verify_status IN ('live','failed','deleted')
      RETURNING id`,
    [ids],
  );
  const dismissed = r.rows.map((row: any) => String(row.id));
  const skipped = ids.filter((id) => !dismissed.includes(id));
  return { dismissed, skipped };
}

// Surfacing helpers.
// Pill definition (§19 "Panel bulk actions & dismiss"): non-terminal rows PLUS
// unacknowledged attention-terminal rows (failed, or live with flags). After
// sweep + bulk verdicts + dismiss, this reaches zero.
export async function getUnverifiedCount(query: QueryLike = defaultQuery as any): Promise<number> {
  const r = await query(
    `SELECT count(*)::int AS n FROM listing_submissions
      WHERE verify_status IN ('pending','processing','stale')
         OR (verify_status = 'failed' AND flags_acknowledged_at IS NULL)
         OR (verify_status = 'live'
             AND (array_length(review_flags,1) > 0 OR terminal_conflict)
             AND flags_acknowledged_at IS NULL)`,
  );
  return r.rows[0]?.n ?? 0;
}

// In-flight rows (pending/processing) — surfaced separately so the panel can
// list them individually and offer manual resolve BEFORE they age to stale
// (e.g. "I deleted this" on a still-processing row, ~26h before the 48h mark).
export async function listInFlight(query: QueryLike = defaultQuery as any): Promise<any[]> {
  return (await query(
    `SELECT id, asin, sku, verify_status, verdict_source, submitted_at, verified_at,
            issues, review_flags, terminal_conflict
       FROM listing_submissions
      WHERE verify_status IN ('pending','processing')
      ORDER BY submitted_at DESC`,
  )).rows;
}

export async function listNeedsAttention(query: QueryLike = defaultQuery as any): Promise<any[]> {
  // Stale rows (always — they need a verdict, not an ack), plus UNACKNOWLEDGED
  // failed rows and UNACKNOWLEDGED live rows carrying review flags / conflicts.
  // Dismissed (flags_acknowledged_at set) terminal rows leave this view; the
  // ledger keeps their issues/flags untouched.
  return (await query(
    `SELECT id, asin, sku, verify_status, verdict_source, submitted_at, verified_at,
            issues, review_flags, terminal_conflict, flags_acknowledged_at
       FROM listing_submissions
      WHERE verify_status = 'stale'
         OR (verify_status = 'failed' AND flags_acknowledged_at IS NULL)
         OR (verify_status = 'live'
             AND (array_length(review_flags,1) > 0 OR terminal_conflict)
             AND flags_acknowledged_at IS NULL)
      ORDER BY submitted_at DESC`,
  )).rows;
}
