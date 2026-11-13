import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readClaimsUrl, writeClaimsUrl, rowsForView, groupNeedsAttention, decideOrder, matchesFilter, qtyText, prefillMethod, productText, CLAIM_COLUMNS, CLAIMS_TABLE_WIDTH, CLAIMS_GRID, claimsGrid, resizableClaimColumn, CLAIMS_COL_WIDTHS_KEY, NOTE_CLAMP_LINES, type ClaimRowApi } from "./claims";

// The Claims page (SPEC §22 "Supplier claims" §5 amended 2026-11-12, commit 2b): URL state, the filter box, the view's rows, the Needs attention groups, the labels, the table.
const row = (over: Partial<ClaimRowApi>): ClaimRowApi => ({
  id: 1, po_id: "p", po_line_item_id: "l", kind: "missing", qty: 2, amount_owed: 10, amount_owed_source: "auto", status: "open", outcome: null, outcome_amount: null, outcome_detail: null, write_off_reason: null,
  found_at: "2026-11-01", found_by: "maria", reported_at: null, reported_channel: null, supplier_confirmed_at: null, last_supplier_reply_at: null, closed_at: null, note: null, replacement_qty: null, replacement_shipped_at: null, replacement_arrived_at: null, return_required: false, qty_disposed: null,
  supplier: "walmart.com", order_id: "1", order_date: "2026-10-05", ships_to: "velocity", po_closed_at: null, alt_order_ids: null, asin: "B0", product_name: null, supplier_sku: null, line_no: 1, ordered: 24, product_pack: 1, asin_pack: 2, qty_basis: "individual",
  refunds: [], tasks: [], conversion_flags: [], owed: 10, remaining: 10, received: 0, bucket: "waiting_supplier", bucket_since: null, due_at: null, timed_out: false, days_in_bucket: 3, days_open: 11, steps: [], step: "", next_action: "",
  sentence: "", action: { kind: "none", label: "", secondary: null }, group: null, ui_steps: [], next: [], ...over,
} as ClaimRowApi);

