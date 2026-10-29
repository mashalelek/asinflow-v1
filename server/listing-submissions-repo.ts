// Ledger operations for listing_submissions. Kept out of routes/offer-add so
// the submit path, the Verify sweep, and the backfill script share one writer.

import { query as defaultQuery } from "./db";
import { anyBuyable } from "./live-offer-check";
import { writeLiveOfferVerdict, reprobeAsinLiveOffer } from "./live-offer-write";
import { probeListingState, extractConflictAsin } from "./submission-verify";
import type { HttpGetFn } from "./sku-catalog-fetch";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

const STALE_HOURS_DEFAULT = 48; // processing beyond this → stale (needs a manual verdict)

// Record one putListingsItem fire. Best-effort: caller must not let a ledger
// failure block the submit (mirrors the asin_skus optimistic-write contract).
export interface PricingDecision {
  source: string | null;                 // fba_anchor | roi_40_floor | roi_60_solve
  detail: string | null;
  anchorOfferPrice: number | null;
  anchorOfferFeedback: number | null;
  cptSeen: number | null;                // recorded for analysis; NEVER a pricing input (§18 v2)
  resultingRoi: number | null;
  warning: string | null;                // low_roi_repriced
  qualifiedOfferCount: number | null;
  disqualifiedOffers: unknown | null;    // JSONB array
}

/**
 * §18 v2 (2026-10-07): the pricing decision is persisted alongside the
 * submission so "why this price" is a ledger fact. `pricing` is OPTIONAL —
 * callers that don't have it (or pre-v2 rows) write NULLs, which means
 * "decision not recorded", never "no decision".
 */
