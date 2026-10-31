// Confirmation-email reconcile (patch docs/claude_spec-patch-po-ai-prefill.md
// §6.7; SPEC §26). No AI. When a retailer's order-confirmation email for an
// AF PO arrives at orders@ (matched on the order #), compare the order #,
// the order total and the line count; on a difference raise the action item
// "Confirm order details" on every line of the PO with the diff as its
// reason. Nothing is written to the PO itself. Runs in the 00:00 pass
// (component 27, after the tracking ingest) and from POST
// /api/pos/reconcile-confirmations; dry run returns the rows.
import type { gmail_v1 } from "googleapis";
import { listMessageIds, getMessage, type GmailMessage } from "./gmail-client";
import { extractOrderIds, isReturnEmail, OWN_DOMAINS } from "./tracking-parse";
import { resolveSupplier, loadDomainMap, loadPlatformSenders } from "./tracking-match";
import { afOrderKeys, afOrderBaseKeys, orderKey, orderBaseKey } from "./order-number";
import { insertLineItems } from "./line-action-items";
import { CONFIRM_ORDER_DETAILS } from "./po-status-map";
import type { QueryLike } from "./scheduler/types";

export const CONFIRM_WATERMARK_KEY = "confirm.gmail_watermark";
const OVERLAP_MS = 24 * 3600_000;

