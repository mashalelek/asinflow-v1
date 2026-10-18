/**
 * Money input with a built-in calculator (2026-10-18): type "24.99*2/3+1.5",
 * blur or press Enter, and the field becomes "18.16". The expression stays
 * visible as a tooltip. An expression that does not parse (or divides by
 * zero) keeps its text, turns the field red with the reason as a tooltip,
 * and stays editable. Parser: shared/money-expr.ts (no eval).
 */
import React, { useState } from "react";
import { Input } from "@/components/ui/input";
import { evalMoneyExpr, isExpression } from "@shared/money-expr";

/** Apply the calculator to a typed value: unchanged when it is not an expression. */
export function calcMoney(text: string): { ok: true; text: string; expression: string | null } | { ok: false; error: string } {
  if (!isExpression(text)) return { ok: true, text, expression: null };
  const r = evalMoneyExpr(text);
  return r.ok ? { ok: true, text: r.text, expression: r.expression } : { ok: false, error: r.error };
}

export function MoneyCalcInput({ value, onChange, className = "", ...rest }: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & { value: string; onChange: (v: string) => void }) {
  const [expr, setExpr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const settle = () => {
    const r = calcMoney(value);
    if (!r.ok) { setErr(`Can't calculate: ${r.error}`); return; }
    setErr(null);
    if (r.expression) { setExpr(r.expression); onChange(r.text); }
  };
  return (
    <Input
      {...rest}
      value={value}
      inputMode="decimal"
      onChange={(e) => { setErr(null); onChange(e.target.value); }}
      onBlur={(e) => { settle(); rest.onBlur?.(e); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); settle(); } rest.onKeyDown?.(e); }}
      title={err ?? (expr ? `= ${expr}` : rest.title)}
      aria-invalid={err ? true : undefined}
      className={`${className} ${err ? "border-destructive ring-1 ring-destructive" : ""}`}
      data-calc-expression={expr ?? undefined}
    />
  );
}
