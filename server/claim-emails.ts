// Supplier emails → claims (claims commit 6; docs/claude_spec-patch-supplier-claims.md §3.11, the acceptance table,
// Maria 2026-11-13). Every row number below is §3.11's.
//
//   classify   the email's family from the known templates (§7): refund / credit confirmation (Walmart "You're getting a
//              $X refund", DK Hardware "Refund Issued for Order#", Home Depot "Credit Applied to Order", Michaels "You
//              received a gift card", the Shopify "Refund notification", generic "your refund … $X"), a return label /
//              pickup (Walmart), return progress, a replacement notice, a feedback request, a case-resolved notice, a
//              reply ("Re:" from the supplier), Maria's own email (the Sent folders of orders@ and maria@; a forward is
//              the forwarded email, read as incoming). Cancellation wording wins over refund wording: commit 5's finder
//              owns those. Order confirmations, shipping notices and gift-card purchases are noise, never a task.
//   match      the PO by order # (incl. alt_order_ids; a sender → supplier through the domain map / aliases, a platform
//              sender by the order # alone); in a reply from the supplier's own domain a SHORT id in the subject after
//              "Order" counts (Voltage 65705, Hardware World 8CMT9); a thread takes the PO another message of it named
//              (Maria's own email that started a Michaels case thread); Target's "order ending in NNNN" + supplier +
//              amount + 30-day window is "not sure" (row 2). An email attaches to ONE claim: with several open claims the
//              one whose amount the email names; otherwise row 2 / 7.
//   rows       1 exact refund / credit on an open claim (a SUGGESTED claim opens first — Maria 2026-11-13) → outcome,
//              supplier_confirmed_at, the refund row prefilled (outcome_amount / outcome_detail), no task;
//              2 not sure → review_email_match (Attach / Not this claim); 3 reply, no outcome → read_reply (Keep waiting /
//              Set outcome); 4 reply with an outcome → confirm_outcome; 5 refund on a PO with no claim → a suggested
//              claim; 6 return label → po_documents return_label + label_saved; 7 unknown sender naming an open claim's
//              order # → review_email_match + the detail's banner; 8 closed / dismissed claim → closed_claim_email
//              (feedback / case-resolved / return-progress notices attach quietly); 9 Maria's own email about an order
//              with one open claim → Contacted supplier; a supplier reply on a PO with no claim → a suggested claim
//              (Maria 2026-11-13); Maria's own email on a PO with no claim → nothing.
//   once       an email already on a claim (an event, a task or a claim's source_email_id with its gmail id) is never
//              applied twice; "Not this claim" / "Nothing to do" leave an email_dismissed event, so it is never proposed
//              again. A dry run writes nothing and never calls the AI.
//   AI         Haiku reads free text only from a known supplier or a thread already attached (the summary, a stated
//              outcome, an amount); recorded fixtures in tests, never a live call. Logged in po_prefill_log kind
//              'claim_email', ≤ CLAIM_EMAIL_AI_MAX_CALLS per pass.
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { gmail_v1, drive_v3 } from "googleapis";
import { AI, aiAvailable, anthropicClient, estimateCost } from "./config/ai";
import { logPrefill } from "./po-prefill";
import { listMessageIds, parseGmailMessage, GMAIL_SUBJECT, type GmailMessage } from "./gmail-client";
import { unwrapForwarded, classifyCancellation, cleanText, type EmailFacts } from "./cancellation-emails";
import { resolveSupplier, registrable, DOMAIN_MAP_KEY, PLATFORM_SENDERS_KEY, DEFAULT_PLATFORM_SENDERS, type PoRef } from "./tracking-match";
import { posNamedInText, orderTokens, normOrder, orderIdParts, matchOrderId } from "./order-number";
import { suggestClaim, existingClaims, type Suggestion } from "./claim-suggestions";
import { addTask, confirmSupplier, doneTask, recordContact, recordReply, logClaimEvent, stampEventEmail } from "./supplier-claims";
import { ensureMonthFolder, uploadPdf } from "./drive-client";
import { attachReturnLabel, readReturnEmail, type ReturnEmailReading } from "./claim-returns";
import { mdOf as mdIso } from "@shared/claim-bucket";
import { logEdits } from "./po-edit";
import type { QueryLike } from "./scheduler/types";

export const EMAIL_WATERMARK_KEY = "claims.email_watermark";
export const CLAIM_EMAIL_AI_MAX_CALLS = 25;
/** The mailboxes read: orders@ (received + Sent) and maria@ (Sent — her own emails to suppliers and her forwards). */
export const WATCHED_MAILBOXES = (): ReadonlyArray<{ mailbox: string; received: boolean; sent: boolean }> => [
  { mailbox: GMAIL_SUBJECT, received: true, sent: true },
  { mailbox: process.env.CLAIMS_SECOND_MAILBOX || "maria@coastalqualitygoods.com", received: false, sent: true },
];
const OVERLAP_MS = 6 * 3600 * 1000;
/** Supplier domains that write from another domain than the one AF buys from (§7: Voltage writes from voltagesupply.com). */
export const SUPPLIER_EMAIL_ALIASES: Readonly<Record<string, string>> = { "voltagesupply.com": "voltagecoffeesupply.com" };

// ── The email ────────────────────────────────────────────────────────────────

export interface EmailAttachment { filename: string; mimeType: string; attachmentId: string | null; size: number }
export interface ClaimEmail extends EmailFacts {
  id: string; mailbox: string; threadId: string | null;
  /** "in" = received; "sent" = Maria's own email (a forward from Sent is read as "in": the forwarded email). */
  direction: "in" | "sent";
  to: string; toDomain: string | null;
  attachments: EmailAttachment[];
}

/** Pure: the attachments of a Gmail payload (name, type, id), PDFs first. */
export function attachmentsOf(payload: gmail_v1.Schema$MessagePart | undefined): EmailAttachment[] {
  const out: EmailAttachment[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart | undefined) => {
    if (!p) return;
    if (p.filename && p.body) out.push({ filename: p.filename, mimeType: p.mimeType ?? "application/octet-stream", attachmentId: p.body.attachmentId ?? null, size: Number(p.body.size ?? 0) });
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  return out.sort((a, b) => Number(/pdf/i.test(b.mimeType) || /\.pdf$/i.test(b.filename)) - Number(/pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename)));
}
/** Pure: a raw Gmail message as the classifier reads it. */
export function toClaimEmail(raw: gmail_v1.Schema$Message, mailbox: string, direction: "in" | "sent"): ClaimEmail {
  const msg: GmailMessage = parseGmailMessage(raw);
  const headers = raw.payload?.headers ?? [];
  const to = headers.find((h) => (h.name ?? "").toLowerCase() === "to")?.value ?? "";
  const f = unwrapForwarded(msg);
  const sentForward = direction === "sent" && f.forwarded;
  return {
    ...f, id: String(raw.id), mailbox, threadId: msg.threadId ?? null,
    direction: sentForward ? "in" : direction,
    to, toDomain: (/@([^>\s,;]+)/.exec(to)?.[1] ?? "").toLowerCase() || null,
    attachments: attachmentsOf(raw.payload),
  };
}

// ── Classify ─────────────────────────────────────────────────────────────────

