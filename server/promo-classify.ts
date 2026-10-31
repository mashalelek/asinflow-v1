// Promo classification (patch po-ai-prefill §8.4 as amended 2026-10-31):
// one Haiku batch call over DISTINCT promo texts → type (sale | coupon |
// rewards), a normalized description, amount or percent when stated, and
// a confidence. The SAME rules run on each new captured PO's promo lines
// (the capture's extraction prompt embeds PROMO_RULES) and on the col AK
// backfill (script/backfill-po-promos.ts). High confidence is applied; low
// confidence is stored with type NULL for Maria (the review CSV).
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AI, anthropicClient, estimateCost } from "./config/ai";

/** Maria's rules (2026-10-31), verbatim in both prompts. */
export const PROMO_RULES = `Classify each retailer promotion as exactly one type:
- "coupon": a code that gives a discount (e.g. "15% off with WELCOME15", "$20 off with THANKYOU428", "B1G1 with BB2604001", "10% off with autoship").
- "rewards": rewards, points, store credit or a balance earned and applied (e.g. "Rewards", "Rewards balance", "points").
- "sale": a site-wide or category sale, clearance, B1G1 / BOGO without a code, "N% off <category>" (e.g. "Sale", "60% off Clearance", "25% off flavors", "BOGO").
- michaels.com exception: Michaels runs site-wide 20–40% sales that require entering a displayed code — classify those as "sale", with the description normalized to "<N>% on regular priced items" (e.g. "30% off with COMEBACK47Z5" at michaels.com → sale, "30% on regular priced items").
Normalize the description: keep the discount and the code, drop filler. Give "amount" (dollars off) or "percent" when the text states one; leave both null otherwise. Several promos joined by "+" or "," stay ONE entry describing the combination; use the first one's type unless a rewards part is present, then "rewards" only when the whole promo is rewards.
Confidence "high" when the type follows directly from the rules; "low" when the text is ambiguous, empty of a discount, or a bare code.`;

export const PromoClassificationSchema = z.object({
  items: z.array(z.object({
    id: z.number().int(),
    type: z.enum(["sale", "coupon", "rewards"]),
    description: z.string(),
    amount: z.number().nullable(),
    percent: z.number().nullable(),
    confidence: z.enum(["high", "low"]),
  })),
});
export type PromoClassification = z.infer<typeof PromoClassificationSchema>["items"][number];

export interface PromoClassifyInput { id: number; text: string; supplier: string | null }
export interface PromoClassifyUsage { model: string; input_tokens: number; output_tokens: number; cost_estimate: number; duration_ms: number; schema_ok: boolean; input_chars: number }
export interface PromoClassifyDeps {
  /** Test seam: the model call. Returns the parsed object (or null on a schema failure) and usage. */
  call?: (system: string, user: string) => Promise<{ parsed: unknown; input_tokens: number; output_tokens: number }>;
}

export function promoUserMessage(items: readonly PromoClassifyInput[]): string {
  return `Classify these ${items.length} promotions. Return every id exactly once.\n` + items.map((i) => `${i.id}\t${i.supplier ?? "?"}\t${i.text.replace(/\s+/g, " ").trim()}`).join("\n");
}

async function defaultCall(system: string, user: string): Promise<{ parsed: unknown; input_tokens: number; output_tokens: number }> {
  const client = anthropicClient();
  const res = await client.messages.parse({
    model: AI.model, max_tokens: AI.maxTokens, output_config: { effort: AI.effort, format: zodOutputFormat(PromoClassificationSchema) },
    system, messages: [{ role: "user", content: user }],
  });
  return { parsed: res.parsed_output ?? null, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
}

/** One batch call; items the model did not return (or returned with an unknown id) come back absent — the caller treats them as low confidence. */
export async function classifyPromos(items: readonly PromoClassifyInput[], deps: PromoClassifyDeps = {}): Promise<{ results: Map<number, PromoClassification>; usage: PromoClassifyUsage }> {
  const system = `You classify retailer promotions for a purchase-order system. Input lines are "id<TAB>supplier<TAB>promo text".\n${PROMO_RULES}`;
  const user = promoUserMessage(items);
  const t0 = Date.now();
  const r = await (deps.call ?? defaultCall)(system, user);
  const parsed = PromoClassificationSchema.safeParse(r.parsed);
  const results = new Map<number, PromoClassification>();
  const ids = new Set(items.map((i) => i.id));
  if (parsed.success) for (const it of parsed.data.items) if (ids.has(it.id) && !results.has(it.id)) results.set(it.id, it);
  return {
    results,
    usage: { model: AI.model, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_estimate: estimateCost(r.input_tokens, r.output_tokens), duration_ms: Date.now() - t0, schema_ok: parsed.success, input_chars: system.length + user.length },
  };
}
