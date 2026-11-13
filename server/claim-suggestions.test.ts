// Auto-found claims (SPEC §22 "Supplier claims", claims patch §3.1 / D8, commit 5): missing after delivery, never
// received with and without tracking, business days, dedupe by suggestion key, the suggested-only writer.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  missingSuggestion, neverReceivedSuggestion, lostRule, deliveredAt, isNewSuggestion, suggestClaim, sweepSuggestions, supersedeConvertedOnLine, sweepSupersededConverted, CONVERTED_BADGE_SQL, SUPERSEDED_REASON,
  MISSING_ROWS_SQL, PO_STATE_SQL, TRACKING_STATE_SQL, MISSING_AFTER_BUSINESS_DAYS, LOST_AFTER_BUSINESS_DAYS, IN_TRANSIT_MAX_DAYS, NOTHING_AFTER_DAYS,
  type AsinRowState, type TrackingState, type PoState,
} from "./claim-suggestions";
import { COMPONENTS } from "./scheduler/components";

// Thursday 2026-11-12 15:00 ET
const NOW = new Date("2026-11-12T20:00:00Z");
const PO = "11111111-1111-1111-1111-111111111111";
const LINE = "22222222-2222-2222-2222-222222222222";
const tracking = (o: Partial<TrackingState> = {}): TrackingState => ({ id: 1, po_id: PO, carrier: "UPS", tracking_number: "1Z1", carrier_status: "delivered", est_delivery_at: null, last_scan_at: "2026-11-06T15:00:00Z", delivered_at: "2026-11-06T15:00:00Z", velocity_tracking_status: null, shipped_at: "2026-11-03T00:00:00Z", updated_at: "2026-11-07T00:00:00Z", qty: null, ...o });
const asinRow = (o: Partial<AsinRowState> = {}): AsinRowState => ({ asin_row_id: "a1", po_id: PO, order_id: "200015", supplier: "walmart.com", asin: "B0TEST", ordered_individual: 12, canceled_individual: 0, received_velocity_individual: 10, product_pack: 2, asin_rows_on_po: 1, line_id: LINE, line_count: 1, ...o });
const po = (o: Partial<PoState> = {}): PoState => ({ po_id: PO, order_id: "200015", supplier: "walmart.com", ships_to: "velocity", order_date: "2026-10-20", order_total: 59.7, line_count: 1, single_line_id: LINE, tracking_rows_any: 1, expected_individual: 12, received_individual: 0, shipped_fba_individual: 0, ...o });

