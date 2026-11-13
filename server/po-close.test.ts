import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { allUnitsAccounted, autoCloseVerdict, evaluateAutoClose, setPoClosedManually, parseQtyInput, MANUAL_QTY_COLUMNS } from "./po-close";
import type { QueryLike } from "./scheduler/types";

// Patch §5 (D2, D3): Closed is col 1; auto-close when every unit is
// accounted for AND no action items; auto never reopens a PO closed by hand
// or by the sheet backfill; a user can close/reopen with confirm. Since
// migration 101 (D14 / D15): Expected comes from the view (ordered − Σ claims
// that count) and an OPEN claim keeps the PO open.

const row = (o: Partial<Parameters<typeof allUnitsAccounted>[0][number]> = {}) => ({ qty_expected_asin: 10, qty_lost_damaged_us: null, qty_shipped_fba: null, ...o });

describe("auto-close verdict", () => {
  it("(a): every row shipped >= expected (ordered − claims) − lost, with at least one shipped unit", () => {
    expect(allUnitsAccounted([row({ qty_shipped_fba: "10" })])).toBe(true);
    expect(allUnitsAccounted([row({ qty_shipped_fba: "9" })])).toBe(false);
    // 10 ordered, 2 canceled + 1 returned as claims → the view's Expected is 7
    expect(allUnitsAccounted([row({ qty_shipped_fba: "7", qty_expected_asin: "7" })])).toBe(true);
    expect(allUnitsAccounted([row({ qty_shipped_fba: "8", qty_lost_damaged_us: "2" })])).toBe(true);
    expect(allUnitsAccounted([row({ qty_shipped_fba: "10" }), row({ qty_expected_asin: 3, qty_shipped_fba: "2" })])).toBe(false);
    // NULLs read as 0: a never-shipped PO is not "accounted for"
    expect(allUnitsAccounted([row()])).toBe(false);
    expect(allUnitsAccounted([])).toBe(false);
  });
  it("(a) 2026-11-13: nothing due and nothing shipped is accounted for when units were ordered — a fully canceled PO, or one whose every unit is a claim that counts", () => {
    // bathandbodyworks 00474317701906: 10 ordered, 10 canceled (claim closed), 0 shipped → closes (reads Canceled)
    expect(allUnitsAccounted([row({ qty: 10, qty_expected_asin: "0" })])).toBe(true);
    // yankeecandle HFUS09001835764: 90 ordered, 90 missing (claims closed), 0 shipped → closes (reads Closed)
    expect(allUnitsAccounted([row({ qty: "90", qty_expected_asin: "0" })])).toBe(true);
    // lost by us covers the rest
    expect(allUnitsAccounted([row({ qty: 10, qty_expected_asin: "2", qty_lost_damaged_us: "2" })])).toBe(true);
    // two rows, one canceled and one still due → open; one canceled and one shipped → closes as before
    expect(allUnitsAccounted([row({ qty: 10, qty_expected_asin: "0" }), row({ qty: 5, qty_expected_asin: "5" })])).toBe(false);
    expect(allUnitsAccounted([row({ qty: 10, qty_expected_asin: "0" }), row({ qty: 5, qty_expected_asin: "5", qty_shipped_fba: "5" })])).toBe(true);
    // rows that ordered nothing (the sheet era's canceled 0/0 rows: jellycat 8918590, supplyhouse 29050884) account for nothing
    expect(allUnitsAccounted([row({ qty: 0, qty_expected_asin: "0" })])).toBe(false);
    expect(allUnitsAccounted([row({ qty: null, qty_expected_asin: "0" })])).toBe(false);
  });
  it("(b): any open action item keeps the PO Open; (c) so does an open claim (D15)", () => {
    expect(autoCloseVerdict([row({ qty_shipped_fba: "10" })], [])).toBe(true);
    expect(autoCloseVerdict([row({ qty_shipped_fba: "10" })], ["See Comments"])).toBe(false);
    expect(autoCloseVerdict([row({ qty_shipped_fba: "10" })], [], 1)).toBe(false);
    expect(autoCloseVerdict([row({ qty_shipped_fba: "10" })], [], 0)).toBe(true);
  });
});