export async function recordSubmission(
  args: {
    asin: string; sku: string; submissionId: string | null; submittedPrice: number | null;
    pricing?: PricingDecision;
    /** §18 Relist (2026-10-29): the §19 ladder skips close-after-create for
     *  this row — the offer comes up OPEN. Default false (normal Add to SC). */
    openOnCreate?: boolean;
  },
  query: QueryLike = defaultQuery as any,
): Promise<void> {
  const p = args.pricing;
  await query(
    `INSERT INTO listing_submissions (
       asin, sku, submission_id, submitted_price, verify_status,
       price_source, price_detail, anchor_offer_price, anchor_offer_feedback,
       cpt_seen, resulting_roi, price_warning, qualified_offer_count, disqualified_offers,
       open_on_create)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
    [
      args.asin, args.sku, args.submissionId, args.submittedPrice,
      p?.source ?? null, p?.detail ?? null, p?.anchorOfferPrice ?? null,
      p?.anchorOfferFeedback ?? null, p?.cptSeen ?? null, p?.resultingRoi ?? null,
      p?.warning ?? null, p?.qualifiedOfferCount ?? null,
      p?.disqualifiedOffers != null ? JSON.stringify(p.disqualifiedOffers) : null,
      args.openOnCreate === true,
    ],
  );
}

export interface VerifySweepSummary {
  checked: number;
  live: number;
  failed: number;
  processing: number;
  stale: number;
  throttled: number; // left unchanged (fail-closed) — re-run to converge
  // §18 A2 (2026-10-09): ASIN -> outcome for every flag write this sweep
  // made. The sweep has no refresh_runs row of its own, so its ledger is
  // this field — a flag write with nowhere to record an outcome is not
  // reachable through the primitive.
  flagOutcomes: Record<string, string>;
}

// Sweep non-terminal rows (pending/processing/stale) through SC. Paced +
// fail-closed: a throttled probe leaves the row untouched. Idempotent.
// opts.ids scopes the sweep to specific ledger rows (the §19 auto verify
// after submit) — already-resolved ids fall out via the status filter, so a
// scoped re-run over the same ids only probes what's still open.
export async function verifyPending(
  sellerId: string,
  opts: {
    httpGet?: HttpGetFn; query?: QueryLike; delayMs?: number; staleHours?: number; ids?: string[];
    /** Close-after-create (2026-10-23): called once per probe that sees the submitted SKU listed
     *  (200 with summaries). Production callers pass listing-hygiene-run's closeAfterCreate; absent → no close. */
    closeAfterCreate?: (row: { asin: string; sku: string; submittedAt: Date | string }) => Promise<unknown>;
  } = {},
): Promise<VerifySweepSummary> {
  const query = opts.query ?? (defaultQuery as any);
  const delayMs = opts.delayMs ?? 1100;
  const staleHours = opts.staleHours ?? STALE_HOURS_DEFAULT;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const scoped = opts.ids != null && opts.ids.length > 0;
  const rows = (await query(
    `SELECT id, asin, sku, submitted_at, open_on_create,
            EXTRACT(EPOCH FROM (now() - submitted_at))/3600 AS age_hours
       FROM listing_submissions
      WHERE verify_status IN ('pending','processing','stale')
      ${scoped ? "AND id = ANY($1::uuid[])" : ""}
      ORDER BY submitted_at`,
    scoped ? [opts.ids] : undefined,
  )).rows;

  const s: VerifySweepSummary = {
    checked: 0, live: 0, failed: 0, processing: 0, stale: 0, throttled: 0, flagOutcomes: {},
  };
  const flagOutcomes = s.flagOutcomes;

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

    // §18: has_live_offer means "a listing record EXISTS at SC". A 200 with a
    // real listing for the submitted SKU writes TRUE immediately, independent
    // of whether the ledger row materializes to 'live' or stays 'processing'
    // (a just-created SKU 200s with an EMPTY status for a while — still
    // listed). The ledger keeps its own classifier; only this flag write is
    // decoupled. Still NOT set at ACCEPTED — synchronous validation only.
    //
    // Keyed on `probe.input.listed`, NOT `.found` (§18 A1, 2026-10-09): a 200
    // with summaries: [] is a SKU shell, and the shell behind B07J2WWWD4's
    // failed submission is precisely what used to write TRUE here. `found`
    // stays true for the shell so the classifier still sees its 5886 and
    // returns `failed` — the two predicates are deliberately different.
    //
    // Written through the ONE primitive (§18 A2), which also records the
    // per-ASIN outcome. The sweep has no refresh_runs row of its own, so the
    // outcome goes to the sweep's own summary; a flag write with nowhere to
    // record an outcome is not reachable.
    if (probe.input.listed) {
      await writeLiveOfferVerdict(
        {
          asin: row.asin,
          prevFlag: (await query(`SELECT has_live_offer FROM asins WHERE asin = $1`, [row.asin]))
            .rows[0]?.has_live_offer ?? null,
          listed: true,
          buyable: anyBuyable([probe.input.status]),
          issues: probe.input.issues.map((i) => ({
            code: String(i.code ?? ""), severity: String(i.severity ?? ""), message: String(i.message ?? ""),
          })),
        },
        { query, outcomes: (asin, outcome) => { flagOutcomes[asin] = outcome; } },
      );
    }
    // Close-after-create: the first probe that sees the listing closes it
    // (the hook is idempotent — sent once). A failure is logged, never fatal
    // to the sweep: the nightly component 22 still closes an open zero-stock SKU.
    // §18 Relist: a row submitted with open_on_create stays OPEN — the hook is
    // skipped for it. (Component 22 may still close it later on its own
    // evidence; this only removes the automatic close tied to creation.)
    if (probe.input.listed && opts.closeAfterCreate && !row.open_on_create) {
      try { await opts.closeAfterCreate({ asin: row.asin, sku: row.sku, submittedAt: row.submitted_at }); }
      catch (err: any) { console.error(`[verify] close-after-create failed for ${row.sku}: ${err?.message ?? err}`); }
    }
    // A 'failed' verdict RE-PROBES; it does not write the flag (§18 Writers,
    // 2026-10-10). It used to revert has_live_offer to FALSE directly, guarded
    // on no other ledger row for the ASIN being 'live' — a guard that existed
    // because a verdict is weak evidence about an ASIN: failing ONE SKU of a
    // multi-offer ASIN says nothing about the others. The probe needs no such
    // guard, because it looks at every SKU and answers the actual question.
    //
    // This is also the write that put the wrong FALSE on B07J2WWWD4 in the
    // first place: correct by luck, from a verdict rather than an observation,
    // which is why a single bad probe could later overturn it.
    if (status === "failed") {
      await reprobeAsinLiveOffer(row.asin, {
        query, outcomes: (asin, outcome) => { flagOutcomes[asin] = outcome; },
        sellerId, httpGet: opts.httpGet,
      });
    }

    // A 48h stale promotion re-probes too (§19): the row reaching 48h is the
    // moment AF admits it does not know what happened, which is exactly when
    // the flag is most likely stale — and a human is about to be asked for a
    // verdict, so they should be looking at a freshly observed one.
    if (status === "stale" && probe.classification.status === "processing") {
      await reprobeAsinLiveOffer(row.asin, {
        query, outcomes: (asin, outcome) => { flagOutcomes[asin] = outcome; },
        sellerId, httpGet: opts.httpGet,
      });
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
  // Injected for tests; production uses the env seller id and the real
  // spApiGet via reprobeAsinLiveOffer's defaults.
  deps?: { sellerId?: string; httpGet?: HttpGetFn },
): Promise<{ flagOutcome: string | null }> {
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

  // EVERY manual verdict RE-PROBES; none writes the flag (§19, 2026-10-10,
  // supersedes the 2026-08-28 manual-'live' write).
  //
  // The old rule had 'live' write has_live_offer = TRUE directly, to satisfy
  // §14 manual-trigger completeness: with crons off, "waits for the daily
  // pass" meant "waits for a manual scan". The re-probe satisfies that
  // better — the user still gets an immediate answer AND it is an observed
  // one. A human resolving a row as 'live' can be right that they created a
  // listing and wrong about which SKU or ASIN carries it; the probe catches
  // that, a direct write cannot.
  //
  // 'failed'/'deleted' wrote nothing before, which was right on the evidence
  // but left the flag untouched until the next full reconcile. They re-probe
  // for the same reason: the human has just said something changed, so this
  // is the cheapest possible moment to go look.
  //
  // has_buyable_offer is no longer a special case — the primitive writes it
  // from the same probe's summaries[].status (§23), so it can neither be
  // skipped nor set from a human's assertion.
  //
  // NON-FATAL by construction (see reprobeAsinLiveOffer): a throttled probe
  // records skipped_transient and writes nothing. The ledger row above has
  // ALREADY been written — the verdict is the human's to make, and this must
  // never be able to refuse it.
  const flagOutcomes: Record<string, string> = {};
  await reprobeAsinLiveOffer(asin, {
    query, outcomes: (a, o) => { flagOutcomes[a] = o; },
    sellerId: deps?.sellerId, httpGet: deps?.httpGet,
  });

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

  return { flagOutcome: flagOutcomes[asin] ?? null };
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
  deps?: { sellerId?: string; httpGet?: HttpGetFn },
): Promise<BulkResolveResult> {
  const out: BulkResolveResult = { resolved: [], skipped: [] };
  for (const id of ids) {
    try {
      await resolveSubmissionManual(id, verdict, query, deps);
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
