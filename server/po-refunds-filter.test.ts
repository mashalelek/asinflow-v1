import { describe, it, expect } from "vitest";
import { refundsFilterCond, REFUND_DUE_SQL } from "./po-queries";
import { REFUNDS_DUE_EXISTS_SQL, REFUNDS_DUE_PO_SQL } from "./supplier-claim-sql";

// Dashboard patch §2.4: GET /api/pos?refunds=due|none — on the claims since migration 101 (§3.7):
// due = an open claim with $ still owed (outcome unset or a refund / credit); none = no refund row and nothing owed.
describe("refundsFilterCond", () => {
  it("due = an open claim still owed; none = no refund row and nothing owed; anything else = no condition", () => {
    expect(refundsFilterCond("due")).toBe(REFUNDS_DUE_EXISTS_SQL("p"));
    expect(refundsFilterCond("none")).toBe(`(NOT EXISTS (SELECT 1 FROM po_line_refunds r WHERE r.po_id = p.id) AND NOT ${REFUNDS_DUE_EXISTS_SQL("p")})`);
    expect(refundsFilterCond("any")).toBeNull();
    expect(refundsFilterCond(undefined)).toBeNull();
    expect(refundsFilterCond(" DUE ")).toMatch(/supplier_claims c WHERE c\.po_id = p\.id AND \(c\.status = 'open'/);
    // the row's "refund due $X" = Σ remaining on the PO's open refund / credit claims; replacement / write-off / dismissed / suggested never count
    expect(REFUND_DUE_SQL).toBe(`${REFUNDS_DUE_PO_SQL("p")}::float8`);
    expect(REFUND_DUE_SQL).toMatch(/outcome IN \('refund_card', 'gift_card', 'store_credit'\)/);
    expect(REFUND_DUE_SQL).not.toMatch(/status = 'due'/);
  });
});