function fakePo(state: { closed_at: Date | null; closed_by: string | null; action_items: string[]; open_claims?: number }, rows: any[]) {
  const writes: string[] = [];
  const query: QueryLike = async (sql, params) => {
    const s = sql.replace(/\s+/g, " ").trim();
    // Row-level Status (2026-10-17): (b) reads the union of the PO's line action items.
    // PO_ACTION_ITEMS_SQL (the line union + the derived "Review Velocity", SPEC §26); (c) the open-claim count (D15, migration 101).
    if (s.startsWith("SELECT p.closed_at, p.closed_by, ARRAY(SELECT ai.item FROM po_line_action_items ai JOIN po_line_items l ON l.id = ai.po_line_item_id WHERE ai.cleared_at IS NULL AND l.po_id = p.id") && s.includes("AS action_items,") && s.includes("AS open_claims FROM purchase_orders p")) return { rows: [{ open_claims: 0, ...state }], rowCount: 1 };
    if (s.startsWith("SELECT pa.*")) return { rows, rowCount: rows.length };
    if (s.startsWith("UPDATE purchase_orders SET closed_at = NOW(), closed_by = 'auto'")) { writes.push("close:auto"); state.closed_at = new Date(); state.closed_by = "auto"; return { rows: [], rowCount: 1 }; }
    if (s.startsWith("UPDATE purchase_orders SET closed_at = NULL, closed_by = NULL") && s.includes("closed_by = 'auto'")) { writes.push("reopen:auto"); state.closed_at = null; state.closed_by = null; return { rows: [], rowCount: 1 }; }
    if (s.startsWith("UPDATE purchase_orders SET closed_at = NOW(), closed_by = $2")) { writes.push(`close:${params![1]}`); state.closed_at = new Date(); state.closed_by = params![1]; return { rows: [], rowCount: 1 }; }
    if (s.startsWith("UPDATE purchase_orders SET closed_at = NULL, closed_by = NULL")) { writes.push("reopen:manual"); state.closed_at = null; state.closed_by = null; return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected ${s.slice(0, 60)}`);
  };
  return { query, writes, state };
}

describe("evaluateAutoClose", () => {
  it("closes an Open PO when the rule holds, with closed_by = auto", async () => {
    const f = fakePo({ closed_at: null, closed_by: null, action_items: [] }, [row({ qty_shipped_fba: "10" })]);
    expect(await evaluateAutoClose("p1", f.query)).toEqual({ closed: true, closedBy: "auto", changed: "closed" });
    expect(f.writes).toEqual(["close:auto"]);
  });
  it("reopens an auto-closed PO when the rule stops holding (an action item appears / a qty edit)", async () => {
    const f = fakePo({ closed_at: new Date(), closed_by: "auto", action_items: ["Need to Return"] }, [row({ qty_shipped_fba: "10" })]);
    expect(await evaluateAutoClose("p1", f.query)).toEqual({ closed: false, closedBy: null, changed: "reopened" });
    expect(f.writes).toEqual(["reopen:auto"]);
  });
  it("never reopens a PO closed by the sheet backfill or by a user", async () => {
    for (const by of ["sheet", "4"]) {
      const f = fakePo({ closed_at: new Date(), closed_by: by, action_items: ["See Comments"] }, [row()]);
      expect(await evaluateAutoClose("p1", f.query)).toEqual({ closed: true, closedBy: by, changed: null });
      expect(f.writes).toEqual([]);
    }
  });
  it("leaves an Open PO open while the rule fails, and a closed one closed while it holds", async () => {
    const f1 = fakePo({ closed_at: null, closed_by: null, action_items: [] }, [row({ qty_shipped_fba: "3" })]);
    expect((await evaluateAutoClose("p1", f1.query)).changed).toBeNull();
    const f2 = fakePo({ closed_at: new Date(), closed_by: "auto", action_items: [] }, [row({ qty_shipped_fba: "10" })]);
    expect((await evaluateAutoClose("p1", f2.query)).changed).toBeNull();
  });
  it("manual close records the user; manual reopen clears both and a later evaluation can re-close only if the rule holds", async () => {
    const f = fakePo({ closed_at: null, closed_by: null, action_items: [] }, [row({ qty_shipped_fba: "3" })]);
    await setPoClosedManually("p1", true, 7, f.query);
    expect(f.state.closed_by).toBe("7");
    expect((await evaluateAutoClose("p1", f.query)).changed).toBeNull(); // auto does not reopen a user-closed PO
    await setPoClosedManually("p1", false, 7, f.query);
    expect(f.state.closed_at).toBeNull();
    expect((await evaluateAutoClose("p1", f.query)).changed).toBeNull(); // stays Open: 3 of 10 shipped
  });
});

describe("quantity input + routes", () => {
  it("parseQtyInput: empty = NULL (not tracked); negatives rejected; 2 dp", () => {
    expect(parseQtyInput("")).toEqual({ ok: true, value: null });
    expect(parseQtyInput(null)).toEqual({ ok: true, value: null });
    expect(parseQtyInput("1.166")).toEqual({ ok: true, value: 1.17 });
    expect(parseQtyInput(4)).toEqual({ ok: true, value: 4 });
    expect(parseQtyInput("-1").ok).toBe(false);
    expect(parseQtyInput("x").ok).toBe(false);
    expect(MANUAL_QTY_COLUMNS).toEqual(["qty_at_warehouse", "qty_lost_damaged_us", "qty_shipped_supplier"]);
  });
  it("the list defaults to Open only (D3) and accepts closed=open|closed|all", () => {
    // The list's filters moved to po-list-filters.ts (2026-11-06); behaviour in po-list-filters.test.ts.
    const s = readFileSync(join(__dirname, "routes.ts"), "utf8");
    const list = s.slice(s.indexOf('app.get("/api/pos"'), s.indexOf('app.get("/api/pos/:id"'));
    expect(list).toMatch(/const filters = parsePoListFilters\(req\.query/);
    const f = readFileSync(join(__dirname, "po-list-filters.ts"), "utf8");
    expect(f).toMatch(/const closedRaw = str\(q\.closed\)\.toLowerCase\(\) \|\| "open"/);
    expect(f).toMatch(/c === "open" \? `p\.closed_at IS NULL` : c === "closed" \? `p\.closed_at IS NOT NULL` : null/);
  });
  it("a refund row added / edited / removed re-runs the rule (a refund closes the claim that kept the PO open, 2026-11-13)", () => {
    const s = readFileSync(join(__dirname, "routes.ts"), "utf8");
    const block = s.slice(s.indexOf("const moneyRoutes = "), s.indexOf("// === Supplier claims"));
    expect((block.match(/\.then\(withRefundClose\)/g) ?? []).length).toBe(3);
    expect(block).toMatch(/table === "po_line_refunds" \? \{ \.\.\.out, close: await evaluateAutoClose\(out\.poId, poQuery\) \} : out/);
  });
  it("every quantity / shipment write re-runs the rule; the manual toggle records the user", () => {
    const s = readFileSync(join(__dirname, "routes.ts"), "utf8");
    const block = s.slice(s.indexOf("// === PO status + quantities"), s.indexOf("// === Bulk Profit Calculator"));
    expect((block.match(/await evaluateAutoClose\(/g) ?? []).length).toBe(10); // refund rows (withRefundClose, 2026-11-13), PO + ASIN + product action items, ASIN cancel, quantities, shipment add, shipment delete, Sync Shipments, supplier defects (one shared helper)
    expect(readFileSync(join(__dirname, "shipment-link.ts"), "utf8")).toMatch(/await evaluateAutoClose\(String\(pa\.po_id\), query\)/); // unmatched link (shipment-link.ts since 2026-10-29)
    expect(block).toMatch(/setPoClosedManually\(id, closed, req\.session\?\.userId \?\? null/);
    expect(block).toMatch(/VALUES \(\$1, 'manual:' \|\| uuid_generate_v4\(\)::text, \$2::text\[\], \$3, \$4, \$5, 'manual', 'none'\)/); // shipment-reconciliation §2: manual rows keyed manual:<uuid>
    // only the manual columns are writable
    expect(block).toMatch(/for \(const col of MANUAL_QTY_COLUMNS\)/);
  });
  it("the page: col 1 is the Closed toggle with confirm; Open/Closed/All filter defaults to open; nested rows editable", () => {
    const page = readFileSync(join(__dirname, "..", "client", "src", "pages", "purchase-orders.tsx"), "utf8");
    expect(page).toMatch(/useState<ClosedFilter>\(linked\.closed\)/); // readPoListUrl defaults it to "open" (lib/po-list-url.ts, 2026-11-06) // default Open — the ASINs-page On Order link too: On Order counts open POs only (2026-11-02)
    expect(page).toMatch(/params\.set\("closed", closedFilter\)/);
    expect(page).toMatch(/<ClosedToggle po=\{po\} onToggled=\{load\} canceled=\{poStatusLabel\(/);
    expect(page).toMatch(/data-testid="button-po-closed-confirm"/);
    expect(page).toMatch(/<PoAsinRow key=\{a\.id\} a=\{a\} indent editable onChanged=\{load\} po=\{\{ id: po\.id/);
    expect(page).toMatch(/<PoAsinTable asins=\{asins\} editable onChanged=\{reload\} po=\{\{ id: po\.id/);
  });
});
