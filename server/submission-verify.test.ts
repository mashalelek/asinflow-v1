import { describe, it, expect } from "vitest";
import {
  classifyListingState,
  extractConflictAsin,
  probeListingState,
  type ListingStateInput,
} from "./submission-verify";

// `listed` (§18 A1) defaults to `found` here: for every pre-existing case in
// this file a 200 came with a real summary, so found and listed agree. The
// shell case — found WITHOUT listed — is covered explicitly in
// listing-shell-a1.test.ts.
const base = (o: Partial<ListingStateInput>): ListingStateInput => ({
  found: false, status: [], hasOffer: false, issues: [], listed: o.found ?? false, ...o,
});

describe("classifyListingState — the 5 adjustments + real batch cases", () => {
  it("DISCOVERABLE + offer, no issues → LIVE (B00QLAAV5M)", () => {
    const c = classifyListingState(base({ found: true, status: ["DISCOVERABLE"], hasOffer: true }));
    expect(c.status).toBe("live");
    expect(c.reviewFlags).toEqual([]);
  });

  it("LIVE + ERROR 18555 advisory → LIVE with a review flag, NOT failed (B0FQKGTC6Y)", () => {
    const c = classifyListingState(base({
      found: true, status: ["DISCOVERABLE"], hasOffer: true,
      issues: [{ code: "18555", severity: "ERROR", message: "selling price appears higher than expected" }],
    }));
    expect(c.status).toBe("live");
    expect(c.reviewFlags.some((f) => f.includes("18555"))).toBe(true);
    expect(c.terminalConflict).toBe(false);
  });

  it("empty status + transient 8541, no terminal → PROCESSING (mid-processing, resolves later)", () => {
    const c = classifyListingState(base({
      found: true, status: [],
      issues: [{ code: "8541", severity: "ERROR", message: "matching conflict with B0DHVBQTLZ" }],
    }));
    expect(c.status).toBe("processing"); // NOT failed — 8541 is not in the terminal set
  });

  it("empty status + terminal 5886/13013 → FAILED (B09R7VZLV7)", () => {
    const c = classifyListingState(base({
      found: true, status: [],
      issues: [
        { code: "13013", severity: "ERROR", message: "product is not in the catalog", enforcementActions: ["LISTING_SUPPRESSED"] },
        { code: "5886", severity: "ERROR", message: "restricted generic ASIN" },
      ],
    }));
    expect(c.status).toBe("failed");
  });

  it("adjustment 1 — terminal signal ALONGSIDE a materialized listing → LIVE + prominent conflict flag, never silent", () => {
    const c = classifyListingState(base({
      found: true, status: ["DISCOVERABLE"], hasOffer: true,
      issues: [{ code: "13013", severity: "ERROR", message: "suppressed", enforcementActions: ["LISTING_SUPPRESSED"] }],
    }));
    expect(c.status).toBe("live");
    expect(c.terminalConflict).toBe(true);
    expect(c.reviewFlags[0]).toMatch(/CONFLICT/);
  });

  it("adjustment 2 — unknown ERROR code without materialization stays PROCESSING (never inferred FAILED)", () => {
    const c = classifyListingState(base({
      found: true, status: [],
      issues: [{ code: "99999", severity: "ERROR", message: "some new code we've never seen" }],
    }));
    expect(c.status).toBe("processing");
  });

  it("404 / absent (no status, no offer, no issues) → PROCESSING (B00434MRG4; STALE+manual handle it)", () => {
    expect(classifyListingState(base({ found: false })).status).toBe("processing");
  });

  it("LISTING_SUPPRESSED enforcement alone (no known code) + not materialized → FAILED", () => {
    const c = classifyListingState(base({
      found: true, status: [],
      issues: [{ code: "70000", severity: "ERROR", message: "x", enforcementActions: ["LISTING_SUPPRESSED"] }],
    }));
    expect(c.status).toBe("failed");
  });
});

describe("extractConflictAsin", () => {
  it("pulls the conflict ASIN out of an 8541-style message", () => {
    expect(extractConflictAsin([{ code: "8541", severity: "ERROR", message: "matching conflict → B0DHVBQTLZ" }]))
      .toBe("B0DHVBQTLZ");
  });
  it("returns null when no ASIN is present", () => {
    expect(extractConflictAsin([{ code: "18555", severity: "ERROR", message: "price too high" }])).toBeNull();
  });
});

describe("probeListingState — fail-closed + SKU-drift fallback", () => {
  const throttle = () => { const e: any = new Error("t"); e.response = { status: 429, data: { errors: [{ code: "QuotaExceeded" }] } }; throw e; };
  const notFound = () => { const e: any = new Error("404"); e.response = { status: 404 }; throw e; };

  it("throttle → throttled=true, no verdict written", async () => {
    const r = await probeListingState("SELLER", "B0X", "SKU-1", throttle as any);
    expect(r.throttled).toBe(true);
  });

  it("live SKU 200 → live", async () => {
    const get = async () => ({ summaries: [{ status: ["DISCOVERABLE"] }], offers: [{}], fulfillmentAvailability: [{}], issues: [] });
    const r = await probeListingState("SELLER", "B0X", "SKU-1", get as any);
    expect(r.classification.status).toBe("live");
    expect(r.throttled).toBe(false);
  });

  it("SKU 404 → falls back to ASIN search; found under drifted SKU → LIVE with observedSku", async () => {
    let call = 0;
    const get = async (endpoint: string) => {
      call++;
      if (call === 1) notFound();               // getListingsItem by SKU → 404
      return { items: [{ sku: "DRIFTED-SKU-9", summaries: [{ status: ["DISCOVERABLE"] }] }] }; // ASIN search
    };
    const r = await probeListingState("SELLER", "B0X", "SKU-1", get as any);
    expect(r.classification.status).toBe("live");
    expect(r.observedSku).toBe("DRIFTED-SKU-9");
  });

  it("SKU 404 + ASIN search empty → PROCESSING (absent, no terminal signal)", async () => {
    let call = 0;
    const get = async () => { call++; if (call === 1) notFound(); return { items: [] }; };
    const r = await probeListingState("SELLER", "B0X", "SKU-1", get as any);
    expect(r.classification.status).toBe("processing");
    expect(r.throttled).toBe(false);
  });
});
