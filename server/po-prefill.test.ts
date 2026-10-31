import { describe, it, expect, vi } from "vitest";
import { CaptureSchema, PrefillSchema, extractPrefill, enrichPrefill, mergedPagesText, supplierForHost, shipsToForStreet, storePrefill, getPrefill, _clearPrefillCache, PREFILL_TTL_MS } from "./po-prefill";

vi.mock("./log", () => ({ log: () => {} }));

// po-ai-prefill §5: strict schema, raw-text fallback, enrichment with no AI, the 10-minute key.
const capture = CaptureSchema.parse({
  retailerHost: "www.michaels.com", capturedAt: "2026-10-31T15:00:00Z",
  pages: [
    { step: "review", url: "https://www.michaels.com/checkout/review", title: "Review", text: "Order summary\nLiquitex BASICS Acrylic Paint 4oz Blue Gray × 6 $5.99\nSubtotal $35.94\nShipping $0.00\nTax $2.52\nTotal $38.46\nDeliver to 805 Grandy Ave" },
    { step: "cart", url: "https://www.michaels.com/cart?x=1", title: "Cart", text: "Cart", fields: [{ label: "Quantity", value: "6" }] },
  ],
});
const extraction = PrefillSchema.parse({
  retailer: "Michaels", orderId: "8100107959187461", orderDate: "2026-10-31",
  lines: [{ productName: "Liquitex BASICS Acrylic Paint, 4oz., Color: PB29 Blue Gray", retailerSku: "10543981", qty: 6, unitsPerPack: 1, unitPrice: 5.99, lineTotal: 35.94, asinGuess: "B08BR4NC22" }],
  subtotal: 35.94, discount: 0, tax: 2.52, shipping: 0, total: 38.46,
  promos: [{ type: "sale", description: "30% on regular priced items", amount: null, percent: 30, confidence: "high" }],
  payments: [{ method: "card", nickname: "Amex", last4: "1001", amount: 38.46 }],
  shipToStreet: "805 Grandy Ave", subscription: { present: false, frequencyWeeks: null }, purchasedEmail: "orders@coastalqualitygoods.com", notes: [],
});

describe("extractPrefill", () => {
  it("merges the pages in checkout order with their form fields, and returns the parsed extraction with usage", async () => {
    const text = mergedPagesText(capture);
    expect(text.indexOf("PAGE 1 (cart)")).toBeLessThan(text.indexOf("PAGE 2 (review)"));
    expect(text).toContain("FORM FIELDS:\nQuantity: 6");
    const r = await extractPrefill(capture, { call: async () => ({ parsed: extraction, input_tokens: 1200, output_tokens: 300 }) });
    expect(r.extraction?.orderId).toBe("8100107959187461");
    expect(r.usage).toMatchObject({ schema_ok: true, input_tokens: 1200, output_tokens: 300, cost_estimate: 0.00027, error: null });
  });
  it("a schema failure or an API error is the raw-text fallback (extraction null), never a throw", async () => {
    const bad = await extractPrefill(capture, { call: async () => ({ parsed: { orderId: 5 }, input_tokens: 10, output_tokens: 5 }) });
    expect(bad.extraction).toBeNull();
    expect(bad.usage.schema_ok).toBe(false);
    expect(bad.usage.error).toMatch(/^schema:/);
    const err = await extractPrefill(capture, { call: async () => { throw new Error("overloaded"); } });
    expect(err.extraction).toBeNull();
    expect(err.usage.error).toBe("overloaded");
  });
});

