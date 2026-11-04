// Gmail read client for PO tracking (SPEC §26; patch po-tracking-velocity §4,
// D2). The existing Google service account (asinflow-sheets, the same key
// file the Sheets reader uses: GOOGLE_CREDENTIALS_PATH) with domain-wide
// delegation, impersonating the orders@ mailbox. Scope gmail.readonly — AF
// never sends, labels or deletes mail. No OAuth consent flow, no refresh
// tokens.
//
// Dependency-free of ./index (it boots Express): scripts (gmail:check, the
// backfill) import this directly.
import { readFileSync } from "fs";
import { google, type gmail_v1 } from "googleapis";

export const GMAIL_SUBJECT = process.env.GMAIL_SUBJECT || "orders@coastalqualitygoods.com";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export function gmailClient(subject: string = GMAIL_SUBJECT): gmail_v1.Gmail {
  const keyFile = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!keyFile) throw new Error("GOOGLE_CREDENTIALS_PATH not configured");
  // email + key passed explicitly: JWT({keyFile}) leaves the issuer null at
  // token time ("invalid_grant: Invalid issuer: null").
  const cred = JSON.parse(readFileSync(keyFile, "utf8")) as { client_email: string; private_key: string };
  const auth = new google.auth.JWT({ email: cred.client_email, key: cred.private_key, scopes: [GMAIL_SCOPE], subject });
  return google.gmail({ version: "v1", auth });
}

export interface GmailMessage {
  id: string;
  threadId: string | null;
  /** Gmail's receive time (internalDate). */
  date: Date;
  from: string;
  /** Lower-cased domain of the From address, e.g. "oe.target.com". */
  fromDomain: string | null;
  subject: string;
  /** Plain-text body, plus the HTML part converted to text when the plain part is missing or a short preview. */
  text: string;
  /** HTML anchors that say "track" (anchor text first, then href) — htmlToText drops hrefs (2026-10-22). */
  trackLinks?: string[];
  labelIds: string[];
}

/** Message ids matching a Gmail search query, newest first, up to `max`. */
export async function listMessageIds(gmail: gmail_v1.Gmail, q: string, max = 500): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const r = await gmail.users.messages.list({ userId: "me", q, maxResults: Math.min(500, max - ids.length), pageToken });
    for (const m of r.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);
  return ids;
}

const b64 = (s: string | null | undefined) => (s ? Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "");

/** Pure: crude but dependable HTML → text (tags out, block breaks kept, entities decoded). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|td|th)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

/** Pure: hrefs of the HTML's anchors whose text — then whose URL — says "track", de-duplicated, in order. */
export function trackAnchors(html: string): string[] {
  const byText: string[] = [], byHref: string[] = [];
  for (const m of Array.from(html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi))) {
    const href = m[2].replace(/&amp;/gi, "&");
    const label = htmlToText(m[3]);
    if (/\btrack/i.test(label)) byText.push(href);
    else if (/track/i.test(href)) byHref.push(href);
  }
  return Array.from(new Set([...byText, ...byHref]));
}

function walkParts(p: gmail_v1.Schema$MessagePart | undefined, out: { plain: string[]; html: string[] }): void {
  if (!p) return;
  const mime = (p.mimeType ?? "").toLowerCase();
  if (mime === "text/plain" && p.body?.data) out.plain.push(b64(p.body.data));
  else if (mime === "text/html" && p.body?.data) out.html.push(b64(p.body.data));
  for (const c of p.parts ?? []) walkParts(c, out);
}

/** Pure: a full-format Gmail message → GmailMessage. */
export function parseGmailMessage(m: gmail_v1.Schema$Message): GmailMessage {
  const headers = m.payload?.headers ?? [];
  const h = (name: string) => headers.find((x) => (x.name ?? "").toLowerCase() === name)?.value ?? "";
  const from = h("from");
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const fromDomain = /@([^>\s]+)$/.exec(addr.trim())?.[1]?.toLowerCase() ?? null;
  const parts = { plain: [] as string[], html: [] as string[] };
  walkParts(m.payload, parts);
  // Many retailers' text/plain part is a one-line preview ("Get your tracking
  // details inside" — Macy's); the facts are in the HTML. Plain alone only
  // when it is substantial.
  const plain = parts.plain.join("\n").trim();
  const html = parts.html.length ? htmlToText(parts.html.join("\n")) : "";
  const text = plain.length >= 300 || !html ? plain : [plain, html].filter(Boolean).join("\n");
  return {
    id: String(m.id), threadId: m.threadId ?? null,
    date: new Date(Number(m.internalDate ?? 0)),
    from, fromDomain, subject: h("subject"), text, trackLinks: parts.html.length ? trackAnchors(parts.html.join("\n")) : [], labelIds: m.labelIds ?? [],
  };
}

