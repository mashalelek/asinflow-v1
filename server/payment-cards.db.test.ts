import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaymentNickname, canonicalPaymentName, type PaymentLists } from "@shared/po-form";
import { refundCardWord } from "./claim-emails";

// The Wells Fargo card (Maria 2026-11-15, migration 115) on the REAL local schema: the three settings every
// picker and parser read, the hand-typed payments relinked by the migration's own SQL (run again inside a
// transaction that is ROLLED BACK — it is idempotent). Skipped only when no local Postgres answers.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM po_payments LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });
type Q = (sql: string, params?: any[]) => Promise<any>;

async function lists(q: Q): Promise<PaymentLists> {
  const rows = (await q(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [["po_payment_methods", "po_payment_method_aliases", "po_payment_method_last4"]])).rows as Array<{ key: string; value: any }>;
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  return { methods: v("po_payment_methods") ?? [], aliases: v("po_payment_method_aliases") ?? {}, last4: v("po_payment_method_last4") ?? {} };
}

describe("The Walmart card payments with no last 4 get 0302 (migration 119)", () => {
  it("a 'Walmart card' row with last4 NULL gets 0302 with one History row; one already on 0302, one on another last 4, another card's NULL and a store-credit 'Walmart cash' row are left alone; running it again adds nothing", async (ctx) => {
    if (!client) return ctx.skip();
    const q: Q = (s, p) => client!.query(s, p);
    const sql = readFileSync(join(__dirname, "..", "database", "migrations", "119_walmart_card_last4_backfill.sql"), "utf8");
    await q("BEGIN");
    try {
      const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, tax, sh_donations, discount, refund_amount, order_total, ships_to) VALUES ('zz-walmart-119', '2026-08-01', 'zz-test.com', 10, 0, 0, 0, 0, 10, 'velocity') RETURNING id`)).rows[0].id as string;
      const ins = async (method: string, nick: string | null, last4: string | null) => Number((await q(`INSERT INTO po_payments (po_id, position, method, nickname, last4, amount) VALUES ($1, 0, $2, $3, $4, 10) RETURNING id`, [po, method, nick, last4])).rows[0].id);
      const blank = await ins("card", "Walmart card", null), has = await ins("card", "Walmart card", "0302"), other = await ins("card", "Walmart card", "1234"), chase = await ins("card", "Chase", null), cash = await ins("store_credit", "Walmart cash", null);
      await q(sql); await q(sql);
      const l4 = async (id: number) => (await q(`SELECT last4 FROM po_payments WHERE id = $1`, [id])).rows[0].last4;
      expect(await l4(blank)).toBe("0302");
      expect(await l4(has)).toBe("0302");
      expect(await l4(other)).toBe("1234");
      expect(await l4(chase)).toBeNull();
      expect(await l4(cash)).toBeNull();
      expect((await q(`SELECT field, old_value, new_value FROM po_edit_log WHERE po_id = $1 ORDER BY id`, [po])).rows).toEqual([
        { field: "payment last 4 (Walmart card 0302 filled in, migration 119)", old_value: null, new_value: "0302" },
      ]);
    } finally { await q("ROLLBACK"); }
    expect((await q(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id = 'zz-walmart-119'`)).rows[0].n).toBe(0);
  });
});

