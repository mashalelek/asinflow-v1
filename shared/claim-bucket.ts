// Supplier claims — buckets, the one timer, the step checklist (SPEC §22 "Supplier claims",
// docs/claude_spec-patch-supplier-claims.md §3.2–3.4, claims commit 2). Pure: no I/O, no Date.now().
//
//   bucket    — derived, never stored (§3.2). Precedence: an open task → Needs attention; otherwise the bucket of the
//               running timer (Waiting on supplier / shipment / refund to post / Velocity); closed and dismissed are their
//               own. A suggested claim always has an open review_suggestion task, so it lands in Needs attention.
//               Two tasks are PASSIVE (refund_received, replacement_arrived): they are Maria's tick when the money or
//               the units show up, not something to do now — they never pull a claim into Needs attention (otherwise
//               "Waiting on refund to post" could never occur, §3.2 vs §3.3); the row offers the tick as its Next action.
//   timer     — ONE timer, 5 business days (Mon–Fri, America/New_York; D7). It starts at the bucket's anchor (reported,
//               supplier confirmed, shipped, Velocity asked) or at the last Follow up / Check on it tick (a snooze restarts
//               it); when it runs out the sweep (server/claim-buckets.ts) creates follow_up_supplier (Waiting on supplier)
//               or check_on_it with the reason (every other bucket).
//   steps     — the checklist (§3.4): the path by outcome; steps that don't apply to the path aren't shown.

import type { ClaimOutcome, ClaimTaskKind } from "./supplier-claim";
import { CLAIM_TASK_LABELS } from "./supplier-claim";

export const CLAIM_BUCKETS = ["needs_attention", "waiting_supplier", "waiting_shipment", "waiting_refund", "waiting_velocity", "closed", "dismissed"] as const;
export type ClaimBucket = (typeof CLAIM_BUCKETS)[number];
export const CLAIM_BUCKET_LABELS: Readonly<Record<ClaimBucket, string>> = {
  needs_attention: "Needs attention", waiting_supplier: "Waiting on supplier", waiting_shipment: "Waiting on shipment",
  waiting_refund: "Waiting on refund to post", waiting_velocity: "Waiting on Velocity", closed: "Closed", dismissed: "Dismissed",
};
/** The tabs in order (Dismissed is a toggle on Closed, §5). */
export const CLAIM_BUCKET_TABS: readonly ClaimBucket[] = ["needs_attention", "waiting_supplier", "waiting_shipment", "waiting_refund", "waiting_velocity", "closed"];
export const TASK_GROUPS = ["decide", "supplier", "velocity", "money", "timed_out"] as const;
export type TaskGroup = (typeof TASK_GROUPS)[number];
export const TASK_GROUP_LABELS: Readonly<Record<TaskGroup, string>> = { decide: "Decide", supplier: "Supplier", velocity: "Velocity", money: "Money and arrivals", timed_out: "Timed out" };

/** Ticks that wait for the world (the refund posting, the replacement arriving): shown as the Next action, never Needs attention, and they never hold the timer (Maria 2026-11-11). */
export const PASSIVE_TASK_KINDS: ReadonlySet<string> = new Set(["refund_received", "replacement_arrived"]);
export const isActiveTask = (t: { kind: string; done_at: string | null }): boolean => !t.done_at && !PASSIVE_TASK_KINDS.has(t.kind);
export const BUSINESS_DAYS = 5;
export const BUSINESS_TZ = "America/New_York";

