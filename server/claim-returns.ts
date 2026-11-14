// Returns (claims commit 7 — docs/claude_spec-patch-supplier-claims.md §3.12, the acceptance table rows 1–12; §3.5 "Return";
// §3.9's is_return note; migration 113; Maria 2026-11-13). The mockups docs/mockups/claims-list-returns-2026-11-13.html and
// claim-detail-returns-2026-11-13.html are the UI.
//
//   readReturnEmail     pure: what a return email says — the kind (a label, a scheduled pickup, a store return, "we received
//                       your return", a pickup reminder), the carrier + tracking # ("FEDEX tracking number 528882007345"),
//                       the return-by date ("Return by Mon, Nov 30" / "…by Fri, Nov 20"), the pickup date. Regex: every
//                       Walmart template of the last 90 days reads by regex (probe 2026-11-13); Haiku is the fallback for
//                       an uploaded PDF label with nothing typed (readLabelWithAi).
//   attachReturnLabel   rows 1 / 2 / 3 + 10: the claim's return starts — return_required, the return-by date (a typed date is
//                       never overwritten), the tracking row (direction = return, claim_id; the ingest's parked copy of
//                       the number — match_reason 'return' — is adopted; a number the inbound leg already carries gets a
//                       second row, the §3.9 reuse case), Upload label ticked, send_label (Velocity PO) or drop_off_return
//                       (home PO) opened, the label_saved entry, a History row. Nothing writes to Velocity.
//   returnScanState     pure: a tracker's scans AFTER the label — the first movement scan (→ Shipped), the delivery (→
//                       Delivered), the last scan and its place, a carrier exception; the inbound leg's scans never count.
//   applyReturnTracker  rows 5 / 6 / 8: every return row carrying the tracker's number takes its state; the claim's Shipped /
//                       Delivered follow (source 'tracking') unless set by hand; an exception → Check on it. Called from
//                       every EasyPost write (register, webhook, sweep).
//   setReturnFacts      Steps / the Return card by hand: return by, Sent / Dropped off date, Shipped, Delivered, the tracking
//                       # (source 'manual' — never overwritten by tracking or email).
//   noLabel             row 3's No label: a store return / pickup without a label (tracking typed or none).
//   sweepReturnByWarnings  row 9: the return-by date 3 calendar days away (or past) and the return not shipped → Check on it
//                       "return by M/D · N days left", once per date.
import { z } from "zod/v4";
import type { QueryLike } from "./scheduler/types";
import { EditError, logEdits } from "./po-edit";
import { addTask } from "./supplier-claims";
import { carrierForNumber, extractTracking, type Carrier } from "./tracking-parse";
import { AI, anthropicClient, aiAvailable, estimateCost } from "./config/ai";
import { logPrefill } from "./po-prefill";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { EASYPOST_STATUSES, isTerminalStatus, type EasypostStatus } from "@shared/carrier-status";
import { mdOf } from "@shared/claim-bucket";
import type { EasypostTracker } from "./easypost";
import type { drive_v3 } from "googleapis";
import { ensureMonthFolder, folderFileNames, uploadPdf } from "./drive-client";

// ── Reading a return email ────────────────────────────────────────────────────

