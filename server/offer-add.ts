// Per-ASIN offer-add orchestrator.
//
// Flow:
//   1. Resurrection — read prior SKUs, decide reuse/generate/duplicate/gated/etc.
//   2. If pre-PUT failure (gated, dead, legend_pending, error) → return early.
//   3. If duplicate_warning → return as preview gate (UI prompts; DA-4 doesn't auto-resolve).
//   4. If reuse/generate → fetch product-type definition (spec-required first step).
//   5. Assemble putListingsItem payload (FBA, NO quantity key, always-present attrs).
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
import { fetchProductTypeDefinition } from "./listings-definitions";
import { putListingsItem, type HttpPutFn } from "./listings-write";
import { mapPutListingsResponse, type OfferAddFailureReason, type ListingsIssue } from "./listings-error-map";
import { applyCatalogDeletedSignal } from "./catalog-deleted-write";
import type { QueryFn } from "@shared/sku-legend";
import { fetchDangerousGoodLive, type HttpGetFn } from "./sku-catalog-fetch";
import { recordSubmission } from "./listing-submissions-repo";

const MARKETPLACE = "ATVPDKIKX0DER";
const PRODUCT_TYPE = "PRODUCT"; // offer-only matching uses the generic PRODUCT type

export interface OfferAddInput {
  asin: string;
  productNumber: number;
  variantSuffix?: string;
  price: number;       // resolved by the price resolver (separate concern)
  // NOTE: DG is NOT taken from the caller/stored column. It is derived LIVE from
  // the catalog fetch inside offerAddForAsin (generate: resurrection trail;
  // reuse: fetchDangerousGoodLive) and passed to buildOfferOnlyPayload. This
  // keeps the DG attribute immune to stale/NULL is_dangerous_good state.
  // OPTIONAL operator override for the assembled SKU. Only applied on the
  // GENERATE path (reused SKUs ignore this). Must match the canonical
  // BRD-DEP-AS3-TTL-NNN[-X] regex AND share BRD-DEP-AS3 with the
  // resurrection-computed SKU (no brand/dept/asin swap). Server-side
  // collision checks live in the submit orchestrator (offer-add-submit.ts).
  skuOverride?: string;
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
  const isDangerousGood =
    resurrection.kind === "generate"
      ? resurrection.trail.isDangerousGood
      : ((await fetchDangerousGoodLive(input.asin, deps.httpGet)) ?? false);

