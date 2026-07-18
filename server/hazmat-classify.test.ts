import { describe, it, expect } from "vitest";
import {
  isHazmatFromInboundCodes,
  isDangerousGoodFromAttributes,
  dgHzRegulationFromAttributes,
  resolveDgHzRegulation,
  DG_HZ_REGULATION_ENUM,
  HAZMAT_INBOUND_CODES,
} from "./hazmat-classify";

// Fixtures = the four real ASINs vs Amazon's SC dangerous-goods ground truth.
// `flag` = the presence-derivation's is_dangerous_good (which over-flags the two
// non-DG items); `catalogValue` = attributes.supplier_declared_dg_hz_regulation.
describe("resolveDgHzRegulation (supplier_declared_dg_hz_regulation pass-through)", () => {
  it("B00HX6N2WW (genuine DG) → passes through catalog 'storage'", () => {
    expect(resolveDgHzRegulation("storage", true, DG_HZ_REGULATION_ENUM)).toEqual({ kind: "value", value: "storage" });
  });

  it("B0BLHGNP54 Jetboil (genuine DG) → passes through catalog 'transportation'", () => {
    expect(resolveDgHzRegulation("transportation", true, DG_HZ_REGULATION_ENUM)).toEqual({ kind: "value", value: "transportation" });
  });

  it("B07H3B443Q / B001DKV5H8 (presence false-positive, flag TRUE) → self-heals to catalog 'not_applicable'", () => {
    expect(resolveDgHzRegulation("not_applicable", true, DG_HZ_REGULATION_ENUM)).toEqual({ kind: "value", value: "not_applicable" });
  });

  it("absent catalog value + flag TRUE → fail-closed unresolved (no guess)", () => {
    expect(resolveDgHzRegulation(null, true, DG_HZ_REGULATION_ENUM)).toEqual({ kind: "unresolved" });
  });

  it("absent catalog value + flag FALSE → not_applicable (proven-safe non-DG)", () => {
    expect(resolveDgHzRegulation(null, false, DG_HZ_REGULATION_ENUM)).toEqual({ kind: "value", value: "not_applicable" });
  });

  it("enum-invalid catalog value (e.g. legacy consumer_commodity) + flag TRUE → unresolved", () => {
    expect(resolveDgHzRegulation("consumer_commodity", true, DG_HZ_REGULATION_ENUM)).toEqual({ kind: "unresolved" });
  });

  it("enum-invalid catalog value + flag FALSE → not_applicable", () => {
    expect(resolveDgHzRegulation("consumer_commodity", false, DG_HZ_REGULATION_ENUM)).toEqual({ kind: "value", value: "not_applicable" });
  });
});

describe("dgHzRegulationFromAttributes (US marketplace extraction)", () => {
  const US = "ATVPDKIKX0DER";
  it("extracts the US marketplace value", () => {
    expect(dgHzRegulationFromAttributes({ supplier_declared_dg_hz_regulation: [{ value: "transportation", marketplace_id: US }] })).toBe("transportation");
  });
  it("ignores non-US entries → null when no US entry", () => {
    expect(dgHzRegulationFromAttributes({ supplier_declared_dg_hz_regulation: [{ value: "storage", marketplace_id: "A1F83G8C2ARO7P" }] })).toBeNull();
  });
  it("absent attribute → null (does not throw)", () => {
    expect(dgHzRegulationFromAttributes({})).toBeNull();
    expect(dgHzRegulationFromAttributes(null)).toBeNull();
  });
});

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
