import { describe, it, expect } from "vitest";
import { matchesCurrentSkuFormat } from "./sku-classifier";

describe("matchesCurrentSkuFormat", () => {
  it("matches canonical BRD-DEP-AS3-TTL-… prefix", () => {
    expect(matchesCurrentSkuFormat("AMG-BPC-X35-CLN-001")).toBe(true);
    expect(matchesCurrentSkuFormat("KAR-GRO-7Y8-NUT-042-A")).toBe(true);
    expect(matchesCurrentSkuFormat("PAT-OUT-123-HIP-007")).toBe(true);
  });

  it("rejects legacy AMG (2-char dept, no AS3)", () => {
    expect(matchesCurrentSkuFormat("AMG-BP-CLN-RRC-002-A")).toBe(false);
    expect(matchesCurrentSkuFormat("AMG-BP-EYS-EYE-013")).toBe(false);
  });

  it("rejects Amazon-generated patterns", () => {
    expect(matchesCurrentSkuFormat("amzn.gr.KP-C3D1-140L-28doDXpYRP0qVWPb-VG")).toBe(false);
    expect(matchesCurrentSkuFormat("00-5PDC-FO04")).toBe(false);
    expect(matchesCurrentSkuFormat("VZ-TS25-NZFO")).toBe(false);
  });

  it("rejects all-digit and malformed strings", () => {
    expect(matchesCurrentSkuFormat("1068914771")).toBe(false);
    expect(matchesCurrentSkuFormat("")).toBe(false);
    expect(matchesCurrentSkuFormat("FOO")).toBe(false);
    expect(matchesCurrentSkuFormat("FOO-BAR")).toBe(false);
  });
});
