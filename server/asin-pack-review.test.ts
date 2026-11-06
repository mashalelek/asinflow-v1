import { describe, expect, it } from "vitest";
import { decideFromEvidence, packFitsHistory, packReproduces, parseUploadPack, suggestPack, type PackEvidence, type PackRow } from "./asin-pack-review";
import { aiPackSuggestion, allowedPackUnits, packAiPrompt } from "./asin-pack-ai";

const line = (qty: number, y: number | null, r: number | null = null, p: number | null = null) => ({ qty_ordered: qty, asin_qty_per_product: y, retailer_units_per_product: r, asin_units_per_pack: p });
const row = (o: Partial<PackRow>): PackRow => ({ order_id: "PO1", supplier: "walmart.com", closed: true, order_date: "2026-01-01", hand: false, pack: null, qty: 0, velocity_units: null, lines: [], ...o });
const ev = (o: Partial<PackEvidence>): PackEvidence => ({ asin: "B000000001", title: null, record: null, recordSource: null, recordMine: false, rows: [], ...o });
const ind = { sold_as: "individual" as const, units: 1 };
const two = { sold_as: "multi-pack" as const, units: 2 };

describe("packReproduces / packFitsHistory", () => {
  it("a sheet line's stored Ordered is reproduced within 0.01", () => {
    expect(packReproduces(row({ qty: 10, lines: [line(20, 0.5)] }), two)).toBe(true);    // 20 × 1 ÷ 2
    expect(packReproduces(row({ qty: 10, lines: [line(20, 0.5)] }), ind)).toBe(false);   // 0.5 is no whole number at ×1
    expect(packReproduces(row({ qty: 20, lines: [line(60, 0.33)] }), { sold_as: "multi-pack", units: 3 })).toBe(true);
    expect(packReproduces(row({ qty: 10, lines: [] }), ind)).toBe(false);
  });
  it("history: every row with lines and an Ordered must fit", () => {
    const rows = [row({ qty: 10, lines: [line(20, 0.5)] }), row({ qty: 5, lines: [line(10, 0.5)] }), row({ qty: 0, lines: [] })];
    expect(packFitsHistory(rows, two)).toBe(true);
    expect(packFitsHistory(rows, ind)).toBe(false);
  });
});

describe("decideFromEvidence", () => {
  it("a pack Maria set herself is never re-decided", () => {
    expect(decideFromEvidence(ev({ recordMine: true, rows: [row({ hand: true, pack: two })] }))).toEqual({ kind: "mine" });
  });
  it("(a) PO lines that agree confirm — hand-set rows, or sheet rows their pack reproduces", () => {
    const d = decideFromEvidence(ev({ rows: [row({ hand: true, pack: two, order_id: "A" }), row({ pack: two, qty: 10, lines: [line(20, 0.5)], order_id: "B" })] }));
    expect(d).toMatchObject({ kind: "confirmed", pack: two, source: "po" });
  });
  it("a sheet row its own pack does not reproduce does not count", () => {
    expect(decideFromEvidence(ev({ rows: [row({ pack: ind, qty: 10, lines: [line(20, 0.5)] })] }))).toBeNull();
  });
  it("(b) Velocity alone confirms; with PO lines agreeing it is po_velocity", () => {
    expect(decideFromEvidence(ev({ rows: [row({ velocity_units: 2 })] }))).toMatchObject({ kind: "confirmed", pack: two, source: "velocity" });
    expect(decideFromEvidence(ev({ rows: [row({ hand: true, pack: two, velocity_units: 2 })] }))).toMatchObject({ kind: "confirmed", source: "po_velocity" });
  });
  it("PO lines that disagree need review and list each PO #", () => {
    const d = decideFromEvidence(ev({ rows: [row({ hand: true, pack: ind, order_id: "111", order_date: "2026-02-01" }), row({ hand: true, pack: two, order_id: "222" })] }));
    expect(d).toMatchObject({ kind: "review", reason: "po_conflict", suggestion: ind });
    expect((d as any).note).toContain("PO individual: walmart.com 111");
    expect((d as any).note).toContain("PO multi-pack ×2: walmart.com 222");
  });
  it("PO lines vs Velocity need review; Velocity disagreeing with itself too", () => {
    expect(decideFromEvidence(ev({ rows: [row({ hand: true, pack: ind, velocity_units: 2 })] }))).toMatchObject({ kind: "review", reason: "po_velocity_conflict" });
    expect(decideFromEvidence(ev({ rows: [row({ velocity_units: 1 }), row({ velocity_units: 2 })] }))).toMatchObject({ kind: "review", reason: "velocity_conflict" });
  });
});

