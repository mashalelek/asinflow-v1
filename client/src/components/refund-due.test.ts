import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { proposalsFor } from "./refund-due-dialog";
import { readPoPageParams } from "@/pages/purchase-orders";

// Dashboard patch commit 4 (SPEC §22 "Refunds: due and received", §2.4): the
// due-refund proposal after a cancel, the Payments tab's status column with
// Mark received, the POs page's Refunds filter + deep link + refund-due text.
const dialog = readFileSync(resolve(__dirname, "refund-due-dialog.tsx"), "utf8");
const moneyTab = readFileSync(resolve(__dirname, "po-money.tsx"), "utf8");
const editor = readFileSync(resolve(__dirname, "po-edit.tsx"), "utf8");
const rows = readFileSync(resolve(__dirname, "po-asin-rows.tsx"), "utf8");
const page = readFileSync(resolve(__dirname, "../pages/purchase-orders.tsx"), "utf8");

describe("proposalsFor — one due row per canceled line, allocated from the PO header", () => {
  it("allocates discount and tax when the header has a subtotal; plain qty × price otherwise; a zero qty line is dropped", () => {
    const po = { id: "p1", subtotal: "200", discount: "20", tax: "16" };
    expect(proposalsFor(po, [{ lineId: "l1", productName: "A", qty: 2, price: "25" }, { lineId: "l2", productName: "B", qty: 0, price: "9" }])).toEqual([{ lineId: "l1", productName: "A", qty: 2, price: "25", amount: "49", allocated: true }]);
    expect(proposalsFor({ id: "p1" }, [{ lineId: "l1", productName: "A", qty: 3, price: "10" }])[0]).toMatchObject({ amount: "30", allocated: false });
    expect(proposalsFor({ id: "p1" }, [{ lineId: "l1", productName: "A", qty: 3, price: null }])[0]).toMatchObject({ amount: "", allocated: false });
  });
});

describe("entry points and dialogs", () => {
  it("both dialogs ride the shared frame with their own ids; the proposal posts status due and Skip saves nothing", () => {
    expect(dialog).toMatch(/dialogId="refund-due-proposal"/);
    expect(dialog).toMatch(/dialogId="refund-mark-received"/);
    expect(dialog).toMatch(/status: "due", note: "canceled — refund expected"/);
    expect(dialog).toMatch(/data-testid="button-refund-proposal-skip"/);
    expect(dialog).toMatch(/PATCH", \{ status: "received", refunded_at: form\.refunded_at, method: form\.method/);
  });
  it("the Products tab proposes on a RAISED Canceled qty; the ASIN row's cancel proposes the newly canceled qty of every line", () => {
    expect(editor).toMatch(/if \(field === "qty_canceled"\) \{\s*const added = \(Number\(v\) \|\| 0\) - \(Number\(l\.qty_canceled\) \|\| 0\);\s*if \(added > 0\) setProposal/);
    expect(editor).toMatch(/<RefundProposalDialog po=\{po \?\? \{ id: poId \}\} lines=\{proposal\}/);
    expect(rows).toMatch(/qty: \(Number\(l\.qty_ordered\) \|\| 0\) - \(Number\(l\.qty_canceled\) \|\| 0\), price: l\.price \}\)\)\.filter\(\(l\) => l\.qty > 0\)/);
    expect(rows).toMatch(/<MarkCanceled a=\{a\} onChanged=\{onChanged\} po=\{po\} \/>/);
  });
  it("the Payments tab shows the status, Mark received on a due row, and an Add refund status select (due hides the date)", () => {
    expect(moneyTab).toMatch(/<th className=\{th\}>Status<\/th>/);
    expect(moneyTab).toMatch(/data-testid=\{`button-refund-mark-received-\$\{r\.id\}`\}/);
    expect(moneyTab).toMatch(/data-testid="select-add-refund-status"/);
    expect(moneyTab).toMatch(/refunded_at: newRefund\.status === "due" \? null : newRefund\.refunded_at/);
    expect(moneyTab).toMatch(/<MarkReceivedDialog refund=\{receiving\}/);
  });
  it("the POs page: Refunds any / due / none beside Open / Closed, sent as ?refunds= only when not any; the refund-due text under the total; the header money passed to the cancel entry points", () => {
    expect(page).toMatch(/data-testid="select-po-refunds"/);
    expect(page).toMatch(/if \(refundsFilter !== "any"\) params\.set\("refunds", refundsFilter\);/);
    expect(page).toMatch(/data-testid=\{`po-refund-due-\$\{po\.order_id\}`\}/);
    expect(page).toMatch(/<PoProductsTable poId=\{po\.id\} asins=\{asins\} onChanged=\{reload\} po=\{\{ id: po\.id, subtotal: po\.subtotal, discount: po\.discount, tax: po\.tax \}\} shipsTo=\{po\.ships_to\} \/>/);
    expect(page).toMatch(/<PoAsinRow key=\{a\.id\} a=\{a\} indent editable onChanged=\{load\} po=\{\{ id: po\.id/);
  });
  it("deep link: ?refunds=due&closed=all&from&to is read on mount; garbage falls back", () => {
    expect(readPoPageParams("?refunds=due&closed=all&from=2026-10-01&to=2026-10-31")).toEqual({ asin: "", refunds: "due", closed: "all", from: "2026-10-01", to: "2026-10-31" });
    expect(readPoPageParams("?asin=b0abc&refunds=maybe&closed=x&from=yesterday")).toEqual({ asin: "B0ABC", refunds: "any", closed: null, from: "", to: "" });
    expect(readPoPageParams("")).toEqual({ asin: "", refunds: "any", closed: null, from: "", to: "" });
  });
});