export type ReturnEmailKind = "label" | "pickup" | "store" | "received" | "reminder" | "other";
export interface ReturnEmailReading {
  kind: ReturnEmailKind;
  carrier: Carrier | null;
  trackingNumber: string | null;
  /** YYYY-MM-DD: "Return by Mon, Nov 30" / the subject's "by Fri, Nov 20"; the year is the next occurrence on or after the email. */
  returnBy: string | null;
  /** YYYY-MM-DD: a scheduled pickup ("Return pickup confirmation: Mon, Oct 5") — row 10's Shipped, from email. */
  pickupDate: string | null;
  /** A store return / a QR code at the counter: no label and no tracking until the carrier prints it. */
  storeReturn: boolean;
}
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DAY_WORD = `(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\\s+)?`;
const MONTH_DAY = `([A-Z][a-z]{2,8})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`;
const NUMERIC_DATE = `(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?`;
const RETURN_BY_RE = new RegExp(`\\breturn by\\s+${DAY_WORD}(?:${MONTH_DAY}|${NUMERIC_DATE})`, "i");
const SUBJECT_BY_RE = new RegExp(`\\bby\\s+${DAY_WORD}(?:${MONTH_DAY}|${NUMERIC_DATE})`, "i");
const PICKUP_RE = new RegExp(`(?:pickup confirmation:|scheduled for|picked up on)\\s*${DAY_WORD}(?:${MONTH_DAY}|${NUMERIC_DATE})`, "i");
const TRACKING_RE = /\b(FedEx|UPS|USPS|DHL|OnTrac|LaserShip)\s+tracking\s*(?:number|#|no\.?)?\s*[:\-]?\s*([A-Z0-9]{10,34})\b/i;
const CARRIER_WORD: Record<string, Carrier> = { fedex: "FEDEX", ups: "UPS", usps: "USPS", dhl: "DHL", ontrac: "ONTRAC", lasership: "LASERSHIP" };

/** Pure: "Nov 30" / "11/30" → the next YYYY-MM-DD on or after `from` (the year printed wins when the email prints one). */
export function resolveDate(m: RegExpExecArray | null, from: Date): string | null {
  if (!m) return null;
  const [, monthWord, dayWord, yearWord, numMonth, numDay, numYear] = m;
  let month: number, day: number, year: number | null = null;
  if (monthWord) { const mm = MONTHS[monthWord.toLowerCase().slice(0, 4)] ?? MONTHS[monthWord.toLowerCase().slice(0, 3)]; if (!mm) return null; month = mm; day = Number(dayWord); if (yearWord) year = Number(yearWord); }
  else { month = Number(numMonth); day = Number(numDay); if (numYear) year = numYear.length === 2 ? 2000 + Number(numYear) : Number(numYear); }
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (year) return `${year}-${pad(month)}-${pad(day)}`;
  const y0 = from.getUTCFullYear();
  const fromDay = Date.UTC(y0, from.getUTCMonth(), from.getUTCDate());
  // the date the email means is in the next 11 months: this year unless that day is more than a month behind the email
  const thisYear = Date.UTC(y0, month - 1, day);
  const y = thisYear < fromDay - 31 * 86_400_000 ? y0 + 1 : y0;
  return `${y}-${pad(month)}-${pad(day)}`;
}

/** Pure: what a return email says (see the header). */
export function readReturnEmail(e: { subject: string; text: string; date: Date }): ReturnEmailReading {
  const subject = e.subject ?? "", text = e.text ?? "";
  const all = `${subject}\n${text}`;
  const store = /\bin-?store\b|at a walmart store|return code:|show the (?:return )?barcode/i.test(all);
  const kind: ReturnEmailKind = /we received your return|your return is complete|return (?:received|complete|processed)\b/i.test(subject) ? "received"
    : /picked up tomorrow|reminder: your return|pickup (?:is )?tomorrow/i.test(subject) ? "reminder"
    : /return pickup confirmation|pickup (?:is )?scheduled/i.test(subject) ? "pickup"
    : store ? "store"
    : /drop off your return|return label|print your return|return shipping label|return (?:instructions|started)/i.test(subject) ? "label" : "other";
  let carrier: Carrier | null = null, trackingNumber: string | null = null;
  const t = TRACKING_RE.exec(all);
  if (t) { carrier = CARRIER_WORD[t[1].toLowerCase()] ?? carrierForNumber(t[2]); trackingNumber = t[2].toUpperCase(); }
  else { const x = extractTracking(text, [])[0]; if (x) { carrier = x.carrier; trackingNumber = x.trackingNumber; } }
  const returnBy = resolveDate(RETURN_BY_RE.exec(all), e.date) ?? (kind === "label" || kind === "store" ? resolveDate(SUBJECT_BY_RE.exec(subject), e.date) : null);
  const pickupDate = kind === "pickup" || kind === "reminder" ? resolveDate(PICKUP_RE.exec(all), e.date) : null;
  return { kind, carrier, trackingNumber, returnBy, pickupDate, storeReturn: store && !trackingNumber };
}

// ── The tracker's scans after the label ──────────────────────────────────────

export interface ReturnScanState {
  status: EasypostStatus;
  /** The first movement scan after the label (anything but pre_transit / unknown) — Shipped — and where it was. */
  first_scan_at: string | null;
  first_scan_location: string | null;
  last_scan_at: string | null;
  last_scan_location: string | null;
  delivered_at: string | null;
  est_delivery_at: string | null;
  /** The carrier reports a problem on the return leg: failure, return to sender, error, cancelled. */
  exception: EasypostStatus | null;
  /** Scans after the label exist (false = only the inbound leg's — the §3.9 reuse case before the return moves). */
  moved: boolean;
}
const iso = (s: unknown): string | null => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const dayStart = (v: string | Date | null | undefined): number => { if (!v) return 0; const d = new Date(v); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const EXCEPTIONS = new Set<string>(["failure", "return_to_sender", "error", "cancelled"]);
const place = (d: any): string | null => { const l = d?.tracking_location; if (!l) return null; const parts = [l.city, l.state].filter((x) => x && String(x).trim()).map((x) => String(x).trim()); return parts.length ? parts.map((p, i) => (i === 0 ? p.replace(/\w\S*/g, (w) => w[0] + w.slice(1).toLowerCase()) : p)).join(", ") : null; };

/** Pure: only the scans on or after the label's day count (the inbound leg's never do, §3.9's reuse note). */
export function returnScanState(t: EasypostTracker, labelAt: string | Date | null | undefined): ReturnScanState {
  const since = dayStart(labelAt);
  const scans = (t.tracking_details ?? []).map((d) => ({ at: iso(d.datetime), status: String(d.status ?? ""), where: place(d) })).filter((d): d is { at: string; status: string; where: string | null } => !!d.at && Date.parse(d.at) >= since).sort((a, b) => a.at.localeCompare(b.at));
  const moved = scans.length > 0;
  const movement = scans.filter((d) => d.status !== "pre_transit" && d.status !== "unknown");
  const delivered = scans.filter((d) => d.status === "delivered").pop() ?? null;
  const last = scans[scans.length - 1] ?? null;
  const raw = (EASYPOST_STATUSES as readonly string[]).includes(String(t.status)) ? (t.status as EasypostStatus) : "unknown";
  // the tracker's status is the return's only once a scan after the label backs it (a tracker reused from the inbound leg says "delivered" about the inbound parcel)
  const status: EasypostStatus = !moved ? "pre_transit" : raw === "delivered" && !delivered ? (last?.status === "out_for_delivery" ? "out_for_delivery" : "in_transit") : raw;
  return {
    status, first_scan_at: movement[0]?.at ?? null, first_scan_location: movement[0]?.where ?? null, last_scan_at: last?.at ?? null, last_scan_location: last?.where ?? null,
    delivered_at: delivered?.at ?? null, est_delivery_at: iso(t.est_delivery_date), exception: moved && EXCEPTIONS.has(status) ? status : null, moved,
  };
}

// ── The return tracking row ───────────────────────────────────────────────────

export interface ReturnTrackingInput { poId: string; claimId: number; carrier: Carrier | string; trackingNumber: string; shippedAt: string; source: "regex" | "ai" | "manual"; gmailMessageId?: string | null; emailSubject?: string | null }
/**
 * The return's po_tracking row (direction = return, claim_id). The tracking ingest parks every return email's number as an
 * unmatched row with match_reason 'return' (server/tracking-ingest.ts) — that row is adopted; a number the inbound leg carries
 * (matched / pushed) gets a second row beside it (migration 113: the unique key includes the direction; EasyPost answers the
 * inbound tracker, §3.9); a return row that exists already is reused. Returns the row id.
 */
export async function upsertReturnTracking(query: QueryLike, t: ReturnTrackingInput): Promise<number> {
  const carrier = String(t.carrier).toUpperCase(), number = t.trackingNumber.trim().toUpperCase();
  const rows = (await query(`SELECT id, direction, status, match_reason, claim_id, po_id FROM po_tracking WHERE carrier = $1 AND upper(tracking_number) = $2 AND split_of IS NULL ORDER BY id`, [carrier, number])).rows as any[];
  const own = rows.find((r) => r.direction === "return");
  if (own) {
    await query(`UPDATE po_tracking SET claim_id = COALESCE(claim_id, $2), po_id = COALESCE(po_id, $3), status = CASE WHEN status = 'unmatched' THEN 'matched' ELSE status END, updated_at = NOW() WHERE id = $1`, [own.id, t.claimId, t.poId]);
    return Number(own.id);
  }
  const parked = rows.find((r) => r.direction === "inbound" && r.status === "unmatched" && r.match_reason === "return");
  if (parked) {
    await query(`UPDATE po_tracking SET direction = 'return', po_id = $2, claim_id = $3, status = 'matched', match_reason = 'return claim', shipped_at = COALESCE(shipped_at, $4::timestamptz), updated_at = NOW() WHERE id = $1`, [parked.id, t.poId, t.claimId, t.shippedAt]);
    return Number(parked.id);
  }
  const ins = (await query(
    `INSERT INTO po_tracking (po_id, claim_id, carrier, tracking_number, direction, status, match_reason, shipped_at, gmail_message_id, email_subject, source)
     VALUES ($1, $2, $3, $4, 'return', 'matched', 'return claim', $5, $6, $7, $8) RETURNING id`,
    // gmail_message_id is NOT NULL (066): a typed / AI-read number carries the same marker the manual tracking route writes
    [t.poId, t.claimId, carrier, number, t.shippedAt, t.gmailMessageId ?? "manual", t.emailSubject ? t.emailSubject.slice(0, 300) : null, t.source],
  )).rows[0];
  return Number(ins.id);
}

// ── The label arrives ─────────────────────────────────────────────────────────

export interface AttachLabelInput {
  /** 'email' (§3.11 row 6 saved it), 'upload' (Maria's file), 'none' (No label: a store return / pickup without one). */
  labelSource: "email" | "upload" | "none";
  labelAt: string;
  docId?: number | null;
  carrier?: Carrier | string | null; trackingNumber?: string | null;
  returnBy?: string | null; returnBySource?: "email" | "manual";
  /** Row 10: a scheduled pickup's date → Shipped, from email (a later carrier scan corrects it). */
  pickupDate?: string | null;
  email?: { id: string; mailbox: string; subject: string } | null;
  note?: string | null;
  trackingSource?: "regex" | "ai" | "manual";
}
const claimOf = async (query: QueryLike, id: number) => {
  const d = (await query(`SELECT c.id, c.po_id, c.status, c.qty, c.return_required, c.return_by::text AS return_by, c.return_by_source, c.return_no_label, c.return_shipped_at::text AS return_shipped_at, c.return_shipped_source, c.return_delivered_at::text AS return_delivered_at, c.return_delivered_source,
                                 p.ships_to, p.supplier, p.order_id, p.closed_at AS po_closed_at
                            FROM supplier_claims c JOIN purchase_orders p ON p.id = c.po_id WHERE c.id = $1`, [id])).rows[0];
  if (!d) throw new EditError(404, "claim not found");
  return { ...d, id: Number(d.id), po_id: String(d.po_id) } as { id: number; po_id: string; status: string; qty: number | null; return_required: boolean; return_by: string | null; return_by_source: string | null; return_no_label: boolean; return_shipped_at: string | null; return_shipped_source: string | null; return_delivered_at: string | null; return_delivered_source: string | null; ships_to: string | null; supplier: string; order_id: string; po_closed_at: Date | null };
};
const noon = (ymd: string) => `${ymd}T12:00:00Z`;
const isYmd = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
async function claimEvent(query: QueryLike, claimId: number, type: string, summary: string | null, by: number | null, refs: { email?: { id: string; mailbox: string } | null; docId?: number | null; trackingId?: number | null; at?: string | null } = {}): Promise<number> {
  const r = (await query(`INSERT INTO supplier_claim_events (claim_id, at, type, summary, by, gmail_message_id, mailbox, po_document_id, po_tracking_id) VALUES ($1, COALESCE($9::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [claimId, type, summary, by, refs.email?.id ?? null, refs.email?.mailbox ?? null, refs.docId ?? null, refs.trackingId ?? null, refs.at ?? null])).rows[0];
  return Number(r.id);
}

/** Rows 1 / 2 / 3 (+ 10 for a scheduled pickup): the return starts on the claim. Returns what it set. */
export async function attachReturnLabel(query: QueryLike, claimId: number, input: AttachLabelInput, userId: number | null): Promise<{ tracking_id: number | null; task: "send_label" | "drop_off_return" | null; return_by: string | null }> {
  const d = await claimOf(query, claimId);
  if (d.status !== "open" && d.status !== "suggested") throw new EditError(400, "only an open claim takes a return label");
  const changes: Array<{ field: string; old: string | null; new: string | null }> = [];
  const home = d.ships_to === "home";
  // return_required = yes; No label when nothing came
  const sets: string[] = ["return_required = true", "updated_at = now()"]; const params: unknown[] = [claimId];
  if (!d.return_required) changes.push({ field: "claim return_required", old: "false", new: "true" });
  if (input.labelSource === "none" && !d.return_no_label) { sets.push("return_no_label = true"); changes.push({ field: "claim return_no_label", old: "false", new: "true" }); }
  if (input.labelSource !== "none" && d.return_no_label) { sets.push("return_no_label = false"); changes.push({ field: "claim return_no_label", old: "true", new: "false" }); }
  // the return-by date: typed by hand wins; an email's date fills a blank or replaces an earlier email's
  let returnBy = d.return_by;
  if (isYmd(input.returnBy) && (d.return_by_source !== "manual" || input.returnBySource === "manual") && input.returnBy !== d.return_by) {
    params.push(input.returnBy, input.returnBySource ?? "email");
    sets.push(`return_by = $${params.length - 1}::date`, `return_by_source = $${params.length}`, "return_by_warned = NULL");
    changes.push({ field: "claim return_by", old: d.return_by, new: input.returnBy });
    returnBy = input.returnBy;
  }
  // row 10: a scheduled pickup is the ship date (from email) until the carrier's first scan corrects it; never over a hand-set date
  if (isYmd(input.pickupDate) && d.return_shipped_source !== "manual" && d.return_shipped_source !== "tracking") {
    params.push(noon(input.pickupDate));
    sets.push(`return_shipped_at = $${params.length}::timestamptz`, "return_shipped_source = 'email'");
    changes.push({ field: "claim return_shipped_at", old: d.return_shipped_at?.slice(0, 10) ?? null, new: input.pickupDate });
  }
  await query(`UPDATE supplier_claims SET ${sets.join(", ")} WHERE id = $1`, params);
  // the tracking row
  let trackingId: number | null = null;
  if (input.trackingNumber && input.trackingNumber.trim()) {
    const carrier = input.carrier ? String(input.carrier).toUpperCase() : carrierForNumber(input.trackingNumber);
    trackingId = await upsertReturnTracking(query, { poId: d.po_id, claimId, carrier, trackingNumber: input.trackingNumber, shippedAt: input.labelAt, source: input.trackingSource ?? (input.labelSource === "email" ? "regex" : "manual"), gmailMessageId: input.email?.id ?? null, emailSubject: input.email?.subject ?? null });
    changes.push({ field: "claim return tracking", old: null, new: `${carrier} ${input.trackingNumber.trim().toUpperCase()}` });
  }
  // Upload label is done (the label came, or there is none) — the tick is dated by the label so the Label step reads it when no document was saved
  const ticked = await query(`UPDATE supplier_claim_tasks SET done_at = $3::timestamptz, done_by = $2 WHERE claim_id = $1 AND kind = 'upload_return_label' AND done_at IS NULL`, [claimId, userId, input.labelAt]);
  if (!(ticked.rowCount ?? 0) && !(await query(`SELECT 1 FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'upload_return_label' AND done_at IS NOT NULL`, [claimId])).rows.length) {
    await query(`INSERT INTO supplier_claim_tasks (claim_id, kind, "group", reason, done_at, done_by) VALUES ($1, 'upload_return_label', 'money', $2, $3::timestamptz, $4)`, [claimId, input.labelSource === "none" ? "no label" : "the label came", input.labelAt, userId]);
  }
  // the next hand: Velocity sends it / Maria drops it off
  let task: "send_label" | "drop_off_return" | null = null;
  if (!d.return_shipped_at && !isYmd(input.pickupDate)) {
    task = home ? "drop_off_return" : "send_label";
    await addTask(query, claimId, task, home ? `drop off the return${returnBy ? ` by ${mdOf(returnBy)}` : ""}` : `send the return label to Velocity${returnBy ? ` · return by ${mdOf(returnBy)}` : ""}`);
  }
  const what = input.labelSource === "none" ? `No label · ${input.note?.trim() || "store return / pickup"}` : input.labelSource === "upload" ? "Return label uploaded" : `Return label received · from email · "${input.email?.subject ?? ""}"`;
  const detail = [input.trackingNumber ? `tracking ${input.carrier ? String(input.carrier).toUpperCase() : carrierForNumber(input.trackingNumber)} ${input.trackingNumber.trim().toUpperCase()} read from the ${input.labelSource === "email" ? "email" : "label"}` : null, returnBy ? `return by ${mdOf(returnBy)}` : null, isYmd(input.pickupDate) ? `pickup scheduled ${mdOf(input.pickupDate)}` : null].filter(Boolean).join(" · ");
  await claimEvent(query, claimId, input.labelSource === "none" ? "task_done" : "label_saved", input.labelSource === "none" ? `upload_return_label: ${what}${detail ? ` · ${detail}` : ""}` : `${what}${detail ? ` · ${detail}` : ""}`, userId, { email: input.email ?? null, docId: input.docId ?? null, trackingId, at: input.labelSource === "email" ? input.labelAt : null });
  if (isYmd(input.pickupDate) && d.return_shipped_source !== "manual" && d.return_shipped_source !== "tracking") await claimEvent(query, claimId, "return_shipped", `pickup scheduled ${mdOf(input.pickupDate)} · from email`, userId, { email: input.email ?? null, trackingId });
  if (changes.length) await logEdits(query, d.po_id, userId, "claim", String(claimId), changes);
  return { tracking_id: trackingId, task, return_by: returnBy };
}

/** Row 3's No label: a store return / a carrier pickup with nothing to print — tracking typed by hand, or none. */
export async function noLabel(query: QueryLike, claimId: number, body: { carrier?: string | null; tracking_number?: string | null; return_by?: string | null; note?: string | null }, userId: number | null) {
  return attachReturnLabel(query, claimId, { labelSource: "none", labelAt: new Date().toISOString(), carrier: body.carrier ?? null, trackingNumber: body.tracking_number ?? null, returnBy: isYmd(body.return_by) ? body.return_by : null, returnBySource: "manual", note: body.note ?? null, trackingSource: "manual" }, userId);
}

// ── By hand: Steps and the Return card ───────────────────────────────────────

export interface ReturnFactsBody { return_by?: string | null; sent_at?: string | null; shipped_at?: string | null; delivered_at?: string | null; carrier?: string | null; tracking_number?: string | null }
/**
 * A date set by hand is the fact: return_by (source manual), Sent to Velocity / Dropped off (the task's done_at — ticked if open),
 * Shipped / Delivered (source manual — tracking never overwrites them). "" clears a return date. The tracking # typed on the card
 * makes the return row (source manual).
 */
export async function setReturnFacts(query: QueryLike, claimId: number, body: ReturnFactsBody, userId: number | null): Promise<{ id: number; po_id: string }> {
  const d = await claimOf(query, claimId);
  if (d.status !== "open" && d.status !== "suggested") throw new EditError(400, "only an open claim's return can be changed");
  const changes: Array<{ field: string; old: string | null; new: string | null }> = [];
  const home = d.ships_to === "home";
  if ("return_by" in body) {
    const v = body.return_by == null || body.return_by === "" ? null : body.return_by;
    if (v != null && !isYmd(v)) throw new EditError(400, "return_by must be YYYY-MM-DD");
    if (v !== d.return_by) {
      await query(`UPDATE supplier_claims SET return_by = $2::date, return_by_source = CASE WHEN $2::date IS NULL THEN NULL ELSE 'manual' END, return_by_warned = NULL, updated_at = now() WHERE id = $1`, [claimId, v]);
      changes.push({ field: "claim return_by", old: d.return_by, new: v });
    }
  }
  if ("sent_at" in body) {
    if (!isYmd(body.sent_at)) throw new EditError(400, "sent_at must be YYYY-MM-DD");
    const kind = home ? "drop_off_return" : "send_label";
    const open = (await query(`SELECT id FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = $2 AND done_at IS NULL LIMIT 1`, [claimId, kind])).rows[0];
    if (open) {
      await query(`UPDATE supplier_claim_tasks SET done_at = $3::timestamptz, done_by = $2 WHERE id = $1`, [open.id, userId, noon(body.sent_at)]);
      await claimEvent(query, claimId, "task_done", `${kind}: ${home ? "dropped off" : "sent to Velocity"} ${mdOf(body.sent_at)}`, userId);
    } else {
      const last = (await query(`SELECT id, done_at::text AS done_at FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = $2 AND done_at IS NOT NULL ORDER BY done_at DESC, id DESC LIMIT 1`, [claimId, kind])).rows[0];
      if (last) await query(`UPDATE supplier_claim_tasks SET done_at = $2::timestamptz WHERE id = $1`, [last.id, noon(body.sent_at)]);
      else { await addTask(query, claimId, kind, null); await query(`UPDATE supplier_claim_tasks SET done_at = $3::timestamptz, done_by = $2 WHERE claim_id = $1 AND kind = $4 AND done_at IS NULL`, [claimId, userId, noon(body.sent_at), kind]); await claimEvent(query, claimId, "task_done", `${kind}: ${home ? "dropped off" : "sent to Velocity"} ${mdOf(body.sent_at)}`, userId); }
    }
    changes.push({ field: `claim ${home ? "dropped off" : "sent to Velocity"}`, old: null, new: body.sent_at });
  }
  for (const step of ["shipped", "delivered"] as const) {
    const key = `${step}_at` as const;
    if (!(key in body)) continue;
    const v = body[key] == null || body[key] === "" ? null : body[key];
    if (v != null && !isYmd(v)) throw new EditError(400, `${key} must be YYYY-MM-DD`);
    const col = `return_${step}_at`, src = `return_${step}_source`;
    const cur = step === "shipped" ? d.return_shipped_at : d.return_delivered_at;
    await query(`UPDATE supplier_claims SET ${col} = $2::timestamptz, ${src} = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE 'manual' END, updated_at = now() WHERE id = $1`, [claimId, v ? noon(v) : null]);
    changes.push({ field: `claim ${col}`, old: cur?.slice(0, 10) ?? null, new: v });
    if (v) {
      await claimEvent(query, claimId, step === "shipped" ? "return_shipped" : "return_delivered", `${mdOf(v)} · set by hand`, userId);
      // the return left: the send / drop-off tick is implied
      if (step === "shipped") await query(`UPDATE supplier_claim_tasks SET done_at = $3::timestamptz, done_by = $2 WHERE claim_id = $1 AND kind IN ('send_label', 'drop_off_return', 'upload_return_label') AND done_at IS NULL`, [claimId, userId, noon(v)]);
    }
  }
  if (body.tracking_number && body.tracking_number.trim()) {
    const carrier = body.carrier ? String(body.carrier).toUpperCase() : carrierForNumber(body.tracking_number);
    const id = await upsertReturnTracking(query, { poId: d.po_id, claimId, carrier, trackingNumber: body.tracking_number, shippedAt: new Date().toISOString(), source: "manual" });
    changes.push({ field: "claim return tracking", old: null, new: `${carrier} ${body.tracking_number.trim().toUpperCase()}` });
    await claimEvent(query, claimId, "task_done", `return tracking ${carrier} ${body.tracking_number.trim().toUpperCase()} typed`, userId, { trackingId: id });
  }
  if (changes.length) await logEdits(query, d.po_id, userId, "claim", String(claimId), changes);
  return { id: claimId, po_id: d.po_id };
}

// ── The carrier moves the return ─────────────────────────────────────────────

export interface ReturnTrackerResult { rows: number; shipped: number; delivered: number; exceptions: number }
const STATUS_WORDS: Record<string, string> = { failure: "delivery failed", return_to_sender: "returned to sender", error: "a carrier error", cancelled: "the shipment cancelled" };
/**
 * Rows 5 / 6 / 8: every return row carrying this tracker's number (or id) takes the state of the scans after its label; the
 * claim's Shipped (first movement scan) and Delivered follow with source 'tracking' — never over a hand-set date; an email date
 * yields to tracking. A carrier exception opens Check on it with the reason. Called by every EasyPost write (easypost.ts).
 */
export async function applyReturnTracker(query: QueryLike, t: EasypostTracker, userId: number | null = null): Promise<ReturnTrackerResult> {
  const r: ReturnTrackerResult = { rows: 0, shipped: 0, delivered: 0, exceptions: 0 };
  const code = String(t.tracking_code ?? "").toUpperCase();
  const rows = (await query(`SELECT id, claim_id, shipped_at::text AS shipped_at, easypost_tracker_id FROM po_tracking WHERE direction = 'return' AND claim_id IS NOT NULL AND tracking_number NOT LIKE 'email:%' AND (easypost_tracker_id = $1 OR (easypost_tracker_id IS NULL AND upper(tracking_number) = $2))`, [String(t.id), code])).rows as any[];
  for (const row of rows) {
    const s = returnScanState(t, row.shipped_at);
    r.rows++;
    await query(`UPDATE po_tracking SET easypost_tracker_id = $2, carrier_status = $3, est_delivery_at = $4, last_scan_at = $5, last_scan_location = $6, delivered_at = $7, carrier_checked_at = NOW(), updated_at = NOW(), easypost_registered_at = COALESCE(easypost_registered_at, NOW()) WHERE id = $1`,
      [row.id, String(t.id), s.status, s.est_delivery_at, s.last_scan_at, s.last_scan_location, s.delivered_at]);
    const claimId = Number(row.claim_id);
    const c = (await query(`SELECT status, return_required, return_shipped_at::text AS return_shipped_at, return_shipped_source, return_delivered_at::text AS return_delivered_at, return_delivered_source, po_id FROM supplier_claims WHERE id = $1`, [claimId])).rows[0];
    if (!c || c.status === "dismissed") continue;
    const changes: Array<{ field: string; old: string | null; new: string | null }> = [];
    const carrier = `${t.carrier ?? ""} ${code}`.trim();
    if (s.first_scan_at && c.return_shipped_source !== "manual" && (c.return_shipped_at == null || c.return_shipped_source !== "tracking" || Date.parse(c.return_shipped_at) !== Date.parse(s.first_scan_at))) {
      const first = c.return_shipped_at == null || c.return_shipped_source !== "tracking";
      await query(`UPDATE supplier_claims SET return_shipped_at = $2::timestamptz, return_shipped_source = 'tracking', updated_at = now() WHERE id = $1`, [claimId, s.first_scan_at]);
      changes.push({ field: "claim return_shipped_at", old: c.return_shipped_at?.slice(0, 10) ?? null, new: `${s.first_scan_at.slice(0, 10)} (tracking)` });
      const summary = `${carrier}${s.first_scan_location ? ` picked up in ${s.first_scan_location}` : ""}${s.est_delivery_at ? ` · due ${mdOf(s.est_delivery_at)}` : ""} · from tracking`;
      const prev = (await query(`SELECT id FROM supplier_claim_events WHERE claim_id = $1 AND type = 'return_shipped' AND po_tracking_id = $2 ORDER BY id DESC LIMIT 1`, [claimId, row.id])).rows[0];
      if (prev) await query(`UPDATE supplier_claim_events SET at = $2::timestamptz, summary = $3 WHERE id = $1`, [prev.id, s.first_scan_at, summary]);
      else { await query(`INSERT INTO supplier_claim_events (claim_id, at, type, summary, by, po_tracking_id) VALUES ($1, $2::timestamptz, 'return_shipped', $3, $4, $5)`, [claimId, s.first_scan_at, summary, userId, row.id]); if (first) r.shipped++; }
      // the label left Maria's / Velocity's hands: the send / drop-off tick is implied, dated by the scan
      await query(`UPDATE supplier_claim_tasks SET done_at = $2::timestamptz, done_by = NULL WHERE claim_id = $1 AND kind IN ('send_label', 'drop_off_return', 'upload_return_label') AND done_at IS NULL`, [claimId, s.first_scan_at]);
    }
    if (s.delivered_at && c.return_delivered_source !== "manual" && (c.return_delivered_at == null || c.return_delivered_source !== "tracking")) {
      await query(`UPDATE supplier_claims SET return_delivered_at = $2::timestamptz, return_delivered_source = 'tracking', updated_at = now() WHERE id = $1`, [claimId, s.delivered_at]);
      changes.push({ field: "claim return_delivered_at", old: c.return_delivered_at?.slice(0, 10) ?? null, new: `${s.delivered_at.slice(0, 10)} (tracking)` });
      await query(`INSERT INTO supplier_claim_events (claim_id, at, type, summary, by, po_tracking_id) VALUES ($1, $2::timestamptz, 'return_delivered', $3, $4, $5)`, [claimId, s.delivered_at, `${carrier}${s.last_scan_location ? ` delivered in ${s.last_scan_location}` : " delivered"} · from tracking`, userId, row.id]);
      // a Check on it the stall opened is answered by the delivery
      await query(`UPDATE supplier_claim_tasks SET done_at = $2::timestamptz, done_by = NULL WHERE claim_id = $1 AND kind = 'check_on_it' AND done_at IS NULL AND reason LIKE '%no new carrier scan%'`, [claimId, s.delivered_at]);
      r.delivered++;
    }
    if (s.exception && c.status === "open" && !c.return_delivered_at) {
      const reason = `carrier reports ${STATUS_WORDS[s.exception] ?? s.exception} on the return · ${carrier}`;
      const has = (await query(`SELECT 1 FROM supplier_claim_tasks WHERE claim_id = $1 AND kind = 'check_on_it' AND reason = $2`, [claimId, reason])).rows.length > 0;
      if (!has) { await addTask(query, claimId, "check_on_it", reason); await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by, po_tracking_id) VALUES ($1, 'timed_out', $2, $3, $4)`, [claimId, reason, userId, row.id]); r.exceptions++; }
    }
    if (changes.length) await logEdits(query, String(c.po_id), userId, "claim", String(claimId), changes);
  }
  return r;
}

