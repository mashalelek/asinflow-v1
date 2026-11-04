// PO documents (patch docs/claude_spec-patch-po-documents.md; SPEC §22 "PO
// documents", §26): PDFs kept for a PO in Maria's Drive, under the Invoices
// root, one po_documents row each.
//
// - linkExistingDocuments (D1): existing PDFs found by name (shared/po-documents.ts
//   planLinks — Maria's rules 2026-11-04) are linked, never renamed, moved or
//   re-rendered; the ambiguous ones go on a review list (a CSV for Maria).
// - ingestDocuments (§5): order-confirmation, shipped and delivered emails in
//   orders@ matched to exactly one PO by order # are rendered to PDF
//   (server/pdf-render.ts), uploaded under the §2 name into the PO's month
//   folder (D2, created when missing) and recorded. One document per
//   (gmail_message_id, type) — re-runs never duplicate or rename. D4: an email
//   received before the ingest went live counts only for a PO created in AF
//   (form / extension / email renewal); sheet-era POs get D1 linking only.
//
// Dry runs write nothing — no Drive file or folder, no row, no watermark —
// and return counts.
import type { gmail_v1, drive_v3 } from "googleapis";
import { listMessageIds, getMessage, getRenderableMessage, type GmailMessage } from "./gmail-client";
import { parseConfirmationEmail, findPoForConfirmation, type PoFacts } from "./po-confirm-reconcile";
import { isReturnEmail } from "./tracking-parse";
import { resolveSupplier, loadDomainMap, loadPlatformSenders, poNamedInEmail, retailerNameFromSubject, supplierByName, registrable } from "./tracking-match";
import { loadAliases, aliasKey } from "./supplier-aliases";
import { classifySubject, type EmailDocType } from "./order-email-classify";
import { AI, aiAvailable, anthropicClient, estimateCost } from "./config/ai";
import { logPrefill } from "./po-prefill";
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { listInvoiceTree, ensureMonthFolder, folderFileNames, uploadPdf, type DriveTree } from "./drive-client";
import { renderHtmlToPdf } from "./pdf-render";
import { planLinks, documentBaseName, nextDocumentFileName, orderYmd, type PoDocumentType, type LinkReviewEntry } from "@shared/po-documents";
import type { QueryLike } from "./scheduler/types";

export const DOCS_WATERMARK_KEY = "docs.gmail_watermark";
const OVERLAP_MS = 6 * 3600_000;
/** PO sources that are "created in AF" (D4). */
export const AF_CREATED_SOURCES = ["manual", "extension", "email_renewal"] as const;

const hasTable = async (query: QueryLike): Promise<boolean> =>
  !!(await query(`SELECT to_regclass('public.po_documents') AS t`)).rows[0]?.t;

// ---- D1: link existing PDFs ----

export interface LinkResult {
  files: number; pdfs: number; pos: number; already_linked: number;
  linked: { name: number; loose: number }; pos_linked: number;
  by_month: Record<string, { pos: number; linked: number }>;
  review: LinkReviewEntry[]; dryRun: boolean;
}

