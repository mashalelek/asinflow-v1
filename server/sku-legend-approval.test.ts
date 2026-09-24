// Tests for the bulk approval ORCHESTRATOR — the part with subtle logic
// (ordering, dependency tracking, position-correlated results). Action
// handlers themselves get integration-tested via a DB smoke script.

import { describe, it, expect, vi } from "vitest";
import {
  processBulkApproval,
  normalizeRawValue,
  type ApprovalItem,
  type ApprovalActionHandlers,
  type ApprovalResult,
  type ApprovedBrand,
} from "./sku-legend-approval";

// Helper: build a mock handler set that records call order and returns
// predetermined outcomes per item (keyed by rawValue).
function mockHandlers(opts: {
  approveNewByRaw?: Record<string, Partial<ApprovalResult>>;
  approveInPlaceByRaw?: Record<string, Partial<ApprovalResult>>;
  mergeByRaw?: Record<string, Partial<ApprovalResult>>;
  preExistingApproved?: Map<string, ApprovedBrand>;
}): { handlers: ApprovalActionHandlers; calls: { phase: string; rawValue: string }[] } {
  const calls: { phase: string; rawValue: string }[] = [];
  return {
    calls,
    handlers: {
      async loadApprovedBrands() {
        calls.push({ phase: "loadApprovedBrands", rawValue: "" });
        return opts.preExistingApproved ?? new Map();
      },
      async approveNew(item) {
        calls.push({ phase: "approveNew", rawValue: item.rawValue });
        const partial = opts.approveNewByRaw?.[item.rawValue];
        if (!partial) return { rawValue: item.rawValue, outcome: "created", code: item.code, legendId: `uuid-${item.rawValue}` };
        return { rawValue: item.rawValue, ...partial } as ApprovalResult;
      },
      async approveInPlace(item) {
        calls.push({ phase: "approveInPlace", rawValue: item.rawValue });
        const partial = opts.approveInPlaceByRaw?.[item.rawValue];
        if (!partial) return { rawValue: item.rawValue, outcome: "updated", code: item.code, legendId: item.legendId };
        return { rawValue: item.rawValue, ...partial } as ApprovalResult;
      },
      async merge(item, target) {
        calls.push({ phase: "merge", rawValue: item.rawValue });
        const partial = opts.mergeByRaw?.[item.rawValue];
        if (!partial) return { rawValue: item.rawValue, outcome: "merged", intoCode: target.code, intoLegendId: target.legendId };
        return { rawValue: item.rawValue, ...partial } as ApprovalResult;
      },
    },
  };
}

// ============================================================================
// Phase ordering — approve_new → merge → approve_in_place
// ============================================================================
describe("processBulkApproval — phase ordering", () => {
  it("runs approve_new first, then merge, then approve_in_place regardless of input order", async () => {
    const { handlers, calls } = mockHandlers({
      preExistingApproved: new Map([
        [normalizeRawValue("AminoGenesis"), { legendId: "uuid-amg", code: "AMG" }],
      ]),
    });
    const items: ApprovalItem[] = [
      // Input order intentionally scrambled
      { type: "brand", rawValue: "InPlaceFirst", action: "approve_in_place", legendId: "u-ipf", code: "IPF" },
      { type: "brand", rawValue: "MergeBrand",   action: "merge", intoRawValue: "AminoGenesis" },
      { type: "brand", rawValue: "NewBrand",     action: "approve_new", code: "NEW" },
    ];
    await processBulkApproval(items, handlers);

    const actionCalls = calls.filter((c) => c.phase !== "loadApprovedBrands").map((c) => c.phase);
    expect(actionCalls).toEqual(["approveNew", "merge", "approveInPlace"]);
  });

  it("loadApprovedBrands runs ONCE, between approve_new and merge phases", async () => {
    const { handlers, calls } = mockHandlers({
      preExistingApproved: new Map([
        [normalizeRawValue("AminoGenesis"), { legendId: "u-a", code: "AMG" }],
      ]),
    });
    await processBulkApproval(
      [
        { type: "brand", rawValue: "A", action: "approve_new", code: "AAA" },
        { type: "brand", rawValue: "B", action: "merge", intoRawValue: "AminoGenesis" },
      ],
      handlers,
    );

    const loadCalls = calls.filter((c) => c.phase === "loadApprovedBrands");
    expect(loadCalls).toHaveLength(1);
    // Position: after the approveNew, before the merge
    const phases = calls.map((c) => c.phase);
    const loadIdx = phases.indexOf("loadApprovedBrands");
    const newIdx = phases.indexOf("approveNew");
    const mergeIdx = phases.indexOf("merge");
    expect(loadIdx).toBeGreaterThan(newIdx);
    expect(loadIdx).toBeLessThan(mergeIdx);
  });
});

