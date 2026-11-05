// Supplier verification (Maria 2026-11-05; SPEC §11 "Supplier verification"): Capture PO's "Verify supplier" button —
// on click only — makes ONE Claude call (server/config/ai.ts, Haiku-class) with the web search tool: is it a
// legitimate business, is it US-based, red flags in reviews (BBB, Trustpilot, Reddit, scam reports), the domain's age
// if findable. A short verdict (looks legit / mixed / red flags), 3–5 findings, the source links. Stored on the
// supplier record (migration 093: verified_at, verdict, findings, sources); later visits read the stored result with
// its date, and a check older than 6 months suggests a re-check. Logged in po_prefill_log as supplier_check with its
// cost (tokens + searches). An AI assessment, not a guarantee — the panel says so.
import { z } from "zod/v4";
import type { QueryLike } from "./scheduler/types";
import { AI, anthropicClient, estimateCost } from "./config/ai";
import { logPrefill } from "./po-prefill";
import { supplierKey } from "./supplier-defaults";

export const VERDICTS = ["looks_legit", "mixed", "red_flags"] as const;
const YNU = z.enum(["yes", "no", "unclear"]);
export const SupplierCheckSchema = z.object({
  verdict: z.enum(VERDICTS),
  legitimate: YNU,
  usBased: YNU,
  domainAge: z.string().max(120).nullable(),
  findings: z.array(z.string().max(300)).min(1).max(5),
  sources: z.array(z.object({ title: z.string().max(200).nullable().default(null), url: z.string().url().max(500) })).max(10).default([]),
});
export type SupplierCheck = z.infer<typeof SupplierCheckSchema>;

export const SUPPLIER_CHECK_SYSTEM = `You check whether an online store is safe to buy from, for a small US reseller about to place an order.
Use web search. Look for: whether it is a legitimate, established business; whether it is US-based (where it ships from, its address); red flags in reviews and complaints (BBB, Trustpilot, Reddit, scam-report sites); the domain's age or registration date if you can find it. Do not visit or summarize the store's own marketing claims as evidence by themselves.
Answer with ONLY one JSON object, no prose before or after:
{"verdict": "looks_legit" | "mixed" | "red_flags", "legitimate": "yes" | "no" | "unclear", "usBased": "yes" | "no" | "unclear", "domainAge": string or null (e.g. "registered 2009"), "findings": [3 to 5 short sentences, each one fact you found], "sources": [{"title": string, "url": string}] (the pages the findings rest on)}
"looks_legit": established, mostly positive reviews, no scam reports. "red_flags": scam reports, many unresolved complaints, a very new domain posing as an established brand, or no trace of a real business. Otherwise "mixed". If you found little, say so in the findings and use "mixed".`;

export const RECHECK_AFTER_DAYS = 183; // ~6 months
const n = (v: unknown) => (typeof v === "number" ? v : 0);

/** Pure: the first JSON object in the model's final text. */
export function parseCheckText(text: string): unknown {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}
/** Pure: the search results' pages (title + url), de-duplicated — the sources when the model named none. */
export function searchResultSources(content: ReadonlyArray<any>): Array<{ title: string | null; url: string }> {
  const out = new Map<string, { title: string | null; url: string }>();
  for (const b of content) if (b?.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r?.type === "web_search_result" && r.url && !out.has(r.url)) out.set(r.url, { title: r.title ?? null, url: r.url });
  return Array.from(out.values());
}

export interface CheckCall { text: string; content: any[]; input_tokens: number; output_tokens: number; web_searches: number }
export interface CheckDeps { call?: (system: string, user: string) => Promise<CheckCall> }
async function defaultCall(system: string, user: string): Promise<CheckCall> {
  const res = await anthropicClient().messages.create({
    model: AI.model, max_tokens: AI.maxTokens, output_config: { effort: AI.effort },
    tools: [{ type: AI.webSearch.type, name: "web_search", max_uses: AI.webSearch.maxUses }],
    system, messages: [{ role: "user", content: user }],
  });
  // Read blocks by type, never by position: the final answer is the text after the last search.
  const blocks = res.content as any[];
  const lastTool = blocks.map((b) => b.type).lastIndexOf("web_search_tool_result");
  const text = blocks.slice(lastTool + 1).filter((b) => b.type === "text").map((b) => b.text).join("") || blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, content: blocks, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, web_searches: n((res.usage as any).server_tool_use?.web_search_requests) };
}