// ── Row 9: the return-by date ────────────────────────────────────────────────

const NY_DAY = (at: Date): number => { const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }); const p: Record<string, string> = {}; for (const x of f.formatToParts(at)) p[x.type] = x.value; return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)); };
/** Pure: calendar days from today (America/New_York) to the return-by date; negative when past. */
export const daysToReturnBy = (returnBy: string, now: Date): number => Math.round((Date.UTC(Number(returnBy.slice(0, 4)), Number(returnBy.slice(5, 7)) - 1, Number(returnBy.slice(8, 10))) - NY_DAY(now)) / 86_400_000);
export const RETURN_BY_WARN_DAYS = 3;
/** Pure: the Check on it reason — "return by 11/16 · 3 days left" / "today" / "N days overdue". */
export const returnByReason = (returnBy: string, days: number): string => `return by ${mdOf(returnBy)} · ${days > 0 ? `${days} day${days === 1 ? "" : "s"} left` : days === 0 ? "today" : `${-days} day${days === -1 ? "" : "s"} overdue`}`;
/**
 * Row 9: an open claim whose return-by date is RETURN_BY_WARN_DAYS calendar days away (or past) and whose return has not
 * shipped gets Check on it with the reason, once per return-by date (return_by_warned). Runs with the timer sweep.
 */
