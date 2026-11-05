// Card reward % counts toward COGS (Maria 2026-11-04; SPEC §22 "Costs", migration 090).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { weightedPaymentPct, defaultRewardPct, canonicalPaymentName, checkPoForm, emptyPoForm, emptyPayment, WEIGHTED_PAYMENT_LABEL } from "@shared/po-form";
import { withRewardDefaults } from "./po-create";
import { addMoneyRow, editMoneyRow, syncWeightedPaymentPct } from "./po-money-edit";

const ALIASES = { "OnePay Cash": "Walmart card", "OnePay CashRewards": "Walmart card" };
const REWARDS = { "Walmart card": 5 };

describe("payment rewards: the pure rules", () => {
  it("the label; Walmart card (and both aliases) defaults to 5 %, every other method to none", () => {
    expect(WEIGHTED_PAYMENT_LABEL).toBe("Weighted payment discount %");
    for (const n of ["Walmart card", "OnePay Cash", "OnePay CashRewards", "onepay cashrewards 1234"]) expect(defaultRewardPct(canonicalPaymentName(n, ALIASES), REWARDS)).toBe(5);
    expect(defaultRewardPct(canonicalPaymentName("Amex Gold", ALIASES), REWARDS)).toBeNull();
    expect(defaultRewardPct("Walmart card", null)).toBeNull();
  });
  it("weighted by amount over the order total: gift-card GC % and card reward %; other methods and missing figures do not count", () => {
    expect(weightedPaymentPct([{ method: "card", amount: "100.00", reward_pct: "5" }], 100)).toBe(5);
    expect(weightedPaymentPct([{ method: "card", amount: "60", reward_pct: "5" }, { method: "gift_card", amount: "40", gift_card_discount_pct: "10" }], 100)).toBe(7);
    expect(weightedPaymentPct([{ method: "card", amount: "60", reward_pct: "5" }, { method: "card", amount: "40", reward_pct: "" }], 100)).toBe(3);
    expect(weightedPaymentPct([{ method: "paypal", amount: "100", reward_pct: "5" }], 100)).toBeNull(); // only cards earn the reward
    expect(weightedPaymentPct([{ method: "gift_card", amount: "100", reward_pct: "5" }], 100)).toBeNull(); // a gift card's figure is its GC %
    expect(weightedPaymentPct([{ method: "card", amount: null, reward_pct: "5" }], 100)).toBeNull();
    expect(weightedPaymentPct([{ method: "card", amount: "100", reward_pct: "5" }], 0)).toBeNull();
  });
  it("the form: a card payment's reward % feeds weightedGcPct; a bad reward % is an error; cashback % stays outside it", () => {
    const f = { ...emptyPoForm("2031-01-05"), payments: [{ ...emptyPayment("card"), nickname: "Walmart card", amount: "50.00", reward_pct: "5" }, { ...emptyPayment("gift_card"), amount: "50.00", gift_card_discount_pct: "8" }], order_total: "100.00", cashback_pct: "10" };
    expect(checkPoForm(f).weightedGcPct).toBe(6.5);
    expect(checkPoForm({ ...f, payments: [{ ...f.payments[0], reward_pct: "120" }] }).errors).toContain("Payment 1 (Walmart card): reward must be a percentage between 0 and 100");
  });
  it("withRewardDefaults: a card with no reward % takes its method's default before the check; a typed 0 stays; other methods untouched", async () => {
    const q = (async (sql: string) => (/settings/.test(sql) ? { rows: [{ key: "po_payment_method_aliases", value: ALIASES }, { key: "po_payment_method_reward_pct", value: REWARDS }] } : { rows: [] })) as any;
    const f = { ...emptyPoForm("2031-01-05"), payments: [{ ...emptyPayment("card"), nickname: "OnePay CashRewards", amount: "10" }, { ...emptyPayment("card"), nickname: "Walmart card", amount: "10", reward_pct: "0" }, { ...emptyPayment("card"), nickname: "Amex Gold", amount: "10" }, { ...emptyPayment("gift_card"), nickname: "Walmart card", amount: "10" }] };
    expect((await withRewardDefaults(q, f)).payments!.map((p) => p.reward_pct)).toEqual(["5.00", "0", "", ""]);
  });
});

