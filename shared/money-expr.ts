// Built-in calculator for cost / COGS money fields (2026-10-18). A field
// that holds an arithmetic expression — "24.99*2/3+1.5" — evaluates on blur
// / Enter to the result rounded to the cent. A recursive-descent parser over
// numbers, + − × ÷ (also * / x), parentheses and unary minus; no eval().
// Division by zero and anything unparseable are rejected (the field keeps
// the text and stays editable). "$" and thousands commas are accepted in
// numbers ("$1,234.50").

export type ExprResult = { ok: true; value: number; text: string; expression: string | null } | { ok: false; error: string };

/** True when the text is more than a plain amount — i.e. there is something to calculate. */
export function isExpression(s: string): boolean {
  const t = s.trim().replace(/^\$/, "").replace(/,/g, "");
  if (t === "") return false;
  return !/^-?\d*\.?\d+$/.test(t) && !/^-?\d+\.$/.test(t);
}

type Tok = { k: "num"; v: number } | { k: "op"; v: "+" | "-" | "*" | "/" } | { k: "("} | { k: ")" };

function tokenize(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  const s = src.replace(/[−–]/g, "-").replace(/[×xX]/g, "*").replace(/÷/g, "/");
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "$") { i++; continue; }
    if ("+-*/".includes(c)) { out.push({ k: "op", v: c as any }); i++; continue; }
    if (c === "(") { out.push({ k: "(" }); i++; continue; }
    if (c === ")") { out.push({ k: ")" }); i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.,]/.test(s[j])) j++;
      const raw = s.slice(i, j).replace(/,/g, "");
      if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) return `"${s.slice(i, j)}" is not a number`;
      out.push({ k: "num", v: Number(raw) });
      i = j; continue;
    }
    return `unexpected "${c}"`;
  }
  return out;
}

/** Evaluate an expression. Result rounded to the cent. */
export function evalMoneyExpr(input: string): ExprResult {
  const src = String(input ?? "").trim();
  if (src === "") return { ok: false, error: "empty" };
  const toks = tokenize(src);
  if (typeof toks === "string") return { ok: false, error: toks };
  let p = 0;
  const peek = () => toks[p];
  const fail = (m: string): never => { throw new Error(m); };
  // expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ; factor := '-' factor | '+' factor | num | '(' expr ')'
  const factor = (): number => {
    const t = peek();
    if (!t) return fail("incomplete expression");
    if (t.k === "op" && (t.v === "-" || t.v === "+")) { p++; const v = factor(); return t.v === "-" ? -v : v; }
    if (t.k === "num") { p++; return t.v; }
    if (t.k === "(") {
      p++; const v = expr();
      if (peek()?.k !== ")") return fail("missing )");
      p++; return v;
    }
    return fail(t.k === ")" ? "unexpected )" : `unexpected "${(t as any).v}"`);
  };
  const term = (): number => {
    let v = factor();
    for (let t = peek(); t && t.k === "op" && (t.v === "*" || t.v === "/"); t = peek()) {
      p++; const r = factor();
      if (t.v === "/") { if (r === 0) fail("division by zero"); v = v / r; } else v = v * r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    for (let t = peek(); t && t.k === "op" && (t.v === "+" || t.v === "-"); t = peek()) { p++; const r = term(); v = t.v === "+" ? v + r : v - r; }
    return v;
  };
  try {
    const v = expr();
    if (p !== toks.length) return { ok: false, error: toks[p].k === ")" ? "unexpected )" : "unexpected input" };
    if (!Number.isFinite(v)) return { ok: false, error: "not a finite number" };
    const value = Math.round((v + Number.EPSILON * Math.sign(v)) * 100) / 100;
    const norm = Object.is(value, -0) ? 0 : value;
    return { ok: true, value: norm, text: norm.toFixed(2), expression: isExpression(src) ? src : null };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "invalid expression" };
  }
}