export async function sweepReturnByWarnings(query: QueryLike, now = new Date(), userId: number | null = null): Promise<Array<{ claim_id: number; kind: string; reason: string }>> {
  const out: Array<{ claim_id: number; kind: string; reason: string }> = [];
  const rows = (await query(`SELECT id, return_by::text AS return_by FROM supplier_claims WHERE status = 'open' AND return_required AND return_by IS NOT NULL AND return_shipped_at IS NULL AND return_delivered_at IS NULL AND (return_by_warned IS NULL OR return_by_warned <> return_by) ORDER BY id`)).rows as any[];
  for (const c of rows) {
    const days = daysToReturnBy(String(c.return_by), now);
    if (days > RETURN_BY_WARN_DAYS) continue;
    const reason = returnByReason(String(c.return_by), days);
    await addTask(query, Number(c.id), "check_on_it", reason);
    await query(`INSERT INTO supplier_claim_events (claim_id, type, summary, by) VALUES ($1, 'timed_out', $2, $3)`, [c.id, reason, userId]);
    await query(`UPDATE supplier_claims SET return_by_warned = return_by, updated_at = now() WHERE id = $1`, [c.id]);
    out.push({ claim_id: Number(c.id), kind: "check_on_it", reason });
  }
  return out;
}

// ── Reading an uploaded label (Haiku, the fallback) ──────────────────────────

