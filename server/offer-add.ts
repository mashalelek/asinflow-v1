// Per-ASIN offer-add orchestrator.
//
// Flow:
//   1. Resurrection — read prior SKUs, decide reuse/generate/duplicate/gated/etc.
//   2. If pre-PUT failure (gated, dead, legend_pending, error) → return early.
//   3. If duplicate_warning → return as preview gate (UI prompts; DA-4 doesn't auto-resolve).
//   4. If reuse/generate → fetch product-type definition (spec-required first step).
//   5. Assemble putListingsItem payload (FBA, no fulfillment quantity key,
//      always-present attrs incl. the COGS-conditional max_order_quantity).
//   6. If dryRun=true → return { kind: 'preview', sku, payload }. NO PUT call.
//   7. If dryRun=false → call putListingsItem → mapper → typed outcome.
//      - On reason='catalog_deleted' → fire applyCatalogDeletedSignal(asin, true).
//      - On reason='gated' → return reason only. NO writes to eligibility_status
//        (per Maria's call: avoid two writers on one §14-owned field; gated
//        from putListingsItem can be noisy/transient. If gated persists, re-run analyze).
//
// CRITICAL: dryRun is a REQUIRED boolean. No default. Caller must explicitly
// opt into live writes. This is a defensive contract — the first real
// putListingsItem call must come from an explicit, audited code path.

import { resurrectOrGenerateSku, type ResurrectionDeps, type ResurrectionOutcome, type LegendPending } from "./sku-resurrection";
import type { PresentListing } from "./sku-listing-search";
import type { ProductRegistryRepo } from "./product-registry-repo";
import { fetchDgHzRegulationEnum } from "./listings-definitions";
import { putListingsItem, type HttpPutFn } from "./listings-write";
import { mapPutListingsResponse, type OfferAddFailureReason, type ListingsIssue } from "./listings-error-map";
import { applyCatalogDeletedSignal } from "./catalog-deleted-write";
import type { QueryFn } from "@shared/sku-legend";
import { fetchDgHzLive, type HttpGetFn } from "./sku-catalog-fetch";
import { resolveDgHzRegulation } from "./hazmat-classify";
import { recordSubmission, type PricingDecision } from "./listing-submissions-repo";

const MARKETPLACE = "ATVPDKIKX0DER";
const PRODUCT_TYPE = "PRODUCT"; // offer-only matching uses the generic PRODUCT type
// §18 born-closed: past end_at soft-closes the offer at creation. Year-2000
// per the community-verified pattern; any past date works.
export const BORN_CLOSED_END_AT = "2000-01-01";

/**
 * THE end_at value AF writes — the one helper both writers use: the
 * born-closed PUT (buildOfferOnlyPayload) and the component-22 close PATCH
 * (listing-hygiene.ts). A fixed past date; AF never sends end_at null and
 * never removes it, so no code path can reopen a listing (§18, enforced by
 * listing-hygiene-never-reopen.test.ts).
 */
export function closedEndAt(): { value: string } {
  return { value: BORN_CLOSED_END_AT };
}

export interface OfferAddInput {
  asin: string;
  productNumber: number;
  variantSuffix?: string;
  price: number;       // resolved by the price resolver (separate concern)
  // Per-unit estimated COGS — the SAME value the price resolver consumed
  // (COALESCE(estimated_cogs, cogs), §2 provenance), threaded from phase 3
  // so the cap can never drift from the number the price was built on.
  // REQUIRED (null = explicitly unknown): an omitted field silently meaning
  // "unknown" and quietly picking the tighter cap is the fail-quiet pattern
  // we're eliminating — state it, always.
  cogs: number | null;
  // NOTE: DG is NOT taken from the caller/stored column. It is derived LIVE from
  // the catalog fetch inside offerAddForAsin (generate: resurrection trail;
  // reuse: fetchDgHzLive) and passed to buildOfferOnlyPayload. This
  // keeps the DG attribute immune to stale/NULL is_dangerous_good state.
  // OPTIONAL operator override for the assembled SKU. Only applied on the
  // GENERATE path (reused SKUs ignore this). Must match the canonical
  // BRD-DEP-AS3-TTL-NNN[-X] regex AND share BRD-DEP-AS3 with the
  // resurrection-computed SKU (no brand/dept/asin swap). Server-side
  // collision checks live in the submit orchestrator (offer-add-submit.ts).
  skuOverride?: string;
  // §18 v2 (2026-10-07): the resolver's decision, threaded through so the
  // verification-ledger row records WHY this price — source, anchor offer,
  // CPT seen, resulting ROI, warning, qualified/disqualified. Optional: the
  // dry-run/preview path and tests don't supply it, and a missing decision
  // writes NULLs (= "not recorded"), never a wrong one.
  pricingDecision?: PricingDecision;
}

