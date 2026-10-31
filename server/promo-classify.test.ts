import { describe, it, expect } from "vitest";
import { classifyPromos, promoUserMessage, PROMO_RULES } from "./promo-classify";

// po-ai-prefill §8.4 as amended 2026-10-31: one batch call, Maria's rules in the prompt, ids matched back, unknown ids dropped.
describe("classifyPromos", () => {
  it("prompts with the rules (michaels exception included) and one line per distinct text; maps results by id; drops unknown ids and a schema failure", async () => {
    expect(PROMO_RULES).toMatch(/michaels\.com exception/);
    const items = [{ id: 1, text: "30% off with COMEBACK47Z5", supplier: "michaels.com" }, { id: 2, text: "Rewards", supplier: null }];
    expect(promoUserMessage(items)).toBe("Classify these 2 promotions. Return every id exactly once.\n1\tmichaels.com\t30% off with COMEBACK47Z5\n2\t?\tRewards");
    let seen: { system: string; user: string } | null = null;
    const r = await classifyPromos(items, { call: async (system, user) => { seen = { system, user }; return { parsed: { items: [
      { id: 1, type: "sale", description: "30% on regular priced items", amount: null, percent: 30, confidence: "high" },
      { id: 2, type: "rewards", description: "Rewards", amount: null, percent: null, confidence: "high" },
      { id: 9, type: "coupon", description: "ghost", amount: null, percent: null, confidence: "high" },
    ] }, input_tokens: 500, output_tokens: 120 }; } });
    expect(seen!.system).toContain(PROMO_RULES);
    expect(Array.from(r.results.keys())).toEqual([1, 2]);
    expect(r.results.get(1)).toMatchObject({ type: "sale", description: "30% on regular priced items", percent: 30 });
    expect(r.usage).toMatchObject({ model: "claude-haiku-5-5", schema_ok: true, input_tokens: 500, output_tokens: 120, cost_estimate: 0.00011 });
    const bad = await classifyPromos(items, { call: async () => ({ parsed: { items: [{ id: 1, type: "discount" }] }, input_tokens: 1, output_tokens: 1 }) });
    expect(bad.results.size).toBe(0);
    expect(bad.usage.schema_ok).toBe(false);
  });
});
