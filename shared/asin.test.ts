import { describe, it, expect } from "vitest";
import { ASIN_PLACEHOLDERS, cleanAsinInput, isAsinPlaceholder, isValidAsin, IS_ASIN_SQL, NO_ASIN_SQL, VALID_ASIN_SQL_RE, VALID_ASIN_RE } from "./asin";

// shared/asin.ts (Maria 2026-11-14): "a valid ASIN: 10 chars, B0… or an ISBN-10"; placeholder text is not an ASIN.
describe("isValidAsin", () => {
  it("accepts B0 + 8 and an ISBN-10, nothing else", () => {
    for (const a of ["B0H1J8WN3F", "B000000001", "B0CF3VL5QL", "0306406152", "080442957X"]) expect(isValidAsin(a), a).toBe(true);
    for (const a of ["NA", "KOOKABURRA", "B0H1J8WN3", "B0H1J8WN3FX", "b0h1j8wn3f", "ZZPOCOST01", "A0H1J8WN3F", "080442957x", "", null, undefined, 12]) expect(isValidAsin(a as any), String(a)).toBe(false);
  });
  it("the SQL regex is the JS regex", () => {
    expect(VALID_ASIN_SQL_RE).toBe(VALID_ASIN_RE.source.replace("(?:", "("));
    expect(IS_ASIN_SQL("pa.asin")).toBe(`pa.asin ~ '${VALID_ASIN_SQL_RE}'`);
    expect(NO_ASIN_SQL("pa.asin")).toBe(`pa.asin !~ '${VALID_ASIN_SQL_RE}'`);
    expect(VALID_ASIN_SQL_RE).not.toContain("'");
  });
});

describe("placeholders", () => {
  it("NA / N/A / none / tbd and the dash-question-x shapes are placeholders; blanks and ASIN-like text are not", () => {
    for (const p of ["NA", "na", " n/a ", "None", "TBD", "tba", "unknown", "pending", "no asin", "-", "--", "—", "?", "???", "x", "XXX", "0", "000"]) expect(isAsinPlaceholder(p), p).toBe(true);
    for (const p of ["", "   ", "B0H1J8WN3F", "KOOKABURRA", "B0H1", "nap", "tbdx", "0306406152"]) expect(isAsinPlaceholder(p), JSON.stringify(p)).toBe(false);
    expect(ASIN_PLACEHOLDERS.has("NA")).toBe(true);
  });
  it("cleanAsinInput: trims and upper-cases; a placeholder becomes the empty field", () => {
    expect(cleanAsinInput(" b0h1j8wn3f ")).toBe("B0H1J8WN3F");
    expect(cleanAsinInput("NA")).toBe("");
    expect(cleanAsinInput("n/a")).toBe("");
    expect(cleanAsinInput("tbd")).toBe("");
    expect(cleanAsinInput("")).toBe("");
    expect(cleanAsinInput(null)).toBe("");
    expect(cleanAsinInput("kookaburra")).toBe("KOOKABURRA"); // not a placeholder: the shape check rejects it with its own message
  });
});