/** The claim fields the derivation reads (a ClaimRow has them all; dates are ISO strings or null). */
export interface BucketClaim {
  status: string; kind: string; outcome: ClaimOutcome | string | null;
  found_at: string; found_by?: string | null; reported_at: string | null; supplier_confirmed_at: string | null; last_supplier_reply_at?: string | null;
  closed_at: string | null; return_required?: boolean;
  replacement_shipped_at: string | null; replacement_arrived_at: string | null; qty_disposed: number | null;
  /** owed − Σ applied; null when the $ is not known. */
  remaining: number | null; received?: number; qty?: number | null;
  tasks: ReadonlyArray<{ kind: ClaimTaskKind | string; done_at: string | null; created_at?: string; snoozed_until?: string | null; reason?: string | null }>;
  /** The PO's destination: Velocity tasks exist only on a Velocity PO. */
  ships_to?: string | null;
}

export interface BucketResult {
  bucket: ClaimBucket;
  /** When this bucket started (the timer's anchor, or the last tick) — for Needs attention the oldest open task; null for closed / dismissed without a date. */
  since: string | null;
  /** The running timer's deadline (since + 5 business days); null when no timer runs — Needs attention (an open task holds it), closed, dismissed. */
  due: string | null;
  /** True when the timer has run out and no timeout task is open yet — the sweep creates one. */
  timedOut: boolean;
  /** The task the sweep creates when the timer runs out, with its reason. */
  timeout: { kind: "follow_up_supplier" | "check_on_it"; reason: string } | null;
}

const ts = (v: string | null | undefined): number | null => { if (!v) return null; const t = Date.parse(v.length === 10 ? `${v}T12:00:00Z` : v); return Number.isFinite(t) ? t : null; };
const latest = (...vs: Array<string | null | undefined>): string | null => vs.filter((v): v is string => !!v && ts(v) != null).sort((a, b) => ts(a)! - ts(b)!).pop() ?? null;
const doneAt = (c: BucketClaim, kind: string): string | null => latest(...c.tasks.filter((t) => t.kind === kind && t.done_at).map((t) => t.done_at));
const hasOpen = (c: BucketClaim, kind: string): boolean => c.tasks.some((t) => t.kind === kind && !t.done_at);
export const REFUND_OUTCOME_SET: ReadonlySet<string> = new Set(["refund_card", "gift_card", "store_credit"]);

// ── Business days (America/New_York) ────────────────────────────────────────

/** Y-M-D and the weekday (0 = Sunday) of an instant in the business time zone. */
function tzParts(at: Date, tz = BUSINESS_TZ): { y: number; m: number; d: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd };
}
/** Noon in the business zone of that calendar day is not needed: business days are counted on the zone's calendar dates. */
const dayKey = (p: { y: number; m: number; d: number }) => Date.UTC(p.y, p.m - 1, p.d);
const isWeekday = (wd: number) => wd >= 1 && wd <= 5;

