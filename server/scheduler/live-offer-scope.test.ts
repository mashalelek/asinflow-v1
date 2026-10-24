// Component 16 probes the dead ASINs whose SKUs have an SC listing on a
// full-scope pass (listing hygiene, Maria 2026-10-24) — and only those.
import { describe, it, expect, vi } from "vitest";

const probed: string[][] = [];
vi.mock("../full-scope-pass", () => ({
  runFullScopePass: vi.fn(async (o: any) => { probed.push(Array.from(o.asinFilter)); return { phaseA: { asins: 0, live: 0, noOffer: 0, transientSkipped: 0, flips: [], repoints: [], discoveries: [] }, phaseB: { asins: 0, transientSkipped: 0, discovered: [], noListing: 0 }, outcomes: {} }; }),
}));
import { COMPONENTS } from "./components";
const liveOffer = COMPONENTS.find((c) => c.n === 16)!;

const ctx = (scopeAsins: string[] | null) => ({
  job: { id: 1, scope_asins: scopeAsins }, asins: ["B000000001"], scopeAsins: ["B000000001"], cache: new Map(), checkpoint: async () => {},
  query: async (sql: string) => sql.includes("a.status = 'dead'") ? { rows: [{ asin: "B0DEAD0001" }] } : { rows: [] },
}) as any;

describe("component 16 scope", () => {
  it("full-scope pass: the scheduled ASINs plus the dead ASINs with an SC listing", async () => {
    probed.length = 0;
    const r = await liveOffer.run(ctx(null));
    expect(probed.flat()).toEqual(["B000000001", "B0DEAD0001"]);
    expect(r.counts.dead_with_listing).toBe(1);
  });
  it("a subset job probes only its own ASINs", async () => {
    probed.length = 0;
    await liveOffer.run(ctx(["B000000001"]));
    expect(probed.flat()).toEqual(["B000000001"]);
  });
});
