import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ACTION_ITEMS, mapSheetStatus, normalizeActionItems } from "./po-status-map";

// Patch §6 + §6.4 (pre-flight decisions 2–3, 2026-10-16): the sheet's
// free-text Status becomes action_items + Closed + per-line qty_canceled.

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("mapSheetStatus", () => {
  it("maps every token P5 found in the PO mirror — nothing unmapped", () => {
    const p5 = ["Closed", "Ordered", "SHIP", "Canceled", "See comments", "Missing / damaged from supplier", "ATTN: Velocity",
      "Received Partial", "Received", "Received - FBM", "Returned", "Confirm refund / replacement"];
    for (const t of p5) expect(mapSheetStatus(t).unmapped, t).toEqual([]);
  });
  it("\"Lost / Damaged by Us\" and \"Partial Return\" are mapped, never a stop (Maria 2026-10-18, all years)", () => {
    expect(mapSheetStatus("Closed, Lost / Damaged by Us")).toMatchObject({ closed: true, lostDamagedUs: true, unmapped: [] });
    expect(mapSheetStatus("Partial Return")).toMatchObject({ returned: true, unmapped: [] });
  });
  it("\"Shipped FBA\" (appeared 2026-10-16, fleetfarm MW7400517) maps to nothing — never an action item, never a stop", () => {
    const m = mapSheetStatus("Shipped FBA, Confirm refund / replacement");
    expect(m).toMatchObject({ shippedFba: true, unmapped: [], actionItems: ["Confirm refund / replacement"], closed: false });
  });
  it("splits on commas, keeps action items in display order, dedupes", () => {
    const m = mapSheetStatus("See comments, ATTN: Velocity, see comments");
    expect(m.actionItems).toEqual(["ATTN: Velocity", "See comments"]);
    expect(m.closed).toBe(false);
  });
  it("Closed → closed; Canceled → canceled; Returned / Received / Received Partial / Ordered → flags only", () => {
    expect(mapSheetStatus("Closed, Canceled")).toMatchObject({ closed: true, canceled: true, actionItems: [] });
    expect(mapSheetStatus("Closed, Returned")).toMatchObject({ closed: true, returned: true });
    expect(mapSheetStatus("Received Partial, Closed")).toMatchObject({ closed: true, received: true });
    expect(mapSheetStatus("Received, ATTN: Velocity")).toMatchObject({ received: true, actionItems: ["ATTN: Velocity"] });
    expect(mapSheetStatus("Ordered")).toMatchObject({ ordered: true, actionItems: [], closed: false });
    expect(mapSheetStatus("Closed, Received - FBM")).toMatchObject({ closed: true, actionItems: ["Received - FBM"] });
  });
  it("an unknown token is reported, never guessed", () => {
    const m = mapSheetStatus("Closed, Lost in transit");
    expect(m.unmapped).toEqual(["Lost in transit"]);
    expect(m.closed).toBe(true);
  });
  it("blank / NULL → no tokens, nothing", () => {
    expect(mapSheetStatus(null)).toMatchObject({ tokens: [], actionItems: [], closed: false, canceled: false });
  });
});

describe("normalizeActionItems", () => {
  it("accepts known values, dedupes, orders; rejects unknown", () => {
    expect(normalizeActionItems(["SHIP", "Need to return", "SHIP"])).toEqual({ ok: true, value: ["Need to return", "SHIP"] });
    expect(normalizeActionItems([])).toEqual({ ok: true, value: [] });
    expect(normalizeActionItems(["Lost"]).ok).toBe(false);
    expect(normalizeActionItems("SHIP").ok).toBe(false);
    expect(ACTION_ITEMS).toHaveLength(7);
  });
});

describe("consumers switched (§6.3)", () => {
  it("the list route filters on action_items (any-of) and the Closed state; nothing reads the old status column", () => {
    const routes = read("server/routes.ts");
    const list = routes.slice(routes.indexOf('app.get("/api/pos"'), routes.indexOf('app.get("/api/pos/:id"'));
    // Row-level Status (2026-10-17): the filter is any-of over the PO's LINE action items.
    expect(list).toMatch(/ai\.item = ANY\(\$\$\{params\.length\}::text\[\]\)/);
    expect(list).not.toMatch(/p\.status ILIKE|string_to_array\(status/);
    // The filter options: the stored items + the derived "Review Velocity" (SPEC §26).
    expect(list).toMatch(/actionItems: DISPLAY_ACTION_ITEMS/);
    const block = routes.slice(routes.indexOf("// === PO status + quantities"), routes.indexOf("// === Bulk Profit Calculator"));
    expect(block).toMatch(/app\.patch\("\/api\/pos\/asin-rows\/:id\/action-items"/);
    expect(block).toMatch(/app\.patch\("\/api\/pos\/lines\/:id\/action-items"/);
    expect(block).toMatch(/normalizeActionItems\(/);
    expect((block.match(/await evaluateAutoClose\(/g) ?? []).length).toBe(7); // ASIN + product action items, ASIN cancel, quantities, shipments ×2, Sync Shipments (the unmatched link: shipment-link.ts)
  });
  it("the importer writes action_items / closed_at / qty_canceled and never the status column", () => {
    const imp = read("script/import-po-2026.ts");
    expect(imp).toMatch(/mapSheetStatus\(/);
    expect(imp).toMatch(/INSERT INTO purchase_orders \(order_id, order_date, supplier, action_items, closed_at, closed_by,/);
    expect(imp).not.toMatch(/INSERT INTO purchase_orders \([^)]*\bstatus\b/);
    expect(imp).toMatch(/p\.canceledFromSheet \? l\.qtyOrdered : null/);
    expect(imp).toMatch(/unmapped token\(s\)/);
  });
  it("the one-time value migration is dry-run by default and stops on an unmapped value", () => {
    const s = read("script/migrate-po-status.ts");
    expect(s).toMatch(/const LIVE = process\.argv\.includes\("--live"\)/);
    expect(s).toMatch(/UNMAPPED VALUES — STOP, nothing written/);
    expect(s).toMatch(/closed_at = COALESCE\(closed_at, updated_at, NOW\(\)\), closed_by = 'sheet' WHERE id = \$1 AND closed_at IS NULL/);
    expect(s).toMatch(/SET qty_canceled = qty_ordered WHERE po_id = ANY\(\$1::uuid\[\]\) AND qty_canceled IS NULL/);
    expect(JSON.parse(read("package.json")).scripts["migrate:po-status"]).toBe("tsx script/migrate-po-status.ts");
  });
  it("the page renders Action Items chips with an inline editor and filters on them; no status chips remain", () => {
    const page = read("client/src/pages/purchase-orders.tsx");
    // Row-level Status (2026-10-17): the PO column is the read-only union; editing moved to ASIN / product rows.
    expect(page).toMatch(/<ActionItemChips items=\{po\.action_items\} reasons=\{po\.review_velocity_reasons\} testId=\{`po-action-items-\$\{po\.order_id\}`\} \/>/);
    expect(page).toMatch(/params\.set\("action", actionKey\)/);
    expect(page).not.toMatch(/statusChipClass|po\.status\b|statusTokens/);
  });
});
