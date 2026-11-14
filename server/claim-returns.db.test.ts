// Returns (claims commit 7): the §3.12 acceptance table walked END TO END on the REAL local schema (migration 113), every test
// in a transaction that is ROLLED BACK — the email (a scrubbed fixture, server/__fixtures__/claim-emails/ret*.json) or the
// carrier event (a return tracker fixture, server/__fixtures__/easypost/tracker-return-*.json) in, then the Claims page row it
// makes (bucket, group, Step sentence, the Do button, the links), then what Maria does. No Gmail, no EasyPost, no Haiku, no
// Drive (a stub takes the label). The table the run prints is the report's. Skipped when no local Postgres answers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEmailPlan, classifyClaimEmail, planClaimEmail, loadMatchContext, type ClaimEmail, type MatchContext } from "./claim-emails";
import { addClaim, addRefundReceived, doneTask, editClaim, confirmSupplier, loadClaims, loadClaimEvents } from "./supplier-claims";
import { loadClaimsPage, claimDetail, sweepClaimTimers } from "./claim-buckets";
import { attachReturnLabel, applyReturnTracker, setReturnFacts, noLabel, sweepReturnByWarnings } from "./claim-returns";
import { applyCarrierUpdate, trackerUpdate, trackerAction, type EasypostTracker } from "./easypost";
import { claimSteps } from "@shared/claim-bucket";

const FX = join(__dirname, "__fixtures__");
const fx = (name: string): ClaimEmail => { const m = JSON.parse(readFileSync(join(FX, "claim-emails", `${name}.json`), "utf8")); return { ...m, date: new Date(m.date) }; };
const trk = (name: string, code?: string): EasypostTracker => { const t = JSON.parse(readFileSync(join(FX, "easypost", `${name}.json`), "utf8")); return code ? { ...t, tracking_code: code } : t; };
const NOW = new Date("2026-11-13T15:00:00Z"); // Fri Nov 13, 10:00 ET
const LABEL_STUB = { attachment: async () => Buffer.from("%PDF-1.4 zz"), saveLabel: async (_n: string, pdf: Buffer) => ({ id: "drive-zz", bytes: pdf.length }) };

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT return_by, return_shipped_source FROM supplier_claims LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });
type Q = (sql: string, params?: any[]) => Promise<any>;

/** A Velocity PO (ZZ4471188, 12 singles at $5.97) and a home PO (ZZ4471199), one supplier; the fixtures name them. */
async function seed(q: Q) {
  const mk = async (orderId: string, date: string, shipsTo: "velocity" | "home") => {
    const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, order_total, ships_to) VALUES ($1, $2, 'zz-test.com', 71.64, 71.64, $3) RETURNING id`, [orderId, date, shipsTo])).rows[0].id as string;
    const pa = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as, qty_basis) VALUES ($1, 'B0ZZEML00A', 12, 2, 'multi-pack', 'individual') RETURNING id`, [po])).rows[0].id as string;
    const line = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered, price, adjusted_product_cost, retailer_units_per_product, asin_units_per_pack, qty_basis)
                          VALUES ($1, $2, 0, 'zz soap', 12, 5.97, 5.97, 1, 2, 'individual') RETURNING id`, [po, pa])).rows[0].id as string;
    return { po, pa, line };
  };
  await q(`INSERT INTO asins (asin, title) VALUES ('B0ZZEML00A', 'zz email test') ON CONFLICT DO NOTHING`);
  return { a: await mk("ZZ4471188", "2026-11-01", "velocity"), b: await mk("ZZ4471199", "2026-11-03", "home") };
}
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id IN ('ZZ4471188', 'ZZ4471199')`)).rows[0].n).toBe(0);
}
const ctxOf = async (q: Q): Promise<MatchContext> => ({ ...(await loadMatchContext(q)), threadPo: new Map() });
const planOf = async (q: Q, name: string) => { const e = fx(name); return { e, p: planClaimEmail(e, classifyClaimEmail(e), await ctxOf(q)) }; };
const row = async (q: Q, id: number, now = NOW) => (await loadClaimsPage(q, {}, now)).find((r) => r.id === id)!;
const one = async (q: Q, id: number) => (await loadClaims(q, { ids: [id] }))[0];
const openKinds = (c: { tasks: Array<{ kind: string; done_at: string | null }> }) => c.tasks.filter((t) => !t.done_at).map((t) => t.kind);
/** The claim was reported to the supplier (a return follows the supplier's answer): the Contact supplier tick, dated. */
const reported = async (q: Q, id: number) => { const t = (await one(q, id)).tasks.find((x) => x.kind === "contact_supplier" && !x.done_at)!; await doneTask(q, t.id, null, { date: "2026-11-05", channel: "email" }); };
const steps = (c: any) => claimSteps(c).map((s) => `${s.done ? "✓" : s.current ? "●" : "○"} ${s.key}${s.source ? `(${s.source})` : ""}`).join(" · ");
/** The carrier's event as every EasyPost write applies it (register / webhook / sweep): the generic inbound write, then the return rows. */
const carrier = (q: Q, t: EasypostTracker) => applyCarrierUpdate(q, trackerUpdate(t), t);
const TABLE: string[] = ["| Row | What happens | Claim after (bucket · group · Step · Do) | Maria does | Then |", "|---|---|---|---|---|"];
const md = (s: string) => s.replace(/\|/g, "\\|");
const line = (n: string, what: string, r: any, does: string, then: string) => TABLE.push(`| ${n} | ${md(what)} | ${r.bucket}${r.group ? ` › ${r.group}` : ""} · ${md(r.sentence)} · ${r.action.label || "—"}${r.action.secondary ? ` / ${r.action.secondary}` : ""}${r.action.links?.label_doc_id ? " · label" : ""}${r.action.links?.copy_message ? " · copy message" : ""} | ${md(does)} | ${md(then)} |`);
afterAll(async () => {
  console.log("\n" + TABLE.join("\n") + "\n");
  if (process.env.CLAIM_RETURNS_TABLE) (await import("node:fs")).writeFileSync(process.env.CLAIM_RETURNS_TABLE, TABLE.join("\n") + "\n");
});

