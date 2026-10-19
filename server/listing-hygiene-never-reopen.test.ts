// Listing hygiene rule 5 (SPEC §18, 2026-10-18): AF NEVER reopens a listing.
// No source file sends end_at null or removes it; the only end_at writer is
// the shared helper with the fixed past date (closedEndAt in offer-add.ts),
// used by the born-closed PUT and the component-22 close PATCH. Reopen stays a
// manual action in Seller Central.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { BORN_CLOSED_END_AT, closedEndAt, buildOfferOnlyPayload } from "./offer-add";
import { buildClosePatchBody } from "./listing-hygiene";

const ROOT = join(__dirname, "..");
const DIRS = ["server", "shared", "client/src", "script", "scripts"];
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e) && !/\.test(-fixtures)?\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
const stripComments = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const sources = DIRS.flatMap((d) => walk(join(ROOT, d))).map((p) => ({ file: relative(ROOT, p), code: stripComments(readFileSync(p, "utf8")) }));

describe("never-reopen guard", () => {
  it("scans a real source tree", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some((s) => s.file === "server/listing-hygiene.ts")).toBe(true);
  });

  it("every end_at KEY written anywhere is `end_at: closedEndAt()` — nothing else", () => {
    const bad: string[] = [];
    let writers = 0;
    for (const { file, code } of sources) {
      const re = /(?<![\w.])["']?end_at["']?\s*:/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        const rest = code.slice(m.index + m[0].length).trimStart();
        if (rest.startsWith("closedEndAt()")) writers++;
        else bad.push(`${file}: ${code.slice(m.index, m.index + 60).replace(/\s+/g, " ")}`);
      }
    }
    expect(bad).toEqual([]);
    expect(writers).toBe(2); // the born-closed PUT and the close PATCH
  });

  it("no source assigns, nulls or deletes end_at, and no patch removes purchasable_offer", () => {
    const bad: string[] = [];
    for (const { file, code } of sources) {
      if (/(?<![\w])end_at\s*=(?!=)/.test(code)) bad.push(`${file}: end_at assignment`);
      if (/delete\s+[^;\n]*\bend_at\b/.test(code)) bad.push(`${file}: delete end_at`);
      if (/end_at["']?\s*:\s*null/.test(code)) bad.push(`${file}: end_at: null`);
      if (/op\s*:\s*["'](replace|delete|remove)["']/.test(code)) bad.push(`${file}: op replace/delete`);
    }
    expect(bad).toEqual([]);
  });

  it("the helper is a fixed date in the past, and both writers send exactly it", () => {
    expect(Date.parse(BORN_CLOSED_END_AT)).toBeLessThan(Date.parse("2001-01-01"));
    expect(closedEndAt()).toEqual({ value: BORN_CLOSED_END_AT });
    const put = buildOfferOnlyPayload({ asin: "B000000001", productNumber: 1, price: 10, cogs: 5 } as any, "not_applicable");
    expect(put.attributes.purchasable_offer[0].end_at).toEqual({ value: BORN_CLOSED_END_AT });
    expect(buildClosePatchBody("PRODUCT").patches[0].value[0].end_at).toEqual({ value: BORN_CLOSED_END_AT });
  });

  it("BORN_CLOSED_END_AT is defined once", () => {
    const defs = sources.filter((s) => /BORN_CLOSED_END_AT\s*=/.test(s.code)).map((s) => s.file);
    expect(defs).toEqual(["server/offer-add.ts"]);
  });
});
