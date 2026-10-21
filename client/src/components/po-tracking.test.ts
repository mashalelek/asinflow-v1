// PO tracking UI helpers (SPEC §26, patch commit 6).
import { describe, it, expect } from "vitest";
import { carrierTrackingUrl, pickPo } from "./po-tracking";
import { DISPLAY_ACTION_ITEMS, ACTION_ITEM_OPTIONS } from "./po-asin-rows";

describe("po-tracking helpers", () => {
  it("carrier tracking pages; OTHER has none", () => {
    expect(carrierTrackingUrl("UPS", "1ZE3652C0344289436")).toBe("https://www.ups.com/track?tracknum=1ZE3652C0344289436");
    expect(carrierTrackingUrl("FEDEX", "878643981912")).toBe("https://www.fedex.com/fedextrack/?trknbr=878643981912");
    expect(carrierTrackingUrl("USPS", "9200190288079111507345")).toMatch(/usps\.com.*tLabels=9200190288079111507345/);
    expect(carrierTrackingUrl("OTHER", "x")).toBeNull();
  });
  it("pickPo: exact order #, punctuation-insensitive; none or several → an error to show", () => {
    const pos = [{ id: "a", order_id: "200015328073060", supplier: "walmart.com" }, { id: "b", order_id: "4798028553", supplier: "macys.com" }, { id: "c", order_id: "47980285530", supplier: "macys.com" }];
    expect(pickPo(pos, "2000153-28073060")).toEqual(pos[0]);
    expect(pickPo(pos, "4798028553")).toEqual(pos[1]);
    expect(pickPo(pos, "999")).toEqual({ error: "no PO with order # 999" });
  });
  it("Review Velocity is displayed, never offered in the editor", () => {
    expect(DISPLAY_ACTION_ITEMS).toContain("Review Velocity");
    expect(ACTION_ITEM_OPTIONS).not.toContain("Review Velocity");
  });
});
