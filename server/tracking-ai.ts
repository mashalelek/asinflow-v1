// AI fallback for PO tracking (SPEC §26; patch po-tracking-velocity §4 D3).
// Built 2026-11-04 (Maria — the 43 ai_disabled placeholders): a shipped-type
// email the regex and the tracking-link extractors cannot read is queued as
// an "email:<domain>:<order>" placeholder (tracking-ingest.ts). When that
// placeholder's order # names exactly ONE AF PO (matchRow, the matcher's own
// rule), one Haiku call reads the email: the carrier + tracking numbers it
// prints, or the URL of its "track your order" link. Nothing the model says
// is trusted as is — a number counts only when it is printed in the email
// (alnum-compared), and a link only when it is one of the email's own links,
// followed through the generic redirect follow (tracking-links.ts: HEAD
// redirects to a carrier URL, the body never read — no retailer page is
// scraped). Found → real rows (source 'ai') replace the placeholder and the
// matcher attaches them; nothing found → match_reason 'ai_no_tracking', never
// asked again. Capped per pass; a dry run never calls the model (it counts
// the emails it would ask about). Every call is logged in po_prefill_log
// (kind 'tracking_fallback'). The client lives in server/config/ai.ts only.
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { gmail_v1 } from "googleapis";
import { AI, aiAvailable, anthropicClient, estimateCost } from "./config/ai";
import { logPrefill } from "./po-prefill";
import { getMessage, type GmailMessage } from "./gmail-client";
import { extractGenericLinkTracking, type FetchLike } from "./tracking-links";
import { stripZipPrefix, type Carrier } from "./tracking-parse";
import type { QueryLike } from "./scheduler/types";

export const AI_DISABLED_REASON = "ai_disabled";
/** A placeholder the AI read and found no number in — kept in the queue, never asked again. */
export const AI_NO_TRACKING_REASON = "ai_no_tracking";
export const TRACKING_AI_MAX_CALLS = 25;

/** True when a key is configured (server/config/ai.ts). */
export function aiFallbackAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return aiAvailable(env);
}

const CARRIERS = ["UPS", "FEDEX", "USPS", "DHL", "AMAZON", "ONTRAC", "LASERSHIP", "OTHER"] as const;
const AiTrackingSchema = z.object({
  shipments: z.array(z.object({ carrier: z.enum(CARRIERS), tracking_number: z.string() })),
  track_link: z.string().nullable(),
});
export const AI_TRACKING_SYSTEM = `You read one shipping email a retailer sent about an order. Return:
- shipments: every carrier tracking number printed in the email, with its carrier (UPS, FEDEX, USPS, DHL, AMAZON, ONTRAC, LASERSHIP, else OTHER). Copy each number exactly as printed. Never return an order number, invoice number, reference number, SKU, phone number or ZIP code. Return [] when the email prints none.
- track_link: when no number is printed, the exact URL of the email's "track your order / track package" link, copied from the email; else null.`;