export interface PutListingsPayload {
  productType: string;
  requirements: "LISTING_OFFER_ONLY";
  attributes: Record<string, any>;
}

// Single discriminated union covering every per-ASIN outcome.
// Pre-PUT outcomes are reachable in BOTH dryRun and live modes.
// 'preview' is dryRun-only. 'created' / 'putlistings_failed' are live-only.
export type OfferAddResult =
  // Pre-PUT outcomes (any mode)
  | { kind: "gated";              asin: string; details: string }
  | { kind: "dead_asin";          asin: string; details: string }
  | { kind: "legend_pending";     asin: string; pending: LegendPending; details: string }
  | { kind: "duplicate_warning";  asin: string; existingSku: string; statuses: string[] }
  // NEW: any SKU listing exists for this ASIN under our sellerId in SC (any
  // status). Skip — never create a duplicate offer.
  | { kind: "already_in_catalog"; asin: string; items: PresentListing[] }
  | { kind: "resurrection_error"; asin: string; reason: string; details: string }
  // Fail-closed DG exclusion: is_dangerous_good but the catalog carries no enum-
  // valid supplier_declared_dg_hz_regulation to mirror. Needs manual selection —
  // same exclusion family as legend_pending. Never guessed ('unknown' not used).
  | { kind: "dg_value_unresolved";  asin: string; details: string }
  // Dry-run output: payload assembled, no PUT fired
  | { kind: "preview";            asin: string; sku: string; reused: boolean; payload: PutListingsPayload }
  // Live PUT outcomes
  | { kind: "created";            asin: string; sku: string; submissionId: string; warnings: ListingsIssue[] }
  | { kind: "putlistings_failed"; asin: string; sku: string; reason: OfferAddFailureReason; originalCode: string | null; originalMessage: string; retryable: boolean; rawResponse?: unknown };

export interface OfferAddDeps {
  queryFn: QueryFn;
  httpGet?: HttpGetFn;
  httpPut?: HttpPutFn;
  selfHealWrite?: ResurrectionDeps["selfHealWrite"];
  sellerId: string;
  // OPTIONAL: when provided AND dryRun=false AND generate-path, the
  // orchestrator does registry validation + reserve-then-PUT. Absent in
  // dry-run / preview / tests-that-don't-care; validation is skipped.
  productRegistry?: ProductRegistryRepo;
  // TEST SEAM (2026-09-13): override the payload builder so the pre-flight
  // quantity abort can be proven end-to-end — a poisoned payload must never
  // reach putListingsItem. Production never passes this.
  buildPayloadFn?: typeof buildOfferOnlyPayload;
}

/**
 * Per-ASIN orchestrator. dryRun is REQUIRED — no implicit default.
 *
 * In dry-run: all READ-side SP-API calls (catalog, listing status, product-type
 * definition) still happen — they're needed to assemble the preview payload.
 * NO writes: putListingsItem skipped, selfHealWrite intentionally omitted
 * from the resurrection call (so dry-run never mutates `asins` table either).
 */