  // 3b. Apply operator SKU override (generate path only). Validates format
  // and the BRD-DEP-AS3 invariant (operator can only edit TTL and NNN, not
  // brand/dept/asin — those are derived and changing them would mismatch
  // the actual listing).
  let sku = computedSku;
  if (input.skuOverride && !reused) {
    const computedParts = computedSku.split("-");
    const overrideParts = input.skuOverride.split("-");
    const SKU_FMT = /^[A-Z]{3}-[A-Z]{3}-[A-Z0-9]{3}-[A-Z]{3}-\d{3}(-[A-Z])?$/;
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

  // 4. Spec-required: fetch product-type definition BEFORE payload assembly.
  // (Cached per session; doesn't add cost on a multi-ASIN batch.) Today this
  // is mostly a validation tripwire — if it throws, we abort with a clear
  // diagnostic before wasting a putListingsItem call on a malformed payload.
  try {
    await fetchProductTypeDefinition(PRODUCT_TYPE, deps.sellerId, deps.httpGet);
  } catch (err: any) {
    return {
      kind: "resurrection_error",
      asin: input.asin,
      reason: "definitions_fetch_failed",
      details: err?.message ?? "getDefinitionsProductType failed",
    };
  }

  // 5. Assemble the payload — strictly per spec
  const payload = buildOfferOnlyPayload(input, isDangerousGood);

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
  // UNIQUE (brand_code, nnn) serializes — second writer's INSERT throws,
  // and we re-check what the winner wrote (matching TTL → reuse, mismatched
  // TTL → ttl_mismatch reject before PUT).
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
      if (existing.ttl !== ttl) {
        return {
          kind: "resurrection_error",
          asin: input.asin,
          reason: "ttl_mismatch",
          details: `NNN ${nnn} in brand ${brd} is bound to TTL '${existing.ttl}' (${existing.productName ?? "unnamed product"}); submitted SKU uses '${ttl}'. The product's TTL is fixed by the first ASIN that registered it.`,
        };
      }
      // reuse_ok — proceed without reserving (no row to roll back)
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
        if (post && post.ttl === ttl) {
          // A concurrent writer reserved the same product (same TTL) — fine,
          // their row stays, we proceed without our own reservation.
        } else if (post && post.ttl !== ttl) {
          return {
            kind: "resurrection_error",
            asin: input.asin,
            reason: "ttl_mismatch",
            details: `Concurrent reservation: NNN ${nnn} in brand ${brd} was just registered with TTL '${post.ttl}' by another submit; submitted '${ttl}'.`,
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
    const callResult = await putListingsItem(
      { sellerId: deps.sellerId, sku, productType: PRODUCT_TYPE, attributes: payload.attributes, requirements: "LISTING_OFFER_ONLY" },
      deps.httpPut,
    );
    const outcome = mapPutListingsResponse(callResult);

    if (outcome.ok) {
      committed = true; // MUST be set before return so finally sees it

      // Write the live SKU into asin_skus so the NNN allocator sees it on the
      // NEXT batch's max+1 computation (in-batch sequencing is already handled
      // by assignNnns's cursor). Before this write existed, the allocator was
      // blind to submitted-but-not-yet-inventory-synced SKUs and silently
      // reassigned their NNNs to new ASINs in subsequent batches.
      //
      // ON CONFLICT semantics mirror inventory-sync.ts:131 exactly — a later
      // inventory-sync re-observing this same SKU is an idempotent no-op
      // (well, a NO-OP UPDATE on is_primary).
      //
      // is_primary=false at submit time: SKU has zero fulfillable inventory
      // until physical units arrive. inventory-sync's later poll determines
      // primary by fulfillable count and UPDATEs accordingly.
      //
      // Generate-path only: reuse path means the SKU was already in
      // asin_skus (that's how resurrection found it as a candidate).
      //
      // Best-effort with loud logging: a DB failure here leaves a live SC
      // listing without local asin_skus tracking. The registry row is intact
      // and the SKU at SC is real; inventory-sync will reconcile asin_skus
      // on its next run. Until then, allocator could collide for this bucket
      // on a same-day second batch — log loudly so it's visible.
      if (!reused) {
        try {
          await deps.queryFn(
            `INSERT INTO asin_skus (asin_id, sku, is_primary)
                  SELECT id, $2, false FROM asins WHERE asin = $1
             ON CONFLICT (asin_id, sku) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
            [input.asin, sku],
          );
        } catch (err: any) {
          // eslint-disable-next-line no-console
          console.error(
            `[offer-add] CRITICAL: failed to write asin_skus for asin=${input.asin} sku=${sku} ` +
            `(listing IS live at SC; registry row is committed; allocator may collide on next ` +
            `batch in this bucket until inventory-sync runs): ${err?.message ?? err}`,
          );
        }
      }

      // Record the fire in the verification ledger. ACCEPTED ≠ live — this row
      // starts 'pending' and only the Verify sweep resolves it. Best-effort:
      // a ledger-write failure must never mask a real SC submission.
      try {
        await recordSubmission(
          { asin: input.asin, sku, submissionId: outcome.submissionId ?? null, submittedPrice: input.price ?? null },
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
//   - NO quantity key anywhere (would flip SKU to merchant-fulfilled)
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

export function buildOfferOnlyPayload(input: OfferAddInput, isDangerousGood: boolean): PutListingsPayload {
  const attributes: Record<string, any> = {
    // ASIN attaches the offer to an EXISTING listing (offer-only matching).
    // Without this, Amazon would create a NEW listing (duplicate ASIN).
    merchant_suggested_asin: attr(input.asin),

    condition_type: attr("new_new"),

    // Always-present per spec (not category-specific):
    batteries_required: attr(false), // TODO per-ASIN battery flag if needed
    supplier_declared_dg_hz_regulation: attr(
      // Gated on LIVE-derived is_dangerous_good (attributes.hazmat present), NOT
      // the old is_hazmat. Non-DG → not_applicable (the fix: the 3 grocery ASINs
      // stop sending consumer_commodity and no longer hit invalid_attribute).
      //
      // PARKED BUG (unchanged here, per plan): the consumer_commodity VALUE is a
      // blanket placeholder for genuinely-DG items — real DG needs a per-product
      // -type value (ltd_qty / storage_class_* / consumer_commodity) derived from
      // getDefinitionsProductType. Tracked separately; do NOT fix in this change.
      isDangerousGood ? "consumer_commodity" : "not_applicable",
    ),

    // Price + FBA fulfillment. Critically OMITS quantity (FBA-owned).
    purchasable_offer: [
      {
        marketplace_id: MARKETPLACE,
        currency: "USD",
        our_price: [{ schedule: [{ value_with_tax: input.price }] }],
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
