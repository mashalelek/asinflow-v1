// Post-submit verification: classify a submitted SKU's real state at SC.
//
// Pure classifier (classifyListingState) is Express-free and unit-tested; the
// SC probe (probeListingState) does the getListingsItem + ASIN-search fallback.
//
// DESIGN (hard-won from yesterday's batch — see script/diag-reverify-4skus.ts):
//   • ERROR severity ≠ failed. 18555 (price advisory) rode on a LIVE, buyable
//     listing. The reliable LIVE signal is a MATERIALIZED offer/status, never
//     the absence of issues.
//   • empty-status + transient issue (e.g. 8541) is mid-processing, and it
//     resolves. Unknown/non-terminal state → PROCESSING, never FAILED.
//   • FAILED requires a CONCLUSIVE terminal signal, never an inference.

import { spApiGet as realSpApiGet } from "./spapi-auth";
import type { HttpGetFn } from "./sku-catalog-fetch";

const MARKETPLACE = "ATVPDKIKX0DER";

// Observed terminal cases: a listing emitting these with NO materialized offer
// cannot complete via offer-only add.
//   5886  — restricted generic ASIN (must go through Add-a-Product)
//   13013 — offer rejected, product not in catalog (paired with LISTING_SUPPRESSED)
// EXTEND DELIBERATELY from real re-probed evidence. NEVER infer terminality from
// issue severity — healthy live listings carry ERROR-severity advisories.
export const TERMINAL_ISSUE_CODES: ReadonlySet<string> = new Set(["5886", "13013"]);

const TERMINAL_ENFORCEMENTS: ReadonlySet<string> = new Set(["LISTING_SUPPRESSED"]);

export interface ListingIssue {
  code: string;
  severity: string;
  message: string;
  enforcementActions?: string[]; // from issues[].enforcements.actions[].action
}

export interface ListingStateInput {
  found: boolean;      // getListingsItem returned 200 (SKU record exists at SC)
  // §18 A1 (2026-10-09): 200 AND a NON-EMPTY summaries array — i.e. a real
  // listing, not a SKU shell. DISTINCT from `found` on purpose:
  //   - `found` keeps its documented meaning ("a SKU record exists") and is
  //     what the classifier's terminal-signal path needs. A shell still
  //     carries its issues, so B07J2WWWD4's 5886 must still classify
  //     `failed` — dropping `found` to false would lose that and make it
  //     `processing` forever.
  //   - `listed` is the FLAG predicate. Only this may write has_live_offer.
  // Conflating the two is exactly how a shell wrote TRUE.
  listed: boolean;
  status: string[];    // summaries[0].status, e.g. ["DISCOVERABLE","BUYABLE"]
  hasOffer: boolean;   // offers.length>0 OR fulfillmentAvailability present
  issues: ListingIssue[];
}

export type ResolvedStatus = "live" | "failed" | "processing";

export interface Classification {
  status: ResolvedStatus;
  reviewFlags: string[];      // surfaced advisories (visible, not JSONB-only)
  terminalConflict: boolean;  // LIVE but a terminal signal is also present
}

function isMaterialized(i: ListingStateInput): boolean {
  return i.status.length > 0 || i.hasOffer;
}

function hasTerminalSignal(issues: ListingIssue[]): boolean {
  return issues.some(
    (x) =>
      TERMINAL_ISSUE_CODES.has(String(x.code)) ||
      (x.enforcementActions ?? []).some((a) => TERMINAL_ENFORCEMENTS.has(a)),
  );
}

/**
 * Classify a probed listing state into live / failed / processing.
 * Defaults toward NOT-failed: FAILED only on a conclusive terminal signal with
 * no materialized listing. Everything uncertain stays PROCESSING.
 */
export function classifyListingState(i: ListingStateInput): Classification {
  const terminal = hasTerminalSignal(i.issues);
  const errorIssues = i.issues.filter((x) => x.severity === "ERROR");

  // 1. Materialized → LIVE. Advisory issues (incl. ERROR) become review flags;
  //    they never downgrade a buyable listing.
  if (isMaterialized(i)) {
    const reviewFlags = errorIssues.map((x) => `${x.code}: ${x.message}`);
    // Precedence guard (adjustment 1): a terminal signal ALONGSIDE a live
    // listing is NOT silently LIVE — surface the conflict prominently.
    if (terminal) {
      reviewFlags.unshift(
        "⚠ CONFLICT: a terminal signal is present on a materialized listing — verify manually",
      );
    }
    return { status: "live", reviewFlags, terminalConflict: terminal };
  }

  // 2. Not materialized + conclusive terminal signal → FAILED.
  if (terminal) {
    return { status: "failed", reviewFlags: [], terminalConflict: false };
  }

  // 3. Not materialized, no terminal signal → still processing (empty status,
  //    transient issue, or API not yet indexed). Unknown codes land here.
  return { status: "processing", reviewFlags: [], terminalConflict: false };
}

