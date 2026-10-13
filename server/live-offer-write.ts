// The ONE writer of asins.has_live_offer (§18 A2, 2026-10-09).
//
// Before this module the flag had NINE write sites across five files, and the
// listings stage's refresh_runs.outcomes recorded flips and discoveries only —
// so an ASIN that was probed and stayed put left no trace at all. Combined,
// those two facts are how B07J2WWWD4 acquired a wrong TRUE that nothing could
// be attributed to: a FALSE→TRUE flip with no ledger row anywhere.
//
// Every write now goes through writeLiveOfferVerdict, and every write records
// a per-ASIN outcome in the invoking run. A flag change with no ledger row is
// impossible by construction — you cannot reach the UPDATE without passing an
// outcome sink.
//
// has_buyable_offer (§23) is written in the SAME statement, by this same
// function. It used to be a convention each call site had to remember; it is
// now structural, so the two flags cannot disagree about one probe. BUYABLE in
// summaries[].status remains the buyable flag's sole source.
//
// A1 is upstream of this module: a 200 with summaries: [] is a SKU shell, not
// a listing, and sku-listing-fetch.ts/sku-listing-search.ts already report it
// as absent. This function never sees the distinction — it is handed a verdict.

import type { ListingIssueLite } from "./sku-listing-fetch";
import { checkAsinLiveOffer, anyBuyable } from "./live-offer-check";
import type { HttpGetFn } from "./sku-catalog-fetch";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

// The per-ASIN outcome vocabulary (§18 A2). One of these lands in the
// invoking run's refresh_runs.outcomes for EVERY ASIN the reconcile touches.
//
//   listed             a listing exists at SC, flag was already TRUE
//   not_listed         no listing, flag was already FALSE
//   flip: x -> y       the flag changed (NULL counts as a from-value)
//   discovery          SC had SKUs AF did not know; they were recorded
//   onboarded          the ASIN itself was absent from AF (phase c, 2026-10)
//   skipped_transient  throttle/5xx/timeout — NOTHING written, retried next run
//   error: <msg>       the probe or write failed for this ASIN
export type LiveOfferOutcome = string;

export type OutcomeSink = (asin: string, outcome: LiveOfferOutcome) => void;

export interface LiveOfferVerdict {
  asin: string;
  /** The flag's value BEFORE this write — drives flip detection. */
  prevFlag: boolean | null;
  /** A1-qualified: ≥1 SKU returned a 200 with a non-empty summary. */
  listed: boolean;
  /** §23: BUYABLE present in any probed SKU's summaries[].status. */
  buyable: boolean;
  /** §6 snapshot — the lead SKU's issues; [] when nothing is listed. */
  issues: ListingIssueLite[];
  /**
   * More specific than a flip, when it applies. `discovery` = SC had SKUs AF
   * did not know. `onboarded` = the asins row itself was just created.
   * Both outrank the flip label: a discovery is ALWAYS also a flip, and the
   * discovery is the more informative fact. The flip is still recoverable
   * from the pass report's flips array.
   */
  event?: "discovery" | "onboarded";
  /**
   * Appended to the event label, for outcomes that carry detail the ledger
   * should keep. Phase c uses it for the onboarded list the results dialog
   * shows (§18 phase c step 5): SKUs, COGS source, buy-link source. Kept in
   * the outcome string rather than a parallel field so BOTH results dialogs
   * render it through the existing per-ASIN outcome list, with no second
   * shape to thread through two different summary payloads.
   */
  detail?: string;
}

/**
 * Decide the outcome label for a verdict. Pure — exported so the dry-run path
 * reports exactly what a live run would record, with no second implementation.
 */
export function outcomeFor(v: LiveOfferVerdict): LiveOfferOutcome {
  if (v.event) return v.detail ? `${v.event} · ${v.detail}` : v.event;
  if (v.prevFlag !== v.listed) {
    return `flip: ${String(v.prevFlag)} -> ${String(v.listed)}`;
  }
  return v.listed ? "listed" : "not_listed";
}

/**
 * Write the live-offer verdict for one ASIN and record its outcome.
 *
 * Returns the outcome string it recorded, so callers can log/assert on it
 * without recomputing.
 *
 * dryRun probes and reports identically but performs NO write — the outcome is
 * still recorded, which is what makes a dry run a faithful preview.
 */
