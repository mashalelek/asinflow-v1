// Payment-form values never leave the browser (Capture PO 2.0.2, Maria 2026-11-05). Gordon's payment form sent its
// security code as SECNO_NEW, which the label rules missed. The REAL capture.js runs here against a small fake DOM
// shaped like that page — a synthetic 3-digit code in SECNO_NEW, a synthetic expiry in oddly named selects, a public
// test card number — plus a separate shipping form, an autocomplete cc-csc input outside any form and a password.
// Synthetic numbers only, never real ones.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import vm from "vm";
import { isCardInput, isSecretInput, paymentFormField, rescrubFields, cardShaped } from "../chrome-extension/core/scrub.js";

const EXT = resolve(__dirname, "../chrome-extension");
type Spec = { tag: "input" | "select" | "textarea"; type?: string; name?: string; id?: string; label?: string; value?: string; options?: string[]; checked?: boolean; autocomplete?: string; context?: string };
class El {
  tagName: string; parentElement: El | null = null; children: El[] = []; attrs: Record<string, string> = {}; value = ""; checked = false; name = ""; id = ""; innerText = "";
  options: { text: string; value: string }[] = []; selectedIndex = -1; kind: string;
  constructor(kind: string) { this.kind = kind; this.tagName = kind.toUpperCase(); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  getBoundingClientRect() { return { width: 100, height: 20 }; }
  closest(sel: string): El | null { for (let n: El | null = this; n; n = n.parentElement) if (n.kind === sel) return n; return null; }
  contains(o: El): boolean { for (let n: El | null = o; n; n = n.parentElement) if (n === this) return true; return false; }
  add(c: El) { c.parentElement = this; this.children.push(c); return c; }
}
function control(s: Spec): El {
  const el = new El(s.tag);
  if (s.type) el.attrs.type = s.type;
  if (s.autocomplete) el.attrs.autocomplete = s.autocomplete;
  if (s.label) el.attrs["aria-label"] = s.label;
  el.name = s.name ?? ""; el.id = s.id ?? "";
  if (s.tag === "select") { el.options = (s.options ?? []).map((t) => ({ text: t, value: t })); el.selectedIndex = Math.max(0, (s.options ?? []).indexOf(s.value ?? "")); }
  else el.value = s.value ?? "";
  el.checked = !!s.checked;
  return el;
}
/** body > [form (shipping), form (payment; a label wrapping each radio), form (other), loose inputs (no form)] */
function page(paymentSpecs: Spec[], shippingSpecs: Spec[], loose: Spec[], other: Spec[] = []) {
  const body = new El("body"), all: El[] = [];
  const mount = (box: El, specs: Spec[]) => specs.forEach((s) => {
    if (s.type === "radio") { const lab = box.add(new El("label")); lab.innerText = s.context ?? ""; all.push(lab.add(control(s))); }
    else all.push(box.add(control(s)));
  });
  mount(body.add(new El("form")), shippingSpecs); mount(body.add(new El("form")), paymentSpecs); mount(body.add(new El("form")), other); mount(body, loose);
  body.innerText = "Checkout\nBilling Address:\n*Name on Card\n*Address Line 1\nPayment Method\nVisa\nMaster Card\n*Credit Card Number\nExp Date\n*Security Code (?)";
  return { body, all };
}
function capture(p: { body: El; all: El[] }) {
  const document = { title: "Checkout", body: p.body, querySelectorAll: () => p.all, querySelector: () => null };
  const ctx: any = { document, location: { origin: "https://www.gordonelectricsupply.com", pathname: "/index.jsp" }, getComputedStyle: () => ({ visibility: "visible", display: "block" }), CSS: { escape: (s: string) => s }, Element: El };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(EXT, "core/scrub.js"), "utf8"), ctx);
  return vm.runInContext(readFileSync(resolve(EXT, "capture.js"), "utf8"), ctx) as { fields: { label: string; value: string }[]; text: string };
}

