// Per-path end-to-end (spec §3.4, Maria 2026-11-12): one fixture claim per path walked from creation to Closed, asserting the
// Steps (✓ done, ● current), the bucket, the Next action and the timer at every stage. Pure — the same functions the list
// and the detail read (rowOf). The table the run prints is the report's.
import { describe, it, expect, afterAll } from "vitest";
import { claimSteps, deriveBucket, nextAction, type BucketClaim } from "./claim-bucket";
import { stateSentence, primaryAction, type UiClaim } from "./claim-ui";
import { poStatusLabel } from "./po-status";
import { autoCloseVerdict } from "../server/po-close";

const NOW = new Date("2026-11-05T15:00:00Z");   // Thu Nov 5, 10:00 ET — timers running
const LATER = new Date("2026-11-12T15:00:00Z"); // Thu Nov 12 — the Nov 3 / Nov 4 timers have run out
const base = (over: Partial<UiClaim> = {}): UiClaim => ({
  status: "open", kind: "missing", outcome: null, found_at: "2026-11-02", found_by: "maria", reported_at: null, reported_channel: null, supplier_confirmed_at: null, last_supplier_reply_at: null, closed_at: null,
  return_required: false, replacement_shipped_at: null, replacement_arrived_at: null, qty_disposed: null, remaining: 5.97, received: 0, qty: 1, ordered: 12, tasks: [], ships_to: "velocity", ...over,
});
let n = 0;
const open = (kind: string, created = "2026-11-02T15:00:00Z", reason: string | null = null) => ({ id: ++n, kind, done_at: null, created_at: created, reason });
const done = (kind: string, at: string, reason: string | null = null) => ({ id: ++n, kind, done_at: at, created_at: at, reason });

type Stage = { stage: string; c: UiClaim; now?: Date; want: { current: string | null; bucket: string; next: string; since?: string | null; due?: string | null; timedOut?: boolean; timeout?: string | null; sentence?: string; action?: string } };
const TABLE: string[] = ["| Path | Stage | Steps | Bucket | Next action | Timer |", "|---|---|---|---|---|---|"];
const md = (s: string) => s.replace(/\|/g, "\\|");
function walk(path: string, stages: Stage[]) {
  for (const s of stages) {
    const now = s.now ?? NOW;
    const steps = claimSteps(s.c), b = deriveBucket(s.c, now), next = nextAction(s.c, b);
    const label = (x: { key: string; done: boolean; current: boolean }) => `${x.done ? "✓" : x.current ? "●" : "○"} ${x.key}`;
    const timer = b.due ? `${b.due.slice(0, 10)}${b.timedOut ? ` ran out → ${b.timeout?.kind}` : ""}` : "—";
    TABLE.push(`| ${path} | ${md(s.stage)} | ${steps.map(label).join(" · ")} | ${b.bucket} | ${md(next)} | ${timer} |`);
    expect(steps.find((x) => x.current)?.key ?? null, `${path} / ${s.stage}: current step`).toBe(s.want.current);
    expect(b.bucket, `${path} / ${s.stage}: bucket`).toBe(s.want.bucket);
    expect(next, `${path} / ${s.stage}: next action`).toBe(s.want.next);
    if (s.want.since !== undefined) expect(b.since, `${path} / ${s.stage}: since`).toBe(s.want.since);
    if (s.want.due !== undefined) expect(b.due, `${path} / ${s.stage}: due`).toBe(s.want.due);
    if (s.want.timedOut !== undefined) expect(b.timedOut, `${path} / ${s.stage}: timed out`).toBe(s.want.timedOut);
    if (s.want.timeout !== undefined) expect(b.timeout?.kind ?? null, `${path} / ${s.stage}: timeout task`).toBe(s.want.timeout);
    if (s.want.sentence !== undefined) expect(stateSentence(s.c, b), `${path} / ${s.stage}: sentence`).toBe(s.want.sentence);
    if (s.want.action !== undefined) expect(primaryAction(s.c, b).label, `${path} / ${s.stage}: Do`).toBe(s.want.action);
    // every stage is in Needs attention or carries a running timer, except closed / dismissed
    if (b.bucket !== "closed" && b.bucket !== "dismissed" && b.bucket !== "needs_attention") expect(b.due, `${path} / ${s.stage}: a waiting bucket has a timer`).not.toBeNull();
  }
}
afterAll(async () => {
  console.log("\n" + TABLE.join("\n") + "\n");
  // CLAIM_PATHS_TABLE=<file>: the report's copy of the table
  if (process.env.CLAIM_PATHS_TABLE) (await import("node:fs")).writeFileSync(process.env.CLAIM_PATHS_TABLE, TABLE.join("\n") + "\n");
});

