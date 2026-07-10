// Tests for the live submit orchestrator.
//
// Mock approach: inject offerAddFn + fetchOffersFn so we never touch the
// network. queryFn / selfHealWrite aren't reached because mocked offerAddFn
// doesn't use them.

import { describe, it, expect } from "vitest";
import { submitOfferAddBatch, type SubmitAsinRow, type SubmitDeps } from "./offer-add-submit";
import { settingsSchema, type Settings } from "@shared/schema";
import type { OfferAddResult, OfferAddInput, OfferAddDeps } from "./offer-add";
import type { OffersFetchOutcome } from "./listings-offers-fetch";

const SETTINGS: Settings = settingsSchema.parse({});

// ============================================================================
// Helpers
// ============================================================================

function makeRow(asin: string, overrides: Partial<SubmitAsinRow> = {}): SubmitAsinRow {
  return {
    asin,
    is_catalog_deleted: false,
    eligibility_status: "yes",
    is_hazmat: false,
    cogs: 5.00,
    fbaFee: 3.50,
    referralFee: 1.50,
    feesEstimatePrice: 20.00,
    weightLbs: 1.0,
    category: "Health & Household",
    prepCost: 1.00,
    storageCost: 0.10,
    ...overrides,
  };
}

function makeDeps(
  offerAddFn: SubmitDeps["offerAddFn"],
  fetchOffersFn: SubmitDeps["fetchOffersFn"],
  allExistingSkus: string[] = [],
): SubmitDeps {
  return {
    queryFn: async () => ({ rows: [] }) as any,
    sellerId: "SELLERTEST",
    settings: SETTINGS,
    includeInboundShipping: true,
    allExistingSkus,
    offerAddFn,
    fetchOffersFn,
    pacingMs: 0, // disable 2200ms pacing in tests
  };
}

// Standard "ready" preview outcome — generates a valid current-format SKU.
function previewOutcome(asin: string, brd: string, dep: string, reused = false): OfferAddResult {
  return {
    kind: "preview",
    asin,
    sku: `${brd}-${dep}-AB1-PRD-001${reused ? "-A" : ""}`, // matches current format
    reused,
    payload: { productType: "PRODUCT", requirements: "LISTING_OFFER_ONLY", attributes: {} },
  };
}

function createdOutcome(asin: string, sku: string): OfferAddResult {
  return { kind: "created", asin, sku, submissionId: "SUB-" + asin, warnings: [] };
}

// ============================================================================
// Pre-filter
// ============================================================================

