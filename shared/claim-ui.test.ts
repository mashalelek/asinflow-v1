// The words and controls of the two Claims pages (SPEC §22 "Supplier claims" §5 amended 2026-11-12, commit 2b):
// the one-sentence state, the row's one primary button, every step with a handler per path, what happens next.
import { describe, it, expect } from "vitest";
import { deriveBucket, nextAction, claimSteps } from "./claim-bucket";
import { stateSentence, primaryAction, needsAttentionGroup, stepActions, whatHappensNext, type UiClaim } from "./claim-ui";
import { CLAIM_TASK_KINDS } from "./supplier-claim";

const NOW = new Date("2026-11-12T20:00:00Z"); // Thu
const base = (over: Partial<UiClaim> = {}): UiClaim => ({
  status: "open", kind: "missing", outcome: null, found_at: "2026-11-02", found_by: "maria", reported_at: null, reported_channel: null, supplier_confirmed_at: null, last_supplier_reply_at: null, closed_at: null,
  return_required: false, replacement_shipped_at: null, replacement_arrived_at: null, qty_disposed: null, remaining: 5.97, received: 0, qty: 1, ordered: 12, tasks: [], ships_to: "velocity", ...over,
});
const done = (kind: string, at: string, id = 1) => ({ id, kind, done_at: at, created_at: at });
const open = (kind: string, id = 2, reason: string | null = null) => ({ id, kind, done_at: null, created_at: "2026-11-02T15:00:00Z", reason });
const sentence = (c: UiClaim) => stateSentence(c, deriveBucket(c, NOW));
const action = (c: UiClaim) => primaryAction(c, deriveBucket(c, NOW));

