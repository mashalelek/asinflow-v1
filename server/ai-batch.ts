// One streamed structured-output call for a batch job (the promo backfill,
// the COGS review pass): thinking OFF — a rule lookup needs none, and with
// adaptive thinking on the 16K capture ceiling was spent thinking before the
// JSON finished (production dry run 2026-11-01: stop_reason max_tokens, 2K
// chars of text). The events are accumulated by hand so a truncated reply
// still comes back with its stop_reason and usage instead of an SDK parse
// exception; the caller treats stop_reason "max_tokens" as a failure.
// The client itself is built only in server/config/ai.ts.
import type { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AI, anthropicClient } from "./config/ai";

export interface BatchCallResult { parsed: unknown; input_tokens: number; output_tokens: number; stop_reason: string | null; text: string }

export async function structuredBatchCall(system: string, user: string, schema: z.ZodType): Promise<BatchCallResult> {
  const client = anthropicClient();
  const stream = await client.messages.create({
    model: AI.model, max_tokens: AI.batchMaxTokens, thinking: { type: "disabled" },
    output_config: { effort: AI.effort, format: zodOutputFormat(schema) },
    system, messages: [{ role: "user", content: user }], stream: true,
  });
  let text = "", input_tokens = 0, output_tokens = 0, stop_reason: string | null = null;
  for await (const ev of stream) {
    if (ev.type === "message_start") input_tokens = ev.message.usage.input_tokens;
    else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") text += ev.delta.text;
    else if (ev.type === "message_delta") { stop_reason = ev.delta.stop_reason ?? stop_reason; output_tokens = ev.usage.output_tokens; }
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { parsed, input_tokens, output_tokens, stop_reason, text };
}
