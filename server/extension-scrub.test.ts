import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { luhn, maskCardRuns, removeExpiries, removeCvvs, maskGiftCards, scrubText, scrubField } from "../chrome-extension/scrub.js";

// Capture PO §4.3: nothing card-like leaves the browser. The fixtures are
// hand-written synthetic checkout pages (public test card numbers only).
const FIX = resolve(__dirname, "__fixtures__/capture-pages");
const fixtures = readdirSync(FIX).filter((f) => f.endsWith(".txt")).map((f) => [f, readFileSync(resolve(FIX, f), "utf8")] as const);

describe("scrub.js", () => {
  it("Luhn: the public test numbers pass, a phone / account number does not", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("5555555555554444")).toBe(true);
    expect(luhn("378282246310005")).toBe(true);
    expect(luhn("6011111111111117")).toBe(true);
    expect(luhn("7575550100")).toBe(false);
    expect(luhn("1234567890")).toBe(false);
  });
  it("card runs with spaces or dashes → •••• last 4; a Luhn-failing run (order id, account) is untouched", () => {
    expect(maskCardRuns("Card number 4111 1111 1111 1111 on file")).toBe("Card number •••• 1111 on file");
    expect(maskCardRuns("Mastercard 5555-5555-5555-4444")).toBe("Mastercard •••• 4444");
    expect(maskCardRuns("Order number: 123456789012")).toBe("Order number: 123456789012");
    expect(maskCardRuns("Account 1234 5678 90")).toBe("Account 1234 5678 90");
  });
  it("expiries only near exp / valid; CVVs by label; gift cards keep the last 4", () => {
    expect(removeExpiries("Expiration 09/28 · Arrives 11/06")).toBe("Expiration [expiry removed] · Arrives 11/06");
    expect(removeExpiries("Valid thru 03/27")).toBe("Valid thru [expiry removed]");
    expect(removeExpiries("Order placed 10/2026")).toBe("Order placed 10/2026");
    expect(removeCvvs("CVV 123 and security code: 4321")).toBe("CVV [removed] and security code: [removed]");
    expect(maskGiftCards("Gift card number 6006 4921 1234 5678 9012 PIN 4321")).toBe("Gift card number •••• 9012 PIN 4321");
    expect(maskGiftCards("e-Gift card: 7777 8888 9999 0000 1234 applied")).toBe("e-Gift card: •••• 1234 applied");
  });
  it("fields: cvv / expiry fields dropped, gift-card fields keep the last 4, others scrubbed like text", () => {
    expect(scrubField("CVV", "123")).toBeNull();
    expect(scrubField("Expiration date", "09/28")).toBeNull();
    expect(scrubField("Gift card number", "6006492112345678")).toEqual({ label: "Gift card number", value: "•••• 5678" });
    expect(scrubField("Card number", "4111111111111111")).toEqual({ label: "Card number", value: "•••• 1111" });
    expect(scrubField("Email", "maria@example.com")).toEqual({ label: "Email", value: "maria@example.com" });
    expect(scrubField("Quantity", "6")).toEqual({ label: "Quantity", value: "6" });
  });
  it.each(fixtures)("%s: no full card number, no CVV, no expiry survives; prices, quantities, addresses and the email do", (_name, text) => {
    const out = scrubText(text);
    for (const n of ["4111 1111 1111 1111", "4111-1111-1111-1111", "5555-5555-5555-4444", "3782 822463 10005", "6011 1111 1111 1117", "6006 4921 1234 5678 9012", "7777 8888 9999 0000 1234"]) expect(out).not.toContain(n);
    expect(out).not.toMatch(/CVV \d|CVC: \d|security code \d/);
    expect(out).not.toMatch(/(Expiration|exp|Exp\.|Valid thru) \d\d\/\d\d/);
    expect(out).toMatch(/\$\d+\.\d{2}/);
    expect(out).toMatch(/Qty:? ?\d|Items \(?\d/);
    expect(out).toMatch(/805 Grandy|65 Rivercrest/);
    if (text.includes("maria@example.com")) expect(out).toContain("maria@example.com");
    if (text.includes("Order number: 123456789012")) expect(out).toContain("Order number: 123456789012");
  });
});
