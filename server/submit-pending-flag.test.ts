import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// §18/§19 (2026-09-21): ACCEPTED writes the PENDING half of has_live_offer at
// submit time; the probe ladder is demoted to confirmer; a 'failed' verdict
// reverts — but only when no other SKU of the ASIN resolved 'live'.
vi.mock("./index", () => ({ log: () => {} }));
const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

describe("submit-time pending write", () => {
  const src = read("offer-add.ts");
  const accepted = src.slice(src.indexOf("§18 PENDING half"), src.indexOf("§18 PENDING half") + 1400);

  it("the ACCEPTED path writes has_live_offer = TRUE with offer_checked_at", () => {
    expect(accepted).toMatch(/UPDATE asins SET has_live_offer = TRUE, offer_checked_at = now\(\)/);
  });

  it("it does NOT write has_buyable_offer — a pending offer is not BUYABLE (§23)", () => {
    // Assignment, not mention: the block deliberately EXPLAINS the omission
    // in a comment, so match the SQL assignment rather than the word.
    expect(accepted).not.toMatch(/has_buyable_offer\s*=/);
    expect(src).not.toMatch(/SET[^`]*has_buyable_offer\s*=[^`]*WHERE asin = \$1`,\s*\n\s*\[input\.asin\]/);
  });

  it("the ledger row still starts 'pending' — it supplies the pending render style", () => {
    // §18 v2 (2026-10-07) widened this INSERT with the pricing-decision
    // columns, so the pin can't match the old closing paren. The INTENT is
    // unchanged and still asserted: verify_status is the 5th value and it is
    // the literal 'pending' — ACCEPTED is not live.
    const repo = read("listing-submissions-repo.ts");
    expect(repo).toMatch(/verify_status,?[\s\S]*VALUES \(\$1, \$2, \$3, \$4, 'pending'/);
  });
});

describe("'failed' verdict reverts the pending flag", () => {
  const sweep = read("listing-submissions-repo.ts");
  const block = sweep.slice(sweep.indexOf('if (status === "failed")'), sweep.indexOf('if (status === "failed")') + 700);

  it("reverts has_live_offer to FALSE on a definitive failure", () => {
    expect(block).toMatch(/UPDATE asins SET has_live_offer = FALSE/);
  });

  it("is guarded: never reverts when another SKU of the ASIN resolved 'live'", () => {
    // Failing ONE SKU of a multi-offer ASIN is not evidence the ASIN has no
    // live offer — the guard is what keeps the revert honest.
    expect(block).toMatch(/NOT EXISTS/);
    expect(block).toMatch(/verify_status = 'live'/);
  });

  it("manual verdicts still write nothing (weaker evidence than the API)", () => {
    const manual = sweep.slice(sweep.indexOf("Manual 'live' writes the flag"));
    expect(manual).toMatch(/'failed'\/'deleted' still write nothing/);
  });
});
