import { describe, it, expect } from "vitest";
import {
  isHazmatFromInboundCodes,
  isDangerousGoodFromAttributes,
  HAZMAT_INBOUND_CODES,
} from "./hazmat-classify";

describe("isHazmatFromInboundCodes (is_hazmat driver)", () => {
  it("0015 → hazmat true (CO2 cylinders, the proven anchor)", () => {
    expect(isHazmatFromInboundCodes(["FBA_INB_0015"])).toBe(true);
  });

  it("0015 alongside out-of-set 0050 → still true", () => {
    expect(isHazmatFromInboundCodes(["FBA_INB_0015", "FBA_INB_0050"])).toBe(true);
  });

  it("0014 → NOT hazmat (butane / DG-only — the range would have false-flagged this)", () => {
    expect(isHazmatFromInboundCodes(["FBA_INB_0014"])).toBe(false);
  });

  it("0004 → NOT hazmat", () => {
    expect(isHazmatFromInboundCodes(["FBA_INB_0004"])).toBe(false);
  });

  it("0050 → NOT hazmat (shared restriction, not a hazmat signal)", () => {
    expect(isHazmatFromInboundCodes(["FBA_INB_0050"])).toBe(false);
  });

  it("butane's full code set [0014,0004,0050] → NOT hazmat", () => {
    expect(isHazmatFromInboundCodes(["FBA_INB_0014", "FBA_INB_0004", "FBA_INB_0050"])).toBe(false);
  });

  it("empty list (eligible / no restrictions) → NOT hazmat", () => {
    expect(isHazmatFromInboundCodes([])).toBe(false);
  });

  it("guards against range-widening: the whole 0007–0016 range is NOT the rule", () => {
    // Only 0015 is in the set; 0007..0014 and 0016 must NOT match.
    for (let n = 7; n <= 16; n++) {
      const code = `FBA_INB_${String(n).padStart(4, "0")}`;
      expect(HAZMAT_INBOUND_CODES.has(code)).toBe(n === 15);
    }
  });
});

describe("isDangerousGoodFromAttributes (is_dangerous_good driver)", () => {
  it("attributes.hazmat present/non-empty → DG true", () => {
    const attrs = {
      hazmat: [
        { aspect: "united_nations_regulatory_id", value: "UN1013" },
        { aspect: "transportation_regulatory_class", value: "2.2" },
      ],
    };
    expect(isDangerousGoodFromAttributes(attrs)).toBe(true);
  });

  it("butane's class-\"0\", no-UN hazmat row → DG true (presence, NOT value validation)", () => {
    const attrs = { hazmat: [{ aspect: "transportation_regulatory_class", value: "0" }] };
    expect(isDangerousGoodFromAttributes(attrs)).toBe(true);
  });

  it("no hazmat key (grocery: salt/chicken) → DG false", () => {
    expect(isDangerousGoodFromAttributes({ item_name: [{ value: "Morton Salt" }] })).toBe(false);
  });

  it("empty hazmat array → DG false", () => {
    expect(isDangerousGoodFromAttributes({ hazmat: [] })).toBe(false);
  });

  it("null / missing attributes → DG false (does not throw)", () => {
    expect(isDangerousGoodFromAttributes(null)).toBe(false);
    expect(isDangerousGoodFromAttributes(undefined)).toBe(false);
    expect(isDangerousGoodFromAttributes({})).toBe(false);
  });
});
