// Per-ASIN orchestrator for the offer-add flow. Walks the decision tree:
//
//   1. Gated check (cheapest — DB query, no API calls)
//        eligibility_status !== 'yes' → gated (incl. NULL = 'not_checked')
//
//   2. SC-PRESENCE CHECK (format-agnostic — added by Maria after the
//      B00CA6Z37C duplicate-detection bug, 2026-06-28).
//        searchListingsItems by ASIN under our sellerId. ANY SKU in ANY
//        status (DISCOVERABLE, BUYABLE, closed, inactive) → already_in_catalog.
//        STOP. Never reuse, never generate, never act.
//      This is THE only check that detects pre-existing listings now. The
//      old per-SKU check at step 4a was gated on conforming-format SKUs and
//      missed every legacy/PFL/Amazon-random SKU.
//
//   3. variantSuffix bypass — explicit additional-offer mode skips reuse
//      lookup and goes straight to generate. (Only reached when step 2
//      confirmed no listing exists — variant suffixes are for adding new
//      SKUs to an ALREADY-EXISTING listing, which step 2 would have blocked.
//      Today this path is reserved for future "create variant" workflows.)
//
//   4. Resurrection candidate lookup (only for REUSE — pure format question)
//        SELECT from asin_skus, filter via matchesCurrentSkuFormat,
//        pick the most-recent (created_at DESC).
//
//   5a. Candidate found → live SC status check (defensive — step 2 should
//       have caught a duplicate, but format-agnostic checks have edge cases)
//        404 (absent) → reuse the SKU string
//        200 (present) → duplicate_warning (shouldn't happen post-step-2)
//        transient → error('transient_error') — don't fall through
//
//   5b. No candidate → resolveAndGenerateSku
//        ok          → generate
//        dead_asin   → dead_asin
//        legend_pending → legend_pending (pass through pending details)
//        no_brand / no_category / transient_error → error(reason)
//
// CRITICAL ordering rationale:
//   already_in_catalog runs BEFORE the dead_asin / catalog-fetch path because
//   a present-in-SC listing trumps any concern about Amazon's catalog state.
//   The two outcomes are mutually exclusive in practice (a catalog-deleted
//   ASIN can't have a live listing under us), but if they could co-occur
//   (e.g., catalog drift mid-batch), the present-in-SC signal wins:
//   we MUST NOT create a duplicate offer for any reason.

import { resolveAndGenerateSku, type ResolveSkuDeps } from "./sku-resolver";
import { checkSkuListingStatus } from "./sku-listing-fetch";
import { searchListingsItemsByAsin, type PresentListing } from "./sku-listing-search";
import { matchesCurrentSkuFormat } from "@shared/sku-classifier";
import type { QueryFn } from "@shared/sku-legend";
import type { HttpGetFn } from "./sku-catalog-fetch";

export interface LegendPending {
  // A brandless ASIN is never pending (§18, 2026-09-24) — it resolves to the
  // reserved code NUL automatically, so a brand row here always carries a real
  // (non-empty) brand name awaiting a legend decision.
  brand?: { rawValue: string; proposedCode: string; status: "proposed" | "not_in_legend" };
  dept?: { rawValue: string; proposedCode: string; status: "proposed" | "not_in_legend" };
}

export type ResurrectionOutcome =
  | { kind: "reuse"; sku: string; lastCreatedAt: Date }
  | { kind: "generate"; sku: string; trail: { brd: string; dep: string; ttl: string; category: string; brand: string; itemName: string | null; isDangerousGood: boolean; dgHzRegulation: string | null } }
  | { kind: "duplicate_warning"; existingSku: string; statuses: string[] }
  // NEW: at least one SKU listing exists under our sellerId for this ASIN in
  // SC, in any status. Format-agnostic — applies to legacy/PFL/Amazon-random
  // SKUs too. Skip entirely; do NOT add a second offer.
  | { kind: "already_in_catalog"; items: PresentListing[] }
  | { kind: "dead_asin"; details: string }
  | { kind: "legend_pending"; pending: LegendPending; details: string }
  | { kind: "gated"; eligibilityStatus: string }
  | { kind: "error"; reason: "no_brand" | "no_category" | "transient_error" | "listings_search_failed"; details: string };

