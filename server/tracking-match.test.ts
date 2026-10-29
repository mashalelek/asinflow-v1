// PO tracking matching + supplier domain map (SPEC §26, patch commit 3).
import { describe, it, expect } from "vitest";
import { resolveSupplier, findPos, matchRow, baseOrderId, matchTrackingRows, retailerNameFromSubject, supplierByName, findPosByOrderDigits, type PoRef } from "./tracking-match";

const SUPPLIERS = ["target.com", "walmart.com", "macys.com", "michaels.com", "homedepot.com", "staples.com", "zoro.com", "tractorsupply.com", "shop.equalexchange.coop", "communitycoffee.com"];
const POS: PoRef[] = [
  { id: "po-macys-1", supplier: "macys.com", order_id: "4800667218" },
  { id: "po-macys-2", supplier: "macys.com", order_id: "4798028553" },
  { id: "po-walmart", supplier: "walmart.com", order_id: "200015328073060" },
  { id: "po-target-a", supplier: "target.com", order_id: "102003876318342" },
  { id: "po-target-b", supplier: "target.com", order_id: "102003876318342_2" },
  { id: "po-zoro-suffix", supplier: "zoro.com", order_id: "WB5741517959_2" },
  { id: "po-pyramyd", supplier: "pyramydair.com", order_id: "115449859 / 115450009" },
];

describe("supplier from sender domain", () => {
  it("obvious pairs: registrable domain, a supplier on the same registrable domain, a platform's first label", () => {
    for (const [d, s] of [["oe.target.com", "target.com"], ["oe1.target.com", "target.com"], ["notify.macys.com", "macys.com"], ["order.homedepot.com", "homedepot.com"],
      ["orders.staples.com", "staples.com"], ["e.zoro.com", "zoro.com"], ["equalexchange.coop", "shop.equalexchange.coop"], ["tractorsupply.narvar.com", "tractorsupply.com"]] as const) {
      expect(resolveSupplier(d, {}, SUPPLIERS)).toEqual({ supplier: s, obvious: true });
    }
  });
  it("the map wins over the obvious rule; unknown domains resolve to nothing", () => {
    expect(resolveSupplier("t.shopifyemail.com", { "t.shopifyemail.com": "communitycoffee.com" }, SUPPLIERS)).toEqual({ supplier: "communitycoffee.com", obvious: false });
    expect(resolveSupplier("ups.com", {}, SUPPLIERS)).toEqual({ supplier: null, obvious: false });
    expect(resolveSupplier(null, {}, SUPPLIERS).supplier).toBeNull();
  });
});

describe("PO matching", () => {
  it("D4: an AF _N suffix matches on the base id; punctuation is ignored (Walmart hyphen)", () => {
    expect(baseOrderId("WB5741517959_2")).toBe("WB5741517959");
    expect(findPos("zoro.com", "WB5741517959", POS).map((p) => p.id)).toEqual(["po-zoro-suffix"]);
    expect(findPos("walmart.com", "2000153-28073060", POS).map((p) => p.id)).toEqual(["po-walmart"]);
    expect(findPos("pyramydair.com", "115450009", POS).map((p) => p.id)).toEqual(["po-pyramyd"]);
  });
  it("0 → no_po, 1 → matched, >1 → ambiguous (Maria picks); supplier must match too", () => {
    expect(matchRow({ sender_domain: "notify.macys.com", retailer_order_id: "4800667218" }, {}, SUPPLIERS, POS)).toMatchObject({ status: "matched", po_id: "po-macys-1" });
    expect(matchRow({ sender_domain: "notify.macys.com", retailer_order_id: "9999999999" }, {}, SUPPLIERS, POS)).toMatchObject({ status: "unmatched", reason: "no_po" });
    expect(matchRow({ sender_domain: "oe.target.com", retailer_order_id: "102003876318342" }, {}, SUPPLIERS, POS)).toMatchObject({ status: "unmatched", reason: "ambiguous", candidates: ["po-target-a", "po-target-b"] });
    expect(matchRow({ sender_domain: "oe.target.com", retailer_order_id: "4800667218" }, {}, SUPPLIERS, POS)).toMatchObject({ reason: "no_po" });
    expect(matchRow({ sender_domain: "ups.com", retailer_order_id: "1" }, {}, SUPPLIERS, POS)).toMatchObject({ reason: "unknown_sender" });
    expect(matchRow({ sender_domain: "notify.macys.com", retailer_order_id: null }, {}, SUPPLIERS, POS)).toMatchObject({ reason: "unpaired" });
  });
});