describe("submitOfferAddBatch — pre-filter", () => {
  it("skips catalog_deleted ASINs without calling offerAddFn", async () => {
    const calls: string[] = [];
    const offerAddFn = async (input: OfferAddInput) => {
      calls.push(input.asin);
      return previewOutcome(input.asin, "AMG", "HEA");
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const rows = [makeRow("B0000001", { is_catalog_deleted: true })];
    const r = await submitOfferAddBatch(rows, makeDeps(offerAddFn, fetchOffersFn));
    expect(calls).toEqual([]); // never called offerAddFn for excluded ASIN
    expect(r.perAsin[0].outcome.kind).toBe("skipped");
    if (r.perAsin[0].outcome.kind === "skipped") {
      expect(r.perAsin[0].outcome.reason).toBe("catalog_deleted");
    }
    expect(r.preFilter.excluded).toHaveLength(1);
  });

  it("skips gated ASINs (eligibility_status != 'yes')", async () => {
    const offerAddFn = async () => ({ kind: "preview" } as any);
    const fetchOffersFn = async () => ({ ok: true } as any);
    const rows = [
      makeRow("B0000001", { eligibility_status: "no" }),
      makeRow("B0000002", { eligibility_status: null }), // not_checked
    ];
    const r = await submitOfferAddBatch(rows, makeDeps(offerAddFn, fetchOffersFn));
    expect(r.perAsin[0].outcome.kind).toBe("skipped");
    expect(r.perAsin[1].outcome.kind).toBe("skipped");
    if (r.perAsin[0].outcome.kind === "skipped") expect(r.perAsin[0].outcome.reason).toBe("gated");
    if (r.perAsin[1].outcome.kind === "skipped") expect(r.perAsin[1].outcome.reason).toBe("not_checked");
  });
});

// ============================================================================
// Phase 1: classification pass-through
// ============================================================================

describe("submitOfferAddBatch — phase 1 (classification)", () => {
  it("passes blocked outcomes (legend_pending, gated, etc) straight through as skips", async () => {
    let i = 0;
    const outcomes: OfferAddResult[] = [
      { kind: "legend_pending", asin: "B0000001", pending: { brand: null, dept: null } as any, details: "brand X" },
      { kind: "dead_asin", asin: "B0000002", details: "asin missing in catalog" },
      { kind: "duplicate_warning", asin: "B0000003", existingSku: "OLD-SKU", statuses: ["Active"] },
      { kind: "resurrection_error", asin: "B0000004", reason: "weird", details: "boom" },
    ];
    const offerAddFn = async () => outcomes[i++];
    const fetchOffersFn = async () => ({ ok: true } as any);
    const rows = outcomes.map((o) => makeRow(o.asin));
    const r = await submitOfferAddBatch(rows, makeDeps(offerAddFn, fetchOffersFn));
    expect(r.perAsin.map((p) => p.outcome.kind)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    const reasons = r.perAsin.map((p) => p.outcome.kind === "skipped" ? p.outcome.reason : "");
    expect(reasons).toEqual(["legend_pending", "dead_asin", "duplicate_warning", "resurrection_error"]);
    expect(r.notes.submittedCount).toBe(0);
    expect(r.notes.skippedCount).toBe(4);
  });

  it("phase 1 produces preview → phase 4 fires live PUT", async () => {
    const calls: { dryRun: boolean; productNumber: number; price: number }[] = [];
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean) => {
      calls.push({ dryRun, productNumber: input.productNumber, price: input.price });
      if (dryRun) return previewOutcome(input.asin, "AMG", "HEA");
      return createdOutcome(input.asin, "AMG-HEA-AB1-PRD-001");
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [10.00], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const r = await submitOfferAddBatch([makeRow("B0000001")], makeDeps(offerAddFn, fetchOffersFn));
    expect(calls).toHaveLength(2); // 1 dry-run, 1 live
    expect(calls[0].dryRun).toBe(true);
    expect(calls[1].dryRun).toBe(false);
    expect(calls[1].price).toBeGreaterThan(0); // real resolved price (not 0 placeholder)
    expect(r.perAsin[0].outcome.kind).toBe("created");
  });
});

// ============================================================================
// Phase 2: NNN allocation
// ============================================================================

describe("submitOfferAddBatch — phase 2 (NNN allocation)", () => {
  it("batch-sequential NNNs: 3 GENERATE ASINs in same bucket → 1, 2, 3", async () => {
    const livePutCalls: number[] = [];
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean) => {
      if (dryRun) return previewOutcome(input.asin, "AMG", "HEA");
      livePutCalls.push(input.productNumber);
      return createdOutcome(input.asin, `AMG-HEA-AB1-PRD-${String(input.productNumber).padStart(3, "0")}`);
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [10.00], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const rows = [makeRow("B0000001"), makeRow("B0000002"), makeRow("B0000003")];
    const r = await submitOfferAddBatch(rows, makeDeps(offerAddFn, fetchOffersFn));
    expect(livePutCalls).toEqual([1, 2, 3]); // sequential within batch
    expect(r.notes.submittedCount).toBe(3);
  });

  it("respects existing max-NNN from allExistingSkus", async () => {
    const livePutCalls: number[] = [];
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean) => {
      if (dryRun) return previewOutcome(input.asin, "AMG", "HEA");
      livePutCalls.push(input.productNumber);
      return createdOutcome(input.asin, "AMG-HEA-AB1-PRD-XXX");
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [10.00], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const rows = [makeRow("B0000001"), makeRow("B0000002")];
    const deps = makeDeps(offerAddFn, fetchOffersFn, [
      "AMG-HEA-XY1-OLD-042",  // existing NNN=42 in AMG-HEA bucket
      "AMG-HEA-XY2-OLD-007",  // existing NNN=7
    ]);
    await submitOfferAddBatch(rows, deps);
    expect(livePutCalls).toEqual([43, 44]); // continues from max=42
  });

  it("NNN overflow at 999 → skipped, others in same batch unaffected", async () => {
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean) => {
      if (dryRun) {
        // Asin 1+2 in bucket AMG-HEA (will overflow); asin 3 in different bucket OTH-DEP
        if (input.asin === "B0000003") return previewOutcome(input.asin, "OTH", "DEP");
        return previewOutcome(input.asin, "AMG", "HEA");
      }
      return createdOutcome(input.asin, "X");
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [10.00], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const rows = [makeRow("B0000001"), makeRow("B0000002"), makeRow("B0000003")];
    // Existing 999 in AMG-HEA bucket — first 2 ASINs hit overflow
    const deps = makeDeps(offerAddFn, fetchOffersFn, ["AMG-HEA-XY1-OLD-999"]);
    const r = await submitOfferAddBatch(rows, deps);
    expect(r.perAsin[0].outcome.kind).toBe("skipped");
    if (r.perAsin[0].outcome.kind === "skipped") expect(r.perAsin[0].outcome.reason).toBe("nnn_overflow");
    expect(r.perAsin[1].outcome.kind).toBe("skipped");
    if (r.perAsin[1].outcome.kind === "skipped") expect(r.perAsin[1].outcome.reason).toBe("nnn_overflow");
    expect(r.perAsin[2].outcome.kind).toBe("created"); // different bucket — fine
  });

  it("REUSE-path ASINs bypass allocator (no NNN assignment, existing SKU used as-is)", async () => {
    const livePutSkus: string[] = [];
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean) => {
      if (dryRun) return previewOutcome(input.asin, "AMG", "HEA", /* reused */ true);
      livePutSkus.push(`reuse-call:NNN=${input.productNumber}`);
      return createdOutcome(input.asin, "AMG-HEA-AB1-PRD-001-A"); // arbitrary
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [10.00], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const r = await submitOfferAddBatch([makeRow("B0000001")], makeDeps(offerAddFn, fetchOffersFn));
    // Reuse path: phase 4 still calls offerAddForAsin (which uses the existing SKU);
    // productNumber passed is the placeholder 1 (ignored downstream because resurrection
    // returns 'reuse' kind, which doesn't regenerate).
    expect(r.perAsin[0].outcome.kind).toBe("created");
    expect(livePutSkus).toEqual(["reuse-call:NNN=1"]); // placeholder
  });
});

// ============================================================================
// Phase 3: price resolution
// ============================================================================

describe("submitOfferAddBatch — phase 3 (price resolution)", () => {
  it("Rule 1 applies when competing offers exist; price feeds phase 4", async () => {
    let phase4Price: number | null = null;
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean) => {
      if (dryRun) return previewOutcome(input.asin, "AMG", "HEA");
      phase4Price = input.price;
      return createdOutcome(input.asin, "AMG-HEA-AB1-PRD-001");
    };
    const fetchOffersFn = async () => ({
      ok: true,
      competingOffers: [10.00], // highest * 1.30 = 13.00 → ceiled to 13.99
      ourOffer: null,
      allOffers: [],
    } as OffersFetchOutcome);
    const r = await submitOfferAddBatch([makeRow("B0000001")], makeDeps(offerAddFn, fetchOffersFn));
    expect(r.perAsin[0].outcome.kind).toBe("created");
    expect(phase4Price).toBe(13.99);
    if (r.perAsin[0].outcome.kind === "created") {
      expect(r.perAsin[0].outcome.priceRule).toBe("highest_plus_30");
      expect(r.perAsin[0].outcome.resolvedPrice).toBe(13.99);
    }
  });

  it("offers fetch_failed → skipped with reason=offers_fetch_failed (does NOT submit at $0)", async () => {
    let phase4Called = false;
    const offerAddFn = async (_input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean) => {
      if (dryRun) return previewOutcome("B0000001", "AMG", "HEA");
      phase4Called = true;
      return createdOutcome("B0000001", "X");
    };
    const fetchOffersFn = async () => ({
      ok: false,
      reason: "transient_error",
      status: 429,
      message: "throttled",
    } as OffersFetchOutcome);
    const r = await submitOfferAddBatch([makeRow("B0000001")], makeDeps(offerAddFn, fetchOffersFn));
    expect(phase4Called).toBe(false); // critical: never submitted at unknown price
    expect(r.perAsin[0].outcome.kind).toBe("skipped");
    if (r.perAsin[0].outcome.kind === "skipped") {
      expect(r.perAsin[0].outcome.reason).toBe("offers_fetch_failed");
    }
  });

  it("Rule 2 + cogs missing → needs_cogs skip", async () => {
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean) => {
      if (dryRun) return previewOutcome(input.asin, "AMG", "HEA");
      return createdOutcome(input.asin, "X");
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const r = await submitOfferAddBatch(
      [makeRow("B0000001", { cogs: null })],
      makeDeps(offerAddFn, fetchOffersFn),
    );
    expect(r.perAsin[0].outcome.kind).toBe("skipped");
    if (r.perAsin[0].outcome.kind === "skipped") {
      expect(r.perAsin[0].outcome.reason).toBe("needs_cogs");
    }
  });
});

// ============================================================================
// Phase 4: live submit + putlistings failures
// ============================================================================

describe("submitOfferAddBatch — phase 4 (live submit)", () => {
  it("putlistings_failed surfaces as outcome with reason", async () => {
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean): Promise<OfferAddResult> => {
      if (dryRun) return previewOutcome(input.asin, "AMG", "HEA");
      return {
        kind: "putlistings_failed",
        asin: input.asin,
        sku: "AMG-HEA-AB1-PRD-001",
        reason: "gated",
        originalCode: "INVALID_LISTINGS_OPERATION",
        originalMessage: "You are not approved",
        retryable: false,
      };
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [10.00], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const r = await submitOfferAddBatch([makeRow("B0000001")], makeDeps(offerAddFn, fetchOffersFn));
    expect(r.perAsin[0].outcome.kind).toBe("putlistings_failed");
    if (r.perAsin[0].outcome.kind === "putlistings_failed") {
      expect(r.perAsin[0].outcome.reason).toBe("gated");
      expect(r.perAsin[0].outcome.resolvedPrice).toBe(13.99);
    }
    expect(r.notes.failedCount).toBe(1);
    expect(r.notes.submittedCount).toBe(0);
  });

  it("per-ASIN failure isolation: one fails, others still submit", async () => {
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean): Promise<OfferAddResult> => {
      if (dryRun) return previewOutcome(input.asin, "AMG", "HEA");
      if (input.asin === "B0000002") {
        return { kind: "putlistings_failed", asin: input.asin, sku: "X", reason: "validation_error",
          originalCode: "VAL", originalMessage: "bad", retryable: false };
      }
      return createdOutcome(input.asin, "AMG-HEA-AB1-PRD-XXX");
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [10.00], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const rows = [makeRow("B0000001"), makeRow("B0000002"), makeRow("B0000003")];
    const r = await submitOfferAddBatch(rows, makeDeps(offerAddFn, fetchOffersFn));
    expect(r.perAsin.map((p) => p.outcome.kind)).toEqual(["created", "putlistings_failed", "created"]);
    expect(r.notes.submittedCount).toBe(2);
    expect(r.notes.failedCount).toBe(1);
  });
});

// ============================================================================
// Result ordering + summary
// ============================================================================

// ============================================================================
// phase4Mode="preview" — used by the preview endpoint to show the EXACT
// payload that would be sent, without firing the PUT.
// ============================================================================

describe("submitOfferAddBatch — phase4Mode='preview'", () => {
  it("returns would_submit (NOT created) with the assembled payload + resolved price", async () => {
    let livePutFired = false;
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean): Promise<OfferAddResult> => {
      if (dryRun) {
        // Phase 1 dry-run AND phase 4 dry-run both come here. Distinguish by price:
        // phase 1 uses placeholder price=0, phase 4 uses resolved price.
        return {
          kind: "preview",
          asin: input.asin,
          sku: `AMG-HEA-AB1-PRD-${String(input.productNumber).padStart(3, "0")}`,
          reused: false,
          payload: {
            productType: "PRODUCT",
            requirements: "LISTING_OFFER_ONLY",
            attributes: { our_price: input.price }, // mock payload reflects passed price
          },
        };
      }
      livePutFired = true;
      return createdOutcome(input.asin, "X");
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [10.00], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const deps = { ...makeDeps(offerAddFn, fetchOffersFn), phase4Mode: "preview" as const };
    const r = await submitOfferAddBatch([makeRow("B0000001")], deps);
    expect(livePutFired).toBe(false); // CRITICAL: no PUT in preview mode
    expect(r.perAsin[0].outcome.kind).toBe("would_submit");
    if (r.perAsin[0].outcome.kind === "would_submit") {
      expect(r.perAsin[0].outcome.sku).toBe("AMG-HEA-AB1-PRD-001");
      expect(r.perAsin[0].outcome.resolvedPrice).toBe(13.99);
      expect(r.perAsin[0].outcome.payload.attributes.our_price).toBe(13.99); // payload built with REAL price
    }
    expect(r.notes.liveWrites).toContain("DISABLED");
  });

  it("preview mode honors all phase 1-3 blockers (legend_pending, offers_fetch_failed, etc) identically to live mode", async () => {
    const offerAddFn = async (input: OfferAddInput) =>
      ({ kind: "legend_pending", asin: input.asin, pending: { brand: null, dept: null } as any, details: "x" } as OfferAddResult);
    const fetchOffersFn = async () => ({ ok: true } as any);
    const deps = { ...makeDeps(offerAddFn, fetchOffersFn), phase4Mode: "preview" as const };
    const r = await submitOfferAddBatch([makeRow("B0000001")], deps);
    expect(r.perAsin[0].outcome.kind).toBe("skipped");
    if (r.perAsin[0].outcome.kind === "skipped") {
      expect(r.perAsin[0].outcome.reason).toBe("legend_pending");
    }
  });
});

describe("submitOfferAddBatch — result shape", () => {
  it("perAsin order matches input order regardless of outcome", async () => {
    let i = 0;
    const offerAddFn = async (input: OfferAddInput, _d: OfferAddDeps, dryRun: boolean): Promise<OfferAddResult> => {
      if (dryRun) {
        // Alternate skip/preview to scramble phase-4 sequence
        if (i++ % 2 === 0) return previewOutcome(input.asin, "AMG", "HEA");
        return { kind: "gated", asin: input.asin, details: "gated" };
      }
      return createdOutcome(input.asin, "X");
    };
    const fetchOffersFn = async () => ({ ok: true, competingOffers: [10.00], ourOffer: null, allOffers: [] } as OffersFetchOutcome);
    const rows = ["B0000001", "B0000002", "B0000003", "B0000004"].map((a) => makeRow(a));
    const r = await submitOfferAddBatch(rows, makeDeps(offerAddFn, fetchOffersFn));
    expect(r.perAsin.map((p) => p.asin)).toEqual(["B0000001", "B0000002", "B0000003", "B0000004"]);
  });

  it("notes.liveWrites reflects the live nature of this endpoint", async () => {
    const offerAddFn = async () => ({ kind: "preview" } as any);
    const fetchOffersFn = async () => ({ ok: true } as any);
    const r = await submitOfferAddBatch([], makeDeps(offerAddFn, fetchOffersFn));
    expect(r.notes.liveWrites).toContain("ENABLED");
  });
});
