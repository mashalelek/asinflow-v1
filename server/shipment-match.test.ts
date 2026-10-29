import { describe, it, expect } from "vitest";
import { buildKeyIndex, rankCandidates, velocityDate, dayDiff, type MatchRow } from "./shipment-match";
import { syncVelocityShipments, type AfAsinRow, type VelocitySyncDeps } from "./shipment-sync-velocity";

// Patch docs/claude_spec-patch-po-matching.md §3 / §4 (amended 2026-10-29):
// past the legacy keys — alias, normalized order #, Col P, base order # with
// units fit, the candidate rule — and never past ordered units.

const row = (o: Partial<AfAsinRow> & { id: string; asin: string; order_id: string; supplier: string; order_date: string }): AfAsinRow =>
  ({ po_id: `p-${o.id}`, units_per_pack: 1, qty_at_prep: null, sold_as: "individual", velocity_units_per_pack: null, qty: 10, ...o });

describe("pure: dates and ranking", () => {
  it("Velocity's MM/DD/YYYY, else created_at; day deltas", () => {
    expect(velocityDate({ date: "05/15/2026" })).toBe("2026-05-15");
    expect(velocityDate({ date: null, created_at: "Fri, 15 May 2026 19:28:17 GMT" })).toBe("2026-05-15");
    expect(dayDiff("2026-05-17", "2026-05-15")).toBe(2);
  });
  it("ranked by |Δdays| then the tightest fit; out-of-window and too-small rows drop", () => {
    const rows: MatchRow[] = [
      { id: "far", asin: "B1", order_id: "F", supplier: "s.com", order_date: "2026-03-01", qty: 10, units_per_pack: 1 },
      { id: "near", asin: "B1", order_id: "N", supplier: "s.com", order_date: "2026-05-14", qty: 10, units_per_pack: 1 },
      { id: "tight", asin: "B1", order_id: "T", supplier: "s.com", order_date: "2026-05-16", qty: 5, units_per_pack: 1 },
      { id: "small", asin: "B1", order_id: "S", supplier: "s.com", order_date: "2026-05-15", qty: 2, units_per_pack: 1 },
    ];
    const ki = buildKeyIndex(rows);
    const r = rankCandidates({ asin: "B1", retailer: { kind: "blank" }, units: 5, vDate: "2026-05-15", orderNumber: "" }, ki, (x) => Number(x.qty));
    expect(r.candidates.map((c) => c.po_asin_id)).toEqual(["tight", "near"]); // both 1 day; T leaves 0, N leaves 5
  });
});

// ── through the sync ─────────────────────────────────────────────────────────
const SID = "s1-0000-0000"; const SID2 = "s2-0000-0000";
function harness(af: AfAsinRow[], lines: Array<{ sid?: string; line: any }>, extra: { aliases?: any[]; unmatched?: any[]; colP?: any[]; fbaIds?: any[] } = {}) {
  const writes: Array<{ sql: string; params?: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    const s = sql.trim();
    if (s.startsWith("SELECT pa.id, pa.po_id, pa.asin")) return { rows: af, rowCount: af.length };
    if (s.startsWith("SELECT alias, supplier FROM supplier_aliases")) return { rows: extra.aliases ?? [], rowCount: 0 };
    if (s.startsWith("SELECT id, velocity_shipment_id, velocity_order_id, reason")) return { rows: extra.unmatched ?? [], rowCount: 0 };
    if (s.startsWith("SELECT DISTINCT c.fba_shipment_id")) return { rows: extra.colP ?? [], rowCount: 0 };
    if (s.startsWith("SELECT id, sc_shipment_ids FROM velocity_shipments")) return { rows: extra.fbaIds ?? [], rowCount: 0 };
    if (s.startsWith("SELECT")) return { rows: [], rowCount: 0 };
    writes.push({ sql: s, params }); return { rows: [], rowCount: 1 };
  };
  const ids = Array.from(new Set(lines.map((l) => l.sid ?? SID)));
  const deps: VelocitySyncDeps = {
    listShipments: async () => ids.map((id) => ({ shipment_id: id, status: "shipped", shipped_at: "Tue, 26 May 2026 15:00:00 GMT" } as any)),
    getShipment: async (id) => ({ orders: lines.filter((l) => (l.sid ?? SID) === id).map((l) => l.line) }),
    listInbound: async () => [], listInventory: async () => [], now: () => new Date("2026-10-29T20:00:00Z"),
  };
  const run = (dryRun = false) => syncVelocityShipments({ dryRun, deps, db: { query, connect: async () => ({ query, release: () => {} }) } as any });
  return { run, writes };
}
const vline = (o: Record<string, unknown>) => ({ order_id: "vo-1", order_number: null, retailer: null, asin: "B0G674X135", sold_as: "individual", units_per_pack: null, date: "05/15/2026", quantity: 5, quantity_shipped: 5, quantity_remaining: 0, ...o });

