// Supplier emails → claims (claims commit 6): the §3.11 acceptance table walked END TO END on the REAL local schema, every
// test in a transaction that is ROLLED BACK — the email (a scrubbed fixture) in, then the Claims page row it makes (bucket,
// group, Step sentence, the Do button), then the button pressed and what it set. No Gmail, no Haiku (recorded answers),
// no Drive (a stub takes the label). The table the run prints is the report's. Skipped when no local Postgres answers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEmailPlan, classifyClaimEmail, planClaimEmail, applyAiReply, loadMatchContext, type ClaimEmail, type MatchContext } from "./claim-emails";
import { addClaim, addRefundReceived, doneTask, setOutcome, dismissClaim, loadClaims, loadClaimEvents } from "./supplier-claims";
import { loadClaimsPage, claimDetail } from "./claim-buckets";

const DIR = join(__dirname, "__fixtures__", "claim-emails");
const fx = (name: string): ClaimEmail => { const m = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")); return { ...m, date: new Date(m.date) }; };
const aiOf = (name: string) => JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")).answer;
const NOW = new Date("2026-11-13T15:00:00Z");

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT gmail_message_id FROM supplier_claim_tasks LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });
type Q = (sql: string, params?: any[]) => Promise<any>;

/** Two POs of one supplier (ZZ4471188 with a line of 12 singles at $5.97; ZZ4471199 without a claim) and a Target PO ending in 1188. */
async function seed(q: Q) {
  const mk = async (supplier: string, orderId: string, date: string) => {
    const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, order_total, ships_to) VALUES ($1, $2, $3, 71.64, 71.64, 'velocity') RETURNING id`, [orderId, date, supplier])).rows[0].id as string;
    const pa = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as, qty_basis) VALUES ($1, 'B0ZZEML00A', 12, 2, 'multi-pack', 'individual') RETURNING id`, [po])).rows[0].id as string;
    const line = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered, price, adjusted_product_cost, retailer_units_per_product, asin_units_per_pack, qty_basis)
                          VALUES ($1, $2, 0, 'zz soap', 12, 5.97, 5.97, 1, 2, 'individual') RETURNING id`, [po, pa])).rows[0].id as string;
    return { po, pa, line };
  };
  await q(`INSERT INTO asins (asin, title) VALUES ('B0ZZEML00A', 'zz email test') ON CONFLICT DO NOTHING`);
  return { a: await mk("zz-test.com", "ZZ4471188", "2026-11-01"), b: await mk("zz-test.com", "ZZ4471199", "2026-11-03"), t: await mk("target.com", "102003897221188", "2026-11-05") };
}
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id IN ('ZZ4471188', 'ZZ4471199', '102003897221188')`)).rows[0].n).toBe(0);
}
const ctxOf = async (q: Q, emails: ClaimEmail[] = []): Promise<MatchContext> => ({ ...(await loadMatchContext(q)), threadPo: new Map() });
const planOf = async (q: Q, name: string) => { const e = fx(name); return { e, p: planClaimEmail(e, classifyClaimEmail(e), await ctxOf(q)) }; };
const row = async (q: Q, id: number) => (await loadClaimsPage(q, {}, NOW)).find((r) => r.id === id)!;
const TABLE: string[] = ["| Row | Email | Claim after the email (bucket · group · Step · Do) | Maria presses | Then |", "|---|---|---|---|---|"];
const md = (s: string) => s.replace(/\|/g, "\\|");
const line = (row: string, email: string, r: any, press: string, then: string) => TABLE.push(`| ${row} | ${md(email)} | ${r.bucket}${r.group ? ` › ${r.group}` : ""} · ${md(r.sentence)} · ${r.action.label}${r.action.secondary ? ` / ${r.action.secondary}` : ""} | ${press} | ${md(then)} |`);
afterAll(async () => {
  console.log("\n" + TABLE.join("\n") + "\n");
  if (process.env.CLAIM_EMAILS_TABLE) (await import("node:fs")).writeFileSync(process.env.CLAIM_EMAILS_TABLE, TABLE.join("\n") + "\n");
});