const CODE = "428", MONTH = "07", YEAR = "2031", CARD = "5105 1051 0510 5100"; // synthetic code / expiry; public Mastercard test number
const gordonPayment: Spec[] = [
  { tag: "input", type: "radio", name: "PAYOPT", checked: true, context: "Use a credit card" },
  { tag: "input", name: "BILLNAME", label: "Name on Card", value: "Test Buyer" },
  { tag: "input", name: "BILLADDR1", label: "Address Line 1", value: "12 Elsewhere St" },
  { tag: "input", name: "BILLCITY", label: "City", value: "Springfield" },
  { tag: "select", name: "BILLSTATE", label: "State", options: ["---- Select State ----", "Illinois (IL)"], value: "Illinois (IL)" },
  { tag: "input", name: "BILLZIP", label: "Zip Code", value: "62701" },
  { tag: "select", name: "CC.TYPE", options: ["Visa", "Master Card", "Amer Express", "Discover"], value: "Master Card" },
  { tag: "input", name: "CCNO", value: CARD },
  { tag: "select", name: "ZQ_A1", options: ["01", "02", "03", "04", "05", "06", "07"], value: MONTH }, // expiry month, oddly named
  { tag: "select", name: "ZQ_A2", options: ["2026", "2031"], value: YEAR }, // expiry year, oddly named
  { tag: "input", name: "SECNO_NEW", value: CODE },
];
const shippingForm: Spec[] = [
  { tag: "input", name: "SHIPEMAIL", label: "Email Address", value: "buyer@example.com" },
  { tag: "input", name: "SHIPADDR1", label: "Address Line 1", value: "805 Grandy Ave" },
  { tag: "input", name: "SHIPZIP", label: "Zip Code", value: "97850" },
];

describe("capture.js on a Gordon-like payment page: nothing but the last 4 (and the card nickname) leaves", () => {
  const out = capture(page(gordonPayment, [...shippingForm, { tag: "input", type: "password", name: "pw", value: "hunter2" }], [], [
    { tag: "input", name: "zz9", autocomplete: "cc-csc", value: "917" }, // a code box in a form of its own, oddly named
    { tag: "input", name: "zz_note", value: "leave at door" }, // …which makes that form payment-side
  ]));
  const byName = (n: string) => out.fields.find((f) => f.label === n);
  it("the security code, the expiry, the name on card and the billing address leave with an empty value (labels stay)", () => {
    for (const n of ["SECNO_NEW", "ZQ_A1", "ZQ_A2", "Name on Card", "City", "State"]) expect(byName(n)).toEqual({ label: n, value: "" });
    const blob = JSON.stringify(out);
    for (const secret of [CODE, "917", "leave at door", MONTH, YEAR, "hunter2", "Test Buyer", "12 Elsewhere", "Springfield", "62701", "5105", "Illinois"]) expect(blob).not.toContain(secret);
  });
  it("the card's last 4 and its nickname are what stays — AF stores both", () => {
    expect(byName("CCNO")).toEqual({ label: "CCNO", value: "•••• 5100" });
    expect(byName("CC.TYPE")).toEqual({ label: "CC.TYPE", value: "Master Card" });
    expect(byName("selected: Use a credit card")).toEqual({ label: "selected: Use a credit card", value: "Use a credit card" }); // a checked option's visible text is page text
  });
  it("a separate shipping form keeps its values; a cc-csc input empties its own form; a password is never read", () => {
    expect(out.fields.filter((f) => f.label === "Address Line 1").map((f) => f.value).sort()).toEqual(["", "805 Grandy Ave"]);
    expect(byName("Email Address")?.value).toBe("buyer@example.com");
    expect(byName("zz9")).toEqual({ label: "zz9", value: "" });
    expect(byName("zz_note")).toEqual({ label: "zz_note", value: "" });
    expect(byName("pw")).toBeUndefined();
  });
  it("the page text and its labels stay", () => expect(out.text).toMatch(/Security Code \(\?\)[\s\S]*/));
  it("with no form on the page, a card input makes every control outside a form payment-side — a real form elsewhere keeps its values", () => {
    const p = page([], shippingForm, [...gordonPayment.slice(1)]);
    const o = capture(p);
    expect(JSON.stringify(o.fields)).not.toMatch(new RegExp(`${CODE}|${YEAR}|Test Buyer|62701|12 Elsewhere`));
    expect(o.fields.find((f) => f.label === "CCNO")?.value).toBe("•••• 5100");
    expect(o.fields.find((f) => f.label === "Email Address")?.value).toBe("buyer@example.com");
  });
});

