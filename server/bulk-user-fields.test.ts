import { describe, it, expect } from "vitest";

// §21 bulk user-controlled fields (2026-09-04): the Date Added backdate
// parser (local-midnight M/D/YYYY — never UTC midnight — plus ISO for the
// export round-trip) and the alias exact-match guarantee that makes the
// broad "date"/"added" aliases safe.
import { parseAddedAt } from "./bulk-lists";

describe("parseAddedAt — §21 Date Added backdate", () => {
  it("M/D/YYYY parses as LOCAL midnight, so 09/02/2026 renders 09/02/2026", () => {
    const d = parseAddedAt("09/02/2026")!;
    // Round-trip through the Date Added cell formatter (local getters):
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth() + 1).toBe(9);
    expect(d.getDate()).toBe(2);
    expect(d.getHours()).toBe(0); // local midnight — NOT UTC midnight
  });

  it("unpadded M/D/YYYY works", () => {
    const d = parseAddedAt("9/2/2026")!;
    expect([d.getMonth() + 1, d.getDate(), d.getFullYear()]).toEqual([9, 2, 2026]);
  });

  it("ISO timestamps parse (Export CSV emits ISO — export → re-upload round-trips)", () => {
    const orig = parseAddedAt("09/02/2026")!;
    const roundTripped = parseAddedAt(orig.toISOString())!;
    expect(roundTripped.getTime()).toBe(orig.getTime());
    expect([roundTripped.getMonth() + 1, roundTripped.getDate()]).toEqual([9, 2]);
  });

  it("absent/blank/garbage → null (caller falls back to NOW(); the row never fails)", () => {
    expect(parseAddedAt(null)).toBeNull();
    expect(parseAddedAt("")).toBeNull();
    expect(parseAddedAt("  ")).toBeNull();
    expect(parseAddedAt("not a date")).toBeNull();
    expect(parseAddedAt("13/45/2026")).toBeNull();
  });
});
