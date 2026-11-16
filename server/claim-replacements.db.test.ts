// Replacements + dismiss with note (claims commit 8): §3.13's two acceptance tables walked END TO END on the REAL local schema
// (migration 114), every test in a transaction that is ROLLED BACK — the event in (a promise, a shipping email the ingest parked,
// a carrier scan from a recorded tracker fixture, Velocity's count), then the Claims page row (bucket · group · Step · Do · links),
// then what Maria does. Plus the nine places a replacement order # shows, the Upload plan / push rules, and the dismissals'
// return / undo. No Velocity, no EasyPost, no Gmail: fixtures and fakes only. Skipped when no local Postgres answers.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { addClaim, doneTask, setOutcome, loadClaims, loadClaimEvents, recordReply } from "./supplier-claims";
import { loadClaimsPage, claimDetail, sweepClaimTimers } from "./claim-buckets";
import { sweepReplacements, applyReplacementTracker, itemsMatchProduct } from "./claim-replacements";
import { addOtherNumber, listOtherNumbers, otherNumberText, syncOtherNumbersFromText } from "./po-other-numbers";
import { dismissWarning, undoDismissal, listDismissals } from "./po-warning-dismiss";
import { PO_ACTION_ITEMS_SQL, PO_CLOSE_ACTION_ITEMS_SQL } from "./po-action-items";
import { EXTRA_UNITS_SHIPPED, PACK_SIZE_MISMATCH, RECEIVING_MISMATCH, REVIEW_VELOCITY, DISMISSABLE_WARNINGS, AUTO_ACTION_ITEMS } from "./po-status-map";
import { evaluateAutoClose } from "./po-close";
import { applyCarrierUpdate, trackerUpdate, type EasypostTracker } from "./easypost";
import { pushTracking, type VelocityDeps } from "./tracking-push";
import { loadAfPoRows } from "./po-af-source";
import { searchOtherSql } from "./po-list-filters";
import { syncVelocityAfterOrderIdRename } from "./po-rename-velocity";
import { claimSteps } from "@shared/claim-bucket";
import { replacementMessage } from "@shared/claim-ui";

const FX = join(__dirname, "__fixtures__", "easypost");
const trk = (name: string, code: string): EasypostTracker => ({ ...JSON.parse(readFileSync(join(FX, `${name}.json`), "utf8")), tracking_code: code, id: `trk_zz_${code}` });
const NOW = new Date("2026-11-13T15:00:00Z"); // Fri Nov 13, 10:00 ET

const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT replacement_delivered_at FROM supplier_claims LIMIT 0"); await c.query("SELECT 1 FROM po_other_numbers LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });
type Q = (sql: string, params?: any[]) => Promise<any>;