// Extract the referenced/conflict ASIN from an issue message where present
// (e.g. 8541 matching-conflict messages name the other ASIN). Best-effort.
export function extractConflictAsin(issues: ListingIssue[]): string | null {
  for (const i of issues) {
    const m = /\b(B0[A-Z0-9]{8})\b/.exec(i.message ?? "");
    if (m) return m[1];
  }
  return null;
}

function normalizeIssues(raw: any[]): ListingIssue[] {
  return (raw ?? []).map((i) => ({
    code: String(i?.code ?? ""),
    severity: String(i?.severity ?? ""),
    message: String(i?.message ?? ""),
    enforcementActions: (i?.enforcements?.actions ?? []).map((a: any) => a?.action).filter(Boolean),
  }));
}

export interface ProbeResult {
  input: ListingStateInput;
  classification: Classification;
  observedSku: string;   // the SKU the state was read from (may differ from ours on ASIN-fallback)
  throttled: boolean;    // true → caller must leave the row unchanged (fail-closed)
}

/**
 * Probe SC for a submitted (asin, sku). getListingsItem is primary; on a 404
 * we fall back to searchListingsItems by ASIN to catch a listing that
 * materialized under a drifted SKU. Throttle/5xx → throttled=true (no verdict).
 */
export async function probeListingState(
  sellerId: string,
  asin: string,
  sku: string,
  httpGet: HttpGetFn = realSpApiGet,
): Promise<ProbeResult> {
  // Primary: getListingsItem by our SKU.
  try {
    const d = await httpGet(`/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`, {
      marketplaceIds: MARKETPLACE,
      includedData: "summaries,issues,offers,fulfillmentAvailability",
    });
    const summaries: any[] = Array.isArray(d?.summaries) ? d.summaries : [];
    const input: ListingStateInput = {
      found: true,
      listed: summaries.length > 0, // §18 A1 — a shell is found-but-not-listed
      status: summaries[0]?.status ?? [],
      hasOffer: (d?.offers ?? []).length > 0 || (d?.fulfillmentAvailability ?? []).length > 0,
      issues: normalizeIssues(d?.issues ?? []),
    };
    return { input, classification: classifyListingState(input), observedSku: sku, throttled: false };
  } catch (err: any) {
    const status = err?.response?.status;
    const code = err?.response?.data?.errors?.[0]?.code;
    if (status === 429 || code === "QuotaExceeded" || (status >= 500 && status <= 599)) {
      // Fail-closed: no verdict on throttle/server error.
      return {
        input: { found: false, listed: false, status: [], hasOffer: false, issues: [] },
        classification: { status: "processing", reviewFlags: [], terminalConflict: false },
        observedSku: sku,
        throttled: true,
      };
    }
    if (status !== 404) {
      // Any other client error is inconclusive — treat like throttle (no verdict).
      return {
        input: { found: false, listed: false, status: [], hasOffer: false, issues: [] },
        classification: { status: "processing", reviewFlags: [], terminalConflict: false },
        observedSku: sku,
        throttled: true,
      };
    }
    // 404 → SKU absent under our SKU string. Fall back to ASIN search (SKU drift).
  }

  try {
    const d = await httpGet(`/listings/2021-08-01/items/${sellerId}`, {
      marketplaceIds: MARKETPLACE,
      identifiers: asin,
      identifiersType: "ASIN",
      includedData: "summaries",
    });
    // §18 A1: shells filtered before the found/absent decision.
    const items: any[] = (d?.items ?? []).filter(
      (it: any) => Array.isArray(it?.summaries) && it.summaries.length > 0,
    );
    if (items.length === 0) {
      // Genuinely absent at SC, and no terminal signal (404 carries none) →
      // PROCESSING. Time-based STALE + manual DELETED verdict handle this.
      const input: ListingStateInput = { found: false, listed: false, status: [], hasOffer: false, issues: [] };
      return { input, classification: classifyListingState(input), observedSku: sku, throttled: false };
    }
    // Materialized under a (possibly different) SKU → LIVE, record the real SKU.
    const it = items[0];
    const input: ListingStateInput = {
      found: true,
      listed: true, // filtered above — this row has a summary
      status: it?.summaries?.[0]?.status ?? [],
      hasOffer: true, // present under the ASIN with a summary = materialized
      issues: [],
    };
    return { input, classification: classifyListingState(input), observedSku: String(it?.sku ?? sku), throttled: false };
  } catch {
    // Fallback failed → no verdict (fail-closed).
    return {
      input: { found: false, listed: false, status: [], hasOffer: false, issues: [] },
      classification: { status: "processing", reviewFlags: [], terminalConflict: false },
      observedSku: sku,
      throttled: true,
    };
  }
}
