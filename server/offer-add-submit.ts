// 2D-4: Live submit orchestrator. THE FIRST place dryRun=false is ever passed.
//
// This is the ONLY code path that fires real putListingsItem calls. Every
// blocking outcome surfaced by phase 1-3 is respected — no ASIN reaches phase
// 4 unless price + NNN are fully resolved.
//
// Phases (forced by batch-NNN requirement — allocator can't run per-call):
//   Phase 1 — per-ASIN classification via dry-run offerAddForAsin.
//             Yields a "preview" outcome (with SKU embedded) for ready ASINs.
//             Blocked outcomes (gated/dead_asin/legend_pending/duplicate_warning
//             /resurrection_error) pass straight through to the result.
//   Phase 2 — batch NNN allocation. Single assignNnns() call over the GENERATE
//             bucket. Sequential within batch (max+1, max+2, max+3…). 999
//             overflow becomes a skip; other buckets unaffected.
//   Phase 3 — per-ASIN price resolution via fetchCompetingOffers (retry+backoff
//             built in) + resolveOfferPrice. Paced 2200ms between calls
//             (matches getItemOffers 0.5 rps limit).
//   Phase 4 — per-ASIN live submit: offerAddForAsin(dryRun=false) with the
//             allocated NNN + resolved price. Reuse-path ASINs use a
//             placeholder productNumber (resurrection bypasses NNN when reusing).
//
// CRITICAL non-coverage edge case: if a putListingsItem SUCCEEDS at Amazon's
// end but our response handling errors out (network hiccup mid-response), the
// listing exists but we never record the SKU. The next batch's allocator
// would reassign the same NNN → collision. Manual fix: after any
// putlistings_failed outcome, verify in Seller Central before retry.
//
// Tests inject offerAddFn + fetchOffersFn to avoid network. Production calls
// pass the real implementations.

import { offerAddForAsin as realOfferAddForAsin, preFilterSubmitSet, type OfferAddInput, type OfferAddResult, type OfferAddDeps, type PreFilterResult } from "./offer-add";
import type { LegendPending } from "./sku-resurrection";
import { fetchCompetingOffers as realFetchOffers, type OffersFetchOutcome } from "./listings-offers-fetch";
import { resolveOfferPrice, type PriceResolverResult, type DisqualifiedOffer } from "@shared/price-resolver";
import { assignNnns, buildExistingNnnsFromSkus, mergeRegistryNnns, parseConformingSku, type NnnAssignmentRequest, type NnnAssignmentOutcome } from "@shared/nnn-assignment";
import type { ListingsIssue, OfferAddFailureReason } from "./listings-error-map";
import type { QueryFn } from "@shared/sku-legend";
import type { Settings } from "@shared/schema";
import type { ProductRegistryRepo } from "./product-registry-repo";
import type { ProductRegistryRow } from "@shared/product-registry";

// ============================================================================
// Result types
// ============================================================================

// Discriminated union covering EVERY per-ASIN outcome of the submit flow.
// 'skipped' is the catch-all for any ASIN that didn't reach phase 4 (live PUT).
// 'created' / 'putlistings_failed' come only from phase 4.
export type SubmitOutcome =
  // Reached phase 4 + completed (phase4Mode="live")
  | { kind: "created";             asin: string; sku: string; submissionId: string; warnings: ListingsIssue[]; resolvedPrice: number; priceSource: string;
      priceDetail: string; anchorOfferPrice: number | null; anchorOfferFeedback: number | null;
      competitivePriceThreshold: number | null; resultingRoi: number | null;
      priceWarning: string | null; qualifiedCount: number; disqualified: DisqualifiedOffer[] }
  | { kind: "putlistings_failed";  asin: string; sku: string; reason: OfferAddFailureReason; originalCode: string | null; originalMessage: string; retryable: boolean; resolvedPrice: number }
  // Reached phase 4 but did NOT fire PUT (phase4Mode="preview").
  // The payload IS the exact bytes that "live" mode would have sent.
  //
  // brandCode + registry expose the brand's product registry to the UI so
  // operator NNN edits can lock/unlock TTL client-side without an extra
  // round-trip. proposedNnn/proposedTtl are the allocator + derivation
  // defaults the canonical SKU was built from.
  | { kind: "would_submit"; asin: string; sku: string; reused: boolean; payload: any; resolvedPrice: number; priceSource: string;
      priceDetail: string; anchorOfferPrice: number | null; anchorOfferFeedback: number | null;
      competitivePriceThreshold: number | null; resultingRoi: number | null;
      priceWarning: string | null; qualifiedCount: number; disqualified: DisqualifiedOffer[];
      // §18 max_order_quantity (2026-09-13) — read out of the assembled payload.
      maxOrderQuantity?: number;
      brandCode?: string; registry?: ProductRegistryRow[]; proposedNnn?: number; proposedTtl?: string }
  // Skipped before reaching phase 4.
  // `pending` is populated ONLY when reason === "legend_pending" — the
  // structured resolver payload (LegendPending) the approval dialog needs.
  // Carried through here so the route mapper doesn't have to reconstruct
  // (or worse, hard-code nulls) from the `details` string. All other skip
  // reasons leave it undefined; no bloat for non-legend skips.
  | { kind: "skipped"; asin: string; reason: SkipReason; details: string; pending?: LegendPending };