describe("suggestPack — suggestions only, never confirmed", () => {
  it("AI first, then catalog item_package_quantity, then the title, then an unreviewed record", () => {
    expect(suggestPack(ev({ title: "Treats, Pack of 2" }), { item_package_quantity: 3, number_of_items: 12 }, { sold_as: "multi-pack", units_per_pack: 2, note: "title says 6, image shows 2 packages" }))
      .toMatchObject({ kind: "review", reason: "suggestion", suggestion: two, suggestionSource: "ai" });
    const c = suggestPack(ev({ title: "Treats, Pack of 2" }), { item_package_quantity: 3, number_of_items: 12 }, null);
    expect(c).toMatchObject({ suggestion: { sold_as: "multi-pack", units: 3 }, suggestionSource: "catalog" });
    expect(c.note).toContain("number_of_items 12 (items, not packages)");
    expect(suggestPack(ev({ title: "Treats, Pack of 2" }), null, null)).toMatchObject({ suggestion: two, suggestionSource: "title" });
    expect(suggestPack(ev({ record: ind }), null, null)).toMatchObject({ suggestion: ind, suggestionSource: "record" });
  });
  it("with past PO lines only a pack that reproduces them is suggested", () => {
    const rows = [row({ qty: 10, lines: [line(20, 0.5)] })];
    expect(suggestPack(ev({ title: "Pack of 3", rows }), { item_package_quantity: 1, number_of_items: null }, null)).toMatchObject({ reason: "nothing", suggestion: null });
    expect(suggestPack(ev({ title: "Pack of 2", rows }), { item_package_quantity: 1, number_of_items: null }, null)).toMatchObject({ suggestion: two, suggestionSource: "title" });
  });
  it("nothing found", () => {
    expect(suggestPack(ev({}), null, null)).toMatchObject({ reason: "nothing", suggestion: null, note: "nothing found" });
  });
});

describe("parseUploadPack", () => {
  it("reads the round-trip; a trailing ? (an unconfirmed suggestion) is never confirmed", () => {
    expect(parseUploadPack("individual", "1")).toEqual(ind);
    expect(parseUploadPack("Multi-pack", "2")).toEqual(two);
    expect(parseUploadPack("multi-pack?", "2?")).toBeNull();
    expect(parseUploadPack("multi-pack", "1")).toBeNull();
    expect(parseUploadPack("", "")).toBeNull();
    expect(parseUploadPack("bundle", "3")).toEqual({ sold_as: "bundle", units: 3 });
  });
});

describe("the AI read", () => {
  it("allowed packs are those reproducing the history (null without history)", () => {
    expect(allowedPackUnits((u) => u === 2 || u === 4, true)).toEqual([2, 4]);
    expect(allowedPackUnits(() => true, false)).toBeNull();
  });
  it("the prompt names the allowed packs and says number_of_items counts items", () => {
    const p = packAiPrompt({ asin: "B1", title: "Lot of 6", image_url: "x.jpg", catalog: { item_package_quantity: null, number_of_items: 6 }, allowed: [2] });
    expect(p).toContain("Allowed packs");
    expect(p).toContain("number_of_items counts items, not packages");
  });
  it("logs every call with its cost; off without a key; a failure is logged and gives nothing", async () => {
    const logged: any[] = [];
    const q = async (_sql: string, params?: any[]) => { logged.push(params); return { rows: [], rowCount: 1 } as any; };
    const input = { asin: "B1", title: "t", image_url: null, catalog: null, allowed: null };
    expect(await aiPackSuggestion(q, input, { available: false })).toEqual({ result: null, cost: 0 });
    const ok = await aiPackSuggestion(q, input, { available: true, call: async () => ({ sold_as: "multi-pack", units_per_pack: 2, note: "2 bags", input_tokens: 1000, output_tokens: 100 }) });
    expect(ok.result).toEqual({ sold_as: "multi-pack", units_per_pack: 2, note: "2 bags" });
    expect(ok.cost).toBeGreaterThan(0);
    const bad = await aiPackSuggestion(q, input, { available: true, call: async () => { throw new Error("boom"); } });
    expect(bad).toEqual({ result: null, cost: 0 });
    expect(logged.length).toBe(2);
  });
});