describe("missing (D8)", () => {
  it("every inbound tracking delivered, ≥ 3 business days since the latest delivery, received < shipped → one suggestion with both figures and the two causes", () => {
    const s = missingSuggestion(asinRow(), [tracking()], NOW)!;
    expect(s).toMatchObject({ kind: "missing", po_line_item_id: LINE, qty: 2, amount: null, found_by: "auto", rule: "missing_after_delivery", key: "missing:a1:12:10" });
    expect(s.reason).toContain("Velocity received 10 Individual units, 12 shipped (ordered 12 − canceled 0)");
    expect(s.reason).toContain("the supplier shipped a single instead of the case, or Velocity's pack size is wrong");
  });
  it("shipped = Σ the emails' stated Product units × the product pack when the PO has one ASIN row and every delivered row states a qty; else ordered − canceled", () => {
    // 2 shipments of 3 Product units each × pack 2 = 12 shipped; Velocity got 10
    const s = missingSuggestion(asinRow(), [tracking({ id: 1, qty: 3 }), tracking({ id: 2, tracking_number: "1Z2", qty: 3 })], NOW)!;
    expect(s.reason).toContain("the 2 shipping emails state 6 Product units");
    expect(s.qty).toBe(2);
    // one row without a stated qty → ordered − canceled (12 − 4 = 8 shipped, 10 received → nothing missing)
    expect(missingSuggestion(asinRow({ canceled_individual: 4 }), [tracking({ qty: 3 }), tracking({ id: 2, tracking_number: "1Z2" })], NOW)).toBeNull();
    // two ASIN rows on the PO: the tracking qty cannot be split → ordered − canceled
    expect(missingSuggestion(asinRow({ asin_rows_on_po: 2 }), [tracking({ qty: 1 })], NOW)!.reason).toContain("ordered 12 − canceled 0");
  });
  it("not suggested: a row still undelivered, fewer than 3 business days since delivery (weekend excluded), nothing received short, no tracking at all", () => {
    expect(missingSuggestion(asinRow(), [tracking(), tracking({ id: 2, tracking_number: "1Z2", carrier_status: "in_transit", delivered_at: null })], NOW)).toBeNull();
    // delivered Tue Nov 10 → Thu Nov 12 is 2 business days
    expect(missingSuggestion(asinRow(), [tracking({ delivered_at: "2026-11-10T15:00:00Z" })], NOW)).toBeNull();
    // delivered Fri Nov 6 → Thu Nov 12 is 4 business days (Sat / Sun do not count)
    expect(missingSuggestion(asinRow(), [tracking({ delivered_at: "2026-11-06T15:00:00Z" })], NOW)).not.toBeNull();
    expect(MISSING_AFTER_BUSINESS_DAYS).toBe(3);
    expect(missingSuggestion(asinRow({ received_velocity_individual: 12 }), [tracking()], NOW)).toBeNull();
    expect(missingSuggestion(asinRow(), [], NOW)).toBeNull();
  });
  it("Velocity's tracking_status is the delivered fallback for rows EasyPost does not track (FedEx until its carrier account, GLS)", () => {
    const fedex = tracking({ carrier: "FEDEX", carrier_status: null, delivered_at: null, velocity_tracking_status: "Delivered", updated_at: "2026-11-05T12:00:00Z" });
    expect(deliveredAt(fedex)).toBe("2026-11-05T12:00:00Z");
    expect(deliveredAt(tracking({ delivered_at: null, velocity_tracking_status: "In Transit" }))).toBeNull();
    expect(missingSuggestion(asinRow(), [fedex], NOW)!.reason).toContain("the latest 2026-11-05");
  });
  it("the key carries the figures: the same figures are never suggested twice, changed figures are; one open suggestion per line", () => {
    const s = missingSuggestion(asinRow(), [tracking()], NOW)!;
    expect(isNewSuggestion(s, [{ po_id: PO, po_line_item_id: LINE, kind: "missing", status: "dismissed", suggestion_key: "missing:a1:12:10" }])).toBe("same_key");
    expect(isNewSuggestion(s, [{ po_id: PO, po_line_item_id: LINE, kind: "missing", status: "dismissed", suggestion_key: "missing:a1:12:8" }])).toBe("created");
    expect(isNewSuggestion(s, [{ po_id: PO, po_line_item_id: LINE, kind: "missing", status: "suggested", suggestion_key: "missing:a1:12:8" }])).toBe("already_suggested");
    expect(isNewSuggestion(s, [{ po_id: PO, po_line_item_id: LINE, kind: "missing", status: "closed", suggestion_key: null }])).toBe("created");
    // a CLOSED canceled claim on the line blocks a canceled suggestion (bathandbodyworks 00474317701906, 2026-11-13: Cancel PO → refund → closed, then the email suggested it again)
    const canceled = { ...s, kind: "canceled" as const, key: "canceled:x:10" };
    expect(isNewSuggestion(canceled, [{ po_id: PO, po_line_item_id: LINE, kind: "canceled", status: "closed", suggestion_key: null }])).toBe("already_suggested");
    expect(isNewSuggestion(canceled, [{ po_id: PO, po_line_item_id: LINE, kind: "canceled", status: "dismissed", suggestion_key: null }])).toBe("created");
    expect(isNewSuggestion(s, [{ po_id: PO, po_line_item_id: null, kind: "never_received", status: "open", suggestion_key: null }])).toBe("created");
    // a converted badge claim (migration 101, qty NULL, enter_quantity open) of the same kind on the line never blocks — it is superseded instead (Maria 2026-11-12)
    expect(isNewSuggestion(s, [{ po_id: PO, po_line_item_id: LINE, kind: "missing", status: "open", suggestion_key: null, converted_badge: true }])).toBe("created");
    expect(isNewSuggestion(s, [{ po_id: PO, po_line_item_id: LINE, kind: "missing", status: "open", suggestion_key: null, converted_badge: false }])).toBe("already_suggested");
  });
});