describe("§4 candidate rule", () => {
  it("INSH line, blank retailer, exactly one PO fits → linked, recorded like a picker link, one edit-log row", async () => {
    const af = [row({ id: "pla", asin: "B0G674X135", order_id: "BAMBU-1", supplier: "us.store.bambulab.com", order_date: "2026-05-14", qty: 5 })];
    const h = harness(af, [{ line: vline({ order_number: "INSH-051526-1043381-13772482" }) }]);
    const r = await h.run();
    expect(r.counts).toMatchObject({ linesMatched: 1, linesMatchedCandidate: 1, linesPoNotFound: 0 });
    expect(r.ruleLinks[0]).toMatchObject({ how: "candidate", poOrderId: "BAMBU-1", days: -1, units: 5 });
    const rec = h.writes.find((w) => w.sql.startsWith("INSERT INTO shipment_unmatched") && /resolved_po_asin_id/.test(w.sql));
    expect(rec?.params?.slice(3)).toEqual(["po_not_found", new Date("2026-10-29T20:00:00Z"), "pla", "candidate_unique"]);
    const log = h.writes.find((w) => w.sql.startsWith("INSERT INTO po_edit_log"));
    expect(log?.params?.slice(0, 5)).toEqual(["p-pla", null, "shipment", "pla", "link"]);
    expect(h.writes.find((w) => w.sql.startsWith("INSERT INTO po_asin_shipments"))?.params?.slice(0, 3)).toEqual(["pla", SID, 5]);
  });
  it("two fit → stays unmatched with both, nearest date first", async () => {
    const af = [
      row({ id: "a", asin: "B0G674X135", order_id: "A", supplier: "x.com", order_date: "2026-05-01" }),
      row({ id: "b", asin: "B0G674X135", order_id: "B", supplier: "x.com", order_date: "2026-05-16" }),
    ];
    const r = await harness(af, [{ line: vline({ order_number: "INSH-1" }) }]).run(true);
    expect(r.counts).toMatchObject({ linesMatched: 0, linesCandidateAmbiguous: 1, linesPoNotFound: 1 });
    expect(r.unmatched[0].candidates?.map((c) => [c.order_id, c.days, c.source])).toEqual([["B", 1, "candidate"], ["A", -14, "candidate"]]);
  });
  it("none → a nearest-miss sentence (units, date, supplier, ASIN)", async () => {
    const full = row({ id: "f", asin: "B0G674X135", order_id: "F", supplier: "x.com", order_date: "2026-05-15", qty: 3 });
    expect((await harness([full], [{ line: vline({ order_number: "INSH-1" }) }]).run(true)).unmatched[0].miss).toBe("PO F (x.com) has 3 units left, the line needs 5");
    const old = row({ id: "o", asin: "B0G674X135", order_id: "O", supplier: "x.com", order_date: "2026-01-01" });
    expect((await harness([old], [{ line: vline({ order_number: "INSH-1" }) }]).run(true)).unmatched[0].miss).toBe("nearest PO O (x.com) is 134 days before the Velocity order");
    expect((await harness([old], [{ line: vline({ order_number: "INSH-1", retailer: "Carters" }) }]).run(true)).unmatched[0].miss).toMatch(/^retailer "Carters" is not mapped/);
    expect((await harness([], [{ line: vline({ order_number: "INSH-1" }) }]).run(true)).unmatched[0].miss).toBe("no AF PO has B0G674X135");
  });
  it("units already placed by other lines count: a row filled by an exact match is not a candidate", async () => {
    const af = [row({ id: "r", asin: "B0G674X135", order_id: "R1", supplier: "x.com", order_date: "2026-05-15", qty: 5 })];
    const r = await harness(af, [
      { line: vline({ order_id: "vo-exact", order_number: "R1", retailer: "x.com" }) },
      { line: vline({ order_id: "vo-insh", order_number: "INSH-1" }) },
    ]).run(true);
    expect(r.counts).toMatchObject({ linesMatched: 1, linesMatchedCandidate: 0, linesPoNotFound: 1 });
    expect(r.unmatched[0].miss).toMatch(/has 0 units left, the line needs 5/);
  });
  it("one Velocity order split over two shipments: one decision, units summed (15 + 3 = 18 fits an 18, not a 15)", async () => {
    const af = [
      row({ id: "small", asin: "B081J755XG", order_id: "S", supplier: "x.com", order_date: "2026-05-08", qty: 15 }),
      row({ id: "big", asin: "B081J755XG", order_id: "B", supplier: "x.com", order_date: "2026-05-09", qty: 18 }),
    ];
    const r = await harness(af, [
      { sid: SID, line: vline({ order_id: "vo-ca99", asin: "B081J755XG", order_number: "INSH-050826-1033616-13761354", date: "05/08/2026", quantity: 18, quantity_shipped: 15 }) },
      { sid: SID2, line: vline({ order_id: "vo-ca99", asin: "B081J755XG", order_number: "INSH-050826-1033616-13761354", date: "05/08/2026", quantity: 18, quantity_shipped: 3 }) },
    ]).run(true);
    expect(r.counts).toMatchObject({ linesMatched: 2, linesMatchedCandidate: 2 });
    expect(new Set(r.ruleLinks.map((l) => l.poAsinId))).toEqual(new Set(["big"]));
  });
  it("a later run keeps a candidate link (recorded resolved_po_asin_id) without re-testing the fit", async () => {
    const af = [row({ id: "pla", asin: "B0G674X135", order_id: "BAMBU-1", supplier: "x.com", order_date: "2026-05-14", qty: 5 })];
    const prior = [{ id: "u1", velocity_shipment_id: SID, velocity_order_id: "vo-1", reason: "po_not_found", resolved_at: "2026-10-29", resolved_po_asin_id: "pla", match_reason: "candidate_unique" }];
    const h = harness(af, [{ line: vline({ order_number: "INSH-1" }) }], { unmatched: prior });
    const r = await h.run();
    expect(r.counts).toMatchObject({ linesMatched: 1, linesMatchedCandidate: 0, linesPoNotFound: 0 });
    expect(h.writes.some((w) => w.sql.startsWith("INSERT INTO po_edit_log"))).toBe(false);
  });
});

