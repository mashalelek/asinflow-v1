// Supplier claims — the words and controls of the two pages (SPEC §22 "Supplier claims" §5 amended 2026-11-12: the
// mockups docs/mockups/claims-list-2026-11-12.html and claim-detail-2026-11-12.html; commit 2b). Pure, no I/O.
//   stateSentence   — the row's Step and the header's state: ONE plain sentence of what is going on (a suggestion's
//                     figures and its two causes, "Report to supplier", "Reported 11/5 by chat · no answer in 5 business
//                     days", "Confirmed 10/28 · short by $42.00", …). Never the word "waiting" before the report.
//   primaryAction   — the row's Do column: ONE primary button for the task (plus Dismiss / Snooze where they apply).
//   stepActions     — the Steps list per path, every step with the handler that sets or changes it.
//   whatHappensNext — the detail's "What happens next" box: now · then · then.
import { CLAIM_KIND_LABELS, CLAIM_OUTCOME_LABELS, CLAIM_TASK_LABELS, type ClaimTaskKind } from "./supplier-claim";
import { BUSINESS_DAYS, claimSteps, isReported, effectiveTasks, supplierConfirmedAt, TIMEOUT_REASON_RE, PASSIVE_TASK_KINDS, isActiveTask, returnLabelAt, returnSentAt, returnPending, type BucketClaim, type BucketResult, type ClaimStep } from "./claim-bucket";
import { carrierStatusText } from "./carrier-status";