export async function writeLiveOfferVerdict(
  v: LiveOfferVerdict,
  deps: { query: QueryLike; outcomes: OutcomeSink; dryRun?: boolean },
): Promise<LiveOfferOutcome> {
  const outcome = outcomeFor(v);
  deps.outcomes(v.asin, outcome);
  if (deps.dryRun) return outcome;

  // ONE statement. has_live_offer, has_buyable_offer and both their stamps
  // move together or not at all — §23's "can never disagree about the same
  // probe" is enforced here rather than asked of each caller.
  await deps.query(
    `UPDATE asins
        SET has_live_offer = $2, offer_checked_at = now(),
            has_buyable_offer = $3, buyable_checked_at = now(),
            current_issues = $4::jsonb, issues_checked_at = now()
      WHERE asin = $1`,
    [v.asin, v.listed, v.buyable, JSON.stringify(v.issues ?? [])],
  );
  return outcome;
}

/**
 * A transient probe writes NOTHING and records skipped_transient. Separate
 * entry point rather than a flag on the verdict, so "fail-closed" is a
 * different call shape from "here is a verdict" and cannot be reached by
 * accident with a half-built verdict object.
 */
export function recordTransient(asin: string, outcomes: OutcomeSink): LiveOfferOutcome {
  outcomes(asin, "skipped_transient");
  return "skipped_transient";
}

export function recordError(asin: string, msg: string, outcomes: OutcomeSink): LiveOfferOutcome {
  const outcome = `error: ${msg}`;
  outcomes(asin, outcome);
  return outcome;
}

/**
 * Re-probe one ASIN and write whatever SC says (§18 Writers, 2026-10-10).
 *
 * This is what a §19 verdict or a 48h stale promotion TRIGGERS. A verdict is
 * a statement about a SUBMISSION; the flag is a statement about SELLER
 * CENTRAL. They are usually consistent and occasionally not, and when they
 * diverge the API is the better witness — a human resolving a row as 'live'
 * can be right that they created a listing and wrong about which SKU or ASIN
 * carries it. So the verdict never writes the flag; it asks.
 *
 * Probes every known SKU, then ASIN discovery if they all come back absent —
 * `checkAsinLiveOffer`, the same path the reconcile stage uses.
 *
 * FAIL-CLOSED AND NON-FATAL. A throttled or 5xx probe writes nothing and
 * records skipped_transient; the caller's ledger write still stands. The
 * verdict is the human's to make — this must never be able to refuse it.
 */
export async function reprobeAsinLiveOffer(
  asin: string,
  deps: {
    query: QueryLike;
    outcomes: OutcomeSink;
    sellerId?: string;
    httpGet?: HttpGetFn;
  },
): Promise<LiveOfferOutcome> {
  const sellerId = deps.sellerId ?? process.env.SP_API_SELLER_ID;
  if (!sellerId) return recordError(asin, "SP_API_SELLER_ID not configured", deps.outcomes);

  let prevFlag: boolean | null = null;
  try {
    const r = await deps.query(`SELECT has_live_offer FROM asins WHERE asin = $1`, [asin]);
    prevFlag = r.rows[0]?.has_live_offer ?? null;
  } catch (err: any) {
    return recordError(asin, `prev-flag read failed: ${err?.message ?? err}`, deps.outcomes);
  }

  let res: Awaited<ReturnType<typeof checkAsinLiveOffer>>;
  try {
    res = await checkAsinLiveOffer(asin, sellerId, { query: deps.query, httpGet: deps.httpGet });
  } catch (err: any) {
    return recordError(asin, `re-probe failed: ${err?.message ?? err}`, deps.outcomes);
  }

  if (res.verdict === "skip") {
    // transient → retried by the next sync. no_sku → nothing to probe, which
    // retrying cannot fix; recorded as an error so it is visible rather than
    // silently indistinguishable from a throttle.
    return res.skipReason === "no_sku"
      ? recordError(asin, "no known SKUs to probe", deps.outcomes)
      : recordTransient(asin, deps.outcomes);
  }

  return writeLiveOfferVerdict(
    {
      asin,
      prevFlag,
      listed: res.verdict === "live",
      buyable: anyBuyable([res.statuses ?? []]),
      issues: res.issues ?? [],
      event: res.discovered && res.discovered.length > 0 ? "discovery" : undefined,
    },
    { query: deps.query, outcomes: deps.outcomes },
  );
}
