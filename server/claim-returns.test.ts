// Returns (claims commit 7, §3.12) — the pure readings: what a return email says (the Walmart templates of the 90-day probe,
// scrubbed), the tracker's scans after the label (the §3.9 reuse case), the return-by arithmetic, the Velocity message.
// No Gmail, no EasyPost, no Haiku: fixtures only.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readReturnEmail, resolveDate, returnScanState, daysToReturnBy, returnByReason, RETURN_BY_WARN_DAYS } from "./claim-returns";
import { velocityMessage, stateSentence, primaryAction, whatHappensNext, sourceWord } from "@shared/claim-ui";
import { deriveBucket, claimSteps } from "@shared/claim-bucket";
import type { EasypostTracker } from "./easypost";

const FX = join(__dirname, "__fixtures__");
const email = (name: string) => { const m = JSON.parse(readFileSync(join(FX, "claim-emails", `${name}.json`), "utf8")); return { ...m, date: new Date(m.date) }; };
const tracker = (name: string): EasypostTracker => JSON.parse(readFileSync(join(FX, "easypost", `${name}.json`), "utf8"));

describe("readReturnEmail — regex over the Walmart templates", () => {
  it("'Drop off your return at FedEx by Mon, Nov 30': the label, FedEx 12 digits, return by 11/30", () => {
    expect(readReturnEmail(email("ret1-label-fedex"))).toEqual({ kind: "label", carrier: "FEDEX", trackingNumber: "528889999001", returnBy: "2026-11-30", pickupDate: null, storeReturn: false });
  });
  it("'Return pickup confirmation: Thu, Nov 12': a scheduled pickup with the tracking #, the pickup date, no return-by", () => {
    expect(readReturnEmail(email("ret10-pickup"))).toEqual({ kind: "pickup", carrier: "FEDEX", trackingNumber: "798199999003", returnBy: null, pickupDate: "2026-11-12", storeReturn: false });
  });
  it("'Drop off your return in-store by Fri, Nov 20': a store return — no label, no tracking, return by 11/20", () => {
    expect(readReturnEmail(email("ret3-store-no-label"))).toEqual({ kind: "store", carrier: null, trackingNumber: null, returnBy: "2026-11-20", pickupDate: null, storeReturn: true });
  });
  it("'We received your return' and the pickup reminder (its 'Return by Thu, Dec 10')", () => {
    expect(readReturnEmail(email("ret10-received")).kind).toBe("received");
    expect(readReturnEmail(email("ret-reminder"))).toMatchObject({ kind: "reminder", returnBy: "2026-12-10", pickupDate: "2026-11-12" });
  });
  it("the year is the next occurrence on or after the email: 'by Jan 5' read on Nov 10 is next January; a printed year wins", () => {
    const nov = new Date("2026-11-10T12:00:00Z");
    expect(resolveDate(/by (?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?([A-Z][a-z]{2,8})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i.exec("by Mon, Jan 5"), nov)).toBe("2027-01-05");
    expect(resolveDate(/by (?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?([A-Z][a-z]{2,8})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i.exec("by Nov 30, 2027"), nov)).toBe("2027-11-30");
    expect(readReturnEmail({ subject: "Drop off your return by 12/1", text: "Return by 12/1", date: nov })).toMatchObject({ kind: "label", returnBy: "2026-12-01" });
  });
});

describe("returnScanState — only the scans after the label count", () => {
  it("a label 11/10: pre_transit → nothing moved; in transit → the first movement scan 11/13 (Shipped), the last scan's place, the ETA", () => {
    expect(returnScanState(tracker("tracker-return-pre_transit"), "2026-11-10T15:34:35Z")).toMatchObject({ status: "pre_transit", first_scan_at: null, moved: true, exception: null });
    expect(returnScanState(tracker("tracker-return-in_transit"), "2026-11-10T15:34:35Z")).toMatchObject({ status: "in_transit", first_scan_at: "2026-11-13T16:40:00.000Z", last_scan_at: "2026-11-14T03:12:00.000Z", last_scan_location: "Memphis, TN", delivered_at: null, est_delivery_at: "2026-11-17T00:00:00.000Z" });
    expect(returnScanState(tracker("tracker-return-delivered-after-label"), "2026-11-10T15:34:35Z")).toMatchObject({ status: "delivered", first_scan_at: "2026-11-13T16:40:00.000Z", delivered_at: "2026-11-17T14:02:00.000Z", last_scan_location: "Bentonville, AR" });
    expect(returnScanState(tracker("tracker-return-exception"), "2026-11-10T15:34:35Z")).toMatchObject({ status: "return_to_sender", exception: "return_to_sender", first_scan_at: "2026-11-13T16:40:00.000Z" });
  });
  it("a return reusing the inbound number (§3.9): the inbound leg's October scans and its delivery never count; the November pickup does", () => {
    const before = returnScanState(tracker("tracker-reuse-inbound"), "2026-11-11T12:00:00Z");
    expect(before).toMatchObject({ status: "pre_transit", moved: false, first_scan_at: null, delivered_at: null, exception: null });
    const after = returnScanState(tracker("tracker-reuse-return-moved"), "2026-11-11T12:00:00Z");
    expect(after).toMatchObject({ status: "in_transit", first_scan_at: "2026-11-12T18:00:00.000Z", delivered_at: null, last_scan_location: "La Grande, OR" });
  });
});

describe("the return-by date (row 9)", () => {
  it("calendar days in America/New_York; the warning at 3 days or less; the reason's words", () => {
    const now = new Date("2026-11-27T15:00:00Z"); // Fri Nov 27, 10:00 ET
    expect(daysToReturnBy("2026-11-30", now)).toBe(3);
    expect(daysToReturnBy("2026-11-27", now)).toBe(0);
    expect(daysToReturnBy("2026-11-25", now)).toBe(-2);
    expect(RETURN_BY_WARN_DAYS).toBe(3);
    expect(returnByReason("2026-11-30", 3)).toBe("return by 11/30 · 3 days left");
    expect(returnByReason("2026-11-28", 1)).toBe("return by 11/28 · 1 day left");
    expect(returnByReason("2026-11-27", 0)).toBe("return by 11/27 · today");
    expect(returnByReason("2026-11-25", -2)).toBe("return by 11/25 · 2 days overdue");
  });
});

describe("the words (the two mockups)", () => {
  const base = (over: Record<string, unknown> = {}): any => ({
    id: 3356, status: "open", kind: "cant_sell", outcome: "refund_card", found_at: "2026-10-30", found_by: "maria", reported_at: "2026-10-31", reported_channel: "return started on walmart.com", supplier_confirmed_at: null, last_supplier_reply_at: null, closed_at: null,
    return_required: true, replacement_shipped_at: null, replacement_arrived_at: null, qty_disposed: null, remaining: 47.76, received: 0, qty: 8, ordered: 8, tasks: [], ships_to: "velocity",
    return_label_at: "2026-10-31T15:02:00Z", return_label_source: "email", return_label_doc_id: 1835, return_no_label: false, return_by: "2026-11-30", return_by_source: "email",
    product_name: "Oreos (gated)", asin: "B07Q4RXG2Z", order_id: "200015193721348", supplier: "walmart.com", ...over,
  });
  const NOW = new Date("2026-11-13T15:00:00Z");
  it("Copy message for Velocity: the §3.12 text, with the return-by date; without one the last sentence goes", () => {
    expect(velocityMessage(base())).toBe("Please ship back 8 units of Oreos (gated) (B07Q4RXG2Z) from order 200015193721348 using the attached label. It has to go out by 11/30/2026.");
    expect(velocityMessage(base({ return_by: null }))).toBe("Please ship back 8 units of Oreos (gated) (B07Q4RXG2Z) from order 200015193721348 using the attached label.");
  });
  it("rows 1 / 2 / 3: the Needs attention sentences, buttons and links", () => {
    const sent = base({ tasks: [{ id: 1, kind: "send_label", done_at: null, created_at: "2026-10-31T15:02:00Z" }] });
    const b = deriveBucket(sent, NOW);
    expect(b.bucket).toBe("needs_attention");
    expect(stateSentence(sent, b)).toBe("Return label saved 10/31 · from email · send it to Velocity · return by 11/30");
    expect(primaryAction(sent, b)).toMatchObject({ kind: "task", label: "Sent label", taskId: 1, links: { label_doc_id: 1835, copy_message: expect.stringContaining("Please ship back 8 units") } });
    const home = base({ ships_to: "home", return_label_at: "2026-11-12T14:00:00Z", return_by: "2026-11-20", tasks: [{ id: 2, kind: "drop_off_return", done_at: null, created_at: "2026-11-12T14:00:00Z" }] });
    expect(stateSentence(home, deriveBucket(home, NOW))).toBe("Return label saved 11/12 · from email · ships from home · drop off by 11/20");
    expect(primaryAction(home, deriveBucket(home, NOW))).toMatchObject({ label: "Dropped off", links: { label_doc_id: 1835, copy_message: null } });
    const noLabel = base({ return_label_at: null, return_label_doc_id: null, return_by: null, tasks: [{ id: 3, kind: "upload_return_label", done_at: null, created_at: "2026-11-10T14:00:00Z" }] });
    expect(stateSentence(noLabel, deriveBucket(noLabel, NOW))).toBe("A return is needed · no label yet");
    expect(primaryAction(noLabel, deriveBucket(noLabel, NOW))).toMatchObject({ kind: "detail", label: "Upload label", secondary: "no_label" });
  });
  it("rows 4 / 5 / 6: the waiting sentences; 8 / 9: the timed-out ones; the step sources", () => {
    const sent = base({ tasks: [{ id: 1, kind: "send_label", done_at: "2026-11-12T15:00:00Z", created_at: "2026-10-31T15:02:00Z" }] });
    expect(deriveBucket(sent, NOW).bucket).toBe("waiting_velocity");
    expect(stateSentence(sent, deriveBucket(sent, NOW))).toBe("Label sent 11/12 · waiting for the first carrier scan");
    const tracking = { carrier: "FEDEX", tracking_number: "798190555249", carrier_status: "in_transit", est_delivery_at: "2026-11-17T00:00:00Z", last_scan_at: "2026-11-13T16:40:00Z", last_scan_location: "Memphis, TN", delivered_at: null };
    const shipped = base({ ...sent, return_shipped_at: "2026-11-13T16:40:00Z", return_shipped_source: "tracking", return_tracking: tracking });
    expect(deriveBucket(shipped, NOW)).toMatchObject({ bucket: "waiting_shipment", since: "2026-11-13T16:40:00.000Z" });
    expect(stateSentence(shipped, deriveBucket(shipped, NOW))).toBe("Return shipped 11/13 · FedEx in transit · due 11/17 · from tracking");
    expect(whatHappensNext(shipped, deriveBucket(shipped, NOW)).map((n) => n.when)).toEqual(["Now", "Then", "Then", "If it stalls"]);
    const delivered = base({ ...shipped, return_delivered_at: "2026-11-17T14:02:00Z", return_delivered_source: "tracking" });
    const bd = deriveBucket(delivered, new Date("2026-11-18T15:00:00Z"));
    expect(bd).toMatchObject({ bucket: "waiting_supplier", timeout: { kind: "check_on_it", reason: "5 business days: return delivered 11/17 · no refund confirmation" } });
    expect(stateSentence(delivered, bd)).toBe("Return delivered 11/17 · from tracking · waiting for the refund confirmation");
    // row 8: the stall sentences; row 9: the return-by warning
    const stalled = base({ ...sent, tasks: [...sent.tasks, { id: 9, kind: "check_on_it", done_at: null, created_at: "2026-11-20T15:00:00Z", reason: "5 business days: label sent to Velocity 11/12 · no carrier scan" }] });
    expect(stateSentence(stalled, deriveBucket(stalled, NOW))).toBe("Label sent to Velocity 11/12 · no carrier scan in 5 business days");
    const warned = base({ return_label_at: "2026-10-20T15:00:00Z", return_by: "2026-11-16", tasks: [{ id: 10, kind: "check_on_it", done_at: null, created_at: "2026-11-13T15:00:00Z", reason: "return by 11/16 · 3 days left" }] });
    expect(stateSentence(warned, deriveBucket(warned, NOW))).toBe("Return by 11/16 · 3 days left · label saved 10/20, not shipped yet");
    const exception = base({ ...shipped, tasks: [...sent.tasks, { id: 11, kind: "check_on_it", done_at: null, created_at: "2026-11-15T15:00:00Z", reason: "carrier reports returned to sender on the return · FedExDefault 798190555249" }] });
    expect(stateSentence(exception, deriveBucket(exception, NOW))).toBe("Carrier reports returned to sender on the return · FedExDefault 798190555249");
    // the steps carry their source; row 12's kept auto-tick reads "set at confirmation, before tracking"
    expect(claimSteps(delivered).filter((s) => s.source).map((s) => [s.key, s.source])).toEqual([["label", "email"], ["return_shipped", "tracking"], ["return_delivered", "tracking"]]);
    expect(sourceWord("confirmation")).toBe("set at confirmation, before tracking");
    const kept = base({ ...sent, supplier_confirmed_at: "2026-11-09T12:00:00Z", return_shipped_at: "2026-11-09T12:00:00Z", return_shipped_source: "confirmation", return_delivered_at: "2026-11-09T12:00:00Z", return_delivered_source: "confirmation" });
    expect(deriveBucket(kept, NOW).bucket).toBe("waiting_refund"); // nothing re-opens
    expect(claimSteps(kept).find((s) => s.key === "return_delivered")).toMatchObject({ done: true, source: "confirmation" });
  });
  it("row 11: return_required off → no return steps; the write-off path keeps its own", () => {
    expect(claimSteps(base({ return_required: false })).map((s) => s.key)).toEqual(["found", "reported", "answered", "confirmed", "received", "closed"]);
    expect(claimSteps(base()).map((s) => s.key)).toEqual(["found", "reported", "answered", "label", "label_sent", "return_shipped", "return_delivered", "confirmed", "received", "closed"]);
    expect(claimSteps(base({ ships_to: "home" })).find((s) => s.key === "label_sent")?.label).toBe("Dropped off");
  });
});
