// Supplier emails → claims (claims commit 6, §3.11): the classifier and the matcher on scrubbed fixtures
// (server/__fixtures__/claim-emails/ — invented emails in the real templates' shape; the AI answers are recorded). The
// end-to-end walk per table row (email in → bucket, row text, button, what the button does) is claim-emails.db.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyClaimEmail, planClaimEmail, applyAiReply, poByShortSubjectId, statedOutcome, firstLine, threadPoMap, attachmentsOf, ingestClaimEmails, type ClaimEmail, type MatchContext, type ClaimRef } from "./claim-emails";
import type { PoRef } from "./tracking-match";

const DIR = join(__dirname, "__fixtures__", "claim-emails");
export const fx = (name: string): ClaimEmail => { const m = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")); return { ...m, date: new Date(m.date) }; };
const ai = (name: string) => JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")).answer;

const PO1: PoRef = { id: "po-1", supplier: "zz-test.com", order_id: "ZZ4471188", order_date: "2026-11-01", alt_order_ids: null, ships_to: "velocity" };
const PO2: PoRef = { id: "po-2", supplier: "zz-test.com", order_id: "ZZ4471199", order_date: "2026-11-03", alt_order_ids: null, ships_to: "velocity" };
const TARGET: PoRef = { id: "po-t", supplier: "target.com", order_id: "102003897221188", order_date: "2026-11-05", alt_order_ids: null, ships_to: "velocity" };
const VOLT: PoRef = { id: "po-v", supplier: "voltagecoffeesupply.com", order_id: "65705", order_date: "2026-09-25", alt_order_ids: null, ships_to: "velocity" };
const claim = (o: Partial<ClaimRef> & { id: number; po_id: string }): ClaimRef => ({ po_line_item_id: "l-1", kind: "missing", status: "open", outcome: null, amount_owed: 5.97, remaining: 5.97, reported_at: null, supplier_confirmed_at: null, source_email_id: null, ...o });
const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  pos: [PO1, PO2, TARGET, VOLT], claims: [claim({ id: 1, po_id: "po-1" })], suppliers: ["zz-test.com", "target.com", "voltagecoffeesupply.com", "walmart.com"],
  domainMap: {}, platforms: [], threadPo: new Map(), seen: new Set(), dismissed: new Map(), ...over,
});
const plan = (name: string, c: MatchContext = ctx()) => { const e = fx(name); return planClaimEmail(e, classifyClaimEmail(e), c); };

describe("fixtures", () => {
  it("every fixture is scrubbed: invented names, no real address, phone or card", () => {
    for (const f of readdirSync(DIR)) {
      const t = readFileSync(join(DIR, f), "utf8");
      expect(t, f).not.toMatch(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b\d{13,16}\b|@gmail\.com|Lelekina|Peters/i);
    }
  });
});

describe("classify (§7 templates; noise never becomes a task)", () => {
  it("the refund / credit templates, with amount, method and Target's last 4", () => {
    expect(classifyClaimEmail(fx("row1-walmart-refund"))).toMatchObject({ family: "refund_credit", template: "subject: walmart refund", amount: 5.97, method: "refund_card" });
    expect(classifyClaimEmail(fx("row2-target-last4"))).toMatchObject({ family: "refund_credit", amount: 19.98, last4: "1188" });
    expect(classifyClaimEmail(fx("row7-unknown-sender"))).toMatchObject({ family: "refund_credit", amount: 12, method: "store_credit" });
  });
  it("replies, labels, feedback, Maria's own email; a label PDF is found", () => {
    expect(classifyClaimEmail(fx("row3-reply-no-outcome")).family).toBe("reply");
    expect(classifyClaimEmail(fx("row6-return-label"))).toMatchObject({ family: "return_label", labelPdf: { filename: "return-label.pdf" } });
    expect(classifyClaimEmail(fx("row8-feedback-quiet"))).toMatchObject({ family: "feedback", quiet: true });
    expect(classifyClaimEmail(fx("row9-maria-to-supplier")).family).toBe("sent");
  });
  it("order confirmations with gift-card wording are noise (the dry run's 5 false hits); cancellation wording wins over refund wording (commit 5's)", () => {
    expect(classifyClaimEmail(fx("noise-sephora-confirmation")).family).toBe("noise");
    // "Order #… confirmed!" (Walgreens, Bath & Body Works, Frends — the 2026-11-13 dry run) is a confirmation whatever the body says
    expect(classifyClaimEmail({ ...fx("noise-sephora-confirmation"), subject: "Order #215651271261 confirmed! Stay tuned for more updates", text: "We will refund $6.39 if an item is out of stock." }).family).toBe("noise");
    expect(classifyClaimEmail({ ...fx("noise-sephora-confirmation"), subject: "your order (00474312974433) has been confirmed.", text: "Refund of $32.47 applies if canceled." }).family).toBe("noise");
    expect(classifyClaimEmail(fx("noise-cancel-wins")).family).toBe("cancel");
    expect(plan("noise-cancel-wins").row).toBe("commit5");
  });
  it("statedOutcome and firstLine", () => {
    expect(statedOutcome("The remaining 1 unit ships out tomorrow as a replacement")).toBe("replacement");
    expect(statedOutcome("We will refund the missing item to your card")).toBe("refund");
    expect(statedOutcome("Unfortunately we cannot help with this")).toBe("cant_help");
    expect(statedOutcome("We have opened case 08841127")).toBeNull();
    expect(firstLine(fx("row3-reply-no-outcome").text)).toBe("We have opened case 08841127 and will get back to you.");
    expect(attachmentsOf({ parts: [{ filename: "a.png", mimeType: "image/png", body: { attachmentId: "x", size: 1 } }, { filename: "label.pdf", mimeType: "application/pdf", body: { attachmentId: "y", size: 2 } }] })[0].filename).toBe("label.pdf");
  });
});