export async function offerAddForAsin(
  input: OfferAddInput,
  deps: OfferAddDeps,
  dryRun: boolean,
): Promise<OfferAddResult> {
  // 1. Resurrection — figure out the SKU. In dryRun, omit selfHealWrite so
  // resurrection's catalog fetch doesn't mutate asins via COALESCE upsert.
  const resurrection: ResurrectionOutcome = await resurrectOrGenerateSku(
    input.asin,
    input.productNumber,
    {
      queryFn: deps.queryFn,
      httpGet: deps.httpGet,
      sellerId: deps.sellerId,
      selfHealWrite: dryRun ? undefined : deps.selfHealWrite,
    },
    input.variantSuffix,
  );

  // 2. Pre-PUT failure pass-throughs
  switch (resurrection.kind) {
    case "gated":
      return { kind: "gated", asin: input.asin, details: `eligibility=${resurrection.eligibilityStatus}` };
    case "dead_asin":
      return { kind: "dead_asin", asin: input.asin, details: resurrection.details };
    case "legend_pending":
      return { kind: "legend_pending", asin: input.asin, pending: resurrection.pending, details: resurrection.details };
    case "duplicate_warning":
      return { kind: "duplicate_warning", asin: input.asin, existingSku: resurrection.existingSku, statuses: resurrection.statuses };
    case "already_in_catalog":
      return { kind: "already_in_catalog", asin: input.asin, items: resurrection.items };
    case "error":
      return { kind: "resurrection_error", asin: input.asin, reason: resurrection.reason, details: resurrection.details };
  }

  // 3. resurrection.kind is now 'reuse' or 'generate' — we have an SKU
  const computedSku = resurrection.kind === "reuse" ? resurrection.sku : resurrection.sku;
  const reused = resurrection.kind === "reuse";
  // Capture the catalog's itemName for registry.reserve() — only present on
  // the generate path (reuse skips catalog fetch). Used solely for the
  // human-readable product_name column; never affects SKU assembly.
  const itemName = resurrection.kind === "generate" ? resurrection.trail.itemName : null;

  // DG for the payload — LIVE-derived, never the stored is_dangerous_good column.
  //   generate → the resurrection catalog fetch already carries it (zero extra call)
  //   reuse    → that path skips the catalog fetch, so probe live here
  // Reuse-path fetch failure (null) → default not_applicable (false): non-blocking
  // and still not sourced from the stored column. (The blanket consumer_commodity
  // VALUE for genuinely-DG items remains a separate PARKED bug — see below.)
  // DG signals — LIVE-derived, never the stored column. We need BOTH the flag
  // (for the fail-closed branch) AND the catalog's own supplier_declared_dg_hz_
  // regulation value (which the payload mirrors when enum-valid).
  //   generate → resurrection catalog fetch already carries both (zero extra call)
  //   reuse    → dedicated probe; null (fetch failed) → safe non-DG defaults
  let isDangerousGood: boolean;
  let catalogDgHz: string | null;
  if (resurrection.kind === "generate") {
    isDangerousGood = resurrection.trail.isDangerousGood;
    catalogDgHz = resurrection.trail.dgHzRegulation;
  } else {
    const live = await fetchDgHzLive(input.asin, deps.httpGet);
    isDangerousGood = live?.isDangerousGood ?? false;
    catalogDgHz = live?.dgHzRegulation ?? null;
  }

  // 3b. Apply operator SKU override (generate path only). Validates format
  // and the BRD-DEP-AS3 invariant (operator can only edit TTL and NNN, not
  // brand/dept/asin — those are derived and changing them would mismatch
  // the actual listing).
  let sku = computedSku;
  if (input.skuOverride && !reused) {
    const computedParts = computedSku.split("-");
    const overrideParts = input.skuOverride.split("-");
    const SKU_FMT = /^[A-Z0-9]{3}-[A-Z]{3}-[A-Z0-9]{3}-[A-Z]{3}-\d{3}(-[A-Z])?$/; // BRD may carry digits (§18 missing-brand manual code, 2026-08-29)
    if (!SKU_FMT.test(input.skuOverride)) {
      return {
        kind: "resurrection_error",
        asin: input.asin,
        reason: "invalid_sku_override",
        details: `SKU override doesn't match canonical format BRD-DEP-AS3-TTL-NNN[-X]: ${input.skuOverride}`,
      };
    }
    if (computedParts[0] !== overrideParts[0] || computedParts[1] !== overrideParts[1] || computedParts[2] !== overrideParts[2]) {
      return {
        kind: "resurrection_error",
        asin: input.asin,
        reason: "invalid_sku_override",
        details: `SKU override BRD-DEP-AS3 must match computed prefix '${computedParts.slice(0, 3).join("-")}'; got '${overrideParts.slice(0, 3).join("-")}'`,
      };
    }
    sku = input.skuOverride;
  }

  // 4. Spec-required: fetch product-type definition BEFORE payload assembly, and
  // extract the supplier_declared_dg_hz_regulation enum to validate against.
  // (Cached; the definitions call is also the §18 product-type tripwire — if it
  // throws we abort before wasting a putListingsItem call.)
  let dgHzEnum: string[];
  try {
    dgHzEnum = await fetchDgHzRegulationEnum(PRODUCT_TYPE, deps.sellerId, deps.httpGet);
  } catch (err: any) {
    return {
      kind: "resurrection_error",
      asin: input.asin,
      reason: "definitions_fetch_failed",
      details: err?.message ?? "getDefinitionsProductType failed",
    };
  }

  // 4b. Resolve the DG declaration value: pass through the catalog's own value
  // when enum-valid (self-healing over the presence-derivation's false
  // positives); fail closed if DG-true with no enum-valid value (no guess).
  const dgHz = resolveDgHzRegulation(catalogDgHz, isDangerousGood, dgHzEnum);
  if (dgHz.kind === "unresolved") {
    return {
      kind: "dg_value_unresolved",
      asin: input.asin,
      details: `is_dangerous_good but catalog supplier_declared_dg_hz_regulation is ${catalogDgHz == null ? "absent" : `not enum-valid ("${catalogDgHz}")`}; needs manual selection`,
    };
  }

  // 5. Assemble the payload — strictly per spec
  const payload = (deps.buildPayloadFn ?? buildOfferOnlyPayload)(input, dgHz.value);

  // 6. Dry-run gate — no PUT, no DB writes downstream
  if (dryRun) {
    return { kind: "preview", asin: input.asin, sku, reused, payload };
  }

  // 7. Registry pre-PUT validation + reservation (reserve-then-PUT pattern).
  //
  // Generate-path only (reuse path doesn't touch the registry — it's adding
  // an offer to an SKU that already represents a product the registry has
  // either seen before or doesn't care about for this listing).
  //
  // The reservation is INSERTED before the PUT so concurrent submits across
  // operators (Maria's VA + Maria) can't both claim the same (brand, NNN).
  // UNIQUE (brand_code, nnn) serializes — second writer's INSERT throws, and
  // we re-check what the winner wrote. Either way the loser REJECTS before
  // the PUT (§18, 2026-10-07): an NNN someone else just took is not ours to
  // share, whatever its TTL says.
  let reservedRowId: string | null = null;
  if (deps.productRegistry && !reused) {
    const parts = sku.split("-");
    const brd = parts[0];
    const dep = parts[1];
    const ttl = parts[3];
    const nnnStr = parts[4];
    const nnn = parseInt(nnnStr ?? "", 10);
    if (isNaN(nnn) || nnn < 1 || nnn > 999) {
      return {
        kind: "resurrection_error",
        asin: input.asin,
        reason: "invalid_sku_format",
        details: `SKU has unparseable NNN segment: ${sku}`,
      };
    }
    const existing = await deps.productRegistry.getByKey(brd, nnn);
    if (existing) {
      // §18 (2026-10-07): an existing (brand, NNN) is NEVER assigned to an
      // ASIN that does not already own it. This used to be `reuse_ok` —
      // matching TTL meant "same product, different ASIN", proceed sharing
      // the number without reserving. The inference was wrong every time in
      // practice: equal TTLs are two products that happened to derive the
      // same 3 chars. The allocator now bumps past every taken NNN, so
      // reaching here at all means something upstream handed us a number
      // that is already spoken for — a hard error, not a reuse.
      //
      // TTL is NOT consulted. The old code split this into reuse_ok (TTL
      // equal) and ttl_mismatch (TTL differs); both are the same fact — the
      // number belongs to another ASIN — and comparing TTLs to decide was
      // itself the forbidden (brand, TTL) -> NNN lookup.
      return {
        kind: "resurrection_error",
        asin: input.asin,
        reason: "nnn_taken",
        details: `NNN ${nnn} in brand ${brd} already belongs to ${existing.firstAsin ?? "another ASIN"} (${existing.productName ?? "unnamed product"}, TTL '${existing.ttl}'). Every new ASIN gets its own product number; NNN is never shared.`,
      };
    } else {
      try {
        const r = await deps.productRegistry.reserve({
          brandCode: brd,
          nnn,
          ttl,
          deptCode: dep,
          productName: itemName,
          firstAsin: input.asin,
        });
        reservedRowId = r.id;
      } catch (err: any) {
        // UNIQUE conflict (concurrent writer) is the expected throw. Re-check
        // the current row state and route accordingly.
        const post = await deps.productRegistry.getByKey(brd, nnn).catch(() => null);
        if (post) {
          // §18 (2026-10-07): a concurrent writer winning this (brand, NNN)
          // is a hard error whether or not its TTL matches ours. The
          // same-TTL arm used to proceed on the winner's row — that is the
          // reuse_ok rule under a different name, and the same wrong
          // inference. Losing the race means our number is gone; the
          // operator re-previews and the allocator hands out the next free
          // one.
          return {
            kind: "resurrection_error",
            asin: input.asin,
            reason: "nnn_taken",
            details: `Concurrent reservation: NNN ${nnn} in brand ${brd} was just registered by another submit (TTL '${post.ttl}', ASIN ${post.firstAsin ?? "unknown"}); submitted '${ttl}'. Re-preview to get the next free number.`,
          };
        } else {
          return {
            kind: "resurrection_error",
            asin: input.asin,
            reason: "registry_reserve_failed",
            details: `Failed to reserve product (brand=${brd}, nnn=${nnn}): ${err?.message ?? "unknown"}`,
          };
        }
      }
    }
  }

  // 8. Live PUT → mapper → typed outcome.
  //
  // The try/finally below is THE commit/rollback gate for the registry
  // reservation. `committed` is set to true ONLY when the PUT mapper reports
  // ok=true. Any other path (PUT returns failure, mapper rejects, PUT throws
  // network error) leaves `committed = false` and the finally rolls back.
  // Rollback failure is caught + logged so it can't mask the original error.
  let committed = false;
  try {
    // PRE-FLIGHT ABORT (2026-09-13): the payload is physically blocked at
    // fire time if it carries the fulfillment quantity key. Test-time
    // checking isn't enough for an irreversible live write. Inside the try
    // on purpose — the finally rolls the registry reservation back.
    const forbidden = findForbiddenQuantityPaths(payload);
    if (forbidden.length > 0) {
      throw new Error(
        `Offer-add aborted before PUT: payload contains the fulfillment quantity key at ${forbidden.join(", ")} — ` +
        `this would flip ${sku} to merchant-fulfilled. No listing was created.`,
      );
    }
    const callResult = await putListingsItem(
      { sellerId: deps.sellerId, sku, productType: PRODUCT_TYPE, attributes: payload.attributes, requirements: "LISTING_OFFER_ONLY" },
      deps.httpPut,
    );
    const outcome = mapPutListingsResponse(callResult);

    if (outcome.ok) {
      committed = true; // MUST be set before return so finally sees it

      // Promote this SKU to primary and record it in asin_skus. It now carries
      // the live SC offer, so it IS the lead SKU for the ASIN — runs for BOTH
      // the generate path (new row) and the resurrection-reuse path (existing
      // row flipped back to primary). This also keeps the NNN allocator aware
      // of submitted-but-not-yet-inventory-synced SKUs: before any asin_skus
      // write existed, the allocator was blind to them and silently reassigned
      // their NNNs to new ASINs in later batches.
      //
      // One atomic statement (data-modifying CTEs) so asin_skus.is_primary and
      // asins.primary_sku can NEVER disagree:
      //   promote — upsert this SKU as is_primary=true (INSERT for generate;
      //             flip an existing/resurrected row via ON CONFLICT),
      //   demote  — set is_primary=false on every OTHER SKU for the ASIN,
      //   then update asins.primary_sku to this SKU.
      // promote and demote touch disjoint rows (target vs. sku <> $2), so the
      // two CTEs never modify the same tuple.
      //
      // The live-offer SKU is authoritative for primary. inventory-sync's
      // fulfillable-count heuristic is bootstrap-only (sets primary only when
      // none exists) and must never overwrite this — see inventory-sync.ts.
      //
      // Best-effort with loud logging: a DB failure here leaves a live SC
      // listing whose local primary wasn't promoted (the registry row is
      // committed and the SKU at SC is real). It must NOT roll back the live
      // listing — inventory-sync reconciles asin_skus on its next run.
      try {
        await deps.queryFn(
          `WITH tgt AS (
             SELECT id FROM asins WHERE asin = $1
           ),
           promote AS (
             INSERT INTO asin_skus (asin_id, sku, is_primary)
             SELECT id, $2, true FROM tgt
             ON CONFLICT (asin_id, sku) DO UPDATE SET is_primary = true
           ),
           demote AS (
             UPDATE asin_skus SET is_primary = false
             WHERE asin_id = (SELECT id FROM tgt) AND sku <> $2
           )
           UPDATE asins SET primary_sku = $2 WHERE asin = $1`,
          [input.asin, sku],
        );
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error(
          `[offer-add] CRITICAL: failed to promote primary SKU for asin=${input.asin} sku=${sku} ` +
          `(listing IS live at SC; registry row is committed; local primary_sku/is_primary not ` +
          `updated until inventory-sync reconciles): ${err?.message ?? err}`,
        );
      }

      // ACCEPTED WRITES NOTHING TO has_live_offer (§18 Writers, 2026-10-10).
      //
      // The 2026-09-21 "PENDING half" wrote has_live_offer = TRUE here, so
      // the catalog icon would flip on the submit response rather than show
      // "+" for the minutes Amazon takes to materialize. The UX concern was
      // real and is unchanged — but the flag answers "does SC have a
      // listing", and at this moment SC does not. Writing it here made the
      // flag mean "listed OR submitted", and nothing reading it could tell
      // which; that ambiguity is what let a bad probe silently overturn a
      // verdict-written value (B07J2WWWD4).
      //
      // The icon still flips immediately: it reads PENDINGNESS from the
      // ledger row created just below, which exists the instant this submit
      // lands (§6 Catalog icon). Same feedback, honest source. The
      // T+1/3/10/30/60m ladder is the first writer of the flag again (§19).

      // Record the fire in the verification ledger. ACCEPTED ≠ live — this row
      // starts 'pending' and only the Verify sweep resolves it. Best-effort:
      // a ledger-write failure must never mask a real SC submission.
      try {
        await recordSubmission(
          {
            asin: input.asin, sku, submissionId: outcome.submissionId ?? null,
            submittedPrice: input.price ?? null,
            pricing: input.pricingDecision,
          },
          deps.queryFn as any,
        );
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error(`[offer-add] failed to record listing_submissions for ${input.asin}/${sku}: ${err?.message ?? err}`);
      }

      return { kind: "created", asin: input.asin, sku, submissionId: outcome.submissionId, warnings: outcome.warnings };
    }

    // catalog_deleted from putListingsItem → fire the shared helper (same as DA-2).
    if (outcome.reason === "catalog_deleted") {
      await applyCatalogDeletedSignal(input.asin, true).catch(() => {});
    }

    // Gated and all other failures: NO side-effect writes. Reason surfaced as-is.
    // Reservation rolls back via finally (committed stays false).
    return {
      kind: "putlistings_failed",
      asin: input.asin,
      sku,
      reason: outcome.reason,
      originalCode: outcome.originalCode,
      originalMessage: outcome.originalMessage,
      retryable: outcome.retryable,
      rawResponse: outcome.rawResponse,
    };
  } finally {
    if (reservedRowId && !committed && deps.productRegistry) {
      // Best-effort rollback. Failures here are logged but do NOT mask the
      // original return value or exception — that's the original failure
      // the caller cares about. A stranded row will be cleaned up manually
      // if rollback fails AND its product never re-registers.
      await deps.productRegistry.rollback(reservedRowId).catch(() => {
        // Intentionally swallowed; caller's error/return path takes priority.
        // Production wiring routes a log line via the surrounding orchestrator.
      });
    }
  }
}

