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
    from, fromDomain, subject: h("subject"), text, labelIds: m.labelIds ?? [],
  };
}

export async function getMessage(gmail: gmail_v1.Gmail, id: string): Promise<GmailMessage> {
  const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  return parseGmailMessage(r.data);
}
