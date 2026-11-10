import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 101 (D17): every PO quantity column is stored in Individual units and READ through the views
// po_asin_expected / po_line_expected (server/po-expected.ts). This lint fails when server code outside the
// allowlist selects a quantity column of po_asins / po_line_items directly in SQL, or multiplies / divides by a
// pack size itself. The allowlist names the writers and the same-basis guards that legitimately touch the stored
// numbers, each with its reason — a new entry needs one too.
const QTY = /\b(qty|qty_ordered|qty_received|qty_shipped_supplier|qty_at_prep|qty_at_warehouse|qty_lost_damaged_us|qty_shipped_fba|qty_received_amazon|received_velocity|unreimbursed_loss_qty)\b/;
const ALLOWED_DIRECT_READS: Record<string, string> = {
  "extra-units.ts": "Extra units shipped: compares the row's shipped and ordered in the same stored basis, writes the cleared snapshot",
  "po-edit.ts": "the writers: recomputeAsinQty / fillAsinPackGaps / linesAtPack read stored values and convert them with productUnitsOf / storedQtyForAsinRow",
  "po-guards.ts": "Σ qty_at_prep for the delete message, labelled Individual units",
  "shipment-link.ts": "the overshoot guard compares units shipped with the row's stored ordered in the same basis",
  "shipment-sync-velocity.ts": "the writer of qty_at_prep / received_velocity / the shipment rows; capacityUnits reads qty with its basis",
  "tracking-match.ts": "fully shipped = Σ shipped by supplier ≥ Σ ordered, both stored in the same basis",
  "tracking-replacement-pair.ts": "received by Velocity ≥ ordered, both stored in the same basis",
};
const ALLOWED_PACK_ARITHMETIC: Record<string, string> = {
  "po-expected.ts": "the one place the conversions live",
  "shipment-match.ts": "capacityUnits: a legacy row's ASIN units × pack (reads qty_basis)",
};
const files = readdirSync(join(__dirname)).filter((n) => n.endsWith(".ts") && !n.includes(".test.") && !n.startsWith("__"));
const literals = (src: string) => src.match(/`[^`]*`/g) ?? [];

describe("PO quantities are read through the views (D17, migration 101)", () => {
  it("no SQL outside the allowlist selects a stored quantity column of po_asins / po_line_items", () => {
    const hits: Record<string, string[]> = {};
    for (const f of files) {
      for (const l of literals(readFileSync(join(__dirname, f), "utf8"))) {
        if (!/\bFROM\s+po_(asins|line_items)\b/.test(l) || /po_(asin|line)_expected/.test(l) || /^\s*`\s*(INSERT|UPDATE|DELETE)/i.test(l) || !QTY.test(l)) continue;
        (hits[f] ??= []).push(l.replace(/\s+/g, " ").slice(0, 120));
      }
    }
    const offenders = Object.keys(hits).filter((f) => !(f in ALLOWED_DIRECT_READS));
    expect(offenders, JSON.stringify(Object.fromEntries(offenders.map((f) => [f, hits[f]])), null, 1)).toEqual([]);
    // the allowlist stays honest: every entry still has a hit
    expect(Object.keys(ALLOWED_DIRECT_READS).filter((f) => !hits[f])).toEqual([]);
  });
  it("no server code outside the allowlist multiplies or divides by units_per_pack / retailer_units_per_product", () => {
    // "× pack" / "÷ pack" with the column named right after the operator (a prefix such as `pa.` or `Number(` allowed); the
    // yield ratio retailer ÷ asin_units_per_pack (po-queries LINE_YIELD_SQL, lineRatio inputs) is not a quantity conversion.
    const re = /(\*|\/)\s*\(?\s*(?:Number\()?(?:\w+\.)?(units_per_pack|retailer_units_per_product)\b/;
    const offenders: string[] = [];
    for (const f of files) {
      const code = readFileSync(join(__dirname, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (re.test(code) && !(f in ALLOWED_PACK_ARITHMETIC)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
