import { describe, it, expect } from "vitest";
import { sheetEntrySeqByKey, afEntrySeq, NEWEST_PO_ORDER } from "./po-entry-seq";
import { COL } from "./po-import-classify";

// Same-day tie-break (af-owned patch, Maria 2026-10-18): newest = order_date DESC, entry_seq DESC.
const r = (supplier: string, orderId: string) => { const c = Array(52).fill(""); c[COL.supplier] = supplier; c[COL.orderId] = orderId; return c; };

describe("entry_seq", () => {
  it("the sheet runs newest-first: a higher row gets a larger entry_seq; a PO's first row counts; tetley alias applies", () => {
    const m = sheetEntrySeqByKey([r("staples.com", "9929903576"), r("staples.com", "9929903576"), r("x.com", ""), r("staples.com", "9929903025"), r("shop.tetleyusa.com / WorldPantry.com", "7")]);
    expect(m.get("staples.com\u00009929903576")).toBe(5);
    expect(m.get("staples.com\u00009929903025")).toBe(2);
    expect(m.get("shop.tetleyusa.com\u00007")).toBe(1);
    expect(m.size).toBe(3);
  });
  it("an AF-created PO sorts after every sheet PO of the same date; the ORDER BY is the shared definition", () => {
    expect(afEntrySeq(new Date("2026-10-18T00:00:00Z"))).toBeGreaterThan(1e12);
    expect(NEWEST_PO_ORDER).toBe("p.order_date DESC, p.entry_seq DESC NULLS LAST, p.created_at DESC");
  });
});