export async function linkExistingDocuments(opts: { query: QueryLike; drive: drive_v3.Drive; tree?: DriveTree; dryRun?: boolean; log?: (m: string) => void }): Promise<LinkResult> {
  const tree = opts.tree ?? await listInvoiceTree(opts.drive);
  const pos = (await opts.query(`SELECT id, order_date, supplier, order_id FROM purchase_orders`)).rows;
  const table = await hasTable(opts.query);
  const linkedIds = new Set<string>(table ? (await opts.query(`SELECT drive_file_id FROM po_documents`)).rows.map((r: any) => String(r.drive_file_id)) : []);
  const plan = planLinks(pos, tree.files, linkedIds);
  const r: LinkResult = {
    files: tree.files.length, pdfs: tree.files.filter((f) => /\.pdf\s*$/i.test(f.name) || f.mimeType === "application/pdf").length,
    pos: pos.length, already_linked: linkedIds.size, linked: { name: 0, loose: 0 }, pos_linked: new Set(plan.links.map((l) => l.po_id)).size,
    by_month: {}, review: plan.review, dryRun: !!opts.dryRun,
  };
  const linkedPos = new Set(plan.links.map((l) => l.po_id));
  for (const p of pos) { const m = orderYmd(p.order_date).slice(0, 7); const e = (r.by_month[m] ??= { pos: 0, linked: 0 }); e.pos++; if (linkedPos.has(String(p.id))) e.linked++; }
  for (const l of plan.links) {
    r.linked[l.rule]++;
    if (opts.dryRun) continue;
    await opts.query(
      `INSERT INTO po_documents (po_id, type, drive_file_id, file_name, bytes, document_at, source) VALUES ($1, $2, $3, $4, $5, $6, 'linked_existing') ON CONFLICT DO NOTHING`,
      [l.po_id, l.type, l.file.id, l.file.name, l.file.size ?? null, l.file.createdTime ?? null],
    );
  }
  opts.log?.(`documents link: ${r.files} files (${r.pdfs} PDF), ${r.linked.name + r.linked.loose} linked (name ${r.linked.name}, loose ${r.linked.loose}) on ${r.pos_linked} POs, review ${r.review.length}${r.dryRun ? " (dry run)" : ""}`);
  return r;
}

/** Pure: the review list as CSV (Maria's decision 2 — the several-candidates cases only). */
export function reviewCsv(review: readonly LinkReviewEntry[]): string {
  const q = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = [["po_id", "order_date", "supplier", "order_id", "reason", "candidate_files", "candidate_folders", "candidate_drive_ids"].join(",")];
  for (const e of review) {
    rows.push([e.po.id, orderYmd(e.po.order_date), e.po.supplier, e.po.order_id, e.reason, e.candidates.map((c) => c.name).join(" | "), e.candidates.map((c) => c.path ?? "").join(" | "), e.candidates.map((c) => c.id).join(" | ")].map(q).join(","));
  }
  return rows.join("\n") + "\n";
}

// ---- §5: ingest order emails ----
//
// 2026-11-04 (Maria — ShagTools PO 4126643 got no document): the type comes
// from the subject rules in server/order-email-classify.ts (built from a
// 90-day sample of orders@), emails filed under Promotions are read too
// (ShagTools' "has been received!", most Zoro and all Yankee Candle order
// mail sit there), a supplier's invoice email is type invoice, and the PO is
// found by the labelled order # or, failing that, by an AF order # named in
// the text (posNamedInText). A subject no rule names goes to the AI fallback
// — only when the email already names exactly one PO, at most
// DOC_AI_MAX_CALLS per pass, each call logged in po_prefill_log
// (doc_classify).

export const DOC_AI_MAX_CALLS = 40;

export interface ClassifiedEmail {
  /** The subject's document type; "unknown" = no rule (the AI fallback's input). */
  type: EmailDocType | "unknown";
  rule: string | null;
  orderIds: string[];
  senderDomain: string | null;
}

/** Pure: which document an email is — null for an excluded subject (cancel / refund / return, cart, review, marketing, in-between notices) or a return email. */
export function classifyEmail(msg: Pick<GmailMessage, "subject" | "text" | "fromDomain">): ClassifiedEmail | null {
  const c = classifySubject(msg.subject ?? "");
  if (c.type === "excluded" || isReturnEmail(msg.subject ?? "", msg.text ?? "")) return null;
  const p = parseConfirmationEmail(msg); // the order ids, and the original sender of a forward
  return { type: c.type, rule: c.type === "unknown" ? null : c.rule, orderIds: p.orderIds, senderDomain: p.senderDomain };
}

/** Pure: the one PO an email is about — the labelled order # (narrowed by the sender's supplier), else an AF order # named in its text. */
export function poForEmail<T extends PoFacts & { order_date?: Date | string | null }>(c: ClassifiedEmail, msg: Pick<GmailMessage, "subject" | "text" | "date">, pos: readonly T[], supplier: string | null): T[] {
  const byId = findPoForConfirmation({ isConfirmation: true, orderIds: c.orderIds, total: null, lineCount: null, senderDomain: c.senderDomain }, pos, supplier) as T[];
  if (byId.length) return byId;
  const named = poNamedInEmail(`${msg.subject ?? ""}\n${msg.text ?? ""}`, msg.date ?? null, supplier, pos);
  return named ? [named as T] : [];
}

