// Supplier claims — the words and controls of the two pages (SPEC §22 "Supplier claims" §5 amended 2026-11-12: the
// mockups docs/mockups/claims-list-2026-11-12.html and claim-detail-2026-11-12.html; commit 2b). Pure, no I/O.
//   stateSentence   — the row's Step and the header's state: ONE plain sentence of what is going on (a suggestion's
//                     figures and its two causes, "Report to supplier", "Reported 11/5 by chat · no answer in 5 business
//                     days", "Confirmed 10/28 · short by $42.00", …). Never the word "waiting" before the report.
//   primaryAction   — the row's Do column: ONE primary button for the task (plus Dismiss / Snooze where they apply).
//   stepActions     — the Steps list per path, every step with the handler that sets or changes it.
//   whatHappensNext — the detail's "What happens next" box: now · then · then.
import { CLAIM_KIND_LABELS, CLAIM_OUTCOME_LABELS, CLAIM_TASK_LABELS, type ClaimTaskKind } from "./supplier-claim";
import { BUSINESS_DAYS, claimSteps, isReported, effectiveTasks, supplierConfirmedAt, TIMEOUT_REASON_RE, PASSIVE_TASK_KINDS, isActiveTask, type BucketClaim, type BucketResult, type ClaimStep } from "./claim-bucket";

