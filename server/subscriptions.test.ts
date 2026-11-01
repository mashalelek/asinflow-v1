import { describe, it, expect } from "vitest";
import { alertDue, runSubscriptionAlerts, subscriptionsFromForm, qtyPriceNear, tryRenewalFromEmail, updateSubscription } from "./subscriptions";

// po-ai-prefill §9 / SPEC §27.
describe("alert timing", () => {
  it("'Subscription renews' is due from 7 days before the next order until 14 days after; never for paused / canceled or undated", () => {
    expect(alertDue({ status: "active", next_order_date: "2026-11-08" }, "2026-10-31")).toBe(false); // 8 days out
    expect(alertDue({ status: "active", next_order_date: "2026-11-07" }, "2026-10-31")).toBe(true);  // 7 days out
    expect(alertDue({ status: "active", next_order_date: "2026-10-31" }, "2026-10-31")).toBe(true);
    expect(alertDue({ status: "active", next_order_date: "2026-10-17" }, "2026-10-31")).toBe(true);  // 14 days overdue
    expect(alertDue({ status: "active", next_order_date: "2026-10-16" }, "2026-10-31")).toBe(false); // 15 days overdue: the page shows it, no item
    expect(alertDue({ status: "paused", next_order_date: "2026-11-01" }, "2026-10-31")).toBe(false);
    expect(alertDue({ status: "active", next_order_date: null }, "2026-10-31")).toBe(false);
  });
  it("runSubscriptionAlerts raises on the last PO's lines when due and clears when not", async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const q = async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/FROM subscriptions$/.test(sql.trim())) return { rows: [
        { id: 1, status: "active", next_order_date: "2026-11-03", last_po_id: "p1", supplier: "drmartypets.com", asin: "B0A" },
        { id: 2, status: "canceled", next_order_date: "2026-11-03", last_po_id: "p2", supplier: "chewy.com", asin: "B0B" },
        { id: 3, status: "active", next_order_date: "2026-01-03", last_po_id: "p3", supplier: "amsoil.com", asin: "B0C" },
      ], rowCount: 3 };
      if (/SELECT id FROM po_line_items WHERE po_id/.test(sql)) return { rows: [{ id: `${params[0]}-l1` }], rowCount: 1 };
      if (/UPDATE po_line_action_items/.test(sql)) return { rows: [], rowCount: params[0] === "p2" ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    };
    const r = await runSubscriptionAlerts(q, "2026-10-31");
    expect(r).toEqual({ due: 1, raised: 1, cleared: 1, overdue: 1 });
    const ins = calls.find((c) => /INSERT INTO po_line_action_items/.test(c.sql))!;
    expect(ins.params).toEqual(["p1-l1", ["Subscription renews"], "auto", "drmartypets.com B0A: next order 2026-11-03"]);
    expect(calls.filter((c) => /UPDATE po_line_action_items/.test(c.sql)).map((c) => c.params[0])).toEqual(["p2", "p3"]);
  });
});

describe("form hook and page edits", () => {
  it("'Subscription: yes · every 4 weeks' on a saved PO upserts one row per ASIN row with the next date", async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const q = async (sql: string, params: any[] = []) => { calls.push({ sql, params }); if (/SELECT id FROM subscriptions WHERE supplier/.test(sql)) return { rows: params[1] === "B0OLD" ? [{ id: 9 }] : [], rowCount: 0 }; return { rows: [], rowCount: 1 }; };
    const n = await subscriptionsFromForm(q, "po1", { supplier: "drmartypets.com", order_date: "2026-10-31", subscription: { present: true, frequency_weeks: "4" }, prefill: { id: "abc", sources: {} } }, [{ id: "pa1", asin: "B0NEW", asin_name: "Nature's Blend" }, { id: "pa2", asin: "B0OLD", asin_name: null }]);
    expect(n).toBe(2);
    expect(calls.find((c) => /INSERT INTO subscriptions/.test(c.sql))!.params).toEqual(["drmartypets.com", "pa1", "B0NEW", "Nature's Blend", 4, "2026-11-28", "po1", "capture"]);
    expect(calls.find((c) => /UPDATE subscriptions SET last_po_id/.test(c.sql))!.params).toEqual([9, "po1", "pa2", 4, "2026-11-28"]);
    expect(await subscriptionsFromForm(q, "po1", { supplier: "x", order_date: "2026-10-31", subscription: { present: false, frequency_weeks: "" } }, [])).toBe(0);
  });
  it("a pause from the page clears the open alert on the last PO and logs the change in that PO's History", async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const q = async (sql: string, params: any[] = []) => { calls.push({ sql, params }); if (/SELECT \* FROM subscriptions WHERE id/.test(sql)) return { rows: [{ id: 1, status: "active", frequency_weeks: 4, next_order_date: new Date(2026, 10, 3), last_po_id: "p1", notes: null }], rowCount: 1 }; return { rows: [], rowCount: 1 }; };
    const r = await updateSubscription(q, 1, { status: "paused", frequency_weeks: "4" }, 7);
    expect(r).toEqual({ id: 1, changes: ["status"] });
    expect(calls.find((c) => /UPDATE subscriptions SET status/.test(c.sql))!.params).toEqual([1, "paused"]);
    expect(calls.some((c) => /UPDATE po_line_action_items/.test(c.sql) && c.params[0] === "p1" && c.params[2] === "manual")).toBe(true);
    expect(calls.find((c) => /INSERT INTO po_edit_log/.test(c.sql))!.params.slice(3)).toEqual(["p1", "subscription status", "active", "paused"]);
    await expect(updateSubscription(q, 1, { status: "gone" }, 7)).rejects.toMatchObject({ status: 400 });
  });
});

