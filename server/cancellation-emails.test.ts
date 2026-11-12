// Cancellation emails → suggested canceled claims (SPEC §22 "Supplier claims" §3.1, claims patch commit 5). Every
// email here is a scrubbed fixture from the mailbox (server/__fixtures__/cancellation-emails/); the Haiku answers are
// recorded (ai-*.json) — the suite never calls the model or Gmail.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  cleanText, unwrapForwarded, classifyCancellation, parseCancellation, applyAi, matchCancellation, proposeLine, cancellationSuggestions, ingestCancellations,
  PARSERS, POS_SQL, LINES_SQL, WATERMARK_KEY, type EmailFacts, type PoLine, type CancellationAiCall,
} from "./cancellation-emails";
import type { PoRef } from "./tracking-match";

const DIR = join(__dirname, "__fixtures__", "cancellation-emails");
const fx = (name: string) => { const m = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")); return { ...m, date: new Date(m.date) }; };
const facts = (name: string): EmailFacts => unwrapForwarded(fx(name));
const parsed = (name: string) => { const f = facts(name); const c = classifyCancellation(f); if (!c.candidate) throw new Error(`${name}: ${c.why}`); return { f, p: parseCancellation(f, c.matched) }; };

describe("fixtures", () => {
  it("every fixture is scrubbed: no real name, address, mailbox or phone", () => {
    for (const f of readdirSync(DIR)) {
      const t = readFileSync(join(DIR, f), "utf8");
      expect(t, f).not.toMatch(/Peters|Rivercrest|@gmail\.com|@coastalqualitygoods|8434671254|\bMaria\b/);
    }
  });
});

describe("classifier", () => {
  it("cancellation language in the subject or the body's head → candidate; confirmations, delays, subscriptions, payment notices and threats are not", () => {
    for (const name of ["walmart-full-refund-walmart-cash", "walmart-partial-out-of-stock", "target-last4", "sephora-full", "bbw-full", "bbts-item-cancellation", "oracle-cancellation-summary", "supplyhouse-security", "dkhardware-full", "jellycat-full", "shopify-refunded-items", "urbanoutfitters-partial", "macys-out-of-stock", "staples-item", "fleetfarm-partial-no-items", "walgreens-adjusted", "michaels-gift-card", "kohls-forwarded-full", "tnvalleybikes-payment-canceled", "tnvalleybikes-free-text"]) {
      expect(classifyCancellation(facts(name)), name).toMatchObject({ candidate: true });
    }
    expect(classifyCancellation(facts("sephora-confirmation"))).toEqual({ candidate: false, why: "no cancellation language" }); // "to view or cancel your order"
    expect(classifyCancellation(facts("walgreens-confirmed"))).toEqual({ candidate: false, why: "no cancellation language" }); // "if your order is adjusted or canceled"
    expect(classifyCancellation(facts("walmart-delayed"))).toEqual({ candidate: false, why: "delayed notice (D4)" });
    expect(classifyCancellation(facts("webstaurant-subscription"))).toEqual({ candidate: false, why: "subscription / membership cancel" });
    expect(classifyCancellation(facts("bbts-declined-payment"))).toEqual({ candidate: false, why: "payment notice, not a cancellation" });
    expect(classifyCancellation(facts("powermower-backorder"))).toEqual({ candidate: false, why: "no cancellation language" }); // out of stock with an ETA = a delay
    expect(classifyCancellation(facts("hardwareworld-free-text"))).toEqual({ candidate: false, why: "no cancellation language" }); // "otherwise, your order will be cancelled"
    expect(classifyCancellation({ subject: "You received a gift card", text: "x", fromDomain: "other.com" })).toEqual({ candidate: false, why: "gift card notice" });
    // a negation, a subscription cancel mentioned in a balance email, and a newsletter's "order cancellation prevention" are not cancellations of goods
    expect(classifyCancellation({ subject: "Your Cards are Here!", text: "Once the cards are accessed, orders cannot be canceled due to delivery time or buyer's remorse.", fromDomain: "cardcookie.com" })).toMatchObject({ candidate: false });
    expect(classifyCancellation({ subject: "Account Update: Review your current balance", text: "We're sorry you canceled your subscription(s). We get it.", fromDomain: "spoiledchild.com" })).toMatchObject({ candidate: false });
  });
  it("a forwarded email takes its sender, date and subject from the forwarded header block (Kohl's via the owner's mailbox)", () => {
    const f = facts("kohls-forwarded-full");
    expect(f.forwarded).toBe(true);
    expect(f.fromDomain).toBe("t.kohls.com");
    expect(f.subject).toMatch(/^Sorry, Test\. We couldn't complete your Kohl/);
    expect(f.date.toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(f.text).not.toMatch(/Forwarded message/);
    expect(cleanText("a &zwnj; &zwnj;\n\n\n b​")).toBe("a\nb");
  });
});

describe("retailer parsers (one fixture each)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["walmart-full-refund-walmart-cash", { retailer: "walmart.com", orderId: "3111268-28712490", scope: "full", items: [], refundAmount: 4, refundMethod: "Walmart Cash", reason: "customer request" }],
    ["walmart-partial-out-of-stock", { orderId: "3111267-12639562", scope: "partial", items: [{ name: "Little Debbie Family Pack Pumpkin Spice Rolls, 13.13 oz", qty: 1 }], reason: "out of stock" }],
    ["walmart-partial-two-items", { scope: "partial", items: [{ name: "Dr Teal's Restorative Minerals Body Balm with Magnesium, Zinc and Potassium , 2.65 oz", qty: 6 }, { name: "Kinder's Smoked Onion Seasoning & Rub for Grilling, 7 oz", qty: 4 }], reason: "delayed items canceled" }],
    ["walmart-full-policy-flag", { scope: "full", items: [], reason: "policy flag" }],
    ["target-last4", { retailer: "target.com", orderId: "023114860104476", orderLast4: "3365", scope: "partial", items: [{ name: "Keurig Descaling Solution: Liquid Cleaner for Coffee Equipment, Prevents Lime Scale, Vinegar Scent, 14 oz", qty: 4 }] }],
    ["sephora-full", { retailer: "sephora.com", orderId: "947025116108", scope: "full", refundAmount: 520, reason: "customer request" }],
    ["bbw-full", { retailer: "bathandbodyworks.com", orderId: "11585423070088", scope: "full", items: [], reason: "security" }],
    ["bbts-item-cancellation", { retailer: "bigbadtoystore.com", orderId: null, scope: "partial", items: [{ name: "DC Comics Todd's Mods Batman Limited Edition Vinyl Figure (BBTS Mint)", qty: 5 }], reason: "non-payment" }],
    ["oracle-cancellation-summary", { retailer: "oracle-hosted", orderId: "62573525", scope: "full", items: [{ name: "CRETACOLR ARTST PWDR CHAR POWDER 175G (SKU 879732147)", qty: 10 }] }],
    ["supplyhouse-security", { orderId: "30161995", scope: "full", reason: "security" }],
    ["dkhardware-full", { orderId: "DKH-5314520", scope: "full", reason: "customer request" }],
    ["jellycat-full", { orderId: "9029601", scope: "full", refundAmount: 380 }],
    ["shopify-refunded-items", { retailer: "shopify", orderId: "OLE3245352", scope: "full", refundAmount: 275.65 }],
    ["urbanoutfitters-partial", { orderId: "TP70924388", scope: "partial", items: [{ name: "Ariana Grande - Sweetener UO Exclusive 2XLP", qty: 5 }], reason: "customer request" }],
    ["macys-out-of-stock", { orderId: "5911778329", scope: "partial", items: [{ name: "Frango Chocolates 2 Pack 1 LB Milk Mint Box of Chocolates,...", qty: 2 }], reason: "out of stock" }],
    ["staples-item", { orderId: "0040007066", scope: "partial", items: [{ name: "Folgers French Vanilla Coffee Keurig KCup Pod 96Carton 6661CT", qty: 3 }] }],
    ["fleetfarm-partial-no-items", { orderId: "MW9622739", scope: "partial", items: [] }],
    ["walgreens-adjusted", { retailer: "walgreens.com", orderId: "326702397598", scope: "partial", items: [{ name: "Liz Claiborne Eau de Toilette 1.0 fl oz", qty: 1 }], reason: "out of stock" }],
    ["michaels-gift-card", { retailer: "michaels.com", orderId: "6011210721206084", scope: null, refundAmount: 14.03, refundMethod: "Michaels eGift card" }],
    ["kohls-forwarded-full", { retailer: "kohls.com", orderId: "7840095846", scope: "full" }],
    ["tnvalleybikes-payment-canceled", { orderId: "191937-346517-413", scope: "full", refundAmount: 93 }],
  ];
  for (const [name, want] of cases) {
    it(`${name}`, () => {
      const { p } = parsed(name);
      expect(p).toMatchObject({ ...want, source: "regex", complete: true });
    });
  }
  it("Sephora lists both items with their quantities; the Shopify template reads 'Name × 5'", () => {
    expect(parsed("sephora-full").p.items).toEqual([{ name: "Software Update Retinol Body Serum for Fine Lines & Crepey Skin", qty: 5 }, { name: "VANILLA CANDY ROCK SUGAR | 42 Eau de Parfum", qty: 2 }]);
    expect(parsed("shopify-refunded-items").p.items.map((i) => i.qty)).toEqual([5, 5, 5]);
  });
  it("free text (Tennessee Valley Bicycles' reply) is a candidate the parsers cannot complete → the AI is asked; its recorded answer fills the parse, source ai", () => {
    const { p } = parsed("tnvalleybikes-free-text");
    expect(p).toMatchObject({ orderId: null, scope: null, items: [], complete: false });
    const rec = JSON.parse(readFileSync(join(DIR, "ai-tnvalleybikes-free-text.json"), "utf8"));
    expect(rec.answer).toMatchObject({ is_cancellation: true, scope: "full" });
    const a = applyAi(p, rec.answer);
    expect(a).toMatchObject({ source: "ai", scope: "full", items: [{ name: "SRAM Stealthamajig brake hose fitting parts", qty: null }] });
    expect(a.reason).toMatch(/incorrect price/);
    // the threat email, had it been asked: not a cancellation
    expect(JSON.parse(readFileSync(join(DIR, "ai-hardwareworld-free-text.json"), "utf8")).answer.is_cancellation).toBe(false);
  });
  it("one parser per retailer family, keyed on the sender's domain", () => {
    expect(PARSERS.map((p) => p.retailer)).toEqual(["walmart.com", "target.com", "sephora.com", "bathandbodyworks.com", "bigbadtoystore.com", "oracle-hosted", "supplyhouse.com", "dkhardware.com", "jellycat.com", "shopify", "urbanoutfitters.com", "macys.com", "staples.com", "fleetfarm.com", "walgreens.com", "michaels.com", "kohls.com", "tnvalleybikes.com"]);
  });
});

describe("matching and the claims", () => {
  const po = (o: Partial<PoRef>): PoRef => ({ id: "p1", supplier: "walmart.com", order_id: "311126828712490", order_date: "2026-11-07", alt_order_ids: null, ships_to: "velocity", closed: false, ...o });
  const line = (o: Partial<PoLine>): PoLine => ({ id: "l1", po_id: "p1", product_name: "Little Debbie Family Pack Pumpkin Spice Rolls 13.13 oz", product_pack: 1, ordered_individual: 3, qty_basis: "individual", ...o });
  it("the order # (normalised: Walmart's dash dropped) names one PO of the supplier; Target's last 4 → the one Target PO of the last 60 days; no order # → the one open PO whose line shares the item's words", () => {
    const pos = [po({}), po({ id: "p2", supplier: "target.com", order_id: "912003759093365", order_date: "2026-09-10" }), po({ id: "p3", supplier: "target.com", order_id: "912001111113365", order_date: "2026-03-01" }), po({ id: "p4", supplier: "bigbadtoystore.com", order_id: "35633556" })];
    const lines = [line({}), line({ id: "l4", po_id: "p4", product_name: "DC Comics Todd's Mods Batman Vinyl Figure" })];
    const { f, p } = parsed("walmart-full-refund-walmart-cash");
    expect(matchCancellation({ ...p, orderId: "2000157-17601389" }, f, "walmart.com", [po({ order_id: "200015717601389" })], lines)).toMatchObject({ via: "order_id" });
    expect(matchCancellation(p, f, "walmart.com", pos, lines)).toMatchObject({ via: "order_id", po: { id: "p1" } }); // "3111268-28712490" = 311126828712490
    expect(matchCancellation({ ...p, orderId: "9999999-00000000" }, f, "walmart.com", pos, lines)).toMatchObject({ po: null, reason: "no_po" });
    const t = parsed("target-last4");
    expect(matchCancellation({ ...t.p, orderId: null }, { ...t.f, date: new Date("2026-09-12T00:00:00Z") }, "target.com", pos, lines)).toMatchObject({ via: "last4", po: { id: "p2" } });
    const b = parsed("bbts-item-cancellation");
    expect(matchCancellation(b.p, b.f, "bigbadtoystore.com", pos, lines)).toMatchObject({ via: "item_words", po: { id: "p4" } });
    expect(matchCancellation(b.p, b.f, null, pos, lines)).toMatchObject({ po: null, reason: "no_order_id" });
    // a platform sender (Oracle-hosted): any supplier, by the order # alone
    expect(matchCancellation({ ...p, orderId: "35633556" }, f, null, pos, lines)).toMatchObject({ via: "order_id", po: { id: "p4" } });
  });
  it("line proposal: one line → it; ≥ 2 distinctive shared words → that line; a tie or nothing → null", () => {
    const l1 = line({}), l2 = line({ id: "l2", product_name: "Kinder's Smoked Onion Seasoning & Rub 7 oz" }), l3 = line({ id: "l3", product_name: "Dr Teal's Restorative Minerals Body Balm 2.65 oz" });
    expect(proposeLine("anything", [l1])).toBe(l1);
    expect(proposeLine("Kinder's Smoked Onion Seasoning & Rub for Grilling, 7 oz", [l1, l2, l3])).toBe(l2);
    expect(proposeLine("Dr Teal's Restorative Minerals Body Balm with Magnesium", [l1, l2, l3])).toBe(l3);
    expect(proposeLine("Keurig Descaling Solution", [l1, l2, l3])).toBeNull();
  });
  it("suggestions: one suggested canceled claim per placed item (qty = Product units × the line's pack, NULL when over Ordered — the combined Walgreens case), else one whole-PO claim; source email + items on the claim", () => {
    const { f, p } = parsed("walmart-partial-two-items");
    const lines = [line({ id: "l2", product_name: "Kinder's Smoked Onion Seasoning & Rub 7 oz", product_pack: 2, ordered_individual: 8 }), line({ id: "l3", product_name: "Dr Teal's Restorative Minerals Body Balm 2.65 oz", product_pack: 1, ordered_individual: 6 })];
    const s = cancellationSuggestions(p, f, po({}), lines, "msg1");
    expect(s.map((x) => [x.po_line_item_id, x.qty, x.key])).toEqual([["l3", 6, "email:msg1:l3"], ["l2", 8, "email:msg1:l2"]]);
    expect(s[0]).toMatchObject({ kind: "canceled", found_by: "email", source_email_id: "msg1", amount: null, rule: "email:walmart.com:partial" });
    expect(s[0].reason).toMatch(/^Canceled per the walmart\.com email of 2026-09-23 \(delayed items canceled\): 6 × Dr Teal's .* = 6 Individual units\. Open the claim\?$/);
    expect(s[0].source_items_json).toEqual(p.items);
    // Walgreens: email says 5 Folgers, the combined line ordered 3 → qty NULL, the reason says so
    const w = parsed("walgreens-adjusted");
    const over = cancellationSuggestions({ ...w.p, items: [{ name: "Folgers Instant Coffee Classic Roast 8.0 oz", qty: 5 }] }, w.f, po({ supplier: "walgreens.com" }), [line({ product_name: "Folgers Instant Coffee Classic Roast - 8.0 oz", ordered_individual: 3 })], "msg2");
    expect(over[0]).toMatchObject({ qty: null, po_line_item_id: "l1" });
    expect(over[0].reason).toContain("more than the line's Ordered (3; a combined order?), type the quantity");
    // a full cancel with no items: whole PO, qty = Σ ordered, amount = the stated refund
    const k = parsed("kohls-forwarded-full");
    const whole = cancellationSuggestions({ ...k.p, refundAmount: 50 }, k.f, po({ supplier: "kohls.com" }), [line({ ordered_individual: 4 }), line({ id: "l2", ordered_individual: 6 })], "msg3");
    expect(whole).toHaveLength(1);
    expect(whole[0]).toMatchObject({ po_line_item_id: null, qty: 10, amount: 50, key: "email:msg3:po", rule: "email:kohls.com:full" });
    expect(whole[0].reason).toMatch(/the whole order\. Refund stated: \$50\.00\. Open the claim\?$/);
    // the Michaels gift card: unclear scope, qty unknown, the amount is the credit
    const m = parsed("michaels-gift-card");
    expect(cancellationSuggestions(m.p, m.f, po({ supplier: "michaels.com" }), [line({})], "msg4")[0]).toMatchObject({ qty: null, amount: 14.03 });
  });
});

describe("the ingest", () => {
  it("scans Gmail since the watermark, skips emails already behind a claim, writes suggestions only live, asks the AI only live and only for incomplete parses, and moves the watermark", async () => {
    const msgs: Record<string, any> = { m1: fx("walmart-partial-out-of-stock"), m2: fx("tnvalleybikes-free-text"), m3: fx("walmart-delayed"), m4: fx("sephora-full") };
    const writes: Array<{ sql: string; params: any[] }> = [];
    const aiCalls: string[] = [];
    const ai: CancellationAiCall = async (subject) => { aiCalls.push(subject); return { ...JSON.parse(readFileSync(join(DIR, "ai-tnvalleybikes-free-text.json"), "utf8")).answer, input_tokens: 10, output_tokens: 5 }; };
    const query = async (sql: string, params?: any[]) => {
      if (/FROM settings WHERE key = \$1/.test(sql)) return { rows: [{ value: { last_scanned_at: "2026-11-01T00:00:00Z" } }], rowCount: 1 };
      if (/FROM settings WHERE key = ANY/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql === POS_SQL) return { rows: [{ id: "p1", supplier: "walmart.com", order_id: "311126712639562", order_date: "2026-10-18", closed: false }, { id: "p2", supplier: "tnvalleybikes.com", order_id: "191937-346517-413", order_date: "2026-08-08", closed: false }, { id: "p4", supplier: "sephora.com", order_id: "947025116108", order_date: "2026-09-26", closed: true }], rowCount: 3 };
      if (sql === LINES_SQL) return { rows: [{ id: "l1", po_id: "p1", product_name: "Little Debbie Pumpkin Spice Rolls", product_pack: 1, ordered_individual: 2, qty_basis: "individual" }, { id: "l2", po_id: "p2", product_name: "SRAM Stealthamajig brake hose fitting", product_pack: 1, ordered_individual: 2, qty_basis: "individual" }, { id: "l4", po_id: "p4", product_name: "Retinol Body Serum", product_pack: 1, ordered_individual: 5, qty_basis: "individual" }], rowCount: 3 };
      if (/SELECT source_email_id FROM supplier_claims/.test(sql)) return { rows: [{ source_email_id: "m4" }], rowCount: 1 };
      if (/^SELECT po_id, po_line_item_id/.test(sql)) return { rows: [], rowCount: 0 };
      if (/information_schema\.columns/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      writes.push({ sql: sql.replace(/\s+/g, " "), params: params ?? [] });
      if (/^INSERT INTO supplier_claims /.test(sql)) return { rows: [{ id: 9 }], rowCount: 1 };
      return { rows: [{ id: 1 }], rowCount: 1 };
    };
    const deps = { gmail: {} as any, list: async (_g: any, q: string) => { expect(q).toMatch(/^-category:promotions after:\d+ \(canceled OR cancelled/); return Object.keys(msgs); }, get: async (_g: any, id: string) => ({ id, threadId: null, labelIds: [], from: msgs[id].from, ...msgs[id] }), ai };
    const dry = await ingestCancellations({ query, deps, now: new Date("2026-11-12T20:00:00Z"), dryRun: true });
    expect(dry).toMatchObject({ scanned: 4, candidates: 2, ai_calls: 0, ai_skipped: 1, created: 0, not_candidates: { already_read: 1, "delayed notice (D4)": 1 } });
    expect(dry.rows.map((r) => [r.sender, r.po, r.match, r.source])).toEqual([["walmart.com", "311126712639562", "matched (order_id)", "regex"], ["tnvalleybikes.com", null, "no_order_id", "regex (AI would be asked)"]]);
    expect(dry.rows[0].matched).toBe("was canceled");
    expect(dry.rows[0].suggestions).toHaveLength(1);
    expect(dry.rows[0].suggestions[0]).toMatchObject({ outcome: "dry_run", po_line_item_id: "l1", qty: 1 });
    expect(writes).toHaveLength(0);
    expect(aiCalls).toHaveLength(0);
    // live: the AI reads the free text (still no order #, so no claim — listed), the Walmart claim is written, the watermark moves
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const live = await ingestCancellations({ query, deps, now: new Date("2026-11-12T20:00:00Z") });
      // the free text: the AI names the item, the one open PO of that supplier with that item → a whole-PO suggestion (qty unknown)
      expect(live).toMatchObject({ candidates: 2, ai_calls: 1, created: 2 });
      expect(aiCalls).toEqual(["SRAM Brake Part Order"]);
      expect(live.rows[1]).toMatchObject({ source: "ai", scope: "full", match: "matched (item_words)", po: "191937-346517-413" });
      expect(live.rows[1].suggestions[0]).toMatchObject({ po_line_item_id: null, qty: 2, rule: "email:tnvalleybikes.com:full:ai" }); // a full cancel: qty = Σ ordered
      expect(writes.find((w) => /INSERT INTO po_prefill_log/.test(w.sql))!.params[1]).toBe("cancellation");
      const claim = writes.find((w) => /^INSERT INTO supplier_claims /.test(w.sql))!;
      expect(claim.params.slice(0, 4)).toEqual(["p1", "l1", "canceled", 1]);
      expect(claim.params[6]).toBe("email");
      expect(claim.params[7]).toBe("m1");
      expect(JSON.parse(claim.params[8])).toEqual([{ name: "Little Debbie Family Pack Pumpkin Spice Rolls, 13.13 oz", qty: 1 }]);
      const wm = writes.find((w) => /INSERT INTO settings/.test(w.sql))!;
      expect(wm.params[0]).toBe(WATERMARK_KEY);
      expect(JSON.parse(wm.params[1])).toEqual({ last_scanned_at: "2026-11-12T20:00:00.000Z" });
    } finally { delete process.env.ANTHROPIC_API_KEY; }
  });
});