export interface ResurrectionDeps {
  queryFn: QueryFn;
  httpGet?: HttpGetFn;
  selfHealWrite?: ResolveSkuDeps["selfHealWrite"];
  sellerId: string;
}

const GATED_SQL = `
  SELECT e.eligibility_status
  FROM asin_estimates e
  WHERE e.asin = $1
  LIMIT 1
`;

const CANDIDATE_SKU_SQL = `
  SELECT s.sku, s.created_at
  FROM asin_skus s
  JOIN asins a ON a.id = s.asin_id
  WHERE a.asin = $1
  ORDER BY s.created_at DESC, s.id DESC
`;

export async function resurrectOrGenerateSku(
  asin: string,
  productNumber: number,
  deps: ResurrectionDeps,
  variantSuffix?: string,
): Promise<ResurrectionOutcome> {
  // 1. Gated check (cheap DB lookup, no API calls)
  const gateRes = await deps.queryFn(GATED_SQL, [asin]);
  const elig: string | null | undefined = gateRes.rows[0]?.eligibility_status;
  if (elig !== "yes") {
    return { kind: "gated", eligibilityStatus: elig ?? "not_checked" };
  }

  // 2. SC-presence check — format-agnostic. Detects ANY existing listing
  // under our sellerId for this ASIN. This is THE duplicate-detection
  // gate now; the format-filtered candidate check at step 4 is only for
  // reuse selection. Failure here MUST NOT silently route to generate —
  // unknown SC state is treated as "could be a duplicate", error out.
  const presence = await searchListingsItemsByAsin(deps.sellerId, asin, deps.httpGet);
  if (!presence.ok) {
    return {
      kind: "error",
      reason: "listings_search_failed",
      details: `searchListingsItems failed (${presence.status ?? "?"}): ${presence.message}`,
    };
  }
  if (presence.present) {
    return { kind: "already_in_catalog", items: presence.items };
  }

  // 3. variantSuffix bypass — explicit additional-offer mode (post-step-2
  // gate: we only reach this when no listing exists, so variant suffix is
  // moot today; reserved for future "create variant of existing listing"
  // workflow that would need to bypass step 2's gate explicitly).
  if (!variantSuffix) {
    // 4. Resurrection candidate lookup (format-aware, for REUSE only)
    const skuRes = await deps.queryFn(CANDIDATE_SKU_SQL, [asin]);
    const candidate = skuRes.rows.find((r: any) => matchesCurrentSkuFormat(r.sku));

    if (candidate) {
      // 5a. Defensive per-SKU live status check (step 2 should have caught
      // any duplicate; this is belt-and-suspenders for the candidate SKU)
      const status = await checkSkuListingStatus(deps.sellerId, candidate.sku, deps.httpGet);
      if (!status.ok) {
        return {
          kind: "error",
          reason: "transient_error",
          details: `listing status check failed (${status.status ?? "?"}): ${status.message}`,
        };
      }
      if (status.present) {
        // Shouldn't reach here if step 2 worked correctly — but if SC state
        // raced (listing created between step 2 and step 5a), still surface as duplicate
        return { kind: "duplicate_warning", existingSku: candidate.sku, statuses: status.statuses };
      }
      return { kind: "reuse", sku: candidate.sku, lastCreatedAt: candidate.created_at };
    }
  }

  // 4b. No candidate (or variantSuffix mode) — generate new
  const resolved = await resolveAndGenerateSku(
    asin,
    productNumber,
    {
      queryFn: deps.queryFn,
      httpGet: deps.httpGet,
      selfHealWrite: deps.selfHealWrite,
    },
    variantSuffix,
  );

  if (resolved.ok) {
    return { kind: "generate", sku: resolved.sku, trail: resolved.trail };
  }
  switch (resolved.reason) {
    case "dead_asin":
      return { kind: "dead_asin", details: resolved.details };
    case "legend_pending":
      return { kind: "legend_pending", pending: resolved.pending ?? {}, details: resolved.details };
    case "no_brand":
    case "no_category":
    case "transient_error":
      return { kind: "error", reason: resolved.reason, details: resolved.details };
  }
}