describe("matchTrackingRows", () => {
  function db(rows: any[], map: Record<string, string> = {}) {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const query = async (sql: string, params?: any[]) => {
      if (sql.includes("FROM po_tracking") && sql.trimStart().startsWith("SELECT")) return { rows, rowCount: rows.length };
      if (sql.startsWith("SELECT value FROM settings")) return { rows: [{ value: map }], rowCount: 1 };
      if (sql.includes("FROM purchase_orders")) return { rows: POS, rowCount: POS.length };
      if (sql.startsWith("SELECT alias, supplier FROM supplier_aliases")) return { rows: [], rowCount: 0 };
      writes.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    };
    return { query, writes };
  }
  it("matches, records reasons, and seeds obvious pairs into the domain map", async () => {
    const d = db([
      { id: 1, sender_domain: "notify.macys.com", retailer_order_id: "4800667218" },
      { id: 2, sender_domain: "oe.target.com", retailer_order_id: "102003876318342" },
      { id: 3, sender_domain: "ups.com", retailer_order_id: "x1" },
    ]);
    const r = await matchTrackingRows(d.query as any);
    expect(r).toMatchObject({ considered: 3, matched: 1, unmatched: { ambiguous: 1, unknown_sender: 1 }, seeded: { "notify.macys.com": "macys.com", "oe.target.com": "target.com" } });
    const up = d.writes.filter((w) => w.sql.includes("UPDATE po_tracking"));
    expect(up.map((w) => [w.params[0], w.params[3], w.params[4]])).toEqual([[1, "matched", null], [2, "unmatched", "ambiguous"], [3, "unmatched", "unknown_sender"]]);
    expect(up[0].sql).toMatch(/source <> 'manual' AND reassigned_at IS NULL/);
    expect(d.writes.filter((w) => w.sql.includes("INSERT INTO settings")).map((w) => w.params[1])).toEqual(["notify.macys.com", "oe.target.com"]);
  });
  it("only rows the sync may move are selected — never manual, reassigned, dismissed, ai_disabled or return", async () => {
    let seen = "";
    await matchTrackingRows((async (sql: string) => { if (sql.includes("FROM po_tracking")) seen = sql; return { rows: [], rowCount: 0 }; }) as any);
    expect(seen).toMatch(/source <> 'manual' AND reassigned_at IS NULL/);
    expect(seen).toMatch(/NOT IN \('dismissed', 'ai_disabled', 'return'\)/);
  });
  it("a dry run writes nothing", async () => {
    const d = db([{ id: 1, sender_domain: "notify.macys.com", retailer_order_id: "4800667218" }]);
    await matchTrackingRows(d.query as any, { dryRun: true });
    expect(d.writes).toHaveLength(0);
  });
});

describe("shared order-# functions and supplier_aliases (PO matching patch §7, 2026-10-29)", () => {
  const SUP = [...SUPPLIERS, "carters.com"];
  const P: PoRef[] = [...POS, { id: "po-car", supplier: "carters.com", order_id: "CAR118805142" }];
  it("a platform email's subject name resolves through supplier_aliases first", () => {
    const row = { sender_domain: "shopifyemail.com", retailer_order_id: "CAR118805142", email_subject: "Your Carters order has shipped" };
    expect(matchRow(row, {}, SUP, P, undefined, new Map([["carters", "carters.com"]]))).toMatchObject({ status: "matched", po_id: "po-car", via: "retailer_name", supplier: "carters.com" });
  });
  it("a free-text prefix on the email's order # drops (shared normOrder)", () => {
    expect(findPos("carters.com", "Order #CAR118805142", P).map((p) => p.id)).toEqual(["po-car"]);
    expect(findPosByOrderDigits("Order #200015279183885", [{ id: "w", supplier: "walmart.com", order_id: "2000152-79183885" }]).map((p) => p.id)).toEqual(["w"]);
  });
});