// ============================================================================
// Payload assembly — strictly per spec
//
// CRITICAL guarantees enforced by buildOfferOnlyPayload + tested explicitly:
//   - merchant_suggested_asin is present (else Amazon creates a NEW listing)
//   - fulfillment_channel_code is FBA (AMAZON_NA — see TODO below)
//   - NO fulfillment quantity key: the exact key "quantity" at ANY depth
//     (fulfillment_availability[].quantity flips the SKU to merchant-
//     fulfilled). max_order_quantity is a DIFFERENT attribute and IS sent.
//     Enforced by findForbiddenQuantityPaths in tests AND as a pre-flight
//     abort immediately before the live PUT.
//   - condition_type=new_new, batteries_required default No, DG/HZ defaults
// ============================================================================

// TODO: AMAZON_NA is the documented FBA channel for North America in the
// 2021-08-01 listings API. Community reports flag occasional drift (DEFAULT
// vs AMAZON_NA) by product type. The fetched product-type schema can be used
// to validate this in a follow-up; for now we ship AMAZON_NA and let the
// mapper catch any rejection.
const FBA_CHANNEL_CODE = "AMAZON_NA";

function attr(value: any, extra: Record<string, any> = {}): any {
  return [{ value, marketplace_id: MARKETPLACE, ...extra }];
}

