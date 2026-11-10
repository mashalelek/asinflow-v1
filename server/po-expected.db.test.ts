import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { poAsinRowsSql, loadPoAsinRows } from "./po-queries";
import { ASIN_ROW_QTY_FIELDS, asinRowFactor, lineFactor, storedQtyForAsinRow, storedQtyForLine, asinUnitsOf, productUnitsOf, individualOf } from "./po-expected";
import { addClaim, setOutcome } from "./supplier-claims";
import { editLine, editAsinRow } from "./po-edit";
import { loadAsinPipeline } from "./asin-po-pipeline";

// The two quantity views of migration 101 (SPEC §22 "Supplier claims" §4.6, D17): every PO quantity in Individual,
// Product and ASIN units from the stored Individual base; a bundle by the bundle rule; a legacy row / line (pack not
// known) read as stored and converted the moment its pack arrives. Against the REAL schema, rolled back.
describe("the writers' conversions (pure)", () => {
  it("ASIN / Product units ↔ the stored Individual units; a legacy row or line stores its basis as before", () => {
    expect(asinRowFactor({ qty_basis: "individual", sold_as: "multi-pack", units_per_pack: 2 })).toBe(2);
    expect(asinRowFactor({ qty_basis: "asin_legacy", units_per_pack: null })).toBe(1);
    expect(lineFactor({ qty_basis: "individual", retailer_units_per_product: 6 })).toBe(6);
    expect(lineFactor({ qty_basis: "product_legacy", retailer_units_per_product: null })).toBe(1);
    expect(storedQtyForAsinRow(5.5, { qty_basis: "individual", units_per_pack: 2 })).toBe(11);
    expect(storedQtyForLine(2, { qty_basis: "individual", retailer_units_per_product: 6 })).toBe(12);
    expect(asinUnitsOf("11.00", { qty_basis: "individual", units_per_pack: 2 })).toBe(5.5);
    expect(productUnitsOf("12.00", { qty_basis: "individual", retailer_units_per_product: 6 })).toBe(2);
    expect(individualOf("12.00", { qty_basis: "asin_legacy" })).toBeNull();
    expect(individualOf("12.00", { qty_basis: "individual" })).toBe(12);
  });
  it("the ASIN-row overlay names every API field the clients read, after pa.* (the later duplicate wins in node-pg)", () => {
    const sql = poAsinRowsSql("pa.po_id = $1");
    expect(sql.indexOf("pa.*")).toBeLessThan(sql.indexOf("e.ordered_asin AS qty"));
    for (const [api, col] of Object.entries(ASIN_ROW_QTY_FIELDS)) expect(sql).toContain(`e.${col} AS ${api}`);
    expect(sql).toContain("JOIN po_asin_expected e ON e.id = pa.id");
  });
});

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM po_asin_expected LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });
type Q = (sql: string, params?: any[]) => Promise<any>;
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id LIKE 'zz-view-%'`)).rows[0].n).toBe(0);
}
const po = async (q: Q, suffix: string) => (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, order_total) VALUES ($1, '2026-10-18', 'zz-test.com', 100, 100) RETURNING id`, [`zz-view-${suffix}`])).rows[0].id as string;
const row = async (q: Q, poId: string, asin: string, o: { qty: number; sold_as: string | null; upp: number | null; basis?: string }) =>
  (await q(`INSERT INTO po_asins (po_id, asin, qty, sold_as, units_per_pack, qty_basis) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [poId, asin, o.qty, o.sold_as, o.upp, o.basis ?? (o.sold_as ? "individual" : "asin_legacy")])).rows[0].id as string;
const line = async (q: Q, poId: string, paId: string, pos: number, o: { qty: number; pack: number | null; asinPack?: number | null; perBundle?: number | null; price?: number; basis?: string; name?: string }) =>
  (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered, price, adjusted_product_cost, retailer_units_per_product, asin_units_per_pack, units_per_bundle, qty_basis) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10) RETURNING id`,
    [poId, paId, pos, o.name ?? `zz line ${pos}`, o.qty, o.price ?? 10, o.pack, o.asinPack ?? null, o.perBundle ?? null, o.basis ?? (o.pack ? "individual" : "product_legacy")])).rows[0].id as string;