// ============================================================================
// Position-correlated results
// ============================================================================
describe("processBulkApproval — results position-correlated with input", () => {
  it("returns one result per input item, in input order", async () => {
    const { handlers } = mockHandlers({
      preExistingApproved: new Map([[normalizeRawValue("AminoGenesis"), { legendId: "u", code: "AMG" }]]),
    });
    const items: ApprovalItem[] = [
      { type: "brand", rawValue: "X", action: "approve_new", code: "XXX" },
      { type: "brand", rawValue: "Y", action: "merge", intoRawValue: "AminoGenesis" },
      { type: "brand", rawValue: "Z", action: "approve_in_place", legendId: "u-z", code: "ZZZ" },
    ];
    const results = await processBulkApproval(items, handlers);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.rawValue)).toEqual(["X", "Y", "Z"]);
  });
});

// ============================================================================
// Same-batch merge dependency (the user's critical addition)
// ============================================================================
describe("processBulkApproval — same-batch merge dependency tracking", () => {
  it("merge into newly-approved-this-batch brand succeeds (cer-merge after cer-approve)", async () => {
    const { handlers } = mockHandlers({});
    const items: ApprovalItem[] = [
      { type: "brand", rawValue: "CerMedia",   action: "approve_new", code: "CER" },
      { type: "brand", rawValue: "MarinePure", action: "merge", intoRawValue: "CerMedia" },
    ];
    const results = await processBulkApproval(items, handlers);
    expect(results[0].outcome).toBe("created");
    expect(results[1].outcome).toBe("merged");
    if (results[1].outcome === "merged") {
      expect(results[1].intoCode).toBe("CER");
    }
  });

  it("merge into a SAME-BATCH approve_new that FAILED → merge_target_failed (CRITICAL)", async () => {
    const { handlers } = mockHandlers({
      approveNewByRaw: {
        // Simulate CerMedia's approve_new returning code_collision
        CerMedia: { outcome: "error", reason: "code_collision", message: "CER already taken" },
      },
    });
    const items: ApprovalItem[] = [
      { type: "brand", rawValue: "CerMedia",   action: "approve_new", code: "CER" },
      { type: "brand", rawValue: "MarinePure", action: "merge", intoRawValue: "CerMedia" },
    ];
    const results = await processBulkApproval(items, handlers);

    // The approve_new errored
    expect(results[0].outcome).toBe("error");

    // The dependent merge must NOT silently succeed and must NOT use target_not_found
    expect(results[1].outcome).toBe("error");
    if (results[1].outcome === "error") {
      expect(results[1].reason).toBe("merge_target_failed");
      expect(results[1].message).toContain("CerMedia");
      expect(results[1].message).toContain("failed to approve");
    }
  });

  it("merge into rawValue that was NEVER attempted in this batch → target_not_found", async () => {
    const { handlers } = mockHandlers({});
    const items: ApprovalItem[] = [
      { type: "brand", rawValue: "MarinePure", action: "merge", intoRawValue: "NonExistentBrand" },
    ];
    const results = await processBulkApproval(items, handlers);
    expect(results[0].outcome).toBe("error");
    if (results[0].outcome === "error") {
      expect(results[0].reason).toBe("target_not_found");
    }
  });

  it("merge into PRE-EXISTING approved brand succeeds without same-batch approve_new", async () => {
    const { handlers } = mockHandlers({
      preExistingApproved: new Map([
        [normalizeRawValue("AminoGenesis"), { legendId: "u-amg", code: "AMG" }],
      ]),
    });
    const items: ApprovalItem[] = [
      { type: "brand", rawValue: "AminoGenesis Cosmetics", action: "merge", intoRawValue: "AminoGenesis" },
    ];
    const results = await processBulkApproval(items, handlers);
    expect(results[0].outcome).toBe("merged");
  });

  it("multiple merges into the same approved-this-batch target all succeed", async () => {
    const { handlers } = mockHandlers({});
    const items: ApprovalItem[] = [
      { type: "brand", rawValue: "CerMedia",       action: "approve_new", code: "CER" },
      { type: "brand", rawValue: "MarinePure",     action: "merge", intoRawValue: "CerMedia" },
      { type: "brand", rawValue: "MP-Bio-Filter",  action: "merge", intoRawValue: "CerMedia" },
    ];
    const results = await processBulkApproval(items, handlers);
    expect(results[0].outcome).toBe("created");
    expect(results[1].outcome).toBe("merged");
    expect(results[2].outcome).toBe("merged");
  });

  it("approve_new succeeds with already_approved → still usable as merge target", async () => {
    const { handlers } = mockHandlers({
      approveNewByRaw: {
        CerMedia: { outcome: "already_approved", code: "CER", legendId: "u-cer-existing" },
      },
    });
    const items: ApprovalItem[] = [
      { type: "brand", rawValue: "CerMedia",   action: "approve_new", code: "CER" },
      { type: "brand", rawValue: "MarinePure", action: "merge", intoRawValue: "CerMedia" },
    ];
    const results = await processBulkApproval(items, handlers);
    expect(results[0].outcome).toBe("already_approved");
    expect(results[1].outcome).toBe("merged");
  });
});