describe("Claims page URL state", () => {
  it("round-trips bucket(s), the filter box, kind and the PO date range; the default is the bare URL; old po= / supplier= / dismissed=1 links still read", () => {
    const s = { bucket: ["waiting_refund", "waiting_supplier"] as const, q: "michaels.com", kind: "canceled", from: "2026-06-01", to: "2026-06-17" };
    expect(readClaimsUrl("?bucket=closed&dismissed=1").bucket).toEqual(["closed"]);
    expect(readClaimsUrl("?dismissed=1").bucket).toEqual(["dismissed"]);
    expect(readClaimsUrl("?bucket=dismissed").bucket).toEqual(["dismissed"]);
    expect(readClaimsUrl(writeClaimsUrl({ ...s, bucket: [...s.bucket] }))).toEqual({ ...s, bucket: [...s.bucket] });
    expect(writeClaimsUrl(readClaimsUrl(""))).toBe("");
    expect(readClaimsUrl("").bucket).toEqual(["needs_attention"]);
    expect(readClaimsUrl("?bucket=nope,closed").bucket).toEqual(["closed"]);
    expect(readClaimsUrl("?po=9500110801616249").q).toBe("9500110801616249");
    // the Dashboard's Refunds due link (metric-grid refundsDueHref)
    expect(readClaimsUrl("?bucket=waiting_refund,waiting_supplier&from=2026-06-01&to=2026-06-17")).toMatchObject({ bucket: ["waiting_refund", "waiting_supplier"], from: "2026-06-01", to: "2026-06-17" });
  });
  it("rowsForView: the tab's buckets, the filter box (supplier / PO / alternate / ASIN / product), the kind, the PO date range; Dismissed is its own tab (Maria 2026-11-12)", () => {
    const rows = [row({ id: 1, bucket: "waiting_refund" }), row({ id: 2, bucket: "waiting_supplier", order_date: "2026-01-01", supplier: "michaels.com", product_name: "Red Heart yarn", alt_order_ids: "R4600" }), row({ id: 3, bucket: "closed" }), row({ id: 4, bucket: "dismissed" })];
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier")).map((r) => r.id)).toEqual([1, 2]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier&from=2026-06-01&to=2026-11-10")).map((r) => r.id)).toEqual([1]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier&q=yarn")).map((r) => r.id)).toEqual([2]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=waiting_refund,waiting_supplier&q=r4600")).map((r) => r.id)).toEqual([2]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=closed")).map((r) => r.id)).toEqual([3]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=dismissed")).map((r) => r.id)).toEqual([4]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=dismissed&q=michaels")).map((r) => r.id)).toEqual([]);
    expect(rowsForView([...rows, row({ id: 5, bucket: "dismissed", order_id: "6426282", supplier: "opentip.com" })], readClaimsUrl("?bucket=dismissed&q=6426282")).map((r) => r.id)).toEqual([5]);
    const page = readFileSync("client/src/pages/claims.tsx", "utf8");
    expect(page).not.toContain("show dismissed");
    expect(page).toContain('a.kind === "reopen" ? () => void call(`/api/pos/claims/${claim.id}/reopen`)');
    expect(matchesFilter(row({ asin: "B07N6V47HC" }), "b07n6")).toBe(true);
    expect(matchesFilter(row({}), "")).toBe(true);
  });
  it("the filter box finds a claim by its # (with or without #), PO order #, alternate order #, ASIN, supplier SKU, product name and supplier — on every tab, Closed and Dismissed included (Maria 2026-11-13)", () => {
    const c = row({ id: 3111, order_id: "200015497641702", alt_order_ids: "2000154-47705454", asin: "B0GWG5S64Q", supplier_sku: "WM-DRT-OIL", product_name: "Dr Teal's Restorative Minerals Bath & Body Oil", supplier: "walmart.com" });
    for (const q of ["#3111", "3111", " #3111 ", "200015497641702", "47705454", "b0gwg5s64q", "wm-drt-oil", "body oil", "walmart"]) expect(matchesFilter(c, q), q).toBe(true);
    for (const q of ["#3112", "3112", "michaels", "B0GNHTYGPF", "XYZ"]) expect(matchesFilter(c, q), q).toBe(false);
    expect(matchesFilter(row({ supplier_sku: null, alt_order_ids: null, product_name: null, asin: null }), "oil")).toBe(false);
    const rows = [row({ id: 3111, bucket: "closed", supplier_sku: "WM-DRT-OIL" }), row({ id: 3099, bucket: "dismissed" }), row({ id: 7, bucket: "needs_attention" })];
    for (const bucket of ["closed", "dismissed", "needs_attention"] as const) {
      const want = rows.filter((r) => r.bucket === bucket).map((r) => r.id);
      expect(rowsForView(rows, readClaimsUrl(`?bucket=${bucket}&q=%23${want[0]}`)).map((r) => r.id)).toEqual(want);
    }
    expect(rowsForView(rows, readClaimsUrl("?bucket=closed&q=wm-drt")).map((r) => r.id)).toEqual([3111]);
    expect(rowsForView(rows, readClaimsUrl("?bucket=dismissed&q=3111")).map((r) => r.id)).toEqual([]); // the claim is on Closed, not Dismissed
    // the row and the detail header carry the muted claim #
    const page = readFileSync("client/src/pages/claims.tsx", "utf8");
    expect(page).toContain('<span className="mut num" data-testid={`claim-number-${c.id}`}>#{c.id}</span> {c.supplier}</span>'); // the number first, so a long supplier truncates and the number never does
    expect(page).toContain('data-testid="claim-number">#{c.id}</span></h1>');
    expect(page).toContain('placeholder="Claim #, PO, ASIN, SKU, product, supplier"');
    // the server hands the SKU to the row
    expect(readFileSync("server/supplier-claims.ts", "utf8")).toContain("pa.asin, l.product_name, l.supplier_sku,");
  });
});

