import { describe, it, expect } from "vitest";
import { evalMoneyExpr, isExpression } from "./money-expr";

const ok = (src: string) => { const r = evalMoneyExpr(src); if (!r.ok) throw new Error(`${src}: ${r.error}`); return r; };

describe("money-field calculator", () => {
  it("the example from the brief: 24.99*2/3+1.5 → 18.16", () => {
    expect(evalMoneyExpr("24.99*2/3+1.5")).toEqual({ ok: true, value: 18.16, text: "18.16", expression: "24.99*2/3+1.5" });
  });
  it("precedence: × ÷ before + −, left to right", () => {
    expect(ok("1+2*3").value).toBe(7);
    expect(ok("10-4-3").value).toBe(3);
    expect(ok("12/2/3").value).toBe(2);
    expect(ok("2+12/4*3").value).toBe(11);
  });
  it("parentheses, nesting, unary minus", () => {
    expect(ok("(1+2)*3").value).toBe(9);
    expect(ok("((2+3)*(4-1))/5").value).toBe(3);
    expect(ok("-(2+3)*2").value).toBe(-10);
    expect(ok("5*-2").value).toBe(-10);
  });
  it("× ÷ and x symbols, $ and thousands commas, decimals, rounding to the cent", () => {
    expect(ok("24.99 × 2 ÷ 3").value).toBe(16.66);
    expect(ok("3x4").value).toBe(12);
    expect(ok("$1,234.50 + .5").value).toBe(1235);
    expect(ok("1.005*1").value).toBe(1.01);
    expect(ok("10/3").text).toBe("3.33");
    expect(evalMoneyExpr("12.5")).toEqual({ ok: true, value: 12.5, text: "12.50", expression: null });
  });
  it("division by zero is rejected", () => {
    expect(evalMoneyExpr("5/0")).toEqual({ ok: false, error: "division by zero" });
    expect(evalMoneyExpr("5/(2-2)")).toEqual({ ok: false, error: "division by zero" });
  });
  it("invalid input is rejected (the field keeps its text)", () => {
    for (const bad of ["", "abc", "2+", "(1+2", "1+2)", "1..2", "2**3", "1 2", "=1+1", "alert(1)", "1e3"]) {
      const r = evalMoneyExpr(bad);
      expect(r.ok, bad).toBe(false);
    }
  });
  it("isExpression: a plain amount is not one", () => {
    expect(isExpression("12.50")).toBe(false);
    expect(isExpression("$1,234.50")).toBe(false);
    expect(isExpression("-3")).toBe(false);
    expect(isExpression("12.5+1")).toBe(true);
  });
});
