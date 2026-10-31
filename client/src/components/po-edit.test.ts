import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { headerChanges, editText, ymdOf, ORDER_ID_WARNING } from "./po-edit";

// po-af-owned §3 (2026-10-18): the PO edit drawer sends only changed fields.
describe("PO edit drawer", () => {
  const po = { id: "p", supplier: "walmart.com", order_id: "111", order_date: "2026-10-18T04:00:00.000Z", subtotal: "12.50", tax: "0.00", notes: null, cashback_pct: null };
  it("stored values read without float noise; dates as YYYY-MM-DD", () => {
    expect(editText("12.50")).toBe("12.5");
    expect(editText(null)).toBe("");
    expect(ymdOf("2026-10-18")).toBe("2026-10-18");
  });
  it("only the edited fields are sent", () => {
    const draft = { supplier: "walmart.com", order_id: "111_1", order_date: ymdOf(po.order_date), subtotal: "12.5", tax: "0", notes: "dented", cashback_pct: "" };
    expect(headerChanges(po, draft)).toEqual({ order_id: "111_1", notes: "dented" });
  });
  it("the order # warning text is the patch's, and the drawer shows it when supplier / order # change", () => {
    expect(ORDER_ID_WARNING).toBe("order # is how shipments are matched from Velocity; changing it re-matches on the next Sync Shipments");
    const src = readFileSync(resolve(__dirname, "po-edit.tsx"), "utf8");
    expect(src).toMatch(/const orderKeyChanged = "order_id" in changes \|\| "supplier" in changes;/);
  });
  it("PO detail has Edit PO, editable Products and a History tab; ASIN rows edit cost / prep / sold as / units per pack", () => {
    const page = readFileSync(resolve(__dirname, "../pages/purchase-orders.tsx"), "utf8");
    expect(page).toMatch(/data-testid="button-edit-po"/);
    expect(page).toMatch(/\["history", "History"\]/);
    expect(page).toMatch(/<PoHistory poId=\{po\.id\} reloadKey=\{version\} \/>/);
    const rows = readFileSync(resolve(__dirname, "po-asin-rows.tsx"), "utf8");
    for (const f of ["cost_per_unit", "prep_cost", "sold_as", "units_per_pack"]) expect(rows).toContain(`saveAsin("${f}")`);
  });
});

describe("New PO form (po-af-owned §4)", () => {
  it("the POs page's + New PO opens the form (no longer disabled 'Soon'); the dialog validates with the shared checkPoForm and posts the plain JSON state", () => {
    const page = readFileSync(resolve(__dirname, "../pages/purchase-orders.tsx"), "utf8");
    expect(page).toMatch(/<Button variant="default" size="sm" onClick=\{\(\) => setNewPoOpen\(true\)\} data-testid="button-new-po">/);
    expect(page).not.toMatch(/Soon — arrives with the entry form/);
    expect(page).toMatch(/onCreated=\{\(id\) => navigate\(`\/purchase-orders\/\$\{id\}`\)\}/);
    const dlg = readFileSync(resolve(__dirname, "new-po-dialog.tsx"), "utf8");
    expect(dlg).toMatch(/const check = useMemo\(\(\) => checkPoForm\(form\), \[form\]\);/);
    expect(dlg).toMatch(/fetch\("\/api\/pos", \{ method: "POST", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(\{ \.\.\.settled\.form, ships_to: shipsTo \}\) \}\)/);
    // The ASIN picker (po-ai-prefill §6.4, 2026-10-31): history from the same supplier first, then title matches, then the typed search.
    expect(dlg).toMatch(/fetch\(`\/api\/pos\/asin-suggest\?\$\{u\}`\)/);
  });
});

describe("§5 delete / cancel / reassign UI", () => {
  it("the §5.1 block text and the §5.3 confirm text", async () => {
    const { shipmentBlockText, deleteConfirmText } = await import("./po-edit");
    expect(shipmentBlockText([])).toBeNull();
    expect(shipmentBlockText([{ qty_shipped: "9.00", fba_shipment_ids: ["FBA19GQG1TDR"] }, { qty_shipped: "1", fba_shipment_ids: ["FBA19GQHT7BL", "FBA19GQG1TDR"] }]))
      .toBe("10 units shipped to FBA in FBA19GQG1TDR, FBA19GQHT7BL. Reassign the shipment to another PO first.");
    expect(deleteConfirmText({ supplier: "walmart.com", orderId: "200015415094735", lineCount: 2, asinCount: 1, atPrepUnits: 0 }))
      .toBe("Delete PO walmart.com 200015415094735 with its 2 products (1 ASIN)? Sync POs will not import it again.");
    expect(deleteConfirmText({ supplier: "walmart.com", orderId: "1", lineCount: 1, asinCount: 1, atPrepUnits: 2 })).toMatch(/ 2 units still at Velocity for this PO\.$/);
  });
  it("PO detail carries Cancel PO / Delete PO (disabled with the message when blocked); ASIN rows disable cancel when shipped; shipments offer Reassign", () => {
    const page = readFileSync(resolve(__dirname, "../pages/purchase-orders.tsx"), "utf8");
    expect(page).toMatch(/<PoDangerActions poId=\{po\.id\} reloadKey=\{version\} onCanceled=\{reload\} onDeleted=\{\(\) => navigate\("\/purchase-orders"\)\} \/>/);
    const src = readFileSync(resolve(__dirname, "po-edit.tsx"), "utf8");
    expect(src).toMatch(/disabled=\{!!g\.blocked\} onClick=\{\(\) => setConfirm\("delete"\)\}/);
    expect(src).toMatch(/disabled=\{!!g\.blocked\} onClick=\{\(\) => setConfirm\("cancel"\)\}/);
    const rows = readFileSync(resolve(__dirname, "po-asin-rows.tsx"), "utf8");
    expect(rows).toMatch(/const blocked = shipmentBlockText\(a\.shipments \?\? \[\]\);/);
    expect(rows).toMatch(/\{editable && <ReassignShipment shipment=\{s\} asin=\{asin\} currentRowId=\{rowId\}/);
  });
});
