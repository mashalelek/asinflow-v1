import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPoFromForm } from "./po-create";
import { loadPoForm, savePoForm } from "./po-edit-form";
import { loadAfPoRows, loadAfAsinCostMap } from "./po-af-source";
import { syncAsinCostsFromPos, clearCostsOfFullyCanceledAsins } from "./asin-po-costs";
import { loadAsinPipeline } from "./asin-po-pipeline";
import { evaluateAutoClose, autoCloseVerdict, type PoCloseRow } from "./po-close";
import { pushTracking } from "./tracking-push";
import { buildVelocityRecords } from "./velocity-export";
import { recomputePoCosts } from "./po-costs";
import { addClaim } from "./supplier-claims";
import { poAsinRowsSql } from "./po-queries";
import { loadGrid } from "./dashboard";
import { emptyPoForm, emptyProduct, type PoFormState } from "@shared/po-form";

// "Components only" PO rows (Maria 2026-11-15, migration 116; SPEC §22 "Bundles" → "Components only") on the REAL
// local schema, every test inside a transaction that is ROLLED BACK. One bullet of the brief per assertion block:
// never a Velocity order (no create / update / skip, no tracking push), never in COGS (save sync, hourly backstop,
// SB / SC exports), not On Order, never blocks or drives auto-close, Spend / claims / tracking as usual, Individual
// units only with no whole-packs warning, one product on a bundle ASIN allowed. Skipped when no local Postgres answers.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT components_only FROM po_asins LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
  process.env.VELOCITY_MIN_ORDER_DATE ??= "1/1/2025";
});
afterAll(async () => { await client?.end(); });
type Q = (sql: string, params?: any[]) => Promise<any>;

const ASIN = "B0ZZCOMPON";   // the bundle whose balms are bought as components (B0GWG5S64Q on production)
const ASIN2 = "B0ZZCOMPTW";  // an ASIN with ONLY a components-only row
const COMP_ORDER = "zz-200015730948075", FULL_ORDER = "zz-200015415094735", MIXED_ORDER = "zz-200015999999999";
const noLog = () => {};

const balm = (qty: string, asin = ASIN) => ({ ...emptyProduct(), product_name: "zz Dr Teal's balm", price: "3.00", qty_ordered: qty, asin, sold_as: "bundle" as const, units_per_pack: "2", prep_cost: "1.00" });
const oil = (qty: string) => ({ ...emptyProduct(), product_name: "zz Dr Teal's oil", price: "4.00", qty_ordered: qty, asin: ASIN, sold_as: "bundle" as const, units_per_pack: "2", prep_cost: "1.00" });
const compForm = (date = "2027-01-05"): PoFormState => ({ ...emptyPoForm(date), supplier: "walmart.com", order_id: COMP_ORDER, products: [balm("5")], components_only: { [ASIN]: true } });
const fullForm = (): PoFormState => ({ ...emptyPoForm("2026-11-01"), supplier: "walmart.com", order_id: FULL_ORDER, products: [balm("6"), oil("6")] });
const mixedForm = (): PoFormState => ({ ...emptyPoForm("2026-11-10"), supplier: "walmart.com", order_id: MIXED_ORDER, products: [balm("6"), oil("6"), balm("5", ASIN2)], components_only: { [ASIN2]: true } });