describe("§3.12 rows, end to end (real schema, rolled back)", () => {
  it("rows 1 · 4 · 5 · 8 · 6 · 8 · 7: a Velocity PO's return from the label email to the refund — the carrier moves it, the stalls become Check on it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "cant_sell", qty: 8, amount_owed: 5.97 }, null);
      await reported(q, id);
      // row 1: the label arrives by email (§3.11 row 6 saves it) — tracking #, carrier, return-by read; the return row; EasyPost registration; return_required
      const { e, p } = await planOf(q, "ret1-label-fedex");
      expect(p).toMatchObject({ row: 6, claim: { id }, ret: { kind: "label", carrier: "FEDEX", trackingNumber: "528889999001", returnBy: "2026-11-30" } });
      const a = await applyEmailPlan(q, e, p, LABEL_STUB);
      expect(a.what).toContain("return_label document 2026-11-10_zz-test.com_ZZ4471188_return-label.pdf");
      let c = await one(q, id);
      expect(c).toMatchObject({ return_required: true, return_by: "2026-11-30", return_by_source: "email", return_label_source: "email", return_no_label: false, return_tracking: { carrier: "FEDEX", tracking_number: "528889999001", carrier_status: null } });
      expect(c.return_label_doc_id).toBeTruthy();
      expect(openKinds(c)).toEqual(["send_label"]);
      const tr = (await q(`SELECT id, direction, claim_id, status, carrier, tracking_number, shipped_at::text AS shipped_at, delivered_at, easypost_tracker_id FROM po_tracking WHERE claim_id = $1`, [id])).rows;
      expect(tr).toHaveLength(1);
      expect(tr[0]).toMatchObject({ direction: "return", status: "matched", carrier: "FEDEX", tracking_number: "528889999001" });
      expect(trackerAction({ ...tr[0], id: Number(tr[0].id) }, NOW, "register")).toBe("register"); // the hourly pass registers it (is_return — easypost.test)
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "velocity", sentence: "Return label saved 11/10 · from email · send it to Velocity · return by 11/30",
        action: { kind: "task", label: "Sent label", links: { label_doc_id: c.return_label_doc_id, copy_message: "Please ship back 8 units of zz soap (B0ZZEML00A) from order ZZ4471188 using the attached label. It has to go out by 11/30/2026." } } });
      const ev = (await loadClaimEvents(q, id)).find((x) => x.type === "label_saved")!;
      expect(ev).toMatchObject({ gmail_message_id: "fx-ret1-label-fedex", po_document_id: c.return_label_doc_id, po_tracking_id: Number(tr[0].id), summary: expect.stringContaining("tracking FEDEX 528889999001 read from the email · return by 11/30") });
      line("1", "label email (Velocity PO)", r, "Sent label", "Waiting on Velocity");
      // the registration's answer (pre_transit) lands on the return row
      await carrier(q, trk("tracker-return-pre_transit"));
      expect((await one(q, id)).return_tracking).toMatchObject({ carrier_status: "pre_transit" });
      // row 4: Sent label (dated 11/12) → Waiting on Velocity, the first carrier scan awaited
      const send = c.tasks.find((t) => t.kind === "send_label" && !t.done_at)!;
      await doneTask(q, send.id, null, { date: "2026-11-12", channel: "Discord" });
      r = await row(q, id);
      expect(r).toMatchObject({ bucket: "waiting_velocity", sentence: "Label sent 11/12 · waiting for the first carrier scan", action: { kind: "none" }, bucket_since: "2026-11-12T12:00:00.000Z" });
      line("4", "Sent label ticked 11/12", r, "nothing", "the first scan → Shipped");
      // row 5: the carrier's first scan → Shipped, from tracking; Waiting on shipment
      await carrier(q, trk("tracker-return-in_transit"));
      c = await one(q, id);
      expect(c).toMatchObject({ return_shipped_source: "tracking", return_tracking: { carrier_status: "in_transit", last_scan_location: "Memphis, TN" } });
      expect(new Date(c.return_shipped_at!).toISOString()).toBe("2026-11-13T16:40:00.000Z");
      expect(steps(c)).toContain("✓ return_shipped(tracking) · ○ return_delivered");
      r = await row(q, id, new Date("2026-11-14T15:00:00Z"));
      expect(r).toMatchObject({ bucket: "waiting_shipment", sentence: "Return shipped 11/13 · FedEx in transit · due 11/17 · from tracking", action: { kind: "none" } });
      expect((await loadClaimEvents(q, id)).find((x) => x.type === "return_shipped")).toMatchObject({ summary: "FedExDefault 528889999001 picked up in Florence, SC · due 11/17 · from tracking", po_tracking_id: Number(tr[0].id) });
      line("5", "first carrier scan 11/13", r, "nothing", "delivered → Waiting on supplier");
      // the same event again changes nothing
      await carrier(q, trk("tracker-return-in_transit"));
      expect((await loadClaimEvents(q, id)).filter((x) => x.type === "return_shipped")).toHaveLength(1);
      // row 8: in transit, no scan in 5 business days (last scan Sat 11/14 → Fri 11/20) → Check on it with the reason
      const stall = new Date("2026-11-23T15:00:00Z");
      const made = await sweepClaimTimers(q, stall, null);
      expect(made.find((x) => x.claim_id === id)).toEqual({ claim_id: id, kind: "check_on_it", reason: "5 business days: return shipped 11/13 · no new carrier scan" });
      r = await row(q, id, stall);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "timed_out", sentence: "Return shipped 11/13 · no new carrier scan in 5 business days", action: { label: "Check on it", secondary: "snooze" } });
      line("8", "no new scan in 5 business days", r, "Check on it", "the timer restarts");
      await doneTask(q, (await one(q, id)).tasks.find((t) => t.kind === "check_on_it" && !t.done_at)!.id, null, {});
      expect((await row(q, id, stall)).bucket).toBe("waiting_shipment");
      // row 6: delivered → Delivered, from tracking; Waiting on supplier for the refund confirmation
      await carrier(q, trk("tracker-return-delivered-after-label"));
      c = await one(q, id);
      expect(c).toMatchObject({ return_delivered_source: "tracking", return_tracking: { carrier_status: "delivered" } });
      expect(new Date(c.return_delivered_at!).toISOString()).toBe("2026-11-17T14:02:00.000Z");
      r = await row(q, id, new Date("2026-11-18T15:00:00Z"));
      expect(r).toMatchObject({ bucket: "waiting_supplier", sentence: "Return delivered 11/17 · from tracking · waiting for the refund confirmation", action: { kind: "none" } });
      line("6", "carrier delivered 11/17", r, "nothing", "the refund email → Waiting on refund to post");
      // row 8 again: delivered and no refund confirmation in 5 business days → Check on it (never Follow up)
      const stall2 = new Date("2026-11-25T15:00:00Z");
      expect((await sweepClaimTimers(q, stall2, null)).find((x) => x.claim_id === id)).toEqual({ claim_id: id, kind: "check_on_it", reason: "5 business days: return delivered 11/17 · no refund confirmation" });
      r = await row(q, id, stall2);
      expect(r).toMatchObject({ group: "timed_out", sentence: "Return delivered 11/17 · no refund confirmation in 5 business days", action: { label: "Check on it" } });
      line("8", "delivered, no refund email in 5 business days", r, "Check on it", "—");
      await doneTask(q, (await one(q, id)).tasks.find((t) => t.kind === "check_on_it" && !t.done_at)!.id, null, {});
      // row 7: the refund email (§3.11 row 1) → Waiting on refund to post; Refund received closes it
      const refund = await planOf(q, "row1-walmart-refund");
      expect(refund.p).toMatchObject({ row: 1, claim: { id } });
      await applyEmailPlan(q, refund.e, refund.p);
      r = await row(q, id, stall2);
      expect(r).toMatchObject({ bucket: "waiting_refund", sentence: "Supplier confirmed $5.97 refund 11/12 · from email · waiting for it to post", action: { kind: "refund", label: "Refund received" } });
      line("7", "refund email", r, "Refund received", "Closed");
      await addRefundReceived(q, id, { amount: 5.97, method: "card", refunded_at: "2026-11-26" }, null);
      expect(await one(q, id)).toMatchObject({ status: "closed", remaining: 0 });
      const d = (await claimDetail(q, id, stall2))!;
      expect(d.linked.tracking).toEqual([expect.objectContaining({ direction: "return", tracking_number: "528889999001", carrier_status: "delivered", last_scan_location: "Bentonville, AR" })]);
    });
  });

  it("row 2: a home PO's label → Money and arrivals, 'ships from home · drop off by', Dropped off (dated) → Waiting on shipment", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.b.po, { po_line_item_id: s.b.line, kind: "wrong_item", qty: 2 }, null);
      await reported(q, id);
      const { e, p } = await planOf(q, "ret2-label-home");
      expect(p).toMatchObject({ row: 6, claim: { id }, ret: { returnBy: "2026-11-20", trackingNumber: "528889999002" } });
      expect(p.sets).toContain("drop_off_return");
      await applyEmailPlan(q, e, p, LABEL_STUB);
      let c = await one(q, id);
      expect(openKinds(c)).toEqual(["drop_off_return"]);
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "money", sentence: "Return label saved 11/12 · from email · ships from home · drop off by 11/20", action: { label: "Dropped off", links: { label_doc_id: c.return_label_doc_id, copy_message: null } } });
      expect(claimSteps(c).find((x) => x.key === "label_sent")?.label).toBe("Dropped off");
      line("2", "label email (home PO)", r, "Dropped off", "Waiting on shipment");
      await doneTask(q, c.tasks.find((t) => t.kind === "drop_off_return" && !t.done_at)!.id, null, { date: "2026-11-13" });
      r = await row(q, id, new Date("2026-11-14T15:00:00Z"));
      expect(r).toMatchObject({ bucket: "waiting_shipment", sentence: "Dropped off 11/13 · waiting for the first carrier scan", action: { kind: "none" } });
      expect((await loadClaimEvents(q, id)).find((x) => x.type === "task_done" && /^drop_off_return/.test(x.summary ?? ""))?.summary).toBe("drop_off_return: dropped off 11/13");
      line("2", "Dropped off ticked 11/13", r, "nothing", "the first scan → Shipped");
      // its stall is a Check on it with the home wording
      expect((await sweepClaimTimers(q, new Date("2026-11-23T15:00:00Z"), null)).find((x) => x.claim_id === id)?.reason).toBe("5 business days: dropped off 11/13 · no carrier scan");
    });
  });

  it("row 3: a return needed, no label → 'A return is needed · no label yet' (Upload label / No label); No label; an uploaded label with the tracking typed", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "expired", qty: 10, return_required: true }, null);
      await reported(q, id);
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "money", sentence: "A return is needed · no label yet", action: { kind: "detail", label: "Upload label", secondary: "no_label" } });
      line("3", "return needed, no label", r, "Upload label / No label", "send_label / drop_off_return");
      // No label (a store return): nothing to send — Velocity is told to ship it back; the Label step reads "No label"
      await noLabel(q, id, { note: "store return at the counter" }, null);
      let c = await one(q, id);
      expect(c).toMatchObject({ return_no_label: true, return_tracking: null });
      expect(openKinds(c)).toEqual(["send_label"]);
      expect(claimSteps(c).find((x) => x.key === "label")).toMatchObject({ label: "No label", done: true });
      r = await row(q, id);
      expect(r.sentence).toBe("No label · tell Velocity to ship it back");
      line("3", "No label", r, "Sent label", "Shipped / Delivered by hand (row 10)");
      // an uploaded label on another claim: the document, the tracking typed with it (source manual), the return-by typed
      const other = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "damaged", qty: 1, return_required: true }, null);
      await reported(q, other.id);
      const doc = (await q(`INSERT INTO po_documents (po_id, type, drive_file_id, file_name, bytes, document_at, source, claim_id) VALUES ($1, 'return_label', 'drive-zz-up', '2026-11-13_zz-test.com_ZZ4471188_return-label.pdf', 10, '2026-11-13T15:00:00Z', 'upload', $2) RETURNING id`, [s.a.po, other.id])).rows[0];
      await attachReturnLabel(q, other.id, { labelSource: "upload", labelAt: "2026-11-13T15:00:00Z", docId: Number(doc.id), carrier: "UPS", trackingNumber: "1Z999ZZ90312114001", returnBy: "2026-11-25", returnBySource: "manual", trackingSource: "manual" }, null);
      c = await one(q, other.id);
      expect(c).toMatchObject({ return_label_source: "upload", return_label_doc_id: Number(doc.id), return_by: "2026-11-25", return_by_source: "manual", return_tracking: { carrier: "UPS", tracking_number: "1Z999ZZ90312114001" } });
      expect(openKinds(c)).toEqual(["send_label"]);
      expect((await row(q, other.id)).sentence).toBe("Return label uploaded 11/13 · send it to Velocity · return by 11/25");
      expect((await q(`SELECT source FROM po_tracking WHERE claim_id = $1`, [other.id])).rows[0].source).toBe("manual");
    });
  });

  it("row 9: the return-by date 3 days away and not shipped → Check on it 'return by 11/30 · 3 days left', once per date; a typed date restarts it", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "cant_sell", qty: 8 }, null);
      await reported(q, id);
      const { e, p } = await planOf(q, "ret1-label-fedex");
      await applyEmailPlan(q, e, p, LABEL_STUB);
      expect(await sweepReturnByWarnings(q, new Date("2026-11-26T15:00:00Z"))).toEqual([]); // 4 days: not yet
      const at3 = new Date("2026-11-27T15:00:00Z");
      expect((await sweepClaimTimers(q, at3, null)).find((x) => x.claim_id === id)).toEqual({ claim_id: id, kind: "check_on_it", reason: "return by 11/30 · 3 days left" });
      const r = await row(q, id, at3);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "timed_out", sentence: "Return by 11/30 · 3 days left · label saved 11/10, not shipped yet", action: { label: "Check on it", secondary: "snooze" } });
      line("9", "return by 11/30, 3 days away, not shipped", r, "Check on it / chase Velocity", "—");
      expect((await sweepClaimTimers(q, new Date("2026-11-28T15:00:00Z"), null)).find((x) => x.claim_id === id)).toBeUndefined(); // once per date
      await doneTask(q, (await one(q, id)).tasks.find((t) => t.kind === "check_on_it" && !t.done_at)!.id, null, {});
      await setReturnFacts(q, id, { return_by: "2026-12-15" }, null);
      expect(await one(q, id)).toMatchObject({ return_by: "2026-12-15", return_by_source: "manual" });
      expect((await sweepClaimTimers(q, new Date("2026-11-28T15:00:00Z"), null)).find((x) => x.claim_id === id)).toBeUndefined();
      expect((await sweepReturnByWarnings(q, new Date("2026-12-13T15:00:00Z"))).find((x) => x.claim_id === id)?.reason).toBe("return by 12/15 · 2 days left");
      // a later label email never overwrites the typed date
      const again = await planOf(q, "ret2-label-home");
      expect(again.p.row).not.toBe(6); // (it names the home PO) — the rule itself:
      await attachReturnLabel(q, id, { labelSource: "email", labelAt: "2026-11-14T12:00:00Z", returnBy: "2026-11-21", returnBySource: "email" }, null);
      expect((await one(q, id)).return_by).toBe("2026-12-15");
    });
  });

  it("row 10: no tracking yet — a Walmart pickup confirmation → Shipped from email (the first scan corrects it), 'We received your return' → Delivered from email; Steps show the source", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "damaged", qty: 1, return_required: true }, null);
      await reported(q, id);
      const pickup = await planOf(q, "ret10-pickup");
      expect(pickup.p).toMatchObject({ row: 6, claim: { id }, ret: { kind: "pickup", pickupDate: "2026-11-12", trackingNumber: "798199999003" } });
      await applyEmailPlan(q, pickup.e, pickup.p, LABEL_STUB);
      let c = await one(q, id);
      expect(c).toMatchObject({ return_shipped_source: "email", return_required: true, return_tracking: { tracking_number: "798199999003" } });
      expect(new Date(c.return_shipped_at!).toISOString()).toBe("2026-11-12T12:00:00.000Z");
      expect(openKinds(c)).toEqual([]); // a scheduled pickup needs no Sent label
      expect(steps(c)).toContain("✓ label(email) · ✓ label_sent · ✓ return_shipped(email) · ○ return_delivered");
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "waiting_shipment", sentence: "Return shipped 11/12 · from email" });
      line("10", "pickup confirmation email (pickup 11/12)", r, "nothing", "the scan corrects the date; received email → Delivered");
      // the carrier's first scan wins over the email's date
      await carrier(q, trk("tracker-return-in_transit", "798199999003"));
      c = await one(q, id);
      expect(c.return_shipped_source).toBe("tracking");
      expect(new Date(c.return_shipped_at!).toISOString()).toBe("2026-11-13T16:40:00.000Z");
      // "We received your return" → Delivered, from email (no delivery scan yet)
      const got = await planOf(q, "ret10-received");
      expect(got.p).toMatchObject({ row: 6, claim: { id }, ret: { kind: "received" } });
      await applyEmailPlan(q, got.e, got.p);
      c = await one(q, id);
      expect(c.return_delivered_source).toBe("email");
      expect(steps(c)).toContain("✓ return_shipped(tracking) · ✓ return_delivered(email) · ○ confirmed");
      r = await row(q, id, new Date("2026-11-17T15:00:00Z"));
      expect(r.sentence).toBe("Return delivered 11/16 · from email · waiting for the refund confirmation");
      line("10", "'We received your return' email", r, "nothing", "Waiting on supplier");
      // the store return (no label, no tracking): return_by read, No label, Velocity told
      const st = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "expired", qty: 2 }, null);
      await reported(q, st.id);
      const store = await planOf(q, "ret3-store-no-label");
      expect(store.p).toMatchObject({ row: 6, ret: { kind: "store", storeReturn: true, returnBy: "2026-11-20" } });
      expect(store.p.claim?.id).toBe(id); // the PO's claim already on a return path comes first
      await editClaim(q, id, { return_required: false }, null); // (row 11 below) — so the store email lands on the other claim
      const store2 = await planOf(q, "ret3-store-no-label");
      expect(store2.p.claim?.id).toBe(st.id);
      await applyEmailPlan(q, store2.e, store2.p);
      expect(await one(q, st.id)).toMatchObject({ return_required: true, return_no_label: true, return_by: "2026-11-20", return_tracking: null });
      expect((await row(q, st.id)).sentence).toBe("No label · tell Velocity to ship it back · return by 11/20");
      // the pickup reminder fills a blank return-by date, quietly
      const rem = await planOf(q, "ret-reminder");
      expect(rem.p).toMatchObject({ row: 6, claim: { id: st.id }, ret: { kind: "reminder", returnBy: "2026-12-10" } });
      expect((await applyEmailPlan(q, rem.e, rem.p)).what).toContain("pickup reminder attached");
      expect((await one(q, st.id)).return_by).toBe("2026-12-10"); // a later email's date replaces an earlier email's; only a typed date stands
    });
  });

  it("row 11: the supplier says keep it — return_required off: the return steps, the Return card and its open tasks go; nothing else changes", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "cant_sell", qty: 8 }, null);
      await reported(q, id);
      const { e, p } = await planOf(q, "ret1-label-fedex");
      await applyEmailPlan(q, e, p, LABEL_STUB);
      expect(openKinds(await one(q, id))).toEqual(["send_label"]);
      await editClaim(q, id, { return_required: false }, null);
      const c = await one(q, id);
      expect(c.return_required).toBe(false);
      expect(openKinds(c)).toEqual([]);
      expect(claimSteps(c).map((x) => x.key)).toEqual(["found", "reported", "answered", "confirmed", "received", "closed"]);
      expect(c.return_label_doc_id).toBeTruthy(); // the document stays on the claim
      const r = await row(q, id);
      expect(r.sentence).toBe("Reported 11/5 by email · no answer yet");
      line("11", "return_required off", r, "nothing", "the usual path; dispose_units as today on a write-off");
      // back on: Upload label waits again (the label is still there — no new task)
      await editClaim(q, id, { return_required: true }, null);
      expect(openKinds(await one(q, id))).toEqual([]);
      expect(claimSteps(await one(q, id)).find((x) => x.key === "label")).toMatchObject({ done: true });
    });
  });

  it("row 12: a claim the temporary auto-tick ticked keeps its dates, labeled 'set at confirmation, before tracking'; nothing re-opens", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      // as the claims stood before commit 7: no Upload label task (noTask), the confirmation stands for the report
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "damaged", qty: 1, return_required: true }, null, { noTask: true });
      await confirmSupplier(q, id, { at: "2026-11-09", outcome: "refund_card" }, null);
      // migration 113's row-12 statement, as applied
      const sql = readFileSync(join(__dirname, "..", "database", "migrations", "113_claim_returns.sql"), "utf8").split("\n").filter((l) => !l.startsWith("--")).join("\n");
      const stmt = sql.slice(sql.indexOf("UPDATE supplier_claims\n   SET return_shipped_at"));
      expect(stmt).toContain("return_shipped_source = 'confirmation'");
      await q(stmt.replace(/;\s*$/, "").replace("WHERE return_required", `WHERE id = ${id} AND return_required`));
      const c = await one(q, id);
      expect(c).toMatchObject({ return_shipped_source: "confirmation", return_delivered_source: "confirmation" });
      expect(steps(c)).toContain("✓ return_shipped(confirmation) · ✓ return_delivered(confirmation) · ✓ confirmed · ○ received");
      const r = await row(q, id);
      expect(r).toMatchObject({ bucket: "waiting_refund", sentence: "Refund confirmed 11/9 · check the card", action: { label: "Refund received" } });
      line("12", "a claim ticked by the commit-2b auto-tick", r, "nothing", "no change");
      // the carrier never overrides those either? it does not: 'confirmation' is not 'manual' — a real scan after the label corrects a guessed date (the label date is the tick)
    });
  });

  it("extra: a return that reuses the inbound tracking number — two rows, the inbound leg's scans and delivery never count, the November pickup does", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      await q(`INSERT INTO po_tracking (po_id, carrier, tracking_number, status, source, shipped_at, delivered_at, carrier_status, easypost_tracker_id, easypost_registered_at, gmail_message_id) VALUES ($1, 'UPS', '1Z999ZZ90312114999', 'pushed', 'regex', '2026-10-01T12:00:00Z', '2026-10-04T15:30:00Z', 'delivered', 'trk_zzreuse0002', '2026-10-02T00:00:00Z', 'zz-inbound-msg')`, [s.a.po]);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "damaged", qty: 2, return_required: true }, null);
      await reported(q, id);
      await attachReturnLabel(q, id, { labelSource: "none", labelAt: "2026-11-11T12:00:00Z", carrier: "UPS", trackingNumber: "1Z999ZZ90312114999", trackingSource: "manual" }, null);
      const rows = (await q(`SELECT direction, claim_id, status, delivered_at::text AS delivered_at FROM po_tracking WHERE tracking_number = '1Z999ZZ90312114999' ORDER BY id`)).rows;
      expect(rows.map((x: any) => [x.direction, x.claim_id == null ? null : Number(x.claim_id)])).toEqual([["inbound", null], ["return", id]]);
      // EasyPost answers the inbound tracker (§3.9): the return row stays pre_transit, the inbound row keeps its October delivery, the claim is not shipped
      await carrier(q, trk("tracker-reuse-inbound"));
      let c = await one(q, id);
      expect(c.return_shipped_at).toBeNull();
      expect(c.return_tracking).toMatchObject({ carrier_status: "pre_transit", delivered_at: null });
      expect((await q(`SELECT delivered_at::text AS d FROM po_tracking WHERE tracking_number = '1Z999ZZ90312114999' AND direction = 'inbound'`)).rows[0].d).toContain("2026-10-04");
      // the return leg moves
      await carrier(q, trk("tracker-reuse-return-moved"));
      c = await one(q, id);
      expect(new Date(c.return_shipped_at!).toISOString()).toBe("2026-11-12T18:00:00.000Z");
      expect(c.return_shipped_source).toBe("tracking");
      expect((await row(q, id)).sentence).toBe("Return shipped 11/12 · UPS in transit · due 11/16 · from tracking");
      line("extra", "a return reusing the inbound number", await row(q, id), "nothing", "only scans after the label count");
    });
  });

  it("extra: a hand-set Shipped date is never overwritten by a scan; a hand-set tracking # makes the return row; Delivered by hand", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "cant_sell", qty: 8 }, null);
      await reported(q, id);
      const { e, p } = await planOf(q, "ret1-label-fedex");
      await applyEmailPlan(q, e, p, LABEL_STUB);
      await setReturnFacts(q, id, { shipped_at: "2026-11-12" }, null);
      let c = await one(q, id);
      expect(c.return_shipped_source).toBe("manual");
      expect(openKinds(c)).toEqual([]); // Sent label is implied by a shipped date
      await carrier(q, trk("tracker-return-in_transit"));
      c = await one(q, id);
      expect(c.return_shipped_source).toBe("manual");
      expect(new Date(c.return_shipped_at!).toISOString()).toBe("2026-11-12T12:00:00.000Z");
      expect(steps(c)).toContain("✓ return_shipped(manual)");
      expect((await row(q, id, new Date("2026-11-14T15:00:00Z"))).sentence).toBe("Return shipped 11/12 · FedEx in transit · due 11/17");
      // Delivered by hand, then the carrier's delivery: the hand-set date stands
      await setReturnFacts(q, id, { delivered_at: "2026-11-16" }, null);
      await carrier(q, trk("tracker-return-delivered-after-label"));
      c = await one(q, id);
      expect(c.return_delivered_source).toBe("manual");
      expect(new Date(c.return_delivered_at!).toISOString()).toBe("2026-11-16T12:00:00.000Z");
      line("extra", "Shipped set by hand 11/12, then a scan 11/13", await row(q, id, new Date("2026-11-17T15:00:00Z")), "—", "the hand-set date stands");
      // a carrier exception on another claim → Check on it with the reason
      const ex = await addClaim(q, s.b.po, { po_line_item_id: s.b.line, kind: "damaged", qty: 1, return_required: true }, null);
      await reported(q, ex.id);
      // No label, the tracking typed by hand (row 3), dropped off 11/11
      await noLabel(q, ex.id, { carrier: "FEDEX", tracking_number: "528889999777" }, null);
      await setReturnFacts(q, ex.id, { sent_at: "2026-11-11" }, null);
      await q(`UPDATE po_tracking SET shipped_at = '2026-11-10T12:00:00Z' WHERE claim_id = $1`, [ex.id]);
      await carrier(q, trk("tracker-return-exception", "528889999777"));
      const r = await row(q, ex.id, new Date("2026-11-16T15:00:00Z"));
      expect(r).toMatchObject({ bucket: "needs_attention", group: "timed_out", sentence: "Carrier reports returned to sender on the return · FedExDefault 528889999777", action: { label: "Check on it" } });
      line("8", "the carrier reports an exception", r, "Check on it", "—");
    });
  });

  it("extra: the return-by date already past when the label arrives → the warning at once, 'N days overdue'", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.a.po, { po_line_item_id: s.a.line, kind: "cant_sell", qty: 8 }, null);
      await reported(q, id);
      const { e, p } = await planOf(q, "ret1-label-fedex");
      await applyEmailPlan(q, e, p, LABEL_STUB);
      const late = new Date("2026-12-02T15:00:00Z");
      expect((await sweepClaimTimers(q, late, null)).find((x) => x.claim_id === id)).toEqual({ claim_id: id, kind: "check_on_it", reason: "return by 11/30 · 2 days overdue" });
      const r = await row(q, id, late);
      expect(r.sentence).toBe("Return by 11/30 · 2 days overdue · label saved 11/10, not shipped yet");
      line("9", "return-by date already past", r, "Check on it", "—");
    });
  });
});
