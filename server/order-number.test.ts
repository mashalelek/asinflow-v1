import { describe, it, expect } from "vitest";
import { normOrder, orderKey, orderBaseKey, afOrderKeys, afOrderBaseKeys, baseOrderId, orderIdParts, digitForms, orderTokens, posNamedInText, namedIdOk } from "./order-number";
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

describe("posNamedInText (2026-11-04)", () => {
  it("tokens: as is, hyphen-joined, hyphen parts, leading zeros dropped", () => {
    const t = orderTokens("Order 2000152-79183885 · ref 0412645 · CAR118805142_1");
    for (const k of ["200015279183885", "2000152", "79183885", "0412645", "412645", "CAR1188051421", "CAR118805142"]) expect(t.has(k)).toBe(true);
  });
  it("an AF order id counts from free text only when specific enough", () => {
    expect(namedIdOk("833416", "supplier")).toBe(true);
    expect(namedIdOk("833416", "any")).toBe(false);
    expect(namedIdOk("18807E", "any")).toBe(true);
    expect(namedIdOk("12345", "supplier")).toBe(false);
    expect(namedIdOk("ABCDEFGH", "any")).toBe(false);
  });
  it("whole tokens only; either id of a two-id order_id; AF's _N dropped", () => {
    const pos = [{ id: "a", order_id: "115449859 / 115450009" }, { id: "b", order_id: "200015279183885" }, { id: "c", order_id: "28686630_1" }];
    expect(posNamedInText("shipped (#115450009)", pos, "supplier").map((p) => p.id)).toEqual(["a"]);
    expect(posNamedInText("Order# 2000152-79183885", pos, "any").map((p) => p.id)).toEqual(["b"]);
    expect(posNamedInText("order 28686630 has shipped", pos, "supplier").map((p) => p.id)).toEqual(["c"]);
    expect(posNamedInText("x1150000098595", pos, "supplier")).toEqual([]);
  });
});

describe("a trailing -YYYYMMDD ship-date suffix is a shipment suffix (Summit Racing's Narvar notice, 2026-11-11)", () => {
  it("2392393-20261004 and 2392393 share the base key; a 1–2 digit suffix still does; other suffixes do not", async () => {
    const { orderBaseKey, stripShipmentSuffix } = await import("./order-number");
    expect(stripShipmentSuffix("2392393-20261004")).toBe("2392393");
    expect(orderBaseKey("2392393-20261004")).toBe(orderBaseKey("0412645-20260910").length ? "2392393" : "");
    expect(orderBaseKey("412645-20260910")).toBe("412645");
    expect(orderBaseKey("70633076-1")).toBe("70633076");
    expect(orderBaseKey("2392393-31372115")).toBe("239239331372115");
  });
});
