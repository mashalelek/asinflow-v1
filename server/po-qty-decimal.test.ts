import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { normalizeAsinRowQty, normalizeLineQty } from "./po-queries";

// Migration 062 (2026-10-18): every PO quantity is numeric(10,2).
describe("decimal PO quantities", () => {
  it("the migration converts the seven integer quantity columns and re-adds final_qty with the same expression", () => {
    const sql = readFileSync(new URL("../database/migrations/062_po_quantities_decimal.sql", import.meta.url), "utf8");
    for (const c of ["qty_ordered", "qty_received", "qty_returned", "qty_canceled"]) expect(sql).toMatch(new RegExp(`ALTER COLUMN ${c}\\s+TYPE numeric\\(10,2\\)`));
    expect(sql).toMatch(/ALTER COLUMN qty TYPE numeric\(10,2\)/);
    expect(sql).toMatch(/ALTER COLUMN unreimbursed_loss_qty TYPE numeric\(10,2\)/);
    expect(sql).toMatch(/ADD COLUMN final_qty numeric\(10,2\) GENERATED ALWAYS AS \(\(qty_ordered - qty_canceled\) - qty_returned\) STORED/);
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/);
  });
  it("the API returns quantities as numbers, NULL stays NULL", () => {
    expect(normalizeAsinRowQty({ qty: "2.50", unreimbursed_loss_qty: null, qty_individual: "5.00", open_claims: "1" })).toEqual({ qty: 2.5, unreimbursed_loss_qty: null, qty_individual: 5, open_claims: 1 });
    expect(normalizeLineQty({ qty_ordered: "13.50", qty_received: null, qty_returned: "0.00", qty_canceled: null, qty_expected: "13.50" })).toMatchObject({ qty_ordered: 13.5, qty_received: null, qty_returned: 0, qty_canceled: null, qty_expected: 13.5, qty_ordered_individual: null });
  });
});
