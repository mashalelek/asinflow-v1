import { describe, it, expect, vi } from "vitest";
import { CaptureSchema, PrefillSchema, enrichPrefill, settleGiftCards } from "./po-prefill";
import { checkPoForm, emptyPoForm, type PoFormState } from "@shared/po-form";
import { _clearAmazonSearchCache } from "./asin-amazon-search";

vi.mock("./log", () => ({ log: () => {} }));
vi.mock("./spapi-auth", () => ({ spApiGet: async () => { throw new Error("no SP-API in tests"); } }));

// yankeecandle.com HFUS09823034326 (Maria 2026-11-06): Christmas Eve Large Jar × 10 = $349.90; Cherries On Snow Large Jar × 10 =
// $0.00 (was $349.90, "Buy 2, Get 2 Free"); Subtotal $349.90; Order Discount −$52.49 (WS15F-HO7ZRXYFZV, 15%); Gift Card −$297.41;
// Total $0.00; paid by two gift cards $204.28 + $93.13. Saved by hand as: order total $297.41, GC 8.39 % weighted, $13.62 / candle
// on B0155OGEUU and B005OMNPII — the expected result here, from the capture as the model first read it (the gift card in the
// discount, the post-gift-card total).
const capture = CaptureSchema.parse({
  retailerHost: "www.yankeecandle.com", capturedAt: "2026-11-06T10:49:00Z",
  pages: [{ step: "other", url: "https://www.yankeecandle.com/order-confirmation", title: "Order confirmation", text: "Order HFUS09823034326\nShipping address 805 Grandy Ave" }],
});
const extraction = PrefillSchema.parse({
  retailer: "Yankee Candle", orderId: "HFUS09823034326", orderDate: "2026-11-06",
  lines: [
    { productName: "Christmas Eve Original Large Jar Candle", retailerSku: null, qty: 10, unitsPerPack: 1, unitPrice: 34.99, lineTotal: 349.9, regularUnitPrice: null, asinGuess: null },
    { productName: "Cherries On Snow Original Large Jar Candle", retailerSku: null, qty: 10, unitsPerPack: 1, unitPrice: 0, lineTotal: 0, regularUnitPrice: 34.99, asinGuess: null },
  ],
  subtotal: 349.9, discount: 349.9, tax: 0, shipping: 0, total: 0,
  promos: [
    { type: "sale", description: "Buy 2, Get 2 Free: Most Full-Price Candles", amount: 349.9, percent: null, confidence: "high" },
    { type: "coupon", description: "Order Discount WS15F-HO7ZRXYFZV", amount: 52.49, percent: 15, confidence: "high" },
    { type: "coupon", description: "Gift Card", amount: 297.41, percent: null, confidence: "high" },
  ],
  payments: [{ method: "gift_card", nickname: "Gift card", last4: null, amount: 204.28 }, { method: "gift_card", nickname: "Gift card", last4: null, amount: 93.13 }],
  shipToStreet: "805 Grandy Ave", subscription: { present: false, frequencyWeeks: null }, purchasedEmail: null, notes: [],
});
// What Amazon's catalog search returned for the two lines (2026-11-06, trimmed to the top hits).
const item = (asin: string, itemName: string, size: string) => ({ asin, summaries: [{ marketplaceId: "ATVPDKIKX0DER", itemName, brand: "Yankee Candle", size }], attributes: { item_package_quantity: [{ value: 1 }] }, images: [] });
const AMAZON: Record<string, any[]> = {
  christmas: [
    item("B0F8K84QX6", "Yankee Candle Christmas Eve Scented Candle, 22oz Large Jar", "New Large Jar"),
    item("B0155OGEUU", "Yankee Candle Christmas Eve Scented, Classic 22oz Large Jar Single Wick Candle, Over 110 Hours of Burn Time", "Classic Large Jar"),
    item("B0F3DQZ193", "Yankee Candle Christmas Cookie Scented Candle, 22oz Large Jar", "New Large Jar"),
    item("B0FLZWNDH7", "Yankee Candle Christmas Eve Scented Candle, 14.5oz 3-Wick", "14.5oz"),
  ],
  cherries: [
    item("B005OMNPII", "Yankee Candle Cherries On Snow Scented, Classic 22oz Large Jar Single Wick Candle", "Classic Large Jar"),
    item("B0F8KP5395", "Yankee Candle Snow Globe Wonderland Scented Candle, 22oz Large Jar", "22 oz"),
  ],
};
const searchDeps = { get: async (_e: string, p: Record<string, any>) => ({ items: /christmas/i.test(p.keywords) ? AMAZON.christmas : /cherries/i.test(p.keywords) ? AMAZON.cherries : [] }) };
const q = async (sql: string) => {
  if (/SELECT DISTINCT supplier FROM purchase_orders/.test(sql)) return { rows: [{ supplier: "yankeecandle.com" }], rowCount: 1 };
  if (/FROM settings WHERE key = ANY/.test(sql)) return { rows: [{ key: "tracking.velocity_street", value: "805 grandy" }, { key: "tracking.home_streets", value: ["65 rivercrest"] }, { key: "prep_cost", value: 1 }], rowCount: 3 };
  return { rows: [], rowCount: 0 };
};