export interface UiTask { id: number; kind: ClaimTaskKind | string; reason?: string | null; done_at: string | null; created_at?: string; snoozed_until?: string | null; /** An email-made task (commit 6): the email behind it. */ gmail_message_id?: string | null; mailbox?: string | null; payload?: Record<string, unknown> | null }
/** What the sentences read beyond BucketClaim. */
export interface UiClaim extends BucketClaim {
  id?: number;
  /** The supplier's confirmation came from a refund / credit email (commit 6, row 1). */
  email_confirmed?: boolean;
  reported_channel?: string | null;
  outcome_amount?: number | null;
  owed?: number | null;
  /** The line's Ordered (Individual units) for "2 of 24"; null for a whole-PO claim or a legacy line. */
  ordered?: number | null;
  refunds?: ReadonlyArray<{ id: number; amount: number | null; amount_applied: number | null }>;
  tasks: ReadonlyArray<UiTask>;
  write_off_reason?: string | null;
  source_items_json?: unknown;
  /** The reason typed on Dismiss; the claim's note stands in when none was typed. */
  dismiss_reason?: string | null;
  note?: string | null;
  /** The return (claims commit 7): the saved label's document (the row's "label" link) and what the Velocity message names. */
  return_label_doc_id?: number | null;
  product_name?: string | null; asin?: string | null; order_id?: string | null; supplier?: string | null;
}
const fmtMDY = (iso: string | null | undefined): string => { if (!iso) return "?"; const [y, m, d] = iso.slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}/${y}`; };
/** "· from email" / "· from tracking" / "· set at confirmation, before tracking" after a return date (null = nothing). */
export const sourceWord = (source: string | null | undefined): string | null =>
  source === "email" ? "from email" : source === "tracking" ? "from tracking" : source === "confirmation" ? "set at confirmation, before tracking" : null;
const suffix = (source: string | null | undefined) => { const w = sourceWord(source); return w ? ` · ${w}` : ""; };
const CARRIER_WORDS: Record<string, string> = { UPS: "UPS", FEDEX: "FedEx", USPS: "USPS", DHL: "DHL", AMAZON: "Amazon", GLS: "GLS", ONTRAC: "OnTrac", LASERSHIP: "LaserShip" };
export const carrierWord = (c: string | null | undefined): string => (c ? CARRIER_WORDS[c.toUpperCase()] ?? c : "carrier");
/** "FedEx in transit · due 11/17" from the return's tracking row; "" when AF has no carrier word yet. */
const carrierPhrase = (c: UiClaim): string => {
  const t = c.return_tracking; if (!t) return "";
  const w = carrierStatusText(t);
  const status = w ? (w.source === "velocity" ? w.text : w.text.toLowerCase()) : null;
  return `${status ? ` · ${carrierWord(t.carrier)} ${status}` : ""}${t.est_delivery_at && !t.delivered_at ? ` · due ${fmtMD(t.est_delivery_at)}` : ""}`;
};
/** The return-by phrase of the Needs attention rows: "return by 11/30" (Velocity) / "drop off by 11/20" (home); "" without a date. */
const returnByPhrase = (c: UiClaim, home: boolean) => (c.return_by ? ` · ${home ? "drop off" : "return"} by ${fmtMD(c.return_by)}` : "");
/** The label phrase: "Return label saved 10/31 · from email" / "No label" / "Return label uploaded 11/2". */
const labelPhrase = (c: UiClaim) => (c.return_no_label ? "No label" : `Return label ${c.return_label_source === "upload" ? "uploaded" : "saved"} ${fmtMD(returnLabelAt(c))}${suffix(c.return_label_source)}`);
/**
 * Copy message for Velocity (§3.12): plain text for the clipboard — AF sends nothing (D13: Discord stays manual).
 * "Please ship back N units of <product> (<ASIN>) from order <order #> using the attached label. It has to go out by <return-by date>."
 */
export function velocityMessage(c: UiClaim): string {
  const n = c.qty == null ? "the" : String(c.qty);
  const product = c.product_name ?? "the product";
  const head = `Please ship back ${n} units of ${product}${c.asin ? ` (${c.asin})` : ""} from order ${c.order_id ?? "?"} using the ${c.return_no_label ? "return instructions" : "attached label"}.`;
  return c.return_by ? `${head} It has to go out by ${fmtMDY(c.return_by)}.` : head;
}

export const fmtMD = (iso: string | null | undefined): string => { if (!iso) return "?"; const [, m, d] = iso.slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}`; };
export const fmtMoney = (v: number | null | undefined): string => (v == null ? "—" : `$${v.toFixed(2)}`);
// effectiveTasks: an open contact_supplier task on a reported claim is ignored — the same set the bucket reads (one derivation, Maria 2026-11-12).
const openTasks = (c: UiClaim) => effectiveTasks(c).filter((t) => !t.done_at);
const openOf = (c: UiClaim, kind: string) => openTasks(c).find((t) => t.kind === kind) ?? null;
const doneAt = (c: UiClaim, kind: string): string | null => c.tasks.filter((t) => t.kind === kind && t.done_at).map((t) => t.done_at!).sort().pop() ?? null;
const emailed = (c: UiClaim) => c.kind === "canceled" && c.found_by === "email";
const short = (c: UiClaim) => (c.received ?? 0) > 0 && c.remaining != null && c.remaining > 0.005 ? ` · short by ${fmtMoney(c.remaining)}` : "";
const outcomeWord = (c: UiClaim) => (c.outcome ? CLAIM_OUTCOME_LABELS[c.outcome as keyof typeof CLAIM_OUTCOME_LABELS] ?? String(c.outcome) : null);
const reportedText = (c: UiClaim) => `Reported ${fmtMD(c.reported_at ?? doneAt(c, "contact_supplier"))}${c.reported_channel ? ` by ${c.reported_channel}` : ""}`;