describe("§3.11 rows, end to end (real schema, rolled back)", () => {
  it("row 1: an exact refund email confirms the open claim by itself — Waiting on refund to post, the refund row prefilled, 'from email'; the same email again does nothing; Refund received (Maria's tick) closes it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "missing", qty: 1 }, null);
      const { e, p } = await planOf(q, "row1-walmart-refund");
      expect(p.row).toBe(1);
      const a = await applyEmailPlan(q, e, p);
      expect(a).toMatchObject({ row: 1, claim_id: id });
      const [c] = await loadClaims(q, { ids: [id] });
      expect(c).toMatchObject({ status: "open", outcome: "refund_card", outcome_amount: 5.97, outcome_detail: "card ••6830 · from email", email_confirmed: true });
      expect(c.supplier_confirmed_at?.slice(0, 10)).toBe("2026-11-12");
      expect(c.tasks.filter((t) => !t.done_at).map((t) => t.kind)).toContain("refund_received"); // (the report prompt is moot once the supplier confirmed — effectiveTasks)
      const r = await row(q, id);
      expect(r).toMatchObject({ bucket: "waiting_refund", sentence: "Supplier confirmed $5.97 refund 11/12 · from email · waiting for it to post", action: { kind: "refund", label: "Refund received" } });
      const ev = (await loadClaimEvents(q, id)).find((x) => x.type === "supplier_confirmed")!;
      expect(ev).toMatchObject({ gmail_message_id: "fx-row1-walmart-refund", mailbox: "orders@coastalqualitygoods.com", summary: `$5.97 · "You're getting a $5.97 refund: [zz soap, 2 Count]" · order # and amount match` });
      expect(r.next[0].text).toContain("AF moved it here when the refund email matched");
      // the duplicate: nothing changes
      expect((await applyEmailPlan(q, e, p)).row).toBe("seen");
      expect((await loadClaimEvents(q, id)).filter((x) => x.gmail_message_id).length).toBe(1);
      line("1", `"${e.subject}"`, r, "Refund received", "closed, refund $5.97 applied");
      await addRefundReceived(q, id, { amount: 5.97, method: "card", refunded_at: "2026-11-14" }, null);
      expect((await loadClaims(q, { ids: [id] }))[0]).toMatchObject({ status: "closed", remaining: 0 });
    });
  });
  it("row 1 on a SUGGESTED claim (Maria 2026-11-13): the suggestion opens — 'Opened from the supplier's refund email' — then row 1 applies", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "missing", qty: 1, status: "suggested" } as any, null);
      expect((await loadClaims(q, { ids: [id] }))[0].status).toBe("suggested");
      const { e, p } = await planOf(q, "row1-walmart-refund");
      expect(p).toMatchObject({ row: 1, claim: { id, status: "suggested" } });
      await applyEmailPlan(q, e, p);
      const [c] = await loadClaims(q, { ids: [id] });
      expect(c).toMatchObject({ status: "open", outcome: "refund_card", email_confirmed: true });
      expect(c.tasks.filter((t) => !t.done_at).map((t) => t.kind)).toContain("refund_received");
      expect((await loadClaimEvents(q, id)).map((x) => [x.type, x.summary]).slice(0, 2)).toEqual([["found", expect.any(String)], ["opened", "Opened from the supplier's refund email"]]);
      line("1 (suggested)", `"${e.subject}"`, await row(q, id), "—", "opened and confirmed by the email");
    });
  });
  it("row 2: Target's 'order ending in 1188' → Needs attention › Decide 'Email 11/12 may be this claim's refund…' · Attach / Not this claim; Attach applies row 1; Not this claim leaves the email off this claim for good", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.t.po, { po_line_item_id: s.t.line, kind: "damaged", qty: 2, amount_owed: 19.98 }, null);
      const { e, p } = await planOf(q, "row2-target-last4");
      expect(p).toMatchObject({ row: 2, claim: { id } });
      await applyEmailPlan(q, e, p);
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "decide", sentence: `Email 11/12 may be this claim's refund: "We've refunded your order ending in 1188" · $19.98`, action: { label: "Attach", secondary: "not_this", decision: "attach", email: { id: "fx-row2-target-last4" } } });
      const task = r.tasks.find((t) => t.kind === "review_email_match" && !t.done_at)!;
      expect(task.payload).toMatchObject({ kind: "refund", amount: 19.98 });
      line("2", `"${e.subject}"`, r, "Attach", "confirmed $19.98 refund, Waiting on refund to post");
      await doneTask(q, task.id, null, { decision: "attach" });
      r = await row(q, id);
      expect(r).toMatchObject({ bucket: "waiting_refund", outcome: "refund_card", outcome_amount: 19.98, email_confirmed: true });
      expect((await loadClaimEvents(q, id)).some((x) => x.type === "email_review")).toBe(false);
    });
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.t.po, { po_line_item_id: s.t.line, kind: "damaged", qty: 2, amount_owed: 19.98 }, null);
      const { e, p } = await planOf(q, "row2-target-last4");
      await applyEmailPlan(q, e, p);
      const task = (await row(q, id)).tasks.find((t) => t.kind === "review_email_match" && !t.done_at)!;
      await doneTask(q, task.id, null, { decision: "not_this" });
      const r = await row(q, id);
      expect(r.bucket).toBe("needs_attention"); // back to the report prompt — nothing was set
      expect(r.outcome).toBeNull();
      expect((await loadClaimEvents(q, id)).map((x) => x.type)).toContain("email_dismissed");
      const again = planClaimEmail(e, classifyClaimEmail(e), await ctxOf(q));
      expect(again.row).toBe("noise"); // never proposed to this claim again
      line("2 (not this)", `"${e.subject}"`, r, "Not this claim", "email dismissed for this claim; never proposed to it again");
    });
  });
  it("row 3: a reply with no outcome → Needs attention › Supplier 'Supplier replied 11/12: …' · Keep waiting / Set outcome; Keep waiting → Waiting on supplier with the timer from the reply's date", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "missing", qty: 1 }, null);
      await doneTask(q, (await loadClaims(q, { ids: [id] }))[0].tasks[0].id, null, { date: "2026-11-11", channel: "email" });
      const { e, p: p0 } = await planOf(q, "row3-reply-no-outcome");
      expect(p0).toMatchObject({ row: 3, claim: { id }, needsAi: true });
      const p = applyAiReply(p0, aiOf("ai-reply-none"));
      await applyEmailPlan(q, e, p);
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "supplier", sentence: `Supplier replied 11/12: "We have opened case 08841127 and will get back to you."`, action: { label: "Keep waiting", secondary: "set_outcome", decision: "keep" }, last_supplier_reply_at: expect.stringContaining("2026-11-12"), email_replied: true });
      const ev = (await loadClaimEvents(q, id)).find((x) => x.type === "supplier_reply")!;
      expect(ev.gmail_message_id).toBe("fx-row3-reply-no-outcome");
      line("3", `"${e.subject}"`, r, "Keep waiting", "Waiting on supplier, timer from 11/12");
      const task = r.tasks.find((t) => t.kind === "read_reply" && !t.done_at)!;
      await doneTask(q, task.id, null, { decision: "keep" } as any);
      r = await row(q, id);
      expect(r).toMatchObject({ bucket: "waiting_supplier" });
      expect(r.bucket_since?.slice(0, 10)).toBe("2026-11-12");
      expect(r.tasks.find((t) => t.id === task.id)!.done_at?.slice(0, 10)).toBe("2026-11-12");
    });
  });
  it("row 4: a reply that states an outcome → Needs attention › Decide 'Supplier replied 11/12: … → replacement?' · Confirm outcome; Set outcome replacement ticks it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "missing", qty: 1 }, null);
      await doneTask(q, (await loadClaims(q, { ids: [id] }))[0].tasks[0].id, null, { date: "2026-11-11", channel: "email" });
      const { e, p } = await planOf(q, "row4-reply-replacement");
      expect(p).toMatchObject({ row: 4, outcome: "replacement" });
      await applyEmailPlan(q, e, p);
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "decide", sentence: `Supplier replied 11/12: "The remaining 1 unit ships out tomorrow as a replacement at no charge." → replacement?`, action: { label: "Confirm outcome", kind: "detail" } });
      expect(r.outcome).toBeNull(); // never set by itself
      line("4", `"${e.subject}"`, r, "Confirm outcome → replacement", "Waiting on supplier (replacement promised)");
      await setOutcome(q, id, { outcome: "replacement" }, null);
      r = await row(q, id);
      expect(r.tasks.filter((t) => !t.done_at).map((t) => t.kind)).toEqual(["tell_velocity_replacement", "replacement_arrived"].filter((k) => r.tasks.some((t) => t.kind === k && !t.done_at)));
      expect(r.outcome).toBe("replacement");
    });
  });
  it("row 5: a refund email on a PO with no claim → a suggested claim 'refund · from email', qty ?, Open claim / Dismiss; Open claim makes it a confirmed canceled claim waiting for the money", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      await seed(q);
      const { e, p } = await planOf(q, "row5-refund-no-claim");
      expect(p.row).toBe(5);
      const a = await applyEmailPlan(q, e, p);
      const id = a.claim_id!;
      let r = await row(q, id);
      expect(r).toMatchObject({ status: "suggested", kind: "canceled", found_by: "email", qty: null, amount_owed: 9.94, note: "refund · from email · refund card", bucket: "needs_attention", group: "decide", sentence: `"You're getting a $9.94 refund: [zz onion seasoning 7 oz]" 11/11 · no claim on this PO yet`, action: { label: "Open claim", secondary: "dismiss" } });
      line("5", `"${e.subject}"`, r, "Open claim", "open canceled claim, confirmed 11/11, Waiting on refund to post");
      await doneTask(q, r.tasks.find((t) => t.kind === "review_suggestion")!.id, null, { decision: "open" });
      await q(`UPDATE supplier_claims SET qty = 1 WHERE id = $1`, [id]); // Maria types the quantity (enter_quantity)
      await q(`UPDATE supplier_claim_tasks SET done_at = now() WHERE claim_id = $1 AND kind = 'enter_quantity'`, [id]);
      r = await row(q, id);
      expect(r).toMatchObject({ status: "open", bucket: "waiting_refund" });
      expect((await applyEmailPlan(q, e, p)).row).toBe("seen");
    });
  });
  it("row 6: a return label email → the PDF saved as a return_label document on the claim, 'Return label received · from email' on the timeline, no task", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "damaged", qty: 1, return_required: true } as any, null);
      const { e, p } = await planOf(q, "row6-return-label");
      expect(p).toMatchObject({ row: 6, claim: { id } });
      const saved: string[] = [];
      await applyEmailPlan(q, e, p, { attachment: async () => Buffer.from("%PDF-1.4 zz"), saveLabel: async (name, pdf) => { saved.push(name); return { id: "drive-zz", bytes: pdf.length }; } });
      expect(saved).toEqual(["2026-11-10_zz-test.com_ZZ4471188_return-label.pdf"]);
      const d = (await claimDetail(q, id, NOW))!;
      expect(d.linked.documents).toEqual([expect.objectContaining({ type: "return_label", file_name: "2026-11-10_zz-test.com_ZZ4471188_return-label.pdf", drive_file_id: "drive-zz" })]);
      const ev = d.events.find((x) => x.type === "label_saved")!;
      expect(ev).toMatchObject({ gmail_message_id: "fx-row6-return-label", summary: expect.stringContaining("Return label received · from email") });
      const r = await row(q, id);
      expect(r.tasks.filter((t) => !t.done_at).map((t) => t.kind)).toEqual(["contact_supplier"]); // nothing new to do
      line("6", `"${e.subject}"`, r, "nothing (commit 7 sends it)", "document return_label on the claim");
    });
  });
  it("row 7: an unknown sender naming an open claim's order # → the banner + a Decide row; Attach adds it as a supplier reply", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "missing", qty: 1 }, null);
      const { e, p } = await planOf(q, "row7-unknown-sender");
      expect(p).toMatchObject({ row: 7, claim: { id } });
      await applyEmailPlan(q, e, p);
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "decide", sentence: `An email may belong to this claim · 11/13 · random-mailer.example · "Your store credit" · $12.00`, action: { label: "Attach", secondary: "not_this" } });
      const banner = r.tasks.find((t) => t.kind === "review_email_match" && !t.done_at)!;
      expect(banner.payload).toMatchObject({ subject: "Your store credit", from: "random-mailer.example", amount: 12 });
      line("7", `"${e.subject}" (random-mailer.example)`, r, "Attach", "Supplier replied · from email (read_reply)");
      await doneTask(q, banner.id, null, { decision: "attach" });
      r = await row(q, id);
      expect((await loadClaimEvents(q, id)).find((x) => x.type === "supplier_reply")).toMatchObject({ gmail_message_id: "fx-row7-unknown-sender", summary: expect.stringContaining("attached by hand") });
      expect(r.outcome).toBeNull();
    });
  });
  it("row 8: an email on a CLOSED claim → Needs attention › Decide 'New email on a closed claim 11/13: …' · Reopen / Nothing to do; a feedback request attaches quietly; a dismissed claim behaves the same", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "never_received", qty: 1 }, null);
      await setOutcome(q, id, { outcome: "write_off", reason: "the supplier never answered" } as any, null);
      expect((await loadClaims(q, { ids: [id] }))[0].status).toBe("closed");
      const quiet = await planOf(q, "row8-feedback-quiet");
      expect(quiet.p).toMatchObject({ row: 8, quiet: true });
      await applyEmailPlan(q, quiet.e, quiet.p);
      let r = await row(q, id);
      expect(r.bucket).toBe("closed");
      expect((await loadClaimEvents(q, id)).find((x) => x.type === "email_attached")).toMatchObject({ gmail_message_id: "fx-row8-feedback-quiet" });
      line("8 (quiet)", `"${quiet.e.subject}"`, r, "—", "attached to the timeline, no task");
      const { e, p } = await planOf(q, "row8-closed-claim-refund-failed");
      expect(p).toMatchObject({ row: 8, quiet: false });
      await applyEmailPlan(q, e, p);
      r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "decide", sentence: `New email on a closed claim 11/13: "Re: Order ZZ4471188 — refund"`, action: { label: "Reopen", secondary: "nothing", decision: "reopen" } });
      line("8", `"${e.subject}"`, r, "Reopen", "open again; Nothing to do would leave it closed");
      await doneTask(q, r.tasks.find((t) => t.kind === "closed_claim_email" && !t.done_at)!.id, null, { decision: "reopen" });
      expect((await loadClaims(q, { ids: [id] }))[0].status).toBe("open");
    });
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "missing", qty: 1 }, null);
      await dismissClaim(q, id, null, "not worth it");
      const { e, p } = await planOf(q, "row8-closed-claim-refund-failed");
      expect(p).toMatchObject({ row: 8, claim: { status: "dismissed" } });
      await applyEmailPlan(q, e, p);
      const r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", action: { label: "Reopen", secondary: "nothing" } });
      await doneTask(q, r.tasks.find((t) => t.kind === "closed_claim_email" && !t.done_at)!.id, null, { decision: "nothing" });
      expect((await loadClaims(q, { ids: [id] }))[0].status).toBe("dismissed");
      expect((await loadClaimEvents(q, id)).map((x) => x.type)).toContain("email_dismissed");
      line("8 (dismissed)", `"${e.subject}"`, r, "Nothing to do", "stays dismissed; the email is noted");
    });
  });
  it("row 9: Maria's own email to the supplier about an order with one open claim → Contacted supplier · from email, the timer from that date; with no open claim nothing happens", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "missing", qty: 1 }, null);
      const { e, p } = await planOf(q, "row9-maria-to-supplier");
      expect(p).toMatchObject({ row: 9, claim: { id } });
      await applyEmailPlan(q, e, p);
      const r = await row(q, id);
      expect(r).toMatchObject({ bucket: "waiting_supplier", reported_at: "2026-11-11", reported_channel: "email" });
      expect(r.tasks.filter((t) => !t.done_at)).toEqual([]);
      const ev = (await loadClaimEvents(q, id)).find((x) => x.type === "reported")!;
      expect(ev).toMatchObject({ gmail_message_id: "fx-row9-maria-to-supplier", summary: expect.stringContaining("Order ZZ4471188 arrived with 1 unit missing") });
      expect(r.bucket_since?.slice(0, 10)).toBe("2026-11-11");
      line("9", `"${e.subject}" (sent)`, r, "—", "reported 11/11 by email, Waiting on supplier");
      // the same PO with no open claim: nothing
      await q(`UPDATE supplier_claims SET status = 'closed', closed_at = now() WHERE id = $1`, [id]);
      const again = planClaimEmail({ ...e, id: "fx-row9-again" }, classifyClaimEmail(e), await ctxOf(q));
      expect(again).toMatchObject({ row: "noise", label: "Maria's email, PO has no open claim" });
    });
  });
  it("two open claims on one PO: the refund attaches to the one whose amount it names; a reply becomes 'An email may belong to this claim' on the first (row 7), never both", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id: one } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "missing", qty: 1 }, null);
      const { id: two } = await addClaim(q, s.a.po, { kind: "damaged", qty: 2, amount_owed: 19.98 } as any, null);
      const refund = await planOf(q, "row1-walmart-refund");
      expect(refund.p).toMatchObject({ row: 1, claim: { id: one } });
      const reply = await planOf(q, "row3-reply-no-outcome");
      expect(reply.p).toMatchObject({ row: 7 });
      await applyEmailPlan(q, reply.e, reply.p);
      const rows = await loadClaimsPage(q, {}, NOW);
      expect(rows.filter((r) => [one, two].includes(r.id) && r.tasks.some((t) => t.kind === "review_email_match" && !t.done_at)).length).toBe(1);
      line("7 (two claims)", `"${reply.e.subject}"`, rows.find((r) => r.id === reply.p.claim!.id)!, "Attach / Not this claim", "one claim asked, never both");
    });
  });
});
