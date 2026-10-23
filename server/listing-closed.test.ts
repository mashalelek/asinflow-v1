// The closed test (listing-hygiene amendment 2026-10-23): end_at's form plus
// AF's own close PATCH; BUYABLE always open. Shapes from the 2026-10-23 probe.
import { describe, it, expect } from "vitest";
import { isOfferClosed, isBornClosedLiteral } from "./listing-closed";
import { evaluateClose, evaluateDelete, fireClose, fireDelete, verifyListingActions, type Basis } from "./listing-hygiene";
import { facts, fakeSc } from "./listing-hygiene.test-fixtures";
import { hygieneDeps } from "./listing-hygiene-run";

const NOW = new Date("2026-10-23T20:00:00Z");
const PASS = new Date("2026-10-19T13:00:00Z");
const basis: Basis = { now: new Date("2026-10-19T14:00:00Z"), inventoryFrom: PASS, listingFrom: PASS };
const CREATED = "2026-10-22T22:42:44.376Z"; // LIN-GRO-4SQ-CBS-001

describe("isOfferClosed", () => {
  it("the literal is recognised as Amazon echoes it and as the DB stores it", () => {
    expect(isBornClosedLiteral("2000-01-01")).toBe(true);
    expect(isBornClosedLiteral(new Date("2000-01-01T00:00:00Z"))).toBe(true);
    expect(isBornClosedLiteral("2000-01-01T00:00:00.000Z")).toBe(true);
    expect(isBornClosedLiteral("2026-10-19T09:31:29.082Z")).toBe(false);
    expect(isBornClosedLiteral(null)).toBe(false);
  });
  it("a real close timestamp → closed (PRK-HOM-6P4-PIC-001, closed in SC)", () => {
    expect(isOfferClosed({ endAt: "2026-10-19T09:31:29.082Z", createdAt: "2026-09-18T20:29:43.610Z" }, NOW)).toBe(true);
  });
  it("the literal with no AF close PATCH → NOT closed (the create-only SKUs SC shows Out of stock)", () => {
    expect(isOfferClosed({ endAt: "2000-01-01", createdAt: CREATED, closePatchAt: null }, NOW)).toBe(false);
  });
  it("the literal with an accepted AF close PATCH after the latest creation → closed (RHO-BPC-6WB-PLS-002)", () => {
    expect(isOfferClosed({ endAt: "2000-01-01", createdAt: "2026-09-02T18:06:53Z", closePatchAt: "2026-10-20T11:05:20Z" }, NOW)).toBe(true);
  });
  it("a PATCH from BEFORE the latest creation does not count (the SKU was re-created since)", () => {
    expect(isOfferClosed({ endAt: "2000-01-01", createdAt: "2026-10-22T22:42:00Z", closePatchAt: "2026-10-20T11:05:20Z" }, NOW)).toBe(false);
  });
  it("BUYABLE → open, whatever end_at says", () => {
    expect(isOfferClosed({ endAt: "2026-10-19T09:31:29.082Z", buyable: true }, NOW)).toBe(false);
    expect(isOfferClosed({ endAt: "2000-01-01", buyable: true, closePatchAt: "2026-10-23T00:00:00Z", createdAt: CREATED }, NOW)).toBe(false);
  });
  it("null → open; a future end date → open", () => {
    expect(isOfferClosed({ endAt: null }, NOW)).toBe(false);
    expect(isOfferClosed({ endAt: "2027-01-01T00:00:00Z" }, NOW)).toBe(false);
  });
});

describe("component 22 / 24 with the closed test", () => {
  const lit = new Date("2000-01-01T00:00:00Z");
  it("literal without PATCH → not closed → component 22 closes it at 0 stock", () => {
    expect(evaluateClose(facts({ listing: { ...facts().listing, offerEndAt: lit, closePatchAt: null } }), basis).outcome).toBe("would_close");
  });
  it("literal with an AF close PATCH → skip_already_closed", () => {
    expect(evaluateClose(facts({ listing: { ...facts().listing, offerEndAt: lit, closePatchAt: new Date("2026-10-18T00:00:00Z") } }), basis).outcome).toBe("skip_already_closed");
  });
  it("real timestamp → skip_already_closed", () => {
    expect(evaluateClose(facts({ listing: { ...facts().listing, offerEndAt: new Date("2026-10-15T01:55:12Z") } }), basis).outcome).toBe("skip_already_closed");
  });
  it("delete requires closed: a create-only literal is skip_not_closed until 22 closes it", () => {
    expect(evaluateDelete(facts({ listing: { ...facts().listing, offerEndAt: lit, closePatchAt: null } }), basis).outcome).toBe("skip_not_closed");
  });
  it("fire pre-flight (live read): literal without PATCH → the PATCH is sent; literal with PATCH → skip_already_closed; BUYABLE → sent", async () => {
    let sc = fakeSc({ "SKU-1": { end: "2000-01-01" } });
    expect((await fireClose("SELLER", "SKU-1", hygieneDeps.sc, NOW)).outcome).toBe("closed");
    expect(sc.patches).toHaveLength(1);
    sc = fakeSc({ "SKU-1": { end: "2000-01-01" } });
    expect((await fireClose("SELLER", "SKU-1", hygieneDeps.sc, NOW, { closePatchAt: new Date("2026-10-20T00:00:00Z") })).outcome).toBe("skip_already_closed");
    expect(sc.patches).toHaveLength(0);
    sc = fakeSc({ "SKU-1": { end: "2000-01-01" } });
    expect((await fireDelete("SELLER", "SKU-1", hygieneDeps.sc, NOW)).outcome).toBe("skip_not_closed");
    expect(sc.deletes).toHaveLength(0);
  });
  it("close verification: the literal read back after THIS action's PATCH verifies it", async () => {
    const updates: any[] = [];
    const query = async (sql: string, params: any[] = []) => {
      if (sql.includes("FROM listing_actions la")) return { rows: [{ id: 1, action: "close", verify_passes: 0, fired_at: "2026-10-23T19:00:00Z", listing_checked_at: "2026-10-23T19:30:00Z", listing_created_at: CREATED, offer_end_at: "2000-01-01T00:00:00Z" }] };
      updates.push({ sql, params }); return { rows: [] };
    };
    expect(await verifyListingActions(query as any, new Date("2026-10-23T19:00:00Z"))).toMatchObject({ verified: 1 });
  });
});
