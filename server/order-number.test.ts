import { describe, it, expect } from "vitest";
import { normOrder, orderKey, orderBaseKey, afOrderKeys, afOrderBaseKeys, baseOrderId, orderIdParts, digitForms } from "./order-number";
import { resolveRetailer, proposeAlias, editDistance, supplierLabel } from "./supplier-aliases";

// Patch docs/claude_spec-patch-po-matching.md §3 — the real Unmatched rows (2026-10-29).

describe("order-# normalization", () => {
  it("Walmart's printed form = AF's digits", () => {
    expect(orderKey("2000152-79183885")).toBe("200015279183885");
  });
  it("free-text prefixes drop", () => {
    expect(orderKey("Confirmation #G9TG5IACK")).toBe("G9TG5IACK");
    expect(orderKey("Order #W123456")).toBe("W123456");
    expect(orderKey("Order No. 55512")).toBe("55512");
    expect(orderKey("PO# 7788")).toBe("7788");
    expect(orderKey("Order 112-3344")).toBe("1123344");
    expect(normOrder("ORDERLY12")).toBe("ORDERLY12"); // a word, not a prefix
  });
  it("base key: _N / -N (1–2 digits) off, the full key keeps it", () => {
    expect(orderKey("CAR118805142_1")).toBe("CAR1188051421");
    expect(orderBaseKey("CAR118805142_1")).toBe("CAR118805142");
    expect(orderBaseKey("200014815022950_1")).toBe("200014815022950");
    expect(orderBaseKey("70633076-1")).toBe("70633076");
    expect(orderBaseKey("INSH-051526-1043381-13772482")).toBe("INSH051526104338113772482");
  });
  it("an AF order_id holding two ids yields both", () => {
    expect(afOrderKeys("115449859 / 115450009")).toEqual(["115449859", "115450009"]);
    expect(afOrderBaseKeys("CAR118805142_1")).toEqual(["CAR118805142"]);
    expect(orderIdParts("115449859 / 115450009")).toEqual(["115449859", "115450009"]);
    expect(baseOrderId("200014815022950_1")).toBe("200014815022950");
  });
  it("digit forms (tracking order-#-unique)", () => {
    expect(digitForms("70633076-1")).toEqual(["706330761", "70633076"]);
    expect(digitForms("Order #1234")).toEqual([]);
  });
});

describe("retailer → supplier", () => {
  const suppliers = ["walmart.com", "carters.com", "webstaurantstore.com", "shop.tetleyusa.com", "voltagecoffeesupply.com", "target.com"];
  it("alias first, then case-insensitive equality; blank matches any; anything else unresolved", () => {
    const aliases = new Map([["webstraunt store", "webstaurantstore.com"]]);
    expect(resolveRetailer("Webstraunt Store", aliases, suppliers)).toEqual({ kind: "supplier", supplier: "webstaurantstore.com", via: "alias" });
    expect(resolveRetailer("Walmart.com", aliases, suppliers)).toEqual({ kind: "supplier", supplier: "walmart.com", via: "equal" });
    expect(resolveRetailer("  ", aliases, suppliers)).toEqual({ kind: "blank" });
    expect(resolveRetailer(null, aliases, suppliers)).toEqual({ kind: "blank" });
    expect(resolveRetailer("WALMART", aliases, suppliers)).toEqual({ kind: "unresolved", retailer: "WALMART" });
  });
  it("proposals: first label, a listed part, a near spelling; nothing for an unknown store", () => {
    expect(proposeAlias("WALMART", suppliers)).toMatchObject({ supplier: "walmart.com", rule: "first_label" });
    expect(proposeAlias("Carters", suppliers)).toMatchObject({ supplier: "carters.com", rule: "first_label" });
    expect(proposeAlias("shop.tetleyusa.com / WorldPantry.com", suppliers)).toMatchObject({ supplier: "shop.tetleyusa.com", rule: "listed_part" });
    expect(proposeAlias("Webstraunt Store", suppliers)).toMatchObject({ supplier: "webstaurantstore.com", rule: "near_spelling" });
    expect(proposeAlias("Monin", suppliers)).toMatchObject({ supplier: null, rule: null });
  });
  it("helpers", () => {
    expect(supplierLabel("shop.tetleyusa.com")).toBe("tetleyusa");
    expect(editDistance("webstrauntstore", "webstaurantstore")).toBe(3);
    expect(editDistance("carters", "carter")).toBe(1);
    expect(editDistance("ab", "ba")).toBe(1); // a transposition is one edit
  });
});
