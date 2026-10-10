// Tests for offerAddForAsin's reserve-then-PUT semantics.
//
// THE CRITICAL TESTS (Maria 2026-06-28):
//   - PUT returns failure → reservation rolled back
//   - PUT throws (network/timeout) → reservation rolled back, exception re-propagates
//   - PUT succeeds → reservation committed (not rolled back)
//   - a taken (brand, NNN) rejected BEFORE PUT (no reservation, no PUT call)
//   - a taken NNN with a MATCHING TTL is rejected too (was reuse_ok until
//     2026-10-07 — §18, NNN is never shared across ASINs)
//   - concurrent UNIQUE conflict → nnn_taken reject, whatever the TTL

import { describe, it, expect } from "vitest";
import { offerAddForAsin } from "./offer-add";
import type { ProductRegistryRepo } from "./product-registry-repo";
import type { ProductRegistryRow } from "@shared/product-registry";

const SELLER = "A1SELLERID";
const ASIN = "B0FCM6CX8M";

// Minimal mock: queryFn returns eligibility=yes, no candidates (so resurrection
// goes through resolveAndGenerateSku), legend resolved to AMG/BPC.
function makeMockQuery() {
  return async (sql: string, params?: any[]) => {
    if (sql.includes("FROM asin_estimates")) return { rows: [{ eligibility_status: "yes" }] };
    if (sql.includes("FROM asin_skus")) return { rows: [] };
    if (sql.includes("FROM sku_legend_alias")) {
      const [type, rawValue] = params ?? [];
      const key = `${type}:${String(rawValue ?? "").toLowerCase().trim()}`;
      const lookup: Record<string, any> = {
        "brand:aminogenesis": { legend_id: "x", code: "AMG", status: "approved" },
        "dept:beauty & personal care": { legend_id: "y", code: "BPC", status: "approved" },
      };
      return { rows: lookup[key] ? [lookup[key]] : [] };
    }
    return { rows: [] };
  };
}