describe("Walmart card (0302) and Amex (1008) are cards like every other (migration 118)", () => {
  it("Walmart card keeps its name and aliases and gains its last 4; Amex (1008) is a fourth Amex that resolves by last 4 only ('Amex' + 1001 still lands on Amex (1001)); the migration relinks 'OnePay CashRewards' 0302 and 'Amex' 1008 rows with a History row each, leaves a 'Walmart card' row with no last 4 and another card's 1008 alone, and runs twice without a second row", async (ctx) => {
    if (!client) return ctx.skip();
    const q: Q = (s, p) => client!.query(s, p);
    const l = await lists(q);
    expect(l.methods.filter((m) => m === "Walmart card")).toHaveLength(1); // migration 029's entry, not a second one
    expect(l.last4!["Walmart card"]).toBe("0302");
    expect(l.aliases!["OnePay CashRewards"]).toBe("Walmart card");
    expect(resolvePaymentNickname("", "0302", l)).toEqual({ nickname: "Walmart card", ambiguous: [] });
    expect(resolvePaymentNickname("OnePay CashRewards", "0302", l)).toEqual({ nickname: "Walmart card", ambiguous: [] });
    expect(l.methods).toContain("Amex (1008)");
    expect(l.last4!["Amex (1008)"]).toBe("1008");
    expect(Object.keys(l.aliases!).find((a) => a.toLowerCase() === "amex")).toBeUndefined(); // no bare alias: four Amex cards
    expect(resolvePaymentNickname("Amex", "1008", l)).toEqual({ nickname: "Amex (1008)", ambiguous: [] });
    expect(resolvePaymentNickname("", "1008", l)).toEqual({ nickname: "Amex (1008)", ambiguous: [] });
    expect(resolvePaymentNickname("Amex", "1001", l)).toEqual({ nickname: "Amex (1001)", ambiguous: [] });
    expect(resolvePaymentNickname("Amex", "1005", l)).toEqual({ nickname: "", ambiguous: ["Amex Gold", "Amex Plus"] });
    expect(refundCardWord("Refunded to card ending in 1008", "refund_card", l)).toBe("card Amex (1008)");
    expect(refundCardWord("Refunded to card ending in 0302", "refund_card", l)).toBe("card Walmart card");
    const sql = readFileSync(join(__dirname, "..", "database", "migrations", "118_walmart_amex_cards.sql"), "utf8");
    await q("BEGIN");
    try {
      const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, tax, sh_donations, discount, refund_amount, order_total, ships_to) VALUES ('zz-cards-118', '2026-11-01', 'zz-test.com', 10, 0, 0, 0, 0, 10, 'velocity') RETURNING id`)).rows[0].id as string;
      const ins = async (nick: string | null, last4: string | null) => Number((await q(`INSERT INTO po_payments (po_id, position, method, nickname, last4, amount) VALUES ($1, 0, 'card', $2, $3, 10) RETURNING id`, [po, nick, last4])).rows[0].id);
      const onepay = await ins("OnePay CashRewards", "0302"), walmartCanon = await ins("Walmart card", "0302"), walmartNoLast4 = await ins("Walmart card", null);
      const amex = await ins("Amex", "1008"), amexBlank = await ins(null, "1008"), chase1008 = await ins("Chase", "1008");
      await q(sql); await q(sql);
      const nick = async (id: number) => (await q(`SELECT nickname, last4 FROM po_payments WHERE id = $1`, [id])).rows[0];
      expect(await nick(onepay)).toEqual({ nickname: "Walmart card", last4: "0302" });
      expect(await nick(walmartCanon)).toEqual({ nickname: "Walmart card", last4: "0302" });
      expect(await nick(walmartNoLast4)).toEqual({ nickname: "Walmart card", last4: null }); // 118 never fills a last 4 in; 119 does, for Walmart card rows
      expect(await nick(amex)).toEqual({ nickname: "Amex (1008)", last4: "1008" });
      expect(await nick(amexBlank)).toEqual({ nickname: "Amex (1008)", last4: "1008" });
      expect(await nick(chase1008)).toEqual({ nickname: "Chase", last4: "1008" });
      expect((await q(`SELECT field, old_value, new_value FROM po_edit_log WHERE po_id = $1 ORDER BY id`, [po])).rows).toEqual([
        { field: "payment nickname (Walmart card last 4 added, migration 118)", old_value: "OnePay CashRewards", new_value: "Walmart card" },
        { field: "payment nickname (Amex (1008) card added, migration 118)", old_value: "Amex", new_value: "Amex (1008)" },
        { field: "payment nickname (Amex (1008) card added, migration 118)", old_value: null, new_value: "Amex (1008)" },
      ]);
      const l2 = await lists(q);
      expect(l2.methods.filter((m) => m === "Amex (1008)")).toHaveLength(1);
      expect(l2.methods.filter((m) => m === "Walmart card")).toHaveLength(1);
    } finally { await q("ROLLBACK"); }
    expect((await q(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id = 'zz-cards-118'`)).rows[0].n).toBe(0);
  });
});