describe("Col P on a line WITH an Order # AF lacks must fit the units (dry run 2026-10-29)", () => {
  const colPRow = (id: string, order: string, asin: string, fba: string) => ({ fba_shipment_id: fba, po_asin_id: id, order_id: order, supplier: "carters.com", asin });
  it("CAR118805142_1 never lands on a fully shipped CAR118908837 just because its FBA shipment is in that row's Col P", async () => {
    const full = row({ id: "c9", asin: "B0DZ33XH15", order_id: "CAR118908837", supplier: "carters.com", order_date: "2026-08-24", qty: 5 });
    const lines = [
      { line: vline({ order_id: "vo-own", order_number: "CAR118908837", retailer: "carters.com", asin: "B0DZ33XH15", date: "08/24/2026" }) },
      { line: vline({ order_id: "vo-1", order_number: "CAR118805142_1", retailer: "carters.com", asin: "B0DZ33XH15", date: "09/02/2026" }) },
    ];
    const r = await harness([full], lines, { colP: [colPRow("c9", "CAR118908837", "B0DZ33XH15", "FBA1")], fbaIds: [{ id: SID, sc_shipment_ids: ["FBA1"] }] }).run(true);
    expect(r.counts).toMatchObject({ linesMatched: 1, linesMatchedColP: 0, linesPoNotFound: 1 });
    expect(r.unmatched[0].candidates?.map((c) => [c.order_id, c.source])).toEqual([["CAR118908837", "col_p"]]);
    expect(r.unmatched[0].miss).toBe("Col P names PO CAR118908837 (carters.com), but it has 0 units left, the line needs 5");
  });
  it("a non-fitting Col P hit is a hint, not a verdict: the line still reaches base and §4 (prod shape 2026-10-29)", async () => {
    const own = row({ id: "c5", asin: "B0DZ33XH15", order_id: "CAR118805142", supplier: "carters.com", order_date: "2026-08-17", qty: 5 });
    const full = row({ id: "c9", asin: "B0DZ33XH15", order_id: "CAR118908837", supplier: "carters.com", order_date: "2026-08-24", qty: 5 });
    const open = row({ id: "c3", asin: "B0DZ33XH15", order_id: "CAR119308842", supplier: "carters.com", order_date: "2026-09-07", qty: 10 });
    const lines = [
      { line: vline({ order_id: "vo-a", order_number: "CAR118805142", retailer: "carters.com", asin: "B0DZ33XH15", date: "08/17/2026" }) },
      { line: vline({ order_id: "vo-b", order_number: "CAR118908837", retailer: "carters.com", asin: "B0DZ33XH15", date: "08/24/2026" }) },
      { sid: SID2, line: vline({ order_id: "vo-1", order_number: "CAR118805142_1", retailer: "carters.com", asin: "B0DZ33XH15", date: "09/02/2026" }) },
    ];
    const opts = { colP: [colPRow("c9", "CAR118908837", "B0DZ33XH15", "FBA1")], fbaIds: [{ id: SID2, sc_shipment_ids: ["FBA1"] }] };
    const r = await harness([own, full, open], lines, opts).run(true);
    expect(r.counts).toMatchObject({ linesMatched: 3, linesMatchedCandidate: 1, linesPoNotFound: 0 });
    expect(r.ruleLinks.find((l) => l.orderNumber === "CAR118805142_1")?.poAsinId).toBe("c3");
    // base with room wins over §4 even after a failed Col P hit
    const r2 = await harness([{ ...own, qty: 10 }, full, open], lines, opts).run(true);
    expect(r2.ruleLinks.find((l) => l.orderNumber === "CAR118805142_1")).toMatchObject({ poAsinId: "c5", how: "base_id" });
  });
  it("…and with room it is placed (col_p) and recorded like a picker link", async () => {
    const room = row({ id: "c9", asin: "B0DZ33XH15", order_id: "CAR118908837", supplier: "carters.com", order_date: "2026-08-24", qty: 10 });
    const h = harness([room], [{ line: vline({ order_id: "vo-1", order_number: "INSH-1", asin: "B0DZ33XH15", date: "08/24/2026" }) }],
      { colP: [colPRow("c9", "CAR118908837", "B0DZ33XH15", "FBA1")], fbaIds: [{ id: SID, sc_shipment_ids: ["FBA1"] }] });
    const r = await h.run();
    expect(r.counts).toMatchObject({ linesMatched: 1, linesMatchedColP: 1 });
    expect(h.writes.find((w) => w.sql.startsWith("INSERT INTO shipment_unmatched") && /resolved_po_asin_id/.test(w.sql))?.params?.[6]).toBe("col_p");
  });
  it("a no-Order # line keeps today's Col P rule (no fit test — Monin 73 of 72 stands)", async () => {
    const monin = row({ id: "m", asin: "B015EVCRQY", order_id: "126768935", supplier: "webstaurantstore.com", order_date: "2026-06-09", qty: 72 });
    const r = await harness([monin], [
      { line: vline({ order_id: "vo-own", order_number: "126768935", retailer: "webstaurantstore.com", asin: "B015EVCRQY", quantity_shipped: 72, date: "06/09/2026" }) },
      { line: vline({ order_id: "vo-monin", order_number: null, retailer: "Monin", asin: "B015EVCRQY", quantity_shipped: 1, date: "06/15/2026" }) },
    ], { colP: [{ fba_shipment_id: "FBA1", po_asin_id: "m", order_id: "126768935", supplier: "webstaurantstore.com", asin: "B015EVCRQY" }], fbaIds: [{ id: SID, sc_shipment_ids: ["FBA1"] }] }).run(true);
    expect(r.counts).toMatchObject({ linesMatched: 2, linesMatchedColP: 1 });
  });
});