const vA = async (q: Q, paId: string) => (await q(`SELECT * FROM po_asin_expected WHERE id = $1`, [paId])).rows[0];
const vL = async (q: Q, lineId: string) => (await q(`SELECT * FROM po_line_expected WHERE line_id = $1`, [lineId])).rows[0];

describe("po_line_expected / po_asin_expected on the real schema (rolled back)", () => {
  it("Caress: 11 singles bought for a 2-pack ASIN → 11 Individual = 11 Product = 5.5 ASIN units; a claim's units leave Expected in all three", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const p = await po(q, "caress"), pa = await row(q, p, "B0ZZVIEW01", { qty: 11, sold_as: "multi-pack", upp: 2 });
      const l = await line(q, p, pa, 0, { qty: 11, pack: 1, asinPack: 2, price: 5.97 });
      expect(await vL(q, l)).toMatchObject({ ordered_individual: "11.00", ordered_product: "11.00", ordered_asin: "5.50", expected_individual: "11.00", expected_asin: "5.50", claimed_individual: "0.00", fully_canceled: false });
      expect(await vA(q, pa)).toMatchObject({ ordered_individual: "11.00", ordered_product: "11.00", ordered_asin: "5.50", expected_asin: "5.50", product_pack: 1 });
      // 1 missing, written off → Expected 10 Individual = 5 ASIN; the claim's $ = 1 × 5.97
      const { id } = await addClaim(q, p, { po_line_item_id: l, kind: "missing", qty: 1 }, null);
      await setOutcome(q, id, { outcome: "write_off", reason: "test" }, null);
      expect(await vL(q, l)).toMatchObject({ claimed_individual: "1.00", claimed_product: "1.00", claimed_asin: "0.50", expected_individual: "10.00", expected_product: "10.00", expected_asin: "5.00" });
      expect(await vA(q, pa)).toMatchObject({ expected_asin: "5.00", expected_individual: "10.00", claimed_asin: "0.50" });
      // the API row: ASIN units under the old names, the Individual twins beside
      const [r] = await loadPoAsinRows(q as any, [p]);
      expect(r).toMatchObject({ qty: 5.5, qty_individual: 11, qty_expected_asin: "5.00", qty_basis: "individual" });
      expect(r.lines[0]).toMatchObject({ qty_ordered: 11, qty_ordered_individual: 11, qty_expected: 10, qty_expected_individual: 10 });
    });
  });

  it("a bundle ×2 (1 balm + 1 oil): 12 singles + 2 six-packs → 12 bundles, 24 Individual; a canceled claim on one component caps the bundles", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const p = await po(q, "bundle"), pa = await row(q, p, "B0ZZVIEW02", { qty: 24, sold_as: "bundle", upp: 2 });
      const balm = await line(q, p, pa, 0, { qty: 12, pack: 1, asinPack: 2, perBundle: 1, price: 5.87, name: "balm" });
      const oil = await line(q, p, pa, 1, { qty: 12, pack: 6, asinPack: 2, perBundle: 1, price: 31.7, name: "(6 pack) oil" });
      expect(await vL(q, balm)).toMatchObject({ ordered_individual: "12.00", ordered_product: "12.00", ordered_asin: "12.00", per_bundle: 1 });
      expect(await vL(q, oil)).toMatchObject({ ordered_individual: "12.00", ordered_product: "2.00", ordered_asin: "12.00" });
      expect(await vA(q, pa)).toMatchObject({ ordered_asin: "12.00", ordered_individual: "24.00", expected_asin: "12.00", expected_individual: "24.00" });
      // 6 oils canceled (one six-pack) → only 6 bundles can be built; the row's Individual = bundles × N
      await addClaim(q, p, { po_line_item_id: oil, kind: "canceled", qty: 6 }, null);
      expect(await vL(q, oil)).toMatchObject({ canceled_individual: "6.00", canceled_product: "1.00", canceled_asin: "6.00", expected_asin: "6.00" });
      expect(await vA(q, pa)).toMatchObject({ expected_asin: "6.00", expected_individual: "12.00", claimed_asin: "6.00", canceled_asin: "6.00" });
      // On Order reads the same: 6 bundles expected, nothing shipped
      const pipe = await loadAsinPipeline(q as any, ["B0ZZVIEW02"]);
      expect(pipe.get("B0ZZVIEW02")?.on_order).toBe(6);
    });
  });

  it("a 2:1 bundle ×3 (2 of A + 1 of B): 20 A + 10 B → 10 bundles, 30 Individual; the component's ASIN units = Individual ÷ its units per bundle", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const p = await po(q, "bundle21"), pa = await row(q, p, "B0ZZVIEW03", { qty: 30, sold_as: "bundle", upp: 3 });
      const a = await line(q, p, pa, 0, { qty: 20, pack: 1, asinPack: 3, perBundle: 2, name: "A" });
      const b = await line(q, p, pa, 1, { qty: 10, pack: 1, asinPack: 3, perBundle: 1, name: "B" });
      expect(await vL(q, a)).toMatchObject({ ordered_asin: "10.00", per_bundle: 2 });
      expect(await vL(q, b)).toMatchObject({ ordered_asin: "10.00", per_bundle: 1 });
      expect(await vA(q, pa)).toMatchObject({ ordered_asin: "10.00", ordered_individual: "30.00", expected_asin: "10.00" });
      // with no stored split the view proposes the even one where N divides (×3 over 3 lines) and gives NULL ASIN units where it does not
      const pa2 = await row(q, p, "B0ZZVIEW04", { qty: 30, sold_as: "bundle", upp: 3 });
      const c = await line(q, p, pa2, 0, { qty: 20, pack: 1, asinPack: 3, name: "C" });
      await line(q, p, pa2, 1, { qty: 10, pack: 1, asinPack: 3, name: "D" });
      expect((await vL(q, c)).per_bundle).toBeNull();
      expect((await vL(q, c)).ordered_asin).toBeNull();
    });
  });

  it("a row with no pack size (NULL sold_as) stays asin_legacy: ASIN units as stored, Individual NULL — and converts the moment the pack arrives (the trigger), History row included", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const p = await po(q, "legacy"), pa = await row(q, p, "B0ZZVIEW05", { qty: 2.5, sold_as: null, upp: null });
      const l = await line(q, p, pa, 0, { qty: 2.5, pack: null, asinPack: null });
      await q(`UPDATE po_line_items SET asin_qty_per_product = 1 WHERE id = $1`, [l]);
      expect(await vA(q, pa)).toMatchObject({ qty_basis: "asin_legacy", ordered_asin: "2.50", ordered_individual: null, expected_asin: "2.50" });
      expect(await vL(q, l)).toMatchObject({ qty_basis: "product_legacy", ordered_product: "2.50", ordered_individual: null, ordered_asin: "2.50" });
      const [r] = await loadPoAsinRows(q as any, [p]);
      expect(r).toMatchObject({ qty: 2.5, qty_individual: null, qty_basis: "asin_legacy" });
      // the pack arrives: 2.5 ASIN units of a 2-pack = 5 Individual
      await editAsinRow(q, pa, { sold_as: "multi-pack", units_per_pack: 2 }, null);
      const after = (await q(`SELECT qty, qty_basis FROM po_asins WHERE id = $1`, [pa])).rows[0];
      expect(after).toEqual({ qty: "5.00", qty_basis: "individual" });
      expect(await vA(q, pa)).toMatchObject({ ordered_asin: "2.50", ordered_individual: "5.00" });
      expect((await q(`SELECT field, new_value FROM po_edit_log WHERE po_id = $1 AND field = 'qty_basis' AND entity = 'asin'`, [p])).rows).toEqual([{ field: "qty_basis", new_value: "individual (× 2 = 5.00)" }]);
      // the legacy LINE converted with it (the pack set on the row gives the line its integers, 2 over 2): 2.5 Product units × 2 = 5 Individual, read back as 2.5 Product units
      expect((await q(`SELECT qty_ordered, qty_basis, retailer_units_per_product FROM po_line_items WHERE id = $1`, [l])).rows[0]).toEqual({ qty_ordered: "5.00", qty_basis: "individual", retailer_units_per_product: 2 });
      expect(await vL(q, l)).toMatchObject({ ordered_product: "2.50", ordered_individual: "5.00" });
      // and the pack cleared again takes the row back to ASIN units (÷ 2), asin_legacy, so the basis check always holds
      await editAsinRow(q, pa, { sold_as: null }, null);
      expect((await q(`SELECT qty, qty_basis, units_per_pack FROM po_asins WHERE id = $1`, [pa])).rows[0]).toEqual({ qty: "2.50", qty_basis: "asin_legacy", units_per_pack: null });
    });
  });

  it("editLine takes Product units and stores Individual (× the Product pack); a pack change keeps the Product units; a 3.33 × 3 legacy value rounds to 10", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const p = await po(q, "edit"), pa = await row(q, p, "B0ZZVIEW06", { qty: 12, sold_as: "individual", upp: 1 });
      const l = await line(q, p, pa, 0, { qty: 12, pack: 1, asinPack: 1 });
      await editLine(q, l, { qty_ordered: "2", retailer_units_per_product: "6" }, null);
      expect((await q(`SELECT qty_ordered FROM po_line_items WHERE id = $1`, [l])).rows[0].qty_ordered).toBe("12.00"); // 2 six-packs
      expect(await vL(q, l)).toMatchObject({ ordered_product: "2.00", ordered_individual: "12.00", ordered_asin: "12.00" });
      await editLine(q, l, { retailer_units_per_product: "1" }, null); // the Product units stay 2
      expect((await q(`SELECT qty_ordered FROM po_line_items WHERE id = $1`, [l])).rows[0].qty_ordered).toBe("2.00");
      expect((await q(`SELECT qty FROM po_asins WHERE id = $1`, [pa])).rows[0].qty).toBe("2.00"); // Ordered recomputed in Individual units
      // the migration's tolerance: a 2-dp third × 3 is a whole number
      expect((await q(`SELECT po_qty_individual(3.33, 3) AS a, po_qty_individual(3.67, 3) AS b, po_qty_individual(1.17, 6) AS c, po_qty_individual(0.36, 1) AS d, po_qty_individual(2.5, 2) AS e`)).rows[0]).toEqual({ a: "10", b: "11", c: "7", d: null, e: "5" });
    });
  });
});

