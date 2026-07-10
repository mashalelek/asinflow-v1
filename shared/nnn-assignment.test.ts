import { describe, it, expect } from "vitest";
import {
  assignNnns,
  parseConformingSku,
  buildExistingNnnsFromSkus,
  type NnnAssignmentRequest,
  type ExistingNnns,
} from "./nnn-assignment";
import { buildSku } from "./sku-generator";

function req(asin: string, brd: string, dep: string): NnnAssignmentRequest {
  return { asin, brandCode: brd, deptCode: dep };
}

function existing(entries: Array<[string, number[]]>): ExistingNnns {
  const map: ExistingNnns = new Map();
  for (const [key, nnns] of entries) map.set(key, new Set(nnns));
  return map;
}

// ============================================================================
// parseConformingSku — discriminator must match resurrection's
// ============================================================================
describe("parseConformingSku", () => {
  it("parses valid current-format SKU: BRD-DEP-AS3-TTL-NNN", () => {
    expect(parseConformingSku("AMG-BPC-X8M-RRC-007")).toEqual({ brd: "AMG", dep: "BPC", nnn: 7 });
    expect(parseConformingSku("KAR-GRO-7Y8-NUT-042")).toEqual({ brd: "KAR", dep: "GRO", nnn: 42 });
  });

  it("parses current-format with variant suffix: BRD-DEP-AS3-TTL-NNN-X", () => {
    expect(parseConformingSku("AMG-BPC-X8M-RRC-007-A")).toEqual({ brd: "AMG", dep: "BPC", nnn: 7 });
  });

  it("rejects legacy AMG (2-char dept, no AS3)", () => {
    expect(parseConformingSku("AMG-BP-CLN-RRC-002-A")).toBeNull();
    expect(parseConformingSku("AMG-BP-EYS-EYE-013")).toBeNull();
  });

  it("rejects Amazon-random patterns", () => {
    expect(parseConformingSku("amzn.gr.KP-C3D1-140L-28doDXpYRP0qVWPb-VG")).toBeNull();
    expect(parseConformingSku("00-5PDC-FO04")).toBeNull();
    expect(parseConformingSku("VZ-TS25-NZFO")).toBeNull();
  });

  it("rejects pure-digit / malformed", () => {
    expect(parseConformingSku("1068914771")).toBeNull();
    expect(parseConformingSku("")).toBeNull();
    expect(parseConformingSku("PFL_AMINO_AMIHVOT3GL1YFNJIBB37")).toBeNull();
  });

  it("rejects NNN out of valid range (0, > 999, non-numeric)", () => {
    expect(parseConformingSku("AMG-BPC-X8M-RRC-000")).toBeNull(); // 0 not allowed
    expect(parseConformingSku("AMG-BPC-X8M-RRC-1000")).toBeNull(); // too high
    expect(parseConformingSku("AMG-BPC-X8M-RRC-XYZ")).toBeNull(); // non-numeric
  });
});

// ============================================================================
// buildExistingNnnsFromSkus — filters non-conforming, groups by bucket
// ============================================================================
describe("buildExistingNnnsFromSkus", () => {
  it("groups conforming SKUs by (BRD, DEP), filters non-conforming silently", () => {
    const result = buildExistingNnnsFromSkus([
      "AMG-BPC-X8M-RRC-001",       // conforming
      "AMG-BPC-Y9N-XYZ-002-A",     // conforming, variant
      "KAR-GRO-7Y8-NUT-042",       // conforming, different bucket
      "AMG-BP-CLN-RRC-002-A",      // legacy (rejected)
      "amzn.gr.foo",               // amazon (rejected)
      "1068914771",                // pure digit (rejected)
    ]);
    expect(result.get("AMG-BPC")).toEqual(new Set([1, 2]));
    expect(result.get("KAR-GRO")).toEqual(new Set([42]));
    expect(result.size).toBe(2); // only the two conforming buckets
  });

  it("empty input → empty map", () => {
    expect(buildExistingNnnsFromSkus([])).toEqual(new Map());
  });

  it("all-non-conforming input → empty map", () => {
    expect(
      buildExistingNnnsFromSkus(["amzn.gr.foo", "AMG-BP-CLN-RRC-002", "1068914771"]),
    ).toEqual(new Map());
  });
});

// ============================================================================
// assignNnns — empty existing, fresh assignments
// ============================================================================
describe("assignNnns — fresh buckets (no existing)", () => {
  it("single request, empty bucket → NNN=1", () => {
    const r = assignNnns([req("B0X1", "AMG", "BPC")], new Map());
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ kind: "assigned", asin: "B0X1", brandCode: "AMG", deptCode: "BPC", nnn: 1 });
  });

  it("multiple buckets in same batch, all empty → each starts at 1", () => {
    const r = assignNnns(
      [req("B0X1", "AMG", "BPC"), req("B0X2", "KAR", "GRO"), req("B0X3", "PAT", "SPO")],
      new Map(),
    );
    expect(r.map((o) => o.kind === "assigned" ? o.nnn : -1)).toEqual([1, 1, 1]);
  });
});