/** Business days (Mon–Fri in `tz`) elapsed from `from` to `to`: whole calendar days of the zone that are weekdays, the start day excluded. Negative when `to` is before `from`. */
export function businessDaysBetween(from: Date | string, to: Date | string, tz = BUSINESS_TZ): number {
  const a = typeof from === "string" ? new Date(ts(from) ?? NaN) : from, b = typeof to === "string" ? new Date(ts(to) ?? NaN) : to;
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return 0;
  if (b < a) return -businessDaysBetween(b, a, tz);
  const pa = tzParts(a, tz), pb = tzParts(b, tz);
  let n = 0;
  // walk the zone's calendar from the day after `from` through `to`'s day
  for (let k = dayKey(pa) + 86_400_000; k <= dayKey(pb); k += 86_400_000) {
    const wd = new Date(k).getUTCDay();
    if (isWeekday(wd)) n++;
  }
  return n;
}
/** The instant `n` business days after `from` (same clock time, on the n-th weekday after `from`'s zone day). */
export function addBusinessDays(from: Date | string, n: number, tz = BUSINESS_TZ): Date {
  const a = typeof from === "string" ? new Date(ts(from) ?? NaN) : from;
  let k = dayKey(tzParts(a, tz)), left = n;
  while (left > 0) { k += 86_400_000; if (isWeekday(new Date(k).getUTCDay())) left--; }
  const days = Math.round((k - dayKey(tzParts(a, tz))) / 86_400_000);
  return new Date(a.getTime() + days * 86_400_000);
}
/** Days in bucket (calendar), whole, never negative. */
export function daysSince(since: string | null, now: Date): number | null {
  const t = ts(since);
  return t == null ? null : Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

// ── Bucket ──────────────────────────────────────────────────────────────────

/**
 * §3.2. The anchors: Waiting on refund to post — supplier confirmed (or the refund / credit promised) and money still owed;
 * Waiting on shipment — a replacement shipped and not arrived, or a return on its way (commit 7 adds the return tracking;
 * until then `send_label` ticked stands for the return at Velocity); Waiting on Velocity — a Velocity task ticked and
 * nothing changed yet (label sent, dispose asked, order change asked); Waiting on supplier — everything else once reported
 * (no reply yet, or an outcome promised but not confirmed).
 *
 * The timer (Maria 2026-11-11): it runs only while the claim has no open Needs attention task — a claim in Needs attention
 * never gets a Follow up / Check on it on top; the two passive ticks (Refund received, Replacement arrived) never hold it,
 * so a confirmed refund times out into Check on it "refund not posted". It restarts when the open task is ticked (any
 * tick; the Contact supplier tick counts from the report date typed on it).
 */
export function deriveBucket(c: BucketClaim, now: Date): BucketResult {
  const none: BucketResult = { bucket: "needs_attention", since: null, due: null, timedOut: false, timeout: null };
  if (c.status === "dismissed") return { ...none, bucket: "dismissed" };
  if (c.status === "closed") return { ...none, bucket: "closed", since: c.closed_at };
  // Needs attention: "since" = the oldest open task (what has been waiting for a hand the longest), the found date for a bare suggestion
  if (c.status === "suggested" || c.tasks.some(isActiveTask)) {
    const oldest = c.tasks.filter(isActiveTask).map((t) => t.created_at).filter((x): x is string => !!x).sort()[0] ?? c.found_at;
    return { ...none, since: new Date(ts(oldest) ?? Date.now()).toISOString() };
  }

  const outcome = c.outcome ?? null;
  let bucket: ClaimBucket; let anchor: string | null; let reason: string;
  const labelSent = doneAt(c, "send_label"), disposeAsked = doneAt(c, "dispose_units"), orderChangeAsked = doneAt(c, "update_velocity_order"), toldVelocity = doneAt(c, "tell_velocity_replacement");
  if (outcome === "replacement" && c.replacement_shipped_at && !c.replacement_arrived_at) {
    bucket = "waiting_shipment"; anchor = c.replacement_shipped_at; reason = "replacement shipped, not arrived";
  } else if (REFUND_OUTCOME_SET.has(outcome ?? "") && c.supplier_confirmed_at && (c.remaining == null || c.remaining > 0)) {
    bucket = "waiting_refund"; anchor = c.supplier_confirmed_at; reason = c.received && c.received > 0 ? "refund not posted in full" : "refund not posted";
  } else if (labelSent && c.return_required) {
    bucket = "waiting_velocity"; anchor = labelSent; reason = "return label sent, return not shipped";
  } else if (disposeAsked && c.qty_disposed == null) {
    bucket = "waiting_velocity"; anchor = disposeAsked; reason = "dispose asked, count not down";
  } else if (orderChangeAsked && !c.reported_at) {
    bucket = "waiting_velocity"; anchor = orderChangeAsked; reason = "order change asked";
  } else if (outcome === "replacement" && toldVelocity) {
    bucket = "waiting_shipment"; anchor = toldVelocity; reason = "replacement not shipped";
  } else if (outcome === "replacement") {
    bucket = "waiting_supplier"; anchor = doneAt(c, "confirm_outcome") ?? c.reported_at ?? doneAt(c, "contact_supplier"); reason = "replacement promised, no shipment";
  } else if (REFUND_OUTCOME_SET.has(outcome ?? "") && !c.supplier_confirmed_at) {
    bucket = "waiting_supplier"; anchor = doneAt(c, "confirm_outcome") ?? c.reported_at ?? doneAt(c, "contact_supplier"); reason = "refund promised, no confirmation";
  } else {
    // the report date Maria typed (reported_at), else the tick itself
    bucket = "waiting_supplier"; anchor = c.reported_at ?? doneAt(c, "contact_supplier") ?? c.found_at; reason = "no answer from the supplier";
  }
  // The timer never starts before the supplier was contacted (Maria 2026-11-12): an unreported claim — no report date,
  // no Contact supplier tick, no confirmation, not an emailed cancellation — waits for the Contacted supplier action in
  // Needs attention, whether or not its contact_supplier task exists (a converted claim may lack it).
  if (bucket === "waiting_supplier" && !isReported(c)) return { ...none, since: new Date(ts(c.found_at) ?? Date.now()).toISOString() };
  // Every tick restarts the timer (a snooze is such a tick) — except Contact supplier, whose typed report date
  // (reported_at) is the anchor itself; without a typed date its tick is the anchor through doneAt above. A supplier
  // reply (last_supplier_reply_at, the Supplier replied form) restarts it too (§5 amended 2026-11-12).
  const restart = latest(...c.tasks.filter((t) => t.done_at && t.kind !== "contact_supplier").map((t) => t.done_at), bucket === "waiting_supplier" ? c.last_supplier_reply_at ?? null : null);
  // normalized to an ISO instant (a date-only anchor such as reported_at reads as noon UTC)
  const since = new Date(ts(latest(anchor, restart) ?? c.found_at) ?? Date.now()).toISOString();
  const dueDate = addBusinessDays(since, BUSINESS_DAYS);
  const snoozed = c.tasks.filter((t) => t.snoozed_until && ts(t.snoozed_until)! > now.getTime()).length > 0;
  const timedOut = !snoozed && now.getTime() >= dueDate.getTime();
  const timeout = bucket === "waiting_supplier"
    ? { kind: "follow_up_supplier" as const, reason: `${BUSINESS_DAYS} business days: ${reason}` }
    : { kind: "check_on_it" as const, reason: `${BUSINESS_DAYS} business days: ${reason}` };
  return { bucket, since, due: dueDate.toISOString(), timedOut, timeout };
}

// ── Steps (§3.4) ─────────────────────────────────────────────────────────────

export interface ClaimStep { key: string; label: string; done: boolean; at: string | null; current: boolean; /** The row's Step text while this step is current ("Report to supplier"). */ todo?: string }

/** The path's checklist with ✓ per step and the current one. */
export function claimSteps(c: BucketClaim): ClaimStep[] {
  const outcome = c.outcome ?? null;
  const emailed = c.kind === "canceled" && c.found_by === "email";
  const closed = c.status === "closed";
  const reportedAt = c.reported_at ?? doneAt(c, "contact_supplier");
  const promisedAt = outcome ? doneAt(c, "confirm_outcome") ?? c.supplier_confirmed_at ?? reportedAt : null;
  const steps: Array<Omit<ClaimStep, "current">> = [{ key: "found", label: "Found", done: true, at: c.found_at }];
  if (!emailed) steps.push({ key: "reported", label: reportedAt || closed ? "Reported" : "Report", done: !!reportedAt || closed, at: reportedAt, todo: "Report to supplier" });
  // "Supplier answers · outcome" (mockup 2026-11-12): done once the supplier replied or the outcome is known; before the rest of the path
  if (!emailed && outcome !== "write_off" && outcome !== "replacement") steps.push({ key: "answered", label: outcome ? `Supplier answered · ${outcome.replace("_", " ")}` : "Supplier answers · outcome", done: !!outcome || !!c.last_supplier_reply_at || closed, at: c.last_supplier_reply_at ?? (outcome ? doneAt(c, "confirm_outcome") ?? c.supplier_confirmed_at : null), todo: "Supplier's answer" });
  if (outcome === "replacement") {
    steps.push({ key: "promised", label: "Promised", done: true, at: promisedAt });
    if (c.ships_to !== "home") steps.push({ key: "tell_velocity", label: "Tell Velocity", done: !!doneAt(c, "tell_velocity_replacement") || !!c.replacement_shipped_at || closed, at: doneAt(c, "tell_velocity_replacement") });
    steps.push({ key: "shipped", label: "Shipped", done: !!c.replacement_shipped_at || !!c.replacement_arrived_at, at: c.replacement_shipped_at });
    steps.push({ key: "arrived", label: "Arrived", done: !!c.replacement_arrived_at, at: c.replacement_arrived_at });
  } else if (outcome === "write_off") {
    steps.push({ key: "written_off", label: "Written off", done: true, at: c.closed_at });
    if (c.tasks.some((t) => t.kind === "dispose_units")) steps.push({ key: "dispose", label: "Dispose", done: !!doneAt(c, "dispose_units") && c.qty_disposed != null, at: doneAt(c, "dispose_units") });
  } else {
    if (c.return_required) {
      steps.push({ key: "label", label: "Label", done: !!doneAt(c, "upload_return_label") || !!doneAt(c, "send_label"), at: doneAt(c, "upload_return_label") });
      steps.push({ key: "label_sent", label: "Sent to Velocity", done: !!doneAt(c, "send_label"), at: doneAt(c, "send_label") });
      steps.push({ key: "return_shipped", label: "Shipped", done: false, at: null });   // commit 7: the return's tracking
      steps.push({ key: "return_delivered", label: "Delivered", done: false, at: null });
    }
    steps.push({ key: "confirmed", label: "Confirmed by supplier", done: !!c.supplier_confirmed_at || (closed && outcome != null), at: c.supplier_confirmed_at });
    steps.push({ key: "received", label: "Received", done: c.remaining != null && c.remaining <= 0.005 && (c.received ?? 0) > 0 || (closed && outcome != null && outcome !== "write_off"), at: closed ? c.closed_at : null });
  }
  steps.push({ key: "closed", label: "Closed", done: closed, at: c.closed_at });
  let currentSet = false;
  return steps.map((s) => { const current = !s.done && !currentSet && c.status !== "dismissed"; if (current) currentSet = true; return { ...s, current }; });
}

/** Reported = a typed report date, a Contact supplier tick, or the supplier's confirmation; an emailed cancellation needs no report. */
export function isReported(c: Pick<BucketClaim, "reported_at" | "supplier_confirmed_at" | "kind" | "found_by" | "tasks">): boolean {
  if (c.kind === "canceled" && c.found_by === "email") return true;
  return !!c.reported_at || !!c.supplier_confirmed_at || !!doneAt(c as BucketClaim, "contact_supplier");
}

/** The row's "Next action": the open task, else what the timer waits for. */
export function nextAction(c: BucketClaim, b: BucketResult): string {
  const open = c.tasks.filter((t) => !t.done_at);
  if (open.length) return open.map((t) => CLAIM_TASK_LABELS[t.kind as ClaimTaskKind] ?? t.kind).join(" · ");
  if (b.bucket === "needs_attention" && c.status === "open" && !isReported(c)) return "Contact supplier";
  switch (b.bucket) {
    case "waiting_supplier": return c.outcome && !c.supplier_confirmed_at ? "waiting for the supplier's confirmation" : "waiting for the supplier's answer";
    case "waiting_shipment": return "waiting for the carrier";
    case "waiting_refund": return "waiting for the refund to post";
    case "waiting_velocity": return "waiting for Velocity";
    case "closed": return "";
    case "dismissed": return "";
    default: return "";
  }
}
