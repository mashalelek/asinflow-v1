import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { dropSkipsKnownToVelocity } from "./velocity-reconcile";

// Upload to Velocity dialog fix (2026-10-17): skips come from the sheet
// alone, so rows Velocity already knows must not be listed as skipped.
const key = (o: string, a: string) => `${o.trim()} ${a.trim().toUpperCase()}`;

describe("dropSkipsKnownToVelocity", () => {
  const known = new Set([key("200015297647874", "B007K83C46")]);
  it("a no-live-SKU row whose (order, ASIN) is in Velocity is dropped; one that is not stays", () => {
    const skips: any[] = [
      { reason: "no_live_sku", orderNumber: "200015297647874", asin: "b007k83c46 ", itemName: "Kraft" },
      { reason: "no_live_sku", orderNumber: "999", asin: "B000000001", itemName: "not in Velocity" },
    ];
    expect(dropSkipsKnownToVelocity(skips, known).map((s) => s.orderNumber)).toEqual(["999"]);
  });
  it("every sheet-side reason is filtered (pack math, missing qty, bundle shape)", () => {
    for (const reason of ["invalid_pack_math", "missing_quantity", "unparseable_date", "bundle_incomplete", "bundle_component_bad_yield", "bundle_sets_disagree"]) {
      expect(dropSkipsKnownToVelocity([{ reason, orderNumber: "200015297647874", asin: "B007K83C46" } as any], known)).toEqual([]);
    }
  });
  it("bundle_unplaced_candidate is about Velocity state and always stays", () => {
    const s = [{ reason: "bundle_unplaced_candidate", orderNumber: "200015297647874", asin: "B007K83C46" } as any];
    expect(dropSkipsKnownToVelocity(s, known)).toEqual(s);
  });
  it("buildVelocityPlan applies it to the build's skips before returning", () => {
    const src = readFileSync(join(__dirname, "velocity-reconcile.ts"), "utf8");
    const at = src.indexOf("build.skips = dropSkipsKnownToVelocity(build.skips, matchedVelocityByKey);");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf('reason: "bundle_unplaced_candidate",'));
  });
});