/** A Velocity PO (ZZ5471188, 12 singles at $5.97, Velocity order #6778 linked) and a home PO (ZZ5471199), one supplier zz-test.com. */
async function seed(q: Q) {
  const mk = async (orderId: string, date: string, shipsTo: "velocity" | "home") => {
    const po = (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, subtotal, order_total, ships_to) VALUES ($1, $2, 'zz-test.com', 71.64, 71.64, $3) RETURNING id`, [orderId, date, shipsTo])).rows[0].id as string;
    const pa = (await q(`INSERT INTO po_asins (po_id, asin, qty, units_per_pack, sold_as, qty_basis) VALUES ($1, 'B0ZZEML00A', 12, 1, 'multi-pack', 'individual') RETURNING id`, [po])).rows[0].id as string;
    const line = (await q(`INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, qty_ordered, price, adjusted_product_cost, retailer_units_per_product, asin_units_per_pack, qty_basis)
                          VALUES ($1, $2, 0, 'zz soap, 2 Count', 12, 5.97, 5.97, 1, 1, 'individual') RETURNING id`, [po, pa])).rows[0].id as string;
    return { po, pa, line };
  };
  await q(`INSERT INTO asins (asin, title) VALUES ('B0ZZEML00A', 'zz email test') ON CONFLICT DO NOTHING`);
  const v = await mk("ZZ5471188", "2026-10-14", "velocity"), h = await mk("ZZ5471199", "2026-11-01", "home");
  await q(`INSERT INTO velocity_order_links (velocity_order_id, po_asin_id, source) VALUES ('6778', $1, 'manual') ON CONFLICT DO NOTHING`, [v.pa]).catch(async () => q(`INSERT INTO velocity_order_links (velocity_order_id, po_asin_id) VALUES ('6778', $1)`, [v.pa]));
  return { v, h };
}
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE order_id IN ('ZZ5471188', 'ZZ5471199', 'ZZ5471188-NEW')`)).rows[0].n).toBe(0);
}
const row = async (q: Q, id: number, now = NOW) => (await loadClaimsPage(q, {}, now)).find((r) => r.id === id)!;
const one = async (q: Q, id: number) => (await loadClaims(q, { ids: [id] }))[0];
const openKinds = (c: { tasks: Array<{ kind: string; done_at: string | null }> }) => c.tasks.filter((t) => !t.done_at).map((t) => t.kind).sort();
const steps = (c: any) => claimSteps(c).map((s) => `${s.done ? "✓" : s.current ? "●" : "○"} ${s.key}${s.source ? `(${s.source})` : ""}`).join(" · ");
const reported = async (q: Q, id: number) => { const t = (await one(q, id)).tasks.find((x) => x.kind === "contact_supplier" && !x.done_at)!; await doneTask(q, t.id, null, { date: "2026-11-04", channel: "email" }); };
/** The supplier's reply promising a replacement, then Maria confirms it (the outcome) — the promise is 11/5. */
const promised = async (q: Q, id: number) => {
  await recordReply(q, id, { date: "2026-11-05", channel: "email", summary: "the remaining units ship out tomorrow" }, null, { task: "confirm_outcome", suggestedOutcome: "replacement" });
  await setOutcome(q, id, { outcome: "replacement" }, null);
  // Maria confirmed the outcome the day of the reply (the real clock would stamp the tick today)
  await q(`UPDATE supplier_claim_tasks SET done_at = '2026-11-05T14:00:00Z' WHERE claim_id = $1 AND kind = 'confirm_outcome'`, [id]);
};
const carrier = (q: Q, t: EasypostTracker) => applyCarrierUpdate(q, trackerUpdate(t), t);
// Check on it ticked AT the sweep's instant: a plain tick is stamped now(), and the timer restarts from the latest tick, so a
// tick on the real clock drifted past the fixed "5 business days" dates below once the calendar caught up (2026-11-16).
const checked = async (q: Q, id: number, at: Date) => { const t = (await one(q, id)).tasks.find((x) => x.kind === "check_on_it" && !x.done_at)!; await doneTask(q, t.id, null, {}); await q(`UPDATE supplier_claim_tasks SET done_at = $2::timestamptz WHERE id = $1`, [t.id, at.toISOString()]); };
const ship = async (q: Q, poId: string, number: string, shippedAt: string, opts: { retailer?: string; pushed?: string[]; gmail?: string } = {}) =>
  Number((await q(`INSERT INTO po_tracking (po_id, carrier, tracking_number, retailer_order_id, shipped_at, gmail_message_id, source, status, pushed_at, pushed_velocity_ids) VALUES ($1, 'UPS', $2, $3, $4, $5, 'regex', $6, $7, $8) RETURNING id`,
    [poId, number, opts.retailer ?? null, shippedAt, opts.gmail ?? `zz-mail-${number}`, opts.pushed ? "pushed" : "matched", opts.pushed ? shippedAt : null, opts.pushed ?? null])).rows[0].id);
const TABLE: string[] = ["| Row | What happens | Claim after (bucket · group · Step · Do) | Maria does | Then |", "|---|---|---|---|---|"];
const md = (s: string) => s.replace(/\|/g, "\\|");
const line = (n: string, what: string, r: any, does: string, then: string) => TABLE.push(`| ${n} | ${md(what)} | ${r.bucket}${r.group ? ` › ${r.group}` : ""} · ${md(r.sentence)} · ${r.action.label || "—"}${r.action.secondary ? ` / ${r.action.secondary}` : ""}${r.action.links?.copy_message ? " · copy message" : ""} | ${md(does)} | ${md(then)} |`);
afterAll(async () => {
  console.log("\n" + TABLE.join("\n") + "\n");
  if (process.env.CLAIM_REPLACEMENTS_TABLE) (await import("node:fs")).writeFileSync(process.env.CLAIM_REPLACEMENTS_TABLE, TABLE.join("\n") + "\n");
});

