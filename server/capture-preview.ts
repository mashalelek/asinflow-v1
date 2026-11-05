// The extension's AI preview (Maria 2026-11-04; SPEC §11 "Chrome extension —
// Capture PO", v1.3) — instead of more per-site parsing rules. Each Capture
// click posts that ONE page's scrubbed text; one small Haiku extraction
// (server/config/ai.ts, the prefill's schema and prompt — products with qty /
// price / line total / SKU, the totals, payment, promos, order # / date,
// ship-to, checkout email) is turned into the panel's six buckets. The panel
// shows the rule-based buckets at once and replaces them when this answers.
// Cached per page (a hash of host + text + fields): recapturing the same page
// never calls again — here, and in the tab's capture record. "Open in AF"
// stays the one full prefill call (po-prefill.ts). Every call is logged in
// po_prefill_log (kind capture_preview, with its cost); a cache hit is not.
import { createHash } from "crypto";
import { z } from "zod/v4";
import type { QueryLike } from "./scheduler/types";
import { AI } from "./config/ai";
import { CapturePageSchema, extractPrefill, logPrefill, type ExtractDeps, type PrefillExtraction } from "./po-prefill";

// v1.4 (2026-11-05): the extension also says what its in-page structured reader (schema.org / Shopify / BigCommerce data) filled.
export const StructuredSummarySchema = z.object({ platform: z.string().max(40).nullable().default(null), products: z.boolean().default(false), totals: z.boolean().default(false) });
export const PreviewRequestSchema = z.object({ retailerHost: z.string().max(253), page: CapturePageSchema, structured: StructuredSummarySchema.optional() });
export type PreviewRequest = z.infer<typeof PreviewRequestSchema>;

/** The panel's bucket shape (chrome-extension/buckets.js emptyBuckets), money as "$1.23". */
export interface PreviewBuckets {
  products: Array<{ name: string; qty: number | null; price: string | null; total: string | null; sku: string | null }>;
  shipping: { street: string; candidates: string[] } | null;
  payment: { cards: Array<{ nickname: string; last4: string; amount: string | null }>; giftCards: Array<{ last4: string | null; amount: string | null }> };
  totals: Partial<Record<"subtotal" | "discount" | "tax" | "shipping" | "total", string>>;
  promos: string[];
  order: { number?: string; date?: string; subscription?: { on: boolean; every: string | null }; email?: string };
}

/** Pure: the cache key of one page — host + title-free text + fields (the URL / title / time do not change what it shows). */
export function previewKey(host: string, page: { text: string; fields?: Array<{ label: string; value: string }> }): string {
  const h = createHash("sha256");
  h.update(String(host).toLowerCase().replace(/^www\./, "")); h.update("\n\u0000");
  h.update(String(page.text ?? "")); h.update("\n\u0000");
  for (const f of page.fields ?? []) { h.update(`${f.label}\u0001${f.value}\n`); }
  return h.digest("hex").slice(0, 32);
}

