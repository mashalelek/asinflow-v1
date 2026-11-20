import { describe, it, expect } from "vitest";
import { SETTINGS_KEY_MAP, settingsFromRows, settingsToRows } from "./settings-keys";
import { settingsSchema } from "./schema";

describe("settings key map (Finances API patch commit 1)", () => {
  it("names a DB key for every Settings field, each distinct", () => {
    const fields = Object.keys(settingsSchema.shape);
    expect(Object.keys(SETTINGS_KEY_MAP).sort()).toEqual(fields.sort());
    expect(new Set(Object.values(SETTINGS_KEY_MAP)).size).toBe(fields.length);
  });
  it("reads jsonb numbers and text, keeps the schema default for a missing or bad key", () => {
    const s = settingsFromRows([
      { key: "prep_cost", value: 1.2 }, { key: "hazmat_prep_surcharge", value: "1" },
      { key: "min_roi", value: "abc" }, { key: "additional_fees", value: -3 }, { key: "po_payment_methods", value: ["x"] },
    ]);
    expect(s.prepCost).toBe(1.2); expect(s.hazmatPrepSurcharge).toBe(1);
    expect(s.minRoiThreshold).toBe(15); expect(s.storageFee).toBe(0); expect(s.maxCogsMinRoiPct).toBe(20);
  });
  it("round-trips a full Settings through rows", () => {
    const full = settingsSchema.parse({ prepCost: 1.3, hazmatPrepSurcharge: 1, inboundShippingCost: 0.7, minProfitUnitThreshold: 2.5 });
    const rows = settingsToRows(full);
    expect(rows.length).toBe(Object.keys(SETTINGS_KEY_MAP).length);
    expect(settingsFromRows(rows)).toEqual(full);
  });
  it("drops unknown fields and negative / non-finite values from a patch", () => {
    expect(settingsToRows({ prepCost: 1.3, bogus: 9, minRoiThreshold: -1, storageFee: "x" } as any)).toEqual([{ key: "prep_cost", value: 1.3 }]);
  });
});
