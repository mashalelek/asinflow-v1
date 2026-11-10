import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readClaimsUrl, writeClaimsUrl, rowsForView, groupNeedsAttention, qtyText, prefillMethod, CLAIM_COLUMNS, CLAIMS_TABLE_WIDTH, type ClaimRowApi } from "./claims";

// The Claims page (SPEC §22 "Supplier claims" §5, commit 2): URL state, the view's rows, the Needs attention groups, the labels.
const row = (over: Partial<ClaimRowApi>): ClaimRowApi => ({
  id: 1, po_id: "p", po_line_item_id: "l", kind: "missing", qty: 2, amount_owed: 10, amount_owed_source: "auto", status: "open", outcome: null, outcome_amount: null, outcome_detail: null, write_off_reason: null,
  found_at: "2026-11-01", found_by: "maria", reported_at: null, reported_channel: null, supplier_confirmed_at: null, closed_at: null, note: null, replacement_qty: null, replacement_shipped_at: null, replacement_arrived_at: null, return_required: false, qty_disposed: null,
  supplier: "walmart.com", order_id: "1", order_date: "2026-10-05", ships_to: "velocity", po_closed_at: null, alt_order_ids: null, asin: "B0", product_name: null, line_no: 1, product_pack: 1, asin_pack: 2, qty_basis: "individual",
  refunds: [], tasks: [], conversion_flags: [], owed: 10, remaining: 10, received: 0, bucket: "waiting_supplier", bucket_since: null, due_at: null, timed_out: false, days_in_bucket: 3, steps: [], step: "", next_action: "", ...over,
} as ClaimRowApi);

describe("Claims page URL state", () => {
  it("round-trips bucket(s), supplier, kind, po, the PO date range and the dismissed toggle; the default is the bare URL", () => {
    const s = { bucket: ["waiting_refund", "waiting_supplier"] as const, supplier: "michaels.com", kind: "canceled", po: "9500110801616249", from: "2026-06-01", to: "2026-06-17", dismissed: true };
    expect(readClaimsUrl(writeClaimsUrl({ ...s, bucket: [...s.bucket] }))).toEqual({ ...s, bucket: [...s.bucket] });
    expect(writeClaimsUrl(readClaimsUrl(""))).toBe("");
    expect(readClaimsUrl("").bucket).toEqual(["needs_attention"]);
    expect(readClaimsUrl("?bucket=nope,closed").bucket).toEqual(["closed"]);
    // the Dashboard's Refunds due link (metric-grid refundsDueHref)
    expect(readClaimsUrl("?bucket=waiting_refund,waiting_supplier&from=2026-06-01&to=2026-06-17")).toMatchObject({ bucket: ["waiting_refund", "waiting_supplier"], from: "2026-06-01", to: "2026-06-17" });
  });
  it("rowsForView: the tab's buckets, the PO date range; dismissed only on Closed with the toggle", () => {
    const rows = [row({ id: 1, bucket: "waiting_refund" }), row({ id: 2, bucket: "waiting_supplier", order_date: "2026-01-01" }), row({ id: 3, bucket: "closed" }), row({ id: 4, bucket: "dismissed" })];
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier")).map((r) => r.id)).toEqual([1, 2]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier&from=2026-06-01&to=2026-11-10")).map((r) => r.id)).toEqual([1]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=closed")).map((r) => r.id)).toEqual([3]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=closed&dismissed=1")).map((r) => r.id)).toEqual([3, 4]);
  });
});

describe("Needs attention groups, labels, the method prefill, the table", () => {
  it("a claim appears under each group where it has an OPEN ACTIVE task; the passive ticks (Refund received, Replacement arrived) never place it", () => {
    const t = (id: number, kind: string, done = false) => ({ id, kind: kind as any, group: "", reason: null, created_at: "2026-11-01T00:00:00Z", due_at: null, done_at: done ? "2026-11-02T00:00:00Z" : null, snoozed_until: null });
    const rows = [row({ id: 1, tasks: [t(1, "enter_quantity"), t(2, "refund_received")] }), row({ id: 2, tasks: [t(3, "contact_supplier", true), t(4, "check_on_it")] }), row({ id: 3, tasks: [t(5, "refund_received")] })];
    const g = groupNeedsAttention(rows);
    expect(g.map((x) => [x.group, x.rows.map((r) => r.claim.id)])).toEqual([["decide", [1]], ["timed_out", [2]]]);
    expect(g[0].rows[0].tasks.map((x) => x.kind)).toEqual(["enter_quantity"]);
  });
  it("qty text: the number, 'qty unknown', or 'unknown (sheet zeroed the line)'; the refund method prefills from the PO's first payment", () => {
    expect(qtyText({ qty: 5.5, conversion_flags: [] })).toBe("5.50");
    expect(qtyText({ qty: null, conversion_flags: ["qty_unknown"] })).toBe("qty unknown");
    expect(qtyText({ qty: null, conversion_flags: ["canceled_no_ordered_qty"] })).toBe("unknown (sheet zeroed the line)");
    expect(prefillMethod([{ method: "gift_card" }, { method: "card" }])).toBe("gift_card");
    expect(prefillMethod([])).toBe("card");
  });
  it("the table is fixed layout with content-sized widths that fit 1280 (docs/UI_RULES.md); the Qty header names its kind", () => {
    expect(CLAIMS_TABLE_WIDTH).toBeLessThanOrEqual(1280 - 48);
    expect(CLAIM_COLUMNS.find((c) => c.id === "qty")!.kind).toBe("Individual units");
    const page = readFileSync("client/src/pages/claims.tsx", "utf8");
    expect(page).toMatch(/table-fixed" style=\{\{ width: CLAIMS_TABLE_WIDTH, minWidth: "100%" \}\}/);
    expect(page).toMatch(/<colgroup>\{CLAIM_COLUMNS\.map/);
  });
});