describe("CapitalOne (6830) is a card like every other (migration 117)", () => {
  it("the list, the last-4 map and both aliases carry it; 'CapitalOne', 'Capital One', 'capital one' and a bare 6830 resolve to it; the migration relinks a hand-typed 'CapitalOne' row with a History row and runs twice without a second row", async (ctx) => {
    if (!client) return ctx.skip();
    const q: Q = (s, p) => client!.query(s, p);
    const l = await lists(q);
    expect(l.methods).toContain("CapitalOne (6830)");
    expect(l.last4!["CapitalOne (6830)"]).toBe("6830");
    for (const typed of ["CapitalOne", "Capital One", "capital one"]) expect(resolvePaymentNickname(typed, "", l)).toEqual({ nickname: "CapitalOne (6830)", ambiguous: [] });
    expect(resolvePaymentNickname("", "6830", l)).toEqual({ nickname: "CapitalOne (6830)", ambiguous: [] });
    const sql = readFileSync(join(__dirname, "..", "database", "migrations", "117_capitalone_card.sql"), "utf8");
    await q("BEGIN");
    try {
      const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, tax, sh_donations, discount, refund_amount, order_total, ships_to) VALUES ('zz-cap-6830', '2026-10-20', 'zz-test.com', 10, 0, 0, 0, 0, 10, 'velocity') RETURNING id`)).rows[0].id as string;
      const id = Number((await q(`INSERT INTO po_payments (po_id, position, method, nickname, last4, amount) VALUES ($1, 0, 'card', 'CapitalOne', '6830', 10) RETURNING id`, [po])).rows[0].id);
      await q(sql); await q(sql);
      expect((await q(`SELECT nickname FROM po_payments WHERE id = $1`, [id])).rows[0].nickname).toBe("CapitalOne (6830)");
      expect((await q(`SELECT field, old_value, new_value FROM po_edit_log WHERE po_id = $1`, [po])).rows).toEqual([{ field: "payment nickname (CapitalOne card added, migration 117)", old_value: "CapitalOne", new_value: "CapitalOne (6830)" }]);
      expect((await lists(q)).methods.filter((m) => m === "CapitalOne (6830)")).toHaveLength(1);
    } finally { await q("ROLLBACK"); }
    expect((await q(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id = 'zz-cap-6830'`)).rows[0].n).toBe(0);
  });
});

