import { describe, it, expect } from "vitest";
import { addBusinessDays, businessDaysBetween, claimSteps, daysSince, deriveBucket, nextAction, type BucketClaim } from "./claim-bucket";

// Supplier claims commit 2 (SPEC §22 "Supplier claims" §3.2–3.4): buckets, the one 5-business-day timer, the checklist.
const base = (over: Partial<BucketClaim> = {}): BucketClaim => ({
  status: "open", kind: "missing", outcome: null, found_at: "2026-11-02", found_by: "maria", reported_at: null, supplier_confirmed_at: null, closed_at: null,
  return_required: false, replacement_shipped_at: null, replacement_arrived_at: null, qty_disposed: null, remaining: 5.97, received: 0, qty: 1, tasks: [], ships_to: "velocity", ...over,
});
const done = (kind: string, at: string, extra: Record<string, unknown> = {}) => ({ kind, done_at: at, created_at: at, ...extra });
const open = (kind: string) => ({ kind, done_at: null, created_at: "2026-11-02T15:00:00Z" });
const NOW = new Date("2026-11-10T15:00:00Z"); // Tue Nov 10, 10:00 ET

describe("business days (Mon–Fri, America/New_York)", () => {
  it("counts weekdays after the start day; a weekend adds nothing", () => {
    expect(businessDaysBetween("2026-11-06T20:00:00Z", "2026-11-09T20:00:00Z")).toBe(1); // Fri → Mon
    expect(businessDaysBetween("2026-11-02T15:00:00Z", "2026-11-09T15:00:00Z")).toBe(5); // Mon → next Mon
    expect(businessDaysBetween("2026-11-07T15:00:00Z", "2026-11-08T15:00:00Z")).toBe(0); // Sat → Sun
    expect(businessDaysBetween("2026-11-09T15:00:00Z", "2026-11-06T15:00:00Z")).toBe(-1);
  });
  it("+5 business days: Friday → the next Friday, Monday → the next Monday, a Saturday start counts from Monday", () => {
    expect(addBusinessDays("2026-11-06T20:00:00Z", 5).toISOString()).toBe("2026-11-13T20:00:00.000Z");
    expect(addBusinessDays("2026-11-02T15:00:00Z", 5).toISOString()).toBe("2026-11-09T15:00:00.000Z");
    expect(addBusinessDays("2026-11-07T15:00:00Z", 5).toISOString()).toBe("2026-11-13T15:00:00.000Z");
  });
  it("the zone decides the day: 11:30 pm ET on a Friday is still Friday (04:30Z Saturday)", () => {
    expect(addBusinessDays("2026-11-07T04:30:00Z", 5).toISOString()).toBe("2026-11-14T04:30:00.000Z"); // Fri Nov 6 ET → Fri Nov 13 ET
    expect(daysSince("2026-11-02", NOW)).toBe(8);
    expect(daysSince(null, NOW)).toBeNull();
  });
});

