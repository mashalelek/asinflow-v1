import { describe, it, expect } from "vitest";
import { anyBuyable } from "./live-offer-check";

// §23 Repricer Phase 1b (2026-09-15): "SC-Active" = a listing carrying a
// BUYABLE offer. These pin the ONE distinction the whole view rests on —
// has_live_offer is TRUE for any existing listing record (Inactive
// included, §18), has_buyable_offer only for a purchasable one.
describe("anyBuyable — the SC-Active signal", () => {
  it("TRUE when any SKU's status array contains BUYABLE", () => {
    expect(anyBuyable([["DISCOVERABLE", "BUYABLE"]])).toBe(true);
    expect(anyBuyable([["DISCOVERABLE"], ["BUYABLE"]])).toBe(true); // any SKU
  });

  it("FALSE for a DISCOVERABLE-only listing — the born-closed / Inactive case", () => {
    // This is exactly the row has_live_offer would call TRUE: the listing
    // record exists, the offer is not purchasable. Born-closed offers whose
    // inventory checked in but which were never reopened live here.
    expect(anyBuyable([["DISCOVERABLE"]])).toBe(false);
  });

  it("FALSE for empty / missing status (a just-created SKU 200s with no status)", () => {
    expect(anyBuyable([[]])).toBe(false);
    expect(anyBuyable([null])).toBe(false);
    expect(anyBuyable([undefined])).toBe(false);
    expect(anyBuyable([])).toBe(false);
  });

  it("is case-insensitive (Amazon's casing is not contractual)", () => {
    expect(anyBuyable([["buyable"]])).toBe(true);
  });

  it("does NOT match substrings — only the exact status token", () => {
    expect(anyBuyable([["NOT_BUYABLE_REASON"]])).toBe(false);
  });
});
