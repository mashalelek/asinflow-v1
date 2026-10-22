// ER leads sheet client (SPEC §11, patch er-leads-sheet-sync).
import { describe, it, expect } from "vitest";
import { ER_HEADERS, ER_TAB, erHeaderDiff, parseErValues, ErHeaderDriftError } from "./er-leads-sheet";

const row = (o: Record<number, string>) => Array.from({ length: 39 }, (_, i) => o[i] ?? "");

describe("ER leads sheet client", () => {
  it("tab Leads, 39 headers A–AM as the pre-flight read them (F blank)", () => {
    expect(ER_TAB).toBe("Leads");
    expect(ER_HEADERS).toHaveLength(39);
    expect(ER_HEADERS[5]).toBe("");
    expect([ER_HEADERS[0], ER_HEADERS[1], ER_HEADERS[2], ER_HEADERS[7], ER_HEADERS[8], ER_HEADERS[12], ER_HEADERS[35], ER_HEADERS[38]])
      .toEqual(["Approved", "Date", "ASIN", "Buy Link", "Coupons/Gift Cards", "Cost Price", "Emelie", "Maria"]);
  });
  it("header tripwire: exact match passes (whitespace trimmed); a moved, renamed or extra column throws with the diff", () => {
    expect(erHeaderDiff(ER_HEADERS.map((h) => ` ${h} `))).toEqual([]);
    const moved = [...ER_HEADERS]; moved[12] = "Cost"; moved.push("New col");
    expect(erHeaderDiff(moved)).toEqual(['M: expected "Cost Price", found "Cost"', 'AN: unexpected "New col"']);
    expect(() => parseErValues([moved, row({ 2: "B0TEST0001" })])).toThrow(ErHeaderDriftError);
    expect(() => parseErValues([])).toThrow(/header drift/);
  });
  it("rows: the patch's columns, trimmed, ASIN upper-cased, COGS via parseMoney, blank ASIN skipped, sheet row numbers kept", () => {
    const rows = parseErValues([
      [...ER_HEADERS],
      row({ 0: " Yes ", 1: "2026-10-21", 2: " b0test0001 ", 7: "https://shop.example.com/p?ref=x", 8: "10% WELCOME", 12: "$12.49", 35: "check size", 38: "good one" }),
      row({ 0: "Yes", 1: "2026-10-21" }),
      row({ 0: "No", 1: "bad", 2: "B0TEST0002", 12: "n/a" }),
    ]);
    expect(rows).toEqual([
      { row: 2, asin: "B0TEST0001", approvedRaw: "Yes", dateRaw: "2026-10-21", buyLink: "https://shop.example.com/p?ref=x", promoNotes: "10% WELCOME", cogs: 12.49, vaNotes: "check size", myNotes: "good one" },
      { row: 4, asin: "B0TEST0002", approvedRaw: "No", dateRaw: "bad", buyLink: null, promoNotes: null, cogs: null, vaNotes: null, myNotes: null },
    ]);
  });
});
