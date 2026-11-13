import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Wiring (Orders-sheet retirement commit 1, 2026-11-13): every PO write route runs the scoped cost sync after its
// transaction, through routes.ts's withCostSync (or the claim routes' shared tail). A new PO mutation route must be
// wrapped the same way — this test names the labels so a missing one is a failing test, not a stale ASIN.
const src = fs.readFileSync(path.join(__dirname, "routes.ts"), "utf8");

describe("Actual COGS on PO save — route wiring", () => {
  it("each PO write route is wrapped in withCostSync with its label", () => {
    for (const label of ['"create PO"', '"edit PO"', '"save PO form"', '"add line"', '"edit line"', '"remove line"', '"edit ASIN row"', '"delete PO"', '"cancel PO"', '"cancel ASIN row"', "`add ${plural}`", "`remove ${plural}`"]) {
      expect(src, label).toContain(`withCostSync(${label}`);
    }
    expect(src).toContain('syncAsinCostsAfterPoWrite(query, await poAsinList(query, String(po)).catch(() => []), "claim change")');
    // the sync runs AFTER the transaction: withCostSync wraps withPoTx, never the reverse
    expect(src).not.toMatch(/withPoTx\([^)]*withCostSync/);
    // the old body is gone from routes.ts; the module is the one implementation
    expect(src).not.toMatch(/async function runSheetsSync/);
    expect(src).toContain('const syncAsinCosts = (asinFilter?: ReadonlySet<string>) => syncAsinCostsFromPos(query, asinFilter);');
  });
  it("the stored source label is af_po everywhere the server writes or filters it", () => {
    for (const f of ["routes.ts", "asin-po-costs.ts", "sourcing-cost.ts", "sc-discovery.ts"]) {
      const s = fs.readFileSync(path.join(__dirname, f), "utf8");
      expect(s, f).not.toMatch(/['"]po_sheet['"]/);
    }
  });
});