describe("the migration file", () => {
  it("converts every quantity column in place with the tolerance, flags the rest, drops the old columns and the refund status, and never touches a bundle component by × N", () => {
    const sql = readFileSync("database/migrations/101_supplier_claims.sql", "utf8");
    for (const c of ["qty_shipped_supplier", "qty_at_prep", "qty_at_warehouse", "received_velocity", "extra_units_cleared_shipped"]) expect(sql).toContain(`${c} = po_qty_individual(pa.${c}, pa.units_per_pack)`);
    // the history columns keep a fraction rather than hold the row in its old basis (a 0.17-pack sheet loss)
    for (const c of ["qty_lost_damaged_us", "unreimbursed_loss_qty"]) expect(sql).toContain(`${c} = po_qty_individual_loose(pa.${c}, pa.units_per_pack)`);
    expect(sql).toContain("qty_ordered = po_qty_individual(l.qty_ordered, l.retailer_units_per_product)");
    expect(sql).toMatch(/ALTER TABLE po_line_items DROP COLUMN final_qty;\s*ALTER TABLE po_line_items DROP COLUMN qty_canceled;\s*ALTER TABLE po_line_items DROP COLUMN qty_returned;/);
    expect(sql).toContain("ALTER TABLE po_line_refunds DROP COLUMN status;");
    expect(sql).toContain("CREATE VIEW po_line_expected AS");
    expect(sql).toContain("CREATE VIEW po_asin_expected AS");
    expect(sql).not.toMatch(/retailer_units_per_product \* pa\.units_per_pack/);
  });
});
