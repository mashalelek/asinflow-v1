import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { calcMoney } from "./money-calc-input";
import { settleMoney } from "./new-po-dialog";
import { emptyPoForm, emptyProduct } from "@shared/po-form";

describe("calculator in the money fields", () => {
  it("calcMoney: a plain amount passes through; an expression becomes its cent-rounded result; a bad one is refused", () => {
    expect(calcMoney("12.50")).toEqual({ ok: true, text: "12.50", expression: null });
    expect(calcMoney("24.99*2/3+1.5")).toEqual({ ok: true, text: "18.16", expression: "24.99*2/3+1.5" });
    expect(calcMoney("5/0")).toEqual({ ok: false, error: "division by zero" });
    expect(calcMoney("2+")).toMatchObject({ ok: false });
  });
  it("New PO: Create calculates every money field still holding an expression; a bad one blocks the save", () => {
    const f = { ...emptyPoForm("2026-10-18"), tax: "1.5+1.5", products: [{ ...emptyProduct(), price: "24.99*2/3+1.5", prep_cost: "0.5*2" }], cost_overrides: { B0TEST0001: "10/4" } };
    const s = settleMoney(f);
    expect(s.ok && s.form.tax).toBe("3.00");
    expect(s.ok && s.form.products[0]).toMatchObject({ price: "18.16", prep_cost: "1.00" });
    expect(s.ok && s.form.cost_overrides).toEqual({ B0TEST0001: "2.50" });
    expect(settleMoney({ ...f, discount: "1/(2-2)" })).toEqual({ ok: false, error: '"1/(2-2)": division by zero' });
  });
  it("every cost / money field uses the calculator: New PO (header money, price, prep, cost / unit), the PO edit drawer's money fields, the price / cost / prep cells", () => {
    const dlg = readFileSync(resolve(__dirname, "new-po-dialog.tsx"), "utf8");
    for (const k of ["subtotal", "tax", "sh_donations", "discount", "refund_amount", "order_total"]) expect(dlg).toMatch(new RegExp(`field\\("${k}", "[^"]+", \\{[^}]*money: true \\}\\)`));
    expect(dlg).toMatch(/<MoneyCalcInput value=\{p\.price\}/);
    expect(dlg).toMatch(/<MoneyCalcInput value=\{p\.prep_cost\}/);
    expect(dlg).toMatch(/<MoneyCalcInput value=\{form\.cost_overrides\[a\.asin\]/);
    const edit = readFileSync(resolve(__dirname, "po-edit.tsx"), "utf8");
    expect(edit).toMatch(/f\.type === "money" \? \(\s*<MoneyCalcInput/);
    expect(edit).toMatch(/<InlineEdit money value=\{l\.price\}/);
    const rows = readFileSync(resolve(__dirname, "po-asin-rows.tsx"), "utf8");
    expect(rows).toMatch(/<InlineEdit money value=\{a\.cost_per_unit\}/);
    expect(rows).toMatch(/<InlineEdit money value=\{a\.prep_cost\}/);
    // the expression stays visible as a tooltip after evaluating
    expect(readFileSync(resolve(__dirname, "money-calc-input.tsx"), "utf8")).toMatch(/title=\{err \?\? \(expr \? `= \$\{expr\}` : rest\.title\)\}/);
    expect(edit).toMatch(/title=\{err \?\? \(expr \? `= \$\{expr\}` : title\)\}/);
  });
});
