import { describe, it, expect } from "vitest";
import { refundsFilterCond, REFUND_DUE_SQL } from "./po-queries";

// Dashboard patch §2.4: GET /api/pos?refunds=due|none.
describe("refundsFilterCond", () => {
  it("due = a row still due; none = no refund row at all; anything else = no condition", () => {
    expect(refundsFilterCond("due")).toBe(`EXISTS (SELECT 1 FROM po_line_refunds r WHERE r.po_id = p.id AND r.status = 'due')`);
    expect(refundsFilterCond("none")).toBe(`NOT EXISTS (SELECT 1 FROM po_line_refunds r WHERE r.po_id = p.id)`);
    expect(refundsFilterCond("any")).toBeNull();
    expect(refundsFilterCond(undefined)).toBeNull();
    expect(refundsFilterCond(" DUE ")).toMatch(/status = 'due'/);
    expect(REFUND_DUE_SQL).toMatch(/status = 'due'/);
  });
});