export async function getMessage(gmail: gmail_v1.Gmail, id: string): Promise<GmailMessage> {
  const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  return parseGmailMessage(r.data);
}

/** The tracking matcher's text rule (tracking-match.ts EmailTextFor): a row's email text and date by message id. */
export const emailTextFor = (gmail: gmail_v1.Gmail) => async (id: string): Promise<{ text: string; date: Date | null }> => {
  const m = await getMessage(gmail, id);
  return { text: m.text, date: m.date };
};

// ---- PO documents (SPEC §22 "PO documents"): the email as a printable page ----

export interface RenderableMessage { id: string; html: string; subject: string; from: string; to: string; date: Date }

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Pure: the message's HTML (or its plain text as <pre>) with cid: images inlined and a From / Date / Subject header on top. */
export function renderableHtml(m: { html: string | null; plain: string | null; subject: string; from: string; to: string; date: Date }, cid: Record<string, string> = {}): string {
  let body = m.html ?? `<pre style="white-space:pre-wrap;font:13px/1.4 Arial,Helvetica,sans-serif">${escapeHtml(m.plain ?? "")}</pre>`;
  body = body.replace(/(["'(])cid:([^"')\s]+)/gi, (all, q, id) => (cid[id] ? `${q}${cid[id]}` : all));
  const head = `<div style="font:12px/1.5 Arial,Helvetica,sans-serif;color:#333;border-bottom:1px solid #ccc;margin:0 0 12px;padding:0 0 8px">`
    + `<div><b>From:</b> ${escapeHtml(m.from)}</div><div><b>To:</b> ${escapeHtml(m.to)}</div>`
    + `<div><b>Date:</b> ${escapeHtml(m.date.toUTCString())}</div><div><b>Subject:</b> ${escapeHtml(m.subject)}</div></div>`;
  const doc = /<body[^>]*>/i.test(body) ? body.replace(/<body[^>]*>/i, (b) => `${b}${head}`) : `<!doctype html><html><head><meta charset="utf-8"></head><body>${head}${body}</body></html>`;
  return /<meta[^>]+charset/i.test(doc) ? doc : doc.replace(/<head[^>]*>/i, (h) => `${h}<meta charset="utf-8">`);
}

/** The full message for rendering: the first HTML part (else the plain text), its inline (cid:) images fetched and inlined as data: URIs. */
export async function getRenderableMessage(gmail: gmail_v1.Gmail, id: string): Promise<RenderableMessage> {
  const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const m = r.data;
  const headers = m.payload?.headers ?? [];
  const h = (p: gmail_v1.Schema$MessagePart | undefined, name: string) => (p?.headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name)?.value ?? "";
  const parts = { plain: [] as string[], html: [] as string[] };
  walkParts(m.payload, parts);
  const cid: Record<string, string> = {};
  const inline: gmail_v1.Schema$MessagePart[] = [];
  const collect = (p: gmail_v1.Schema$MessagePart | undefined) => { if (!p) return; if (/^image\//i.test(p.mimeType ?? "") && h(p, "content-id")) inline.push(p); (p.parts ?? []).forEach(collect); };
  collect(m.payload);
  for (const p of inline) {
    const key = h(p, "content-id").replace(/^<|>$/g, "");
    let data = p.body?.data ?? null;
    if (!data && p.body?.attachmentId) data = (await gmail.users.messages.attachments.get({ userId: "me", messageId: id, id: p.body.attachmentId })).data.data ?? null;
    if (data) cid[key] = `data:${p.mimeType};base64,${data.replace(/-/g, "+").replace(/_/g, "/")}`;
  }
  const subject = headers.find((x) => (x.name ?? "").toLowerCase() === "subject")?.value ?? "";
  const from = headers.find((x) => (x.name ?? "").toLowerCase() === "from")?.value ?? "";
  const to = headers.find((x) => (x.name ?? "").toLowerCase() === "to")?.value ?? "";
  const date = new Date(Number(m.internalDate ?? 0));
  const html = renderableHtml({ html: parts.html[0] ?? null, plain: parts.plain.join("\n") || null, subject, from, to, date }, cid);
  return { id, html, subject, from, to, date };
}