describe("§3 exact rules past the legacy keys", () => {
  it("base order # links only when the units fit — CAR118805142_1 never lands on a fully shipped CAR118805142", async () => {
    const base = row({ id: "car", asin: "B0DZ33XH15", order_id: "CAR118805142", supplier: "carters.com", order_date: "2026-08-17", qty: 5 });
    const shipped = { order_id: "vo-orig", order_number: "CAR118805142", retailer: "carters.com", asin: "B0DZ33XH15", date: "08/17/2026", quantity_shipped: 5 };
    const r = await harness([base], [{ line: vline(shipped) }, { line: vline({ order_id: "vo-1", order_number: "CAR118805142_1", retailer: "carters.com", asin: "B0DZ33XH15", date: "09/08/2026" }) }]).run(true);
    expect(r.counts).toMatchObject({ linesMatched: 1, linesMatchedBaseId: 0, linesPoNotFound: 1 });
    expect(r.unmatched[0].miss).toBe("base PO CAR118805142 (carters.com) has 0 units left, the line needs 5 — the CAR118805142_1 PO may be missing from AF");
    const room = await harness([{ ...base, qty: 10 }], [{ line: vline({ order_id: "vo-1", order_number: "CAR118805142_1", retailer: "carters.com", asin: "B0DZ33XH15", date: "09/08/2026" }) }]).run(true);
    expect(room.counts).toMatchObject({ linesMatched: 1, linesMatchedBaseId: 1 });
  });
  it("normalized: a free-text prefix and a two-id AF order_id", async () => {
    const af = [
      row({ id: "volt", asin: "B0091CZ7WO", order_id: "G9TG5IACK", supplier: "voltagecoffeesupply.com", order_date: "2026-07-06" }),
      row({ id: "pyr", asin: "B0D8LBY448", order_id: "115449859 / 115450009", supplier: "pyramydair.com", order_date: "2026-08-24" }),
    ];
    const r = await harness(af, [
      { line: vline({ order_id: "v1", order_number: "Confirmation #G9TG5IACK", retailer: "voltagecoffeesupply.com", asin: "B0091CZ7WO" }) },
      { line: vline({ order_id: "v2", order_number: "115449859", retailer: "pyramydair.com", asin: "B0D8LBY448" }) },
    ]).run(true);
    expect(r.counts).toMatchObject({ linesMatched: 2, linesMatchedNormalized: 2 });
  });
  it("alias: WALMART → walmart.com through supplier_aliases (and a blank retailer still searches every supplier)", async () => {
    const af = [row({ id: "w", asin: "B0GGLS46Q1", order_id: "200015497641702", supplier: "walmart.com", order_date: "2026-09-19", qty: 5 })];
    const lines = [{ line: vline({ order_number: null, retailer: "WALMART", asin: "B0GGLS46Q1", date: "09/18/2026", quantity_shipped: 1 }) }];
    expect((await harness(af, lines).run(true)).unmatched[0].miss).toMatch(/^retailer "WALMART" is not mapped/);
    const r = await harness(af, lines, { aliases: [{ alias: "walmart", supplier: "walmart.com" }] }).run(true);
    expect(r.counts).toMatchObject({ linesMatched: 1, linesMatchedCandidate: 1 });
  });
  it("the order # is in AF but not with this ASIN → said so", async () => {
    const af = [row({ id: "rh", asin: "B09W1K4GYX", order_id: "200015022377538", supplier: "walmart.com", order_date: "2026-08-02" })];
    const r = await harness(af, [{ line: vline({ order_number: "200015022377538", retailer: "walmart.com", asin: "B07N6XRBRD", date: "08/02/2026" }) }]).run(true);
    expect(r.unmatched[0].miss).toBe("Order # 200015022377538 (walmart.com) is in AF without B07N6XRBRD — it has B09W1K4GYX");
  });
});