describe("§3.4 paths, creation → Closed", () => {
  it("missing → refund", () => {
    const found = base({ tasks: [open("contact_supplier")] });
    const reported = base({ reported_at: "2026-11-03", reported_channel: "chat", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z")] });
    const followUp = base({ ...reported, tasks: [...reported.tasks, open("follow_up_supplier", "2026-11-11T15:00:00Z", "5 business days: no answer from the supplier")] });
    const promised = base({ ...reported, outcome: "refund_card", last_supplier_reply_at: "2026-11-12T16:00:00Z", tasks: [...reported.tasks, done("follow_up_supplier", "2026-11-12T16:00:00Z")] });
    const confirmed = base({ ...promised, supplier_confirmed_at: "2026-11-13T12:00:00Z", tasks: [...promised.tasks, open("refund_received", "2026-11-13T12:00:00Z")] });
    const closed = base({ ...confirmed, status: "closed", closed_at: "2026-11-18T12:00:00Z", received: 5.97, remaining: 0, tasks: [...promised.tasks, done("refund_received", "2026-11-18T12:00:00Z")] });
    walk("missing → refund", [
      { stage: "found, not yet reported", c: found, want: { current: "reported", bucket: "needs_attention", next: "Contact supplier", due: null, sentence: "Report to supplier", action: "Contacted supplier" } },
      { stage: "reported 11/3 by chat", c: reported, want: { current: "answered", bucket: "waiting_supplier", next: "waiting for the supplier's answer", since: "2026-11-03T12:00:00.000Z", due: "2026-11-10T12:00:00.000Z", timedOut: false, sentence: "Reported 11/3 by chat · no answer yet" } },
      { stage: "11/12: no answer in 5 business days", c: reported, now: LATER, want: { current: "answered", bucket: "waiting_supplier", next: "waiting for the supplier's answer", timedOut: true, timeout: "follow_up_supplier" } },
      { stage: "the sweep's Follow up task", c: followUp, now: LATER, want: { current: "answered", bucket: "needs_attention", next: "Follow up with supplier", due: null, action: "Followed up" } },
      { stage: "supplier replied 11/12: refund to card", c: promised, now: LATER, want: { current: "confirmed", bucket: "waiting_supplier", next: "waiting for the supplier's confirmation", since: "2026-11-12T16:00:00.000Z", due: "2026-11-19T16:00:00.000Z", sentence: "Supplier replied 11/12 · refund to card promised · no confirmation yet" } },
      { stage: "confirmed 11/13", c: confirmed, now: LATER, want: { current: "received", bucket: "waiting_refund", next: "Refund received", since: "2026-11-13T12:00:00.000Z", due: "2026-11-20T12:00:00.000Z", sentence: "Refund confirmed 11/13 · check the card", action: "Refund received" } },
      { stage: "refund posted 11/18", c: closed, now: LATER, want: { current: null, bucket: "closed", next: "", sentence: "Closed 11/18 · refund to card" } },
    ]);
  });
  it("missing → replacement", () => {
    const reported = base({ reported_at: "2026-11-03", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z")] });
    const promised = base({ ...reported, outcome: "replacement", tasks: [...reported.tasks, done("confirm_outcome", "2026-11-04T15:00:00Z"), open("tell_velocity_replacement", "2026-11-04T15:00:00Z")] });
    const told = base({ ...reported, outcome: "replacement", tasks: [...reported.tasks, done("confirm_outcome", "2026-11-04T15:00:00Z"), done("tell_velocity_replacement", "2026-11-04T17:00:00Z")] });
    const shipped = base({ ...told, replacement_shipped_at: "2026-11-06", tasks: [...told.tasks, open("replacement_arrived", "2026-11-06T12:00:00Z")] });
    const closed = base({ ...shipped, status: "closed", closed_at: "2026-11-10T12:00:00Z", replacement_arrived_at: "2026-11-10", tasks: [...told.tasks, done("replacement_arrived", "2026-11-10T12:00:00Z")] });
    walk("missing → replacement", [
      { stage: "reported 11/3", c: reported, want: { current: "answered", bucket: "waiting_supplier", next: "waiting for the supplier's answer", due: "2026-11-10T12:00:00.000Z" } },
      { stage: "replacement promised 11/4 · tell Velocity", c: promised, want: { current: "tell_velocity", bucket: "needs_attention", next: "Tell Velocity a replacement is coming", due: null, action: "Told Velocity" } },
      { stage: "told Velocity 11/4", c: told, want: { current: "shipped", bucket: "waiting_shipment", next: "waiting for the carrier", since: "2026-11-04T17:00:00.000Z", due: "2026-11-11T17:00:00.000Z" } },
      { stage: "shipped 11/6", c: shipped, now: LATER, want: { current: "arrived", bucket: "waiting_shipment", next: "Replacement arrived", since: "2026-11-06T12:00:00.000Z", due: "2026-11-13T12:00:00.000Z", timedOut: false, sentence: "Replacement shipped 11/6 · not arrived", action: "Arrived" } },
      { stage: "arrived 11/10", c: closed, now: LATER, want: { current: null, bucket: "closed", next: "" } },
    ]);
  });
  const returnPath = (kind: string) => {
    const reported = base({ kind, reported_at: "2026-11-03", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z")] });
    const label = base({ ...reported, outcome: "refund_card", return_required: true, tasks: [...reported.tasks, done("confirm_outcome", "2026-11-04T15:00:00Z"), open("upload_return_label", "2026-11-04T15:00:00Z")] });
    const uploaded = base({ ...label, tasks: [...reported.tasks, done("confirm_outcome", "2026-11-04T15:00:00Z"), done("upload_return_label", "2026-11-04T16:00:00Z"), open("send_label", "2026-11-04T16:00:00Z")] });
    const sent = base({ ...uploaded, tasks: [...reported.tasks, done("confirm_outcome", "2026-11-04T15:00:00Z"), done("upload_return_label", "2026-11-04T16:00:00Z"), done("send_label", "2026-11-04T18:00:00Z")] });
    // commit 7 (§3.12): the carrier's scans move the return on — Shipped (first scan), Delivered — then the refund email confirms
    const tracking = { carrier: "FEDEX", tracking_number: "528889999001", carrier_status: "in_transit", est_delivery_at: "2026-11-10T00:00:00Z", last_scan_at: "2026-11-06T03:12:00Z", last_scan_location: "Memphis, TN", delivered_at: null };
    const shipped = base({ ...sent, return_shipped_at: "2026-11-05T16:40:00Z", return_shipped_source: "tracking", return_tracking: tracking });
    const delivered = base({ ...shipped, return_delivered_at: "2026-11-10T14:02:00Z", return_delivered_source: "tracking", return_tracking: { ...tracking, carrier_status: "delivered", delivered_at: "2026-11-10T14:02:00Z" } });
    const confirmed = base({ ...delivered, supplier_confirmed_at: "2026-11-12T12:00:00Z", tasks: [...sent.tasks, open("refund_received", "2026-11-12T12:00:00Z")] });
    const closed = base({ ...confirmed, status: "closed", closed_at: "2026-11-13T12:00:00Z", received: 5.97, remaining: 0, tasks: [...sent.tasks, done("refund_received", "2026-11-13T12:00:00Z")] });
    walk(`${kind} → return → refund`, [
      { stage: "reported 11/3", c: reported, want: { current: "answered", bucket: "waiting_supplier", next: "waiting for the supplier's answer", due: "2026-11-10T12:00:00.000Z" } },
      { stage: "supplier wants it back · upload the label", c: label, want: { current: "label", bucket: "needs_attention", next: "Upload return label", due: null, sentence: "A return is needed · no label yet", action: "Upload label" } },
      { stage: "label uploaded · send it to Velocity", c: uploaded, want: { current: "label_sent", bucket: "needs_attention", next: "Send return label to Velocity", due: null, action: "Sent label" } },
      { stage: "label sent to Velocity 11/4", c: sent, want: { current: "return_shipped", bucket: "waiting_velocity", next: "waiting for Velocity", since: "2026-11-04T18:00:00.000Z", due: "2026-11-11T18:00:00.000Z", sentence: "Label sent 11/4 · waiting for the first carrier scan" } },
      { stage: "11/12: no carrier scan in 5 business days", c: sent, now: LATER, want: { current: "return_shipped", bucket: "waiting_velocity", next: "waiting for Velocity", timedOut: true, timeout: "check_on_it" } },
      { stage: "first scan 11/5 · from tracking", c: shipped, now: new Date("2026-11-06T15:00:00Z"), want: { current: "return_delivered", bucket: "waiting_shipment", next: "waiting for the carrier", since: "2026-11-06T03:12:00.000Z", due: "2026-11-13T03:12:00.000Z", sentence: "Return shipped 11/5 · FedEx in transit · due 11/10 · from tracking" } },
      { stage: "delivered 11/10 · from tracking", c: delivered, now: new Date("2026-11-11T15:00:00Z"), want: { current: "confirmed", bucket: "waiting_supplier", next: "waiting for the supplier's confirmation", since: "2026-11-10T14:02:00.000Z", due: "2026-11-17T14:02:00.000Z", timeout: "check_on_it", sentence: "Return delivered 11/10 · from tracking · waiting for the refund confirmation" } },
      { stage: "supplier confirmed the refund 11/12", c: confirmed, now: LATER, want: { current: "received", bucket: "waiting_refund", next: "Refund received", since: "2026-11-12T12:00:00.000Z", due: "2026-11-19T12:00:00.000Z", action: "Refund received" } },
      { stage: "refund posted 11/13", c: closed, now: LATER, want: { current: null, bucket: "closed", next: "" } },
    ]);
  };
  it("damaged → return → refund", () => returnPath("damaged"));
  it("cant_sell → return → refund", () => returnPath("cant_sell"));
  it("expired → return → write-off", () => {
    const reported = base({ kind: "expired", reported_at: "2026-11-03", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z")] });
    const label = base({ ...reported, return_required: true, last_supplier_reply_at: "2026-11-04T15:00:00Z", tasks: [...reported.tasks, open("upload_return_label", "2026-11-04T15:00:00Z")] });
    const sent = base({ ...label, tasks: [...reported.tasks, done("upload_return_label", "2026-11-04T16:00:00Z"), done("send_label", "2026-11-04T18:00:00Z")] });
    const checkOnIt = base({ ...sent, tasks: [...sent.tasks, open("check_on_it", "2026-11-12T15:00:00Z", "5 business days: return label sent, return not shipped")] });
    const writtenOff = base({ ...sent, status: "closed", outcome: "write_off", closed_at: "2026-11-13T12:00:00Z", remaining: 5.97, tasks: [...sent.tasks, done("check_on_it", "2026-11-13T12:00:00Z"), open("dispose_units", "2026-11-13T12:00:00Z")] });
    const asked = base({ ...writtenOff, tasks: [...sent.tasks, done("check_on_it", "2026-11-13T12:00:00Z"), done("dispose_units", "2026-11-16T15:00:00Z")] });
    const disposed = base({ ...asked, qty_disposed: 1 });
    walk("expired → return → write-off", [
      { stage: "reported 11/3", c: reported, want: { current: "answered", bucket: "waiting_supplier", next: "waiting for the supplier's answer", due: "2026-11-10T12:00:00.000Z" } },
      { stage: "supplier wants it back · upload the label", c: label, want: { current: "label", bucket: "needs_attention", next: "Upload return label", due: null } },
      { stage: "label sent 11/4, return never moves", c: sent, now: LATER, want: { current: "return_shipped", bucket: "waiting_velocity", next: "waiting for Velocity", timedOut: true, timeout: "check_on_it" } },
      { stage: "the sweep's Check on it", c: checkOnIt, now: LATER, want: { current: "return_shipped", bucket: "needs_attention", next: "Check on it", due: null, action: "Check on it" } },
      // written off + Velocity still to act is not Closed (Maria 2026-11-12): the open dispose task → Needs attention › Velocity
      { stage: "written off 11/13 · dispose task open", c: writtenOff, now: LATER, want: { current: "dispose", bucket: "needs_attention", next: "Ask Velocity to dispose / return", due: null, sentence: "write-off · ask Velocity to dispose 1 units", action: "Asked" } },
      // dispose asked 11/16, count not down → Waiting on Velocity, timer from the ask
      { stage: "Velocity asked to dispose 11/16", c: asked, now: new Date("2026-11-17T15:00:00Z"), want: { current: "dispose", bucket: "waiting_velocity", next: "waiting for Velocity", since: "2026-11-16T15:00:00.000Z", due: "2026-11-23T15:00:00.000Z", timedOut: false, sentence: "Velocity asked to dispose · count not down yet" } },
      { stage: "11/24: count still not down", c: asked, now: new Date("2026-11-24T15:00:00Z"), want: { current: "dispose", bucket: "waiting_velocity", next: "waiting for Velocity", timedOut: true, timeout: "check_on_it" } },
      { stage: "Velocity's count down (1 disposed)", c: disposed, now: new Date("2026-11-24T15:00:00Z"), want: { current: null, bucket: "closed", next: "", sentence: "Closed 11/13 · write-off" } },
    ]);
  });
  it("never_received → refund", () => {
    const suggested = base({ kind: "never_received", status: "suggested", found_by: "auto", qty: 12, remaining: 59.7, tasks: [open("review_suggestion", "2026-11-02T15:00:00Z", "Looks not received. Open a claim? No tracking number and no shipping email 14 days after the order date (2026-10-19).")] });
    const opened = base({ ...suggested, status: "open", tasks: [done("review_suggestion", "2026-11-02T16:00:00Z"), open("contact_supplier", "2026-11-02T16:00:00Z")] });
    const reported = base({ ...opened, reported_at: "2026-11-03", tasks: [done("review_suggestion", "2026-11-02T16:00:00Z"), done("contact_supplier", "2026-11-03T15:00:00Z")] });
    const confirmed = base({ ...reported, outcome: "refund_card", supplier_confirmed_at: "2026-11-04T12:00:00Z", tasks: [...reported.tasks, open("refund_received", "2026-11-04T12:00:00Z")] });
    const closed = base({ ...confirmed, status: "closed", closed_at: "2026-11-09T12:00:00Z", received: 59.7, remaining: 0, tasks: [...reported.tasks, done("refund_received", "2026-11-09T12:00:00Z")] });
    walk("never_received → refund", [
      { stage: "suggested (nothing 14 days after the order)", c: suggested, want: { current: "reported", bucket: "needs_attention", next: "Review suggestion", due: null, action: "Open claim" } },
      { stage: "opened 11/2", c: opened, want: { current: "reported", bucket: "needs_attention", next: "Contact supplier", due: null, sentence: "Report to supplier", action: "Contacted supplier" } },
      { stage: "reported 11/3", c: reported, want: { current: "answered", bucket: "waiting_supplier", next: "waiting for the supplier's answer", due: "2026-11-10T12:00:00.000Z" } },
      { stage: "confirmed 11/4: refund to card", c: confirmed, want: { current: "received", bucket: "waiting_refund", next: "Refund received", since: "2026-11-04T12:00:00.000Z", due: "2026-11-11T12:00:00.000Z", sentence: "Refund confirmed 11/4 · check the card" } },
      { stage: "refund posted 11/9", c: closed, now: LATER, want: { current: null, bucket: "closed", next: "" } },
    ]);
  });
  it("never_received → write-off", () => {
    const reported = base({ kind: "never_received", found_by: "auto", qty: 12, remaining: 59.7, reported_at: "2026-11-03", tasks: [done("review_suggestion", "2026-11-02T16:00:00Z"), done("contact_supplier", "2026-11-03T15:00:00Z")] });
    const followUp = base({ ...reported, tasks: [...reported.tasks, open("follow_up_supplier", "2026-11-11T15:00:00Z", "5 business days: no answer from the supplier")] });
    const followedUp = base({ ...reported, tasks: [...reported.tasks, done("follow_up_supplier", "2026-11-12T15:00:00Z")] });
    const writtenOff = base({ ...followedUp, status: "closed", outcome: "write_off", closed_at: "2026-11-20T12:00:00Z" });
    walk("never_received → write-off", [
      { stage: "reported 11/3", c: reported, want: { current: "answered", bucket: "waiting_supplier", next: "waiting for the supplier's answer", due: "2026-11-10T12:00:00.000Z" } },
      { stage: "11/12: no answer", c: reported, now: LATER, want: { current: "answered", bucket: "waiting_supplier", next: "waiting for the supplier's answer", timedOut: true, timeout: "follow_up_supplier" } },
      { stage: "the sweep's Follow up", c: followUp, now: LATER, want: { current: "answered", bucket: "needs_attention", next: "Follow up with supplier", due: null, action: "Followed up" } },
      { stage: "followed up 11/12 · timer restarts", c: followedUp, now: LATER, want: { current: "answered", bucket: "waiting_supplier", next: "waiting for the supplier's answer", since: "2026-11-12T15:00:00.000Z", due: "2026-11-19T15:00:00.000Z", timedOut: false } },
      { stage: "written off 11/20", c: writtenOff, now: new Date("2026-11-21T15:00:00Z"), want: { current: null, bucket: "closed", next: "", sentence: "Closed 11/20 · write-off" } },
    ]);
  });
  it("canceled (email) → refund: confirmed on the email's date, no Report step, contact only after the refund times out", () => {
    const suggested = base({ kind: "canceled", status: "suggested", found_by: "email", found_at: "2026-11-02", supplier_confirmed_at: "2026-10-27T14:00:00Z", qty: 6, remaining: 35.22, tasks: [open("review_suggestion", "2026-11-02T15:00:00Z", "Canceled per the walmart.com email of 2026-10-27")] });
    const opened = base({ ...suggested, status: "open", tasks: [done("review_suggestion", "2026-11-02T16:00:00Z"), open("refund_received", "2026-11-02T16:00:00Z")] });
    const contact = base({ ...opened, tasks: [...opened.tasks, open("contact_supplier", "2026-11-04T15:00:00Z", "5 business days: refund not posted")] });
    const contacted = base({ ...opened, reported_at: "2026-11-05", tasks: [...opened.tasks, done("contact_supplier", "2026-11-05T15:00:00Z", "5 business days: refund not posted")] });
    const closed = base({ ...contacted, status: "closed", outcome: "refund_card", closed_at: "2026-11-09T12:00:00Z", received: 35.22, remaining: 0, tasks: [done("review_suggestion", "2026-11-02T16:00:00Z"), done("refund_received", "2026-11-09T12:00:00Z"), done("contact_supplier", "2026-11-05T15:00:00Z", "5 business days: refund not posted")] });
    walk("canceled (email) → refund", [
      { stage: "suggested from the 10/27 email", c: suggested, want: { current: "received", bucket: "needs_attention", next: "Review suggestion", due: null, action: "Open claim" } },
      { stage: "opened 11/2 · no refund yet", c: opened, want: { current: "received", bucket: "waiting_refund", next: "Refund received", since: "2026-10-27T14:00:00.000Z", due: "2026-11-03T14:00:00.000Z", timedOut: true, timeout: "contact_supplier", sentence: "Refund confirmed 10/27 · check the card", action: "Refund received" } },
      { stage: "the sweep's Contact supplier", c: contact, want: { current: "received", bucket: "needs_attention", next: "Refund received · Contact supplier", due: null, sentence: "Refund not posted in 5 business days · contact the supplier", action: "Contacted supplier" } },
      { stage: "contacted 11/5 · timer restarts", c: contacted, want: { current: "received", bucket: "waiting_refund", next: "Refund received", since: "2026-11-05T15:00:00.000Z", due: "2026-11-12T15:00:00.000Z", timedOut: false } },
      { stage: "refund posted 11/9", c: closed, now: LATER, want: { current: null, bucket: "closed", next: "", sentence: "Closed 11/9 · refund to card" } },
    ]);
  });
  it("canceled (Cancel PO) → refund: confirmed on the cancel date, the refund tick is the next action from the start", () => {
    const canceled = base({ kind: "canceled", found_at: "2026-11-03", supplier_confirmed_at: "2026-11-03T12:00:00Z", qty: 7, remaining: 85.53, tasks: [open("refund_received", "2026-11-03T12:00:00Z")] });
    const contact = base({ ...canceled, tasks: [...canceled.tasks, open("contact_supplier", "2026-11-11T15:00:00Z", "5 business days: refund not posted")] });
    const closed = base({ ...canceled, status: "closed", outcome: "refund_card", closed_at: "2026-11-12T12:00:00Z", received: 85.53, remaining: 0, tasks: [done("refund_received", "2026-11-12T12:00:00Z"), done("contact_supplier", "2026-11-12T11:00:00Z", "5 business days: refund not posted")] });
    walk("canceled (Cancel PO) → refund", [
      { stage: "Cancel PO 11/3", c: canceled, want: { current: "received", bucket: "waiting_refund", next: "Refund received", since: "2026-11-03T12:00:00.000Z", due: "2026-11-10T12:00:00.000Z", timedOut: false, sentence: "Refund confirmed 11/3 · check the card", action: "Refund received" } },
      { stage: "11/12: refund not posted", c: canceled, now: LATER, want: { current: "received", bucket: "waiting_refund", next: "Refund received", timedOut: true, timeout: "contact_supplier" } },
      { stage: "the sweep's Contact supplier", c: contact, now: LATER, want: { current: "received", bucket: "needs_attention", next: "Refund received · Contact supplier", due: null, action: "Contacted supplier" } },
      { stage: "refund posted 11/12", c: closed, now: LATER, want: { current: null, bucket: "closed", next: "" } },
    ]);
    // The PO (Maria 2026-11-13, bathandbodyworks 00474317701906): Cancel PO leaves 7 ordered / 0 expected / nothing shipped. While the
    // claim is open the PO stays Open (D15); the refund that closes the claim closes the PO in the same request — no further
    // click — and a fully canceled PO reads Canceled, not Closed.
    const rows = [{ qty: 7, qty_expected_asin: 0, qty_lost_damaged_us: null, qty_shipped_fba: null, fully_canceled: true }];
    expect(autoCloseVerdict(rows, [], 1)).toBe(false);
    expect(poStatusLabel({ closed_at: null }, rows)).toBe("Open");
    expect(autoCloseVerdict(rows, [], 0)).toBe(true);
    expect(poStatusLabel({ closed_at: "2026-11-12T12:00:00Z" }, rows)).toBe("Canceled");
    expect(poStatusLabel({ closed_at: "2026-11-12T12:00:00Z" }, [{ fully_canceled: false }])).toBe("Closed");
    TABLE.push("| canceled (Cancel PO) → refund | PO after the refund | — | PO Canceled (auto-closed in the refund's request) | — | — |");
  });
  // a canceled claim stored before this rule (no confirmation stored) reads its found date as the cancel date
  it("a canceled claim without a stored confirmation reads its found date", () => {
    const c = base({ kind: "canceled", found_at: "2026-11-03", qty: 4, remaining: 19.88, tasks: [open("refund_received", "2026-11-03T12:00:00Z")] });
    expect(deriveBucket(c, NOW)).toMatchObject({ bucket: "waiting_refund", since: "2026-11-03T12:00:00.000Z" });
    expect(claimSteps(c).map((s) => `${s.done ? "✓" : s.current ? "●" : "○"} ${s.key}`)).toEqual(["✓ found", "✓ confirmed", "● received", "○ closed"]);
  });
});