// The whole path on the real local schema, inside a transaction that is ROLLED BACK.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT reward_pct FROM po_payments LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

describe("payment rewards on the real schema (rolled back)", () => {
  it("a card payment added on a form-saved PO takes 5 %, the weighted % follows with a History row and COGS drops 5 %; a sheet-imported PO is untouched", async (ctx) => {
    if (!client) return ctx.skip();
    const q = (sql: string, params?: any[]) => client!.query(sql, params);
    await q("BEGIN");
    try {
      await q(`INSERT INTO settings (key, value) VALUES ('po_payment_method_reward_pct', '{"Walmart card": 5}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = '{"Walmart card": 5}'::jsonb`);
      const mk = async (oid: string, version: number | null) => {
        const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, tax, sh_donations, discount, order_total, cost_formula_version) VALUES ($1, '2031-01-05', 'zz-rewards.test', 100, 0, 0, 0, 100, $2) RETURNING id`, [oid, version])).rows[0].id;
        const pa = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as, cost_per_unit) VALUES ($1, 'B0ZZREWARD', 10, 1, 'individual', 10.00) RETURNING id`, [po])).rows[0].id;
        await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered, price, retailer_units_per_product, asin_units_per_pack, asin_qty_per_product) VALUES ($1, $2, 0, 'zz', 10, 10, 1, 1, 1)`, [po, pa]);
        return po as string;
      };
      const form = await mk("zz-R1", 3), sheet = await mk("zz-R2", null);
      const r = await addMoneyRow(q as any, "po_payments", form, { method: "card", nickname: "OnePay CashRewards", amount: "100.00" }, null);
      expect((await q(`SELECT reward_pct, nickname FROM po_payments WHERE id = $1`, [r.id])).rows[0]).toMatchObject({ reward_pct: "5.00" });
      expect((await q(`SELECT weighted_gc_discount_pct FROM purchase_orders WHERE id = $1`, [form])).rows[0].weighted_gc_discount_pct).toBe("5.00");
      expect(Number((await q(`SELECT cost_per_unit FROM po_asins WHERE po_id = $1`, [form])).rows[0].cost_per_unit)).toBeCloseTo(9.5, 2);
      expect((await q(`SELECT field, old_value, new_value FROM po_edit_log WHERE po_id = $1 AND field = 'weighted_gc_discount_pct'`, [form])).rows).toEqual([{ field: "weighted_gc_discount_pct", old_value: null, new_value: "5.00" }]);
      // edited per PO: 0 → the weighted % and COGS follow back
      await editMoneyRow(q as any, "po_payments", r.id, { reward_pct: "0" }, null);
      expect(Number((await q(`SELECT cost_per_unit FROM po_asins WHERE po_id = $1`, [form])).rows[0].cost_per_unit)).toBeCloseTo(10, 2);
      // sheet-imported: the payment is stored, nothing derived or recomputed
      await addMoneyRow(q as any, "po_payments", sheet, { method: "card", nickname: "Walmart card", amount: "100.00" }, null);
      expect((await q(`SELECT weighted_gc_discount_pct FROM purchase_orders WHERE id = $1`, [sheet])).rows[0].weighted_gc_discount_pct).toBeNull();
      expect((await q(`SELECT cost_per_unit FROM po_asins WHERE po_id = $1`, [sheet])).rows[0].cost_per_unit).toBe("10.00");
      expect((await syncWeightedPaymentPct(q as any, sheet, null)).recomputed).toBeNull();
    } finally { await q("ROLLBACK"); }
    expect((await client.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE supplier = 'zz-rewards.test'`)).rows[0].n).toBe(0);
  });
});
