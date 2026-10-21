// PO tracking matching + supplier domain map (SPEC §26, patch commit 3).
import { describe, it, expect } from "vitest";
import { resolveSupplier, findPos, matchRow, baseOrderId, matchTrackingRows, type PoRef } from "./tracking-match";

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
  it("only rows the sync may move are selected — never manual, reassigned, dismissed or ai_disabled", async () => {
    let seen = "";
    await matchTrackingRows((async (sql: string) => { if (sql.includes("FROM po_tracking")) seen = sql; return { rows: [], rowCount: 0 }; }) as any);
    expect(seen).toMatch(/source <> 'manual' AND reassigned_at IS NULL/);
    expect(seen).toMatch(/NOT IN \('dismissed', 'ai_disabled'\)/);
  });
  it("a dry run writes nothing", async () => {
    const d = db([{ id: 1, sender_domain: "notify.macys.com", retailer_order_id: "4800667218" }]);
    await matchTrackingRows(d.query as any, { dryRun: true });
    expect(d.writes).toHaveLength(0);
  });
});