describe("Needs attention groups, labels, the method prefill, the table", () => {
  it("a row sits under the server's group (its primary action's task group); rows without a group are left out", () => {
    const rows = [row({ id: 1, group: "decide" }), row({ id: 2, group: "timed_out" }), row({ id: 3, group: null }), row({ id: 4, group: "decide" })];
    expect(groupNeedsAttention(rows).map((x) => [x.group, x.rows.map((r) => r.id)])).toEqual([["decide", [1, 4]], ["timed_out", [2]]]);
  });
  it("Decide's order (Maria 2026-11-12): suggestions with figures first, then the rest, the converted claims still waiting on a quantity last — the server's order kept within each", () => {
    const enterQty = { id: 9, kind: "enter_quantity" as const, group: "decide", reason: null, created_at: "2026-11-10", due_at: null, done_at: null, snoozed_until: null };
    const rows = [
      row({ id: 1, group: "decide", status: "open", qty: null, tasks: [enterQty] }),                       // converted, waiting on a quantity
      row({ id: 2, group: "decide", status: "suggested", qty: 4 }),                                        // suggestion with figures
      row({ id: 3, group: "decide", status: "open", qty: 2 }),                                             // an outcome to confirm
      row({ id: 4, group: "decide", status: "suggested", qty: null, tasks: [enterQty] }),                  // a suggestion without figures
      row({ id: 5, group: "decide", status: "suggested", qty: 1 }),
      row({ id: 6, group: "decide", status: "open", qty: null, tasks: [{ ...enterQty, done_at: "2026-11-11" }] }), // its quantity task done → not waiting
      row({ id: 7, group: "supplier" }),
    ];
    expect(decideOrder(rows.filter((r) => r.group === "decide")).map((r) => r.id)).toEqual([2, 5, 3, 4, 6, 1]);
    expect(groupNeedsAttention(rows).map((x) => [x.group, x.rows.map((r) => r.id)])).toEqual([["decide", [2, 5, 3, 4, 6, 1]], ["supplier", [7]]]);
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
  it("the list is the mockup's grid with Product widened (28 · 140 · 240 · 120 · 100 · 110 · 1fr · 70 · 180, 12 px gaps) and fits 1280; the mockup's nine columns; the Qty header names its kind on the muted line above (the quantity-names rule wins there, Maria 2026-11-12); columns resizable through the PO table's hook, Step takes the rest", () => {
    expect(CLAIMS_TABLE_WIDTH).toBeLessThanOrEqual(1280 - 48);
    expect(CLAIMS_TABLE_WIDTH).toBe(1084);
    expect(CLAIMS_GRID).toBe("28px 140px 240px 120px 100px 110px 1fr 70px 180px");
    expect(CLAIM_COLUMNS.find((c) => c.id === "product")!.width).toBe(240);
    expect(claimsGrid({ product: 320, waiting: 80 })).toBe("28px 140px 320px 120px 100px 110px 1fr 80px 180px");
    expect(CLAIM_COLUMNS.filter(resizableClaimColumn).map((c) => c.id)).toEqual(["supplier", "product", "kind", "qty", "owed", "waiting", "do"]);
    expect(CLAIMS_COL_WIDTHS_KEY).toBe("claims-col-widths");
    const hook = readFileSync("client/src/hooks/use-column-widths.tsx", "utf8");
    expect(hook).toContain('closest("th, [data-resize-col]")');
    expect(CLAIM_COLUMNS.map((c) => c.label)).toEqual(["", "Supplier · PO", "Product", "Kind", "Qty", "Owed / left", "Step", "Waiting", "Do"]);
    expect(CLAIM_COLUMNS.find((c) => c.id === "qty")!.kind).toBe("Individual units");
    const page = readFileSync("client/src/pages/claims.tsx", "utf8");
    const css = readFileSync("client/src/pages/claims.css", "utf8");
    // the stylesheet is the mockups' <style> blocks, scoped to .cl; the page wraps both views in it
    for (const f of ["docs/mockups/claims-list-2026-11-12.html", "docs/mockups/claim-detail-2026-11-12.html"]) {
      const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(f, "utf8"))![1];
      for (const rule of style.split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (rule.startsWith("body{")) continue; // → .cl{…}
        for (const one of rule.split("}").filter(Boolean)) { const [sel, body] = one.split("{"); expect(css, one).toContain(`.cl ${sel.trim().split(",").join(",.cl ")}{${body}`); }
      }
    }
    expect(css).toContain(".cl{margin:0;background:#181716;color:#e6e3dc;font-family:Inter,system-ui,sans-serif;font-size:13px");
    expect(page).toContain('import "./claims.css"');
    expect(page).toContain("useColumnWidths(CLAIMS_COL_WIDTHS_KEY)");
    expect(page).toContain('"--claims-grid": claimsGrid(colWidths)');
    expect(page).toMatch(/data-resize-col=\{resizableClaimColumn\(c\) \? c\.id : undefined\}/);
    expect(page).toMatch(/\{resizableClaimColumn\(c\) && <ResizeHandle onMouseDown=\{\(e\) => handleResizeStart\(e, c\.id\)\} \/>\}/);
    expect(page).toMatch(/onClick=\{resetWidths\} data-testid="button-claims-reset-widths">Reset widths</);
    expect(css).toContain(".cl .hd,.cl .row{grid-template-columns:var(--claims-grid,28px 140px 240px 120px 100px 110px 1fr 70px 180px)}");
    // the timeline note sits in the entry column, wraps, clamps past 3 lines with "more" (Maria 2026-11-12: a 300-character summary fell into the dot column)
    expect(css).toContain(".cl .tl .n{width:auto;height:auto;border:0;border-radius:0;display:block;font-size:inherit;color:#a39f96}");
    expect(page).toContain("<TimelineNote id={e.id} text={`${note}${e.by_name ? ` · ${e.by_name}` : \"\"}`} email={e.gmail_message_id ? { id: e.gmail_message_id, mailbox: e.mailbox ?? \"\" } : null} />");
    expect(page).toContain('WebkitLineClamp: NOTE_CLAMP_LINES, WebkitBoxOrient: "vertical", overflow: "hidden" }');
    expect(page).toContain("setClamped(el.scrollHeight > el.clientHeight + 1)");
    expect(page).toContain('{expanded ? "less" : "more"}</button>');
    expect(NOTE_CLAMP_LINES).toBe(3);
    // Refund received: the split section collapsed by default, rows kind · qty · owed with the amount field; the targets come filtered from the server
    expect(page).toContain('data-testid="button-refund-split-toggle">Split across other claims on this PO {splitOpen ? "▾" : "▸"}</button>');
    expect(page).toContain("const [splitOpen, setSplitOpen] = useState(false);");
    expect(page).toMatch(/\{splitOpen && others\.map\(\(o\) => \(/);
    expect(page).toContain("{CLAIM_KIND_LABELS[o.kind as ClaimKind] ?? o.kind} · {fmtQty(o.qty)} <span className=\"mut\">Individual units</span> · {money(o.amount_owed)} owed");
    expect(page).not.toContain("One refund for several claims?");
    // no always-visible explanations of backend state on the detail (Maria 2026-11-12)
    for (const gone of ["Steps change with the outcome", "Several refunds can land on one claim", "converted from the sheet era"]) expect(page).not.toContain(gone);
    expect(page).toContain('<div className="cl" style={{ display: "flex", flexDirection: "column" }} data-testid="claims-page">');
    expect(page).toContain('<div className="cl" data-testid="claim-detail">');
    expect(page).toMatch(/className="hd" data-testid="claims-table"/);
    expect(page).toContain('{c.kind && <span className="kind-line">{c.kind}</span>}{c.label}');
    expect(css).toContain(".cl .hd .kind-line{display:block;font-size:9px;text-transform:none;letter-spacing:0;color:#6f6b63;line-height:1.2}");
    expect(page).toMatch(/className="row" style=\{\{ cursor: "pointer" \}\}/);
    expect(readFileSync("client/index.html", "utf8")).toContain("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap");
    // the detail's three columns and its action buttons; nothing says "waiting" before the report (the words come from shared/claim-ui.ts)
    expect(page).toContain('gridTemplateColumns: "340px minmax(0, 1fr) 360px", gap: 16');
    expect(page).toContain('className="tl"');
    expect(page).toContain("Set outcome ▾");
    expect(page).toContain("More ▾");
    for (const id of ["button-claim-contacted", "button-claim-replied", "button-claim-set-outcome", "button-claim-more", "button-claim-refund-received", "claim-next", "claim-more", "button-event-edit-", "button-event-remove-", "button-event-remove-confirm-"]) expect(page).toContain(id);
    // Remove this entry (Maria 2026-11-12) is a DELETE of the entry; the client's removable list is the server's
    expect(page).toContain('call(`/api/pos/claims/events/${e.id}`, "DELETE")');
    const server = readFileSync("server/supplier-claims.ts", "utf8");
    const m = /REMOVABLE_EVENT_TYPES = \[([^\]]+)\]/.exec(server)!;
    expect(page).toContain(`const REMOVABLE_EVENTS = [${m[1]}];`);
  });
});
