import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { filterSuggestions, type AsinInfo } from "./new-po-dialog";

// PO form polish (Maria 2026-11-01).
const info = (over: Partial<AsinInfo>): AsinInfo => ({ asin: "B000000001", title: null, primary_sku: null, image_url: null, brand: null, sold_as: null, units_per_pack: null, in_af: true, ...over });

describe("ASIN picker — a type-ahead, not a dropdown", () => {
  it("typing narrows the suggestions by ASIN, title, SKU or brand (case-insensitive); nothing typed keeps them all", () => {
    const opts = [info({ asin: "B0AAAAAAAA", title: "Liquitex Basics Acrylic", primary_sku: "LQ-4", brand: "Liquitex" }), info({ asin: "B0BBBBBBBB", title: "Tetley Tea 80ct", brand: "Tetley", matched_name: "Tetley British Blend" })];
    expect(filterSuggestions(opts, "")).toHaveLength(2);
    expect(filterSuggestions(opts, "liqui").map((o) => o.asin)).toEqual(["B0AAAAAAAA"]);
    expect(filterSuggestions(opts, "lq-4").map((o) => o.asin)).toEqual(["B0AAAAAAAA"]);
    expect(filterSuggestions(opts, "british").map((o) => o.asin)).toEqual(["B0BBBBBBBB"]);
    expect(filterSuggestions(opts, "B0BB").map((o) => o.asin)).toEqual(["B0BBBBBBBB"]);
    expect(filterSuggestions(opts, "zzz")).toEqual([]);
  });
  it("the input is a combobox: ↑ ↓ move, Enter picks, Escape closes, no Radix popover; an ASIN AF lacks offers Add to AF in the list", () => {
    const src = readFileSync(resolve(__dirname, "new-po-dialog.tsx"), "utf8");
    expect(src).toMatch(/role="combobox"/);
    expect(src).toMatch(/e\.key === "ArrowDown"/);
    expect(src).toMatch(/e\.key === "Enter"\) \{ if \(open && shown\[hi\]\) \{ e\.preventDefault\(\); pick\(shown\[hi\]\); \}/);
    expect(src).toMatch(/e\.key === "Escape" \|\| e\.key === "Tab"\) setOpen\(false\)/);
    expect(src).not.toMatch(/PopoverTrigger/);
    expect(src).toMatch(/is not in AF — Add to AF/);
  });
});

// Round 2 (Maria 2026-11-01): fixed widths that wrap, the rows in order, the ASIN row with its costs, no summary table.
describe("New PO form — round 2 layout", () => {
  const src = readFileSync(resolve(__dirname, "new-po-dialog.tsx"), "utf8");
  it("fields have fixed, content-sized widths and the rows wrap; PO notes fills the rest of its row; the product name caps at 40rem", () => {
    for (const [k, px] of [["supplier", 220], ["order_id", 180], ["order_date", 140], ["cashback_pct", 80]] as const) expect(src).toMatch(new RegExp(`field\\("${k}", "[^"]+", \\{ px: ${px}`));
    for (const k of ["subtotal", "discount", "tax", "sh_donations", "order_total"]) expect(src).toMatch(new RegExp(`field\\("${k}", "[^"]+", \\{ px: 120, [^}]*money: true \\}\\)`));
    expect(src).toMatch(/data-testid="new-po-order-fields">/);
    expect(src).toMatch(/className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-1\.5" data-testid="new-po-order-fields"/);
    expect(src).toMatch(/className="min-w-\[200px\] flex-1 space-y-0\.5">\s*<Label[^>]*>PO notes<\/Label>/);
    expect(src).toMatch(/grid-cols-\[7\.5rem_minmax\(12rem,40rem\)/);
    expect(src).not.toMatch(/Creates the PO, its products and ASIN rows in AF/);
  });
  it("Email used and Cashback site are dropdowns (Other… frees the email); Weighted GC % is read-only and computed; promos and payments sit side by side from 1440 px", () => {
    expect(src).toMatch(/<select id="new-po-email_used"/);
    expect(src).toMatch(/<option value="__other">Other…<\/option>/);
    expect(src).toMatch(/<select id="new-po-cashback_site"/);
    expect(src).toMatch(/<option value="">None<\/option>/);
    expect(src).toMatch(/data-testid="new-po-weighted-gc">\{check\.weightedGcPct/);
    expect(src).not.toMatch(/field\("weighted_gc_discount_pct"/);
    expect(src).toMatch(/min-\[1440px\]:grid-cols-2/);
    expect(src).toMatch(/GC % <Input value=\{p\.gift_card_discount_pct\}/);
    expect(src).toMatch(/canonicalPaymentName\(p\.nickname, people\.payment_aliases\)/);
    expect(src).toMatch(/\{PROMO_REFLECTED_NOTE\}/);
  });
  it("the ASIN row carries a label row (ASIN · Title · ASIN qty · Sold as · Units/pack · Prep · Sourcing · COGS · Paid · Adjustment · Reason · Notes) and the three costs; the summary table, Lines and Pack are gone; the math line stays; prep defaults from Ships to", () => {
    expect(src).toMatch(/\["ASIN", A\.asin\], \["Title", "title"\], \["ASIN qty", A\.qty, "text-right"\], \["Sold as", A\.sold\], \["Units\/pack", A\.upp, "text-right"\], \["Prep", A\.prep, "text-right"\], \["Sourcing", A\.sourcing, "text-right"\], \["COGS", A\.cogs, "text-right"\], \["Paid", A\.paid, "text-right"\], \["Adjustment", A\.adj, "text-right"\], \["Reason", A\.reason\], \["Notes", A\.notes\]/);
    expect(src).not.toMatch(/ASIN rows this PO will create|new-po-asin-summary|COGS \/ unit|<th className=\{th\}>Pack<\/th>/);
    expect(src).toMatch(/data-testid=\{`new-po-asin-math-\$\{i\}`\}/);
    expect(src).toMatch(/const want = shipsTo === "velocity" \? people\.velocity_prep\.toFixed\(2\) : "0\.00";/);
  });
});