// §18 Max Order Quantity (2026-09-13) — per-ORDER purchase cap, COGS-conditional:
//   COGS <= $20   → 6   (boundary INCLUSIVE: 20.00 → 6, 20.01 → 4)
//   COGS >  $20   → 4   (tighter cap on higher per-unit exposure)
//   COGS unknown  → 4   (conservative — unknown exposure gets the tight cap)
// Schema (verified live against the PRODUCT productType definition,
// 2026-09-13): top-level `max_order_quantity`, array, selector
// marketplace_id, items {value: integer >= 1} — exactly the shape attr()
// emits. This is NOT a fulfillment quantity and never touches FBA
// inventory ownership; see findForbiddenQuantityPaths for the key that does.
export const MAX_ORDER_QTY_COGS_THRESHOLD = 20;

export function resolveMaxOrderQuantity(cogs: number | null | undefined): number {
  if (cogs == null || !isFinite(cogs)) return 4;
  return cogs <= MAX_ORDER_QTY_COGS_THRESHOLD ? 6 : 4;
}

// The ONE forbidden key: `quantity` (exact, any depth). On
// fulfillment_availability it is "your current inventory commitment" and
// flips the SKU to merchant-fulfilled — irreversible in effect and invisible
// until the offer misbehaves. Walks KEYS rather than the serialized blob, so
// max_order_quantity (a different key) passes while the real key is caught
// wherever it appears. Returns the offending paths; empty array = clean.
export function findForbiddenQuantityPaths(node: any, path = "$"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => findForbiddenQuantityPaths(v, `${path}[${i}]`));
  }
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) =>
      k.toLowerCase() === "quantity"
        ? [`${path}.${k}`]
        : findForbiddenQuantityPaths(v, `${path}.${k}`));
  }
  return [];
}