describe("platform senders + order-#-unique (Maria 2026-10-22)", () => {
  const SUP = [...SUPPLIERS, "shop.lospoblanos.com", "shop.tetleyusa.com", "us.typology.com", "yvesrocherusa.com"];
  const P: PoRef[] = [...POS,
    { id: "po-lospoblanos", supplier: "shop.lospoblanos.com", order_id: "635389" },
    { id: "po-tetley", supplier: "shop.tetleyusa.com", order_id: "70633076" },
    { id: "po-typology", supplier: "us.typology.com", order_id: "U1283797" },
    { id: "po-yves", supplier: "yvesrocherusa.com", order_id: "130097" },
    { id: "po-dup-a", supplier: "a.com", order_id: "55555" }, { id: "po-dup-b", supplier: "b.com", order_id: "55555" },
  ];
  it("the store a platform subject names", () => {
    expect(retailerNameFromSubject("Maria P, your Los Poblanos order has been delivered!")).toBe("Los Poblanos");
    expect(retailerNameFromSubject("Your order with Tetley and WorldPantry.com has Shipped (70633076-1)")).toBe("Tetley");
    expect(retailerNameFromSubject("Your order has been delivered!")).toBeNull();
    expect(supplierByName("Los Poblanos", SUP)).toBe("shop.lospoblanos.com");
    expect(supplierByName("Tetley", SUP)).toBe("shop.tetleyusa.com");
    expect(supplierByName("ADVANTAGE DISTRIBUTING LLC", SUP)).toBeNull();
  });
  it("the supplier route also reads a trailing -N off the email's number", () => {
    expect(matchRow({ sender_domain: "worldpantry.com", retailer_order_id: "70633076-1", email_subject: "Your order with Tetley and WorldPantry.com has Shipped (70633076-1)" }, {}, SUP, P))
      .toMatchObject({ status: "matched", po_id: "po-tetley", via: "retailer_name" });
  });
  it("a platform sender is matched by the subject's store → retailer_name, and never seeded", () => {
    expect(matchRow({ sender_domain: "shipstation.com", retailer_order_id: "635389", email_subject: "Your Los Poblanos order 635389 has been shipped!" }, {}, SUP, P))
      .toMatchObject({ status: "matched", po_id: "po-lospoblanos", via: "retailer_name", obvious: false });
  });
  it("unmapped sender, order # names exactly one PO digits-only (incl. a trailing -N) → order_id_unique", () => {
    expect(matchRow({ sender_domain: "worldpantry.com", retailer_order_id: "70633076-1", email_subject: "Shipped" }, {}, SUP, P)).toMatchObject({ status: "matched", po_id: "po-tetley", via: "order_id_unique", supplier: "shop.tetleyusa.com", obvious: false });
    expect(matchRow({ sender_domain: "parcelpanel.net", retailer_order_id: "U1283797" }, {}, SUP, P)).toMatchObject({ po_id: "po-typology", via: "order_id_unique" });
    expect(matchRow({ sender_domain: "yvesrocher.us", retailer_order_id: "130097" }, {}, SUP, P)).toMatchObject({ po_id: "po-yves", via: "order_id_unique" });
  });
  it("zero or several POs, a short number, or a mapped sender's no_po → still queued", () => {
    expect(matchRow({ sender_domain: "yvesrocher.us", retailer_order_id: "55555" }, {}, SUP, P)).toMatchObject({ status: "unmatched", reason: "unknown_sender" });
    expect(matchRow({ sender_domain: "yvesrocher.us", retailer_order_id: "999999" }, {}, SUP, P)).toMatchObject({ reason: "unknown_sender" });
    expect(findPosByOrderDigits("1234", P)).toEqual([]);
    expect(matchRow({ sender_domain: "oe.target.com", retailer_order_id: "4800667218" }, {}, SUP, P)).toMatchObject({ reason: "no_po" });
  });
});
