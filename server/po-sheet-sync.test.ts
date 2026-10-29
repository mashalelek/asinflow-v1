import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parsePoSheet, syncPoSheet, poKey, PO_SHEET_HEADER_EXPECT } from "./po-sheet-sync";
import { COL } from "./po-import-classify";

// Patch docs/claude_spec-patch-po-sheet-sync.md §3 — the repeatable
// Orders-sheet → PO sync. Pure parse + a diff/apply driven by an injected
// query function, so every §3 rule is pinned without a database.

// ── sheet fixtures ────────────────────────────────────────────────────────────
const HEADER: string[] = Array(52).fill("");
for (const [idx, caption] of PO_SHEET_HEADER_EXPECT) HEADER[idx] = caption;

interface RowOpts {
  orderId: string; supplier?: string; date?: string; status?: string; asin?: string; product?: string;
  L?: string; M?: string; N?: string; R?: string; S?: string; T?: string; Y?: string; X?: string;
  total?: string; refund?: string; notes?: string; prep?: string; soldAs?: string; upp?: string; promo?: string; email?: string;
}
function row(o: RowOpts): string[] {
  const c: string[] = Array(52).fill("");
  c[COL.orderId] = o.orderId; c[COL.orderDate] = o.date ?? "3/1/2026"; c[COL.status] = o.status ?? "Ordered";
  c[COL.supplier] = o.supplier ?? "walmart.com"; c[COL.productName] = o.product ?? "Widget"; c[COL.asin] = o.asin ?? "B000000001";
  c[COL.qtyOrdered] = o.L ?? "4"; c[COL.qtyReceived] = o.M ?? ""; c[COL.asinQtyTotal] = o.N ?? "4"; c[COL.qtyReturned] = o.R ?? "";
  c[COL.uniqueProductsPerAsin] = o.S ?? "1"; c[COL.asinQtyPerProduct] = o.T ?? "1";
  c[COL.adjCogs] = o.Y ?? "$10.00"; c[COL.adjProductCost] = o.X ?? "$10.00"; c[COL.price] = "$10.00";
  c[COL.subtotal] = "$40.00"; c[COL.orderTotal] = o.total ?? "$40.00"; c[COL.refundAmount] = o.refund ?? "";
  c[COL.notes] = o.notes ?? ""; c[COL.prepCost] = o.prep ?? ""; c[COL.soldAs] = o.soldAs ?? ""; c[COL.unitsPerPack] = o.upp ?? "";
  c[COL.promo] = o.promo ?? ""; c[COL.emailUsed] = o.email ?? "";
  return c;
}