describe("the §3.11 rows (pure match)", () => {
  it("row 1: order # + amount within 1¢ on an open claim → confirmed, outcome, the refund row prefilled; a suggested claim opens (Maria 2026-11-13); 1¢ off is row 2", () => {
    expect(plan("row1-walmart-refund")).toMatchObject({ row: 1, claim: { id: 1 }, method: "refund_card", amount: 5.97 });
    expect(plan("row1-walmart-refund", ctx({ claims: [claim({ id: 1, po_id: "po-1", status: "suggested" })] }))).toMatchObject({ row: 1, label: expect.stringContaining("suggested") });
    expect(plan("row1-walmart-refund", ctx({ claims: [claim({ id: 1, po_id: "po-1", remaining: 5.99 })] }))).toMatchObject({ row: 2, claim: { id: 1 } });
    expect(plan("row1-walmart-refund", ctx({ claims: [claim({ id: 1, po_id: "po-1", remaining: 5.98 })] }))).toMatchObject({ row: 1 });
  });
  it("row 2: Target's last 4 + supplier + 60-day window → not sure", () => {
    const c = ctx({ claims: [claim({ id: 9, po_id: "po-t", amount_owed: 19.98, remaining: 19.98 })] });
    expect(plan("row2-target-last4", c)).toMatchObject({ row: 2, claim: { id: 9 }, why: expect.stringContaining("last 4 1188") });
  });
  it("row 3 / row 4: a reply on the one open claim — no outcome → read_reply (Haiku reads it from a known supplier); an outcome stated → confirm_outcome", () => {
    expect(plan("row3-reply-no-outcome")).toMatchObject({ row: 3, claim: { id: 1 }, needsAi: true, summary: "We have opened case 08841127 and will get back to you." });
    expect(plan("row4-reply-replacement")).toMatchObject({ row: 4, claim: { id: 1 }, outcome: "replacement", needsAi: false });
    expect(applyAiReply(plan("row3-reply-no-outcome"), ai("ai-reply-none"))).toMatchObject({ row: 3, needsAi: false });
    expect(applyAiReply(plan("row3-reply-no-outcome"), ai("ai-reply-replacement"))).toMatchObject({ row: 4, outcome: "replacement" });
  });
  it("row 5: a refund email on a PO with no claim → a suggested claim; a supplier reply on such a PO → a suggested claim too (Maria 2026-11-13)", () => {
    expect(plan("row5-refund-no-claim")).toMatchObject({ row: 5, po: { id: "po-2" }, amount: 9.94, claim: null });
    expect(plan("row3-reply-no-outcome", ctx({ claims: [] }))).toMatchObject({ row: 3, claim: null, sets: expect.stringContaining("Supplier email on a PO with no claim") });
  });
  it("row 6: a return label with its PDF on an open claim", () => {
    expect(plan("row6-return-label")).toMatchObject({ row: 6, claim: { id: 1 }, labelPdf: { filename: "return-label.pdf" } });
  });
  it("row 7: an unknown sender naming an open claim's order #", () => {
    expect(plan("row7-unknown-sender")).toMatchObject({ row: 7, claim: { id: 1 }, amount: 12 });
  });
  it("row 8: an email on a closed claim → a task; feedback / case-resolved / return progress → quiet; a dismissed claim counts as closed", () => {
    const closed = ctx({ claims: [claim({ id: 1, po_id: "po-1", status: "closed", remaining: 0 })] });
    expect(plan("row8-closed-claim-refund-failed", closed)).toMatchObject({ row: 8, quiet: false, claim: { id: 1 } });
    expect(plan("row8-feedback-quiet", closed)).toMatchObject({ row: 8, quiet: true });
    expect(plan("row8-feedback-quiet")).toMatchObject({ row: 8, quiet: true, claim: { status: "open" } });
    expect(plan("row8-closed-claim-refund-failed", ctx({ claims: [claim({ id: 1, po_id: "po-1", status: "dismissed" })] }))).toMatchObject({ row: 8, claim: { status: "dismissed" } });
  });
  it("row 9: Maria's own email to the supplier about an order with one open claim; with no open claim nothing happens; several open claims → not sure", () => {
    expect(plan("row9-maria-to-supplier")).toMatchObject({ row: 9, claim: { id: 1 }, summary: expect.stringContaining("Order ZZ4471188 arrived with 1 unit missing") });
    expect(plan("row9-maria-to-supplier", ctx({ claims: [] }))).toMatchObject({ row: "noise", label: "Maria's email, PO has no open claim" });
    expect(plan("row9-maria-to-supplier", ctx({ claims: [claim({ id: 1, po_id: "po-1" }), claim({ id: 2, po_id: "po-1", po_line_item_id: "l-2" })] }))).toMatchObject({ row: 2 });
  });
  it("two open claims on one PO: a refund attaches to the one whose amount it names, else row 2; a reply → row 7 (which claim)", () => {
    const two = ctx({ claims: [claim({ id: 1, po_id: "po-1" }), claim({ id: 2, po_id: "po-1", po_line_item_id: "l-2", amount_owed: 19.98, remaining: 19.98 })] });
    expect(plan("row1-walmart-refund", two)).toMatchObject({ row: 1, claim: { id: 1 } });
    expect(plan("row1-walmart-refund", ctx({ claims: [claim({ id: 1, po_id: "po-1", remaining: 3 }), claim({ id: 2, po_id: "po-1", po_line_item_id: "l-2", remaining: 4 })] }))).toMatchObject({ row: 2 });
    expect(plan("row3-reply-no-outcome", two)).toMatchObject({ row: 7 });
  });
  it("a duplicate email (already on a claim) does nothing; a dismissed email is never proposed to that claim again but may fit another", () => {
    expect(plan("row1-walmart-refund", ctx({ seen: new Set(["fx-row1-walmart-refund"]) })).row).toBe("seen");
    const dism = ctx({ dismissed: new Map([["fx-row1-walmart-refund", new Set([1])]]) });
    expect(plan("row1-walmart-refund", dism)).toMatchObject({ row: 5 }); // no other claim on the PO: a suggestion, not #1 again
  });
  it("short order numbers (Maria 2026-11-13): a reply from the supplier's own domain with a short id after \"Order\" in the subject; the Voltage alias", () => {
    expect(poByShortSubjectId("Re: Order 65705 confirmed", "voltagecoffeesupply.com", [VOLT])).toEqual(VOLT);
    expect(poByShortSubjectId("Re: your account", "voltagecoffeesupply.com", [VOLT])).toBeNull();
    expect(plan("row3-short-id-voltage", ctx({ claims: [claim({ id: 7, po_id: "po-v" })] }))).toMatchObject({ row: 3, po: { id: "po-v" }, claim: { id: 7 }, why: "short order # in the subject" });
  });
  it("a thread takes the PO another message of it named (a Michaels case thread Maria's email started)", () => {
    const reply = { ...fx("row3-reply-no-outcome"), subject: "Re: Case 08841127", text: "We have opened case 08841127 and will get back to you." };
    const map = threadPoMap([fx("row9-maria-to-supplier"), reply], [PO1, PO2]);
    expect(map.get("orders@coastalqualitygoods.com:thr-1")).toEqual(PO1);
    expect(planClaimEmail(reply, classifyClaimEmail(reply), ctx({ threadPo: map }))).toMatchObject({ row: 3, why: "the thread names the PO" });
  });
});

describe("the hourly pass never reads a mailbox's whole history on its own", () => {
  it("requireWatermark: a mailbox with no watermark is skipped (the first live backfill sets it); with a watermark the pass reads from it", async () => {
    const listed: string[] = [];
    const q = async (sql: string) => (/FROM settings WHERE key = \$1/.test(sql) ? { rows: [{ value: { "orders@coastalqualitygoods.com": "2026-11-13T18:00:00.000Z" } }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const deps = { gmailFor: () => ({}) as any, list: async (_g: any, query: string) => { listed.push(query); return []; }, get: async () => ({}) as any };
    const r = await ingestClaimEmails({ query: q as any, deps, requireWatermark: true, dryRun: true, mailboxes: [{ mailbox: "orders@coastalqualitygoods.com", received: true, sent: true }, { mailbox: "maria@coastalqualitygoods.com", received: false, sent: true }] });
    expect(r.skipped_mailboxes).toEqual(["maria@coastalqualitygoods.com"]);
    expect(listed.every((x) => /after:\d+/.test(x))).toBe(true); // orders@ read from its watermark (6 h overlap), never from the beginning
    expect(listed.length).toBe(2);
  });
});
