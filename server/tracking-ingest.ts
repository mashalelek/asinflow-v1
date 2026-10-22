// Gmail → po_tracking (SPEC §26; patch po-tracking-velocity §4). The ingest
// half of "Sync tracking" / the 00:00 component po_tracking_ingest.
//
// Messages since the watermark (minus a day of overlap — dedup absorbs it),
// excluding Promotions; each parsed by tracking-parse.ts; non-candidates are
// skipped. One row per (carrier, tracking_number): "shipped", "out for
// delivery" and "delivered" repeat the same number, so a repeat email only
// refreshes gmail_message_id / shipped_at while the row is still unmatched.
//
// A shipped-type email with an order # but no tracking number (Michaels:
// only its own shipment ids) is queued as ONE placeholder row per (sender
// domain, order #): carrier OTHER, tracking_number "email:<domain>:<order>",
// match_reason "ai_disabled" until the AI fallback (§4 D3) can read it. It is
// never pushed.
import type { gmail_v1 } from "googleapis";
import { listMessageIds, getMessage, type GmailMessage } from "./gmail-client";
import { parseTrackingEmail, type ParsedEmail } from "./tracking-parse";
import { extractorFor, extractLinkTracking, type FetchLike } from "./tracking-links";
import { AI_DISABLED_REASON } from "./tracking-ai";
import type { QueryLike } from "./scheduler/types";

export const WATERMARK_KEY = "tracking.gmail_watermark";
const OVERLAP_MS = 24 * 3600_000;
const SHIPPED_SUBJECT = /\b(shipped|has shipped|on the way|on its way|about to ship|ready to ship|shipment|left our warehouse|label (?:has been )?created)\b/i;

export interface TrackingRowDraft {
  carrier: string;
  tracking_number: string;
  retailer_order_id: string | null;
  sender_domain: string | null;
  ship_to_street: string | null;
  shipped_at: Date;
  items_json: Array<{ name: string; qty: number }> | null;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  email_subject: string;
  source: "regex" | "ai";
  match_reason: string | null;
}

export const placeholderTracking = (domain: string | null, orderId: string) => `email:${domain ?? "?"}:${orderId}`;
export const isPlaceholder = (trackingNumber: string) => trackingNumber.startsWith("email:");

/** Pure: one parsed email → the rows it contributes (possibly none). */
export function rowsFromEmail(msg: Pick<GmailMessage, "id" | "threadId" | "date" | "subject">, p: ParsedEmail): TrackingRowDraft[] {
  if (!p.candidate) return [];
  const single = p.orderIds.length === 1 ? p.orderIds[0] : null;
  // Several distinct order #s in one email and no structure pairing them → no order on the rows, queued as unpaired.
  const unpaired = p.orderIds.length > 1;
  const base = {
    sender_domain: p.senderDomain, ship_to_street: p.shipToStreet, shipped_at: msg.date,
    gmail_message_id: msg.id, gmail_thread_id: msg.threadId, email_subject: msg.subject.slice(0, 300),
  };
  if (p.shipments.length > 0) {
    return p.shipments.map((s) => ({
      ...base, carrier: s.carrier, tracking_number: s.trackingNumber,
      retailer_order_id: single, items_json: s.items.length ? s.items : null,
      source: "regex" as const, match_reason: unpaired ? "unpaired" : null,
    }));
  }
  if (single && p.kind === "shipped" && SHIPPED_SUBJECT.test(msg.subject)) {
    return [{
      ...base, carrier: "OTHER", tracking_number: placeholderTracking(p.senderDomain, single),
      retailer_order_id: single, items_json: null, source: "regex", match_reason: AI_DISABLED_REASON,
    }];
  }
  return [];
}

export interface IngestResult {
  scanned: number; candidates: number; rows: number; inserted: number; refreshed: number; ignored_repeats: number; placeholders: number;
  /** Emails whose numbers came from a tracking link (Michaels). */
  link_resolved: number;
  /** Earlier placeholders re-read and resolved through a tracking link. */
  placeholders_resolved?: number;
  since: string | null; until: string;
  /** Per new / refreshed row: what was read (dry runs report these too). */
  drafts?: TrackingRowDraft[];
}

export interface IngestDeps {
  gmail: gmail_v1.Gmail;
  list?: typeof listMessageIds;
  get?: typeof getMessage;
  /** The tracking-link extractors' redirect follower (tests inject one). */
  fetch?: FetchLike;
}

/**
 * Pure-ish: when the body carries no number and the sender has a tracking-link
 * extractor (Michaels), the numbers behind its links become the shipments.
 */
export async function withLinkTracking(msg: Pick<GmailMessage, "text">, p: ParsedEmail, fetchFn?: FetchLike): Promise<ParsedEmail> {
  if (p.shipments.length > 0 || !extractorFor(p.senderDomain)) return p;
  const found = await extractLinkTracking(msg.text, p.senderDomain, fetchFn);
  return found.length ? { ...p, shipments: found.map((f) => ({ ...f, items: [] })) } : p;
}

/** Drop an order's "email:" placeholder once a real number exists for it (it was a queue entry, not history). */
async function dropPlaceholder(query: QueryLike, domain: string | null, orderId: string | null): Promise<void> {
  if (!orderId) return;
  await query(`DELETE FROM po_tracking WHERE tracking_number = $1 AND status = 'unmatched'`, [placeholderTracking(domain, orderId)]);
}

/**
 * Re-read the emails behind existing placeholders whose sender now has a
 * tracking-link extractor (the Michaels placeholders queued before it
 * existed); each one resolved becomes real rows and its placeholder goes.
 */