// ============================================================================
// assignNnns — max+1 from existing
// ============================================================================
describe("assignNnns — increment past existing max", () => {
  it("existing max 5 → next is 6", () => {
    const r = assignNnns(
      [req("B0X1", "AMG", "BPC")],
      existing([["AMG-BPC", [1, 2, 3, 4, 5]]]),
    );
    expect((r[0] as any).nnn).toBe(6);
  });

  it("existing max 5 with gaps {1, 3, 5} → next is 6 (gap-NOT-filled)", () => {
    // Critical: never fill gaps left by retired SKUs. Monotonic increase only.
    const r = assignNnns(
      [req("B0X1", "AMG", "BPC")],
      existing([["AMG-BPC", [1, 3, 5]]]),
    );
    expect((r[0] as any).nnn).toBe(6); // NOT 2, NOT 4
  });

  it("retired number reservation: existing {7} where 7 was deleted → next is 8, NEVER 7", () => {
    // The function doesn't care whether existing NNNs come from live or
    // retired SKUs — both contribute to max. Caller passes existing from
    // asin_skus which retains retired SKUs. This test pins the contract.
    const r = assignNnns(
      [req("B0X1", "AMG", "BPC")],
      existing([["AMG-BPC", [7]]]), // imagine 7 belongs to a deleted SKU
    );
    expect((r[0] as any).nnn).toBe(8);
  });
});

// ============================================================================
// assignNnns — batch sequencing within same bucket (CRITICAL)
// ============================================================================
describe("assignNnns — batch sequencing within same (BRD,DEP)", () => {
  it("3 requests in same bucket, empty existing → sequential 1, 2, 3", () => {
    const r = assignNnns(
      [req("B0A", "AMG", "BPC"), req("B0B", "AMG", "BPC"), req("B0C", "AMG", "BPC")],
      new Map(),
    );
    expect(r.map((o) => (o as any).nnn)).toEqual([1, 2, 3]);
  });

  it("3 requests in same bucket, existing max 10 → sequential 11, 12, 13", () => {
    // The bug this guards against: each request independently computes max+1
    // = 11, all three get 11, collision on commit.
    const r = assignNnns(
      [req("B0A", "AMG", "BPC"), req("B0B", "AMG", "BPC"), req("B0C", "AMG", "BPC")],
      existing([["AMG-BPC", [10]]]),
    );
    expect(r.map((o) => (o as any).nnn)).toEqual([11, 12, 13]);
  });

  it("mixed buckets in same batch, each bucket increments independently", () => {
    const r = assignNnns(
      [
        req("B01", "AMG", "BPC"), // AMG-BPC has max=5 → 6
        req("B02", "KAR", "GRO"), // KAR-GRO has max=2 → 3
        req("B03", "AMG", "BPC"), // AMG-BPC cursor now 6 → 7
        req("B04", "PAT", "SPO"), // PAT-SPO empty → 1
        req("B05", "KAR", "GRO"), // KAR-GRO cursor now 3 → 4
      ],
      existing([
        ["AMG-BPC", [5]],
        ["KAR-GRO", [2]],
      ]),
    );
    expect(r.map((o) => (o as any).nnn)).toEqual([6, 3, 7, 1, 4]);
  });

  it("preserves input order in output (one outcome per input position)", () => {
    const r = assignNnns(
      [req("X", "AMG", "BPC"), req("Y", "KAR", "GRO"), req("Z", "AMG", "BPC")],
      new Map(),
    );
    expect(r.map((o) => o.asin)).toEqual(["X", "Y", "Z"]);
  });
});

// ============================================================================
// assignNnns — 999 overflow
// ============================================================================
describe("assignNnns — 999 overflow", () => {
  it("bucket at 999 → first request in that bucket errors with kind=overflow", () => {
    const r = assignNnns(
      [req("B0X1", "AMG", "BPC")],
      existing([["AMG-BPC", [999]]]),
    );
    expect(r[0].kind).toBe("overflow");
    expect((r[0] as any).detail).toMatch(/999/);
    expect((r[0] as any).bucket).toBe("AMG-BPC");
  });

  it("bucket at 999, batch of 3 in that bucket → all 3 error (cursor doesn't advance on overflow)", () => {
    const r = assignNnns(
      [
        req("B01", "AMG", "BPC"),
        req("B02", "AMG", "BPC"),
        req("B03", "AMG", "BPC"),
      ],
      existing([["AMG-BPC", [999]]]),
    );
    expect(r.map((o) => o.kind)).toEqual(["overflow", "overflow", "overflow"]);
  });

  it("one bucket overflows, other buckets in same batch still assign correctly", () => {
    const r = assignNnns(
      [
        req("B01", "AMG", "BPC"), // overflow
        req("B02", "KAR", "GRO"), // assigned 1
        req("B03", "AMG", "BPC"), // overflow again
        req("B04", "PAT", "SPO"), // assigned 1
      ],
      existing([["AMG-BPC", [999]]]),
    );
    expect(r[0].kind).toBe("overflow");
    expect((r[1] as any).nnn).toBe(1);
    expect(r[2].kind).toBe("overflow");
    expect((r[3] as any).nnn).toBe(1);
  });

  it("bucket at 998, batch of 2 in that bucket → 999 assigned, then overflow", () => {
    const r = assignNnns(
      [req("B01", "AMG", "BPC"), req("B02", "AMG", "BPC")],
      existing([["AMG-BPC", [998]]]),
    );
    expect((r[0] as any).nnn).toBe(999);
    expect(r[1].kind).toBe("overflow");
  });
});

