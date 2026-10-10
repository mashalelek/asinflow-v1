import { describe, it, expect } from "vitest";
import { proposeCode, resolveLegend, type QueryFn } from "./sku-legend";

describe("proposeCode", () => {
  it("returns first 3 letters of first significant word, uppercased", () => {
    expect(proposeCode("AminoGenesis")).toBe("AMI");
    expect(proposeCode("Patagonia")).toBe("PAT");
  });
  it("strips stopwords", () => {
    expect(proposeCode("The North Face")).toBe("NOR");
    expect(proposeCode("Of the Day")).toBe("DAY");
  });
  it("strips digit-prefixed tokens — '3M' loses to 'Company'", () => {
    // "3m" fails the letter-start filter and is dropped; "company" wins.
    // This is a flaw of the proposer for brands like "3M" — the user is
    // expected to override via the legend (which IS authoritative).
    expect(proposeCode("3M Company")).toBe("COM");
  });
  it("strips punctuation, treats as separator", () => {
    expect(proposeCode("Carter's")).toBe("CAR");
    expect(proposeCode("Sand + Fog")).toBe("SAN");
  });
  it("pads short words with X", () => {
    expect(proposeCode("AT")).toBe("ATX");
  });
  it("returns XXX on empty/junk", () => {
    expect(proposeCode("")).toBe("XXX");
    expect(proposeCode("   ")).toBe("XXX");
    expect(proposeCode("!!!")).toBe("XXX");
  });
});

describe("resolveLegend", () => {
  function fakeQuery(rows: any[]): QueryFn {
    return async () => ({ rows });
  }

  it("returns approved when an approved row exists", async () => {
    const q = fakeQuery([{ code: "AMG", status: "approved" }]);
    const r = await resolveLegend("brand", "AminoGenesis", q);
    expect(r).toEqual({ type: "brand", rawValue: "AminoGenesis", status: "approved", code: "AMG" });
  });

  it("returns proposed (with code AND derivedProposal) when row exists but unapproved", async () => {
    const q = fakeQuery([{ code: "BAM", status: "proposed" }]);
    const r = await resolveLegend("brand", "Bambu Lab", q);
    expect(r.status).toBe("proposed");
    expect(r.code).toBe("BAM");
    expect(r.derivedProposal).toBe("BAM");
  });

  it("returns not_in_legend (with derivedProposal) when no row exists", async () => {
    const q = fakeQuery([]);
    const r = await resolveLegend("brand", "Yankee Candle", q);
    expect(r.status).toBe("not_in_legend");
    expect(r.code).toBeNull();
    expect(r.derivedProposal).toBe("YAN");
  });

  it("handles empty/whitespace raw value as not_in_legend, with no LOOKUP", async () => {
    // The alias LOOKUP is still skipped for a blank value — there is nothing
    // to look up. The taken-codes SELECT does run (2026-10-07): the proposer
    // always proposes a FREE code, which means it must know what is taken on
    // every branch. Blank values never become legend entries either way
    // (§18 — they resolve to NUL and the approvals dialog drops them).
    const seen: string[] = [];
    const q: QueryFn = async (sql) => {
      seen.push(sql);
      return { rows: [] };
    };
    const r1 = await resolveLegend("dept", "", q);
    const r2 = await resolveLegend("dept", "   ", q);
    expect(r1.status).toBe("not_in_legend");
    expect(r2.status).toBe("not_in_legend");
    expect(seen.every((sql) => !/sku_legend_alias/.test(sql))).toBe(true);
  });

  it("normalization is handled by the SQL — resolver passes raw value through", async () => {
    // The unique index folds case/whitespace; we trust the SQL. The resolver
    // just doesn't pre-normalize, so "  bambu  lab  " reaches the DB as-is.
    let receivedParams: any[] = [];
    const q: QueryFn = async (_, params) => {
      receivedParams = params!;
      return { rows: [{ code: "BAM", status: "approved" }] };
    };
    await resolveLegend("brand", "  bambu  lab  ", q);
    expect(receivedParams[1]).toBe("  bambu  lab  ");
  });

  it("returns legendId when an approved row matches (for in-place approval / merge target)", async () => {
    const q = fakeQuery([{ legend_id: "uuid-amg", code: "AMG", status: "approved" }]);
    const r = await resolveLegend("brand", "AminoGenesis", q);
    expect(r.legendId).toBe("uuid-amg");
    expect(r.status).toBe("approved");
  });

  it("returns legendId on proposed rows too", async () => {
    const q = fakeQuery([{ legend_id: "uuid-bam", code: "BAM", status: "proposed" }]);
    const r = await resolveLegend("brand", "Bambu Lab", q);
    expect(r.legendId).toBe("uuid-bam");
    expect(r.status).toBe("proposed");
  });

  it("legendId is undefined when no row matches (merge target unknown)", async () => {
    const q = fakeQuery([]);
    const r = await resolveLegend("brand", "Brand-New-Brand", q);
    expect(r.legendId).toBeUndefined();
    expect(r.status).toBe("not_in_legend");
  });
});
