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
