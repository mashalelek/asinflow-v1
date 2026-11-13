import { describe, it, expect } from "vitest";
import { afEntrySeq, NEWEST_PO_ORDER } from "./po-entry-seq";

// Same-day tie-break (af-owned patch, Maria 2026-10-18): newest = order_date DESC, entry_seq DESC.

describe("entry_seq", () => {
  it("an AF-created PO sorts after every sheet PO of the same date; the ORDER BY is the shared definition", () => {
    expect(afEntrySeq(new Date("2026-10-18T00:00:00Z"))).toBeGreaterThan(1e12);
    expect(NEWEST_PO_ORDER).toBe("p.order_date DESC, p.entry_seq DESC NULLS LAST, p.created_at DESC");
  });
});