describe("renewal from a confirmation email", () => {
  const email = { id: "m9", subject: "Confirmed! Your subscription has been renewed", date: new Date(2026, 9, 31), orderId: "ORD-175000001", total: 73.05,
    text: "Order #: ORD-175000001\nDr. Marty Nature's Blend Essential Wellness 16oz\nQty: 2  $36.00\nVisa ending in 7927\nOrder total: $73.05" };
  it("reads the qty and price printed near a product name", () => {
    expect(qtyPriceNear(email.text, "Dr. Marty Nature's Blend Essential Wellness 16oz")).toEqual({ qty: 2, price: 36 });
    expect(qtyPriceNear(email.text, "Something else entirely")).toEqual({ qty: null, price: null });
  });
  it("creates the renewal PO from the last PO with the email's qty / price, a payment row, Review renewal PO, and advances the subscription", async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    let n = 0, subStatus = "active";
    const q = async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/FROM subscriptions s WHERE s.status IN \('active', 'canceled'\)/.test(sql)) return { rows: [{ id: 5, status: subStatus, last_po_id: "old", frequency_weeks: 4, asin: "B0DS6KY94H" }], rowCount: 1 };
      if (/SELECT \* FROM purchase_orders WHERE id/.test(sql)) return { rows: [{ id: "old", supplier: "drmartypets.com", order_id: "ORD-174000000", subtotal: "70.00", order_total: "70.00", payment_method: "Visa (7927)", weighted_gc_discount_pct: null, purchased_by: "Maria", purchased_by_user_id: 1, email_used: null, ships_to: "velocity" }], rowCount: 1 };
      if (/SELECT \* FROM po_asins WHERE po_id/.test(sql)) return { rows: [{ id: "pa-old", asin: "B0DS6KY94H", asin_name: "Nature's Blend", sku: "NB-1", qty: "2", cost_per_unit: "35.00", prep_cost: "1.00", sold_as: "individual", units_per_pack: 1, unique_products: null, sourcing_cost: "35.00", paid_cost: "35.00" }], rowCount: 1 };
      if (/SELECT \* FROM po_line_items WHERE po_id/.test(sql)) return { rows: [{ id: "l-old", po_asin_id: "pa-old", position: 0, product_name: "Dr. Marty Nature's Blend Essential Wellness 16oz", supplier_sku: null, price: "35.00", qty_ordered: "2", asin_qty_per_product: "1", adjusted_product_cost: "35.00" }], rowCount: 1 };
      if (/SELECT id FROM purchase_orders WHERE supplier/.test(sql)) return { rows: [], rowCount: 0 };
      if (/RETURNING id/.test(sql)) return { rows: [{ id: `new${++n}` }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    const r = await tryRenewalFromEmail(q, "drmartypets.com", email);
    expect(r).toEqual({ created: true, poId: "new1", subscriptionIds: [5], item: "Review renewal PO" });
    const po = calls.find((c) => /INSERT INTO purchase_orders/.test(c.sql))!;
    expect(po.sql).toMatch(/'email_renewal'/);
    expect(po.params.slice(0, 5)).toEqual(["ORD-175000001", "2026-10-31", "drmartypets.com", 73.05, 73.05]);
    const line = calls.find((c) => /INSERT INTO po_line_items/.test(c.sql))!;
    expect(line.params[1]).toBe("new2"); // the copied ASIN row
    expect(line.params[5]).toBe("36.00"); expect(line.params[6]).toBe(2);
    expect(calls.find((c) => /INSERT INTO po_payments/.test(c.sql))!.params).toEqual(["new1", "Visa", "7927", 73.05]);
    expect(calls.find((c) => /INSERT INTO po_line_action_items/.test(c.sql))!.params.slice(0, 3)).toEqual(["new3", ["Review renewal PO"], "auto"]);
    expect(calls.find((c) => /UPDATE subscriptions SET last_po_id/.test(c.sql))!.params).toEqual([5, "new1", "2026-11-28"]);
    expect(calls.some((c) => /UPDATE po_line_action_items/.test(c.sql) && c.params[0] === "old")).toBe(true);
    expect(await tryRenewalFromEmail(q, null, email)).toEqual({ created: false, reason: "unknown sender" });

    // Maria 2026-11-01: a CANCELED subscription still gets the PO, with "Subscription may be active"; its status and date stay.
    subStatus = "canceled"; calls.length = 0; n = 0;
    const c = await tryRenewalFromEmail(q, "drmartypets.com", email);
    expect(c).toEqual({ created: true, poId: "new1", subscriptionIds: [5], item: "Subscription may be active" });
    expect(calls.find((x) => /INSERT INTO po_line_action_items/.test(x.sql))!.params.slice(0, 3)).toEqual(["new3", ["Subscription may be active"], "auto"]);
    expect(calls.find((x) => /UPDATE subscriptions SET last_po_id/.test(x.sql))!.params).toEqual([5, "new1", null]);
  });
});