export interface UiTask { id: number; kind: ClaimTaskKind | string; reason?: string | null; done_at: string | null; created_at?: string; snoozed_until?: string | null }
/** What the sentences read beyond BucketClaim. */
export interface UiClaim extends BucketClaim {
  id?: number;
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
  // the Dismissed tab's Step: why (the typed reason, else the claim's note) — Maria 2026-11-12
  if (c.status === "dismissed") return `Dismissed${c.dismiss_reason ? ` · ${c.dismiss_reason}` : c.note ? ` · ${c.note}` : ""}`;
  // a written-off claim with Velocity still to act reads its task / its wait, not "Closed" (its bucket says so)
  if (c.status === "closed" && b.bucket === "closed") return `Closed ${fmtMD(c.closed_at)}${outcomeWord(c) ? ` · ${outcomeWord(c)}` : ""}${c.write_off_reason ? ` · ${c.write_off_reason}` : ""}`;
  const sug = openOf(c, "review_suggestion");
  if (c.status === "suggested" || sug) return sug?.reason ?? "Suggested — open or dismiss";
  if (!isReported(c)) return "Report to supplier";
  const act = openTasks(c).filter((t) => isActiveTask(t as any));
  const first = act[0];
  if (first) {
    switch (first.kind) {
      case "confirm_outcome": return first.reason ?? "Supplier replied · confirm the outcome";
      case "enter_quantity": return "Quantity not known yet · type the Individual units";
      case "contact_supplier": return TIMEOUT_REASON_RE.test(first.reason ?? "") ? `${capital(first.reason!.replace(TIMEOUT_REASON_RE, ""))} in ${BUSINESS_DAYS} business days · contact the supplier` : "Report to supplier";
      case "follow_up_supplier": return `${reportedText(c)} · no answer in ${BUSINESS_DAYS} business days`;
      case "confirm_reship_order": return first.reason ?? "A reship order # arrived · confirm it";
      case "send_label": return "Return label saved · send it to Velocity";
      case "tell_velocity_replacement": return "Replacement promised · tell Velocity it is coming";
      case "dispose_units": return `${outcomeWord(c) ?? "Settled"} · ask Velocity to dispose ${c.qty ?? "the"} units`;
      case "update_velocity_order": return first.reason ?? "Update the Velocity order";
      case "upload_return_label": return "A return is needed · upload the label";
      case "check_on_it": return first.reason?.replace(/^\d+ business days: /, (m) => "") ? `${capital(first.reason!.replace(/^\d+ business days: /, ""))} · ${BUSINESS_DAYS} business days` : "Timed out · check on it";
      default: return CLAIM_TASK_LABELS[first.kind as ClaimTaskKind] ?? String(first.kind);
    }
  }
  switch (b.bucket) {
    // "Refund confirmed 9/23 · check the card" (Maria 2026-11-12): what was confirmed, when, and where to look
    case "waiting_refund": return `${refundWord(c)} confirmed ${fmtMD(supplierConfirmedAt(c))} · check the ${refundWhere(c)}${short(c)}`;
    case "waiting_shipment": return c.replacement_shipped_at ? `Replacement shipped ${fmtMD(c.replacement_shipped_at)} · not arrived` : "Return on its way to the supplier";
    // dispose asked wins over an older label (a written-off claim whose return never moved, Maria 2026-11-12)
    case "waiting_velocity": return doneAt(c, "dispose_units") && c.qty_disposed == null ? "Velocity asked to dispose · count not down yet" : doneAt(c, "send_label") ? `Label sent ${fmtMD(doneAt(c, "send_label"))} · return not shipped yet` : "Velocity asked · nothing changed yet";
    case "waiting_supplier": {
      const reply = c.last_supplier_reply_at ? `Supplier replied ${fmtMD(c.last_supplier_reply_at)}` : null;
      if (c.outcome && !c.supplier_confirmed_at) return `${reply ?? reportedText(c)} · ${outcomeWord(c)} promised · no confirmation yet`;
      return emailed(c) ? `Canceled per the supplier's email ${fmtMD(c.found_at)} · no refund seen yet` : c.kind === "canceled" ? `Canceled ${fmtMD(c.found_at)} · no refund seen yet` : `${reply ?? reportedText(c)} · no answer yet`;
    }
    default: return openTasks(c).map((t) => CLAIM_TASK_LABELS[t.kind as ClaimTaskKind] ?? t.kind).join(" · ") || reportedText(c);
  }
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const refundWord = (c: UiClaim) => (c.outcome === "gift_card" ? "Gift card" : c.outcome === "store_credit" ? "Store credit" : "Refund");
const refundWhere = (c: UiClaim) => (c.outcome === "gift_card" ? "gift card" : c.outcome === "store_credit" ? "account" : "card");

export interface PrimaryAction {
  /** What the button does: tick this task (`task`), the Contacted supplier form (`contact`), go to the detail (`detail`), the refund form (`refund`), reopen a dismissed claim (`reopen`), nothing (`none`). */
  kind: "task" | "contact" | "detail" | "refund" | "reopen" | "none";
  label: string;
  taskId?: number;
  taskKind?: string;
  /** The second control beside the button. */
  secondary: "dismiss" | "snooze" | null;
  /** The tick needs this control before it can be saved. */
  needs?: "order_id" | "qty" | null;
}
/** Pure: the row's Do column. */
export function primaryAction(c: UiClaim, b: BucketResult): PrimaryAction {
  if (b.bucket === "dismissed") return { kind: "reopen", label: "Reopen", secondary: null };
  if (b.bucket === "closed") return { kind: "none", label: "", secondary: null };
  const open = openTasks(c);
  const by = (k: string) => open.find((t) => t.kind === k);
  let t: UiTask | undefined;
  if ((t = by("review_suggestion"))) return { kind: "task", label: "Open claim", taskId: t.id, taskKind: t.kind, secondary: "dismiss" };
  if ((t = by("confirm_outcome"))) return { kind: "detail", label: "Confirm outcome", taskId: t.id, taskKind: t.kind, secondary: null };
  if ((t = by("enter_quantity"))) return { kind: "detail", label: "Enter quantity", taskId: t.id, taskKind: t.kind, secondary: null, needs: "qty" };
  if ((t = by("contact_supplier")) || (c.status === "open" && !isReported(c))) return { kind: "contact", label: "Contacted supplier", taskId: t?.id, taskKind: "contact_supplier", secondary: t && TIMEOUT_REASON_RE.test(t.reason ?? "") ? "snooze" : null };
  if ((t = by("follow_up_supplier"))) return { kind: "contact", label: "Followed up", taskId: t.id, taskKind: t.kind, secondary: "snooze" };
  if ((t = by("confirm_reship_order"))) return { kind: "detail", label: "Add order #", taskId: t.id, taskKind: t.kind, secondary: null, needs: "order_id" };
  if ((t = by("upload_return_label"))) return { kind: "detail", label: "Upload label", taskId: t.id, taskKind: t.kind, secondary: null };
  if ((t = by("send_label"))) return { kind: "task", label: "Sent label", taskId: t.id, taskKind: t.kind, secondary: null };
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
  if (k === "review_suggestion" || k === "confirm_outcome" || k === "enter_quantity") return "decide";
  if (k === "contact_supplier" || k === "follow_up_supplier" || k === "confirm_reship_order") return "supplier";
  if (k === "send_label" || k === "tell_velocity_replacement" || k === "dispose_units" || k === "update_velocity_order") return "velocity";
  return "money";
}
export const GROUP_HINTS: Readonly<Record<string, string>> = { decide: "suggestions and outcomes to confirm", supplier: "contact or follow up", velocity: "one Discord message", money: "check the card", timed_out: "" };

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
  | { type: "task"; task: ClaimTaskKind }  // a task tick: tell Velocity, upload label, send label, dispose
  | { type: "none"; why: string };         // commit 7: the return's own tracking
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
      case "label": handler = { type: "task", task: "upload_return_label" }; break;
      case "label_sent": handler = { type: "task", task: "send_label" }; break;
      case "return_shipped": case "return_delivered": handler = { type: "none", why: "the return's own tracking arrives with commit 7" }; break;
      default: handler = { type: "none", why: "no handler" };
    }
    out.push({ ...s, handler });
  }
  return out;
}

