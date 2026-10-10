import { describe, it, expect } from "vitest";
import { proposeBrandCode, proposeCode, NO_VALUE_CODE } from "./sku-legend";

// §18 Brand/Department Legend — collision walk (2026-10-07).
//
// Before: proposeCode() derived a 3-char code and handed it up even when the
// legend already held it. Approval then failed inline with "already in legend
// with code X" and the operator had to invent a free code by hand.
//
// proposeBrandCode does that walk itself and can only return a FREE code.
// Brand and dept codes are ONE namespace; NUL is reserved and always taken.
// Uniqueness is the only requirement — mnemonic quality is not, so a tier-5
// answer like "AM7" is a correct result, not a degradation.

describe("tier 1 — today's derivation, when it is free", () => {
  it("returns the plain derived code and stops there", () => {
    expect(proposeBrandCode("AminoGenesis", [])).toBe("AMI");
    expect(proposeCode("AminoGenesis")).toBe("AMI"); // same answer, no walk needed
  });

  it("keeps proposeCode's stopword and leading-digit-token handling", () => {
    expect(proposeBrandCode("The North Face", [])).toBe("NOR"); // "the" stripped
    // "3m" does not start with a letter, so the whole token is dropped and
    // the next word supplies the code. (The source comment used to claim
    // "MCO" here; the filter has always been "starts with a letter", not
    // "pure digits", so the real answer is COM — corrected 2026-10-07.)
    expect(proposeBrandCode("3M Company", [])).toBe("COM");
  });

  it("pads a short name out to 3 chars", () => {
    expect(proposeBrandCode("Go", [])).toBe("GOX");
  });
});

describe("tier 2 — first 2 letters + the 4th, 5th, … letter", () => {
  it("tier 1 taken → first2 + 4th letter", () => {
    // AMI taken → A,M + L[3] ('N' of amiNoGenesis) → AMN
    expect(proposeBrandCode("AminoGenesis", ["AMI"])).toBe("AMN");
  });

  it("walks along the name one letter at a time", () => {
    expect(proposeBrandCode("AminoGenesis", ["AMI", "AMN"])).toBe("AMO");
    expect(proposeBrandCode("AminoGenesis", ["AMI", "AMN", "AMO"])).toBe("AMG");
    expect(proposeBrandCode("AminoGenesis", ["AMI", "AMN", "AMO", "AMG"])).toBe("AME");
  });

  it("letters are the name's alphanumerics — punctuation and spaces skipped", () => {
    // Letters = DRBRONNERS. Tier 1 is DRX ("dr" padded — a 2-letter first
    // word). With DRX taken, tier 2 is first2 + L[3] = DR + 'R' → DRR.
    expect(proposeCode("Dr. Bronner's")).toBe("DRX");
    expect(proposeBrandCode("Dr. Bronner's", ["DRX"])).toBe("DRR");
  });
});

describe("tier 3 — initials of the first three words", () => {
  it("fires for a 3+ word name once tiers 1–2 are exhausted", () => {
    // "Red Hot Chili" → tier 1 "RED"; tier 2 walks R,E + H,O,T,C,H,I,L,I.
    // Take all of those and the initials RHC must come back.
    const taken = ["RED", "REH", "REO", "RET", "REC", "REI", "REL"];
    expect(proposeBrandCode("Red Hot Chili", taken)).toBe("RHC");
  });

  it("is skipped for a 2-word name (no third initial to take)", () => {
    const code = proposeBrandCode("Red Hot", ["RED", "REH", "REO", "RET"]);
    expect(code).not.toBe("RHX");
    expect(code).toMatch(/^[A-Z0-9]{3}$/);
  });
});

describe("tier 4 — the 3rd letter, then every positional triple", () => {
  it("picks up the 3rd letter that tier 2 deliberately skipped", () => {
    // "Kara" → letters KARA. tier 1 KAR; tier 2 first2+L[3] = KAA.
    // tier 4a then offers K,A + L[2] = KAR — already tried — so it moves to
    // the positional triples. Whatever it returns must be free and well-formed.
    const code = proposeBrandCode("Kara", ["KAR", "KAA"]);
    expect(code).toMatch(/^[A-Z0-9]{3}$/);
    expect(["KAR", "KAA"]).not.toContain(code);
  });

  it("reaches a triple that no earlier tier could produce", () => {
    // "Zebra" → letters ZEBRA. Block tier 1 (ZEB) and all of tier 2
    // (ZER, ZEA) plus tier 4a (ZEB again). The first free positional triple
    // in ascending index order is ZBR (indices 0,2,3).
    expect(proposeBrandCode("Zebra", ["ZEB", "ZER", "ZEA"])).toBe("ZBR");
  });
});