/** Subjects / bodies that are an order confirmation (not a shipping, return or marketing email). Covers the 2026-10-30 probe's formats. */
const CONFIRM_SUBJECT = /\b(order\s+(?:is\s+)?confirm(?:ed|ation)|confirm(?:ation|ed)\s+(?:of\s+)?(?:your\s+)?order|thanks?\s+(?:you\s+)?for\s+(?:your\s+)?(?:[\w.&'-]+\s+){0,3}?(?:order|purchase|shopping)|we(?:'ve|\s+have)\s+received\s+your\s+order|your\s+order\s+(?:has\s+been\s+)?(?:received|placed)|order\s+received|order\s+placed|order\s+#?\s*[A-Z0-9-]{4,}\s+confirmed)\b/i;
const NOT_CONFIRM = /\b(shipped|on (?:the|its) way|out for delivery|delivered|tracking|cancel+ed|refund|return)\b/i;

export interface ParsedConfirmation {
  isConfirmation: boolean;
  orderIds: string[];
  total: number | null;
  lineCount: number | null;
  senderDomain: string | null;
}

/** Pure: the order total — "Order total" / "Grand total" first, then a bare "Total" (the last one on the page). */
export function extractTotal(text: string): number | null {
  const amt = (re: RegExp): number | null => { const all = Array.from(text.matchAll(re)); const m = all[all.length - 1]; return m ? Number(m[1].replace(/,/g, "")) : null; };
  const strong = amt(/\b(?:order|grand)\s+total\b[^\n$\d-]{0,30}\$?\s?(\d[\d,]*\.\d{2})/gi);
  if (strong != null) return strong;
  return amt(/(?<![a-z])total\b(?!\s+(?:savings|discount|items?|qty|quantity))[^\n$\d-]{0,30}\$?\s?(\d[\d,]*\.\d{2})/gi);
}
/** Pure: the number of item lines — "Qty: N" / "Quantity N" / "× N" / "N x $" occurrences; null when the email shows none. */
export function extractLineCount(text: string): number | null {
  const n = Array.from(text.matchAll(/(?:\b(?:qty|quantity)\s*[:.]?\s*\d+\b|\b\d+\s*[x×]\s*\$\s?\d|(?<=\s)[x×]\s*\d+\s*$)/gim)).length;
  return n > 0 ? n : null;
}
/** Pure. Forwards from our own mailboxes are attributed to the original sender like the tracking parser does. */
export function parseConfirmationEmail(msg: Pick<GmailMessage, "subject" | "text" | "fromDomain">): ParsedConfirmation {
  const text = msg.text ?? "";
  let senderDomain = msg.fromDomain ?? null;
  if (senderDomain && OWN_DOMAINS.has(senderDomain)) {
    const fwd = /^\s*from:\s*.*?@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/im.exec(text);
    if (fwd) senderDomain = fwd[1].toLowerCase();
  }
  const subject = msg.subject ?? "";
  const isConfirmation = CONFIRM_SUBJECT.test(subject) && !NOT_CONFIRM.test(subject) && !isReturnEmail(subject, text);
  return { isConfirmation, orderIds: extractOrderIds(subject, text), total: extractTotal(text), lineCount: extractLineCount(text), senderDomain };
}

export interface PoFacts { id: string; supplier: string; order_id: string; order_total: number | null; line_count: number }
export interface ConfirmDiff { po_id: string; supplier: string; order_id: string; differences: string[] }

/** Pure: the PO(s) an email's order ids name, narrowed by the sender's supplier when several match. */
export function findPoForConfirmation(p: ParsedConfirmation, pos: readonly PoFacts[], supplier: string | null): PoFacts[] {
  if (p.orderIds.length === 0) return [];
  const keys = new Set(p.orderIds.map(orderKey)), baseKeys = new Set(p.orderIds.map(orderBaseKey));
  const exact = pos.filter((po) => afOrderKeys(po.order_id).some((k) => keys.has(k)));
  let hits = exact.length ? exact : pos.filter((po) => afOrderBaseKeys(po.order_id).some((k) => baseKeys.has(k)));
  if (hits.length > 1 && supplier) { const same = hits.filter((h) => h.supplier.toLowerCase() === supplier.toLowerCase()); if (same.length) hits = same; }
  return hits;
}

/** Pure: the §6.7 comparison. Empty = the email agrees with the PO. */
export function compareConfirmation(p: ParsedConfirmation, po: PoFacts): string[] {
  const out: string[] = [];
  const emailId = p.orderIds.find((id) => afOrderKeys(po.order_id).includes(orderKey(id))) ?? p.orderIds[0];
  if (emailId && orderKey(emailId) !== orderKey(po.order_id)) out.push(`order # ${po.order_id} in AF, ${emailId} in the email`);
  if (p.total != null && po.order_total != null && Math.abs(p.total - po.order_total) > 0.01) out.push(`total $${po.order_total.toFixed(2)} in AF, $${p.total.toFixed(2)} in the email`);
  if (p.lineCount != null && p.lineCount !== po.line_count) out.push(`${po.line_count} line${po.line_count === 1 ? "" : "s"} in AF, ${p.lineCount} in the email`);
  return out;
}

export interface ReconcileResult {
  scanned: number; confirmations: number; matched: number; agreed: number; differed: number; raised: number; unmatched: number; ambiguous: number;
  since: string | null; until: string; diffs: ConfirmDiff[]; dryRun: boolean;
}
export interface ReconcileDeps { gmail: gmail_v1.Gmail; list?: typeof listMessageIds; get?: typeof getMessage }

export async function reconcileConfirmations(opts: { query: QueryLike; deps: ReconcileDeps; now?: Date; since?: Date | null; dryRun?: boolean; maxMessages?: number; log?: (m: string) => void }): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const list = opts.deps.list ?? listMessageIds, get = opts.deps.get ?? getMessage;
  const wm = opts.since !== undefined ? opts.since : await readConfirmWatermark(opts.query);
  const from = wm ? new Date(wm.getTime() - OVERLAP_MS) : null;
  const q = `-category:promotions${from ? ` after:${Math.floor(from.getTime() / 1000)}` : ""}`;
  const ids = await list(opts.deps.gmail, q, opts.maxMessages ?? 5000);
  const r: ReconcileResult = { scanned: ids.length, confirmations: 0, matched: 0, agreed: 0, differed: 0, raised: 0, unmatched: 0, ambiguous: 0, since: from?.toISOString() ?? null, until: now.toISOString(), diffs: [], dryRun: !!opts.dryRun };
  const pos = (await opts.query(
    `SELECT p.id, p.supplier, p.order_id, p.order_total::float AS order_total, (SELECT COUNT(*)::int FROM po_line_items l WHERE l.po_id = p.id) AS line_count FROM purchase_orders p`,
  )).rows as PoFacts[];
  const suppliers = Array.from(new Set(pos.map((p) => p.supplier)));
  const domainMap = await loadDomainMap(opts.query), platforms = await loadPlatformSenders(opts.query);
  for (const id of ids) {
    const msg = await get(opts.deps.gmail, id);
    const p = parseConfirmationEmail(msg);
    if (!p.isConfirmation) continue;
    r.confirmations++;
    const supplier = resolveSupplier(p.senderDomain, domainMap, suppliers, platforms).supplier;
    const hits = findPoForConfirmation(p, pos, supplier);
    if (hits.length === 0) { r.unmatched++; continue; }
    if (hits.length > 1) { r.ambiguous++; continue; }
    const po = hits[0];
    r.matched++;
    const differences = compareConfirmation(p, po);
    if (differences.length === 0) { r.agreed++; continue; }
    r.differed++;
    r.diffs.push({ po_id: po.id, supplier: po.supplier, order_id: po.order_id, differences });
    if (opts.dryRun) continue;
    const lines = (await opts.query(`SELECT id FROM po_line_items WHERE po_id = $1`, [po.id])).rows;
    for (const l of lines) await insertLineItems(opts.query, String(l.id), [CONFIRM_ORDER_DETAILS], "auto", differences.join("; "));
    r.raised++;
  }
  if (!opts.dryRun) {
    await opts.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = NOW()`,
      [CONFIRM_WATERMARK_KEY, JSON.stringify({ last_scanned_at: now.toISOString() })],
    );
  }
  opts.log?.(`confirmations: scanned ${r.scanned}, confirmations ${r.confirmations}, matched ${r.matched} (agreed ${r.agreed}, differed ${r.differed}, raised ${r.raised}), unmatched ${r.unmatched}, ambiguous ${r.ambiguous}`);
  return r;
}

export async function readConfirmWatermark(query: QueryLike): Promise<Date | null> {
  const v = (await query(`SELECT value FROM settings WHERE key = $1`, [CONFIRM_WATERMARK_KEY])).rows[0]?.value;
  return v?.last_scanned_at ? new Date(v.last_scanned_at) : null;
}