describe("never_received", () => {
  it("(a) with tracking — the four lost rules, each needing business days where the spec says so", () => {
    expect(lostRule(tracking({ carrier_status: "return_to_sender", delivered_at: null }), NOW)).toBe("carrier_exception");
    expect(lostRule(tracking({ carrier_status: "failure", delivered_at: null }), NOW)).toBe("carrier_exception");
    // ETA Wed Nov 4 → Thu Nov 12 = 6 business days
    expect(lostRule(tracking({ carrier_status: "in_transit", delivered_at: null, est_delivery_at: "2026-11-04T00:00:00Z", last_scan_at: "2026-11-11T00:00:00Z" }), NOW)).toBe("eta_passed");
    // ETA Mon Nov 9 → Thu Nov 12 = 3 business days: not yet
    expect(lostRule(tracking({ carrier_status: "in_transit", delivered_at: null, est_delivery_at: "2026-11-09T00:00:00Z", last_scan_at: "2026-11-11T00:00:00Z", shipped_at: "2026-11-05T00:00:00Z" }), NOW)).toBeNull();
    // last scan Wed Nov 4 → 6 business days of silence
    expect(lostRule(tracking({ carrier_status: "in_transit", delivered_at: null, last_scan_at: "2026-11-04T00:00:00Z", shipped_at: "2026-11-03T00:00:00Z" }), NOW)).toBe("no_scan");
    // shipped 20 days ago, a scan 2 days ago: not stale; a scan 5 days ago (Sat Nov 7 → 3 business days, 5 calendar): stale
    expect(lostRule(tracking({ carrier_status: "in_transit", delivered_at: null, last_scan_at: "2026-11-10T20:00:00Z", shipped_at: "2026-10-23T00:00:00Z" }), NOW)).toBeNull();
    expect(lostRule(tracking({ carrier_status: "in_transit", delivered_at: null, last_scan_at: "2026-11-07T00:00:00Z", shipped_at: "2026-10-23T00:00:00Z" }), NOW)).toBe("stale_in_transit");
    // no carrier data at all (FedEx before its account): only the 14-day rule applies, from the email date
    expect(lostRule(tracking({ carrier: "FEDEX", carrier_status: null, delivered_at: null, last_scan_at: null, shipped_at: "2026-10-20T00:00:00Z" }), NOW)).toBe("stale_in_transit");
    expect(lostRule(tracking({ carrier: "FEDEX", carrier_status: null, delivered_at: null, last_scan_at: null, shipped_at: "2026-11-05T00:00:00Z" }), NOW)).toBeNull();
    expect(lostRule(tracking(), NOW)).toBeNull(); // delivered
    expect([LOST_AFTER_BUSINESS_DAYS, IN_TRANSIT_MAX_DAYS]).toEqual([5, 14]);
  });
  it("every shipment flagged → a whole-PO claim (line NULL, qty = expected, amount = the order total); some → a claim on the one line, else whole-PO with the numbers and no qty", () => {
    const lost = tracking({ carrier_status: "return_to_sender", delivered_at: null });
    const whole = neverReceivedSuggestion(po(), [lost], NOW)!;
    expect(whole).toMatchObject({ kind: "never_received", po_line_item_id: null, qty: 12, amount: 59.7, rule: "lost:carrier_exception" });
    expect(whole.reason).toMatch(/^Looks not received\. Open a claim\? Every shipment on the PO looks lost — UPS 1Z1: the carrier reports an exception/);
    const partial = neverReceivedSuggestion(po(), [lost, tracking({ id: 2, tracking_number: "1Z2" })], NOW)!;
    expect(partial).toMatchObject({ po_line_item_id: LINE, qty: null, amount: null, rule: "lost_partial:carrier_exception" });
    expect(partial.reason).toContain("1 of 2 shipments on the PO looks lost");
    const multi = neverReceivedSuggestion(po({ line_count: 3 }), [lost, tracking({ id: 2, tracking_number: "1Z2" })], NOW)!;
    expect(multi.po_line_item_id).toBeNull();
    expect(multi.key).toBe(`never_received:${PO}:carrier_exception:1Z1`);
  });
  it("(b) with nothing — no tracking row of any kind (a placeholder counts) and nothing received 14 days after the order date; never once something arrived", () => {
    const s = neverReceivedSuggestion(po({ tracking_rows_any: 0, order_date: "2026-10-20" }), [], NOW)!;
    expect(s).toMatchObject({ po_line_item_id: null, qty: 12, amount: 59.7, rule: "nothing_after_order", key: `never_received:${PO}:nothing:2026-10-20` });
    expect(s.reason).toMatch(/^Looks not received\. Open a claim\? No tracking number and no shipping email 23 days after the order date/);
    expect(neverReceivedSuggestion(po({ tracking_rows_any: 0, order_date: "2026-11-01" }), [], NOW)).toBeNull();
    expect(neverReceivedSuggestion(po({ tracking_rows_any: 1 }), [], NOW)).toBeNull(); // a placeholder row = a shipping email
    expect(neverReceivedSuggestion(po({ tracking_rows_any: 0, order_date: "2026-10-01", received_individual: 4 }), [], NOW)).toBeNull();
    expect(neverReceivedSuggestion(po({ tracking_rows_any: 0, order_date: "2026-10-01", expected_individual: 0 }), [], NOW)).toBeNull(); // fully canceled
    expect(NOTHING_AFTER_DAYS).toBe(14);
  });
});