describe("tier 5 — digit tails once the name's letters are exhausted", () => {
  // Every code the name's own letters can produce, for a 3-letter name.
  const allLetterCodesFor = (name: string): string[] => {
    const L = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const out = new Set<string>([proposeCode(name)]);
    for (let i = 3; i < L.length; i++) out.add(L.slice(0, 2) + L[i]);
    for (let i = 2; i < L.length; i++) out.add(L[0] + L[1] + L[i]);
    for (let i = 0; i < L.length; i++)
      for (let j = i + 1; j < L.length; j++)
        for (let k = j + 1; k < L.length; k++) out.add(L[i] + L[j] + L[k]);
    return Array.from(out);
  };

  it("every positional combination taken → first 2 letters + digit 2", () => {
    expect(proposeBrandCode("Amino", allLetterCodesFor("Amino"))).toBe("AM2");
  });

  it("walks the digit 2–9 range in order", () => {
    const taken = allLetterCodesFor("Amino").concat(["AM2", "AM3", "AM4"]);
    expect(proposeBrandCode("Amino", taken)).toBe("AM5");
  });

  it("digits 2–9 exhausted → first letter + two digits", () => {
    const taken = allLetterCodesFor("Amino")
      .concat(["AM2", "AM3", "AM4", "AM5", "AM6", "AM7", "AM8", "AM9"]);
    const code = proposeBrandCode("Amino", taken);
    expect(code).toBe("A00");
  });

  it("never offers digit 0 or 1 as the single-digit tail", () => {
    // 0/1 are excluded by spec (O/I confusion). AM0 and AM1 must not appear
    // even though they are free.
    const code = proposeBrandCode("Amino", allLetterCodesFor("Amino"));
    expect(code).not.toBe("AM0");
    expect(code).not.toBe("AM1");
  });

  it("throws rather than return a taken code when even the digits run out", () => {
    const taken = allLetterCodesFor("Amino").concat(["AM2", "AM3", "AM4", "AM5", "AM6", "AM7", "AM8", "AM9"]);
    for (let a = 0; a <= 9; a++) for (let b = 0; b <= 9; b++) taken.push(`A${a}${b}`);
    expect(() => proposeBrandCode("Amino", taken)).toThrow(/exhausted every tier/);
  });
});

describe("the contract: never taken, never reserved, deterministic", () => {
  it("never returns a code in the taken set, at any tier", () => {
    const names = ["AminoGenesis", "The North Face", "Red Hot Chili", "Zebra", "3M Company", "Go"];
    for (const name of names) {
      const taken: string[] = [];
      // Repeatedly propose and then declare the answer taken. Every answer
      // must be new, well-formed, and absent from everything before it.
      for (let i = 0; i < 25; i++) {
        const code = proposeBrandCode(name, taken);
        expect(code, `${name} round ${i}`).toMatch(/^[A-Z0-9]{3}$/);
        expect(taken, `${name} round ${i}`).not.toContain(code);
        taken.push(code);
      }
    }
  });

  it("never returns the reserved NUL, even when NUL is the natural derivation", () => {
    // "Null Industries" derives NUL at tier 1. Reserved → must walk past it
    // with an empty taken set.
    expect(proposeCode("Null Industries")).toBe(NO_VALUE_CODE);
    expect(proposeBrandCode("Null Industries", [])).not.toBe(NO_VALUE_CODE);
  });

  it("treats the taken set case-insensitively", () => {
    expect(proposeBrandCode("AminoGenesis", ["ami"])).toBe("AMN");
  });

  it("accepts a Set as well as an array", () => {
    expect(proposeBrandCode("AminoGenesis", new Set(["AMI"]))).toBe("AMN");
  });

  it("deterministic — same name + same taken set always yields the same code", () => {
    const taken = ["AMI", "AMN", "AMO"];
    const first = proposeBrandCode("AminoGenesis", taken);
    for (let i = 0; i < 5; i++) {
      expect(proposeBrandCode("AminoGenesis", taken)).toBe(first);
    }
    // Set vs array ordering must not change the answer either.
    expect(proposeBrandCode("AminoGenesis", new Set(taken.slice().reverse()))).toBe(first);
  });

  it("does not mutate the caller's taken set", () => {
    const taken = ["AMI"];
    proposeBrandCode("AminoGenesis", taken);
    expect(taken).toEqual(["AMI"]);
  });
});