describe("the pure rules", () => {
  it("a card input: autocomplete cc-*, a card label by its words or the form's name, a card-shaped value", () => {
    expect(isCardInput("zz", "cc-exp-month", "")).toBe(true);
    expect(isCardInput("SECNO_NEW", "", "")).toBe(true);
    expect(isCardInput("Name on Card", "", "")).toBe(true);
    expect(isCardInput("q", "", "4111 1111 1111 1111")).toBe(true);
    expect(isCardInput("Search", "", "0012345678905")).toBe(false); // a GTIN-13 is no card
    expect(isCardInput("Zip Code", "postal-code", "97850")).toBe(false);
    expect(cardShaped("6011-1111-1111-1117")).toBe(true);
  });
  it("secret inputs anywhere: password, cc-csc, cc-exp, cc-number, cc-name", () => {
    for (const ac of ["cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-number", "cc-name", "billing cc-csc"]) expect(isSecretInput("text", ac)).toBe(true);
    expect(isSecretInput("password", "")).toBe(true);
    expect(isSecretInput("text", "cc-type")).toBe(false);
    expect(isSecretInput("text", "shipping street-address")).toBe(false);
  });
  it("a payment-form field keeps a value only for a card number's last 4 or a nickname", () => {
    expect(paymentFormField("Card number", "4111111111111111")).toEqual({ label: "Card number", value: "•••• 1111" });
    expect(paymentFormField("Card", "", "cc-type")).toEqual({ label: "Card", value: "" });
    expect(paymentFormField("Card type", "Visa")).toEqual({ label: "Card type", value: "Visa" });
    expect(paymentFormField("brand", "American Express", "cc-type")).toEqual({ label: "brand", value: "American Express" });
    expect(paymentFormField("Nickname", "Chase Sapphire")).toEqual({ label: "Nickname", value: "Chase Sapphire" });
    expect(paymentFormField("Name on card", "Visa")).toEqual({ label: "Name on card", value: "Visa" }); // a brand word is a nickname wherever it sits
    expect(paymentFormField("Name on card", "Test Buyer", "cc-name")).toEqual({ label: "Name on card", value: "" });
    expect(paymentFormField("x", "2031")).toEqual({ label: "x", value: "" });
  });
  it("stored fields (no DOM) scrubbed again: a page with a card field keeps only last 4, nickname and the checked options", () => {
    expect(rescrubFields([{ label: "selected: Use a credit card", value: "Use a credit card" }, { label: "Name on Card", value: "Test Buyer" }, { label: "CC.TYPE", value: "Master Card" }, { label: "CCNO", value: "•••• 5100" }, { label: "EXP.MONTH", value: "07" }, { label: "SECNO_NEW", value: "428" }, { label: "Zip Code", value: "62701" }]))
      .toEqual([{ label: "selected: Use a credit card", value: "Use a credit card" }, { label: "Name on Card", value: "" }, { label: "CC.TYPE", value: "Master Card" }, { label: "CCNO", value: "•••• 5100" }, { label: "Zip Code", value: "" }]);
    expect(rescrubFields([{ label: "Address Line 1", value: "805 Grandy Ave" }, { label: "Zip Code", value: "97850" }])).toEqual([{ label: "Address Line 1", value: "805 Grandy Ave" }, { label: "Zip Code", value: "97850" }]);
  });
});