// ── fake database ─────────────────────────────────────────────────────────────
interface DbState { pos: any[]; asins: any[]; lines: any[]; skus?: Record<string, string> }
function po(overrides: Partial<any> & { id: string; order_id: string }): any {
  return {
    supplier: "walmart.com", order_date: "2026-03-01", subtotal: "40.00", tax: "0.00", sh_donations: "0.00", discount: "0.00",
    refund_amount: "0.00", order_total: "40.00", payment_method: null, weighted_gc_discount_pct: null, promo: null, cashback_site: null,
    cashback_pct: null, purchased_by: null, subscription: false, email_used: "orders@coastalqualitygoods.com", invoice_attached: false,
    notes: null, action_items: [], closed_at: null, closed_by: null, ...overrides,
  };
}
function pa(overrides: Partial<any> & { id: string; po_id: string; asin: string }): any {
  return { asin_name: null, qty: 4, cost_per_unit: "10.00", prep_cost: "0", sold_as: "individual", units_per_pack: 1,
    unreimbursed_loss_qty: 0, unreimbursed_loss_amount: "0", unique_products: 1, shipment_rows: 0, qty_shipped_fba: null, ...overrides };
}
function line(overrides: Partial<any> & { id: string; po_id: string; po_asin_id: string }): any {
  return { position: 0, product_name: "Widget", supplier_sku: null, price: "10.00", qty_ordered: 4, qty_received: null, qty_returned: 0,
    asin_qty_per_product: "1.00", adjusted_product_cost: "10.00", qty_canceled: null, action_items: [], ...overrides };
}
function fakeDb(state: DbState) {
  const writes: Array<{ sql: string; params?: any[] }> = [];
  const query = async (sql: string, params?: any[]) => {
    const s = sql.trim();
    if (s.startsWith("SELECT * FROM purchase_orders")) return { rows: state.pos, rowCount: state.pos.length };
    if (s.startsWith("SELECT pa.*")) return { rows: state.asins, rowCount: state.asins.length };
    if (s.startsWith("SELECT * FROM po_line_items")) return { rows: state.lines, rowCount: state.lines.length };
    if (s.startsWith("SELECT asin, primary_sku")) return { rows: Object.entries(state.skus ?? {}).map(([asin, primary_sku]) => ({ asin, primary_sku })), rowCount: 0 };
    if (s.startsWith("SELECT supplier, order_id FROM deleted_pos")) return { rows: (state as any).tombstones ?? [], rowCount: 0 };
    writes.push({ sql: s, params });
    if (s.startsWith("INSERT")) return { rows: [{ id: `new-${writes.length}` }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release: () => { writes.push({ sql: "RELEASE" }); } };
  return { query, connect: async () => client, writes };
}
const read = (cells: string[][]) => async () => ({ header: HEADER, dataCells: cells });

// ── parse ─────────────────────────────────────────────────────────────────────
describe("parsePoSheet — the importer's assembly, ported", () => {
  it("refuses a differently-shaped header (fail-closed)", () => {
    const bad = [...HEADER]; bad[COL.asinQtyTotal] = "Qty";
    expect(() => parsePoSheet(bad, [row({ orderId: "1" })])).toThrow(/header mismatch/);
  });
  it("groups rows on (supplier, order_id), applies the tetley alias and the 2026 filter, maps the Status cell", () => {
    const p = parsePoSheet(HEADER, [
      row({ orderId: "A1", status: "Closed, SHIP", asin: "B000000001" }),
      row({ orderId: "A1", asin: "B000000002", status: "Ordered" }), // second ASIN, first-row Status wins
      row({ orderId: "T9", supplier: "shop.tetleyusa.com / WorldPantry.com" }),
      row({ orderId: "OLD", date: "3/1/2025" }),
      row({ orderId: "C1", status: "Closed, Canceled", L: "0", N: "0" }),
      row({ orderId: "U1", status: "Lost in transit" }),
    ]);
    expect(p.rawRowsRead).toBe(6);
    // 2026-10-18 (PO history import): the year filter is gone — the 2025 row imports too.
    expect(p.importedRows).toBe(6);
    expect(p.pos.map((x) => x.orderId)).toEqual(["A1", "T9", "OLD", "C1", "U1"]);
    expect(p.pos.find((x) => x.orderId === "OLD")?.historical).toBe(true);
    const a1 = p.pos[0];
    expect(a1.key).toBe(poKey("walmart.com", "A1"));
    expect(a1.poAsins.map((a) => a.asin)).toEqual(["B000000001", "B000000002"]);
    // Row-level Status (2026-10-17): row 1 "Closed, SHIP", row 2 "Ordered" → NOT closed (not every row);
    // action items land on row 1's line only; the PO reports the union.
    expect(a1).toMatchObject({ closed: false, actionItems: ["SHIP"], email: "orders@coastalqualitygoods.com" });
    expect(a1.poAsins[0].lines[0]).toMatchObject({ actionItems: ["SHIP"], canceled: false, statusCell: "Closed, SHIP" });
    expect(a1.poAsins[1].lines[0]).toMatchObject({ actionItems: [], canceled: false, statusCell: "Ordered" });
    expect(p.pos[1].supplier).toBe("shop.tetleyusa.com");
    expect(p.pos[3]).toMatchObject({ closed: true });
    expect(p.pos[3].poAsins[0].lines[0].canceled).toBe(true);
    expect(p.unmapped).toEqual([{ po: "walmart.com U1", tokens: ["Lost in transit"] }]);
    expect(p.skippedMixed).toEqual([]);
  });
  it("S=1 same-ASIN rows merge additively (qty = Σ Col N; cost verbatim when rows agree) and keep one line per row", () => {
    const p = parsePoSheet(HEADER, [
      row({ orderId: "M1", L: "10", N: "5", T: "0.50", Y: "$8.82" }),
      row({ orderId: "M1", L: "10", N: "5", T: "0.50", Y: "$8.82" }),
    ]);
    expect(p.pos[0].poAsins).toHaveLength(1);
    expect(p.pos[0].poAsins[0]).toMatchObject({ qty: 10, costPerUnit: "8.82" });
    expect(p.pos[0].poAsins[0].lines.map((l) => l.position)).toEqual([0, 1]);
  });
  it("a mixed Col S group skips the whole PO (data error, never guessed)", () => {
    const p = parsePoSheet(HEADER, [row({ orderId: "X1", S: "1" }), row({ orderId: "X1", S: "2" })]);
    expect(p.pos).toEqual([]);
    expect(p.skippedMixed).toHaveLength(1);
  });
});

// ── diff (dry run) ────────────────────────────────────────────────────────────
describe("syncPoSheet — dry run computes the §3.9 counts and writes nothing", () => {
  const state: DbState = {
    pos: [
      po({ id: "p1", order_id: "A1" }),                                            // unchanged
      po({ id: "p2", order_id: "A2", closed_at: "2026-09-01", closed_by: "auto" }),   // sheet not Closed → reopened (D2)
      po({ id: "p3", order_id: "A3", action_items: ["SHIP"] }),                      // sheet Closed → closed (sheet); action_items → []
      po({ id: "p4", order_id: "A4" }),                                            // ASIN replaced; one ASIN kept (shipments)
      po({ id: "p5", order_id: "A5" }),                                            // canceled in sheet with L = 0 → stored qty kept
      po({ id: "p6", order_id: "GONE" }),                                          // not in sheet → reported, not deleted
    ],
    asins: [
      pa({ id: "a1", po_id: "p1", asin: "B000000001" }),
      pa({ id: "a2", po_id: "p2", asin: "B000000001" }),
      pa({ id: "a3", po_id: "p3", asin: "B000000001" }),
      pa({ id: "a4", po_id: "p4", asin: "B000000001" }),
      pa({ id: "a4b", po_id: "p4", asin: "B000000009", shipment_rows: 2 }),
      pa({ id: "a5", po_id: "p5", asin: "B000000001", qty: 12 }),
      pa({ id: "a6", po_id: "p6", asin: "B000000001" }),
    ],
    lines: [
      line({ id: "l1", po_id: "p1", po_asin_id: "a1" }),
      line({ id: "l2", po_id: "p2", po_asin_id: "a2" }),
      line({ id: "l3", po_id: "p3", po_asin_id: "a3" }),
      line({ id: "l4", po_id: "p4", po_asin_id: "a4" }),
      line({ id: "l4x", po_id: "p4", po_asin_id: "a4", position: 1 }),           // second line gone from the sheet → deleted
      line({ id: "l4b", po_id: "p4", po_asin_id: "a4b" }),
      line({ id: "l5", po_id: "p5", po_asin_id: "a5", qty_ordered: 12 }),
      line({ id: "l6", po_id: "p6", po_asin_id: "a6" }),
    ],
  };
  const cells = [
    row({ orderId: "A1" }),
    row({ orderId: "A2", status: "Ordered" }),
    row({ orderId: "A3", status: "Closed", M: "4" }),
    row({ orderId: "A4", asin: "B000000002" }),
    row({ orderId: "A5", status: "Closed, Canceled", L: "0", N: "0", total: "$0.00", refund: "$40.00" }),
    row({ orderId: "NEW1", status: "Ordered", asin: "B000000003" }),
    row({ orderId: "NEWC", status: "Closed, Canceled", L: "0", N: "0" }),
  ];

  it("counts inserted / updated / unchanged / deletes / kept / in-AF-not-in-sheet, with the cancel rules", async () => {
    const db = fakeDb(state);
    const r = await syncPoSheet({ sheetId: "s", dryRun: true, db, read: read(cells) });
    expect(r.stop).toBeNull();
    expect(r.wrote).toBe(false);
    expect(r.counts).toEqual({
      // Intake-only (af-owned, 2026-10-18): the 4 existing POs that differ are reported as drift, nothing applied.
      sheetPos: 7, inserted: 2, updated: 0, unchanged: 1, linesDeleted: 0, poAsinsDeleted: 0, poAsinsKeptWithShipments: 0,
      canceledKeptOrderedQty: 0, canceledNoOrderedQty: 1, returnedNoQty: 0, lineActionItemsChanged: 0, historyInserted: 0, historyWithActionItems: 0, skippedBadCells: 0,
      colPEntries: 0, sheetDiffers: 4, tombstoned: 0, posInAfNotInSheet: 1, unmappedTokens: 0, skippedMixed: 0,
    });
    expect(r.inAfNotInSheet).toEqual(["walmart.com GONE (2026-03-01)"]);
    expect(r.keptWithShipments).toEqual([]);
    expect(r.canceledKept).toEqual([]);
    expect(r.canceledNoQty).toEqual(["walmart.com NEWC"]);
    expect(db.writes).toEqual([]);
    const by = Object.fromEntries(r.diffs.map((d) => [d.po, d.changes]));
    expect(by["walmart.com A2"]).toEqual(["closed: closed (auto) → open"]);
    // The PO-level action_items column is no longer written (row-level Status §2.1).
    expect(by["walmart.com A3"]).toEqual(["closed: open → closed (sheet)", "B000000001 line 0.qty_received: NULL → 4"]);
    expect(by["walmart.com A4"]).toEqual(expect.arrayContaining(["B000000002: new ASIN row", "B000000001: ASIN row deleted (not in sheet; 2 line(s))", "B000000009: not in sheet — KEPT (2 shipment rows)"]));
    // A5: stored 12 kept on both the ASIN row and the line; qty_canceled = 12; money fields still follow the sheet.
    expect(by["walmart.com A5"]).toEqual(expect.arrayContaining(["refund_amount: 0.00 → 40.00", "order_total: 40.00 → 0.00", "closed: open → closed (sheet)", "B000000001 line 0.qty_canceled: NULL → 12", "canceled: sheet qty 0 ignored, stored ordered qty kept"]));
    expect(by["walmart.com A5"].some((c) => c.includes("qty: 12 → 0") || c.includes("qty_ordered: 12 → 0"))).toBe(false);
    expect(r.samples).toHaveLength(4);
    expect(r.samples[0]).toMatch(/^walmart\.com A2: closed/);
  });

  it("an unmapped Status token stops the sync: reported, nothing written even on a live run", async () => {
    const db = fakeDb(state);
    const r = await syncPoSheet({ sheetId: "s", dryRun: false, db, read: read([...cells, row({ orderId: "U1", status: "Lost in transit" })]) });
    expect(r.stop).toMatch(/unmapped Status token\(s\) on 1 PO\(s\): walmart\.com U1 \["Lost in transit"\]/);
    expect(r.wrote).toBe(false);
    expect(r.counts.unmappedTokens).toBe(1);
    expect(db.writes).toEqual([]);
  });

  it("\"Shipped FBA\" is a no-op token, not a stop (decision 1, 2026-10-16)", async () => {
    const db = fakeDb(state);
    const r = await syncPoSheet({ sheetId: "s", dryRun: true, db, read: read([row({ orderId: "A1", status: "Shipped FBA, Confirm Refund / Replacement" })]) });
    expect(r.stop).toBeNull();
    expect(r.diffs.find((d) => d.po === "walmart.com A1")?.changes).toEqual(["B000000001 line 0.action_items: [] → [\"Confirm Refund / Replacement\"]"]);
  });

  it("live run (intake-only, af-owned 2026-10-18): inserts new POs like the importer, Open, with entry_seq; never writes an existing PO", async () => {
    const db = fakeDb(state);
    const r = await syncPoSheet({ sheetId: "s", dryRun: false, db, read: read(cells) });
    expect(r.wrote).toBe(true);
    const sql = db.writes.map((w) => w.sql);
    expect(sql[0]).toBe("BEGIN");
    expect(sql[sql.length - 2]).toBe("COMMIT");
    expect(sql[sql.length - 1]).toBe("RELEASE");
    const poInserts = db.writes.filter((w) => w.sql.startsWith("INSERT INTO purchase_orders"));
    expect(poInserts).toHaveLength(2);
    expect(poInserts[0].sql).toMatch(/INSERT INTO purchase_orders \(order_id, order_date, supplier, action_items, closed_at, closed_by,[\s\S]*source, entry_seq\)/);
    expect(poInserts[0].sql).toMatch(/'sheet_import'/);
    expect(poInserts[0].sql).not.toMatch(/\bstatus\b/);
    // Closed is AF-only: NEWC (rows say "Closed, Canceled") arrives Open; nothing new writes closed_by = 'sheet'.
    const newc = poInserts.find((w) => w.params?.[0] === "NEWC")!;
    expect([newc.params?.[4], newc.params?.[5]]).toEqual([null, null]);
    expect(newc.params?.[22]).toBe(1); // entry_seq: 7 rows, NEWC on the last row → 7 − 6
    const lineInserts = db.writes.filter((w) => w.sql.startsWith("INSERT INTO po_line_items"));
    expect(lineInserts.find((w) => w.params?.[6] === 0 && w.params?.[11] === 0)).toBeTruthy(); // NEWC: ordered 0, qty_canceled 0 (as-is)
    // Existing POs are never written: no UPDATE / DELETE of any PO table. The
    // only DELETE is the Col P signal table's full refresh (not PO data).
    expect(sql.filter((x) => /^(UPDATE|DELETE)/.test(x))).toEqual(["DELETE FROM po_sheet_fba_shipments"]);
  });
;

  it("Col P: one multi-row insert per run (column arrays), however many entries", async () => {
    const withP = cells.map((c, i) => { const x = [...c]; if (i < 2) x[COL.fbaShipmentIds] = i === 0 ? "FBA19H4BCJP4 (4), FBA19H4BK2W6 (4) [note]" : "FBA19H9RS9TJ"; return x; });
    const db = fakeDb(state);
    const r = await syncPoSheet({ sheetId: "s", dryRun: false, db, read: read(withP) });
    expect(r.counts.colPEntries).toBe(3);
    const ins = db.writes.filter((w) => w.sql.startsWith("INSERT INTO po_sheet_fba_shipments"));
    expect(ins).toHaveLength(1);
    expect(ins[0].sql).toMatch(/unnest\(\$1::text\[\], \$2::text\[\], \$3::text\[\], \$4::int\[\], \$5::text\[\], \$6::numeric\[\], \$7::text\[\]\)/);
    expect(ins[0].params).toHaveLength(7);
    expect(ins[0].params?.[4]).toEqual(["FBA19H4BCJP4", "FBA19H4BK2W6", "FBA19H9RS9TJ"]);
    expect(ins[0].params?.[5]).toEqual([4, 4, null]);
  });

  it("a rolled-back apply rethrows and releases the client", async () => {
    const db = fakeDb(state);
    const failing = { ...db, connect: async () => ({ query: async (sql: string) => { if (sql.startsWith("INSERT")) throw new Error("boom"); return { rows: [], rowCount: 0 }; }, release: () => db.writes.push({ sql: "RELEASE" }) }) };
    await expect(syncPoSheet({ sheetId: "s", dryRun: false, db: failing, read: read(cells) })).rejects.toThrow("boom");
    expect(db.writes.map((w) => w.sql)).toEqual(["RELEASE"]);
  });
});

// ── §4 button wiring ──────────────────────────────────────────────────────────
describe("Sync POs button (§4): PO sync first, then the per-ASIN sync; both outcomes reported", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  it("the route runs syncPoSheet before runSheetsSync, survives a PO-sync failure, and ?dryRun=true writes nothing", () => {
    const routes = read("server/routes.ts");
    const start = routes.indexOf('app.post("/api/sheets/sync"');
    const body = routes.slice(start, routes.indexOf("app.post(", start + 10));
    const po = body.indexOf("await syncPoSheet({ sheetId, dryRun })");
    const asin = body.indexOf("await runSheetsSync(filter)");
    expect(po).toBeGreaterThan(0);
    expect(asin).toBeGreaterThan(po);
    expect(body).toMatch(/poSync = \{ error: err\?\.message \?\? String\(err\) \}/);
    expect(body).toMatch(/if \(dryRun\) return \{ dryRun: true, updated: 0, skipped: 0, errors: \[\], cleared: 0, clearedAsins: \[\], poSync \}/);
    expect(body).toMatch(/return \{ \.\.\.asinSync, poSync \}/);
    expect(body).not.toMatch(/enqueueJob|enqueueOnboardingJob/); // rule C: inline, never a job
  });
  it("the toast shows the PO counts and the ASIN counts, and goes destructive when the PO sync failed or stopped", () => {
    const page = read("client/src/pages/home.tsx");
    const h = page.slice(page.indexOf("const handleSyncSheet"), page.indexOf("}, [toast, currentWorkingSet, fetchAsins"));
    expect(h).toMatch(/fetchLongSync\("\/api\/sheets\/sync", \{ asins: ws \}\)/);
    expect(h).toMatch(/POs: \+\$\{po\.counts\.inserted\} new\$\{po\.counts\.sheetDiffers \? `, \$\{po\.counts\.sheetDiffers\} existing differ from the sheet \(AF owns them — not applied\)`/);
    expect(h).toMatch(/POs: STOPPED, nothing written/);
    expect(h).toMatch(/POs: FAILED/);
    expect(h).toMatch(/ASINs: updated \$\{data\.updated\}, skipped \$\{data\.skipped\}/);
    expect(h).toMatch(/variant: poFailed \? "destructive" : undefined/);
  });
});

// ── Row-level Status (patch docs/claude_spec-patch-row-level-status.md §2, 2026-10-17) ──
describe("row-level Status: each sheet row's Status maps onto its own line", () => {
  // target.com 912003733645362: Kinder's ×2 "Closed", Topps "Received" (2 still at Velocity).
  const state = {
    pos: [po({ id: "pt", order_id: "912003733645362", supplier: "target.com", closed_at: "2026-10-16", closed_by: "sheet", action_items: ["SHIP"] })],
    asins: [
      pa({ id: "k1", po_id: "pt", asin: "B0H4P226KP" }), pa({ id: "k2", po_id: "pt", asin: "B0H3XJTQVG" }), pa({ id: "tp", po_id: "pt", asin: "B0HGP5P91F", qty: 2 }),
    ],
    lines: [
      line({ id: "lk1", po_id: "pt", po_asin_id: "k1" }), line({ id: "lk2", po_id: "pt", po_asin_id: "k2" }), line({ id: "ltp", po_id: "pt", po_asin_id: "tp", qty_ordered: 2, qty_returned: 1 }),
    ],
  };
  const cells = [
    row({ orderId: "912003733645362", supplier: "target.com", asin: "B0H4P226KP", status: "Closed" }),
    row({ orderId: "912003733645362", supplier: "target.com", asin: "B0H3XJTQVG", status: "Closed, See Comments" }),
    row({ orderId: "912003733645362", supplier: "target.com", asin: "B0HGP5P91F", status: "Received, Returned", L: "2", N: "2", R: "" }),
  ];
  it("PO is Open unless EVERY row says Closed; action items go to their own line only; PO-level array untouched", async () => {
    const r = await syncPoSheet({ sheetId: "s", dryRun: true, db: fakeDb(state), read: read(cells) });
    const ch = r.diffs.find((d) => d.po === "target.com 912003733645362")!.changes;
    expect(ch).toContain("closed: closed (sheet) → open");
    expect(ch).toContain('B0H3XJTQVG line 0.action_items: [] → ["See Comments"]');
    expect(ch.some((c) => c.startsWith("B0H4P226KP line 0.action_items"))).toBe(false);
    expect(ch.some((c) => c.startsWith("action_items"))).toBe(false);
    expect(r.counts.sheetDiffers).toBe(1); // drift only — intake-only since 2026-10-18
  });
  it("a Returned row with a blank Col R leaves qty_returned as stored and is reported", async () => {
    const r = await syncPoSheet({ sheetId: "s", dryRun: true, db: fakeDb(state), read: read(cells) });
    expect(r.counts.returnedNoQty).toBe(0); // existing POs are drift-only now; the note still appears in the drift
    const ch = r.diffs.find((d) => d.po === "target.com 912003733645362")!.changes;
    expect(ch.some((c) => c.includes("qty_returned:"))).toBe(false);
    expect(ch).toContain("B0HGP5P91F line 0: Returned with no qty — qty_returned left at 1");
  });
  it("all rows Closed → Closed; Canceled on one row cancels that line only", async () => {
    const all = cells.map((c, i) => { const x = [...c]; x[COL.status] = i === 0 ? "Closed, Canceled" : "Closed"; return x; });
    const r = await syncPoSheet({ sheetId: "s", dryRun: true, db: fakeDb({ ...state, pos: [po({ id: "pt", order_id: "912003733645362", supplier: "target.com" })] }), read: read(all) });
    const ch = r.diffs.find((d) => d.po === "target.com 912003733645362")!.changes;
    expect(ch).toContain("closed: open → closed (sheet)");
    expect(ch).toContain("B0H4P226KP line 0.qty_canceled: NULL → 4");
    expect(ch.some((c) => c.startsWith("B0H3XJTQVG line 0.qty_canceled") || c.startsWith("B0HGP5P91F line 0.qty_canceled"))).toBe(false);
  });
  it("live: new lines carry their own action_items and qty_canceled; ASIN rows carry Col S", async () => {
    const db = fakeDb({ pos: [], asins: [], lines: [] });
    await syncPoSheet({ sheetId: "s", dryRun: false, db, read: read([
      row({ orderId: "NB", asin: "B0BUNDLE01", S: "2", status: "SHIP" }),
      row({ orderId: "NB", asin: "B0BUNDLE01", S: "2", status: "Canceled" }),
    ]) });
    const li = db.writes.filter((w) => w.sql.startsWith("INSERT INTO po_line_items"));
    expect(li.map((w) => [w.params?.[11], w.params?.[12]])).toEqual([[null, ["SHIP"]], [4, []]]);
    expect(li[0].sql).toMatch(/\$13::text\[\]/);
    const ai = db.writes.find((w) => w.sql.startsWith("INSERT INTO po_asins"))!;
    expect(ai.params?.[11]).toBe(2);
    const pi = db.writes.find((w) => w.sql.startsWith("INSERT INTO purchase_orders"))!;
    expect(pi.params?.[3]).toEqual([]); // PO-level action_items no longer written
  });
});


// ── PO history import (patch docs/claude_spec-patch-po-history-import.md, 2026-10-18) ──
describe("pre-2026 history rows", () => {
  it("a pre-2026 PO is imported Closed at its order date with closed_by = 'import'; prep NULL; a 1/n yield single product becomes an n-pack", async () => {
    const db = fakeDb({ pos: [], asins: [], lines: [] });
    const r = await syncPoSheet({ sheetId: "s", dryRun: false, db, read: read([
      row({ orderId: "H1", date: "12/28/2025", asin: "B000GGJCOI", L: "10", N: "5", T: "0.50", Y: "$5.86", status: "Closed" }),
      row({ orderId: "H2", date: "7/1/2025", asin: "B000000002", L: "3", N: "3", T: "1.00", status: "Ordered, SHIP" }),
    ]) });
    expect(r.counts).toMatchObject({ inserted: 2, historyInserted: 2, historyWithActionItems: 1 });
    expect(r.historyPack).toEqual({ derivedMultiPack: 1, individual: 1 });
    const pi = db.writes.filter((w) => w.sql.startsWith("INSERT INTO purchase_orders"));
    expect(pi.map((w) => [w.params?.[0], w.params?.[4], w.params?.[5]])).toEqual([["H1", "2025-12-28", "import"], ["H2", "2025-07-01", "import"]]);
    const ai = db.writes.filter((w) => w.sql.startsWith("INSERT INTO po_asins"));
    // prep_cost $7 NULL; sold_as $8 / units_per_pack $9 derived; cost_per_unit $6 verbatim
    expect(ai.map((w) => [w.params?.[1], w.params?.[5], w.params?.[6], w.params?.[7], w.params?.[8]])).toEqual([["B000GGJCOI", "5.86", null, "multi-pack", 2], ["B000000002", "10.00", null, "individual", 1]]);
  });
  it("an imported (closed_by 'import') PO is never reopened by its rows' Status", async () => {
    const st = { pos: [po({ id: "ph", order_id: "H2", order_date: "2025-07-01", closed_at: "2025-07-01", closed_by: "import" })], asins: [pa({ id: "ah", po_id: "ph", asin: "B000000002", qty: 3, prep_cost: null })], lines: [line({ id: "lh", po_id: "ph", po_asin_id: "ah", qty_ordered: 3 })] };
    const r = await syncPoSheet({ sheetId: "s", dryRun: true, db: fakeDb(st), read: read([row({ orderId: "H2", date: "7/1/2025", asin: "B000000002", L: "3", N: "3", status: "Ordered" })]) });
    const ch = r.diffs.find((d) => d.po === "walmart.com H2")?.changes ?? [];
    expect(ch.some((c) => c.startsWith("closed"))).toBe(false);
  });
  it("one unparseable cell skips that PO only, with its row and reason; the read continues", async () => {
    const bad = row({ orderId: "BAD", date: "3/1/2025" }); bad[COL.weightedGcPct] = "%";
    const r = await syncPoSheet({ sheetId: "s", dryRun: true, db: fakeDb({ pos: [], asins: [], lines: [] }), read: read([bad, row({ orderId: "OK1", date: "3/2/2025" })]) });
    expect(r.stop).toBeNull();
    expect(r.counts).toMatchObject({ inserted: 1, skippedBadCells: 1 });
    expect(r.skippedBadCells).toEqual([{ po: "walmart.com BAD", row: 2, reason: 'unparseable percent: "%"' }]);
  });
  it("a cashback-% cell holding only \"%\" means no cashback: site and percent NULL, the PO imports (Maria 2026-10-18)", async () => {
    const r1 = row({ orderId: "CB", date: "2/2/2025" }); r1[COL.cashbackPct] = "%"; r1[COL.cashbackSite] = "Rakuten";
    const db = fakeDb({ pos: [], asins: [], lines: [] });
    const r = await syncPoSheet({ sheetId: "s", dryRun: false, db, read: read([r1]) });
    expect(r.counts).toMatchObject({ inserted: 1, skippedBadCells: 0 });
    const pi = db.writes.find((w) => w.sql.startsWith("INSERT INTO purchase_orders"))!;
    expect([pi.params?.[15], pi.params?.[16]]).toEqual([null, null]); // cashback_site, cashback_pct
  });
  it("an ASIN cell that is not one ASIN skips its PO (history: any non-ASIN; 2026: only what cannot be stored)", async () => {
    const r = await syncPoSheet({ sheetId: "s", dryRun: true, db: fakeDb({ pos: [], asins: [], lines: [] }), read: read([
      row({ orderId: "X1", date: "9/28/2024", asin: "Shipping Supplies" }),
      row({ orderId: "X2", date: "7/20/2024", asin: "NA" }),
      row({ orderId: "X3", date: "8/9/2026", asin: "NA" }),
      row({ orderId: "X4", date: "8/9/2026", asin: "B001FB5HYC, B00757A9B6" }),
    ]) });
    expect(r.skippedBadCells.map((x) => x.po)).toEqual(["walmart.com X1", "walmart.com X2", "walmart.com X4"]);
    expect(r.counts.inserted).toBe(1); // X3: a 2026 "NA" row is left as the sync has always treated it
  });
  it("\"Lost / Damaged by Us\" fills qty_lost_damaged_us from Col V × yield on insert", async () => {
    const lr = row({ orderId: "LD", date: "12/21/2025", asin: "B078MYRN9V", L: "10", N: "30", T: "3.00", status: "Closed, Lost / Damaged by Us" }); lr[COL.lossQty] = "10";
    const db = fakeDb({ pos: [], asins: [], lines: [] });
    await syncPoSheet({ sheetId: "s", dryRun: false, db, read: read([lr]) });
    expect(db.writes.find((w) => w.sql.startsWith("INSERT INTO po_asins"))?.params?.[12]).toBe(30);
  });
});

describe("af-owned intake-only (patch docs/claude_spec-patch-po-af-owned.md §2, §5.3)", () => {
  it("a PO deleted in AF (deleted_pos tombstone) is never re-imported", async () => {
    const db = fakeDb({ pos: [], asins: [], lines: [], tombstones: [{ supplier: "walmart.com", order_id: "GONE1" }] } as any);
    const r = await syncPoSheet({ sheetId: "s", dryRun: false, db, read: read([row({ orderId: "GONE1" }), row({ orderId: "NEW9" })]) });
    expect(r.counts).toMatchObject({ inserted: 1, tombstoned: 1 });
    expect(db.writes.filter((w) => w.sql.startsWith("INSERT INTO purchase_orders")).map((w) => w.params?.[0])).toEqual(["NEW9"]);
  });
});

describe("decimal quantities (migration 062)", () => {
  it("Col N keeps its decimals; a merged S=1 group's cost is weighted by the exact Col N, and the integer-era weighting is reported for the one-off re-import", () => {
    // homedepot.com WN63100522: two rows of B07N13K4SS, N 0.667 @ $17.61 and 0.333 @ $19.17
    const p = parsePoSheet(HEADER, [
      row({ orderId: "WN63100522", supplier: "homedepot.com", date: "6/28/2026", asin: "B07N13K4SS", L: "1", N: "0.6666666667", T: "0.67", Y: "$17.61" }),
      row({ orderId: "WN63100522", supplier: "homedepot.com", date: "6/28/2026", asin: "B07N13K4SS", L: "1", N: "0.3333333333", T: "0.33", Y: "$19.17" }),
    ]);
    const a = p.pos[0].poAsins[0];
    expect(a.qty).toBe(1);
    expect(a.costPerUnit).toBe("18.12");
    expect(a.costPerUnitIntegerEra).toBe("17.61");
    const single = parsePoSheet(HEADER, [row({ orderId: "1", N: "2.5", L: "5", T: "0.5" })]).pos[0].poAsins[0];
    expect(single.qty).toBe(2.5);
    expect(single.costPerUnitIntegerEra).toBeNull();
  });
});