describe("enrichment (no AI)", () => {
  it("hostname → supplier: exact domain, alias, same registrable domain, else new", () => {
    const suppliers = ["walmart.com", "shop.tetleyusa.com", "michaels.com"];
    const aliases = new Map([["m.walmart.com", "walmart.com"]]);
    expect(supplierForHost("https://www.walmart.com/checkout", suppliers, aliases)).toEqual({ supplier: "walmart.com", known: true });
    expect(supplierForHost("m.walmart.com", suppliers, aliases)).toEqual({ supplier: "walmart.com", known: true });
    expect(supplierForHost("www.tetleyusa.com", suppliers, aliases)).toEqual({ supplier: "shop.tetleyusa.com", known: true });
    expect(supplierForHost("www.newstore.com", suppliers, aliases)).toEqual({ supplier: "newstore.com", known: false });
  });
  it("§4.4 ship-to: Velocity street → velocity + the prep rate, home street → home + $0, else blank", () => {
    const s = { velocityStreet: "805 grandy", homeStreets: ["65 rivercrest"], prepCost: 1 };
    expect(shipsToForStreet("805 Grandy Ave, Norfolk", s)).toEqual({ ships_to: "velocity", prep: "1.00" });
    expect(shipsToForStreet("65 Rivercrest Dr", s)).toEqual({ ships_to: "home", prep: "0" });
    expect(shipsToForStreet("12 Elsewhere St", s)).toEqual({ ships_to: "", prep: "" });
    expect(shipsToForStreet(null, s)).toEqual({ ships_to: "", prep: "" });
  });
  it("builds the form with markers: supplier from AF, history ASIN (stone) with AF's pack, promos / payments from the model (amber), totals cross-checks", async () => {
    const q = async (sql: string, params: any[] = []) => {
      if (/SELECT DISTINCT supplier FROM purchase_orders/.test(sql)) return { rows: [{ supplier: "michaels.com" }], rowCount: 1 };
      if (/FROM supplier_aliases/.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM settings WHERE key = ANY/.test(sql)) return { rows: [{ key: "tracking.velocity_street", value: "805 grandy" }, { key: "tracking.home_streets", value: ["65 rivercrest"] }, { key: "prep_cost", value: 1 }], rowCount: 3 };
      if (/FROM po_line_items l JOIN po_asins/.test(sql)) return { rows: [{ asin: "B08BR4NC22", product_name: "Liquitex BASICS™ Acrylic Paint, 4oz., Color: PB29 Blue Gray", last_ordered: "2026-10-01" }], rowCount: 1 };
      if (/WHERE a.asin = ANY/.test(sql)) return { rows: params[0].map((asin: string) => ({ asin, title: "Liquitex Basics Acrylic 4oz", primary_sku: "LQ-4", image_url: null, brand: "Liquitex", sold_as: "multi-pack", units_per_pack: 2 })), rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const out = await enrichPrefill(q, capture, { ...extraction, total: 40 }, null, { id: "", capturedAt: "2026-10-31T15:00:00Z" });
    expect(out.form).toMatchObject({ supplier: "michaels.com", order_id: "8100107959187461", order_date: "2026-10-31", subtotal: "35.94", tax: "2.52", sh_donations: "0.00", order_total: "40.00", ships_to: "velocity", email_used: "orders@coastalqualitygoods.com" });
    expect(out.form.products?.[0]).toMatchObject({ product_name: expect.stringContaining("Liquitex"), price: "5.99", qty_ordered: "6", retailer_units_per_pack: "1", asin: "B08BR4NC22", sold_as: "multi-pack", units_per_pack: "2", asin_qty_per_product: "0.5", prep_cost: "1.00" });
    expect(out.form.promos).toEqual([{ type: "sale", description: "30% on regular priced items", amount: "", percent: "30.00", counts_toward_cogs: true }]);
    expect(out.form.payments).toEqual([{ method: "card", nickname: "Amex", last4: "1001", amount: "38.46", gift_card_discount_pct: "" }]);
    expect(out.prefill.sources).toMatchObject({ supplier: "af", order_id: "model", "products.0.price": "model", "products.0.asin": "af", "asin.B08BR4NC22": "af", "promos.0": "model", "payments.0": "model", ships_to: "af" });
    expect(out.prefill.warnings).toEqual(["Payments add up to 38.46, the order total is 40.00"]);
    expect(out.prefill).toMatchObject({ supplier: "michaels.com", pages: 2, captured_at: "2026-10-31T15:00:00Z", raw_text: null });
  });
  it("with no extraction: the form carries only the supplier, the raw text and the fallback warning", async () => {
    const q = async (sql: string) => (/DISTINCT supplier/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 });
    const out = await enrichPrefill(q, capture, null, "RAW", { id: "", capturedAt: null });
    expect(out.form).toEqual({ supplier: "michaels.com" });
    expect(out.prefill.raw_text).toBe("RAW");
    expect(out.prefill.warnings?.[0]).toMatch(/could not be read into the form/);
    expect(out.prefill.warnings).toContain("New supplier: michaels.com has no PO in AF yet");
  });
});

describe("the 10-minute key", () => {
  it("stores, returns with its id, expires after the TTL", () => {
    _clearPrefillCache();
    const id = storePrefill({ form: { supplier: "x" }, prefill: { sources: {} } }, 42, 1_000);
    expect(id).toHaveLength(10);
    expect(getPrefill(id, 2_000)).toEqual({ payload: { form: { supplier: "x" }, prefill: { sources: {}, id } }, logId: 42 });
    expect(getPrefill(id, 1_000 + PREFILL_TTL_MS)).toBeNull();
    expect(getPrefill("nope")).toBeNull();
  });
});
