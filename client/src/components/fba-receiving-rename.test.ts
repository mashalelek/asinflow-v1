// "Receiving mismatch" → "FBA receiving mismatch" (Maria 2026-11-07): the
// label everywhere, its hover, and a saved list URL with the old label.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DISPLAY_ACTION_ITEMS, FBA_RECEIVING_MISMATCH, fbaReceivingTitle } from "./po-asin-rows";
import { RECEIVING_MISMATCH, DISPLAY_ACTION_ITEMS as SERVER_DISPLAY } from "../../../server/po-status-map";
import { parsePoListFilters } from "../../../server/po-list-filters";
import { readPoListUrl, writePoListUrl } from "@/lib/po-list-url";

describe("FBA receiving mismatch", () => {
  it("is the label on both sides, in the display order (filter options, chips)", () => {
    expect(RECEIVING_MISMATCH).toBe("FBA receiving mismatch");
    expect(FBA_RECEIVING_MISMATCH).toBe(RECEIVING_MISMATCH);
    expect(DISPLAY_ACTION_ITEMS).toContain("FBA receiving mismatch");
    expect(SERVER_DISPLAY).toContain("FBA receiving mismatch");
    expect([...DISPLAY_ACTION_ITEMS, ...SERVER_DISPLAY]).not.toContain("Receiving mismatch");
  });

  it("hover says what it means: Received by Amazon ≠ Shipped FBA", () => {
    expect(fbaReceivingTitle({ qty_shipped_fba: "15.00", qty_received_amazon: "13.00" })).toBe("Received by Amazon 13 ≠ Shipped FBA 15, in ASIN units (information only; never blocks auto-close)");
    expect(readFileSync("client/src/components/po-asin-rows.tsx", "utf8")).toMatch(/withMeaning\(it, lineDetailTitle\(it, d\)\)/);
  });

  it("a saved list URL with the old label reads as the new one and is rewritten once", () => {
    const s = readPoListUrl("?action=Receiving%20mismatch,SHIP");
    expect(s.action).toEqual(["FBA receiving mismatch", "SHIP"]);
    expect(writePoListUrl(s)).toBe("?action=FBA+receiving+mismatch%2CSHIP");
    expect(readPoListUrl("?action=Receiving%20mismatch,FBA%20receiving%20mismatch").action).toEqual(["FBA receiving mismatch"]);
  });

  it("the server filter maps the old label too", () => {
    expect(parsePoListFilters({ action: "Receiving mismatch" }).action).toEqual(["FBA receiving mismatch"]);
  });
});