export async function resolveLinkPlaceholders(query: QueryLike, deps: IngestDeps, opts: { dryRun?: boolean } = {}): Promise<{ placeholders: number; resolved: number; rows: number }> {
  const get = deps.get ?? getMessage;
  const ph = (await query(
    `SELECT id, gmail_message_id, sender_domain, retailer_order_id FROM po_tracking
      WHERE tracking_number LIKE 'email:%' AND status = 'unmatched'`,
  )).rows.filter((r: any) => extractorFor(r.sender_domain));
  const out = { placeholders: ph.length, resolved: 0, rows: 0 };
  for (const r of ph) {
    const msg = await get(deps.gmail, String(r.gmail_message_id));
    const p = await withLinkTracking(msg, parseTrackingEmail(msg), deps.fetch);
    const drafts = rowsFromEmail(msg, p).filter((d) => !isPlaceholder(d.tracking_number));
    if (drafts.length === 0) continue;
    out.resolved++; out.rows += drafts.length;
    if (opts.dryRun) continue;
    for (const d of drafts) await upsertTrackingRow(query, d);
    await dropPlaceholder(query, r.sender_domain, r.retailer_order_id);
  }
  return out;
}

export async function readWatermark(query: QueryLike): Promise<Date | null> {
  const v = (await query(`SELECT value FROM settings WHERE key = $1`, [WATERMARK_KEY])).rows[0]?.value;
  return v?.last_scanned_at ? new Date(v.last_scanned_at) : null;
}

/**
 * Scan and upsert. `since` overrides the watermark (the backfill); a dry run
 * writes nothing (no rows, no watermark) and returns the drafts.
 */
export async function ingestTracking(opts: {
  query: QueryLike; deps: IngestDeps; now?: Date; since?: Date | null; dryRun?: boolean; maxMessages?: number;
  log?: (m: string) => void;
}): Promise<IngestResult> {
  const now = opts.now ?? new Date();
  const list = opts.deps.list ?? listMessageIds;
  const get = opts.deps.get ?? getMessage;
  const since = opts.since !== undefined ? opts.since : await readWatermark(opts.query);
  const from = since ? new Date(since.getTime() - OVERLAP_MS) : null;
  const q = `-category:promotions${from ? ` after:${Math.floor(from.getTime() / 1000)}` : ""}`;
  const ids = await list(opts.deps.gmail, q, opts.maxMessages ?? 5000);
  const r: IngestResult = { scanned: ids.length, candidates: 0, rows: 0, inserted: 0, refreshed: 0, ignored_repeats: 0, placeholders: 0, link_resolved: 0, since: from?.toISOString() ?? null, until: now.toISOString() };
  const drafts: TrackingRowDraft[] = [];
  for (const id of ids) {
    const msg = await get(opts.deps.gmail, id);
    const parsed = parseTrackingEmail(msg);
    if (!parsed.candidate) continue;
    r.candidates++;
    const p = await withLinkTracking(msg, parsed, opts.deps.fetch);
    if (p !== parsed) r.link_resolved++;
    if (p !== parsed && !opts.dryRun) await dropPlaceholder(opts.query, p.senderDomain, p.orderIds.length === 1 ? p.orderIds[0] : null);
    for (const d of rowsFromEmail(msg, p)) {
      drafts.push(d);
      r.rows++;
      if (d.match_reason === "ai_disabled") r.placeholders++;
      if (opts.dryRun) continue;
      const w = await upsertTrackingRow(opts.query, d);
      if (w === "inserted") r.inserted++; else if (w === "refreshed") r.refreshed++; else r.ignored_repeats++;
    }
  }
  r.placeholders_resolved = (await resolveLinkPlaceholders(opts.query, opts.deps, { dryRun: opts.dryRun })).resolved;
  if (!opts.dryRun) {
    await opts.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = NOW()`,
      [WATERMARK_KEY, JSON.stringify({ last_scanned_at: now.toISOString() })],
    );
  }
  if (opts.dryRun) r.drafts = drafts;
  opts.log?.(`ingest: scanned ${r.scanned}, candidates ${r.candidates}, rows ${r.rows} (new ${r.inserted}, refreshed ${r.refreshed}, repeats ignored ${r.ignored_repeats}, placeholders ${r.placeholders})`);
  return r;
}

/** Insert, or refresh message id / ship date when the row is still unmatched; otherwise leave it. */
export async function upsertTrackingRow(query: QueryLike, d: TrackingRowDraft): Promise<"inserted" | "refreshed" | "ignored"> {
  const res = await query(
    `INSERT INTO po_tracking (carrier, tracking_number, retailer_order_id, sender_domain, ship_to_street, shipped_at, items_json,
                              gmail_message_id, gmail_thread_id, email_subject, source, status, match_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, 'unmatched', $12)
     ON CONFLICT (carrier, tracking_number) DO UPDATE SET
       gmail_message_id = EXCLUDED.gmail_message_id, gmail_thread_id = EXCLUDED.gmail_thread_id,
       shipped_at = EXCLUDED.shipped_at, updated_at = NOW()
     WHERE po_tracking.status = 'unmatched'
     RETURNING (xmax = 0) AS inserted`,
    [d.carrier, d.tracking_number, d.retailer_order_id, d.sender_domain, d.ship_to_street, d.shipped_at.toISOString(),
     d.items_json ? JSON.stringify(d.items_json) : null, d.gmail_message_id, d.gmail_thread_id, d.email_subject, d.source, d.match_reason],
  );
  if (res.rows.length === 0) return "ignored";
  return res.rows[0].inserted ? "inserted" : "refreshed";
}