const LabelReadSchema = z.object({
  carrier: z.enum(["FedEx", "UPS", "USPS", "DHL", "other", "none"]).describe("the carrier the label is for"),
  tracking_number: z.string().nullable().describe("the tracking number printed on the label, exactly as printed without spaces; null when none"),
  return_by: z.string().nullable().describe("a return-by / ship-by date printed on the label, as YYYY-MM-DD; null when none"),
});
export type LabelRead = z.infer<typeof LabelReadSchema>;
export const LABEL_READ_SYSTEM = `You read ONE return shipping label (a PDF a retailer emailed for a return). Give the carrier, the tracking number printed on it (the long number under the barcode, without spaces) and any return-by / ship-by date. Nothing else; null when a value is not printed.`;
export type LabelReadCall = (pdf: Buffer) => Promise<LabelRead & { input_tokens: number; output_tokens: number }>;
const defaultLabelRead: LabelReadCall = async (pdf) => {
  const res = await anthropicClient().messages.parse({
    model: AI.model, max_tokens: 400, output_config: { effort: AI.effort, format: zodOutputFormat(LabelReadSchema) },
    system: LABEL_READ_SYSTEM,
    messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } }, { type: "text", text: "Read this return label." }] }],
  });
  const parsed = LabelReadSchema.safeParse(res.parsed_output);
  if (!parsed.success) throw new Error(`schema: ${parsed.error.message.slice(0, 200)}`);
  return { ...parsed.data, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
};
/** The AI reading of a PDF label when nothing was typed: one Haiku call, logged as claim_return_label; null when AI is off or the read fails. */
export async function readLabelWithAi(query: QueryLike, pdf: Buffer, retailer: string | null, userId: number | null, call: LabelReadCall = defaultLabelRead): Promise<{ carrier: Carrier | null; trackingNumber: string | null; returnBy: string | null } | null> {
  if (!aiAvailable()) return null;
  const t0 = Date.now();
  try {
    const a = await call(pdf);
    await logPrefill(query, { user_id: userId, kind: "claim_return_label", retailer, input_chars: pdf.length, input_tokens: a.input_tokens, output_tokens: a.output_tokens, cost_estimate: estimateCost(a.input_tokens, a.output_tokens), duration_ms: Date.now() - t0, schema_ok: true, error: null });
    const number = a.tracking_number?.replace(/\s+/g, "").toUpperCase() || null;
    const carrier = a.carrier === "FedEx" ? "FEDEX" : a.carrier === "UPS" ? "UPS" : a.carrier === "USPS" ? "USPS" : a.carrier === "DHL" ? "DHL" : number ? carrierForNumber(number) : null;
    return { carrier, trackingNumber: number, returnBy: isYmd(a.return_by) ? a.return_by : null };
  } catch (err: any) {
    await logPrefill(query, { user_id: userId, kind: "claim_return_label", retailer, input_chars: pdf.length, input_tokens: 0, output_tokens: 0, cost_estimate: 0, duration_ms: Date.now() - t0, schema_ok: false, error: String(err?.message ?? err).slice(0, 500) }).catch(() => {});
    return null;
  }
}
export const isCarrierExceptionStatus = (s: string | null | undefined) => !!s && EXCEPTIONS.has(s) && !isTerminalStatus(s === "return_to_sender" ? null : s);

