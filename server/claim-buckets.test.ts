// The Claims page's rows and the detail come from ONE derivation (rowOf) — list and detail agree (Maria 2026-11-12);
// the refund-split targets. `npm run claims:list-detail-check -- --prod` is the read-only check over every claim.
import { describe, it, expect, vi } from "vitest";

const claims: any[] = [];
vi.mock("./supplier-claims", () => ({
  loadClaims: async (_q: unknown, where: { ids?: number[]; poId?: string; all?: boolean }) => claims.filter((c) => (where.ids ? where.ids.includes(c.id) : where.poId ? c.po_id === where.poId : true)),
  loadClaimEvents: async () => [],
  addTask: async () => {},
}));
import { loadClaimsPage, claimDetail, isSplitTarget } from "./claim-buckets";

const PO = "11111111-1111-1111-1111-111111111111";
const base = (over: Record<string, unknown>) => ({
  id: 1, po_id: PO, po_line_item_id: "l1", kind: "missing", qty: 2, amount_owed: 10, amount_owed_source: "auto", status: "open", outcome: null, outcome_amount: null, outcome_detail: null, write_off_reason: null,
  found_at: "2026-11-01", found_by: "maria", reported_at: null, reported_channel: null, supplier_confirmed_at: null, last_supplier_reply_at: null, closed_at: null, note: null, replacement_qty: null, replacement_shipped_at: null, replacement_arrived_at: null, return_required: false, qty_disposed: null,
  supplier: "walmart.com", order_id: "200015497641702", order_date: "2026-09-19", ships_to: "velocity", po_closed_at: null, alt_order_ids: null, asin: "B0GWG5S64Q", product_name: "Balm", line_no: 1, ordered: 12, product_pack: 1, asin_pack: 2, qty_basis: "individual",
  refunds: [], tasks: [], conversion_flags: [], owed: 10, remaining: 10, received: 0, ...over,
});
const query = async (sql: string): Promise<any> => {
  if (/FROM purchase_orders WHERE id/.test(sql)) return { rows: [{ id: PO, order_id: "200015497641702", supplier: "walmart.com", order_date: "2026-09-19", ships_to: "velocity", closed_at: null, alt_order_ids: null }] };
  if (/po_asin_expected/.test(sql)) return { rows: [{ n: "20" }] };
  return { rows: [] };
};
const NOW = new Date("2026-11-12T20:00:00Z");

describe("list and detail agree", () => {
  it("claim #3355's shape — an emailed cancellation, refund to card confirmed 9/23, a stray contact_supplier task: Waiting on refund to post on both, 'Refund confirmed 9/23 · check the card', Refund received, overdue", async () => {
    claims.length = 0;
    claims.push(base({ id: 3355, kind: "canceled", found_by: "email", outcome: "refund_card", supplier_confirmed_at: "2026-09-23T12:00:00Z", found_at: "2026-11-12", qty: 6, amount_owed: 35.22, owed: 35.22, remaining: 35.22,
      tasks: [{ id: 1, kind: "review_suggestion", group: "decide", done_at: "2026-11-12T18:00:00Z", created_at: "2026-11-12T17:00:00Z" }, { id: 2, kind: "contact_supplier", group: "supplier", done_at: null, created_at: "2026-11-12T18:00:00Z" }, { id: 3, kind: "refund_received", group: "money", done_at: null, created_at: "2026-11-12T18:00:00Z" }] }));
    claims.push(base({ id: 3356, kind: "canceled", found_by: "email", found_at: "2026-11-12", qty: 4, amount_owed: 19.88, owed: 19.88, remaining: 19.88, tasks: [{ id: 4, kind: "contact_supplier", group: "supplier", done_at: null, created_at: "2026-11-12T18:00:00Z" }] }));
    claims.push(base({ id: 3099, qty: null, amount_owed: null, owed: null, remaining: null, tasks: [{ id: 5, kind: "enter_quantity", group: "decide", done_at: null, created_at: "2026-11-10T02:00:00Z" }] }));
    claims.push(base({ id: 9, outcome: "replacement", qty: 1 }));
    const list = await loadClaimsPage(query, {}, NOW);
    const keys = ["bucket", "bucket_since", "due_at", "timed_out", "days_in_bucket", "step", "sentence", "next_action", "group"] as const;
    for (const row of list) {
      const d = (await claimDetail(query, row.id, NOW))!;
      for (const k of keys) expect(d.claim[k], `${row.id}.${k}`).toEqual(row[k]);
      expect(d.claim.action).toEqual(row.action);
      expect(d.claim.steps).toEqual(row.steps);
    }
    const r = list.find((x) => x.id === 3355)!;
    expect(r).toMatchObject({ bucket: "waiting_refund", bucket_since: "2026-09-23T12:00:00.000Z", timed_out: true, sentence: "Refund confirmed 9/23 · check the card", next_action: "Refund received", step: "Received", group: null });
    expect(r.action).toMatchObject({ kind: "refund", label: "Refund received" });
    // the other emailed cancellation (no confirmation stored): confirmed on its found date, waits for the refund, no contact tick wanted
    expect(list.find((x) => x.id === 3356)).toMatchObject({ bucket: "waiting_refund", sentence: "Refund confirmed 11/12 · check the card", next_action: "waiting for the refund to post" });
  });
  it("other_open_claims = the refund-split targets: open, a quantity, outcome unset or a refund / credit — never a converted empty claim or a replacement", async () => {
    const d = (await claimDetail(query, 3355, NOW))!;
    expect(d.other_open_claims.map((o) => o.id)).toEqual([3356]);
    expect(d.other_open_claims[0]).toMatchObject({ kind: "canceled", qty: 4, amount_owed: 19.88, outcome: null, remaining: 19.88 });
    expect(isSplitTarget({ status: "open", qty: 2, outcome: null })).toBe(true);
    expect(isSplitTarget({ status: "open", qty: 2, outcome: "gift_card" })).toBe(true);
    expect(isSplitTarget({ status: "open", qty: null, outcome: null })).toBe(false);
    expect(isSplitTarget({ status: "open", qty: 2, outcome: "replacement" })).toBe(false);
    expect(isSplitTarget({ status: "open", qty: 2, outcome: "write_off" })).toBe(false);
    expect(isSplitTarget({ status: "suggested", qty: 2, outcome: null })).toBe(false);
  });
});