describe("Yankee HFUS09823034326: gift cards are payments, free units share the cost by regular price", () => {
  it("settleGiftCards: the discount loses the gift card, the total is the one before it, the gift-card promo goes", () => {
    const s = settleGiftCards(extraction);
    expect(s.changed).toBe(true);
    expect(s.x.discount).toBe(52.49);
    expect(s.x.total).toBe(297.41);
    expect(s.x.promos.map((p) => p.description)).not.toContain("Gift Card");
  });
  it("prefill → Maria's picks and GC % → $14.87 sourcing, $13.62 COGS on both ASINs, order total $297.41", async () => {
    _clearAmazonSearchCache();
    const out = await enrichPrefill(q as any, capture, extraction, null, { id: "", capturedAt: null }, searchDeps);
    expect(out.form.order_total).toBe("297.41");
    expect(out.form.discount).toBe("52.49");
    expect(out.form.products?.map((p) => p.regular_price)).toEqual(["34.99", "34.99"]);
    const deal = out.form.promos!.find((p) => /Get 2 Free/.test(p.description))!;
    expect(deal).toMatchObject({ type: "sale", amount: "349.90", counts_toward_cogs: false, in_line_prices: true });
    expect(out.form.promos!.find((p) => /WS15F/.test(p.description))).toMatchObject({ amount: "52.49", counts_toward_cogs: true });
    const form: PoFormState = { ...emptyPoForm("2026-11-06"), ...out.form } as PoFormState;
    form.products = form.products.map((p, i) => ({ ...p, asin: i === 0 ? "B0155OGEUU" : "B005OMNPII" }));
    form.payments = (form.payments ?? []).map((p, i) => ({ ...p, gift_card_discount_pct: i === 0 ? "7.65" : "10.00" })); // her two cards
    const check = checkPoForm(form);
    expect(check.errors).toEqual([]);
    expect(check.effectiveOrderTotal.toFixed(2)).toBe("297.41");
    expect(check.weightedGcPct?.toFixed(2)).toBe("8.39");
    for (const asin of ["B0155OGEUU", "B005OMNPII"]) {
      const a = check.asins.find((x) => x.asin === asin)!;
      expect(a.sourcing_cost).toBe("14.87");
      expect(a.computed_cost_per_unit).toBe("13.62");
    }
  });
});

