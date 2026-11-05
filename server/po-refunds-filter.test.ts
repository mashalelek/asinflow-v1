import { describe, it, expect } from "vitest";
import { refundsFilterCond, REFUND_DUE_SQL } from "./po-queries";
import { DEFECT_UNCOVERED_EXISTS_SQL } from "./po-defect-sql";

// Dashboard patch §2.4: GET /api/pos?refunds=due|none.
describe("refundsFilterCond", () => {
  it("due = a row still due; none = no refund row at all; anything else = no condition", () => {
    // Supplier defects (2026-11-05): an open defect's $ no refund row carries yet is due as well (and so not "none").
    expect(refundsFilterCond("due")).toBe(`(EXISTS (SELECT 1 FROM po_line_refunds r WHERE r.po_id = p.id AND r.status = 'due') OR ${DEFECT_UNCOVERED_EXISTS_SQL("p")})`);
    expect(refundsFilterCond("none")).toBe(`(NOT EXISTS (SELECT 1 FROM po_line_refunds r WHERE r.po_id = p.id) AND NOT ${DEFECT_UNCOVERED_EXISTS_SQL("p")})`);
    expect(refundsFilterCond("any")).toBeNull();
    expect(refundsFilterCond(undefined)).toBeNull();
    expect(refundsFilterCond(" DUE ")).toMatch(/status = 'due'/);
    expect(REFUND_DUE_SQL).toMatch(/status = 'due'/);
  });
});