export type TrackingAiCall = (subject: string, text: string) => Promise<{ shipments: Array<{ carrier: string; tracking_number: string }>; track_link: string | null; input_tokens: number; output_tokens: number }>;
const defaultTrackingAi: TrackingAiCall = async (subject, text) => {
  const res = await anthropicClient().messages.parse({
    model: AI.model, max_tokens: 4000, output_config: { effort: AI.effort, format: zodOutputFormat(AiTrackingSchema) },
    system: AI_TRACKING_SYSTEM, messages: [{ role: "user", content: `Subject: ${subject}\n\n${text}` }],
  });
  const parsed = AiTrackingSchema.safeParse(res.parsed_output);
  if (!parsed.success) throw new Error(`schema: ${parsed.error.message.slice(0, 200)}`);
  return { ...parsed.data, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
};

const alnum = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");

/** Pure: the email text the model sees — invisible padding and runs of whitespace collapsed, at most 12K characters. */
export function aiEmailText(msg: Pick<GmailMessage, "text" | "trackLinks">): string {
  const t = msg.text.replace(/&#\d+;|&zwnj;|&nbsp;|[​-‍͏ ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 12000);
  const links = (msg.trackLinks ?? []).slice(0, 6);
  return links.length ? `${t}\n\nTracking links:\n${links.join("\n")}` : t;
}

/**
 * Pure: the model's numbers that are really printed in the email (alnum-compared,
 * a USPS ZIP prefix allowed), 8–34 characters, not the order #. Carrier as the model said.
 */
export function verifiedAiShipments(found: ReadonlyArray<{ carrier: string; tracking_number: string }>, emailText: string, orderId: string): Array<{ carrier: Carrier; trackingNumber: string }> {
  const hay = alnum(emailText), order = alnum(orderId);
  const out: Array<{ carrier: Carrier; trackingNumber: string }> = [];
  for (const f of found) {
    const n = stripZipPrefix(alnum(f.tracking_number));
    if (n.length < 8 || n.length > 34 || !/\d/.test(n) || n === order || !hay.includes(n)) continue;
    if (out.some((x) => x.trackingNumber === n)) continue;
    out.push({ carrier: (CARRIERS as readonly string[]).includes(f.carrier) ? (f.carrier as Carrier) : "OTHER", trackingNumber: n });
  }
  return out;
}

/** Pure: the model's link, only when it is one of the email's own URLs. */
export function verifiedAiLink(link: string | null, msg: Pick<GmailMessage, "text" | "trackLinks">): string | null {
  if (!link || !/^https?:\/\//i.test(link)) return null;
  const clean = link.replace(/&amp;/g, "&");
  const own = [...(msg.trackLinks ?? []), ...Array.from(msg.text.matchAll(/https?:\/\/[^\s)>"'\]]+/gi), (m) => m[0])].map((u) => u.replace(/&amp;/g, "&"));
  return own.includes(clean) ? clean : null;
}

export interface AiPlaceholderItem { id: number; order_id: string; sender_domain: string | null; outcome: "resolved" | "none" | "failed" | "would_ask" | "over_cap"; numbers?: string[]; via?: "text" | "link"; error?: string }
export interface AiPlaceholderResult {
  placeholders: number; one_po: number; no_single_po: number;
  calls: number; resolved: number; rows: number; none: number; failed: number; skipped_cap: number; dry_run: number; off: boolean; cost: number;
  items: AiPlaceholderItem[];
}

export interface AiPlaceholderDeps {
  gmail: gmail_v1.Gmail;
  get?: typeof getMessage;
  fetch?: FetchLike;
  /** The model call (tests inject one); null = off. Default: on when a key is configured. */
  ai?: TrackingAiCall | null;
  /** Exactly one AF PO for a placeholder's order # (the matcher's rule) — injected by the caller to avoid a cycle. */
  onePo: (row: { sender_domain: string | null; retailer_order_id: string | null; email_subject: string | null }) => { po_id: string; supplier: string } | null;
  /** Writes real rows (tracking-ingest upsertTrackingRow). */
  upsert: (draft: any) => Promise<unknown>;
}

/**
 * The fallback over every open ai_disabled placeholder (oldest first). Live:
 * up to maxCalls model calls, each logged; resolved placeholders become real
 * rows and are deleted, the rest are marked ai_no_tracking. Dry run: no call,
 * no write — counts only.
 */
export async function resolvePlaceholdersWithAi(query: QueryLike, deps: AiPlaceholderDeps, opts: { dryRun?: boolean; maxCalls?: number } = {}): Promise<AiPlaceholderResult> {
  const get = deps.get ?? getMessage;
  const ai = deps.ai !== undefined ? deps.ai : aiAvailable() ? defaultTrackingAi : null;
  const max = opts.maxCalls ?? TRACKING_AI_MAX_CALLS;
  const rows = (await query(
    `SELECT id, gmail_message_id, gmail_thread_id, sender_domain, retailer_order_id, email_subject, ship_to_street, shipped_at FROM po_tracking
      WHERE tracking_number LIKE 'email:%' AND status = 'unmatched' AND match_reason = $1 ORDER BY shipped_at, id`, [AI_DISABLED_REASON],
  )).rows;
  const r: AiPlaceholderResult = { placeholders: rows.length, one_po: 0, no_single_po: 0, calls: 0, resolved: 0, rows: 0, none: 0, failed: 0, skipped_cap: 0, dry_run: 0, off: !ai, cost: 0, items: [] };
  for (const row of rows) {
    const po = deps.onePo(row);
    if (!po) { r.no_single_po++; continue; }
    r.one_po++;
    const base = { id: Number(row.id), order_id: String(row.retailer_order_id), sender_domain: row.sender_domain ?? null };
    if (!ai) continue;
    if (opts.dryRun) { r.dry_run++; r.items.push({ ...base, outcome: "would_ask" }); continue; }
    if (r.calls >= max) { r.skipped_cap++; r.items.push({ ...base, outcome: "over_cap" }); continue; }
    const msg = await get(deps.gmail, String(row.gmail_message_id));
    const text = aiEmailText(msg);
    const t0 = Date.now();
    r.calls++;
    let a: Awaited<ReturnType<TrackingAiCall>>;
    try {
      a = await ai(msg.subject, text);
    } catch (err: any) {
      r.failed++;
      const error = String(err?.message ?? err).slice(0, 500);
      await logPrefill(query, { user_id: null, kind: "tracking_fallback", retailer: po.supplier, input_chars: AI_TRACKING_SYSTEM.length + text.length, input_tokens: 0, output_tokens: 0, cost_estimate: 0, duration_ms: Date.now() - t0, schema_ok: false, error });
      r.items.push({ ...base, outcome: "failed", error });
      continue;
    }
    const cost = estimateCost(a.input_tokens, a.output_tokens);
    r.cost = Math.round((r.cost + cost) * 1e5) / 1e5;
    await logPrefill(query, { user_id: null, kind: "tracking_fallback", retailer: po.supplier, input_chars: AI_TRACKING_SYSTEM.length + text.length, input_tokens: a.input_tokens, output_tokens: a.output_tokens, cost_estimate: cost, duration_ms: Date.now() - t0, schema_ok: true, error: null });
    let found = verifiedAiShipments(a.shipments, msg.text + "\n" + (msg.trackLinks ?? []).join("\n"), base.order_id);
    let via: "text" | "link" = "text";
    if (found.length === 0) {
      const link = verifiedAiLink(a.track_link, msg);
      if (link) { found = await extractGenericLinkTracking("", [base.order_id], deps.fetch, [link]).catch(() => []); via = "link"; }
    }
    if (found.length === 0) {
      r.none++;
      await query(`UPDATE po_tracking SET match_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'unmatched'`, [row.id, AI_NO_TRACKING_REASON]);
      r.items.push({ ...base, outcome: "none" });
      continue;
    }
    r.resolved++; r.rows += found.length;
    for (const f of found) {
      await deps.upsert({
        carrier: f.carrier, tracking_number: f.trackingNumber, retailer_order_id: base.order_id, sender_domain: base.sender_domain,
        ship_to_street: row.ship_to_street ?? null, shipped_at: new Date(row.shipped_at ?? msg.date), items_json: null,
        gmail_message_id: String(row.gmail_message_id), gmail_thread_id: row.gmail_thread_id ?? null, email_subject: String(row.email_subject ?? msg.subject).slice(0, 300),
        source: "ai", match_reason: null,
      });
    }
    await query(`DELETE FROM po_tracking WHERE id = $1 AND status = 'unmatched'`, [row.id]);
    r.items.push({ ...base, outcome: "resolved", numbers: found.map((f) => `${f.carrier} ${f.trackingNumber}`), via });
  }
  return r;
}