export function buildOfferOnlyPayload(input: OfferAddInput, dgHzRegulationValue: string): PutListingsPayload {
  const attributes: Record<string, any> = {
    // ASIN attaches the offer to an EXISTING listing (offer-only matching).
    // Without this, Amazon would create a NEW listing (duplicate ASIN).
    merchant_suggested_asin: attr(input.asin),

    condition_type: attr("new_new"),

    // Per-ORDER purchase cap (§18, 2026-09-13) — 6 at COGS <= $20, else 4,
    // 4 when COGS is unknown. NOT a fulfillment quantity.
    max_order_quantity: attr(resolveMaxOrderQuantity(input.cogs)),

    // Always-present per spec (not category-specific):
    batteries_required: attr(false), // TODO per-ASIN battery flag if needed
    // Value is resolved upstream by resolveDgHzRegulation and passed in verbatim
    // — it mirrors the catalog's own supplier_declared_dg_hz_regulation and is
    // enum-validated before we get here. (FIXED: the old `consumer_commodity`
    // constant was enum-INVALID for every product type — the enum is
    // {ghs, not_applicable, other, storage, transportation, unknown, waste} — and
    // the hazmat array was never the source. Amazon's own catalog attribute is.)
    supplier_declared_dg_hz_regulation: attr(dgHzRegulationValue),

    // Price + FBA fulfillment. Critically OMITS quantity (FBA-owned).
    // BORN CLOSED (§18): end_at in the past soft-closes the offer at creation
    // — SC's "Close listing" is literally this field. Verified live 2026-08-01
    // and -02 (accepted at create, persists through async processing, listing
    // settles DISCOVERABLE-not-BUYABLE, §19 verifies live). Reopening is done
    // in Seller Central directly by the user.
    purchasable_offer: [
      {
        marketplace_id: MARKETPLACE,
        currency: "USD",
        our_price: [{ schedule: [{ value_with_tax: input.price }] }],
        end_at: closedEndAt(),
      },
    ],
    fulfillment_availability: [
      {
        fulfillment_channel_code: FBA_CHANNEL_CODE,
        // NO quantity field — FBA quantity is owned by Amazon. Adding any
        // quantity value (including 0) flips the SKU to merchant-fulfilled.
      },
    ],
  };

  return {
    productType: PRODUCT_TYPE,
    requirements: "LISTING_OFFER_ONLY",
    attributes,
  };
}

