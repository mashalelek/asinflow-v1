import { describe, expect, it } from "vitest";
import { confirmableAsins, packFilterMatch, packReviewOrder } from "./pack-filter";
import type { AsinPack } from "@shared/schema";

const pk = (o: Partial<AsinPack>): AsinPack => ({ soldAs: null, units: null, source: null, suggestedSoldAs: null, suggestedUnits: null, suggestionSource: null, reason: null, note: null, hasPo: false, ...o });
const confirmed = { asin: "A1", pack: pk({ soldAs: "individual", units: 1, source: "po" }) };
const review = { asin: "A2", pack: pk({ suggestedSoldAs: "multi-pack", suggestedUnits: 2, reason: "suggestion" }) };
const reviewPo = { asin: "A3", pack: pk({ suggestedSoldAs: "individual", suggestedUnits: 1, reason: "suggestion", hasPo: true }) };
const conflict = { asin: "A4", pack: pk({ reason: "po_conflict" }) };
const missing = { asin: "A5", pack: pk({ reason: "nothing" }) };
const bare: { asin: string; pack?: AsinPack } = { asin: "A6" };

describe("pack filter", () => {
  it("matches by status; a conflict with no suggestion still needs review; no pack data is missing", () => {
    expect([confirmed, review, reviewPo, conflict, missing, bare].filter((r) => packFilterMatch(r, "needs_review")).map((r) => r.asin)).toEqual(["A2", "A3", "A4"]);
    expect([confirmed, review, missing, bare].filter((r) => packFilterMatch(r, "missing")).map((r) => r.asin)).toEqual(["A5", "A6"]);
    expect([confirmed, review].filter((r) => packFilterMatch(r, "")).length).toBe(2);
  });
  it("needs review puts PO / Buy List / on hold first, keeping each group's order", () => {
    const rows = [review, conflict, reviewPo, missing];
    expect(packReviewOrder(rows, "needs_review", new Set(["A4"]), new Set()).map((r) => r.asin)).toEqual(["A4", "A3", "A2", "A5"]);
    expect(packReviewOrder(rows, "needs_review", new Set(), new Set(["A5"])).map((r) => r.asin)).toEqual(["A3", "A5", "A2", "A4"]);
    expect(packReviewOrder(rows, "confirmed", new Set(["A4"]), new Set())).toBe(rows);
  });
  it("Confirm takes only selected rows with a suggestion", () => {
    expect(confirmableAsins([confirmed, review, reviewPo, conflict], new Set(["A1", "A2", "A4"]))).toEqual(["A2"]);
  });
});
