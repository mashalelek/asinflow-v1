// PO tracking routing rules + the "Review Velocity" action item (SPEC §26, patch commit 4).
import { describe, it, expect } from "vitest";
import { routeTracking, joinReasons, REASON } from "./tracking-route-rules";
import { unionActionItems, asinWriteThrough, PO_ACTION_ITEMS_SQL, REVIEW_VELOCITY_EXISTS_SQL } from "./po-action-items";
import { normalizeActionItems, REVIEW_VELOCITY, ACTION_ITEMS } from "./po-status-map";

const base = { velocityStreet: "805 grandy", homeStreets: ["65 rivercrest"], poCanceledOrReturned: false };
const r = (inVelocity: boolean, emailStreet: string | null, shipsTo: "velocity" | "home") => routeTracking({ ...base, velocity: inVelocity ? "inbound" : "absent", emailStreet, shipsTo });

describe("routing table (§7)", () => {
  it("in Velocity, ship-to none or agreeing on a Velocity PO → push, no warning", () => {
    expect(r(true, null, "velocity")).toEqual({ push: true, held: false, reasons: [] });
    expect(r(true, "805 grandy", "velocity")).toEqual({ push: true, held: false, reasons: [] });
  });
  it("in Velocity, an unknown street on a Velocity PO → push + address mismatch", () => {
    expect(r(true, "12 elm", "velocity")).toEqual({ push: true, held: false, reasons: [REASON.addressMismatch] });
  });
  it("hold rule: a Velocity PO whose email names the home street → held, review, never pushed (482270182, 2026-10-29)", () => {
    expect(r(true, "65 rivercrest", "velocity")).toEqual({ push: false, held: true, reasons: [REASON.addressMismatch] });
  });
  it("hold rule, reverse: a Home PO whose email names the Velocity street → held, review", () => {
    expect(r(true, "805 grandy", "home")).toEqual({ push: false, held: true, reasons: [REASON.homeInVelocity, REASON.addressMismatch] });
  });
  it("a Home PO is never pushed, even when Velocity has an order for it — review only (2026-10-29)", () => {
    for (const street of [null, "65 rivercrest", "12 elm"]) {
      expect(r(true, street, "home")).toEqual({ push: false, held: false, reasons: [REASON.homeInVelocity] });
    }
  });
  it("not in Velocity: Velocity street / none on a Velocity PO / ships_to velocity → not in Velocity", () => {
    expect(r(false, "805 grandy", "home").reasons).toEqual([REASON.notInVelocity]);
    expect(r(false, null, "velocity").reasons).toEqual([REASON.notInVelocity]);
    expect(r(false, "65 rivercrest", "velocity").reasons).toEqual([REASON.notInVelocity]);
  });
  it("not in Velocity, home street — or no street — on a home PO → held, no warning (Maria 2026-10-22)", () => {
    expect(r(false, "65 rivercrest", "home")).toEqual({ push: false, held: true, reasons: [] });
    expect(r(false, null, "home")).toEqual({ push: false, held: true, reasons: [] });
  });
  it("not in Velocity, unknown street → unknown address (and not-in-Velocity too on a Velocity PO)", () => {
    expect(r(false, "12 elm", "home").reasons).toEqual([REASON.unknownAddress]);
    expect(r(false, "12 elm", "velocity").reasons).toEqual([REASON.notInVelocity, REASON.unknownAddress]);
    expect(joinReasons(r(false, "12 elm", "velocity").reasons)).toBe("not in Velocity; unknown address");
  });
  it("a canceled / returned PO → shipped but canceled, never pushed", () => {
    expect(routeTracking({ ...base, poCanceledOrReturned: true, velocity: "inbound", emailStreet: null, shipsTo: "velocity" })).toEqual({ push: false, held: false, reasons: [REASON.canceled] });
  });
  it("stop b: a PO Velocity already received / shipped (known, not inbound) → no push, no warning — whatever the address", () => {
    for (const street of [null, "805 grandy", "65 rivercrest", "12 elm"]) {
      expect(routeTracking({ ...base, velocity: "known", emailStreet: street, shipsTo: "velocity" })).toEqual({ push: false, held: false, reasons: [] });
    }
  });
});

describe("Review Velocity — auto-managed, stored per line by the mirror only (PO table v2)", () => {
  it("shows after the manual items in the union", () => {
    expect(unionActionItems([["See comments", REVIEW_VELOCITY, "ATTN: Velocity"]])).toEqual(["ATTN: Velocity", "See comments", REVIEW_VELOCITY]);
  });
  it("the editors drop it rather than refuse, and never write it to lines", () => {
    expect(normalizeActionItems(["SHIP", REVIEW_VELOCITY])).toEqual({ ok: true, value: ["SHIP"] });
    const lines = [{ id: "l1", action_items: ["SHIP"] }];
    expect(asinWriteThrough(lines, ["SHIP", REVIEW_VELOCITY]).size).toBe(0);
    expect(ACTION_ITEMS as readonly string[]).not.toContain(REVIEW_VELOCITY); // not in the CHECK list
  });
  it("derived from open, unsuppressed review reasons on the PO's tracking rows", () => {
    expect(REVIEW_VELOCITY_EXISTS_SQL).toMatch(/t\.review_reason IS NOT NULL AND t\.suppressed_at IS NULL/);
    // the PO union reads it from po_line_action_items, where reconcileReviewVelocity puts it
    expect(PO_ACTION_ITEMS_SQL).not.toMatch(/UNION SELECT 'Review Velocity'/);
    expect(PO_ACTION_ITEMS_SQL).toMatch(/FROM po_line_action_items ai JOIN po_line_items l ON l\.id = ai\.po_line_item_id WHERE ai\.cleared_at IS NULL AND l\.po_id = p\.id/);
  });
});
