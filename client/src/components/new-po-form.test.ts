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

// Cosmetics (Maria 2026-11-04): the ↳ ASIN label row under each product group; Cashback % a numeric field like the money ones.
describe("New PO form — cosmetics 2026-11-04", () => {
  const src = readFileSync(resolve(__dirname, "new-po-dialog.tsx"), "utf8");
  it("each ASIN label sits in its field's cell (2026-11-06): on a group's first ↳ ASIN row always, on the others only below 1280 — no separate label row, not in the table header", () => {
    const header = src.slice(src.indexOf('data-testid="new-po-products"'), src.indexOf("{boxes.map((box, bi) =>"));
    expect(header).not.toMatch(/ASIN_LABELS/);
    expect(src).not.toMatch(/new-po-asin-labels-/);
    const slots = src.slice(src.indexOf("{box.slots.map((slot, k) =>"));
    expect(slots).toMatch(/<LabelledCells labels=\{ASIN_LABELS\} always=\{k === 0\}>/);
    const cells = src.slice(src.indexOf("function LabelledCells"));
    expect(cells).toMatch(/\$\{always \? "" : "xl:hidden "\}/);
    expect(cells).toMatch(/\{label\}<\/span>\s*\{node\}/); // the label directly above its box, in the same cell
  });
  it("Cashback % is a numeric input (type number, decimal keypad, right-aligned) at the 120 px money / percent width", () => {
    expect(src).toMatch(/field\("cashback_pct", "Cashback %", \{ px: 120, ph: "0\.00", pct: true \}\)/);
    expect(src).toMatch(/opts\.pct\s*\? <Input id=\{`new-po-\$\{String\(k\)\}`\} type="number" inputMode="decimal"/);
  });
});

// Round 2 (Maria 2026-11-01): fixed widths that wrap, the rows in order, the ASIN row with its costs, no summary table.
describe("New PO form — round 2 layout", () => {
  const src = readFileSync(resolve(__dirname, "new-po-dialog.tsx"), "utf8");
  it("fields have fixed, content-sized widths and the rows wrap; PO notes fills the rest of its row; the product name caps at 40rem", () => {
    for (const [k, px] of [["supplier", 220], ["order_id", 180], ["order_date", 140], ["cashback_pct", 120]] as const) expect(src).toMatch(new RegExp(`field\\("${k}", "[^"]+", \\{ px: ${px}`));
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
    // Maria 2026-11-02: the picker resolves by nickname first, last 4 second, never by a shared last 4 alone (resolvePaymentNickname on blur of both fields; amber hint).
    expect(src).toMatch(/resolvePaymentNickname\(p\.nickname, p\.last4, \{ methods: people\.payment_methods, aliases: people\.payment_aliases, last4: people\.payment_last4 \}\)/);
    expect(src).toMatch(/onBlur=\{\(\) => resolvePay\(i\)\}[^\n]*input-new-po-payment-last4/);
    expect(src).toMatch(/\{PROMO_REFLECTED_NOTE\}/);
  });
  it("the ASIN row carries a label row (ASIN · Title · ASIN qty · Sold as · Units/pack · Prep · Sourcing · COGS · Paid · Adjustment · Reason · Notes) and the three costs; the summary table, Lines and Pack are gone; the math line stays; prep defaults from Ships to", () => {
    expect(src).toMatch(/\["ASIN", A\.asin\], \["Title", "title"\], \["ASIN qty", A\.qty, "text-right"\], \["Sold as", A\.sold\], \["Units\/pack", A\.upp, "text-right"\], \["Prep", A\.prep, "text-right"\], \["Sourcing", A\.sourcing, "text-right"\], \["COGS", A\.cogs, "text-right"\], \["Paid", A\.paid, "text-right"\], \["Adjustment", A\.adj, "text-right"\], \["Reason", A\.reason\], \["Notes", A\.notes\]/);
    expect(src).not.toMatch(/ASIN rows this PO will create|new-po-asin-summary|COGS \/ unit|<th className=\{th\}>Pack<\/th>/);
    expect(src).toMatch(/data-testid=\{`new-po-asin-math-\$\{i\}`\}/);
    expect(src).toMatch(/const want = shipsTo === "velocity" \? people\.velocity_prep\.toFixed\(2\) : "0\.00";/);
  });
});

// The "Update ASIN in AF" offer (§6.5) is hidden when AF's ASIN already has the entered pack: a quiet line says so (Maria 2026-11-06).
describe("New PO form — pack offer", () => {
  const src = readFileSync(resolve(__dirname, "new-po-dialog.tsx"), "utf8");
  it("a pack equal to AF's ASIN records 'this PO only' silently and shows 'ASIN already ×N'", () => {
    expect(src).toMatch(/if \(upp === afUpp && p\.sold_as === info\.sold_as\) \{ setForm\(\(f\) => \(\{ \.\.\.f, pack_updates: \{ \.\.\.\(f\.pack_updates \?\? \{\}\), \[p\.asin\]: false \} \}\)\); return; \}/);
    expect(src).toMatch(/data-testid=\{`new-po-pack-same-\$\{i\}`\}>ASIN already ×/);
  });
  it("an ASIN with no pack on record: a grey 'ASIN set to … in AF', no question; the save's counts go in the toast", () => {
    expect(src).toMatch(/info\?\.in_af && !info\.sold_as && \(p\.sold_as === "individual" \|\| \(p\.sold_as === "multi-pack" && Number\(p\.units_per_pack\) >= 2\)\)/);
    expect(src).toMatch(/if \(!info\?\.in_af \|\| !info\.sold_as \|\| p\.sold_as === ""\) return;/);
    expect(src).toMatch(/\(data\.asinPackSets \?\? \[\]\)\.map\(asinPackSetNote\)/);
  });
});
