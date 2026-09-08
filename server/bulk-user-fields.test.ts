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

// §21 resolution chain (2026-09-08): explicit column > Notes "Lead date
// MM/DD/YYYY" > NOW()-fallback, one parser for both inputs. THREE DISTINCT
// dates on purpose — the 42f0f42 same-date fixture couldn't distinguish
// "parsed from CSV" from "everything stamped upload day".
import { resolveAddedAt, extractPromoFromNotes } from "./bulk-lists";

describe("resolveAddedAt — §21 lead-date resolution chain", () => {
  const local = (m: number, d: number, y: number) => new Date(y, m - 1, d).getTime();

  it("three DISTINCT column dates each land distinctly (column source)", () => {
    const rows = [
      resolveAddedAt("08/02/2026", "Lead date 09/02/2026 | stuff"),
      resolveAddedAt("08/12/2026", "Lead date 09/02/2026 | stuff"),
      resolveAddedAt("09/02/2026", "Lead date 09/02/2026 | stuff"),
    ];
    expect(rows.map((r) => r.source)).toEqual(["column", "column", "column"]);
    expect(rows.map((r) => r.date!.getTime())).toEqual([
      local(8, 2, 2026), local(8, 12, 2026), local(9, 2, 2026),
    ]);
    expect(new Set(rows.map((r) => r.date!.getTime())).size).toBe(3);
  });

  it("no column → Notes 'Lead date' regex, distinct dates, SAME parser (local midnight)", () => {
    const rows = [
      resolveAddedAt(null, "Lead date 08/02/2026 | Promo: X"),
      resolveAddedAt("", "Lead date 08/12/2026 | notes"),
      resolveAddedAt(undefined, "prefix | Lead date 09/02/2026"),
    ];
    expect(rows.map((r) => r.source)).toEqual(["notes", "notes", "notes"]);
    expect(rows.map((r) => r.date!.getTime())).toEqual([
      local(8, 2, 2026), local(8, 12, 2026), local(9, 2, 2026),
    ]);
    expect(rows[0].date!.getHours()).toBe(0); // local midnight, never UTC
  });

  it("explicit column beats the Notes date", () => {
    const r = resolveAddedAt("08/02/2026", "Lead date 09/02/2026");
    expect(r.source).toBe("column");
    expect(r.date!.getTime()).toBe(local(8, 2, 2026));
  });

  it("unparseable column falls through to Notes; both bad → fallback with raw preserved", () => {
    expect(resolveAddedAt("13/45/2026", "Lead date 09/02/2026").source).toBe("notes");
    const f = resolveAddedAt("garbage", "no lead date here");
    expect(f).toEqual({ date: null, source: "fallback", raw: "garbage" });
    expect(resolveAddedAt(null, null)).toEqual({ date: null, source: "fallback", raw: null });
    // Rollover-rejecting parser applies to the Notes leg too — one parser.
    expect(resolveAddedAt(null, "Lead date 13/45/2026").source).toBe("fallback");
  });
});

describe("extractPromoFromNotes — explicit value only", () => {
  it("takes the value up to the next ' | ' delimiter", () => {
    expect(extractPromoFromNotes("Lead date 09/02/2026 | Promo: WELCOME | Newly listed")).toBe("WELCOME");
  });
  it("value at end of string works; absent/empty → null, never guesses", () => {
    expect(extractPromoFromNotes("stuff | Promo: SAVE20")).toBe("SAVE20");
    expect(extractPromoFromNotes("no promos mentioned")).toBeNull();
    expect(extractPromoFromNotes("stuff | Promo:  | more")).toBeNull();
    expect(extractPromoFromNotes(null)).toBeNull();
  });
});