async function seed(q: Q) {
  for (const a of [ASIN, ASIN2]) {
    await q(`INSERT INTO asins (asin, title, primary_sku, has_live_offer, sold_as, units_per_pack) VALUES ($1, 'zz components-only test', $2, true, 'bundle', 2)`, [a, `ZZ-${a}`]);
    await q(`INSERT INTO asin_estimates (asin) VALUES ($1)`, [a]);
  }
  const comp = (await createPoFromForm(q, compForm(), null)).poId;
  const full = (await createPoFromForm(q, fullForm(), null)).poId;
  const mixed = (await createPoFromForm(q, mixedForm(), null)).poId;
  return { comp, full, mixed };
}
const rowOf = async (q: Q, po: string, asin = ASIN) => (await q(`SELECT pa.*, e.ordered_asin, e.ordered_individual, e.expected_individual, e.open_claims FROM po_asins pa JOIN po_asin_expected e ON e.id = pa.id WHERE pa.po_id = $1 AND pa.asin = $2`, [po, asin])).rows[0];
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id LIKE 'zz-2000159%' OR order_id = $1 OR order_id = $2`, [COMP_ORDER, FULL_ORDER])).rows[0].n).toBe(0);
  expect((await client!.query(`SELECT count(*)::int AS n FROM asins WHERE asin IN ($1, $2)`, [ASIN, ASIN2])).rows[0].n).toBe(0);
}

describe("Components only (migration 116) on the real schema, rolled back", () => {
  it("stored as a purchase record: one product on a bundle ASIN, qty = Σ Individual units, cost per Individual unit, the API row says so; the whole-packs warning never fires", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const r = await rowOf(q, s.comp);
      expect(r).toMatchObject({ components_only: true, sold_as: "bundle", units_per_pack: 2, unique_products: 1, qty_basis: "individual", cost_per_unit: "3.00", prep_cost: "1.00" });
      expect(Number(r.qty)).toBe(5);                  // 5 balms: Individual units as stored
      expect(Number(r.ordered_individual)).toBe(5);
      expect(Number(r.ordered_asin)).toBe(2.5);       // the view's ÷ pack — never shown for this row
      const api = (await q(poAsinRowsSql(`pa.po_id = $1`), [s.comp])).rows[0];
      expect(api.components_only).toBe(true);
      expect(Number(api.total_cost)).toBe(15); // Individual units × the per-Individual cost
      // Off: the same one-product bundle is refused, as before.
      await expect(createPoFromForm(q, { ...compForm("2027-01-06"), order_id: "zz-2000159000000002", components_only: {} }, null)).rejects.toThrow(/a bundle needs at least two products/);
      // The ordinary bundle row beside it is unchanged by the flag: 6 bundles × 2 = 12 Individual units at $7.00 a bundle.
      expect(await rowOf(q, s.full)).toMatchObject({ components_only: false, unique_products: 2, cost_per_unit: "7.00" });
      expect(Number((await rowOf(q, s.full)).qty)).toBe(12);
      // recomputePoCosts keeps the per-Individual basis.
      await recomputePoCosts(q, s.comp, null);
      expect((await rowOf(q, s.comp)).cost_per_unit).toBe("3.00");
    });
  });

  it("never a Velocity order: not a row of the plan's source (no create, no update, no 'will skip'), SB COGS and SC COGS exports read the same rows; its PO's tracking is not pushed — a mixed PO's still is", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const rows = (await loadAfPoRows(q)).rows;
      expect(rows.filter((r) => r.orderNumber === COMP_ORDER)).toEqual([]);
      expect(rows.filter((r) => r.orderNumber === FULL_ORDER)).toHaveLength(2);
      expect(rows.filter((r) => r.orderNumber === MIXED_ORDER).map((r) => r.asin)).toEqual([ASIN, ASIN]); // ASIN2's components-only row is not there
      const plan = await buildVelocityRecords(new Date(2026, 9, 1), new Date(2027, 11, 31), { query: q });
      const text = JSON.stringify(plan);
      expect(text).not.toContain(COMP_ORDER);
      expect(text).not.toContain(ASIN2);
      expect(text).toContain(FULL_ORDER);
      // Tracking push (dry run): the components-only PO has no row to evaluate; the mixed PO has.
      for (const po of [s.comp, s.mixed]) await q(`INSERT INTO po_tracking (po_id, carrier, tracking_number, gmail_message_id, status, source) VALUES ($1, 'UPS', $2, $3, 'matched', 'manual')`, [po, `1ZZZ${po.slice(0, 8)}`, `zz-msg-${po}`]);
      const deps = { list: async () => [], known: async () => [], append: async () => { throw new Error("never called on a dry run"); } };
      expect((await pushTracking({ query: q, deps, dryRun: true, poId: s.comp })).rows_evaluated).toBe(0);
      expect((await pushTracking({ query: q, deps, dryRun: true, poId: s.mixed })).rows_evaluated).toBe(1);
    });
  });

  it("never in COGS: the cost map, the save-time sync and the hourly backstop read the ASIN's newest OTHER row; an ASIN with only a components-only row keeps what it has; the canceled-clear ignores it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      await q(`UPDATE asin_estimates SET actual_cogs = 9.99, cogs = 9.99, cogs_source = 'manual' WHERE asin = $1`, [ASIN2]);
      const map = (await loadAfAsinCostMap(q, [ASIN, ASIN2])).data;
      expect(map.get(ASIN)).toMatchObject({ cogs: 7, prepCost: 1 }); // the 2026-11-01 bundle row, not the newer (2027) components-only row
      expect(map.has(ASIN2)).toBe(false);
      await syncAsinCostsFromPos(q as any, new Set([ASIN, ASIN2]), noLog);
      expect((await q(`SELECT actual_cogs, cogs_source FROM asin_estimates WHERE asin = $1`, [ASIN])).rows[0]).toEqual({ actual_cogs: "7.00", cogs_source: "af_po" });
      expect((await q(`SELECT actual_cogs, cogs_source FROM asin_estimates WHERE asin = $1`, [ASIN2])).rows[0]).toEqual({ actual_cogs: "9.99", cogs_source: "manual" });
      expect(await clearCostsOfFullyCanceledAsins(q as any, [ASIN, ASIN2])).toEqual([]);
      expect((await q(`SELECT actual_cogs FROM asin_estimates WHERE asin = $1`, [ASIN2])).rows[0].actual_cogs).toBe("9.99");
      expect((await q(`SELECT actual_cogs, estimated_cogs FROM asin_estimates WHERE asin = $1`, [s.comp ? ASIN : ASIN])).rows[0].estimated_cogs).not.toBe("3.00");
    });
  });

  it("not On Order; outside the auto-close rule (a mixed PO closes on its other rows, a PO of only components-only rows never auto-closes); Spend counts it; a claim on its line works as usual", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const pipe = await loadAsinPipeline(q, [ASIN, ASIN2]);
      expect(pipe.get(ASIN)).toMatchObject({ on_order: 12, open_po_count: 2 }); // the full and the mixed PO's bundle rows (6 + 6), never the 2.5 of the components-only row
      expect(pipe.has(ASIN2)).toBe(false);
      // Auto-close: the mixed PO with its bundle row fully shipped closes although its components-only row shipped nothing …
      const before = (await q(poAsinRowsSql(`pa.po_id = $1`), [s.mixed])).rows as PoCloseRow[];
      expect(autoCloseVerdict(before, [], 0)).toBe(false);
      await q(`UPDATE po_asins SET qty_shipped_fba = 12 WHERE po_id = $1 AND asin = $2`, [s.mixed, ASIN]);
      const after = (await q(poAsinRowsSql(`pa.po_id = $1`), [s.mixed])).rows as PoCloseRow[];
      expect(after.find((r: any) => r.asin === ASIN2)).toMatchObject({ components_only: true });
      expect(autoCloseVerdict(after, [], 0)).toBe(true);
      // … and the components-only PO stays open until closed by hand, even with nothing due.
      expect((await evaluateAutoClose(s.comp, q)).closed).toBe(false);
      // Spend: the PO's order total counts on its day.
      const g = await loadGrid(q, 1, undefined, new Date("2027-01-05T17:00:00Z"));
      expect(g.columns[0].eastern).toEqual({ from: "2027-01-05", to: "2027-01-05" });
      expect(g.columns[0].cells.spend.value).toBe(15);
      // A claim on the line: 2 balms canceled by the supplier → expected 3 Individual units, one open claim on the row.
      const line = (await q(`SELECT id FROM po_line_items WHERE po_id = $1`, [s.comp])).rows[0].id;
      await addClaim(q, s.comp, { po_line_item_id: String(line), kind: "canceled", qty: 2 }, null);
      const r = await rowOf(q, s.comp);
      expect(Number(r.expected_individual)).toBe(3);
      expect(Number(r.open_claims)).toBe(1);
    });
  });

  it("Edit PO: the checkbox comes back on; off with one product on a bundle is refused; toggling the mixed PO's bundle row on re-stores Σ Individual units and a per-Individual cost with History rows, off restores the bundle rule", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const f = (await loadPoForm(q, s.comp))!.form;
      expect(f.components_only).toEqual({ [ASIN]: true });
      await expect(savePoForm(q, s.comp, { ...f, components_only: {} }, null)).rejects.toThrow(/a bundle needs at least two products/);
      const m = (await loadPoForm(q, s.mixed))!.form;
      expect(m.components_only).toEqual({ [ASIN2]: true });
      await savePoForm(q, s.mixed, { ...m, components_only: { [ASIN2]: true, [ASIN]: true } }, null);
      let r = await rowOf(q, s.mixed);
      expect(r).toMatchObject({ components_only: true, cost_per_unit: "3.50" }); // (6 × 3 + 6 × 4) ÷ 12 Individual units
      expect(Number(r.qty)).toBe(12);
      const log = (await q(`SELECT field, old_value, new_value FROM po_edit_log WHERE po_id = $1 AND entity = 'asin' AND entity_id = $2 ORDER BY id`, [s.mixed, r.id])).rows;
      expect(log).toContainEqual({ field: "components_only", old_value: "false", new_value: "true" });
      expect(log).toContainEqual({ field: "cost_per_unit", old_value: "7", new_value: "3.5" });
      await savePoForm(q, s.mixed, { ...m, components_only: { [ASIN2]: true } }, null);
      r = await rowOf(q, s.mixed);
      expect(r).toMatchObject({ components_only: false, cost_per_unit: "7.00" });
      expect(Number(r.qty)).toBe(12);
    });
  });
});