// ── Row 3: Upload label ───────────────────────────────────────────────────────

const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i;
export interface UploadLabelDeps { imageToPdf: (data: Buffer, mime: string) => Promise<Buffer>; readLabel?: LabelReadCall | null }
/**
 * Maria's own label (PDF or an image → PDF), saved as a return_label document in the Invoices month folder of today, named
 * YYYY-MM-DD_supplier_POID_return-label.pdf (§3.5), then the return starts on the claim: the carrier / tracking # / return-by
 * typed with it win; with nothing typed, Haiku reads the PDF (when AI is on); the return row registers with EasyPost on the
 * next hourly pass. Returns what was read, so the form can show "tracking read from the label".
 */
export async function uploadReturnLabel(query: QueryLike, drive: drive_v3.Drive, claimId: number, file: { buffer: Buffer; mimetype: string; originalname: string }, body: { carrier?: string | null; tracking_number?: string | null; return_by?: string | null }, userId: number | null, deps: UploadLabelDeps): Promise<{ document_id: number; file_name: string; tracking: { carrier: string | null; number: string | null; source: "typed" | "ai" | "none" }; return_by: string | null }> {
  const d = await claimOf(query, claimId);
  const isPdf = file.mimetype === "application/pdf" || (/\.pdf$/i.test(file.originalname) && file.buffer.subarray(0, 5).toString() === "%PDF-");
  if (!isPdf && !IMAGE_TYPES.test(file.mimetype)) throw new EditError(400, "Upload a PDF or an image");
  const pdf = isPdf ? file.buffer : await deps.imageToPdf(file.buffer, file.mimetype);
  const today = new Date().toISOString().slice(0, 10);
  const folder = await ensureMonthFolder(drive, today);
  const base = `${today}_${d.supplier}_${d.order_id}_return-label`;
  const taken = new Set([...(await folderFileNames(drive, folder.id)), ...(await query(`SELECT file_name FROM po_documents WHERE po_id = $1`, [d.po_id])).rows.map((r: any) => String(r.file_name))]);
  let name = `${base}.pdf`; for (let i = 2; taken.has(name); i++) name = `${base}-${i}.pdf`;
  const up = await uploadPdf(drive, folder.id, name, pdf);
  const docId = Number((await query(`INSERT INTO po_documents (po_id, type, drive_file_id, file_name, bytes, document_at, created_by_user_id, source, claim_id) VALUES ($1, 'return_label', $2, $3, $4, NOW(), $5, 'upload', $6) RETURNING id`, [d.po_id, up.id, name, up.bytes, userId, claimId])).rows[0].id);
  let carrier: string | null = body.carrier ? String(body.carrier).toUpperCase() : null, number: string | null = body.tracking_number?.trim() ? body.tracking_number.trim().toUpperCase() : null;
  let returnBy = isYmd(body.return_by) ? body.return_by : null;
  let source: "typed" | "ai" | "none" = number ? "typed" : "none";
  if (!number && isPdf && deps.readLabel !== null) {
    const read = await readLabelWithAi(query, pdf, d.supplier, userId, deps.readLabel ?? undefined);
    if (read?.trackingNumber) { number = read.trackingNumber; carrier = read.carrier ?? carrierForNumber(number); source = "ai"; }
    if (!returnBy && read?.returnBy) returnBy = read.returnBy;
  }
  await attachReturnLabel(query, claimId, { labelSource: "upload", labelAt: new Date().toISOString(), docId, carrier, trackingNumber: number, returnBy, returnBySource: "manual", trackingSource: source === "ai" ? "ai" : "manual" }, userId);
  return { document_id: docId, file_name: name, tracking: { carrier, number, source }, return_by: returnBy };
}
