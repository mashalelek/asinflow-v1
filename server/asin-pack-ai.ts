// The pack review's AI read (Maria 2026-11-06): for an ASIN with nothing from its PO lines or Velocity, one Haiku
// call with the main product image, the title and the catalog's attributes. It counts the physical retail packages
// the image shows; when the title's number and the image disagree ("Lot of 6", two bags of 3) it proposes the image
// count and says so. Where the ASIN has past PO lines, only the packs that reproduce their stored quantities are
// allowed. Never confirmed — a suggestion Maria reviews. Logged in po_prefill_log (kind pack_review).
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AI, aiAvailable, anthropicClient, estimateCost } from "./config/ai";
import { logPrefill } from "./po-prefill";
import type { QueryLike } from "./scheduler/types";
import type { AiPack, CatalogPack } from "./asin-pack-review";

const PackAiSchema = z.object({
  packages_in_image: z.number().int().nullable(),
  title_number: z.number().int().nullable(),
  sold_as: z.enum(["individual", "multi-pack", "bundle"]).nullable(),
  units_per_pack: z.number().int().nullable(),
  note: z.string(),
});

export const PACK_AI_SYSTEM = `You decide one Amazon listing's pack size for a reseller: how many manufactured retail packages a buyer receives in ONE unit of this ASIN.
- Count retail packages (a bag, a box, a bottle, a blister card as sold on a store shelf), never the items inside a package: a bag of 3 sachets is ONE package; "Lot of 6" sachets shown as 2 bags of 3 is 2 packages.
- Look at the main image first and count the packages it shows. Read the number the title states ("Pack of 2", "Lot of 6", "12 Count") into title_number.
- When the title's number and the image's package count differ, answer the image count and say so in note, e.g. "title says 6, image shows 2 packages".
- sold_as: "individual" for 1 package, "multi-pack" for 2 or more identical packages, "bundle" for different products sold together; units_per_pack = the package count (1 for individual). Use null for both when you cannot tell.
- When allowed packs are listed, answer one of them or null.
- note: one short sentence, the evidence.`;

export interface PackAiInput { asin: string; title: string | null; image_url: string | null; catalog: CatalogPack | null; allowed: number[] | null }
export type PackAiCall = (input: PackAiInput) => Promise<AiPack & { input_tokens: number; output_tokens: number }>;

export function packAiPrompt(i: PackAiInput): string {
  return [
    `ASIN ${i.asin}`,
    `Title: ${i.title ?? "(none)"}`,
    `Catalog item_package_quantity: ${i.catalog?.item_package_quantity ?? "—"}; number_of_items: ${i.catalog?.number_of_items ?? "—"} (number_of_items counts items, not packages)`,
    i.allowed ? `Allowed packs (they reproduce this ASIN's past order quantities): ${i.allowed.join(", ")}` : "",
    i.image_url ? "The main product image follows." : "No image.",
  ].filter(Boolean).join("\n");
}

const defaultCall: PackAiCall = async (i) => {
  const content: any[] = [{ type: "text", text: packAiPrompt(i) }];
  if (i.image_url) content.push({ type: "image", source: { type: "url", url: i.image_url } });
  const res = await anthropicClient().messages.parse({
    model: AI.model, max_tokens: 4000, output_config: { effort: AI.effort, format: zodOutputFormat(PackAiSchema) },
    system: PACK_AI_SYSTEM, messages: [{ role: "user", content }],
  });
  const p = PackAiSchema.safeParse(res.parsed_output);
  if (!p.success) throw new Error(`schema: ${p.error.message.slice(0, 200)}`);
  const allowedOk = (u: number) => !i.allowed || i.allowed.includes(u);
  const units = p.data.sold_as === "individual" ? 1 : p.data.units_per_pack;
  const ok = p.data.sold_as != null && units != null && units >= 1 && allowedOk(units);
  return { sold_as: ok ? p.data.sold_as : null, units_per_pack: ok ? units : null, note: p.data.note, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
};

/** One AI read, logged (cost estimate, tokens, the error if any). Null when AI is off or the call failed. */
export async function aiPackSuggestion(query: QueryLike, input: PackAiInput, deps: { call?: PackAiCall; available?: boolean } = {}): Promise<{ result: AiPack | null; cost: number }> {
  if (!(deps.available ?? aiAvailable())) return { result: null, cost: 0 };
  const t0 = Date.now();
  try {
    const r = await (deps.call ?? defaultCall)(input);
    const cost = estimateCost(r.input_tokens, r.output_tokens);
    await logPrefill(query, { user_id: null, kind: "pack_review", retailer: input.asin, input_chars: packAiPrompt(input).length, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_estimate: cost, duration_ms: Date.now() - t0, schema_ok: true, error: null });
    return { result: { sold_as: r.sold_as, units_per_pack: r.units_per_pack, note: r.note }, cost };
  } catch (e: any) {
    await logPrefill(query, { user_id: null, kind: "pack_review", retailer: input.asin, input_chars: packAiPrompt(input).length, input_tokens: 0, output_tokens: 0, cost_estimate: 0, duration_ms: Date.now() - t0, schema_ok: false, error: String(e?.message ?? e).slice(0, 300) });
    return { result: null, cost: 0 };
  }
}

/** Pure: the packs (units) up to 24 that reproduce every past PO row's quantities, or null when there is no history. */
export function allowedPackUnits(fits: (units: number) => boolean, hasHistory: boolean): number[] | null {
  if (!hasHistory) return null;
  const out: number[] = [];
  for (let u = 1; u <= 24; u++) if (fits(u)) out.push(u);
  return out;
}