describe("§3.13 replacements, end to end (real schema, rolled back)", () => {
  it("rows 1 · 3 · 5 · 7: a Velocity PO — promised → Tell Velocity (+ the message); the PO's new tracking is tied and ticks Shipped; the carrier's scans; Velocity's count closes it; the stalls", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.v.po, { po_line_item_id: s.v.line, kind: "missing", qty: 11 }, null);
      await reported(q, id); await promised(q, id);
      // row 1: Needs attention › Velocity with the message; the units stay expected (§3.6)
      let c = await one(q, id);
      expect(openKinds(c)).toEqual(["replacement_arrived", "tell_velocity_replacement"]);
      expect(steps(c)).toBe("✓ found · ✓ reported · ✓ answered · ● tell_velocity · ○ shipped · ○ arrived · ○ closed");
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "needs_attention", group: "velocity", sentence: "Replacement promised 11/5 · tell Velocity 11 more are coming on order ZZ5471188", action: { label: "Told Velocity", links: { copy_message: "A replacement for 11 units of zz soap, 2 Count (B0ZZEML00A) from order ZZ5471188 is coming. Please receive it on order ZZ5471188." } } });
      expect(Number((await q(`SELECT expected_individual FROM po_line_expected WHERE line_id = $1`, [s.v.line])).rows[0].expected_individual)).toBe(12); // nothing leaves Expected
      line("1", "outcome replacement, Velocity PO", r, "Told Velocity", "Waiting on supplier until it ships");
      await doneTask(q, c.tasks.find((t) => t.kind === "tell_velocity_replacement" && !t.done_at)!.id, null, { date: "2026-11-06", channel: "Discord" });
      r = await row(q, id);
      expect(r).toMatchObject({ bucket: "waiting_supplier", sentence: "Replacement promised 11/5 · waiting for the shipping email or tracking" });
      expect(r.bucket_since?.slice(0, 10)).toBe("2026-11-06"); // the dated Told Velocity tick restarts the timer
      // row 7: promised and no shipping email / tracking in 5 business days → Check on it naming it
      const stall = new Date("2026-11-16T15:00:00Z");
      expect((await sweepClaimTimers(q, stall, null)).find((x) => x.claim_id === id)).toEqual({ claim_id: id, kind: "check_on_it", reason: "5 business days: replacement promised 11/5 · no shipping email or tracking" });
      r = await row(q, id, stall);
      expect(r).toMatchObject({ group: "timed_out", sentence: "Replacement promised 11/5 · no shipping email or tracking in 5 business days", action: { label: "Check on it", secondary: "snooze" } });
      line("7", "promised, nothing shipped in 5 business days", r, "Check on it", "—");
      await checked(q, id, stall);
      // row 3: a tracking row arrives on the PO's own order # after the promise, pushed to the original Velocity order → tied, Shipped
      const t1 = await ship(q, s.v.po, "1Z4F0R490398184975", "2026-11-12T18:12:00Z", { retailer: "ZZ5471188", pushed: ["6778"] });
      const sw = await sweepReplacements(q, NOW);
      expect(sw.tied).toBe(1);
      c = await one(q, id);
      expect(c).toMatchObject({ replacement_shipped_source: "email", replacement_tracking: { tracking_number: "1Z4F0R490398184975", pushed_velocity_ids: ["6778"] } });
      expect((await loadClaimEvents(q, id)).find((e) => e.type === "replacement_shipped")).toMatchObject({ po_tracking_id: t1, summary: "UPS 1Z4F0R490398184975 · arrived on the PO's order # after the claim was opened, so AF tied it to this claim · pushed to Velocity order #6778" });
      // the carrier's first scan is Shipped (source tracking); Waiting on shipment with the carrier's word
      await carrier(q, trk("tracker-return-in_transit", "1Z4F0R490398184975"));
      c = await one(q, id);
      expect(c.replacement_shipped_source).toBe("tracking");
      expect(String(c.replacement_shipped_at).slice(0, 10)).toBe("2026-11-13"); // (a date column since migration 101: the day of the first scan)
      r = await row(q, id, new Date("2026-11-14T15:00:00Z"));
      expect(r).toMatchObject({ bucket: "waiting_shipment", sentence: "Replacement shipped 11/13 · UPS in transit · due 11/17 · from tracking" });
      expect(steps(c)).toContain("✓ tell_velocity · ✓ shipped(tracking) · ● arrived");
      expect(replacementMessage(c)).toBe("A replacement for 11 units of zz soap, 2 Count (B0ZZEML00A) from order ZZ5471188 is on its way, UPS 1Z4F0R490398184975. Please receive it on order ZZ5471188.");
      line("3", "tracking on the same order #, first scan 11/13", r, "nothing", "Velocity's count → Arrived");
      // row 7 again: in transit, no scan in 5 business days
      const stall2 = new Date("2026-11-23T15:00:00Z");
      expect((await sweepClaimTimers(q, stall2, null)).find((x) => x.claim_id === id)?.reason).toBe("5 business days: replacement shipped 11/13 · no new carrier scan");
      await checked(q, id, stall); // (dated before the 11/17 delivery below: the rows are illustrative, not one timeline — the restart must not outrun the delivery anchor)
      // row 7 (D8): delivered to Velocity, the line still short → 3 business days, "Velocity received 2 of 12"
      await carrier(q, trk("tracker-return-delivered-after-label", "1Z4F0R490398184975"));
      await q(`UPDATE po_line_items SET qty_received = 2 WHERE id = $1`, [s.v.line]);
      c = await one(q, id);
      expect(c.replacement_delivered_at).toBeTruthy();
      const late = new Date("2026-11-20T15:00:00Z"); // Tue 11/17 + 3 bd = Fri 11/20
      expect((await sweepClaimTimers(q, late, null)).find((x) => x.claim_id === id)?.reason).toBe("3 business days: replacement delivered 11/17 · Velocity received 2 of 12");
      r = await row(q, id, late);
      expect(r.sentence).toBe("Replacement delivered 11/17 · Velocity received 2 of 12 · 3 business days since delivery");
      line("7", "delivered, Velocity short after 3 business days", r, "Check on it", "—");
      await checked(q, id, late);
      // row 5: Velocity's count covers the line → Arrived → Closed, with no click
      await q(`UPDATE po_line_items SET qty_received = 12 WHERE id = $1`, [s.v.line]);
      expect((await sweepReplacements(q, late)).arrived).toBe(1);
      c = await one(q, id);
      expect(c.status).toBe("closed");
      r = await row(q, id, late);
      expect(r.sentence).toBe(`Replacement arrived ${r.replacement_arrived_at!.slice(5, 7).replace(/^0/, "")}/${r.replacement_arrived_at!.slice(8, 10).replace(/^0/, "")} · Velocity received 12 of 12`);
      expect((await loadClaimEvents(q, id)).find((e) => e.type === "replacement_arrived")?.summary).toBe("Velocity received 12 of 12");
      line("5", "Velocity received 12 of 12", r, "nothing", "Closed");
    });
  });

  it("row 2 · 6: a home PO — no Velocity task, Waiting on supplier; delivered → Money and arrivals 'did all N arrive?' — Arrived closes, Short keeps the rest open", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.h.po, { po_line_item_id: s.h.line, kind: "damaged", qty: 6 }, null);
      await reported(q, id); await promised(q, id);
      let c = await one(q, id);
      expect(openKinds(c)).toEqual(["replacement_arrived"]);
      let r = await row(q, id);
      expect(r).toMatchObject({ bucket: "waiting_supplier", sentence: "Replacement promised 11/5 · waiting for the shipping email or tracking" });
      line("2", "outcome replacement, home PO", r, "nothing", "Waiting on supplier until it ships");
      await ship(q, s.h.po, "1Z4F0R490398184976", "2026-11-10T18:12:00Z", { retailer: "ZZ5471199" });
      await sweepReplacements(q, NOW);
      await carrier(q, trk("tracker-return-delivered-after-label", "1Z4F0R490398184976"));
      c = await one(q, id);
      expect(openKinds(c)).toEqual(["confirm_arrival", "replacement_arrived"]);
      r = await row(q, id, new Date("2026-11-18T15:00:00Z"));
      expect(r).toMatchObject({ bucket: "needs_attention", group: "money", sentence: "Replacement delivered 11/17 · from tracking · did all 6 arrive?", action: { label: "Arrived", secondary: "short", decision: "arrived" } });
      line("6", "carrier delivered 11/17 (home PO)", r, "Arrived / Short", "Closed / the rest stays open");
      // Short: 4 of 6 arrived → the claim stays open for 2, reported again
      await doneTask(q, c.tasks.find((t) => t.kind === "confirm_arrival" && !t.done_at)!.id, null, { decision: "short", qty: 4 });
      c = await one(q, id);
      expect(c).toMatchObject({ status: "open", replacement_short_qty: 4 });
      r = await row(q, id, new Date("2026-11-18T15:00:00Z"));
      expect(r).toMatchObject({ bucket: "needs_attention", group: "supplier", sentence: "Replacement short: 4 of 6 arrived · 2 still missing — report the rest", action: { label: "Contacted supplier" } });
      line("6", "Short: 4 of 6 arrived", r, "Contacted supplier", "the usual path for the rest");
      // Arrived on a second home claim closes it
      const other = await addClaim(q, s.h.po, { po_line_item_id: s.h.line, kind: "missing", qty: 1 }, null);
      await reported(q, other.id); await promised(q, other.id);
      await q(`UPDATE supplier_claims SET replacement_delivered_at = '2026-11-12T12:00:00Z' WHERE id = $1`, [other.id]);
      await q(`INSERT INTO supplier_claim_tasks (claim_id, kind, "group", reason) VALUES ($1, 'confirm_arrival', 'money', 'delivered')`, [other.id]);
      await doneTask(q, (await one(q, other.id)).tasks.find((t) => t.kind === "confirm_arrival" && !t.done_at)!.id, null, { decision: "arrived" });
      expect((await one(q, other.id)).status).toBe("closed");
    });
  });

  it("row 4 + the nine places: a shipping email under a NEW order # → It's the reship — the number kept on the PO as replacement order, the row tied and pushed to the ORIGINAL Velocity order; It's not — never again", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.v.po, { po_line_item_id: s.v.line, kind: "missing", qty: 3 }, null);
      await reported(q, id); await promised(q, id);
      await doneTask(q, (await one(q, id)).tasks.find((t) => t.kind === "tell_velocity_replacement" && !t.done_at)!.id, null, {});
      // the ingest parked the shipping email: unknown order #, the supplier's domain, the items
      const unmatched = Number((await q(`INSERT INTO po_tracking (carrier, tracking_number, retailer_order_id, sender_domain, shipped_at, items_json, gmail_message_id, email_subject, source, status, match_reason)
        VALUES ('UPS', '1Z86W3400341556021', 'R4600111200931', 'zz-test.com', '2026-11-12T14:00:00Z', $1::jsonb, 'zz-mail-reship', 'Your order R4600111200931 has shipped', 'regex', 'unmatched', 'no_po') RETURNING id`, [JSON.stringify([{ name: "zz soap, 2 Count", qty: 3 }])])).rows[0].id);
      expect(itemsMatchProduct([{ name: "zz soap, 2 Count" }], "zz soap, 2 Count", "B0ZZEML00A")).toBe("yes");
      const sw = await sweepReplacements(q, NOW);
      expect(sw.suggested).toBe(1);
      let c = await one(q, id);
      const task = c.tasks.find((t) => t.kind === "confirm_reship_order" && !t.done_at)!;
      expect(task.payload).toMatchObject({ tracking_id: unmatched, order_id: "R4600111200931" });
      let r = await row(q, id);
      // place 1: the row before confirming
      expect(r).toMatchObject({ bucket: "needs_attention", group: "supplier", sentence: "Shipping email 11/12 for order R4600111200931 · 3 × zz soap, 2 Count · looks like the reship", action: { label: "It's the reship", secondary: "not_reship", decision: "reship", email: { id: "zz-mail-reship" } } });
      line("4", "shipping email for order R4600111200931", r, "It's the reship / It's not", "the number kept on the PO, the tracking pushed to the original Velocity order");
      const out = await doneTask(q, task.id, null, { decision: "reship" });
      expect((out as any).push_tracking_po_id).toBe(s.v.po);
      // place 6: the Order card's "Other numbers" — labeled, with the claim; alt_order_ids follows; the PO's own order # unchanged
      const nums = await listOtherNumbers(q, s.v.po);
      expect(nums.map((n) => otherNumberText(n))).toEqual([`R4600111200931 · replacement order · claim #${id}`]);
      expect((await q(`SELECT order_id, alt_order_ids FROM purchase_orders WHERE id = $1`, [s.v.po])).rows[0]).toEqual({ order_id: "ZZ5471188", alt_order_ids: "R4600111200931" });
      // place 7: PO History
      expect((await q(`SELECT field, new_value FROM po_edit_log WHERE po_id = $1 AND field = 'Other number added'`, [s.v.po])).rows).toEqual([{ field: "Other number added", new_value: `R4600111200931 · replacement order · claim #${id}` }]);
      // the row: tied to the PO and the claim, matched — never a new Velocity order
      expect((await q(`SELECT po_id, claim_id, status FROM po_tracking WHERE id = $1`, [unmatched])).rows[0]).toEqual({ po_id: s.v.po, claim_id: String(id), status: "matched" });
      c = await one(q, id);
      expect(c).toMatchObject({ replacement_order_id: "R4600111200931", replacement_shipped_source: "email" });
      // place 4: the timeline
      const ev = await loadClaimEvents(q, id);
      expect(ev.find((e) => e.type === "reship_confirmed")).toMatchObject({ summary: `Order R4600111200931 kept on the PO as replacement order · tracking UPS 1Z86W3400341556021 tied to this claim`, po_tracking_id: unmatched });
      // place 2 + 3 + 5: the row after, the card's data, the message with the box sentence
      await carrier(q, trk("tracker-return-in_transit", "1Z86W3400341556021"));
      c = await one(q, id);
      r = await row(q, id, new Date("2026-11-14T15:00:00Z"));
      expect(r.sentence).toBe("Replacement shipped 11/13 on order R4600111200931 · UPS in transit · due 11/17 · from tracking");
      expect(replacementMessage(c)).toBe("A replacement for 3 units of zz soap, 2 Count (B0ZZEML00A) from order ZZ5471188 is on its way, UPS 1Z86W3400341556021. The box may show order # R4600111200931. Please receive it on order ZZ5471188.");
      line("4", "It's the reship", r, "nothing", "delivered → Velocity's count → Closed");
      // place 8: the Tracking tab's order # label (the tab's subquery)
      expect((await q(`SELECT (SELECT n.kind FROM po_other_numbers n WHERE n.po_id = t.po_id AND n.number = t.retailer_order_id ORDER BY n.id LIMIT 1) AS order_number_kind, t.claim_id FROM po_tracking t WHERE t.id = $1`, [unmatched])).rows[0]).toEqual({ order_number_kind: "replacement_order", claim_id: String(id) });
      // place 9: search finds the original PO and says which number matched
      const P: any[] = [s.v.po];
      const hit = (await q(`SELECT p.order_id, ${searchOtherSql("R46001112", { $: (v) => `$${P.push(v)}` })} AS search_other FROM purchase_orders p WHERE p.id = $1`, P)).rows[0];
      expect(hit).toEqual({ order_id: "ZZ5471188", search_other: "R4600111200931|replacement_order" });
      // the Upload plan: the PO's row answers under the reship number too — a Velocity order under R… is this row's, never a create
      const af = (await loadAfPoRows(q)).rows.find((x) => x.orderNumber === "ZZ5471188")!;
      expect(af.altOrderIds).toEqual(["R4600111200931"]);
      expect(readFileSync(join(__dirname, "velocity-reconcile.ts"), "utf8")).toContain("for (const num of [row.orderNumber, ...(row.altOrderIds ?? [])])");
      // the push: the reship's row goes to the ORIGINAL Velocity order (#6778 under ZZ5471188); nothing is created
      const puts: Array<{ ids: string[]; numbers: string[] }> = [];
      const deps: VelocityDeps = {
        list: async () => [{ order_id: "6778", order_number: "ZZ5471188", asin: "B0ZZEML00A", date: "10/14/2026", sold_as: "multi-pack", status: "inbound", unit_status: "pending", units_per_pack: 1, quantity: 12, trackings: [] } as any],
        known: async () => [{ order_id: "6778", order_number: "ZZ5471188", asin: "B0ZZEML00A", date: "10/14/2026", sold_as: "multi-pack", status: "inbound" } as any],
        append: async (ids, numbers) => { puts.push({ ids, numbers }); },
      };
      const res = await pushTracking({ query: q, deps, poId: s.v.po });
      expect(puts).toEqual([{ ids: ["6778"], numbers: ["1Z86W3400341556021"] }]);
      expect(res.plans[0]).toMatchObject({ order_id: "ZZ5471188", targets: [{ velocity_order_id: "6778", to_add: ["1Z86W3400341556021"] }] });
      expect(JSON.stringify(res.plans[0])).not.toContain("R4600111200931"); // the reship number never reaches Velocity
      // It's not: a second claim, the same kind of email → dismissed, never proposed again
      const two = await addClaim(q, s.h.po, { po_line_item_id: s.h.line, kind: "missing", qty: 1 }, null);
      await reported(q, two.id); await promised(q, two.id);
      const um2 = Number((await q(`INSERT INTO po_tracking (carrier, tracking_number, retailer_order_id, sender_domain, shipped_at, items_json, gmail_message_id, source, status, match_reason)
        VALUES ('UPS', '1Z86W3400341556022', 'R4600111200999', 'zz-test.com', '2026-11-12T14:00:00Z', $1::jsonb, 'zz-mail-reship-2', 'regex', 'unmatched', 'no_po') RETURNING id`, [JSON.stringify([{ name: "zz soap", qty: 1 }])])).rows[0].id);
      await sweepReplacements(q, NOW);
      const t2 = (await one(q, two.id)).tasks.find((t) => t.kind === "confirm_reship_order" && !t.done_at)!;
      await doneTask(q, t2.id, null, { decision: "not_reship" });
      expect((await loadClaimEvents(q, two.id)).find((e) => e.type === "reship_dismissed")).toMatchObject({ po_tracking_id: um2 });
      await sweepReplacements(q, NOW);
      expect(openKinds(await one(q, two.id))).toEqual(["replacement_arrived"]);
      expect((await q(`SELECT po_id FROM po_tracking WHERE id = $1`, [um2])).rows[0].po_id).toBeNull();
    });
  });

  it("row 8 · 9: the outcome changes to a refund → the replacement steps, card and tasks go, the units leave Expected; the one-off chip is gone", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const { id } = await addClaim(q, s.v.po, { po_line_item_id: s.v.line, kind: "missing", qty: 3 }, null);
      await reported(q, id); await promised(q, id);
      expect(Number((await q(`SELECT expected_individual FROM po_line_expected WHERE line_id = $1`, [s.v.line])).rows[0].expected_individual)).toBe(12);
      await setOutcome(q, id, { outcome: "refund_card" }, null);
      const c = await one(q, id);
      expect(openKinds(c)).toEqual([]);
      expect(claimSteps(c).map((x) => x.key)).toEqual(["found", "reported", "answered", "confirmed", "received", "closed"]);
      expect(Number((await q(`SELECT expected_individual FROM po_line_expected WHERE line_id = $1`, [s.v.line])).rows[0].expected_individual)).toBe(9);
      line("8", "outcome changed to refund", await row(q, id), "the refund path", "$ owed again");
      // row 9: no one-off chip anywhere
      expect(existsSync(join(__dirname, "tracking-replacement-pair.ts"))).toBe(false);
      expect(AUTO_ACTION_ITEMS.some((x) => /Tracking also goes/.test(x))).toBe(false);
      expect(PO_ACTION_ITEMS_SQL).not.toContain("Tracking also goes");
      expect(readFileSync(join(__dirname, "..", "client", "src", "components", "po-asin-rows.tsx"), "utf8")).not.toContain("Tracking also goes");
    });
  });

  it("rows 10–13: the four warnings dismiss with a required note into po_warning_dismissals, leave the PO's items, come back when the numbers change, undo; never block auto-close; the other two never dismiss", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      const items = async () => (await q(`SELECT ${PO_ACTION_ITEMS_SQL} AS items, ${PO_CLOSE_ACTION_ITEMS_SQL} AS close_items FROM purchase_orders p WHERE p.id = $1`, [s.v.po])).rows[0];
      // Extra units shipped (7 of 5 ordered), FBA receiving mismatch (received 3), Pack size mismatch (Velocity's pack 6 vs 1), Review Velocity (a review reason)
      await q(`UPDATE po_asins SET qty = 5, velocity_units_per_pack = 6 WHERE id = $1`, [s.v.pa]);
      await q(`INSERT INTO po_asin_shipments (po_asin_id, velocity_shipment_id, qty_shipped, qty_received, source, fba_shipment_ids) VALUES ($1, 'zz-vs-1', 7, 3, 'manual', ARRAY['FBA-ZZ-1'])`, [s.v.pa]);
      await q(`INSERT INTO po_tracking (po_id, carrier, tracking_number, shipped_at, gmail_message_id, source, status, review_reason) VALUES ($1, 'UPS', '1ZZZREVIEW000001', '2026-11-10T12:00:00Z', 'zz-review', 'regex', 'held', 'not in Velocity')`, [s.v.po]);
      const { reconcileReviewVelocity } = await import("./line-action-items");
      await reconcileReviewVelocity(q, [s.v.po]);
      expect(DISMISSABLE_WARNINGS).toEqual([EXTRA_UNITS_SHIPPED, PACK_SIZE_MISMATCH, RECEIVING_MISMATCH, REVIEW_VELOCITY]);
      let it_ = await items();
      for (const w of DISMISSABLE_WARNINGS) expect(it_.items, w).toContain(w);
      // row 10: a note is required; row 11: the chip leaves; the Notes card lists it
      await expect(dismissWarning(q, { poAsinId: s.v.pa }, EXTRA_UNITS_SHIPPED, "  ", null)).rejects.toMatchObject({ status: 400 });
      await expect(dismissWarning(q, { poAsinId: s.v.pa }, "No invoice saved", "x", null)).rejects.toMatchObject({ status: 400 });
      await expect(dismissWarning(q, { poAsinId: s.v.pa }, "Pack size missing", "x", null)).rejects.toMatchObject({ status: 400 });
      const d1 = await dismissWarning(q, { poAsinId: s.v.pa }, EXTRA_UNITS_SHIPPED, "2 extra are the free units the supplier added", null);
      expect(d1.dismissal).toMatchObject({ warning_type: EXTRA_UNITS_SHIPPED, summary: "shipped 7 of 5", asin: "B0ZZEML00A", note: "2 extra are the free units the supplier added" });
      const d2 = await dismissWarning(q, { poAsinId: s.v.pa }, RECEIVING_MISMATCH, "Amazon still counting", null);
      expect(d2.dismissal.summary).toBe("received 3 ≠ shipped 7");
      const d3 = await dismissWarning(q, { poAsinId: s.v.pa }, PACK_SIZE_MISMATCH, "Velocity has the 6-pack by mistake, told them", null);
      expect(d3.dismissal.summary).toBe("Velocity pack 6 vs 1 (multi-pack)");
      const d4 = await dismissWarning(q, { poId: s.v.po }, REVIEW_VELOCITY, "the number is on the Velocity order already", null);
      expect(d4.dismissal.summary).toBe("reasons: not in Velocity");
      it_ = await items();
      for (const w of DISMISSABLE_WARNINGS) { expect(it_.items, w).not.toContain(w); expect(it_.close_items, w).not.toContain(w); }
      expect((await listDismissals(q, s.v.po)).map((d) => d.warning_type).sort()).toEqual([EXTRA_UNITS_SHIPPED, PACK_SIZE_MISMATCH, RECEIVING_MISMATCH, REVIEW_VELOCITY].sort());
      expect((await q(`SELECT field, old_value, new_value FROM po_edit_log WHERE po_id = $1 AND field = 'warning dismissed' ORDER BY id`, [s.v.po])).rows[0]).toEqual({ field: "warning dismissed", old_value: "Extra units shipped · shipped 7 of 5", new_value: "2 extra are the free units the supplier added" });
      TABLE.push(`| 10–11 | the four warnings dismissed with a note | chips gone from the PO; Notes › Dismissed warnings: ${(await listDismissals(q, s.v.po)).map((d) => `${d.warning_type} · ${d.summary}`).join("; ")} | undo | the warning is back |`);
      // row 13: a dismissed warning never blocks auto-close — every unit shipped (7 of 5), no open claim → the PO closes
      expect((await evaluateAutoClose(s.v.po, q)).closed).toBe(true);
      // row 12: the numbers change → the warning is back; the old line stays
      await q(`UPDATE po_asin_shipments SET qty_shipped = 8 WHERE po_asin_id = $1`, [s.v.pa]);
      it_ = await items();
      expect(it_.items).toContain(EXTRA_UNITS_SHIPPED);
      expect(it_.items).toContain(RECEIVING_MISMATCH); // received 3 ≠ shipped 8 now
      expect((await listDismissals(q, s.v.po)).find((d) => d.warning_type === EXTRA_UNITS_SHIPPED)).toMatchObject({ summary: "shipped 7 of 5", undone_at: null });
      await q(`UPDATE po_asin_shipments SET qty_shipped = 7 WHERE po_asin_id = $1`, [s.v.pa]);
      expect((await items()).items).not.toContain(EXTRA_UNITS_SHIPPED);
      // undo brings it back at once
      const u = await undoDismissal(q, d3.dismissal.id, null);
      expect(u.dismissal.undone_at).toBeTruthy();
      expect((await items()).items).toContain(PACK_SIZE_MISMATCH);
      await expect(undoDismissal(q, d3.dismissal.id, null)).rejects.toMatchObject({ status: 404 });
      // Review Velocity: undo → the stored item is back on the lines
      await undoDismissal(q, d4.dismissal.id, null);
      expect((await items()).items).toContain(REVIEW_VELOCITY);
      // row 13's other half: units still unshipped → the PO stays open whatever is dismissed
      await q(`UPDATE po_asin_shipments SET qty_shipped = 3 WHERE po_asin_id = $1`, [s.v.pa]);
      await q(`UPDATE purchase_orders SET closed_at = NULL, closed_by = NULL WHERE id = $1`, [s.v.po]);
      expect((await evaluateAutoClose(s.v.po, q)).closed).toBe(false);
      TABLE.push("| 12–13 | numbers change / undo / auto-close | the warning returns, the old line stays; undo returns it at once; dismissed warnings never block auto-close, unshipped units do | — | — |");
    });
  });

  it("other numbers: a rename keeps the old number as 'previous number' dated; a typed number is 'other' with a note; the PO's own order # is refused; an 'other' needs a note", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const s = await seed(q);
      await expect(addOtherNumber(q, s.v.po, { number: "ZZ5471188", kind: "invoice" }, null)).rejects.toMatchObject({ status: 400 });
      await expect(addOtherNumber(q, s.v.po, { number: "MIK-INV-1", kind: "other" }, null)).rejects.toMatchObject({ status: 400 });
      const inv = await addOtherNumber(q, s.v.po, { number: "MIK-INV-208841", kind: "invoice", note: "same order" }, null);
      expect(otherNumberText(inv)).toBe("MIK-INV-208841 · invoice # · same order");
      await syncOtherNumbersFromText(q, s.v.po, "MIK-INV-208841, 7788", null);
      expect((await listOtherNumbers(q, s.v.po)).map(otherNumberText)).toEqual(["MIK-INV-208841 · invoice # · same order", "7788 · other · typed on the Edit PO form — label it on the PO page"]);
      expect((await q(`SELECT alt_order_ids FROM purchase_orders WHERE id = $1`, [s.v.po])).rows[0].alt_order_ids).toBe("MIK-INV-208841, 7788");
      // the rename (Velocity untouched: no orders known) → previous number, dated
      const puts: any[] = [];
      await q(`UPDATE purchase_orders SET order_id = 'ZZ5471188-NEW' WHERE id = $1`, [s.v.po]); // the header edit renames first, then the sync runs (routes)
      const r = await syncVelocityAfterOrderIdRename(q, { poId: s.v.po, oldOrderId: "ZZ5471188", newOrderId: "ZZ5471188-NEW" }, null,
        { fetchKnown: async () => [{ order_id: "6778", order_number: "ZZ5471188", asin: "B0ZZEML00A", status: "inbound", date: "10/14/2026", sold_as: "multi-pack" }], update: async (id: string, body: any) => { puts.push({ id, body }); return {}; }, log: () => {} } as any);
      expect(r.outcome, r.warning).toBe("done");
      const nums = await listOtherNumbers(q, s.v.po);
      expect(r.altKept).toBe(true);
      expect(nums.find((n) => n.number === "ZZ5471188")).toMatchObject({ kind: "previous_number", note: expect.stringMatching(/^renamed \d+\/\d+\/\d{4}$/) });
      expect(r.warning).toContain("kept as the previous number");
    });
  });
});