// ============================================================================
// Pre-filter helper — cheap UX gate before any API call.
// AUTHORITY is still the API response; this is just a "don't waste a call
// on an ASIN we already know is excluded" optimization.
// ============================================================================

export interface PreFilterRow {
  asin: string;
  is_catalog_deleted: boolean;
  eligibility_status: string | null;
}

export interface PreFilterResult {
  submittable: string[];     // ASINs passing all filters
  excluded: Array<{ asin: string; reason: "catalog_deleted" | "gated" | "not_checked" }>;
}

/**
 * Filter a candidate ASIN set against the locally-known catalog-deleted and
 * gated state. Pre-PUT optimization — the API response still has final say
 * for any ASIN that passes.
 *
 * Eligibility predicate matches the resurrection orchestrator: anything not
 * 'yes' (including NULL = 'not_checked') is excluded.
 */
export function preFilterSubmitSet(rows: PreFilterRow[]): PreFilterResult {
  const submittable: string[] = [];
  const excluded: PreFilterResult["excluded"] = [];
  for (const r of rows) {
    if (r.is_catalog_deleted) {
      excluded.push({ asin: r.asin, reason: "catalog_deleted" });
      continue;
    }
    if (r.eligibility_status !== "yes") {
      excluded.push({
        asin: r.asin,
        reason: r.eligibility_status == null ? "not_checked" : "gated",
      });
      continue;
    }
    submittable.push(r.asin);
  }
  return { submittable, excluded };
}
