import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lineReceivedShown } from "./po-edit";

// Products → Received from Velocity's count (Maria 2026-11-05): Velocity POs show Velocity's received in retailer units.
const line = (o: Record<string, unknown> = {}) => ({ qty_received: null, asin_qty_per_product: null, retailer_units_per_product: 1, asin_units_per_pack: 2, ...o });

describe("lineReceivedShown", () => {
  it("200015557295492: one line, 5.5 two-packs checked in → 11 singles of 12", () => {
    const r = lineReceivedShown(line() as any, { received_velocity: "5.50", lines: [{}] }, "velocity");
    expect(r).toMatchObject({ fromVelocity: true, value: 11 });
    expect(r.title).toBe("From Velocity: 5.5 ASIN units received × 2 ÷ 1 = 11 retailer units");
  });
  it("a bundle-style yield (6 retailer units make 1 ASIN unit) divides the other way", () => {
    expect(lineReceivedShown(line({ retailer_units_per_product: 6, asin_units_per_pack: 1 }) as any, { received_velocity: 3, lines: [{}] }, "velocity").value).toBe(0.5);
  });
  it("a line without the two integers uses its stored yield", () => {
    expect(lineReceivedShown(line({ retailer_units_per_product: null, asin_units_per_pack: null, asin_qty_per_product: "0.5" }) as any, { received_velocity: 5, lines: [{}] }, "velocity").value).toBe(10);
  });
  it("several lines share one Velocity order: blank lines, the total named on hover; nothing checked in yet → blank", () => {
    const r = lineReceivedShown(line({ qty_received: 4 }) as any, { received_velocity: 6, lines: [{}, {}] }, "velocity");
    expect(r).toMatchObject({ fromVelocity: true, value: null });
    expect(r.title).toMatch(/6 ASIN units on the ASIN row — 2 lines share one Velocity order.*own count 4/);
    expect(lineReceivedShown(line() as any, { received_velocity: null, lines: [{}] }, "velocity")).toMatchObject({ value: null, title: "From Velocity: nothing checked in yet" });
  });
  it("a home PO keeps its own count (editable)", () => {
    expect(lineReceivedShown(line({ qty_received: 7 }) as any, { received_velocity: 5.5, lines: [{}] }, "home")).toEqual({ fromVelocity: false, value: 7 });
    expect(lineReceivedShown(line() as any, { received_velocity: 5.5, lines: [{}] }, null)).toEqual({ fromVelocity: false, value: null });
  });
  it("the Products tab is handed the PO's ships_to", () => {
    expect(readFileSync("client/src/pages/purchase-orders.tsx", "utf8")).toMatch(/<PoProductsTable [^>]*shipsTo=\{po\.ships_to\}/);
  });
});