const AiDocSchema = z.object({ type: z.enum(["order_confirmation", "invoice", "shipped", "delivered", "none"]) });
const AI_DOC_SYSTEM = `You classify one email a retailer or supplier sent about a purchase order. Answer with the document it is:
- order_confirmation: the order was received / placed / confirmed (not yet shipped)
- invoice: an invoice or receipt for the order
- shipped: the order or part of it has shipped / is on its way / is complete and sent
- delivered: the order or part of it was delivered / has arrived
- none: anything else — marketing, a cart reminder, a review or survey request, a cancellation, a refund, a return, a delay, a payment problem, "out for delivery", "ready for pickup", account mail.`;

export type DocAiCall = (subject: string, text: string) => Promise<{ type: EmailDocType | "none"; input_tokens: number; output_tokens: number }>;
const defaultDocAi: DocAiCall = async (subject, text) => {
  const res = await anthropicClient().messages.parse({
    model: AI.model, max_tokens: 2000, output_config: { effort: AI.effort, format: zodOutputFormat(AiDocSchema) },
    system: AI_DOC_SYSTEM, messages: [{ role: "user", content: `Subject: ${subject}\n\n${text.slice(0, 4000)}` }],
  });
  const parsed = AiDocSchema.safeParse(res.parsed_output);
  if (!parsed.success) throw new Error("schema: the answer was not a document type");
  return { type: parsed.data.type, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
};

type IngestPo = PoFacts & { order_date: Date | string; source: string };

export interface IngestResult {
  scanned: number; documents: number; matched: number; unmatched: number; ambiguous: number;
  already: number; sheet_era_skipped: number; rendered: number; failed: number;
  /** Subjects an exclusion stopped; subjects no rule named that the AI did not type (off, over the cap, or "none"). */
  excluded: number; untyped: number;
  /** dry_run: emails the AI would be asked about (a dry run never calls it — every call is logged, and a dry run writes nothing). */
  ai: { calls: number; typed: number; none: number; failed: number; cost: number; skipped_cap: number; dry_run: number; off: boolean };
  by_type: Record<string, number>; by_rule: Record<string, number>; folders_created: string[];
  since: string | null; until: string; dryRun: boolean; failures: Array<{ message_id: string; error: string }>;
  /** The documents written (live) or that would be (dry run). */
  items: Array<{ po_id: string; supplier: string; order_id: string; type: PoDocumentType; rule: string; message_id: string; subject: string; file_name?: string; source: string }>;
}

export interface IngestDeps {
  gmail: gmail_v1.Gmail; drive: drive_v3.Drive;
  list?: typeof listMessageIds; get?: typeof getMessage; getRenderable?: typeof getRenderableMessage;
  render?: (html: string) => Promise<Buffer>;
  /** The AI fallback (default: one Haiku call via server/config/ai.ts; off without ANTHROPIC_API_KEY). */
  ai?: DocAiCall | null;
}

interface DocsWatermark { last_scanned_at?: string; live_since?: string }

export async function readDocsWatermark(query: QueryLike): Promise<DocsWatermark> {
  return ((await query(`SELECT value FROM settings WHERE key = $1`, [DOCS_WATERMARK_KEY])).rows[0]?.value ?? {}) as DocsWatermark;
}

/** The first scan's start: the day before the oldest AF-created PO's order date (D4's backfill). */
async function backfillStart(query: QueryLike): Promise<Date | null> {
  const d = (await query(`SELECT MIN(order_date) AS d FROM purchase_orders WHERE source = ANY($1::text[])`, [AF_CREATED_SOURCES])).rows[0]?.d;
  if (!d) return null;
  const x = new Date(`${orderYmd(d)}T00:00:00Z`);
  return new Date(x.getTime() - 86_400_000);
}

export async function ingestDocuments(opts: { query: QueryLike; deps: IngestDeps; now?: Date; since?: Date | null; dryRun?: boolean; maxMessages?: number; aiMaxCalls?: number; onlyPoId?: string; log?: (m: string) => void }): Promise<IngestResult> {
  const now = opts.now ?? new Date();
  const { deps } = opts;
  const list = deps.list ?? listMessageIds, get = deps.get ?? getMessage, getRenderable = deps.getRenderable ?? getRenderableMessage;
  const render = deps.render ?? (async (html: string) => (await renderHtmlToPdf(html)).pdf);
  const wm = await readDocsWatermark(opts.query);
  // Before the first live run every email is backfill (D4); live_since is stamped on that run.
  const liveSince = wm.live_since ? new Date(wm.live_since) : now;
  const from = opts.since !== undefined ? opts.since
    : wm.last_scanned_at ? new Date(new Date(wm.last_scanned_at).getTime() - OVERLAP_MS) : await backfillStart(opts.query);
  // Promotions included (2026-11-04): real order mail is filed there; spam and trash are not searched.
  const q = from ? `after:${Math.floor(from.getTime() / 1000)}` : "";
  const ids = await list(deps.gmail, q, opts.maxMessages ?? 5000);
  const r: IngestResult = {
    scanned: ids.length, documents: 0, matched: 0, unmatched: 0, ambiguous: 0, already: 0, sheet_era_skipped: 0, rendered: 0, failed: 0,
    excluded: 0, untyped: 0, ai: { calls: 0, typed: 0, none: 0, failed: 0, cost: 0, skipped_cap: 0, dry_run: 0, off: false },
    by_type: {}, by_rule: {}, folders_created: [], since: from?.toISOString() ?? null, until: now.toISOString(), dryRun: !!opts.dryRun, failures: [], items: [],
  };
  const pos = (await opts.query(
    `SELECT p.id, p.supplier, p.order_id, p.order_date, p.source, p.order_total::float AS order_total, 0 AS line_count FROM purchase_orders p`,
  )).rows as IngestPo[];
  const suppliers = Array.from(new Set(pos.map((p) => p.supplier)));
  const domainMap = await loadDomainMap(opts.query), platforms = await loadPlatformSenders(opts.query), aliases = await loadAliases(opts.query);
  const table = await hasTable(opts.query);
  const ai = deps.ai !== undefined ? deps.ai : aiAvailable() ? defaultDocAi : null;
  r.ai.off = !ai;
  const aiMax = opts.aiMaxCalls ?? DOC_AI_MAX_CALLS;
  for (const id of ids) {
    const msg = await get(deps.gmail, id);
    const c = classifyEmail(msg);
    if (!c) { r.excluded++; continue; }
    let supplier = resolveSupplier(c.senderDomain, domainMap, suppliers, platforms).supplier;
    if (!supplier && c.senderDomain && platforms.includes(registrable(c.senderDomain))) {
      const name = retailerNameFromSubject(msg.subject); // a platform sender: the store its subject names
      supplier = name ? (aliases.get(aliasKey(name)) ?? supplierByName(name, suppliers)) : null;
    }
    const hits = poForEmail(c, msg, pos, supplier);
    if (hits.length === 0) { if (c.type !== "unknown") { r.documents++; r.unmatched++; } continue; }
    if (hits.length > 1) { if (c.type !== "unknown") { r.documents++; r.ambiguous++; } continue; }
    const po = hits[0];
    if (opts.onlyPoId && String(po.id) !== opts.onlyPoId) continue; // npm run po-docs -- --order <#>: one PO only
    if (msg.date < liveSince && !(AF_CREATED_SOURCES as readonly string[]).includes(po.source)) { if (c.type !== "unknown") { r.documents++; r.matched++; r.sheet_era_skipped++; } continue; }
    let type: EmailDocType, rule: string;
    if (c.type !== "unknown") { type = c.type; rule = c.rule ?? c.type; } else {
      // No subject rule: the AI types it — only now that it names exactly one PO it may be filed on.
      if (table && (await opts.query(`SELECT 1 FROM po_documents WHERE gmail_message_id = $1`, [msg.id])).rows.length) continue;
      if (!ai) { r.untyped++; continue; }
      if (opts.dryRun) { r.ai.dry_run++; r.untyped++; continue; }
      if (r.ai.calls >= aiMax) { r.ai.skipped_cap++; r.untyped++; continue; }
      r.ai.calls++;
      const t0 = Date.now();
      const text = msg.text ?? "";
      try {
        const a = await ai(msg.subject ?? "", text);
        const cost = estimateCost(a.input_tokens, a.output_tokens);
        r.ai.cost = Math.round((r.ai.cost + cost) * 1e5) / 1e5;
        await logPrefill(opts.query, { user_id: null, kind: "doc_classify", retailer: po.supplier, input_chars: AI_DOC_SYSTEM.length + text.length, input_tokens: a.input_tokens, output_tokens: a.output_tokens, cost_estimate: cost, duration_ms: Date.now() - t0, schema_ok: true, error: null });
        if (a.type === "none") { r.ai.none++; r.untyped++; continue; }
        r.ai.typed++;
        type = a.type; rule = "ai";
      } catch (err: any) {
        r.ai.failed++; r.untyped++;
        await logPrefill(opts.query, { user_id: null, kind: "doc_classify", retailer: po.supplier, input_chars: AI_DOC_SYSTEM.length + text.length, input_tokens: 0, output_tokens: 0, cost_estimate: 0, duration_ms: Date.now() - t0, schema_ok: false, error: String(err?.message ?? err).slice(0, 500) });
        continue;
      }
    }
    r.documents++;
    r.matched++;
    if (table && (await opts.query(`SELECT 1 FROM po_documents WHERE gmail_message_id = $1 AND type = $2`, [msg.id, type])).rows.length) { r.already++; continue; }
    r.by_type[type] = (r.by_type[type] ?? 0) + 1;
    r.by_rule[rule] = (r.by_rule[rule] ?? 0) + 1;
    const item = { po_id: String(po.id), supplier: po.supplier, order_id: po.order_id, type: type as PoDocumentType, rule, message_id: msg.id, subject: msg.subject ?? "", source: po.source };
    if (opts.dryRun) {
      const folder = await ensureMonthFolder(deps.drive, orderYmd(po.order_date), { dryRun: true });
      for (const f of folder.created) if (!r.folders_created.includes(f)) r.folders_created.push(f);
      r.items.push(item);
      continue;
    }
    try {
      const rm = await getRenderable(deps.gmail, msg.id);
      const pdf = await render(rm.html);
      r.rendered++;
      const folder = await ensureMonthFolder(deps.drive, orderYmd(po.order_date));
      for (const f of folder.created) if (!r.folders_created.includes(f)) r.folders_created.push(f);
      const onPo = (await opts.query(`SELECT file_name FROM po_documents WHERE po_id = $1`, [po.id])).rows.map((x: any) => String(x.file_name));
      const name = nextDocumentFileName(documentBaseName(po), type, [...(await folderFileNames(deps.drive, folder.id)), ...onPo]);
      const up = await uploadPdf(deps.drive, folder.id, name, pdf);
      await opts.query(
        `INSERT INTO po_documents (po_id, type, gmail_message_id, drive_file_id, file_name, bytes, document_at, source) VALUES ($1, $2, $3, $4, $5, $6, $7, 'email') ON CONFLICT DO NOTHING`,
        [po.id, type, msg.id, up.id, name, up.bytes, msg.date.toISOString()],
      );
      r.items.push({ ...item, file_name: name });
    } catch (err: any) {
      r.failed++;
      r.failures.push({ message_id: msg.id, error: String(err?.message ?? err).slice(0, 300) });
    }
  }
  // A failed render keeps the watermark where it was, so the next pass retries it (idempotent: the rest are skipped as already done).
  if (!opts.dryRun && r.failed === 0) {
    const v: DocsWatermark = { last_scanned_at: now.toISOString(), live_since: wm.live_since ?? now.toISOString() };
    await opts.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [DOCS_WATERMARK_KEY, JSON.stringify(v)],
    );
  }
  opts.log?.(`documents ingest: scanned ${r.scanned} (excluded ${r.excluded}), documents ${r.documents}, matched ${r.matched} (unmatched ${r.unmatched}, ambiguous ${r.ambiguous}), already ${r.already}, sheet-era skipped ${r.sheet_era_skipped}, ${opts.dryRun ? "would write" : "written"} ${r.items.length}${r.failed ? `, failed ${r.failed}` : ""}`);
  return r;
}