const usd = (n: number | null | undefined): string | null => (n == null || !Number.isFinite(n) ? null : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`);
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Pure: the extraction → the panel's buckets. Discount shown as the positive amount, as the rules show it. */
export function extractionToBuckets(x: PrefillExtraction): PreviewBuckets {
  const products = x.lines.map((l) => {
    const unit = l.unitPrice ?? (l.lineTotal != null && l.qty ? l.lineTotal / l.qty : null);
    return { name: l.productName, qty: l.qty, price: usd(unit), total: usd(l.lineTotal ?? (unit != null && l.qty != null ? unit * l.qty : null)), sku: l.retailerSku || null };
  });
  const totals: PreviewBuckets["totals"] = {};
  for (const [k, v] of [["subtotal", x.subtotal], ["discount", x.discount == null ? null : Math.abs(x.discount)], ["tax", x.tax], ["shipping", x.shipping], ["total", x.total]] as const) { const s = usd(v); if (s) totals[k] = s; }
  const promos = x.promos.map((p) => [p.description, p.amount != null ? `−${usd(Math.abs(p.amount))}` : p.percent != null ? `${p.percent}%` : null].filter(Boolean).join(" "));
  const cards: PreviewBuckets["payment"]["cards"] = [], giftCards: PreviewBuckets["payment"]["giftCards"] = [];
  for (const p of x.payments) {
    if (p.method === "gift_card") giftCards.push({ last4: p.last4, amount: usd(p.amount) });
    else if (p.last4 || p.nickname) cards.push({ nickname: p.nickname ?? p.method, last4: p.last4 ?? "", amount: usd(p.amount) });
  }
  const order: PreviewBuckets["order"] = {};
  if (x.orderId) order.number = x.orderId;
  if (x.orderDate) order.date = x.orderDate;
  if (x.subscription.present) order.subscription = { on: true, every: x.subscription.frequencyWeeks ? `${x.subscription.frequencyWeeks} weeks` : null };
  if (x.purchasedEmail && EMAIL.test(x.purchasedEmail.trim())) order.email = x.purchasedEmail.trim().toLowerCase();
  return { products, shipping: x.shipToStreet ? { street: x.shipToStreet, candidates: [] } : null, payment: { cards, giftCards }, totals, promos, order };
}

// Per page, across tabs and captures: 24 h, at most 500 pages (a capture record also keeps its own).
const TTL_MS = 24 * 60 * 60 * 1000, MAX = 500;
const cache = new Map<string, { buckets: PreviewBuckets; expires: number }>();
export function _clearPreviewCache(): void { cache.clear(); }

export interface PreviewResult { key: string; buckets: PreviewBuckets | null; cached: boolean; cost_estimate: number; schema_ok: boolean; error: string | null; logId?: number | null; sampled?: string[] }

/** One page → its buckets: from the cache, else one model call (logged). A failed call returns buckets null — the panel keeps the rules. */
export async function capturePreview(query: QueryLike, req: PreviewRequest, userId: number | null, deps: ExtractDeps = {}, now = Date.now()): Promise<PreviewResult> {
  const key = previewKey(req.retailerHost, req.page);
  const hit = cache.get(key);
  if (hit && hit.expires > now) return { key, buckets: hit.buckets, cached: true, cost_estimate: 0, schema_ok: true, error: null };
  const { extraction, usage } = await extractPrefill({ retailerHost: req.retailerHost, pages: [req.page] }, deps);
  const logId = await logPrefill(query, { user_id: userId, kind: "capture_preview", retailer: req.retailerHost, ...usage });
  const buckets = extraction ? extractionToBuckets(extraction) : null;
  const sampled = await keepSampleIfEmpty(query, req, key, buckets, userId).catch(() => []);
  if (!buckets) return { key, buckets: null, cached: false, cost_estimate: usage.cost_estimate, schema_ok: false, error: usage.error, logId, sampled };
  cache.delete(key); cache.set(key, { buckets, expires: now + TTL_MS });
  while (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  return { key, buckets, cached: false, cost_estimate: usage.cost_estimate, schema_ok: true, error: null, logId, sampled };
}

/** Pure: which of Products / Totals stayed empty after every layer (the in-page structured reader, then the AI). */
export function emptyAfterLayers(buckets: PreviewBuckets | null, structured?: { products?: boolean; totals?: boolean }): string[] {
  const out: string[] = [];
  if (!structured?.products && !(buckets?.products.length)) out.push("products");
  if (!structured?.totals && !(buckets?.totals.subtotal || buckets?.totals.total)) out.push("totals");
  return out;
}
export const SAMPLE_RETENTION_DAYS = 30;
/** A page whose Products or Totals stayed empty: its scrubbed text kept 30 days for test fixtures (migration 092, admin-only). */
async function keepSampleIfEmpty(query: QueryLike, req: PreviewRequest, key: string, buckets: PreviewBuckets | null, userId: number | null): Promise<string[]> {
  const missing = emptyAfterLayers(buckets, req.structured);
  if (!missing.length) return [];
  await query(`DELETE FROM capture_page_samples WHERE created_at < now() - make_interval(days => $1)`, [SAMPLE_RETENTION_DAYS]);
  await query(
    `INSERT INTO capture_page_samples (user_id, retailer, page_key, step, url, title, text, fields, missing, layers) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::text[],$10::jsonb) ON CONFLICT (page_key) DO NOTHING`,
    [userId, req.retailerHost, key, req.page.step, req.page.url, req.page.title, req.page.text, JSON.stringify(req.page.fields ?? []), missing, JSON.stringify({ structured: req.structured ?? null, ai: buckets ? { products: buckets.products.length, totals: Object.keys(buckets.totals) } : null })],
  );
  return missing;
}

/**
 * Express middleware for POST /api/pos/capture-preview, mounted BEFORE auth: every request the server receives or
 * rejects leaves one po_prefill_log row — the route's own model-call row gets its status; anything else (401, 400,
 * 503 AI off, a cache hit, 500) gets a row of its own with cost 0 and the reason in note (migration 092).
 */
export function previewRequestLog(query: QueryLike, onError: (m: string) => void = () => {}) {
  return (req: any, res: any, next: () => void) => {
    const send = res.json.bind(res);
    res.json = (body: any) => { res.locals.previewBody = body; return send(body); };
    res.on("finish", () => {
      const status = res.statusCode as number, body = res.locals.previewBody ?? {};
      const logId: number | null = body.logId ?? null;
      const note = status === 200 ? (body.cached ? "cache hit" : body.buckets ? null : String(body.error ?? "no buckets").slice(0, 300)) : String(body.message ?? body.error ?? `HTTP ${status}`).slice(0, 300);
      const host = typeof req.body?.retailerHost === "string" ? req.body.retailerHost.slice(0, 253) : null;
      const userId = req.session?.userId ?? req.user?.id ?? null;
      const p = logId != null
        ? query(`UPDATE po_prefill_log SET http_status = $2, note = COALESCE(note, $3) WHERE id = $1`, [logId, status, note])
        : query(`INSERT INTO po_prefill_log (user_id, kind, retailer, model, input_chars, input_tokens, output_tokens, cost_estimate, duration_ms, schema_ok, error, http_status, note) VALUES ($1,'capture_preview',$2,$7,$3,0,0,0,0,$4,NULL,$5,$6)`,
            [typeof userId === "number" ? userId : null, host, typeof req.body?.page?.text === "string" ? req.body.page.text.length : 0, status === 200, status, note, AI.model]);
      Promise.resolve(p).catch((e: any) => onError(`preview request log failed: ${e?.message ?? e}`));
    });
    next();
  };
}
