// ships_to from prep cost (SPEC §26, Maria 2026-10-22).
import { describe, it, expect } from "vitest";
import { shipsToFromPrep, isPreVelocityDataError, readVelocityStartDate } from "./ships-to-backfill";
import { shipsToFromForm, emptyPoForm, emptyProduct } from "@shared/po-form";

describe("ships_to from prep cost only", () => {
  it("backfill: any ASIN row with prep > 0 → velocity; 0 / NULL / no rows → home", () => {
    expect(shipsToFromPrep(1)).toBe("velocity");
    expect(shipsToFromPrep(0.5)).toBe("velocity");
    expect(shipsToFromPrep(0)).toBe("home");
    expect(shipsToFromPrep(null)).toBe("home");
  });
  it("the date is only a sanity check: a pre-Velocity PO coming out velocity is a data error, not overridden", () => {
    expect(isPreVelocityDataError("2026-04-07", "2026-05-01", "velocity")).toBe(true);
    expect(isPreVelocityDataError("2026-04-07", "2026-05-01", "home")).toBe(false);
    expect(isPreVelocityDataError("2026-06-01", "2026-05-01", "velocity")).toBe(false);
  });
  it("New PO form default: prep > 0 on any product → velocity (the empty product's $1 prep); all $0 → home", () => {
    expect(shipsToFromForm(emptyPoForm("2026-10-22"))).toBe("velocity");
    expect(shipsToFromForm({ products: [{ ...emptyProduct(), prep_cost: "0" }, { ...emptyProduct(), prep_cost: "" }] })).toBe("home");
    expect(shipsToFromForm({ products: [{ ...emptyProduct(), prep_cost: "0" }, { ...emptyProduct(), prep_cost: "$1.00" }] })).toBe("velocity");
  });
  it("the cutoff is the tracking.velocity_start_date setting (YYYY-MM-DD); absent or malformed → null", async () => {
    const q = (value: any) => (async () => ({ rows: value === undefined ? [] : [{ value }] })) as any;
    expect(await readVelocityStartDate(q("2026-04-07"))).toBe("2026-04-07");
    expect(await readVelocityStartDate(q(undefined))).toBeNull();
    expect(await readVelocityStartDate(q("7/30/2026"))).toBeNull();
  });
});