// ============================================================================
// Normalization in dependency matching (case/whitespace insensitive)
// ============================================================================
describe("processBulkApproval — normalization in merge target resolution", () => {
  it("merge intoRawValue matches case/whitespace variants of the approve_new rawValue", async () => {
    const { handlers } = mockHandlers({});
    const items: ApprovalItem[] = [
      { type: "brand", rawValue: "CerMedia", action: "approve_new", code: "CER" },
      { type: "brand", rawValue: "MarinePure", action: "merge", intoRawValue: "  cermedia  " },
    ];
    const results = await processBulkApproval(items, handlers);
    expect(results[1].outcome).toBe("merged");
  });
});

// ============================================================================
// Per-item failure isolation
// ============================================================================
describe("processBulkApproval — per-item failure isolation", () => {
  it("one failing item doesn't block others", async () => {
    const { handlers } = mockHandlers({
      approveNewByRaw: {
        Bad: { outcome: "error", reason: "code_collision", message: "BAD taken" },
      },
    });
    const items: ApprovalItem[] = [
      { type: "brand", rawValue: "Good", action: "approve_new", code: "GUD" },
      { type: "brand", rawValue: "Bad",  action: "approve_new", code: "BAD" },
      { type: "brand", rawValue: "AlsoGood", action: "approve_new", code: "AGD" },
    ];
    const results = await processBulkApproval(items, handlers);
    expect(results[0].outcome).toBe("created");
    expect(results[1].outcome).toBe("error");
    expect(results[2].outcome).toBe("created");
  });

  it("handler that throws produces error outcome, not crashing the batch", async () => {
    const handlers: ApprovalActionHandlers = {
      loadApprovedBrands: async () => new Map(),
      approveNew: async () => { throw new Error("simulated crash"); },
      approveInPlace: async () => ({ rawValue: "", outcome: "updated", code: "ZZZ", legendId: "u" }),
      merge: async () => ({ rawValue: "", outcome: "merged", intoCode: "X", intoLegendId: "u" }),
    };
    const results = await processBulkApproval(
      [{ type: "brand", rawValue: "Crash", action: "approve_new", code: "CRH" }],
      handlers,
    );
    expect(results[0].outcome).toBe("error");
    if (results[0].outcome === "error") {
      expect(results[0].reason).toBe("unknown");
      expect(results[0].message).toContain("simulated crash");
    }
  });
});

// ============================================================================
// Edge cases
// ============================================================================
describe("processBulkApproval — edge cases", () => {
  it("empty items → empty results, no handler calls (well, loadApprovedBrands still fires once)", async () => {
    const { handlers, calls } = mockHandlers({});
    const results = await processBulkApproval([], handlers);
    expect(results).toEqual([]);
    // loadApprovedBrands always runs (cheap, single SELECT). All other phases skip.
    expect(calls.filter((c) => c.phase !== "loadApprovedBrands")).toEqual([]);
  });

  it("only approve_in_place items — no merge phase needed but loadApprovedBrands still cheap-fires", async () => {
    const { handlers } = mockHandlers({});
    const results = await processBulkApproval(
      [{ type: "brand", rawValue: "X", action: "approve_in_place", legendId: "u", code: "XXX" }],
      handlers,
    );
    expect(results[0].outcome).toBe("updated");
  });

  it("dept items only — no merge expected (merge is brand-only per type system)", async () => {
    // The type system itself prevents `merge` on type='dept' (Extract narrows).
    // This test just confirms the orchestrator handles a dept-only batch.
    const { handlers } = mockHandlers({});
    const results = await processBulkApproval(
      [
        { type: "dept", rawValue: "Beauty & Personal Care", action: "approve_new", code: "BPC" },
        { type: "dept", rawValue: "Books", action: "approve_in_place", legendId: "u-books", code: "BOO" },
      ],
      handlers,
    );
    expect(results[0].outcome).toBe("created");
    expect(results[1].outcome).toBe("updated");
  });
});

// ============================================================================
// normalizeRawValue
// ============================================================================
describe("normalizeRawValue", () => {
  it("lowercases, trims, collapses internal whitespace", () => {
    expect(normalizeRawValue("  AminoGenesis  Cosmetics  ")).toBe("aminogenesis cosmetics");
  });
  it("handles single value", () => {
    expect(normalizeRawValue("Patagonia")).toBe("patagonia");
  });
  it("collapses multiple spaces", () => {
    expect(normalizeRawValue("A   B   C")).toBe("a b c");
  });
});