// httpGet routing: catalog returns a happy payload, listings search returns
// no existing listings, listings per-SKU returns 404 (so resurrection generates new).
function makeMockHttpGet() {
  return async (endpoint: string) => {
    if (endpoint.startsWith("/catalog/")) {
      return {
        summaries: [{ brand: "AminoGenesis", itemName: "Test Product" }],
        classifications: [{
          classifications: [{ displayName: "Beauty & Personal Care" }],
        }],
        images: [],
      };
    }
    if (endpoint.startsWith("/listings/")) {
      const tail = endpoint.replace(/^\/listings\/2021-08-01\/items\//, "");
      const isSearch = !tail.includes("/");
      if (isSearch) return { numberOfResults: 0, items: [] };
      // per-SKU: 404
      const err: any = new Error("not found");
      err.response = { status: 404 };
      throw err;
    }
    if (endpoint.startsWith("/definitions/")) return { name: "PRODUCT" };
    throw new Error(`unrouted: ${endpoint}`);
  };
}

interface MockRepoState {
  rows: ProductRegistryRow[];
  reserveCalls: number;
  rollbackCalls: number;
  reservedIds: string[];
  reserveShouldThrow?: "unique_conflict" | "other";
}

function makeMockRepo(initial: ProductRegistryRow[] = []): { repo: ProductRegistryRepo; state: MockRepoState } {
  const state: MockRepoState = {
    rows: [...initial],
    reserveCalls: 0,
    rollbackCalls: 0,
    reservedIds: [],
  };
  const repo: ProductRegistryRepo = {
    async listForBrand(brand) { return state.rows.filter((r) => r.brandCode === brand); },
    async getByKey(brand, nnn) { return state.rows.find((r) => r.brandCode === brand && r.nnn === nnn) ?? null; },
    async reserve(input) {
      state.reserveCalls++;
      if (state.reserveShouldThrow) {
        const e: any = new Error("duplicate key");
        e.code = "23505";
        throw e;
      }
      // Check for existing UNIQUE conflict in our state (mirrors PG behavior)
      const collision = state.rows.find((r) => r.brandCode === input.brandCode && r.nnn === input.nnn);
      if (collision) {
        const e: any = new Error("duplicate key");
        e.code = "23505";
        throw e;
      }
      const id = `r${state.reserveCalls}`;
      state.reservedIds.push(id);
      state.rows.push({
        brandCode: input.brandCode, nnn: input.nnn, ttl: input.ttl,
        deptCode: input.deptCode, productName: input.productName, firstAsin: input.firstAsin,
        registeredAt: new Date(),
      });
      return { id };
    },
    async rollback(id) {
      state.rollbackCalls++;
      state.rows = state.rows.filter((_, i) => state.reservedIds[i] !== id);
    },
  };
  return { repo, state };
}

// ============================================================================
// Tests
// ============================================================================

describe("offerAddForAsin — registry reserve-then-PUT", () => {
  it("PUT succeeds → reservation COMMITTED (no rollback)", async () => {
    const { repo, state } = makeMockRepo();
    const httpPut = async () => ({ sku: "AMG-BPC-X8M-TPR-001", status: "ACCEPTED", submissionId: "SUB-OK", issues: [] });
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), httpPut, sellerId: SELLER, productRegistry: repo },
      false,
    );
    expect(r.kind).toBe("created");
    expect(state.reserveCalls).toBe(1);
    expect(state.rollbackCalls).toBe(0); // CRITICAL: committed → no rollback
    expect(state.rows).toHaveLength(1);
  });

  it("PUT returns 400 (Amazon rejects payload) → reservation ROLLED BACK", async () => {
    const { repo, state } = makeMockRepo();
    const httpPut = async () => {
      // axios-style rejection: putListingsItem catches err.response and converts to http_error envelope.
      const e: any = new Error("invalid");
      e.response = { status: 400, data: { errors: [{ code: "INVALID_LISTINGS_DATA", message: "bad payload" }] } };
      throw e;
    };
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), httpPut, sellerId: SELLER, productRegistry: repo },
      false,
    );
    expect(r.kind).toBe("putlistings_failed");
    expect(state.reserveCalls).toBe(1);
    expect(state.rollbackCalls).toBe(1); // CRITICAL: failure → rollback fired
    expect(state.rows).toHaveLength(0);  // row removed
  });

  it("httpPut THROWS network error (ECONNRESET-style) → reservation ROLLED BACK", async () => {
    // Important nuance: putListingsItem CATCHES network throws internally and
    // converts them to a typed envelope (kind: "network_error"). So
    // offerAddForAsin doesn't re-throw — it returns putlistings_failed with
    // reason="transient". The rollback still fires because committed=false.
    // (If we ever want re-throw semantics, we'd refactor putListingsItem to
    // surface network errors as exceptions — current design avoids that.)
    const { repo, state } = makeMockRepo();
    const httpPut = async () => { throw new Error("ECONNRESET: connection reset"); };
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), httpPut, sellerId: SELLER, productRegistry: repo },
      false,
    );
    expect(r.kind).toBe("putlistings_failed");
    if (r.kind === "putlistings_failed") {
      expect(r.reason).toBe("transient");
    }
    expect(state.reserveCalls).toBe(1);
    expect(state.rollbackCalls).toBe(1); // CRITICAL: rollback fired despite no re-throw
    expect(state.rows).toHaveLength(0);
  });

  it("nnn_taken: NNN exists with a DIFFERENT TTL → REJECT BEFORE PUT (no reservation, no PUT)", async () => {
    let putCalled = false;
    const { repo, state } = makeMockRepo([
      { brandCode: "AMG", nnn: 1, ttl: "OLD", deptCode: "BPC", productName: "Old Product", firstAsin: "B00OLD", registeredAt: new Date() },
    ]);
    const httpPut = async () => { putCalled = true; return { status: 200, data: {} }; };
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), httpPut, sellerId: SELLER, productRegistry: repo },
      false,
    );
    expect(r.kind).toBe("resurrection_error");
    if (r.kind === "resurrection_error") {
      expect(r.reason).toBe("nnn_taken");
      expect(r.details).toContain("'OLD'");
      expect(r.details).toContain("B00OLD");
    }
    expect(state.reserveCalls).toBe(0); // never tried to insert
    expect(state.rollbackCalls).toBe(0);
    expect(putCalled).toBe(false); // CRITICAL: no PUT fired
  });

  it("nnn_taken: NNN exists with a MATCHING TTL → also rejected (this was reuse_ok)", async () => {
    // §18 (2026-10-07). resurrection generates the SKU with TTL "TPR"; the
    // registry already holds (AMG, 1, TPR) under another ASIN. That exact
    // shape used to be `reuse_ok` — "same product, different ASIN", fire the
    // PUT and share the number. An equal TTL is now no evidence of anything:
    // two products deriving the same 3 chars is ordinary, and the number
    // belongs to B00OLD either way.
    const { repo, state } = makeMockRepo([
      { brandCode: "AMG", nnn: 1, ttl: "TPR", deptCode: "BPC", productName: "Test Product (existing)", firstAsin: "B00OLD", registeredAt: new Date() },
    ]);
    let putCalled = false;
    const httpPut = async () => { putCalled = true; return { sku: "AMG-BPC-X8M-TPR-001", status: "ACCEPTED", submissionId: "SUB-OK", issues: [] }; };
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), httpPut, sellerId: SELLER, productRegistry: repo },
      false,
    );
    expect(r.kind).toBe("resurrection_error");
    if (r.kind === "resurrection_error") {
      expect(r.reason).toBe("nnn_taken");
      expect(r.details).toContain("B00OLD");
    }
    expect(putCalled).toBe(false); // CRITICAL: no offer created on someone else's NNN
    expect(state.reserveCalls).toBe(0);
    expect(state.rollbackCalls).toBe(0);
    expect(state.rows).toHaveLength(1); // untouched
  });

  it("concurrent writer wins the NNN with a MATCHING TTL → nnn_taken, no PUT", async () => {
    // The race: getByKey saw the NNN free, so we tried to reserve; a parallel
    // submit got there first and UNIQUE (brand_code, nnn) threw. We re-read
    // and find THEIR row, carrying the same TTL ours derived.
    //
    // §18 (2026-10-07): this is the reuse_ok rule under another name and is
    // now a hard error. Losing the race means the number is gone — the
    // operator re-previews and the allocator hands out the next free one.
    // Previously this arm fell through and fired the PUT on their number.
    const { repo, state } = makeMockRepo([]);
    let putCalled = false;
    const winner: ProductRegistryRow = {
      brandCode: "AMG", nnn: 1, ttl: "TPR", deptCode: "BPC",
      productName: "Won the race", firstAsin: "B00RACE", registeredAt: new Date(),
    };
    // reserve throws like a UNIQUE conflict; the post-conflict re-read then
    // sees the winner's row.
    state.reserveShouldThrow = "unique_conflict";
    const racing: ProductRegistryRepo = {
      ...repo,
      async reserve(input) { return repo.reserve(input); },
      async getByKey(brand, nnn) {
        return state.reserveCalls > 0 ? winner : null; // free before, taken after
      },
    };
    const httpPut = async () => { putCalled = true; return { sku: "x", status: "ACCEPTED", submissionId: "S", issues: [] }; };
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), httpPut, sellerId: SELLER, productRegistry: racing },
      false,
    );
    expect(r.kind).toBe("resurrection_error");
    if (r.kind === "resurrection_error") {
      expect(r.reason).toBe("nnn_taken");
      expect(r.details).toContain("B00RACE");
    }
    expect(putCalled).toBe(false);
    expect(state.rollbackCalls).toBe(0); // our reserve never landed — nothing to undo
  });

  it("dryRun=true bypasses ALL registry interaction (no reads, no writes)", async () => {
    let getByKeyCalls = 0;
    const { repo, state } = makeMockRepo();
    const wrappedRepo: ProductRegistryRepo = {
      ...repo,
      getByKey: async (b, n) => { getByKeyCalls++; return repo.getByKey(b, n); },
    };
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), sellerId: SELLER, productRegistry: wrappedRepo },
      true, // dryRun
    );
    expect(r.kind).toBe("preview");
    expect(getByKeyCalls).toBe(0); // CRITICAL: dry-run skips registry entirely
    expect(state.reserveCalls).toBe(0);
    expect(state.rollbackCalls).toBe(0);
  });

  it("no productRegistry dep → registry validation skipped, behaves as before", async () => {
    // Back-compat: tests/callers without registry config still work.
    const httpPut = async () => ({ sku: "AMG-BPC-X8M-TPR-001", status: "ACCEPTED", submissionId: "SUB-OK", issues: [] });
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), httpPut, sellerId: SELLER /* no productRegistry */ },
      false,
    );
    expect(r.kind).toBe("created");
  });

  it("reserve gets product_name from catalog itemName (threaded via resurrection trail)", async () => {
    const { repo, state } = makeMockRepo();
    let capturedInput: any = null;
    const wrappedRepo: ProductRegistryRepo = {
      ...repo,
      reserve: async (input) => {
        capturedInput = input;
        return repo.reserve(input);
      },
    };
    const httpPut = async () => ({ sku: "AMG-BPC-X8M-TPR-001", status: "ACCEPTED", submissionId: "SUB-OK", issues: [] });
    await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), httpPut, sellerId: SELLER, productRegistry: wrappedRepo },
      false,
    );
    expect(capturedInput).not.toBeNull();
    expect(capturedInput.productName).toBe("Test Product"); // from mock catalog's itemName
    expect(capturedInput.firstAsin).toBe(ASIN);
  });

  it("rollback FAILURE is caught and logged — original error/return still surfaces", async () => {
    const { repo, state } = makeMockRepo();
    // Make rollback throw
    const badRepo: ProductRegistryRepo = {
      ...repo,
      rollback: async () => { throw new Error("DB connection lost during rollback"); },
    };
    const httpPut = async () => {
      const e: any = new Error("amazon rejected");
      e.response = { status: 400, data: { errors: [{ code: "X", message: "y" }] } };
      throw e;
    };
    // Should still return putlistings_failed (not throw the rollback error)
    const r = await offerAddForAsin(
      { asin: ASIN, productNumber: 1, price: 10, cogs: null },
      { queryFn: makeMockQuery(), httpGet: makeMockHttpGet(), httpPut, sellerId: SELLER, productRegistry: badRepo },
      false,
    );
    expect(r.kind).toBe("putlistings_failed"); // original error wins, rollback error swallowed
    expect(state.reserveCalls).toBe(1);
  });
});