// ============================================================================
// Determinism + purity
// ============================================================================
// ============================================================================
// Integration: allocator → buildSku — NNN integer must format as 3-digit
// zero-padded segment in the final SKU string. Pins the contract between
// the two modules so a change to either can't silently produce malformed
// (e.g. "AMG-BPC-X35-RRC-1" instead of "AMG-BPC-X35-RRC-001").
// ============================================================================
describe("integration: assignNnns output → buildSku produces fixed-width NNN", () => {
  function buildFromAllocation(nnn: number, variant?: string): string {
    return buildSku({
      brd: "AMG",
      dep: "BPC",
      asin: "B0FCM6CX8M",
      ttl: "RRC",
      nnn,
      variantSuffix: variant,
    });
  }

  it("allocator returns 1 → SKU segment is '001'", () => {
    const alloc = assignNnns([{ asin: "B0X", brandCode: "AMG", deptCode: "BPC" }], new Map());
    expect(alloc[0].kind).toBe("assigned");
    const nnn = (alloc[0] as any).nnn;
    expect(nnn).toBe(1);
    const sku = buildFromAllocation(nnn);
    expect(sku).toBe("AMG-BPC-X8M-RRC-001");
    expect(sku.split("-")[4]).toBe("001");
  });

  it("allocator returns 42 → SKU segment is '042'", () => {
    const sku = buildFromAllocation(42);
    expect(sku).toBe("AMG-BPC-X8M-RRC-042");
  });

  it("allocator returns 100 → SKU segment is '100' (no padding needed at 3 digits)", () => {
    const sku = buildFromAllocation(100);
    expect(sku).toBe("AMG-BPC-X8M-RRC-100");
  });

  it("allocator returns 999 → SKU segment is '999' (upper bound, valid)", () => {
    const sku = buildFromAllocation(999);
    expect(sku).toBe("AMG-BPC-X8M-RRC-999");
  });

  it("sequential allocator output → all SKUs end in zero-padded 3-digit NNN", () => {
    const allocs = assignNnns(
      [
        { asin: "B0A", brandCode: "AMG", deptCode: "BPC" },
        { asin: "B0B", brandCode: "AMG", deptCode: "BPC" },
        { asin: "B0C", brandCode: "AMG", deptCode: "BPC" },
      ],
      new Map(),
    );
    const skus = allocs.map((a) => buildFromAllocation((a as any).nnn));
    expect(skus).toEqual([
      "AMG-BPC-X8M-RRC-001",
      "AMG-BPC-X8M-RRC-002",
      "AMG-BPC-X8M-RRC-003",
    ]);
    // Every NNN segment is exactly 3 chars
    for (const sku of skus) expect(sku.split("-")[4]).toHaveLength(3);
  });

  it("allocator output round-trips through parseConformingSku (sanity)", () => {
    // If buildSku produces a properly-formatted SKU from allocator output,
    // parseConformingSku must accept it and recover the original NNN.
    const alloc = assignNnns([{ asin: "B0X", brandCode: "AMG", deptCode: "BPC" }], new Map());
    const nnn = (alloc[0] as any).nnn;
    const sku = buildFromAllocation(nnn);
    const parsed = parseConformingSku(sku);
    expect(parsed).not.toBeNull();
    expect(parsed!.nnn).toBe(nnn);
    expect(parsed!.brd).toBe("AMG");
    expect(parsed!.dep).toBe("BPC");
  });
});

describe("assignNnns — determinism", () => {
  it("same input → same output (pure function)", () => {
    const reqs = [req("B0A", "AMG", "BPC"), req("B0B", "KAR", "GRO")];
    const ex = existing([["AMG-BPC", [3]]]);
    const r1 = assignNnns(reqs, ex);
    const r2 = assignNnns(reqs, ex);
    expect(r1).toEqual(r2);
  });

  it("does NOT mutate the existing map", () => {
    const ex = existing([["AMG-BPC", [5]]]);
    const before = new Set(ex.get("AMG-BPC")!);
    assignNnns([req("B0X", "AMG", "BPC"), req("B0Y", "AMG", "BPC")], ex);
    expect(ex.get("AMG-BPC")).toEqual(before); // unchanged
  });
});