describe("Wells Fargo (0875) is a card like every other (migration 115)", () => {
  it("the picker's list, the last-4 map and the alias carry it; a typed 'Wells Fargo', a bare 0875 and a refund email's 'ending in 0875' all resolve to it", async (ctx) => {
    if (!client) return ctx.skip();
    const l = await lists((s, p) => client!.query(s, p));
    expect(l.methods).toContain("Wells Fargo (0875)");
    expect(l.methods.indexOf("Wells Fargo (0875)")).toBeGreaterThan(l.methods.indexOf("Chase (7927)")); // appended: the list's order (element 0 = the default) is untouched
    expect(l.last4!["Wells Fargo (0875)"]).toBe("0875");
    expect(l.aliases!["Wells Fargo"]).toBe("Wells Fargo (0875)");
    expect(canonicalPaymentName("Wells Fargo", l.aliases)).toBe("Wells Fargo (0875)");
    expect(canonicalPaymentName("wells fargo active cash", l.aliases)).toBe("Wells Fargo (0875)");
    expect(resolvePaymentNickname("Wells Fargo", "", l)).toEqual({ nickname: "Wells Fargo (0875)", ambiguous: [] });
    expect(resolvePaymentNickname("", "0875", l)).toEqual({ nickname: "Wells Fargo (0875)", ambiguous: [] });
    expect(resolvePaymentNickname("Visa", "0875", l)).toEqual({ nickname: "Wells Fargo (0875)", ambiguous: [] });
    // Refund / order emails: the card word names the card by its last 4; a last 4 AF has no card for stays "••NNNN"; two cards on one last 4 name neither.
    expect(refundCardWord("Your refund of $21.45 will go back to the card ending in 0875 within 5 days.", "refund_card", l)).toBe("card Wells Fargo (0875)");
    expect(refundCardWord("Refunded to Visa ••6830", "refund_card", l)).toBe("card CapitalOne (6830)"); // migration 117
    expect(refundCardWord("Refunded to card ending in 4242", "refund_card", l)).toBe("card ••4242");
    expect(refundCardWord("Refunded to card ending in 1005", "refund_card", l)).toBe("card ••1005"); // two cards end in 1005
    expect(refundCardWord("A $5 gift card is on its way", "gift_card", l)).toBe("gift card");
    expect(refundCardWord("refund to card ending in 0875", "refund_card", null)).toBe("card ••0875");
  });

  it("the migration's relink: a card payment typed 'Wells Fargo' / blank with last 4 0875 takes the canonical name with one History row; one already canonical, another card's 0875 and a gift card are left alone; running it again changes nothing", async (ctx) => {
    if (!client) return ctx.skip();
    const q: Q = (s, p) => client!.query(s, p);
    const sql = readFileSync(join(__dirname, "..", "database", "migrations", "115_wells_fargo_card.sql"), "utf8");
    await q("BEGIN");
    try {
      const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, tax, sh_donations, discount, refund_amount, order_total, ships_to) VALUES ('zz-wf-0875', '2026-11-15', 'zz-test.com', 10, 0, 0, 0, 0, 10, 'velocity') RETURNING id`)).rows[0].id as string;
      const ins = async (method: string, nick: string | null, last4: string | null) => Number((await q(`INSERT INTO po_payments (po_id, position, method, nickname, last4, amount) VALUES ($1, 0, $2, $3, $4, 10) RETURNING id`, [po, method, nick, last4])).rows[0].id);
      const typed = await ins("card", "Wells Fargo", "0875"), blank = await ins("card", null, "0875"), canon = await ins("card", "Wells Fargo (0875)", "0875"), other = await ins("card", "Chase", "0875"), gc = await ins("gift_card", null, "0875");
      await q(sql);
      const nick = async (id: number) => (await q(`SELECT nickname FROM po_payments WHERE id = $1`, [id])).rows[0].nickname;
      expect(await nick(typed)).toBe("Wells Fargo (0875)");
      expect(await nick(blank)).toBe("Wells Fargo (0875)");
      expect(await nick(canon)).toBe("Wells Fargo (0875)");
      expect(await nick(other)).toBe("Chase");
      expect(await nick(gc)).toBeNull();
      const log = (await q(`SELECT field, old_value, new_value FROM po_edit_log WHERE po_id = $1 ORDER BY id`, [po])).rows;
      expect(log).toEqual([
        { field: "payment nickname (Wells Fargo card added, migration 115)", old_value: "Wells Fargo", new_value: "Wells Fargo (0875)" },
        { field: "payment nickname (Wells Fargo card added, migration 115)", old_value: null, new_value: "Wells Fargo (0875)" },
      ]);
      await q(sql); // idempotent: no second History row, the lists carry the card once
      expect((await q(`SELECT count(*)::int AS n FROM po_edit_log WHERE po_id = $1`, [po])).rows[0].n).toBe(2);
      const l = await lists(q);
      expect(l.methods.filter((m) => m === "Wells Fargo (0875)")).toHaveLength(1);
    } finally { await q("ROLLBACK"); }
    expect((await q(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id = 'zz-wf-0875'`)).rows[0].n).toBe(0);
  });
});
