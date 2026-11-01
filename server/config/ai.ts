// AI configuration (patch docs/claude_spec-patch-po-ai-prefill.md §1, §5;
// CLAUDE.md "AI config"). ONE place for the model id, token ceiling, effort
// and the price used for the per-call cost estimate in po_prefill_log.
// `ANTHROPIC_API_KEY` comes from the environment (a Render env var); without
// it every AI feature is off and says so (never a silent fallback).
//
// Haiku-class by decision (Maria 2026-10-30): one call per capture, and the
// promo backfill is one batch call. Claude Haiku 5.5: adaptive thinking is
// on by default (omit `thinking`); effort low keeps an extraction cheap;
// read content blocks by type, never by position.
import Anthropic from "@anthropic-ai/sdk";

export const AI = {
  model: "claude-haiku-5-5",
  maxTokens: 16000,
  /** The promo backfill's one batch call (server/promo-classify.ts): ~500
   *  distinct texts ≈ 20K output tokens of JSON, so a higher ceiling, with
   *  thinking off — the 16K ceiling was spent on thinking before the JSON
   *  finished (production dry run 2026-11-01, stop_reason max_tokens). */
  batchMaxTokens: 64000,
  effort: "low" as const,
  /** $ per million tokens — the ≤ 100K-token rate card (prompts are far smaller). */
  pricePerMTok: { input: 0.1, output: 0.5 },
} as const;

export function aiAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "";
}
export const AI_OFF_MESSAGE = "AI prefill is off: ANTHROPIC_API_KEY is not configured";

/** $ for one call, 5 decimals. */
export function estimateCost(inputTokens: number, outputTokens: number): number {
  return Math.round(((inputTokens * AI.pricePerMTok.input + outputTokens * AI.pricePerMTok.output) / 1_000_000) * 1e5) / 1e5;
}

let client: Anthropic | null = null;
/** Lazy singleton; throws when the key is missing (callers check aiAvailable first). */
export function anthropicClient(): Anthropic {
  if (!aiAvailable()) throw new Error(AI_OFF_MESSAGE);
  if (!client) client = new Anthropic();
  return client;
}