export type EmailFamily = "refund_credit" | "cancel" | "return_label" | "return_other" | "replacement" | "reply" | "feedback" | "case_resolved" | "claim_status" | "sent" | "noise";
export type RefundMethod = "refund_card" | "gift_card" | "store_credit";
export interface Classified {
  family: EmailFamily; template: string;
  amount: number | null; method: RefundMethod | null;
  /** Target: "order ending in NNNN". */
  last4: string | null;
  /** A PDF attachment (a return label). */
  labelPdf: EmailAttachment | null;
  /** Row 8's quiet kinds: attached without a task. */
  quiet: boolean;
}
const money = (s: string | null | undefined): number | null => { const m = /\$\s?([\d,]+\.\d{2})/.exec(s ?? ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
const LAST4 = /\border (?:ending|that ends) in (\d{4})\b/i;
/** Subjects of order / shipping / account notices — never a refund, whatever the body says (the 5 false hits of the dry run). */
const ORDER_NOISE = /(?:\border\b[^\n]{0,40}\bconfirmed\b|delayed|delivery order|your order(?: is| has|:|!| will| confirm)|your [a-z'’]+ order(?::|!| has| is| confirm)|thanks? (?:you )?for (?:your|ordering|placing)|we received your order|order confirm|got it!|shipped|out for delivery|delivered|review your order|substitution|preparing|is now complete|invoice|arriving|on its way|ready to ship|sign in|password|statement|receipt|welcome|newsletter|\bsale\b|% off|\bdeal\b|e-?gift card has been sent|received a [a-z &]+ e-?gift card|removal request|payment didn'?t|loyalty|rewards|points|your account|thanks for your purchase)/i;
const TEMPLATES: Array<[RegExp, EmailFamily, string]> = [
  [/you'?re getting a \$[\d,.]+ refund/i, "refund_credit", "walmart refund"],
  [/refund issued for order/i, "refund_credit", "dkhardware refund"],
  [/credit applied to order/i, "refund_credit", "homedepot credit"],
  [/^you received a gift card$/i, "refund_credit", "michaels gift card"],
  [/^refund notification$|your refund (?:is|has|was)|refund (?:has been|was) (?:issued|processed)|we'?ve (?:issued|processed) (?:your|a) refund|refund confirmation|refund for (?:your )?order|we credited your account|store credit (?:has been )?(?:issued|applied)|your store credit|credit memo/i, "refund_credit", "refund / credit template"],
  [/drop off your return|return (?:pickup|label)|print your return|your return label|return shipping label/i, "return_label", "return label / pickup"],
  [/we received your return|your return is complete|return (?:received|complete|processed)|reminder: your return/i, "return_other", "return progress"],
  [/replacement|reship/i, "replacement", "replacement / reship"],
  [/\b(?:feedback|how did we do|rate your|survey|how was your|tell us about)\b/i, "feedback", "feedback request"],
  [/\bcase\b.*\b(?:resolved|closed|been closed)\b|your (?:case|request|ticket) (?:has been|is) (?:resolved|closed)/i, "case_resolved", "case resolved"],
  [/your claim (?:was|is|has been)/i, "claim_status", "claim status"],
  [/^(?:re|fwd?|fw|aw)\s*:/i, "reply", "a reply in a thread"],
];
const REFUND_WORD = /\b(?:your refund|refund(?:ed)? (?:of|for|to|has|was|will)|been refunded|store credit|gift card|credit (?:memo|applied|issued)|we(?:'ve| have) (?:issued|processed|credited))\b/i;
const QUIET = new Set<EmailFamily>(["feedback", "case_resolved", "return_other"]);

/** Pure: family, template, amount, method, last 4, the label PDF. */
export function classifyClaimEmail(e: Pick<ClaimEmail, "subject" | "text" | "fromDomain" | "direction" | "attachments">): Classified {
  const subject = e.subject ?? "", text = cleanText(e.text ?? ""), head = text.slice(0, 3000);
  const labelPdf = e.attachments.find((a) => /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename)) ?? null;
  const base = { amount: money(subject) ?? money(text.slice(0, 6000)), last4: LAST4.exec(`${subject}\n${head}`)?.[1] ?? null, labelPdf, quiet: false };
  const method = (s: string): RefundMethod | null => (/gift card|e-?gift/i.test(s) ? "gift_card" : /store credit|credit applied|credited your account|credit memo/i.test(s) ? "store_credit" : /refund/i.test(s) ? "refund_card" : null);
  if (e.direction === "sent") return { ...base, family: "sent", template: "Maria's own email", method: null };
  // commit 5 owns cancellations (their refund wording is the cancellation's)
  const cancel = classifyCancellation({ subject, text, fromDomain: e.fromDomain });
  if (cancel.candidate && !/you'?re getting a \$[\d,.]+ refund|refund issued for order|credit applied to order/i.test(subject)) return { ...base, family: "cancel", template: cancel.matched, method: null };
  for (const [re, family, template] of TEMPLATES) if (re.test(subject)) return { ...base, family, template: `subject: ${template}`, method: family === "refund_credit" ? method(`${subject} ${head}`) : null, quiet: QUIET.has(family) };
  if (!ORDER_NOISE.test(subject) && REFUND_WORD.test(head) && base.amount != null) return { ...base, family: "refund_credit", template: "body: refund / credit wording + amount", method: method(head) };
  return { ...base, family: "noise", template: "no claim-related wording", method: null };
}

/** Pure: the outcome a reply states, by the known phrasings; null = none stated (Haiku may read it). */
export function statedOutcome(text: string): "replacement" | "refund" | "cant_help" | null {
  const t = cleanText(text).slice(0, 4000);
  if (/\b(?:replacement|reship|re-ship|resend|re-send|send (?:you |out )?(?:a |the )?new|ship(?:ping)? (?:out )?(?:a |the )?(?:new|replacement)|ships? out tomorrow)\b/i.test(t)) return "replacement";
  if (/\b(?:will (?:be )?(?:refund|credit)|refund(?:ed|ing)? (?:you|your|the)|issued a refund|process(?:ed|ing)? (?:a |the |your )?refund|credit(?:ed)? (?:your|the) (?:account|card)|money back)\b/i.test(t)) return "refund";
  if (/\b(?:unable to|cannot|can'?t|not able to|no longer|declined|denied|unfortunately we (?:do not|don'?t|can'?t))\b/i.test(t)) return "cant_help";
  return null;
}
/** Pure: the first meaningful line of a reply (the one-line summary the row shows), quote-stripped, ≤ 140 characters. */
export function firstLine(text: string): string {
  const lines = cleanText(text).split("\n").map((l) => l.trim()).filter((l) => l && !/^(?:>|On .* wrote:|From:|Sent:|To:|Subject:|Date:|-{3,}|hi\b|hello\b|dear\b|thank you for (?:contacting|reaching))/i.test(l));
  const l = lines[0] ?? "";
  return l.length > 140 ? `${l.slice(0, 137)}…` : l;
}

// ── Match ────────────────────────────────────────────────────────────────────

export interface ClaimRef {
  id: number; po_id: string; po_line_item_id: string | null; kind: string; status: string; outcome: string | null;
  amount_owed: number | null; remaining: number | null; reported_at: string | null; supplier_confirmed_at: string | null; source_email_id: string | null;
  /** A return on the claim (commit 7): a label / pickup / received email lands on it first. */
  return_required?: boolean;
}
export interface MatchContext {
  pos: readonly PoRef[]; claims: readonly ClaimRef[]; suppliers: readonly string[];
  domainMap: Record<string, string>; platforms: readonly string[];
  /** `${mailbox}:${threadId}` → the PO another message of the thread named. */
  threadPo: ReadonlyMap<string, PoRef>;
  /** Emails already on a claim (an event, a task, a claim's source) → never applied twice. */
  seen: ReadonlySet<string>;
  /** Emails Maria said are "not this claim" / "nothing to do": claim ids per email. */
  dismissed: ReadonlyMap<string, ReadonlySet<number>>;
}
export type EmailRowNo = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export interface EmailPlan {
  row: EmailRowNo | "noise" | "commit5" | "seen";
  label: string;
  /** What AF would set. */
  sets: string;
  why: string;
  po: PoRef | null;
  claim: ClaimRef | null;
  /** Row 1 / 2 (refund): the figures. */
  amount: number | null; method: RefundMethod | null;
  /** Row 3 / 4: the reply's summary and the outcome it states (Haiku may fill them). */
  summary: string | null; outcome: "replacement" | "refund" | "cant_help" | null;
  /** The AI would read this email (free text from a known supplier / an attached thread); the dry run never calls it. */
  needsAi: boolean;
  quiet: boolean;
  labelPdf: EmailAttachment | null;
  /** A return email's reading (commit 7, §3.12): the kind, the tracking #, the return-by / pickup date. */
  ret?: ReturnEmailReading | null;
}

const SHORT_ID_IN_SUBJECT = /\border\s*(?:#|no\.?|number)?\s*:?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/i;
/** Pure: the supplier's PO named by a short id in a reply's subject after "Order" (Maria 2026-11-13: Voltage 65705, Hardware World 8CMT9). */
export function poByShortSubjectId(subject: string, supplier: string, pos: readonly PoRef[]): PoRef | null {
  const m = SHORT_ID_IN_SUBJECT.exec(subject);
  if (!m) return null;
  const key = normOrder(m[1]);
  const hits = pos.filter((p) => p.supplier === supplier && orderIdParts(matchOrderId(p)).some((x) => normOrder(x) === key));
  return hits.length === 1 ? hits[0] : null;
}
const within1c = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= 0.0105; // within 1¢, float-safe
const daysApart = (a: Date, b: Date | string | null | undefined) => (b ? Math.abs(a.getTime() - new Date(b).getTime()) / 86_400_000 : Infinity);
const openOn = (ctx: MatchContext, poId: string) => ctx.claims.filter((c) => c.po_id === poId && c.status === "open");
const suggestedOn = (ctx: MatchContext, poId: string) => ctx.claims.filter((c) => c.po_id === poId && c.status === "suggested");
const closedOn = (ctx: MatchContext, poId: string) => ctx.claims.filter((c) => c.po_id === poId && (c.status === "closed" || c.status === "dismissed"));
const notDismissed = (ctx: MatchContext, emailId: string, cs: ClaimRef[]) => cs.filter((c) => !ctx.dismissed.get(emailId)?.has(c.id));
/** The claim an exact refund / credit email confirms: amount = remaining (else $ owed) within 1¢. */
const exactAmount = (cs: ClaimRef[], amount: number | null) => cs.filter((c) => within1c(amount, c.remaining ?? c.amount_owed));

/** Pure: the §3.11 row for one email and what AF would do. */
export function planClaimEmail(e: ClaimEmail, cls: Classified, ctx: MatchContext): EmailPlan {
  const base: EmailPlan = { row: "noise", label: "", sets: "", why: "", po: null, claim: null, amount: cls.amount, method: cls.method, summary: null, outcome: null, needsAi: false, quiet: cls.quiet, labelPdf: cls.labelPdf };
  if (ctx.seen.has(e.id)) return { ...base, row: "seen", label: "already on a claim", why: "the email is on a claim already" };
  if (cls.family === "cancel") return { ...base, row: "commit5", label: "cancellation (commit 5's finder)", why: cls.template };
  if (cls.family === "noise") return { ...base, label: "noise", why: cls.template };
  const sent = cls.family === "sent";
  const domain = sent ? e.toDomain : e.fromDomain;
  const map = { ...SUPPLIER_EMAIL_ALIASES, ...ctx.domainMap };
  const sup = resolveSupplier(domain, map, ctx.suppliers, ctx.platforms);
  const text = `${e.subject}\n${e.text}`;
  const scope = sup.supplier ? ctx.pos.filter((p) => p.supplier === sup.supplier) : ctx.pos;
  let po: PoRef | null = null; let how = "";
  const named = posNamedInText(text, scope, sup.supplier ? "supplier" : "any");
  if (named.length === 1) { po = named[0]; how = sup.supplier ? "order # + supplier" : "order # alone"; }
  else if (named.length > 1) how = `${named.length} POs named`;
  if (!po && sup.supplier && (cls.family === "reply" || sent)) { const s = poByShortSubjectId(e.subject, sup.supplier, ctx.pos); if (s) { po = s; how = "short order # in the subject"; } }
  if (!po && e.threadId && ctx.threadPo.has(`${e.mailbox}:${e.threadId}`)) { po = ctx.threadPo.get(`${e.mailbox}:${e.threadId}`)!; how = "the thread names the PO"; }
  const when = e.date.toISOString().slice(0, 10);
  const md = `${Number(when.slice(5, 7))}/${Number(when.slice(8, 10))}`;
  const quoted = `"${e.subject.length > 70 ? `${e.subject.slice(0, 67)}…` : e.subject}"`;

  // Row 9: Maria's own email to a supplier about an order with ONE open claim.
  if (sent) {
    if (!po) return { ...base, label: sup.supplier ? "Maria's email to a supplier, no PO named" : "sent, no PO named", why: how || "no order # in the email or its thread" };
    if (!sup.supplier) return { ...base, po, label: "sent, PO named, not to a supplier", why: how };
    const open = openOn(ctx, po.id);
    if (open.length === 1) return { ...base, row: 9, po, claim: open[0], label: "Maria's email to the supplier", why: how, summary: firstLine(e.text), sets: open[0].reported_at ? `Contacted supplier · from email (${md}) — a follow-up on #${open[0].id}` : `Contacted supplier · from email: reported ${when}, channel email, on #${open[0].id}` };
    if (open.length > 1) return { ...base, row: 2, po, label: "Maria's email, several open claims", why: `${how}; ${open.length} open claims on the PO`, summary: firstLine(e.text), sets: "review_email_match: which claim" };
    return { ...base, po, label: "Maria's email, PO has no open claim", why: how, sets: "nothing (no open claim)" };
  }

  // Row 7: an unknown sender naming an open claim's order # — nothing automatic, whatever the email says.
  if (!sup.supplier && !how.includes("thread")) { const r7 = row7(e, ctx, md, quoted); if (r7) return { ...base, ...r7 }; }

  // Refund / credit confirmations: rows 1, 2, 5, 8.
  if (cls.family === "refund_credit") {
    const amount = cls.amount;
    if (po) {
      const open = notDismissed(ctx, e.id, openOn(ctx, po.id)), sug = notDismissed(ctx, e.id, suggestedOn(ctx, po.id)), closed = closedOn(ctx, po.id);
      const exactOpen = exactAmount(open, amount), exactSug = exactAmount(sug, amount);
      if (exactOpen.length === 1 && how.startsWith("order #")) return { ...base, row: 1, po, claim: exactOpen[0], label: "refund / credit confirmation, exact match", why: `${how}; amount matches`, sets: `Confirmed by supplier ${when} · ${cls.method ?? "refund_card"} · refund row prefilled $${amount?.toFixed(2)} → Waiting on refund to post` };
      if (exactOpen.length === 0 && exactSug.length === 1 && how.startsWith("order #")) return { ...base, row: 1, po, claim: exactSug[0], label: "refund / credit confirmation, exact match on a suggested claim", why: `${how}; amount matches; the suggestion opens (Maria 2026-11-13)`, sets: `Opened from the supplier's refund email · Confirmed ${when} · ${cls.method ?? "refund_card"} · refund row prefilled $${amount?.toFixed(2)}` };
      const cands = [...open, ...sug];
      if (cands.length) return { ...base, row: 2, po, claim: cands[0], label: "refund / credit, not sure", why: `${how}; ${cands.length} claim(s), amount $${amount ?? "?"} vs ${cands.map((c) => c.remaining ?? c.amount_owed ?? "?").join(" / ")}`, sets: `review_email_match on #${cands[0].id}: "Email ${md} may be this claim's refund: ${quoted} · $${amount ?? "?"}"` };
      if (closed.length) return { ...base, row: 8, po, claim: closed[0], label: "refund / credit on a closed claim", why: how, sets: `closed_claim_email on #${closed[0].id}: Reopen / Nothing to do` };
      return { ...base, row: 5, po, label: "refund / credit, no claim on the PO", why: how, sets: `suggested claim (refund · from email) $${amount ?? "?"}: Open claim / Dismiss` };
    }
    // Target's last 4 (§3.5 fallback): supplier + last 4 + amount + 30-day window → not sure
    if (cls.last4 && sup.supplier) {
      const pos4 = scope.filter((p) => String(p.order_id).endsWith(cls.last4!) && daysApart(e.date, p.order_date) <= 60);
      const cands = notDismissed(ctx, e.id, pos4.flatMap((p) => [...openOn(ctx, p.id), ...suggestedOn(ctx, p.id)]));
      const byAmount = exactAmount(cands, amount);
      const pick = byAmount.length === 1 ? byAmount : cands;
      if (pick.length) return { ...base, row: 2, po: ctx.pos.find((p) => p.id === pick[0].po_id) ?? null, claim: pick[0], label: "refund / credit, Target's last 4", why: `last 4 ${cls.last4} + supplier${byAmount.length === 1 ? " + amount" : ""}, 60-day window`, sets: `review_email_match on #${pick[0].id}: "Email ${md} may be this claim's refund: "order ending in ${cls.last4}" · $${amount ?? "?"}"` };
    }
    // no order #: the supplier's one open claim with this amount, within 30 days
    if (sup.supplier && amount != null) {
      const cands = notDismissed(ctx, e.id, ctx.claims.filter((c) => c.status === "open" && scope.some((p) => p.id === c.po_id) && within1c(amount, c.remaining ?? c.amount_owed) && daysApart(e.date, scope.find((p) => p.id === c.po_id)?.order_date) <= 30));
      if (cands.length === 1) return { ...base, row: 2, po: scope.find((p) => p.id === cands[0].po_id) ?? null, claim: cands[0], label: "refund / credit, amount only", why: "no order #; the supplier's one open claim with this amount within 30 days", sets: `review_email_match on #${cands[0].id}: "Email ${md} may be this claim's refund: ${quoted} · $${amount.toFixed(2)}"` };
    }
    return { ...base, label: sup.supplier ? "refund / credit, PO not found" : "refund / credit from an unknown sender", why: how || (sup.supplier ? "no order # named" : "unknown sender, no order #") };
  }

  // Return label / progress: rows 6, 8 — and the return itself (commit 7, §3.12 rows 1 / 2 / 3 / 10): the label starts the
  // return on the claim (tracking #, carrier, return-by read by regex), a scheduled pickup / "we received your return" set
  // Shipped / Delivered from email, a pickup reminder fills the return-by date.
  if (cls.family === "return_label" || cls.family === "return_other") {
    if (!po) return { ...base, label: `${cls.family === "return_label" ? "return label" : "return progress"}, no PO`, why: how || "no order # named" };
    const open = notDismissed(ctx, e.id, openOn(ctx, po.id)), closed = closedOn(ctx, po.id);
    // the claim already on a return path first, else the PO's first open claim
    const target = open.find((c) => c.return_required) ?? open[0] ?? closed[0] ?? null;
    if (!target) return { ...base, po, label: `${cls.family === "return_label" ? "return label" : "return progress"}, PO without a claim`, why: how, sets: "nothing (no claim on the PO)" };
    const ret = readReturnEmail({ subject: e.subject, text: e.text, date: e.date });
    const read = [ret.trackingNumber ? `${ret.carrier ?? "?"} ${ret.trackingNumber}` : "no tracking #", ret.returnBy ? `return by ${mdIso(ret.returnBy)}` : "no return-by date", ret.pickupDate ? `pickup ${mdIso(ret.pickupDate)}` : null].filter(Boolean).join(", ");
    if (target.status === "open" && (ret.kind === "label" || ret.kind === "pickup" || ret.kind === "store")) {
      return { ...base, row: 6, po, claim: target, ret, label: ret.kind === "store" ? "store return (no label)" : ret.kind === "pickup" ? "return pickup scheduled" : "return label", why: `${how}; ${read}`,
        sets: `${cls.labelPdf ? `return_label document "${cls.labelPdf.filename}" on #${target.id}` : ret.kind === "store" ? `No label on #${target.id}` : `"Return label received · from email" on #${target.id} (no PDF attached)`} · return_required${ret.trackingNumber ? ` · return tracking ${ret.carrier ?? ""} ${ret.trackingNumber} (EasyPost)` : ""}${ret.returnBy ? ` · return by ${mdIso(ret.returnBy)}` : ""}${ret.pickupDate ? ` · Shipped ${mdIso(ret.pickupDate)} from email (the first scan corrects it)` : ""} · ${po.ships_to === "home" ? "drop_off_return" : "send_label"}` };
    }
    if (target.status === "open" && target.return_required && (ret.kind === "received" || ret.kind === "reminder")) {
      return { ...base, row: 6, po, claim: target, ret, label: ret.kind === "received" ? "return received by the supplier" : "return pickup reminder", why: `${how}; ${read}`,
        sets: ret.kind === "received" ? `Delivered ${md} · from email on #${target.id} (a hand-set or tracking date stands)` : `return by ${ret.returnBy ? mdIso(ret.returnBy) : "?"} on #${target.id} when none is set · attached quietly` };
    }
    return { ...base, row: 8, po, claim: target, quiet: true, ret, label: `${cls.template.replace("subject: ", "")} on #${target.id} (${target.status}) — quiet`, why: how, sets: `timeline entry on #${target.id}, no task` };
  }

  // Feedback / case resolved: attached quietly to the claim (open or closed), row 8's quiet kinds.
  if (cls.family === "feedback" || cls.family === "case_resolved") {
    if (!po) return { ...base, label: `${cls.family}, no PO`, why: how || "no order # named" };
    const target = openOn(ctx, po.id)[0] ?? closedOn(ctx, po.id)[0] ?? null;
    if (!target) return { ...base, po, label: `${cls.family}, PO without a claim`, why: how };
    return { ...base, row: 8, po, claim: target, quiet: true, label: `${cls.family.replace("_", " ")} on #${target.id} (${target.status}) — quiet`, why: how, sets: `timeline entry on #${target.id}, no task` };
  }

  // Replies, replacement notices, claim status: rows 3, 4, 7, 8, and the no-claim suggestion.
  const stated = cls.family === "replacement" ? "replacement" : statedOutcome(e.text);
  const summary = firstLine(e.text) || e.subject;
  if (!po) return { ...base, label: sup.supplier ? `${cls.family}, PO not found` : `${cls.family} from an unknown sender`, why: how || (sup.supplier ? "no order # in the email, its subject or its thread" : "unknown sender, no order #"), needsAi: false };
  const open = notDismissed(ctx, e.id, openOn(ctx, po.id)), closed = closedOn(ctx, po.id);
  const known = !!sup.supplier || how.includes("thread");
  if (open.length === 1) {
    const c = open[0];
    if (stated) return { ...base, row: 4, po, claim: c, label: "supplier reply with an outcome", why: `${how}; states ${stated}`, summary, outcome: stated, needsAi: false, sets: `Supplier replied ${md} · from email → outcome suggested: ${stated === "cant_help" ? "write-off" : stated} → confirm_outcome on #${c.id}` };
    return { ...base, row: 3, po, claim: c, label: "supplier reply on an open claim", why: how, summary, needsAi: known && cls.family === "reply", sets: `Supplier replied ${md} · from email → read_reply on #${c.id} (Keep waiting / Set outcome)${known && cls.family === "reply" ? "; Haiku reads the outcome" : ""}` };
  }
  if (open.length > 1) return { ...base, row: 7, po, claim: open[0], label: "reply, several open claims", why: `${how}; ${open.length} open claims`, summary, sets: `review_email_match on each: "An email may belong to this claim" (Attach / Not this claim)` };
  if (closed.length) return { ...base, row: 8, po, claim: closed[0], label: `${cls.family} on a closed claim`, why: how, summary, sets: `closed_claim_email on #${closed[0].id}: "New email on a closed claim ${md}: ${quoted}" (Reopen / Nothing to do)` };
  if (sup.supplier && cls.family !== "replacement") return { ...base, row: 3, po, label: "supplier reply on a PO with no claim", why: how, summary, sets: `suggested claim on the PO: "Supplier email on a PO with no claim · ${md}: ${quoted}" (Open claim / Dismiss)` };
  return { ...base, po, label: `${cls.family}, PO without a claim`, why: how, sets: "nothing" };
}
/** Row 7: an unknown sender whose email names an open claim's order # (any supplier's POs, 8+ characters or letters + digits). */
function row7(e: ClaimEmail, ctx: MatchContext, md: string, quoted: string): Partial<EmailPlan> | null {
  const named = posNamedInText(`${e.subject}\n${e.text}`, ctx.pos, "any");
  const open = named.flatMap((p) => notDismissed(ctx, e.id, openOn(ctx, p.id)));
  if (open.length === 0) return null;
  const c = open[0];
  return { row: 7, po: named.find((p) => p.id === c.po_id) ?? null, claim: c, label: "unknown sender naming an open claim's order #", why: `${e.fromDomain ?? "?"} is no known supplier; the order # is in the text`, summary: firstLine(e.text) || e.subject, sets: `review_email_match on #${c.id} + the banner "An email may belong to this claim" (Attach / Not this claim)` };
}

// ── AI (free text) ───────────────────────────────────────────────────────────

const AiReplySchema = z.object({
  summary: z.string().describe("one line, what the supplier says, in their words where possible"),
  outcome: z.enum(["replacement", "refund", "cant_help", "none"]).describe("the outcome the reply states: a replacement / reship, a refund or credit, that they cannot help, or none stated"),
  amount: z.number().nullable().describe("a dollar amount the reply states for a refund or credit, else null"),
});
export type AiReply = z.infer<typeof AiReplySchema>;
export const AI_REPLY_SYSTEM = `You read one email a supplier sent about a problem with an order (missing, damaged, never received, canceled units). Say in one line what they say, whether they state an outcome, and any dollar amount.
- summary: one plain line (≤ 140 characters) — their answer, not a greeting.
- outcome: "replacement" if they will ship replacement / missing units; "refund" if they will refund or credit; "cant_help" if they decline or cannot help; "none" if no outcome is stated (a case opened, a question back, an acknowledgement).
- amount: a dollar amount they state for a refund / credit, else null.`;
export type ClaimEmailAiCall = (subject: string, text: string) => Promise<AiReply & { input_tokens: number; output_tokens: number }>;
const defaultAi: ClaimEmailAiCall = async (subject, text) => {
  const res = await anthropicClient().messages.parse({
    model: AI.model, max_tokens: 600, output_config: { effort: AI.effort, format: zodOutputFormat(AiReplySchema) },
    system: AI_REPLY_SYSTEM, messages: [{ role: "user", content: `Subject: ${subject}\n\n${text.slice(0, 12000)}` }],
  });
  const parsed = AiReplySchema.safeParse(res.parsed_output);
  if (!parsed.success) throw new Error(`schema: ${parsed.error.message.slice(0, 200)}`);
  return { ...parsed.data, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
};
/** Pure: the AI's reading folded into a row-3 plan — an outcome stated makes it row 4. */
export function applyAiReply(p: EmailPlan, ai: AiReply): EmailPlan {
  const summary = ai.summary.trim() || p.summary;
  const outcome = ai.outcome === "none" ? null : ai.outcome;
  if (!outcome || p.row !== 3 || !p.claim) return { ...p, summary, needsAi: false };
  const md = p.sets.match(/Supplier replied (\d+\/\d+)/)?.[1] ?? "";
  return { ...p, row: 4, summary, outcome, amount: ai.amount ?? p.amount, needsAi: false, label: "supplier reply with an outcome (AI)", sets: `Supplier replied ${md} · from email → outcome suggested: ${outcome === "cant_help" ? "write-off" : outcome} → confirm_outcome on #${p.claim.id}` };
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface ApplyDeps {
  gmail?: gmail_v1.Gmail;
  drive?: drive_v3.Drive | null;
  /** Row 6: where the label PDF goes (default: the Invoices month folder in Drive); tests hand in a stub. */
  saveLabel?: (name: string, pdf: Buffer, when: string) => Promise<{ id: string; bytes: number }>;
  /** Row 6: the label PDF's bytes (tests hand them in). */
  attachment?: (e: ClaimEmail, a: EmailAttachment) => Promise<Buffer | null>;
  log?: (m: string) => void;
}
const quoteSubject = (s: string) => `"${s.length > 90 ? `${s.slice(0, 87)}…` : s}"`;
const mdOf = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);

const stampEvent = (query: QueryLike, claimId: number, type: string, e: ClaimEmail, summary?: string | null) => stampEventEmail(query, claimId, type, { id: e.id, mailbox: e.mailbox }, summary);
/** A task made by an email: kind, the sentence (reason), the email and the facts the decision needs. */
async function emailTask(query: QueryLike, claimId: number, kind: "read_reply" | "review_email_match" | "closed_claim_email", reason: string, e: ClaimEmail, payload: Record<string, unknown>): Promise<void> {
  await addTask(query, claimId, kind, reason);
  await query(`UPDATE supplier_claim_tasks SET gmail_message_id = $3, mailbox = $4, payload = $5::jsonb WHERE claim_id = $1 AND kind = $2 AND done_at IS NULL`, [claimId, kind, e.id, e.mailbox, JSON.stringify(payload)]);
}
export interface AppliedEmail { row: EmailPlan["row"]; claim_id: number | null; what: string }

/** Apply one plan (never on a dry run). Idempotent: an email already on a claim does nothing. */
export async function applyEmailPlan(query: QueryLike, e: ClaimEmail, p: EmailPlan, deps: ApplyDeps = {}): Promise<AppliedEmail> {
  const seen = (await query(`SELECT 1 FROM supplier_claim_events WHERE gmail_message_id = $1 UNION ALL SELECT 1 FROM supplier_claim_tasks WHERE gmail_message_id = $1 UNION ALL SELECT 1 FROM supplier_claims WHERE source_email_id = $1 LIMIT 1`, [e.id])).rows.length > 0;
  if (seen) return { row: "seen", claim_id: p.claim?.id ?? null, what: "already on a claim" };
  const when = ymdOf(e.date), md = mdOf(e.date), subject = quoteSubject(e.subject);
  const payload = { subject: e.subject, date: when, from: e.fromDomain ?? e.from, amount: p.amount, method: p.method, summary: p.summary, outcome: p.outcome, last4: null as string | null };
  switch (p.row) {
    case 1: {
      const c = p.claim!;
      const method = p.method ?? "refund_card";
      if (c.status === "suggested") {
        await query(`UPDATE supplier_claims SET status = 'open', updated_at = now() WHERE id = $1 AND status = 'suggested'`, [c.id]);
        await query(`UPDATE supplier_claim_tasks SET done_at = now(), done_by = NULL WHERE claim_id = $1 AND kind = 'review_suggestion' AND done_at IS NULL`, [c.id]);
        await logClaimEvent(query, c.id, "opened", "Opened from the supplier's refund email", null);
        await logEdits(query, c.po_id, null, "claim", String(c.id), [{ field: "claim opened", old: "suggested", new: `open — the supplier's refund email ${subject}` }]);
      }
      await confirmSupplier(query, c.id, { at: when, outcome: method, amount: p.amount, detail: refundDetail(e, method) }, null);
      await stampEvent(query, c.id, "supplier_confirmed", e, `$${(p.amount ?? 0).toFixed(2)} · ${subject} · order # and amount match`);
      return { row: 1, claim_id: c.id, what: `confirmed ${method} $${p.amount?.toFixed(2)} on #${c.id}` };
    }
    case 2: case 7: {
      const c = p.claim!;
      const reason = p.row === 7 || p.summary && p.amount == null
        ? `An email may belong to this claim · ${md} · ${e.fromDomain ?? e.from} · ${subject}${p.amount != null ? ` · $${p.amount.toFixed(2)}` : ""}`
        : `Email ${md} may be this claim's refund: ${quoteSubject(e.subject)} · $${p.amount?.toFixed(2) ?? "?"}`;
      // row 2's Attach confirms the refund (row 1 applies); row 7's Attach adds the email as a supplier reply, nothing else (the mockup's banner)
      await emailTask(query, c.id, "review_email_match", reason, e, { ...payload, kind: p.row === 2 && p.amount != null && p.method ? "refund" : "reply" });
      await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, gmail_message_id, mailbox) VALUES ($1, 'email_review', $2, NULL, $3, $4)`, [c.id, reason, e.id, e.mailbox]);
      return { row: p.row, claim_id: c.id, what: `review_email_match on #${c.id}` };
    }
    case 3: case 4: {
      if (!p.claim) {
        // a supplier reply on a PO with no claim (Maria 2026-11-13): a suggested claim under Decide
        const s: Suggestion = { po_id: p.po!.id, order_id: p.po!.order_id, supplier: p.po!.supplier, po_line_item_id: null, kind: "missing", qty: null, amount: null,
          reason: `Supplier email on a PO with no claim · ${md}: ${subject}`, key: `email:${e.id}`, found_by: "email", source_email_id: e.id, note: p.summary, rule: "supplier_email_no_claim" };
        const o = await suggestClaim(query, s);
        if (o.created && o.id != null) await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, gmail_message_id, mailbox) VALUES ($1, 'email_attached', $2, NULL, $3, $4)`, [o.id, `${subject} · from email`, e.id, e.mailbox]);
        return { row: 3, claim_id: o.id, what: o.created ? `suggested claim #${o.id} on ${p.po!.supplier} ${p.po!.order_id}` : `not suggested (${o.why})` };
      }
      const c = p.claim;
      const outcome = p.outcome === "cant_help" ? "write_off" : p.outcome === "refund" ? (p.method ?? "refund_card") : p.outcome;
      await recordReply(query, c.id, { date: when, channel: "email", summary: p.summary ?? e.subject }, null, { task: p.row === 4 ? "confirm_outcome" : "read_reply", suggestedOutcome: outcome, suggestedAmount: p.amount });
      await stampEvent(query, c.id, "supplier_reply", e, `${p.summary ? quoteSubject(p.summary) : subject}${p.row === 4 ? ` → outcome suggested: ${outcome === "write_off" ? "write-off" : outcome?.replace("_", " ")}` : ""}`);
      await query(`UPDATE supplier_claim_tasks SET gmail_message_id = $3, mailbox = $4, payload = $5::jsonb WHERE claim_id = $1 AND kind = $2 AND done_at IS NULL`, [c.id, p.row === 4 ? "confirm_outcome" : "read_reply", e.id, e.mailbox, JSON.stringify({ ...payload, kind: "reply" })]);
      return { row: p.row, claim_id: c.id, what: `${p.row === 4 ? "confirm_outcome" : "read_reply"} on #${c.id}` };
    }
    case 5: {
      const items = emailItemCount(e.subject);
      const s: Suggestion = { po_id: p.po!.id, order_id: p.po!.order_id, supplier: p.po!.supplier, po_line_item_id: null, kind: "canceled", qty: null, amount: p.amount,
        reason: `${subject} ${md} · no claim on this PO yet`, key: `refund:${e.id}`, found_by: "email", confirmed_at: when, source_email_id: e.id, note: `refund · from email${p.method ? ` · ${p.method.replace("_", " ")}` : ""}`, source_items_json: items ? { items } : null, rule: "refund_email_no_claim" };
      const o = await suggestClaim(query, s);
      return { row: 5, claim_id: o.id, what: o.created ? `suggested refund claim #${o.id}` : `not suggested (${o.why})` };
    }
    case 6: {
      const c = p.claim!;
      const ret = p.ret ?? readReturnEmail({ subject: e.subject, text: e.text, date: e.date });
      const email = { id: e.id, mailbox: e.mailbox, subject: e.subject };
      // row 10: "we received your return" → Delivered from email (never over a hand-set or tracking date); a pickup reminder fills the return-by date
      if (ret.kind === "received" || ret.kind === "reminder") {
        const cur = (await query(`SELECT return_delivered_at, return_delivered_source, return_by::text AS return_by, return_by_source FROM supplier_claims WHERE id = $1`, [c.id])).rows[0];
        if (ret.kind === "received" && cur && (cur.return_delivered_at == null || cur.return_delivered_source === "email")) {
          await query(`UPDATE supplier_claims SET return_delivered_at = $2::timestamptz, return_delivered_source = 'email', updated_at = now() WHERE id = $1`, [c.id, e.date.toISOString()]);
          await query(`INSERT INTO supplier_claim_events (claim_id, at, type, summary, by, gmail_message_id, mailbox) VALUES ($1, $2::timestamptz, 'return_delivered', $3, NULL, $4, $5)`, [c.id, e.date.toISOString(), `${subject} · from email`, e.id, e.mailbox]);
          await logEdits(query, c.po_id, null, "claim", String(c.id), [{ field: "claim return_delivered_at", old: cur.return_delivered_at ? new Date(cur.return_delivered_at).toISOString().slice(0, 10) : null, new: `${when} (email)` }]);
          return { row: 6, claim_id: c.id, what: `return delivered ${md} from email on #${c.id}` };
        }
        if (ret.kind === "reminder" && ret.returnBy && cur && cur.return_by_source !== "manual" && cur.return_by !== ret.returnBy) {
          await query(`UPDATE supplier_claims SET return_by = $2::date, return_by_source = 'email', return_by_warned = NULL, updated_at = now() WHERE id = $1`, [c.id, ret.returnBy]);
          await logEdits(query, c.po_id, null, "claim", String(c.id), [{ field: "claim return_by", old: cur.return_by, new: ret.returnBy }]);
        }
        await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, gmail_message_id, mailbox) VALUES ($1, 'email_attached', $2, NULL, $3, $4)`, [c.id, `${subject} · ${md} · from email${ret.returnBy && ret.kind === "reminder" ? ` · return by ${mdIso(ret.returnBy)}` : ""}`, e.id, e.mailbox]);
        return { row: 6, claim_id: c.id, what: `${ret.kind === "received" ? "return received (a hand-set / tracking date stands)" : "pickup reminder"} attached to #${c.id}` };
      }
      // rows 1 / 2 / 3: the label (its PDF saved as a return_label document), the tracking # and the return-by date, the return started on the claim
      let docId: number | null = null, what = "label linked";
      const save = deps.saveLabel ?? (deps.drive ? async (name: string, pdf: Buffer, ymd: string) => uploadPdf(deps.drive!, (await ensureMonthFolder(deps.drive!, ymd)).id, name, pdf) : null);
      if (p.labelPdf && save && (deps.attachment || deps.gmail)) {
        const bytes = deps.attachment ? await deps.attachment(e, p.labelPdf) : await fetchAttachment(deps.gmail!, e.id, p.labelPdf);
        if (bytes) {
          const name = `${when}_${p.po!.supplier}_${p.po!.order_id}_return-label.pdf`;
          const up = await save(name, bytes, when);
          const row = (await query(`INSERT INTO po_documents (po_id, type, gmail_message_id, drive_file_id, file_name, bytes, document_at, source, claim_id) VALUES ($1, 'return_label', $2, $3, $4, $5, $6, 'email', $7) RETURNING id`, [p.po!.id, e.id, up.id, name, up.bytes, e.date, c.id])).rows[0];
          docId = Number(row.id); what = `return_label document ${name}`;
        }
      }
      const labelSource = docId ? "email" : ret.kind === "store" || !ret.trackingNumber ? "none" : "email";
      const a = await attachReturnLabel(query, c.id, { labelSource, labelAt: e.date.toISOString(), docId, carrier: ret.carrier, trackingNumber: ret.trackingNumber, returnBy: ret.returnBy, returnBySource: "email", pickupDate: ret.pickupDate, email, trackingSource: "regex", note: ret.kind === "store" ? "store return" : null }, null);
      return { row: 6, claim_id: c.id, what: `${what} on #${c.id}${a.tracking_id ? ` · return tracking ${ret.carrier ?? ""} ${ret.trackingNumber}` : ""}${a.return_by ? ` · return by ${mdIso(a.return_by)}` : ""}${a.task ? ` · ${a.task}` : ""}` };
    }
    case 8: {
      const c = p.claim!;
      if (p.quiet) {
        await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, gmail_message_id, mailbox) VALUES ($1, 'email_attached', $2, NULL, $3, $4)`, [c.id, `${subject} · ${md} · from email`, e.id, e.mailbox]);
        return { row: 8, claim_id: c.id, what: `attached quietly to #${c.id}` };
      }
      const reason = `New email on a closed claim ${md}: ${subject}`;
      await emailTask(query, c.id, "closed_claim_email", reason, e, { ...payload, kind: p.amount != null && p.method ? "refund" : "reply" });
      await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, gmail_message_id, mailbox) VALUES ($1, 'email_review', $2, NULL, $3, $4)`, [c.id, reason, e.id, e.mailbox]);
      return { row: 8, claim_id: c.id, what: `closed_claim_email on #${c.id}` };
    }
    case 9: {
      const c = p.claim!;
      const note = p.summary || e.subject;
      const open = (await query(`SELECT id, kind FROM supplier_claim_tasks WHERE claim_id = $1 AND done_at IS NULL AND kind IN ('follow_up_supplier', 'contact_supplier')`, [c.id])).rows as Array<{ id: number; kind: string }>;
      const followUp = open.find((t) => t.kind === "follow_up_supplier");
      if (c.reported_at && followUp) {
        await doneTask(query, Number(followUp.id), null, { date: when, channel: "email", note });
        await stampEvent(query, c.id, "followed_up", e, `email · ${when} · ${note} · from email`);
        return { row: 9, claim_id: c.id, what: `followed up #${c.id} from email` };
      }
      await recordContact(query, c.id, { date: when, channel: "email", note }, null);
      await stampEvent(query, c.id, "reported", e, `email · ${when} · ${note} · from email`);
      return { row: 9, claim_id: c.id, what: `contacted supplier on #${c.id} from email` };
    }
    default:
      return { row: p.row, claim_id: null, what: "nothing" };
  }
}
/** Pure: how many items a refund subject names — Walmart "[item]" is one, "[item] +2 items" three; 0 when it says nothing. */
export function emailItemCount(subject: string): number {
  const bracket = /\[[^\]]+\]/.test(subject) ? 1 : 0;
  const more = /\+(\d+) items?\b/i.exec(subject);
  return bracket + (more ? Number(more[1]) : 0);
}
/** "CapitalOne ••6830" when the email prints the card; else the method word. */
function refundDetail(e: ClaimEmail, method: RefundMethod): string {
  const m = /(?:ending in|ending|last four|\*{2,}|••)\s*(\d{4})\b/i.exec(e.text);
  return `${method === "gift_card" ? "gift card" : method === "store_credit" ? "store credit" : "card"}${m ? ` ••${m[1]}` : ""} · from email`;
}
async function fetchAttachment(gmail: gmail_v1.Gmail, messageId: string, a: EmailAttachment): Promise<Buffer | null> {
  if (!a.attachmentId) return null;
  const r = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: a.attachmentId });
  const data = r.data.data;
  return data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64") : null;
}

// ── The ingest (component 30 and the backfill) ───────────────────────────────

export interface ClaimEmailDeps {
  gmailFor: (mailbox: string) => gmail_v1.Gmail;
  list?: typeof listMessageIds;
  get?: (gmail: gmail_v1.Gmail, id: string) => Promise<gmail_v1.Schema$Message>;
  ai?: ClaimEmailAiCall;
  drive?: drive_v3.Drive | null;
}
export interface ClaimEmailReportRow {
  gmail_message_id: string; mailbox: string; direction: string; date: string; sender: string; to: string; subject: string;
  family: string; template: string; row: string; label: string; po: string | null; claim_id: number | null; claim_status: string | null; amount: number | null; sets: string; why: string; needs_ai: boolean; applied: string | null;
}
export interface ClaimEmailReport { scanned: number; rows: ClaimEmailReportRow[]; counts: Record<string, number>; ai_calls: number; ai_skipped: number; cost: number; applied: number; /** Mailboxes the hourly pass left alone: no watermark yet (requireWatermark). */ skipped_mailboxes: string[] }
const SEARCH_TERMS = `(refund OR refunded OR credit OR "gift card" OR return OR replacement OR reship OR case OR claim OR feedback OR resolved OR survey OR "Re:" OR "RE:")`;

export async function readEmailWatermark(query: QueryLike): Promise<Record<string, string>> {
  const v = (await query(`SELECT value FROM settings WHERE key = $1`, [EMAIL_WATERMARK_KEY])).rows[0]?.value;
  return v && typeof v === "object" ? v : {};
}
export async function loadMatchContext(query: QueryLike): Promise<Omit<MatchContext, "threadPo">> {
  const settings = (await query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [[DOMAIN_MAP_KEY, PLATFORM_SENDERS_KEY]])).rows;
  const domainMap = (settings.find((s: any) => s.key === DOMAIN_MAP_KEY)?.value ?? {}) as Record<string, string>;
  const platforms = (settings.find((s: any) => s.key === PLATFORM_SENDERS_KEY)?.value as string[] | undefined) ?? DEFAULT_PLATFORM_SENDERS;
  const pos: PoRef[] = (await query(`SELECT p.id, p.supplier, p.order_id, p.order_date::text AS order_date, p.alt_order_ids, p.ships_to, (p.closed_at IS NOT NULL) AS closed FROM purchase_orders p`)).rows
    .map((x: any) => ({ id: String(x.id), supplier: String(x.supplier), order_id: String(x.order_id), order_date: x.order_date, alt_order_ids: x.alt_order_ids, ships_to: x.ships_to, closed: x.closed }));
  const claims: ClaimRef[] = (await query(`SELECT c.id, c.po_id, c.po_line_item_id, c.kind, c.status, c.outcome, c.amount_owed, c.reported_at::text AS reported_at, c.supplier_confirmed_at::text AS supplier_confirmed_at, c.source_email_id, c.return_required,
      GREATEST(0, COALESCE(c.amount_owed, 0) - COALESCE((SELECT SUM(COALESCE(x.amount_applied, r.amount)) FROM supplier_claim_refunds x JOIN po_line_refunds r ON r.id = x.po_line_refund_id WHERE x.claim_id = c.id), 0)) AS remaining
    FROM supplier_claims c`)).rows.map((c: any) => ({ ...c, id: Number(c.id), po_id: String(c.po_id), po_line_item_id: c.po_line_item_id == null ? null : String(c.po_line_item_id), amount_owed: c.amount_owed == null ? null : Number(c.amount_owed), remaining: c.amount_owed == null ? null : Number(c.remaining) }));
  const seen = new Set<string>();
  for (const r of (await query(`SELECT gmail_message_id AS id FROM supplier_claim_events WHERE gmail_message_id IS NOT NULL UNION SELECT gmail_message_id FROM supplier_claim_tasks WHERE gmail_message_id IS NOT NULL UNION SELECT source_email_id FROM supplier_claims WHERE source_email_id IS NOT NULL`)).rows) seen.add(String(r.id));
  const dismissed = new Map<string, Set<number>>();
  for (const r of (await query(`SELECT gmail_message_id AS id, claim_id FROM supplier_claim_events WHERE type = 'email_dismissed' AND gmail_message_id IS NOT NULL`)).rows) { const k = String(r.id); if (!dismissed.has(k)) dismissed.set(k, new Set()); dismissed.get(k)!.add(Number(r.claim_id)); }
  // a dismissed email is not "seen": it may belong to another claim; the dismissal keeps it off that one
  for (const k of Array.from(dismissed.keys())) seen.delete(k);
  return { pos, claims, suppliers: Array.from(new Set(pos.map((p) => p.supplier))), domainMap, platforms, seen, dismissed };
}
/** Pure: `${mailbox}:${threadId}` → the one PO a message of the thread names. */
export function threadPoMap(emails: ReadonlyArray<ClaimEmail>, pos: readonly PoRef[]): Map<string, PoRef> {
  const out = new Map<string, PoRef>();
  for (const e of emails) {
    if (!e.threadId) continue;
    const hits = posNamedInText(`${e.subject}\n${e.text}`, pos, "any");
    if (hits.length === 1) out.set(`${e.mailbox}:${e.threadId}`, hits[0]);
  }
  return out;
}

export async function ingestClaimEmails(opts: { query: QueryLike; deps: ClaimEmailDeps; now?: Date; since?: Date | null; dryRun?: boolean; maxMessages?: number; log?: (m: string) => void; mailboxes?: ReadonlyArray<{ mailbox: string; received: boolean; sent: boolean }>;
  /** The hourly pass (component 30): a mailbox with no watermark yet is skipped — the first live backfill (row 10, Maria's approval) sets it; the pass never reads a mailbox's whole history on its own. */
  requireWatermark?: boolean }): Promise<ClaimEmailReport> {
  const { query } = opts;
  const now = opts.now ?? new Date();
  const list = opts.deps.list ?? listMessageIds;
  const get = opts.deps.get ?? (async (g: gmail_v1.Gmail, id: string) => (await g.users.messages.get({ userId: "me", id, format: "full" })).data);
  const marks = await readEmailWatermark(query);
  const r: ClaimEmailReport = { scanned: 0, rows: [], counts: {}, ai_calls: 0, ai_skipped: 0, cost: 0, applied: 0, skipped_mailboxes: [] };
  const emails: ClaimEmail[] = [];
  const read: Array<{ mailbox: string; received: boolean; sent: boolean }> = [];
  for (const mb of opts.mailboxes ?? WATCHED_MAILBOXES()) {
    if (opts.requireWatermark && !marks[mb.mailbox]) { r.skipped_mailboxes.push(mb.mailbox); opts.log?.(`claim emails: ${mb.mailbox} has no watermark yet — waiting for the first live backfill (npm run claims:emails -- --live)`); continue; }
    read.push(mb);
    const since = opts.since !== undefined ? opts.since : marks[mb.mailbox] ? new Date(marks[mb.mailbox]) : null;
    const from = since ? new Date(since.getTime() - OVERLAP_MS) : null;
    const after = from ? ` after:${Math.floor(from.getTime() / 1000)}` : "";
    let gmail: gmail_v1.Gmail;
    try { gmail = opts.deps.gmailFor(mb.mailbox); } catch (err: any) { opts.log?.(`claim emails: ${mb.mailbox} not readable: ${err?.message ?? err}`); continue; }
    const ids: Array<[string, "in" | "sent"]> = [];
    if (mb.received) for (const id of await list(gmail, `-category:promotions -in:sent${after} ${SEARCH_TERMS}`, opts.maxMessages ?? 2000)) ids.push([id, "in"]);
    if (mb.sent) for (const id of await list(gmail, `in:sent${after}`, opts.maxMessages ?? 1000)) ids.push([id, "sent"]);
    for (const [id, direction] of ids) {
      try { emails.push(toClaimEmail(await get(gmail, id), mb.mailbox, direction)); } catch (err: any) { opts.log?.(`claim emails: ${mb.mailbox} ${id}: ${err?.message ?? err}`); }
    }
  }
  r.scanned = emails.length;
  const base = await loadMatchContext(query);
  const ctx: MatchContext = { ...base, threadPo: threadPoMap(emails, base.pos) };
  const ai = opts.deps.ai ?? defaultAi;
  // oldest first: a thread's earlier message may place the later one
  emails.sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const e of emails) {
    const cls = classifyClaimEmail(e);
    let p = planClaimEmail(e, cls, ctx);
    if (p.needsAi) {
      if (opts.dryRun || !aiAvailable() || r.ai_calls >= CLAIM_EMAIL_AI_MAX_CALLS) r.ai_skipped++;
      else {
        r.ai_calls++;
        const t0 = Date.now();
        try {
          const a = await ai(e.subject, e.text);
          const cost = estimateCost(a.input_tokens, a.output_tokens);
          r.cost += cost;
          await logPrefill(query, { user_id: null, kind: "claim_email", retailer: e.fromDomain ?? null, input_chars: e.text.length, input_tokens: a.input_tokens, output_tokens: a.output_tokens, cost_estimate: cost, duration_ms: Date.now() - t0, schema_ok: true, error: null });
          p = applyAiReply(p, a);
        } catch (err: any) {
          await logPrefill(query, { user_id: null, kind: "claim_email", retailer: e.fromDomain ?? null, input_chars: e.text.length, input_tokens: 0, output_tokens: 0, cost_estimate: 0, duration_ms: Date.now() - t0, schema_ok: false, error: String(err?.message ?? err).slice(0, 300) });
          opts.log?.(`claim email AI failed for ${e.id}: ${err?.message ?? err}`);
        }
      }
    }
    const rowKey = String(p.row);
    if (p.row !== "noise") r.counts[rowKey] = (r.counts[rowKey] ?? 0) + 1;
    let applied: string | null = null;
    if (!opts.dryRun && typeof p.row === "number") {
      try {
        const a = await applyEmailPlan(query, e, p, { gmail: opts.deps.gmailFor(e.mailbox), drive: opts.deps.drive ?? null, log: opts.log });
        applied = a.what; if (a.row !== "seen") r.applied++;
        // the context follows the writes within the pass: a claim opened / suggested / confirmed changes the next email's row
        if (a.claim_id != null) {
          (ctx.seen as Set<string>).add(e.id);
          const fresh = (await query(`SELECT id, po_id, po_line_item_id, kind, status, outcome, amount_owed, reported_at::text AS reported_at, supplier_confirmed_at::text AS supplier_confirmed_at, source_email_id, return_required FROM supplier_claims WHERE id = $1`, [a.claim_id])).rows[0];
          if (fresh) { const i = ctx.claims.findIndex((c) => c.id === Number(fresh.id)); const ref: ClaimRef = { ...fresh, id: Number(fresh.id), po_id: String(fresh.po_id), amount_owed: fresh.amount_owed == null ? null : Number(fresh.amount_owed), remaining: fresh.amount_owed == null ? null : Number(fresh.amount_owed) }; if (i >= 0) (ctx.claims as ClaimRef[])[i] = ref; else (ctx.claims as ClaimRef[]).push(ref); }
        }
      } catch (err: any) { applied = `error: ${err?.message ?? err}`; opts.log?.(`claim email ${e.id} (${p.row}): ${err?.message ?? err}`); }
    }
    if (p.row !== "noise" || opts.dryRun) r.rows.push({ gmail_message_id: e.id, mailbox: e.mailbox, direction: e.direction, date: ymdOf(e.date), sender: e.fromDomain ?? e.from, to: e.to, subject: e.subject.slice(0, 120), family: cls.family, template: cls.template, row: rowKey, label: p.label, po: p.po ? `${p.po.supplier} ${p.po.order_id}` : null, claim_id: p.claim?.id ?? null, claim_status: p.claim?.status ?? null, amount: p.amount, sets: p.sets, why: p.why, needs_ai: p.needsAi, applied });
  }
  if (!opts.dryRun && read.length) {
    const next = { ...marks };
    for (const mb of read) next[mb.mailbox] = now.toISOString();
    await query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [EMAIL_WATERMARK_KEY, JSON.stringify(next)]);
  }
  return r;
}