describe("the writer and the sweep", () => {
  it("suggestClaim: status suggested, found_by, the key, event found, a review_suggestion task with the reason (+ enter_quantity when the qty is unknown); a dry run writes nothing; a same-key claim is skipped", async () => {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const query = async (sql: string, params?: any[]) => {
      writes.push({ sql: sql.replace(/\s+/g, " ").trim(), params: params ?? [] });
      if (/^SELECT po_id, po_line_item_id/.test(sql)) return { rows: [], rowCount: 0 };
      if (/information_schema\.columns/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (/^SELECT l\.qty_basis/.test(sql)) return { rows: [{ qty_basis: "individual", price: 5.97, adjusted_product_cost: 5.97, retailer_units_per_product: 1, subtotal: 71.64, discount: 0, tax: 0, sh_donations: 0 }], rowCount: 1 };
      if (/^INSERT INTO supplier_claims /.test(sql)) return { rows: [{ id: 77 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    const s = missingSuggestion(asinRow(), [tracking()], NOW)!;
    expect(await suggestClaim(query, s, { dryRun: true })).toEqual({ created: false, id: null, why: "dry_run" });
    expect(writes.filter((w) => /^INSERT/.test(w.sql))).toHaveLength(0);
    const r = await suggestClaim(query, s);
    expect(r).toEqual({ created: true, id: 77, why: "created" });
    const ins = writes.find((w) => /^INSERT INTO supplier_claims /.test(w.sql))!;
    expect(ins.sql).toContain("'suggested', $7, $8, $9, $10");
    expect(ins.params).toEqual([PO, LINE, "missing", 2, 11.94, null, "auto", null, null, "missing:a1:12:10", null]);
    // a canceled suggestion is supplier-confirmed at creation on the email's date (paths, Maria 2026-11-12)
    expect(ins.sql).toContain("suggestion_key, supplier_confirmed_at)");
    writes.length = 0;
    await suggestClaim(query, { ...s, kind: "canceled", key: "c1", confirmed_at: "2026-10-27T14:00:00.000Z" });
    expect(writes.find((w) => /^INSERT INTO supplier_claims /.test(w.sql))!.params[10]).toBe("2026-10-27T14:00:00.000Z");
    expect(writes.find((w) => /INSERT INTO supplier_claim_events/.test(w.sql))!.params.slice(0, 2)).toEqual([77, "found"]);
    const task = writes.find((w) => /INSERT INTO supplier_claim_tasks/.test(w.sql))!;
    expect(task.params.slice(0, 2)).toEqual([77, "review_suggestion"]);
    expect(task.params[3]).toContain("Velocity received 10 Individual units");
    expect(writes.filter((w) => /INSERT INTO supplier_claim_tasks/.test(w.sql))).toHaveLength(1);
    // unknown qty → enter_quantity too
    writes.length = 0;
    await suggestClaim(query, { ...s, qty: null, key: "k2" });
    expect(writes.filter((w) => /INSERT INTO supplier_claim_tasks/.test(w.sql)).map((w) => w.params[1])).toEqual(["review_suggestion", "enter_quantity"]);
    expect(await suggestClaim(query, s, { existing: [{ po_id: PO, po_line_item_id: LINE, kind: "missing", status: "dismissed", suggestion_key: s.key }] })).toMatchObject({ created: false, why: "same_key" });
  });
  it("a suggestion on a line supersedes the converted badge claims there — a whole-PO suggestion those on every line of the PO: dismissed 'superseded by found claim' with a History row and an event; the ids come back on the outcome; a dry run only lists", async () => {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const query = async (sql: string, params?: any[]) => {
      writes.push({ sql: sql.replace(/\s+/g, " ").trim(), params: params ?? [] });
      if (/^SELECT po_id, po_line_item_id/.test(sql)) return { rows: [], rowCount: 0 };
      if (/information_schema\.columns/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (/^SELECT l\.qty_basis/.test(sql)) return { rows: [{ qty_basis: "individual", price: 5.97, adjusted_product_cost: 5.97, retailer_units_per_product: 1, subtotal: 71.64, discount: 0, tax: 0, sh_donations: 0 }], rowCount: 1 };
      if (/^INSERT INTO supplier_claims /.test(sql)) return { rows: [{ id: 77 }], rowCount: 1 };
      if (/^SELECT c\.id FROM supplier_claims c WHERE c\.po_id = \$1 AND \(\$2::uuid IS NULL OR c\.po_line_item_id = \$2\)/.test(sql)) return { rows: params![1] == null ? [{ id: 3099 }, { id: 3106 }] : [{ id: 3099 }, { id: 77 }], rowCount: 2 };
      if (/^SELECT \* FROM supplier_claims WHERE id = \$1/.test(sql)) return { rows: [{ id: params![0], po_id: PO, status: "open", outcome: null }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    expect(CONVERTED_BADGE_SQL).toContain("c.status = 'open' AND c.qty IS NULL");
    expect(CONVERTED_BADGE_SQL).toContain("supplier_claim_conversions");
    expect(CONVERTED_BADGE_SQL).toContain("t.kind = 'enter_quantity' AND t.done_at IS NULL");
    const s = missingSuggestion(asinRow(), [tracking()], NOW)!;
    const r = await suggestClaim(query, s);
    expect(r).toEqual({ created: true, id: 77, why: "created", superseded: [3099] }); // never its own id
    const dismiss = writes.find((w) => /^UPDATE supplier_claims SET status = 'dismissed'/.test(w.sql))!;
    expect(dismiss.params).toEqual([3099]);
    expect(writes.filter((w) => /^UPDATE supplier_claims SET status = 'dismissed'/.test(w.sql))).toHaveLength(1);
    const history = writes.find((w) => /po_edit_log/.test(w.sql) && w.params.some((p) => p === "claim dismissed" || (typeof p === "string" && p.includes("claim dismissed"))))!;
    expect(history).toBeTruthy();
    expect(JSON.stringify(history.params)).toContain(SUPERSEDED_REASON);
    const ev = writes.find((w) => /INSERT INTO supplier_claim_events/.test(w.sql) && w.params[1] === "dismissed")!;
    expect(ev.params.slice(0, 3)).toEqual([3099, "dismissed", SUPERSEDED_REASON]);
    // whole-PO: every converted badge claim on the PO
    writes.length = 0;
    expect(await supersedeConvertedOnLine(query, PO, null)).toEqual([3099, 3106]);
    expect(writes.filter((w) => /^UPDATE supplier_claims SET status = 'dismissed'/.test(w.sql)).map((w) => w.params[0])).toEqual([3099, 3106]);
    // dry run lists, writes nothing
    writes.length = 0;
    expect(await supersedeConvertedOnLine(query, PO, LINE, { dryRun: true })).toEqual([3099, 77]);
    expect(writes.filter((w) => /^UPDATE/.test(w.sql))).toHaveLength(0);
  });
  it("sweepSupersededConverted: every converted badge claim whose line carries a suggestion (any status) is dismissed; a dry run lists them", async () => {
    const writes: string[] = [];
    const query = async (sql: string, params?: any[]) => {
      if (/JOIN LATERAL/.test(sql)) {
        expect(sql).toContain("(s.po_line_item_id = c.po_line_item_id OR s.po_line_item_id IS NULL)");
        expect(sql).toContain("s.suggestion_key IS NOT NULL");
        expect(sql).toContain("c.po_line_item_id IS NOT NULL");
        return { rows: [{ claim_id: "3099", po_id: PO, order_id: "200015497641702", supplier: "walmart.com", po_line_item_id: LINE, product_name: "Balm", kind: "missing", suggestion_id: "4001", suggestion_kind: "canceled", suggestion_status: "suggested" }], rowCount: 1 };
      }
      if (/^SELECT \* FROM supplier_claims WHERE id = \$1/.test(sql)) return { rows: [{ id: params![0], po_id: PO, status: "open", outcome: null }], rowCount: 1 };
      writes.push(sql.replace(/\s+/g, " ").trim()); return { rows: [], rowCount: 1 };
    };
    const dry = await sweepSupersededConverted(query, { dryRun: true });
    expect(dry.rows.length).toBe(1);
    expect(dry.rows.map((r) => [r.claim_id, r.suggestion_id])).toEqual([[3099, 4001]]);
    expect(dry.dismissed).toBe(0);
    expect(writes.filter((w) => /^UPDATE/.test(w))).toHaveLength(0);
    const live = await sweepSupersededConverted(query);
    expect(live.dismissed).toBe(1);
    expect(writes.some((w) => /^UPDATE supplier_claims SET status = 'dismissed'/.test(w))).toBe(true);
  });
  it("sweepSuggestions reads the views only (open POs, Velocity POs for missing), groups by rule, and a dry run creates nothing", async () => {
    for (const sql of [MISSING_ROWS_SQL, PO_STATE_SQL, TRACKING_STATE_SQL]) {
      expect(sql).not.toMatch(/\b(a|l)\.qty\b|qty_shipped|qty_received|units_per_pack/);
    }
    expect(MISSING_ROWS_SQL).toContain("p.closed_at IS NULL AND p.ships_to = 'velocity'");
    expect(PO_STATE_SQL).toContain("WHERE p.closed_at IS NULL");
    expect(TRACKING_STATE_SQL).toContain("t.direction = 'inbound' AND t.tracking_number NOT LIKE 'email:%'");
    const writes: string[] = [];
    const query = async (sql: string) => {
      if (sql === MISSING_ROWS_SQL) return { rows: [asinRow()], rowCount: 1 };
      if (sql === PO_STATE_SQL) return { rows: [po(), po({ po_id: "33333333-3333-3333-3333-333333333333", order_id: "200099", tracking_rows_any: 0, order_date: "2026-10-01" })], rowCount: 2 };
      if (sql === TRACKING_STATE_SQL) return { rows: [tracking()], rowCount: 1 };
      if (/^SELECT po_id, po_line_item_id/.test(sql)) return { rows: [], rowCount: 0 };
      if (/information_schema\.columns/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      writes.push(sql); return { rows: [{ id: 1 }], rowCount: 1 };
    };
    const dry = await sweepSuggestions(query, NOW, { dryRun: true });
    expect(dry.created).toBe(0);
    expect(writes).toHaveLength(0);
    expect(dry.by_rule).toEqual({ missing_after_delivery: 1, nothing_after_order: 1 });
    expect(dry.suggestions.map((s) => [s.kind, s.order_id, s.outcome])).toEqual([["missing", "200015", "dry_run"], ["never_received", "200099", "dry_run"]]);
    const live = await sweepSuggestions(query, NOW);
    expect(live.created).toBe(2);
  });
  it("component 30 runs the suggestion sweep and the cancellation-email ingest beside the timer sweep", () => {
    const c30 = COMPONENTS.find((c) => c.n === 30)!;
    expect(c30.call).toContain("Gmail");
    const src = readFileSync(join(__dirname, "scheduler", "components", "30-claim-timers.ts"), "utf8");
    expect(src).toContain("claimTimerDeps.suggest(ctx.query, now)");
    expect(src).toContain("claimTimerDeps.cancellations({");
  });
});