/** Pure: ONE sentence for the row's Step / the header. */
export function stateSentence(c: UiClaim, b: BucketResult): string {
  // an email task's sentence (commit 6, the mockups' Step text) comes first: on a closed, dismissed or unreported claim alike
  const emailTask = openTasks(c).find((t) => t.kind === "review_email_match" || t.kind === "closed_claim_email" || t.kind === "read_reply");
  if (emailTask) return emailTask.reason ?? CLAIM_TASK_LABELS[emailTask.kind as ClaimTaskKind];
  // the Dismissed tab's Step: why (the typed reason, else the claim's note) — Maria 2026-11-12
  if (c.status === "dismissed") return `Dismissed${c.dismiss_reason ? ` · ${c.dismiss_reason}` : c.note ? ` · ${c.note}` : ""}`;
  // a written-off claim with Velocity still to act reads its task / its wait, not "Closed" (its bucket says so)
  if (c.status === "closed" && b.bucket === "closed") return `Closed ${fmtMD(c.closed_at)}${outcomeWord(c) ? ` · ${outcomeWord(c)}` : ""}${c.write_off_reason ? ` · ${c.write_off_reason}` : ""}`;
  const sug = openOf(c, "review_suggestion");
  if (c.status === "suggested" || sug) return sug?.reason ?? "Suggested — open or dismiss";
  if (!isReported(c)) return "Report to supplier";
  const act = openTasks(c).filter((t) => isActiveTask(t as any));
  // the return-by warning (§3.12 row 9) is the urgent one: it speaks before an older Send label / Dropped off task
  const first = act.find(isReturnByWarning) ?? act[0];
  if (first) {
    switch (first.kind) {
      case "confirm_outcome": return first.reason ?? "Supplier replied · confirm the outcome";
      // the three email tasks carry their sentence (the mockups' Step text); the row adds "· open email"
      case "read_reply": case "review_email_match": case "closed_claim_email": return first.reason ?? CLAIM_TASK_LABELS[first.kind as ClaimTaskKind];
      case "enter_quantity": return "Quantity not known yet · type the Individual units";
      case "contact_supplier": return TIMEOUT_REASON_RE.test(first.reason ?? "") ? `${capital(first.reason!.replace(TIMEOUT_REASON_RE, ""))} in ${BUSINESS_DAYS} business days · contact the supplier` : "Report to supplier";
      case "follow_up_supplier": return `${reportedText(c)} · no answer in ${BUSINESS_DAYS} business days`;
      case "confirm_reship_order": return first.reason ?? "A reship order # arrived · confirm it";
      // §3.12 rows 1 / 2 / 3 (the list mockup): the label, where it ships from, the return-by date
      case "send_label": return `${labelPhrase(c)} · ${c.return_no_label ? "tell Velocity to ship it back" : "send it to Velocity"}${returnByPhrase(c, false)}`;
      case "drop_off_return": return `${labelPhrase(c)} · ships from home${returnByPhrase(c, true)}`;
      case "tell_velocity_replacement": return "Replacement promised · tell Velocity it is coming";
      case "dispose_units": return `${outcomeWord(c) ?? "Settled"} · ask Velocity to dispose ${c.qty ?? "the"} units`;
      case "update_velocity_order": return first.reason ?? "Update the Velocity order";
      case "upload_return_label": return "A return is needed · no label yet";
      case "check_on_it": return checkOnItSentence(c, first.reason ?? null);
      default: return CLAIM_TASK_LABELS[first.kind as ClaimTaskKind] ?? String(first.kind);
    }
  }
  switch (b.bucket) {
    // "Refund confirmed 9/23 · check the card" (Maria 2026-11-12): what was confirmed, when, and where to look
    // a refund / credit the supplier's own email confirmed (commit 6, row 1 — the list mockup): "Supplier confirmed $77.23 refund 11/12 · from email · waiting for it to post"
    case "waiting_refund": return c.email_confirmed
      ? `Supplier confirmed ${c.outcome_amount != null ? `$${c.outcome_amount.toFixed(2)} ` : ""}${refundWord(c).toLowerCase()} ${fmtMD(supplierConfirmedAt(c))} · from email · waiting for it to post${short(c)}`
      : `${refundWord(c)} confirmed ${fmtMD(supplierConfirmedAt(c))} · check the ${refundWhere(c)}${short(c)}`;
    // §3.12 rows 4 / 5 (the list mockup): "Return shipped 11/13 · FedEx in transit · due 11/17 · from tracking"; "Dropped off 11/12 · waiting for the first carrier scan"
    case "waiting_shipment": return c.outcome === "replacement" && c.replacement_shipped_at ? `Replacement shipped ${fmtMD(c.replacement_shipped_at)} · not arrived`
      : returnPending(c) && c.return_shipped_at ? `Return shipped ${fmtMD(c.return_shipped_at)}${carrierPhrase(c)}${suffix(c.return_shipped_source)}`
      : returnPending(c) && returnSentAt(c) ? `Dropped off ${fmtMD(returnSentAt(c))} · waiting for the first carrier scan`
      : "Return on its way to the supplier";
    // dispose asked wins over an older label (a written-off claim whose return never moved, Maria 2026-11-12)
    case "waiting_velocity": return doneAt(c, "dispose_units") && c.qty_disposed == null ? "Velocity asked to dispose · count not down yet" : returnSentAt(c) ? `Label sent ${fmtMD(returnSentAt(c))} · waiting for the first carrier scan` : "Velocity asked · nothing changed yet";
    case "waiting_supplier": {
      // row 6: delivered to the supplier, the refund confirmation to come
      if (c.return_required && c.return_delivered_at && !supplierConfirmedAt(c)) return `Return delivered ${fmtMD(c.return_delivered_at)}${suffix(c.return_delivered_source)} · waiting for the refund confirmation`;
      const reply = c.last_supplier_reply_at ? `Supplier replied ${fmtMD(c.last_supplier_reply_at)}` : null;
      if (c.outcome && !c.supplier_confirmed_at) return `${reply ?? reportedText(c)} · ${outcomeWord(c)} promised · no confirmation yet`;
      return emailed(c) ? `Canceled per the supplier's email ${fmtMD(c.found_at)} · no refund seen yet` : c.kind === "canceled" ? `Canceled ${fmtMD(c.found_at)} · no refund seen yet` : `${reply ?? reportedText(c)} · no answer yet`;
    }
    default: return openTasks(c).map((t) => CLAIM_TASK_LABELS[t.kind as ClaimTaskKind] ?? t.kind).join(" · ") || reportedText(c);
  }
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isReturnByWarning = (t: { kind: string; reason?: string | null }) => t.kind === "check_on_it" && /^return by /i.test(t.reason ?? "");
/**
 * The Timed out row's sentence. A timer timeout ("5 business days: …"): the return reasons read "Label sent to Velocity 11/3 · no
 * carrier scan in 5 business days" (the list mockup); every other "<reason> · 5 business days". The return-by warning (row 9):
 * "Return by 11/16 · 3 days left · label saved 10/20, not shipped yet". A carrier exception: its reason as written.
 */
function checkOnItSentence(c: UiClaim, reason: string | null): string {
  if (!reason) return "Timed out · check on it";
  if (TIMEOUT_REASON_RE.test(reason)) {
    const core = reason.replace(TIMEOUT_REASON_RE, "");
    return / · no /.test(core) ? `${capital(core)} in ${BUSINESS_DAYS} business days` : `${capital(core)} · ${BUSINESS_DAYS} business days`;
  }
  if (/^return by /i.test(reason)) return `${capital(reason)} · label ${c.return_label_source === "upload" ? "uploaded" : "saved"} ${fmtMD(returnLabelAt(c))}, not shipped yet`;
  return capital(reason);
}
const refundWord = (c: UiClaim) => (c.outcome === "gift_card" ? "Gift card" : c.outcome === "store_credit" ? "Store credit" : "Refund");
const refundWhere = (c: UiClaim) => (c.outcome === "gift_card" ? "gift card" : c.outcome === "store_credit" ? "account" : "card");

export interface PrimaryAction {
  /** What the button does: tick this task (`task`), the Contacted supplier form (`contact`), go to the detail (`detail`), the refund form (`refund`), reopen a dismissed claim (`reopen`), nothing (`none`). */
  kind: "task" | "contact" | "detail" | "refund" | "reopen" | "none";
  label: string;
  taskId?: number;
  taskKind?: string;
  /** The second control beside the button (commit 6: Not this claim / Set outcome / Nothing to do beside the email tasks' buttons; commit 7: No label beside Upload label). */
  secondary: "dismiss" | "snooze" | "not_this" | "set_outcome" | "nothing" | "no_label" | null;
  /** The row's links after its sentence (§3.12 rows 1 / 2): the saved label and the Velocity message to copy. */
  links?: { label_doc_id: number | null; copy_message: string | null } | null;
  /** The decision the tick sends (review_email_match: attach; closed_claim_email: reopen; read_reply: keep). */
  decision?: "attach" | "reopen" | "keep";
  /** The email the row's sentence links to ("open email"), from the task behind the action. */
  email?: { id: string; mailbox: string } | null;
  /** The tick needs this control before it can be saved. */
  needs?: "order_id" | "qty" | null;
}
/** The email behind an email-made task (the row's "open email"). */
export const emailOf = (t: UiTask | undefined | null): { id: string; mailbox: string } | null => (t?.gmail_message_id ? { id: t.gmail_message_id, mailbox: t.mailbox ?? "" } : null);
/** Pure: the row's Do column. */
export function primaryAction(c: UiClaim, b: BucketResult): PrimaryAction {
  // an email on a closed / dismissed claim (commit 6, row 8) asks before the closed / dismissed defaults
  const closedEmail = c.tasks.find((t) => t.kind === "closed_claim_email" && !t.done_at);
  if (closedEmail) return { kind: "task", label: "Reopen", taskId: closedEmail.id, taskKind: closedEmail.kind, secondary: "nothing", decision: "reopen", email: emailOf(closedEmail) };
  if (b.bucket === "dismissed") return { kind: "reopen", label: "Reopen", secondary: null };
  if (b.bucket === "closed") return { kind: "none", label: "", secondary: null };
  const open = openTasks(c);
  const by = (k: string) => open.find((t) => t.kind === k);
  let t: UiTask | undefined;
  if ((t = by("review_suggestion"))) return { kind: "task", label: "Open claim", taskId: t.id, taskKind: t.kind, secondary: "dismiss" };
  // the return-by warning (§3.12 row 9) before the Send label / Dropped off task it sits on
  if ((t = open.find(isReturnByWarning))) return { kind: "task", label: "Check on it", taskId: t.id, taskKind: t.kind, secondary: "snooze" };
  // supplier emails (commit 6, §3.11 — the mockups' Do column): Attach / Not this claim, Keep waiting / Set outcome, Reopen / Nothing to do
  if ((t = by("review_email_match"))) return { kind: "task", label: "Attach", taskId: t.id, taskKind: t.kind, secondary: "not_this", decision: "attach", email: emailOf(t) };
  if ((t = by("closed_claim_email"))) return { kind: "task", label: "Reopen", taskId: t.id, taskKind: t.kind, secondary: "nothing", decision: "reopen", email: emailOf(t) };
  if ((t = by("read_reply"))) return { kind: "task", label: "Keep waiting", taskId: t.id, taskKind: t.kind, secondary: "set_outcome", decision: "keep", email: emailOf(t) };
  if ((t = by("confirm_outcome"))) return { kind: "detail", label: "Confirm outcome", taskId: t.id, taskKind: t.kind, secondary: null, email: emailOf(t) };
  if ((t = by("enter_quantity"))) return { kind: "detail", label: "Enter quantity", taskId: t.id, taskKind: t.kind, secondary: null, needs: "qty" };
  if ((t = by("contact_supplier")) || (c.status === "open" && !isReported(c))) return { kind: "contact", label: "Contacted supplier", taskId: t?.id, taskKind: "contact_supplier", secondary: t && TIMEOUT_REASON_RE.test(t.reason ?? "") ? "snooze" : null };
  if ((t = by("follow_up_supplier"))) return { kind: "contact", label: "Followed up", taskId: t.id, taskKind: t.kind, secondary: "snooze" };
  if ((t = by("confirm_reship_order"))) return { kind: "detail", label: "Add order #", taskId: t.id, taskKind: t.kind, secondary: null, needs: "order_id" };
  if ((t = by("upload_return_label"))) return { kind: "detail", label: "Upload label", taskId: t.id, taskKind: t.kind, secondary: "no_label" };
  if ((t = by("send_label"))) return { kind: "task", label: "Sent label", taskId: t.id, taskKind: t.kind, secondary: null, links: { label_doc_id: c.return_label_doc_id ?? null, copy_message: velocityMessage(c) } };
  if ((t = by("drop_off_return"))) return { kind: "task", label: "Dropped off", taskId: t.id, taskKind: t.kind, secondary: null, links: { label_doc_id: c.return_label_doc_id ?? null, copy_message: null } };
  if ((t = by("tell_velocity_replacement"))) return { kind: "task", label: "Told Velocity", taskId: t.id, taskKind: t.kind, secondary: null };
  if ((t = by("dispose_units"))) return { kind: "task", label: "Asked", taskId: t.id, taskKind: t.kind, secondary: null };
  if ((t = by("update_velocity_order"))) return { kind: "task", label: "Updated", taskId: t.id, taskKind: t.kind, secondary: null };
  if ((t = by("check_on_it"))) return { kind: "task", label: "Check on it", taskId: t.id, taskKind: t.kind, secondary: "snooze" };
  if ((t = by("refund_received"))) return { kind: "refund", label: "Refund received", taskId: t.id, taskKind: t.kind, secondary: null };
  if ((t = by("replacement_arrived"))) return { kind: "task", label: "Arrived", taskId: t.id, taskKind: t.kind, secondary: null };
  if (b.bucket === "waiting_refund") return { kind: "refund", label: "Refund received", secondary: null };
  return { kind: "none", label: "", secondary: null };
}

/** The group a Needs attention row sits under (the first open active task's group; an unreported claim → Supplier). */
export function needsAttentionGroup(c: UiClaim): "decide" | "supplier" | "velocity" | "money" | "timed_out" | null {
  const a = primaryAction(c, { bucket: "needs_attention", since: null, due: null, timedOut: false, timeout: null });
  const k = a.taskKind;
  if (!k && a.kind === "contact") return "supplier";
  if (!k) return null;
  if (k === "check_on_it") return "timed_out";
  if (k === "review_suggestion" || k === "confirm_outcome" || k === "enter_quantity" || k === "review_email_match" || k === "closed_claim_email") return "decide";
  if (k === "contact_supplier" || k === "follow_up_supplier" || k === "confirm_reship_order" || k === "read_reply") return "supplier";
  if (k === "send_label" || k === "tell_velocity_replacement" || k === "dispose_units" || k === "update_velocity_order") return "velocity";
  return "money";
}
export const GROUP_HINTS: Readonly<Record<string, string>> = { decide: "suggestions and outcomes to confirm", supplier: "contact or follow up", velocity: "one Discord message", money: "check the card", timed_out: "" };
/** The group's hint with email rows in it (the list mockup 2026-11-13): Decide "emails AF wasn't sure about, and outcomes to confirm", Supplier "replies to read". */
export function groupHint(group: string, rows: ReadonlyArray<{ action: { taskKind?: string } }>): string {
  const kinds = new Set(rows.map((r) => r.action.taskKind));
  if (group === "decide" && (kinds.has("review_email_match") || kinds.has("closed_claim_email"))) return "emails AF wasn't sure about, and outcomes to confirm";
  if (group === "supplier" && kinds.has("read_reply")) return "replies to read";
  // returns (the list mockup 2026-11-13): Money and arrivals "returns you handle yourself" when its rows are returns
  if (group === "money" && (kinds.has("drop_off_return") || kinds.has("upload_return_label"))) return "returns you handle yourself";
  return GROUP_HINTS[group] ?? "";
}

// ── Steps with handlers ───────────────────────────────────────────────────────
export type StepHandler =
  | { type: "edit_found" }                 // Found: change the found date
  | { type: "contact" }                    // Report: the Contacted supplier form
  | { type: "reply" }                      // Supplier answers · outcome: the Supplier replied form
  | { type: "confirm" }                    // Confirmed by supplier: date (+ outcome when none)
  | { type: "refund" }                     // Received: + Refund received
  | { type: "write_off" }                  // Closed / Written off: write off (reason)
  | { type: "replacement_promised" }       // Promised: set outcome = replacement (date)
  | { type: "replacement_shipped" }        // Shipped: the ship date
  | { type: "replacement_arrived" }        // Arrived: the arrival date (closes)
  | { type: "task"; task: ClaimTaskKind }  // a task tick: tell Velocity, dispose
  | { type: "task_dated"; task: ClaimTaskKind }  // Sent to Velocity / Dropped off: the tick carries its date; done → change the date
  | { type: "return_label" }               // Label: upload the label (PDF / image) or No label
  | { type: "return_date"; step: "shipped" | "delivered" }  // Shipped / Delivered: set or change by hand — a hand-set date is never overwritten by tracking
  | { type: "none"; why: string };
export interface UiStep extends ClaimStep { handler: StepHandler }

/** Pure: the Steps list per path, every step with its handler. */
export function stepActions(c: UiClaim): UiStep[] {
  const steps = claimSteps(c);
  const outcome = c.outcome ?? null;
  const out: UiStep[] = [];
  for (const s of steps) {
    let handler: StepHandler;
    switch (s.key) {
      case "found": handler = { type: "edit_found" }; break;
      case "reported": handler = { type: "contact" }; break;
      case "answered": handler = { type: "reply" }; break;
      case "confirmed": handler = { type: "confirm" }; break;
      case "received": handler = { type: "refund" }; break;
      case "closed": handler = outcome === "replacement" ? { type: "replacement_arrived" } : { type: "write_off" }; break;
      case "written_off": handler = { type: "write_off" }; break;
      case "promised": handler = { type: "replacement_promised" }; break;
      case "tell_velocity": handler = { type: "task", task: "tell_velocity_replacement" }; break;
      case "shipped": handler = { type: "replacement_shipped" }; break;
      case "arrived": handler = { type: "replacement_arrived" }; break;
      case "dispose": handler = { type: "task", task: "dispose_units" }; break;
      case "label": handler = { type: "return_label" }; break;
      case "label_sent": handler = { type: "task_dated", task: c.ships_to === "home" ? "drop_off_return" : "send_label" }; break;
      case "return_shipped": handler = { type: "return_date", step: "shipped" }; break;
      case "return_delivered": handler = { type: "return_date", step: "delivered" }; break;
      default: handler = { type: "none", why: "no handler" };
    }
    out.push({ ...s, handler });
  }
  return out;
}

/** Pure: the "What happens next" box — now · then · then. */
export function whatHappensNext(c: UiClaim, b: BucketResult): Array<{ when: "Now" | "Then" | "Or" | "If it stalls"; text: string }> {
  if (c.status === "closed" && b.bucket === "closed") return [{ when: "Now", text: `Closed ${fmtMD(c.closed_at)}${outcomeWord(c) ? ` · ${outcomeWord(c)}` : ""}. Reopen from More if something changes.` }];
  if (c.status === "dismissed") return [{ when: "Now", text: "Dismissed. Reopen from More to take it up again." }];
  const paths = "the supplier's answer sets the outcome: refund → Confirmed → Received; replacement → Promised → Shipped → Arrived; nothing → Write off";
  if (c.status === "suggested") return [{ when: "Now", text: "in Needs attention › Decide until you open or dismiss the suggestion" }, { when: "Then", text: "Report to supplier · the timer starts from the report date" }, { when: "Then", text: paths }];
  if (!isReported(c)) return [{ when: "Now", text: "in Needs attention › Supplier until you record the contact" }, { when: "Then", text: `Waiting on supplier · Follow up after ${BUSINESS_DAYS} business days with no reply` }, { when: "Then", text: paths }];
  const timer = b.due ? ` · timer runs out ${fmtMD(b.due)}` : "";
  // a return on its way (§3.12, the detail mockup): the carrier moves it on, the refund email after, Check on it if it stalls
  if (returnPending(c) && (b.bucket === "waiting_shipment" || b.bucket === "waiting_velocity")) {
    const carrier = carrierWord(c.return_tracking?.carrier);
    const now = b.bucket === "waiting_velocity" ? "in Waiting on Velocity — the label is with Velocity, waiting for the first carrier scan" : c.return_shipped_at ? "in Waiting on shipment — the carrier has the return" : "in Waiting on shipment — dropped off, waiting for the first carrier scan";
    return [
      { when: "Now", text: now },
      ...(c.return_shipped_at ? [] : [{ when: "Then" as const, text: `the first ${carrier} scan → Shipped · Waiting on shipment` }]),
      { when: "Then", text: `${carrier} shows delivered → Waiting on supplier for the refund confirmation` },
      { when: "Then", text: "refund email → Waiting on refund to post → you tick Received → Closed" },
      { when: "If it stalls", text: `no scan for ${BUSINESS_DAYS} business days, or delivered with no refund email in ${BUSINESS_DAYS} business days → Check on it${c.return_by && !c.return_shipped_at ? ` · return by ${fmtMD(c.return_by)}: a warning 3 days before` : ""}` },
    ];
  }
  if (c.return_required && c.return_delivered_at && b.bucket === "waiting_supplier") return [
    { when: "Now", text: `Waiting on supplier${timer} — the return is delivered, the refund confirmation to come · Check on it after ${BUSINESS_DAYS} business days` },
    { when: "Then", text: "refund email → Waiting on refund to post → you tick Received → Closed" },
  ];
  switch (b.bucket) {
    case "needs_attention": return [{ when: "Now", text: `in Needs attention until ${openTasks(c).filter((t) => isActiveTask(t as any)).map((t) => (CLAIM_TASK_LABELS[t.kind as ClaimTaskKind] ?? t.kind).toLowerCase()).join(", ") || "the task"} is done` }, { when: "Then", text: paths }];
    case "waiting_supplier": return [{ when: "Now", text: `Waiting on supplier${timer} · Follow up after ${BUSINESS_DAYS} business days with no reply` }, { when: "Then", text: c.outcome ? `the supplier confirms the ${outcomeWord(c)} → ${c.outcome === "replacement" ? "Shipped → Arrived" : "Waiting on refund to post → Received"}` : paths }];
    case "waiting_refund": return [{ when: "Now", text: `Waiting on refund to post${c.email_confirmed ? " — AF moved it here when the refund email matched" : ""}${timer} · ${c.kind === "canceled" ? "Contact supplier" : "Check on it"} after ${BUSINESS_DAYS} business days` }, { when: "Then", text: "the refund posts → + Refund received closes the claim; short → Write off remainder or wait for the rest" }];
    case "waiting_shipment": return [{ when: "Now", text: `Waiting on shipment${timer} · Check on it if the carrier goes quiet` }, { when: "Then", text: c.outcome === "replacement" ? "the replacement arrives → Arrived closes the claim" : "the return is delivered → the supplier confirms the refund" }];
    case "waiting_velocity": return [{ when: "Now", text: `Waiting on Velocity${timer} · Check on it after ${BUSINESS_DAYS} business days` }, { when: "Then", text: "Velocity acts → the next step on the path" }];
    default: return [{ when: "Now", text: paths }];
  }
}

export const kindLabel = (k: string) => CLAIM_KIND_LABELS[k as keyof typeof CLAIM_KIND_LABELS] ?? k;
export { PASSIVE_TASK_KINDS };
