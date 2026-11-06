import { describe, it, expect } from "vitest";
import { titlePackSuggestion } from "./pack-parse";

// The title's pack as an unconfirmed suggestion for a pack not known (Maria 2026-11-06).
describe("titlePackSuggestion", () => {
  it("reads Pack of N / N Pack / N Count; 1 is individual; nothing stated is no suggestion", () => {
    expect(titlePackSuggestion("Jolly Rancher Hard Candy, Pack of 2")).toMatchObject({ sold_as: "multi-pack", units_per_pack: 2, text: expect.stringMatching(/Pack of 2/i) });
    expect(titlePackSuggestion("Sparkling Water 6 Pack")).toMatchObject({ sold_as: "multi-pack", units_per_pack: 6 });
    expect(titlePackSuggestion("Pens, 12 Count")).toMatchObject({ sold_as: "multi-pack", units_per_pack: 12 });
    expect(titlePackSuggestion("Candle (Pack of 1)")).toMatchObject({ sold_as: "individual", units_per_pack: 1 });
    expect(titlePackSuggestion("PAW Patrol Recycle Truck")).toBeNull();
    expect(titlePackSuggestion(null)).toBeNull();
  });
});