/** Pure: the "What happens next" box — now · then · then. */
export function whatHappensNext(c: UiClaim, b: BucketResult): Array<{ when: "Now" | "Then"; text: string }> {
  if (c.status === "closed" && b.bucket === "closed") return [{ when: "Now", text: `Closed ${fmtMD(c.closed_at)}${outcomeWord(c) ? ` · ${outcomeWord(c)}` : ""}. Reopen from More if something changes.` }];
  if (c.status === "dismissed") return [{ when: "Now", text: "Dismissed. Reopen from More to take it up again." }];
  const paths = "the supplier's answer sets the outcome: refund → Confirmed → Received; replacement → Promised → Shipped → Arrived; nothing → Write off";
  if (c.status === "suggested") return [{ when: "Now", text: "in Needs attention › Decide until you open or dismiss the suggestion" }, { when: "Then", text: "Report to supplier · the timer starts from the report date" }, { when: "Then", text: paths }];
  if (!isReported(c)) return [{ when: "Now", text: "in Needs attention › Supplier until you record the contact" }, { when: "Then", text: `Waiting on supplier · Follow up after ${BUSINESS_DAYS} business days with no reply` }, { when: "Then", text: paths }];
  const timer = b.due ? ` · timer runs out ${fmtMD(b.due)}` : "";
  switch (b.bucket) {
    case "needs_attention": return [{ when: "Now", text: `in Needs attention until ${openTasks(c).filter((t) => isActiveTask(t as any)).map((t) => (CLAIM_TASK_LABELS[t.kind as ClaimTaskKind] ?? t.kind).toLowerCase()).join(", ") || "the task"} is done` }, { when: "Then", text: paths }];
    case "waiting_supplier": return [{ when: "Now", text: `Waiting on supplier${timer} · Follow up after ${BUSINESS_DAYS} business days with no reply` }, { when: "Then", text: c.outcome ? `the supplier confirms the ${outcomeWord(c)} → ${c.outcome === "replacement" ? "Shipped → Arrived" : "Waiting on refund to post → Received"}` : paths }];
    case "waiting_refund": return [{ when: "Now", text: `Waiting on refund to post${timer} · ${c.kind === "canceled" ? "Contact supplier" : "Check on it"} after ${BUSINESS_DAYS} business days` }, { when: "Then", text: "the refund posts → + Refund received closes the claim; short → Write off remainder or wait for the rest" }];
    case "waiting_shipment": return [{ when: "Now", text: `Waiting on shipment${timer} · Check on it if the carrier goes quiet` }, { when: "Then", text: c.outcome === "replacement" ? "the replacement arrives → Arrived closes the claim" : "the return is delivered → the supplier confirms the refund" }];
    case "waiting_velocity": return [{ when: "Now", text: `Waiting on Velocity${timer} · Check on it after ${BUSINESS_DAYS} business days` }, { when: "Then", text: "Velocity acts → the next step on the path" }];
    default: return [{ when: "Now", text: paths }];
  }
}

export const kindLabel = (k: string) => CLAIM_KIND_LABELS[k as keyof typeof CLAIM_KIND_LABELS] ?? k;
export { PASSIVE_TASK_KINDS };
