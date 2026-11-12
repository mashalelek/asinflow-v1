import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readClaimsUrl, writeClaimsUrl, rowsForView, groupNeedsAttention, matchesFilter, qtyText, prefillMethod, productText, CLAIM_COLUMNS, CLAIMS_TABLE_WIDTH, type ClaimRowApi } from "./claims";

// The Claims page (SPEC §22 "Supplier claims" §5 amended 2026-11-12, commit 2b): URL state, the filter box, the view's rows, the Needs attention groups, the labels, the table.
const row = (over: Partial<ClaimRowApi>): ClaimRowApi => ({
  id: 1, po_id: "p", po_line_item_id: "l", kind: "missing", qty: 2, amount_owed: 10, amount_owed_source: "auto", status: "open", outcome: null, outcome_amount: null, outcome_detail: null, write_off_reason: null,
  found_at: "2026-11-01", found_by: "maria", reported_at: null, reported_channel: null, supplier_confirmed_at: null, last_supplier_reply_at: null, closed_at: null, note: null, replacement_qty: null, replacement_shipped_at: null, replacement_arrived_at: null, return_required: false, qty_disposed: null,
  supplier: "walmart.com", order_id: "1", order_date: "2026-10-05", ships_to: "velocity", po_closed_at: null, alt_order_ids: null, asin: "B0", product_name: null, line_no: 1, ordered: 24, product_pack: 1, asin_pack: 2, qty_basis: "individual",
  refunds: [], tasks: [], conversion_flags: [], owed: 10, remaining: 10, received: 0, bucket: "waiting_supplier", bucket_since: null, due_at: null, timed_out: false, days_in_bucket: 3, days_open: 11, steps: [], step: "", next_action: "",
  sentence: "", action: { kind: "none", label: "", secondary: null }, group: null, ui_steps: [], next: [], ...over,
} as ClaimRowApi);

describe("Claims page URL state", () => {
  it("round-trips bucket(s), the filter box, kind, the PO date range and the dismissed toggle; the default is the bare URL; old po= / supplier= links still read", () => {
    const s = { bucket: ["waiting_refund", "waiting_supplier"] as const, q: "michaels.com", kind: "canceled", from: "2026-06-01", to: "2026-06-17", dismissed: true };
    expect(readClaimsUrl(writeClaimsUrl({ ...s, bucket: [...s.bucket] }))).toEqual({ ...s, bucket: [...s.bucket] });
    expect(writeClaimsUrl(readClaimsUrl(""))).toBe("");
    expect(readClaimsUrl("").bucket).toEqual(["needs_attention"]);
    expect(readClaimsUrl("?bucket=nope,closed").bucket).toEqual(["closed"]);
    expect(readClaimsUrl("?po=9500110801616249").q).toBe("9500110801616249");
    // the Dashboard's Refunds due link (metric-grid refundsDueHref)
    expect(readClaimsUrl("?bucket=waiting_refund,waiting_supplier&from=2026-06-01&to=2026-06-17")).toMatchObject({ bucket: ["waiting_refund", "waiting_supplier"], from: "2026-06-01", to: "2026-06-17" });
  });
  it("rowsForView: the tab's buckets, the filter box (supplier / PO / alternate / ASIN / product), the kind, the PO date range; dismissed only on Closed with the toggle", () => {
    const rows = [row({ id: 1, bucket: "waiting_refund" }), row({ id: 2, bucket: "waiting_supplier", order_date: "2026-01-01", supplier: "michaels.com", product_name: "Red Heart yarn", alt_order_ids: "R4600" }), row({ id: 3, bucket: "closed" }), row({ id: 4, bucket: "dismissed" })];
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier")).map((r) => r.id)).toEqual([1, 2]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier&from=2026-06-01&to=2026-11-10")).map((r) => r.id)).toEqual([1]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier&q=yarn")).map((r) => r.id)).toEqual([2]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier&q=r4600")).map((r) => r.id)).toEqual([2]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=closed")).map((r) => r.id)).toEqual([3]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=closed&dismissed=1")).map((r) => r.id)).toEqual([3, 4]);
    expect(matchesFilter(row({ asin: "B07N6V47HC" }), "b07n6")).toBe(true);
    expect(matchesFilter(row({}), "")).toBe(true);
  });
});

describe("Needs attention groups, labels, the method prefill, the table", () => {
  it("a row sits under the server's group (its primary action's task group); rows without a group are left out", () => {
    const rows = [row({ id: 1, group: "decide" }), row({ id: 2, group: "timed_out" }), row({ id: 3, group: null }), row({ id: 4, group: "decide" })];
    expect(groupNeedsAttention(rows).map((x) => [x.group, x.rows.map((r) => r.id)])).toEqual([["decide", [1, 4]], ["timed_out", [2]]]);
  });
  it("qty text, the product cell and the refund method prefill", () => {
    expect(qtyText({ qty: 5.5, conversion_flags: [] })).toBe("5.50");
    expect(qtyText({ qty: null, conversion_flags: ["qty_unknown"] })).toBe("qty unknown");
    expect(qtyText({ qty: null, conversion_flags: ["canceled_no_ordered_qty"] })).toBe("unknown (sheet zeroed the line)");
    expect(productText(row({ product_name: "Caress Body Wash 2-pk", asin: "B006T0U4R4" }))).toEqual({ main: "Caress Body Wash 2-pk", sub: "B006T0U4R4" });
    expect(productText(row({ po_line_item_id: null, kind: "canceled" }))).toEqual({ main: "Whole order", sub: "all lines" });
    expect(prefillMethod([{ method: "gift_card" }, { method: "card" }])).toBe("gift_card");
    expect(prefillMethod([])).toBe("card");
  });
  it("the table is fixed layout with content-sized widths that fit 1280 (docs/UI_RULES.md); the mockup's nine columns; the Qty header names its kind", () => {
    expect(CLAIMS_TABLE_WIDTH).toBeLessThanOrEqual(1280 - 48);
    expect(CLAIM_COLUMNS.map((c) => c.label)).toEqual(["Supplier · PO", "Product", "Kind", "Qty", "Owed / left", "Step", "Waiting", "Do"]);
    expect(CLAIM_COLUMNS.find((c) => c.id === "qty")!.kind).toBe("Individual units");
    const page = readFileSync("client/src/pages/claims.tsx", "utf8");
    expect(page).toMatch(/table-fixed" style=\{\{ width: CLAIMS_TABLE_WIDTH, minWidth: "100%" \}\}/);
    expect(page).toMatch(/<colgroup>\{CLAIM_COLUMNS\.map/);
    // the detail's three columns and its action buttons; nothing says "waiting" before the report (the words come from shared/claim-ui.ts)
    expect(page).toContain('gridTemplateColumns: "340px minmax(0, 1fr) 360px"');
    for (const id of ["button-claim-contacted", "button-claim-replied", "button-claim-set-outcome", "button-claim-more", "button-claim-refund-received", "claim-next", "claim-more"]) expect(page).toContain(id);
  });
});