describe("Yankee HFUS09823034326 as Maria saved it: promos in sequence", () => {
  it("subtotal $699.80, B2G2 50% then WS15F 15% (no $), discount $402.39 → promos $349.90 then $52.49; $14.87 / $13.62 on both", () => {
    const form: PoFormState = { ...emptyPoForm("2026-11-06"), supplier: "yankeecandle.com", order_id: "HFUS09823034326", subtotal: "699.80", discount: "402.39", tax: "0", sh_donations: "0", order_total: "297.41",
      products: [
        { product_name: "Christmas Eve® Original Large Jar Candle", supplier_sku: "", price: "34.99", qty_ordered: "10", retailer_units_per_pack: "1", asin: "B0155OGEUU", asin_qty_per_product: "1", sold_as: "individual", units_per_pack: "1", prep_cost: "1.00", notes: "" },
        { product_name: "Cherries On Snow™ Original Large Jar Candles", supplier_sku: "", price: "34.99", qty_ordered: "10", retailer_units_per_pack: "1", asin: "B005OMNPII", asin_qty_per_product: "1", sold_as: "individual", units_per_pack: "1", prep_cost: "1.00", notes: "" },
      ],
      promos: [{ type: "sale", description: "B2G2", amount: "", percent: "50", counts_toward_cogs: true }, { type: "coupon", description: "WS15F-HO7ZRXYFZV", amount: "", percent: "15", counts_toward_cogs: true }],
      payments: [{ method: "gift_card", nickname: "", last4: "", amount: "204.28", gift_card_discount_pct: "7.65", reward_pct: "" }, { method: "gift_card", nickname: "", last4: "", amount: "93.13", gift_card_discount_pct: "10.00", reward_pct: "" }],
    } as PoFormState;
    const check = checkPoForm(form);
    expect(check.errors).toEqual([]);
    expect(check.promoAmountsUsed).toEqual([349.9, 52.49]);
    expect(check.weightedGcPct?.toFixed(2)).toBe("8.39");
    for (const asin of ["B0155OGEUU", "B005OMNPII"]) expect(check.asins.find((x) => x.asin === asin)).toMatchObject({ sourcing_cost: "14.87", computed_cost_per_unit: "13.62" });
    // Reversed, the % stack gives the same: 15% then 50% → $104.97 then $297.42 (Σ $402.39).
    const rev = checkPoForm({ ...form, promos: [form.promos![1], form.promos![0]] });
    expect(rev.promoAmountsUsed).toEqual([104.97, 297.42]);
  });
});

describe("Yankee HFUS09823034326: ASINs — AF's database first, else Amazon search; the model never supplies one", () => {
  it("no AF match: Christmas Eve has 3 Amazon results naming every distinctive word → blank, top 3 to pick (the Midnight Jasmine line is no match); Cherries On Snow has one → prefilled amber", async () => {
    _clearAmazonSearchCache();
    // The old match: a past Yankee line "Midnight Jasmine Original Large Jar Candle" shared only the generic words.
    const qh = async (sql: string) => /FROM po_line_items l JOIN po_asins/.test(sql) && !/supplier_sku/.test(sql)
      ? { rows: [{ asin: "B00184W5LY", product_name: "Midnight Jasmine Original Large Jar Candle", last_ordered: "2026-10-01" }], rowCount: 1 } : q(sql);
    const x = { ...extraction, lines: extraction.lines.map((l, i) => ({ ...l, asinGuess: i === 0 ? "B00184W5LY" : null })) };
    const out = await enrichPrefill(qh as any, capture, x, null, { id: "", capturedAt: null }, searchDeps);
    expect(out.form.products![0].asin).toBe("");
    expect(out.prefill.asin_candidates!["0"].map((c) => c.asin)).toEqual(["B0155OGEUU", "B0F8K84QX6", "B0FLZWNDH7"]);
    expect(out.prefill.asin_candidates!["0"].every((c) => c.via === "amazon" && c.name_all)).toBe(true);
    expect(out.form.products![1].asin).toBe("B005OMNPII");
    expect(out.prefill.sources["products.1.asin"]).toBe("model"); // amber
    expect(out.prefill.hints!["products.1.asin"]).toMatch(/^Amazon search: the only result matching every distinctive word/);
    expect(out.prefill.warnings!.join(" ")).toMatch(/Line 1: no ASIN in AF's database — pick one of the suggestions/);
  });
  it("a remembered pick (her saved line, same name) fills from AF's database, stone, before any search", async () => {
    _clearAmazonSearchCache();
    let searched = 0;
    const qh = async (sql: string) => /FROM po_line_items l JOIN po_asins/.test(sql) && !/supplier_sku/.test(sql)
      ? { rows: [{ asin: "B0155OGEUU", product_name: "Christmas Eve® Original Large Jar Candle", last_ordered: "2026-11-06" }], rowCount: 1 } : q(sql);
    const out = await enrichPrefill(qh as any, capture, { ...extraction, lines: [extraction.lines[0]] }, null, { id: "", capturedAt: null }, { get: async (e, p) => { searched++; return searchDeps.get(e, p); } });
    expect(out.form.products![0].asin).toBe("B0155OGEUU");
    expect(out.prefill.sources["products.0.asin"]).toBe("af");
    expect(out.prefill.hints!["products.0.asin"]).toMatch(/^AF database: past PO line/);
    expect(searched).toBe(0);
  });
});
