import { describe, expect, it } from "vitest";
import { gapsNote } from "./pack-cell";

describe("gapsNote (strict pack fill, 2026-11-06)", () => {
  it("counts the rows filled and names each row left because the pack does not reproduce it", () => {
    expect(gapsNote({ openRows: 1, closedRows: 2, closedSkipped: 0, lines: 3 })).toBe("filled 1 open and 2 closed PO rows");
    expect(gapsNote({ openRows: 0, closedRows: 0, closedSkipped: 1, lines: 0, openSkipped: 1, skipped: [
      { order_id: "200014306614860", closed: false, qty: 3, at_pack: 12, asin: "B07SDNN7RW" },
      { order_id: "200014742158460", closed: true, qty: 5, at_pack: null },
    ] })).toBe("not written — the pack doesn't reproduce the stored ASIN qty: B07SDNN7RW 200014306614860 (open): ASIN qty 3, this pack gives 12; 200014742158460: ASIN qty 5, this pack gives no whole number");
    expect(gapsNote({ openRows: 0, closedRows: 0, closedSkipped: 0, lines: 0 })).toBe("");
  });
});