export interface StoredCheck { supplier: string; verifiedAt: string | null; verdict: SupplierCheck["verdict"] | null; findings: { legitimate: string; usBased: string; domainAge: string | null; points: string[] } | null; sources: Array<{ title: string | null; url: string }>; recheckSuggested: boolean }

export async function storedCheck(query: QueryLike, supplier: string, now = new Date()): Promise<StoredCheck> {
  const key = supplierKey(supplier);
  const r = (await query(`SELECT verified_at, verdict, findings, sources FROM suppliers WHERE supplier = $1`, [key])).rows[0] as any;
  const at: Date | null = r?.verified_at ? new Date(r.verified_at) : null;
  return {
    supplier: key, verifiedAt: at ? at.toISOString() : null, verdict: r?.verdict ?? null, findings: r?.findings ?? null, sources: r?.sources ?? [],
    recheckSuggested: !!at && now.getTime() - at.getTime() > RECHECK_AFTER_DAYS * 86_400_000,
  };
}

/** The one call → stored on the supplier (a new supplier gets its row). A failed call stores nothing and says why. `store: false` (the script's dry run): the call and its log row only. */
export async function runSupplierCheck(query: QueryLike, supplier: string, userId: number | null, deps: CheckDeps = {}, now = new Date(), opts: { store?: boolean } = {}): Promise<{ ok: true; check: StoredCheck; cost: number } | { ok: false; message: string }> {
  const key = supplierKey(supplier);
  const user = `Store: ${key} (https://${key})`;
  const t0 = Date.now();
  let call: CheckCall | null = null, error: string | null = null, parsed: SupplierCheck | null = null;
  try {
    call = await (deps.call ?? defaultCall)(SUPPLIER_CHECK_SYSTEM, user);
    const p = SupplierCheckSchema.safeParse(parseCheckText(call.text));
    if (p.success) parsed = p.data; else error = "schema: " + p.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  } catch (e: any) { error = String(e?.message ?? e).slice(0, 500); }
  const cost = call ? estimateCost(call.input_tokens, call.output_tokens, call.web_searches) : 0;
  await logPrefill(query, { user_id: userId, kind: "supplier_check", retailer: key, input_chars: SUPPLIER_CHECK_SYSTEM.length + user.length, input_tokens: call?.input_tokens ?? 0, output_tokens: call?.output_tokens ?? 0, cost_estimate: cost, duration_ms: Date.now() - t0, schema_ok: !!parsed, error });
  if (!parsed) return { ok: false, message: `The check could not be read (${error}) — nothing was stored` };
  const sources = (parsed.sources.length ? parsed.sources : searchResultSources(call!.content)).slice(0, 8);
  const findings = { legitimate: parsed.legitimate, usBased: parsed.usBased, domainAge: parsed.domainAge, points: parsed.findings };
  if (opts.store === false) return { ok: true, check: { supplier: key, verifiedAt: null, verdict: parsed.verdict, findings, sources, recheckSuggested: false }, cost };
  await query(
    `INSERT INTO suppliers (supplier, verified_at, verdict, findings, sources) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     ON CONFLICT (supplier) DO UPDATE SET verified_at = EXCLUDED.verified_at, verdict = EXCLUDED.verdict, findings = EXCLUDED.findings, sources = EXCLUDED.sources, updated_at = now()`,
    [key, now.toISOString(), parsed.verdict, JSON.stringify(findings), JSON.stringify(sources)],
  );
  return { ok: true, check: await storedCheck(query, key, now), cost };
}