describe("bucket derivation (§3.2): an open task wins, else the running timer", () => {
  it("open task → Needs attention; suggested → Needs attention; closed / dismissed are their own", () => {
    expect(deriveBucket(base({ tasks: [open("contact_supplier")] }), NOW).bucket).toBe("needs_attention");
    expect(deriveBucket(base({ status: "suggested", tasks: [open("review_suggestion")] }), NOW).bucket).toBe("needs_attention");
    expect(deriveBucket(base({ status: "closed", closed_at: "2026-11-05T10:00:00Z" }), NOW)).toMatchObject({ bucket: "closed", since: "2026-11-05T10:00:00Z", timedOut: false });
    expect(deriveBucket(base({ status: "dismissed" }), NOW).bucket).toBe("dismissed");
  });
  it("reported, no answer → Waiting on supplier from the report; 5 business days later follow_up_supplier is due", () => {
    const reportedMon = base({ reported_at: "2026-11-02", tasks: [done("contact_supplier", "2026-11-02T15:00:00Z")] });
    const b = deriveBucket(reportedMon, new Date("2026-11-06T15:00:00Z")); // Fri: 4 business days
    expect(b).toMatchObject({ bucket: "waiting_supplier", since: "2026-11-02T12:00:00.000Z", timedOut: false, timeout: { kind: "follow_up_supplier" } }); // the typed report date anchors it
    expect(deriveBucket(reportedMon, new Date("2026-11-09T15:00:00Z")).timedOut).toBe(true);  // Mon: 5
    expect(deriveBucket(reportedMon, NOW).timeout!.reason).toMatch(/no answer from the supplier/);
  });
  it("a Follow up / Check on it tick restarts the timer; a snooze (snoozed_until in the future) holds it", () => {
    const c = base({ reported_at: "2026-10-20", tasks: [done("contact_supplier", "2026-10-20T15:00:00Z"), done("follow_up_supplier", "2026-11-05T15:00:00Z")] });
    const b = deriveBucket(c, NOW);
    expect(b).toMatchObject({ bucket: "waiting_supplier", since: "2026-11-05T15:00:00.000Z", timedOut: false });
    expect(b.due).toBe("2026-11-12T15:00:00.000Z");
    const snoozed = base({ reported_at: "2026-10-20", tasks: [done("contact_supplier", "2026-10-20T15:00:00Z"), done("check_on_it", "2026-10-26T15:00:00Z", { snoozed_until: "2026-11-20T15:00:00Z" })] });
    expect(deriveBucket(snoozed, NOW).timedOut).toBe(false);
  });
  it("the timer runs only while the claim has NO open task (Maria 2026-11-11): an open tick of any kind holds it, and any tick restarts it", () => {
    // reported Oct 20, long overdue — but an Enter quantity task is open: Needs attention, no timer, nothing for the sweep
    const held = base({ reported_at: "2026-10-20", tasks: [done("contact_supplier", "2026-10-20T15:00:00Z"), open("enter_quantity")] });
    expect(deriveBucket(held, NOW)).toMatchObject({ bucket: "needs_attention", due: null, timedOut: false, timeout: null });
    // the same claim with an open PASSIVE tick: its timer bucket, still no timer
    const passive = base({ reported_at: "2026-10-20", outcome: "refund_card", supplier_confirmed_at: "2026-10-22T15:00:00Z", tasks: [done("contact_supplier", "2026-10-20T15:00:00Z"), open("refund_received")] });
    expect(deriveBucket(passive, NOW)).toMatchObject({ bucket: "waiting_refund", since: "2026-10-22T15:00:00.000Z", due: null, timedOut: false, timeout: null });
    // ticked (Enter quantity done Nov 9) → the timer restarts from the tick, not from the Oct 20 report
    const ticked = base({ reported_at: "2026-10-20", tasks: [done("contact_supplier", "2026-10-20T15:00:00Z"), done("enter_quantity", "2026-11-09T15:00:00Z")] });
    expect(deriveBucket(ticked, NOW)).toMatchObject({ bucket: "waiting_supplier", since: "2026-11-09T15:00:00.000Z", due: "2026-11-16T15:00:00.000Z", timedOut: false });
    // the Contact supplier tick itself does not restart it: the typed report date is the anchor
    const typed = base({ reported_at: "2026-10-20", tasks: [done("contact_supplier", "2026-11-09T15:00:00Z")] });
    expect(deriveBucket(typed, NOW)).toMatchObject({ since: "2026-10-20T12:00:00.000Z", timedOut: true, timeout: { kind: "follow_up_supplier" } });
  });
  it("refund promised but not confirmed → Waiting on supplier; confirmed and not posted → Waiting on refund to post (check_on_it 'refund not posted')", () => {
    const promised = base({ outcome: "refund_card", reported_at: "2026-11-03", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z"), done("confirm_outcome", "2026-11-04T15:00:00Z")] });
    expect(deriveBucket(promised, NOW)).toMatchObject({ bucket: "waiting_supplier", since: "2026-11-04T15:00:00.000Z", timeout: { kind: "follow_up_supplier" } });
    const confirmed = base({ outcome: "gift_card", reported_at: "2026-10-26", supplier_confirmed_at: "2026-10-30T15:00:00Z", tasks: [done("contact_supplier", "2026-10-26T15:00:00Z")] });
    const b = deriveBucket(confirmed, NOW);
    expect(b).toMatchObject({ bucket: "waiting_refund", since: "2026-10-30T15:00:00.000Z", timedOut: true, timeout: { kind: "check_on_it" } });
    expect(b.timeout!.reason).toMatch(/refund not posted/);
    expect(deriveBucket({ ...confirmed, received: 20, remaining: 16.11 }, NOW).timeout!.reason).toMatch(/not posted in full/);
  });
  it("replacement: promised → Waiting on supplier; told Velocity → Waiting on shipment; shipped → Waiting on shipment from the ship date; arrived closes", () => {
    const promised = base({ outcome: "replacement", reported_at: "2026-11-03", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z")] });
    expect(deriveBucket(promised, NOW).bucket).toBe("waiting_supplier");
    const told = { ...promised, tasks: [...promised.tasks, done("tell_velocity_replacement", "2026-11-04T15:00:00Z")] };
    expect(deriveBucket(told, NOW)).toMatchObject({ bucket: "waiting_shipment", since: "2026-11-04T15:00:00.000Z" });
    const shipped = { ...told, replacement_shipped_at: "2026-11-05" };
    expect(deriveBucket(shipped, NOW)).toMatchObject({ bucket: "waiting_shipment", since: "2026-11-05T12:00:00.000Z", timedOut: false });
    expect(deriveBucket(shipped, new Date("2026-11-13T15:00:00Z")).timedOut).toBe(true); // Thu Nov 5 + 5 bd = Thu Nov 12
  });
  it("Velocity: label sent on a return → Waiting on Velocity; dispose asked, count not down → Waiting on Velocity until qty_disposed", () => {
    const label = base({ return_required: true, reported_at: "2026-11-03", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z"), done("send_label", "2026-11-06T15:00:00Z")] });
    expect(deriveBucket(label, NOW)).toMatchObject({ bucket: "waiting_velocity", since: "2026-11-06T15:00:00.000Z", timedOut: false });
    const dispose = base({ outcome: "write_off", reported_at: "2026-11-03", tasks: [done("dispose_units", "2026-11-02T15:00:00Z")] });
    expect(deriveBucket(dispose, NOW)).toMatchObject({ bucket: "waiting_velocity", timedOut: true, timeout: { kind: "check_on_it" } });
    expect(deriveBucket({ ...dispose, qty_disposed: 3 }, NOW).bucket).toBe("waiting_supplier"); // nothing Velocity-side left; the generic timer
  });
});

describe("the checklist (§3.4) and Next action", () => {
  it("refund path: Found → Reported → Confirmed by supplier → Received → Closed, the current step highlighted", () => {
    const c = base({ reported_at: "2026-11-03", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z")] });
    const s = claimSteps(c);
    expect(s.map((x) => [x.label, x.done, x.current])).toEqual([["Found", true, false], ["Reported", true, false], ["Confirmed by supplier", false, true], ["Received", false, false], ["Closed", false, false]]);
    const closed = claimSteps(base({ status: "closed", outcome: "refund_card", closed_at: "2026-11-09T10:00:00Z", supplier_confirmed_at: "2026-11-06T10:00:00Z", remaining: 0, received: 5.97 }));
    expect(closed.every((x) => x.done)).toBe(true);
  });
  it("return steps show only on a return; replacement and write-off paths; an emailed cancellation skips Reported", () => {
    expect(claimSteps(base({ return_required: true })).map((x) => x.label)).toEqual(["Found", "Reported", "Label", "Sent to Velocity", "Shipped", "Delivered", "Confirmed by supplier", "Received", "Closed"]);
    expect(claimSteps(base({ outcome: "replacement", reported_at: "2026-11-03" })).map((x) => x.label)).toEqual(["Found", "Reported", "Promised", "Tell Velocity", "Shipped", "Arrived", "Closed"]);
    expect(claimSteps(base({ outcome: "replacement", reported_at: "2026-11-03", ships_to: "home" })).map((x) => x.label)).toEqual(["Found", "Reported", "Promised", "Shipped", "Arrived", "Closed"]);
    expect(claimSteps(base({ outcome: "write_off", status: "closed", closed_at: "2026-11-09", tasks: [open("dispose_units")] })).map((x) => x.label)).toEqual(["Found", "Reported", "Written off", "Dispose", "Closed"]);
    expect(claimSteps(base({ kind: "canceled", found_by: "email" })).map((x) => x.label)).toEqual(["Found", "Confirmed by supplier", "Received", "Closed"]);
  });
  it("passive tasks (refund_received, replacement_arrived) never make Needs attention: the claim waits in its timer bucket and offers the tick as Next action", () => {
    const c = base({ outcome: "refund_card", reported_at: "2026-11-03", supplier_confirmed_at: "2026-11-05T15:00:00Z", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z"), open("refund_received")] });
    expect(deriveBucket(c, NOW)).toMatchObject({ bucket: "waiting_refund", since: "2026-11-05T15:00:00.000Z", due: null });
    expect(nextAction(c, deriveBucket(c, NOW))).toBe("Refund received");
    const r = base({ outcome: "replacement", reported_at: "2026-11-03", replacement_shipped_at: "2026-11-05", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z"), open("replacement_arrived")] });
    expect(deriveBucket(r, NOW).bucket).toBe("waiting_shipment");
  });
  it("Next action: the open tasks, else what the timer waits for", () => {
    const c = base({ tasks: [open("enter_quantity"), open("refund_received")] });
    expect(nextAction(c, deriveBucket(c, NOW))).toBe("Enter quantity · Refund received");
    const w = base({ reported_at: "2026-11-03", tasks: [done("contact_supplier", "2026-11-03T15:00:00Z")] });
    expect(nextAction(w, deriveBucket(w, NOW))).toBe("waiting for the supplier's answer");
  });
});