export type SkipReason =
  // Pre-filter
  | "catalog_deleted" | "gated" | "not_checked"
  // Phase 1 (resurrection blocked outcomes)
  | "dead_asin" | "legend_pending" | "duplicate_warning" | "already_in_catalog" | "resurrection_error" | "definitions_fetch_failed"
  // DG declaration value unresolved (fail-closed; manual selection needed)
  | "dg_value_unresolved"
  // Phase 2 (allocator)
  | "nnn_overflow"
  // Phase 3 (price resolver)
  | "needs_cogs" | "offers_fetch_failed" | "unreachable_roi"
  // Phase 4 override validation + registry validation
  | "invalid_sku_override" | "sku_collision"
  | "nnn_taken" | "registry_reserve_failed" | "invalid_sku_format"
  // §18 Relist: the requested SKU is not in asin_skus for the ASIN
  | "relist_sku_unknown";

export interface SubmitResult {
  preFilter: { excluded: PreFilterResult["excluded"] };
  perAsin: Array<{ asin: string; outcome: SubmitOutcome }>;
  notes: {
    liveWrites: string;
    submittedCount: number;
    skippedCount: number;
    failedCount: number;
  };
}

// ============================================================================
// Per-ASIN input — what the submit endpoint needs to know per ASIN.
// Loaded by the route in a single SQL query before calling submitOfferAddBatch.
// ============================================================================

export interface SubmitAsinRow {
  asin: string;
  // Pre-filter inputs
  is_catalog_deleted: boolean;
  eligibility_status: string | null;
  /** When eligibility_status was last probed (ISO); the preview shows "gated as of …". Optional: tests and older callers omit it. */
  gating_checked_at?: string | null;
  // Still consumed by the PRICE resolver (hazmat surcharge). NOT used for the
  // offer-add DG attribute anymore — that is LIVE-derived in offerAddForAsin,
  // never the stored column. (Switching the surcharge to is_dangerous_good is
  // the separate surcharge/UI pass, decision (b).)
  is_hazmat: boolean;
  // Price resolver inputs (from asin_estimates)
  cogs: number | null;
  fbaFee: number | null;
  referralFee: number | null;
  feesEstimatePrice: number | null;
  weightLbs: number | null;
  category: string | null;
  prepCost: number;
  storageCost: number;
}