// ============================================================================
// Phase 0 — reserved code + blank raw value rejection (§18, 2026-09-24)
// ============================================================================
// Origin: approving a brand row whose raw value was empty wrote
// sku_legend(brand, "", HAU). Every later brandless ASIN then resolved
// through it, and both Approve and Merge on that row failed with
// `"" already in legend with code "HAU"` — unfixable from the UI.
describe("processBulkApproval — reserved codes and blank raw values", () => {
  const RESERVED = "NUL";

  for (const action of ["approve_new", "approve_in_place"] as const) {
    it(`rejects the reserved code ${RESERVED} for ${action}, and no handler runs`, async () => {
      const { handlers, calls } = mockHandlers({});
      const item =
        action === "approve_new"
          ? { type: "brand", rawValue: "Nulon", action, code: RESERVED }
          : { type: "brand", rawValue: "Nulon", action, legendId: "u-1", code: RESERVED };
      const results = await processBulkApproval([item as ApprovalItem], handlers);
      expect(results[0].outcome).toBe("error");
      if (results[0].outcome !== "error") return;
      expect(results[0].reason).toBe("invalid_input");
      expect(results[0].message).toContain(RESERVED);
      expect(calls.filter((c) => c.phase !== "loadApprovedBrands")).toEqual([]);
    });
  }

  it("rejects the reserved code case-insensitively and with surrounding space", async () => {
    const { handlers } = mockHandlers({});
    const results = await processBulkApproval(
      [
        { type: "brand", rawValue: "A", action: "approve_new", code: "nul" },
        { type: "dept", rawValue: "B", action: "approve_new", code: " NUL " },
      ],
      handlers,
    );
    expect(results.every((r) => r.outcome === "error")).toBe(true);
  });

  it("reserves NUL for departments too — not just brands", async () => {
    const { handlers } = mockHandlers({});
    const results = await processBulkApproval(
      [{ type: "dept", rawValue: "Books", action: "approve_new", code: RESERVED }],
      handlers,
    );
    expect(results[0].outcome).toBe("error");
  });

  for (const [label, blank] of [["empty", ""], ["whitespace", "   "]] as const) {
    it(`rejects a ${label} raw value for approve_new — this is the "" → HAU row's origin`, async () => {
      const { handlers, calls } = mockHandlers({});
      const results = await processBulkApproval(
        [{ type: "brand", rawValue: blank, action: "approve_new", code: "HAU" }],
        handlers,
      );
      expect(results[0].outcome).toBe("error");
      if (results[0].outcome !== "error") return;
      expect(results[0].reason).toBe("invalid_input");
      expect(results[0].message).toContain("NUL"); // points at the real rule
      expect(calls.filter((c) => c.phase === "approveNew")).toEqual([]);
    });
  }

  it("rejects a blank raw value for merge, and a blank merge TARGET", async () => {
    const { handlers } = mockHandlers({});
    const results = await processBulkApproval(
      [
        { type: "brand", rawValue: "   ", action: "merge", intoRawValue: "AminoGenesis" },
        { type: "brand", rawValue: "Amino Genesis", action: "merge", intoRawValue: "  " },
      ],
      handlers,
    );
    expect(results[0].outcome).toBe("error");
    expect(results[1].outcome).toBe("error");
  });

  it("a rejected item does not block its valid siblings, and positions still line up", async () => {
    const { handlers } = mockHandlers({});
    const results = await processBulkApproval(
      [
        { type: "brand", rawValue: "Patagonia", action: "approve_new", code: "PAT" },
        { type: "brand", rawValue: "", action: "approve_new", code: "HAU" },       // rejected
        { type: "brand", rawValue: "Nulon", action: "approve_new", code: "NUL" },  // rejected
        { type: "dept", rawValue: "Books", action: "approve_new", code: "BOO" },
      ],
      handlers,
    );
    expect(results.map((r) => r.outcome)).toEqual(["created", "error", "error", "created"]);
    expect(results[0].rawValue).toBe("Patagonia");
    expect(results[3].rawValue).toBe("Books");
  });

  it("a rejected approve_new is NOT available as a merge target in the same batch", async () => {
    const { handlers } = mockHandlers({});
    const results = await processBulkApproval(
      [
        { type: "brand", rawValue: "", action: "approve_new", code: "HAU" },
        { type: "brand", rawValue: "Some Brand", action: "merge", intoRawValue: "" },
      ],
      handlers,
    );
    expect(results[0].outcome).toBe("error");
    expect(results[1].outcome).toBe("error");
  });

  it("still approves a normal, non-reserved code with a real raw value", async () => {
    const { handlers } = mockHandlers({});
    const results = await processBulkApproval(
      [{ type: "brand", rawValue: "AminoGenesis", action: "approve_new", code: "AMG" }],
      handlers,
    );
    expect(results[0].outcome).toBe("created");
  });
});