describe("stateSentence — one plain sentence, never 'waiting' before the report", () => {
  it("unreported → Report to supplier; a suggestion → its figures and causes; reported → the report and no answer yet", () => {
    expect(sentence(base())).toBe("Report to supplier");
    expect(sentence(base({ tasks: [open("contact_supplier")] }))).toBe("Report to supplier");
    const sug = base({ status: "suggested", found_by: "auto", tasks: [open("review_suggestion", 2, "Velocity received 22 Individual units, 24 shipped; every tracking delivered, the latest 2026-11-05. 2 missing — possible causes: the supplier shipped a single instead of the case, or Velocity's pack size is wrong.")] });
    expect(sentence(sug)).toMatch(/22 Individual units, 24 shipped.*single instead of the case, or Velocity's pack size is wrong/);
    expect(sentence(base({ reported_at: "2026-11-05", reported_channel: "chat" }))).toBe("Reported 11/5 by chat · no answer yet");
    expect(sentence(base({ reported_at: "2026-11-05", reported_channel: "chat", tasks: [open("follow_up_supplier")] }))).toBe("Reported 11/5 by chat · no answer in 5 business days");
    for (const c of [base(), base({ reported_at: null, outcome: "refund_card" }), base({ tasks: [open("enter_quantity")] })]) expect(sentence(c).toLowerCase()).not.toContain("waiting");
  });
  it("a reply, a promised outcome, a confirmation, a refund short, a replacement on its way, Velocity asked, closed, dismissed", () => {
    expect(sentence(base({ reported_at: "2026-11-05", last_supplier_reply_at: "2026-11-06T12:00:00Z" }))).toBe("Supplier replied 11/6 · no answer yet");
    expect(sentence(base({ reported_at: "2026-11-05", tasks: [open("confirm_outcome", 3, 'Supplier replied 11/6: "remaining 11 jars ship out tomorrow" → outcome?')] }))).toBe('Supplier replied 11/6: "remaining 11 jars ship out tomorrow" → outcome?');
    expect(sentence(base({ reported_at: "2026-11-05", outcome: "replacement" }))).toBe("Reported 11/5 · replacement promised · no confirmation yet");
    expect(sentence(base({ reported_at: "2026-11-05", outcome: "gift_card", supplier_confirmed_at: "2026-10-28T12:00:00Z", remaining: 42, received: 42 }))).toBe("Gift card confirmed 10/28 · check the gift card · short by $42.00");
    expect(sentence(base({ reported_at: "2026-11-05", outcome: "refund_card", supplier_confirmed_at: "2026-10-28T12:00:00Z" }))).toBe("Refund confirmed 10/28 · check the card");
    expect(sentence(base({ reported_at: "2026-11-05", outcome: "replacement", replacement_shipped_at: "2026-10-29" }))).toBe("Replacement shipped 10/29 · not arrived");
    expect(sentence(base({ reported_at: "2026-11-05", return_required: true, tasks: [done("send_label", "2026-11-10T12:00:00Z")] }))).toBe("Label sent 11/10 · return not shipped yet");
    expect(sentence(base({ reported_at: "2026-11-05", outcome: "write_off", tasks: [open("dispose_units")], qty: 18 }))).toBe("write-off · ask Velocity to dispose 18 units");
    expect(sentence(base({ status: "closed", closed_at: "2026-11-09", outcome: "refund_card" }))).toBe("Closed 11/9 · refund to card");
    expect(sentence(base({ status: "dismissed" }))).toBe("Dismissed");
    expect(sentence(base({ kind: "canceled", found_by: "email", found_at: "2026-09-04" }))).toBe("Refund confirmed 9/4 · check the card"); // a canceled claim is confirmed on its cancel date (paths, Maria 2026-11-12)
  });
});

describe("primaryAction — ONE button per row, Dismiss / Snooze where they apply", () => {
  it("every task kind has a button; the unreported claim gets Contacted supplier even with no task", () => {
    const want: Record<string, [string, string | null]> = {
      review_suggestion: ["Open claim", "dismiss"], confirm_outcome: ["Confirm outcome", null], enter_quantity: ["Enter quantity", null], contact_supplier: ["Contacted supplier", null],
      follow_up_supplier: ["Followed up", "snooze"], confirm_reship_order: ["Add order #", null], send_label: ["Sent label", null], tell_velocity_replacement: ["Told Velocity", null],
      dispose_units: ["Asked", null], update_velocity_order: ["Updated", null], refund_received: ["Refund received", null], replacement_arrived: ["Arrived", null], upload_return_label: ["Upload label", null], check_on_it: ["Check on it", "snooze"],
    };
    for (const k of CLAIM_TASK_KINDS) {
      // a contact_supplier task only means something on an unreported claim (one derivation, Maria 2026-11-12)
      const a = action(base({ reported_at: k === "contact_supplier" ? null : "2026-11-05", tasks: [open(k, 7)] }));
      expect([a.label, a.secondary], k).toEqual(want[k]);
      expect(a.taskId, k).toBe(7);
    }
    expect(action(base({ reported_at: "2026-11-05", tasks: [open("contact_supplier", 7)] })).kind).toBe("none");
    expect(action(base())).toMatchObject({ kind: "contact", label: "Contacted supplier", secondary: null });
    expect(action(base({ reported_at: "2026-11-05", outcome: "refund_card", supplier_confirmed_at: "2026-11-06T12:00:00Z" }))).toMatchObject({ kind: "refund", label: "Refund received" });
    expect(action(base({ reported_at: "2026-11-05" })).kind).toBe("none");
    expect(action(base({ status: "closed" })).kind).toBe("none");
  });
  it("the Needs attention group follows the button's task", () => {
    expect(needsAttentionGroup(base())).toBe("supplier");
    expect(needsAttentionGroup(base({ status: "suggested", tasks: [open("review_suggestion")] }))).toBe("decide");
    expect(needsAttentionGroup(base({ reported_at: "2026-11-05", tasks: [open("check_on_it")] }))).toBe("timed_out");
    expect(needsAttentionGroup(base({ reported_at: "2026-11-05", tasks: [open("send_label")] }))).toBe("velocity");
    expect(needsAttentionGroup(base({ reported_at: "2026-11-05", tasks: [open("upload_return_label")] }))).toBe("money");
    expect(needsAttentionGroup(base({ reported_at: "2026-11-05" }))).toBeNull();
  });
});

describe("stepActions — every step of every path has a handler", () => {
  const handlers = (c: UiClaim) => stepActions(c).map((s) => [s.key, s.handler.type]);
  it("refund path: found · report · supplier answers · confirmed · received · closed", () => {
    expect(handlers(base())).toEqual([["found", "edit_found"], ["reported", "contact"], ["answered", "reply"], ["confirmed", "confirm"], ["received", "refund"], ["closed", "write_off"]]);
  });
  it("replacement path: promised · tell Velocity · shipped · arrived · closed (no Tell Velocity on a home PO)", () => {
    expect(handlers(base({ outcome: "replacement", reported_at: "2026-11-05" }))).toEqual([["found", "edit_found"], ["reported", "contact"], ["promised", "replacement_promised"], ["tell_velocity", "task"], ["shipped", "replacement_shipped"], ["arrived", "replacement_arrived"], ["closed", "replacement_arrived"]]);
    expect(handlers(base({ outcome: "replacement", reported_at: "2026-11-05", ships_to: "home" })).map((x) => x[0])).not.toContain("tell_velocity");
    expect(stepActions(base({ outcome: "replacement" })).find((s) => s.key === "tell_velocity")!.handler).toEqual({ type: "task", task: "tell_velocity_replacement" });
  });
  it("return path adds label · sent · shipped · delivered (the last two wait for commit 7); write-off path; emailed cancellation", () => {
    expect(handlers(base({ return_required: true }))).toEqual([["found", "edit_found"], ["reported", "contact"], ["answered", "reply"], ["label", "task"], ["label_sent", "task"], ["return_shipped", "none"], ["return_delivered", "none"], ["confirmed", "confirm"], ["received", "refund"], ["closed", "write_off"]]);
    expect(handlers(base({ outcome: "write_off", status: "closed", closed_at: "2026-11-09", tasks: [open("dispose_units")] }))).toEqual([["found", "edit_found"], ["reported", "contact"], ["written_off", "write_off"], ["dispose", "task"], ["closed", "write_off"]]);
    expect(handlers(base({ kind: "canceled", found_by: "email" }))).toEqual([["found", "edit_found"], ["confirmed", "confirm"], ["received", "refund"], ["closed", "write_off"]]);
    // every step everywhere carries a handler type, and only the two commit-7 steps are "none"
    for (const c of [base(), base({ outcome: "replacement" }), base({ return_required: true }), base({ outcome: "write_off" }), base({ kind: "canceled", found_by: "email" })]) {
      for (const s of stepActions(c)) { expect(s.handler.type).toBeTruthy(); if (s.handler.type === "none") expect(["return_shipped", "return_delivered"]).toContain(s.key); }
    }
  });
});

describe("whatHappensNext", () => {
  it("now · then · then, matching the bucket; no 'waiting' before the report", () => {
    const un = whatHappensNext(base(), deriveBucket(base(), NOW));
    expect(un[0]).toEqual({ when: "Now", text: "in Needs attention › Supplier until you record the contact" });
    expect(un.map((x) => x.text).join(" ").toLowerCase()).not.toMatch(/^waiting/);
    const rep = base({ reported_at: "2026-11-05" });
    expect(whatHappensNext(rep, deriveBucket(rep, NOW))[0].text).toMatch(/^Waiting on supplier · timer runs out 11\/12 · Follow up after 5 business days/);
    const conf = base({ reported_at: "2026-11-05", outcome: "refund_card", supplier_confirmed_at: "2026-11-10T12:00:00Z" });
    expect(whatHappensNext(conf, deriveBucket(conf, NOW))[0].text).toMatch(/^Waiting on refund to post/);
    expect(whatHappensNext(base({ status: "closed", closed_at: "2026-11-09", outcome: "gift_card" }), deriveBucket(base({ status: "closed", closed_at: "2026-11-09" }), NOW))[0].text).toMatch(/^Closed 11\/9 · gift card/);
  });
});

// One derivation for the list and the detail (Maria 2026-11-12): claim #3355 — the Walmart cancellation opened from its email,
// outcome refund to card, confirmed 9/23, with the stray contact_supplier task the opening added.
describe("an emailed cancellation with a stray contact_supplier task reads the same on the list and the detail", () => {
  const NOW = new Date("2026-11-12T20:00:00Z");
  const c = base({ kind: "canceled", found_by: "email", outcome: "refund_card", supplier_confirmed_at: "2026-09-23T12:00:00Z", found_at: "2026-11-12", remaining: 35.22, received: 0,
    tasks: [{ id: 1, kind: "review_suggestion", done_at: "2026-11-12T18:00:00Z" }, { id: 2, kind: "contact_supplier", done_at: null, created_at: "2026-11-12T18:00:00Z" }, { id: 3, kind: "refund_received", done_at: null, created_at: "2026-11-12T18:00:00Z" }] });
  it("Waiting on refund to post · 'Refund confirmed 9/23 · check the card' · Refund received · timer from 9/23, overdue → Contact supplier (a canceled claim's one contact)", () => {
    const b = deriveBucket(c, NOW);
    expect(b).toMatchObject({ bucket: "waiting_refund", since: "2026-09-23T12:00:00.000Z", timedOut: true, timeout: { kind: "contact_supplier", reason: "5 business days: refund not posted" } });
    expect(stateSentence(c, b)).toBe("Refund confirmed 9/23 · check the card");
    expect(nextAction(c, b)).toBe("Refund received");
    expect(primaryAction(c, b)).toMatchObject({ kind: "refund", label: "Refund received", taskId: 3 });
    expect(claimSteps(c).find((s) => s.current)!.key).toBe("received");
    expect(claimSteps(c).find((s) => s.key === "confirmed")).toMatchObject({ done: true, at: "2026-09-23T12:00:00Z" });
    expect(claimSteps(c).some((s) => s.key === "reported")).toBe(false);
  });
  it("the stray task is ignored on any reported claim (a typed report date, a confirmation); an unreported claim still needs the Contacted tick", () => {
    const typed = base({ reported_at: "2026-11-05", tasks: [{ id: 2, kind: "contact_supplier", done_at: null, created_at: "2026-11-06T18:00:00Z" }] });
    expect(deriveBucket(typed, NOW).bucket).toBe("waiting_supplier");
    expect(stateSentence(typed, deriveBucket(typed, NOW))).toBe("Reported 11/5 · no answer yet");
    const unreported = base({ tasks: [{ id: 2, kind: "contact_supplier", done_at: null, created_at: "2026-11-06T18:00:00Z" }] });
    expect(deriveBucket(unreported, NOW).bucket).toBe("needs_attention");
    expect(primaryAction(unreported, deriveBucket(unreported, NOW))).toMatchObject({ kind: "contact", label: "Contacted supplier", taskId: 2 });
  });
});