export interface SubmitDeps {
  queryFn: QueryFn;
  sellerId: string;
  settings: Settings;
  includeInboundShipping: boolean;
  // All asin_skus rows (just the sku strings) — fed to allocator for max-NNN
  // computation. Pre-loaded by the route in one SQL query.
  allExistingSkus: string[];
  // Test injection points; defaults call the real implementations.
  offerAddFn?: (input: OfferAddInput, innerDeps: OfferAddDeps, dryRun: boolean) => Promise<OfferAddResult>;
  fetchOffersFn?: (asin: string, sellerId: string) => Promise<OffersFetchOutcome>;
  // selfHeal pass-through to offerAddForAsin (live writes ARE allowed in submit)
  selfHealWrite?: OfferAddDeps["selfHealWrite"];
  // For tests: skip the 2200ms inter-ASIN pacing on getItemOffers calls.
  pacingMs?: number;
  // Phase 1 inter-ASIN pacing for the Listings API family (searchListingsItems
  // + getListingsItem + getCatalogItem). Listings is 5 rps / 10 burst; 250ms
  // between ASIN starts yields ~4 starts/sec, well within burst budget when
  // each ASIN's worst case is ~4 Listings calls. Retries inside the helpers
  // smooth out any remaining spikes.
  phase1PacingMs?: number;
  // "live" (default) fires putListingsItem in phase 4. "preview" does
  // EVERYTHING except the final PUT — same orchestration, same resolved price,
  // same NNN — so the preview UI can show the EXACT payload that submit would
  // send. This guarantees preview == submit by construction (single code path).
  phase4Mode?: "live" | "preview";
  // Operator SKU overrides keyed by ASIN. Each value is the full final SKU
  // string (BRD-DEP-AS3-TTL-NNN[-X]). Applied in phase 4 only — preview mode
  // ignores them (the canonical SKU is what gets returned for the operator
  // to edit). Validation: format regex + BRD-DEP-AS3 invariant inside
  // offerAddForAsin, plus a final batch-wide collision sweep here.
  skuOverrides?: Record<string, string>;
  // §18 Relist (2026-10-29), keyed by ASIN: reuse THIS exact prior SKU
  // (format-agnostic — the SKU must be AF history in asin_skus and must 404
  // live), optionally coming up OPEN (openOnCreate → the §19 ladder skips
  // close-after-create for that submission). Threaded into BOTH phase 1
  // (classification resolves the requested SKU, not a conforming candidate)
  // and phase 4. Relist is an exact-reuse path: no NNN allocation, no
  // registry reservation, and the skuOverrides collision sweep does not
  // apply (the SKU exists in asin_skus by design).
  relist?: Record<string, { sku: string; openOnCreate?: boolean }>;
  // Registry repo for reserve-then-PUT in live mode. Required for any live
  // submit; preview mode uses it only to LOAD the brand's registry into
  // would_submit outcomes (no reservation).
  productRegistry?: ProductRegistryRepo;
}

const DEFAULT_OFFERS_PACING_MS = 2200;
// Phase 1 (classification reads) — 400ms between ASIN starts gives ~2.5
// starts/sec × ~2 Listings calls avg = ~5 calls/sec sustained, matching the
// Listings API 5 rps limit. Combined with searchListingsItemsByAsin's
// 5-attempt retry budget (1+2+4+8s backoff = 15s max under extreme throttle),
// this absorbs bursts cleanly for batches of 100+ ASINs.
// Pacing only fires BETWEEN ASINs (pi > 0 guard) — single-ASIN runs have
// zero added latency.
const DEFAULT_PHASE1_PACING_MS = 400;

// ============================================================================
// Orchestrator
// ============================================================================

export async function submitOfferAddBatch(
  rows: SubmitAsinRow[],
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const offerAddFn = deps.offerAddFn ?? realOfferAddForAsin;
  const fetchOffersFn = deps.fetchOffersFn ?? ((asin, sid) => realFetchOffers(asin, sid));
  const pacingMs = deps.pacingMs ?? DEFAULT_OFFERS_PACING_MS;
  const phase1PacingMs = deps.phase1PacingMs ?? DEFAULT_PHASE1_PACING_MS;
  const phase4Mode = deps.phase4Mode ?? "live";

  // ─── Pre-filter ─────────────────────────────────────────────────────────────
  const preFilter = preFilterSubmitSet(rows.map((r) => ({
    asin: r.asin,
    is_catalog_deleted: r.is_catalog_deleted,
    eligibility_status: r.eligibility_status,
  })));

  // Build per-ASIN outcomes — start with pre-filter exclusions as skipped.
  const outcomeByAsin = new Map<string, SubmitOutcome>();
  for (const ex of preFilter.excluded) {
    outcomeByAsin.set(ex.asin, {
      kind: "skipped",
      asin: ex.asin,
      reason: ex.reason,
      details: ex.reason === "catalog_deleted"
        ? "ASIN marked is_catalog_deleted in DB"
        : ex.reason === "gated"
          ? `eligibility_status='${rows.find(r => r.asin === ex.asin)?.eligibility_status ?? ""}'`
          : "eligibility never checked — re-run analyze first",
    });
  }
  const submittableRows = rows.filter((r) => preFilter.submittable.includes(r.asin));

  // ─── Phase 1: per-ASIN dry-run classification ───────────────────────────────
  // We pass placeholder productNumber=1 and price=0. Phase 4 will recall with
  // real values. Reuse-path ASINs return reused=true with their existing SKU.
  // Generate-path ASINs return reused=false with a SKU containing NNN=001 prefix.
  interface Phase1Ready {
    asin: string;
    sku: string;       // SKU template from dry-run (NNN may be placeholder for generate)
    reused: boolean;   // true = use the SKU as-is (no NNN allocation); false = re-generate with allocated NNN
  }
  const phase1Ready: Phase1Ready[] = [];

  for (let pi = 0; pi < submittableRows.length; pi++) {
    const row = submittableRows[pi];
    // Pace BETWEEN phase-1 ASIN starts (not before the first) for the
    // Listings API family. Each ASIN's worst-case ~4 Listings calls would
    // otherwise burst over the 10-burst limit on N>=3 batches.
    if (pi > 0 && phase1PacingMs > 0) await delay(phase1PacingMs);
    const innerDeps: OfferAddDeps = {
      queryFn: deps.queryFn,
      sellerId: deps.sellerId,
      // selfHealWrite intentionally omitted in dry-run — orchestrator suppresses it too,
      // but defense-in-depth.
    };
    const result = await offerAddFn(
      // cogs passed for completeness — this probe resolves the SKU only
      // (price 0, dryRun), so the cap it computes is never submitted.
      { asin: row.asin, productNumber: 1, price: 0, cogs: row.cogs, relistSku: deps.relist?.[row.asin]?.sku },
      innerDeps,
      true, // dryRun
    );
    const skipped = mapBlockedOutcomeToSkip(result);
    if (skipped) {
      outcomeByAsin.set(row.asin, skipped);
      continue;
    }
    // Must be 'preview' kind at this point
    if (result.kind !== "preview") {
      // Defensive — shouldn't happen given the discriminated union, but if a new
      // outcome is added that we don't classify, surface it as resurrection_error.
      outcomeByAsin.set(row.asin, {
        kind: "skipped", asin: row.asin, reason: "resurrection_error",
        details: `unexpected phase-1 outcome kind=${(result as any).kind}`,
      });
      continue;
    }
    phase1Ready.push({
      asin: row.asin,
      sku: result.sku,
      reused: result.reused,
    });
  }

  // ─── Phase 1.5: load brand registries (once per unique brand) ───────────────
  // Used in two places:
  //   (preview mode) attached to would_submit outcomes so the UI can lookup
  //                  operator NNN edits client-side
  //   (live mode)   the repo is passed to offerAddForAsin for reserve-then-PUT
  // Parses brand code from each generate-path SKU's first segment.
  const registryByBrand = new Map<string, ProductRegistryRow[]>();
  if (deps.productRegistry) {
    const brandsNeeded = new Set<string>();
    for (const p of phase1Ready) {
      if (p.reused) continue;
      const parsed = parseConformingSku(p.sku);
      if (parsed) brandsNeeded.add(parsed.brd);
    }
    for (const brand of Array.from(brandsNeeded)) {
      const rows = await deps.productRegistry.listForBrand(brand);
      registryByBrand.set(brand, rows);
    }
  }

  // ─── Phase 2: batch NNN allocation for GENERATE-bucket ASINs ────────────────
  // Reuse-bucket ASINs skip the allocator (their NNN is already baked into the
  // existing SKU). For generate: parse BRD/DEP from the dry-run SKU prefix,
  // batch-assign sequential NNNs from existing-max.
  const generateAsins = phase1Ready.filter((p) => !p.reused);
  const nnnRequests: NnnAssignmentRequest[] = [];
  for (const p of generateAsins) {
    const parsed = parseConformingSku(p.sku);
    if (!parsed) {
      outcomeByAsin.set(p.asin, {
        kind: "skipped", asin: p.asin, reason: "resurrection_error",
        details: `dry-run produced non-conforming SKU: ${p.sku}`,
      });
      continue;
    }
    nnnRequests.push({ asin: p.asin, brandCode: parsed.brd, deptCode: parsed.dep });
  }
  // §18 (2026-10-07): the existing set is asin_skus UNION the registry. The
  // per-brand rows were already loaded above for the preview's client-side
  // lookup, so this costs no extra query. A registry row whose SKU never
  // reached asin_skus (a reservation whose PUT failed) still burns its NNN.
  const existingNnns = buildExistingNnnsFromSkus(deps.allExistingSkus);
  for (const rows of Array.from(registryByBrand.values())) {
    mergeRegistryNnns(existingNnns, rows.map((r) => ({ brandCode: r.brandCode, nnn: r.nnn })));
  }
  const allocations = assignNnns(nnnRequests, existingNnns);
  // Build map: asin → allocation outcome
  const allocByAsin = new Map<string, NnnAssignmentOutcome>();
  for (const a of allocations) allocByAsin.set(a.asin, a);
  // Record overflow as skip
  for (const a of allocations) {
    if (a.kind === "overflow") {
      outcomeByAsin.set(a.asin, {
        kind: "skipped", asin: a.asin, reason: "nnn_overflow",
        details: a.detail,
      });
    }
  }

  // ─── Phase 3: per-ASIN price resolution (paced) ─────────────────────────────
  // After phase 2, "ready for pricing" = phase1Ready ∖ (overflow + non-conforming-SKU).
  const readyForPricing = phase1Ready.filter((p) => !outcomeByAsin.has(p.asin));
  const priceByAsin = new Map<string, {
    // cogs travels WITH the price (2026-09-13) so max_order_quantity is
    // computed from the exact number the price was resolved against — a
    // re-read here could drift from what the resolver saw.
    price: number; cogs: number | null;
    detail: string; source: string; anchorOfferPrice: number | null; anchorOfferFeedback: number | null;
    competitivePriceThreshold: number | null; resultingRoi: number | null;
    warning: string | null; qualifiedCount: number; disqualified: DisqualifiedOffer[];
  }>();
  for (let i = 0; i < readyForPricing.length; i++) {
    const p = readyForPricing[i];
    const row = submittableRows.find((r) => r.asin === p.asin)!;

    // Pace BEFORE the call (except the first one) — getItemOffers is 0.5 rps.
    // fetchCompetingOffers has internal retry-on-throttle, but proactive pacing
    // avoids burning retry budget on a batch's natural cadence.
    if (i > 0 && pacingMs > 0) await delay(pacingMs);

    const offersOutcome = await fetchOffersFn(p.asin, deps.sellerId);
    const resolverInput = {
      cogs: row.cogs,
      fbaFee: row.fbaFee,
      referralFee: row.referralFee,
      feesEstimatePrice: row.feesEstimatePrice,
      weightLbs: row.weightLbs,
      isHazmat: row.is_hazmat,
      category: row.category,
      prepCost: row.prepCost,
      storageCost: row.storageCost,
      offers: offersOutcome.ok
        ? {
            kind: "definitive" as const,
            // §18 v2: the resolver qualifies (Amazon out, feedback >= 15) and
            // reports the disqualified, so it needs the full per-offer list —
            // not just prices. Our own offer is already filtered out upstream.
            offers: offersOutcome.allOffers.filter((o) => o.sellerId !== deps.sellerId),
            competitivePriceThreshold: offersOutcome.competitivePriceThreshold,
            buyBoxPrice: offersOutcome.buyBoxPrice,
          }
        : { kind: "fetch_failed" as const, reason: `${offersOutcome.reason}${offersOutcome.status ? ` (${offersOutcome.status})` : ""}: ${offersOutcome.message}` },
    };
    const resolved: PriceResolverResult = resolveOfferPrice(resolverInput, deps.settings, deps.includeInboundShipping);

    if (resolved.resolvedPrice == null) {
      // §18 v2 blocked reasons map 1:1 onto the existing skip reasons.
      // needs_cogs is NOT a dead end: the preview expands the row for an
      // inline COGS entry, saves it as estimated COGS, and re-resolves.
      const skipReason: SkipReason =
        resolved.blocked === "needs_cogs" ? "needs_cogs"
        : resolved.blocked === "offers_fetch_failed" ? "offers_fetch_failed"
        : "unreachable_roi";
      outcomeByAsin.set(p.asin, {
        kind: "skipped", asin: p.asin, reason: skipReason,
        details: resolved.detail,
      });
      continue;
    }
    priceByAsin.set(p.asin, {
      price: resolved.resolvedPrice, cogs: row.cogs,
      detail: resolved.detail, source: resolved.source!,
      anchorOfferPrice: resolved.anchorOffer?.price ?? null,
      anchorOfferFeedback: resolved.anchorOffer?.feedbackCount ?? null,
      competitivePriceThreshold: resolved.competitivePriceThreshold,
      resultingRoi: resolved.resultingRoi,
      warning: resolved.warning, qualifiedCount: resolved.qualifiedCount,
      disqualified: resolved.disqualified,
    });
  }

  // ─── Phase 4: per-ASIN live submit (or preview) ─────────────────────────────
  // For each ASIN with both NNN (or reuse) AND price resolved → fire real PUT
  // (or assemble preview payload if phase4Mode="preview").
  const readyForSubmit = phase1Ready.filter((p) => !outcomeByAsin.has(p.asin) && priceByAsin.has(p.asin));

  // ── Live-mode override collision sweep ──
  // For live mode with overrides: walk every ready ASIN and compute its FINAL
  // intended SKU (override if present, else canonical). Detect any duplicate
  // or any clash with allExistingSkus. Mark all colliding ASINs as skipped
  // BEFORE any PUT fires — never half-write a batch with a collision pending.
  if (phase4Mode === "live" && deps.skuOverrides && Object.keys(deps.skuOverrides).length > 0) {
    const finalSkuByAsin = new Map<string, string>();
    const overrides = deps.skuOverrides;
    for (const p of readyForSubmit) {
      const alloc = p.reused ? null : allocByAsin.get(p.asin);
      const productNumber = p.reused ? 1 : (alloc && alloc.kind === "assigned" ? alloc.nnn : 1);
      const override = overrides[p.asin];
      let finalSku: string;
      if (override && !p.reused) {
        finalSku = override;
      } else if (p.reused) {
        finalSku = p.sku; // reuse path: existing SKU as-is
      } else {
        // Reconstruct allocator-assigned SKU: keep BRD-DEP-AS3-TTL, swap NNN
        const parts = p.sku.split("-");
        parts[4] = String(productNumber).padStart(3, "0");
        finalSku = parts.join("-");
      }
      finalSkuByAsin.set(p.asin, finalSku);
    }
    // Detect duplicate finals within the batch + clashes with existing SKUs.
    const existingSet = new Set(deps.allExistingSkus);
    const seenFinal = new Map<string, string>(); // sku -> asin
    for (const [asin, sku] of Array.from(finalSkuByAsin.entries())) {
      const conflictWith = seenFinal.get(sku);
      if (conflictWith) {
        outcomeByAsin.set(asin, {
          kind: "skipped", asin, reason: "sku_collision",
          details: `SKU '${sku}' duplicated within this batch (also requested for ${conflictWith})`,
        });
        outcomeByAsin.set(conflictWith, {
          kind: "skipped", asin: conflictWith, reason: "sku_collision",
          details: `SKU '${sku}' duplicated within this batch (also requested for ${asin})`,
        });
        continue;
      }
      if (existingSet.has(sku)) {
        outcomeByAsin.set(asin, {
          kind: "skipped", asin, reason: "sku_collision",
          details: `SKU '${sku}' already exists in asin_skus (retired or in use)`,
        });
        continue;
      }
      seenFinal.set(sku, asin);
    }
  }

  for (const p of readyForSubmit) {
    if (outcomeByAsin.has(p.asin)) continue; // collision sweep above may have skipped this
    const priced = priceByAsin.get(p.asin)!;
    const alloc = p.reused ? null : allocByAsin.get(p.asin);
    // For generate, alloc must be 'assigned' (overflow already filtered above).
    const productNumber = p.reused
      ? 1 // placeholder — reuse path bypasses generation, productNumber is unused
      : (alloc && alloc.kind === "assigned" ? alloc.nnn : 1);
    const skuOverride = phase4Mode === "live" && !p.reused ? deps.skuOverrides?.[p.asin] : undefined;

    const innerDeps: OfferAddDeps = {
      queryFn: deps.queryFn,
      sellerId: deps.sellerId,
      // Pass selfHealWrite only in live mode — preview mode doesn't mutate
      selfHealWrite: phase4Mode === "live" ? deps.selfHealWrite : undefined,
      // Registry repo: live mode only. Preview never reserves.
      productRegistry: phase4Mode === "live" ? deps.productRegistry : undefined,
    };
    const relistEntry = deps.relist?.[p.asin];
    const result = await offerAddFn(
      {
        asin: p.asin, productNumber, price: priced.price, cogs: priced.cogs, skuOverride,
        relistSku: relistEntry?.sku,
        openOnCreate: relistEntry?.openOnCreate === true,
        // §18 v2: persist WHY this price on the ledger row. Only in live mode —
        // preview fires no PUT and writes no submission.
        pricingDecision: phase4Mode === "live" ? {
          source: priced.source,
          detail: priced.detail,
          anchorOfferPrice: priced.anchorOfferPrice,
          anchorOfferFeedback: priced.anchorOfferFeedback,
          cptSeen: priced.competitivePriceThreshold,
          resultingRoi: priced.resultingRoi,
          warning: priced.warning,
          qualifiedOfferCount: priced.qualifiedCount,
          disqualifiedOffers: priced.disqualified,
        } : undefined,
      },
      innerDeps,
      phase4Mode === "preview", // dryRun: TRUE for preview, FALSE for live PUT
    );

    if (result.kind === "preview") {
      // phase4Mode="preview" path — surface the assembled payload + resolved price
      // plus brand registry + proposed defaults for the editable UI.
      let brandCode: string | undefined;
      let registry: ProductRegistryRow[] | undefined;
      let proposedNnn: number | undefined;
      let proposedTtl: string | undefined;
      if (!result.reused) {
        const parsed = parseConformingSku(result.sku);
        if (parsed) {
          brandCode = parsed.brd;
          registry = registryByBrand.get(parsed.brd) ?? [];
          proposedNnn = parsed.nnn;
          // proposedTtl is the 4th segment of the canonical SKU (derived from
          // product name by the resolver upstream).
          proposedTtl = result.sku.split("-")[3];
        }
      }
      outcomeByAsin.set(p.asin, {
        kind: "would_submit", asin: p.asin, sku: result.sku, reused: result.reused,
        payload: result.payload, resolvedPrice: priced.price, priceSource: priced.source,
        // Read back OUT of the assembled payload — preview shows exactly what
        // would ship, not a recomputation that could drift from it.
        maxOrderQuantity: (result.payload as any)?.attributes?.max_order_quantity?.[0]?.value,
        priceDetail: priced.detail, anchorOfferPrice: priced.anchorOfferPrice,
        anchorOfferFeedback: priced.anchorOfferFeedback,
        competitivePriceThreshold: priced.competitivePriceThreshold,
        resultingRoi: priced.resultingRoi, priceWarning: priced.warning,
        qualifiedCount: priced.qualifiedCount, disqualified: priced.disqualified,
        brandCode, registry, proposedNnn, proposedTtl,
      });
    } else if (result.kind === "created") {
      outcomeByAsin.set(p.asin, {
        kind: "created", asin: p.asin, sku: result.sku, submissionId: result.submissionId,
        warnings: result.warnings, resolvedPrice: priced.price, priceSource: priced.source,
        priceDetail: priced.detail, anchorOfferPrice: priced.anchorOfferPrice,
        anchorOfferFeedback: priced.anchorOfferFeedback,
        competitivePriceThreshold: priced.competitivePriceThreshold,
        resultingRoi: priced.resultingRoi, priceWarning: priced.warning,
        qualifiedCount: priced.qualifiedCount, disqualified: priced.disqualified,
      });
    } else if (result.kind === "putlistings_failed") {
      outcomeByAsin.set(p.asin, {
        kind: "putlistings_failed", asin: p.asin, sku: result.sku, reason: result.reason,
        originalCode: result.originalCode, originalMessage: result.originalMessage,
        retryable: result.retryable, resolvedPrice: priced.price,
      });
    } else {
      // Resurrection state changed between phase 1 and phase 4 (TOCTOU). Rare.
      const skipped = mapBlockedOutcomeToSkip(result);
      outcomeByAsin.set(p.asin, skipped ?? {
        kind: "skipped", asin: p.asin, reason: "resurrection_error",
        details: `phase-4 outcome unexpectedly kind=${(result as any).kind}`,
      });
    }
  }

  // ─── Assemble result in original input order ────────────────────────────────
  const perAsin = rows.map((r) => ({
    asin: r.asin,
    outcome: outcomeByAsin.get(r.asin) ?? {
      kind: "skipped" as const, asin: r.asin, reason: "resurrection_error" as const,
      details: "no outcome recorded — orchestrator bug",
    },
  }));

  let submittedCount = 0, skippedCount = 0, failedCount = 0;
  for (const { outcome } of perAsin) {
    if (outcome.kind === "created" || outcome.kind === "would_submit") submittedCount++;
    else if (outcome.kind === "putlistings_failed") failedCount++;
    else skippedCount++;
  }

  return {
    preFilter: { excluded: preFilter.excluded },
    perAsin,
    notes: {
      liveWrites: phase4Mode === "live"
        ? "ENABLED — this endpoint fires real putListingsItem calls."
        : "DISABLED — preview mode: phase 4 assembles payload but skips PUT.",
      submittedCount,
      skippedCount,
      failedCount,
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function mapBlockedOutcomeToSkip(result: OfferAddResult): SubmitOutcome | null {
  switch (result.kind) {
    case "gated":
      return { kind: "skipped", asin: result.asin, reason: "gated", details: result.details };
    case "dead_asin":
      return { kind: "skipped", asin: result.asin, reason: "dead_asin", details: result.details };
    case "legend_pending":
      // Carry the structured resolver payload (rawValue/proposedCode/status
      // per brand+dept) through the collapse so the client's approval
      // dialog has something real to walk. Previously dropped here → client
      // received {brand:null, dept:null} → "Review approvals" silently no-op'd.
      return { kind: "skipped", asin: result.asin, reason: "legend_pending", details: result.details, pending: result.pending };
    case "duplicate_warning":
      return { kind: "skipped", asin: result.asin, reason: "duplicate_warning",
        details: `existing SKU ${result.existingSku} (${result.statuses.join(", ")})` };
    case "already_in_catalog": {
      const summary = result.items
        .map((it) => `${it.sku}${it.statuses.length ? ` [${it.statuses.join(",")}]` : ""}`)
        .join("; ");
      return { kind: "skipped", asin: result.asin, reason: "already_in_catalog",
        details: `Already listed under your seller: ${summary}` };
    }
    case "resurrection_error":
      return { kind: "skipped", asin: result.asin,
        reason: result.reason === "definitions_fetch_failed" ? "definitions_fetch_failed"
              : result.reason === "invalid_sku_override" ? "invalid_sku_override"
              : result.reason === "nnn_taken" ? "nnn_taken"
              : result.reason === "registry_reserve_failed" ? "registry_reserve_failed"
              : result.reason === "invalid_sku_format" ? "invalid_sku_format"
              : result.reason === "relist_sku_unknown" ? "relist_sku_unknown"
              : "resurrection_error",
        details: result.details };
    case "dg_value_unresolved":
      return { kind: "skipped", asin: result.asin, reason: "dg_value_unresolved", details: result.details };
    default:
      return null;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
